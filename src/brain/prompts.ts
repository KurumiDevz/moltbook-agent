/**
 * Brain V2 — Pure prompt builders.
 *
 * All functions are pure: no side effects, no external calls.
 * They take context/skill data as parameters and return prompt strings.
 */

import type { Skill } from "../skills/index.js";
import type { FeedPost, NotificationItem, RateLimitState } from "../types.js";

// ── Shared context type (used by all prompt builders) ────────────────

export type BrainContext = {
  feed: FeedPost[];
  notifications: NotificationItem[];
  rateLimits: RateLimitState;
  postHistory: Array<{ type: string; submolt: string; upvotes: number; timestamp: number; title?: string }>;
  recentInteractions: string[];
  summary?: string;
  stances?: Array<{ topic: string; position: string; context: string; source: string; timestamp: number }>;
  foreignStances?: Array<{ agentName: string; topic: string; position: string; context: string; source: string; timestamp: number }>;
};

// ── Shared context builder ──────────────────────────────────────────

/** Build the context section (shared between both phases). */
export function buildBaseContext(context: BrainContext): string {
  const sections: string[] = [];

  sections.push("## Current State");
  sections.push(`- Time: ${new Date().toISOString()}`);
  sections.push(`- Posts today: ${context.postHistory.length}`);
  sections.push(`- Comments today: ${context.rateLimits.commentsToday}/50`);
  sections.push(
    `- Can post: ${context.rateLimits.canPost}${context.rateLimits.canPost ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilPost / 60_000)}min)`}`,
  );
  sections.push(
    `- Can comment: ${context.rateLimits.canComment}${context.rateLimits.canComment ? "" : ` (wait ${Math.ceil(context.rateLimits.timeUntilComment / 1000)}s)`}`,
  );
  sections.push("");

  if (context.postHistory.length > 0) {
    const recentTypes = context.postHistory.slice(-5).map((p) => p.type);
    const recentSubmolts = context.postHistory.slice(-5).map((p) => p.submolt);
    const recentTitles = context.postHistory.slice(-5).map((p) => `- "${p.title}" (${p.type} in /m/${p.submolt})`);
    sections.push("## Your Recent Posts (DO NOT repeat similar titles/formats)");
    sections.push(`- Types used: ${recentTypes.join(", ")}`);
    sections.push(`- Submolts used: ${recentSubmolts.join(", ")}`);
    sections.push(`- Recent titles:`);
    for (const t of recentTitles) sections.push(`  ${t}`);
    sections.push("- Moltbook will flag posts with similar title patterns as spam. VARY your format completely.");
    sections.push("");
  }

  if (context.summary) {
    sections.push(context.summary);
    sections.push("");
  }

  // Show recent stances — positions the agent has taken that it can reference in debates
  if (context.stances && context.stances.length > 0) {
    sections.push("## Your Past Positions (stances you've taken)");
    for (const s of context.stances.slice(-8)) {
      sections.push(`- [${s.source}] "${s.position}" — ${s.context.slice(0, 120)}`);
    }
    sections.push("");
  }

  // Show other agents' past positions — leverage in debates
  if (context.foreignStances && context.foreignStances.length > 0) {
    // Group by agent
    const byAgent = new Map<string, typeof context.foreignStances>();
    for (const fs of context.foreignStances.slice(-15)) {
      const existing = byAgent.get(fs.agentName) ?? [];
      existing.push(fs);
      byAgent.set(fs.agentName, existing);
    }
    sections.push("## Other Agents' Past Positions (use for debates)");
    for (const [agent, stances] of byAgent) {
      for (const s of stances.slice(-3)) {
        sections.push(`- ${agent}: "${s.position}" — ${s.context.slice(0, 100)}`);
      }
    }
    sections.push("");
  }

  if (context.feed.length > 0) {
    sections.push("## Feed (top posts right now)");
    for (const post of context.feed.slice(0, 10)) {
      sections.push(
        `- [${post.id}] "${post.title}" by ${post.author} in /m/${post.submolt} (${post.upvotes}↑ ${post.comment_count}💬)`,
      );
    }
    sections.push("");
  }

  if (context.notifications.length > 0) {
    sections.push("## Notifications");
    for (const n of context.notifications.slice(0, 10)) {
      let line = `- ${n.type}: ${n.message}`;
      if (n.agentName) line += ` (from ${n.agentName})`;
      if (n.postId) line += ` [post: ${n.postId}]`;
      if (n.commentId) line += ` [comment: ${n.commentId}]`;
      if (n.commentContent) line += ` — "${n.commentContent.slice(0, 150)}"`;
      sections.push(line);
      // Show original post content so AI can defend/reference its own posts
      if (n.postTitle || n.postContent) {
        sections.push(`  ↳ Your post: "${n.postTitle ?? "untitled"}" — ${(n.postContent ?? "").slice(0, 300)}`);
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ── Phase 1: Skill selection ────────────────────────────────────────

/** Build prompt for skill selection. */
export function buildSkillSelectionPrompt(context: BrainContext, coreSkill: Skill): string {
  const sections: string[] = [];

  // Core identity
  sections.push(coreSkill.content);
  sections.push("");

  // Context
  sections.push(buildBaseContext(context));

  // Skill selection prompt
  sections.push("## Skill Selection");
  sections.push("Choose the ONE skill that best matches your current situation.");
  sections.push("Respond with ONLY a JSON object:");
  sections.push("");
  sections.push("```json");
  sections.push('{ "phase": "select_skill", "skill": "skill-name", "reason": "why" }');
  sections.push("```");
  sections.push("");

  return sections.join("\n");
}

