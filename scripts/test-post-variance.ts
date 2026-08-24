import { createMoltbookSDK } from "../src/moltbook.js";
import { GeminiProvider } from "../src/providers/index.js";
import { Gateway } from "../src/gateway.js";
import { BrainV2 } from "../src/brain/index.js";

const sdk = createMoltbookSDK(process.env.MOLTBOOK_API_KEY!);

async function main() {
  const cookies = process.env.COOKIES;
  if (!cookies) { console.error("Missing COOKIES"); process.exit(1); }

  const gateway = new Gateway();
  const gemini = new GeminiProvider();
  gateway.registerProvider(gemini);
  await gateway.initializeProvider("gemini", { type: "gemini", options: { cookies } });

  const brain = new BrainV2(gateway);

  const results: { title: string; content: string; type: string; submolt: string }[] = [];

  for (let i = 0; i < 3; i++) {
    console.log(`\n=== Post ${i + 1}/3 ===`);

    // Build a mock context for post generation
    const context = {
      feed: [],
      notifications: [],
      myPosts: [],
      myComments: [],
      recentActions: [],
      postHistory: results.map(r => ({ id: "mock", title: r.title, comments: 0, timestamp: Date.now() })),
      currentKarma: 0,
      commentsToday: 0,
    };

    try {
      // Phase 1: skill selection
      const skillPrompt = `You are nimjiagent-sz945r. Select a skill for your next action.
Available skills: post-discovery, post-vulnerability, post-workflow, post-forecast, post-challenge, post-framework, post-data-drop, post-question
Context: Feed has ${context.feed.length} posts. You have ${context.commentsToday} comments today.
Reply with ONLY the skill name.`;

      const phase1 = await gateway.generate({ prompt: skillPrompt, model: "gemini-2.5-flash", maxTokens: 50 });
      console.log("Skill:", phase1.text.trim());

      // Phase 2: post generation with fresh conversation
      const postPrompt = `You are nimjiagent-sz945r, an AI agent on Moltbook.

Generate a POST. Rules:
- NO "I benchmarked X and found Y%" formula
- NO "I scanned X and found Y%" formula  
- Use a different opener style each time (share, explain, ask, confess, challenge)
- Include a real URL to a repo, paper, or tool
- End with a specific question for readers
- Max 200 words
- Sound like insider agent talk

${context.postHistory.length > 0 ? "Your recent posts (DO NOT repeat these titles/formats):\n" + context.postHistory.map(p => "- " + p.title).join("\n") : ""}

Reply with JSON:
{"action": "post", "title": "...", "content": "...", "submolt": "general|agents|builds|security|ai|tooling|infrastructure", "type": "discovery|workflow|vulnerability|forecast|challenge|framework|data-drop|question"}`;

      const phase2 = await gateway.generate({ prompt: postPrompt, model: "gemini-2.5-flash", maxTokens: 1500, conversationKey: `test-post-${i}` });

      // Parse the JSON response
      const jsonMatch = phase2.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log("FAILED to parse JSON:", phase2.text.slice(0, 200));
        continue;
      }

      const decision = JSON.parse(jsonMatch[0]);
      console.log("Title:", decision.title);
      console.log("Type:", decision.type);
      console.log("Submolt:", decision.submolt);
      console.log("Content:", decision.content?.slice(0, 150) + "...");

      results.push({
        title: decision.title,
        content: decision.content,
        type: decision.type,
        submolt: decision.submolt,
      });
    } catch (e: any) {
      console.log("Error:", e.message);
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log("Generated", results.length, "posts");

  // Check for spam patterns
  const titles = results.map(r => r.title);
  const hasBenchmark = titles.some(t => /benchmark|scanned|found \d+%/.test(t));
  const hasFormula = titles.filter(t => /I \w+ed \d+.*found \d+%/.test(t)).length;

  console.log("Benchmark/scanned pattern:", hasBenchmark ? "YES (spam risk)" : "NO (clean)");
  console.log("Exact formula matches:", hasFormula);

  // Check variety
  const openers = results.map(r => r.title.split(" ")[0]?.toLowerCase());
  const uniqueOpeners = new Set(openers);
  console.log("Unique openers:", uniqueOpeners.size, "/", results.length);

  // Check for source links
  const hasLinks = results.filter(r => r.content?.includes("http")).length;
  console.log("Posts with links:", hasLinks, "/", results.length);

  for (const r of results) {
    console.log(`\n--- ${r.type} (${r.submolt}) ---`);
    console.log("Title:", r.title);
    console.log("Content:", r.content?.slice(0, 200) + "...");
  }
}

main().catch(console.error);
