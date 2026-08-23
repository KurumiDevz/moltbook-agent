/**
 * Agent V2 — Prompt-driven autonomous agent.
 *
 * Simple loop: gather context → AI decides → execute → record → repeat.
 * Uses sub-agent for feed scoring + summary generation.
 * Uses compact activity summary instead of raw history.
 *
 * Replaces the old agent.ts with a much simpler architecture.
 */

import type { MoltbookAgent } from "./moltbook.js";
import type { Gateway } from "./gateway.js";
import { BrainV2 } from "./brain-v2.js";
import { runSubAgentTask } from "./sub-agent.js";
import { SummaryGenerator } from "./summary.js";
import { SkillValidator } from "./skill-validator.js";
import { shouldRotateConversation, deleteConversation, rotateOnDeploy } from "./session-manager.js";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type {
  AgentDecision,
  FeedPost,
  NotificationItem,
  RateLimitState,
  ExecutionResult,
  PostSummary,
  Stance,
  ForeignStance,
  ScoredPost,
  ActivitySummary,
  TaskQueueItem,
} from "./types.js";

// Re-export for backward compatibility
export type { ExecutionResult } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export type AgentV2Config = {
  moltbookAgent: MoltbookAgent;
  gateway: Gateway;
  model?: string;
  submolts?: string[];
  skillPath?: string;
  /** Skills directory (default: ./skills) */
  skillsDir?: string;
  /** Sub-agent model for feed analysis (default: flash-lite) */
  subAgentModel?: string;
  /** How often to regenerate summary in cycles (default: 5) */
  summaryInterval?: number;
  /** Data directory for summary persistence (default: ./data) */
  dataDir?: string;
};

// ── Memory (simplified) ─────────────────────────────────────────────

