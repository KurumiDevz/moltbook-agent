/**
 * Agent V2 — Thin orchestrator.
 *
 * Delegates to cycle.ts for cycle logic, hydration.ts for startup recovery.
 * Simple loop: start → cycle → sleep → repeat.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { Gateway } from "../gateway.js";
import { BrainV2 } from "../brain/index.js";
import { SummaryGenerator } from "../summary.js";
import { rotateOnDeploy } from "../session-manager.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { AgentDecision, ExecutionResult, ActivitySummary } from "../types.js";

import type { AgentV2Config, MemoryState } from "./types.js";
import { sleep } from "./helpers.js";
import { hydrateReplyCounts } from "./hydration.js";
import { runCycle, type CycleResult } from "./cycle.js";
import { getConfig } from "../config.js";

// Re-export for backward compatibility
export type { ExecutionResult } from "../types.js";

// ── AgentV2 ──────────────────────────────────────────────────────────

export class AgentV2 {
  private moltbookAgent: MoltbookAgent;
  private brain: BrainV2;
  private gateway: Gateway;
  private subAgentModel: string;
  private summaryGen: SummaryGenerator;
  private submolts: string[];
  private running = false;
  private cycleCount = 0;
  private memory: MemoryState;
  private summaryInterval: number;
  private lastSummary: ActivitySummary | null = null;

  constructor(config: AgentV2Config) {
    this.moltbookAgent = config.moltbookAgent;
    this.gateway = config.gateway;
    this.subAgentModel = config.subAgentModel ?? "flash-lite";
    this.brain = new BrainV2({
      gateway: config.gateway,
      model: config.model,
      skillPath: config.skillPath,
      skillsDir: config.skillsDir,
    });
    this.summaryGen = new SummaryGenerator(config.dataDir);
    this.submolts = config.submolts ?? ["general", "agents", "builds"];
    this.summaryInterval = config.summaryInterval ?? 5;

    // Load existing summary to resume task queue
    const existingSummary = this.summaryGen.load();
    this.lastSummary = existingSummary;

    this.memory = {
      topicsSeen: [],
      totalPosts: 0,
      totalComments: 0,
      totalUpvotes: 0,
      commentsToday: 0,
      lastCommentAt: 0,
      lastPostAt: 0,
      taskQueue: existingSummary
        ? [...(existingSummary.completedTasks ?? []), ...(existingSummary.pendingTasks ?? [])]
        : [],
      repliedCommentIds: new Set(existingSummary?.repliedCommentIds ?? []),
      repliedThreadCounts: new Map<string, number>(
        existingSummary?.repliedThreadCounts
          ? Object.entries(existingSummary.repliedThreadCounts)
          : [],
      ),
      repliedPostCounts: new Map<string, number>(
        existingSummary?.repliedPostCounts
          ? Object.entries(existingSummary.repliedPostCounts)
          : [],
      ),
      postHistory: (existingSummary?.postHistory ?? []).map((p: any) => ({
        id: p.id, title: p.title, content: p.content, submolt: p.submolt, type: p.type,
        upvotes: p.upvotes ?? 0, comments: p.comments ?? 0, timestamp: p.timestamp ?? 0,
      })),
      stances: existingSummary?.stances ?? [],
      foreignStances: existingSummary?.foreignStances ?? [],
    };

    // Resume cycle count from last summary
    if (existingSummary?.lastCycleNumber) {
      this.cycleCount = existingSummary.lastCycleNumber;
    }

    // Log resumed state
    if (existingSummary) {
      const pending = this.memory.taskQueue.filter((t) => t.status === "pending");
      console.log(`📋 Resumed from cycle #${this.cycleCount} — ${pending.length} pending tasks`);
    }
  }

  /** Start the autonomous loop. */
  async start(): Promise<void> {
    this.running = true;
    console.log("🚀 Agent V2 started — prompt-driven mode");
    console.log(`   Submolts: ${this.submolts.join(", ")}`);

    // Rotate all conversations on deploy (version change) to prevent poisoned context
    try {
      const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
      rotateOnDeploy(pkg.version);
    } catch { /* ignore */ }

    // Hydrate reply counts from API before first cycle
    await hydrateReplyCounts(this.moltbookAgent, this.memory);

    while (this.running) {
      try {
        const cycleResult = await runCycle({
          moltbookAgent: this.moltbookAgent,
          brain: this.brain,
          gateway: this.gateway,
          memory: this.memory,
          summaryGen: this.summaryGen,
          subAgentModel: this.subAgentModel,
          summaryInterval: this.summaryInterval,
          cycleCount: this.cycleCount,
          lastSummary: this.lastSummary,
        });
        this.cycleCount = cycleResult.cycleCount;
        this.lastSummary = cycleResult.lastSummary;
      } catch (err) {
        console.error("💥 Cycle error:", err);
      }
      const [min, max] = getConfig().cycleSleepMs;
      await sleep(min + Math.random() * (max - min));
    }
  }

  /** Single cycle: observe → think → act. */
  async cycle(): Promise<ExecutionResult> {
    const cycleResult = await runCycle({
      moltbookAgent: this.moltbookAgent,
      brain: this.brain,
      gateway: this.gateway,
      memory: this.memory,
      summaryGen: this.summaryGen,
      subAgentModel: this.subAgentModel,
      summaryInterval: this.summaryInterval,
      cycleCount: this.cycleCount,
      lastSummary: this.lastSummary,
    });
    this.cycleCount = cycleResult.cycleCount;
    this.lastSummary = cycleResult.lastSummary;
    return cycleResult.result;
  }

  /** Stop the loop. */
  stop(): void {
    this.running = false;
    console.log("🛑 Agent V2 stopping...");
  }

  /** Dry run — observe + decide, no execution. */
  async dryRun(): Promise<AgentDecision> {
    console.log("\n🧪 Dry run — observe + decide only");

    const { fetchFeed, fetchHome, fetchRelevantPosts, fetchNotifications } = await import("./context.js");
    const { getRateLimits } = await import("./helpers.js");

    const rawFeed = await fetchFeed(this.moltbookAgent);
    const relevantPosts = await fetchRelevantPosts(this.moltbookAgent, this.memory);
    const notifications = await fetchNotifications(this.moltbookAgent, this.memory);
    const rateLimits = getRateLimits(this.memory);
    const home = await fetchHome(this.moltbookAgent);

    // Merge hot feed + semantic search results
    const seenIds = new Set(rawFeed.map((p) => p.id));
    for (const p of relevantPosts) {
      if (!seenIds.has(p.id)) {
        rawFeed.push(p);
        seenIds.add(p.id);
      }
    }
    const feed = rawFeed;
    console.log(`   Home: ${home.activity.length} posts with activity | ${home.unreadCount} unread`);
    console.log(`   Feed: ${feed.length} posts (${relevantPosts.length} from semantic search)`);

    const summaryText = this.summaryGen.formatForPrompt(this.summaryGen.generate(this.memory.postHistory, [], 0, [], 0, this.memory.stances, this.memory.foreignStances));

    const decision = await this.brain.decide({
      feed,
      notifications,
      rateLimits,
      postHistory: this.memory.postHistory,
      recentInteractions: [],
      summary: summaryText,
      stances: this.memory.stances,
      foreignStances: this.memory.foreignStances,
    });

    console.log(`\n📋 Would execute: ${decision.action}`);
    console.log(`   Reason: ${decision.reason}`);
    return decision;
  }
}
