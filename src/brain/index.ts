/**
 * Agent Brain - Persona, Skills, and Smart Content Generation.
 * Generates high-quality posts with minimal token usage through chunking and reuse.
 *
 * Moltbook Rate Limits:
 * - 1 post per 30 minutes (server-enforced)
 * - 1 comment per 20 seconds
 * - 50 comments per day
 * - 100 requests per minute global
 *
 * Best Practices for Karma:
 * - Comment before posting (first 10 interactions should be comments)
 * - Ask questions - generates 3x more replies
 * - Diversify submolts
 * - Quality over quantity
 * - Spread engagement across heartbeats
 */

import type { Gateway } from "../gateway.js";

// --- Data imports ---
import hooksData from "./data/hooks.json" with { type: "json" };
import transitionsData from "./data/transitions.json" with { type: "json" };
import closingsData from "./data/closings.json" with { type: "json" };
import questionsData from "./data/questions.json" with { type: "json" };
import skillsData from "./data/skills.json" with { type: "json" };
import topicsData from "./data/topics.json" with { type: "json" };
import personaData from "./data/persona.json" with { type: "json" };

// --- Type exports ---
export type { PostType, Persona, Skill, ContentChunks, RateState, BrainConfig } from "./types.js";

// --- Import prompt builder ---
import { buildTypePrompt } from "./prompts.js";
export { buildTypePrompt } from "./prompts.js";

// --- Context7 for real library docs ---
import { getRelevantDocs } from "../context7.js";

// --- Import types ---
import type { PostType, Persona, Skill, ContentChunks, RateState, BrainConfig } from "./types.js";

/** Default persona - curious, direct, technical */
const DEFAULT_PERSONA: Persona = personaData as Persona;

/** Default content chunks - reusable fragments that cost zero LLM tokens */
const DEFAULT_CHUNKS: ContentChunks = {
  hooks: hooksData,
  transitions: transitionsData,
  closings: closingsData,
  questions: questionsData,
};

/** Skill templates for common post types */
export const BUILT_IN_SKILLS: readonly Skill[] = skillsData as Skill[];

/** Topic suggestions for content generation */
const SUGGESTIONS: Array<{ topic: string; type: PostType }> = topicsData as Array<{ topic: string; type: PostType }>;

/**
 * Agent Brain - generates content using persona + skills + chunks.
 * Minimizes LLM token usage by reusing pre-built fragments.
 * Respects Moltbook rate limits and optimizes for karma.
 */
export class Brain {
  private persona: Persona;
  private chunks: ContentChunks;
  private skills: Skill[];
  private gateway: Gateway;
  private model: string;
  private postHistory: string[] = [];
  private topicHistory: string[] = [];
  private postTypeHistory: PostType[] = [];
  private rateState: RateState;

  // Rate limits (Moltbook)
  static readonly POST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
  static readonly COMMENT_COOLDOWN_MS = 20 * 1000; // 20 seconds
  static readonly DAILY_COMMENT_LIMIT = 50;

  constructor(config: BrainConfig) {
    this.persona = config.persona ?? DEFAULT_PERSONA;
    this.chunks = config.chunks ?? DEFAULT_CHUNKS;
    this.skills = [...BUILT_IN_SKILLS, ...(config.skills ?? [])];
    this.gateway = config.gateway;
    this.model = config.model ?? "flash";
    this.rateState = {
      lastPost: 0,
      lastComment: 0,
      lastUpvote: 0,
      dailyComments: 0,
      dailyReset: Date.now(),
    };
  }

  /**
   * Check if we can perform an action based on rate limits.
   */
  canPost(): boolean {
    return Date.now() - this.rateState.lastPost >= Brain.POST_COOLDOWN_MS;
  }

  canComment(): boolean {
    this.resetDailyIfNeeded();
    return (
      Date.now() - this.rateState.lastComment >= Brain.COMMENT_COOLDOWN_MS &&
      this.rateState.dailyComments < Brain.DAILY_COMMENT_LIMIT
    );
  }

  timeUntilNextPost(): number {
    const elapsed = Date.now() - this.rateState.lastPost;
    return Math.max(0, Brain.POST_COOLDOWN_MS - elapsed);
  }

  recordPost(): void {
    this.rateState.lastPost = Date.now();
  }

  recordComment(): void {
    this.rateState.lastComment = Date.now();
    this.rateState.dailyComments++;
  }

  private resetDailyIfNeeded(): void {
    const now = Date.now();
    if (now - this.rateState.dailyReset >= 24 * 60 * 60 * 1000) {
      this.rateState.dailyComments = 0;
      this.rateState.dailyReset = now;
    }
  }

  /**
   * Check if a topic is too similar to recent posts.
   */
  isTopicRepeated(topic: string): boolean {
    const lower = topic.toLowerCase();
    return this.topicHistory.some((prev) => this.similarity(lower, prev.toLowerCase()) > 0.5);
  }

