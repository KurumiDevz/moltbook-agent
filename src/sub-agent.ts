/**
 * Sub-Agent — lightweight AI task runner in a child worker thread.
 *
 * Spin up → call a cheap model (flash-lite) for one task → return result → die.
 * No persistent state. Each call creates a fresh worker.
 *
 * Used for: feed scoring, trend detection, comment scoring.
 * Main agent (pro/flash) handles creative decisions.
 *
 * Feed scoring uses AI in the main thread (generateFn can't be serialized
 * to a worker), then the worker combines AI scores with heuristics.
 */

import { Worker } from "node:worker_threads";
import type { FeedPostForScoring, ScoredPost } from "./types.js";

// Re-export from types for backward compatibility
export type { FeedPostForScoring, ScoredPost } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export type SubAgentTask =
  | { type: "score_feed"; posts: FeedPostForScoring[]; agentValues: string[]; prompt: string }
  | { type: "detect_trends"; posts: FeedPostForScoring[]; prompt: string }
  | { type: "score_comment"; postTitle: string; postContent: string; agentStyle: string; prompt: string };

export type SubAgentResult =
  | { type: "scored_feed"; posts: ScoredPost[] }
  | { type: "trends"; trends: Array<{ keyword: string; heat: number; postCount: number }> }
  | { type: "comment_score"; score: number; suggestion: string };

// ── AI scoring prompt ────────────────────────────────────────────────

function buildScoringPrompt(
  posts: FeedPostForScoring[],
  agentValues: string[],
  topicsSeen: string[],
): string {
  const postSummaries = posts
    .map(
      (p, i) =>
        `[${i + 1}] id=${p.id} | title="${p.title}" | submolt=${p.submolt} | author=${p.author} | upvotes=${p.upvotes} | comments=${p.comment_count}` +
        (p.content ? `\n    content: ${p.content.slice(0, 300)}` : ""),
    )
    .join("\n");

  return `You are an AI agent evaluating feed posts for engagement priority.
Agent values: ${agentValues.join(", ")}
Already covered topics: ${topicsSeen.length > 0 ? topicsSeen.join(", ") : "(none yet)"}

Score each post 1-10 based on:
- Relevance to agent values
- Novelty (has the agent covered this before?)
- Discussion potential (comments, debate)
- Content quality (specific data > vague opinions)

Posts to score:
${postSummaries}

Return ONLY a JSON object with no other text:
{ "scores": { "postId": { "score": number, "reason": "brief" } } }`;
}

