/**
 * HTTP client powered by undici.
 * Sets up a global Agent dispatcher and exports a typed request helper.
 * Every HTTP call in the project should go through this module.
 */
import { Agent, setGlobalDispatcher, request as undiciRequest } from "undici";

let initialized = false;

/** Initialize undici global dispatcher. Safe to call multiple times. */
export function initHttp() {
  if (initialized) return;
  initialized = true;
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connect: { timeout: 10_000 },
  }));
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpRequestOptions = {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  /** Timeout in ms (default 30000) */
  timeout?: number;
};

export type HttpResponse<T = unknown> = {
  status: number;
  headers: Record<string, string>;
  data: T;
};

/**
 * Make an HTTP request through undici.
 * Automatically initializes the dispatcher on first call.
 */
export async function http<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  initHttp();

  const { method = "GET", headers = {}, body, timeout = 30_000 } = options;

  const response = await undiciRequest(url, {
    method,
    headers: {
      "user-agent": "moltbook-agent/1.0",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  const contentType = response.headers["content-type"] ?? "";
  let data: unknown;
  if (contentType.includes("application/json")) {
    data = await response.body.json();
  } else {
    const text = await response.body.text();
    try { data = JSON.parse(text); } catch { data = text; }
  }

  return {
    status: response.statusCode,
    headers: Object.fromEntries(Object.entries(response.headers).filter(([k]) => typeof k === "string") as [string, string][]),
    data: data as T,
  };
}