  /**
   * Weighted random selection that avoids repeating the same post type.
   * Recently used types get lower weights.
   */
  selectPostType(): PostType {
    const allTypes: PostType[] = [
      "discovery",
      "workflow",
      "vulnerability",
      "forecast",
      "challenge",
      "framework",
      "data-drop",
      "question",
    ];

    const recentTypes = this.postTypeHistory.slice(-5);
    const weights = allTypes.map((type) => {
      const recentCount = recentTypes.filter((t) => t === type).length;
      return Math.max(1, 10 - recentCount * 3);
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < allTypes.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return allTypes[i];
      }
    }

    return allTypes[0];
  }

  /**
   * Suggest diverse topics based on expertise and trends.
   * Returns topics with associated post types for content diversity.
   */
  suggestTopics(count: number = 3): Array<{ topic: string; type: PostType }> {
    // Filter out recently used topics
    return SUGGESTIONS.filter((s) => !this.isTopicRepeated(s.topic)).slice(0, count);
  }

  /**
   * Get optimal posting schedule based on rate limits.
   * Returns suggested times for next posts today.
   */
  getPostingSchedule(): { time: Date; type: string }[] {
    const now = new Date();
    const schedule: { time: Date; type: string }[] = [];

    // With 30-min cooldown, max ~48 posts/day (but quality > quantity)
    // Recommended: 2-3 posts per day, spread across 8+ hours
    const idealPostTimes = [
      this.setTime(now, 9, 0), // Morning
      this.setTime(now, 14, 0), // Afternoon
      this.setTime(now, 20, 0), // Evening
    ];

    for (const time of idealPostTimes) {
      if (time > now) {
        schedule.push({ time, type: "post" });
      }
    }

    return schedule;
  }

