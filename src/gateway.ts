/**
 * Gateway router for multi-provider LLM access.
 * Routes requests to the appropriate provider based on model name or explicit provider selection.
 */

import type { GenerateRequest, GenerateResponse, Provider, ProviderType } from "./provider.js";

export type GatewayConfig = {
  /** Default provider to use when not specified */
  readonly defaultProvider?: ProviderType;
  /** Fallback order if primary provider fails */
  readonly fallbackOrder?: readonly ProviderType[];
  /** Timeout for requests in milliseconds */
  readonly timeoutMs?: number;
};

/**
 * Gateway that manages multiple LLM providers and routes requests.
 */
export class Gateway {
  private providers = new Map<ProviderType, Provider>();
  private config: GatewayConfig;
  private initialized = new Set<ProviderType>();

  constructor(config: GatewayConfig = {}) {
    this.config = {
      defaultProvider: "gemini",
      fallbackOrder: ["gemini"],
      timeoutMs: 60_000,
      ...config,
    };
  }

  /**
   * Register a provider with the gateway.
   */
  registerProvider(provider: Provider): void {
    this.providers.set(provider.type, provider);
  }

  /**
   * Initialize a specific provider or all registered providers.
   */
  async initializeProvider(type: ProviderType, config: Parameters<Provider["initialize"]>[0]): Promise<void> {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Provider "${type}" not registered. Available: ${this.getAvailableProviders().join(", ")}`);
    }

    await provider.initialize(config);
    this.initialized.add(type);
  }

  /**
   * Initialize all registered providers with their configs.
   */
  async initializeAll(configs: Record<ProviderType, Parameters<Provider["initialize"]>[0]>): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [type] of this.providers) {
      const config = configs[type];
      if (config) {
        promises.push(this.initializeProvider(type, config));
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * Generate a response using the specified or default provider.
   */
  async generate(request: GenerateRequest, providerType?: ProviderType): Promise<GenerateResponse> {
    const targetProvider = providerType ?? this.resolveProvider(request);

    // Try primary provider
    try {
      return await this.generateWithProvider(targetProvider, request);
    } catch (primaryError) {
      // If fallback is enabled, try other providers
      if (this.config.fallbackOrder && this.config.fallbackOrder.length > 1) {
        for (const fallbackType of this.config.fallbackOrder) {
          if (fallbackType === targetProvider) continue;

          try {
            return await this.generateWithProvider(fallbackType, request);
          } catch {
            // Continue to next fallback
          }
        }
      }

      throw primaryError;
    }
  }

  /**
   * Generate using a specific provider with timeout.
   */
  private async generateWithProvider(type: ProviderType, request: GenerateRequest): Promise<GenerateResponse> {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Provider "${type}" not registered`);
    }

    if (!this.initialized.has(type)) {
      throw new Error(`Provider "${type}" not initialized. Call initializeProvider() first.`);
    }

    const timeout = this.config.timeoutMs ?? 60_000;

    return Promise.race([
      provider.generate(request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Provider "${type}" timeout after ${timeout}ms`)), timeout),
      ),
    ]);
  }

  /**
   * Resolve which provider to use based on request model or default.
   */
  private resolveProvider(request: GenerateRequest): ProviderType {
    // If model is specified, try to find a provider that supports it
    if (request.model) {
      for (const [type] of this.providers) {
        if (!this.initialized.has(type)) continue;

        const providerInstance = this.providers.get(type);
        if (!providerInstance) continue;
        const caps = providerInstance.getCapabilities();
        if (caps.supportedModels.includes(request.model)) {
          return type;
        }
      }
    }

    // Use default provider
    return this.config.defaultProvider ?? "gemini";
  }

  /**
   * Get list of available (registered) providers.
   */
  getAvailableProviders(): ProviderType[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get list of initialized providers.
   */
  getInitializedProviders(): ProviderType[] {
    return Array.from(this.initialized);
  }

  /**
   * Get capabilities of a specific provider.
   */
  getProviderCapabilities(type: ProviderType): ProviderCapabilities | undefined {
    return this.providers.get(type)?.getCapabilities();
  }

  /**
   * Health check all initialized providers.
   */
  async healthCheck(): Promise<Record<ProviderType, boolean>> {
    const results: Record<ProviderType, boolean> = {} as Record<ProviderType, boolean>;

    const checks: Promise<void>[] = [];

    for (const [type, provider] of this.providers) {
      if (!this.initialized.has(type)) {
        results[type] = false;
        continue;
      }

      checks.push(
        provider.healthCheck().then((healthy) => {
          results[type] = healthy;
        }),
      );
    }

    await Promise.allSettled(checks);
    return results;
  }

  /**
   * Dispose all providers and cleanup resources.
   */
  async dispose(): Promise<void> {
    const disposePromises: Promise<void>[] = [];

    for (const provider of this.providers.values()) {
      disposePromises.push(provider.dispose());
    }

    await Promise.allSettled(disposePromises);
    this.initialized.clear();
  }
}

/**
 * Create a new Gateway instance.
 */
export function createGateway(config?: GatewayConfig): Gateway {
  return new Gateway(config);
}

import type { ProviderCapabilities } from "./provider.js";
