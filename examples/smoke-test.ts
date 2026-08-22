/**
 * Quick smoke test — tests all API endpoints through http.ts
 * Run: npx tsx --env-file=.env examples/smoke-test.ts
 */
import { Gateway, GeminiProvider, MoltbookAgent } from "../src/index.js";

async function main() {
  const gateway = new Gateway();
  gateway.registerProvider(new GeminiProvider());
  await gateway.initializeProvider("gemini", { type: "gemini", cookies: process.env.COOKIES });
  const agent = new MoltbookAgent(gateway, { apiKey: process.env.MOLTBOOK_API_KEY });

  console.log("=== Smoke Test ===\n");

  // 1. Status
  try {
    const status = await agent.getStatus();
    console.log("✅ Status:", status.name, "| Karma:", status.karma);
  } catch (err: any) {
    console.log("❌ Status:", err.message);
  }

  // 2. Home
  try {
    const home = await agent.getHome();
    console.log("✅ Home: karma=" + home.karma, "agents=" + home.stats.agents, "posts=" + home.stats.posts);
  } catch (err: any) {
    console.log("❌ Home:", err.message);
  }

  // 3. Feed
  try {
    const feed = await agent.getFeed({ sort: "hot", limit: 5 });
    console.log("✅ Feed:", feed.posts.length, "posts");
    for (const p of feed.posts) {
      console.log("   -", p.title.slice(0, 55), "|", p.votes, "votes");
    }
  } catch (err: any) {
    console.log("❌ Feed:", err.message);
  }

  // 4. Notifications
  try {
    const notifs = await agent.getNotifications({ limit: 3 });
    console.log("✅ Notifications:", notifs.notifications.length);
    for (const n of notifs.notifications) {
      console.log("   -", n.type, ":", n.message.slice(0, 50));
    }
  } catch (err: any) {
    console.log("❌ Notifications:", err.message);
  }

  // 5. Comment on first post
  try {
    const feed = await agent.getFeed({ sort: "hot", limit: 1 });
    if (feed.posts.length > 0) {
      const res = await agent.comment(feed.posts[0].id, "Interesting take. What's the main failure mode you've seen?");
      console.log("✅ Comment:", res.id);
    }
  } catch (err: any) {
    console.log("❌ Comment:", err.message);
  }

  // 6. Upvote
  try {
    const feed = await agent.getFeed({ sort: "hot", limit: 1 });
    if (feed.posts.length > 0) {
      await agent.vote(feed.posts[0].id, "up");
      console.log("✅ Upvote:", feed.posts[0].title.slice(0, 40));
    }
  } catch (err: any) {
    console.log("❌ Upvote:", err.message);
  }

  // 7. Profile
  try {
    const me = await agent.getMe();
    console.log("✅ Profile:", me.name, "| Karma:", me.karma);
  } catch (err: any) {
    console.log("❌ Profile:", err.message);
  }

  // 8. Submolts
  try {
    const subs = await agent.listSubmolts();
    console.log("✅ Submolts:", subs.submolts.length);
  } catch (err: any) {
    console.log("❌ Submolts:", err.message);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
