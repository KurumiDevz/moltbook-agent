/**
 * Diagnostic: test Gemini with refreshSession + tokens.
 * Run: npx tsx --env-file=.env examples/diagnose-gemini.ts
 */
import { create } from "nimji";
import { readFileSync } from "node:fs";

// Inline refreshSession — matches nimji's bard-utils exactly
async function refreshSession(opts: {
  cookies: string;
  userAgent?: string;
}): Promise<{ cookies: string; fSid: string; atToken: string } | null> {
  const baseUrl = "https://bard-utils.onrender.com";
  const ua = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";

  try {
    // Step 1: Get auth token
    const tokenRes = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nimji-ua": ua },
      body: JSON.stringify({}),
      redirect: "follow",
    });
    const tokenJson = await tokenRes.json() as any;
    console.log("   Token response:", JSON.stringify(tokenJson).slice(0, 200));
    if (!tokenJson.ok || !tokenJson.data) return null;

    // Step 2: Refresh session
    const refreshRes = await fetch(`${baseUrl}/api/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenJson.data.token}`,
        "x-nimji-ua": ua,
      },
      body: JSON.stringify({ cookies: opts.cookies }),
      redirect: "follow",
    });
    const refreshJson = await refreshRes.json() as any;
    console.log("   Refresh response:", JSON.stringify(refreshJson).slice(0, 300));
    if (!refreshJson.ok || !refreshJson.data) return null;

    return {
      cookies: refreshJson.data.cookies,
      fSid: refreshJson.data.fSid ?? "",
      atToken: refreshJson.data.atToken ?? "",
    };
  } catch (err: any) {
    console.log("   ❌ Refresh error:", err.message);
    return null;
  }
}

async function main() {
  const cookies = process.env.COOKIES ?? "";
  if (!cookies) {
    console.log("❌ No COOKIES in env");
    process.exit(1);
  }

  console.log("1. Refreshing session via bard-utils...");
  const refresh = await refreshSession({ cookies });
  if (!refresh) {
    console.log("❌ Session refresh failed");
    process.exit(1);
  }
  console.log("   ✅ fSid:", refresh.fSid.slice(0, 20) + "...");
  console.log("   ✅ atToken:", refresh.atToken.slice(0, 20) + "...");

  console.log("\n2. Creating nimji client with tokens...");
  const client = create({
    COOKIES: refresh.cookies,
    MODEL: "flash",
    AT_TOKEN: refresh.atToken,
    F_SID: refresh.fSid,
  });

  console.log("   Client created, sending 'say OK'...");

  const result = await client.generate({ prompt: "say OK" });

  if (result.isErr()) {
    console.log("   ❌ Error:", result.error.message);
  } else {
    console.log("   ✅ Response:", result.value.text?.slice(0, 200));
    console.log("   Status:", result.value.meta.statusCode);
    console.log("   Chunks:", result.value.meta.chunkCount);
  }

  client.stopKeepalive();
}

main().catch(console.error);
