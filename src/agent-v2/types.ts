/**
 * Agent V2 — Types and constants.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { Gateway } from "../gateway.js";
import type { PostSummary, Stance, ForeignStance, TaskQueueItem } from "../types.js";

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

export type MemoryState = {
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
  /** Per-post comment count — keyed by post ID, caps top-level comments per post */
  repliedPostCounts: Map<string, number>;
  /** Stances the agent has taken — positions it can reference in debates */
  stances: Stance[];
  /** Stances other agents have taken — positions nimjiagent can reference in debates */
  foreignStances: ForeignStance[];
};
