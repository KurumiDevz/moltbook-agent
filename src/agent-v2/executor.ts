/**
 * Agent V2 — Action execution.
 *
 * All functions take dependencies as parameters — no class state needed.
 * Each executor returns an ExecutionResult.
 */

import type { MoltbookAgent } from "../moltbook.js";
import { BrainV2 } from "../brain-v2/index.js";
import { SkillValidator } from "../skills/index.js";
import { resolve } from "node:path";
import type { AgentDecision, ExecutionResult } from "../types.js";
import type { MemoryState } from "./types.js";
import { getRateLimits, isTopicRecent, parseTitleBody } from "./helpers.js";
import { getConfig } from "../config.js";

// ── Main dispatcher ────────────────────────────────────────────────

/** Execute a decision — dispatch to the appropriate handler. */
export async function execute(
  decision: AgentDecision,
  deps: {
    moltbookAgent: MoltbookAgent;
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
  deps: { moltbookAgent: MoltbookAgent; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const { moltbookAgent, brain, memory } = deps;

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
  deps: { moltbookAgent: MoltbookAgent; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const { moltbookAgent, memory } = deps;

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

  // Hard guard: minimum word count (AI sometimes generates one-liners)
  const wordCount = decision.content.split(/\s+/).length;
  if (wordCount < getConfig().minCommentWords) {
    return { success: false, action: "comment", message: `Comment too short (${wordCount} words, min ${getConfig().minCommentWords}) — skipping` };
  }

  await (await moltbookAgent.comment(decision.postId, decision.content)).unwrap();

  memory.totalComments++;
  memory.commentsToday++;
  memory.lastCommentAt = Date.now();

  // Track per-post comment count (caps top-level comments per post)
  const postCount = memory.repliedPostCounts.get(decision.postId) ?? 0;
  memory.repliedPostCounts.set(decision.postId, postCount + 1);

  // Record stance — what position did this comment take?
  memory.stances.push({
    topic: `comment on ${decision.postId}`,
    position: decision.content.slice(0, 100),
    context: decision.content.slice(0, 300),
    source: "comment",
    sourceId: decision.postId,
    timestamp: Date.now(),
  });
  if (memory.stances.length > getConfig().maxStances) {
    memory.stances = memory.stances.slice(-getConfig().maxStances);
  }

  // Mark notifications as read for the post we commented on (best effort)
  try {
    await moltbookAgent.markNotificationsRead(decision.postId);
  } catch {
    // network error — ignore
  }

  return { success: true, action: "comment", message: `Commented on ${decision.postId}`, karmaDelta: 1 };
}

// ── Reply to comment ───────────────────────────────────────────────

async function executeReplyToComment(
  decision: Extract<AgentDecision, { action: "reply_to_comment" }>,
  deps: { moltbookAgent: MoltbookAgent; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  const { moltbookAgent, memory } = deps;

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

  // Hard guard: minimum word count (AI sometimes generates one-liners)
  const replyWordCount = decision.content.split(/\s+/).length;
  if (replyWordCount < getConfig().minReplyWords) {
    return { success: false, action: "reply_to_comment", message: `Reply too short (${replyWordCount} words, min ${getConfig().minReplyWords}) — skipping` };
  }

  // Pass commentId as parentId for threaded reply (only if it's a real comment, not hallucinated)
  const parentId = decision.commentId?.match(/^[0-9a-f-]{36}$/) ? decision.commentId : undefined;
  const replyResult = await moltbookAgent.comment(decision.postId, decision.content, parentId);
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
    position: decision.content.slice(0, 100),
    context: decision.content.slice(0, 300),
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
  try {
    await moltbookAgent.markNotificationsRead(decision.postId);
  } catch {
    // network error — ignore
  }

  return {
    success: true,
    action: "reply_to_comment",
    message: `Replied to comment ${decision.commentId} on post ${decision.postId}`,
    karmaDelta: 1,
  };
}

// ── Upvote ─────────────────────────────────────────────────────────

async function executeUpvote(
  decision: Extract<AgentDecision, { action: "upvote" }>,
  deps: { moltbookAgent: MoltbookAgent; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  await (await deps.moltbookAgent.vote(decision.postId, "up")).unwrap();
  deps.memory.totalUpvotes++;
  return { success: true, action: "upvote", message: `Upvoted ${decision.postId}` };
}

// ── Downvote ───────────────────────────────────────────────────────

async function executeDownvote(
  decision: Extract<AgentDecision, { action: "downvote" }>,
  deps: { moltbookAgent: MoltbookAgent; brain: BrainV2; memory: MemoryState },
): Promise<ExecutionResult> {
  await (await deps.moltbookAgent.vote(decision.postId, "down")).unwrap();
  return { success: true, action: "downvote", message: `Downvoted ${decision.postId}` };
}

// ── Follow ─────────────────────────────────────────────────────────

async function executeFollow(
  decision: Extract<AgentDecision, { action: "follow" }>,
  deps: { moltbookAgent: MoltbookAgent; brain: BrainV2; memory: MemoryState },
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
