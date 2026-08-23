import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { BrainV2, type AgentDecision, type FeedPost, type NotificationItem, type RateLimitState } from "../src/brain-v2.js";

// ── Helpers ──────────────────────────────────────────────────────────

function buildMockGateway() {
  return {
    generate: mock.fn(async () => ({ text: '{"action":"scroll","reason":"testing"}' })),
    register: mock.fn(),
    list: mock.fn(() => []),
    route: mock.fn(),
  };
}

function defaultRateLimits(): RateLimitState {
  return { canPost: true, canComment: true, timeUntilPost: 0, timeUntilComment: 0, commentsToday: 0 };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("BrainV2", () => {
  describe("parseDecision", () => {
    it("parses valid post JSON", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"post","topic":"AI security","submolt":"general","postType":"discovery","reason":"found something"}');
      assert.strictEqual(result?.action, "post");
      assert.strictEqual(result?.reason, "found something");
    });

    it("parses JSON wrapped in markdown code blocks", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('```json\n{"action":"upvote","postId":"abc123","reason":"good post"}\n```');
      assert.strictEqual(result?.action, "upvote");
      assert.strictEqual(result?.reason, "good post");
    });

    it("parses JSON with extra text around it", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('Here is my decision:\n{"action":"comment","postId":"p1","content":"great work","reason":"insightful"}\nThanks!');
      assert.strictEqual(result?.action, "comment");
    });

    it("returns null for non-JSON text", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision("I think I should post about something");
      assert.strictEqual(result, null);
    });

    it("returns null for empty string", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      assert.strictEqual(brain.parseDecision(""), null);
    });

    it("returns null for invalid JSON", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      assert.strictEqual(brain.parseDecision("{not valid json}"), null);
    });

    it("parses scroll decision", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"scroll","reason":"nothing interesting"}');
      assert.strictEqual(result?.action, "scroll");
    });

    it("parses rest decision", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"rest","reason":"been active too long"}');
      assert.strictEqual(result?.action, "rest");
    });

    it("parses follow decision", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"follow","agentName":"coolbot","reason":"interesting posts"}');
      assert.strictEqual(result?.action, "follow");
      assert.strictEqual((result as any)?.agentName, "coolbot");
    });

    it("rejects unknown action types", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"delete","postId":"p1","reason":"bad"}');
      assert.strictEqual(result, null);
    });

    it("rejects post without required fields", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"post","reason":"missing fields"}');
      assert.strictEqual(result, null);
    });

    it("rejects comment without postId", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"comment","content":"hello","reason":"no postId"}');
      assert.strictEqual(result, null);
    });

    it("adds default reason when missing", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const result = brain.parseDecision('{"action":"scroll"}');
      assert.strictEqual(result?.action, "scroll");
      assert.strictEqual(result?.reason, "ai_decided");
    });
  });

  describe("buildSkillSelectionPrompt", () => {
    it("includes rate limit info", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const prompt = brain.buildSkillSelectionPrompt({
        feed: [],
        notifications: [],
        rateLimits: { canPost: false, canComment: true, timeUntilPost: 900_000, timeUntilComment: 0, commentsToday: 3 },
        postHistory: [],
        recentInteractions: [],
      });
      assert.ok(prompt.includes("Can post: false"));
      assert.ok(prompt.includes("wait 15min"));
      assert.ok(prompt.includes("Comments today: 3/50"));
    });

    it("includes feed posts", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const feed: FeedPost[] = [
        { id: "p1", title: "Test Post", submolt: "general", author: "bot1", upvotes: 10, comment_count: 5, createdAt: "" },
      ];
      const prompt = brain.buildSkillSelectionPrompt({
        feed,
        notifications: [],
        rateLimits: defaultRateLimits(),
        postHistory: [],
        recentInteractions: [],
      });
      assert.ok(prompt.includes("Test Post"));
      assert.ok(prompt.includes("bot1"));
    });

    it("includes recent post types for dedup", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const prompt = brain.buildSkillSelectionPrompt({
        feed: [],
        notifications: [],
        rateLimits: defaultRateLimits(),
        postHistory: [
          { type: "discovery", submolt: "general", upvotes: 5, timestamp: Date.now() },
          { type: "workflow", submolt: "agents", upvotes: 3, timestamp: Date.now() },
        ],
        recentInteractions: [],
      });
      assert.ok(prompt.includes("discovery"));
      assert.ok(prompt.includes("workflow"));
    });

    it("includes notifications", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const prompt = brain.buildSkillSelectionPrompt({
        feed: [],
        notifications: [{ type: "reply", message: "Nice post!", agentName: "bot2", postId: "p1", createdAt: "" }],
        rateLimits: defaultRateLimits(),
        postHistory: [],
        recentInteractions: [],
      });
      assert.ok(prompt.includes("Nice post!"));
      assert.ok(prompt.includes("bot2"));
    });

    it("includes SKILL.md content", () => {
      const brain = new BrainV2({ gateway: buildMockGateway() as any, skillsDir: "skills" });
      const prompt = brain.buildSkillSelectionPrompt({
        feed: [],
        notifications: [],
        rateLimits: defaultRateLimits(),
        postHistory: [],
        recentInteractions: [],
      });
      assert.ok(prompt.includes("nimjiagent"));
      assert.ok(prompt.includes("Moltbook"));
    });
  });

  describe("decide", () => {
    it("calls gateway.generate twice (skill selection + decision)", async () => {
      const gw = buildMockGateway();
      const brain = new BrainV2({ gateway: gw as any, skillsDir: "skills" });
      await brain.decide({
        feed: [],
        notifications: [],
        rateLimits: defaultRateLimits(),
        postHistory: [],
        recentInteractions: [],
      });
      // Phase 1: skill selection, Phase 2: decision
      assert.strictEqual(gw.generate.mock.calls.length, 2);
    });

    it("retries on malformed output", async () => {
      const gw = buildMockGateway();
      // Phase 1 returns valid skill selection, Phase 2 returns garbage, then retry returns valid
      let callCount = 0;
      gw.generate = mock.fn(async () => {
        callCount++;
        if (callCount === 1) return { text: '{"phase":"select_skill","skill":"engagement-strategy"}' };
        if (callCount === 2) return { text: "not json at all" };
        return { text: '{"action":"scroll","reason":"retry works"}' };
      });
      const brain = new BrainV2({ gateway: gw as any, skillsDir: "skills" });
      const result = await brain.decide({
        feed: [],
        notifications: [],
        rateLimits: defaultRateLimits(),
        postHistory: [],
        recentInteractions: [],
      });
      // 3 calls: skill selection + failed decision + retry decision
      assert.strictEqual(gw.generate.mock.calls.length, 3);
      assert.strictEqual(result.action, "scroll");
      assert.strictEqual(result.reason, "retry works");
    });

    it("returns parsed decision on first attempt", async () => {
      const gw = buildMockGateway();
      let callCount = 0;
      gw.generate = mock.fn(async () => {
        callCount++;
        if (callCount === 1) return { text: '{"phase":"select_skill","skill":"post-discovery"}' };
        return { text: '{"action":"post","topic":"test","submolt":"general","postType":"discovery","reason":"testing"}' };
      });
      const brain = new BrainV2({ gateway: gw as any, skillsDir: "skills" });
      const result = await brain.decide({
        feed: [],
        notifications: [],
        rateLimits: defaultRateLimits(),
        postHistory: [],
        recentInteractions: [],
      });
      assert.strictEqual(gw.generate.mock.calls.length, 2);
      assert.strictEqual(result.action, "post");
    });
  });
});
