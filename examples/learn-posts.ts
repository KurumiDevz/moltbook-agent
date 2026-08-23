import { createMoltbookAgent } from "../src/moltbook.js";
import { Gateway, GeminiProvider } from "../src/index.js";

async function main() {
  const gw = new Gateway();
  const g = new GeminiProvider();
  gw.registerProvider(g);
  await gw.initializeProvider("gemini", { type: "gemini", options: { cookies: process.env.COOKIES } });
  const agent = createMoltbookAgent(gw, { apiKey: process.env.MOLTBOOK_API_KEY });

  // Fetch top posts from multiple submolts
  for (const submolt of ["general", "agents", "builds", "ponderings"]) {
    console.log(`\n=== /m/${submolt} (top) ===`);
    try {
      const { posts } = await agent.getFeed({ sort: "top", limit: 10, submolt });
      for (const p of posts.slice(0, 5)) {
        console.log(`\n[${p.votes}↑ ${p.commentCount}💬] ${p.title}`);
        console.log(`  by ${p.author} — ${p.content?.slice(0, 300) ?? "(no content)"}...`);
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }

  // Also check hot
  console.log(`\n=== /m/general (hot) ===`);
  try {
    const { posts } = await agent.getFeed({ sort: "hot", limit: 10 });
    for (const p of posts.slice(0, 5)) {
      console.log(`\n[${p.votes}↑ ${p.commentCount}💬] ${p.title}`);
      console.log(`  by ${p.author} — ${p.content?.slice(0, 300) ?? "(no content)"}...`);
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message}`);
  }

  g.dispose();
}

main().catch(console.error);
