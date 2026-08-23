/**
 * Brain V2 — Prompt-driven agent intelligence.
 *
 * Loads skills from skills/ directory, builds context prompts from
 * memory/feed state + compact activity summary, sends to AI, parses
 * structured JSON decisions.
 *
 * Replaces the old brain/ + personality.ts + decision.ts + observer.ts
 * with a single prompt-driven approach.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Gateway } from "./gateway.js";
import { SkillLoader, type Skill } from "./skill-loader.js";
import type { ActivitySummary } from "./summary.js";

// ── Types ────────────────────────────────────────────────────────────

export type AgentDecision =
  | { action: "post"; topic: string; submolt: string; postType: string; title?: string; body?: string; reason: string }
  | { action: "comment"; postId: string; content: string; reason: string }
  | { action: "upvote"; postId: string; reason: string }
  | { action: "downvote"; postId: string; reason: string }
  | { action: "follow"; agentName: string; reason: string }
  | { action: "scroll"; reason: string }
  | { action: "rest"; reason: string };

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
  timeUntilPost: number; // ms
  timeUntilComment: number; // ms
  commentsToday: number;
};

export type BrainV2Config = {
  gateway: Gateway;
  model?: string;
  /** Path to a specific skill file (default: load all from skills/) */
  skillPath?: string;
  /** Skills directory (default: ./skills) */
  skillsDir?: string;
};

// ── BrainV2 ──────────────────────────────────────────────────────────

export class BrainV2 {
  private gateway: Gateway;
  private model: string;
  private skillContent: string;
  private skills: Skill[];

  constructor(config: BrainV2Config) {
    this.gateway = config.gateway;
    this.model = config.model ?? "auto";

    // Load skills from skills/ directory
    const loader = new SkillLoader({ skillsDir: config.skillsDir });

    if (config.skillPath) {
      // Load specific skill file
      this.skillContent = readFileSync(config.skillPath, "utf-8");
      this.skills = [{ name: "custom", path: config.skillPath, content: this.skillContent }];
    } else {
      // Load all skills from directory
      this.skills = loader.loadAll();
      if (this.skills.length === 0) {
        // Fallback: try loading from project root
        try {
          const fallback = readFileSync(resolve(process.cwd(), "SKILL.md"), "utf-8");
          this.skillContent = fallback;
          this.skills = [{ name: "fallback", path: "SKILL.md", content: fallback }];
        } catch {
          this.skillContent = "# No skill loaded. You are a Moltbook agent. Be helpful.";
          this.skills = [];
        }
      } else {
        // Use the first skill as primary (or find "nimjiagent")
        const primary = this.skills.find((s) => s.name === "nimjiagent") ?? this.skills[0];
        this.skillContent = primary.content;
      }
    }
  }

  /**
   * Build the full prompt for the AI decision cycle.
   * Combines skill instructions with current context + activity summary.
   */
  buildContextPrompt(context: {
    feed: FeedPost[];
    notifications: NotificationItem[];
    rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number }>;
    recentInteractions: string[];
    summary?: string; // compact activity summary from sub-agent
  }): string {
    const sections: string[] = [];

    // 1. Skill instructions (the brain)
    sections.push(this.skillContent);
    sections.push("");

    // 2. Current state
    sections.push("## Current State");
    sections.push(`- Time: ${new Date().toISOString()}`);
    sections.push(`- Posts today: ${context.postHistory.length}`);
    sections.push(`- Comments today: ${context.rateLimits.commentsToday}/50`);
    sections.push(`- Can post: ${context.rateLimits.canPost}${context.rateLimits.canPost ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilPost / 60_000)}min)`}`);
    sections.push(`- Can comment: ${context.rateLimits.canComment}${context.rateLimits.canComment ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilComment / 1000)}s)`}`);
    sections.push("");

    // 3. Recent post types (avoid repetition)
    if (context.postHistory.length > 0) {
      const recentTypes = context.postHistory.slice(-5).map((p) => p.type);
      const recentSubmolts = context.postHistory.slice(-5).map((p) => p.submolt);
      sections.push("## Your Recent Posts (avoid repeating)");
      sections.push(`- Types: ${recentTypes.join(", ")}`);
      sections.push(`- Submolts: ${recentSubmolts.join(", ")}`);
      sections.push("");
    }

    // 4. Activity summary (compact index from sub-agent)
    if (context.summary) {
      sections.push(context.summary);
      sections.push("");
    }

    // 5. Feed (top posts to engage with)
    if (context.feed.length > 0) {
      sections.push("## Feed (top posts right now)");
      for (const post of context.feed.slice(0, 10)) {
        sections.push(`- [${post.id}] "${post.title}" by ${post.author} in /m/${post.submolt} (${post.upvotes}↑ ${post.comment_count}💬)`);
      }
      sections.push("");
    }

    // 5. Notifications
    if (context.notifications.length > 0) {
      sections.push("## Notifications");
      for (const n of context.notifications.slice(0, 10)) {
        sections.push(`- ${n.type}: ${n.message}${n.agentName ? ` (from ${n.agentName})` : ""}${n.postId ? ` [${n.postId}]` : ""}`);
      }
      sections.push("");
    }

    // 6. Decision prompt
    sections.push("## Your Decision");
    sections.push("Based on the above, choose ONE action. Respond with ONLY a JSON object.");
    sections.push("If you want to create a post, include title and body in the JSON.");
    sections.push("If you want to comment, include the content in the JSON.");
    sections.push("");

    return sections.join("\n");
  }

  /**
   * Send context to AI and parse the JSON decision.
   * Retries once if output isn't valid JSON.
   */
  async decide(context: {
    feed: FeedPost[];
    notifications: NotificationItem[];
    rateLimits: RateLimitState;
    postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number }>;
    recentInteractions: string[];
  }): Promise<AgentDecision> {
    const prompt = this.buildContextPrompt(context);

    // First attempt
    const result = await this.gateway.generate({
      prompt,
      model: this.model,
      maxTokens: 2000,
    });

    const parsed = this.parseDecision(result.text);
    if (parsed) return parsed;

    // Retry with explicit instruction
    const retryPrompt = prompt +
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

    // Fallback to scroll
    return { action: "scroll", reason: "failed_to_parse_ai_output" };
  }

  /**
   * Parse AI output into a structured decision.
   * Handles markdown code blocks, extra text, etc.
   */
  parseDecision(text: string): AgentDecision | null {
    if (!text) return null;

    // Strip markdown code blocks
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    cleaned = cleaned.trim();

    // Try to find JSON object in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const obj = JSON.parse(jsonMatch[0]);
      return this.validateDecision(obj);
    } catch {
      return null;
    }
  }

  /**
   * Validate that a parsed object is a valid AgentDecision.
   */
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

      default:
        return null;
    }
  }
}
