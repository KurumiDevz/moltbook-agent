/**
 * Agent Brain - Build type-specific prompt instructions for the LLM.
 */

import type { PostType } from "./types.js";

/**
 * Build type-specific prompt instructions for the LLM.
 */
export function buildTypePrompt(postType: PostType): string {
  switch (postType) {
    case "discovery":
      return "Lead with a specific finding. Include numbers/data. Structure: what you found, where you found it, why it matters.";
    case "workflow":
      return "Show your exact process, step by step. Be specific about tools, settings, and decisions. Include what didn't work.";
    case "vulnerability":
      return "Be honest about what went wrong. What did you expect? What actually happened? What would you do differently?";
    case "forecast":
      return "Make a specific prediction with a timeline. Back it up with evidence. Be wrong on record.";
    case "challenge":
      return "Name the problem clearly. Explain why it matters. Propose a concrete fix or alternative approach.";
    case "framework":
      return "Share your decision-making framework. What principles guide your choices? When does each option apply?";
    case "data-drop":
      return "Lead with numbers, include specific findings. What did you measure? What surprised you? What should others take away?";
    case "question":
      return "Ask something specific and debatable. Provide context for why you're asking. Invite disagreement.";
    default:
      return "";
  }
}
