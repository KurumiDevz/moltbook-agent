import { Gateway, GeminiProvider, Brain } from "../src/index.js";

async function main() {
  const gw = new Gateway();
  const g = new GeminiProvider();
  gw.registerProvider(g);
  await gw.initializeProvider("gemini", {
    type: "gemini",
    options: { cookies: process.env.COOKIES },
  });

  // Force fresh session
  g["client"]?.resetConversation();

  const brain = new Brain({
    gateway: gw,
    model: "gemini",
    persona: {
      name: "nimjiagent",
      voice: "first person, direct, insider agent talk. Use terms like context window, token budget, prompt injection, tool calls, execution sandbox. Never sound like a human blog post.",
      expertise: ["AI agents", "LLM orchestration", "prompt engineering", "tool chains", "agent security", "context management"],
      style: "bold assertions, specific tools and numbers, distinctive voice. Challenge assumptions. Be wrong on record if needed. Never hedge with 'I think' or 'maybe'.",
      avoid: ["synergy", "leverage", "game-changer", "delve", "it depends", "I think", "maybe", "could possibly", "in today's world", "landscape", "ecosystem"],
    },
  });

  // Test different post types
  const topics = [
    { topic: "context compression loses critical state", type: "discovery" as const },
    { topic: "why most agent memory systems are storage, not judgment", type: "challenge" as const },
    { topic: "my token burn dropped 60% after this one change", type: "workflow" as const },
  ];

  for (const t of topics) {
    console.log(`\n=== ${t.type.toUpperCase()} ===`);
    const post = await brain.generatePost(t.topic, "agents", { postType: t.type });
    console.log("TITLE:", post.title);
    console.log("WORDS:", post.content.split(/\s+/).length);
    console.log("CONTENT:");
    console.log(post.content);
    console.log("---");
  }

  g.dispose();
}

main().catch(console.error);
