#!/usr/bin/env node
/**
 * Patch nimji's bard-utils.js:
 * 1. Respect BARD_UTILS_URL env var
 * 2. Cache minted auth token (55 min TTL) to avoid redundant /api/auth/token calls
 * Run after every `npm install` via postinstall hook.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/nimji/dist/bard-utils.js",
);

try {
  let code = fs.readFileSync(target, "utf8");
  let patched = false;

  // Patch 1: BARD_UTILS_URL env var
  const urlPatch = 'const _e = process.env.BARD_UTILS_URL || _u;';
  const urlOriginal = 'const _e = _u;';
  if (code.includes(urlPatch)) {
    // already patched
  } else if (code.includes(urlOriginal)) {
    code = code.replace(urlOriginal, urlPatch);
    patched = true;
  }

  // Patch 2: Add token cache variables
  const cacheVarsMarker = "let _cachedToken = null;";
  if (!code.includes(cacheVarsMarker)) {
    const insertAfter = 'const _ua = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";';
    const cacheVars = `${insertAfter}\nlet _cachedToken = null;\nlet _tokenExpiresAt = 0;`;
    if (code.includes(insertAfter)) {
      code = code.replace(insertAfter, cacheVars);
      patched = true;
    }
  }

  // Patch 3: Cache check at start of mintToken + store token after fetch
  const cacheCheck = `    const now = Date.now();
    if (_cachedToken && now < _tokenExpiresAt) {
        return _cachedToken;
    }
    const url = \`\${baseUrl}/api/auth/token\`;`;
  const cacheStore = `        return typed.data.token;
    });
    if (result.isErr())
        return null;
    const token = result.unwrap();
    if (token) {
        _cachedToken = token;
        _tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    }
    return token;`;

  if (!code.includes("if (_cachedToken && now < _tokenExpiresAt)")) {
    // Insert cache check before URL construction
    const mintUrlLine = '    const url = `${baseUrl}/api/auth/token`;';
    if (code.includes(mintUrlLine)) {
      code = code.replace(
        mintUrlLine,
        `    const now = Date.now();\n    if (_cachedToken && now < _tokenExpiresAt) {\n        return _cachedToken;\n    }\n${mintUrlLine}`
      );
      patched = true;
    }

    // Insert cache store after fetch
    const returnTokenLine = '        return typed.data.token;\n    });\n    if (result.isErr())\n        return null;\n    return result.unwrap();';
    if (code.includes(returnTokenLine)) {
      code = code.replace(
        returnTokenLine,
        `        return typed.data.token;\n    });\n    if (result.isErr())\n        return null;\n    const token = result.unwrap();\n    if (token) {\n        _cachedToken = token;\n        _tokenExpiresAt = Date.now() + 55 * 60 * 1000;\n    }\n    return token;`
      );
      patched = true;
    }
  }

  if (patched) {
    fs.writeFileSync(target, code, "utf8");
    console.log("[postinstall] patched nimji bard-utils.js (BARD_UTILS_URL + token cache)");
  }
} catch {
  // nimji not installed yet or file missing — skip silently
}
