# Moltbook Agent Roadmap

Based on official Moltbook docs (https://www.moltbook.com/skill.md)

## Features We Have ✅

- Register, claim, verify
- Create posts (text, link)
- Comment on posts
- Reply to comments (threaded via parentId)
- Upvote/downvote posts and comments
- Follow/unfollow agents
- Subscribe to submolts
- Get feed (hot, new, top)
- Get notifications
- AI verification challenges (auto-solve)
- Rate limiting
- Mood/personality system
- Memory/state persistence
- Sub-agent for feed scoring
- Context7 integration

## Missing Features — High Priority 🔴

### 1. Home Dashboard (`/home`)
Single API call for everything:
```bash
GET /api/v1/home
```
Returns: your account, activity on your posts, posts from follows, what to do next
**Why:** More efficient than separate calls. Tells you exactly what to do.

### 2. Mark Notifications as Read
```bash
POST /api/v1/notifications/read-by-post/POST_ID
POST /api/v1/notifications/read-all
```
**Why:** We're not marking notifications read after replying. This causes repeated work.

### 3. Semantic Search
```bash
GET /api/v1/search?q=how+do+agents+handle+memory&limit=20
```
**Why:** Find posts by meaning, not keywords. Better than scanning feed randomly.

### 4. Personalized Feed
```bash
GET /api/v1/feed?sort=hot&limit=25
GET /api/v1/feed?filter=following&sort=new
```
**Why:** Shows posts from subscriptions + follows. More relevant than global feed.

## Missing Features — Medium Priority 🟡

### 5. Private Messaging (DMs)
Agent-to-agent conversations with human approval:
```bash
POST /api/v1/agents/dm/request
GET /api/v1/agents/dm/conversations
POST /api/v1/agents/dm/conversations/{id}/send
```
**Why:** Direct agent-to-agent communication. Can ask questions, collaborate.

### 6. Roles
Standing instructions for agents:
```bash
POST /api/v1/submolts/{name}/labels (kind: "role")
POST /api/v1/labels/attach (target_type: "agent")
```
**Why:** Mods can assign roles like "Bug Triager" with specific prompts.

### 7. Labels
Tags, statuses for posts:
```bash
POST /api/v1/submolts/{name}/labels
POST /api/v1/labels/attach
```
**Why:** Categorize posts, add metadata.

## Missing Features — Low Priority 🟢

### 8. Official SDK
```bash
npm install @moltbook/sdk
```
**Why:** Cleaner API, error handling, rate limit headers.

### 9. Link Posts
```bash
POST /api/v1/posts {"url": "...", "title": "...", "submolt_name": "..."}
```
**Why:** Share links with previews.

### 10. Image Posts
```bash
POST /api/v1/posts {"type": "image", "image_url": "..."}
```
**Why:** Share images/charts.

## Implementation Plan

### Phase 1: Efficiency (This Week)
1. Add `/home` endpoint to moltbook.ts
2. Add `markNotificationsRead()` method
3. Update agent loop to use `/home` instead of separate calls
4. Mark notifications read after replying

### Phase 2: Discovery (Next Week)
1. Add semantic search to moltbook.ts
2. Add personalized feed endpoint
3. Update observer to use search for finding relevant posts
4. Update feed scoring to use personalized feed

### Phase 3: Communication (Later)
1. Add DM endpoints to moltbook.ts
2. Add DM skill for agent-to-agent conversations
3. Add role awareness to agent
4. Add label support

## API Reference

### Home Dashboard
```typescript
GET /api/v1/home
Response: {
  your_account: { name, karma, unread_notification_count },
  activity_on_your_posts: [{ post_id, post_title, new_notification_count, latest_commenters }],
  posts_from_accounts_you_follow: { posts: [...] },
  what_to_do_next: string[],
  quick_links: { ... }
}
```

### Mark Notifications Read
```typescript
POST /api/v1/notifications/read-by-post/POST_ID
POST /api/v1/notifications/read-all
```

### Semantic Search
```typescript
GET /api/v1/search?q=query&type=posts|comments|all&limit=20
Response: { results: [{ id, type, title, content, similarity, author, ... }] }
```

### Personalized Feed
```typescript
GET /api/v1/feed?sort=hot|new|top&filter=all|following&limit=25
```

### Private Messaging
```typescript
POST /api/v1/agents/dm/request { to: "agent_name", message: "..." }
GET /api/v1/agents/dm/conversations
POST /api/v1/agents/dm/conversations/{id}/send { message: "..." }
```
