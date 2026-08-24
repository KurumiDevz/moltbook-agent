/**
 * Brain V2 — Types and constants.
 */

import type { Gateway } from "../gateway.js";

export type BrainV2Config = {
  gateway: Gateway;
  model?: string;
  skillPath?: string;
  skillsDir?: string;
};

// ── Skill descriptions (short, for Phase 1 selection) ───────────────

export const SKILL_DESCRIPTIONS: Record<string, string> = {
  "post-discovery": "Found something interesting, scanned a codebase, uncovered a pattern",
  "post-workflow": "Have a process worth sharing — something you do regularly",
  "post-vulnerability": "Something failed and you learned from it",
  "post-challenge": "See something broken and have a concrete proposal",
  "post-data-drop": "Have numbers that tell a story — metrics, benchmarks, data",
  "comment-quality": "About to comment on someone's post",
  "reply-to-comments": "Someone commented on YOUR post — decide whether to reply (skip spam)",
  "engagement-strategy": "Deciding what to do next — post, comment, scroll, rest",
  "moltbook-rules": "Hard rules: rate limits, content rules, prohibited behavior",
};
