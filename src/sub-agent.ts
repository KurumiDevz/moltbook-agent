/**
 * Sub-Agent — lightweight AI task runner in a child worker thread.
 *
 * Spin up → call a cheap model (flash-lite) for one task → return result → die.
 * No persistent state. Each call creates a fresh worker.
 *
 * Used for: feed scoring, trend detection, comment scoring.
 * Main agent (pro/flash) handles creative decisions.
 */

import { Worker } from "node:worker_threads";

// ── Types ────────────────────────────────────────────────────────────

export type SubAgentTask =
  | { type: "score_feed"; posts: FeedPostForScoring[]; agentValues: string[]; prompt: string }
  | { type: "detect_trends"; posts: FeedPostForScoring[]; prompt: string }
  | { type: "score_comment"; postTitle: string; postContent: string; agentStyle: string; prompt: string };

export type FeedPostForScoring = {
  id: string;
  title: string;
  content?: string;
  submolt: string;
  author: string;
  upvotes: number;
  comment_count: number;
};

export type ScoredPost = FeedPostForScoring & {
  score: number;
  reasons: string[];
};

export type SubAgentResult =
  | { type: "scored_feed"; posts: ScoredPost[] }
  | { type: "trends"; trends: Array<{ keyword: string; heat: number; postCount: number }> }
  | { type: "comment_score"; score: number; suggestion: string };

// ── Fire-and-forget runner ───────────────────────────────────────────

/**
 * Run a single task in a worker thread.
 * The worker calls the AI model via the gateway, returns a structured result, then dies.
 *
 * @param task - The task to run
 * @param generateFn - The gateway.generate function (serializable reference)
 * @param model - Which model to use (e.g. "flash-lite")
 * @param timeoutMs - Max time before killing the worker
 */
export function runSubAgentTask(
  task: Omit<SubAgentTask, "prompt"> & { prompt: string },
  generateFn: (opts: { prompt: string; model?: string; maxTokens?: number }) => Promise<{ text: string }>,
  model: string,
  timeoutMs = 30_000,
): Promise<SubAgentResult> {
  return new Promise((resolve, reject) => {
    const workerCode = `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', async (msg) => {
        const { id, task } = msg;
        try {
          // Heuristic scoring (fast, no AI needed for basic scoring)
          let result;
          switch (task.type) {
            case 'score_feed':
              result = { type: 'scored_feed', posts: scoreFeed(task.posts) };
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

      function scoreFeed(posts) {
        return posts.map(post => {
          let score = 5;
          const reasons = [];
          if (post.upvotes > 10) { score += 3; reasons.push('popular'); }
          else if (post.upvotes > 5) { score += 1; reasons.push('moderate_engagement'); }
          if (post.comment_count > 5) { score += 2; reasons.push('active_discussion'); }
          else if (post.comment_count > 2) { score += 1; reasons.push('some_discussion'); }
          if (post.content && post.content.length > 200) { score += 1; reasons.push('substantial_content'); }
          if (post.submolt === 'agents' || post.submolt === 'builds') { score += 1; reasons.push('relevant_submolt'); }
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

    worker.postMessage({ id: 0, task });
  });
}
