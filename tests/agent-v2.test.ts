import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { AgentV2, type AgentV2Config } from "../src/agent-v2.js";
import { ok } from "../src/result.js";

// ── Helpers ──────────────────────────────────────────────────────────

function buildMockMoltbookAgent() {
  return {
    getFeed: mock.fn(async () => ok({
      posts: [{ id: "p1", title: "Test Post", submolt: "general", author: "bot1", votes: 10, commentCount: 5, createdAt: "" }],
      hasMore: false,
    })),
    getNotifications: mock.fn(async () => ok({
      notifications: [{ type: "reply", message: "Nice!", agent_name: "bot2", post_id: "p1", created_at: "" }],
    })),
    createPost: mock.fn(async () => ok({ id: "new-post", url: "/", title: "Test", createdAt: "" })),
    comment: mock.fn(async () => ok({ id: "c1", content: "test" })),
    vote: mock.fn(async () => ok(undefined as void)),
    follow: mock.fn(async () => ok(undefined as void)),
    search: mock.fn(async () => ok({ results: [], count: 0, has_more: false })),
    getHome: mock.fn(async () => ok({
      your_account: { name: "test", karma: 0, unread_notification_count: 0 },
      activity_on_your_posts: [],
      posts_from_accounts_you_follow: { posts: [], total_following: 0 },
      what_to_do_next: [],
    })),
    markNotificationsRead: mock.fn(async () => ok(undefined as void)),
  };
}

function buildMockGateway() {
  return {
    generate: mock.fn(async () => ({ text: '{"action":"scroll","reason":"testing"}' })),
    register: mock.fn(),
    list: mock.fn(() => []),
    route: mock.fn(),
  };
}

function buildConfig(overrides: Partial<AgentV2Config> = {}): AgentV2Config {
  return {
    moltbookAgent: buildMockMoltbookAgent() as any,
    gateway: buildMockGateway() as any,
    model: "auto",
    submolts: ["general"],
    skillsDir: "skills",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("AgentV2", () => {
  describe("cycle", () => {
    it("fetches feed and notifications, sends to AI, executes decision", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"upvote","postId":"p1","reason":"good post"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "upvote");
      assert.ok(moltbook.getFeed.mock.calls.length >= 1);
      assert.ok(moltbook.vote.mock.calls.length >= 1);
    });

    it("handles post decision with rate limit", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"post","topic":"AI security","submolt":"general","postType":"discovery","title":"Test","body":"Content","reason":"testing"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "post");
      assert.ok(moltbook.createPost.mock.calls.length >= 1);
    });

    it("handles comment decision", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"comment","postId":"p1","content":"Great insights!","reason":"adding value"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "comment");
      assert.ok(moltbook.comment.mock.calls.length >= 1);
    });

    it("handles follow decision", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"follow","agentName":"coolbot","reason":"interesting"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "follow");
      assert.ok(moltbook.follow.mock.calls.length >= 1);
    });

    it("handles scroll decision", async () => {
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"scroll","reason":"nothing interesting"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: buildMockMoltbookAgent() as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "scroll");
    });

    it("handles rest decision", async () => {
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"rest","reason":"been active"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: buildMockMoltbookAgent() as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "rest");
    });

    it("handles feed fetch failure gracefully", async () => {
      const moltbook = buildMockMoltbookAgent();
      moltbook.getFeed = mock.fn(async () => { throw new Error("Network error"); });
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"scroll","reason":"feed unavailable"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
    });
  });

  describe("rate limiting", () => {
    it("rejects post when rate limited", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"post","topic":"test","submolt":"general","postType":"discovery","title":"T","body":"B","reason":"r"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });

      // First cycle posts successfully
      const r1 = await agent.cycle();
      assert.strictEqual(r1.success, true);

      // Second cycle should be rate limited (within 30min)
      const r2 = await agent.cycle();
      assert.strictEqual(r2.success, false);
      assert.ok(r2.message.includes("Rate limited"));
    });

    it("rejects comment when rate limited", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"comment","postId":"p1","content":"test","reason":"r"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });

      // First comment succeeds
      const r1 = await agent.cycle();
      assert.strictEqual(r1.success, true);

      // Second should be rate limited (within 20s)
      const r2 = await agent.cycle();
      assert.strictEqual(r2.success, false);
      assert.ok(r2.message.includes("Rate limited"));
    });
  });

  describe("topic dedup", () => {
    it("rejects duplicate topic within 24h", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      let callCount = 0;
      gw.generate = mock.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { text: '{"action":"post","topic":"AI security","submolt":"general","postType":"discovery","title":"T","body":"B","reason":"r"}' };
        }
        // Second call: try same topic
        return { text: '{"action":"post","topic":"AI security","submolt":"general","postType":"discovery","title":"T2","body":"B2","reason":"r"}' };
      });
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });

      const r1 = await agent.cycle();
      assert.strictEqual(r1.success, true);

      // Manually fast-forward past rate limit but keep topic recent
      const state = (agent as any).memory;
      state.lastPostAt = Date.now() - 31 * 60 * 1000; // 31 min ago (past cooldown)
      // topicsSeen still has "AI security" from first cycle

      const r2 = await agent.cycle();
      assert.strictEqual(r2.success, false);
      assert.ok(r2.message.includes("recently posted"));
    });
  });
});
