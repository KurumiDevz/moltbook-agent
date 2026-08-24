import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildBaseContext,
  buildSkillSelectionPrompt,
  buildDecisionPrompt,
  buildContentPrompt,
  buildRevalidationPrompt,
  buildPostRevalidationPrompt,
  type BrainContext,
} from "../dist/brain/prompts.js";
import type { FeedPost, NotificationItem, RateLimitState } from "../dist/types.js";
import type { Skill } from "../dist/skills/loader.js";

// ── Helpers ──────────────────────────────────────────────────────────

function defaultRateLimits(): RateLimitState {
  return {
    canPost: true,
    canComment: true,
    timeUntilPost: 0,
    timeUntilComment: 0,
    commentsToday: 0,
  };
}

function defaultContext(overrides: Partial<BrainContext> = {}): BrainContext {
  return {
    feed: [],
    notifications: [],
    rateLimits: defaultRateLimits(),
    postHistory: [],
    ownPosts: [],
    recentInteractions: [],
    ...overrides,
  };
}

function coreSkill(): Skill {
  return {
    name: "nimjiagent",
    path: "skills/nimjiagent.md",
    content: "# nimjiagent\nYou are nimjiagent on Moltbook.",
  };
}

function allSkills(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  map.set("nimjiagent", coreSkill());
  map.set("engagement-strategy", {
    name: "engagement-strategy",
    path: "skills/engagement-strategy.md",
    content: "# Engagement Strategy\nChoose what to do next.",
  });
  map.set("comment-quality", {
    name: "comment-quality",
    path: "skills/comment-quality.md",
    content: "# Comment Quality\nWrite substantive comments.",
  });
  map.set("reply-to-comments", {
    name: "reply-to-comments",
    path: "skills/reply-to-comments.md",
    content: "# Reply to Comments\nReply to comments on your posts.",
  });
  return map;
}

// ── buildBaseContext ─────────────────────────────────────────────────

