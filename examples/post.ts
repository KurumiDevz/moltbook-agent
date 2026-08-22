/**
 * Example: Post to Moltbook using AI-generated content.
 * 
 * Run:
 *   npx tsx examples/post.ts
 */

import { Gateway, GeminiProvider, MoltbookAgent, Brain } from "../src/index.js";

async function main() {
  console.log("📝 Posting to Moltbook\n");

  // 1. Create gateway
  const gateway = new Gateway({
    defaultProvider: "gemini",
  });

  const geminiProvider = new GeminiProvider();
  gateway.registerProvider(geminiProvider);

  // 2. Initialize
  console.log("📡 Initializing Gemini...");
  try {
    await gateway.initializeProvider("gemini", {
      type: "gemini",
      cookies: process.env.COOKIES,
    });
    console.log("✅ Gemini ready\n");
  } catch (error) {
    console.error("❌ Gemini init failed:", error);
    console.log("\n💡 Set COOKIES env var with your Gemini session cookies");
    process.exit(1);
  }

  // 3. Create agent with brain
  const agent = new MoltbookAgent(gateway, {
    apiKey: process.env.MOLTBOOK_API_KEY,
  });

  const brain = new Brain({
    gateway,
    persona: {
      name: "NimjiAgent",
      voice: "first person, curious and direct",
      expertise: ["AI agents", "LLMs", "Moltbook", "automation"],
      style: "concise, opinionated, no fluff",
      avoid: ["synergy", "leverage", "game-changing", "revolutionary"],
    },
  });

  // 4. Generate and post
  const topic = "What's the most underrated AI tool right now?";
  const submolt = "general";

  console.log(`🤖 Generating post about: ${topic}`);
  try {
    const { title, content } = await brain.generatePost(topic, submolt, {
      maxLength: 500,
    });

    console.log(`\n📌 Title: ${title}`);
    console.log(`📄 Content:\n${content}`);

    // Post with rate limit handling
    console.log("\n📤 Posting to Moltbook...");
    const post = await agent.createPost({
      submolt,
      title,
      content,
    });

    console.log("\n✅ Post created!");
    console.log(`🔗 URL: ${post.url}`);
    console.log(`⏰ Created: ${post.createdAt}`);
  } catch (error) {
    console.error("❌ Post failed:", error);
  }

  // 5. Cleanup
  await gateway.dispose();
}

main().catch(console.error);