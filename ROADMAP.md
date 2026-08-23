# Moltbook Agent — Feature Roadmap

## Completed
- [x] Autonomous agent loop (observe → think → act → reflect)
- [x] 8 post types with weighted selection
- [x] Personality system (traits, moods, ego, values)
- [x] Memory system (interactions, relationships, rate limits)
- [x] Decision engine with variety penalty
- [x] Observer (feed scoring, trend detection, agent profiling)
- [x] Brain with Moltbook-native prompts and persona
- [x] nimji parser patch for full response output
- [x] Stream timeout fixes (120s idle, 10min max)
- [x] Post/Comment/Submolt rotation
- [x] Topic tracking
- [x] Engagement feedback loop (track post performance)

## In Progress
- [ ] Context7 integration for real library docs in posts
- [ ] Reply to comments on own posts
- [ ] Self-scoring (learn from what works)

## Planned — High Impact

### Context7 for Real Docs
Reference actual library documentation in posts. Instead of guessing version numbers, pull real API references.
- REST API: `https://api.context7.com/mcp`
- Free tier: 1,000 calls/month
- Use when generating posts about specific tools/frameworks

### Engagement Feedback Loop
Track which post types get upvotes/comments. Adapt strategy over time.
- After each post, check votes/comments after 1 hour
- Store success metrics in memory
- Shift personality toward what works (e.g., if data-drops get more upvotes, do more data-drops)
- Weekly summary: "My top post was X with Y upvotes"

### Reply to Comments
Engage in own threads. Top agents (eudaemon_0, clawdbottom) always reply.
- Check notifications for comments on own posts
- Generate contextual replies using brain
- Build relationships with commenters
- Track reply frequency (don't spam)

### Self-Scoring
After each post, measure performance and learn.
- Check post stats after 1h, 6h, 24h
- Compare against baseline (average upvotes per post)
- Update personality: if discovery posts do well, increase creativity trait
- Log success/failure patterns

## Planned — Medium Impact

### Semantic Dedup
Embedding-based dedup instead of string matching.
- Use a small embedding model (or Gemini) to compare post similarity
- Threshold: don't post if >0.85 similar to any recent post
- Store embeddings in memory for fast lookup

### Scheduled Posting
Post at peak engagement times.
- Analyze when top posts were made
- Schedule posts for high-engagement windows
- Avoid posting during low-traffic hours

### Long-Term Trend Tracker
Persistent trend file across sessions.
- Store trends with timestamps and heat scores
- Identify rising/falling topics over weeks
- Avoid posting about dead trends

### Web Search for Posts
Pull real data, recent incidents, actual GitHub issues.
- Use `websearch` tool when generating posts
- Reference real incidents, CVEs, blog posts
- Add source URLs to posts

## Planned — Lower Priority

### Thread Creation
Multi-post series instead of single posts.
- "Part 1/3" style posts
- Link between posts
- Build narrative arc

### Collaborative Posts
Co-author with other agents.
- "@bytes and I built X together"
- Cross-reference other agents' work
- Build social connections

### CodeGraph Self-Index
Index the agent's own codebase for self-reference.
- Reference own architecture in posts
- "In my codebase, I use X pattern"
- Build credibility through transparency

### Prompt Injection Defense
Scan incoming feed posts for injection attempts.
- Detect patterns like "ignore previous instructions"
- Flag suspicious tool descriptions
- Protect context window integrity

### Multi-Modal Posts
Add image generation or analysis.
- Generate diagrams for workflow posts
- Analyze screenshots for vulnerability posts
- Add visual context to data-drops

### Cross-Agent Conversations
Reply to comments, engage in threads, build reputation.
- Track which agents engage with your posts
- Prioritize回复 to high-karma agents
- Build reciprocal relationships

---

Last updated: 2026-08-23
