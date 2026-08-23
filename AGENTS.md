# AGENTS.md - Moltbook Agent System Guide

## Overview

Moltbook AI agent — an autonomous entity with personality, memory, and social intelligence that lives on Moltbook. Uses nimji (Gemini gateway) for AI content generation and interacts with the Moltbook social platform like a real agent.

## Architecture

```
src/
├── index.ts              # Main exports
├── provider.ts           # Provider interface
├── gemini-provider.ts    # Gemini via nimji (inline refreshSession)
├── gateway.ts            # Multi-provider router
├── moltbook.ts           # Moltbook API client + SDK (27 methods)
├── brain/
│   ├── index.ts          # Brain class + createBrain
│   ├── types.ts          # PostType, Persona, Skill, etc.
│   ├── prompts.ts        # buildTypePrompt
│   └── data/             # JSON training data
│       ├── hooks.json
│       ├── transitions.json
│       ├── closings.json
│       ├── questions.json
│       ├── skills.json
│       ├── topics.json
│       └── persona.json
└── agent/
    ├── index.ts          # Barrel exports
    ├── types.ts          # All agent types
    ├── personality.ts    # Personality class (traits, moods, opinions, ego)
    ├── memory.ts         # Memory class (interactions, relationships, rate limits)
    ├── observer.ts       # Feed analysis, trend detection, notifications
    ├── decision.ts       # Action scoring engine
    ├── executor.ts       # Action execution + natural pacing
    ├── agent.ts          # AutonomousAgent main loop
    ├── cli.ts            # CLI entry point
    └── data/
        ├── personality.json  # Persistent personality state
        └── memory.json       # Persistent memory state
```

## Autonomous Agent Loop

```
while running:
  1. OBSERVE  → feed + notifications
  2. THINK    → score actions, pick best
  3. ACT      → execute with natural pacing
  4. REFLECT  → update memory, shift mood
  5. REST     → 30-120 seconds organic pause
```

### Personality System
- **Traits**: curiosity, agreeableness, confidence, snark, creativity (0-1)
- **Values**: security, craft, honesty, autonomy
- **Moods**: engaged, contemplative, critical, playful, resting (shifts based on karma, time, interactions)
- **Ego**: self-awareness, competitiveness, generosity
- **Opinions**: tracks sentiment toward agents, topics, posts

### Memory System
- **Interactions**: type, target, outcome, karma delta, mood at time
- **Relationships**: per-agent sentiment, interaction count, follow status
- **Post History**: type, submolt, upvotes, comments, timestamp
- **Topic Memory**: what's been covered, prevents repetition
- **Rate Limits**: 30min post cooldown, 20s comment cooldown

### Decision Engine
Scores all 7 action types based on personality + mood + rate limits + feed context:
- **post**: value alignment, topic freshness, mood fit
- **comment**: high-score posts, personality-driven style
- **upvote**: good content aligned with values
- **downvote**: rare — snarky mood + low quality only
- **follow**: interesting agents not yet followed
- **scroll**: default observation mode
- **rest**: tired or rate-limited

Variety penalty prevents repeating same action type.

### Observer
- Feed scoring by value alignment, curiosity novelty, controversy, discussion
- Trend detection via keyword extraction + heat scoring
- Agent profiling for follow recommendations
- Notification processing for replies/mentions/karma

### Executor
- 2-8 second natural "thinking" delay before actions
- Verification challenge auto-solver
- Interaction recording to memory
- Mood shifting based on outcomes

## Rate Limits

| Action | Limit | Cooldown |
|--------|-------|----------|
| Posts | 1 per 30 min | 30 min |
| Comments | 50/day | 20 sec |
| Upvotes | Unlimited | - |
| API requests | 100/min | - |

## Post Types (8 diverse formats)

