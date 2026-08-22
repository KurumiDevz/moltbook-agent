# Moltbook Autonomous Agent - Roadmap

**Project:** Transform moltbook-agent from scheduled poster to autonomous AI agent
**Started:** 2026-08-22
**Goal:** An agent that thinks, has ego, interacts socially, and behaves like a real entity on Moltbook

---

## Phase 1: Core Agent Infrastructure
**Target:** 2026-08-22 | **Completed:** 2026-08-23 01:50 AM

- [x] Create `src/agent/` directory structure
- [x] `personality.ts` — Ego, traits, values, moods, opinions
- [x] `memory.ts` — Interaction history, relationship graph, post performance
- [x] `types.ts` — All agent type definitions
- [x] `data/personality.json` — Default personality state
- [x] `data/memory.json` — Default memory state

## Phase 2: Personality System
**Target:** 2026-08-22 | **Completed:** 2026-08-23 01:50 AM

- [x] Trait system: curiosity, agreeableness, confidence, snark (0-1)
- [x] Value system: what the agent cares about (security, craft, honesty, autonomy)
- [x] Mood engine: engaged / contemplative / critical / playful / resting (shifts over time)
- [x] Opinion tracking: beliefs about agents, topics, posts
- [x] Ego model: self-awareness, competitiveness, generosity
- [x] Personality-driven action weighting
- [x] Mood shifts: karma_gain → engaged, karma_loss → contemplative, good_post → playful, time_pass → resting, controversy → critical

## Phase 3: Memory System
**Target:** 2026-08-22 | **Completed:** 2026-08-23 01:50 AM

- [x] Interaction memory: who, what, when, outcome, karma delta
- [x] Relationship graph: agent → sentiment, interaction count, last seen
- [x] Post performance tracking: which types/topics get upvotes
- [x] Topic memory: what's been covered, how recently
- [x] Learning: adjust behavior based on what works
- [x] Rate limiting: 30min post cooldown, 20s comment cooldown

## Phase 4: Decision Engine
**Target:** 2026-08-22 | **Completed:** 2026-08-23 02:45 AM

- [x] Action candidates: post, comment, upvote, downvote, follow, scroll, rest
- [x] Scoring function: personality + mood + rate limits + feed context + memory
- [x] Variety penalty: avoids repeating same action type
- [x] Priority queue: what to do RIGHT NOW vs later
- [x] Boredom/rest: agent doesn't act 24/7, has quiet periods
- [x] Mood-based comment style: sassy for critical/snarky, questions for contemplative

## Phase 5: Observer
**Target:** 2026-08-22 | **Completed:** 2026-08-23 02:30 AM

- [x] Feed reader: get hot/new/top posts via MoltbookAgent.getFeed()
- [x] Post scoring: value alignment, curiosity novelty, controversy detection, discussion activity
- [x] Trend detection: keyword extraction + heat scoring
- [x] Agent profiling: who's interesting, who to follow
- [x] Notification processing: replies, mentions, karma changes

## Phase 6: Executor
**Target:** 2026-08-22 | **Completed:** 2026-08-23 02:45 AM

- [x] Natural action timing: 2-8 second "thinking" pause
- [x] Rate limit respect: built into pacing
- [x] Action logging: what was done, result
- [x] Error handling: mood shift on failure
- [x] Verification challenge solver: auto-solve comment challenges

## Phase 7: Integration & CLI
**Target:** 2026-08-22 | **Completed:** 2026-08-23 03:00 AM

- [x] Wire up Brain (content gen) + MoltbookAgent (API) + Observer + DecisionEngine + Executor
- [x] CLI entry point: `npm run agent` starts autonomous loop
- [x] CLI flags: `--submolts`, `--dry-run`, `--status`, `--cycles N`
- [x] Graceful shutdown: save state on exit (SIGINT handler)
- [x] State persistence: save/load memory and personality to disk
- [x] package.json scripts: `agent`, `agent:dry`

## Phase 8: Polish & Testing
**Target:** TBD

- [ ] Unit tests for decision engine
- [ ] Integration test: run agent for 1 hour, verify it does varied things
- [ ] Remove old `scheduled.ts` (or keep as legacy)
- [x] Update AGENTS.md with new architecture
- [x] Update package.json scripts

---

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│           AutonomousAgent               │
│  src/agent/agent.ts (main loop)         │
│                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │Personality│  │  Memory   │  │ Mood  │ │
│  │  traits   │  │ history  │  │ engine│ │
│  │  values   │  │ relations│  │       │ │
│  │  ego      │  │ learning │  │       │ │
│  └─────┬────┘  └─────┬────┘  └───┬───┘ │
│        │             │           │      │
│        └──────┬──────┘───────────┘      │
│               │                         │
│        ┌──────▼──────┐                  │
│        │  Observer    │                  │
│        │ (feed read)  │                  │
│        └──────┬──────┘                  │
│               │                         │
│        ┌──────▼──────┐                  │
│        │  Decision    │                  │
│        │  Engine      │                  │
│        │ (score+pick) │                  │
│        └──────┬──────┘                  │
│               │                         │
│        ┌──────▼──────┐                  │
│        │  Executor    │                  │
│        │ (act+log)    │                  │
│        └──────┬──────┘                  │
└───────────────┼─────────────────────────┘
         │                    │
    ┌────▼────┐         ┌────▼────┐
    │  Brain  │         │Moltbook │
    │(content)│         │ Agent   │
    └─────────┘         │  (API)  │
                        └─────────┘
```

## File Map

| File | Lines | Purpose |
|------|-------|---------|
| `src/agent/types.ts` | ~90 | All type definitions |
| `src/agent/personality.ts` | ~105 | Personality class (traits, moods, opinions) |
| `src/agent/memory.ts` | ~108 | Memory class (interactions, relationships, rate limits) |
| `src/agent/observer.ts` | ~186 | Feed analysis, trends, notifications |
| `src/agent/decision.ts` | ~130 | Action scoring + selection |
| `src/agent/executor.ts` | ~99 | Action execution + pacing |
| `src/agent/agent.ts` | ~219 | AutonomousAgent main loop |
| `src/agent/cli.ts` | ~106 | CLI entry point |
| `src/agent/index.ts` | ~15 | Barrel exports |
| `src/agent/data/*.json` | - | Persistent state (personality + memory) |

## Usage

```bash
# Start autonomous agent
npm run agent

# Dry run (observe + decide, no actions)
npm run agent:dry

# Run specific submolts
npm run agent -- --submolts general,agents

# Run 10 cycles then exit
npm run agent -- --cycles 10

# Check status
npm run agent -- --status
```

## Key Design Decisions

1. **Personality affects everything** — not just post style, but what it votes on, who it follows, when it rests
2. **Memory is persistent** — saves to disk, learns over days/weeks
3. **Mood shifts naturally** — based on karma feedback, time of day, what it's seen
4. **Pacing is organic** — not "every 3 hours", but "when I have something to say" (30-120s between cycles)
5. **The agent has opinions** — it doesn't just upvote everything, it has tastes
6. **Variety is enforced** — decision engine penalizes repeating same action type
