/**
 * Quick proxy transport test — fetches a free proxy, tests it against bard-utils.
 * Usage: npx tsx test-proxy-transport.ts
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

const TARGET = process.env.BARD_UTILS_URL || "https://bard-utils.onrender.com";
const TOKEN_PATH = "/api/auth/token";
const UA = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";
const TIMEOUT = 8_000;

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

// Classic HTTP proxy (HTTP target)
function classicProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { url: cleanProxy, auth } = extractProxyAuth(proxyUrl);
    const proxy = new URL(cleanProxy);
    const target = new URL(targetUrl);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": "2",
      host: target.hostname + (target.port ? ":" + target.port : ""),
      "x-nimji-ua": UA,
    };
    if (auth) headers["proxy-authorization"] = auth;

    console.log(`  [classic] POST ${target.href} via ${cleanProxy}`);

    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      path: target.href,
      method: "POST",
      headers,
      timeout: TIMEOUT,
    });

    req.on("response", (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        console.log(`  [classic] status=${res.statusCode} body=${buf.slice(0, 200)}`);
        resolve({ status: res.statusCode ?? 0, body: buf });
      });
    });

    req.on("error", (err) => {
      console.log(`  [classic] error: ${err.message}`);
      reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });

    req.write("{}");
    req.end();
  });
}

// CONNECT tunnel (HTTPS target)
function connectTunnel(proxyUrl: string, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const { url: cleanProxy, auth } = extractProxyAuth(proxyUrl);
    const proxy = new URL(cleanProxy);
    const socket = net.connect(Number(proxy.port) || 80, proxy.hostname);

    const timer = setTimeout(() => { socket.destroy(); reject(new Error("CONNECT timeout")); }, TIMEOUT);

    socket.on("connect", () => {
      let header = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (auth) header += `Proxy-Authorization: ${auth}\r\n`;
      socket.write(header + "\r\n");
    });

    let headerBuf = "";
    socket.on("data", (chunk) => {
      headerBuf += chunk.toString();
      if (headerBuf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        if (headerBuf.startsWith("HTTP/") && headerBuf.includes("200")) {
          console.log(`  [tunnel] CONNECT OK`);
          resolve(socket);
        } else {
          console.log(`  [tunnel] CONNECT rejected: ${headerBuf.split("\r\n")[0]}`);
          socket.destroy();
          reject(new Error(`CONNECT rejected: ${headerBuf.split("\r\n")[0]}`));
        }
      }
    });

    socket.on("error", (err) => { clearTimeout(timer); console.log(`  [tunnel] error: ${err.message}`); reject(err); });
    socket.on("timeout", () => { clearTimeout(timer); socket.destroy(); reject(new Error("socket timeout")); });
  });
}

async function testTunnel(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const socket = await connectTunnel(proxyUrl, target.hostname, targetPort);

  // Only TLS for HTTPS targets
  let sendSocket: net.Socket | tls.TLSSocket = socket;
  if (target.protocol === "https:") {
    sendSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
  }

  return new Promise((resolve, reject) => {
    const body = "{}";
    const path = target.pathname;
    const request =
      `POST ${path} HTTP/1.1\r\n` +
      `Host: ${target.hostname}${target.port ? ":" + target.port : ""}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `x-nimji-ua: ${UA}\r\n` +
      `Connection: close\r\n\r\n` +
      body;

    let responseBuf = "";
    const timer = setTimeout(() => { sendSocket.destroy(); reject(new Error("response timeout")); }, TIMEOUT);

    sendSocket.on("data", (chunk) => { responseBuf += chunk.toString(); });
    sendSocket.on("end", () => {
      clearTimeout(timer);
      const headerEnd = responseBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) { reject(new Error("no HTTP headers")); return; }
      const statusCode = parseInt(responseBuf.split("\r\n")[0].split(" ")[1] || "0", 10);
      const responseBody = responseBuf.slice(headerEnd + 4);
      console.log(`  [tunnel] status=${statusCode} body=${responseBody.slice(0, 200)}`);
      resolve({ status: statusCode, body: responseBody });
    });

    sendSocket.on("error", (err) => { clearTimeout(timer); console.log(`  [tunnel] error: ${err.message}`); reject(err); });
    sendSocket.write(request);
  });
}

async function main() {
  const isHttps = new URL(TARGET).protocol === "https:";
  console.log(`Target: ${TARGET} (${isHttps ? "HTTPS → need CONNECT tunnel" : "HTTP → classic proxy"})\n`);

  // Read proxy.txt
  const fs = await import("node:fs");
  const lines = fs.readFileSync("proxy.txt", "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(`proxy.txt: ${lines.length} lines\n`);

  // Test each
  for (const line of lines) {
    console.log(`Testing: ${line}`);
    try {
      const start = Date.now();
      // Always use CONNECT tunnel — works for both HTTP and HTTPS targets
      const result = await testTunnel(line, TARGET + TOKEN_PATH);
      const elapsed = Date.now() - start;

      if (result.status === 200) {
        const parsed = JSON.parse(result.body);
        if (parsed.ok && parsed.data?.token) {
          console.log(`  ✅ WORKING (${elapsed}ms)\n`);
        } else {
          console.log(`  ⚠️ 200 but no token: ${result.body.slice(0, 100)} (${elapsed}ms)\n`);
        }
      } else {
        console.log(`  ❌ status ${result.status}: ${result.body.slice(0, 100)} (${elapsed}ms)\n`);
      }
    } catch (err: any) {
      console.log(`  ❌ ${err.message}\n`);
    }
  }
}

main();
