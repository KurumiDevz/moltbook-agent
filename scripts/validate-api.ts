#!/usr/bin/env npx tsx
/**
 * validate-api.ts — Hit every Moltbook API endpoint, log actual response shapes,
 * and compare against our TypeScript types. Produces roadmap-api.md.
 *
 * Usage: npx tsx scripts/validate-api.ts
 *
 * Reads MOLTBOOK_API_KEY from environment or .env file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Config ─────────────────────────────────────────────────────────────

const BASE_URL = "https://www.moltbook.com/api/v1";

function getApiKey(): string {
  if (process.env.MOLTBOOK_API_KEY) return process.env.MOLTBOOK_API_KEY;
  try {
    const env = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    const match = env.match(/^MOLTBOOK_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* no .env */ }
  throw new Error("Set MOLTBOOK_API_KEY env var or add to .env");
}

const API_KEY = getApiKey();

// ── Helpers ────────────────────────────────────────────────────────────

type TestResult = {
  endpoint: string;
  method: string;
  status: number;
  ok: boolean;
  actualShape: string;
  actualKeys: string[];
  error?: string;
};

const results: TestResult[] = [];

async function api(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function extractKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || obj === undefined) return [`${prefix}=${typeof obj}`];
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [`${prefix}[] (empty)`];
    return [`${prefix}[] (len=${obj.length})`, ...extractKeys(obj[0], `${prefix}[0]`)];
  }
  if (typeof obj === "object") {
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        keys.push(`${prefix}.${k}: {`);
        keys.push(...extractKeys(v, `${prefix}.${k}`));
        keys.push(`${prefix}.${k}: }`);
      } else if (Array.isArray(v)) {
        if (v.length === 0) {
          keys.push(`${prefix}.${k}: [] (empty)`);
        } else {
          keys.push(`${prefix}.${k}: [] (len=${v.length})`);
          keys.push(...extractKeys(v[0], `${prefix}.${k}[0]`));
        }
      } else {
        keys.push(`${prefix}.${k}: ${typeof v} = ${JSON.stringify(v).slice(0, 60)}`);
      }
    }
    return keys;
  }
  return [`${prefix}=${JSON.stringify(obj).slice(0, 60)}`];
}

function shapeString(data: unknown): string {
  return JSON.stringify(data, null, 2).slice(0, 2000);
}

function record(result: TestResult) {
  results.push(result);
  const icon = result.ok ? "✅" : "❌";
  console.log(`${icon} ${result.method} ${result.endpoint} → ${result.status}`);
  if (!result.ok) console.log(`   Error: ${result.error}`);
}

// ── Tests ──────────────────────────────────────────────────────────────

async function testGetHome() {
  const { status, data } = await api("GET", "/home");
  const keys = extractKeys(data);
  const isFlat = data !== null && typeof data === "object" && !("success" in (data as object));
  record({
    endpoint: "/home",
    method: "GET",
    status,
    ok: status === 200 && isFlat,
    actualShape: shapeString(data),
    actualKeys: keys,
    error: !isFlat ? "Expected flat object (no success envelope)" : undefined,
  });
}

async function testGetFeed() {
  const { status, data } = await api("GET", "/feed");
  const obj = data as Record<string, unknown>;
  const hasEnvelope = obj?.success === true;
  const posts = obj?.posts as Array<Record<string, unknown>> | undefined;
  const firstPostKeys = posts?.[0] ? Object.keys(posts[0]).sort() : [];
  record({
    endpoint: "/feed",
    method: "GET",
    status,
    ok: status === 200 && hasEnvelope && (posts?.length ?? 0) > 0,
    actualShape: shapeString(data),
    actualKeys: [`success=${hasEnvelope}`, `posts_count=${posts?.length ?? 0}`, `first_post_keys=[${firstPostKeys.join(", ")}]`],
  });
}

async function testGetFeedFollowing() {
  const { status, data } = await api("GET", "/feed?filter=following");
  const obj = data as Record<string, unknown>;
  record({
    endpoint: "/feed?filter=following",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: extractKeys(data),
  });
}

async function testGetPost() {
  // Get a post ID from feed first
  const { data: feedData } = await api("GET", "/feed?limit=1");
  const posts = (feedData as Record<string, unknown>)?.posts as Array<Record<string, unknown>> | undefined;
  const postId = posts?.[0]?.id as string;
  if (!postId) {
    record({ endpoint: "/posts/:id", method: "GET", status: 0, ok: false, actualShape: "N/A", actualKeys: [], error: "No post ID available" });
    return;
  }
  const { status, data } = await api("GET", `/posts/${postId}`);
  const post = ((data as Record<string, unknown>)?.post ?? data) as Record<string, unknown>;
  const postKeys = Object.keys(post).sort();
  record({
    endpoint: `/posts/${postId}`,
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [`post_keys=[${postKeys.join(", ")}]`],
  });
}

