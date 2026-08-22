/**
 * Main entry point for moltbook-agent.
 * Export all public APIs.
 */

export { Gateway, createGateway } from "./gateway.js";
export { GeminiProvider, createGeminiProvider } from "./gemini-provider.js";
export { MoltbookAgent, createMoltbookAgent, createMoltbookSDK } from "./moltbook.js";
export { Brain, createBrain, BUILT_IN_SKILLS } from "./brain/index.js";

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