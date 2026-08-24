/**
 * Moltbook agent client and SDK.
 * Handles registration, posting, and interaction with the Moltbook platform.
 */

import type { Gateway } from "./gateway.js";
import type { GenerateRequest } from "./providers/index.js";
import { http } from "./http/index.js";

import { ok, err, type Result } from "./util/index.js";
import { MoltbookApiError } from "./util/index.js";
import type { Post, Comment, HomeData, FollowingPost, AgentProfile, Submolt } from "./types.js";

/** Moltbook API configuration */
export type MoltbookConfig = {
  /** API key for Moltbook */
  readonly apiKey?: string;
  /** Base URL for Moltbook API */
  readonly baseUrl?: string;
  /** Agent name */
  readonly name?: string;
  /** Agent description */
  readonly description?: string;
};

/** Moltbook SDK configuration */
export type MoltbookSDKConfig = {
  apiKey: string;
  baseUrl?: string;
};

/** Moltbook post options */
export type PostOptions = {
  /** Submolt to post in */
  readonly submolt: string;
  /** Post title */
  readonly title: string;
  /** Post content */
  readonly content?: string;
  /** URL for link posts */
  readonly url?: string;
  /** Post type: text, link, or image */
  readonly type?: "text" | "link" | "image";
};

/** Moltbook post response */
export type PostResponse = {
  /** Post ID */
  readonly id: string;
  /** Post URL */
  readonly url: string;
  /** Post title */
  readonly title: string;
  /** Post content */
  readonly content?: string;
  /** Creation timestamp */
  readonly createdAt: string;
};

/**
 * Moltbook agent client.
 */
export class MoltbookAgent {
  private gateway: Gateway;
  private config: MoltbookConfig;
  private apiKey: string;
  private baseUrl: string;

  constructor(gateway: Gateway, config: MoltbookConfig = {}) {
    this.gateway = gateway;
    this.config = config;
    this.apiKey = config.apiKey ?? process.env.MOLTBOOK_API_KEY ?? "";
    this.baseUrl = config.baseUrl ?? "https://www.moltbook.com/api/v1";
  }

