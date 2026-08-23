/**
 * Context7 client for fetching real library documentation.
 * Uses the Context7 REST API to pull up-to-date docs for posts.
 * Free tier: 1,000 calls/month.
 *
 * All HTTP routed through src/http.ts — zero raw fetch() calls.
 */

import { http } from "./http.js";

const CONTEXT7_API_BASE = "https://api.context7.com";

export interface Context7Doc {
  library: string;
  title: string;
  content: string;
  url: string;
}

/**
 * Search for a library in Context7.
 * Returns the library ID if found.
 */
export async function searchLibrary(
  query: string,
  apiKey?: string,
): Promise<{ id: string; name: string; description: string }[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const { data, status } = await http<{ libraries?: { id: string; name: string; description: string }[] }>(
    `${CONTEXT7_API_BASE}/v1/search`,
    { method: "POST", headers, body: { query }, timeout: 15_000 },
  );

  if (status >= 400) {
    throw new Error(`Context7 search failed: ${status}`);
  }

  return data.libraries ?? [];
}

/**
 * Fetch documentation for a specific library.
 * Returns relevant doc chunks.
 */
export async function fetchDocs(
  libraryId: string,
  query: string,
  options?: { tokens?: number; apiKey?: string },
): Promise<Context7Doc[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  const { data, status } = await http<{ docs?: { title?: string; content?: string; url?: string }[] }>(
    `${CONTEXT7_API_BASE}/v1/query`,
    {
      method: "POST",
      headers,
      body: {
        library_id: libraryId,
        query,
        tokens: options?.tokens ?? 2000,
      },
      timeout: 15_000,
    },
  );

  if (status >= 400) {
    throw new Error(`Context7 fetch failed: ${status}`);
  }

  return (data.docs ?? []).map((doc) => ({
    library: libraryId,
    title: doc.title ?? "Documentation",
    content: doc.content ?? "",
    url: doc.url ?? `https://context7.com/${libraryId}`,
  }));
}

/**
 * Quick helper: search + fetch in one call.
 * Returns null if library not found.
 */
export async function getRelevantDocs(
  libraryName: string,
  topic: string,
  options?: { tokens?: number; apiKey?: string },
): Promise<Context7Doc | null> {
  try {
    const libraries = await searchLibrary(libraryName, options?.apiKey);
    if (libraries.length === 0) return null;

    const docs = await fetchDocs(libraries[0].id, topic, options);
    return docs[0] ?? null;
  } catch {
    return null;
  }
}
