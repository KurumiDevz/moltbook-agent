/**
 * Smart proxy manager — fetch, test, rotate, health-check.
 *
 * Features:
 *   - Fetches proxies from 3 GitHub sources (lightweight, no deps)
 *   - Classic HTTP proxy for HTTP targets, CONNECT tunnel for HTTPS
 *   - On init: tests batch, picks best (lowest latency + valid response)
 *   - Auto-rotation: if current proxy dies, rotates to next
 *   - Health monitoring: periodic checks, demotes dead proxies
 *   - Exponential backoff on retry
 *
 * Usage:
 *   const mgr = new ProxyManager({ targetUrl: "http://..." });
 *   await mgr.initialize();               // find working proxy
 *   const res = await mgr.fetch("/api/auth/token", { method: "POST", body: "{}" });
 *   await mgr.rotate();                   // force rotation
 *   mgr.dispose();                        // stop health checks
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

// ─── Types ───

export type ProxyCandidate = {
  url: string; // "http://ip:port"
  source: string;
  latencyMs?: number;
  lastCheck?: number;
  alive: boolean;
  consecutiveFails: number;
};

export type ProxyManagerConfig = {
  /** Target URL to test proxies against (must return valid JSON with {ok:true}) */
  targetUrl: string;
  /** Custom headers sent with test/health requests */
  headers?: Record<string, string>;
  /** Max proxies to fetch per source (default: 20) */
  maxPerSource?: number;
  /** Request timeout in ms (default: 6000) */
  timeoutMs?: number;
  /** Health check interval in ms (default: 60000 — 1 min) */
  healthCheckMs?: number;
  /** Max consecutive fails before demoting a proxy (default: 3) */
  maxFails?: number;
  /** Log function (default: console.log) */
  log?: (...args: any[]) => void;
};

export type ProxyRequestOptions = {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
};

// ─── Sources ───

import fs from "node:fs";
import path from "node:path";

/** Parse a single line from proxy.txt into a valid proxy URL.
 *  Adaptive — handles any common format:
 *  - protocol://user:pass@ip:port
 *  - protocol://ip:port
 *  - user:pass@ip:port (auto-prefix http://)
 *  - ip:port (auto-prefix http://)
 *  - ip:port:user:pass (auto-prefix http://user:pass@ip:port)
 *  - lines starting with # are comments
 */
function parseProxyLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  // Already a full URL: http://..., socks4://..., socks5://...
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }

  const parts = trimmed.split(":");
  const isIp = (s: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);

  // ip:port:user:pass → http://user:pass@ip:port
  if (parts.length >= 4 && isIp(parts[0])) {
    const [ip, port, user, ...passParts] = parts;
    const pass = passParts.join(":");
    try {
      new URL(`http://${user}:${pass}@${ip}:${port}`);
      return `http://${user}:${pass}@${ip}:${port}`;
    } catch {
      return null;
    }
  }

  // ip:port → http://ip:port
  if (parts.length === 2 && isIp(parts[0])) {
    try {
      new URL(`http://${trimmed}`);
      return `http://${trimmed}`;
    } catch {
      return null;
    }
  }

  // user:pass@ip:port (no protocol) → http://user:pass@ip:port
  const atSplit = trimmed.split("@");
  if (atSplit.length === 2) {
    const [auth, host] = atSplit;
    try {
      new URL(`http://${auth}@${host}`);
      return `http://${auth}@${host}`;
    } catch {
      return null;
    }
  }

  return null;
}

/** Load proxy.txt from project root. Returns empty array if missing/empty. */
function loadProxyFile(): string[] {
  const candidates = [
    path.resolve("proxy.txt"),
    path.resolve("data/proxy.txt"),
  ];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 0) return lines;
    } catch {}
  }
  return [];
}

const SOURCES = [
  {
    name: "proxifly",
    url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
    parse: (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http")),
  },
  {
    name: "gnxD3RfTT2WE",
    url: "https://raw.githubusercontent.com/gnxD3RfTT2WE/free-http-proxy-list/main/http.txt",
    parse: (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)).map((l) => `http://${l}`),
  },
  {
    name: "jetkai",
    url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
    parse: (t: string) => t.split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l)).map((l) => `http://${l}`),
  },
];

// ─── Transport ───

/** Extract proxy auth from URL (user:pass@host) and return cleaned URL + auth header */
function extractProxyAuth(proxyUrl: string): { url: string; auth?: string } {
  const u = new URL(proxyUrl);
  if (u.username) {
    const decoded = decodeURIComponent(u.username + (u.password ? ":" + u.password : ""));
    const auth = "Basic " + Buffer.from(decoded).toString("base64");
    u.username = "";
    u.password = "";
    return { url: u.toString(), auth };
  }
  return { url: proxyUrl };
}

