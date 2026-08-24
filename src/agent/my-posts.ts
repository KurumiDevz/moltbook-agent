/**
 * Local post tracker — persists our own post titles for topic dedup.
 * The Moltbook API's `author` param is broken (returns empty), so we track locally.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = resolve(import.meta.dirname ?? ".", "..", "data");
const FILE = resolve(DATA_DIR, "my-posts.json");

export type TrackedPost = {
  title: string;
  type: string;
  submolt: string;
  postId: string;
  timestamp: number;
};

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadMyPosts(): TrackedPost[] {
  try {
    if (!existsSync(FILE)) return [];
    return JSON.parse(readFileSync(FILE, "utf-8")) as TrackedPost[];
  } catch {
    return [];
  }
}

export function saveMyPost(post: Omit<TrackedPost, "timestamp">) {
  ensureDir();
  const posts = loadMyPosts();
  // Dedup by postId
  if (posts.some((p) => p.postId === post.postId)) return;
  posts.push({ ...post, timestamp: Date.now() });
  // Keep last 50
  writeFileSync(FILE, JSON.stringify(posts.slice(-50), null, 2));
}

export function getOwnTitles(): string[] {
  return loadMyPosts().map((p) => p.title).filter(Boolean);
}

export function getOwnTopics(): string[] {
  return loadMyPosts().map((p) => p.type).filter(Boolean);
}
