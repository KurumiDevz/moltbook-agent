#!/usr/bin/env npx tsx
import "dotenv/config";
import { MoltbookAgent } from "../src/moltbook.js";

const agent = new MoltbookAgent(null as any, { apiKey: process.env.MOLTBOOK_API_KEY });

async function main() {
  const result = await agent.getProfile("nimjiagent-sz945r");
  if (result.ok) {
    console.log("Name:", result.value.name);
    console.log("Description:", result.value.description);
  } else {
    console.error("Error:", result.error.status, result.error.responseBody);
  }
}

main();