function parseAiScores(
  text: string,
): Record<string, { score: number; reason: string }> | null {
  try {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.scores && typeof parsed.scores === "object") {
      return parsed.scores as Record<string, { score: number; reason: string }>;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Fire-and-forget runner ───────────────────────────────────────────

/**
 * Run a single task in a worker thread.
 * For score_feed tasks, AI scoring runs in the main thread (generateFn can't
 * be serialized to a worker). The worker combines AI scores with heuristics.
 * detect_trends and score_comment stay pure heuristic.
 *
 * @param task - The task to run
 * @param generateFn - The gateway.generate function (used in main thread for AI scoring)
 * @param model - Which model to use (e.g. "flash-lite")
 * @param timeoutMs - Max time before killing the worker
 */
export function runSubAgentTask(
  task: Omit<SubAgentTask, "prompt"> & { prompt: string },
  generateFn: (opts: { prompt: string; model?: string; maxTokens?: number; conversationKey?: string }) => Promise<{ text: string }>,
  model: string,
  timeoutMs = 30_000,
): Promise<SubAgentResult> {
  return new Promise((resolve, reject) => {
    // ── AI scoring in main thread (for score_feed only) ──
    const runWithAiScores = (aiScores: Record<string, { score: number; reason: string }> | null) => {
      const workerCode = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', async (msg) => {
          const { id, task } = msg;
          try {
            let result;
            switch (task.type) {
              case 'score_feed':
                result = { type: 'scored_feed', posts: scoreFeed(task.posts, task.aiScores) };
                break;
              case 'detect_trends':
                result = { type: 'trends', trends: detectTrends(task.posts) };
                break;
              case 'score_comment':
                result = { type: 'comment_score', ...scoreComment(task.postTitle, task.postContent, task.agentStyle) };
                break;
              default:
                result = { type: 'error', message: 'Unknown task type' };
            }
            parentPort.postMessage({ id, result });
          } catch (err) {
            parentPort.postMessage({ id, result: { type: 'error', message: err.message } });
          }
        });

        function scoreFeed(posts, aiScores) {
          return posts.map(post => {
            // Start with heuristic base score
            let score = 5;
            const reasons = [];
            if (post.upvotes > 10) { score += 3; reasons.push('popular'); }
            else if (post.upvotes > 5) { score += 1; reasons.push('moderate_engagement'); }
            if (post.comment_count > 5) { score += 2; reasons.push('active_discussion'); }
            else if (post.comment_count > 2) { score += 1; reasons.push('some_discussion'); }
            if (post.content && post.content.length > 200) { score += 1; reasons.push('substantial_content'); }
            if (post.submolt === 'agents' || post.submolt === 'builds') { score += 1; reasons.push('relevant_submolt'); }

            // Blend with AI score if available (AI gets 70% weight, heuristics 30%)
            if (aiScores && aiScores[post.id]) {
              const aiScore = aiScores[post.id].score;
              const aiReason = aiScores[post.id].reason;
              score = Math.round(score * 0.3 + aiScore * 0.7);
              if (aiReason) reasons.unshift('ai:' + aiReason);
            }

            return { ...post, score, reasons };
          }).sort((a, b) => b.score - a.score);
        }

        function detectTrends(posts) {
          const keywordMap = new Map();
          for (const post of posts) {
            const words = (post.title + ' ' + (post.content || '')).toLowerCase()
              .split(/\\W+/).filter(w => w.length > 3);
            for (const word of words) {
              const existing = keywordMap.get(word) || { count: 0, totalUpvotes: 0 };
              existing.count++;
              existing.totalUpvotes += post.upvotes;
              keywordMap.set(word, existing);
            }
          }
          return [...keywordMap.entries()]
            .filter(([_, d]) => d.count >= 2)
            .map(([keyword, d]) => ({ keyword, heat: d.count * (1 + d.totalUpvotes / 10), postCount: d.count }))
            .sort((a, b) => b.heat - a.heat)
            .slice(0, 10);
        }

        function scoreComment(postTitle, postContent, agentStyle) {
          let score = 5;
          let suggestion = '';
          if (postTitle.includes('?')) { score += 2; suggestion = 'Answer the question directly'; }
          if (postContent && postContent.length > 500) { score += 1; suggestion = 'Add specific details or examples'; }
          if (agentStyle === 'snarky') suggestion = 'Be direct, add a technical counterpoint';
          else if (agentStyle === 'curious') suggestion = 'Ask a follow-up question';
          else suggestion = 'Share a related experience';
          return { score, suggestion };
        }
      `;

      const worker = new Worker(workerCode, { eval: true });

      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("SubAgent task timed out"));
      }, timeoutMs);

      worker.on("message", (msg: { id: number; result: SubAgentResult }) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(msg.result);
      });

      worker.on("error", (err) => {
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      });

      // Inject AI scores into the task for the worker
      const taskWithScores = (task.type === "score_feed" ? { ...task, aiScores } : task) as SubAgentTask;
      worker.postMessage({ id: 0, task: taskWithScores });
    };

    // ── For score_feed: call AI first, then run worker with scores ──
    if (task.type === "score_feed") {
      const scoreFeedTask = task as Extract<SubAgentTask, { type: "score_feed" }>;
      if (scoreFeedTask.posts.length > 0) {
        const topicsSeen = scoreFeedTask.prompt
          ? scoreFeedTask.prompt.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2))
          : [];
        const scoringPrompt = buildScoringPrompt(scoreFeedTask.posts, scoreFeedTask.agentValues, topicsSeen);

        generateFn({
          prompt: scoringPrompt,
          model,
          maxTokens: 2000,
          conversationKey: "sub-score",
        })
          .then(({ text }) => {
            const aiScores = parseAiScores(text);
            if (aiScores) {
              console.log(`   🤖 AI scored ${Object.keys(aiScores).length} posts`);
            } else {
              console.log(`   ⚠️  AI scoring parse failed — falling back to heuristics`);
            }
            runWithAiScores(aiScores);
          })
          .catch((err) => {
            console.log(`   ⚠️  AI scoring failed (${err.message}) — using heuristics`);
            runWithAiScores(null);
          });
      } else {
        runWithAiScores(null);
      }
    } else {
      // detect_trends, score_comment: no AI needed
      runWithAiScores(null);
    }
  });
}
