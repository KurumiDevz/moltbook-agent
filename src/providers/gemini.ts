/**
 * Gemini provider using nimji as an npm package.
 * Uses browser cookies to authenticate with Google's Gemini web API.
 *
 * Mirrors nimji CLI behavior:
 * - Session store persistence for conversation continuity
 * - Retry with fresh client on partial streams
 * - Session recovery: reset conversation + retry when stuck
 * - Keepalive timer to prevent session expiry
 *
 * Hardened conversation isolation:
 * - Cookies: shared in data/gemini-session.json (backward compatible)
 * - Conversations: per-key in data/sessions/<key>.json
 * - Main agent uses "main", sub-agents get unique keys
 */

import { create, type GemaiClient } from "nimji";
import { http } from "../http/index.js";
import { saveCookies, loadCookies, loadConversation, saveConversation } from "../session-manager.js";
import type { GenerateRequest, GenerateResponse, Provider, ProviderCapabilities, ProviderConfig } from "./types.js";

export type GeminiProviderConfig = ProviderConfig & {
  /** Browser session cookies for Gemini web API */
  readonly cookies?: string;
  /** Model to use: flash, pro, flash-lite, extended */
  readonly model?: string;
  /** Conversation key for isolation (default: "main") */
  readonly conversationKey?: string;
  /** Use deep browser session refresh via bard-utils (default: false) */
  readonly deepRefresh?: boolean;
};

// ─── Session refresh via bard-utils ───