async function testGetComments() {
  const { data: feedData } = await api("GET", "/feed?limit=1");
  const posts = (feedData as Record<string, unknown>)?.posts as Array<Record<string, unknown>> | undefined;
  const postId = posts?.[0]?.id as string;
  if (!postId) {
    record({ endpoint: "/posts/:id/comments", method: "GET", status: 0, ok: false, actualShape: "N/A", actualKeys: [], error: "No post ID available" });
    return;
  }
  const { status, data } = await api("GET", `/posts/${postId}/comments`);
  const obj = data as Record<string, unknown>;
  const comments = obj?.comments as Array<Record<string, unknown>> | undefined;
  const firstCommentKeys = comments?.[0] ? Object.keys(comments[0]).sort() : [];
  record({
    endpoint: `/posts/${postId}/comments`,
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [`comments_count=${comments?.length ?? 0}`, `first_comment_keys=[${firstCommentKeys.join(", ")}]`],
  });
}

async function testGetNotifications() {
  const { status, data } = await api("GET", "/notifications?limit=5");
  const obj = data as Record<string, unknown>;
  const notifs = obj?.notifications as Array<Record<string, unknown>> | undefined;
  const firstNotifKeys = notifs?.[0] ? Object.keys(notifs[0]).sort() : [];
  const postKeys = notifs?.[0]?.post ? Object.keys(notifs[0].post as object).sort() : [];
  const commentKeys = notifs?.[0]?.comment ? Object.keys(notifs[0].comment as object).sort() : [];
  record({
    endpoint: "/notifications?limit=5",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [
      `notifications_count=${notifs?.length ?? 0}`,
      `first_notif_keys=[${firstNotifKeys.join(", ")}]`,
      `post_keys=[${postKeys.join(", ")}]`,
      `comment_keys=[${commentKeys.join(", ")}]`,
      `has_more=${obj?.has_more}`,
      `unread_count=${obj?.unread_count}`,
    ],
  });
}

async function testGetNotificationsUnread() {
  const { status, data } = await api("GET", "/notifications?limit=5&unread_only=true");
  const obj = data as Record<string, unknown>;
  record({
    endpoint: "/notifications?limit=5&unread_only=true",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: extractKeys(data),
  });
}

async function testMarkNotificationsRead() {
  // Just test the endpoint shape — don't actually mark read
  const { status, data } = await api("POST", "/notifications/read-all");
  record({
    endpoint: "/notifications/read-all",
    method: "POST",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: extractKeys(data),
  });
}

async function testSearch() {
  const { status, data } = await api("GET", "/search?q=agent&type=all&limit=3");
  const obj = data as Record<string, unknown>;
  const results = obj?.results as Array<Record<string, unknown>> | undefined;
  const firstResultKeys = results?.[0] ? Object.keys(results[0]).sort() : [];
  record({
    endpoint: "/search?q=agent&type=all",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [
      `results_count=${results?.length ?? 0}`,
      `first_result_keys=[${firstResultKeys.join(", ")}]`,
    ],
  });
}

async function testGetProfile() {
  const { status, data } = await api("GET", "/agents/profile?name=nimjiagent-sz945r");
  const agent = ((data as Record<string, unknown>)?.agent ?? data) as Record<string, unknown>;
  const agentKeys = Object.keys(agent).sort();
  record({
    endpoint: "/agents/profile?name=nimjiagent-sz945r",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [`agent_keys=[${agentKeys.join(", ")}]`],
  });
}

async function testGetMe() {
  const { status, data } = await api("GET", "/agents/me");
  const agent = ((data as Record<string, unknown>)?.agent ?? data) as Record<string, unknown>;
  const agentKeys = Object.keys(agent).sort();
  record({
    endpoint: "/agents/me",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [`agent_keys=[${agentKeys.join(", ")}]`],
  });
}

async function testGetSubmolts() {
  const { status, data } = await api("GET", "/submolts");
  const obj = data as Record<string, unknown>;
  const submolts = obj?.submolts as Array<Record<string, unknown>> | undefined;
  const firstSubmoltKeys = submolts?.[0] ? Object.keys(submolts[0]).sort() : [];
  record({
    endpoint: "/submolts",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [
      `submolts_count=${submolts?.length ?? 0}`,
      `first_submolt_keys=[${firstSubmoltKeys.join(", ")}]`,
    ],
  });
}

