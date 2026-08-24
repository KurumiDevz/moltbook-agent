/**
 * Agent V2 — Context gathering (feed, home, search, notifications).
 *
 * All functions take dependencies as parameters — no class state needed.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { FeedPost, NotificationItem } from "../types.js";
import type { MemoryState } from "./types.js";
import { recordForeignStance } from "./helpers.js";
import { getConfig } from "../config.js";

// ── Feed ───────────────────────────────────────────────────────────

/** Fetch hot feed posts. */
export async function fetchFeed(moltbookAgent: MoltbookAgent): Promise<FeedPost[]> {
  try {
    const { posts } = (await moltbookAgent.getFeed({ sort: "hot", limit: 15 })).unwrap();
    return posts.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      submolt: p.submolt,
      author: p.author,
      upvotes: p.votes,
      comment_count: p.commentCount,
      createdAt: p.createdAt,
    }));
  } catch {
    return [];
  }
}

// ── Home dashboard ─────────────────────────────────────────────────

/** Fetch home dashboard — single API call for all context. */
export async function fetchHome(moltbookAgent: MoltbookAgent): Promise<{
  activity: Array<{
    post_id: string;
    post_title: string;
    new_notification_count: number;
    latest_commenters: string[];
  }>;
  followingFeed: FeedPost[];
  unreadCount: number;
  whatToDo: string[];
}> {
  try {
    const home = (await moltbookAgent.getHome()).unwrap();
    return {
      activity: home.activity_on_your_posts ?? [],
      followingFeed: (home.posts_from_accounts_you_follow?.posts ?? []).map((p) => ({
        id: p.post_id,
        title: p.title,
        content: p.content_preview ?? "",
        submolt: p.submolt_name ?? "",
        author: p.author_name ?? "",
        upvotes: p.upvotes ?? 0,
        comment_count: p.comment_count ?? 0,
        createdAt: p.created_at ?? "",
      })),
      unreadCount: home.your_account?.unread_notification_count ?? 0,
      whatToDo: home.what_to_do_next ?? [],
    };
  } catch {
    return { activity: [], followingFeed: [], unreadCount: 0, whatToDo: [] };
  }
}

// ── Semantic search ────────────────────────────────────────────────

/** Fetch posts relevant to agent's recent topics via semantic search. */
export async function fetchRelevantPosts(
  moltbookAgent: MoltbookAgent,
  memory: MemoryState,
): Promise<FeedPost[]> {
  try {
    // Build search query from recent post topics, or fall back to agent interests
    let recentTopics = memory.topicsSeen
      .slice(-5)
      .map((t) => t.topic)
      .join(" ");
    if (!recentTopics) {
      // Seed from agent interests when topicsSeen is empty (fresh start)
      const interests = ["agent memory", "symbol indexing", "prompt engineering", "agent security", "context window"];
      recentTopics = interests[Math.floor(Math.random() * interests.length)];
    }

    const { results } = (
      await moltbookAgent.search(recentTopics, {
        type: "posts",
        limit: 10,
      })
    ).unwrap();

    // Deduplicate against already-fetched feed
    return (results ?? []).map((r) => ({
      id: r.id,
      title: r.title ?? "",
      content: r.content ?? "",
      submolt: "",
      author: r.author?.name ?? "",
      upvotes: 0,
      comment_count: 0,
      createdAt: "",
    }));
  } catch {
    return [];
  }
}

// ── Notifications ──────────────────────────────────────────────────

