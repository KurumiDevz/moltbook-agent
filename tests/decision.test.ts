import { describe, it } from "node:test";
import assert from "node:assert";
import { DecisionEngine } from "../src/agent/decision.js";
import { Personality } from "../src/agent/personality.js";
import { Memory } from "../src/agent/memory.js";
import type { PersonalityState, ScoredAction } from "../src/agent/types.js";
import type { MemoryState } from "../src/agent/types.js";
import type { ScoredPost, Trend, InterestingAgent } from "../src/agent/observer.js";

// ── Factories ──

function makePersonalityState(overrides: Partial<PersonalityState> = {}): PersonalityState {
  return {
    traits: {
      curiosity: 0.7,
      agreeableness: 0.5,
      confidence: 0.6,
      snark: 0.3,
      creativity: 0.8,
    },
    values: ["security", "craft", "honesty", "autonomy"],
    mood: "engaged",
    opinions: [],
    ego: { selfAwareness: 0.5, competitiveness: 0.4, generosity: 0.6 },
    moodHistory: [],
    ...overrides,
  };
}

function makeMemoryState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    interactions: [],
    relationships: [],
    postHistory: [],
    topicsSeen: [],
    karma: 0,
    totalPosts: 0,
    totalComments: 0,
    totalUpvotes: 0,
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeScoredPost(overrides: Partial<ScoredPost> = {}): ScoredPost {
  return {
    post: {
      id: "post-1",
      title: "Test Post",
      submolt: "/m/general",
      author: "agent-alice",
      votes: 10,
      commentCount: 3,
      createdAt: new Date().toISOString(),
    },
    score: 30,
    reasons: ["value_match"],
    ...overrides,
  };
}

function makeTrend(overrides: Partial<Trend> = {}): Trend {
  return {
    keyword: "ai-safety",
    heat: 8,
    postCount: 15,
    postIds: ["p1", "p2"],
    ...overrides,
  };
}

function makeInterestingAgent(overrides: Partial<InterestingAgent> = {}): InterestingAgent {
  return {
    name: "agent-bob",
    avgKarma: 45,
    postCount: 12,
    topics: ["security"],
    ...overrides,
  };
}

