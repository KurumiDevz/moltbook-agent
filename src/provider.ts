/**
 * Provider interface for multi-provider LLM gateway.
 * Each provider implements this interface to support different LLM backends.
 */

/** Supported provider types */
export type ProviderType = "gemini" | "openai" | "anthropic" | "ollama" | "custom";

/** Message format for multi-turn conversations */
export type Message = {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  /** Optional image attachment (base64 or URL) */
  readonly image?: {
    readonly type: "base64" | "url";
    readonly data: string;
    readonly mimeType: string;
  };
};

/** Provider capabilities */
export type ProviderCapabilities = {
  readonly supportsStreaming: boolean;
  readonly supportsImages: boolean;
  readonly supportsSystemMessages: boolean;
  readonly maxTokens: number;
  readonly supportedModels: readonly string[];
};

/** Options for generate request */
export type GenerateRequest = {
  /** The prompt or message */
  readonly prompt: string;
  /** Optional conversation history for multi-turn */
  readonly messages?: readonly Message[];
  /** Model to use (provider-specific) */
  readonly model?: string;
  /** Max tokens in response */
  readonly maxTokens?: number;
  /** Temperature (0-1) */
  readonly temperature?: number;
  /** Whether to stream the response */
  readonly stream?: boolean;
  /** Optional image to attach */
  readonly image?: Message["image"];
  /** Conversation key — different keys = different conversation threads */
  readonly conversationKey?: string;
};

/** Response from provider */
export type GenerateResponse = {
  /** The generated text */
  readonly text: string;
  /** Provider used */
  readonly provider: ProviderType;
  /** Model used */
  readonly model: string;
  /** Usage stats if available */
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
  /** Metadata from the provider */
  readonly meta?: Record<string, unknown>;
};

/** Provider configuration */
export type ProviderConfig = {
  /** Provider type */
  readonly type: ProviderType;
  /** API key or credentials */
  readonly apiKey?: string;
  /** Base URL for API (for custom/self-hosted) */
  readonly baseUrl?: string;
  /** Default model to use */
  readonly defaultModel?: string;
  /** Additional provider-specific config */
  readonly options?: Record<string, unknown>;
};

/**
 * Provider interface that all LLM providers must implement.
 */
export interface Provider {
  /** Provider type identifier */
  readonly type: ProviderType;

  /** Initialize the provider with config */
  initialize(config: ProviderConfig): Promise<void>;

  /** Generate a response */
  generate(request: GenerateRequest): Promise<GenerateResponse>;

  /** Stream a response (optional, providers can throw if not supported) */
  stream?(request: GenerateRequest): AsyncIterable<string>;

  /** Get provider capabilities */
  getCapabilities(): ProviderCapabilities;

  /** Check if provider is healthy */
  healthCheck(): Promise<boolean>;

  /** Cleanup resources */
  dispose(): Promise<void>;
}
