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

import { create, type GemaiClient, type ConversationState } from "nimji";
import { saveCookies, loadCookies, loadConversation, saveConversation } from "../../session-manager.js";
import type { GenerateRequest, GenerateResponse, Provider, ProviderCapabilities, ProviderConfig } from "../types.js";
import type { ProxyManager } from "../../proxy.js";
import { refreshSession, browserinfoKeepalive, directFetch, type BardUtilsFetchFn } from "./bard-utils.js";
import { classifyResponse } from "./classify.js";

export type GeminiProviderConfig = ProviderConfig & {
  /** Browser session cookies for Gemini web API */
  readonly cookies?: string;
  /** Model to use: flash, pro, flash-lite, extended */
  readonly model?: string;
  /** Conversation key for isolation (default: "main") */
  readonly conversationKey?: string;
  /** Use deep browser session refresh via bard-utils (default: false) */
  readonly deepRefresh?: boolean;
  /** Enable nimji's internal cookie rotation timer (default: false).
   *  When false, our refreshTimer handles cookie rotation.
   *  When true, nimji's 8-min rotateTimer calls /api/refresh in addition to ours. */
  readonly enableNimjiRotation?: boolean;
  /** bard-utils API base URL (default: https://bard-utils.onrender.com) */
  readonly bardUtilsUrl?: string;
  /** Optional proxy manager for Pterodactyl environments */
  readonly proxyManager?: ProxyManager;
};

// ─── Gemini provider ───

export class GeminiProvider implements Provider {
  readonly type = "gemini" as const;

