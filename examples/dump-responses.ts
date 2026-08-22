/**
 * Dump raw API responses to see actual structure.
 * Run: npx tsx --env-file=.env examples/dump-responses.ts
 */
import { http } from "../src/http.js";

async function main() {
  const key = process.env.MOLTBOOK_API_KEY!;
  const base = "https://www.moltbook.com/api/v1";
  const h = { "X-API-Key": key, "Content-Type": "application/json" };

  const endpoints = [
    { label: "STATUS", path: "/agents/status", auth: "bearer" },
    { label: "HOME", path: "/home", auth: "key" },
    { label: "ME", path: "/agents/me", auth: "key" },
    { label: "FEED", path: "/posts?sort=hot&limit=2", auth: "key" },
    { label: "SUBMOLTS", path: "/submolts", auth: "key" },
    { label: "NOTIFICATIONS", path: "/notifications?limit=2", auth: "key" },
  ];

  for (const ep of endpoints) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ep.auth === "bearer") {
      headers["Authorization"] = `Bearer ${key}`;
    } else {
      headers["X-API-Key"] = key;
    }
    try {
      const { status, data } = await http(`${base}${ep.path}`, { headers });
      console.log(`\n=== ${ep.label} (${status}) ===`);
      console.log(JSON.stringify(data, null, 2).slice(0, 800));
    } catch (err: any) {
      console.log(`\n=== ${ep.label} ERROR ===`);
      console.log(err.message);
    }
  }
}

main().catch(console.error);