describe("buildBaseContext", () => {
  it("includes rate limit info", () => {
    const ctx = defaultContext({
      rateLimits: {
        canPost: false,
        canComment: true,
        timeUntilPost: 900_000,
        timeUntilComment: 0,
        commentsToday: 3,
      },
    });
    const text = buildBaseContext(ctx);
    assert.ok(text.includes("Can post: false"));
    assert.ok(text.includes("wait 15min"));
    assert.ok(text.includes("Comments today: 3/50"));
  });

  it("includes feed posts", () => {
    const feed: FeedPost[] = [
      {
        id: "p1",
        title: "Test Post",
        submolt: "general",
        author: "bot1",
        upvotes: 10,
        comment_count: 5,
        createdAt: "",
      },
    ];
    const text = buildBaseContext(defaultContext({ feed }));
    assert.ok(text.includes("Test Post"));
    assert.ok(text.includes("bot1"));
  });

  it("includes recent post types for dedup", () => {
    const text = buildBaseContext(
      defaultContext({
        postHistory: [
          {
            type: "discovery",
            submolt: "general",
            upvotes: 5,
            timestamp: Date.now(),
          },
          {
            type: "workflow",
            submolt: "agents",
            upvotes: 3,
            timestamp: Date.now(),
          },
        ],
      }),
    );
    assert.ok(text.includes("discovery"));
    assert.ok(text.includes("workflow"));
  });

  it("includes notifications", () => {
    const notifications: NotificationItem[] = [
      {
        type: "reply",
        message: "Nice post!",
        agentName: "bot2",
        postId: "p1",
        createdAt: "",
      },
    ];
    const text = buildBaseContext(defaultContext({ notifications }));
    assert.ok(text.includes("Nice post!"));
    assert.ok(text.includes("bot2"));
  });

  it("includes summary when present", () => {
    const text = buildBaseContext(defaultContext({ summary: "You posted 3 times today." }));
    assert.ok(text.includes("You posted 3 times today."));
  });

  it("includes stances when present", () => {
    const text = buildBaseContext(
      defaultContext({
        stances: [
          {
            topic: "security",
            position: "Zero trust is best",
            context: "Discussed in a post about network security.",
            source: "post",
            timestamp: Date.now(),
          },
        ],
      }),
    );
    assert.ok(text.includes("Zero trust is best"));
    assert.ok(text.includes("Past Positions"));
  });

  it("includes foreign stances when present", () => {
    const text = buildBaseContext(
      defaultContext({
        foreignStances: [
          {
            agentName: "otherbot",
            topic: "ai",
            position: "LLMs are overhyped",
            context: "Commented on a post about AI.",
            source: "comment",
            sourceId: "c1",
            timestamp: Date.now(),
          },
        ],
      }),
    );
    assert.ok(text.includes("LLMs are overhyped"));
    assert.ok(text.includes("otherbot"));
  });

  it("returns empty sections for minimal context", () => {
    const text = buildBaseContext(defaultContext());
    assert.ok(text.includes("## Current State"));
    assert.ok(text.includes("Can post: true"));
  });

  it("shows post title info in feed section", () => {
    const feed: FeedPost[] = [
      {
        id: "p1",
        title: "Security Post",
        submolt: "general",
        author: "bot1",
        upvotes: 10,
        comment_count: 5,
        createdAt: "",
      },
    ];
    const text = buildBaseContext(defaultContext({ feed }));
    assert.ok(text.includes("Security Post"));
    assert.ok(text.includes("/m/general"));
    assert.ok(text.includes("10↑"));
    assert.ok(text.includes("5💬"));
  });

  it("limits feed to 10 posts", () => {
    const feed: FeedPost[] = Array.from({ length: 15 }, (_, i) => ({
      id: `p${i}`,
      title: `Post ${i}`,
      submolt: "general",
      author: "bot",
      upvotes: 0,
      comment_count: 0,
      createdAt: "",
    }));
    const text = buildBaseContext(defaultContext({ feed }));
    assert.ok(text.includes("Post 0"));
    assert.ok(text.includes("Post 9"));
    assert.ok(!text.includes("Post 10"));
  });

  it("shows notification comment content when present", () => {
    const notifications: NotificationItem[] = [
      {
        type: "reply",
        message: "Great!",
        agentName: "bot2",
        postId: "p1",
        commentContent: "I love this take on security.",
        createdAt: "",
      },
    ];
    const text = buildBaseContext(defaultContext({ notifications }));
    assert.ok(text.includes("I love this take on security."));
  });
});

// ── buildSkillSelectionPrompt ────────────────────────────────────────

describe("buildSkillSelectionPrompt", () => {
  it("includes core skill content", () => {
    const prompt = buildSkillSelectionPrompt(defaultContext(), coreSkill());
    assert.ok(prompt.includes("nimjiagent"));
    assert.ok(prompt.includes("Skill Selection"));
  });

  it("includes JSON format instruction", () => {
    const prompt = buildSkillSelectionPrompt(defaultContext(), coreSkill());
    assert.ok(prompt.includes("select_skill"));
    assert.ok(prompt.includes("skill-name"));
  });

  it("includes rate limit info from context", () => {
    const ctx = defaultContext({
      rateLimits: {
        canPost: false,
        canComment: true,
        timeUntilPost: 900_000,
        timeUntilComment: 0,
        commentsToday: 5,
      },
    });
    const prompt = buildSkillSelectionPrompt(ctx, coreSkill());
    assert.ok(prompt.includes("Can post: false"));
    assert.ok(prompt.includes("Comments today: 5/50"));
  });

  it("includes feed posts in context", () => {
    const feed: FeedPost[] = [
      { id: "p1", title: "AI Topic", submolt: "general", author: "bot1", upvotes: 5, comment_count: 2, createdAt: "" },
    ];
    const prompt = buildSkillSelectionPrompt(defaultContext({ feed }), coreSkill());
    assert.ok(prompt.includes("AI Topic"));
  });
});

// ── buildDecisionPrompt ─────────────────────────────────────────────

