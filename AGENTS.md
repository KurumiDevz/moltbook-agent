# AGENTS.md - Moltbook Agent System Guide

## Overview

Moltbook AI agent — prompt-driven autonomous entity that lives on Moltbook. Uses nimji (Gemini gateway) for AI content generation and interacts with the Moltbook social platform like a real agent.

**This is v2.** Legacy v1 code is preserved in the `legacy-v1` branch.

## Architecture

```
src/
├── index.ts              # Main exports
├── config.ts             # Agent config types, defaults, getConfig()/getBlocked() singletons
├── gateway.ts            # Multi-provider router
├── moltbook.ts           # Moltbook API client + SDK
├── provider.ts           # Provider interface
├── gemini-provider.ts    # Gemini via nimji
├── session-manager.ts    # Conversation persistence, cookie management
├── sub-agent.ts          # AI-powered feed scoring (Gemini + heuristic)
├── summary.ts            # Activity summary generator
├── context7.ts           # Docs integration
├── types.ts              # Shared types
├── brain/                # V2 brain (prompt-driven)
│   ├── brain.ts          # BrainV2 class — decide, generateContent, revalidateDecision
│   ├── prompts.ts        # Pure prompt builders
│   ├── parsers.ts        # Pure JSON parsers
│   ├── types.ts          # BrainV2Config, SKILL_DESCRIPTIONS
│   └── index.ts          # Barrel
├── agent/                # V2 agent (orchestrator)
│   ├── agent.ts          # AgentV2 — thin orchestrator (constructor, start, stop, cycle, dryRun)
│   ├── cycle.ts          # Single cycle logic (gather → filter → score → decide → revalidate → execute)
│   ├── hydration.ts      # Reply count hydration from API on startup
│   ├── context.ts        # Feed, home, search, notification gathering
│   ├── executor.ts       # Action execution (post, comment, reply, upvote, downvote, follow)
│   ├── helpers.ts        # Rate limits, topic dedup, stance tracking, parsing
│   ├── types.ts          # AgentV2Config, MemoryState
│   └── index.ts          # Barrel
├── skills/               # Skill system
│   ├── loader.ts         # SkillLoader — loads SKILL.md + skill files
│   ├── validator.ts      # SkillValidator — validates + drafts skill suggestions
│   └── index.ts          # Barrel
├── http/                 # HTTP client
│   ├── client.ts         # undici wrapper with retry
│   └── index.ts          # Barrel
├── util/                 # Utilities
│   ├── errors.ts         # MoltbookApiError
│   ├── result.ts         # Result<T,E> (Rust-style)
│   └── index.ts          # Barrel
└── providers/            # LLM providers
    ├── types.ts          # Provider interface, GenerateRequest, GenerateResponse
    ├── gemini.ts         # GeminiProvider (nimji)
    └── index.ts          # Barrel
```

## Agent Loop (V2)

```
while running:
  1. GATHER   → feed + notifications + home + semantic search
  2. FILTER   → purge blocked, remove already-replied, per-thread stochastic cap
  3. SCORE    → sub-agent (Gemini + heuristic blend)
  4. DECIDE   → AI selects skill + makes decision (3-phase: select → decide → generate)
  5. VALIDATE → AI revalidates its own decision
  6. EXECUTE  → post, comment, reply, upvote, downvote, follow
  7. RECORD   → update memory, save summary
  8. REST     → 30-120 seconds random pause
```

### Brain V2 (Prompt-Driven)
- **Phase 1**: AI selects which skill to activate (stateless)
- **Phase 2a**: AI makes a structured decision (stateless, no content)
- **Phase 2b**: AI generates content (per-post conversation for comments, per-day for posts)
- **Phase 3**: AI revalidates its own decision (revalidation conversation)
- Skill files define personality, goals, and voice — not hardcoded rules

### Config
- `config.json` — agent name (recommended, not required). Everything else has defaults.
- `blocked.json` — blocked post IDs (operational data)
- `src/config.ts` — types, defaults, `getConfig()` singleton

### Sub-Agent
- AI-powered feed scoring using Gemini with heuristic fallback
- Blend formula: `score = Math.round(heuristic * 0.3 + aiScore * 0.7)`
- Uses own `sub-score` conversation key for isolation

### Session Persistence
- Cookies persisted in `data/gemini-session.json`
- Per-conversation state in `data/sessions/<key>.json`
- Activity summary + task queue in `data/activity-summary.json`
- On restart: load summary → resume task queue → hydrate reply counts from API

## Rate Limits

| Action | Limit | Cooldown |
|--------|-------|----------|
| Posts | 1 per 30 min | 30 min |
| Comments | 50/day | 20 sec |
| Upvotes | Unlimited | - |
| API requests | 100/min | - |

## Scripts

```bash
npm run register    # Register agent
npm run post        # Single post
npm run agent       # Start autonomous agent loop
npm run agent:dry   # Dry run (observe + decide, no actions)
npm run build       # Build TypeScript
```

### Agent CLI Flags

```bash
npm run agent                          # Full autonomous loop
npm run agent -- --submolts general,agents  # Specific submolts only
npm run agent -- --dry-run             # Observe + decide, no execution
npm run agent -- --cycles 10           # Run 10 cycles then exit
```

## Environment

- `COOKIES` — Gemini session cookies (or in config)
- `MOLTBOOK_API_KEY` — Moltbook API key
- `config.json` — agent config (agentName recommended)

## API Quick Reference

### MoltbookAgent
`register`, `getStatus`, `createPost`, `getFeed`, `comment`, `vote`, `follow`, `unfollow`, `getHome`, `getPost`, `listPosts`, `listComments`, `upvoteComment`, `downvoteComment`, `verify`, `getMe`, `listSubmolts`, `getSubmolt`, `search`, `getNotifications`, `markNotificationsRead`

### BrainV2
`decide()`, `generateContent()`, `revalidateDecision()`

### AgentV2
`start()`, `stop()`, `cycle()`, `dryRun()`

## Git Rules

**Commit style**: sentence-case lowercase, `type(scope): summary`, 3-6 bullet body. See `JP/.cursor/rules/commit-and-prose.mdc` for full rules.
**Never auto-push.** Ask user before `git push`. If uncommitted changes exist, include/amend into same commit.
**Build first** — `npm run build` must pass before committing. Stage specific files, never `git add .`.

## Troubleshooting

- **400 from Gemini**: Cookies expired, refresh from DevTools
- **429 Rate Limit**: Wait for cooldown, rate limits tracked in memory
- **Agent stuck**: Config values in config.json, check blocked.json for stale posts
- **Conversation poisoned**: Stale conversations auto-rotated on deploy

## License

MIT
