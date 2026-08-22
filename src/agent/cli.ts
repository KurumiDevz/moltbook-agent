#!/usr/bin/env node

import { Gateway } from "../gateway.js";
import { GeminiProvider } from "../gemini-provider.js";
import { createMoltbookAgent } from "../moltbook.js";
import { createBrain } from "../brain/index.js";
import { AutonomousAgent } from "./agent.js";

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
  await gateway.initializeProvider("gemini", { type: "gemini", options: { cookies } });

  // Create Moltbook agent + Brain
  const moltbookAgent = createMoltbookAgent(gateway, { apiKey });
  const brain = createBrain({ gateway });

  // Create AutonomousAgent
  const agent = new AutonomousAgent({
    moltbookAgent,
    brain,
    submolts: args.submolts,
  });

  // --status: show and exit
  if (args.status) {
    const s = agent.getStatus();
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  // --dry-run: observe + decide but don't execute
  if (args.dryRun) {
    console.log("🧪 Dry run — observe + decide only");
    await agent.dryRun();
    return;
  }

  // Handle shutdown gracefully
  process.on("SIGINT", async () => {
    await agent.stop();
    process.exit(0);
  });

  // --cycles N: run N cycles then exit
  if (args.cycles !== null) {
    console.log(`🔄 Running ${args.cycles} cycle(s)`);
    for (let i = 0; i < args.cycles; i++) {
      await agent.cycle();
    }
    await agent.stop();
    return;
  }

  // Default: run forever
  await agent.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