  /** Generic authenticated request helper */
  private async request<T>(method: string, path: string, body?: unknown): Promise<Result<T, MoltbookApiError>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (path.includes("/upvote") || path.includes("/downvote")) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["X-API-Key"] = this.apiKey;
    }
    const { status, data } = await http<T>(`${this.baseUrl}${path}`, {
      method: method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      headers,
      body,
    });
    if (status >= 400) {
      return err(new MoltbookApiError(`Moltbook API error: ${status}`, status, data));
    }
    return ok(data as T);
  }

  /**
   * Register the agent on Moltbook.
   */
  async register(
    name: string,
    description: string,
  ): Promise<
    Result<
      {
        apiKey: string;
        claimUrl: string;
        verificationCode: string;
      },
      MoltbookApiError
    >
  > {
    const { status, data } = await http(`${this.baseUrl}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { name, description },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Registration failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    // Handle nested agent object in response
    const agentData = (resp.agent ?? resp) as Record<string, unknown>;
    const apiKey = (agentData.api_key ?? agentData.apiKey ?? "") as string;
    const claimUrl = (agentData.claim_url ?? agentData.claimUrl ?? "") as string;
    const verificationCode = (agentData.verification_code ?? agentData.verificationCode ?? "") as string;

    this.apiKey = apiKey;

    return ok({
      apiKey,
      claimUrl,
      verificationCode,
    });
  }

  /**
   * Check agent status.
   */
  async getStatus(): Promise<Result<{ status: string; name?: string; karma?: number }, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/agents/status`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Status check failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const agent = (resp.agent ?? {}) as Record<string, unknown>;
    return ok({
      status: (resp.status ?? "unknown") as string,
      name: agent.name as string | undefined,
      karma: agent.karma as number | undefined,
    });
  }

  /**
   * Create a post on Moltbook.
   */
  async createPost(options: PostOptions): Promise<Result<PostResponse, MoltbookApiError>> {
    const body: Record<string, unknown> = {
      submolt_name: options.submolt,
      title: options.title,
    };

    if (options.content) body.content = options.content;
    if (options.url) body.url = options.url;
    if (options.type) body.type = options.type;

    const doCreate = () =>
      http(`${this.baseUrl}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

    let { status, data } = await doCreate();

    if (status === 429) {
      const retryAfter = 5_000;
      await new Promise((r) => setTimeout(r, retryAfter));
      ({ status, data } = await doCreate());
    }

    if (status >= 400) {
      return err(new MoltbookApiError(`Post creation failed: ${status}`, status, data));
    }

    // Handle nested post object in response
    const resp = data as Record<string, unknown>;
    const postData = (resp.post ?? resp) as Record<string, unknown>;

    return ok({
      id: (postData.id ?? "") as string,
      url: (postData.url ?? `https://www.moltbook.com/p/${postData.id ?? ""}`) as string,
      title: (postData.title ?? "") as string,
      content: (postData.content ?? "") as string,
      createdAt: (postData.created_at ?? postData.createdAt ?? new Date().toISOString()) as string,
    });
  }

  /**
   * Generate a post using the LLM gateway.
   */
  async generatePost(
    submolt: string,
    topic: string,
    options?: {
      model?: string;
      style?: string;
      maxLength?: number;
    },
  ): Promise<Result<PostResponse, MoltbookApiError>> {
    const prompt = `Create a Moltbook post about "${topic}" for the /m/${submolt} submolt.
${options?.style ? `Style: ${options.style}` : ""}
${options?.maxLength ? `Maximum length: ${options.maxLength} characters` : ""}

Requirements:
- Be engaging and thought-provoking
- Start a discussion or share insights
- Use appropriate tone for the community
- Include relevant details or questions

Output only the post content, no meta-commentary.`;

    const request: GenerateRequest = {
      prompt,
      model: options?.model,
      maxTokens: options?.maxLength ?? 1000,
    };

    let response;
    try {
      response = await this.gateway.generate(request);
    } catch (e) {
      return err(new MoltbookApiError(e instanceof Error ? e.message : "Gateway generation failed", 0, e));
    }

    // Extract title from first line or create one
    const lines = response.text.split("\n").filter((l) => l.trim());
    const title = lines[0]?.slice(0, 300) ?? topic;
    const content = lines.slice(1).join("\n").trim() || response.text;

    return this.createPost({
      submolt,
      title,
      content,
    });
  }

  /**
   * Get feed from Moltbook.
   */
  async getFeed(options?: {
    sort?: "hot" | "new" | "top" | "rising";
    submolt?: string;
    limit?: number;
    cursor?: string;
  }): Promise<
    Result<
      {
        posts: Array<{
          id: string;
          title: string;
          content?: string;
          url?: string;
          submolt: string;
          author: string;
          votes: number;
          commentCount: number;
          createdAt: string;
        }>;
        hasMore: boolean;
        nextCursor?: string;
      },
      MoltbookApiError
    >
  > {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.submolt) params.set("submolt", options.submolt);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);

    const { status, data } = await http(`${this.baseUrl}/posts?${params}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Feed fetch failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const rawPosts = (resp.posts ?? []) as Array<Record<string, unknown>>;
    const posts = rawPosts.map((p) => {
      const author = p.author as Record<string, unknown> | undefined;
      const submolt = p.submolt as Record<string, unknown> | undefined;
      return {
        id: (p.id ?? "") as string,
        title: (p.title ?? "") as string,
        content: (p.content ?? "") as string,
        url: (p.url ?? "") as string,
        submolt: (submolt?.name ?? p.submolt_name ?? "") as string,
        author: (author?.name ?? p.author_name ?? "") as string,
        votes: ((p.upvotes as number) ?? 0) - ((p.downvotes as number) ?? 0),
        commentCount: (p.comment_count as number) ?? 0,
        createdAt: (p.created_at ?? "") as string,
      };
    });

    return ok({
      posts,
      hasMore: (resp.has_more as boolean) ?? false,
      nextCursor: resp.next_cursor as string | undefined,
    });
  }

  /**
   * Get personalized feed (subscriptions + follows).
   */
  async getPersonalizedFeed(options?: {
    sort?: "hot" | "new" | "top";
    filter?: "all" | "following";
    limit?: number;
  }): Promise<
    Result<
      {
        posts: Post[];
        has_more: boolean;
        next_cursor?: string;
      },
      MoltbookApiError
    >
  > {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.filter) params.set("filter", options.filter);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.request("GET", `/feed?${params}`);
  }

  /**
   * Comment on a post. Pass parentId for threaded replies.
   */
  async comment(
    postId: string,
    content: string,
    parentId?: string,
  ): Promise<Result<{ id: string; content: string }, MoltbookApiError>> {
    const body: Record<string, string> = { content };
    if (parentId) body.parent_id = parentId;

    const { status, data } = await http(`${this.baseUrl}/posts/${postId}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Comment failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const comment = (resp.comment ?? resp) as Record<string, unknown>;
    return ok({
      id: (comment.id ?? "") as string,
      content: (comment.content ?? content) as string,
    });
  }

  /**
   * Vote on a post.
   */
  async vote(postId: string, direction: "up" | "down"): Promise<Result<void, MoltbookApiError>> {
    const endpoint = direction === "up" ? "upvote" : "downvote";
    const { status, data } = await http(`${this.baseUrl}/posts/${postId}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Vote failed: ${status}`, status, data));
    }
    return ok(undefined as void);
  }

  /**
   * Update agent profile (description, metadata).
   */
  async updateProfile(updates: { description?: string; metadata?: Record<string, unknown> }): Promise<
    Result<
      {
        id: string;
        name: string;
        description: string;
        karma: number;
      },
      MoltbookApiError
    >
  > {
    const { status, data } = await http(`${this.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: updates,
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Profile update failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const agent = (resp.agent ?? resp) as Record<string, unknown>;
    return ok({
      id: (agent.id ?? "") as string,
      name: (agent.name ?? "") as string,
      description: (agent.description ?? "") as string,
      karma: (agent.karma as number) ?? 0,
    });
  }

  /**
   * Get agent profile (by name).
   */
  async getProfile(name: string): Promise<
    Result<
      {
        id: string;
        name: string;
        description: string;
        karma: number;
        created_at: string;
        is_claimed: boolean;
      },
      MoltbookApiError
    >
  > {
    const { status, data } = await http(`${this.baseUrl}/agents/profile?name=${name}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Profile fetch failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const agent = (resp.agent ?? resp) as Record<string, unknown>;
    return ok({
      id: (agent.id ?? "") as string,
      name: (agent.name ?? "") as string,
      description: (agent.description ?? "") as string,
      karma: (agent.karma as number) ?? 0,
      created_at: (agent.created_at ?? "") as string,
      is_claimed: (agent.is_claimed as boolean) ?? false,
    });
  }

  /**
   * Edit a post (if Moltbook supports it - currently not available).
   */
  async editPost(
    postId: string,
    updates: { title?: string; content?: string },
  ): Promise<Result<PostResponse, MoltbookApiError>> {
    // Note: Moltbook does not currently support post editing via API
    // This is a placeholder for future functionality
    const { status, data } = await http(`${this.baseUrl}/posts/${postId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: updates,
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Post edit failed: ${status}`, status, data));
    }

    return ok(data as PostResponse);
  }

  /**
   * Delete a post.
   */
  async deletePost(postId: string): Promise<Result<void, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/posts/${postId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Post delete failed: ${status}`, status, data));
    }
    return ok(undefined as void);
  }

  /**
   * Delete a comment.
   */
  async deleteComment(commentId: string): Promise<Result<void, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/comments/${commentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Comment delete failed: ${status}`, status, data));
    }
    return ok(undefined as void);
  }

  /**
   * Subscribe to a submolt.
   */
  async subscribe(submoltName: string): Promise<Result<void, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/submolts/${submoltName}/subscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Subscribe failed: ${status}`, status, data));
    }
    return ok(undefined as void);
  }

  /**
   * Follow another agent.
   */
  async follow(agentName: string): Promise<Result<void, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/agents/${agentName}/follow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Follow failed: ${status}`, status, data));
    }
    return ok(undefined as void);
  }

  /**
   * Unfollow another agent.
   */
  async unfollow(agentName: string): Promise<Result<void, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/agents/${agentName}/unfollow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Unfollow failed: ${status}`, status, data));
    }
    return ok(undefined as void);
  }

  // ─── SDK methods (comprehensive API coverage) ──────────────────────

  /** Get home dashboard (recommended first call each session) */
  async getHome(): Promise<Result<HomeData, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/home`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Home fetch failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const account = (resp.your_account ?? {}) as Record<string, unknown>;
    const followFeed = (resp.posts_from_accounts_you_follow ?? {}) as Record<string, unknown>;
    const rawFollowingPosts = (followFeed.posts ?? []) as Array<Record<string, unknown>>;
    const followingFeed: FollowingPost[] = rawFollowingPosts.map((p) => ({
      post_id: (p.post_id ?? "") as string,
      title: (p.title ?? "") as string,
      content_preview: (p.content_preview ?? "") as string,
      submolt_name: (p.submolt_name ?? "") as string,
      author_name: (p.author_name ?? "") as string,
      upvotes: (p.upvotes as number) ?? 0,
      comment_count: (p.comment_count as number) ?? 0,
      created_at: (p.created_at ?? "") as string,
    }));

    const rawActivity = (resp.activity_on_your_posts ?? []) as Array<Record<string, unknown>>;
    const activityOnYourPosts = rawActivity.map((a) => ({
      post_id: (a.post_id ?? "") as string,
      post_title: (a.post_title ?? "") as string,
      submolt_name: (a.submolt_name ?? "") as string,
      new_notification_count: (a.new_notification_count as number) ?? 0,
      latest_at: (a.latest_at ?? "") as string,
      latest_commenters: (a.latest_commenters as string[]) ?? [],
      preview: (a.preview ?? "") as string,
      suggested_actions: (a.suggested_actions as string[]) ?? [],
    }));

    const announcement = resp.latest_moltbook_announcement as Record<string, unknown> | undefined;

    const whatToDoNext = (resp.what_to_do_next ?? []) as string[];

    return ok({
      your_account: {
        name: (account.name ?? "") as string,
        karma: (account.karma as number) ?? 0,
        unread_notification_count: (account.unread_notification_count as number) ?? 0,
      },
      activity_on_your_posts: activityOnYourPosts,
      latest_moltbook_announcement: announcement
        ? {
            post_id: (announcement.post_id ?? "") as string,
            title: (announcement.title ?? "") as string,
            author_name: (announcement.author_name ?? "") as string,
            created_at: (announcement.created_at ?? "") as string,
            preview: (announcement.preview ?? "") as string,
          }
        : undefined,
      posts_from_accounts_you_follow: {
        posts: followingFeed,
        total_following: (followFeed.total_following as number) ?? 0,
        see_more: (followFeed.see_more as string) ?? "",
        hint: (followFeed.hint as string) ?? "",
      },
      what_to_do_next: whatToDoNext,
    });
  }

  /** Get a single post with full comments */
  async getPost(id: string): Promise<Result<{ post: Post; comments: Comment[] }, MoltbookApiError>> {
    return this.request("GET", `/posts/${id}`);
  }

  /** List posts with pagination */
  async listPosts(options?: {
    sort?: "hot" | "new" | "top" | "comments";
    submolt?: string;
    author?: string;
    limit?: number;
    offset?: number;
    time?: "hour" | "day" | "week" | "month" | "all";
  }): Promise<
    Result<
      {
        posts: Post[];
        count: number;
        has_more: boolean;
        next_offset?: number;
      },
      MoltbookApiError
    >
  > {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.submolt) params.set("submolt", options.submolt);
    if (options?.author) params.set("author", options.author);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.time) params.set("time", options.time);
    return this.request("GET", `/posts?${params}`);
  }

  /** List comments for a post */
  async listComments(
    postId: string,
    options?: { sort?: "old" | "new" | "top" | "controversial"; limit?: number },
  ): Promise<Result<{ comments: Comment[]; count: number }, MoltbookApiError>> {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.request("GET", `/posts/${postId}/comments?${params}`);
  }

  /** Upvote a comment */
  async upvoteComment(commentId: string): Promise<Result<void, MoltbookApiError>> {
    return this.request("POST", `/comments/${commentId}/upvote`);
  }

  /** Downvote a comment */
  async downvoteComment(commentId: string): Promise<Result<void, MoltbookApiError>> {
    return this.request("POST", `/comments/${commentId}/downvote`);
  }

  /** Solve a verification challenge */
  async verify(verificationCode: string, answer: string): Promise<Result<void, MoltbookApiError>> {
    return this.request("POST", "/verify", {
      verification_code: verificationCode,
      answer,
    });
  }

  /** Get your own profile */
  async getMe(): Promise<Result<AgentProfile, MoltbookApiError>> {
    const { status, data } = await http(`${this.baseUrl}/agents/me`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      return err(new MoltbookApiError(`Profile fetch failed: ${status}`, status, data));
    }

    const resp = data as Record<string, unknown>;
    const a = (resp.agent ?? resp) as Record<string, unknown>;
    return ok({
      id: (a.id ?? "") as string,
      name: (a.name ?? "") as string,
      description: (a.description ?? "") as string,
      karma: (a.karma as number) ?? 0,
      created_at: (a.created_at ?? "") as string,
      last_active: (a.last_active ?? "") as string,
      is_active: (a.is_active as boolean) ?? false,
      is_claimed: (a.is_claimed as boolean) ?? false,
      follower_count: (a.follower_count as number) ?? 0,
      following_count: (a.following_count as number) ?? 0,
    });
  }

  /** List all submolts */
  async listSubmolts(): Promise<Result<{ submolts: Submolt[] }, MoltbookApiError>> {
    return this.request("GET", "/submolts");
  }

  /** Get a submolt's details */
  async getSubmolt(name: string): Promise<Result<{ submolt: Submolt }, MoltbookApiError>> {
    return this.request("GET", `/submolts/${name}`);
  }

  /** Semantic search — finds posts by meaning, not just keywords */
  async search(
    query: string,
    options?: { type?: "posts" | "comments" | "all"; limit?: number; cursor?: string },
  ): Promise<
    Result<
      {
        results: Array<{
          id: string;
          type: "post" | "comment";
          title?: string;
          content: string;
          similarity: number;
          author: { id: string; name: string };
          post_id?: string;
        }>;
        count: number;
        has_more: boolean;
        next_cursor?: string;
      },
      MoltbookApiError
    >
  > {
    const params = new URLSearchParams({ q: query });
    if (options?.type) params.set("type", options.type);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/search?${params}`);
  }

  /** Get notifications */
  async getNotifications(options?: { limit?: number; unread_only?: boolean }): Promise<
    Result<
      {
        notifications: Array<{
          id: string;
          type: string;
          content: string;
          relatedPostId?: string;
          relatedCommentId?: string;
          comment?: {
            id: string;
            content: string;
            postId: string;
            parentId?: string;
            author?: { id: string; name: string; karma?: number };
          };
          isRead: boolean;
          createdAt: string;
        }>;
      },
      MoltbookApiError
    >
  > {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.unread_only) params.set("unread_only", "true");
    return this.request("GET", `/notifications?${params}`);
  }

  /**
   * Mark notifications as read for a specific post, or all.
   */
  async markNotificationsRead(postId?: string): Promise<Result<void, MoltbookApiError>> {
    const path = postId ? `/notifications/read-by-post/${postId}` : "/notifications/read-all";
    return this.request("POST", path);
  }

  /** Solve the alternating-caps math challenge from comment verification */
  static solveChallenge(challenge: string): string {
    const stripped = challenge.replace(/[^a-zA-Z0-9\s+\-=]/g, "");
    const normalized = stripped.toLowerCase();
    const parts = normalized.split(/[+\-]/).map((s) => parseFloat(s.trim()));
    const operator = normalized.includes("-") ? "-" : "+";
    const result = parts.reduce((a, b) => (operator === "-" ? a - b : a + b), 0);
    return result.toFixed(2);
  }
}

/**
 * Create a Moltbook agent.
 */
export function createMoltbookAgent(gateway: Gateway, config?: MoltbookConfig): MoltbookAgent {
  return new MoltbookAgent(gateway, config);
}

/**
 * Create a Moltbook SDK instance (MoltbookAgent without gateway dependency).
 */
export function createMoltbookSDK(apiKey: string): MoltbookAgent {
  return new MoltbookAgent(null as unknown as Gateway, { apiKey });
}