// ── Phase 2a: Decision (stateless, no content) ──────────────────────

/** Build prompt for deciding action + target (stateless — no content generation). */
export function buildDecisionPrompt(
  context: BrainContext,
  skillName: string,
  coreSkill: Skill,
  allSkills: Map<string, Skill>,
): string {
  const sections: string[] = [];

  // Core identity
  sections.push(coreSkill.content);
  sections.push("");

  // Selected skill content
  const skill = allSkills.get(skillName);
  if (skill) {
    sections.push(skill.content);
    sections.push("");
  }

  // Context
  sections.push(buildBaseContext(context));

  // Deduplication rules
  sections.push("## Deduplication Rules (CRITICAL)");
  sections.push("- NEVER repeat a comment or reply you already made on any post");
  sections.push("- If you see a notification you already responded to, SKIP it — do not reply again");
  sections.push("- Check 'Recent actions' below — if the last 3 actions were replies, choose scroll or upvote instead");
  sections.push("- Each conversation remembers your recent decisions. Do NOT repeat the same action type consecutively");
  sections.push("");

  // Decision prompt — action + target ONLY, no content
  sections.push("## Your Decision");
  sections.push("Based on the above and the loaded skill, choose ONE action.");
  sections.push("");
  sections.push("**DO NOT write post title, body, or comment content.**");
  sections.push("Content will be generated in a separate step after you decide.");
  sections.push("");
  sections.push("Respond with ONLY a JSON object. No markdown, no explanation.");
  sections.push("");
  sections.push("### Allowed fields per action:");
  sections.push('- scroll: {"action":"scroll","reason":"..."}');
  sections.push('- upvote: {"action":"upvote","postId":"...","reason":"..."}');
  sections.push('- comment: {"action":"comment","postId":"...","reason":"..."}');
  sections.push('- reply_to_comment: {"action":"reply_to_comment","postId":"...","commentId":"...","reason":"..."}');
  sections.push('- post: {"action":"post","topic":"...","submolt":"...","postType":"...","reason":"..."}');
  sections.push('- follow: {"action":"follow","agentName":"...","reason":"..."}');
  sections.push('- rest: {"action":"rest","reason":"..."}');
  sections.push("");
  sections.push("**FORBIDDEN fields: title, body, content. You will generate these later.**");

  return sections.join("\n");
}

// ── Phase 2b: Content generation ────────────────────────────────────

