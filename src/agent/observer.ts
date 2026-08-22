import type { MoltbookAgent } from "../moltbook.js";
import type { Personality } from "./personality.js";
import type { Memory } from "./memory.js";

export type ScoredPost = {
  post: {
    id: string;
    title: string;
    content?: string;
    url?: string;
    submolt: string;
    author: string;
    votes: number;
    commentCount: number;
    createdAt: string;
  };
  score: number;
  reasons: string[];
};

export type NotificationSummary = {
  replyCount: number;
  mentionCount: number;
  recentActivity: Array<{
    type: string;
    message: string;
    agentName?: string;
    postId?: string;
    createdAt: string;
  }>;
};

export type Trend = {
  keyword: string;
  heat: number;
  postCount: number;
  postIds: string[];
};

export type InterestingAgent = {
  name: string;
  avgKarma: number;
  postCount: number;
  topics: string[];
};

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "it", "to", "in", "for", "of", "and", "or",
  "my", "i", "we", "you", "they", "this", "that", "with", "on", "at",
  "do", "did", "does", "has", "have", "had", "was", "were", "be", "been",
  "will", "would", "can", "could", "should", "may", "might", "so", "but",
  "not", "no", "if", "then", "than", "just", "how", "what", "why", "when",
  "who", "which", "about", "from", "up", "out", "all", "some", "any",
  "here", "there", "your", "its", "our", "their", "into", "also",
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function keywordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let matches = 0;
  for (const word of b) { if (setA.has(word)) matches++; }
  return matches / Math.max(setA.size, b.length);
}

export class Observer {
  constructor(
    private agent: MoltbookAgent,
    private personality: Personality,
  ) {}

  /** Fetch feed and score each post by personality alignment. */
  async observeFeed(
    sort: "hot" | "new" | "top" | "rising" = "hot",
    limit = 25,
  ): Promise<{ posts: ScoredPost[]; hasMore: boolean }> {
    const { posts, hasMore } = await this.agent.getFeed({ sort, limit });
    const scored: ScoredPost[] = posts.map((post) => {
      const reasons: string[] = [];
      let score = 5; // base score so every post is at least interactable
      // Value alignment
      const postKeywords = extractKeywords(`${post.title} ${post.content ?? ""}`);
      const valueAlignment = this.personality.getValueAlignment(postKeywords);
      score += valueAlignment * 40;
      if (valueAlignment > 0.3) reasons.push(`value_match(${valueAlignment.toFixed(2)})`);
      // Novelty: curiosity boosts engagement with low-vote posts
      const curiosity = this.personality.getTraitWeight("curiosity");
      const noveltyBoost = post.votes < 10 ? curiosity * 0.2 : 0;
      score += noveltyBoost * 20;
      if (noveltyBoost > 0) reasons.push("novel_topic");
      // Controversy: mixed votes signal debate potential
      const voteBalance = Math.abs(post.votes);
      const controversyScore = voteBalance < 5 ? 0.5 : voteBalance > 50 ? 0.3 : 0.1;
      const snark = this.personality.getTraitWeight("snark");
      const controversyBonus = controversyScore * snark * 15;
      score += controversyBonus;
      if (controversyBonus > 3) reasons.push("controversial");
      // Engagement: high comment count = active discussion
      if (post.commentCount > 5) {
        const agreeableness = this.personality.getTraitWeight("agreeableness");
        score += agreeableness * 10;
        reasons.push("active_discussion");
      }
      return { post, score, reasons };
    });
    scored.sort((a, b) => b.score - a.score);
    return { posts: scored, hasMore };
  }

  /** Fetch notifications and summarize them. */
  async checkNotifications(): Promise<NotificationSummary> {
    const { notifications } = await this.agent.getNotifications({ limit: 50 });
    let replyCount = 0;
    let mentionCount = 0;
    const recentActivity: NotificationSummary["recentActivity"] = [];
    for (const n of notifications) {
      if (n.type === "reply" || n.type === "comment") replyCount++;
      if (n.type === "mention") mentionCount++;
      recentActivity.push({
        type: n.type,
        message: n.message,
        agentName: n.agent_name,
        postId: n.post_id,
        createdAt: n.created_at,
      });
    }
    return { replyCount, mentionCount, recentActivity: recentActivity.slice(0, 20) };
  }

  /** Detect trending topics by clustering posts with similar keywords. */
  detectTrends(posts: ScoredPost[], maxTrends = 10): Trend[] {
    const groups = new Map<string, { count: number; ids: string[]; keywords: string[] }>();
    for (const { post } of posts) {
      const keywords = extractKeywords(`${post.title} ${post.content ?? ""}`);
      for (const kw of keywords) {
        const existing = groups.get(kw) ?? { count: 0, ids: [], keywords: [] };
        existing.count++;
        existing.ids.push(post.id);
        existing.keywords.push(...keywords);
        groups.set(kw, existing);
      }
    }
    const trends: Trend[] = [];
    for (const [keyword, data] of groups) {
      if (data.count < 2) continue;
      const uniqueKeywords = [...new Set(data.keywords)];
      const heat = data.count * (1 + keywordSimilarity(uniqueKeywords, extractKeywords(keyword)));
      trends.push({
        keyword,
        heat: Math.round(heat * 100) / 100,
        postCount: data.count,
        postIds: [...new Set(data.ids)],
      });
    }
    trends.sort((a, b) => b.heat - a.heat);
    return trends.slice(0, maxTrends);
  }

  /** Find high-karma authors not yet followed. */
  findInterestingAgents(
    posts: ScoredPost[],
    memory: Memory,
    minKarma = 50,
  ): InterestingAgent[] {
    const authorStats = new Map<string, { totalKarma: number; count: number; topics: string[] }>();
    for (const { post } of posts) {
      const existing = authorStats.get(post.author) ?? { totalKarma: 0, count: 0, topics: [] };
      existing.totalKarma += post.votes;
      existing.count++;
      existing.topics.push(post.submolt);
      authorStats.set(post.author, existing);
    }
    const results: InterestingAgent[] = [];
    for (const [name, stats] of authorStats) {
      const rel = memory.getRelationship(name);
      if (rel?.followed) continue;
      if (rel && rel.sentiment < -0.3) continue;
      const avgKarma = stats.totalKarma / stats.count;
      if (avgKarma >= minKarma) {
        results.push({
          name,
          avgKarma: Math.round(avgKarma * 10) / 10,
          postCount: stats.count,
          topics: [...new Set(stats.topics)],
        });
      }
    }
    results.sort((a, b) => b.avgKarma - a.avgKarma);
    return results;
  }
}
