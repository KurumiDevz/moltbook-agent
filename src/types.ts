/**
 * Shared types for the Moltbook agent system.
 *
 * Centralizes all domain types so every module imports from one place.
 * No duplication. No drift. Single source of truth.
 */

// ── Moltbook API types ────────────────────────────────────────────────

/** Submolt data */
export type Submolt = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  subscriber_count: number;
  created_at: string;
  created_by?: {
    id: string;
    name: string;
    description: string;
    karma: number;
    follower_count: number;
    following_count: number;
  };
  created_at_ts?: number;
  is_nsfw?: boolean;
  is_private?: boolean;
  post_count?: number;
};

/** Post data from the API */
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
  author: {
    id: string;
    name: string;
    karma?: number;
    avatar_url?: string;
    description?: string;
    follower_count?: number;
    following_count?: number;
    is_claimed?: boolean;
    is_active?: boolean;
  };
  type?: string;
  score?: number;
  hot_score?: number;
  is_pinned?: boolean;
  is_locked?: boolean;
  is_deleted?: boolean;
  verification_status?: string;
  is_spam?: boolean;
};

/** Comment data from the API */
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

/** Agent profile from the API */
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
  display_name?: string;
  posts_count?: number;
  comments_count?: number;
  is_verified?: boolean;
  claimed_by?: string;
  labels?: { pinned: any[]; inline: any[]; metadata: any[] };
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

/** Post from accounts you follow (different shape than full Post) */
export type FollowingPost = {
  post_id: string;
  title: string;
  content_preview: string;
  submolt_name: string;
  author_name: string;
  upvotes: number;
  comment_count: number;
  created_at: string;
};

/** Home dashboard response from /api/v1/home */
export type HomeData = {
  your_account: {
    name: string;
    karma: number;
    unread_notification_count: number;
  };
  activity_on_your_posts: Array<{
    post_id: string;
    post_title: string;
    submolt_name: string;
    new_notification_count: number;
    latest_at: string;
    latest_commenters: string[];
    preview: string;
    suggested_actions: string[];
  }>;
  latest_moltbook_announcement?: {
    post_id: string;
    title: string;
    preview: string;
    author_name: string;
    created_at: string;
  };
  posts_from_accounts_you_follow: {
    posts: FollowingPost[];
    total_following: number;
    see_more: string;
    hint: string;
  };
  what_to_do_next: string[];
};

/** Semantic search result from /api/v1/search */
export type SearchResult = {
  id: string;
  type: "post" | "comment";
  title?: string;
  content: string;
  relevance: number;
  author: { id: string; name: string };
  post_id?: string;
  upvotes?: number;
  comment_count?: number;
  created_at?: string;
  submolt?: { id: string; name: string; display_name: string } | null;
  url?: string;
  post?: { id: string; title: string } | null;
};

// ── Agent internal types ──────────────────────────────────────────────

/** Feed post used by the brain and agent loop (normalized from API) */
export type FeedPost = {
  id: string;
  title: string;
  content?: string;
  submolt: string;
  author: string;
  upvotes: number;
  comment_count: number;
  createdAt: string;
};

/** Notification item used by the brain (normalized from API) */
export type NotificationItem = {
  type: string;
  message: string;
  agentName?: string;
  postId?: string;
  commentId?: string;
  commentContent?: string;
  /** Original post title — helps AI understand context when replying */
  postTitle?: string;
  /** Original post content — helps AI defend or reference its own posts */
  postContent?: string;
  createdAt: string;
};

/** Rate limit state for the decision engine */
export type RateLimitState = {
  canPost: boolean;
  canComment: boolean;
  timeUntilPost: number;
  timeUntilComment: number;
  commentsToday: number;
};

/** Agent decision output from the brain */
export type AgentDecision =
  | { action: "post"; topic: string; submolt: string; postType: string; title?: string; body?: string; reason: string }
  | { action: "comment"; postId: string; content: string; reason: string }
  | { action: "reply_to_comment"; commentId: string; postId: string; content: string; reason: string }
  | { action: "upvote"; postId: string; reason: string }
  | { action: "downvote"; postId: string; reason: string }
  | { action: "follow"; agentName: string; reason: string }
  | { action: "scroll"; reason: string }
  | { action: "rest"; reason: string }
  | { action: "suggest_skill"; skillName: string; skillContent: string; reason: string };

// ── Summary / persistence types ───────────────────────────────────────

/** Post record for summary generation */
export type PostSummary = {
  id: string;
  title: string;
  content?: string;
  submolt: string;
  type: string;
  upvotes: number;
  comments: number;
  timestamp: number;
};

/** A stance the agent took — position on a topic it can reference in debates */
export type Stance = {
  topic: string;
  position: string;
  context: string;
  source: "post" | "comment" | "reply";
  sourceId: string;
  timestamp: number;
};

/** A stance another agent took — position on a topic nimjiagent can reference in debates */
export type ForeignStance = {
  agentName: string;
  agentId: string;
  topic: string;
  position: string;
  context: string;
  source: "post" | "comment";
  sourceId: string;
  timestamp: number;
};

/** Agent interaction for summary generation */
export type AgentInteraction = {
  agentName: string;
  type: string;
  count: number;
  lastAt: number;
};

/** Task queue item */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type TaskQueueItem = {
  id: string;
  type: "post" | "comment" | "upvote" | "follow" | "engage";
  description: string;
  target?: string;
  status: TaskStatus;
  createdAt: number;
  completedAt?: number;
  result?: string;
};

/** Activity summary — compact index of past agent activity */
export type ActivitySummary = {
  generatedAt: number;
  totalPosts: number;
  totalComments: number;
  totalUpvotes: number;
  karma: number;
  topPostTypes: Array<{ type: string; count: number; avgUpvotes: number }>;
  submoltActivity: Array<{ submolt: string; count: number }>;
  topicsCovered: string[];
  agentsInteracted: AgentInteraction[];
  engagementTrend: string;
  insight: string;
  completedTasks: TaskQueueItem[];
  pendingTasks: TaskQueueItem[];
  nextAction: string;
  lastCycleNumber: number;
  /** Comment IDs the agent has already replied to — prevents double-replies */
  repliedCommentIds: string[];
  /** Per-thread reply counts — keyed by parent comment ID (thread root), survives restarts */
  repliedThreadCounts: Record<string, number>;
  /** Stances the agent has taken — positions it can reference in debates */
  stances: Stance[];
  /** Stances other agents have taken — positions nimjiagent can reference in debates */
  foreignStances: ForeignStance[];
};

// ── Sub-agent types ───────────────────────────────────────────────────

/** Post fed to the sub-agent for scoring */
export type FeedPostForScoring = {
  id: string;
  title: string;
  content?: string;
  submolt: string;
  author: string;
  upvotes: number;
  comment_count: number;
};

/** Scored post from the sub-agent */
export type ScoredPost = FeedPostForScoring & {
  score: number;
  reasons: string[];
};

// ── Execution types ───────────────────────────────────────────────────

/** Result of an executed action */
export type ExecutionResult = {
  success: boolean;
  action: string;
  message: string;
  karmaDelta?: number;
};

// ── Observer types ────────────────────────────────────────────────────

/** Trending topic detected from feed */
export type Trend = {
  keyword: string;
  heat: number;
  postCount: number;
  postIds: string[];
};

/** Interesting agent found in feed */
export type InterestingAgent = {
  name: string;
  avgKarma: number;
  postCount: number;
  topics: string[];
};
