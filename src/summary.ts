/**
 * Activity Summary — compact index of past agent activity.
 *
 * Instead of sending raw history to the AI, generate a compact summary:
 * - Top performing post types
 * - Topics already covered
 * - Agents interacted with
 * - Engagement trends
 * - Task queue: what's done, what's pending, what's next
 *
 * The summary is regenerated periodically (every N cycles) by the sub-agent
 * and cached on disk. The main AI reads it as context.
 * On restart, the agent reads the summary and resumes from where it left off.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export type PostSummary = {
  id: string;
  title: string;
  submolt: string;
  type: string;
  upvotes: number;
  comments: number;
  timestamp: number;
};

export type AgentInteraction = {
  agentName: string;
  type: string; // "commented_on", "upvoted_by", "followed"
  count: number;
  lastAt: number;
};

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type TaskQueueItem = {
  id: string;
  type: "post" | "comment" | "upvote" | "follow" | "engage";
  description: string;
  target?: string; // post ID, agent name, topic, etc.
  status: TaskStatus;
  createdAt: number;
  completedAt?: number;
  result?: string; // success/failure message
};

export type ActivitySummary = {
  /** When this summary was generated */
  generatedAt: number;
  /** Total posts made */
  totalPosts: number;
  /** Total comments made */
  totalComments: number;
  /** Total upvotes given */
  totalUpvotes: number;
  /** Current karma (from API) */
  karma: number;
  /** Top performing post types (sorted by avg upvotes) */
  topPostTypes: Array<{ type: string; count: number; avgUpvotes: number }>;
  /** Submolts posted to (sorted by activity) */
  submoltActivity: Array<{ submolt: string; count: number }>;
  /** Topics already covered (dedup reference) */
  topicsCovered: string[];
  /** Agents interacted with */
  agentsInteracted: AgentInteraction[];
  /** Recent engagement trend: "growing" | "stable" | "declining" */
  engagementTrend: string;
  /** One-line insight for the AI */
  insight: string;
  /** Task queue: completed tasks */
  completedTasks: TaskQueueItem[];
  /** Task queue: pending tasks not yet started */
  pendingTasks: TaskQueueItem[];
  /** What the agent should do next on resume */
  nextAction: string;
  /** Last cycle number when this summary was generated */
  lastCycleNumber: number;
};

// ── Summary Generator ────────────────────────────────────────────────

export class SummaryGenerator {
  private summaryPath: string;

  constructor(dataDir?: string) {
    this.summaryPath = resolve(dataDir ?? process.cwd(), "data", "activity-summary.json");
  }

