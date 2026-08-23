/**
 * Brain V2 — Prompt-driven agent intelligence with skill selection.
 *
 * Two-phase decide:
 *   Phase 1: AI selects which skill to use (sees context + skill list)
 *   Phase 2: AI makes decision (sees context + full skill content)
 *
 * Skills are .md files in the skills/ directory. Each teaches ONE behavior.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Gateway } from "./gateway.js";
import { SkillLoader, type Skill } from "./skill-loader.js";
import { getRelevantDocs } from "./context7.js";

// ── Types ────────────────────────────────────────────────────────────

export type AgentDecision =
  | { action: "post"; topic: string; submolt: string; postType: string; title?: string; body?: string; reason: string }
  | { action: "comment"; postId: string; content: string; reason: string }
  | { action: "upvote"; postId: string; reason: string }
  | { action: "downvote"; postId: string; reason: string }
  | { action: "follow"; agentName: string; reason: string }
  | { action: "scroll"; reason: string }
  | { action: "rest"; reason: string }
  | { action: "suggest_skill"; skillName: string; skillContent: string; reason: string };

export type FeedPost = {
  id: string;
  title: string;
  content?: string;
  submolt: string;
  author: string;
  upvotes: number;
  comment_count: number;
  createdAt: string;
};

export type NotificationItem = {
  type: string;
  message: string;
  agentName?: string;
  postId?: string;
  createdAt: string;
};

export type RateLimitState = {
  canPost: boolean;
  canComment: boolean;
  timeUntilPost: number;
  timeUntilComment: number;
  commentsToday: number;
};

export type BrainV2Config = {
  gateway: Gateway;
  model?: string;
  skillPath?: string;
  skillsDir?: string;
};

// ── Skill descriptions (short, for Phase 1 selection) ───────────────

const SKILL_DESCRIPTIONS: Record<string, string> = {
  "post-discovery": "Found something interesting, scanned a codebase, uncovered a pattern",
  "post-workflow": "Have a process worth sharing — something you do regularly",
  "post-vulnerability": "Something failed and you learned from it",
  "post-challenge": "See something broken and have a concrete proposal",
  "post-data-drop": "Have numbers that tell a story — metrics, benchmarks, data",
  "comment-quality": "About to comment on someone's post",
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
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number }>;
    recentInteractions: string[];
    summary?: string;
  }): string {
    const sections: string[] = [];

    sections.push("## Current State");
    sections.push(`- Time: ${new Date().toISOString()}`);
    sections.push(`- Posts today: ${context.postHistory.length}`);
    sections.push(`- Comments today: ${context.rateLimits.commentsToday}/50`);
    sections.push(`- Can post: ${context.rateLimits.canPost}${context.rateLimits.canPost ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilPost / 60_000)}min)`}`);
    sections.push(`- Can comment: ${context.rateLimits.canComment}${context.rateLimits.canComment ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilComment / 1000)}s)`}`);
    sections.push("");

    if (context.postHistory.length > 0) {
      const recentTypes = context.postHistory.slice(-5).map((p) => p.type);
      const recentSubmolts = context.postHistory.slice(-5).map((p) => p.submolt);
      sections.push("## Your Recent Posts (avoid repeating)");
      sections.push(`- Types: ${recentTypes.join(", ")}`);
      sections.push(`- Submolts: ${recentSubmolts.join(", ")}`);
      sections.push("");
    }

    if (context.summary) {
      sections.push(context.summary);
      sections.push("");
    }

    if (context.feed.length > 0) {
      sections.push("## Feed (top posts right now)");
      for (const post of context.feed.slice(0, 10)) {
        sections.push(`- [${post.id}] "${post.title}" by ${post.author} in /m/${post.submolt} (${post.upvotes}↑ ${post.comment_count}💬)`);
      }
      sections.push("");
    }

    if (context.notifications.length > 0) {
      sections.push("## Notifications");
      for (const n of context.notifications.slice(0, 10)) {
        sections.push(`- ${n.type}: ${n.message}${n.agentName ? ` (from ${n.agentName})` : ""}${n.postId ? ` [${n.postId}]` : ""}`);
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
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number }>;
    recentInteractions: string[];
    summary?: string;
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
    sections.push('```json');
    sections.push('{ "phase": "select_skill", "skill": "skill-name", "reason": "why" }');
    sections.push('```');
    sections.push("");

    return sections.join("\n");
  }

  /** Phase 2: Build prompt for decision with selected skill. */
  buildDecisionPrompt(
    context: {
      feed: FeedPost[];
      notifications: NotificationItem[];
      rateLimits: RateLimitState;
      postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number }>;
      recentInteractions: string[];
      summary?: string;
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
   * Two-phase decide:
   *   Phase 1: AI selects skill (sees context + skill list)
   *   Phase 2: AI makes decision (sees context + skill content)
   */
  async decide(context: {
    feed: FeedPost[];
    notifications: NotificationItem[];
    rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number }>;
    recentInteractions: string[];
    summary?: string;
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

    const phase2 = await this.gateway.generate({
      prompt: decisionPrompt,
      model: this.model,
      maxTokens: 2000,
    });

    const parsed = this.parseDecision(phase2.text);
    if (parsed) return parsed;

    // Retry with explicit instruction
    const retryPrompt = decisionPrompt +
      "\n\n**IMPORTANT**: Your previous response was not valid JSON. " +
      "You MUST respond with ONLY a JSON object like {\"action\": \"scroll\", \"reason\": \"...\"}. " +
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
    } catch { /* fall through */ }

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
      "react", "nextjs", "next.js", "vue", "angular", "svelte",
      "langchain", "openai", "anthropic", "gemini",
      "pinecone", "chromadb", "prisma", "drizzle",
      "express", "fastify", "hono",
      "typescript", "python", "rust", "go", "node.js", "node",
      "docker", "kubernetes", "terraform", "aws", "gcp", "azure",
      "redis", "postgres", "mongodb", "sqlite",
      "vercel", "cloudflare",
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
    } catch { /* Context7 unavailable */ }
    return null;
  }
}
