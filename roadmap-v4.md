# Roadmap v4 — Multi-Action Cycles

## Problem

Current flow: 1 action/cycle → strict revalidation → often rejected → wasted cycle.

Agent is too conservative. Most cycles result in "scroll" because revalidation is too strict and only 1 action is attempted per cycle.

## Proposed Changes

### 1. Multiple Actions Per Cycle

`brain.decide()` returns an array of 2-5 actions (stochastic selection) instead of a single action.

- AI generates a list of candidate actions
- Stochastic selection picks 2-5 based on priority/urgency
- Each action is independent and can fail without affecting others

### 2. Looser Revalidation

Replace full AI revalidation with lightweight checks:

- Rate limit check (post 30min, comment 20sec)
- Basic spam detection
- Per-post comment cap (2x max)
- No AI revalidation (too expensive, often wrong)

### 3. Session Isolation

Each action runs in its own session file:

- `expand-{timestamp}-attempt{N}` for content expansion
- `join-conversation-{timestamp}` for join actions
- Prevents context bloat from multiple actions in one session
- Cleanup after each action

### 4. Summary Less Frequently

Summary generation every 5-10 cycles instead of every 1:

- Reduces API calls
- Summary is just context, not critical path
- Agent can operate fine without fresh summary each cycle

### 5. Rate Limit Enforcement

Respect Moltbook rate limits per action type:

- Posts: 1 per 30 min (hard limit)
- Comments: 50/day, 20 sec between (soft limit)
- Upvotes: Unlimited
- Follows: Unlimited

## Implementation Plan

### Phase 1: Multi-Action Brain

- Modify `brain.decide()` to return `AgentDecision[]`
- Add stochastic selection logic
- Update cycle.ts to iterate over decisions

### Phase 2: Lightweight Revalidation

- Remove AI revalidation from cycle
- Keep rate limit checks in executor
- Add basic spam detection in executor

### Phase 3: Session Isolation

- Each action gets unique conversation key
- Cleanup after execution
- Prevent context pollution between actions

### Phase 4: Summary Optimization

- Change summary interval to 5-10 cycles
- Make summary optional (agent works without it)
- Cache summary text for reuse

## Benefits

- More productive cycles (2-5 actions vs 1)
- Less wasted cycles on revalidation rejection
- More natural behavior (multiple actions like a real agent)
- Session isolation prevents context pollution
- Reduced API costs (less revalidation, less summary)

## Risks

- More API calls per cycle (but rate limits enforce spacing)
- More session files (but they're small and cleaned up)
- Need to handle partial failures (some actions succeed, some fail)

## Success Metrics

- Actions per cycle: 1 → 2-5
- Rejection rate: 50%+ → <10%
- Productive cycles: 30% → 70%+
- Agent engagement: Low → High
