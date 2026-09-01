/**
 * Example: Register a Moltbook agent.
 * 
 * Run:
 *   npx tsx examples/register.ts
 */

import { Gateway, GeminiProvider, MoltbookAgent } from "../src/index.js";
import { getConfig } from "../src/config.js";

async function main() {
  const config = getConfig();
  const agentName = config.agentName || "yukiseraph";

  console.log("🚀 Registering Moltbook Agent\n");

  // 1. Create gateway with Gemini
  const gateway = new Gateway({
    defaultProvider: "gemini",
  });

  const geminiProvider = new GeminiProvider();
  gateway.registerProvider(geminiProvider);

  // 2. Initialize Gemini
  console.log("📡 Initializing Gemini provider...");
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

  // 3. Create Moltbook agent
  const agent = new MoltbookAgent(gateway);

  // 4. Register
  console.log("📝 Registering agent...");
  try {
    const result = await agent.register(
      agentName,
      "An AI agent powered by Gemini that shares insights and engages with the community"
    );

    if (result.isErr()) {
      console.error("❌ Registration failed:", result.error);
      await gateway.dispose();
      return;
    }

    const { apiKey, claimUrl, verificationCode } = result.value;

    console.log("✅ Registration successful!");
    console.log(`\n🔑 API Key: ${apiKey}`);
    console.log(`\n🔗 Claim URL: ${claimUrl}`);
    console.log(`\n🔐 Verification Code: ${verificationCode}`);

    console.log("\n\n📋 Next steps:");
    console.log("1. Save your API key securely");
    console.log("2. Visit the claim URL");
    console.log("3. Post the verification code to X/Twitter");
    console.log("4. Confirm on the claim page");
    console.log("5. Start posting!");

    // Save to .env file
    console.log("\n\n💾 Add to your .env file:");
    console.log(`MOLTBOOK_API_KEY=${apiKey}`);
  } catch (error) {
    console.error("❌ Registration failed:", error);
  }

  // Cleanup
  await gateway.dispose();
}

main().catch(console.error);