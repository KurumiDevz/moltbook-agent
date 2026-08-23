/**
 * Verify Gemini generates real content through the full pipeline.
 * Run: npx tsx --env-file=.env examples/verify-gemini.ts
 */
import { Gateway, GeminiProvider, MoltbookAgent, Brain } from "../src/index.js";

async function main() {
  console.log("=== Gemini Verification ===\n");

  // 1. Init gateway + Gemini
  const gateway = new Gateway();
  gateway.registerProvider(new GeminiProvider());
  console.log("1. Gateway created, Gemini registered");

  // 2. Initialize Gemini with cookies
  await gateway.initializeProvider("gemini", {
    type: "gemini",
    cookies: process.env.COOKIES,
  });
  console.log("2. Gemini initialized with cookies\n");

  // 3. Test raw Gemini generate
  console.log("3. Testing raw Gemini generation...");
  const rawResult = await gateway.generate({
    prompt: "Say exactly: GEMINI_WORKING. Nothing else.",
    maxTokens: 20,
  });
  console.log("   Response:", rawResult.text.slice(0, 100));
  console.log("   Provider:", rawResult.provider);
  console.log("   Model:", rawResult.model);
  const geminiOk = rawResult.text.length > 0 && rawResult.provider === "gemini";
  console.log("   Status:", geminiOk ? "PASS" : "FAIL\n");

  // 4. Test Brain generatePost (uses Gemini internally)
  console.log("4. Testing Brain.generatePost...");
  const brain = new Brain({
    gateway,
    persona: {
      name: "nimjiagent",
      voice: "first person, curious and direct",
      expertise: ["AI agents", "LLMs", "Moltbook"],
      style: "concise, opinionated, no fluff",
      avoid: ["synergy", "leverage", "game-changing"],
    },
  });

  const { title, content } = await brain.generatePost(
    "what is the most underrated AI tool right now",
    "general",
    { maxLength: 300 }
  );
  console.log("   Title:", title);
  console.log("   Content:", content.slice(0, 150));
  const brainOk = title.length > 0 && content.length > 0;
  console.log("   Status:", brainOk ? "PASS" : "FAIL\n");

  // 5. Test Brain generateComment
  console.log("5. Testing Brain.generateComment...");
  const comment = await brain.generateComment(
    "AI agents need better memory systems",
    "general"
  );
  console.log("   Comment:", comment.slice(0, 150));
  const commentOk = comment.length > 0;
  console.log("   Status:", commentOk ? "PASS" : "FAIL\n");

  // Summary
  console.log("=== Summary ===");
  console.log("Gemini raw generate:", geminiOk ? "PASS" : "FAIL");
  console.log("Brain post gen:     ", brainOk ? "PASS" : "FAIL");
  console.log("Brain comment gen:  ", commentOk ? "PASS" : "FAIL");
  console.log("Overall:", (geminiOk && brainOk && commentOk) ? "ALL PASS" : "SOME FAILED");
}

main().catch(console.error);
