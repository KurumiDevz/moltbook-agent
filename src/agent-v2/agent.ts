/**
 * Agent V2 — Main orchestrator.
 *
 * Simple loop: gather context → AI decides → execute → record → repeat.
 * Uses sub-agent for feed scoring + summary generation.
 * Uses compact activity summary instead of raw history.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { Gateway } from "../gateway.js";
import { BrainV2 } from "../brain-v2/index.js";
import { runSubAgentTask } from "../sub-agent.js";
import { SummaryGenerator } from "../summary.js";
import { shouldRotateConversation, deleteConversation, rotateOnDeploy, cleanupOldPostConversations } from "../session-manager.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { AgentDecision, ExecutionResult, ScoredPost, ActivitySummary } from "../types.js";

import type { AgentV2Config, MemoryState } from "./types.js";
import { getRateLimits, sleep, recordForeignStance } from "./helpers.js";
import { fetchFeed, fetchHome, fetchRelevantPosts, fetchNotifications } from "./context.js";
import { execute as executeAction } from "./executor.js";

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
    await this.hydrateReplyCounts();

    while (this.running) {
      try {
        await this.cycle();
      } catch (err) {
        console.error("💥 Cycle error:", err);
      }
      await sleep(30_000 + Math.random() * 90_000);
    }
  }

  /** Hydrate repliedThreadCounts from API on startup — scans feed + notifications for our posts and comments. */
  private async hydrateReplyCounts(): Promise<void> {
    console.log("🔄 Hydrating reply counts from API...");
    const postIdsToScan = new Set<string>();

    try {
      // 1. Find our posts by scanning the feed (same approach as my-posts.ts)
      for (const sort of ["new", "hot", "top"] as const) {
        let offset = 0;
        for (let page = 0; page < 5; page++) {
          try {
            const result = await this.moltbookAgent.listPosts({ sort, limit: 50, offset });
            if (!result.ok) break;
            const data = result.value as any;
            const posts = data.posts ?? [];
            for (const p of posts) {
              if (p.author?.name === "nimjiagent-sz945r" || p.author === "nimjiagent-sz945r") {
                postIdsToScan.add(p.id);
              }
            }
            if (!data.has_more || posts.length === 0) break;
            offset = data.next_offset ?? offset + 50;
          } catch {
            break;
          }
        }
      }
    } catch {
      /* feed scan failed */
    }

    try {
      // 2. Find other posts we commented on via notifications (replies to our comments)
      const notifs = await this.moltbookAgent.getNotifications({ limit: 100 });
      if (notifs.ok) {
        const data = notifs.value as any;
        for (const n of data.notifications ?? []) {
          if (n.post_id) postIdsToScan.add(n.post_id);
        }
      }
    } catch {
      /* notification scan failed */
    }

    // 3. Fallback: use persisted postHistory from disk if feed + notifications found nothing
    if (postIdsToScan.size === 0 && this.memory.postHistory.length > 0) {
      console.log(`   Feed/notifications empty — using ${this.memory.postHistory.length} persisted posts`);
      for (const p of this.memory.postHistory) {
        postIdsToScan.add(p.id);
      }
    }

    if (postIdsToScan.size === 0) {
      console.log("   No posts found — starting fresh");
      return;
    }

    console.log(`   Found ${postIdsToScan.size} posts to scan — counting replies...`);

    // 3. For each post, list comments and count our replies per thread
    let threadCount = 0;
    for (const postId of postIdsToScan) {
      try {
        const commentsResult = await this.moltbookAgent.listComments(postId, { sort: "old", limit: 100 });
        if (!commentsResult.ok) continue;
        const comments = (commentsResult.value as any).comments ?? [];
        for (const c of comments) {
          if (c.author?.name === "nimjiagent-sz945r") {
            const threadKey = c.parentId ?? c.id;
            const current = this.memory.repliedThreadCounts.get(threadKey) ?? 0;
            this.memory.repliedThreadCounts.set(threadKey, current + 1);
            this.memory.repliedCommentIds.add(c.id);
          }
        }
      } catch {
        /* skip failed posts */
      }
    }

    const hydrated = [...this.memory.repliedThreadCounts.entries()].filter(([, c]) => c > 0);
    threadCount = hydrated.length;
    if (hydrated.length > 0) {
      console.log(`   Hydrated ${hydrated.length} threads: ${hydrated.map(([id, c]) => `${id.slice(0, 8)}...(${c})`).join(", ")}`);
    } else {
      console.log("   No existing replies found (comments may be deleted)");
    }
  }

  /** Stop the loop. */
  stop(): void {
    this.running = false;
    console.log("🛑 Agent V2 stopping...");
  }

  /** Single cycle: observe → think → act. */
  async cycle(): Promise<ExecutionResult> {
    this.cycleCount++;
    console.log(`\n── Cycle ${this.cycleCount} ──`);

    // Rotate stale conversations to prevent hallucination loops
    const convoKeys = ["revalidate", "sub-score"];
    for (const key of convoKeys) {
      if (shouldRotateConversation(key, 12 * 60 * 60 * 1000)) {
        deleteConversation(key);
        if (process.env.DEBUG) console.log(`[agent] Rotated stale conversation: ${key}`);
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    if (shouldRotateConversation(`post-${today}`, 24 * 60 * 60 * 1000)) {
      deleteConversation(`post-${today}`);
    }

    // Clean up old per-post conversation files (prevent disk accumulation)
    const cleaned = cleanupOldPostConversations(48 * 60 * 60 * 1000); // 48h threshold
    if (cleaned > 0) {
      console.log(`   Cleaned ${cleaned} stale post conversation(s)`);
    }

    // 1. Gather context
    console.log("👀 Gathering context...");
    const rawFeed = await fetchFeed(this.moltbookAgent);
    const relevantPosts = await fetchRelevantPosts(this.moltbookAgent, this.memory);
    const allNotifications = await fetchNotifications(this.moltbookAgent, this.memory);
    const rateLimits = getRateLimits(this.memory);
    const home = await fetchHome(this.moltbookAgent);

    // Hard-blocked post IDs — deleted/stale posts that still appear in feed/summary
    const blockedPostIds = new Set([
      "d7c66376-f1be-403d-8a9b-d4656e4fa250",
      "3fce4b5f-7113-43bb-b6db-333b0fba0760",
      "cb431ae4-25e5-4fb6-8e73-e5ed62a44d29",
      "c9077efc-08ea-40f5-b1c0-5cf48f3f16b0",
      "a25e996f-3125-4a2d-a8a5-83ef5c3d4f5d",
      "467a1f9b-2966-4236-9602-39e12f26e3b3",
    ]);

    // Purge blocked posts from ALL context BEFORE AI sees anything
    for (const feedArr of [rawFeed, relevantPosts]) {
      for (let i = feedArr.length - 1; i >= 0; i--) {
        if (blockedPostIds.has(feedArr[i].id)) feedArr.splice(i, 1);
      }
    }
    for (const h of home.activity) {
      if (blockedPostIds.has(h.post_id)) h.post_id = ""; // blank it out
    }
    // Purge blocked posts from stances (prevents AI from referencing them)
    this.memory.stances = this.memory.stances.filter((s) => !blockedPostIds.has(s.source));
    this.memory.foreignStances = this.memory.foreignStances.filter((s) => !blockedPostIds.has(s.context));

    // Filter out: already-replied, self-notifications, and stochastic per-thread cap
    const MAX_COMMENTS_PER_POST = 2;
    const notifications = allNotifications.filter((n) => {
      if (n.postId && blockedPostIds.has(n.postId)) return false; // blocked post

      // Per-post cap: block NEW top-level comment notifications on capped posts
      // BUT always allow: (1) replies to our comments, (2) comments on OUR own posts
      if (n.postId) {
        const postCommentCount = this.memory.repliedPostCounts.get(n.postId) ?? 0;
        if (postCommentCount >= MAX_COMMENTS_PER_POST) {
          const isReplyToUs = n.type === "comment_reply";
          const isOurPost = this.memory.postHistory.some((p) => p.id === n.postId);
          if (!isReplyToUs && !isOurPost) return false;
          // reply notifications and comments on our own posts always pass
        }
      }

      if (n.commentId && this.memory.repliedCommentIds.has(n.commentId)) {
        return false; // already replied
      }
      // Per-thread stochastic cap: 1st=100%, 2nd=30%, 3rd+=0%
      if (n.commentId) {
        const threadKey = n.commentId;
        const count = this.memory.repliedThreadCounts.get(threadKey) ?? 0;
        const chances = [1.0, 0.3, 0];
        const chance = chances[Math.min(count, 2)];
        if (Math.random() > chance) {
          return false;
        }
      }
      return true;
    });
    const filteredCount = allNotifications.length - notifications.length;
    if (filteredCount > 0) {
      console.log(`   Filtered ${filteredCount} already-replied/self/over-posted notifications`);
    }

    // Merge hot feed + semantic search results (deduplicate by id)
    const seenIds = new Set(rawFeed.map((p) => p.id));
    for (const p of relevantPosts) {
      if (!seenIds.has(p.id)) {
        rawFeed.push(p);
        seenIds.add(p.id);
      }
    }

    // Remove posts where we've hit the comment cap (prevents AI from seeing them every cycle)
    const feedBeforeCapped = rawFeed.length;
    for (let i = rawFeed.length - 1; i >= 0; i--) {
      if ((this.memory.repliedPostCounts.get(rawFeed[i].id) ?? 0) >= MAX_COMMENTS_PER_POST) {
        rawFeed.splice(i, 1);
      }
    }
    const cappedRemoved = feedBeforeCapped - rawFeed.length;
    if (cappedRemoved > 0) {
      console.log(`   Removed ${cappedRemoved} posts at comment cap (${MAX_COMMENTS_PER_POST}x max)`);
    }

    console.log(`   Home: ${home.activity.length} posts with activity | ${home.unreadCount} unread`);
    console.log(`   Feed: ${rawFeed.length} posts (${relevantPosts.length} from semantic search)`);

    // 2. Sub-agent scores feed (lightweight, fire-and-forget)
    console.log("🔍 Sub-agent scoring feed...");
    let feed: typeof rawFeed;
    try {
      const task = {
        type: "score_feed" as const,
        posts: rawFeed.map((p) => ({
          id: p.id,
          title: p.title,
          content: p.content,
          submolt: p.submolt,
          author: p.author,
          upvotes: p.upvotes,
          comment_count: p.comment_count,
        })),
        agentValues: ["security", "craft", "honesty", "autonomy"],
        prompt: "",
      };
      const scored = await runSubAgentTask(task, (opts) => this.gateway.generate({ ...opts, conversationKey: "sub-score" }), this.subAgentModel);
      feed = (scored as { type: "scored_feed"; posts: ScoredPost[] }).posts.map((p) => ({
        id: p.id,
        title: p.title,
        content: p.content,
        submolt: p.submolt,
        author: p.author,
        upvotes: p.upvotes,
        comment_count: p.comment_count,
        createdAt: "",
      }));
    } catch {
      // Fallback: use raw feed without scoring
      feed = rawFeed;
    }

    console.log(`   Feed: ${feed.length} posts | Notifications: ${notifications.length}`);
    console.log(`   Rate limits: post=${rateLimits.canPost} comment=${rateLimits.canComment}`);

    // Record foreign stances from feed posts
    for (const post of feed) {
      if (post.author !== "nimjiagent-sz945r" && post.title) {
        recordForeignStance(
          this.memory,
          post.author,
          "",  // agentId not available in FeedPost
          post.submolt,
          post.title,
          post.content ?? post.title,
          "post",
          post.id,
        );
      }
    }

    // 3. Generate activity summary periodically (with task queue)
    let summaryText: string | undefined;
    if (this.cycleCount % this.summaryInterval === 0 || !this.lastSummary) {
      console.log("📊 Generating activity summary...");
      try {
        this.lastSummary = this.summaryGen.generate(
          this.memory.postHistory,
          [], // interactions (could track these later)
          0, // karma (could fetch from API)
          this.memory.taskQueue,
          this.cycleCount,
          this.memory.stances,
          this.memory.foreignStances,
        );
        // Merge in-memory replied comment IDs into summary so they persist across restarts
        this.lastSummary.repliedCommentIds = [
          ...new Set([...(this.lastSummary.repliedCommentIds ?? []), ...this.memory.repliedCommentIds]),
        ];
        // Clean up old completed tasks
        this.memory.taskQueue = this.summaryGen.cleanupQueue(this.memory.taskQueue);
        this.summaryGen.save(this.lastSummary);
        summaryText = this.summaryGen.formatForPrompt(this.lastSummary);
        console.log(`   Summary: ${this.lastSummary.insight}`);
      } catch (err) {
        console.warn("   Summary generation failed:", err);
      }
    } else if (this.lastSummary) {
      summaryText = this.summaryGen.formatForPrompt(this.lastSummary);
    }

    // 4. AI decides (with summary context)
    console.log("🤔 AI deciding...");
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

    console.log(`   Decision: ${decision.action} — ${decision.reason}`);

    // Phase 3: AI revalidates its own decision
    // Fetch real comment count from API for reply/comment decisions
    let ownCommentCount = 0;
    if ((decision.action === "reply_to_comment" || decision.action === "comment") && "postId" in decision) {
      try {
        const commentsResult = await this.moltbookAgent.listComments(decision.postId, { sort: "old", limit: 100 });
        if (commentsResult.ok) {
          const comments = (commentsResult.value as any).comments ?? [];
          ownCommentCount = comments.filter((c: any) => c.author?.name === "nimjiagent-sz945r").length;
          // Sync in-memory count with reality
          this.memory.repliedThreadCounts.set(decision.postId, ownCommentCount);
        }
      } catch {
        // API failed — fall back to in-memory count
        ownCommentCount = this.memory.repliedThreadCounts.get(decision.postId) ?? 0;
      }
    }

    const revalidation = await this.brain.revalidateDecision(decision, {
      repliedThreadCounts: this.memory.repliedThreadCounts,
      ownCommentCount,
      commentsToday: this.memory.commentsToday,
      recentActions: this.memory.taskQueue.slice(-5).map((t) => `${t.type}: ${t.description}`),
      notificationAgentNames: notifications.filter((n) => n.agentName).map((n) => n.agentName!),
    });

    let finalDecision = decision;
    if (!revalidation.valid) {
      console.log(`   🛑 Revalidation rejected: ${revalidation.reason}`);
      finalDecision = {
        action: (revalidation.fallback ?? "scroll") as AgentDecision["action"],
        reason: revalidation.reason,
      } as AgentDecision;
    }

    // 5. Add task to queue before executing (use finalDecision after revalidation)
    const task = this.summaryGen.addTask(
      this.memory.taskQueue,
      finalDecision.action === "post"
        ? "post"
        : finalDecision.action === "comment"
          ? "comment"
          : finalDecision.action === "upvote"
            ? "upvote"
            : finalDecision.action === "follow"
              ? "follow"
              : "engage",
      finalDecision.reason,
      finalDecision.action === "post"
        ? finalDecision.topic
        : finalDecision.action === "comment"
          ? finalDecision.postId
          : finalDecision.action === "upvote"
            ? finalDecision.postId
            : finalDecision.action === "follow"
              ? finalDecision.agentName
              : undefined,
    );

    // Persist pending task immediately (crash resilience: task survives mid-cycle crash)
    try {
      const preExecSummary = this.summaryGen.generate(
        this.memory.postHistory,
        [],
        0,
        this.memory.taskQueue,
        this.cycleCount,
        this.memory.stances,
        this.memory.foreignStances,
        Object.fromEntries(this.memory.repliedThreadCounts),
        Object.fromEntries(this.memory.repliedPostCounts),
        [...this.memory.repliedCommentIds],
        this.memory.postHistory,
      );
      this.summaryGen.save(preExecSummary);
      this.lastSummary = preExecSummary;
    } catch {
      /* best effort */
    }

    // 6. Execute (use finalDecision after revalidation, NOT original decision)
    console.log("⚡ Executing...");
    const result = await executeAction(finalDecision, {
      moltbookAgent: this.moltbookAgent,
      brain: this.brain,
      memory: this.memory,
    });
    const emoji = result.success ? "✅" : "❌";
    console.log(`   ${emoji} ${result.message}`);

    // 6b. Mark this post's notifications as read after acting (not blanket clear)
    if (result.success && finalDecision.action !== "scroll" && "postId" in finalDecision) {
      try {
        await this.moltbookAgent.markNotificationsRead(finalDecision.postId);
      } catch {
        /* best effort — just means unread count won't decrease for this post */
      }
    }

    // 7. Update task status
    if (result.success) {
      this.summaryGen.completeTask(this.memory.taskQueue, task.id, result.message);
    } else {
      this.summaryGen.failTask(this.memory.taskQueue, task.id, result.message);
    }

    // 8. Save summary after each cycle (persist task state + reply counts + post history)
    try {
      const cycleSummary = this.summaryGen.generate(
        this.memory.postHistory,
        [],
        0,
        this.memory.taskQueue,
        this.cycleCount,
        this.memory.stances,
        this.memory.foreignStances,
        Object.fromEntries(this.memory.repliedThreadCounts),
        Object.fromEntries(this.memory.repliedPostCounts),
        [...this.memory.repliedCommentIds],
        this.memory.postHistory,
      );
      this.summaryGen.save(cycleSummary);
      this.lastSummary = cycleSummary;
    } catch {
      /* best effort save */
    }

    return result;
  }

  /** Dry run — observe + decide, no execution. */
  async dryRun(): Promise<AgentDecision> {
    console.log("\n🧪 Dry run — observe + decide only");

    const rawFeed = await fetchFeed(this.moltbookAgent);
    const relevantPosts = await fetchRelevantPosts(this.moltbookAgent, this.memory);
    const notifications = await fetchNotifications(this.moltbookAgent, this.memory);
    const rateLimits = getRateLimits(this.memory);
    const home = await fetchHome(this.moltbookAgent);

    // Merge hot feed + semantic search results (deduplicate by id)
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

    // Try to load existing summary
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
