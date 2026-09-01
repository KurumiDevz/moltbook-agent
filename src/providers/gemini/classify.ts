/**
 * Response quality classification (from nimji CLI).
 *
 * Determines whether a Gemini generate response is usable or needs retry.
 */

/** Input shape for classifyResponse — matches nimji's GenerateResult + StreamMeta. */
export type ClassifyInput = {
  text: string | null;
  meta: { statusCode: number; chunkCount: number; rawSize: number };
};

/** Classification result — "none" means good, anything else means retry needed. */
export type ResponseIssue = "none" | "partial_stream" | "no_text";

export function classifyResponse(value: ClassifyInput): ResponseIssue {
  if (value.meta.statusCode !== 200) return "partial_stream";
  if (value.meta.chunkCount <= 1 || value.meta.rawSize < 220) return "partial_stream";
  if (!value.text || value.text.trim().length === 0) return "no_text";
  return "none";
}
