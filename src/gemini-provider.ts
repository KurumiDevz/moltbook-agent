/**
 * Gemini provider using nimji as an npm package.
 * Uses browser cookies to authenticate with Google's Gemini web API.
 *
 * Mirrors nimji CLI behavior:
 * - Session store persistence (session.json) for conversation continuity
 * - Retry with fresh client on partial streams
 * - Session recovery: reset conversation + retry when stuck
 * - Keepalive timer to prevent session expiry
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
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

/** Session state persisted to disk */
interface SessionState {
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
  cookies?: string;
  fSid?: string;
  atToken?: string;
  updatedAt?: string;
}

const SESSION_DIR = path.resolve(process.cwd(), "data");
const SESSION_FILE = path.resolve(SESSION_DIR, "gemini-session.json");

// ─── Session store (mirrors nimji CLI's createSessionStore) ───

function loadSession(): SessionState {
  try {
    if (existsSync(SESSION_FILE)) {
      return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveSession(state: SessionState): void {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  } catch { /* ignore */ }
}

function clearSession(): void {
  saveSession({});
}

// ─── Session refresh via bard-utils ───

async function refreshSession(opts: {
  readonly cookies: string;
  readonly userAgent?: string;
}): Promise<{ cookies: string; fSid: string; atToken: string } | null> {
  const baseUrl = "https://bard-utils.onrender.com";
  const ua = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";

  try {
    const { data: tokenData } = await http<{ ok: boolean; data?: { token: string } }>(
      `${baseUrl}/api/auth/token`,
      { method: "POST", headers: { "content-type": "application/json", "x-nimji-ua": ua }, body: {} },
    );
    if (!tokenData.ok || !tokenData.data) return null;

    const { data: refreshData } = await http<{
      ok: boolean;
      data?: { cookies: string; fSid: string; atToken: string };
    }>(`${baseUrl}/api/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenData.data.token}`,
        "x-nimji-ua": ua,
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

// ─── Response quality classification (from nimji CLI) ───

function classifyResponse(value: { text: string | null; meta: { statusCode: number; chunkCount: number; rawSize: number } }): string {
  if (value.meta.statusCode !== 200) return "partial_stream";
  if (value.meta.chunkCount <= 1 || value.meta.rawSize < 220) return "partial_stream";
  if (!value.text || value.text.trim().length === 0) return "no_text";
  return "none";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Gemini provider ───

export class GeminiProvider implements Provider {
  readonly type = "gemini" as const;

  private client: GemaiClient | null = null;
  private config: GeminiProviderConfig | null = null;
  private defaultModel: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private effectiveCookies: string = "";
  private effectiveFSid: string = "";
  private effectiveAtToken: string = "";

  constructor() {
    this.defaultModel = "flash";
  }

  async initialize(config: GeminiProviderConfig): Promise<void> {
    this.config = config;

    let cookies = config.cookies ?? (config.options?.cookies as string) ?? process.env.COOKIES ?? "";
    if (!cookies) {
      throw new Error(
        "Gemini provider requires COOKIES environment variable or config.cookies. " +
          "Export your browser session cookie string from gemini.google.com DevTools."
      );
    }

    this.defaultModel = config.defaultModel ?? (config.options?.model as string) ?? "flash";

    // Load persisted session if available
    const saved = loadSession();

    // Refresh session via bard-utils (extracts fSid, atToken, rotates cookies)
    const refresh = await refreshSession({
      cookies,
      userAgent: config.options?.userAgent as string,
    });

    if (refresh) {
      cookies = refresh.cookies;
      saveSession({ ...saved, cookies: refresh.cookies, fSid: refresh.fSid, atToken: refresh.atToken });
      if (process.env.DEBUG) {
        console.log("[gemini-provider] Session refreshed via bard-utils");
      }
    }

    this.effectiveCookies = cookies;
    this.effectiveFSid = refresh?.fSid ?? "";
    this.effectiveAtToken = refresh?.atToken ?? "";

    // Create nimji client with refreshed cookies + auth tokens
    // nimji requires AT_TOKEN and F_SID for authenticated requests
    // Increase stream timeouts for longer responses (default 30s idle cuts off mid-generation)
    this.client = create({
      COOKIES: cookies,
      MODEL: this.defaultModel,
      STREAM_IDLE_TIMEOUT_MS: "120000",
      STREAM_MAX_DURATION_MS: "600000",
      ...(refresh ? { AT_TOKEN: refresh.atToken, F_SID: refresh.fSid } : {}),
      ...config.options,
    });

    // Restore conversation state from session store
    if (saved.conversationId) {
      this.client.setConversation({
        conversationId: saved.conversationId,
        responseId: saved.responseId,
        choiceId: saved.choiceId,
      });
      if (process.env.DEBUG) {
        console.log(`[gemini-provider] Restored conversation: ${saved.conversationId}`);
      }
    }

    // Start keepalive (10 min) + cookie rotation (8 min) — same as nimji CLI
    this.startKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) return;

    // Keepalive ping every 10 minutes to keep session alive
    this.keepaliveTimer = setInterval(async () => {
      if (!this.client) return;
      try {
        await this.client.generate({ prompt: "hi" });
        if (process.env.DEBUG) {
          console.log("[gemini-provider] Keepalive ping sent");
        }
      } catch {
        if (process.env.DEBUG) {
          console.log("[gemini-provider] Keepalive ping failed");
        }
      }
    }, 10 * 60_000);

    // Cookie rotation every 8 minutes
    this.refreshTimer = setInterval(async () => {
      const refresh = await refreshSession({
        cookies: this.effectiveCookies,
        userAgent: this.config?.options?.userAgent as string,
      });
      if (refresh) {
        this.effectiveCookies = refresh.cookies;
        saveSession({ ...loadSession(), cookies: refresh.cookies });
        if (process.env.DEBUG) {
          console.log("[gemini-provider] Cookies rotated");
        }
      }
    }, 8 * 60_000);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.client) {
      throw new Error("Gemini provider not initialized. Call initialize() first.");
    }

    const model = request.model ?? this.defaultModel;
    const generateOptions = {
      prompt: request.prompt,
      includeImages: true,
      saveImages: false,
      imageAttachment: request.image
        ? {
            tokenPath: request.image.data,
            mimeType: request.image.mimeType,
            fileName: "attachment",
          }
        : undefined,
    };

    // ─── Retry logic (mirrors nimji CLI's runGenerateWithRetry) ───
    let result = await this.client.generate(generateOptions);

    if (result.isErr()) {
      throw result.error;
    }

    let issue = classifyResponse(result.value);

    // If response is partial/empty, retry with fresh client
    if (issue !== "none") {
      const conversationState = this.client.getConversation();

      // Attempt 1: retry with same config, fresh client
      const retryClient = create({
        COOKIES: this.effectiveCookies,
        MODEL: this.defaultModel,
        AT_TOKEN: this.effectiveAtToken,
        F_SID: this.effectiveFSid,
        ...this.config?.options,
      });
      retryClient.setConversation(conversationState);

      const retried = await retryClient.generate(generateOptions);
      if (retried.isOk()) {
        this.client.setConversation(retryClient.getConversation());
        result = retried;
        issue = classifyResponse(retried.value);
      }

      // Attempt 2: session recovery — reset conversation + fresh context
      if (issue !== "none") {
        const freshClient = create({
          COOKIES: this.effectiveCookies,
          MODEL: this.defaultModel,
          AT_TOKEN: this.effectiveAtToken,
          F_SID: this.effectiveFSid,
          ...this.config?.options,
        });
        const recovered = await freshClient.generate(generateOptions);
        if (recovered.isOk()) {
          this.client.resetConversation();
          this.client.setConversation(freshClient.getConversation());
          result = recovered;
          issue = classifyResponse(recovered.value);
        }
      }
    }

    // Persist conversation state to session store
    const conv = this.client.getConversation();
    saveSession({
      conversationId: conv.conversationId,
      responseId: conv.responseId,
      choiceId: conv.choiceId,
      cookies: this.effectiveCookies,
    });

    const res = result.value;

    return {
      text: res.text ?? "",
      provider: "gemini",
      model,
      usage: undefined,
      meta: {
        imageUrls: res.imageUrls,
        savedImagePaths: res.savedImagePaths,
        conversation: res.conversation,
      },
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      supportsImages: true,
      supportsSystemMessages: false,
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
    this.stopKeepalive();
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
