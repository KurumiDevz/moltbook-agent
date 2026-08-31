#!/usr/bin/env node
/**
 * Patch nimji's bard-utils.js to respect BARD_UTILS_URL env var.
 * Run after every `npm install` via postinstall hook.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/nimji/dist/bard-utils.js",
);

const PATCH_LINE = 'const _e = process.env.BARD_UTILS_URL || _u;';
const ORIGINAL_LINE = 'const _e = _u;';

try {
  let code = fs.readFileSync(target, "utf8");
  if (code.includes(PATCH_LINE)) {
    // Already patched
    process.exit(0);
  }
  code = code.replace(ORIGINAL_LINE, PATCH_LINE);
  fs.writeFileSync(target, code, "utf8");
  console.log("[postinstall] patched nimji bard-utils.js to use BARD_UTILS_URL");
} catch {
  // nimji not installed yet or file missing — skip silently
}