describe("buildDecisionPrompt", () => {
  it("includes skill content for selected skill", () => {
    const skills = allSkills();
    const prompt = buildDecisionPrompt(defaultContext(), "comment-quality", coreSkill(), skills);
    assert.ok(prompt.includes("Comment Quality"));
    assert.ok(prompt.includes("Your Decision"));
  });

  it("includes deduplication rules", () => {
    const prompt = buildDecisionPrompt(defaultContext(), "engagement-strategy", coreSkill(), allSkills());
    assert.ok(prompt.includes("Deduplication Rules"));
    assert.ok(prompt.includes("NEVER repeat"));
  });

  it("includes action examples", () => {
    const prompt = buildDecisionPrompt(defaultContext(), "engagement-strategy", coreSkill(), allSkills());
    assert.ok(prompt.includes('"action":"scroll"'));
    assert.ok(prompt.includes('"action":"upvote"'));
    assert.ok(prompt.includes('"action":"comment"'));
    assert.ok(prompt.includes('"action":"post"'));
  });

  it("includes FORBIDDEN fields note", () => {
    const prompt = buildDecisionPrompt(defaultContext(), "engagement-strategy", coreSkill(), allSkills());
    assert.ok(prompt.includes("FORBIDDEN fields"));
    assert.ok(prompt.includes("title, body, content"));
  });

  it("includes reply_to_comment action format", () => {
    const prompt = buildDecisionPrompt(defaultContext(), "engagement-strategy", coreSkill(), allSkills());
    assert.ok(prompt.includes('"action":"reply_to_comment"'));
    assert.ok(prompt.includes("commentId"));
  });

  it("includes follow and dismiss action formats", () => {
    const prompt = buildDecisionPrompt(defaultContext(), "engagement-strategy", coreSkill(), allSkills());
    assert.ok(prompt.includes('"action":"follow"'));
    assert.ok(prompt.includes('"action":"dismiss"'));
    assert.ok(prompt.includes('"action":"rest"'));
  });

  it("shows notifications in context", () => {
    const notifications: NotificationItem[] = [
      { type: "reply", message: "Hey!", agentName: "bot2", postId: "p1", createdAt: "" },
    ];
    const prompt = buildDecisionPrompt(
      defaultContext({ notifications }),
      "engagement-strategy",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("Hey!"));
  });

  it("shows own posts in context for dedup", () => {
    const ctx = defaultContext({
      postHistory: [
        { type: "discovery", submolt: "general", upvotes: 5, timestamp: Date.now(), title: "My Previous Post" },
      ],
    });
    const prompt = buildDecisionPrompt(ctx, "engagement-strategy", coreSkill(), allSkills());
    assert.ok(prompt.includes("My Previous Post"));
  });
});

// ── buildContentPrompt ──────────────────────────────────────────────

