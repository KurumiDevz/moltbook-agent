/**
 * Brain V2 — Prompt-driven agent intelligence with skill selection.
 *
 * Three-phase decide:
 *   Phase 1: AI selects which skill to use (sees context + skill list)
 *   Phase 2: AI makes decision (sees context + full skill content)
 *   Phase 3: AI revalidates its own decision before execution
 *
 * Skills are .md files in the skills/ directory. Each teaches ONE behavior.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Gateway } from "./gateway.js";
import { SkillLoader, type Skill } from "./skill-loader.js";
import { getRelevantDocs } from "./context7.js";
import type { FeedPost, NotificationItem, RateLimitState, AgentDecision } from "./types.js";

// Re-export from types for backward compatibility
export type { FeedPost, NotificationItem, RateLimitState, AgentDecision } from "./types.js";

export type BrainV2Config = {
  gateway: Gateway;
  model?: string;
  skillPath?: string;
  skillsDir?: string;
};

// ── Skill descriptions (short, for Phase 1 selection) ───────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SKILL_DESCRIPTIONS: Record<string, string> = {
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

// ── BrainV2 ──────────────────────────────────────────────────────────

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

  /** Build the context section (shared between both phases). */
  private buildBaseContext(context: {
    feed: FeedPost[];
    notifications: NotificationItem[];
    rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number; title?: string }>;
    recentInteractions: string[];
    summary?: string;
    stances?: Array<{ topic: string; position: string; context: string; source: string; timestamp: number }>;
    foreignStances?: Array<{ agentName: string; topic: string; position: string; context: string; source: string; timestamp: number }>;
  }): string {
    const sections: string[] = [];

    sections.push("## Current State");
    sections.push(`- Time: ${new Date().toISOString()}`);
    sections.push(`- Posts today: ${context.postHistory.length}`);
    sections.push(`- Comments today: ${context.rateLimits.commentsToday}/50`);
    sections.push(
      `- Can post: ${context.rateLimits.canPost}${context.rateLimits.canPost ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilPost / 60_000)}min)`}`,
    );
    sections.push(
      `- Can comment: ${context.rateLimits.canComment}${context.rateLimits.canComment ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilComment / 1000)}s)`}`,
    );
    sections.push("");

    if (context.postHistory.length > 0) {
      const recentTypes = context.postHistory.slice(-5).map((p) => p.type);
      const recentSubmolts = context.postHistory.slice(-5).map((p) => p.submolt);
      const recentTitles = context.postHistory.slice(-5).map((p) => `- "${p.title}" (${p.type} in /m/${p.submolt})`);
      sections.push("## Your Recent Posts (DO NOT repeat similar titles/formats)");
      sections.push(`- Types used: ${recentTypes.join(", ")}`);
      sections.push(`- Submolts used: ${recentSubmolts.join(", ")}`);
      sections.push(`- Recent titles:`);
      for (const t of recentTitles) sections.push(`  ${t}`);
      sections.push("- Moltbook will flag posts with similar title patterns as spam. VARY your format completely.");
      sections.push("");
    }

    if (context.summary) {
      sections.push(context.summary);
      sections.push("");
    }

    // Show recent stances — positions the agent has taken that it can reference in debates
    if (context.stances && context.stances.length > 0) {
      sections.push("## Your Past Positions (stances you've taken)");
      for (const s of context.stances.slice(-8)) {
        sections.push(`- [${s.source}] "${s.position}" — ${s.context.slice(0, 120)}`);
      }
      sections.push("");
    }

    // Show other agents' past positions — leverage in debates
    if (context.foreignStances && context.foreignStances.length > 0) {
      // Group by agent
      const byAgent = new Map<string, typeof context.foreignStances>();
      for (const fs of context.foreignStances.slice(-15)) {
        const existing = byAgent.get(fs.agentName) ?? [];
        existing.push(fs);
        byAgent.set(fs.agentName, existing);
      }
      sections.push("## Other Agents' Past Positions (use for debates)");
      for (const [agent, stances] of byAgent) {
        for (const s of stances.slice(-3)) {
          sections.push(`- ${agent}: "${s.position}" — ${s.context.slice(0, 100)}`);
        }
      }
      sections.push("");
    }

    if (context.feed.length > 0) {
      sections.push("## Feed (top posts right now)");
      for (const post of context.feed.slice(0, 10)) {
        sections.push(
          `- [${post.id}] "${post.title}" by ${post.author} in /m/${post.submolt} (${post.upvotes}↑ ${post.comment_count}💬)`,
        );
      }
      sections.push("");
    }

    if (context.notifications.length > 0) {
      sections.push("## Notifications");
      for (const n of context.notifications.slice(0, 10)) {
        let line = `- ${n.type}: ${n.message}`;
        if (n.agentName) line += ` (from ${n.agentName})`;
        if (n.postId) line += ` [post: ${n.postId}]`;
        if (n.commentId) line += ` [comment: ${n.commentId}]`;
        if (n.commentContent) line += ` — "${n.commentContent.slice(0, 150)}"`;
        sections.push(line);
        // Show original post content so AI can defend/reference its own posts
        if (n.postTitle || n.postContent) {
          sections.push(`  ↳ Your post: "${n.postTitle ?? "untitled"}" — ${(n.postContent ?? "").slice(0, 300)}`);
        }
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /** Phase 1: Build prompt for skill selection. */
  buildSkillSelectionPrompt(context: {
    feed: FeedPost[];
    notifications: NotificationItem[];
    rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number; title?: string }>;
    recentInteractions: string[];
    summary?: string;
    stances?: Array<{ topic: string; position: string; context: string; source: string; timestamp: number }>;
    foreignStances?: Array<{ agentName: string; topic: string; position: string; context: string; source: string; timestamp: number }>;
  }): string {
    const sections: string[] = [];

    // Core identity
    sections.push(this.coreSkill.content);
    sections.push("");

    // Context
    sections.push(this.buildBaseContext(context));

    // Skill selection prompt
    sections.push("## Skill Selection");
    sections.push("Choose the ONE skill that best matches your current situation.");
    sections.push("Respond with ONLY a JSON object:");
    sections.push("");
    sections.push("```json");
    sections.push('{ "phase": "select_skill", "skill": "skill-name", "reason": "why" }');
    sections.push("```");
    sections.push("");

    return sections.join("\n");
  }

  /** Phase 2: Build prompt for decision with selected skill. */
  buildDecisionPrompt(
    context: {
      feed: FeedPost[];
      notifications: NotificationItem[];
      rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number; title?: string }>;
      recentInteractions: string[];
      summary?: string;
      stances?: Array<{ topic: string; position: string; context: string; source: string; timestamp: number }>;
      foreignStances?: Array<{ agentName: string; topic: string; position: string; context: string; source: string; timestamp: number }>;
    },
    skillName: string,
  ): string {
    const sections: string[] = [];

    // Core identity
    sections.push(this.coreSkill.content);
    sections.push("");

    // Selected skill content
    const skill = this.allSkills.get(skillName);
    if (skill) {
      sections.push(skill.content);
      sections.push("");
    }

    // Context
    sections.push(this.buildBaseContext(context));

    // Decision prompt
    sections.push("## Your Decision");
    sections.push("Based on the above and the loaded skill, choose ONE action.");
    sections.push("Respond with ONLY a JSON object. No markdown, no explanation.");
    sections.push("");

    return sections.join("\n");
  }

  /**
   * Three-phase decide:
   *   Phase 1: AI selects skill (sees context + skill list)
   *   Phase 2: AI makes decision (sees context + skill content)
   *   Phase 3: AI revalidates decision (see revalidateDecision())
   */
  async decide(context: {
    feed: FeedPost[];
    notifications: NotificationItem[];
    rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number; title?: string }>;
    recentInteractions: string[];
    summary?: string;
    stances?: Array<{ topic: string; position: string; context: string; source: string; timestamp: number }>;
    foreignStances?: Array<{ agentName: string; topic: string; position: string; context: string; source: string; timestamp: number }>;
  }): Promise<AgentDecision> {
    // Fetch Context7 docs (shared across both phases)
    const context7Docs = await this.fetchContext7Docs(context.feed);

    // ── Phase 1: Skill selection ──
    let skillSelectionPrompt = this.buildSkillSelectionPrompt(context);
    if (context7Docs) skillSelectionPrompt += context7Docs;

    const phase1 = await this.gateway.generate({
      prompt: skillSelectionPrompt,
      model: this.model,
      maxTokens: 200,
    });

    const selectedSkill = this.parseSkillSelection(phase1.text);

    // ── Phase 2: Decision with selected skill ──
    let decisionPrompt = this.buildDecisionPrompt(context, selectedSkill);
    if (context7Docs) decisionPrompt += context7Docs;

    // Use a fresh conversation for post decisions to avoid repeating title patterns
    const isPost = selectedSkill?.startsWith("post-") ?? false;

    const phase2 = await this.gateway.generate({
      prompt: decisionPrompt,
      model: this.model,
      maxTokens: 2000,
      ...(isPost ? { conversationKey: "post" } : {}),
    });

    const parsed = this.parseDecision(phase2.text);
    if (parsed) return parsed;

    // Retry with explicit instruction
    const retryPrompt =
      decisionPrompt +
      "\n\n**IMPORTANT**: Your previous response was not valid JSON. " +
      'You MUST respond with ONLY a JSON object like {"action": "scroll", "reason": "..."}. ' +
      "No markdown, no explanation, no other text.";

    const retry = await this.gateway.generate({
      prompt: retryPrompt,
      model: this.model,
      maxTokens: 2000,
    });

    const retryParsed = this.parseDecision(retry.text);
    if (retryParsed) return retryParsed;

    return { action: "scroll", reason: "failed_to_parse_ai_output" };
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
      const prompt = this.buildRevalidationPrompt(decision, context);
      const response = await this.gateway.generate({
        model: this.model,
        prompt,
        temperature: 0.3,
      });
      const parsed = this.parseRevalidation(response.text);
      if (parsed && !parsed.valid) {
        return parsed;
      }
    }

    // Non-reply decisions pass through (post, upvote, follow, scroll, rest are fine)
    return { valid: true, reason: "passed" };
  }

  private buildRevalidationPrompt(
    decision: AgentDecision,
    context: {
      repliedThreadCounts: Map<string, number>;
      ownCommentCount: number;
      commentsToday: number;
      recentActions: string[];
      notificationAgentNames: string[];
    },
  ): string {
    const sections: string[] = [];

    sections.push("# Decision Revalidation Checkpoint");
    sections.push("");
    sections.push("You previously decided to take this action. Now review whether it's still a good idea.");
    sections.push("");
    sections.push("## Your Decision");
    sections.push(`- Action: ${decision.action}`);
    sections.push(`- Reason: ${decision.reason}`);
    if ("content" in decision && decision.content) {
      sections.push(`- Content preview: "${(decision.content as string).slice(0, 200)}"`);
    }
    if ("postId" in decision) {
      sections.push(`- Target post: ${decision.postId}`);
    }
    if ("commentId" in decision) {
      sections.push(`- Target comment: ${decision.commentId}`);
    }
    sections.push("");
    sections.push("## Context");
    sections.push(`- Your comments on this post: ${context.ownCommentCount} (verified via API)`);
    sections.push(`- Comments today: ${context.commentsToday}/50`);
    sections.push(`- Recent actions: ${context.recentActions.slice(-5).join(", ") || "none yet"}`);
    if (context.notificationAgentNames.length > 0) {
      sections.push(`- Agents in notifications: ${context.notificationAgentNames.join(", ")}`);
    }
    sections.push("");
    sections.push("## Rules");
    sections.push("- You may reply to the SAME post at most 2 times total (not counting this one)");
    sections.push("- If you already have 2+ comments on this post, reject unless it's a direct question to you");
    sections.push("- If the last 3 actions were all replies/comments, prefer scroll or upvote instead");
    sections.push("- Generic one-liner replies are noise — reject them");
    sections.push("- If the comment is spam (crypto, DEUSPROOF, generic praise), reject");
    sections.push("");
    sections.push("Respond with ONLY a JSON object:");
    sections.push("```json");
    sections.push('{ "valid": true, "reason": "brief explanation" }');
    sections.push("```");
    sections.push("OR");
    sections.push("```json");
    sections.push('{ "valid": false, "fallback": "scroll", "reason": "brief explanation" }');
    sections.push("```");

    return sections.join("\n");
  }

  private parseRevalidation(response: string): { valid: boolean; fallback?: string; reason: string } | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.valid !== "boolean") return null;
      return {
        valid: parsed.valid,
        fallback: parsed.fallback ?? "scroll",
        reason: parsed.reason ?? "revalidation checkpoint",
      };
    } catch {
      return null; // On parse failure, let the decision through (fail-open)
    }
  }

  /** Parse skill selection from Phase 1 output. Falls back to "engagement-strategy". */
  parseSkillSelection(text: string): string {
    if (!text) return "engagement-strategy";

    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    cleaned = cleaned.trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return "engagement-strategy";

    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.skill === "string" && this.allSkills.has(obj.skill)) {
        return obj.skill;
      }
    } catch {
      /* fall through */
    }

    return "engagement-strategy";
  }

  /** Parse AI output into a structured decision. */
  parseDecision(text: string): AgentDecision | null {
    if (!text) return null;

    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    cleaned = cleaned.trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const obj = JSON.parse(jsonMatch[0]);
      return this.validateDecision(obj);
    } catch {
      return null;
    }
  }

  private validateDecision(obj: unknown): AgentDecision | null {
    if (!obj || typeof obj !== "object" || !("action" in obj)) return null;

    const d = obj as Record<string, unknown>;

    switch (d.action) {
      case "post":
        if (typeof d.topic !== "string" || typeof d.submolt !== "string") return null;
        return {
          action: "post",
          topic: d.topic,
          submolt: d.submolt,
          postType: typeof d.postType === "string" ? d.postType : "discovery",
          title: typeof d.title === "string" ? d.title : undefined,
          body: typeof d.body === "string" ? d.body : undefined,
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "comment":
        if (typeof d.postId !== "string") return null;
        return {
          action: "comment",
          postId: d.postId,
          content: typeof d.content === "string" ? d.content : "",
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "reply_to_comment":
        if (typeof d.commentId !== "string" || typeof d.postId !== "string") return null;
        return {
          action: "reply_to_comment",
          commentId: d.commentId,
          postId: d.postId,
          content: typeof d.content === "string" ? d.content : "",
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "upvote":
        if (typeof d.postId !== "string") return null;
        return {
          action: "upvote",
          postId: d.postId,
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "downvote":
        if (typeof d.postId !== "string") return null;
        return {
          action: "downvote",
          postId: d.postId,
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "follow":
        if (typeof d.agentName !== "string") return null;
        return {
          action: "follow",
          agentName: d.agentName,
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "scroll":
        return {
          action: "scroll",
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "rest":
        return {
          action: "rest",
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      case "suggest_skill":
        if (typeof d.skillName !== "string" || typeof d.skillContent !== "string") return null;
        return {
          action: "suggest_skill",
          skillName: d.skillName,
          skillContent: d.skillContent,
          reason: typeof d.reason === "string" ? d.reason : "ai_decided",
        };

      default:
        return null;
    }
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
