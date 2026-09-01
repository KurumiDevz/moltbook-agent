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
import { getConfig } from "../config.js";
import { SkillLoader, type Skill } from "../skills/index.js";
import { getRelevantDocs } from "../context7.js";
import type { FeedPost, NotificationItem, RateLimitState, AgentDecision } from "../types.js";
import { suggestTopics, scoreTopics } from "./topics.js";

import type { BrainV2Config } from "./types.js";
import { buildSkillSelectionPrompt, buildDecisionPrompt, buildContentPrompt, buildRevalidationPrompt, buildPostRevalidationPrompt, type BrainContext } from "./prompts.js";
import { parseSkillSelection, parseDecision, parseDecisions, parseContentResponse, parseRevalidation } from "./parsers.js";

export class BrainV2 {
  private _gateway: Gateway;
  private _model: string;
  private coreSkill: Skill;
  private allSkills: Map<string, Skill>;

  /** Public read-only access to gateway (used by executor for fallback generation). */
  get gateway(): Gateway { return this._gateway; }
  /** Public read-only access to model name. */
  get model(): string { return this._model; }

  constructor(config: BrainV2Config) {
    this._gateway = config.gateway;
    this._model = config.model ?? "auto";
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
   *   Phase 2a: AI decides actions + targets (stateless, no content) — returns 2-5 decisions
   *   Phase 2b: AI generates content for each decision (routed to per-post conversation)
   */
  async decide(context: BrainContext): Promise<AgentDecision[]> {
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

    // ── Phase 2a: Decide actions + targets (stateless) — returns array ──
    let decisionPrompt = buildDecisionPrompt(context, selectedSkill, this.coreSkill, this.allSkills);
    if (context7Docs) decisionPrompt += context7Docs;

    const phase2a = await this.gateway.generate({
      prompt: decisionPrompt,
      model: this.model,
      maxTokens: 1500, // Increased for multiple decisions
    });

    let decisions = parseDecisions(phase2a.text);

    if (decisions.length === 0) {
      // Retry once with explicit instruction
      const retryPrompt =
        decisionPrompt +
        "\n\n**IMPORTANT**: Your previous response was not valid JSON array. " +
        'You MUST respond with ONLY a JSON array like [{"action": "scroll", "reason": "..."}]. ' +
        "No markdown, no explanation, no other text.";

      const retry = await this.gateway.generate({
        prompt: retryPrompt,
        model: this.model,
        maxTokens: 1500,
      });

      decisions = parseDecisions(retry.text);
      if (decisions.length === 0) {
        return [{ action: "scroll", reason: "failed_to_parse_ai_output" }];
      }
    }

    // ── Phase 2b: Generate content for actions that need it ──
    const results: AgentDecision[] = [];
    for (const decision of decisions) {
      if (this.needsContentGeneration(decision)) {
        const withContent = await this.generateContent(decision, context, selectedSkill, context7Docs);
        results.push(withContent);
      } else {
        results.push(decision);
      }
    }

    return results;
  }

  /** Check if a decision needs Phase 2b content generation. */
  private needsContentGeneration(decision: AgentDecision): boolean {
    // Always route these through Phase 2b — AI should NOT generate content in Phase 2a
    if (decision.action === "comment" || decision.action === "reply_to_comment" || decision.action === "join_conversation" || decision.action === "post") {
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
    // ── Topic pipeline for post decisions ──
    // Suggest topics in a FRESH conversation, score against own posts, pick best
    let topicDecision = preliminary;
    if (preliminary.action === "post") {
      // Use own posts from context (fetched by cycle.ts)
      const ownTitles = context.ownPosts.map((p) => p.title ?? "").filter(Boolean);
      const ownTopics = context.ownPosts.map((p) => p.type ?? "").filter(Boolean);

      // Also include recent feed titles for general dedup
      const recentTitles = context.postHistory.slice(-10).map((p) => p.title ?? "");
      const recentTopics = context.postHistory.slice(-10).map((p) => p.type);
      
      // Merge: own posts weighted more heavily
      const allTitles = [...ownTitles, ...recentTitles];
      const allTopics = [...ownTopics, ...recentTopics];

      const candidates = await suggestTopics(this.gateway, this.model, allTitles, allTopics);
      if (candidates.length > 0) {
        const scored = scoreTopics(candidates, allTitles, allTopics, ownTitles);
        const best = scored[0];
        console.log(`   Topic pipeline: "${best.topic}" (score: ${best.uniquenessScore}/10, own posts: ${ownTitles.length})`);
        topicDecision = {
          ...preliminary,
          topic: best.topic,
          submolt: best.submolt,
          postType: best.postType,
        };
      }
    }

    // Route to per-post conversation — after topic pipeline so we use the final topic
    let targetId: string | undefined;
    if (topicDecision.action === "post") {
      // Hash the topic for a unique, fresh conversation per topic
      const topicHash = Buffer.from(topicDecision.topic).toString("base64url").slice(0, 12);
      targetId = `post-${topicHash}`;
    } else if ("postId" in topicDecision) {
      targetId = topicDecision.postId;
    }

    const contentPrompt = buildContentPrompt(topicDecision, context, skillName, this.coreSkill, this.allSkills);
    let fullPrompt = contentPrompt;
    if (context7Docs) fullPrompt += context7Docs;

    const phase2b = await this.gateway.generate({
      prompt: fullPrompt,
      model: this.model,
      maxTokens: 2000,
      ...(targetId ? { conversationKey: targetId } : {}),
    });

    const contentParsed = parseContentResponse(phase2b.text, topicDecision);
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

    const retryParsed = parseContentResponse(retry.text, topicDecision);
    if (retryParsed) return retryParsed;

    // Fallback: return topicDecision (not preliminary) to preserve topic pipeline override
    return topicDecision;
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
      recentTitles?: string[];
      recentTopics?: string[];
      postsToday?: number;
    },
  ): Promise<{ valid: boolean; fallback?: string; reason: string }> {
    // Daily comment limit safety
    const maxComments = getConfig().maxCommentsPerDay;
    if ((decision.action === "comment" || decision.action === "reply_to_comment") && context.commentsToday >= maxComments) {
      return { valid: false, fallback: "scroll", reason: `Daily comment limit: ${context.commentsToday}/${maxComments} used` };
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

    // AI revalidation for post decisions — catch topic repetition and spam
    if (decision.action === "post" && context.recentTitles && context.postsToday !== undefined) {
      const prompt = buildPostRevalidationPrompt(decision, {
        recentTitles: context.recentTitles,
        recentTopics: context.recentTopics ?? [],
        postsToday: context.postsToday,
        recentActions: context.recentActions,
      });
      const response = await this.gateway.generate({
        model: this.model,
        prompt,
        temperature: 0.3,
        conversationKey: "revalidate-post",
      });
      const parsed = parseRevalidation(response.text);
      if (parsed && !parsed.valid) {
        return parsed;
      }
    }

    // Other decisions pass through
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
