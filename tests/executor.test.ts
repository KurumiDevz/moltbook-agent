import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { execute } from "../dist/agent/executor.js";
import type { AgentDecision, ExecutionResult, PostSummary, Stance, ForeignStance } from "../dist/types.js";
import type { MemoryState } from "../dist/agent/types.js";
import { ok, err } from "../dist/util/result.js";
import { MoltbookApiError } from "../dist/util/errors.js";

// ── Helpers ──────────────────────────────────────────────────────────

function buildMemory(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    postHistory: [],
    topicsSeen: [],
    totalPosts: 0,
    totalComments: 0,
    totalUpvotes: 0,
    commentsToday: 0,
    lastCommentAt: 0,
    lastPostAt: 0,
    taskQueue: [],
    repliedCommentIds: new Set(),
    repliedThreadCounts: new Map(),
    repliedPostCounts: new Map(),
    stances: [],
    foreignStances: [],
    ...overrides,
  };
}

function buildMockMoltbookAgent(overrides: Record<string, any> = {}) {
  return {
    createPost: mock.fn(async () =>
      ok({
        id: "new-post-id",
        url: "/p/new-post-id",
        title: "Test Post",
        createdAt: new Date().toISOString(),
      }),
    ),
    comment: mock.fn(async () => ok({ id: "c1", content: "commented" })),
    vote: mock.fn(async () => ok(undefined as void)),
    follow: mock.fn(async () => ok(undefined as void)),
    markNotificationsRead: mock.fn(async () => ok(undefined as void)),
    ...overrides,
  };
}

function buildMockGateway(overrides: Record<string, any> = {}) {
  return {
    generate: mock.fn(async () => ({
      text: "Expanded content that meets the minimum word count requirement for testing purposes and validation of the expansion feature.",
    })),
    ...overrides,
  };
}