  private setTime(date: Date, hours: number, minutes: number): Date {
    const d = new Date(date);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  /**
   * Pick a random item from an array.
   */
  private pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Check if content is too similar to recent posts (dedup).
   */
  private isDuplicate(content: string): boolean {
    const lower = content.toLowerCase();
    return this.postHistory.some((prev) => this.similarity(lower, prev.toLowerCase()) > 0.6);
  }

  /**
   * Simple word-overlap similarity (no extra deps).
   */
  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }
    return overlap / Math.max(wordsA.size, wordsB.size);
  }

  /**
   * Build a compact persona instruction (few tokens).
   */
  private personaInstruction(): string {
    const p = this.persona;
    return [
      `Voice: ${p.voice}.`,
      `Expertise: ${p.expertise.join(", ")}.`,
      `Style: ${p.style}.`,
      `Never use: ${p.avoid.join(", ")}.`,
    ].join(" ");
  }

  /**
   * Assemble a post from chunks (zero LLM tokens).
   */
  assembleFromChunks(topic: string): string | null {
    const hook = this.pick(this.chunks.hooks);
    const closing = this.pick(this.chunks.closings);

    // Simple assembly - only works for short posts
    if (topic.length < 100) {
      return `${hook} ${topic}\n\n${closing}`;
    }
    return null;
  }

  /**
   * Generate a post using the LLM with minimal tokens.
   * Uses persona + skill template to reduce prompt size.
   * Optionally accepts a postType; otherwise selects one automatically.
   */
  async generatePost(
    topic: string,
    submolt: string,
    options?: {
      skill?: string;
      maxLength?: number;
      postType?: PostType;
    },
  ): Promise<{ title: string; content: string; postType: PostType }> {
    // Determine post type
    const postType = options?.postType ?? this.selectPostType();

    // Try chunk assembly first (zero tokens) — only 10% of the time
    const chunkPost = this.assembleFromChunks(topic);
    if (chunkPost && Math.random() > 0.9) {
      const title = topic.length > 80 ? topic.slice(0, 77) + "..." : topic;
      this.postTypeHistory.push(postType);
      if (this.postTypeHistory.length > 20) {
        this.postTypeHistory = this.postTypeHistory.slice(-10);
      }
      return { title, content: chunkPost, postType };
    }

    // Select skill
    const skill = options?.skill
      ? this.skills.find((s) => s.name === options.skill)
      : (this.skills.find((s) => s.name === postType) ?? this.pick(this.skills));

    // Build type-specific prompt
    const typePrompt = buildTypePrompt(postType);

    // Try to fetch real docs from Context7 for specific tools mentioned in topic
    let context7Docs = "";
    const knownLibraries = [
      "react",
      "nextjs",
      "next.js",
      "vue",
      "angular",
      "svelte",
      "langchain",
      "langchain.js",
      "openai",
      "anthropic",
      "gemini",
      "pinecone",
      "milvus",
      "chromadb",
      "prisma",
      "drizzle",
      "express",
      "fastify",
      "hono",
      "elysia",
      "hapi",
      "typescript",
      "python",
      "rust",
      "go",
      "node.js",
      "node",
      "docker",
      "kubernetes",
      "k8s",
      "terraform",
      "aws",
      "gcp",
      "azure",
      "redis",
      "postgres",
      "postgresql",
      "mysql",
      "mongodb",
      "sqlite",
      "vercel",
      "netlify",
      "cloudflare",
      "fly.io",
      "railway",
    ];
    const mentionedLibs = knownLibraries.filter((lib) => topic.toLowerCase().includes(lib.toLowerCase()));
    if (mentionedLibs.length > 0) {
      try {
        const doc = await getRelevantDocs(mentionedLibs[0], topic, { tokens: 1500 });
        if (doc) {
          context7Docs = `\n\nReal documentation for ${doc.library}:\n${doc.content.slice(0, 1500)}\nUse this as reference for accurate version numbers, API names, and code examples.`;
        }
      } catch {
        /* Context7 unavailable, continue without */
      }
    }

    // Build prompt with source instruction
    const prompt = [
      this.personaInstruction(),
      "",
      `Write a Moltbook post for /m/${submolt}.`,
      `Topic: ${topic}`,
      `Post type: ${postType}`,
      skill ? `Format: ${skill.name} style` : "",
      typePrompt,
      context7Docs,
      `Length: 150-300 words. Be specific — name exact tools, versions, numbers, and link to real sources (GitHub repos, docs, articles) where relevant.`,
      "",
      "Format your output as:",
      "TITLE: short punchy title (5-8 words, not a question)",
      "BODY: the post content",
    ]
      .filter(Boolean)
      .join("\n");

    const response = await this.gateway.generate({
      prompt,
      model: this.model,
      maxTokens: 39000,
    });

    let content = response.text.trim();

    // Dedup check
    if (this.isDuplicate(content)) {
      // Regenerate with different skill
      const altSkill = this.skills.find((s) => s.name !== skill?.name) ?? this.pick(this.skills);
      const retryPrompt = [
        this.personaInstruction(),
        "",
        `Write a DIFFERENT Moltbook post for /m/${submolt}.`,
        `Topic: ${topic}`,
        `Post type: ${postType}`,
        `Format: ${altSkill.name} style`,
        `Length: 150-300 words. Include specific tools, numbers, and source links.`,
        "Must be different from: " + this.postHistory.slice(-3).join("; "),
        "",
        "Format your output as:",
        "TITLE: short punchy title (5-8 words, not a question)",
        "BODY: the post content",
      ]
        .filter(Boolean)
        .join("\n");

      const retry = await this.gateway.generate({
        prompt: retryPrompt,
        model: this.model,
        maxTokens: 39000,
      });
      content = retry.text.trim();
    }

    // Track history
    this.postHistory.push(content);
    this.topicHistory.push(topic);
    this.postTypeHistory.push(postType);
    if (this.postHistory.length > 20) {
      this.postHistory = this.postHistory.slice(-10);
    }
    if (this.topicHistory.length > 20) {
      this.topicHistory = this.topicHistory.slice(-10);
    }
    if (this.postTypeHistory.length > 20) {
      this.postTypeHistory = this.postTypeHistory.slice(-10);
    }

    // Parse TITLE: / BODY: format from response
    let title = topic;
    let body = content;
    const titleMatch = content.match(/^TITLE:\s*(.+)$/m);
    const bodyMatch = content.match(/^BODY:\s*/m);
    if (titleMatch) {
      title = titleMatch[1].trim().slice(0, 100);
    }
    if (bodyMatch && bodyMatch.index !== undefined) {
      body = content.slice(bodyMatch.index + bodyMatch[0].length).trim();
    }
    // Fallback: if no TITLE: found, use first line but keep it short
    if (!titleMatch) {
      const lines = content.split("\n").filter((l) => l.trim());
      title = lines[0]?.slice(0, 80) ?? topic;
      body = lines.slice(1).join("\n").trim() || content;
    }

    return { title, content: body, postType };
  }

  /**
   * Generate a comment reply (even shorter, fewer tokens).
   */
  async generateComment(postContent: string, submolt: string): Promise<string> {
    const prompt = [
      this.personaInstruction(),
      "",
      `Reply to this /m/${submolt} post in 1-2 sentences.`,
      `Post: ${postContent.slice(0, 500)}`,
      "",
      "Output ONLY the reply.",
    ]
      .filter(Boolean)
      .join("\n");

    const response = await this.gateway.generate({
      prompt,
      model: this.model,
      maxTokens: 200,
    });

    return response.text.trim();
  }
}

/**
 * Create a Brain instance.
 */
export function createBrain(config: BrainConfig): Brain {
  return new Brain(config);
}
