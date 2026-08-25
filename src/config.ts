/**
 * Agent configuration — types, defaults, loaders.
 *
 * config.json is minimal (only agentName recommended).
 * Everything else has sensible defaults in AGENT_DEFAULTS.
 * blocked.json is separate — operational data that changes without code.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export type AgentConfig = {
  /** Agent username on Moltbook — recommended for accuracy */
  agentName: string;
  /** Submolts to monitor */
  submolts: string[];
  /** How often to regenerate summary (every N cycles) */
  summaryInterval: number;
  /** Sub-agent model for feed scoring */
  subAgentModel: string;
  /** Data directory for summary persistence */
  dataDir: string;
  /** Skills directory */
  skillsDir: string;
  /** Max top-level comments per post */
  maxCommentsPerPost: number;
  /** Post cooldown in ms (default 30 min) */
  commentCooldownMs: number;
  /** Reply cooldown in ms (default 20 sec) */
  replyCooldownMs: number;
  /** Cycle sleep range [min, max] in ms */
  cycleSleepMs: [number, number];
  /** Minimum word count for comments */
  minCommentWords: number;
  /** Minimum word count for replies */
  minReplyWords: number;
  /** Stochastic reply chances per thread depth [1st, 2nd, 3rd+] */
  threadStochasticChances: number[];
  /** How many feed pages to scan during hydration */
  hydrationFeedPages: number;
  /** How many posts per page during hydration */
  hydrationFeedLimit: number;
  /** How many notifications to fetch during hydration */
  hydrationNotifLimit: number;
  /** Max stances to keep in memory */
  maxStances: number;
  /** Max foreign stances to keep in memory */
  maxForeignStances: number;
  /** How long before rotating stale conversations (ms) */
  staleConvoRotationMs: number;
  /** How long before rotating daily post conversations (ms) */
  postConvoRotationMs: number;
  /** How long before cleaning up old post conversation files (ms) */
  postConvoCleanupMs: number;
  /** Topic dedup window — how long before same topic can be repeated (ms) */
  topicDedupWindowMs: number;
  /** Use deep browser session refresh via bard-utils (default: false) */
  deepRefresh: boolean;
  /** Force refresh bypassing bard-utils cache/skip (default: false) */
  forceRefresh: boolean;
};

export type BlockedPosts = {
  blockedPostIds: string[];
};

// ── Defaults ───────────────────────────────────────────────────────

const AGENT_DEFAULTS: AgentConfig = {
  agentName: "",
  submolts: ["general", "agents", "builds"],
  summaryInterval: 5,
  subAgentModel: "flash-lite",
  dataDir: "./data",
  skillsDir: "./skills",
  maxCommentsPerPost: 2,
  commentCooldownMs: 30 * 60 * 1000,
  replyCooldownMs: 20 * 1000,
  cycleSleepMs: [30_000, 120_000],
  minCommentWords: 40,
  minReplyWords: 40,
  threadStochasticChances: [1.0, 0.3, 0],
  hydrationFeedPages: 5,
  hydrationFeedLimit: 50,
  hydrationNotifLimit: 100,
  maxStances: 20,
  maxForeignStances: 30,
  staleConvoRotationMs: 12 * 60 * 60 * 1000,
  postConvoRotationMs: 24 * 60 * 60 * 1000,
  postConvoCleanupMs: 48 * 60 * 60 * 1000,
  topicDedupWindowMs: 24 * 60 * 60 * 1000,
  deepRefresh: false,
  forceRefresh: false,
};

const BLOCKED_DEFAULTS: BlockedPosts = {
  blockedPostIds: [],
};

// ── Loaders ────────────────────────────────────────────────────────

/**
 * Load agent config from config.json, merged with defaults.
 * Only agentName is recommended — everything else has sensible defaults.
 */
export function loadConfig(configPath?: string): AgentConfig {
  const path = configPath ?? resolve(process.cwd(), "config.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...AGENT_DEFAULTS, ...parsed };
  } catch {
    // No config.json — use defaults (agentName will be empty)
    return { ...AGENT_DEFAULTS };
  }
}

/**
 * Load blocked post IDs from blocked.json.
 */
export function loadBlocked(blockedPath?: string): BlockedPosts {
  const path = blockedPath ?? resolve(process.cwd(), "blocked.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...BLOCKED_DEFAULTS, ...parsed };
  } catch {
    return { ...BLOCKED_DEFAULTS };
  }
}

// ── Singletons (lazy, loaded once) ─────────────────────────────────

let _config: AgentConfig | null = null;
let _blocked: BlockedPosts | null = null;

/** Get agent config — loads once, then cached. */
export function getConfig(): AgentConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

/** Get blocked posts — loads once, then cached. */
export function getBlocked(): BlockedPosts {
  if (!_blocked) _blocked = loadBlocked();
  return _blocked;
}
