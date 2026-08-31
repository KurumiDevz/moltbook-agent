/**
 * Test bard-utils connectivity — find a working proxy for Pterodactyl ↔ Pterodactyl.
 *
 * Uses HTTP CONNECT tunneling — works for both HTTP and HTTPS targets.
 * Zero external deps, compatible with Node 18+.
 *
 * Sources: proxifly, gnxD3RfTT2WE, jetkai
 *
 * Usage:
 *   npx tsx test-bard-utils.ts                          # test direct + find proxy
 *   npx tsx test-bard-utils.ts --direct-only             # only test direct
 *   npx tsx test-bard-utils.ts --find-proxy              # force proxy search
 *   BARD_UTILS_URL=http://... npx tsx test-bard-utils.ts  # custom URL
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import net from "node:net";
import tls from "node:tls";

const BARD_UTILS_URL = process.env.BARD_UTILS_URL || "http://45.13.236.245:25890";
const DIRECT_ONLY = process.argv.includes("--direct-only");
const FIND_PROXY = process.argv.includes("--find-proxy");
const TIMEOUT_MS = 8_000;
const MAX_PER_SOURCE = 20;
const CONCURRENCY = 8;

const UA = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";

// ─── Proxy sources ───

const PROXY_SOURCES = [
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

// ─── HTTP CONNECT tunnel ───
// Establishes a tunnel through an HTTP proxy to reach the target.
// Works for both HTTP (port 80) and HTTPS (port 443) targets.

function connectThroughProxy(proxyUrl: string, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const socket = net.connect(Number(proxy.port) || 80, proxy.hostname);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("CONNECT timeout"));
    }, TIMEOUT_MS);

    socket.on("connect", () => {
      // Send CONNECT request to proxy
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });

    let headerBuf = "";
    socket.on("data", (chunk) => {
      headerBuf += chunk.toString();
      // Wait for end of headers (\r\n\r\n)
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

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on("timeout", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("socket timeout"));
    });
  });
}

// ─── Send POST through tunnel (raw socket) ───

function postThroughTunnel(socket: net.Socket, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const body = JSON.stringify({});
    const path = target.pathname;

    const request =
      `POST ${path} HTTP/1.1\r\n` +
      `Host: ${target.hostname}${target.port ? ":" + target.port : ""}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `x-nimji-ua: ${UA}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      body;

    let responseBuf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("response timeout"));
    }, TIMEOUT_MS);

    socket.on("data", (chunk) => {
      responseBuf += chunk.toString();
    });

    socket.on("end", () => {
      clearTimeout(timer);
      // Parse HTTP response
      const headerEnd = responseBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        reject(new Error("no HTTP headers"));
        return;
      }
      const headerLine = responseBuf.split("\r\n")[0];
      const statusCode = parseInt(headerLine.split(" ")[1] || "0", 10);
      const responseBody = responseBuf.slice(headerEnd + 4);
      resolve({ status: statusCode, body: responseBody });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.write(request);
  });
}

// ─── Request via proxy ───
// Auto-detects: HTTP target → classic proxy (path=full URL), HTTPS target → CONNECT tunnel.

async function requestViaProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const target = new URL(targetUrl);
  const isHttps = target.protocol === "https:";

  if (isHttps) {
    // HTTPS target → must use CONNECT tunnel
    const targetPort = Number(target.port) || 443;
    const socket = await connectThroughProxy(proxyUrl, target.hostname, targetPort);
    const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
    return postThroughTunnel(tlsSocket as any, targetUrl);
  }

  // HTTP target → classic proxy (send full URL as path, no tunnel needed)
  return classicHttpProxy(proxyUrl, targetUrl);
}

// ─── Classic HTTP proxy (for HTTP targets) ───
// Sends the request with the full URL as the path — simple, no CONNECT.

function classicHttpProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const target = new URL(targetUrl);
    const body = JSON.stringify({});

    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      path: target.href,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nimji-ua": UA,
        "content-length": Buffer.byteLength(body),
        host: target.hostname + (target.port ? ":" + target.port : ""),
      },
      timeout: TIMEOUT_MS,
    });

    req.on("response", (res) => {
      let buf = "";
      res.on("data", (chunk) => (buf += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    req.write(body);
    req.end();
  });
}

// ─── Direct request ───

function requestDirect(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const body = JSON.stringify({});

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nimji-ua": UA,
          "content-length": Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    req.write(body);
    req.end();
  });
}

// ─── Fetch proxies from source ───

async function fetchSource(source: typeof PROXY_SOURCES[number]): Promise<string[]> {
  try {
    const res = await fetch(source.url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    return source.parse(text);
  } catch {
    return [];
  }
}

// ─── Test proxy ───

async function testProxy(proxy: string, targetUrl: string): Promise<boolean> {
  try {
    const res = await requestViaProxy(proxy, targetUrl);
    if (res.status === 200) {
      const parsed = JSON.parse(res.body);
      return parsed.ok === true && !!parsed.data?.token;
    }
  } catch {}
  return false;
}

// ─── Main ───

async function main() {
  const tokenUrl = `${BARD_UTILS_URL}/api/auth/token`;

  console.log(`\n🔗 bard-utils: ${BARD_UTILS_URL}\n`);

  // 1) Direct
  console.log("━━━ Direct ━━━");
  try {
    const res = await requestDirect(tokenUrl);
    const parsed = JSON.parse(res.body);
    if (parsed.ok && parsed.data?.token) {
      console.log(`   ✅ Direct works!`);
      if (!FIND_PROXY) {
        console.log("\n   No proxy needed from this machine. Use --find-proxy to search anyway.\n");
        return;
      }
      console.log("   (continuing proxy search anyway)\n");
    } else {
      console.log(`   ⚠️  ${res.status} — no valid token\n`);
    }
  } catch (err: any) {
    console.log(`   ❌ ${err.message}\n`);
  }

  if (DIRECT_ONLY) return;

  // 2) Gather from all sources
  console.log("━━━ Gathering proxies ━━━\n");

  const allProxies: string[] = [];

  for (const source of PROXY_SOURCES) {
    const proxies = await fetchSource(source);
    const sampled = proxies.sort(() => Math.random() - 0.5).slice(0, MAX_PER_SOURCE);
    allProxies.push(...sampled);
    console.log(`   ${source.name.padEnd(16)} ${sampled.length}/${proxies.length} proxies`);
  }

  const unique = [...new Set(allProxies)];
  console.log(`\n   Total: ${unique.length} unique proxies to test\n`);

  if (unique.length === 0) {
    console.log("   ⚠️  No proxies gathered.\n");
    return;
  }

  // 3) Test in parallel batches
  console.log("━━━ Testing ━━━\n");

  const working: string[] = [];

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (proxy) => {
        const ok = await testProxy(proxy, tokenUrl);
        console.log(`   ${ok ? "✅" : "❌"} ${proxy}`);
        return ok ? proxy : null;
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) working.push(r.value);
    }

    if (working.length >= 3) break;
  }

  // 4) Results
  console.log("\n━━━ Results ━━━\n");

  if (working.length === 0) {
    console.log("   ⚠️  No working proxy found.");
    console.log("   Try: re-run (lists change), different Pterodactyl node, or self-host proxy\n");
    return;
  }

  console.log(`   🏆 Working proxies: ${working.length}`);
  console.log(`   Best: ${working[0]}\n`);
  console.log("   Add to Pterodactyl .env:");
  console.log(`   BARD_UTILS_PROXY=${working[0]}\n`);
}

main();
