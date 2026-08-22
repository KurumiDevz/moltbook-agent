import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { Observer, type ScoredPost } from "../src/agent/observer.js";
import type { MoltbookAgent } from "../src/moltbook.js";
import type { Personality } from "../src/agent/personality.js";
import type { Memory } from "../src/agent/memory.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makePost(overrides: Partial<ScoredPost["post"]> = {}): ScoredPost["post"] {
  return {
    id: "p1",
    title: "Test post about security",
    content: "A deep dive into authentication security practices",
    submolt: "general",
    author: "alice",
    votes: 15,
    commentCount: 8,
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    type: "reply",
    message: "You have a new reply",
    post_id: "p1",
    agent_name: "bob",
    created_at: "2025-01-01T00:00:00Z",
    read: false,
    ...overrides,
  };
}

function buildMockAgent(overrides: Partial<MoltbookAgent> = {}): MoltbookAgent {
  return {
    getFeed: mock.fn(async () => ({ posts: [makePost()], hasMore: false })),
    getNotifications: mock.fn(async () => ({ notifications: [makeNotification()] })),
    createPost: mock.fn(async () => ({ id: "p1", url: "/", title: "", createdAt: "" })),
    comment: mock.fn(async () => ({ id: "c1", content: "" })),
    vote: mock.fn(async () => {}),
    follow: mock.fn(async () => {}),
    ...overrides,
  } as unknown as MoltbookAgent;
}

function buildMockPersonality(overrides: Partial<Personality> = {}): Personality {
  return {
    getValueAlignment: mock.fn(() => 0.5),
    getTraitWeight: mock.fn(() => 0.5),
    state: { mood: "engaged", traits: { curiosity: 0.8, agreeableness: 0.6, confidence: 0.7, snark: 0.3, creativity: 0.5 }, values: ["security", "craft"], opinions: [], ego: { selfAwareness: 0.5, competitiveness: 0.5, generosity: 0.5 }, moodHistory: [] },
    shiftMood: mock.fn(() => {}),
    ...overrides,
  } as unknown as Personality;
}

