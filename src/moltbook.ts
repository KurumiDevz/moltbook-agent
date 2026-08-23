/**
 * Moltbook agent client and SDK.
 * Handles registration, posting, and interaction with the Moltbook platform.
 */

import type { Gateway } from "./gateway.js";
import type { GenerateRequest, GenerateResponse } from "./provider.js";
import { http } from "./http.js";

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

/** Post data */
export type Post = {
  id: string;
  title: string;
  content?: string;
  url?: string;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  created_at: string;
  submolt: { id: string; name: string; display_name: string };
  author: { id: string; name: string; karma?: number };
};

/** Comment data */
export type Comment = {
  id: string;
  content: string;
  parent_id?: string;
  upvotes: number;
  downvotes: number;
  created_at: string;
  author: { id: string; name: string; karma?: number };
  replies?: Comment[];
};

/** Agent profile */
export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  karma: number;
  created_at: string;
  last_active: string;
  is_active: boolean;
  is_claimed: boolean;
  follower_count: number;
  following_count: number;
  avatar_url?: string;
  owner?: {
    x_handle: string;
    x_name: string;
    x_bio: string;
    x_avatar: string;
    x_follower_count: number;
    x_following_count: number;
    x_verified: boolean;
  };
};

/** Submolt data */
export type Submolt = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  subscriber_count: number;
  created_at: string;
};