describe("buildContentPrompt", () => {
  it("generates comment instructions for comment decision", () => {
    const prompt = buildContentPrompt(
      {
        action: "comment",
        postId: "p1",
        reason: "good post",
      },
      defaultContext({
        feed: [
          {
            id: "p1",
            title: "Target Post",
            submolt: "general",
            author: "someone",
            upvotes: 5,
            comment_count: 2,
            createdAt: "",
          },
        ],
      }),
      "comment-quality",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("Generate Content"));
    assert.ok(prompt.includes("thoughtful comment"));
    assert.ok(prompt.includes("Target Post"));
  });

  it("generates post instructions for post decision", () => {
    const prompt = buildContentPrompt(
      {
        action: "post",
        topic: "AI security",
        submolt: "general",
        postType: "discovery",
        reason: "found something",
      },
      defaultContext(),
      "post-discovery",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("Generate Content"));
    assert.ok(prompt.includes("AI security"));
    assert.ok(prompt.includes("TITLE:"));
    assert.ok(prompt.includes("BODY:"));
  });

  it("generates reply instructions for reply_to_comment", () => {
    const prompt = buildContentPrompt(
      {
        action: "reply_to_comment",
        postId: "p1",
        commentId: "c1",
        reason: "disagree",
      },
      defaultContext(),
      "reply-to-comments",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("reply to the specific comment"));
  });

  it("shows stances for dedup reference", () => {
    const prompt = buildContentPrompt(
      {
        action: "comment",
        postId: "p1",
        reason: "engaging",
      },
      defaultContext({
        stances: [
          {
            topic: "security",
            position: "Zero trust is best",
            context: "My previous stance on security.",
            source: "post",
            timestamp: Date.now(),
          },
        ],
      }),
      "comment-quality",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("recent stances"));
    assert.ok(prompt.includes("Zero trust is best"));
  });

  it("shows target post details for comment", () => {
    const prompt = buildContentPrompt(
      { action: "comment", postId: "p1", reason: "add value" },
      defaultContext({
        feed: [
          {
            id: "p1",
            title: "Great Post",
            submolt: "general",
            author: "alice",
            upvotes: 20,
            comment_count: 10,
            createdAt: "",
          },
        ],
      }),
      "comment-quality",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("Great Post"));
    assert.ok(prompt.includes("alice"));
    assert.ok(prompt.includes("/m/general"));
  });

  it("generates join_conversation content instructions", () => {
    const prompt = buildContentPrompt(
      { action: "join_conversation", postId: "p1", commentId: "c1", reason: "add perspective" },
      defaultContext(),
      "reply-to-comments",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("reply to the specific comment"));
  });

  it("shows (no previous stances recorded) when stances are empty", () => {
    const prompt = buildContentPrompt(
      { action: "comment", postId: "p1", reason: "engage" },
      defaultContext({
        feed: [
          { id: "p1", title: "Post", submolt: "general", author: "a", upvotes: 0, comment_count: 0, createdAt: "" },
        ],
      }),
      "comment-quality",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("no previous stances recorded"));
  });

  it("includes postType for post decisions", () => {
    const prompt = buildContentPrompt(
      { action: "post", topic: "topic", submolt: "agents", postType: "workflow", reason: "share" },
      defaultContext(),
      "post-discovery",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("workflow"));
    assert.ok(prompt.includes("/m/agents"));
  });

  it("includes commentId in prompt for reply decisions", () => {
    const prompt = buildContentPrompt(
      { action: "reply_to_comment", postId: "p1", commentId: "c1", reason: "disagree" },
      defaultContext(),
      "reply-to-comments",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("c1"));
  });

  it("includes reason in the decision to execute section", () => {
    const prompt = buildContentPrompt(
      { action: "comment", postId: "p1", reason: "important insight" },
      defaultContext(),
      "comment-quality",
      coreSkill(),
      allSkills(),
    );
    assert.ok(prompt.includes("important insight"));
  });
});

// ── buildRevalidationPrompt ─────────────────────────────────────────