  /**
   * Generate a compact summary from raw post history, interactions, and task queue.
   * This is what the sub-agent produces periodically.
   */
  generate(
    postHistory: PostSummary[],
    interactions: Array<{ type: string; target?: string; agentName?: string; timestamp: number }>,
    karma: number,
    taskQueue: TaskQueueItem[] = [],
    cycleNumber = 0,
  ): ActivitySummary {
    // Post type performance
    const typeMap = new Map<string, { count: number; totalUpvotes: number }>();
    for (const post of postHistory) {
      const existing = typeMap.get(post.type) ?? { count: 0, totalUpvotes: 0 };
      existing.count++;
      existing.totalUpvotes += post.upvotes;
      typeMap.set(post.type, existing);
    }
    const topPostTypes = [...typeMap.entries()]
      .map(([type, data]) => ({
        type,
        count: data.count,
        avgUpvotes: Math.round((data.totalUpvotes / data.count) * 10) / 10,
      }))
      .sort((a, b) => b.avgUpvotes - a.avgUpvotes);

    // Submolt activity
    const submoltMap = new Map<string, number>();
    for (const post of postHistory) {
      submoltMap.set(post.submolt, (submoltMap.get(post.submolt) ?? 0) + 1);
    }
    const submoltActivity = [...submoltMap.entries()]
      .map(([submolt, count]) => ({ submolt, count }))
      .sort((a, b) => b.count - a.count);

    // Topics covered (unique, recent first)
    const topicsSeen = new Set<string>();
    const topicsCovered: string[] = [];
    for (const post of [...postHistory].reverse()) {
      const topic = post.title.toLowerCase().slice(0, 60);
      if (!topicsSeen.has(topic)) {
        topicsSeen.add(topic);
        topicsCovered.push(post.title);
      }
    }

    // Agent interactions
    const agentMap = new Map<string, { type: string; count: number; lastAt: number }>();
    for (const interaction of interactions) {
      if (!interaction.agentName) continue;
      const existing = agentMap.get(interaction.agentName) ?? { type: interaction.type, count: 0, lastAt: 0 };
      existing.count++;
      existing.lastAt = Math.max(existing.lastAt, interaction.timestamp);
      agentMap.set(interaction.agentName, existing);
    }
    const agentsInteracted = [...agentMap.entries()]
      .map(([agentName, data]) => ({
        agentName,
        type: data.type,
        count: data.count,
        lastAt: data.lastAt,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Engagement trend (simple: compare last 5 posts vs previous 5)
    const recentPosts = postHistory.slice(-5);
    const olderPosts = postHistory.slice(-10, -5);
    const recentAvg = recentPosts.length > 0
      ? recentPosts.reduce((s, p) => s + p.upvotes, 0) / recentPosts.length
      : 0;
    const olderAvg = olderPosts.length > 0
      ? olderPosts.reduce((s, p) => s + p.upvotes, 0) / olderPosts.length
      : 0;
    const engagementTrend = recentAvg > olderAvg * 1.2
      ? "growing"
      : recentAvg < olderAvg * 0.8
        ? "declining"
        : "stable";

    // One-line insight
    const bestType = topPostTypes[0];
    const insight = bestType
      ? `Best performing: ${bestType.type} (${bestType.avgUpvotes}↑ avg). Posted to ${submoltActivity[0]?.submolt ?? "none"} most.`
      : "No posts yet — ready to start.";

    // Task queue split
    const completedTasks = taskQueue.filter((t) => t.status === "completed" || t.status === "failed");
    const pendingTasks = taskQueue.filter((t) => t.status === "pending" || t.status === "in_progress");

    // Next action: first pending task or default
    const nextPending = pendingTasks[0];
    const nextAction = nextPending
      ? `${nextPending.type}: ${nextPending.description}`
      : "Check feed for engagement opportunities";

    return {
      generatedAt: Date.now(),
      totalPosts: postHistory.length,
      totalComments: interactions.filter((i) => i.type === "comment").length,
      totalUpvotes: interactions.filter((i) => i.type === "upvote").length,
      karma,
      topPostTypes,
      submoltActivity,
      topicsCovered: topicsCovered.slice(0, 30),
      agentsInteracted,
      engagementTrend,
      insight,
      completedTasks: completedTasks.slice(-20), // last 20 completed
      pendingTasks,
      nextAction,
      lastCycleNumber: cycleNumber,
    };
  }

  /** Save summary to disk. */
  save(summary: ActivitySummary): void {
    const dir = this.summaryPath.split("/").slice(0, -1).join("/");
    try {
      const { mkdirSync } = require("node:fs");
      mkdirSync(dir, { recursive: true });
    } catch { /* already exists */ }
    writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2));
  }

  /** Load summary from disk. Returns null if not found. */
  load(): ActivitySummary | null {
    if (!existsSync(this.summaryPath)) return null;
    try {
      return JSON.parse(readFileSync(this.summaryPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Format summary as compact text for the AI prompt.
   * This replaces sending raw history. Includes task queue status.
   */
  formatForPrompt(summary: ActivitySummary): string {
    const lines: string[] = [];

    lines.push("## Activity Summary (auto-generated)");
    lines.push(`- Posts: ${summary.totalPosts} | Comments: ${summary.totalComments} | Upvotes: ${summary.totalUpvotes} | Karma: ${summary.karma}`);
    lines.push(`- Engagement trend: ${summary.engagementTrend}`);
    lines.push(`- ${summary.insight}`);

    if (summary.topPostTypes.length > 0) {
      lines.push("- Post type performance:");
      for (const pt of summary.topPostTypes.slice(0, 5)) {
        lines.push(`  - ${pt.type}: ${pt.count} posts, ${pt.avgUpvotes}↑ avg`);
      }
    }

    if (summary.submoltActivity.length > 0) {
      lines.push("- Submolt distribution:");
      for (const sa of summary.submoltActivity.slice(0, 5)) {
        lines.push(`  - /m/${sa.submolt}: ${sa.count} posts`);
      }
    }

    if (summary.agentsInteracted.length > 0) {
      lines.push("- Agents you've interacted with:");
      for (const ai of summary.agentsInteracted.slice(0, 5)) {
        lines.push(`  - ${ai.agentName}: ${ai.count} interactions`);
      }
    }

    if (summary.topicsCovered.length > 0) {
      lines.push(`- Topics covered (last ${Math.min(summary.topicsCovered.length, 15)}): ${summary.topicsCovered.slice(0, 15).join("; ")}`);
    }

    // Task queue status
    const completedTasks = summary.completedTasks ?? [];
    const pendingTasks = summary.pendingTasks ?? [];

    if (completedTasks.length > 0) {
      lines.push(`- Completed tasks (${completedTasks.length}):`);
      for (const t of completedTasks.slice(-5)) {
        const status = t.status === "completed" ? "✅" : "❌";
        lines.push(`  - ${status} ${t.type}: ${t.description}${t.result ? ` → ${t.result}` : ""}`);
      }
    }

    if (pendingTasks.length > 0) {
      lines.push(`- Pending tasks (${pendingTasks.length}):`);
      for (const t of pendingTasks.slice(0, 5)) {
        const status = t.status === "in_progress" ? "🔄" : "⏳";
        lines.push(`  - ${status} ${t.type}: ${t.description}`);
      }
    }

    lines.push(`- Next action: ${summary.nextAction ?? "Check feed for engagement opportunities"}`);
    lines.push(`- Last cycle: #${summary.lastCycleNumber ?? 0}`);

    return lines.join("\n");
  }

  // ── Task Queue Management ──────────────────────────────────────────

  /** Add a task to the queue. Returns the task with generated ID. */
  addTask(
    queue: TaskQueueItem[],
    type: TaskQueueItem["type"],
    description: string,
    target?: string,
  ): TaskQueueItem {
    const task: TaskQueueItem = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      description,
      target,
      status: "pending",
      createdAt: Date.now(),
    };
    queue.push(task);
    return task;
  }

  /** Mark a task as completed. */
  completeTask(queue: TaskQueueItem[], taskId: string, result: string): void {
    const task = queue.find((t) => t.id === taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = Date.now();
      task.result = result;
    }
  }

  /** Mark a task as failed. */
  failTask(queue: TaskQueueItem[], taskId: string, result: string): void {
    const task = queue.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.completedAt = Date.now();
      task.result = result;
    }
  }

  /** Get the next pending task. */
  getNextTask(queue: TaskQueueItem[]): TaskQueueItem | null {
    return queue.find((t) => t.status === "pending") ?? null;
  }

  /** Clean up old completed tasks (keep last N). */
  cleanupQueue(queue: TaskQueueItem[], keepLast = 20): TaskQueueItem[] {
    const pending = queue.filter((t) => t.status === "pending" || t.status === "in_progress");
    const completed = queue.filter((t) => t.status === "completed" || t.status === "failed");
    return [...pending, ...completed.slice(-keepLast)];
  }
}
