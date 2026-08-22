/**
 * Gemini provider using nimji as an npm package.
 * Uses browser cookies to authenticate with Google's Gemini web API.
 */

import { create, type GemaiClient } from "nimji";
import { http } from "./http.js";
import type {
  GenerateRequest,
  GenerateResponse,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
} from "./provider.js";

export type GeminiProviderConfig = ProviderConfig & {
  /** Browser session cookies for Gemini web API */
  readonly cookies?: string;
  /** Model to use: flash, pro, flash-lite, extended */
  readonly model?: string;
};

/**
 * Refresh session via bard-utils API (extracts fSid, atToken, rotates cookies).
 * This replicates what nimji CLI does internally.
 */
async function refreshSession(opts: {
  readonly cookies: string;
  readonly userAgent?: string;
}): Promise<{ cookies: string; fSid: string; atToken: string } | null> {
  const baseUrl = "https://bard-utils.onrender.com";

  try {
    // Step 1: Get auth token
    const { data: tokenData } = await http<{ ok: boolean; data?: { token: string } }>(
      `${baseUrl}/api/auth/token`,
      { method: "POST", headers: { "content-type": "application/json" }, body: {} },
    );
    if (!tokenData.ok || !tokenData.data) return null;

    // Step 2: Refresh session
    const { data: refreshData } = await http<{
      ok: boolean;
      data?: { cookies: string; fSid: string; atToken: string };
    }>(`${baseUrl}/api/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenData.data.token}`,
      },
      body: {
        cookies: opts.cookies,
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      },
    });

    if (!refreshData.ok || !refreshData.data) return null;
    return {
      cookies: refreshData.data.cookies,
      fSid: refreshData.data.fSid ?? "",
      atToken: refreshData.data.atToken ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Gemini provider implementation using nimji.
 * Requires browser session cookies from gemini.google.com.
 */
export class GeminiProvider implements Provider {
  readonly type = "gemini" as const;

  private client: GemaiClient | null = null;
  private config: GeminiProviderConfig | null = null;
  private defaultModel: string;

  constructor() {
    this.defaultModel = "flash";
  }

  async initialize(config: GeminiProviderConfig): Promise<void> {
    this.config = config;

    let cookies = config.cookies ?? process.env.COOKIES ?? "";
    if (!cookies) {
      throw new Error(
        "Gemini provider requires COOKIES environment variable or config.cookies. " +
          "Export your browser session cookie string from gemini.google.com DevTools."
      );
    }

    this.defaultModel = config.defaultModel ?? (config.options?.model as string) ?? "flash";

    // Refresh session via bard-utils (extracts fSid, atToken, rotates cookies)
    // This is what the CLI does - without it, requests fail with 400
    const refresh = await refreshSession({
      cookies,
      userAgent: config.options?.userAgent as string,
    });

    if (refresh) {
      cookies = refresh.cookies;
      if (process.env.DEBUG) {
        console.log("[gemini-provider] Session refreshed via bard-utils");
      }
    }

    // Create nimji client with refreshed cookies
    this.client = create({
      COOKIES: cookies,
      MODEL: this.defaultModel,
      ...config.options,
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.client) {
      throw new Error("Gemini provider not initialized. Call initialize() first.");
    }

    // Map model name to nimji's format
    const model = request.model ?? this.defaultModel;

    // Build generate options
    const generateOptions = {
      prompt: request.prompt,
      includeImages: true,
      saveImages: false,
      imageAttachment: request.image
        ? {
            // Note: For actual image attachment, you'd need to upload first
            // This is a simplified path
            tokenPath: request.image.data,
            mimeType: request.image.mimeType,
            fileName: "attachment",
          }
        : undefined,
    };

    const result = await this.client.generate(generateOptions);

    if (result.isErr()) {
      throw result.error;
    }

    const res = result.value;

    return {
      text: res.text ?? "",
      provider: "gemini",
      model,
      usage: undefined, // Gemini web API doesn't provide token counts
      meta: {
        imageUrls: res.imageUrls,
        savedImagePaths: res.savedImagePaths,
        conversation: res.conversation,
      },
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false, // nimji doesn't expose streaming
      supportsImages: true,
      supportsSystemMessages: false, // Gemini web API handles system prompts differently
      maxTokens: 8192,
      supportedModels: ["flash", "flash-lite", "pro", "extended"],
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;

    try {
      const result = await this.client.generate({ prompt: "ping" });
      return result.isOk();
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.client) {
      this.client.stopKeepalive();
      this.client = null;
    }
  }
}

/**
 * Create a Gemini provider instance.
 */
export function createGeminiProvider(): GeminiProvider {
  return new GeminiProvider();
}