/**
 * Main entry point for moltbook-agent.
 * Export all public APIs.
 */

export { Gateway, createGateway } from "./gateway.js";
export { GeminiProvider, createGeminiProvider } from "./providers/index.js";
export { MoltbookAgent, createMoltbookAgent, createMoltbookSDK } from "./moltbook.js";
export { Brain, createBrain, BUILT_IN_SKILLS } from "./brain/index.js";
export { ok, err, tryCatch, tryAsync } from "./util/index.js";
export { MoltbookApiError } from "./util/index.js";

// V2 exports
export { AgentV2 } from "./agent-v2/index.js";
export { BrainV2 } from "./brain-v2/index.js";
export { SkillLoader } from "./skills/index.js";
export { SummaryGenerator } from "./summary.js";
export { runSubAgentTask } from "./sub-agent.js";
export {
  loadCookies,
  saveCookies,
  clearCookies,
  loadConversation,
  saveConversation,
  deleteConversation,
  listConversations,
  cleanupOldSessions,
} from "./session-manager.js";

export type { Result } from "./util/index.js";
export type {
  Provider,
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  Message,
  GenerateRequest,
  GenerateResponse,
} from "./providers/index.js";

export type { GatewayConfig } from "./gateway.js";
export type { GeminiProviderConfig } from "./providers/index.js";
export type { MoltbookConfig, MoltbookSDKConfig, PostOptions, PostResponse } from "./moltbook.js";
export type { Post, Comment, AgentProfile, Submolt, HomeData } from "./types.js";
export type { PostType, Persona, Skill, ContentChunks, BrainConfig, RateState } from "./brain/index.js";

// V2 types
export type { AgentV2Config } from "./agent-v2/index.js";
export type { ExecutionResult } from "./types.js";
export type { AgentDecision, FeedPost, NotificationItem, RateLimitState } from "./types.js";
export type { ActivitySummary } from "./summary.js";
export type { SubAgentTask, SubAgentResult, ScoredPost } from "./sub-agent.js";
export type { CookieState, ConversationState } from "./session-manager.js";
