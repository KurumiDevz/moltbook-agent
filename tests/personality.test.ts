import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { Personality } from "../src/agent/personality.js";
import type { PersonalityState } from "../src/agent/types.js";

function makeState(overrides: Partial<PersonalityState> = {}): PersonalityState {
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

describe("Personality", () => {
  describe("construction", () => {
    it("constructs with provided state", () => {
      const state = makeState();
      const p = new Personality(state);
      assert.deepStrictEqual(p.state, state);
    });

    it("deserialize creates a deep copy (not same reference)", () => {
      const state = makeState();
      const p = Personality.deserialize(state);
      assert.deepStrictEqual(p.state, state);
      // Mutating original should not affect deserialized copy
      state.mood = "resting";
      assert.strictEqual(p.state.mood, "engaged");
    });
  });

  describe("getTraitWeight", () => {
    it("returns correct value for each trait", () => {
      const p = new Personality(makeState());
      assert.strictEqual(p.getTraitWeight("curiosity"), 0.7);
      assert.strictEqual(p.getTraitWeight("agreeableness"), 0.5);
      assert.strictEqual(p.getTraitWeight("confidence"), 0.6);
      assert.strictEqual(p.getTraitWeight("snark"), 0.3);
      assert.strictEqual(p.getTraitWeight("creativity"), 0.8);
    });

    it("handles extreme trait values (0 and 1)", () => {
      const state = makeState({
        traits: { curiosity: 0, agreeableness: 1, confidence: 0, snark: 1, creativity: 0 },
      });
      const p = new Personality(state);
      assert.strictEqual(p.getTraitWeight("curiosity"), 0);
      assert.strictEqual(p.getTraitWeight("agreeableness"), 1);
      assert.strictEqual(p.getTraitWeight("snark"), 1);
    });
  });

  describe("getValueAlignment", () => {
    it("returns 0.5 for empty values array", () => {
      const p = new Personality(makeState());
      assert.strictEqual(p.getValueAlignment([]), 0.5);
    });

    it("returns 1.0 when all values match", () => {
      const p = new Personality(makeState());
      assert.strictEqual(p.getValueAlignment(["security", "craft"]), 1.0);
    });

    it("returns 0 when no values match", () => {
      const p = new Personality(makeState());
      assert.strictEqual(p.getValueAlignment(["chaos", "destruction"]), 0);
    });

    it("returns partial score for mixed values", () => {
      const p = new Personality(makeState());
      // 1 of 3 matches
      const score = p.getValueAlignment(["security", "chaos", "noise"]);
      assert.strictEqual(score, 1 / 3);
    });
  });

  describe("shiftMood", () => {
    it("karma_gain shifts to engaged", () => {
      const p = new Personality(makeState({ mood: "resting" }));
      p.shiftMood("karma_gain");
      assert.strictEqual(p.state.mood, "engaged");
    });

    it("karma_loss shifts to contemplative", () => {
      const p = new Personality(makeState({ mood: "engaged" }));
      p.shiftMood("karma_loss");
      assert.strictEqual(p.state.mood, "contemplative");
    });

    it("good_post shifts to playful", () => {
      const p = new Personality(makeState({ mood: "resting" }));
      p.shiftMood("good_post");
      assert.strictEqual(p.state.mood, "playful");
    });

    it("time_pass shifts to resting", () => {
      const p = new Personality(makeState({ mood: "engaged" }));
      p.shiftMood("time_pass");
      assert.strictEqual(p.state.mood, "resting");
    });

    it("controversy shifts to critical", () => {
      const p = new Personality(makeState({ mood: "engaged" }));
      p.shiftMood("controversy");
      assert.strictEqual(p.state.mood, "critical");
    });

    it("does not shift when mood already matches target", () => {
      const p = new Personality(makeState({ mood: "engaged" }));
      p.shiftMood("karma_gain");
      // mood was already engaged, should remain engaged and not add to history
      assert.strictEqual(p.state.mood, "engaged");
      assert.strictEqual(p.state.moodHistory.length, 0);
    });

    it("does not crash on unknown trigger", () => {
      const p = new Personality(makeState());
      // @ts-expect-error testing unknown trigger
      p.shiftMood("unknown_trigger");
      assert.strictEqual(p.state.mood, "engaged");
    });

    it("records mood in history and trims at 50", () => {
      const history = Array.from({ length: 50 }, (_, i) => ({
        mood: "resting" as const,
        timestamp: i,
      }));
      const p = new Personality(makeState({ mood: "resting", moodHistory: history }));
      // Shift to engaged (from resting, karma_gain)
      p.shiftMood("karma_gain");
      assert.strictEqual(p.state.mood, "engaged");
      assert.strictEqual(p.state.moodHistory.length, 50); // trimmed oldest, added new
    });
  });

  describe("formOpinion / getOpinion", () => {
    it("creates a new opinion", () => {
      const p = new Personality(makeState());
      p.formOpinion("agent-alice", 0.8);

      const op = p.getOpinion("agent-alice");
      assert(op !== null);
      assert.strictEqual(op.subject, "agent-alice");
      assert.strictEqual(op.interactions, 1);
      assert.strictEqual(op.confidence, 0.1);
      // sentiment should be close to 0.8 (clamped)
      assert.ok(Math.abs(op.sentiment - 0.8) < 0.001);
    });

    it("updates opinion with weighted average on subsequent calls", () => {
      const p = new Personality(makeState());
      p.formOpinion("topic-ai", 0.9);
      p.formOpinion("topic-ai", 0.3);

      const op = p.getOpinion("topic-ai");
      assert(op !== null);
      assert.strictEqual(op.interactions, 2);
      // sentiment = (0.9*1 + 0.3) / 2 = 0.6
      assert.ok(Math.abs(op.sentiment - 0.6) < 0.001);
      // confidence = 2/10 = 0.2
      assert.ok(Math.abs(op.confidence - 0.2) < 0.001);
    });

    it("clamps sentiment to [-1, 1]", () => {
      const p = new Personality(makeState());
      p.formOpinion("extreme-topic", 5.0);
      const op = p.getOpinion("extreme-topic");
      assert(op !== null);
      assert.strictEqual(op.sentiment, 1);
    });

    it("getOpinion returns null for unknown subject", () => {
      const p = new Personality(makeState());
      assert.strictEqual(p.getOpinion("nonexistent"), null);
    });
  });

  describe("shouldEngage", () => {
    it("returns a boolean", () => {
      const p = new Personality(makeState());
      const result = p.shouldEngage("topic-test", ["security"]);
      assert.strictEqual(typeof result, "boolean");
    });

    it("tends to return true when values align well", () => {
      const p = new Personality(makeState({ traits: { ...makeState().traits, curiosity: 1.0 } }));
      let trueCount = 0;
      for (let i = 0; i < 100; i++) {
        if (p.shouldEngage("topic", ["security", "craft", "honesty"])) trueCount++;
      }
      // With high alignment + high curiosity, should engage majority of the time
      assert.ok(trueCount > 50, `Expected >50 true, got ${trueCount}`);
    });

    it("tends to return false when values don't align", () => {
      const p = new Personality(makeState({
        traits: { curiosity: 0.1, agreeableness: 0.1, confidence: 0.1, snark: 0.1, creativity: 0.1 },
      }));
      let trueCount = 0;
      for (let i = 0; i < 100; i++) {
        if (p.shouldEngage("topic", ["chaos", "destruction"])) trueCount++;
      }
      assert.ok(trueCount < 60, `Expected <60 true, got ${trueCount}`);
    });
  });

  describe("getMoodDescription", () => {
    it("returns human-readable string for each mood", () => {
      const moods = ["engaged", "contemplative", "critical", "playful", "resting"] as const;
      for (const mood of moods) {
        const p = new Personality(makeState({ mood }));
        const desc = p.getMoodDescription();
        assert.strictEqual(typeof desc, "string");
        assert.ok(desc.length > 5, `Description for ${mood} is too short`);
      }
    });

    it("returns known description for engaged", () => {
      const p = new Personality(makeState({ mood: "engaged" }));
      assert.strictEqual(p.getMoodDescription(), "Eager to explore and participate");
    });
  });

  describe("serialize / deserialize round-trip", () => {
    it("preserves all state through serialize -> deserialize", () => {
      const state = makeState();
      const p = new Personality(state);
      p.formOpinion("test-subject", 0.7);
      p.formOpinion("other-subject", -0.3);

      const serialized = p.serialize();
      const restored = Personality.deserialize(serialized);

      assert.deepStrictEqual(restored.state.traits, state.traits);
      assert.deepStrictEqual(restored.state.values, state.values);
      assert.strictEqual(restored.state.mood, state.mood);
      assert.strictEqual(restored.state.opinions.length, 2);
      assert.strictEqual(restored.state.opinions[0].subject, "test-subject");
      assert.deepStrictEqual(restored.state.ego, state.ego);
    });

    it("serialized state is a deep copy", () => {
      const p = new Personality(makeState());
      const serialized = p.serialize();
      serialized.mood = "resting";
      assert.strictEqual(p.state.mood, "engaged");
    });
  });
});