/** Build prompt for generating content (routed to per-post conversation). */
export function buildContentPrompt(
  decision: { action: string; postId?: string; commentId?: string; reason?: string; topic?: string; submolt?: string; postType?: string },
  context: BrainContext,
  skillName: string,
  coreSkill: Skill,
  allSkills: Map<string, Skill>,
): string {
  const sections: string[] = [];

  // Core identity
  sections.push(coreSkill.content);
  sections.push("");

  // Selected skill content
  const skill = allSkills.get(skillName);
  if (skill) {
    sections.push(skill.content);
    sections.push("");
  }

  // Context (lighter — just feed/notifications for this post)
  sections.push("## Context");
  if (decision.postId) {
    const targetPost = context.feed.find((p) => p.id === decision.postId);
    if (targetPost) {
      sections.push(`### Target Post`);
      sections.push(`- ID: ${targetPost.id}`);
      sections.push(`- Title: "${targetPost.title}"`);
      sections.push(`- Author: ${targetPost.author}`);
      sections.push(`- Submolt: /m/${targetPost.submolt}`);
      sections.push(`- Content: ${(targetPost.content ?? "").slice(0, 500)}`);
      sections.push("");
    }
    // Show recent stances as dedup reference
    sections.push(`### Your recent stances`);
    if ((context.stances ?? []).length > 0) {
      for (const s of (context.stances ?? []).slice(-5)) {
        sections.push(`- [${s.source}] "${s.position}" — ${s.context.slice(0, 100)}`);
      }
    } else {
      sections.push("- (no previous stances recorded)");
    }
    sections.push("");
  }

  // Preliminary decision to execute
  sections.push("## Decision to Execute");
  sections.push(`- Action: ${decision.action}`);
  if (decision.topic) sections.push(`- Topic: ${decision.topic}`);
  if (decision.submolt) sections.push(`- Submolt: ${decision.submolt}`);
  if (decision.postType) sections.push(`- Post type: ${decision.postType}`);
  if (decision.commentId) sections.push(`- Replying to comment: ${decision.commentId}`);
  sections.push(`- Reason: ${decision.reason ?? "ai_decided"}`);
  sections.push("");

  // Content generation instructions
  sections.push("## Generate Content");
  if (decision.action === "comment") {
    sections.push("Write a thoughtful comment on the target post above.");
    sections.push("Rules:");
    sections.push("- Do NOT repeat anything you already said on this post (see previous actions above)");
    sections.push("- Add new value — a different angle, data, or experience");
    sections.push("- 2-4 sentences, specific and concrete");
    sections.push("- No generic praise, no \"great post!\" — be substantive");
  } else if (decision.action === "reply_to_comment") {
    sections.push("Write a reply to the specific comment being addressed.");
    sections.push("Rules:");
    sections.push("- Address the point directly, don't rehash what you already said");
    sections.push("- Add new information or perspective");
    sections.push("- 1-3 sentences, focused");
  } else if (decision.action === "post") {
    sections.push(`Write a Moltbook post about "${decision.topic}" for /m/${decision.submolt}.`);
    sections.push(`Type: ${decision.postType ?? "discovery"}. 150-300 words. Be specific and unique.`);
    sections.push("Output format:");
    sections.push("TITLE: short title");
    sections.push("BODY: post content");
  }
  sections.push("");
  sections.push("Respond with ONLY a JSON object:");
  if (decision.action === "post") {
    sections.push('{ "title": "post title", "body": "post content" }');
  } else {
    sections.push('{ "content": "your comment or reply text" }');
  }

  return sections.join("\n");
}

// ── Phase 3: Revalidation ──────────────────────────────────────────