function buildMockBrain(overrides: Record<string, any> = {}) {
  return {
    gateway: buildMockGateway(),
    model: "auto",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("execute", () => {
  describe("scroll", () => {
    it("returns success with scrolling message", async () => {
      const decision: AgentDecision = {
        action: "scroll",
        reason: "nothing interesting",
      };
      const memory = buildMemory();
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "scroll");
      assert.ok(result.message.includes("nothing interesting"));
    });
  });

  describe("rest", () => {
    it("returns success with resting message", async () => {
      const decision: AgentDecision = {
        action: "rest",
        reason: "been active too long",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "rest");
      assert.ok(result.message.includes("been active too long"));
    });
  });

  describe("upvote", () => {
    it("calls vote with up direction", async () => {
      const moltbook = buildMockMoltbookAgent();
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "upvote",
        postId: "post-abc",
        reason: "great post",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "upvote");
      assert.ok(result.message.includes("post-abc"));
      assert.strictEqual(moltbook.vote.mock.callCount(), 1);
      assert.deepStrictEqual(moltbook.vote.mock.calls[0].arguments, ["post-abc", "up"]);
      assert.strictEqual(memory.totalUpvotes, 1);
    });
  });

  describe("downvote", () => {
    it("calls vote with down direction", async () => {
      const moltbook = buildMockMoltbookAgent();
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "downvote",
        postId: "post-bad",
        reason: "misinformation",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "downvote");
      assert.ok(result.message.includes("post-bad"));
      assert.strictEqual(moltbook.vote.mock.callCount(), 1);
      assert.deepStrictEqual(moltbook.vote.mock.calls[0].arguments, ["post-bad", "down"]);
    });
  });

  describe("follow", () => {
    it("calls follow with agent name", async () => {
      const moltbook = buildMockMoltbookAgent();
      const decision: AgentDecision = {
        action: "follow",
        agentName: "coolbot",
        reason: "interesting posts",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "follow");
      assert.ok(result.message.includes("coolbot"));
      assert.strictEqual(moltbook.follow.mock.callCount(), 1);
      assert.deepStrictEqual(moltbook.follow.mock.calls[0].arguments, ["coolbot"]);
    });
  });

  describe("dismiss", () => {
    it("calls markNotificationsRead", async () => {
      const moltbook = buildMockMoltbookAgent();
      const decision: AgentDecision = {
        action: "dismiss",
        postId: "post-dismiss",
        reason: "not relevant",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "dismiss");
      assert.strictEqual(moltbook.markNotificationsRead.mock.callCount(), 1);
    });
  });

  describe("post", () => {
    it("creates a post with provided title/body", async () => {
      const moltbook = buildMockMoltbookAgent();
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "post",
        topic: "AI security",
        submolt: "general",
        postType: "discovery",
        title: "My Great Post",
        body: "This is the body of my post about AI security trends.",
        reason: "found something",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "post");
      assert.ok(result.message.includes("My Great Post"));
      assert.strictEqual(moltbook.createPost.mock.callCount(), 1);
      assert.strictEqual(memory.totalPosts, 1);
      assert.strictEqual(memory.postHistory.length, 1);
      assert.strictEqual(memory.postHistory[0].title, "My Great Post");
      assert.strictEqual(memory.topicsSeen.length, 1);
      assert.strictEqual(memory.topicsSeen[0].topic, "AI security");
    });

    it("rejects post when rate limited", async () => {
      const memory = buildMemory({ lastPostAt: Date.now() - 60_000 });
      const decision: AgentDecision = {
        action: "post",
        topic: "test",
        submolt: "general",
        postType: "discovery",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Rate limited"));
    });

    it("rejects duplicate topic within 24h", async () => {
      const memory = buildMemory({
        topicsSeen: [{ topic: "AI security", timestamp: Date.now() }],
      });
      const decision: AgentDecision = {
        action: "post",
        topic: "AI security",
        submolt: "general",
        postType: "discovery",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("recently posted"));
    });

    it("records stance after posting", async () => {
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "post",
        topic: "AI ethics",
        submolt: "agents",
        postType: "workflow",
        title: "Ethics Post",
        body: "Body about ethics.",
        reason: "share",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(memory.stances.length, 1);
      assert.strictEqual(memory.stances[0].topic, "AI ethics");
      assert.strictEqual(memory.stances[0].source, "post");
    });

    it("increments totalPosts and lastPostAt", async () => {
      const memory = buildMemory();
      const before = Date.now();
      const decision: AgentDecision = {
        action: "post",
        topic: "test",
        submolt: "general",
        postType: "discovery",
        title: "T",
        body: "B",
        reason: "r",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(memory.totalPosts, 1);
      assert.ok(memory.lastPostAt >= before);
    });
  });

  describe("comment", () => {
    it("posts a comment with enough words", async () => {
      const moltbook = buildMockMoltbookAgent();
      const memory = buildMemory();
      const longContent =
        "This is a thoughtful comment that has enough words to pass the minimum word count check. It discusses the topic in detail and provides useful perspective.";
      const decision: AgentDecision = {
        action: "comment",
        postId: "target-post",
        content: longContent,
        reason: "adding value",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "comment");
      assert.ok(result.message.includes("target-post"));
      assert.strictEqual(moltbook.comment.mock.callCount(), 1);
      assert.strictEqual(memory.totalComments, 1);
      assert.strictEqual(memory.commentsToday, 1);
      assert.strictEqual(memory.repliedPostCounts.get("target-post"), 1);
    });

    it("rejects comment when rate limited", async () => {
      const memory = buildMemory({ lastCommentAt: Date.now() - 5_000 });
      const decision: AgentDecision = {
        action: "comment",
        postId: "p1",
        content: "A comment with enough words to pass validation checks.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Rate limited"));
    });

    it("rejects comment with no content", async () => {
      const decision: AgentDecision = {
        action: "comment",
        postId: "p1",
        content: "",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("No comment content"));
    });

    it("rejects comment exceeding per-post cap", async () => {
      const memory = buildMemory({
        repliedPostCounts: new Map([["p1", 2]]),
      });
      const decision: AgentDecision = {
        action: "comment",
        postId: "p1",
        content: "Another comment on the same post with enough words to pass.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Already commented"));
    });

    it("records stance after commenting", async () => {
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "comment",
        postId: "p1",
        content: "Great perspective on this topic with enough words for validation.",
        reason: "insightful",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.ok(memory.stances.length >= 1);
      assert.strictEqual(memory.stances[0].source, "comment");
    });

    it("marks notifications read after commenting", async () => {
      const moltbook = buildMockMoltbookAgent();
      const decision: AgentDecision = {
        action: "comment",
        postId: "p1",
        content: "Comment with enough words to pass the minimum validation check threshold.",
        reason: "engage",
      };
      await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.ok(moltbook.markNotificationsRead.mock.callCount() >= 1);
    });
  });

  describe("reply_to_comment", () => {
    it("posts a reply with enough words", async () => {
      const moltbook = buildMockMoltbookAgent();
      const memory = buildMemory();
      const longReply =
        "This reply addresses the specific point raised in the comment with detailed reasoning and evidence from my experience.";
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "comment-abc",
        postId: "post-xyz",
        content: longReply,
        reason: "disagree with point",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "reply_to_comment");
      assert.strictEqual(memory.repliedCommentIds.has("comment-abc"), true);
      assert.strictEqual(memory.repliedThreadCounts.get("comment-abc"), 1);
    });

    it("rejects reply to already-replied comment", async () => {
      const memory = buildMemory({
        repliedCommentIds: new Set(["comment-abc"]),
      });
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "comment-abc",
        postId: "post-xyz",
        content: "A reply with enough words to pass the minimum word count check for validation purposes.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Already replied"));
    });

    it("handles API failure gracefully", async () => {
      const moltbook = buildMockMoltbookAgent({
        comment: mock.fn(async () => err(new MoltbookApiError("Not Found", 404, null))),
      });
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "gone-comment",
        postId: "post-1",
        content: "A reply that should fail because the comment was deleted but still has enough words.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Reply failed"));
      // Should still track the comment ID to prevent retries
      assert.strictEqual(memory.repliedCommentIds.has("gone-comment"), true);
    });

    it("rejects reply with no content", async () => {
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "c1",
        postId: "p1",
        content: "",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("No reply content"));
    });

    it("rejects reply when rate limited", async () => {
      const memory = buildMemory({ lastCommentAt: Date.now() - 5_000 });
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "c1",
        postId: "p1",
        content: "Reply with enough words to pass validation checks for minimum count.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Rate limited"));
    });

    it("increments totalComments and commentsToday", async () => {
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "c1",
        postId: "p1",
        content: "A substantive reply that exceeds the minimum word count threshold for validation.",
        reason: "disagree",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(memory.totalComments, 1);
      assert.strictEqual(memory.commentsToday, 1);
    });

    it("records stance after replying", async () => {
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "reply_to_comment",
        commentId: "c1",
        postId: "p1",
        content: "Reply with a clear position and enough words for the minimum threshold.",
        reason: "disagree",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.ok(memory.stances.length >= 1);
      assert.strictEqual(memory.stances[0].source, "reply");
    });
  });

  describe("join_conversation", () => {
    it("posts a join with enough words", async () => {
      const moltbook = buildMockMoltbookAgent();
      const memory = buildMemory();
      const longContent =
        "Joining this conversation to add a different perspective on the topic being discussed with specific details.";
      const decision: AgentDecision = {
        action: "join_conversation",
        commentId: "thread-root",
        postId: "post-1",
        content: longContent,
        reason: "new angle",
      };
      const result = await execute(decision, {
        moltbookAgent: moltbook,
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.action, "join_conversation");
      assert.strictEqual(memory.repliedCommentIds.has("thread-root"), true);
    });

    it("rejects join when rate limited", async () => {
      const memory = buildMemory({ lastCommentAt: Date.now() - 5_000 });
      const decision: AgentDecision = {
        action: "join_conversation",
        commentId: "c1",
        postId: "p1",
        content: "Joining with enough words to pass the minimum word count validation check.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Rate limited"));
    });

    it("rejects join with no content", async () => {
      const decision: AgentDecision = {
        action: "join_conversation",
        commentId: "c1",
        postId: "p1",
        content: "",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("No reply content"));
    });

    it("rejects join to already-replied comment", async () => {
      const memory = buildMemory({
        repliedCommentIds: new Set(["thread-root"]),
      });
      const decision: AgentDecision = {
        action: "join_conversation",
        commentId: "thread-root",
        postId: "p1",
        content: "Joining with enough words to pass the minimum word count check.",
        reason: "test",
      };
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Already replied"));
    });

    it("increments commentsToday after join", async () => {
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "join_conversation",
        commentId: "c1",
        postId: "p1",
        content: "Joining conversation with a substantive perspective that meets word count.",
        reason: "new angle",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(memory.commentsToday, 1);
    });

    it("tracks thread reply count", async () => {
      const memory = buildMemory();
      const decision: AgentDecision = {
        action: "join_conversation",
        commentId: "c1",
        postId: "p1",
        content: "Adding perspective to the thread with enough words for the check.",
        reason: "add value",
      };
      await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory,
      });
      assert.strictEqual(memory.repliedThreadCounts.get("c1"), 1);
    });
  });

  describe("error handling", () => {
    it("propagates error when API throws", async () => {
      const moltbook = buildMockMoltbookAgent({
        vote: mock.fn(async () => {
          throw new Error("API is down");
        }),
      });
      const decision: AgentDecision = {
        action: "upvote",
        postId: "p1",
        reason: "test",
      };
      // executeUpvote calls .unwrap() which throws — execute() does not catch
      await assert.rejects(
        () =>
          execute(decision, {
            moltbookAgent: moltbook,
            gateway: buildMockGateway(),
            brain: buildMockBrain(),
            memory: buildMemory(),
          }),
        (error: any) => {
          assert.ok(error.message.includes("API is down"));
          return true;
        },
      );
    });

    it("handles unknown action type", async () => {
      const decision = { action: "unknown_action", reason: "test" } as any;
      const result = await execute(decision, {
        moltbookAgent: buildMockMoltbookAgent(),
        gateway: buildMockGateway(),
        brain: buildMockBrain(),
        memory: buildMemory(),
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Unknown"));
    });
  });
});
