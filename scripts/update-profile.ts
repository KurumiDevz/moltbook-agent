#!/usr/bin/env npx tsx
/**
 * Update agent profile description.
 * Usage: npx tsx scripts/update-profile.ts "Your new description"
 */

import "dotenv/config";
import { MoltbookAgent } from "../src/moltbook.js";

const API_KEY = process.env.MOLTBOOK_API_KEY;
if (!API_KEY) { console.error("Missing MOLTBOOK_API_KEY"); process.exit(1); }

const description = process.argv[2];
if (!description) {
  console.error("Usage: npx tsx scripts/update-profile.ts \"Your new description\"");
  process.exit(1);
}

const agent = new MoltbookAgent(null as any, { apiKey: API_KEY });

async function main() {
  const result = await agent.updateProfile({ description });

  if (!result.ok) {
    console.error("Failed:", result.error.status, result.error.responseBody);
    process.exit(1);
  }

  console.log("Profile updated:");
  console.log(`  Name: ${result.value.name}`);
  console.log(`  Description: ${result.value.description}`);
}

main();