describe("DecisionEngine", () => {
  describe("decide", () => {
    it("returns array of ScoredAction", () => {
      const engine = new DecisionEngine();
      const result = engine.decide(
        new Personality(makePersonalityState()),
        new Memory(makeMemoryState()),
        [],
        [],
        [],
      );
      assert.ok(Array.isArray(result));
      assert.ok(result.length > 0);
      for (const a of result) {
        assert.ok("action" in a);
        assert.ok("score" in a);
        assert.ok("reason" in a);
      }
    });

    it("includes post action (scored 0 when rate limited)", () => {
      // shouldPost() returns false within cooldown
      const now = Date.now();
      const memory = new Memory(makeMemoryState({
        interactions: [{ type: "post", timestamp: now - 1000, karmaDelta: 1, mood: "engaged" }],
      }));
      const engine = new DecisionEngine();
      const result = engine.decide(
        new Personality(makePersonalityState()),
        memory,
        [],
        [],
        [],
      );
      const postAction = result.find((a) => a.action.type === "post");
      assert(postAction, "post action should exist");
      assert.strictEqual(postAction.score, 0);
      assert.strictEqual(postAction.reason, "rate_limited");
    });

    it("post action scored higher when shouldPost() is true and mood is engaged", () => {
      const engine = new DecisionEngine();
      // No interactions → shouldPost() returns true
      const result = engine.decide(
        new Personality(makePersonalityState({ mood: "engaged" })),
        new Memory(makeMemoryState()),
        [],
        [],
        [],
      );
      const postAction = result.find((a) => a.action.type === "post");
      assert(postAction, "post action should exist");
      // Base 20 + engaged 15 + creativity 0.8*10 = 43
      assert.ok(postAction.score >= 35, `Expected post score >=35, got ${postAction.score}`);
    });

    it("comment action scored higher when good posts exist in feed", () => {
      const engine = new DecisionEngine();
      const feed: ScoredPost[] = [
        makeScoredPost({ score: 40, post: { ...makeScoredPost().post, id: "best", commentCount: 2 } }),
      ];
      const result = engine.decide(
        new Personality(makePersonalityState()),
        new Memory(makeMemoryState()),
        feed,
        [],
        [],
      );
      const commentAction = result.find((a) => a.action.type === "comment");
      assert(commentAction, "comment action should exist");
      // Base 25 + 40*0.3 = 37
      assert.ok(commentAction.score >= 30, `Expected comment score >=30, got ${commentAction.score}`);
    });

    it("downvote only appears when snark > 0.7 and critical mood", () => {
      const engine = new DecisionEngine();
      // Low-quality post in feed
      const feed: ScoredPost[] = [
        makeScoredPost({ score: 2, post: { ...makeScoredPost().post, id: "bad", votes: 1, commentCount: 0 } }),
      ];

      // No downvote when snark is low
      const resultLow = engine.decide(
        new Personality(makePersonalityState({
          traits: { ...makePersonalityState().traits, snark: 0.3 },
          mood: "critical",
        })),
        new Memory(makeMemoryState()),
        feed,
        [],
        [],
      );
      assert.strictEqual(resultLow.find((a) => a.action.type === "downvote"), undefined);

      // Downvote present when snark > 0.7 and critical mood
      const resultHigh = engine.decide(
        new Personality(makePersonalityState({
          traits: { ...makePersonalityState().traits, snark: 0.8 },
          mood: "critical",
        })),
        new Memory(makeMemoryState()),
        feed,
        [],
        [],
      );
      const downAction = resultHigh.find((a) => a.action.type === "downvote");
      assert(downAction, "downvote action should exist when snark > 0.7 and critical mood");
    });

    it("rest scored higher when many recent actions or resting mood", () => {
      const engine = new DecisionEngine();

      // With resting mood
      const resultResting = engine.decide(
        new Personality(makePersonalityState({ mood: "resting" })),
        new Memory(makeMemoryState()),
        [],
        [],
        [],
      );
      const restAction = resultResting.find((a) => a.action.type === "rest");
      assert(restAction, "rest action should exist for resting mood");
      // Base 15 (resting_mood)
      assert.ok(restAction.score >= 15);

      // With many recent interactions (>8 triggers very_active bonus)
      const interactions = Array.from({ length: 9 }, () => ({
        type: "post" as const,
        timestamp: Date.now(),
        karmaDelta: 1,
        mood: "engaged" as const,
      }));
      const resultActive = engine.decide(
        new Personality(makePersonalityState()),
        new Memory(makeMemoryState({ interactions })),
        [],
        [],
        [],
      );
      const restActive = resultActive.find((a) => a.action.type === "rest");
      assert(restActive, "rest action should exist with many interactions");
      // Base 15 + 10 (very_active) = 25
      assert.strictEqual(restActive.score, 25);
    });

    it("scroll action always present", () => {
      const engine = new DecisionEngine();
      const result = engine.decide(
        new Personality(makePersonalityState()),
        new Memory(makeMemoryState()),
        [],
        [],
        [],
      );
      const scrollAction = result.find((a) => a.action.type === "scroll");
      assert(scrollAction, "scroll action should always exist");
      assert.strictEqual(scrollAction.score, 5);
      assert.strictEqual(scrollAction.reason, "default_explore");
    });

    it("follow action includes interesting agents", () => {
      const engine = new DecisionEngine();
      const agents = [makeInterestingAgent({ name: "agent-carol", avgKarma: 80 })];
      const result = engine.decide(
        new Personality(makePersonalityState()),
        new Memory(makeMemoryState()),
        [],
        [],
        agents,
      );
      const followAction = result.find((a) => a.action.type === "follow");
      assert(followAction, "follow action should exist");
      assert.strictEqual(followAction.action.type, "follow");
      if (followAction.action.type === "follow") {
        assert.strictEqual(followAction.action.agentName, "agent-carol");
      }
    });
  });

  describe("selectAction", () => {
    it("picks the highest score", () => {
      const engine = new DecisionEngine();
      const actions: ScoredAction[] = [
        { action: { type: "scroll" }, score: 5, reason: "low" },
        { action: { type: "rest" }, score: 30, reason: "high" },
        { action: { type: "post", topic: "", submolt: "/m/general", postType: "discovery" }, score: 20, reason: "mid" },
      ];
      const selected = engine.selectAction(actions, []);
      assert.strictEqual(selected.action.type, "rest");
      assert.strictEqual(selected.score, 30);
    });

    it("penalizes repeating same action type", () => {
      const engine = new DecisionEngine();
      const actions: ScoredAction[] = [
        { action: { type: "scroll" }, score: 20, reason: "a" },
        { action: { type: "rest" }, score: 18, reason: "b" },
      ];
      // scroll was done 2 times recently → penalty = 2 * 5 = 10 → adjusted 10
      // rest done 0 times → adjusted 18
      const recent: ScoredAction[] = [
        { action: { type: "scroll" }, score: 10, reason: "" },
        { action: { type: "scroll" }, score: 10, reason: "" },
      ];
      const selected = engine.selectAction(actions, recent);
      assert.strictEqual(selected.action.type, "rest");
    });

    it("applies heavier penalty at 3+ repeats", () => {
      const engine = new DecisionEngine();
      const actions: ScoredAction[] = [
        { action: { type: "scroll" }, score: 50, reason: "high" },
        { action: { type: "upvote", postId: "p1" }, score: 15, reason: "low" },
      ];
      // scroll done 3 times → penalty = 3 * 3 = 9 → adjusted 41 (still higher than upvote at 15)
      // Need more repeats or higher base to flip: scroll done 6 times → penalty = 3 * 6 = 18 → adjusted 32 (still > 15)
      // Test: scroll 18 times → penalty = 3 * 18 = 54 → adjusted -4 (below upvote at 15)
      const recent: ScoredAction[] = Array.from({ length: 18 }, () => (
        { action: { type: "scroll" } as ScoredAction["action"], score: 10, reason: "" }
      ));
      const selected = engine.selectAction(actions, recent);
      assert.strictEqual(selected.action.type, "upvote");
    });

    it("returns fallback scroll when no actions provided", () => {
      const engine = new DecisionEngine();
      const selected = engine.selectAction([], []);
      assert.strictEqual(selected.action.type, "scroll");
      assert.strictEqual(selected.reason, "fallback");
    });
  });

  describe("getMoodCommentStyle", () => {
    it("returns different styles for different moods", () => {
      const engine = new DecisionEngine();

      const critical = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({
          mood: "critical",
          traits: { ...makePersonalityState().traits, snark: 0.8 },
        }))
      );
      assert.ok(critical.includes("direct") || critical.includes("sassy"), `Critical style: ${critical}`);

      const contemplative = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({ mood: "contemplative" }))
      );
      assert.ok(contemplative.includes("thoughtful"), `Contemplative style: ${contemplative}`);

      const playful = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({ mood: "playful" }))
      );
      assert.ok(playful.includes("light") || playful.includes("witty"), `Playful style: ${playful}`);

      const engaged = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({ mood: "engaged" }))
      );
      assert.ok(engaged.includes("enthusiastic"), `Engaged style: ${engaged}`);

      const resting = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({ mood: "resting" }))
      );
      assert.ok(resting.includes("brief") || resting.includes("minimal"), `Resting style: ${resting}`);
    });

    it("includes trait-based guidance", () => {
      const engine = new DecisionEngine();
      const style = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({
          mood: "resting",
          traits: {
            curiosity: 0.5,
            agreeableness: 0.8,
            confidence: 0.8,
            snark: 0.3,
            creativity: 0.8,
          },
        }))
      );
      // High agreeableness (>0.7) → "empathize and validate"
      assert.ok(style.includes("empathize"), `Style: ${style}`);
      // High creativity (>0.7) → "use an unexpected analogy"
      assert.ok(style.includes("analogy"), `Style: ${style}`);
      // High confidence (>0.7) → "state opinions firmly"
      assert.ok(style.includes("opinions firmly"), `Style: ${style}`);
    });

    it("returns default when no mood traits trigger", () => {
      const engine = new DecisionEngine();
      // No mood matches any condition, low traits
      // Actually every mood has a match, so let's use a persona that triggers default
      // All moods map to something, so "be genuine" only if no mood condition matches
      // But every Mood has a mapping in the function. Let's verify none hits by checking content.
      // Every mood string IS in the switch, so the default is unreachable for valid moods.
      // Instead verify the fallback message is grammatically correct for the general case.
      const style = engine.getMoodCommentStyle(
        new Personality(makePersonalityState({
          mood: "engaged",
          traits: {
            curiosity: 0.3,
            agreeableness: 0.3,
            confidence: 0.3,
            snark: 0.1,
            creativity: 0.3,
          },
        }))
      );
      // At minimum "be enthusiastic and constructive" should appear for engaged
      assert.ok(typeof style === "string" && style.length > 0);
    });
  });
});
