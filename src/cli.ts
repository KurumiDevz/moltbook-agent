#!/usr/bin/env node

/**
 * Agent V2 CLI — prompt-driven autonomous agent.
 * Lives at src/cli.ts (outside src/agent/) to avoid V1 module resolution issues.
 */

import "dotenv/config";
import { Gateway } from "./gateway.js";
import { GeminiProvider } from "./providers/index.js";
import { createMoltbookAgent } from "./moltbook.js";
import { AgentV2 } from "./agent/index.js";
import { getConfig } from "./config.js";

function parseArgs(argv: string[]) {
  const args: {
    submolts: string[];
    dryRun: boolean;
    status: boolean;
    cycles: number | null;
  } = {
    submolts: ["general", "agents", "builds"],
    dryRun: false,
    status: false,
    cycles: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--submolts":
        args.submolts = argv[++i]?.split(",") ?? args.submolts;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--status":
        args.status = true;
        break;
      case "--cycles":
        args.cycles = Number(argv[++i]) || null;
        break;
    }
  }
  return args;
}

async function main() {
  console.log("🔧 Agent V2 CLI (src/cli.ts)"); // ← confirms which file runs
  const args = parseArgs(process.argv);

  // Load env
  const apiKey = process.env.MOLTBOOK_API_KEY;
  const cookies = process.env.COOKIES;
  if (!apiKey || !cookies) {
    console.error("❌ Missing COOKIES or MOLTBOOK_API_KEY in environment");
    process.exit(1);
  }

  // Create Gateway + Gemini
  const gateway = new Gateway();
  const gemini = new GeminiProvider();
  gateway.registerProvider(gemini);
  const config = getConfig();
  await gateway.initializeProvider("gemini", { type: "gemini", options: {
    cookies,
    deepRefresh: process.env.DEEP_REFRESH === "true" || config.deepRefresh,
    forceRefresh: process.env.FORCE_REFRESH === "true" || config.forceRefresh,
    bardUtilsUrl: process.env.BARD_UTILS_URL || config.bardUtilsUrl,
  } });

  // Create Moltbook agent
  const moltbookAgent = createMoltbookAgent(gateway, { apiKey });

  // Create AgentV2 (prompt-driven, uses skills/ directory)
  const agent = new AgentV2({
    moltbookAgent,
    gateway,
    submolts: args.submolts,
    skillsDir: "skills",
    summaryInterval: 5,
  });

  // --status: show and exit
  if (args.status) {
    console.log("Agent V2 (prompt-driven mode)");
    console.log(`  Submolts: ${args.submolts.join(", ")}`);
    console.log(`  Skills dir: skills/`);
    console.log(`  Summary interval: every 5 cycles`);
    return;
  }

  // --dry-run: observe + decide but don't execute
  if (args.dryRun) {
    const decision = await agent.dryRun();
    console.log(`\n📋 Would execute: ${decision.action}`);
    console.log(`   Reason: ${decision.reason}`);
    return;
  }

  // Handle shutdown gracefully
  process.on("SIGINT", () => {
    agent.stop();
    process.exit(0);
  });

  // --cycles N: run N cycles then exit
  if (args.cycles !== null) {
    console.log(`🔄 Running ${args.cycles} cycle(s)`);
    for (let i = 0; i < args.cycles; i++) {
      await agent.cycle();
    }
    agent.stop();
    return;
  }

  // Default: run forever
  await agent.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
