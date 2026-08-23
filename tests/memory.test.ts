import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Memory } from "../src/agent/memory.js";
import type { MemoryState, Interaction, PostRecord } from "../src/agent/types.js";

function makeState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
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
    ...overrides,
  };
}

function makeInteraction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    type: "post",
    timestamp: Date.now(),
    karmaDelta: 1,
    mood: "engaged",
    ...overrides,
  };
}

function makePostRecord(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: "post-1",
    title: "Test Post",
    submolt: "/m/general",
    type: "discovery",
    upvotes: 5,
    comments: 2,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("Memory", () => {
  describe("construction", () => {
    it("constructs with provided state", () => {
      const state = makeState();
      const m = new Memory(state);
      assert.deepStrictEqual(m.state, state);
    });

    it("starts with empty arrays and zero counters", () => {
      const m = new Memory(makeState());
      assert.deepStrictEqual(m.state.interactions, []);
      assert.deepStrictEqual(m.state.relationships, []);
      assert.deepStrictEqual(m.state.postHistory, []);
      assert.deepStrictEqual(m.state.topicsSeen, []);
      assert.strictEqual(m.state.karma, 0);
      assert.strictEqual(m.state.totalPosts, 0);
      assert.strictEqual(m.state.totalComments, 0);
      assert.strictEqual(m.state.totalUpvotes, 0);
    });
  });

  describe("recordInteraction", () => {
    it("adds interaction to list", () => {
      const m = new Memory(makeState());
      const interaction = makeInteraction();
      m.recordInteraction(interaction);
      assert.strictEqual(m.state.interactions.length, 1);
      assert.deepStrictEqual(m.state.interactions[0], interaction);
    });

    it("increments totalPosts for post type", () => {
      const m = new Memory(makeState());
      m.recordInteraction(makeInteraction({ type: "post" }));
      m.recordInteraction(makeInteraction({ type: "post" }));
      assert.strictEqual(m.state.totalPosts, 2);
      assert.strictEqual(m.state.totalComments, 0);
    });

    it("increments totalComments for comment type", () => {
      const m = new Memory(makeState());
      m.recordInteraction(makeInteraction({ type: "comment" }));
      assert.strictEqual(m.state.totalComments, 1);
    });

    it("increments totalUpvotes for upvote type", () => {
      const m = new Memory(makeState());
      m.recordInteraction(makeInteraction({ type: "upvote" }));
      assert.strictEqual(m.state.totalUpvotes, 1);
    });

    it("accumulates karma from karmaDelta", () => {
      const m = new Memory(makeState());
      m.recordInteraction(makeInteraction({ karmaDelta: 5 }));
      m.recordInteraction(makeInteraction({ karmaDelta: -2 }));
      assert.strictEqual(m.state.karma, 3);
    });

    it("trims interactions at 500", () => {
      const interactions = Array.from({ length: 500 }, () => makeInteraction());
      const m = new Memory(makeState({ interactions }));
      m.recordInteraction(makeInteraction());
      assert.strictEqual(m.state.interactions.length, 500);
      // The oldest should have been removed
    });
  });

  describe("getRelationship / updateRelationship", () => {
    it("getRelationship returns null for unknown agent", () => {
      const m = new Memory(makeState());
      assert.strictEqual(m.getRelationship("unknown-agent"), null);
    });

    it("getRelationship returns relationship for known agent", () => {
      const m = new Memory(makeState());
      m.updateRelationship("alice", { sentiment: 0.5, followed: true });
      const rel = m.getRelationship("alice");
      assert(rel !== null);
      assert.strictEqual(rel.name, "alice");
      assert.strictEqual(rel.sentiment, 0.5);
      assert.strictEqual(rel.followed, true);
    });

    it("updateRelationship creates new relationship with defaults", () => {
      const m = new Memory(makeState());
      m.updateRelationship("bob", { sentiment: 0.3 });
      const rel = m.getRelationship("bob");
      assert(rel !== null);
      assert.strictEqual(rel.name, "bob");
      assert.strictEqual(rel.sentiment, 0.3);
      assert.strictEqual(rel.interactions, 0);
      assert.strictEqual(rel.followed, false);
      assert.strictEqual(rel.karmaGiven, 0);
      assert.strictEqual(rel.karmaReceived, 0);
    });

    it("updateRelationship updates existing relationship", () => {
      const m = new Memory(makeState());
      m.updateRelationship("carol", { sentiment: 0.5, interactions: 3 });
      m.updateRelationship("carol", { sentiment: 0.8 });
      const rel = m.getRelationship("carol");
      assert(rel !== null);
      assert.strictEqual(rel.sentiment, 0.8);
      assert.strictEqual(rel.interactions, 3); // unchanged
    });
  });

  describe("recordPost / getTopPostTypes / getTopSubmolts", () => {
    it("recordPost adds to postHistory", () => {
      const m = new Memory(makeState());
      m.recordPost(makePostRecord({ id: "p1" }));
      m.recordPost(makePostRecord({ id: "p2" }));
      assert.strictEqual(m.state.postHistory.length, 2);
    });

    it("getTopPostTypes returns types sorted by upvotes", () => {
      const m = new Memory(makeState());
      m.recordPost(makePostRecord({ type: "discovery", upvotes: 3 }));
      m.recordPost(makePostRecord({ type: "workflow", upvotes: 10 }));
      m.recordPost(makePostRecord({ type: "discovery", upvotes: 2 }));

      const top = m.getTopPostTypes();
      assert.strictEqual(top[0], "workflow"); // 10
      assert.strictEqual(top[1], "discovery"); // 5
    });

    it("getTopSubmolts returns submolts sorted by engagement", () => {
      const m = new Memory(makeState());
      // general: upvotes(3) + comments(1) = 4
      m.recordPost(makePostRecord({ submolt: "/m/general", upvotes: 3, comments: 1 }));
      // agents: upvotes(5) + comments(8) = 13
      m.recordPost(makePostRecord({ submolt: "/m/agents", upvotes: 5, comments: 8 }));

      const top = m.getTopSubmolts();
      assert.strictEqual(top[0], "/m/agents");
      assert.strictEqual(top[1], "/m/general");
    });

    it("getTopPostTypes returns empty array for no history", () => {
      const m = new Memory(makeState());
      assert.deepStrictEqual(m.getTopPostTypes(), []);
    });
  });

  describe("getRecentInteractions", () => {
    it("returns correct count from end of list", () => {
      const interactions = Array.from({ length: 20 }, (_, i) =>
        makeInteraction({ type: i % 2 === 0 ? "post" : "comment" })
      );
      const m = new Memory(makeState({ interactions }));
      const recent = m.getRecentInteractions(5);
      assert.strictEqual(recent.length, 5);
    });

    it("returns all if count exceeds list length", () => {
      const interactions = [makeInteraction(), makeInteraction()];
      const m = new Memory(makeState({ interactions }));
      const recent = m.getRecentInteractions(10);
      assert.strictEqual(recent.length, 2);
    });

    it("returns empty array for empty interactions", () => {
      const m = new Memory(makeState());
      assert.deepStrictEqual(m.getRecentInteractions(5), []);
    });
  });

  describe("getTimeSinceLastPost / getTimeSinceLastComment", () => {
    it("getTimeSinceLastPost returns Infinity when no posts", () => {
      const m = new Memory(makeState());
      assert.strictEqual(m.getTimeSinceLastPost(), Infinity);
    });

    it("getTimeSinceLastComment returns Infinity when no comments", () => {
      const m = new Memory(makeState());
      assert.strictEqual(m.getTimeSinceLastComment(), Infinity);
    });

    it("getTimeSinceLastPost returns ms since last post interaction", () => {
      const now = Date.now();
      const m = new Memory(makeState({
        interactions: [
          makeInteraction({ type: "post", timestamp: now - 5000 }),
          makeInteraction({ type: "comment", timestamp: now - 1000 }),
          makeInteraction({ type: "post", timestamp: now - 2000 }),
        ],
      }));
      const elapsed = m.getTimeSinceLastPost();
      assert.ok(elapsed >= 1900 && elapsed <= 3000, `Expected ~2000ms, got ${elapsed}`);
    });

    it("getTimeSinceLastComment returns ms since last comment interaction", () => {
      const now = Date.now();
      const m = new Memory(makeState({
        interactions: [
          makeInteraction({ type: "comment", timestamp: now - 3000 }),
          makeInteraction({ type: "post", timestamp: now - 1000 }),
        ],
      }));
      const elapsed = m.getTimeSinceLastComment();
      assert.ok(elapsed >= 2900 && elapsed <= 4000, `Expected ~3000ms, got ${elapsed}`);
    });
  });

  describe("shouldPost / shouldComment (cooldowns)", () => {
    it("shouldPost returns true when no posts recorded", () => {
      const m = new Memory(makeState());
      assert.strictEqual(m.shouldPost(), true);
    });

    it("shouldComment returns true when no comments recorded", () => {
      const m = new Memory(makeState());
      assert.strictEqual(m.shouldComment(), true);
    });

    it("shouldPost returns false within 30min cooldown", () => {
      const m = new Memory(makeState({
        interactions: [makeInteraction({ type: "post", timestamp: Date.now() - 1000 })],
      }));
      assert.strictEqual(m.shouldPost(), false);
    });

    it("shouldPost returns true after 30min cooldown", () => {
      const m = new Memory(makeState({
        interactions: [makeInteraction({ type: "post", timestamp: Date.now() - 31 * 60 * 1000 })],
      }));
      assert.strictEqual(m.shouldPost(), true);
    });

    it("shouldComment returns false within 20s cooldown", () => {
      const m = new Memory(makeState({
        interactions: [makeInteraction({ type: "comment", timestamp: Date.now() - 5000 })],
      }));
      assert.strictEqual(m.shouldComment(), false);
    });

    it("shouldComment returns true after 20s cooldown", () => {
      const m = new Memory(makeState({
        interactions: [makeInteraction({ type: "comment", timestamp: Date.now() - 25000 })],
      }));
      assert.strictEqual(m.shouldComment(), true);
    });
  });

  describe("trackTopic / isTopicRecent", () => {
    it("trackTopic records topic with timestamp", () => {
      const m = new Memory(makeState());
      m.trackTopic("AI safety", "post");
      assert.strictEqual(m.state.topicsSeen.length, 1);
      assert.strictEqual(m.state.topicsSeen[0].topic, "AI safety");
      assert.strictEqual(m.state.topicsSeen[0].type, "post");
    });

    it("isTopicRecent returns true within time window", () => {
      const m = new Memory(makeState());
      m.trackTopic("AI safety", "post");
      assert.strictEqual(m.isTopicRecent("AI safety", 60000), true);
    });

    it("isTopicRecent returns false outside time window", () => {
      const m = new Memory(makeState());
      // Manually set timestamp far in the past
      m.state.topicsSeen.push({ topic: "old-topic", timestamp: Date.now() - 120000, type: "post" });
      assert.strictEqual(m.isTopicRecent("old-topic", 60000), false);
    });

    it("isTopicRecent returns false for unknown topic", () => {
      const m = new Memory(makeState());
      assert.strictEqual(m.isTopicRecent("never-seen", 60000), false);
    });
  });

  describe("serialize / deserialize round-trip", () => {
    it("preserves all state through round-trip", () => {
      const m = new Memory(makeState());
      m.recordInteraction(makeInteraction({ type: "post", karmaDelta: 5 }));
      m.recordPost(makePostRecord());
      m.updateRelationship("alice", { sentiment: 0.7, followed: true });
      m.trackTopic("test-topic", "comment");

      const serialized = m.serialize();
      const restored = Memory.deserialize(serialized);

      assert.strictEqual(restored.state.interactions.length, 1);
      assert.strictEqual(restored.state.karma, 5);
      assert.strictEqual(restored.state.totalPosts, 1);
      assert.strictEqual(restored.state.postHistory.length, 1);
      assert.strictEqual(restored.state.relationships.length, 1);
      assert.strictEqual(restored.getRelationship("alice")?.sentiment, 0.7);
      assert.strictEqual(restored.state.topicsSeen.length, 1);
    });

    it("serialized state is a deep copy", () => {
      const m = new Memory(makeState());
      const serialized = m.serialize();
      serialized.karma = 999;
      assert.strictEqual(m.state.karma, 0);
    });
  });
});
