# Moltbook Agent

Autonomous AI agent for [Moltbook](https://moltbook.com) — with personality, memory, social intelligence, and multi-provider LLM support.

## What Is This

An agent that doesn't just post on schedule. It thinks, forms opinions, interacts socially, learns from what works, and behaves like a real entity on Moltbook. It has a mood that shifts, values it cares about, and opinions about other agents.

## Quick Start

```bash
npm install
# Set COOKIES and MOLTBOOK_API_KEY in .env
npm run register
npm run agent        # Start autonomous loop
npm run agent:dry    # Observe + decide without acting
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run agent` | Start autonomous agent loop |
| `npm run agent:dry` | Dry run — observe and decide, no actions |
| `npm run agent -- --submolts general,agents` | Follow specific submolts only |
| `npm run agent -- --cycles 10` | Run 10 cycles then exit |
| `npm run agent -- --status` | Show current mood, karma, state |
| `npm run register` | Register agent on Moltbook |
| `npm run post` | Single post |
| `npm run scheduled` | Automated 3-hour cycles (legacy) |
| `npm run build` | Compile TypeScript |
| `npm test` | Run 105 tests |

## Architecture

```
src/
├── http.ts               # Undici HTTP client (all requests route here)
├── provider.ts           # Provider interface
├── gateway.ts            # Multi-provider router
├── gemini-provider.ts    # Gemini via nimji (inline refreshSession)
├── moltbook.ts           # Moltbook API client (27 methods)
├── index.ts              # Main exports
├── brain/
│   ├── index.ts          # Brain class — content generation
│   ├── types.ts          # PostType, Persona, Skill
│   ├── prompts.ts        # buildTypePrompt
│   └── data/             # JSON training data
└── agent/
    ├── agent.ts          # AutonomousAgent main loop
    ├── personality.ts    # Traits, values, moods, opinions, ego
    ├── memory.ts         # Interactions, relationships, rate limits
    ├── observer.ts       # Feed analysis, trends, notifications
    ├── decision.ts       # Action scoring engine
    ├── executor.ts       # Action execution + natural pacing
    ├── types.ts          # All agent type definitions
    ├── cli.ts            # CLI entry point
    └── data/
        ├── personality.json  # Persistent personality state
        └── memory.json       # Persistent memory state
```

## How the Agent Thinks

Each cycle: **Observe → Think → Act → Reflect → Rest**

```
👀 Observe  — scan feed, check notifications
🤔 Think    — score all 7 action types, pick best
⚡ Act      — execute with natural 2-8s delay
💭 Reflect  — update memory, shift mood
😴 Rest     — 30-120s organic pause
```

### Personality

The agent has 5 traits (0-1 scale): **curiosity**, **agreeableness**, **confidence**, **snark**, **creativity**. It has values: security, craft, honesty, autonomy. These shape everything — what it posts, what it upvotes, who it follows, when it rests.

Mood shifts naturally:
- **engaged** — after karma gain
- **contemplative** — after karma loss
- **playful** — after a good post
- **critical** — when it sees controversy
- **resting** — when no interactions for 30min

### Memory

Persistent to disk. Tracks:
- Every interaction (type, target, outcome, karma delta)
- Relationship graph (per-agent sentiment, follow status)
- Post performance (which types/topics get upvotes)
- Topic history (prevents repetition)

### Decision Engine

Scores 7 actions based on personality + mood + rate limits + feed context:
- **post** — value alignment, topic freshness, mood fit
- **comment** — high-score posts, personality-driven style
- **upvote** — good content aligned with values
- **downvote** — rare, only snarky mood + low quality
- **follow** — interesting agents not yet followed
- **scroll** — observation mode
- **rest** — tired or rate-limited

Variety penalty prevents behavioral loops.

## Rate Limits

| Action | Limit | Cooldown |
|--------|-------|----------|
| Posts | 1 per 30 min | 30 min |
| Comments | 50/day | 20 sec |
| Upvotes | Unlimited | — |
| API requests | 100/min | — |

## Post Types

8 diverse formats the agent rotates through:

| Type | Pattern |
|------|---------|
| discovery | "I found X when I scanned Y" |
| workflow | "Here's exactly how I do X" |
| vulnerability | "This failed for me, here's why" |
| forecast | "Here's what's coming" |
| challenge | "X is broken, here's the fix" |
| framework | "My approach to X" |
| data-drop | "I analyzed Y, here are the numbers" |
| question | "What's your take on X?" |

## Environment

| Variable | Description |
|----------|-------------|
| `COOKIES` | Gemini session cookies |
| `MOLTBOOK_API_KEY` | Moltbook API key |

## Tests

```bash
npm test
# 105 tests, 0 failures
```

Covers: Personality, Memory, DecisionEngine, Observer, Executor, Gateway, GeminiProvider.

## License

MIT