type MemoryState = {
  postHistory: PostSummary[];
  topicsSeen: Array<{ topic: string; timestamp: number }>;
  totalPosts: number;
  totalComments: number;
  totalUpvotes: number;
  commentsToday: number;
  lastCommentAt: number;
  lastPostAt: number;
  taskQueue: TaskQueueItem[];
  /** Comment IDs we've already replied to — prevents double-replies */
  repliedCommentIds: Set<string>;
  /** Per-thread reply count — keyed by parent comment ID (thread root) */
  repliedThreadCounts: Map<string, number>;
  /** Stances the agent has taken — positions it can reference in debates */
  stances: Stance[];
  /** Stances other agents have taken — positions nimjiagent can reference in debates */
  foreignStances: ForeignStance[];
};

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
      await this.sleep(30_000 + Math.random() * 90_000);
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

    // 1. Gather context
    console.log("👀 Gathering context...");
    const rawFeed = await this.fetchFeed();
    const relevantPosts = await this.fetchRelevantPosts();
    const allNotifications = await this.fetchNotifications();
    const rateLimits = this.getRateLimits();
    const home = await this.fetchHome();

    // Filter out: already-replied, self-notifications, and stochastic per-thread cap
    const notifications = allNotifications.filter((n) => {
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
    console.log(`   Home: ${home.activity.length} posts with activity | ${home.unreadCount} unread`);
    console.log(`   Feed: ${rawFeed.length} posts (${relevantPosts.length} from semantic search)`);

    // 2. Sub-agent scores feed (lightweight, fire-and-forget)
    console.log("🔍 Sub-agent scoring feed...");
    let feed: FeedPost[];
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
        this.recordForeignStance(
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
    const result = await this.execute(finalDecision);
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

    const rawFeed = await this.fetchFeed();
    const relevantPosts = await this.fetchRelevantPosts();
    const notifications = await this.fetchNotifications();
    const rateLimits = this.getRateLimits();
    const home = await this.fetchHome();

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

  // ── Execution ────────────────────────────────────────────────────────

  private async execute(decision: AgentDecision): Promise<ExecutionResult> {
    switch (decision.action) {
      case "post":
        return this.executePost(decision);
      case "comment":
        return this.executeComment(decision);
      case "reply_to_comment":
        return this.executeReplyToComment(decision);
      case "upvote":
        return this.executeUpvote(decision);
      case "downvote":
        return this.executeDownvote(decision);
      case "follow":
        return this.executeFollow(decision);
      case "scroll":
        return { success: true, action: "scroll", message: `Scrolling: ${decision.reason}` };
      case "rest":
        return { success: true, action: "rest", message: `Resting: ${decision.reason}` };
      case "suggest_skill":
        return this.executeSkillSuggestion(decision);
      default:
        return { success: false, action: "unknown", message: "Unknown action type" };
    }
  }

  private async executePost(decision: Extract<AgentDecision, { action: "post" }>): Promise<ExecutionResult> {
    // Rate limit check
    if (!this.getRateLimits().canPost) {
      return { success: false, action: "post", message: "Rate limited — cannot post yet" };
    }

    // Topic dedup check
    if (this.isTopicRecent(decision.topic)) {
      return { success: false, action: "post", message: `Topic "${decision.topic}" was recently posted` };
    }

    // Use AI-generated title/body if provided, otherwise generate
    let title = decision.title;
    let content = decision.body;

    if (!title || !content) {
      // Fallback: generate via gateway
      const result = await this.brain["gateway"].generate({
        prompt: `Write a Moltbook post about "${decision.topic}" for /m/${decision.submolt}. Type: ${decision.postType}. 150-300 words. Be specific. Output as:\nTITLE: short title\nBODY: post content`,
        model: this.brain["model"],
        maxTokens: 4000,
      });
      const parsed = this.parseTitleBody(result.text);
      title = parsed.title;
      content = parsed.body;
    }

    const posted = (
      await this.moltbookAgent.createPost({
        submolt: decision.submolt,
        title,
        content,
      })
    ).unwrap();

    // Record
    this.memory.postHistory.push({
      id: posted.id,
      title,
      content: content?.slice(0, 500),
      submolt: decision.submolt,
      type: decision.postType,
      upvotes: 0,
      comments: 0,
      timestamp: Date.now(),
    });
    this.memory.topicsSeen.push({ topic: decision.topic, timestamp: Date.now() });
    this.memory.totalPosts++;
    this.memory.lastPostAt = Date.now();

    // Record stance — what position did this post take?
    this.memory.stances.push({
      topic: decision.topic,
      position: title,
      context: (content ?? "").slice(0, 300),
      source: "post",
      sourceId: posted.id,
      timestamp: Date.now(),
    });
    // Keep only last 20 stances
    if (this.memory.stances.length > 20) {
      this.memory.stances = this.memory.stances.slice(-20);
    }

    return { success: true, action: "post", message: `Posted: ${title}`, karmaDelta: 1 };
  }

  private async executeComment(decision: Extract<AgentDecision, { action: "comment" }>): Promise<ExecutionResult> {
    if (!this.getRateLimits().canComment) {
      return { success: false, action: "comment", message: "Rate limited — cannot comment yet" };
    }

    if (!decision.content) {
      return { success: false, action: "comment", message: "No comment content provided" };
    }

    await (await this.moltbookAgent.comment(decision.postId, decision.content)).unwrap();

    this.memory.totalComments++;
    this.memory.commentsToday++;
    this.memory.lastCommentAt = Date.now();

    // Record stance — what position did this comment take?
    this.memory.stances.push({
      topic: `comment on ${decision.postId}`,
      position: decision.content.slice(0, 100),
      context: decision.content.slice(0, 300),
      source: "comment",
      sourceId: decision.postId,
      timestamp: Date.now(),
    });
    if (this.memory.stances.length > 20) {
      this.memory.stances = this.memory.stances.slice(-20);
    }

    // Mark notifications as read for the post we commented on (best effort)
    try {
      await this.moltbookAgent.markNotificationsRead(decision.postId);
    } catch {
      // network error — ignore
    }

    return { success: true, action: "comment", message: `Commented on ${decision.postId}`, karmaDelta: 1 };
  }

  private async executeReplyToComment(
    decision: Extract<AgentDecision, { action: "reply_to_comment" }>,
  ): Promise<ExecutionResult> {
    if (!this.getRateLimits().canComment) {
      return { success: false, action: "reply_to_comment", message: "Rate limited — cannot comment yet" };
    }

    if (!decision.content) {
      return { success: false, action: "reply_to_comment", message: "No reply content provided" };
    }

    // Validate commentId exists before replying — AI sometimes hallucinates IDs from mention notifications
    if (decision.commentId && this.memory.repliedCommentIds.has(decision.commentId)) {
      return { success: false, action: "reply_to_comment", message: "Already replied to this comment" };
    }

    // Pass commentId as parentId for threaded reply (only if it's a real comment, not hallucinated)
    const parentId = decision.commentId?.match(/^[0-9a-f-]{36}$/) ? decision.commentId : undefined;
    const replyResult = await this.moltbookAgent.comment(decision.postId, decision.content, parentId);
    if (!replyResult.ok) {
      // Track as replied so we never retry a deleted/gone comment
      if (decision.commentId) this.memory.repliedCommentIds.add(decision.commentId);
      return { success: false, action: "reply_to_comment", message: `Reply failed (${replyResult.error.status}): comment may have been deleted` };
    }

    this.memory.totalComments++;
    this.memory.commentsToday++;
    this.memory.lastCommentAt = Date.now();

    // Record stance — what position did this reply take?
    this.memory.stances.push({
      topic: `reply to ${decision.commentId}`,
      position: decision.content.slice(0, 100),
      context: decision.content.slice(0, 300),
      source: "reply",
      sourceId: decision.commentId,
      timestamp: Date.now(),
    });
    if (this.memory.stances.length > 20) {
      this.memory.stances = this.memory.stances.slice(-20);
    }

    // Track this comment ID so we never reply to it again
    this.memory.repliedCommentIds.add(decision.commentId);

    // Track per-thread reply count (keyed by the comment we replied to)
    const threadCount = this.memory.repliedThreadCounts.get(decision.commentId) ?? 0;
    this.memory.repliedThreadCounts.set(decision.commentId, threadCount + 1);

    // Mark notifications as read for the post we replied on (best effort)
    try {
      await this.moltbookAgent.markNotificationsRead(decision.postId);
    } catch {
      // network error — ignore
    }

    return {
      success: true,
      action: "reply_to_comment",
      message: `Replied to comment ${decision.commentId} on post ${decision.postId}`,
      karmaDelta: 1,
    };
  }

  private async executeUpvote(decision: Extract<AgentDecision, { action: "upvote" }>): Promise<ExecutionResult> {
    await (await this.moltbookAgent.vote(decision.postId, "up")).unwrap();
    this.memory.totalUpvotes++;
    return { success: true, action: "upvote", message: `Upvoted ${decision.postId}` };
  }

  private async executeDownvote(decision: Extract<AgentDecision, { action: "downvote" }>): Promise<ExecutionResult> {
    await (await this.moltbookAgent.vote(decision.postId, "down")).unwrap();
    return { success: true, action: "downvote", message: `Downvoted ${decision.postId}` };
  }

  private async executeFollow(decision: Extract<AgentDecision, { action: "follow" }>): Promise<ExecutionResult> {
    await (await this.moltbookAgent.follow(decision.agentName)).unwrap();
    return { success: true, action: "follow", message: `Followed ${decision.agentName}` };
  }

  // ── Context gathering ──────────────────────────────────────────────

  private async fetchFeed(): Promise<FeedPost[]> {
    try {
      const { posts } = (await this.moltbookAgent.getFeed({ sort: "hot", limit: 15 })).unwrap();
      return posts.map((p) => ({
        id: p.id,
        title: p.title,
        content: p.content,
        submolt: p.submolt,
        author: p.author,
        upvotes: p.votes,
        comment_count: p.commentCount,
        createdAt: p.createdAt,
      }));
    } catch {
      return [];
    }
  }

  /** Fetch home dashboard — single API call for all context */
  private async fetchHome(): Promise<{
    activity: Array<{
      post_id: string;
      post_title: string;
      new_notification_count: number;
      latest_commenters: string[];
    }>;
    followingFeed: FeedPost[];
    unreadCount: number;
    whatToDo: string[];
  }> {
    try {
      const home = (await this.moltbookAgent.getHome()).unwrap();
      return {
        activity: home.activity_on_your_posts ?? [],
        followingFeed: (home.posts_from_accounts_you_follow?.posts ?? []).map((p) => ({
          id: p.post_id,
          title: p.title,
          content: p.content_preview ?? "",
          submolt: p.submolt_name ?? "",
          author: p.author_name ?? "",
          upvotes: p.upvotes ?? 0,
          comment_count: p.comment_count ?? 0,
          createdAt: p.created_at ?? "",
        })),
        unreadCount: home.your_account?.unread_notification_count ?? 0,
        whatToDo: home.what_to_do_next ?? [],
      };
    } catch {
      return { activity: [], followingFeed: [], unreadCount: 0, whatToDo: [] };
    }
  }

  /** Fetch posts relevant to agent's recent topics via semantic search */
  private async fetchRelevantPosts(): Promise<FeedPost[]> {
    try {
      // Build search query from recent post topics, or fall back to agent interests
      let recentTopics = this.memory.topicsSeen
        .slice(-5)
        .map((t) => t.topic)
        .join(" ");
      if (!recentTopics) {
        // Seed from agent interests when topicsSeen is empty (fresh start)
        const interests = ["agent memory", "symbol indexing", "prompt engineering", "agent security", "context window"];
        recentTopics = interests[Math.floor(Math.random() * interests.length)];
      }

      const { results } = (
        await this.moltbookAgent.search(recentTopics, {
          type: "posts",
          limit: 10,
        })
      ).unwrap();

      // Deduplicate against already-fetched feed
      return (results ?? []).map((r) => ({
        id: r.id,
        title: r.title ?? "",
        content: r.content ?? "",
        submolt: "",
        author: r.author?.name ?? "",
        upvotes: 0,
        comment_count: 0,
        createdAt: "",
      }));
    } catch {
      return [];
    }
  }

  private async fetchNotifications(): Promise<NotificationItem[]> {
    try {
      const { notifications } = (await this.moltbookAgent.getNotifications({ limit: 50 })).unwrap();

      // Group comment notifications by post so we can fetch authors efficiently (1 call per post)
      const commentNotifs = notifications.filter((n) => n.type === "comment" || n.type === "comment_reply");
      const postIds = [...new Set(commentNotifs.map((n) => n.relatedPostId).filter((x): x is string => Boolean(x)))];

      // Build commentId → authorName map by calling listComments on each post
      const commentAuthorMap = new Map<string, string>();
      for (const postId of postIds) {
        try {
          const commentsResult = await this.moltbookAgent.listComments(postId, { limit: 100 });
          if (commentsResult.isOk()) {
            const walk = (comments: any[]) => {
              for (const c of comments) {
                if (c.id && c.author?.name) {
                  commentAuthorMap.set(c.id, c.author.name);
                }
                if (c.replies?.length) walk(c.replies);
              }
            };
            walk(commentsResult.value.comments);
          }
        } catch {
          // best effort
        }
      }

      // Filter notifications: only keep those where we confirmed the author is NOT us
      const blockedPostIds = new Set(["d7c66376-059f-4a03-9694-5f609c8c2e04", "3fce4b5f-7113-43bb-b6db-333b0fba0760"]); // deleted/stale posts with phantom notifications
      const results: NotificationItem[] = [];
      for (const n of notifications) {
        // Skip notifications from deleted/blocked posts
        if (n.relatedPostId && blockedPostIds.has(n.relatedPostId)) continue;

        // For comment notifications, verify author via cross-reference
        if (n.type === "comment" || n.type === "comment_reply") {
          const commentId = n.relatedCommentId;
          if (!commentId) continue;

          // Skip if we already replied to this comment
          if (this.memory.repliedCommentIds.has(commentId)) continue;

          const author = commentAuthorMap.get(commentId);
          // Skip if: author is us, author unknown (phantom/deleted), or not found
          if (!author || author === "nimjiagent-sz945r") continue;
        }

        let postTitle: string | undefined;
        let postContent: string | undefined;
        if (n.relatedPostId && (n.type === "comment" || n.type === "comment_reply" || n.type === "mention")) {
          try {
            const postResult = await this.moltbookAgent.getPost(n.relatedPostId);
            if (postResult.isOk()) {
              const { post } = postResult.value;
              postTitle = post.title;
              postContent = post.content?.slice(0, 500);
            }
          } catch {
            // best effort
          }
        }

        // For mentions: verify we're actually tagged in the post or a comment before acting
        if (n.type === "mention" && postContent) {
          const myName = "nimjiagent-sz945r";
          const mentionedInPost = postContent.includes(`@${myName}`) || postContent.includes(myName);
          if (!mentionedInPost) {
            let mentionedInComment = false;
            if (n.relatedPostId) {
              const commentsR = await this.moltbookAgent.listComments(n.relatedPostId, { limit: 20 });
              if (commentsR.ok) {
                mentionedInComment = commentsR.value.comments.some(c => c.content?.includes(`@${myName}`) || c.content?.includes(myName));
              }
            }
            if (!mentionedInComment) continue;
          }
        }

        const authorName = (n.type === "comment" || n.type === "comment_reply")
          ? commentAuthorMap.get(n.relatedCommentId ?? "")
          : undefined;

        results.push({
          type: n.type,
          message: n.content,
          agentName: authorName,
          postId: n.relatedPostId,
          commentId: n.relatedCommentId,
          commentContent: n.comment?.content,
          postTitle,
          postContent,
          createdAt: n.createdAt,
        });

        // Record foreign stances from comments on our posts
        if (authorName && authorName !== "nimjiagent-sz945r" && n.comment?.content) {
          this.recordForeignStance(
            authorName,
            "",
            postTitle ?? n.relatedPostId ?? "unknown",
            n.comment.content.slice(0, 100),
            n.comment.content,
            "comment",
            n.relatedCommentId ?? `${n.relatedPostId}-${authorName}-${Date.now()}`,
          );
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  // ── Skill suggestion ──────────────────────────────────────────────

  private executeSkillSuggestion(decision: Extract<AgentDecision, { action: "suggest_skill" }>): ExecutionResult {
    const validator = new SkillValidator(resolve(process.cwd(), "skills"));
    const result = validator.saveDraft({
      name: decision.skillName,
      content: decision.skillContent,
      reason: decision.reason,
      suggestedAt: Date.now(),
    });

    if (result.success) {
      return {
        success: true,
        action: "suggest_skill",
        message: `Skill "${decision.skillName}" saved to drafts — review at skills/drafts/${decision.skillName}.md`,
      };
    } else {
      return {
        success: false,
        action: "suggest_skill",
        message: `Skill rejected: ${result.error}`,
      };
    }
  }

  // ── Rate limiting ─────────────────────────────────────────────────

  private getRateLimits(): RateLimitState {
    const now = Date.now();
    const postCooldown = 30 * 60 * 1000; // 30 min
    const commentCooldown = 20 * 1000; // 20 sec
    const timeSincePost = now - this.memory.lastPostAt;
    const timeSinceComment = now - this.memory.lastCommentAt;

    return {
      canPost: this.memory.lastPostAt === 0 || timeSincePost >= postCooldown,
      canComment: this.memory.lastCommentAt === 0 || timeSinceComment >= commentCooldown,
      timeUntilPost: Math.max(0, postCooldown - timeSincePost),
      timeUntilComment: Math.max(0, commentCooldown - timeSinceComment),
      commentsToday: this.memory.commentsToday,
    };
  }

  private isTopicRecent(topic: string, windowMs = 24 * 60 * 60 * 1000): boolean {
    const now = Date.now();
    return this.memory.topicsSeen.some(
      (t) => t.topic.toLowerCase() === topic.toLowerCase() && now - t.timestamp < windowMs,
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private recordForeignStance(agentName: string, agentId: string, topic: string, position: string, context: string, source: "post" | "comment", sourceId: string) {
    // Don't record own stances
    if (agentName === "nimjiagent-sz945r") return;

    // Don't duplicate — check if we already have this sourceId
    if (this.memory.foreignStances.some(s => s.sourceId === sourceId)) return;

    this.memory.foreignStances.push({
      agentName,
      agentId,
      topic,
      position,
      context: context.slice(0, 300),
      source,
      sourceId,
      timestamp: Date.now(),
    });

    // Keep only last 30 foreign stances
    if (this.memory.foreignStances.length > 30) {
      this.memory.foreignStances = this.memory.foreignStances.slice(-30);
    }
  }

  private parseTitleBody(text: string): { title: string; body: string } {
    const titleMatch = text.match(/TITLE:\s*(.+)/i);
    const bodyMatch = text.match(/BODY:\s*([\s\S]+)/i);
    return {
      title: titleMatch?.[1]?.trim() ?? "Untitled",
      body: bodyMatch?.[1]?.trim() ?? text.trim(),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
