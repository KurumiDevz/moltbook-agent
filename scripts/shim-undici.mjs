/**
 * Postinstall: downgrade undici to v6 on Node <22 for compatibility.
 * Also patches nimji's parser to concat all response candidates (full output).
 *
 * Runs automatically via "postinstall" in package.json.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const nodeVersion = process.versions.node;
const [major] = nodeVersion.split(".").map(Number);

// ─── Undici swap (Node <22 only) ───
if (major < 22) {
  try {
    const pkg = JSON.parse(readFileSync("node_modules/undici/package.json", "utf8"));
    const installedMajor = parseInt(pkg.version.split(".")[0], 10);
    if (installedMajor <= 6) {
      console.log(`[undici-swap] Node ${nodeVersion} — undici@${pkg.version} already compatible`);
    } else {
      console.log(`[undici-swap] Node ${nodeVersion} — downgrading undici to v6 for compatibility`);
      execSync("npm install undici@^6.27.0 --no-save", { stdio: "inherit" });
      console.log("[undici-swap] undici@6 installed successfully");
    }
  } catch {
    console.log(`[undici-swap] Node ${nodeVersion} — installing undici@v6 for compatibility`);
    try {
      execSync("npm install undici@^6.27.0 --no-save", { stdio: "inherit" });
      console.log("[undici-swap] undici@6 installed successfully");
    } catch (err) {
      console.warn("[undici-swap] failed to install undici:", err.message);
    }
  }

  // Patch nimji's nested undici
  const nimjiUndici = path.join("node_modules", "nimji", "node_modules", "undici");
  const topUndici = path.join("node_modules", "undici");

  if (existsSync(nimjiUndici)) {
    try {
      const nimjiPkg = JSON.parse(readFileSync(path.join(nimjiUndici, "package.json"), "utf8"));
      const nimjiMajor = parseInt(nimjiPkg.version.split(".")[0], 10);
      if (nimjiMajor > 6) {
        console.log(`[undici-swap] patching nimji's undici@${nimjiPkg.version} → copy of top-level`);
        rmSync(nimjiUndici, { recursive: true, force: true });
        if (existsSync(topUndici)) {
          cpSync(topUndici, nimjiUndici, { recursive: true });
          console.log("[undici-swap] nimji undici patched successfully");
        }
      } else {
        console.log(`[undici-swap] nimji undici@${nimjiPkg.version} already compatible`);
      }
    } catch (err) {
      console.warn("[undici-swap] failed to patch nimji undici:", err.message);
    }
  }

  // Scan for other nested undici@8
  try {
    const topPkg = JSON.parse(readFileSync(path.join(topUndici, "package.json"), "utf8"));
    const topMajor = parseInt(topPkg.version.split(".")[0], 10);
    if (topMajor <= 6) {
      const nmDir = path.join("node_modules");
      for (const pkg of readdirSync(nmDir)) {
        if (pkg.startsWith(".")) continue;
        const nested = path.join(nmDir, pkg, "node_modules", "undici");
        if (!existsSync(nested) || nested === nimjiUndici) continue;
        try {
          const nestedPkg = JSON.parse(readFileSync(path.join(nested, "package.json"), "utf8"));
          const nestedMajor = parseInt(nestedPkg.version.split(".")[0], 10);
          if (nestedMajor > 6) {
            console.log(`[undici-swap] patching ${pkg}/undici@${nestedPkg.version} → copy of top-level`);
            rmSync(nested, { recursive: true, force: true });
            cpSync(topUndici, nested, { recursive: true });
            console.log(`[undici-swap] ${pkg} undici patched`);
          }
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* top-level undici not installed, skip scan */ }

  console.log("[undici-swap] done");
} else {
  console.log(`[undici-swap] Node ${nodeVersion} — undici@8 supported, no swap needed`);
}

// ─── Patch nimji parser: pick longest candidate instead of first ───
// nimji's extractResponse picks ordered[0] (highest score), but Gemini returns
// the full response as overlapping fragments. The longest candidate is usually
// the complete response. Also filter out UI noise like "3.5 Flash-Lite", "Searching the web".
const parserPath = path.join("node_modules", "nimji", "dist", "parser.js");
if (existsSync(parserPath)) {
  try {
    let src = readFileSync(parserPath, "utf-8");

    // Patch 1: add noise filter to the ranking filter
    const noiseNeedle = "return !NOISE_PHRASES.some((phrase) => item.value.includes(phrase));";
    const noiseReplacement = [
      "if (NOISE_PHRASES.some((phrase) => item.value.includes(phrase))) return false;",
      "if (/^\\d+\\.\\d+\\s+(Flash|Pro|Gemini)/i.test(item.value.trim())) return false;",
      "if (/^(Searching the web|Don't personalize|Google Search)$/i.test(item.value.trim())) return false;",
      "return true;",
    ].join("\n        ");
    if (src.includes(noiseNeedle)) {
      src = src.replace(noiseNeedle, noiseReplacement);
      console.log("[nimji-patch] added noise filter");
    }

    // Patch 2: pick longest candidate instead of first
    const oldTop = "const top = ordered[0];";
    const newTop = "const top = ordered.reduce((best, item) => item.value.length > best.value.length ? item : best, ordered[0] ?? { value: null });";
    if (src.includes(oldTop)) {
      src = src.replace(oldTop, newTop);
      console.log("[nimji-patch] now picking longest candidate");
    }

    writeFileSync(parserPath, src, "utf-8");
    console.log("[nimji-patch] parser.js patched successfully");
  } catch (err) {
    console.warn("[nimji-patch] failed to patch parser.js:", err.message);
  }
}

// ─── Patch nimji auth: || → ?? for fSid/atToken rotation ───
// nimji uses || (truthy check) which keeps stale values when our refresh
// provides fresh tokens. ?? (nullish coalescing) ensures fresh values win.
const authFiles = [
  path.join("node_modules", "nimji", "dist", "cli.js"),
  path.join("node_modules", "nimji", "dist", "runtime", "keepalive.js"),
];
const authPatches = [
  {
    find: ".auth.fSid || refresh.fSid",
    replace: ".auth.fSid ?? refresh.fSid",
    label: "fSid: || → ??",
  },
  {
    find: ".auth.atToken || refresh.atToken",
    replace: ".auth.atToken ?? refresh.atToken",
    label: "atToken: || → ??",
  },
];
for (const filePath of authFiles) {
  if (!existsSync(filePath)) continue;
  try {
    let src = readFileSync(filePath, "utf-8");
    let patched = false;
    for (const { find, replace, label } of authPatches) {
      if (src.includes(find)) {
        src = src.replaceAll(find, replace);
        console.log(`[nimji-patch] ${path.basename(filePath)}: ${label}`);
        patched = true;
      }
    }
    if (patched) {
      writeFileSync(filePath, src, "utf-8");
    }
  } catch (err) {
    console.warn(`[nimji-patch] failed to patch ${path.basename(filePath)}:`, err.message);
  }
}