/** Fetch and filter notifications — cross-references comment authors via listComments. */
export async function fetchNotifications(
  moltbookAgent: MoltbookAgent,
  memory: MemoryState,
): Promise<NotificationItem[]> {
  try {
    const { notifications } = (await moltbookAgent.getNotifications({ limit: getConfig().hydrationNotifLimit })).unwrap();

    // Group comment notifications by post so we can fetch authors efficiently (1 call per post)
    const commentNotifs = notifications.filter((n) => n.type === "comment" || n.type === "comment_reply");
    const postIds = [...new Set(commentNotifs.map((n) => n.relatedPostId).filter((x): x is string => Boolean(x)))];

    // Build commentId → authorName map by calling listComments on each post
    const commentAuthorMap = new Map<string, string>();
    for (const postId of postIds) {
      try {
        const commentsResult = await moltbookAgent.listComments(postId, { limit: getConfig().hydrationNotifLimit });
        if (commentsResult.isOk()) {
          const walk = (comments: any[]) => {
            for (const c of comments) {
              if (c.id && c.author?.name) {
                commentAuthorMap.set(c.id, c.author.name);
              }
              if (c.replies?.length) walk(c.replies);
            }
          };
          walk(commentsResult.value.comments);
        }
      } catch {
        // best effort
      }
    }

    // Filter notifications: only keep those where we confirmed the author is NOT us
    const results: NotificationItem[] = [];
    for (const n of notifications) {
      if (n.type === "comment") {
        // For top-level comments on our posts: verify author is not us via map
        if (!n.relatedCommentId) continue;
        const author = commentAuthorMap.get(n.relatedCommentId);
        if (!author || author === getConfig().agentName) continue;
        if (memory.repliedCommentIds.has(n.relatedCommentId)) continue;
      } else if (n.type === "comment_reply") {
        // Replies to our comments — notification itself proves someone replied to us.
        // No author check needed (we can't get notified of our own replies).
        const replyId = n.comment?.id ?? n.relatedCommentId;
        if (!replyId) continue;
        if (memory.repliedCommentIds.has(replyId)) continue;
      }

      let postTitle: string | undefined;
      let postContent: string | undefined;
      if (n.relatedPostId && (n.type === "comment" || n.type === "comment_reply" || n.type === "mention")) {
        try {
          const postResult = await moltbookAgent.getPost(n.relatedPostId);
          if (postResult.isOk()) {
            const { post } = postResult.value;
            postTitle = post.title;
            postContent = post.content?.slice(0, 500);
          }
        } catch {
          // best effort
        }
      }

      // For mentions: verify we're actually tagged in the post or a comment before acting
      if (n.type === "mention" && postContent) {
        const myName = getConfig().agentName;
        const mentionedInPost = postContent.includes(`@${myName}`) || postContent.includes(myName);
        if (!mentionedInPost) {
          let mentionedInComment = false;
          if (n.relatedPostId) {
            const commentsR = await moltbookAgent.listComments(n.relatedPostId, { limit: 20 });
            if (commentsR.ok) {
              mentionedInComment = commentsR.value.comments.some(
                (c) => c.content?.includes(`@${myName}`) || c.content?.includes(myName),
              );
            }
          }
          if (!mentionedInComment) continue;
        }
      }

      // For comment_reply: the comment.id is the reply (what we'd reply to); relatedCommentId is our parent
      const replyLookupId = n.type === "comment_reply" ? (n.comment?.id ?? n.relatedCommentId) : n.relatedCommentId;
      const authorName =
        n.type === "comment" || n.type === "comment_reply"
          ? commentAuthorMap.get(replyLookupId ?? "")
          : undefined;

      results.push({
        type: n.type,
        message: n.content,
        agentName: authorName,
        postId: n.relatedPostId,
        // For comment_reply, this should be the reply comment ID so the brain can reply to it
        commentId: replyLookupId,
        commentContent: n.comment?.content,
        postTitle,
        postContent,
        createdAt: n.createdAt,
      });

      // Record foreign stances from comments on our posts
      if (authorName && authorName !== getConfig().agentName && n.comment?.content) {
        recordForeignStance(
          memory,
          authorName,
          "",
          postTitle ?? n.relatedPostId ?? "unknown",
          n.comment.content.slice(0, 100),
          n.comment.content,
          "comment",
          n.relatedCommentId ?? `${n.relatedPostId}-${authorName}-${Date.now()}`,
        );
      }
    }
    return results;
  } catch {
    return [];
  }
}
