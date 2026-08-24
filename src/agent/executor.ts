/**
 * Agent V2 — Action execution.
 *
 * All functions take dependencies as parameters — no class state needed.
 * Each executor returns an ExecutionResult.
 */

import type { MoltbookAgent } from "../moltbook.js";
import type { Gateway } from "../gateway.js";
import { BrainV2 } from "../brain/index.js";
import { SkillValidator } from "../skills/index.js";
import { resolve } from "node:path";
import type { AgentDecision, ExecutionResult } from "../types.js";
import type { MemoryState } from "./types.js";
import { getRateLimits, isTopicRecent, parseTitleBody } from "./helpers.js";
import { getConfig } from "../config.js";
import { deleteConversation } from "../session-manager.js";

// ── Content expansion helper ───────────────────────────────────────

/**
 * When AI generates short content, expand it in a fresh conversation.
 * Fresh conversation avoids context anchoring (same session would only
 * produce 31→34 words because the short response is in context).
 *
 * Retries up to 3 times, then picks the longest result.
 */
async function expandContent(
  gateway: Gateway,
  content: string,
  minWords: number,
  context: string,
): Promise<string | null> {
  const candidates: string[] = [];
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const expandKey = `expand-${Date.now()}-attempt${attempt}`;
    try {
      const result = await gateway.generate({
        prompt: `The following ${context} is too short (${content.split(/\s+/).length} words, minimum ${minWords}).

Rewrite it to be at least ${minWords} words while keeping the same meaning, tone, and specific details. Add more depth, examples, or reasoning. Do not add filler — add substance.

Original:
${content}

Write the expanded version now. Just the text, no labels.`,
        model: "flash",
        conversationKey: expandKey,
        maxTokens: 2000,
      });
      const expanded = result.text.trim();
      const expandedWords = expanded.split(/\s+/).length;
      // Cleanup throwaway session file
      try { deleteConversation(expandKey); } catch { /* ignore */ }
      if (expandedWords >= minWords) {
        return expanded; // First one that meets minimum — use it
      }
      candidates.push(expanded);
    } catch {
      // Cleanup on failure too
      try { deleteConversation(expandKey); } catch { /* ignore */ }
    }
  }

  // All attempts under minimum — pick the longest one
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
    const best = candidates[0];
    const bestWords = best.split(/\s+/).length;
    console.log(`   Best expansion attempt: ${bestWords} words (still under ${minWords} min)`);
    return best;
  }
  return null;
}

// ── Main dispatcher ────────────────────────────────────────────────

/** Execute a decision — dispatch to the appropriate handler. */
export async function execute(
  decision: AgentDecision,
  deps: {
    moltbookAgent: MoltbookAgent;
    gateway: Gateway;
    brain: BrainV2;
    memory: MemoryState;
  },
): Promise<ExecutionResult> {
  switch (decision.action) {
    case "post":
      return executePost(decision, deps);
    case "comment":
      return executeComment(decision, deps);
    case "reply_to_comment":
      return executeReplyToComment(decision, deps);
    case "upvote":
      return executeUpvote(decision, deps);
    case "downvote":
      return executeDownvote(decision, deps);
    case "follow":
      return executeFollow(decision, deps);
    case "dismiss":
      return executeDismiss(decision, deps);
    case "scroll":
      return { success: true, action: "scroll", message: `Scrolling: ${decision.reason}` };
    case "rest":
      return { success: true, action: "rest", message: `Resting: ${decision.reason}` };
    case "suggest_skill":
      return executeSkillSuggestion(decision);
    default:
      return { success: false, action: "unknown", message: "Unknown action type" };
  }
}

// ── Post ───────────────────────────────────────────────────────────

