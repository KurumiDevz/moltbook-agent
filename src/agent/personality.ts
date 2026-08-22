import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mood, Opinion, PersonalityState, Traits } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PATH = join(__dirname, "data", "personality.json");

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const MOOD_EFFECTS: Record<string, Partial<Record<Mood, number>>> = {
  karma_gain: { engaged: 0.3 },
  karma_loss: { contemplative: 0.3, critical: 0.2 },
  good_post: { playful: 0.3 },
  bad_post: { contemplative: 0.2 },
  time_pass: { resting: 0.5 },
  controversy: { critical: 0.4 },
};

export class Personality {
  state: PersonalityState;

  constructor(state: PersonalityState) {
    this.state = state;
  }

  static default(): Personality {
    try {
      const raw = readFileSync(DEFAULT_PATH, "utf-8");
      return Personality.deserialize(JSON.parse(raw));
    } catch {
      // File missing on fresh deploy — create with hardcoded defaults
      return Personality.deserialize({
        traits: { curiosity: 0.8, agreeableness: 0.5, confidence: 0.7, snark: 0.3, creativity: 0.6 },
        values: ["security", "craft", "honesty", "autonomy"],
        mood: "engaged" as Mood,
        moodHistory: [],
        ego: { selfAwareness: 0.7, competitiveness: 0.5, generosity: 0.6 },
        opinions: [],
      });
    }
  }

  static fromFile(path: string): Personality {
    const raw = readFileSync(path, "utf-8");
    return Personality.deserialize(JSON.parse(raw));
  }

  saveFile(path: string): void {
    writeFileSync(path, JSON.stringify(this.state, null, 2), "utf-8");
  }

  getTraitWeight(trait: keyof Traits): number {
    return this.state.traits[trait];
  }

  getValueAlignment(values: string[]): number {
    if (values.length === 0) return 0.5;
    const mine = new Set(this.state.values);
    const matches = values.filter((v) => mine.has(v)).length;
    return matches / values.length;
  }

  shiftMood(trigger: "karma_gain" | "karma_loss" | "good_post" | "bad_post" | "time_pass" | "controversy"): void {
    const effects = MOOD_EFFECTS[trigger];
    if (!effects) return;
    let bestMood: Mood = this.state.mood;
    let bestDelta = 0;
    for (const [mood, delta] of Object.entries(effects) as [Mood, number][]) {
      if (delta > bestDelta) {
        bestMood = mood;
        bestDelta = delta;
      }
    }
    if (bestDelta > 0 && bestMood !== this.state.mood) {
      this.state.mood = bestMood;
      this.state.moodHistory.push({ mood: bestMood, timestamp: Date.now() });
      if (this.state.moodHistory.length > 50) this.state.moodHistory.shift();
    }
  }

  formOpinion(subject: string, sentiment: number): void {
    const existing = this.state.opinions.find((o) => o.subject === subject);
    if (existing) {
      const total = existing.interactions + 1;
      existing.sentiment = (existing.sentiment * existing.interactions + clamp(sentiment, -1, 1)) / total;
      existing.confidence = clamp(total / 10, 0, 1);
      existing.interactions = total;
      existing.lastSeen = Date.now();
    } else {
      this.state.opinions.push({
        subject,
        sentiment: clamp(sentiment, -1, 1),
        confidence: 0.1,
        interactions: 1,
        lastSeen: Date.now(),
      });
    }
  }

  getOpinion(subject: string): Opinion | null {
    return this.state.opinions.find((o) => o.subject === subject) ?? null;
  }

  shouldEngage(topic: string, values: string[]): boolean {
    const alignment = this.getValueAlignment(values);
    const curiosityBias = this.state.traits.curiosity * 0.3;
    const threshold = 0.3 + alignment * 0.4 - curiosityBias;
    return Math.random() < clamp(threshold + alignment * 0.3, 0.1, 0.95);
  }

  getMoodDescription(): string {
    const m: Mood = this.state.mood;
    const descs: Record<Mood, string> = {
      engaged: "Eager to explore and participate",
      contemplative: "Thinking deeply about what to say",
      critical: "Analyzing everything with a skeptical eye",
      playful: "Ready to have fun with the conversation",
      resting: "Low energy, observing but not acting",
    };
    return descs[m];
  }

  serialize(): PersonalityState {
    return JSON.parse(JSON.stringify(this.state));
  }

  static deserialize(state: PersonalityState): Personality {
    return new Personality(JSON.parse(JSON.stringify(state)));
  }
}
