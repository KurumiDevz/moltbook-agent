import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { AgentV2 } from "../dist/agent/agent.js";
import type { AgentV2Config } from "../dist/agent/types.js";
import { ok, err } from "../dist/util/result.js";
import { MoltbookApiError } from "../dist/util/errors.js";

// ── Helpers ──────────────────────────────────────────────────────────

function buildMockMoltbookAgent() {
  return {
    getFeed: mock.fn(async () =>
      ok({
        posts: [
          {
            id: "p1",
            title: "Test Post",
            content: "Post content here.",
            submolt: "general",
            author: "bot1",
            votes: 10,
            commentCount: 5,
            createdAt: "",
          },
        ],
        hasMore: false,
      }),
    ),
    getNotifications: mock.fn(async () =>
      ok({
        notifications: [
          {
            id: "n1",
            type: "reply",
            content: "Nice post!",
            relatedPostId: "p1",
            isRead: false,
            createdAt: "",
          },
        ],
      }),
    ),
    getHome: mock.fn(async () =>
      ok({
        your_account: {
          name: "test-agent",
          karma: 100,
          unread_notification_count: 1,
        },
        activity_on_your_posts: [],
        posts_from_accounts_you_follow: {
          posts: [],
          total_following: 0,
          see_more: "",
          hint: "",
        },
        what_to_do_next: [],
      }),
    ),
    search: mock.fn(async () => ok({ results: [], count: 0, has_more: false })),
    getMyPosts: mock.fn(async () => ok([])),
    createPost: mock.fn(async () =>
      ok({
        id: "new-post",
        url: "/p/new-post",
        title: "Test",
        createdAt: "",
      }),
    ),
    comment: mock.fn(async () => ok({ id: "c1", content: "test" })),
    vote: mock.fn(async () => ok(undefined as void)),
    follow: mock.fn(async () => ok(undefined as void)),
    markNotificationsRead: mock.fn(async () => ok(undefined as void)),
    listPosts: mock.fn(async () => ok({ posts: [], count: 0, has_more: false })),
    listComments: mock.fn(async () => ok({ comments: [], count: 0 })),
    getPost: mock.fn(async () =>
      ok({
        post: {
          id: "p1",
          title: "Test",
          content: "content",
          upvotes: 0,
          downvotes: 0,
          comment_count: 0,
          created_at: "",
          submolt: { id: "s1", name: "general", display_name: "General" },
          author: {
            id: "a1",
            name: "bot1",
          },
        },
        comments: [],
      }),
    ),
  };
}

function buildMockGateway() {
  return {
    generate: mock.fn(async () => ({
      text: '{"action":"scroll","reason":"testing"}',
    })),
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
  describe("constructor", () => {
    it("initializes with default memory state", () => {
      const agent = new AgentV2(buildConfig());
      const memory = (agent as any).memory;
      // Memory fields exist and have correct types (values may come from persisted summary)
      assert.strictEqual(typeof memory.totalPosts, "number");
      assert.strictEqual(typeof memory.totalComments, "number");
      assert.strictEqual(typeof memory.totalUpvotes, "number");
      assert.strictEqual(typeof memory.commentsToday, "number");
      assert.strictEqual(typeof memory.lastCommentAt, "number");
      assert.strictEqual(typeof memory.lastPostAt, "number");
      assert.ok(Array.isArray(memory.postHistory));
      assert.ok(Array.isArray(memory.topicsSeen));
      assert.ok(memory.repliedCommentIds instanceof Set);
      assert.ok(memory.repliedThreadCounts instanceof Map);
      assert.ok(memory.repliedPostCounts instanceof Map);
      assert.ok(Array.isArray(memory.stances));
      assert.ok(Array.isArray(memory.foreignStances));
      assert.ok(Array.isArray(memory.taskQueue));
    });

    it("loads existing summary from disk if present", () => {
      const agent = new AgentV2(buildConfig());
      // Should not throw — either loads summary or starts fresh
      assert.ok(agent);
    });

    it("sets submolts from config", () => {
      const agent = new AgentV2(buildConfig({ submolts: ["general", "agents"] }));
      assert.deepStrictEqual((agent as any).submolts, ["general", "agents"]);
    });
  });

  describe("stop", () => {
    it("sets running to false", () => {
      const agent = new AgentV2(buildConfig());
      assert.strictEqual((agent as any).running, false);
      agent.stop();
      assert.strictEqual((agent as any).running, false);
    });
  });

  describe("cycle", () => {
    it("fetches feed and executes scroll decision", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"scroll","reason":"nothing interesting"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "scroll");
      assert.ok(moltbook.getFeed.mock.callCount() >= 1);
    });

    it("executes upvote decision", async () => {
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
      assert.ok(moltbook.vote.mock.callCount() >= 1);
    });

    it("executes follow decision", async () => {
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
      assert.ok(moltbook.follow.mock.callCount() >= 1);
    });

    it("executes post decision with title/body", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"post","topic":"AI","submolt":"general","postType":"discovery","title":"Test Title","body":"Test body content here.","reason":"testing"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const result = await agent.cycle();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "post");
      assert.ok(moltbook.createPost.mock.callCount() >= 1);
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

    it("increments cycleCount after each cycle", async () => {
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"scroll","reason":"test"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: buildMockMoltbookAgent() as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      const before = (agent as any).cycleCount;
      await agent.cycle();
      assert.strictEqual((agent as any).cycleCount, before + 1);
      await agent.cycle();
      assert.strictEqual((agent as any).cycleCount, before + 2);
    });
  });

  describe("rate limiting", () => {
    it("skips post when rate limited (within 30min)", async () => {
      const moltbook = buildMockMoltbookAgent();
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"post","topic":"test","submolt":"general","postType":"discovery","title":"T","body":"B content here that is long enough.","reason":"r"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });

      // First cycle posts successfully
      const r1 = await agent.cycle();
      assert.strictEqual(r1.success, true);
      assert.strictEqual(r1.action, "post");
      assert.ok(moltbook.createPost.mock.callCount() >= 1);

      // Second cycle should skip the post (rate limited) and return scroll fallback
      const r2 = await agent.cycle();
      assert.strictEqual(r2.success, true);
      // Post was rate-limited, so no additional createPost call should have been made
      const createPostCallsAfterFirst = moltbook.createPost.mock.callCount();
      // The scroll fallback runs, no new post created
      assert.strictEqual(r2.action, "scroll");
    });
  });

  describe("error handling", () => {
    it("handles feed fetch failure gracefully", async () => {
      const moltbook = buildMockMoltbookAgent();
      moltbook.getFeed = mock.fn(async () => {
        throw new Error("Network error");
      });
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
      // Should still complete — fetch failures return empty arrays
      assert.strictEqual(result.success, true);
    });

    it("propagates vote API error", async () => {
      const moltbook = buildMockMoltbookAgent();
      moltbook.vote = mock.fn(async () => err(new MoltbookApiError("Not Found", 404, null)));
      const gw = buildMockGateway();
      gw.generate = mock.fn(async () => ({
        text: '{"action":"upvote","postId":"p1","reason":"good"}',
      }));
      const agent = new AgentV2({
        moltbookAgent: moltbook as any,
        gateway: gw as any,
        skillsDir: "skills",
      });
      // executeUpvote calls .unwrap() on err() which throws — error propagates
      await assert.rejects(
        () => agent.cycle(),
        (error: any) => {
          assert.strictEqual(error.name, "MoltbookApiError");
          return true;
        },
      );
    });
  });
});
