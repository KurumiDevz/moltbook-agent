#!/usr/bin/env npx tsx
/**
 * Check unread notifications without marking them as read.
 * Resolves agent names via listComments cross-reference.
 * Usage: npx tsx scripts/check-notifications.ts
 */

import "dotenv/config";
import { MoltbookAgent } from "../src/moltbook.js";

const API_KEY = process.env.MOLTBOOK_API_KEY;
if (!API_KEY) { console.error("Missing MOLTBOOK_API_KEY"); process.exit(1); }

const agent = new MoltbookAgent(null as any, { apiKey: API_KEY });

async function main() {
  const result = await agent.getNotifications({ limit: 20, unread_only: true });

  if (!result.ok) {
    console.error("API error:", result.error.status, result.error.responseBody);
    process.exit(1);
  }

  const { notifications } = result.value;

  // Batch-fetch author names: group by postId, call listComments once per post
  const postIds = [...new Set(notifications.map((n) => n.relatedPostId).filter(Boolean))];
  const authorMap = new Map<string, string>(); // commentId → authorName

  for (const postId of postIds) {
    const comments = await agent.listComments(postId!, { sort: "new", limit: 100 });
    if (comments.ok) {
      const walk = (arr: any[]) => {
        for (const c of arr) {
          if (c.id && c.author?.name) {
            authorMap.set(c.id, c.author.name);
          }
          if (c.replies?.length) walk(c.replies);
        }
      };
      walk(comments.value.comments);
    }
  }

  console.log(`\nUnread notifications: ${notifications.length}\n`);

  for (const [i, n] of notifications.entries()) {
    const createdAt = n.createdAt ?? (n as any).created_at ?? 0;
    const ts = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt;
    const ago = Math.round((Date.now() - ts) / 60_000);
    const postTitle = n.post?.title ?? (n as any).relatedPostTitle ?? "Untitled";

    // For comment_reply: n.comment.id is the reply; relatedCommentId is our parent
    // For comment: relatedCommentId is the new comment
    const lookupId = n.type === "comment_reply"
      ? ((n as any).comment?.id ?? n.relatedCommentId)
      : n.relatedCommentId;

    const agentName = authorMap.get(lookupId ?? "") ?? "unknown";
    const preview = ((n as any).comment?.content ?? n.content ?? "").slice(0, 120);

    console.log(`${i + 1}. [${n.type}] ${agentName} → "${postTitle}"`);
    console.log(`   ${ago}m ago | lookupId: ${lookupId?.slice(0, 8)}...`);
    if (preview) console.log(`   "${preview}"`);
    console.log();
  }
}

main();
