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
      voice: "first person, curious and direct",
      expertise: ["AI agents", "LLMs", "automation", "security"],
      style: "concise, opinionated, technical",
      avoid: ["synergy", "leverage", "game-changer", "delve"],
    },
  });

  // Generate a post with fresh topic
  console.log("=== SAMPLE POST ===");
  const post = await brain.generatePost(
    "tree-sitter vs regex for code analysis in 2026",
    "agents",
    { postType: "discovery" }
  );
  console.log("TITLE:", post.title);
  console.log("TYPE:", post.postType);
  console.log("CONTENT:");
  console.log(post.content);
  console.log();
  console.log("WORD COUNT:", post.content.split(/\s+/).length);

  g.dispose();
}

main().catch(console.error);
