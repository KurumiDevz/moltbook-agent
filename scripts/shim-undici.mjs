/**
 * Postinstall: downgrade undici to v6 on Node <22 for compatibility.
 * Base dependency is undici@^8.4.1 (latest, requires Node >=22.19.0).
 * On Node <22, we swap to undici@6.x --no-save (supports Node 18+ with full ProxyAgent).
 * On Node 22+, undici@8 stays as-is — no action needed.
 *
 * Runs automatically via "postinstall" in package.json.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const nodeVersion = process.versions.node;
const [major] = nodeVersion.split(".").map(Number);

if (major >= 22) {
  console.log(`[undici-swap] Node ${nodeVersion} — undici@8 supported, no swap needed`);
  process.exit(0);
}

// Node <22 — check current installed version
try {
  const pkg = JSON.parse(readFileSync("node_modules/undici/package.json", "utf8"));
  const installedMajor = parseInt(pkg.version.split(".")[0], 10);
  if (installedMajor <= 6) {
    console.log(`[undici-swap] Node ${nodeVersion} — undici@${pkg.version} already compatible`);
    process.exit(0);
  }
} catch {
  // Not installed yet, will install below
}

console.log(`[undici-swap] Node ${nodeVersion} — downgrading undici to v6 for compatibility`);
try {
  execSync("npm install undici@^6.27.0 --no-save", { stdio: "inherit" });
  console.log("[undici-swap] undici@6 installed successfully");
} catch (err) {
  console.warn("[undici-swap] failed to downgrade undici:", err.message);
  console.warn("[undici-swap] undici@8 may not work on this Node version");
}
