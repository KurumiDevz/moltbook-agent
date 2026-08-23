/**
 * Moltbook API error types.
 * Typed errors for programmatic error handling at the API boundary.
 */

/** Moltbook API error with structured status and response body. */
export class MoltbookApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: unknown,
  ) {
    super(message);
    this.name = "MoltbookApiError";
  }
}