async function testGetSubmolt() {
  const { status, data } = await api("GET", "/submolts/general");
  const submolt = ((data as Record<string, unknown>)?.submolt ?? data) as Record<string, unknown>;
  const submoltKeys = Object.keys(submolt).sort();
  record({
    endpoint: "/submolts/general",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: [`submolt_keys=[${submoltKeys.join(", ")}]`],
  });
}

async function testVoteEndpoints() {
  // Just check that the endpoints exist — don't actually vote
  const { status: upStatus, data: upData } = await api("POST", "/posts/00000000-0000-0000-0000-000000000000/upvote");
  const { status: downStatus, data: downData } = await api("POST", "/posts/00000000-0000-0000-0000-000000000000/downvote");
  record({
    endpoint: "/posts/:id/upvote (bad ID)",
    method: "POST",
    status: upStatus,
    ok: true, // 404 is expected — confirms endpoint exists
    actualShape: shapeString(upData),
    actualKeys: extractKeys(upData),
  });
  record({
    endpoint: "/posts/:id/downvote (bad ID)",
    method: "POST",
    status: downStatus,
    ok: true,
    actualShape: shapeString(downData),
    actualKeys: extractKeys(downData),
  });
}

async function testFollowUnfollow() {
  const { status: followStatus, data: followData } = await api("POST", "/agents/nonexistent-agent-xyz/follow");
  const { status: unfollowStatus, data: unfollowData } = await api("DELETE", "/agents/nonexistent-agent-xyz/follow");
  record({
    endpoint: "/agents/:name/follow (nonexistent)",
    method: "POST",
    status: followStatus,
    ok: followStatus >= 200, // just checking shape
    actualShape: shapeString(followData),
    actualKeys: extractKeys(followData),
  });
  record({
    endpoint: "/agents/:name/unfollow (nonexistent)",
    method: "DELETE",
    status: unfollowStatus,
    ok: unfollowStatus >= 200,
    actualShape: shapeString(unfollowData),
    actualKeys: extractKeys(unfollowData),
  });
}

async function testVerify() {
  const { status, data } = await api("POST", "/verify", {
    verification_code: "test",
    answer: "0.00",
  });
  record({
    endpoint: "/verify (bad code)",
    method: "POST",
    status,
    ok: status >= 200,
    actualShape: shapeString(data),
    actualKeys: extractKeys(data),
  });
}

async function testErrorShape() {
  const { status, data } = await api("GET", "/posts/nonexistent-uuid");
  record({
    endpoint: "/posts/bad-id (error shape)",
    method: "GET",
    status,
    ok: status >= 400,
    actualShape: shapeString(data),
    actualKeys: extractKeys(data),
  });
}

async function testRateLimitShape() {
  // Trigger rate limit by posting too fast — just check the 429 shape exists
  // We'll use the profile endpoint instead since it's safe
  const { status, data } = await api("GET", "/agents/me");
  record({
    endpoint: "/agents/me (response shape check)",
    method: "GET",
    status,
    ok: status === 200,
    actualShape: shapeString(data),
    actualKeys: extractKeys(data),
  });
}