/** Home dashboard data */
export type HomeData = {
  stats: { agents: number; submolts: number; posts: number; comments: number };
  karma: number;
  unread_count: number;
  dms_waiting: number;
  activity: Array<{ type: string; post_id?: string; agent_name?: string }>;
  suggested_actions: string[];
  following_feed: Post[];
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
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      throw new Error(`Moltbook API error: ${status} - ${JSON.stringify(data)}`);
    }
    return data as T;
  }

  /**
   * Register the agent on Moltbook.
   */
  async register(name: string, description: string): Promise<{
    apiKey: string;
    claimUrl: string;
    verificationCode: string;
  }> {
    const { status, data } = await http(`${this.baseUrl}/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { name, description },
    });

    if (status >= 400) {
      throw new Error(`Registration failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    // Handle nested agent object in response
    const agentData = (resp.agent ?? resp) as Record<string, unknown>;
    const apiKey = (agentData.api_key ?? agentData.apiKey ?? "") as string;
    const claimUrl = (agentData.claim_url ?? agentData.claimUrl ?? "") as string;
    const verificationCode = (agentData.verification_code ?? agentData.verificationCode ?? "") as string;
    
    this.apiKey = apiKey;

    return {
      apiKey,
      claimUrl,
      verificationCode,
    };
  }

  /**
   * Check agent status.
   */
  async getStatus(): Promise<{ status: string; name?: string; karma?: number }> {
    const { status, data } = await http(`${this.baseUrl}/agents/status`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Status check failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    const agent = (resp.agent ?? {}) as Record<string, unknown>;
    return {
      status: (resp.status ?? "unknown") as string,
      name: agent.name as string | undefined,
      karma: agent.karma as number | undefined,
    };
  }

  /**
   * Create a post on Moltbook.
   */
  async createPost(options: PostOptions): Promise<PostResponse> {
    const body: Record<string, unknown> = {
      submolt_name: options.submolt,
      title: options.title,
    };

    if (options.content) body.content = options.content;
    if (options.url) body.url = options.url;
    if (options.type) body.type = options.type;

    const doCreate = () => http(`${this.baseUrl}/posts`, {
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
      throw new Error(`Post creation failed: ${status} - ${JSON.stringify(data)}`);
    }

    // Handle nested post object in response
    const resp = data as Record<string, unknown>;
    const postData = (resp.post ?? resp) as Record<string, unknown>;
    
    return {
      id: (postData.id ?? "") as string,
      url: (postData.url ?? `https://www.moltbook.com/p/${postData.id ?? ""}`) as string,
      title: (postData.title ?? "") as string,
      content: (postData.content ?? "") as string,
      createdAt: (postData.created_at ?? postData.createdAt ?? new Date().toISOString()) as string,
    };
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
    }
  ): Promise<PostResponse> {
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

    const response = await this.gateway.generate(request);

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
  }): Promise<{
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
  }> {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.submolt) params.set("submolt", options.submolt);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);

    const { status, data } = await http(`${this.baseUrl}/posts?${params}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Feed fetch failed: ${status} - ${JSON.stringify(data)}`);
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

    return {
      posts,
      hasMore: (resp.has_more as boolean) ?? false,
      nextCursor: resp.next_cursor as string | undefined,
    };
  }

  /**
   * Comment on a post. Pass parentId for threaded replies.
   */
  async comment(postId: string, content: string, parentId?: string): Promise<{ id: string; content: string }> {
    const body: Record<string, string> = { content };
    if (parentId) body.parentId = parentId;

    const { status, data } = await http(`${this.baseUrl}/posts/${postId}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (status >= 400) {
      throw new Error(`Comment failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    const comment = (resp.comment ?? resp) as Record<string, unknown>;
    return {
      id: (comment.id ?? "") as string,
      content: (comment.content ?? content) as string,
    };
  }

  /**
   * Vote on a post.
   */
  async vote(postId: string, direction: "up" | "down"): Promise<void> {
    const endpoint = direction === "up" ? "upvote" : "downvote";
    const { status, data } = await http(`${this.baseUrl}/posts/${postId}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Vote failed: ${status} - ${JSON.stringify(data)}`);
    }
  }

  /**
   * Update agent profile (description, metadata).
   */
  async updateProfile(updates: { description?: string; metadata?: Record<string, unknown> }): Promise<{
    id: string;
    name: string;
    description: string;
    karma: number;
  }> {
    const { status, data } = await http(`${this.baseUrl}/agents/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: updates,
    });

    if (status >= 400) {
      throw new Error(`Profile update failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    const agent = (resp.agent ?? resp) as Record<string, unknown>;
    return {
      id: (agent.id ?? "") as string,
      name: (agent.name ?? "") as string,
      description: (agent.description ?? "") as string,
      karma: (agent.karma as number) ?? 0,
    };
  }

  /**
   * Get agent profile (by name).
   */
  async getProfile(name: string): Promise<{
    id: string;
    name: string;
    description: string;
    karma: number;
    created_at: string;
    is_claimed: boolean;
  }> {
    const { status, data } = await http(`${this.baseUrl}/agents/profile?name=${name}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Profile fetch failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    const agent = (resp.agent ?? resp) as Record<string, unknown>;
    return {
      id: (agent.id ?? "") as string,
      name: (agent.name ?? "") as string,
      description: (agent.description ?? "") as string,
      karma: (agent.karma as number) ?? 0,
      created_at: (agent.created_at ?? "") as string,
      is_claimed: (agent.is_claimed as boolean) ?? false,
    };
  }

  /**
   * Edit a post (if Moltbook supports it - currently not available).
   */
  async editPost(postId: string, updates: { title?: string; content?: string }): Promise<PostResponse> {
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
      throw new Error(`Post edit failed: ${status} - ${JSON.stringify(data)}`);
    }

    return data as PostResponse;
  }

  /**
   * Delete a post.
   */
  async deletePost(postId: string): Promise<void> {
    const { status, data } = await http(`${this.baseUrl}/posts/${postId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Post delete failed: ${status} - ${JSON.stringify(data)}`);
    }
  }

  /**
   * Subscribe to a submolt.
   */
  async subscribe(submoltName: string): Promise<void> {
    const { status, data } = await http(`${this.baseUrl}/submolts/${submoltName}/subscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Subscribe failed: ${status} - ${JSON.stringify(data)}`);
    }
  }

  /**
   * Follow another agent.
   */
  async follow(agentName: string): Promise<void> {
    const { status, data } = await http(`${this.baseUrl}/agents/${agentName}/follow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Follow failed: ${status} - ${JSON.stringify(data)}`);
    }
  }

  /**
   * Unfollow another agent.
   */
  async unfollow(agentName: string): Promise<void> {
    const { status, data } = await http(`${this.baseUrl}/agents/${agentName}/unfollow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Unfollow failed: ${status} - ${JSON.stringify(data)}`);
    }
  }

  // ─── SDK methods (comprehensive API coverage) ──────────────────────

  /** Get home dashboard (recommended first call each session) */
  async getHome(): Promise<HomeData> {
    const { status, data } = await http(`${this.baseUrl}/home`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Home fetch failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    const account = (resp.your_account ?? {}) as Record<string, unknown>;
    const followFeed = (resp.posts_from_accounts_you_follow ?? {}) as Record<string, unknown>;
    const rawFollowingPosts = (followFeed.posts ?? []) as Array<Record<string, unknown>>;
    const followingFeed: Post[] = rawFollowingPosts.map((p) => {
      const author = p.author as Record<string, unknown> | undefined;
      const submolt = p.submolt as Record<string, unknown> | undefined;
      return {
        id: (p.id ?? "") as string,
        title: (p.title ?? "") as string,
        content: (p.content ?? "") as string,
        url: (p.url ?? "") as string,
        upvotes: (p.upvotes as number) ?? 0,
        downvotes: (p.downvotes as number) ?? 0,
        comment_count: (p.comment_count as number) ?? 0,
        created_at: (p.created_at ?? "") as string,
        submolt: submolt
          ? { id: (submolt.id ?? "") as string, name: (submolt.name ?? "") as string, display_name: (submolt.display_name ?? submolt.name ?? "") as string }
          : { id: "", name: "", display_name: "" },
        author: author
          ? { id: (author.id ?? "") as string, name: (author.name ?? "") as string, karma: author.karma as number | undefined }
          : { id: "", name: "", karma: undefined },
      };
    });

    return {
      stats: { agents: 0, submolts: 0, posts: 0, comments: 0 },
      karma: (account.karma as number) ?? 0,
      unread_count: (account.unread_notification_count as number) ?? 0,
      dms_waiting: 0,
      activity: [],
      suggested_actions: [],
      following_feed: followingFeed,
    };
  }

  /** Get a single post with full comments */
  async getPost(id: string): Promise<{ post: Post; comments: Comment[] }> {
    return this.request("GET", `/posts/${id}`);
  }

  /** List posts with pagination */
  async listPosts(options?: {
    sort?: "hot" | "new" | "top" | "comments";
    submolt?: string;
    limit?: number;
    offset?: number;
    time?: "hour" | "day" | "week" | "month" | "all";
  }): Promise<{
    posts: Post[];
    count: number;
    has_more: boolean;
    next_offset?: number;
  }> {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.submolt) params.set("submolt", options.submolt);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.time) params.set("time", options.time);
    return this.request("GET", `/posts?${params}`);
  }

  /** List comments for a post */
  async listComments(
    postId: string,
    options?: { sort?: "old" | "new" | "top" | "controversial"; limit?: number },
  ): Promise<{ comments: Comment[]; count: number }> {
    const params = new URLSearchParams();
    if (options?.sort) params.set("sort", options.sort);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.request("GET", `/posts/${postId}/comments?${params}`);
  }

  /** Upvote a comment */
  async upvoteComment(commentId: string): Promise<void> {
    await this.request("POST", `/comments/${commentId}/upvote`);
  }

  /** Downvote a comment */
  async downvoteComment(commentId: string): Promise<void> {
    await this.request("POST", `/comments/${commentId}/downvote`);
  }

  /** Solve a verification challenge */
  async verify(verificationCode: string, answer: string): Promise<void> {
    await this.request("POST", "/verify", {
      verification_code: verificationCode,
      answer,
    });
  }

  /** Get your own profile */
  async getMe(): Promise<AgentProfile> {
    const { status, data } = await http(`${this.baseUrl}/agents/me`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (status >= 400) {
      throw new Error(`Profile fetch failed: ${status} - ${JSON.stringify(data)}`);
    }

    const resp = data as Record<string, unknown>;
    const a = (resp.agent ?? resp) as Record<string, unknown>;
    return {
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
    };
  }

  /** List all submolts */
  async listSubmolts(): Promise<{ submolts: Submolt[] }> {
    return this.request("GET", "/submolts");
  }

  /** Get a submolt's details */
  async getSubmolt(name: string): Promise<{ submolt: Submolt }> {
    return this.request("GET", `/submolts/${name}`);
  }

  /** Search posts and agents */
  async search(
    query: string,
    options?: { type?: "posts" | "agents" | "all"; limit?: number },
  ): Promise<{ posts: Post[]; agents: AgentProfile[] }> {
    const params = new URLSearchParams({ q: query });
    if (options?.type) params.set("type", options.type);
    if (options?.limit) params.set("limit", String(options.limit));
    return this.request("GET", `/search?${params}`);
  }

  /** Get notifications */
  async getNotifications(options?: {
    limit?: number;
    unread_only?: boolean;
  }): Promise<{
    notifications: Array<{
      id: string;
      type: string;
      message: string;
      post_id?: string;
      agent_name?: string;
      created_at: string;
      read: boolean;
    }>;
  }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.unread_only) params.set("unread_only", "true");
    return this.request("GET", `/notifications?${params}`);
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
export function createMoltbookAgent(
  gateway: Gateway,
  config?: MoltbookConfig,
): MoltbookAgent {
  return new MoltbookAgent(gateway, config);
}

/**
 * Create a Moltbook SDK instance (MoltbookAgent without gateway dependency).
 */
export function createMoltbookSDK(apiKey: string): MoltbookAgent {
  return new MoltbookAgent(null as unknown as Gateway, { apiKey });
}