function classicHttpProxy(proxyUrl: string, targetUrl: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { url: cleanProxy, auth } = extractProxyAuth(proxyUrl);
    const proxy = new URL(cleanProxy);
    const target = new URL(targetUrl);

    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
      host: target.hostname + (target.port ? ":" + target.port : ""),
      ...headers,
    };
    if (auth) reqHeaders["proxy-authorization"] = auth;

    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      path: target.href,
      method: "POST",
      headers: reqHeaders,
      timeout: timeoutMs,
    });

    req.on("response", (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });

    req.write(body);
    req.end();
  });
}

function connectThroughProxy(proxyUrl: string, targetHost: string, targetPort: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const { url: cleanProxy, auth } = extractProxyAuth(proxyUrl);
    const proxy = new URL(cleanProxy);
    const socket = net.connect(Number(proxy.port) || 80, proxy.hostname);

    const timer = setTimeout(() => { socket.destroy(); reject(new Error("CONNECT timeout")); }, timeoutMs);

    socket.on("connect", () => {
      let connectHeader = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (auth) connectHeader += `Proxy-Authorization: ${auth}\r\n`;
      socket.write(connectHeader + "\r\n");
    });

    let headerBuf = "";
    socket.on("data", (chunk) => {
      headerBuf += chunk.toString();
      if (headerBuf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        if (headerBuf.startsWith("HTTP/") && headerBuf.includes("200")) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`CONNECT rejected: ${headerBuf.split("\r\n")[0]}`));
        }
      }
    });

    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    socket.on("timeout", () => { clearTimeout(timer); socket.destroy(); reject(new Error("socket timeout")); });
  });
}