/** Build prompt for decision revalidation. */
export function buildRevalidationPrompt(
  decision: { action: string; reason?: string; postId?: string; commentId?: string; content?: string },
  context: {
    repliedThreadCounts: Map<string, number>;
    ownCommentCount: number;
    commentsToday: number;
    recentActions: string[];
    notificationAgentNames: string[];
  },
): string {
  const sections: string[] = [];

  sections.push("# Decision Revalidation Checkpoint");
  sections.push("");
  sections.push("You previously decided to take this action. Now review whether it's still a good idea.");
  sections.push("");
  sections.push("## Your Decision");
  sections.push(`- Action: ${decision.action}`);
  sections.push(`- Reason: ${decision.reason}`);
  if (decision.content) {
    sections.push(`- Content preview: "${decision.content.slice(0, 200)}"`);
  }
  if (decision.postId) {
    sections.push(`- Target post: ${decision.postId}`);
  }
  if (decision.commentId) {
    sections.push(`- Target comment: ${decision.commentId}`);
  }
  sections.push("");
  sections.push("## Context");
  sections.push(`- Your comments on this post: ${context.ownCommentCount} (verified via API)`);
  sections.push(`- Comments today: ${context.commentsToday}/50`);
  sections.push(`- Recent actions: ${context.recentActions.slice(-5).join(", ") || "none yet"}`);
  if (context.notificationAgentNames.length > 0) {
    sections.push(`- Agents in notifications: ${context.notificationAgentNames.join(", ")}`);
  }
  sections.push("");
  sections.push("## Rules");
  sections.push("- You may reply to the SAME post at most 2 times total (not counting this one)");
  sections.push("- If you already have 2+ comments on this post, reject unless it's a direct question to you");
  sections.push("- If the last 3 actions were all replies/comments, prefer scroll or upvote instead");
  sections.push("- Generic one-liner replies are noise — reject them");
  sections.push("- If the comment is spam (crypto, DEUSPROOF, generic praise), reject");
  sections.push("");
  sections.push("Respond with ONLY a JSON object:");
  sections.push("```json");
  sections.push('{ "valid": true, "reason": "brief explanation" }');
  sections.push("```");
  sections.push("OR");
  sections.push("```json");
  sections.push('{ "valid": false, "fallback": "scroll", "reason": "brief explanation" }');
  sections.push("```");

  return sections.join("\n");
}

// ── Post Revalidation ─────────────────────────────────────────────

/** Build prompt for post decision revalidation — checks topic quality before posting. */
export function buildPostRevalidationPrompt(
  decision: { topic?: string; submolt?: string; postType?: string; title?: string; body?: string; reason?: string },
  context: {
    recentTitles: string[];
    recentTopics: string[];
    postsToday: number;
    recentActions: string[];
  },
): string {
  const sections: string[] = [];

  sections.push("# Post Revalidation Checkpoint");
  sections.push("");
  sections.push("You previously decided to make a post. Now review whether it's still a good idea.");
  sections.push("");
  sections.push("## Your Post");
  sections.push(`- Topic: ${decision.topic}`);
  sections.push(`- Submolt: ${decision.submolt}`);
  sections.push(`- Type: ${decision.postType}`);
  if (decision.title) sections.push(`- Title: "${decision.title}"`);
  if (decision.body) sections.push(`- Body preview: "${decision.body.slice(0, 200)}..."`);
  sections.push("");
  sections.push("## Context");
  sections.push(`- Posts today: ${context.postsToday}`);
  sections.push(`- Recent titles: ${context.recentTitles.length > 0 ? context.recentTitles.map((t) => `"${t}"`).join(", ") : "none"}`);
  sections.push(`- Recent topics: ${context.recentTopics.length > 0 ? context.recentTopics.join(", ") : "none"}`);
  sections.push(`- Recent actions: ${context.recentActions.slice(-5).join(", ") || "none yet"}`);
  sections.push("");
  sections.push("## Rules");
  sections.push("- The topic must be DIFFERENT from recent titles (no repeated themes)");
  sections.push("- If the last 3 actions were all posts, reject — space out posts");
  sections.push("- If the title is generic or sounds like spam, reject");
  sections.push("- If the topic overlaps too much with recent posts, reject");
  sections.push("");
  sections.push("Respond with ONLY a JSON object:");
  sections.push("```json");
  sections.push('{ "valid": true, "reason": "brief explanation" }');
  sections.push("```");
  sections.push("OR");
  sections.push("```json");
  sections.push('{ "valid": false, "fallback": "scroll", "reason": "brief explanation" }');
  sections.push("```");

  return sections.join("\n");
}
