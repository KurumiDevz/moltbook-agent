/**
 * Bard-utils HTTP helpers for session refresh and browserinfo keepalive.
 *
 * These functions talk to the bard-utils companion service to:
 * - Refresh Gemini session cookies and extract auth tokens
 * - Keep the at token fresh via browserinfo pings
 */

import { http, type HttpMethod } from "../../http/index.js";

/** Signature for a fetch function (direct or proxied). */
export type BardUtilsFetchFn = (
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{ status: number; body: string }>;

// ─── Session refresh via bard-utils ───

/** Cached auth token to avoid redundant /api/auth/token calls (55 min TTL) */
let _cachedAuthToken: string | null = null;
let _authTokenExpiresAt = 0;

export async function refreshSession(opts: {
  readonly cookies: string;
  readonly userAgent?: string;
  readonly deep?: boolean;
  readonly force?: boolean;
  readonly baseUrl?: string;
  /** Custom fetch function that routes through proxy if set */
  readonly fetchFn?: BardUtilsFetchFn;
}): Promise<{ cookies: string; fSid: string; atToken: string } | null> {
  const baseUrl = opts.baseUrl ?? "https://bard-utils.onrender.com";
  const ua = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";
  const fetch = opts.fetchFn ?? directFetch;

  try {
    // Step 1: Get auth token (reuse cached if still valid)
    let token: string;
    const now = Date.now();
    if (_cachedAuthToken && now < _authTokenExpiresAt) {
      token = _cachedAuthToken;
    } else {
      const tokenRes = await fetch(`${baseUrl}/api/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-nimji-ua": ua },
        body: "{}",
      });
      if (process.env.DEBUG) {
        console.log(`[gemini-provider] Token fetch: status=${tokenRes.status} via ${opts.fetchFn ? "proxy" : "direct"}`);
      }
      if (tokenRes.status !== 200) {
        if (process.env.DEBUG) console.log(`[gemini-provider] Token failed: ${tokenRes.body.slice(0, 200)}`);
        return null;
      }
      const tokenData = JSON.parse(tokenRes.body) as { ok: boolean; data?: { token: string } };
      if (!tokenData.ok || !tokenData.data) return null;
      token = tokenData.data.token;
      _cachedAuthToken = token;
      _authTokenExpiresAt = now + 55 * 60 * 1000;
    }

    // Step 2: Refresh cookies
    const refreshRes = await fetch(`${baseUrl}/api/refresh`, {
      method: "POST",
      headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-nimji-ua": ua,
        },
      body: JSON.stringify({
        cookies: opts.cookies,
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
        ...(opts.deep ? { deep: true } : {}),
        ...(opts.force ? { force: true } : {}),
      }),
    });
    if (refreshRes.status !== 200) {
      if (process.env.DEBUG) console.log(`[gemini-provider] Refresh failed: status=${refreshRes.status} ${refreshRes.body.slice(0, 200)}`);
      return null;
    }
    const refreshData = JSON.parse(refreshRes.body) as {
      ok: boolean;
      data?: { cookies: string; fSid: string; atToken: string };
    };
    if (!refreshData.ok || !refreshData.data) {
      if (process.env.DEBUG) console.log(`[gemini-provider] Refresh response not ok: ${refreshRes.body.slice(0, 200)}`);
      return null;
    }

    return {
      cookies: refreshData.data.cookies,
      fSid: refreshData.data.fSid ?? "",
      atToken: refreshData.data.atToken ?? "",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.DEBUG) console.log(`[gemini-provider] Refresh error: ${msg}`);
    return null;
  }
}

/** Direct HTTP fetch (no proxy) — uses undici */
export async function directFetch(
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  const res = await http<{ status: number; body: string }>(url, {
    method: (opts.method as HttpMethod) ?? "POST",
    headers: opts.headers,
    body: opts.body ? JSON.parse(opts.body) : {},
  });
  return { status: res.status, body: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
}

// ─── Bard-utils browserinfo keepalive ───

/**
 * Bard-utils browserinfo keepalive — pings Google's identity surface
 * to keep the at token fresh. This is NOT nimji's keepalive timer
 * (which handles per-request cookie rotation internally).
 *
 * Calls POST /api/browserinfo on bard-utils. Returns updated cookies on success.
 */
export async function browserinfoKeepalive(opts: {
  readonly cookies: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchFn?: BardUtilsFetchFn;
}): Promise<string | false> {
  const fetchFn = opts.fetchFn ?? directFetch;
  const { baseUrl, cookies, token } = opts;

  try {
    // POST /api/browserinfo — use provided token, no mint call
    const biRes = await fetchFn(`${baseUrl}/api/browserinfo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cookies }),
    });
    if (biRes.status !== 200) return false;

    const data = JSON.parse(biRes.body) as {
      ok: boolean;
      data?: { cookies: string; statusCode: number; rotatedCount: number };
    };
    if (!data.ok || !data.data) return false;

    console.log(`[keepalive] browserinfo ${data.data.statusCode} — ${data.data.rotatedCount} cookies rotated`);

    // Return updated cookies (browserinfo may rotate SIDCC etc.)
    return data.data.cookies;
  } catch {
    console.log("[keepalive] browserinfo failed");
    return false;
  }
}
