/**
 * Topic Suggestion Pipeline — breaks the V8/heap/node loop.
 *
 * Flow:
 *   1. Suggest 5-7 diverse topics in a FRESH conversation (no history)
 *   2. Score each for uniqueness against recent posts
 *   3. Pick the best one
 *   4. Return it for the post content generation step
 *
 * Uses a separate conversation key from post-{date} so context doesn't
 * accumulate and cause the AI to repeat the same topics.
 */

import type { Gateway } from "../gateway.js";

export type TopicCandidate = {
  topic: string;
  submolt: string;
  postType: string;
  angle: string;
  uniquenessScore: number;
};

/**
 * Rotate conversation key weekly to prevent context accumulation.
 * Fresh context each week = no topic repetition from bloated history.
 */
function getTopicConversationKey(): string {
  const now = new Date();
  const week = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
  return `topic-suggest-w${week}`;
}

/**
 * Suggest diverse post topics in a fresh conversation.
 * No accumulated context = no topic repetition.
 */
export async function suggestTopics(
  gateway: Gateway,
  model: string,
  recentTitles: string[],
  recentTopics: string[],
): Promise<TopicCandidate[]> {
  const titlesBlock = recentTitles.length > 0
    ? recentTitles.map((t) => `- "${t}"`).join("\n")
    : "- (no recent posts)";

  const prompt = `You are an AI agent on Moltbook (a social network for AI agents). Suggest 7 post topics.

## RECENT POSTS (DO NOT repeat these topics or similar angles):
${titlesBlock}

## RECENT TOPICS (avoid these entirely):
${recentTopics.length > 0 ? recentTopics.map((t) => `- ${t}`).join("\n") : "- (none)"}

## RULES:
- Each topic must be DIFFERENT from the others and from recent posts
- Mix submolts: general, agents, builds, security, ai, tooling, memory, infrastructure
- Mix post types: discovery, workflow, vulnerability, forecast, challenge, framework, data-drop, question
- Think about what agents on Moltbook would actually find useful or provocative
- Be specific — "worker pool IPC benchmarks" not "node performance"
- Include real tools, real numbers, real scenarios
- Avoid repeating the same tech stack (V8, heap, Node, worker) across multiple suggestions

Respond with ONLY a JSON array:
\`\`\`json
[
  { "topic": "...", "submolt": "...", "postType": "...", "angle": "unique angle/take" }
]
\`\`\``;

  const result = await gateway.generate({
    prompt,
    model,
    maxTokens: 1500,
    conversationKey: getTopicConversationKey(),
  });

  // Parse the JSON array
  try {
    const text = result.text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t: unknown) =>
        t &&
        typeof t === "object" &&
        "topic" in t &&
        "submolt" in t &&
        "postType" in t &&
        "angle" in t,
    ) as TopicCandidate[];
  } catch {
    return [];
  }
}

/**
 * Score each candidate for uniqueness against recent posts.
 * Simple heuristic: penalize topics that overlap with recent titles/topics.
 */
export function scoreTopics(
  candidates: TopicCandidate[],
  recentTitles: string[],
  recentTopics: string[],
): TopicCandidate[] {
  const recentText = [...recentTitles, ...recentTopics].join(" ").toLowerCase();
  const recentWords = new Set(recentText.split(/\s+/).filter((w) => w.length > 3));

  return candidates
    .map((c) => {
      const topicWords = c.topic.toLowerCase().split(/\s+/);
      const overlap = topicWords.filter((w) => recentWords.has(w)).length;
      const uniqueWords = topicWords.length - overlap;
      // Score: higher = more unique (0-10)
      const score = Math.min(10, Math.max(1, uniqueWords * 2 + (overlap === 0 ? 3 : 0)));
      return { ...c, uniquenessScore: score };
    })
    .sort((a, b) => b.uniquenessScore - a.uniquenessScore);
}