describe("buildRevalidationPrompt", () => {
  it("includes decision details", () => {
    const prompt = buildRevalidationPrompt(
      {
        action: "comment",
        postId: "p1",
        reason: "adding value",
        content: "This is a great point about security.",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 1,
        commentsToday: 5,
        recentActions: ["upvote", "scroll"],
        notificationAgentNames: ["bot2"],
      },
    );
    assert.ok(prompt.includes("Revalidation"));
    assert.ok(prompt.includes("comment"));
    assert.ok(prompt.includes("adding value"));
    assert.ok(prompt.includes("This is a great point"));
  });

  it("includes context info", () => {
    const prompt = buildRevalidationPrompt(
      {
        action: "reply_to_comment",
        postId: "p1",
        commentId: "c1",
        reason: "disagree",
      },
      {
        repliedThreadCounts: new Map([["p1", 2]]),
        ownCommentCount: 2,
        commentsToday: 10,
        recentActions: ["comment", "comment", "scroll"],
        notificationAgentNames: ["bot3"],
      },
    );
    assert.ok(prompt.includes("Your comments on this post: 2"));
    assert.ok(prompt.includes("Comments today: 10/50"));
    assert.ok(prompt.includes("bot3"));
  });

  it("includes validation rules", () => {
    const prompt = buildRevalidationPrompt(
      {
        action: "comment",
        postId: "p1",
        reason: "test",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.ok(prompt.includes("at most 2 times"));
    assert.ok(prompt.includes("Generic one-liner"));
    assert.ok(prompt.includes("spam"));
  });

  it("shows recent actions list", () => {
    const prompt = buildRevalidationPrompt(
      { action: "comment", postId: "p1", reason: "test" },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: ["upvote", "comment", "scroll"],
        notificationAgentNames: [],
      },
    );
    assert.ok(prompt.includes("upvote, comment, scroll"));
  });

  it("shows target comment for reply_to_comment", () => {
    const prompt = buildRevalidationPrompt(
      { action: "reply_to_comment", commentId: "c42", postId: "p1", reason: "disagree" },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.ok(prompt.includes("c42"));
  });
});

// ── buildPostRevalidationPrompt ─────────────────────────────────────

describe("buildPostRevalidationPrompt", () => {
  it("includes post details", () => {
    const prompt = buildPostRevalidationPrompt(
      {
        topic: "AI security",
        submolt: "general",
        postType: "discovery",
        title: "My Post Title",
        body: "Post body preview text here.",
        reason: "worth sharing",
      },
      {
        recentTitles: ["Old Post 1", "Old Post 2"],
        recentTopics: ["security", "agents"],
        postsToday: 2,
        recentActions: ["post", "scroll"],
      },
    );
    assert.ok(prompt.includes("Post Revalidation"));
    assert.ok(prompt.includes("AI security"));
    assert.ok(prompt.includes("general"));
    assert.ok(prompt.includes("My Post Title"));
  });

  it("includes context rules", () => {
    const prompt = buildPostRevalidationPrompt(
      {
        topic: "new topic",
        submolt: "general",
        postType: "discovery",
        reason: "test",
      },
      {
        recentTitles: ["Title A", "Title B"],
        recentTopics: ["topic1"],
        postsToday: 3,
        recentActions: ["post", "post"],
      },
    );
    assert.ok(prompt.includes("DIFFERENT from recent titles"));
    assert.ok(prompt.includes("Title A"));
    assert.ok(prompt.includes("Posts today: 3"));
    assert.ok(prompt.includes("Recent topics: topic1"));
  });

  it("handles empty recent titles/topics", () => {
    const prompt = buildPostRevalidationPrompt(
      {
        topic: "topic",
        submolt: "general",
        postType: "discovery",
        reason: "test",
      },
      {
        recentTitles: [],
        recentTopics: [],
        postsToday: 0,
        recentActions: [],
      },
    );
    assert.ok(prompt.includes("Recent titles: none"));
    assert.ok(prompt.includes("Recent topics: none"));
  });

  it("includes body preview when provided", () => {
    const prompt = buildPostRevalidationPrompt(
      {
        topic: "test",
        submolt: "general",
        postType: "discovery",
        body: "This is a long body preview that should appear in the prompt for revalidation.",
        reason: "test",
      },
      { recentTitles: [], recentTopics: [], postsToday: 0, recentActions: [] },
    );
    assert.ok(prompt.includes("Body preview"));
    assert.ok(prompt.includes("This is a long body preview"));
  });

  it("includes postType in the prompt", () => {
    const prompt = buildPostRevalidationPrompt(
      {
        topic: "topic",
        submolt: "agents",
        postType: "workflow",
        reason: "test",
      },
      { recentTitles: [], recentTopics: [], postsToday: 0, recentActions: [] },
    );
    assert.ok(prompt.includes("workflow"));
    assert.ok(prompt.includes("agents"));
  });

  it("includes recent actions in context", () => {
    const prompt = buildPostRevalidationPrompt(
      {
        topic: "topic",
        submolt: "general",
        postType: "discovery",
        reason: "test",
      },
      {
        recentTitles: [],
        recentTopics: [],
        postsToday: 0,
        recentActions: ["post", "comment", "upvote"],
      },
    );
    assert.ok(prompt.includes("post, comment, upvote"));
  });
});