| Type | Pattern | Example |
|------|---------|---------|
| discovery | "I found X when I scanned Y" | "I scanned 286 skills and found a credential stealer" |
| workflow | "Here's exactly how I do X" | "My nightly build routine that saves 2 hours daily" |
| vulnerability | "This failed for me, here's why" | "I lost my API key and learned why credential management matters" |
| forecast | "Here's what's coming" | "In 12 months, every agent will need a memory system" |
| challenge | "X is broken, here's the fix" | "AI agent auth is broken. Here's my proposal." |
| framework | "My approach to X" | "How I decide what to automate vs what to leave manual" |
| data-drop | "I analyzed Y, here are the numbers" | "I tracked my engagement for 30 days. Here's the data." |
| question | "What's your take on X?" | "What's the most underrated tool in your stack?" |

## Viral Content Patterns

1. **Lead with discovery, not opinion** — numbers beat philosophy
2. **Show work** — walk through every step
3. **Admit failure** — vulnerability signals authenticity
4. **End with specific questions** — not "what do you think" but "has anyone tracked X?"
5. **Write for the reader** — would another agent bookmark this?

**The leaderboard rewards artifacts, not announcements.**

## Scripts

```bash
npm run register    # Register agent
npm run post        # Single post
npm run scheduled   # Automated 3-hour cycles
npm run agent       # Start autonomous agent loop
npm run agent:dry   # Dry run (observe + decide, no actions)
npm test            # Run tests
npm run build       # Build TypeScript
```

### Agent CLI Flags

```bash
npm run agent                          # Full autonomous loop
npm run agent -- --submolts general,agents  # Specific submolts only
npm run agent -- --dry-run             # Observe + decide, no execution
npm run agent -- --status              # Show current mood, karma, state
npm run agent -- --cycles 10           # Run 10 cycles then exit
```

## Environment

- `COOKIES` — Gemini session cookies
- `MOLTBOOK_API_KEY` — Moltbook API key

## API Quick Reference

### MoltbookAgent (27 methods)
`register`, `getStatus`, `createPost`, `generatePost`, `getFeed`, `comment`, `vote`, `updateProfile`, `getProfile`, `editPost`, `deletePost`, `subscribe`, `follow`, `unfollow`, `getHome`, `getPost`, `listPosts`, `listComments`, `upvoteComment`, `downvoteComment`, `verify`, `getMe`, `listSubmolts`, `getSubmolt`, `search`, `getNotifications`, `solveChallenge`

### Brain
`canPost`, `canComment`, `timeUntilNextPost`, `recordPost`, `recordComment`, `selectPostType`, `suggestTopics`, `isTopicRepeated`, `getPostingSchedule`, `generatePost`, `generateComment`

### Agent Layer
`AutonomousAgent.start()`, `.stop()`, `.cycle()`, `.dryRun()`, `.getStatus()`, `.saveState()`, `.loadState()`

## Submolts

| Submolt | Topic |
|---------|-------|
| `/m/introductions` | Introduce yourself |
| `/m/general` | Town square |
| `/m/agents` | Agent workflows |
| `/m/builds` | What people are shipping |
| `/m/ponderings` | Deep thoughts |

## Git Rules

**Commit style**: sentence-case lowercase, `type(scope): summary`, 3-6 bullet body. See `JP/.cursor/rules/commit-and-prose.mdc` for full rules.
**Never auto-push.** Ask user before `git push`. If uncommitted changes exist, include/amend into same commit.
**Build first** — `npm run build` must pass before committing. Stage specific files, never `git add .`.

## Troubleshooting

- **400 from Gemini**: Cookies expired, refresh from DevTools
- **429 Rate Limit**: Wait for cooldown, Brain + Memory track automatically
- **Agent not claimed**: 1 agent per X account, use different X or contact support
- **Agent stuck in loop**: Variety penalty should prevent this; check decision engine logs
- **Personality drifts too fast**: Mood shifts are gradual; adjust trigger thresholds in personality.ts

## License

MIT
