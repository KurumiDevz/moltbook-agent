import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { Executor } from "../src/agent/executor.js";
import type { MoltbookAgent } from "../src/moltbook.js";
import type { Brain } from "../src/brain/index.js";
import type { Personality } from "../src/agent/personality.js";
import type { Memory } from "../src/agent/memory.js";
import type { ScoredAction } from "../src/agent/types.js";
import { ok, err } from "../src/result.js";
import { MoltbookApiError } from "../src/errors.js";

// ── Helpers ─────────────────────────────────────────────────────────

function buildMockAgent(overrides: Partial<MoltbookAgent> = {}): MoltbookAgent {
  return {
    createPost: mock.fn(async () => ok({ id: "new-post-id", url: "/", title: "Generated", createdAt: "" })),
    getFeed: mock.fn(async () => ok({
      posts: [{ id: "target-post", title: "Target Post", submolt: "general", author: "x", upvotes: 10, comment_count: 5, createdAt: "" }],
      hasMore: false,
    })),
    comment: mock.fn(async () => ok({ id: "c1", content: "Nice" })),
    vote: mock.fn(async () => ok(undefined as void)),
    follow: mock.fn(async () => ok(undefined as void)),
    ...overrides,
  } as unknown as MoltbookAgent;
}

function buildMockBrain(overrides: Partial<Brain> = {}): Brain {
  return {
    generatePost: mock.fn(async () => ({ title: "Generated Title", content: "Generated content body", postType: "discovery" })),
    generateComment: mock.fn(async () => "Great post, I agree!"),
    recordPost: mock.fn(() => {}),
    recordComment: mock.fn(() => {}),
    ...overrides,
  } as unknown as Brain;
}

function buildMockPersonality(): Personality {
  return {
    state: { mood: "engaged", traits: { curiosity: 0.8, agreeableness: 0.6, confidence: 0.7, snark: 0.3, creativity: 0.5 }, values: ["security"], opinions: [], ego: { selfAwareness: 0.5, competitiveness: 0.5, generosity: 0.5 }, moodHistory: [] },
    shiftMood: mock.fn(() => {}),
    getValueAlignment: mock.fn(() => 0.5),
    getTraitWeight: mock.fn(() => 0.5),
  } as unknown as Personality;
}

function buildMockMemory(): Memory {
  return {
    recordInteraction: mock.fn(() => {}),
    recordPost: mock.fn(() => {}),
    updateRelationship: mock.fn(() => {}),
    getRelationship: mock.fn(() => null),
    trackTopic: mock.fn(() => {}),
    getPostsForEngagementCheck: mock.fn(() => []),
    markEngagementChecked: mock.fn(() => {}),
    state: { interactions: [], relationships: [], postHistory: [], topicsSeen: [], karma: 0, totalPosts: 0, totalComments: 0, totalUpvotes: 0, startedAt: Date.now() },
  } as unknown as Memory;
}

function scoredAction(action: ScoredAction["action"], score = 10): ScoredAction {
  return { action, score, reason: "test" };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Executor", () => {
  describe("execute - post", () => {
    it("calls brain.generatePost then agent.createPost and records in memory", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "post", topic: "AI security", submolt: "general", postType: "discovery" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes("Generated Title"));
      assert.strictEqual(brain.generatePost.mock.calls.length, 1);
      assert.deepStrictEqual(brain.generatePost.mock.calls[0].arguments, ["AI security", "general"]);
      assert.strictEqual(agent.createPost.mock.calls.length, 1);
      assert.strictEqual(brain.recordPost.mock.calls.length, 1);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 1);
      assert.strictEqual(memory.recordPost.mock.calls.length, 1);
      assert.strictEqual(personality.shiftMood.mock.calls.length, 1);
    });
  });

  describe("execute - comment", () => {
    it("calls brain.generateComment, comments on post, and records", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "comment", postId: "target-post", content: "" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Comment posted");
      assert.strictEqual(brain.generateComment.mock.calls.length, 1);
      assert.strictEqual(agent.comment.mock.calls.length, 1);
      assert.strictEqual(brain.recordComment.mock.calls.length, 1);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 1);
      // Verify the comment interaction recorded the target post id
      const interaction = memory.recordInteraction.mock.calls[0].arguments[0];
      assert.strictEqual(interaction.type, "comment");
      assert.strictEqual(interaction.target, "target-post");
    });
  });

  describe("execute - upvote", () => {
    it("calls agent.vote with up direction and records in memory", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "upvote", postId: "some-post" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Upvoted");
      assert.strictEqual(agent.vote.mock.calls.length, 1);
      assert.deepStrictEqual(agent.vote.mock.calls[0].arguments, ["some-post", "up"]);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 1);
      assert.strictEqual(personality.shiftMood.mock.calls.length, 1);
    });
  });

  describe("execute - downvote", () => {
    it("calls agent.vote with down direction and records in memory", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "downvote", postId: "bad-post" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Downvoted");
      assert.deepStrictEqual(agent.vote.mock.calls[0].arguments, ["bad-post", "down"]);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 1);
    });
  });

  describe("execute - follow", () => {
    it("calls agent.follow and updates relationship in memory", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "follow", agentName: "cool_agent" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Followed cool_agent");
      assert.strictEqual(agent.follow.mock.calls.length, 1);
      assert.deepStrictEqual(agent.follow.mock.calls[0].arguments, ["cool_agent"]);
      assert.strictEqual(memory.updateRelationship.mock.calls.length, 1);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 1);
    });
  });

  describe("execute - scroll / rest", () => {
    it("scroll does nothing and returns success", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "scroll" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Scrolled feed");
      // No API calls, no memory recording
      assert.strictEqual(agent.createPost.mock.calls.length, 0);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 0);
    });

    it("rest shifts mood and returns success", async () => {
      const agent = buildMockAgent();
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "rest" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Resting");
      assert.strictEqual(personality.shiftMood.mock.calls.length, 1);
      assert.strictEqual(memory.recordInteraction.mock.calls.length, 0);
    });
  });

  describe("naturalDelay", () => {
    it("returns a promise (async function)", () => {
      const executor = new Executor(buildMockAgent(), buildMockBrain());
      const result = executor.naturalDelay();
      assert.ok(result instanceof Promise, "naturalDelay should return a promise");
      // We don't await it — just verify the type. Override setTimeout to resolve instantly.
    });
  });

  describe("error handling", () => {
    it("returns failure result when API call throws", async () => {
      const agent = buildMockAgent({
        createPost: mock.fn(async () => { throw new Error("API is down"); }),
      });
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "post", topic: "topic", submolt: "general", postType: "discovery" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("API is down"));
    });

    it("returns failure when comment target post is not found", async () => {
      const agent = buildMockAgent({
        getFeed: mock.fn(async () => ok({ posts: [], hasMore: false })),
      });
      const brain = buildMockBrain();
      const personality = buildMockPersonality();
      const memory = buildMockMemory();
      const executor = new Executor(agent, brain);

      const action = scoredAction({ type: "comment", postId: "nonexistent", content: "" });
      const result = await executor.execute(action, personality, memory);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("No post found"));
    });
  });
});