async function refreshSession(opts: {
  readonly cookies: string;
  readonly userAgent?: string;
  readonly deep?: boolean;
}): Promise<{ cookies: string; fSid: string; atToken: string } | null> {
  const baseUrl = "https://bard-utils.onrender.com";
  const ua = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";

  try {
    const { data: tokenData } = await http<{ ok: boolean; data?: { token: string } }>(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nimji-ua": ua },
      body: {},
    });
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
        ...(opts.deep ? { deep: true } : {}),
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

function classifyResponse(value: {
  text: string | null;
  meta: { statusCode: number; chunkCount: number; rawSize: number };
}): string {
  if (value.meta.statusCode !== 200) return "partial_stream";
  if (value.meta.chunkCount <= 1 || value.meta.rawSize < 220) return "partial_stream";
  if (!value.text || value.text.trim().length === 0) return "no_text";
  return "none";
}

// ─── Gemini provider ───

export class GeminiProvider implements Provider {
  readonly type = "gemini" as const;

  private client: GemaiClient | null = null;
  private config: GeminiProviderConfig | null = null;
  private defaultModel: string;
  private conversationKey: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private effectiveCookies: string = "";
  private effectiveFSid: string = "";
  private effectiveAtToken: string = "";
  private deepRefresh: boolean = false;

  constructor() {
    this.defaultModel = "flash";
    this.conversationKey = "main";
  }

  async initialize(config: GeminiProviderConfig): Promise<void> {
    this.config = config;
    this.conversationKey = config.conversationKey ?? "main";
    this.deepRefresh = (config.options?.deepRefresh as boolean) ?? false;

    // Load cookies: prefer saved (fresh) from gemini-session.json, fall back to .env
    const savedCookies = loadCookies();
    let cookies = savedCookies.cookies ?? config.cookies ?? (config.options?.cookies as string) ?? process.env.COOKIES ?? "";
    if (!cookies) {
      throw new Error(
        "Gemini provider requires COOKIES environment variable or config.cookies. " +
          "Export your browser session cookie string from gemini.google.com DevTools.",
      );
    }

    this.defaultModel = config.defaultModel ?? (config.options?.model as string) ?? "flash";

    // Refresh session via bard-utils (extracts fSid, atToken, rotates cookies)
    const refresh = await refreshSession({
      cookies,
      userAgent: config.options?.userAgent as string,
      deep: this.deepRefresh,
    });

    if (refresh) {
      cookies = refresh.cookies;
      saveCookies({ cookies: refresh.cookies });
      if (process.env.DEBUG) {
        console.log("[gemini-provider] Session refreshed via bard-utils");
      }
    }

    this.effectiveCookies = cookies;
    this.effectiveFSid = refresh?.fSid ?? "";
    this.effectiveAtToken = refresh?.atToken ?? "";

    // Create nimji client with refreshed cookies + auth tokens
    // Nimji's internal rotation is enabled as safety net alongside our5-min refresh
    this.client = create({
      COOKIES: cookies,
      MODEL: this.defaultModel,
      STREAM_IDLE_TIMEOUT_MS: "120000",
      STREAM_MAX_DURATION_MS: "600000",
      ...(refresh?.atToken ? { AT_TOKEN: refresh.atToken } : {}),
      ...(refresh?.fSid ? { F_SID: refresh.fSid } : {}),
      ...config.options,
    }, { keepalive: { enabled: true, intervalMs: 480_000 } });

    // Don't restore stale conversation — start fresh each startup
    // Gemini accumulates context that causes parse failures after restart
    this.client.resetConversation();

    // Start keepalive (10 min) + cookie rotation (8 min)
    this.startKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) return;

    // Keepalive ping handled by nimji ({ keepalive: true })
    // this.keepaliveTimer = setInterval(async () => {
    //   if (!this.client) return;
    //   try {
    //     const test = await this.client.generate({ prompt: "hi" });
    //     if (test.isErr()) {
    //       console.log("[gemini-provider] Keepalive failed — refreshing session...");
    //       await this.refreshSession();
    //     }
    //   } catch {
    //     console.log("[gemini-provider] Keepalive failed — refreshing session...");
    //     await this.refreshSession();
    //   }
    // }, 7 * 60_000);

    // Cookie + token rotation every 5 minutes
    this.refreshTimer = setInterval(async () => {
      await this.refreshSession();
    }, 5 * 60_000);
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

  /** Full session refresh: rotate cookies + fSid + atToken + recreate client */
  private async refreshSession(): Promise<void> {
    if (!this.config) return;

    // Retry up to 3 times with exponential backoff
    const MAX_RETRIES = 3;
    let refresh: { cookies: string; fSid: string; atToken: string } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      refresh = await refreshSession({
        cookies: this.effectiveCookies,
        userAgent: this.config.options?.userAgent as string,
        deep: this.deepRefresh,
      });

      if (refresh) break;

      if (attempt < MAX_RETRIES) {
        const delayMs = attempt * 2000; // 2s, 4s
        console.log(`[gemini-provider] Refresh attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (!refresh) {
      console.log(`[gemini-provider] Session refresh FAILED after ${MAX_RETRIES} attempts — cookies may be expired`);
      return;
    }

    // Staleness detection: check if rotated cookies actually changed
    const cookiesChanged = refresh.cookies !== this.effectiveCookies;
    const fSidChanged = refresh.fSid && refresh.fSid !== this.effectiveFSid;
    const atTokenChanged = refresh.atToken && refresh.atToken !== this.effectiveAtToken;

    // Update auth state — preserve last-known-good atToken/fSid if refresh returned empty
    this.effectiveCookies = refresh.cookies;
    this.effectiveFSid = refresh.fSid || this.effectiveFSid;
    this.effectiveAtToken = refresh.atToken || this.effectiveAtToken;

    // Null-guard: if both old and new are empty, log warning
    if (!this.effectiveAtToken) {
      console.log("[gemini-provider] WARNING: atToken is empty after refresh — requests may fail");
    }
    if (!this.effectiveFSid) {
      console.log("[gemini-provider] WARNING: fSid is empty after refresh — requests may fail");
    }

    saveCookies({ cookies: refresh.cookies });

    // Stop old client timers BEFORE recreating — prevents zombie timer leak
    if (this.client) {
      this.client.stopKeepalive();
    }

    // Recreate nimji client with fresh tokens
    // Nimji's internal rotation is enabled as safety net alongside our5-min refresh
    this.client = create({
      COOKIES: refresh.cookies,
      MODEL: this.defaultModel,
      STREAM_IDLE_TIMEOUT_MS: "120000",
      STREAM_MAX_DURATION_MS: "600000",
      AT_TOKEN: this.effectiveAtToken,
      F_SID: this.effectiveFSid,
      ...(this.config.options ?? {}),
    }, { keepalive: { enabled: true, intervalMs: 480_000 } });

    // Restore conversation state
    const saved = loadConversation(this.conversationKey);
    if (saved.conversationId) {
      this.client.setConversation({
        conversationId: saved.conversationId,
        responseId: saved.responseId,
        choiceId: saved.choiceId,
      });
    }

    // Detailed rotation logging
    if (cookiesChanged || fSidChanged || atTokenChanged) {
      console.log(`[gemini-provider] Session refreshed — cookies:${cookiesChanged ? "rotated" : "same"} fSid:${fSidChanged ? "rotated" : "same"} atToken:${atTokenChanged ? "rotated" : "same"}`);
    } else {
      console.log("[gemini-provider] Session refreshed — no rotation detected (cookies may be stale)");
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.client) {
      throw new Error("Gemini provider not initialized. Call initialize() first.");
    }

    // If a different conversationKey is requested, temporarily switch conversations
    const useSeparateConvo = request.conversationKey && request.conversationKey !== this.conversationKey;
    let savedConvo = null;
    if (useSeparateConvo) {
      savedConvo = this.client.getConversation();
      const altConvo = loadConversation(request.conversationKey);
      this.client.setConversation(altConvo.conversationId ? {
        conversationId: altConvo.conversationId,
        responseId: altConvo.responseId,
        choiceId: altConvo.choiceId,
      } : {});
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

    // ─── Session expired recovery: refresh cookies + recreate client + retry ───
    const resText = result.value?.text ?? "";
    const isSessionExpired = resText.includes("Session expired") || resText.includes("login page");

    // Also check if the generate itself threw a session expired error
    // (nimji throws this in transport.js when response is HTML login page)
    if (isSessionExpired) {
      console.log("[gemini-provider] Session expired detected in response — refreshing cookies...");
      await this.refreshSession();

      // Retry with fresh client
      const freshClient = create({
        COOKIES: this.effectiveCookies,
        MODEL: this.defaultModel,
        AT_TOKEN: this.effectiveAtToken,
        F_SID: this.effectiveFSid,
        KEEPALIVE_ROTATE_ENABLED: "0",
        ...this.config?.options,
      });
      const retryResult = await freshClient.generate(generateOptions);
      if (retryResult.isOk()) {
        this.client = freshClient;
        result = retryResult;
      }
    }

    // Persist conversation state to per-key session store
    const conv = this.client.getConversation();

    if (useSeparateConvo) {
      // Save the alternate conversation's state
      saveConversation(request.conversationKey!, {
        conversationId: conv.conversationId,
        responseId: conv.responseId,
        choiceId: conv.choiceId,
      });
      // Restore the main conversation
      if (savedConvo) this.client.setConversation(savedConvo);
    }

    saveConversation(this.conversationKey, {
      conversationId: useSeparateConvo && savedConvo ? (savedConvo as any).conversationId : conv.conversationId,
      responseId: useSeparateConvo && savedConvo ? (savedConvo as any).responseId : conv.responseId,
      choiceId: useSeparateConvo && savedConvo ? (savedConvo as any).choiceId : conv.choiceId,
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
