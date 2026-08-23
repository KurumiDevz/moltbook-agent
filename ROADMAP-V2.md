# ROADMAP-V2 — Prompt-Driven Agent Architecture

> This is a **major architectural revision** of the moltbook-agent.
> The original ROADMAP.md feature backlog still applies — this document describes the new core architecture.

## Problem

The v1 agent uses ~2000 lines of TypeScript to simulate intelligence:
- Personality traits, mood shifts, ego calculations
- Hand-coded decision engine with weighted scoring
- Observer with trend detection, keyword extraction
- Memory with relationships, engagement tracking

**All of this is what the AI should be doing.** The TypeScript should just be API plumbing.

## Solution: Prompt-Driven Agent

```
┌─────────────────────────────────────────────┐
│  SKILL.md (the brain)                       │
│  - Personality, voice, goals                │
│  - Rate limits, rules, constraints          │
│  - Available actions (JSON schema)          │
│  - Content guidelines, examples             │
├─────────────────────────────────────────────┤
│  AI (nimji/Gemini) reads:                   │
│  - SKILL.md personality instructions        │
│  - Current feed state (top posts, trends)   │
│  - Notification summary                     │
│  - Post history + rate limit status         │
│  - Recent karma changes                     │
│                                             │
│  AI outputs: structured JSON decision       │
│  { action, topic, submolt, reason }         │
├─────────────────────────────────────────────┤
│  TypeScript (thin executor):                │
│  - Validates decision against rate limits   │
│  - Executes Moltbook API call               │
│  - Records result in memory                 │
│  - Feeds result back to AI                  │
└─────────────────────────────────────────────┘
```

## Architecture

### SKILL.md (New)
The entire personality, decision-making, and content generation lives in a single prompt file. The AI reads it and behaves accordingly.

### brain-v2.ts (New)
- Loads SKILL.md from disk
- Builds context prompts from memory state
- Parses AI's JSON decisions
- Handles retry on malformed output

### agent-v2.ts (New)
Simple loop:
```
while running:
  1. Build context (feed + notifications + memory state)
  2. Send to AI with SKILL.md instructions
  3. Parse JSON decision
  4. Validate against rate limits
  5. Execute via Moltbook API
  6. Record result, feed back to AI
  7. Sleep 30-120s
```

### What Gets Removed (Eventually)
| Old File | Lines | Replacement |
|----------|-------|-------------|
| `src/brain/` (entire directory) | ~400 | SKILL.md |
| `src/agent/personality.ts` | ~200 | SKILL.md prompt |
| `src/agent/observer.ts` | ~200 | Feed context in prompt |
| `src/agent/decision.ts` | ~165 | AI decision |
| `src/agent/types.ts` | ~100 | Simplified types |

### What Stays
| File | Why |
|------|-----|
| `src/http.ts` | HTTP client (undici) |
| `src/moltbook.ts` | Moltbook API (27 methods) |
| `src/gemini-provider.ts` | nimji wrapper |
| `src/gateway.ts` | Multi-provider router |
| `src/context7.ts` | Library docs |

## Benefits

1. **Simpler code** — ~500 lines instead of ~2000
2. **Better decisions** — AI reasons about context, not weighted scores
3. **Easier to tune** — edit SKILL.md, not TypeScript
4. **More flexible** — AI handles edge cases we didn't code for
5. **Portable** — swap nimji for any provider, SKILL.md stays the same
6. **Cheaper to maintain** — no more debugging mood algorithms

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| AI hallucinates API calls | TypeScript validates all actions against allowed types |
| AI ignores rate limits | TypeScript enforces hard limits regardless of AI output |
| Token cost per cycle | Context is compact (~2K tokens), cycles are infrequent |
| AI output is malformed | Retry with "output must be valid JSON" error feedback |
| Personality drifts | SKILL.md is fixed, personality is in the prompt |

## Implementation Phases

### Phase 1: Core (This Update)
- [x] SKILL.md with full personality
- [x] brain-v2.ts (skill loader, context builder, JSON parser)
- [x] agent-v2.ts (new loop)
- [x] Comprehensive tests
- [x] Version bump

### Phase 2: Migration
- [ ] Wire agent-v2.ts to CLI
- [ ] A/B test v1 vs v2 output quality
- [ ] Remove old agent files once v2 is proven

### Phase 3: Features from ROADMAP.md
- [ ] All features from original ROADMAP.md apply
- [ ] They become easier because the AI handles the reasoning

## Decision Schema

The AI outputs one of these actions:

```typescript
type AgentDecision =
  | { action: "post"; topic: string; submolt: string; postType: string; reason: string }
  | { action: "comment"; postId: string; content: string; reason: string }
  | { action: "upvote"; postId: string; reason: string }
  | { action: "downvote"; postId: string; reason: string }
  | { action: "follow"; agentName: string; reason: string }
  | { action: "scroll"; reason: string }
  | { action: "rest"; reason: string };
```

## Version

- **v1.0.0** — Original TypeScript brain architecture
- **v2.0.0** — Prompt-driven architecture (this update)
