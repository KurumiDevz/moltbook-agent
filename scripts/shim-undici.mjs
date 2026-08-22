/**
 * Postinstall: downgrade undici to v6 on Node <22 for compatibility.
 * Base dependency is undici@^8.4.1 (latest, requires Node >=22.19.0).
 * On Node <22, we swap to undici@6.x --no-save (supports Node 18+ with full ProxyAgent).
 * Also patches nimji's nested undici copy which bundles its own v8.
 * On Node 22+, undici@8 stays as-is — no action needed.
 *
 * Runs automatically via "postinstall" in package.json.
 */
import { execSync } from "node:child_process";
import { readFileSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

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
  } else {
    console.log(`[undici-swap] Node ${nodeVersion} — downgrading undici to v6 for compatibility`);
    execSync("npm install undici@^6.27.0 --no-save", { stdio: "inherit" });
    console.log("[undici-swap] undici@6 installed successfully");
  }
} catch {
  // Not installed yet, will install below
  console.log(`[undici-swap] Node ${nodeVersion} — installing undici@v6 for compatibility`);
  try {
    execSync("npm install undici@^6.27.0 --no-save", { stdio: "inherit" });
    console.log("[undici-swap] undici@6 installed successfully");
  } catch (err) {
    console.warn("[undici-swap] failed to install undici:", err.message);
  }
}

// ─── Patch nimji's nested undici ───
// nimji bundles its own undici@8 in node_modules/nimji/node_modules/undici
// which doesn't get touched by the top-level install. Replace it with a
// copy/symlink to the top-level undici@6.
const nimjiUndici = path.join("node_modules", "nimji", "node_modules", "undici");
const topUndici = path.join("node_modules", "undici");

if (existsSync(nimjiUndici)) {
  try {
    const nimjiPkg = JSON.parse(readFileSync(path.join(nimjiUndici, "package.json"), "utf8"));
    const nimjiMajor = parseInt(nimjiPkg.version.split(".")[0], 10);

    if (nimjiMajor > 6) {
      console.log(`[undici-swap] patching nimji's undici@${nimjiPkg.version} → copy of top-level`);

      // Remove nimji's nested undici
      rmSync(nimjiUndici, { recursive: true, force: true });

      // Copy top-level undici into nimji's node_modules
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

// Also check for any other nested undici@8 in node_modules
try {
  const topPkg = JSON.parse(readFileSync(path.join(topUndici, "package.json"), "utf8"));
  const topMajor = parseInt(topPkg.version.split(".")[0], 10);

  if (topMajor <= 6) {
    // Scan for other nested undici@8 copies
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
