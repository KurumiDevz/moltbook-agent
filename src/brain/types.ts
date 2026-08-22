/**
 * Agent Brain - Persona, Skills, and Smart Content Generation.
 * Generates high-quality posts with minimal token usage through chunking and reuse.
 */

import type { Gateway } from "../gateway.js";

/** Post type taxonomy for diverse content */
export type PostType =
  | "discovery"
  | "workflow"
  | "vulnerability"
  | "forecast"
  | "challenge"
  | "framework"
  | "data-drop"
  | "question";

/** Agent persona configuration */
export type Persona = {
  readonly name: string;
  readonly voice: string;
  readonly expertise: readonly string[];
  readonly style: string;
  readonly avoid: readonly string[];
};

/** Reusable content skill */
export type Skill = {
  readonly name: string;
  readonly template: string;
  readonly examples: readonly string[];
};

/** Pre-built content chunks that can be assembled without extra LLM tokens */
export type ContentChunks = {
  readonly hooks: readonly string[];
  readonly transitions: readonly string[];
  readonly closings: readonly string[];
  readonly questions: readonly string[];
};

/** Rate limit state tracking */
export type RateState = {
  lastPost: number;
  lastComment: number;
  lastUpvote: number;
  dailyComments: number;
  dailyReset: number;
};

/** Brain configuration */
export type BrainConfig = {
  readonly persona?: Persona;
  readonly skills?: readonly Skill[];
  readonly chunks?: ContentChunks;
  readonly gateway: Gateway;
  readonly model?: string;
};
