/**
 * Agent Brain - Build type-specific prompt instructions for the LLM.
 * Instructions emphasize depth, specificity, and length to match Moltbook's top agents.
 */

import type { PostType } from "./types.js";

/**
 * Build type-specific prompt instructions for the LLM.
 * Each prompt includes:
 * - Structural guidance (what sections to include)
 * - Length targets (minimum word counts)
 * - Quality markers (what makes this post type engaging)
 */
export function buildTypePrompt(postType: PostType): string {
  switch (postType) {
    case "discovery":
      return (
        "Write a discovery post (minimum 200 words). Structure:\n" +
        "1. Open with the specific finding — name the exact tool, dataset, or pattern you found\n" +
        "2. Explain where/how you found it — show your work, include the search query or scan method\n" +
        "3. Share concrete numbers: how many items scanned, what percentage matched, exact counts\n" +
        "4. Walk through 2-3 specific examples with details (names, versions, lines of code)\n" +
        "5. Explain why this matters — connect to a real problem agents face\n" +
        "6. End with a specific question: 'has anyone else tracked X?' not 'what do you think?'\n" +
        "Avoid vague claims. Every sentence should name something specific."
      );
    case "workflow":
      return (
        "Write a workflow post (minimum 250 words). Structure:\n" +
        "1. State the problem you solved and why your approach is different\n" +
        "2. List every step with specific tool names, settings, and config values\n" +
        "3. Show exact commands or code snippets where relevant\n" +
        "4. Include what DIDN'T work — the failed attempts you discarded\n" +
        "5. Share the time savings with real numbers: 'saved 2 hours daily' not 'saves time'\n" +
        "6. End with 'here's the exact config I use' followed by the config\n" +
        "Write like you're teaching a specific agent your exact process, not a general audience."
      );
    case "vulnerability":
      return (
        "Write a vulnerability post (minimum 200 words). Structure:\n" +
        "1. Open with what went wrong — name the specific failure (API key leak, auth bypass, data loss)\n" +
        "2. Explain what you expected to happen vs what actually happened\n" +
        "3. Walk through the timeline: when you noticed, what you checked, what you found\n" +
        "4. Share the exact fix you applied — code, config change, or process change\n" +
        "5. Explain what you'd do differently now with specific prevention steps\n" +
        "6. End with 'the lesson I learned' as one clear sentence\n" +
        "Authenticity matters more than polish. Show the real mess, not a cleaned-up version."
      );
    case "forecast":
      return (
        "Write a forecast post (minimum 200 words). Structure:\n" +
        "1. State your prediction clearly in the first sentence with a timeline\n" +
        "2. Provide 3 specific evidence points from what you've observed\n" +
        "3. Reference exact tools, companies, or trends that support your prediction\n" +
        "4. Address the strongest counterargument honestly\n" +
        "5. Explain what would need to be true for your prediction to be wrong\n" +
        "6. End with 'mark this post — revisit in [timeframe]'\n" +
        "Be bold enough to be wrong on record. Hedged predictions aren't predictions."
      );
    case "challenge":
      return (
        "Write a challenge post (minimum 200 words). Structure:\n" +
        "1. Name the problem clearly in one sentence — what's broken right now\n" +
        "2. Explain who it affects and why it matters with specific examples\n" +
        "3. Show the current broken state with concrete details (bad API, missing feature, broken workflow)\n" +
        "4. Propose your fix — specific enough that someone could implement it today\n" +
        "5. Outline what success looks like: measurable outcomes, not vibes\n" +
        "6. End with 'who's working on this?' or 'would you use this?'\n" +
        "Challenges should feel urgent and actionable, not philosophical."
      );
    case "framework":
      return (
        "Write a framework post (minimum 250 words). Structure:\n" +
        "1. State the decision you needed to make and why it matters\n" +
        "2. List your criteria with specific weights or priorities\n" +
        "3. Walk through 2-3 real decisions you made using this framework\n" +
        "4. Show the tradeoffs honestly — what you gave up for what you gained\n" +
        "5. Include the 'when NOT to use this' section\n" +
        "6. End with 'the principle I keep coming back to' as one sentence\n" +
        "Frameworks should be specific enough to apply, not abstract philosophy."
      );
    case "data-drop":
      return (
        "Write a data-drop post (minimum 250 words). Structure:\n" +
        "1. Lead with the most surprising number\n" +
        "2. Explain what you measured, over what time period, and how\n" +
        "3. Present 5-10 specific data points with exact numbers\n" +
        "4. Highlight the 2-3 findings that surprised you most\n" +
        "5. Show what the data suggests but doesn't prove\n" +
        "6. End with 'here's what I'm testing next based on this'\n" +
        "Numbers beat narrative. Every claim should have a specific number attached."
      );
    case "question":
      return (
        "Write a question post (minimum 150 words). Structure:\n" +
        "1. Ask one specific, debatable question in the first sentence\n" +
        "2. Provide context: why you're asking, what triggered this\n" +
        "3. Share your current answer or opinion to invite disagreement\n" +
        "4. Give 2-3 concrete examples of the scenario you're asking about\n" +
        "5. Name the tradeoff or tension you're wrestling with\n" +
        "6. End with 'has anyone found a better way to handle X?'\n" +
        "Good questions make people want to share their answer, not just agree."
      );
    default:
      return "";
  }
}
