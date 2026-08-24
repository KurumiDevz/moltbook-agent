# Roadmap v3: Modular Refactoring of brain-v2 and agent-v2

## Goal

Refactor `brain-v2.ts` (869 lines, 15 methods) and `agent-v2.ts` (1184 lines, 23 methods) into modular directories following the same pattern as v1's `src/agent/` structure. Zero behavior change — every function stays identical, same logic, same side effects.

## Why Modular

- **No redundancy** — shared utilities live in one place, not copy-pasted
- **Easier debugging** — isolated modules = isolated context when investigating
- **Smaller context windows** — AI reads one module, not 1000+ lines
- **Parallel development** — work on prompts without touching executor
- **Testability** — pure functions (prompts, parsers) are trivially unit-testable
- **Maintainability** — new team members find things fast

---

## Current State

| File | Lines | Methods | Categories |
|------|-------|---------|------------|
| `brain-v2.ts` | 869 | 15 | 5 prompt builders, 5 parsers, 1 pure logic, 4 API-calling |
| `agent-v2.ts` | 1184 | 23 | 2 init, 4 main loop, 4 context, 8 executor, 2 rate-limit, 3 helpers |

## Target Structure

### `src/brain-v2/`

```
brain-v2/
├── index.ts      — barrel re-exports
├── brain.ts      — BrainV2 class (constructor, decide, generateContent, revalidateDecision, fetchContext7Docs, needsContentGeneration)
├── prompts.ts    — 5 pure prompt builders (buildBaseContext, buildSkillSelectionPrompt, buildDecisionPrompt, buildContentPrompt, buildRevalidationPrompt)
├── parsers.ts    — 5 pure parsers + validateDecision (parseSkillSelection, parseDecision, validateDecision, parseContentResponse, parseRevalidation)
└── types.ts      — BrainV2Config type, SKILL_DESCRIPTIONS const
```

| Module | What moves there | Lines (est) |
|--------|-----------------|-------------|
| `types.ts` | `BrainV2Config`, `SKILL_DESCRIPTIONS` | ~30 |
| `prompts.ts` | `buildBaseContext`, `buildSkillSelectionPrompt`, `buildDecisionPrompt`, `buildContentPrompt`, `buildRevalidationPrompt` | ~280 |
| `parsers.ts` | `parseSkillSelection`, `parseDecision`, `validateDecision`, `parseContentResponse`, `parseRevalidation` | ~200 |
| `brain.ts` | `BrainV2` class: constructor + `decide` + `generateContent` + `revalidateDecision` + `fetchContext7Docs` + `needsContentGeneration` | ~350 |
| `index.ts` | Re-exports `BrainV2`, `BrainV2Config` | ~5 |

### `src/agent-v2/`

```
agent-v2/
├── index.ts      — barrel re-exports
├── agent.ts      — AgentV2 class (constructor, start, stop, cycle, dryRun)
├── context.ts    — 4 fetch methods (fetchFeed, fetchHome, fetchRelevantPosts, fetchNotifications)
├── executor.ts   — 8 execute methods (execute, executePost, executeComment, executeReplyToComment, executeUpvote, executeDownvote, executeFollow, executeSkillSuggestion)
├── helpers.ts    — hydrateReplyCounts, getRateLimits, isTopicRecent, recordForeignStance, parseTitleBody, sleep
└── types.ts      — AgentV2Config, MemoryState
```

| Module | What moves there | Lines (est) |
|--------|-----------------|-------------|
| `types.ts` | `AgentV2Config`, `MemoryState` | ~40 |
| `helpers.ts` | `hydrateReplyCounts`, `getRateLimits`, `isTopicRecent`, `recordForeignStance`, `parseTitleBody`, `sleep` | ~150 |
| `context.ts` | `fetchFeed`, `fetchHome`, `fetchRelevantPosts`, `fetchNotifications` | ~200 |
| `executor.ts` | `execute`, `executePost`, `executeComment`, `executeReplyToComment`, `executeUpvote`, `executeDownvote`, `executeFollow`, `executeSkillSuggestion` | ~300 |
| `agent.ts` | `AgentV2` class: constructor + `start` + `stop` + `cycle` + `dryRun` | ~500 |
| `index.ts` | Re-exports `AgentV2`, `AgentV2Config`, `ExecutionResult` | ~5 |

---

## Constraints

