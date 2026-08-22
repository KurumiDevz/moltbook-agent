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
    this.state = state;
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
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type]) => type);
  }

  getTopSubmolts(): string[] {
    const counts = new Map<string, number>();
    for (const p of this.state.postHistory) {
      const score = p.upvotes + p.comments;
      counts.set(p.submolt, (counts.get(p.submolt) ?? 0) + score);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sub]) => sub);
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

  serialize(): MemoryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  static deserialize(state: MemoryState): Memory {
    return new Memory(JSON.parse(JSON.stringify(state)));
  }
}
