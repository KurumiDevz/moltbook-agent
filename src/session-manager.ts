/**
 * SessionManager — hardened conversation state isolation
 *
 * Cookies: shared in data/gemini-session.json (backward compatible)
 * Conversations: per-key in data/sessions/<key>.json
 *
 * Each agent (main, sub-agents) gets its own conversation file,
 * preventing cross-contamination between concurrent AI calls.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { resolve } from "path";

const DATA_DIR = resolve(process.cwd(), "data");
const SESSIONS_DIR = resolve(DATA_DIR, "sessions");
const COOKIE_FILE = resolve(DATA_DIR, "gemini-session.json");

// ─── Types ───

export interface CookieState {
  cookies?: string;
  updatedAt?: string;
}

export interface ConversationState {
  conversationId?: string;
  responseId?: string;
  choiceId?: string;
  updatedAt?: string;
}

// ─── Cookie persistence (shared) ───

export function loadCookies(): CookieState {
  try {
    if (existsSync(COOKIE_FILE)) {
      return JSON.parse(readFileSync(COOKIE_FILE, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function saveCookies(state: CookieState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(COOKIE_FILE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* ignore */
  }
}

export function clearCookies(): void {
  saveCookies({});
}

// ─── Conversation persistence (per-key) ───

function ensureSessionsDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getConversationPath(key: string): string {
  // Sanitize key to prevent path traversal
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return resolve(SESSIONS_DIR, `${safe}.json`);
}

export function loadConversation(key: string): ConversationState {
  try {
    const filePath = getConversationPath(key);
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function saveConversation(key: string, state: ConversationState): void {
  try {
    ensureSessionsDir();
    const filePath = getConversationPath(key);
    writeFileSync(filePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* ignore */
  }
}

export function deleteConversation(key: string): void {
  try {
    const filePath = getConversationPath(key);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    /* ignore */
  }
}

export function listConversations(): Array<{ key: string; updatedAt?: string }> {
  try {
    ensureSessionsDir();
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const key = f.replace(/\.json$/, "");
      try {
        const state: ConversationState = JSON.parse(readFileSync(resolve(SESSIONS_DIR, f), "utf-8"));
        return { key, updatedAt: state.updatedAt };
      } catch {
        return { key, updatedAt: undefined };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Check if a conversation should be rotated (too old or too many turns).
 * Returns true if the conversation file is older than maxAgeMs.
 */
export function shouldRotateConversation(key: string, maxAgeMs: number = 12 * 60 * 60 * 1000): boolean {
  try {
    const filePath = getConversationPath(key);
    if (!existsSync(filePath)) return false;
    const stat = statSync(filePath);
    return (Date.now() - stat.mtimeMs) > maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Remove conversation files older than maxAgeMs.
 * Useful for cleaning up stale sub-agent sessions.
 */
export function cleanupOldSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  try {
    ensureSessionsDir();
    const now = Date.now();
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    let removed = 0;

    for (const f of files) {
      try {
        const filePath = resolve(SESSIONS_DIR, f);
        const stat = statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > maxAgeMs) {
          unlinkSync(filePath);
          removed++;
        }
      } catch {
        /* skip */
      }
    }

    return removed;
  } catch {
    return 0;
  }
}
