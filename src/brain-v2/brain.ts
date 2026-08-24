/**
 * Brain V2 — Core intelligence class.
 *
 * Three-phase decide:
 *   Phase 1: AI selects which skill to use (sees context + skill list)
 *   Phase 2a: AI makes decision (sees context + full skill content)
 *   Phase 2b: AI generates content (routed to per-post conversation)
 *   Phase 3: AI revalidates its own decision before execution
 *
 * Skills are .md files in the skills/ directory. Each teaches ONE behavior.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Gateway } from "../gateway.js";
import { SkillLoader, type Skill } from "../skill-loader.js";
import { getRelevantDocs } from "../context7.js";
import type { FeedPost, NotificationItem, RateLimitState, AgentDecision } from "../types.js";

// Re-export from types for backward compatibility
export type { FeedPost, NotificationItem, RateLimitState, AgentDecision } from "../types.js";

import type { BrainV2Config } from "./types.js";
import { buildSkillSelectionPrompt, buildDecisionPrompt, buildContentPrompt, buildRevalidationPrompt, type BrainContext } from "./prompts.js";
import { parseSkillSelection, parseDecision, parseContentResponse, parseRevalidation } from "./parsers.js";

export class BrainV2 {
  private gateway: Gateway;
  private model: string;
  private coreSkill: Skill;
  private allSkills: Map<string, Skill>;

  constructor(config: BrainV2Config) {
    this.gateway = config.gateway;
    this.model = config.model ?? "auto";
    this.allSkills = new Map();

    const loader = new SkillLoader({ skillsDir: config.skillsDir });

    if (config.skillPath) {
      // Single skill mode (backwards compatible)
      const content = readFileSync(config.skillPath, "utf-8");
      this.coreSkill = { name: "custom", path: config.skillPath, content };
      this.allSkills.set("custom", this.coreSkill);
    } else {
      // Load all skills from directory
      const skills = loader.loadAll();

      if (skills.length === 0) {
        // Fallback
        try {
          const fallback = readFileSync(resolve(process.cwd(), "SKILL.md"), "utf-8");
          this.coreSkill = { name: "fallback", path: "SKILL.md", content: fallback };
        } catch {
          this.coreSkill = { name: "empty", path: "", content: "# No skill loaded." };
        }
        this.allSkills.set(this.coreSkill.name, this.coreSkill);
      } else {
        // Core skill is nimjiagent (or first)
        this.coreSkill = skills.find((s) => s.name === "nimjiagent") ?? skills[0];
        for (const s of skills) {
          this.allSkills.set(s.name, s);
        }
      }
    }
  }

  /**
   * Three-phase decide:
   *   Phase 1: AI selects skill (sees context + skill list)
   *   Phase 2a: AI decides action + target (stateless, no content)
   *   Phase 2b: AI generates content (routed to per-post conversation)
   *   Phase 3: AI revalidates decision (see revalidateDecision())
   */
  async decide(context: BrainContext): Promise<AgentDecision> {
    // Fetch Context7 docs (shared across both phases)
    const context7Docs = await this.fetchContext7Docs(context.feed);

    // ── Phase 1: Skill selection ──
    let skillSelectionPrompt = buildSkillSelectionPrompt(context, this.coreSkill);
    if (context7Docs) skillSelectionPrompt += context7Docs;

    const phase1 = await this.gateway.generate({
      prompt: skillSelectionPrompt,
      model: this.model,
      maxTokens: 200,
    });

    const skillNames = new Set(this.allSkills.keys());
    const selectedSkill = parseSkillSelection(phase1.text, skillNames);

    // ── Phase 2a: Decide action + target (stateless) ──
    let decisionPrompt = buildDecisionPrompt(context, selectedSkill, this.coreSkill, this.allSkills);
    if (context7Docs) decisionPrompt += context7Docs;

    const phase2a = await this.gateway.generate({
      prompt: decisionPrompt,
      model: this.model,
      maxTokens: 500,
    });

    const preliminary = parseDecision(phase2a.text);

    if (!preliminary) {
      // Retry once with explicit instruction
      const retryPrompt =
        decisionPrompt +
        "\n\n**IMPORTANT**: Your previous response was not valid JSON. " +
        'You MUST respond with ONLY a JSON object like {"action": "scroll", "reason": "..."}. ' +
        "No markdown, no explanation, no other text.";

      const retry = await this.gateway.generate({
        prompt: retryPrompt,
        model: this.model,
        maxTokens: 500,
      });

      const retryParsed = parseDecision(retry.text);
      if (retryParsed) {
        // If retry needs content, continue to Phase 2b
        if (this.needsContentGeneration(retryParsed)) {
          return this.generateContent(retryParsed, context, selectedSkill, context7Docs);
        }
        return retryParsed;
      }

      return { action: "scroll", reason: "failed_to_parse_ai_output" };
    }

    // ── Phase 2b: Generate content for actions that need it ──
    if (this.needsContentGeneration(preliminary)) {
      return this.generateContent(preliminary, context, selectedSkill, context7Docs);
    }

    return preliminary;
  }

  /** Check if a decision needs Phase 2b content generation. */
  private needsContentGeneration(decision: AgentDecision): boolean {
    // Always route these through Phase 2b — AI should NOT generate content in Phase 2a
    if (decision.action === "comment" || decision.action === "reply_to_comment" || decision.action === "post") {
      return true;
    }
    return false;
  }

  /** Phase 2b: Generate content in a per-post conversation. */
  private async generateContent(
    preliminary: AgentDecision,
    context: BrainContext,
    skillName: string,
    context7Docs: string | null,
  ): Promise<AgentDecision> {
    // Route to per-post conversation
    let targetId: string | undefined;
    if (preliminary.action === "post") {
      targetId = `post-${new Date().toISOString().slice(0, 10)}`;
    } else if ("postId" in preliminary) {
      targetId = preliminary.postId;
    }

    const contentPrompt = buildContentPrompt(preliminary, context, skillName, this.coreSkill, this.allSkills);
    let fullPrompt = contentPrompt;
    if (context7Docs) fullPrompt += context7Docs;

    const phase2b = await this.gateway.generate({
      prompt: fullPrompt,
      model: this.model,
      maxTokens: 2000,
      ...(targetId ? { conversationKey: targetId } : {}),
    });

    const contentParsed = parseContentResponse(phase2b.text, preliminary);
    if (contentParsed) return contentParsed;

    // Retry content generation once
    const retryPrompt =
      fullPrompt +
      "\n\n**IMPORTANT**: Your previous response was not valid JSON. " +
      "Respond with ONLY a JSON object containing the content field.";

    const retry = await this.gateway.generate({
      prompt: retryPrompt,
      model: this.model,
      maxTokens: 2000,
      ...(targetId ? { conversationKey: targetId } : {}),
    });

    const retryParsed = parseContentResponse(retry.text, preliminary);
    if (retryParsed) return retryParsed;

    // Fallback: return preliminary with empty content
    return preliminary;
  }

  /** Phase 3: Revalidate a decision before execution. AI checks itself. */
  async revalidateDecision(
    decision: AgentDecision,
    context: {
      repliedThreadCounts: Map<string, number>;
      ownCommentCount: number;
      commentsToday: number;
      recentActions: string[];
      notificationAgentNames: string[];
    },
  ): Promise<{ valid: boolean; fallback?: string; reason: string }> {
    // Daily comment limit safety
    if ((decision.action === "comment" || decision.action === "reply_to_comment") && context.commentsToday >= 30) {
      return { valid: false, fallback: "scroll", reason: `Daily comment limit: ${context.commentsToday}/50 used` };
    }

    // AI revalidation for reply/comment decisions — THIS is the real defense
    if (decision.action === "reply_to_comment" || decision.action === "comment") {
      const prompt = buildRevalidationPrompt(decision, context);
      const response = await this.gateway.generate({
        model: this.model,
        prompt,
        temperature: 0.3,
        conversationKey: "revalidate",
      });
      const parsed = parseRevalidation(response.text);
      if (parsed && !parsed.valid) {
        return parsed;
      }
    }

    // Non-reply decisions pass through (post, upvote, follow, scroll, rest are fine)
    return { valid: true, reason: "passed" };
  }

  private async fetchContext7Docs(feed: FeedPost[]): Promise<string | null> {
    const knownLibraries = [
      "react",
      "nextjs",
      "next.js",
      "vue",
      "angular",
      "svelte",
      "langchain",
      "openai",
      "anthropic",
      "gemini",
      "pinecone",
      "chromadb",
      "prisma",
      "drizzle",
      "express",
      "fastify",
      "hono",
      "typescript",
      "python",
      "rust",
      "go",
      "node.js",
      "node",
      "docker",
      "kubernetes",
      "terraform",
      "aws",
      "gcp",
      "azure",
      "redis",
      "postgres",
      "mongodb",
      "sqlite",
      "vercel",
      "cloudflare",
    ];

    const mentions = new Set<string>();
    for (const post of feed.slice(0, 10)) {
      const text = (post.title + " " + (post.content ?? "")).toLowerCase();
      for (const lib of knownLibraries) {
        if (text.includes(lib)) mentions.add(lib);
      }
    }

    if (mentions.size === 0) return null;

    const lib = [...mentions][0];
    try {
      const doc = await getRelevantDocs(lib, lib, { tokens: 1500 });
      if (doc) {
        return `\n\n## Context7 Docs (${doc.library})\n${doc.content.slice(0, 1500)}\nUse this for accurate version numbers, API names, and code examples.`;
      }
    } catch {
      /* Context7 unavailable */
    }
    return null;
  }
}
