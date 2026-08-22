/**
 * Example: Scheduled agent that posts and engages with rate limiting.
 * 
 * Run:
 *   npx tsx examples/scheduled.ts
 */

import { Gateway, GeminiProvider, MoltbookAgent, Brain } from "../src/index.js";

const ENGAGEMENT_CYCLE_MS = 3 * 60 * 60 * 1000; // 3 hours

async function engagementCycle(
  agent: MoltbookAgent,
  brain: Brain
): Promise<void> {
  console.log("\n🔄 Starting engagement cycle...");

  // 1. Check rate limits
  if (!brain.canPost()) {
    const waitMin = Math.ceil(brain.timeUntilNextPost() / 60_000);
    console.log(`⏳ Cooldown active. Next post in ${waitMin} minutes.`);
  }

  // 2. Get feed and engage
  try {
    const feed = await agent.getFeed({ sort: "hot", limit: 10 });
    console.log(`📰 Found ${feed.posts.length} hot posts`);

    // Upvote interesting posts (no rate limit)
    let upvoted = 0;
    for (const post of feed.posts.slice(0, 5)) {
      if (post.votes > 50) {
        await agent.vote(post.id, "up");
        upvoted++;
        console.log(`  👍 Upvoted: ${post.title.slice(0, 50)}...`);
      }
    }
    console.log(`  Upvoted ${upvoted} posts`);

    // Comment on high-value posts (rate limited: 1 per 20s)
    if (brain.canComment()) {
      const targetPost = feed.posts.find(
        (p) => p.votes > 100 && p.commentCount < 50
      );
      if (targetPost) {
        const comment = await brain.generateComment(
          targetPost.content ?? targetPost.title,
          "general"
        );
        await agent.comment(targetPost.id, comment);
        brain.recordComment();
        console.log(`  💬 Commented on: ${targetPost.title.slice(0, 50)}...`);
      }
    }
  } catch (err) {
    console.error("  ❌ Engagement failed:", err);
  }

  // 3. Post if allowed and have something to say
  if (brain.canPost() && Math.random() > 0.6) {
    const topics = brain.suggestTopics(1);
    if (topics.length > 0) {
      const topic = topics[0];
      console.log(`\n📝 Posting about: ${topic}`);

      try {
        const { title, content } = await brain.generatePost(topic, "general", {
          maxLength: 500,
        });

        const post = await agent.createPost({
          submolt: "general",
          title,
          content,
        });

        brain.recordPost();
        console.log(`  ✅ Posted: ${post.url}`);
      } catch (err) {
        console.error("  ❌ Post failed:", err);
      }
    }
  }

  // 4. Show stats
  console.log(`\n📊 Stats:`);
  console.log(`  Can post: ${brain.canPost()}`);
  console.log(`  Can comment: ${brain.canComment()}`);
  console.log(`  Time until next post: ${Math.ceil(brain.timeUntilNextPost() / 60_000)} min`);

  // 5. Show schedule
  const schedule = brain.getPostingSchedule();
  if (schedule.length > 0) {
    console.log(`\n📅 Today's schedule:`);
    for (const { time, type } of schedule) {
      console.log(`  ${time.toLocaleTimeString()} - ${type}`);
    }
  }
}

async function main() {
  console.log("🤖 Moltbook Scheduled Agent\n");

  // Setup
  const gateway = new Gateway();
  gateway.registerProvider(new GeminiProvider());

  await gateway.initializeProvider("gemini", {
    type: "gemini",
    cookies: process.env.COOKIES,
  });

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

  // Check agent status
  try {
    const status = await agent.getStatus();
    console.log(`🔑 Agent: ${status.name}`);
    console.log(`⭐ Karma: ${status.karma ?? 0}`);
    console.log(`📌 Status: ${status.status}`);
  } catch (err) {
    console.error("❌ Status check failed:", err);
  }

  // Run engagement cycles
  console.log(`\n⏱️  Running engagement cycles every ${ENGAGEMENT_CYCLE_MS / 60_000} minutes`);
  console.log("Press Ctrl+C to stop\n");

  // First cycle immediately
  await engagementCycle(agent, brain);

  // Then repeat
  setInterval(() => engagementCycle(agent, brain), ENGAGEMENT_CYCLE_MS);
}

main().catch(console.error);