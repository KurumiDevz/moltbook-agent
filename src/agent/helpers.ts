/**
 * Agent V2 — Pure helper functions and rate limiting.
 */

import type { RateLimitState } from "../types.js";
import type { MemoryState } from "./types.js";
import { getConfig } from "../config.js";

// ── Rate limiting ──────────────────────────────────────────────────

/** Compute current rate limit state from memory timestamps. */
export function getRateLimits(memory: MemoryState): RateLimitState {
  const config = getConfig();
  const now = Date.now();
  const postCooldown = config.commentCooldownMs;
  const commentCooldown = config.replyCooldownMs;
  const timeSincePost = now - memory.lastPostAt;
  const timeSinceComment = now - memory.lastCommentAt;

  return {
    canPost: memory.lastPostAt === 0 || timeSincePost >= postCooldown,
    canComment: memory.lastCommentAt === 0 || timeSinceComment >= commentCooldown,
    timeUntilPost: Math.max(0, postCooldown - timeSincePost),
    timeUntilComment: Math.max(0, commentCooldown - timeSinceComment),
    commentsToday: memory.commentsToday,
  };
}

// ── Topic dedup ────────────────────────────────────────────────────

/** Check if a topic was recently posted about. */
export function isTopicRecent(
  memory: MemoryState,
  topic: string,
  windowMs = getConfig().topicDedupWindowMs,
): boolean {
  const now = Date.now();
  return memory.topicsSeen.some(
    (t) => t.topic.toLowerCase() === topic.toLowerCase() && now - t.timestamp < windowMs,
  );
}

// ── Foreign stance tracking ────────────────────────────────────────

/** Record a stance taken by another agent. */
export function recordForeignStance(
  memory: MemoryState,
  agentName: string,
  agentId: string,
  topic: string,
  position: string,
  context: string,
  source: "post" | "comment",
  sourceId: string,
): void {
  // Don't record own stances
  if (agentName === getConfig().agentName) return;

  // Don't duplicate — check if we already have this sourceId
  if (memory.foreignStances.some((s) => s.sourceId === sourceId)) return;

  memory.foreignStances.push({
    agentName,
    agentId,
    topic,
    position,
    context: context.slice(0, 300),
    source,
    sourceId,
    timestamp: Date.now(),
  });

  // Keep only last N foreign stances
  if (memory.foreignStances.length > getConfig().maxForeignStances) {
    memory.foreignStances = memory.foreignStances.slice(-getConfig().maxForeignStances);
  }
}

// ── Text parsing ───────────────────────────────────────────────────

/** Parse TITLE:/BODY: from AI-generated text. */
export function parseTitleBody(text: string): { title: string; body: string } {
  const titleMatch = text.match(/TITLE:\s*(.+)/i);
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)/i);
  return {
    title: titleMatch?.[1]?.trim() ?? "Untitled",
    body: bodyMatch?.[1]?.trim() ?? text.trim(),
  };
}

// ── Utility ────────────────────────────────────────────────────────

/** Promise wrapper around setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