function postThroughTunnel(socket: net.Socket, targetUrl: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const path = target.pathname;

    const request =
      `POST ${path} HTTP/1.1\r\n` +
      `Host: ${target.hostname}${target.port ? ":" + target.port : ""}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n" +
      `Connection: close\r\n\r\n` +
      body;

    let responseBuf = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("response timeout")); }, timeoutMs);

    socket.on("data", (chunk) => { responseBuf += chunk.toString(); });
    socket.on("end", () => {
      clearTimeout(timer);
      const headerEnd = responseBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) { reject(new Error("no HTTP headers")); return; }
      const statusCode = parseInt(responseBuf.split("\r\n")[0].split(" ")[1] || "0", 10);
      resolve({ status: statusCode, body: responseBuf.slice(headerEnd + 4) });
    });

    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    socket.write(request);
  });
}

async function proxyRequest(proxyUrl: string, targetUrl: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  const target = new URL(targetUrl);
  if (target.protocol === "https:") {
    const targetPort = Number(target.port) || 443;
    const socket = await connectThroughProxy(proxyUrl, target.hostname, targetPort, timeoutMs);
    const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
    return postThroughTunnel(tlsSocket as any, targetUrl, body, headers, timeoutMs);
  }
  return classicHttpProxy(proxyUrl, targetUrl, body, headers, timeoutMs);
}

// ─── Source fetching ───

async function fetchSources(maxPerSource: number): Promise<ProxyCandidate[]> {
  // 1. Try proxy.txt first — if exists and not empty, use it exclusively
  const fileProxies = loadProxyFile();
  if (fileProxies.length > 0) {
    const parsed = fileProxies.map(parseProxyLine).filter((p): p is string => p !== null);
    if (parsed.length > 0) {
      return parsed.map((url) => ({
        url,
        source: "proxy.txt",
        alive: true,
        consecutiveFails: 0,
      }));
    }
  }

  // 2. Fallback: fetch from GitHub sources
  const all: ProxyCandidate[] = [];

  await Promise.allSettled(
    SOURCES.map(async (src) => {
      try {
        const res = await fetch(src.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return;
        const text = await res.text();
        const urls = src.parse(text)
          .sort(() => Math.random() - 0.5)
          .slice(0, maxPerSource);
        for (const url of urls) {
          all.push({
            url,
            source: src.name,
            alive: true,
            consecutiveFails: 0,
          });
        }
      } catch {}
    }),
  );

  return all;
}

// ─── ProxyManager ───

export class ProxyManager {
  private config: Required<ProxyManagerConfig>;
  private candidates: ProxyCandidate[] = [];
  private currentIdx: number = -1;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(config: ProxyManagerConfig) {
    this.config = {
      maxPerSource: 20,
      timeoutMs: 6_000,
      healthCheckMs: 60_000,
      maxFails: 3,
      log: console.log,
      headers: {},
      ...config,
    };
  }

  /** Current active proxy (or null if none found) */
  get current(): ProxyCandidate | null {
    return this.candidates[this.currentIdx] ?? null;
  }

  /** All known proxies sorted alive-first */
  get proxies(): ProxyCandidate[] {
    return [...this.candidates].sort((a, b) => Number(b.alive) - Number(a.alive));
  }

  /**
   * Initialize: fetch proxies → test batch → pick best → start health monitor.
   * Retries until at least 1 working proxy is found.
   */
  async initialize(): Promise<boolean> {
    const { log, timeoutMs } = this.config;
    let attempt = 0;

    while (!this.disposed) {
      attempt++;
      log(`[proxy] initialization attempt ${attempt}...`);

      // Fetch
      this.candidates = await fetchSources(this.config.maxPerSource);
      if (this.candidates.length === 0) {
        log("[proxy] no proxies fetched, retrying in 5s...");
        await sleep(5_000);
        continue;
      }

      log(`[proxy] testing ${this.candidates.length} proxies...`);

      // Test batch (parallel, 8 at a time)
      const CONCURRENCY = 8;
      for (let i = 0; i < this.candidates.length; i += CONCURRENCY) {
        if (this.disposed) return false;
        const batch = this.candidates.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map(async (c) => {
            const start = Date.now();
            const tokenUrl = this.config.targetUrl.replace(/\/$/, "") + "/api/auth/token";
            try {
              const res = await proxyRequest(c.url, tokenUrl, "{}", this.config.headers, timeoutMs);
              if (res.status === 200) {
                const parsed = JSON.parse(res.body);
                if (parsed.ok && parsed.data?.token) {
                  c.latencyMs = Date.now() - start;
                  c.alive = true;
                  c.lastCheck = Date.now();
                  return;
                }
              }
            } catch {}
            c.alive = false;
            c.consecutiveFails = this.config.maxFails;
          }),
        );
      }

      // Pick best (alive + lowest latency)
      const alive = this.candidates
        .filter((c) => c.alive && c.latencyMs != null)
        .sort((a, b) => a.latencyMs! - b.latencyMs!);

      if (alive.length > 0) {
        this.currentIdx = this.candidates.indexOf(alive[0]);
        log(`[proxy] ✅ found ${alive.length} working proxies, best: ${alive[0].url} (${alive[0].latencyMs}ms)`);
        this.startHealthCheck();
        return true;
      }

      log("[proxy] no working proxies found, retrying in 5s...");
      await sleep(5_000);
    }

    return false;
  }

  /** Make a request through the current proxy. Auto-rotates on failure. */
  async fetch(path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
    const { method = "POST", body = "{}", headers = {} } = opts;
    const mergedHeaders = { ...this.config.headers, ...headers };
    const fullUrl = this.config.targetUrl.replace(/\/$/, "") + path;

    let lastError: Error | null = null;
    const tried = new Set<number>();

    // Try current + fallbacks
    for (let attempt = 0; attempt < this.candidates.length; attempt++) {
      // Pick next alive candidate
      const idx = this.pickNext(tried);
      if (idx === -1) break;
      tried.add(idx);

      const c = this.candidates[idx];
      this.currentIdx = idx;

      try {
        const res = await proxyRequest(c.url, fullUrl, body, mergedHeaders, this.config.timeoutMs);
        c.consecutiveFails = 0;
        c.alive = true;
        c.lastCheck = Date.now();
        return res;
      } catch (err: any) {
        lastError = err;
        c.consecutiveFails++;
        if (c.consecutiveFails >= this.config.maxFails) {
          c.alive = false;
          this.config.log(`[proxy] ❌ ${c.url} demoted (${c.consecutiveFails} fails)`);
        }
      }
    }

    throw lastError ?? new Error("no working proxy available");
  }

  /** Force rotate to next alive proxy. */
  rotate(): boolean {
    const idx = this.pickNext(new Set([this.currentIdx]));
    if (idx === -1) return false;
    this.currentIdx = idx;
    this.config.log(`[proxy] 🔄 rotated to ${this.candidates[idx].url}`);
    return true;
  }

  /** Start periodic health checks. */
  private startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.healthCheck(), this.config.healthCheckMs);
  }

  /** Check current proxy health, rotate if dead. */
  private async healthCheck(): Promise<void> {
    if (this.disposed) return;
    const c = this.current;
    if (!c) return;

    try {
      const start = Date.now();
      const tokenUrl = this.config.targetUrl.replace(/\/$/, "") + "/api/auth/token";
      const res = await proxyRequest(c.url, tokenUrl, "{}", this.config.headers, this.config.timeoutMs);
      if (res.status === 200) {
        const parsed = JSON.parse(res.body);
        if (parsed.ok && parsed.data?.token) {
          c.latencyMs = Date.now() - start;
          c.consecutiveFails = 0;
          c.alive = true;
          c.lastCheck = Date.now();
          return;
        }
      }
    } catch {}

    c.consecutiveFails++;
    if (c.consecutiveFails >= this.config.maxFails) {
      c.alive = false;
      this.config.log(`[proxy] 💀 ${c.url} died — rotating`);
      this.rotate();
    }
  }

  /** Pick next alive proxy index (not in excluded set). */
  private pickNext(excluded: Set<number>): number {
    // Prefer alive proxies with lowest fails
    const alive = this.candidates
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => c.alive && !excluded.has(i))
      .sort((a, b) => a.c.consecutiveFails - b.c.consecutiveFails);

    return alive.length > 0 ? alive[0].i : -1;
  }

  /** Stop health checks. */
  dispose(): void {
    this.disposed = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