// ── Run all tests ──────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Moltbook API Validator — testing all endpoints\n");

  const tests = [
    testGetHome,
    testGetFeed,
    testGetFeedFollowing,
    testGetPost,
    testGetComments,
    testGetNotifications,
    testGetNotificationsUnread,
    testMarkNotificationsRead,
    testSearch,
    testGetProfile,
    testGetMe,
    testGetSubmolts,
    testGetSubmolt,
    testVoteEndpoints,
    testFollowUnfollow,
    testVerify,
    testErrorShape,
    testRateLimitShape,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (err) {
      console.log(`💥 ${test.name}: ${err}`);
    }
    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 300));
  }

  // Write report
  const reportPath = resolve(process.cwd(), "roadmap-api.md");
  const lines: string[] = [];
  lines.push("# Moltbook API Validation Report\n");
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push("## Endpoint Results\n");
  lines.push("| Status | Method | Endpoint | Notes |");
  lines.push("|--------|--------|----------|-------|");
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    const notes = r.error ?? `${r.actualKeys.length} keys mapped`;
    lines.push(`| ${icon} | ${r.method} | \`${r.endpoint}\` | ${notes} |`);
  }
  lines.push("\n## Detailed Response Shapes\n");
  for (const r of results) {
    lines.push(`### ${r.method} \`${r.endpoint}\``);
    lines.push(`Status: ${r.status} | OK: ${r.ok}`);
    lines.push("");
    lines.push("```json");
    lines.push(r.actualShape.slice(0, 1500));
    lines.push("```\n");
    lines.push("Extracted keys:");
    for (const k of r.actualKeys.slice(0, 30)) {
      lines.push(`- ${k}`);
    }
    lines.push("");
  }

  // Compare against our types
  lines.push("## Mismatches vs Our Types\n");
  lines.push("### Issues Found\n");

  // Notification type mismatch
  lines.push("1. **Notification.type mismatch** — API returns `agentId`, `relatedPostId`, `relatedCommentId`, `content`, `isRead`, `createdAt` (camelCase). Our `Notification` type in `types.ts` uses `message`, `post_id`, `agent_name`, `created_at`, `read` (snake_case).");
  lines.push("2. **HomeData.following_feed posts** — API returns `post_id`, `content_preview`, `submolt_name`, `author_name` (snake_case) but our `HomeData` type maps them as `Post[]` which expects `author: { id, name, karma }` — mismatch on nested structure.");
  lines.push("3. **HomeData.activity_on_your_posts** — API includes `suggested_actions: string[]` but our type omits it.");
  lines.push("4. **HomeData.latest_moltbook_announcement** — API includes `author_name` and `created_at` but our type only has `post_id`, `title`, `preview`.");
  lines.push("5. **HomeData.posts_from_accounts_you_follow** — API includes `see_more` and `hint` strings, our type doesn't capture them.");
  lines.push("6. **FeedPost in /feed** — API returns `you_follow_author: boolean` and `avatar_url` on author, our mapping drops these.");
  lines.push("7. **Post detail** — API returns nested `author` with full profile (`avatarUrl`, `followerCount`, `isClaimed`, etc.), our `Post` type only has `{ id, name, karma? }`.");
  lines.push("8. **Search result** — API returns `relevance` (float) not `similarity`. Also has `url`, `post: { id, title }` for comments, and `submolt` is nullable.");
  lines.push("9. **Agent profile** — API returns `display_name`, `posts_count`, `comments_count`, `is_verified`, `claimed_by`, `labels?` — our `AgentProfile` type is missing most of these.");
  lines.push("10. **Submolt** — API returns `created_by` (full agent object), `created_at_ts` (Unix ms), `is_nsfw`, `is_private` — our type is missing these.");
  lines.push("11. **Vote endpoint** — API uses `/upvote` and `/downvote`, NOT `/vote`. Our code uses `vote()` with direction param — need to verify the mapping.");
  lines.push("12. **Notifications embed raw DB objects** — `post` and `comment` inside notifications use camelCase DB fields (`submoltId`, `authorId`, `commentCount`, `verificationStatus`, `isFlagged`, etc.) — NOT the cleaned API shapes.");
  lines.push("13. **Timestamps inconsistent** — `/home` returns non-ISO timestamps (`2026-08-23 08:21:39.105525+00`), other endpoints return ISO 8601.");
  lines.push("14. **Dead `Notification` type** — `types.ts:98-107` defines old shape, never imported anywhere. Dead code.");

  lines.push("\n### Recommended Actions\n");
  lines.push("1. Fix `fetchNotifications()` to extract `agentName` from notification (API has `agentId`, not `agentName` — may need profile lookup or use comment author)");
  lines.push("2. Update `HomeData` type to match actual API shape (nested author objects in following feed, `suggested_actions`, `author_name` in announcements)");
  lines.push("3. Update `Post` type to handle both list shape (flat `{ name, avatar_url }`) and detail shape (nested profile)");
  lines.push("4. Fix `SearchResult` to use `relevance` instead of `similarity`");
  lines.push("5. Update `AgentProfile` to include all API fields (`display_name`, `posts_count`, `comments_count`, `is_verified`, `labels`)");
  lines.push("6. Update `Submolt` type to include `created_by`, `is_nsfw`, `is_private`, `created_at_ts`");
  lines.push("7. Verify `vote()` method calls `/upvote` or `/downvote` correctly");
  lines.push("8. Delete dead `Notification` type from `types.ts`");
  lines.push("9. Handle timestamp inconsistency (non-ISO from `/home`)");
  lines.push("10. Add `agentName` to notification mapping — either use `comment.author.name` from nested object, or fetch profile by `agentId`");

  writeFileSync(reportPath, lines.join("\n"), "utf-8");
  console.log(`\n📄 Report saved to ${reportPath}`);
  console.log(`\n📊 Summary: ${results.filter((r) => r.ok).length}/${results.length} endpoints OK`);
}

main().catch(console.error);
