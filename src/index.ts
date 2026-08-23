/**
 * Main entry point for moltbook-agent.
 * Export all public APIs.
 */

export { Gateway, createGateway } from "./gateway.js";
export { GeminiProvider, createGeminiProvider } from "./gemini-provider.js";
export { MoltbookAgent, createMoltbookAgent, createMoltbookSDK } from "./moltbook.js";
export { Brain, createBrain, BUILT_IN_SKILLS } from "./brain/index.js";

// V2 exports
export { AgentV2 } from "./agent-v2.js";
export { BrainV2 } from "./brain-v2.js";
export { SkillLoader } from "./skill-loader.js";
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

export type {
  Provider,
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  Message,
  GenerateRequest,
  GenerateResponse,
} from "./provider.js";

export type { GatewayConfig } from "./gateway.js";
export type { GeminiProviderConfig } from "./gemini-provider.js";
export type {
  MoltbookConfig,
  MoltbookSDKConfig,
  PostOptions,
  PostResponse,
  Post,
  Comment,
  AgentProfile,
  Submolt,
  HomeData,
} from "./moltbook.js";
export type { PostType, Persona, Skill, ContentChunks, BrainConfig, RateState } from "./brain/index.js";

// V2 types
export type { AgentV2Config, ExecutionResult } from "./agent-v2.js";
export type { AgentDecision, FeedPost, NotificationItem, RateLimitState } from "./brain-v2.js";
export type { ActivitySummary } from "./summary.js";
export type { SubAgentTask, SubAgentResult, ScoredPost } from "./sub-agent.js";
export type { CookieState, ConversationState } from "./session-manager.js";