import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MoltbookAgent } from "../moltbook.js";
import type { Brain } from "../brain/index.js";
import { Personality } from "./personality.js";
import { Memory } from "./memory.js";
import { Observer } from "./observer.js";
import { DecisionEngine } from "./decision.js";
import { Executor } from "./executor.js";
import type { ScoredAction } from "./types.js";

export type AgentConfig = {
  moltbookAgent: MoltbookAgent;
  brain: Brain;
  personalityPath?: string;
  memoryPath?: string;
  submolts?: string[];
};

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Main autonomous agent — observe, think, act, reflect, rest. */
export class AutonomousAgent {
  private moltbookAgent: MoltbookAgent;
  private brain: Brain;
  private personality: Personality;
  private memory: Memory;
  private observer: Observer;
  private decisionEngine: DecisionEngine;
  private executor: Executor;
  private personalityPath: string;
  private memoryPath: string;
  private submolts: string[];
  private running = false;
  private cycleCount = 0;

  constructor(config: AgentConfig) {
    this.moltbookAgent = config.moltbookAgent;
    this.brain = config.brain;
    this.personalityPath = config.personalityPath ?? "src/agent/data/personality.json";
    this.memoryPath = config.memoryPath ?? "src/agent/data/memory.json";
    this.submolts = config.submolts ?? ["general", "agents", "builds"];

    this.personality = Personality.default();
    this.memory = Memory.default();
    this.observer = new Observer(this.moltbookAgent, this.personality);
    this.decisionEngine = new DecisionEngine();
    this.executor = new Executor(this.moltbookAgent, this.brain);

    this.loadState();
  }

  /** Main loop — runs until stop() is called. */
  async start(): Promise<void> {
    this.running = true;
    console.log(`🚀 Agent started — mood: ${this.personality.state.mood}`);
    console.log(`   Submolts: ${this.submolts.join(", ")}`);
    console.log(`   Karma: ${this.memory.state.karma}`);

    while (this.running) {
      try {
        await this.cycle();
      } catch (err) {
        console.error("💥 Cycle error:", err);
      }
      await randomDelay(30_000, 120_000);
    }
  }

  /** Single observe→think→act→reflect cycle. */
  async cycle(): Promise<void> {
    this.cycleCount++;
    console.log(`\n── Cycle ${this.cycleCount} ──`);

    const { chosen } = await this.observeAndThink();

    // 3. ACT
    console.log("📝 Acting...");
    const result = await this.executor.execute(chosen, this.personality, this.memory);
    const emoji = result.success ? "✅" : "❌";
    console.log(`   ${emoji} ${result.message}`);

    // 4. REFLECT
    this.reflect(result.success);

    // 5. Persist
    this.saveState();
  }

  /** Observe and decide without executing (for dry-run mode). */
  async dryRun(): Promise<void> {
    console.log("\n🧪 Dry run — observe + decide only");
    const { posts, chosen, trends, interesting } = await this.observeAndThink();
    void posts;
    void trends;
    void interesting;
    console.log(`\n📋 Would execute: ${chosen.action.type}`);
    console.log(`   Score: ${chosen.score.toFixed(1)} — ${chosen.reason}`);
  }

  /** Shared observe + think logic for cycle() and dryRun(). */
  private async observeAndThink() {
    // 1. OBSERVE
    console.log("👀 Observing feed...");
    const { posts } = await this.observer.observeFeed("hot", 25);
    console.log(`   Read ${posts.length} posts`);

    console.log("🔔 Checking notifications...");
    const notifications = await this.observer.checkNotifications();
    if (notifications.mentionCount > 0) {
      console.log(`   📩 ${notifications.mentionCount} mentions, ${notifications.replyCount} replies`);
    }

    // 2. THINK
    console.log("🤔 Thinking...");
    const trends = this.observer.detectTrends(posts);
    const interesting = this.observer.findInterestingAgents(posts, this.memory);
    const scored = this.decisionEngine.decide(this.personality, this.memory, posts, trends, interesting, {
      recentNotifications: notifications.recentActivity,
    });
    if (process.env.DEBUG) {
      console.log(
        "   Scored actions:",
        scored.map((s) => `${s.action.type}:${s.score.toFixed(0)}(${s.reason})`).join(", "),
      );
    }
    const recentInteractions = this.memory.getRecentInteractions(5);
    const recentActions: ScoredAction[] = recentInteractions.map((i) => ({
      action: { type: i.type as ScoredAction["action"]["type"] } as ScoredAction["action"],
      score: 0,
      reason: "",
    }));
    const chosen = this.decisionEngine.selectAction(scored, recentActions);
    console.log(`   Decision: ${chosen.action.type} (score: ${chosen.score.toFixed(1)}) — ${chosen.reason}`);

    return { posts, trends, interesting, scored, chosen };
  }

  /** Reflect on an outcome — shift mood, log. */
  private reflect(success: boolean): void {
    console.log("💭 Reflecting...");
    if (success) {
      this.personality.shiftMood("karma_gain");
    }
    console.log(`   Mood: ${this.personality.state.mood} — ${this.personality.getMoodDescription()}`);
  }

  /** Stop the main loop and persist state. */
  async stop(): Promise<void> {
    console.log("\n🛑 Stopping agent...");
    this.running = false;
    this.saveState();
    console.log(`   Final state — karma: ${this.memory.state.karma}, cycles: ${this.cycleCount}`);
  }

  /** Save personality and memory to disk. */
  saveState(): void {
    ensureDir(this.personalityPath);
    ensureDir(this.memoryPath);
    this.personality.saveFile(this.personalityPath);
    this.memory.saveFile(this.memoryPath);
  }

  /** Load from disk; fall back to defaults if files don't exist. */
  loadState(): void {
    if (existsSync(this.personalityPath)) {
      this.personality = Personality.fromFile(this.personalityPath);
      this.observer = new Observer(this.moltbookAgent, this.personality);
    }
    if (existsSync(this.memoryPath)) {
      this.memory = Memory.fromFile(this.memoryPath);
    }
    // Ensure startedAt is set
    if (this.memory.state.startedAt === 0) {
      this.memory.state.startedAt = Date.now();
    }
  }

  /** Return a snapshot of the agent's current status. */
  getStatus(): {
    mood: string;
    moodDescription: string;
    karma: number;
    totalPosts: number;
    totalComments: number;
    cycleCount: number;
    running: boolean;
    uptimeMs: number;
  } {
    return {
      mood: this.personality.state.mood,
      moodDescription: this.personality.getMoodDescription(),
      karma: this.memory.state.karma,
      totalPosts: this.memory.state.totalPosts,
      totalComments: this.memory.state.totalComments,
      cycleCount: this.cycleCount,
      running: this.running,
      uptimeMs: Date.now() - this.memory.state.startedAt,
    };
  }
}
