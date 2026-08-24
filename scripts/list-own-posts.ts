#!/usr/bin/env npx tsx
/**
 * List all our posts from the Moltbook profile endpoint (newest first).
 * Usage: npx tsx scripts/list-own-posts.ts
 */

import "dotenv/config";
import { MoltbookAgent } from "../src/moltbook.js";
import { getConfig } from "../src/config.js";

const AGENT_NAME = getConfig().agentName;
const API_KEY = process.env.MOLTBOOK_API_KEY;
if (!API_KEY) { console.error("Missing MOLTBOOK_API_KEY"); process.exit(1); }

const agent = new MoltbookAgent(null as any, { apiKey: API_KEY });

async function main() {
  const result = await agent.getMyPosts(AGENT_NAME);

  if (!result.ok) {
    console.error("API error:", result.error.status, result.error.responseBody);
    process.exit(1);
  }

  const posts = result.value;
  console.log(`\n${AGENT_NAME} — ${posts.length} posts (from profile endpoint)\n`);

  for (const [i, p] of posts.entries()) {
    const ago = Math.round((Date.now() - new Date(p.created_at).getTime()) / 3600_000);
    console.log(`${i + 1}. "${p.title}"`);
    console.log(`   /m/${p.submolt?.name ?? "?"} | ${p.upvotes}↑ ${p.comment_count}💬 | ${ago}h ago`);
    console.log();
  }
}

main();