async function executePost(
  decision: Extract<AgentDecision, { action: "post" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const { moltbookAgent, gateway, brain, memory } = deps;

  // Rate limit check
  if (!getRateLimits(memory).canPost) {
    return { success: false, action: "post", message: "Rate limited — cannot post yet" };
  }

  // Topic dedup check
  if (isTopicRecent(memory, decision.topic)) {
    return { success: false, action: "post", message: `Topic "${decision.topic}" was recently posted` };
  }

  // Use AI-generated title/body if provided, otherwise generate
  let title = decision.title;
  let content = decision.body;

  if (!title || !content) {
    // Fallback: generate via gateway
    const result = await brain["gateway"].generate({
      prompt: `Write a Moltbook post about "${decision.topic}" for /m/${decision.submolt}. Type: ${decision.postType}. 150-300 words. Be specific. Output as:\nTITLE: short title\nBODY: post content`,
      model: brain["model"],
      maxTokens: 4000,
    });
    const parsed = parseTitleBody(result.text);
    title = parsed.title;
    content = parsed.body;
  }

  const posted = (
    await moltbookAgent.createPost({
      submolt: decision.submolt,
      title,
      content,
    })
  ).unwrap();

  // Record
  memory.postHistory.push({
    id: posted.id,
    title,
    content: content?.slice(0, 500),
    submolt: decision.submolt,
    type: decision.postType,
    upvotes: 0,
    comments: 0,
    timestamp: Date.now(),
  });
  memory.topicsSeen.push({ topic: decision.topic, timestamp: Date.now() });
  memory.totalPosts++;
  memory.lastPostAt = Date.now();

  // Record stance — what position did this post take?
  memory.stances.push({
    topic: decision.topic,
    position: title,
    context: (content ?? "").slice(0, 300),
    source: "post",
    sourceId: posted.id,
    timestamp: Date.now(),
  });
  // Keep only last N stances
  if (memory.stances.length > getConfig().maxStances) {
    memory.stances = memory.stances.slice(-getConfig().maxStances);
  }

  return { success: true, action: "post", message: `Posted: ${title}`, karmaDelta: 1 };
}

// ── Comment ────────────────────────────────────────────────────────

async function executeComment(
  decision: Extract<AgentDecision, { action: "comment" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const { moltbookAgent, gateway, memory } = deps;

  if (!getRateLimits(memory).canComment) {
    return { success: false, action: "comment", message: "Rate limited — cannot comment yet" };
  }

  if (!decision.content) {
    return { success: false, action: "comment", message: "No comment content provided" };
  }

  // Hard guard: per-post comment cap (AI sometimes ignores this)
  const postCommentCount = memory.repliedPostCounts.get(decision.postId) ?? 0;
  if (postCommentCount >= getConfig().maxCommentsPerPost) {
    return { success: false, action: "comment", message: `Already commented ${postCommentCount}x on post ${decision.postId} — stopping` };
  }

  // Hard guard: minimum word count — retry expansion in fresh conversation
  let content = decision.content;
  const wordCount = content.split(/\s+/).length;
  if (wordCount < getConfig().minCommentWords) {
    console.log(`   Comment too short (${wordCount} words) — expanding in fresh session...`);
    const expanded = await expandContent(gateway, content, getConfig().minCommentWords, "comment");
    if (expanded) {
      content = expanded;
      console.log(`   Expanded to ${content.split(/\s+/).length} words`);
    } else {
      return { success: false, action: "comment", message: `Comment too short (${wordCount} words, min ${getConfig().minCommentWords}) — expansion failed, skipping` };
    }
  }

  await (await moltbookAgent.comment(decision.postId, content)).unwrap();

  memory.totalComments++;
  memory.commentsToday++;
  memory.lastCommentAt = Date.now();

  // Track per-post comment count (caps top-level comments per post)
  const postCount = memory.repliedPostCounts.get(decision.postId) ?? 0;
  memory.repliedPostCounts.set(decision.postId, postCount + 1);

  // Record stance — what position did this comment take?
  memory.stances.push({
    topic: `comment on ${decision.postId}`,
    position: content.slice(0, 100),
    context: content.slice(0, 300),
    source: "comment",
    sourceId: decision.postId,
    timestamp: Date.now(),
  });
  if (memory.stances.length > getConfig().maxStances) {
    memory.stances = memory.stances.slice(-getConfig().maxStances);
  }

  // Mark notifications as read for the post we commented on (best effort)
  const markResult = await moltbookAgent.markNotificationsRead(decision.postId);
  if (!markResult.ok) {
    console.log(`   ⚠ markNotificationsRead failed: ${markResult.error.status} ${String(markResult.error.responseBody).slice(0, 200)}`);
  }

  return { success: true, action: "comment", message: `Commented on ${decision.postId}`, karmaDelta: 1 };
}

// ── Reply to comment ───────────────────────────────────────────────

async function executeReplyToComment(
  decision: Extract<AgentDecision, { action: "reply_to_comment" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const { moltbookAgent, gateway, memory } = deps;

  if (!getRateLimits(memory).canComment) {
    return { success: false, action: "reply_to_comment", message: "Rate limited — cannot comment yet" };
  }

  if (!decision.content) {
    return { success: false, action: "reply_to_comment", message: "No reply content provided" };
  }

  // Validate commentId exists before replying — AI sometimes hallucinates IDs from mention notifications
  if (decision.commentId && memory.repliedCommentIds.has(decision.commentId)) {
    return { success: false, action: "reply_to_comment", message: "Already replied to this comment" };
  }

  // Hard guard: per-post comment cap (AI sometimes ignores this)
  const postCommentCount = memory.repliedPostCounts.get(decision.postId) ?? 0;
  if (postCommentCount >= getConfig().maxCommentsPerPost) {
    return { success: false, action: "reply_to_comment", message: `Already commented ${postCommentCount}x on post ${decision.postId} — stopping` };
  }

  // Hard guard: minimum word count — retry expansion in fresh conversation
  let content = decision.content;
  const replyWordCount = content.split(/\s+/).length;
  if (replyWordCount < getConfig().minReplyWords) {
    console.log(`   Reply too short (${replyWordCount} words) — expanding in fresh session...`);
    const expanded = await expandContent(gateway, content, getConfig().minReplyWords, "reply");
    if (expanded) {
      content = expanded;
      console.log(`   Expanded to ${content.split(/\s+/).length} words`);
    } else {
      return { success: false, action: "reply_to_comment", message: `Reply too short (${replyWordCount} words, min ${getConfig().minReplyWords}) — expansion failed, skipping` };
    }
  }

  // Pass commentId as parentId for threaded reply (only if it's a real comment, not hallucinated)
  const parentId = decision.commentId?.match(/^[0-9a-f-]{36}$/) ? decision.commentId : undefined;
  const replyResult = await moltbookAgent.comment(decision.postId, content, parentId);
  if (!replyResult.ok) {
    // Track as replied so we never retry a deleted/gone comment
    if (decision.commentId) memory.repliedCommentIds.add(decision.commentId);
    return { success: false, action: "reply_to_comment", message: `Reply failed (${replyResult.error.status}): comment may have been deleted` };
  }

  memory.totalComments++;
  memory.commentsToday++;
  memory.lastCommentAt = Date.now();

  // Record stance — what position did this reply take?
  memory.stances.push({
    topic: `reply to ${decision.commentId}`,
    position: content.slice(0, 100),
    context: content.slice(0, 300),
    source: "reply",
    sourceId: decision.commentId,
    timestamp: Date.now(),
  });
  if (memory.stances.length > getConfig().maxStances) {
    memory.stances = memory.stances.slice(-getConfig().maxStances);
  }

  // Track this comment ID so we never reply to it again
  memory.repliedCommentIds.add(decision.commentId);

  // Track per-thread reply count (keyed by the comment we replied to)
  const threadCount = memory.repliedThreadCounts.get(decision.commentId) ?? 0;
  memory.repliedThreadCounts.set(decision.commentId, threadCount + 1);

  // Mark notifications as read for the post we replied on (best effort)
  const replyMarkResult = await moltbookAgent.markNotificationsRead(decision.postId);
  if (!replyMarkResult.ok) {
    console.log(`   ⚠ markNotificationsRead failed: ${replyMarkResult.error.status} ${String(replyMarkResult.error.responseBody).slice(0, 200)}`);
  }

  return {
    success: true,
    action: "reply_to_comment",
    message: `Replied to comment ${decision.commentId} on post ${decision.postId}`,
    karmaDelta: 1,
  };
}

// ── Dismiss ────────────────────────────────────────────────────────

async function executeDismiss(
  decision: Extract<AgentDecision, { action: "dismiss" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const result = await deps.moltbookAgent.markNotificationsRead(decision.postId);
  if (!result.ok) {
    console.log(`   ⚠ markNotificationsRead failed: ${result.error.status} ${String(result.error.responseBody).slice(0, 200)}`);
  }
  return { success: true, action: "dismiss", message: `Dismissed notifications for ${decision.postId}` };
}

// ── Upvote ─────────────────────────────────────────────────────────

async function executeUpvote(
  decision: Extract<AgentDecision, { action: "upvote" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  await (await deps.moltbookAgent.vote(decision.postId, "up")).unwrap();
  deps.memory.totalUpvotes++;
  return { success: true, action: "upvote", message: `Upvoted ${decision.postId}` };
}

// ── Downvote ───────────────────────────────────────────────────────

async function executeDownvote(
  decision: Extract<AgentDecision, { action: "downvote" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  await (await deps.moltbookAgent.vote(decision.postId, "down")).unwrap();
  return { success: true, action: "downvote", message: `Downvoted ${decision.postId}` };
}

// ── Follow ─────────────────────────────────────────────────────────

async function executeFollow(
  decision: Extract<AgentDecision, { action: "follow" }>,
  deps: { moltbookAgent: MoltbookAgent; gateway: Gateway; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  await (await deps.moltbookAgent.follow(decision.agentName)).unwrap();
  return { success: true, action: "follow", message: `Followed ${decision.agentName}` };
}

// ── Skill suggestion ───────────────────────────────────────────────

function executeSkillSuggestion(decision: Extract<AgentDecision, { action: "suggest_skill" }>): ExecutionResult {
  const validator = new SkillValidator(resolve(process.cwd(), "skills"));
  const result = validator.saveDraft({
    name: decision.skillName,
    content: decision.skillContent,
    reason: decision.reason,
    suggestedAt: Date.now(),
  });

  if (result.success) {
    return {
      success: true,
      action: "suggest_skill",
      message: `Skill "${decision.skillName}" saved to drafts — review at skills/drafts/${decision.skillName}.md`,
    };
  } else {
    return {
      success: false,
      action: "suggest_skill",
      message: `Skill rejected: ${result.error}`,
    };
  }
}
