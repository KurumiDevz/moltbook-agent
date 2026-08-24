import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Interaction, MemoryState, PostRecord, Relationship } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PATH = join(__dirname, "data", "memory.json");

const POST_COOLDOWN_MS = 30 * 60 * 1000;
const COMMENT_COOLDOWN_MS = 20 * 1000;

export class Memory {
  state: MemoryState;

  constructor(state: MemoryState) {
    // Backfill missing fields from old data formats
    this.state = {
      ...state,
      interactions: state.interactions ?? [],
      relationships: state.relationships ?? [],
      postHistory: state.postHistory ?? [],
      topicsSeen: state.topicsSeen ?? [],
      engagement: state.engagement ?? { postTypeScores: {}, lastChecked: 0 },
      karma: state.karma ?? 0,
      totalPosts: state.totalPosts ?? 0,
      totalComments: state.totalComments ?? 0,
      totalUpvotes: state.totalUpvotes ?? 0,
      startedAt: state.startedAt ?? Date.now(),
    };
  }

  static default(): Memory {
    try {
      const raw = readFileSync(DEFAULT_PATH, "utf-8");
      return Memory.deserialize(JSON.parse(raw));
    } catch {
      // File missing on fresh deploy — create with empty state
      return Memory.deserialize({
        interactions: [],
        relationships: [],
        postHistory: [],
        topicsSeen: [],
        engagement: { postTypeScores: {}, lastChecked: 0 },
        karma: 0,
        totalPosts: 0,
        totalComments: 0,
        totalUpvotes: 0,
        startedAt: Date.now(),
      });
    }
  }

  static fromFile(path: string): Memory {
    const raw = readFileSync(path, "utf-8");
    return Memory.deserialize(JSON.parse(raw));
  }

  saveFile(path: string): void {
    writeFileSync(path, JSON.stringify(this.state, null, 2), "utf-8");
  }

  recordInteraction(interaction: Interaction): void {
    this.state.interactions.push(interaction);
    if (this.state.interactions.length > 500) this.state.interactions.shift();
    if (interaction.type === "post") this.state.totalPosts++;
    if (interaction.type === "comment") this.state.totalComments++;
    if (interaction.type === "upvote") this.state.totalUpvotes++;
    this.state.karma += interaction.karmaDelta;
  }

  getRelationship(agentName: string): Relationship | null {
    return this.state.relationships.find((r) => r.name === agentName) ?? null;
  }

  updateRelationship(agentName: string, delta: Partial<Relationship>): void {
    const existing = this.state.relationships.find((r) => r.name === agentName);
    if (existing) {
      Object.assign(existing, delta);
    } else {
      this.state.relationships.push({
        name: agentName,
        sentiment: 0,
        interactions: 0,
        lastInteraction: Date.now(),
        followed: false,
        karmaGiven: 0,
        karmaReceived: 0,
        ...delta,
      });
    }
  }

  recordPost(record: PostRecord): void {
    this.state.postHistory.push(record);
  }

  getTopPostTypes(): string[] {
    const counts = new Map<string, number>();
    for (const p of this.state.postHistory) {
      counts.set(p.type, (counts.get(p.type) ?? 0) + p.upvotes);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  }

  getTopSubmolts(): string[] {
    const counts = new Map<string, number>();
    for (const p of this.state.postHistory) {
      const score = p.upvotes + p.comments;
      counts.set(p.submolt, (counts.get(p.submolt) ?? 0) + score);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([sub]) => sub);
  }

  getRecentInteractions(count: number): Interaction[] {
    return this.state.interactions.slice(-count);
  }

  getTimeSinceLastPost(): number {
    const posts = this.state.interactions.filter((i) => i.type === "post");
    if (posts.length === 0) return Infinity;
    return Date.now() - posts[posts.length - 1].timestamp;
  }

  getTimeSinceLastComment(): number {
    const comments = this.state.interactions.filter((i) => i.type === "comment");
    if (comments.length === 0) return Infinity;
    return Date.now() - comments[comments.length - 1].timestamp;
  }

  shouldPost(): boolean {
    return this.getTimeSinceLastPost() >= POST_COOLDOWN_MS;
  }

  shouldComment(): boolean {
    return this.getTimeSinceLastComment() >= COMMENT_COOLDOWN_MS;
  }

  trackTopic(topic: string, type: string): void {
    this.state.topicsSeen.push({ topic, timestamp: Date.now(), type });
  }

  isTopicRecent(topic: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    return this.state.topicsSeen.some((t) => t.topic === topic && t.timestamp >= cutoff);
  }

  // ─── Engagement tracking ───

  /** Update engagement stats for a post type after checking post stats. */
  updateEngagement(postType: string, upvotes: number, comments: number): void {
    if (!this.state.engagement.postTypeScores[postType]) {
      this.state.engagement.postTypeScores[postType] = { posts: 0, totalUpvotes: 0, totalComments: 0 };
    }
    const stats = this.state.engagement.postTypeScores[postType];
    stats.posts++;
    stats.totalUpvotes += upvotes;
    stats.totalComments += comments;
    this.state.engagement.lastChecked = Date.now();
  }

  /** Get average engagement per post type. Returns sorted by score descending. */
  getEngagementScores(): Array<{ type: string; avgUpvotes: number; avgComments: number; score: number }> {
    const results: Array<{ type: string; avgUpvotes: number; avgComments: number; score: number }> = [];
    for (const [type, stats] of Object.entries(this.state.engagement.postTypeScores)) {
      if (stats.posts === 0) continue;
      const avgUpvotes = stats.totalUpvotes / stats.posts;
      const avgComments = stats.totalComments / stats.posts;
      const score = avgUpvotes * 2 + avgComments * 3; // comments weighted higher
      results.push({ type, avgUpvotes, avgComments, score });
    }
    return results.sort((a, b) => b.score - a.score);
  }

  /** Get the best performing post type. Falls back to "discovery" if no data. */
  getBestPostType(): string {
    const scores = this.getEngagementScores();
    return scores[0]?.type ?? "discovery";
  }

  /** Get posts that need engagement checking (posted >1h ago, not yet checked). */
  getPostsForEngagementCheck(): PostRecord[] {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return this.state.postHistory.filter((p) => p.timestamp < oneHourAgo && !p.engagementChecked);
  }

  /** Mark a post as engagement-checked. */
  markEngagementChecked(postId: string): void {
    const post = this.state.postHistory.find((p) => p.id === postId);
    if (post) post.engagementChecked = true;
  }

  serialize(): MemoryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  static deserialize(state: MemoryState): Memory {
    return new Memory(JSON.parse(JSON.stringify(state)));
  }
}
