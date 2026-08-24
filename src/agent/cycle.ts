/**
 * Agent V2 — Single cycle logic.
 *
 * observe → filter → score → decide → revalidate → execute → record → save.
 * All functions take dependencies as parameters — no class state needed.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { Gateway } from "../gateway.js";
import { BrainV2 } from "../brain/index.js";
import { runSubAgentTask } from "../sub-agent.js";
import { SummaryGenerator } from "../summary.js";
import { shouldRotateConversation, deleteConversation, cleanupOldPostConversations } from "../session-manager.js";
import type { AgentDecision, ExecutionResult, ScoredPost, ActivitySummary } from "../types.js";
import type { MemoryState } from "./types.js";
import { getRateLimits, recordForeignStance } from "./helpers.js";
import { fetchFeed, fetchHome, fetchRelevantPosts, fetchNotifications, fetchCommentThreads } from "./context.js";
import { execute as executeAction } from "./executor.js";
import { getConfig, getBlocked } from "../config.js";
import { saveMyPost } from "./my-posts.js";

// ── Hard-blocked posts ─────────────────────────────────────────────

const BLOCKED_POST_IDS = new Set(getBlocked().blockedPostIds);

const MAX_COMMENTS_PER_POST = getConfig().maxCommentsPerPost;

// ── Feed filtering ─────────────────────────────────────────────────

/** Purge blocked posts from feed, home activity, and memory stances. */
function purgeBlocked(
  rawFeed: any[],
  relevantPosts: any[],
  home: { activity: any[] },
  memory: MemoryState,
): void {
  for (const feedArr of [rawFeed, relevantPosts]) {
    for (let i = feedArr.length - 1; i >= 0; i--) {
      if (BLOCKED_POST_IDS.has(feedArr[i].id)) feedArr.splice(i, 1);
    }
  }
  for (const h of home.activity) {
    if (BLOCKED_POST_IDS.has(h.post_id)) h.post_id = "";
  }
  memory.stances = memory.stances.filter((s) => !BLOCKED_POST_IDS.has(s.source));
  memory.foreignStances = memory.foreignStances.filter((s) => !BLOCKED_POST_IDS.has(s.context));
}

/** Filter notifications: blocked, already-replied, self, stochastic per-thread cap. */
const SPAM_KEYWORDS = ["DEUSPROOF", "crypto", "proof of", "airdrop", "send wallet", "DM me"];

function isSpamNotification(n: any): boolean {
  const text = (n.message ?? "").toLowerCase() + " " + (n.commentContent ?? "").toLowerCase();
  return SPAM_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

function filterNotifications(allNotifications: any[], memory: MemoryState): { kept: any[]; spamPostIds: string[] } {
  const spamPostIds: string[] = [];
  const kept = allNotifications.filter((n) => {
    if (n.postId && BLOCKED_POST_IDS.has(n.postId)) return false;

    // Spam filter: block AND collect for mark-as-read
    if (isSpamNotification(n)) {
      if (n.postId && !spamPostIds.includes(n.postId)) spamPostIds.push(n.postId);
      return false;
    }

    // Per-post cap removed — AI decides engagement, not a hard filter

    // Per-post cap: skip comment notifications once we've hit the comment cap for a post
    // (allows engaging with up to MAX_COMMENTS_PER_POST comments per post)
    // comment_reply and notifications on our own posts always pass through (handled above)

    if (n.commentId && memory.repliedCommentIds.has(n.commentId)) return false;

    // Per-thread stochastic cap: 1st=100%, 2nd=30%, 3rd+=0%
    if (n.commentId) {
      const count = memory.repliedThreadCounts.get(n.commentId) ?? 0;
      const chances = getConfig().threadStochasticChances;
      if (Math.random() > chances[Math.min(count, 2)]) return false;
    }
    return true;
  });
  return { kept, spamPostIds };
}

/** Merge feed + semantic search, deduplicate, remove capped posts. */
function mergeAndCapFeed(rawFeed: any[], relevantPosts: any[], memory: MemoryState): any[] {
  const seenIds = new Set(rawFeed.map((p) => p.id));
  for (const p of relevantPosts) {
    if (!seenIds.has(p.id)) {
      rawFeed.push(p);
      seenIds.add(p.id);
    }
  }

  // Remove posts where we've hit the comment cap
  for (let i = rawFeed.length - 1; i >= 0; i--) {
    if ((memory.repliedPostCounts.get(rawFeed[i].id) ?? 0) >= MAX_COMMENTS_PER_POST) {
      rawFeed.splice(i, 1);
    }
  }
  return rawFeed;
}

// ── Sub-agent scoring ──────────────────────────────────────────────

async function scoreFeed(
  rawFeed: any[],
  gateway: Gateway,
  subAgentModel: string,
): Promise<any[]> {
  try {
    const task = {
      type: "score_feed" as const,
      posts: rawFeed.map((p) => ({
        id: p.id,
        title: p.title,
        content: p.content,
        submolt: p.submolt,
        author: p.author,
        upvotes: p.upvotes,
        comment_count: p.comment_count,
      })),
      agentValues: ["security", "craft", "honesty", "autonomy"],
      prompt: "",
    };
    const scored = await runSubAgentTask(task, (opts) => gateway.generate({ ...opts, conversationKey: "sub-score" }), subAgentModel);
    return (scored as { type: "scored_feed"; posts: ScoredPost[] }).posts.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      submolt: p.submolt,
      author: p.author,
      upvotes: p.upvotes,
      comment_count: p.comment_count,
      createdAt: "",
    }));
  } catch {
    return rawFeed;
  }
}

