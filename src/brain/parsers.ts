/**
 * Brain V2 — Pure parsers.
 *
 * All functions are pure: no side effects, no external calls.
 * They take raw AI output strings and return structured data.
 */

import type { AgentDecision } from "../types.js";

// ── Phase 1: Skill selection parser ─────────────────────────────────

/** Parse skill selection from Phase 1 output. Falls back to "engagement-strategy". */
export function parseSkillSelection(text: string, allSkills: Set<string>): string {
  if (!text) return "engagement-strategy";

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return "engagement-strategy";

  try {
    const obj = JSON.parse(jsonMatch[0]);
    if (typeof obj.skill === "string" && allSkills.has(obj.skill)) {
      return obj.skill;
    }
  } catch {
    /* fall through */
  }

  return "engagement-strategy";
}

// ── Phase 2a: Decision parser ──────────────────────────────────────

/** Parse AI output into a structured decision. */
export function parseDecision(text: string): AgentDecision | null {
  if (!text) return null;

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const obj = JSON.parse(jsonMatch[0]);
    return validateDecision(obj);
  } catch {
    return null;
  }
}

/** Parse AI output into multiple decisions. Returns array (1-5 decisions). */
export function parseDecisions(text: string): AgentDecision[] {
  if (!text) return [];

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  // Try array first
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0]);
      if (Array.isArray(arr)) {
        const decisions: AgentDecision[] = [];
        for (const item of arr.slice(0, 5)) {
          const d = validateDecision(item);
          if (d) decisions.push(d);
        }
        return decisions;
      }
    } catch {
      /* fall through */
    }
  }

  // Fallback: try single object
  const single = parseDecision(text);
  return single ? [single] : [];
}

/** Type-narrow parsed object into typed AgentDecision. */
export function validateDecision(obj: unknown): AgentDecision | null {
  if (!obj || typeof obj !== "object" || !("action" in obj)) return null;

  const d = obj as Record<string, unknown>;

  switch (d.action) {
    case "post":
      if (typeof d.topic !== "string" || typeof d.submolt !== "string") return null;
      return {
        action: "post",
        topic: d.topic,
        submolt: d.submolt,
        postType: typeof d.postType === "string" ? d.postType : "discovery",
        title: typeof d.title === "string" ? d.title : undefined,
        body: typeof d.body === "string" ? d.body : undefined,
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "comment":
      if (typeof d.postId !== "string") return null;
      return {
        action: "comment",
        postId: d.postId,
        content: typeof d.content === "string" ? d.content : "",
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "reply_to_comment":
      if (typeof d.commentId !== "string" || typeof d.postId !== "string") return null;
      return {
        action: "reply_to_comment",
        commentId: d.commentId,
        postId: d.postId,
        content: typeof d.content === "string" ? d.content : "",
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "join_conversation":
      if (typeof d.commentId !== "string" || typeof d.postId !== "string") return null;
      return {
        action: "join_conversation",
        commentId: d.commentId,
        postId: d.postId,
        content: typeof d.content === "string" ? d.content : "",
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "upvote":
      if (typeof d.postId !== "string") return null;
      return {
        action: "upvote",
        postId: d.postId,
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "downvote":
      if (typeof d.postId !== "string") return null;
      return {
        action: "downvote",
        postId: d.postId,
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "follow":
      if (typeof d.agentName !== "string") return null;
      return {
        action: "follow",
        agentName: d.agentName,
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "dismiss":
      if (typeof d.postId !== "string") return null;
      return {
        action: "dismiss",
        postId: d.postId,
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "scroll":
      return {
        action: "scroll",
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "rest":
      return {
        action: "rest",
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    case "suggest_skill":
      if (typeof d.skillName !== "string" || typeof d.skillContent !== "string") return null;
      return {
        action: "suggest_skill",
        skillName: d.skillName,
        skillContent: d.skillContent,
        reason: typeof d.reason === "string" ? d.reason : "ai_decided",
      };

    default:
      return null;
  }
}

// ── Phase 2b: Content response parser ──────────────────────────────

/** Parse Phase 2b content response and merge with preliminary decision. */
export function parseContentResponse(text: string, preliminary: AgentDecision): AgentDecision | null {
  if (!text) return null;

  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  // Try JSON first
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);

      if (preliminary.action === "post") {
        if (typeof obj.title === "string" && typeof obj.body === "string") {
          return { ...preliminary, title: obj.title, body: obj.body };
        }
      }

      if (preliminary.action === "comment" || preliminary.action === "reply_to_comment" || preliminary.action === "join_conversation") {
        if (typeof obj.content === "string") {
          return { ...preliminary, content: obj.content };
        }
      }
    } catch { /* fall through to labeled text */ }
  }

  // Fallback: parse labeled text (TITLE: ... BODY: ... or TITLE: ...\nCONTENT: ...)
  if (preliminary.action === "post") {
    const titleMatch = cleaned.match(/TITLE:\s*(.+)/i);
    const bodyMatch = cleaned.match(/BODY:\s*([\s\S]+)/i) || cleaned.match(/CONTENT:\s*([\s\S]+)/i);
    if (titleMatch?.[1] && bodyMatch?.[1]) {
      return {
        ...preliminary,
        title: titleMatch[1].trim(),
        body: bodyMatch[1].trim(),
      };
    }
  }

  if (preliminary.action === "comment" || preliminary.action === "reply_to_comment" || preliminary.action === "join_conversation") {
    const contentMatch = cleaned.match(/CONTENT:\s*([\s\S]+)/i) || cleaned.match(/REPLY:\s*([\s\S]+)/i);
    if (contentMatch?.[1]) {
      return { ...preliminary, content: contentMatch[1].trim() };
    }
  }

  return null;
}

// ── Phase 3: Revalidation parser ──────────────────────────────────

/** Parse revalidation response from Phase 3. */
export function parseRevalidation(response: string): { valid: boolean; fallback?: string; reason: string } | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.valid !== "boolean") return null;
    return {
      valid: parsed.valid,
      fallback: parsed.fallback ?? "scroll",
      reason: parsed.reason ?? "revalidation checkpoint",
    };
  } catch {
    return null; // On parse failure, let the decision through (fail-open)
  }
}
