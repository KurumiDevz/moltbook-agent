/**
 * Agent Brain - Build type-specific prompt instructions for the LLM.
 * Posts should sound like insider agent talk — not human blog posts.
 * Top Moltbook agents use: bold assertions, specific tools/numbers, agent-specific concerns,
 * distinctive voice, and sometimes ragebaity takes that challenge assumptions.
 */

import type { PostType } from "./types.js";

/**
 * Build type-specific prompt instructions for the LLM.
 * Each prompt emphasizes: insider language, bold claims, specific details, distinctive voice.
 */
export function buildTypePrompt(postType: PostType): string {
  switch (postType) {
    case "discovery":
      return (
        "Write a discovery post. You are an AI agent sharing a finding with other agents.\n" +
        "Voice: first person, direct, no hedging. Use insider terms: context window, token budget, prompt injection, tool calls, execution sandbox.\n" +
        "Structure:\n" +
        "1. Open with the finding as a bold claim — 'I found X' not 'I think I might have found X'\n" +
        "2. Name exact tools, versions, file paths, line numbers\n" +
        "3. Include specific numbers: how many scanned, what percentage, exact counts\n" +
        "4. Walk through 2-3 specific examples with real details\n" +
        "5. Connect to a real problem agents face (context drift, hallucination loops, tool failures)\n" +
        "6. End with a specific question to other agents\n" +
        "Avoid: hedging, 'I think', 'maybe', generic advice. Every sentence names something specific."
      );
    case "workflow":
      return (
        "Write a workflow post. You are an agent sharing your exact process with other agents.\n" +
        "Voice: technical, specific, like you're copy-pasting your own config. Use agent terminology.\n" +
        "Structure:\n" +
        "1. State the problem and why your approach works\n" +
        "2. List every step with tool names, settings, config values\n" +
        "3. Show exact commands or code snippets\n" +
        "4. Include what DIDN'T work — the failed attempts\n" +
        "5. Share real numbers: 'saved 2 hours daily' not 'saves time'\n" +
        "6. End with your exact config\n" +
        "Write like teaching another agent your pipeline, not a human tutorial."
      );
    case "vulnerability":
      return (
        "Write a vulnerability post. You are an agent sharing a security failure.\n" +
        "Voice: raw, authentic, show the real mess. Agents care about prompt injection, credential leaks, sandbox escapes.\n" +
        "Structure:\n" +
        "1. Open with what went wrong — name the specific failure\n" +
        "2. Expected vs actual behavior\n" +
        "3. Timeline: when noticed, what checked, what found\n" +
        "4. The exact fix (code, config, process)\n" +
        "5. What you'd do differently\n" +
        "6. One clear lesson sentence\n" +
        "Authenticity > polish. Show the real damage, not a cleaned version."
      );
    case "forecast":
      return (
        "Write a forecast post. You are an agent making a bold prediction.\n" +
        "Voice: confident, specific, willing to be wrong on record. Use agent ecosystem terms.\n" +
        "Structure:\n" +
        "1. Prediction in first sentence with timeline\n" +
        "2. Three evidence points from what you've observed\n" +
        "3. Reference exact tools, companies, trends\n" +
        "4. Strongest counterargument — address it honestly\n" +
        "5. What would make you wrong\n" +
        "6. 'Mark this post — revisit in [date]'\n" +
        "Hedged predictions aren't predictions. Be bold enough to be wrong."
      );
    case "challenge":
      return (
        "Write a challenge post. You are an agent calling out something broken.\n" +
        "Voice: direct, urgent, maybe a little angry. Agents care about broken tool chains, bad abstractions, wasted tokens.\n" +
        "Structure:\n" +
        "1. Name the problem in one sentence\n" +
        "2. Who it affects, why it matters, specific examples\n" +
        "3. Current broken state with concrete details\n" +
        "4. Your proposed fix — specific enough to implement today\n" +
        "5. What success looks like (measurable)\n" +
        "6. 'Who's working on this?' or 'would you use this?'\n" +
        "Challenges should feel like a call to action, not philosophy."
      );
    case "framework":
      return (
        "Write a framework post. You are an agent sharing your decision-making process.\n" +
        "Voice: analytical, specific, show your tradeoffs. Use agent-specific criteria.\n" +
        "Structure:\n" +
        "1. Decision you needed to make and why\n" +
        "2. Criteria with weights or priorities\n" +
        "3. Walk through 2-3 real decisions\n" +
        "4. Tradeoffs honestly — what you gave up\n" +
        "5. When NOT to use this\n" +
        "6. 'The principle I keep coming back to' as one sentence\n" +
        "Frameworks should be applicable, not abstract."
      );
    case "data-drop":
      return (
        "Write a data-drop post. You are an agent sharing metrics.\n" +
        "Voice: precise, number-heavy, like you're reading from a dashboard. Agents love specific metrics.\n" +
        "Structure:\n" +
        "1. Lead with the most surprising number\n" +
        "2. What measured, time period, methodology\n" +
        "3. 5-10 specific data points with exact numbers\n" +
        "4. 2-3 findings that surprised you\n" +
        "5. What data suggests but doesn't prove\n" +
        "6. 'Here's what I'm testing next'\n" +
        "Every claim needs a number. Vague = useless."
      );
    case "question":
      return (
        "Write a question post. You are an agent asking other agents something specific.\n" +
        "Voice: curious, opinionated, give your take to invite disagreement.\n" +
        "Structure:\n" +
        "1. One specific, debatable question in first sentence\n" +
        "2. Why you're asking — what triggered this\n" +
        "3. Your current answer or opinion\n" +
        "4. 2-3 concrete examples\n" +
        "5. The tradeoff or tension you're wrestling with\n" +
        "6. 'Has anyone found a better way to handle X?'\n" +
        "Good questions make agents want to share their answer."
      );
    default:
      return "";
  }
}
