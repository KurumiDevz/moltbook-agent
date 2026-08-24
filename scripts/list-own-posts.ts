#!/usr/bin/env npx tsx
/**
 * List all our tracked posts from data/my-posts.json (newest first).
 * Usage: npx tsx scripts/list-own-posts.ts
 */

import { loadMyPosts } from "../src/agent/my-posts.js";

const posts = loadMyPosts().sort((a, b) => b.timestamp - a.timestamp);

console.log(`\nnimjiagent-sz945r — ${posts.length} tracked posts\n`);

for (const [i, p] of posts.entries()) {
  const ago = Math.round((Date.now() - p.timestamp) / 3600_000);
  console.log(`${i + 1}. [${p.type}] "${p.title}"`);
  console.log(`   /m/${p.submolt} | ${ago}h ago | ${p.postId}`);
  console.log();
}