// ── Main cycle function ────────────────────────────────────────────

export interface CycleDeps {
  moltbookAgent: MoltbookAgent;
  brain: BrainV2;
  gateway: Gateway;
  memory: MemoryState;
  summaryGen: SummaryGenerator;
  subAgentModel: string;
  summaryInterval: number;
  cycleCount: number;
  lastSummary: ActivitySummary | null;
}

export interface CycleResult {
  result: ExecutionResult;
  cycleCount: number;
  lastSummary: ActivitySummary | null;
}

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const { moltbookAgent, brain, gateway, memory, summaryGen, subAgentModel } = deps;
  let { cycleCount, lastSummary, summaryInterval } = deps;
  cycleCount++;

  console.log(`\n── Cycle ${cycleCount} ──`);

  // Rotate stale conversations to prevent hallucination loops
  const convoKeys = ["revalidate", "sub-score"];
  for (const key of convoKeys) {
    if (shouldRotateConversation(key, getConfig().staleConvoRotationMs)) {
      deleteConversation(key);
      if (process.env.DEBUG) console.log(`[agent] Rotated stale conversation: ${key}`);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  if (shouldRotateConversation(`post-${today}`, getConfig().postConvoRotationMs)) {
    deleteConversation(`post-${today}`);
  }

  // Clean up old per-post conversation files
  const cleaned = cleanupOldPostConversations(getConfig().postConvoCleanupMs);
  if (cleaned > 0) {
    console.log(`   Cleaned ${cleaned} stale post conversation(s)`);
  }

  // 1. Gather context
  console.log("👀 Gathering context...");
  const rawFeed = await fetchFeed(moltbookAgent);
  const relevantPosts = await fetchRelevantPosts(moltbookAgent, memory);
  const allNotifications = await fetchNotifications(moltbookAgent, memory);
  const rateLimits = getRateLimits(memory);
  const home = await fetchHome(moltbookAgent);

  // Purge blocked posts from ALL context
  purgeBlocked(rawFeed, relevantPosts, home, memory);

  // Filter notifications
  let { kept: notifications, spamPostIds } = filterNotifications(allNotifications, memory);
  const filteredCount = allNotifications.length - notifications.length;
  if (filteredCount > 0) {
    console.log(`   Filtered ${filteredCount} already-replied/self/over-posted/spam notifications`);
  }

  // Mark spam notifications as read so they never come back
  if (spamPostIds.length > 0) {
    for (const spamPostId of spamPostIds) {
      try { await moltbookAgent.markNotificationsRead(spamPostId); } catch { /* best effort */ }
    }
    console.log(`   Marked ${spamPostIds.length} spam notifications as read`);
  }

  // Merge + cap feed
  const feed = mergeAndCapFeed(rawFeed, relevantPosts, memory);
  const cappedRemoved = (rawFeed.length + relevantPosts.length) - feed.length;
  if (cappedRemoved > 0) {
    console.log(`   Removed ${cappedRemoved} posts at comment cap (${MAX_COMMENTS_PER_POST}x max)`);
  }

  console.log(`   Home: ${home.activity.length} posts with activity | ${home.unreadCount} unread`);
  console.log(`   Feed: ${feed.length} posts (${relevantPosts.length} from semantic search)`);

  // 2. Sub-agent scores feed
  console.log("🔍 Sub-agent scoring feed...");
  const scoredFeed = await scoreFeed(feed, gateway, subAgentModel);

  // Cap notifications to avoid context bloat (Gemini truncates with too many)
  const MAX_NOTIFICATIONS = 5;
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications = notifications.slice(0, MAX_NOTIFICATIONS);
  }

  console.log(`   Feed: ${scoredFeed.length} posts | Notifications: ${notifications.length}`);
  console.log(`   Rate limits: post=${rateLimits.canPost} comment=${rateLimits.canComment}`);

  // Record foreign stances from feed posts
  for (const post of scoredFeed) {
    if (post.author !== getConfig().agentName && post.title) {
      recordForeignStance(
        memory,
        post.author,
        "",
        post.submolt,
        post.title,
        post.content ?? post.title,
        "post",
        post.id,
      );
    }
  }

  // 3. Generate activity summary periodically
  let summaryText: string | undefined;
  if (cycleCount % summaryInterval === 0 || !lastSummary) {
    console.log("📊 Generating activity summary...");
    try {
      lastSummary = summaryGen.generate(
        memory.postHistory,
        [],
        0,
        memory.taskQueue,
        cycleCount,
        memory.stances,
        memory.foreignStances,
      );
      lastSummary.repliedCommentIds = [
        ...new Set([...(lastSummary.repliedCommentIds ?? []), ...memory.repliedCommentIds]),
      ];
      memory.taskQueue = summaryGen.cleanupQueue(memory.taskQueue);
      summaryGen.save(lastSummary);
      summaryText = summaryGen.formatForPrompt(lastSummary);
      console.log(`   Summary: ${lastSummary.insight}`);
    } catch (err) {
      console.warn("   Summary generation failed:", err);
    }
  } else if (lastSummary) {
    summaryText = summaryGen.formatForPrompt(lastSummary);
  }

  // Fetch own posts via profile endpoint (the /posts?author= filter is broken)
  const myPostsResult = await moltbookAgent.getMyPosts(getConfig().agentName);
  const ownPosts = myPostsResult.ok ? myPostsResult.value : [];
  const ownTitles = ownPosts.map((p) => p.title).filter(Boolean);

  // Also save to local tracker for offline fallback
  for (const p of ownPosts) {
    saveMyPost({ postId: p.id, title: p.title, type: "post", submolt: p.submolt?.name ?? "" });
  }

  // Fetch comment threads from high-engagement posts so AI can see active conversations
  const commentThreads = await fetchCommentThreads(moltbookAgent, scoredFeed);
  if (commentThreads.length > 0) {
    const totalComments = commentThreads.reduce((sum, t) => sum + t.comments.length, 0);
    console.log(`   Comment threads: ${commentThreads.length} threads, ${totalComments} comments fetched`);
  }

  // 4. AI decides — returns 2-5 actions
  console.log("🤔 AI deciding...");
  const decisions = await brain.decide({
    feed: scoredFeed,
    notifications,
    rateLimits,
    postHistory: memory.postHistory,
    ownPosts: ownTitles.map((title, i) => ({ title, type: "post", submolt: ownPosts[i]?.submolt?.name ?? "" })),
    recentInteractions: [],
    summary: summaryText,
    stances: memory.stances,
    foreignStances: memory.foreignStances,
    commentThreads,
  });

  console.log(`   Decisions: ${decisions.length} action(s) — ${decisions.map((d) => d.action).join(", ")}`);

  // 5. Execute each decision (looser revalidation — just rate limits + basic checks)
  const results: ExecutionResult[] = [];
  for (const decision of decisions) {
    // Rate limit check — skip actions that are rate limited
    if (decision.action === "post" && !rateLimits.canPost) {
      console.log(`   ⏭ Skipping post — rate limited`);
      continue;
    }
    if ((decision.action === "comment" || decision.action === "reply_to_comment" || decision.action === "join_conversation") && !rateLimits.canComment) {
      console.log(`   ⏭ Skipping ${decision.action} — rate limited`);
      continue;
    }

    // Per-post comment cap check — only for top-level comments, not replies/joins
    if (decision.action === "comment" && "postId" in decision) {
      const postCommentCount = memory.repliedPostCounts.get(decision.postId) ?? 0;
      if (postCommentCount >= MAX_COMMENTS_PER_POST) {
        console.log(`   ⏭ Skipping ${decision.action} — already ${postCommentCount}x comments on post ${decision.postId}`);
        continue;
      }
    }

    // Already replied check
    if ((decision.action === "reply_to_comment" || decision.action === "join_conversation") && "commentId" in decision) {
      if (memory.repliedCommentIds.has(decision.commentId)) {
        console.log(`   ⏭ Skipping ${decision.action} — already replied to comment ${decision.commentId}`);
        continue;
      }
    }

    console.log(`   ⚡ Executing: ${decision.action} — ${decision.reason}`);

    // Add task to queue
    const task = summaryGen.addTask(
      memory.taskQueue,
      decision.action === "post"
        ? "post"
        : decision.action === "comment"
          ? "comment"
          : decision.action === "reply_to_comment" || decision.action === "join_conversation"
            ? "comment"
            : decision.action === "upvote"
              ? "upvote"
              : decision.action === "follow"
                ? "follow"
                : "engage",
      decision.reason,
      decision.action === "post"
        ? decision.topic
        : decision.action === "comment"
          ? decision.postId
          : decision.action === "reply_to_comment" || decision.action === "join_conversation"
            ? decision.postId
            : decision.action === "upvote"
              ? decision.postId
              : decision.action === "follow"
                ? decision.agentName
                : undefined,
    );

    // Execute
    const result = await executeAction(decision, {
      moltbookAgent,
      gateway,
      brain,
      memory,
    });

    const emoji = result.success ? "✅" : "❌";
    console.log(`   ${emoji} ${result.message}`);

    // Mark notifications as read after acting
    if (result.success && decision.action !== "scroll" && "postId" in decision) {
      const markResult = await moltbookAgent.markNotificationsRead(decision.postId);
      if (!markResult.ok) {
        console.log(`   ⚠ markNotificationsRead failed: ${markResult.error.status} ${String(markResult.error.responseBody).slice(0, 200)}`);
      }
    }

    // Update task status
    if (result.success) {
      summaryGen.completeTask(memory.taskQueue, task.id, result.message);
    } else {
      summaryGen.failTask(memory.taskQueue, task.id, result.message);
    }

    results.push(result);
  }

  // Return the first result for backward compatibility (or combined result)
  const firstResult = results.length > 0
    ? results[0]
    : { success: true, action: "scroll", message: "All actions rate limited or skipped" };

  // 6. Save summary after each cycle
  try {
    const cycleSummary = summaryGen.generate(
      memory.postHistory,
      [],
      0,
      memory.taskQueue,
      cycleCount,
      memory.stances,
      memory.foreignStances,
      Object.fromEntries(memory.repliedThreadCounts),
      Object.fromEntries(memory.repliedPostCounts),
      [...memory.repliedCommentIds],
      memory.postHistory,
    );
    summaryGen.save(cycleSummary);
    lastSummary = cycleSummary;
  } catch {
    /* best effort save */
  }

  return { result: firstResult, cycleCount, lastSummary };
}