  private client: GemaiClient | null = null;
  private config: GeminiProviderConfig | null = null;
  private defaultModel: string;
  private conversationKey: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveIntervalMs: number = 120_000;    // 2 min — browserinfo ping
  private refreshIntervalMs: number = 1_200_000;   // 20 min — full refresh cycle
  private enableBrowserinfo: boolean = true;
  private effectiveCookies: string = "";
  private effectiveFSid: string = "";
  private effectiveAtToken: string = "";
  private deepRefresh: boolean = false;
  private forceRefresh: boolean = false;
  private enableNimjiRotation: boolean = false;
  private bardUtilsUrl: string = "https://bard-utils.onrender.com";
  private proxyManager: ProxyManager | null = null;
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    this.defaultModel = "flash";
    this.conversationKey = "main";
  }

  /** Create nimji client with our standard config.
   *  nimji's batchexecute keepalive runs by default (keeps session warm).
   *  nimji's cookie rotation is controlled by ENABLE_NIMJI_ROTATE (default: off).
   *  When off, our 20-min refreshTimer handles cookie rotation exclusively. */
  private createClient(cookies: string, opts?: { atToken?: string; fSid?: string; extra?: Record<string, unknown> }) {
    // nimji reads KEEPALIVE_ROTATE_ENABLED from process.env at create() time
    process.env.KEEPALIVE_ROTATE_ENABLED = this.enableNimjiRotation ? "1" : "0";
    return create({
      COOKIES: cookies,
      MODEL: this.defaultModel,
      STREAM_IDLE_TIMEOUT_MS: "120000",
      STREAM_MAX_DURATION_MS: "600000",
      ...(opts?.atToken ? { AT_TOKEN: opts.atToken } : {}),
      ...(opts?.fSid ? { F_SID: opts.fSid } : {}),
      ...(opts?.extra ?? {}),
    });
  }

  async initialize(config: GeminiProviderConfig): Promise<void> {
    this.config = config;
    this.conversationKey = config.conversationKey ?? "main";
    this.deepRefresh = (config.options?.deepRefresh as boolean) ?? false;
    this.forceRefresh = (config.options?.forceRefresh as boolean) ?? false;
    this.enableNimjiRotation = (config.options?.enableNimjiRotation as boolean)
      ?? process.env.ENABLE_NIMJI_ROTATION === "true";
    this.bardUtilsUrl = (config.options?.bardUtilsUrl as string) ?? "https://bard-utils.onrender.com";
    this.proxyManager = (config.options?.proxyManager as ProxyManager) ?? null;
    this.keepaliveIntervalMs = (config.options?.keepaliveIntervalMs as number) ?? 120_000;
    this.refreshIntervalMs = (config.options?.refreshIntervalMs as number) ?? 1_200_000;
    this.enableBrowserinfo = (config.options?.enableBrowserinfo as boolean) ?? true;

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
    const fetchFn = this.getProxyFetch();
    const refresh = await refreshSession({
      cookies,
      userAgent: config.options?.userAgent as string,
      deep: this.deepRefresh,
      baseUrl: this.bardUtilsUrl,
      fetchFn,
    });

    if (refresh) {
      cookies = refresh.cookies;
      saveCookies({ cookies: refresh.cookies });
      console.log(`[gemini-provider] Session refreshed via bard-utils${fetchFn ? " (proxy)" : ""}`);
    } else {
      console.log("[gemini-provider] Session refresh FAILED — using stored cookies");
    }

    this.effectiveCookies = cookies;
    this.effectiveFSid = refresh?.fSid ?? "";
    this.effectiveAtToken = refresh?.atToken ?? "";

    // Create nimji client with refreshed cookies + auth tokens
    this.client = this.createClient(cookies, {
      atToken: refresh?.atToken,
      fSid: refresh?.fSid,
      extra: config.options,
    });

    // Don't restore stale conversation — start fresh each startup
    // Gemini accumulates context that causes parse failures after restart
    this.client.resetConversation();

    // Start keepalive timers:
    // - browserinfo every 2 min (our code — keeps at token fresh)
    // - nimji batchexecute every 10 min (nimji internal — keeps session warm)
    // - nimji cookie rotation every 8 min (nimji internal — only if ENABLE_NIMJI_ROTATION=true)
    // - full refresh every 20 min (our code — rotate cookies + fSid + atToken)
    this.startKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) return;

    // ── Bard-utils browserinfo keepalive (every 2 min) ──
    // Pings Google's identity surface to keep the at token fresh.
    // nimji's batchexecute keepalive (10 min) keeps the session warm.
    // nimji's cookie rotation (8 min) is disabled by default — our 20-min refreshTimer handles it.
    // Set ENABLE_NIMJI_ROTATION=true to also run nimji's rotation as a safety net.
    if (this.enableBrowserinfo) {
      this.keepaliveTimer = setInterval(async () => {
        try {
          const token = await this.getToken();
          if (!token) {
            console.log("[keepalive] failed to get auth token");
            return;
          }

          const updatedCookies = await browserinfoKeepalive({
            cookies: this.effectiveCookies,
            baseUrl: this.bardUtilsUrl,
            token,
            fetchFn: this.getProxyFetch(),
          });
          if (updatedCookies) {
            this.effectiveCookies = updatedCookies;
            saveCookies({ cookies: updatedCookies });
          }
        } catch (err) {
          console.log("[keepalive] browserinfo keepalive error:", err);
        }
      }, this.keepaliveIntervalMs);
    }

    // ── Full refresh (every 20 min) ──
    // Calls POST /api/refresh: extractTokens + browserinfo + RotateCookies.
    // This is the heavy rotation — browserinfo alone is not enough for rotation.
    this.refreshTimer = setInterval(async () => {
      await this.refreshSession();
    }, this.refreshIntervalMs);
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

  /** Force a session refresh — bypasses cache and adaptive skip in bard-utils */
  async forceSessionRefresh(): Promise<boolean> {
    if (!this.config) return false;
    console.log("[gemini-provider] Forcing session refresh...");
    await this.refreshSession(true);
    return this.client !== null;
  }

  /** Returns a fetch function that routes through the proxy manager if available */
  private getProxyFetch(): BardUtilsFetchFn | undefined {
    if (!this.proxyManager) return undefined;
    const mgr = this.proxyManager;
    const base = this.bardUtilsUrl.replace(/\/$/, "");
    return (url, opts) => {
      // Strip base URL to get just the path — ProxyManager.fetch expects a path
      const path = url.startsWith(base) ? url.slice(base.length) : url;
      return mgr.fetch(path, opts);
    };
  }

  /**
   * Get a valid auth token from bard-utils, minting a new one only when
   * the cached token is expired or within 60s of expiry.
   *
   * Cuts /api/auth/token calls from ~13/hr to ~1/hr.
   */
  private async getToken(): Promise<string | null> {
    // Reuse cached token if still valid (60s buffer before expiry)
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }

    const fetchFn = this.getProxyFetch() ?? directFetch;
    try {
      const resp = await fetchFn(`${this.bardUtilsUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (resp.status !== 200) return null;
      const data = JSON.parse(resp.body) as {
        data?: { token?: string; expiresIn?: number };
      };
      if (!data.data?.token) return null;

      this.cachedToken = data.data.token;
      this.tokenExpiresAt = Date.now() + (data.data.expiresIn ?? 3600) * 1000;
      return this.cachedToken;
    } catch {
      return null;
    }
  }

  /** Full session refresh: rotate cookies + fSid + atToken + recreate client */
  private async refreshSession(force = false): Promise<void> {
    if (!this.config) return;

    // Use force if explicitly passed OR if forceRefresh is enabled in config
    const useForce = force || this.forceRefresh;

    // Retry up to 3 times with exponential backoff
    const MAX_RETRIES = 3;
    let refresh: { cookies: string; fSid: string; atToken: string } | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      refresh = await refreshSession({
        cookies: this.effectiveCookies,
        userAgent: this.config.options?.userAgent as string,
        deep: this.deepRefresh,
        force: useForce,
        baseUrl: this.bardUtilsUrl,
        fetchFn: this.getProxyFetch(),
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
    this.client = this.createClient(refresh.cookies, {
      atToken: this.effectiveAtToken,
      fSid: this.effectiveFSid,
      extra: this.config.options,
    });

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
      console.log(`[gemini-provider] Session refreshed — cookies:${cookiesChanged ? "rotated" : "same"} fSid:${fSidChanged ? "rotated" : "same"} atToken:${atTokenChanged ? "rotated" : "same"}${useForce ? " (forced)" : ""}`);
    } else {
      console.log(`[gemini-provider] Session refreshed — no rotation detected (cookies may be stale)${useForce ? " (forced)" : ""}`);
    }

    // Smart probe: verify new session works. Handles propagation delay + detects logged-out.
    // Google has multiple servers — rotated cookies may take 1-3s to propagate.
    if (cookiesChanged || fSidChanged) {
      try {
        const probeClient = this.createClient(refresh.cookies, {
          atToken: this.effectiveAtToken,
          fSid: this.effectiveFSid,
        });
        const probe = await probeClient.generate({ prompt: "hi" });
        if (probe.isOk()) {
          console.log("[gemini-provider] Session probe OK — new cookies accepted");
        } else {
          // Wait 3s for propagation, retry once
          await new Promise((r) => setTimeout(r, 3000));
          const probe2 = await probeClient.generate({ prompt: "hi" });
          if (probe2.isOk()) {
            console.log("[gemini-provider] Session probe OK after retry");
          } else if (this.forceRefresh) {
            console.log("[gemini-provider] Session probe failed — forcing refresh...");
            await this.refreshSession(true);
          } else {
            console.log("[gemini-provider] Session probe failed — session may be degraded (enable FORCE_REFRESH to auto-recover)");
          }
        }
      } catch {
        if (this.forceRefresh) {
          console.log("[gemini-provider] Session probe threw — forcing refresh...");
          await this.refreshSession(true);
        } else {
          console.log("[gemini-provider] Session probe threw — session may be degraded (enable FORCE_REFRESH to auto-recover)");
        }
      }
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (!this.client) {
      throw new Error("Gemini provider not initialized. Call initialize() first.");
    }

    // If a different conversationKey is requested, temporarily switch conversations
    const useSeparateConvo = request.conversationKey && request.conversationKey !== this.conversationKey;
    let savedConvo: ConversationState | null = null;
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
      const retryClient = this.createClient(this.effectiveCookies, {
        atToken: this.effectiveAtToken,
        fSid: this.effectiveFSid,
        extra: this.config?.options,
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
        const freshClient = this.createClient(this.effectiveCookies, {
          atToken: this.effectiveAtToken,
          fSid: this.effectiveFSid,
          extra: this.config?.options,
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
      const freshClient = this.createClient(this.effectiveCookies, {
        atToken: this.effectiveAtToken,
        fSid: this.effectiveFSid,
        extra: this.config?.options,
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
      conversationId: useSeparateConvo && savedConvo ? savedConvo.conversationId : conv.conversationId,
      responseId: useSeparateConvo && savedConvo ? savedConvo.responseId : conv.responseId,
      choiceId: useSeparateConvo && savedConvo ? savedConvo.choiceId : conv.choiceId,
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
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
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