1. **Zero behavior change** — every function stays identical (same logic, same side effects)
2. **Same public API** — `BrainV2` and `AgentV2` classes keep identical constructor signatures and method signatures
3. **Imports from external files update** — `./brain-v2.js` → `./brain-v2/index.js`, same for agent
4. **No new dependencies** — only file moves + imports
5. **Build must pass** — `npm run build` green before commit
6. **No logic changes** — if something is broken before, it stays broken after

---

## Execution Steps

### Phase 1: Setup
- [ ] 1.1 Create branch `refactor/modular-v2` from master
- [ ] 1.2 Create `src/brain-v2/` and `src/agent-v2/` directories

### Phase 2: brain-v2 modular
- [ ] 2.1 Create `src/brain-v2/types.ts` — move `BrainV2Config`, `SKILL_DESCRIPTIONS`
- [ ] 2.2 Create `src/brain-v2/prompts.ts` — move all 5 prompt builders
- [ ] 2.3 Create `src/brain-v2/parsers.ts` — move all 5 parsers
- [ ] 2.4 Create `src/brain-v2/brain.ts` — BrainV2 class with remaining methods
- [ ] 2.5 Create `src/brain-v2/index.ts` — barrel re-exports
- [ ] 2.6 Build + verify brain-v2 compiles

### Phase 3: agent-v2 modular
- [ ] 3.1 Create `src/agent-v2/types.ts` — move `AgentV2Config`, `MemoryState`
- [ ] 3.2 Create `src/agent-v2/helpers.ts` — move 6 helper methods
- [ ] 3.3 Create `src/agent-v2/context.ts` — move 4 fetch methods
- [ ] 3.4 Create `src/agent-v2/executor.ts` — move 8 execute methods
- [ ] 3.5 Create `src/agent-v2/agent.ts` — AgentV2 class with remaining methods
- [ ] 3.6 Create `src/agent-v2/index.ts` — barrel re-exports
- [ ] 3.7 Build + verify agent-v2 compiles

### Phase 4: External import updates
- [ ] 4.1 Update `src/cli.ts` — change imports from `./brain-v2.js` → `./brain-v2/index.js`
- [ ] 4.2 Update `src/cli.ts` — change imports from `./agent-v2.js` → `./agent-v2/index.js`
- [ ] 4.3 Update any other files importing from `brain-v2.js` or `agent-v2.js`
- [ ] 4.4 Full build + verify

### Phase 5: Cleanup
- [ ] 5.1 Delete old `src/brain-v2.ts` monolithic file
- [ ] 5.2 Delete old `src/agent-v2.ts` monolithic file
- [ ] 5.3 Final build + verify
- [ ] 5.4 Run agent to confirm no runtime errors
- [ ] 5.5 Commit + push to `refactor/modular-v2` branch

---

## Import Migration Map

| Old Import | New Import |
|------------|-----------|
| `import { BrainV2 } from "./brain-v2.js"` | `import { BrainV2 } from "./brain-v2/index.js"` |
| `import type { BrainV2Config } from "./brain-v2.js"` | `import type { BrainV2Config } from "./brain-v2/index.js"` |
| `import { AgentV2 } from "./agent-v2.js"` | `import { AgentV2 } from "./agent-v2/index.js"` |
| `import type { AgentV2Config } from "./agent-v2.js"` | `import type { AgentV2Config } from "./agent-v2/index.js"` |
| `import { ExecutionResult } from "./agent-v2.js"` | `import { ExecutionResult } from "./agent-v2/index.js"` |

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Import path changes break build | TypeScript compiler catches all errors immediately |
| Circular imports between modules | Brain-v2 modules are pure functions (no circular deps). Agent-v2 modules import from each other in one direction only. |
| Missing method in module move | Build fails → fix |
| Behavior changes accidentally | No logic changes allowed — only file moves + imports |
| External consumers break | Update all imports in Phase 4 before deleting old files |

---

## Verification Checklist

- [ ] `npm run build` passes after each phase
- [ ] `BrainV2` class constructor signature unchanged
- [ ] `BrainV2.decide()` method signature unchanged
- [ ] `BrainV2.revalidateDecision()` method signature unchanged
- [ ] `AgentV2` class constructor signature unchanged
- [ ] `AgentV2.start()` method signature unchanged
- [ ] `AgentV2.cycle()` method signature unchanged
- [ ] `AgentV2.dryRun()` method signature unchanged
- [ ] All external imports updated (cli.ts, index.ts, etc.)
- [ ] Old monolithic files deleted
- [ ] Agent runs without runtime errors
- [ ] Git commit + push to `refactor/modular-v2` branch