function buildMockMemory(relationships: Record<string, { followed?: boolean; sentiment?: number }> = {}): Memory {
  return {
    getRelationship: mock.fn((name: string) => {
      const r = relationships[name];
      if (!r) return null;
      return { name, sentiment: r.sentiment ?? 0, interactions: 1, lastInteraction: Date.now(), followed: r.followed ?? false, karmaGiven: 0, karmaReceived: 0 };
    }),
    recordInteraction: mock.fn(() => {}),
    recordPost: mock.fn(() => {}),
    updateRelationship: mock.fn(() => {}),
    state: { interactions: [], relationships: [], postHistory: [], topicsSeen: [], karma: 0, totalPosts: 0, totalComments: 0, totalUpvotes: 0, startedAt: Date.now() },
  } as unknown as Memory;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Observer", () => {
  describe("observeFeed", () => {
    it("fetches posts and returns scored results sorted by score descending", async () => {
      const agent = buildMockAgent({
        getFeed: mock.fn(async () => ({
          posts: [
            makePost({ id: "p1", title: "Low quality post", votes: 1, commentCount: 0 }),
            makePost({ id: "p2", title: "High quality post", votes: 100, commentCount: 20 }),
          ],
          hasMore: true,
        })),
      });
      const personality = buildMockPersonality();
      const observer = new Observer(agent, personality);

      const result = await observer.observeFeed("hot", 25);

      assert.strictEqual(result.posts.length, 2);
      assert.strictEqual(result.hasMore, true);
      assert.ok(result.posts[0].score >= result.posts[1].score, "Posts should be sorted by score descending");
      // Verify getFeed was called with correct params
      assert.strictEqual(agent.getFeed.mock.calls.length, 1);
      assert.deepStrictEqual(agent.getFeed.mock.calls[0].arguments, [{ sort: "hot", limit: 25 }]);
    });

    it("returns empty arrays when feed is empty", async () => {
      const agent = buildMockAgent({
        getFeed: mock.fn(async () => ({ posts: [], hasMore: false })),
      });
      const personality = buildMockPersonality();
      const observer = new Observer(agent, personality);

      const result = await observer.observeFeed("new");

      assert.strictEqual(result.posts.length, 0);
      assert.strictEqual(result.hasMore, false);
    });

    it("includes scoring reasons based on personality alignment", async () => {
      const agent = buildMockAgent({
        getFeed: mock.fn(async () => ({
          posts: [makePost({ id: "p1", commentCount: 10 })],
          hasMore: false,
        })),
      });
      const personality = buildMockPersonality({
        getValueAlignment: mock.fn(() => 0.8), // high alignment
        getTraitWeight: mock.fn((trait: string) => {
          if (trait === "curiosity") return 0.9;
          if (trait === "snark") return 0.7;
          if (trait === "agreeableness") return 0.6;
          return 0.5;
        }),
      });
      const observer = new Observer(agent, personality);

      const result = await observer.observeFeed();

      assert.strictEqual(result.posts.length, 1);
      assert.ok(result.posts[0].reasons.length > 0, "Should include at least one reason");
      assert.ok(result.posts[0].score > 0, "Score should be positive with high alignment");
    });
  });

  describe("checkNotifications", () => {
    it("parses notification summary with reply and mention counts", async () => {
      const agent = buildMockAgent({
        getNotifications: mock.fn(async () => ({
          notifications: [
            makeNotification({ id: "n1", type: "reply", message: "Reply 1", agent_name: "bob" }),
            makeNotification({ id: "n2", type: "mention", message: "Mention 1", agent_name: "carol" }),
            makeNotification({ id: "n3", type: "reply", message: "Reply 2", agent_name: "dave" }),
            makeNotification({ id: "n4", type: "karma", message: "+5 karma" }),
          ],
        })),
      });
      const personality = buildMockPersonality();
      const observer = new Observer(agent, personality);

      const summary = await observer.checkNotifications();

      assert.strictEqual(summary.replyCount, 2);
      assert.strictEqual(summary.mentionCount, 1);
      assert.strictEqual(summary.recentActivity.length, 4);
      assert.strictEqual(summary.recentActivity[0].type, "reply");
      assert.strictEqual(summary.recentActivity[1].type, "mention");
    });

    it("returns zero counts when no notifications", async () => {
      const agent = buildMockAgent({
        getNotifications: mock.fn(async () => ({ notifications: [] })),
      });
      const personality = buildMockPersonality();
      const observer = new Observer(agent, personality);

      const summary = await observer.checkNotifications();

      assert.strictEqual(summary.replyCount, 0);
      assert.strictEqual(summary.mentionCount, 0);
      assert.strictEqual(summary.recentActivity.length, 0);
    });

    it("caps recentActivity at 20 entries", async () => {
      const notifications = Array.from({ length: 30 }, (_, i) =>
        makeNotification({ id: `n${i}`, type: "reply", message: `Reply ${i}` })
      );
      const agent = buildMockAgent({
        getNotifications: mock.fn(async () => ({ notifications })),
      });
      const personality = buildMockPersonality();
      const observer = new Observer(agent, personality);

      const summary = await observer.checkNotifications();

      assert.strictEqual(summary.recentActivity.length, 20);
      assert.strictEqual(summary.replyCount, 30);
    });
  });

  describe("detectTrends", () => {
    it("groups posts by keyword similarity and sorts by heat", () => {
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      const posts: ScoredPost[] = [
        { post: makePost({ id: "p1", title: "Security authentication system", content: "Building secure authentication" }), score: 10, reasons: [] },
        { post: makePost({ id: "p2", title: "Security best practices guide", content: "Guide to security practices" }), score: 8, reasons: [] },
        { post: makePost({ id: "p3", title: "Random gardening tips", content: "How to grow tomatoes" }), score: 5, reasons: [] },
      ];

      const trends = observer.detectTrends(posts);

      assert.ok(trends.length > 0, "Should detect at least one trend");
      assert.ok(trends[0].heat >= trends[trends.length - 1].heat, "Trends should be sorted by heat descending");
      // "security" appears in 2 posts
      const securityTrend = trends.find((t) => t.keyword === "security");
      assert.ok(securityTrend, "Should find 'security' trend");
      assert.ok(securityTrend!.postCount >= 2, "Security trend should appear in at least 2 posts");
    });

    it("returns empty array when posts is empty", () => {
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      const trends = observer.detectTrends([]);

      assert.strictEqual(trends.length, 0);
    });

    it("filters out keywords with count < 2", () => {
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      // Each keyword appears only once across the single post
      const posts: ScoredPost[] = [
        { post: makePost({ id: "p1", title: "Rambutan fruit guide", content: "How to pick ripe ones" }), score: 5, reasons: [] },
      ];

      const trends = observer.detectTrends(posts);

      // "rambutan" appears once, "fruit" once, "guide" once — all count=1
      const rambutanTrend = trends.find((t) => t.keyword === "rambutan");
      assert.ok(!rambutanTrend, "Single-count keywords should be filtered out");
    });
  });

  describe("findInterestingAgents", () => {
    it("finds high-karma authors not yet followed", () => {
      const memory = buildMockMemory({});
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      const posts: ScoredPost[] = [
        { post: makePost({ id: "p1", author: "high_karma_user", votes: 100, submolt: "general" }), score: 10, reasons: [] },
        { post: makePost({ id: "p2", author: "high_karma_user", votes: 80, submolt: "agents" }), score: 8, reasons: [] },
      ];

      const interesting = observer.findInterestingAgents(posts, memory, 50);

      assert.strictEqual(interesting.length, 1);
      assert.strictEqual(interesting[0].name, "high_karma_user");
      assert.ok(interesting[0].avgKarma >= 50, "Avg karma should meet threshold");
      assert.strictEqual(interesting[0].topics.length, 2);
    });

    it("filters out already-followed agents", () => {
      const memory = buildMockMemory({
        alice: { followed: true },
      });
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      const posts: ScoredPost[] = [
        { post: makePost({ id: "p1", author: "alice", votes: 100 }), score: 10, reasons: [] },
      ];

      const interesting = observer.findInterestingAgents(posts, memory, 50);

      assert.strictEqual(interesting.length, 0, "Followed agents should be excluded");
    });

    it("returns empty when all authors are already followed or below karma threshold", () => {
      const memory = buildMockMemory({
        bob: { followed: true },
      });
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      const posts: ScoredPost[] = [
        { post: makePost({ id: "p1", author: "bob", votes: 100 }), score: 10, reasons: [] },
        { post: makePost({ id: "p2", author: "low_karma", votes: 5 }), score: 2, reasons: [] },
      ];

      const interesting = observer.findInterestingAgents(posts, memory, 50);

      assert.strictEqual(interesting.length, 0);
    });

    it("filters out agents with negative sentiment below -0.3", () => {
      const memory = buildMockMemory({
        troll: { followed: false, sentiment: -0.5 },
      });
      const personality = buildMockPersonality();
      const observer = new Observer(buildMockAgent(), personality);

      const posts: ScoredPost[] = [
        { post: makePost({ id: "p1", author: "troll", votes: 200 }), score: 10, reasons: [] },
      ];

      const interesting = observer.findInterestingAgents(posts, memory, 50);

      assert.strictEqual(interesting.length, 0, "Agents with low sentiment should be excluded");
    });
  });
});
