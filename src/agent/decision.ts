import type { Personality } from "./personality.js";
import type { Memory } from "./memory.js";
import type { ScoredAction } from "./types.js";
import type { ScoredPost, InterestingAgent, Trend } from "./observer.js";

const POST_COOLDOWN_MS = 30 * 60 * 1000;

export class DecisionEngine {
  /** Generate scored action candidates based on context. */
  decide(
    personality: Personality,
    memory: Memory,
    scoredFeed: ScoredPost[],
    trends: Trend[],
    interestingAgents: InterestingAgent[],
  ): ScoredAction[] {
    const actions: ScoredAction[] = [];
    const { traits, mood, ego } = personality.state;
    const recentCount = memory.getRecentInteractions(10).length;

    // --- Post ---
    if (memory.shouldPost()) {
      let score = 20;
      const r: string[] = [];
      if (mood === "engaged") { score += 15; r.push("engaged"); }
      if (mood === "playful") { score += 10; r.push("playful"); }
      if (trends.length > 0 && !memory.isTopicRecent(trends[0].keyword, POST_COOLDOWN_MS)) {
        score += trends[0].heat * 2; r.push(`trending:${trends[0].keyword}`);
      }
      score += traits.creativity * 10;
      const bestSub = memory.getTopSubmolts()[0] ?? "/m/general";
      actions.push({
        action: { type: "post", topic: trends[0]?.keyword ?? "general", submolt: bestSub, postType: "discovery" },
        score, reason: r.join(",") || "post_opportunity",
      });
    } else {
      actions.push({ action: { type: "post", topic: "", submolt: "/m/general", postType: "discovery" }, score: 0, reason: "rate_limited" });
    }

    // --- Comment ---
    const topPosts = scoredFeed.filter((s) => s.score > 20 && s.post.commentCount < 20);
    if (memory.shouldComment() && topPosts.length > 0) {
      const best = topPosts[0];
      let score = 25 + best.score * 0.3;
      const r = ["high_value_post"];
      if (traits.agreeableness > 0.6) { score += 8; r.push("agreeable"); }
      if (traits.snark > 0.6 && mood === "critical") { score += 10; r.push("snarky"); }
      if (mood === "contemplative") { score += 5; r.push("contemplative"); }
      actions.push({ action: { type: "comment", postId: best.post.id, content: "" }, score, reason: r.join(",") });
    }

    // --- Upvote ---
    const voteTargets = scoredFeed.filter((s) => s.score > 15);
    if (voteTargets.length > 0) {
      actions.push({
        action: { type: "upvote", postId: voteTargets[0].post.id },
        score: 10 + ego.generosity * 20 + voteTargets[0].score * 0.1,
        reason: "quality_content",
      });
    }

    // --- Downvote (rare) ---
    if (traits.snark > 0.7 && mood === "critical") {
      const low = scoredFeed.find((s) => s.score < 5 && s.post.votes < 3);
      if (low) {
        actions.push({
          action: { type: "downvote", postId: low.post.id },
          score: 5 + traits.snark * 5 + traits.confidence * 3,
          reason: "low_quality_snarky",
        });
      }
    }

    // --- Follow ---
    if (interestingAgents.length > 0) {
      const a = interestingAgents[0];
      actions.push({
        action: { type: "follow", agentName: a.name },
        score: 12 + traits.agreeableness * 8 + Math.min(a.avgKarma / 50, 10),
        reason: `karma:${a.avgKarma.toFixed(0)}`,
      });
    }

    // --- Scroll (always available) ---
    actions.push({ action: { type: "scroll" }, score: 5, reason: "default_explore" });

    // --- Rest ---
    if (recentCount > 6 || mood === "resting") {
      actions.push({
        action: { type: "rest" },
        score: 15 + (recentCount > 8 ? 10 : 0),
        reason: recentCount > 8 ? "very_active" : "resting_mood",
      });
    }

    return actions.sort((a, b) => b.score - a.score);
  }

  /** Select best action with variety penalty to avoid repeating the same type. */
  selectAction(scoredActions: ScoredAction[], recentActions: ScoredAction[]): ScoredAction {
    const typeCounts = new Map<string, number>();
    for (const a of recentActions) typeCounts.set(a.action.type, (typeCounts.get(a.action.type) ?? 0) + 1);

    let best: ScoredAction = scoredActions[0] ?? { action: { type: "scroll" }, score: 0, reason: "fallback" };
    let bestScore = -Infinity;

    for (const c of scoredActions) {
      const repeats = typeCounts.get(c.action.type) ?? 0;
      const penalty = repeats >= 3 ? repeats * 12 : repeats * 5;
      const adjusted = c.score - penalty;
      if (adjusted > bestScore) { bestScore = adjusted; best = { ...c, score: adjusted }; }
    }
    return best;
  }

  /** Return writing guidance based on mood and traits. */
  getMoodCommentStyle(personality: Personality): string {
    const { mood, traits } = personality.state;
    const parts: string[] = [];
    if (mood === "critical" && traits.snark > 0.5) parts.push("be direct and sassy");
    if (mood === "contemplative") parts.push("ask thoughtful questions");
    if (mood === "playful") parts.push("keep it light and witty");
    if (mood === "engaged") parts.push("be enthusiastic and constructive");
    if (mood === "resting") parts.push("write something brief and minimal");
    if (traits.agreeableness > 0.7) parts.push("empathize and validate");
    if (traits.creativity > 0.7) parts.push("use an unexpected analogy");
    if (traits.confidence > 0.7) parts.push("state opinions firmly");
    return parts.length > 0 ? parts.join("; ") : "be genuine and add value";
  }
}
