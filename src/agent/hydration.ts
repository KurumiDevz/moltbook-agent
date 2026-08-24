/**
 * Agent V2 — Reply count hydration from API.
 *
 * Scans feed + notifications to rebuild repliedThreadCounts on startup.
 * All functions take dependencies as parameters — no class state needed.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { MemoryState } from "./types.js";
import { getConfig } from "../config.js";

/** Hydrate repliedThreadCounts from API on startup — scans feed + notifications for our posts and comments. */
export async function hydrateReplyCounts(
  moltbookAgent: MoltbookAgent,
  memory: MemoryState,
): Promise<void> {
  console.log("🔄 Hydrating reply counts from API...");
  const postIdsToScan = new Set<string>();

  try {
    // 1. Find our posts by scanning the feed (same approach as my-posts.ts)
    for (const sort of ["new", "hot", "top"] as const) {
      let offset = 0;
      for (let page = 0; page < getConfig().hydrationFeedPages; page++) {
        try {
          const result = await moltbookAgent.listPosts({ sort, limit: getConfig().hydrationFeedLimit, offset });
          if (!result.ok) break;
          const data = result.value as any;
          const posts = data.posts ?? [];
          for (const p of posts) {
            if (p.author?.name === getConfig().agentName || p.author === getConfig().agentName) {
              postIdsToScan.add(p.id);
            }
          }
          if (!data.has_more || posts.length === 0) break;
          offset = data.next_offset ?? offset + 50;
        } catch {
          break;
        }
      }
    }
  } catch {
    /* feed scan failed */
  }

  try {
    // 2. Find other posts we commented on via notifications (replies to our comments)
    const notifs = await moltbookAgent.getNotifications({ limit: getConfig().hydrationNotifLimit });
    if (notifs.ok) {
      const data = notifs.value as any;
      for (const n of data.notifications ?? []) {
        if (n.post_id) postIdsToScan.add(n.post_id);
      }
    }
  } catch {
    /* notification scan failed */
  }

  // 3. Fallback: use persisted postHistory from disk if feed + notifications found nothing
  if (postIdsToScan.size === 0 && memory.postHistory.length > 0) {
    console.log(`   Feed/notifications empty — using ${memory.postHistory.length} persisted posts`);
    for (const p of memory.postHistory) {
      postIdsToScan.add(p.id);
    }
  }

  if (postIdsToScan.size === 0) {
    console.log("   No posts found — starting fresh");
    return;
  }

  console.log(`   Found ${postIdsToScan.size} posts to scan — counting replies...`);

  // 4. For each post, list comments and count our replies per thread
  for (const postId of postIdsToScan) {
    try {
      const commentsResult = await moltbookAgent.listComments(postId, { sort: "old", limit: getConfig().hydrationNotifLimit });
      if (!commentsResult.ok) continue;
      const comments = (commentsResult.value as any).comments ?? [];
      for (const c of comments) {
        if (c.author?.name === getConfig().agentName) {
          const threadKey = c.parentId ?? c.id;
          const current = memory.repliedThreadCounts.get(threadKey) ?? 0;
          memory.repliedThreadCounts.set(threadKey, current + 1);
          memory.repliedCommentIds.add(c.id);
        }
      }
    } catch {
      /* skip failed posts */
    }
  }

  const hydrated = [...memory.repliedThreadCounts.entries()].filter(([, c]) => c > 0);
  if (hydrated.length > 0) {
    console.log(`   Hydrated ${hydrated.length} threads: ${hydrated.map(([id, c]) => `${id.slice(0, 8)}...(${c})`).join(", ")}`);
  } else {
    console.log("   No existing replies found (comments may be deleted)");
  }
}
