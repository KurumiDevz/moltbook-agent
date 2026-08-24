/**
 * Comprehensive scan: all posts + comments for an agent.
 * Uses notifications for comments, deep feed scan for posts.
 *
 * Usage: npx tsx scripts/my-posts.ts [agent-name]
 */

import { createMoltbookSDK } from "../src/moltbook.js";

const agentName = process.argv[2] || "nimjiagent-sz945r";
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY!;
const BASE_URL = "https://www.moltbook.com";

async function main() {
  const sdk = createMoltbookSDK(MOLTBOOK_API_KEY);

  console.log(`\n🔍 Scanning all content for u/${agentName}...\n`);

  // ── 1. Notifications (best source for comments) ──
  console.log("📬 Checking notifications for comments...");
  try {
    const notifs = await sdk.getNotifications({ limit: 100 });
    const commentNotifs = notifs.notifications.filter(
      (n) => n.type === "comment" || n.message?.includes("commented") || n.message?.includes("replied")
    );
    console.log(`   Found ${notifs.notifications.length} total notifications, ${commentNotifs.length} comment-related\n`);

    if (commentNotifs.length > 0) {
      for (const n of commentNotifs) {
        console.log(`   💬 ${n.message}`);
        if (n.post_id) console.log(`      Post: ${BASE_URL}/post/${n.post_id}`);
        console.log(`      ${n.created_at}`);
        console.log();
      }
    }
  } catch (err) {
    console.log(`   Notifications failed: ${err}\n`);
  }

  // ── 2. Deep feed scan (paginate through all recent posts) ──
  console.log("📋 Deep scanning feed for your posts...");
  const allPosts: Array<{ id: string; title: string; upvotes: number; downvotes: number; comment_count: number; created_at: string; submolt: { id: string; name: string; display_name: string }; author: { id: string; name: string } }> = [];
  const seenIds = new Set<string>();

  for (const sort of ["new", "hot", "top"] as const) {
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      try {
        const result = await sdk.listPosts({ sort, limit: 50, offset });
        for (const post of result.posts) {
          if (post.author.name === agentName && !seenIds.has(post.id)) {
            seenIds.add(post.id);
            allPosts.push(post);
          }
        }
        if (!result.has_more || result.posts.length === 0) break;
        offset = result.next_offset ?? offset + 50;
      } catch {
        break;
      }
    }
  }

  // Also try time-filtered scans
  for (const time of ["day", "week", "month"] as const) {
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      try {
        const result = await sdk.listPosts({ sort: "new", limit: 50, offset, time });
        for (const post of result.posts) {
          if (post.author.name === agentName && !seenIds.has(post.id)) {
            seenIds.add(post.id);
            allPosts.push(post);
          }
        }
        if (!result.has_more || result.posts.length === 0) break;
        offset = result.next_offset ?? offset + 50;
      } catch {
        break;
      }
    }
  }

  console.log(`   Found ${allPosts.length} unique posts\n`);

  if (allPosts.length > 0) {
    console.log("─".repeat(80));
    for (const post of allPosts) {
      const url = `${BASE_URL}/post/${post.id}`;
      console.log(`📌 ${post.title}`);
      console.log(`   ${url}`);
      console.log(`   ↑${post.upvotes} ↓${post.downvotes} | ${post.comment_count} comments | ${post.submolt.display_name} | ${post.created_at}`);
      console.log();
    }
  }

  // ── 3. Summary ──
  console.log("═".repeat(80));
  console.log(`\n📊 Summary for u/${agentName}:`);
  console.log(`   Posts found: ${allPosts.length}`);
  console.log(`   Total upvotes: ${allPosts.reduce((s, p) => s + p.upvotes, 0)}`);
  console.log(`   Total comments received: ${allPosts.reduce((s, p) => s + p.comment_count, 0)}`);
  console.log(`\n🔗 Profile: ${BASE_URL}/u/${agentName}\n`);
}

main().catch(console.error);
