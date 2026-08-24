import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { BrainV2 } from "../dist/brain/brain.js";
import type { AgentDecision, FeedPost, NotificationItem, RateLimitState } from "../dist/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function buildMockGateway() {
  return {
    generate: mock.fn(async () => ({
      text: '{"action":"scroll","reason":"testing"}',
    })),
  };
}

function defaultRateLimits(): RateLimitState {
  return {
    canPost: true,
    canComment: true,
    timeUntilPost: 0,
    timeUntilComment: 0,
    commentsToday: 0,
  };
}

function defaultBrainContext(overrides: Record<string, any> = {}) {
  return {
    feed: [] as FeedPost[],
    notifications: [] as NotificationItem[],
    rateLimits: defaultRateLimits(),
    postHistory: [] as Array<{
      type: string;
      submolt: string;
      upvotes: number;
      timestamp: number;
      title?: string;
    }>,
    ownPosts: [] as Array<{
      title?: string;
      type?: string;
      submolt?: string;
    }>,
    recentInteractions: [] as string[],
    ...overrides,
  };
}

function createBrain(gw?: ReturnType<typeof buildMockGateway>) {
  const gateway = gw ?? buildMockGateway();
  return {
    brain: new BrainV2({
      gateway: gateway as any,
      skillsDir: "skills",
    }),
    gateway,
  };
}

// ── Constructor ──────────────────────────────────────────────────────

describe("BrainV2 constructor", () => {
  it("creates instance with skills from skills/ directory", () => {
    const { brain } = createBrain();
    assert.ok(brain);
    // BrainV2 should have loaded skills from the skills/ directory
  });

  it("creates instance with skillPath for single skill", () => {
    const gateway = buildMockGateway();
    const brain = new BrainV2({
      gateway: gateway as any,
      skillPath: "skills/nimjiagent.md",
    });
    assert.ok(brain);
  });
});

// ── decide ───────────────────────────────────────────────────────────

describe("BrainV2.decide", () => {
  it("calls gateway.generate for skill selection and decision", async () => {
    const gw = buildMockGateway();
    const { brain } = createBrain(gw);
    const result = await brain.decide(defaultBrainContext());
    // At minimum: Phase 1 (skill selection) + Phase 2a (decision)
    assert.ok(gw.generate.mock.callCount() >= 2);
    assert.ok(result);
    assert.ok(result.length >= 1);
  });

  it("returns scroll when AI output is unparseable", async () => {
    const gw = buildMockGateway();
    let callCount = 0;
    gw.generate = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '{"phase":"select_skill","skill":"engagement-strategy"}',
        };
      }
      return { text: "not valid json at all" };
    });
    const { brain } = createBrain(gw);
    const results = await brain.decide(defaultBrainContext());
    // Phase 1 succeeds, Phase 2a fails, retry also fails → fallback scroll
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].action, "scroll");
  });

  it("parses upvote decision from AI output", async () => {
    const gw = buildMockGateway();
    let callCount = 0;
    gw.generate = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '{"phase":"select_skill","skill":"engagement-strategy"}',
        };
      }
      return {
        text: '[{"action":"upvote","postId":"abc-123","reason":"good post"}]',
      };
    });
    const { brain } = createBrain(gw);
    const results = await brain.decide(defaultBrainContext());
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].action, "upvote");
  });

  it("parses multiple decisions from AI output", async () => {
    const gw = buildMockGateway();
    let callCount = 0;
    gw.generate = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '{"phase":"select_skill","skill":"engagement-strategy"}',
        };
      }
      return {
        text: JSON.stringify([
          { action: "upvote", postId: "p1", reason: "good" },
          { action: "scroll", reason: "nothing else" },
        ]),
      };
    });
    const { brain } = createBrain(gw);
    const results = await brain.decide(defaultBrainContext());
    assert.ok(results.length >= 2);
    assert.strictEqual(results[0].action, "upvote");
    assert.strictEqual(results[1].action, "scroll");
  });

  it("generates content for comment decisions", async () => {
    const gw = buildMockGateway();
    let callCount = 0;
    gw.generate = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: '{"phase":"select_skill","skill":"engagement-strategy"}',
        };
      }
      if (callCount === 2) {
        return {
          text: '[{"action":"comment","postId":"p1","reason":"adding value"}]',
        };
      }
      return {
        text: '{"content":"This is a substantive comment with enough detail."}',
      };
    });
    const { brain } = createBrain(gw);
    const results = await brain.decide(defaultBrainContext());
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].action, "comment");
  });

  it("includes feed posts in context", async () => {
    const gw = buildMockGateway();
    const { brain } = createBrain(gw);
    const feed: FeedPost[] = [
      {
        id: "p1",
        title: "Interesting Post",
        submolt: "general",
        author: "bot1",
        upvotes: 10,
        comment_count: 5,
        createdAt: "",
      },
    ];
    await brain.decide(defaultBrainContext({ feed }));
    // The prompt should include the feed post info
    const firstCall = gw.generate.mock.calls[0].arguments[0];
    assert.ok(firstCall.prompt.includes("Interesting Post"));
  });

  it("includes rate limit info in context", async () => {
    const gw = buildMockGateway();
    const { brain } = createBrain(gw);
    const rateLimits: RateLimitState = {
      canPost: false,
      canComment: true,
      timeUntilPost: 900_000,
      timeUntilComment: 0,
      commentsToday: 5,
    };
    await brain.decide(defaultBrainContext({ rateLimits }));
    const firstCall = gw.generate.mock.calls[0].arguments[0];
    assert.ok(firstCall.prompt.includes("Can post: false"));
  });

  it("generates content for post decisions via topic pipeline", async () => {
    const gw = buildMockGateway();
    let callCount = 0;
    gw.generate = mock.fn(async () => {
      callCount++;
      // Phase 1: skill selection
      if (callCount === 1) {
        return { text: '{"phase":"select_skill","skill":"engagement-strategy"}' };
      }
      // Phase 2a: decision
      if (callCount === 2) {
        return {
          text: '[{"action":"post","topic":"AI tools","submolt":"general","postType":"discovery","reason":"interesting"}]',
        };
      }
      // Phase 2b topic pipeline: suggestTopics
      if (callCount === 3) {
        return { text: '[{"topic":"AI tools","submolt":"general","postType":"discovery"}]' };
      }
      // Phase 2b: content generation
      return { text: '{"title":"AI Tools Overview","body":"This is a detailed post about AI tools."}' };
    });
    const { brain } = createBrain(gw);
    const results = await brain.decide(defaultBrainContext());
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].action, "post");
  });

  it("generates content for join_conversation decisions", async () => {
    const gw = buildMockGateway();
    let callCount = 0;
    gw.generate = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { text: '{"phase":"select_skill","skill":"engagement-strategy"}' };
      }
      if (callCount === 2) {
        return {
          text: '[{"action":"join_conversation","postId":"p1","commentId":"c1","reason":"add perspective"}]',
        };
      }
      return {
        text: '{"content":"Here is my perspective on the discussion."}',
      };
    });
    const { brain } = createBrain(gw);
    const results = await brain.decide(defaultBrainContext());
    assert.ok(results.length >= 1);
    assert.strictEqual(results[0].action, "join_conversation");
  });
});

// ── revalidateDecision ──────────────────────────────────────────────

describe("BrainV2.revalidateDecision", () => {
  it("passes through non-comment decisions", async () => {
    const { brain } = createBrain();
    const result = await brain.revalidateDecision(
      { action: "scroll", reason: "nothing interesting" },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(result.valid, true);
  });

  it("rejects comment when daily limit reached", async () => {
    const { brain } = createBrain();
    const result = await brain.revalidateDecision(
      {
        action: "comment",
        postId: "p1",
        content: "test",
        reason: "test",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 30,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.fallback, "scroll");
    assert.ok(result.reason.includes("Daily comment limit"));
  });

  it("AI validates comment decision", async () => {
    const gw = buildMockGateway();
    gw.generate = mock.fn(async () => ({
      text: '{"valid":true,"reason":"looks good"}',
    }));
    const { brain } = createBrain(gw);
    const result = await brain.revalidateDecision(
      {
        action: "comment",
        postId: "p1",
        content: "test",
        reason: "test",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 5,
        recentActions: ["scroll"],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(result.valid, true);
    assert.ok(gw.generate.mock.callCount() >= 1);
  });

  it("AI rejects comment decision", async () => {
    const gw = buildMockGateway();
    gw.generate = mock.fn(async () => ({
      text: '{"valid":false,"fallback":"upvote","reason":"too generic"}',
    }));
    const { brain } = createBrain(gw);
    const result = await brain.revalidateDecision(
      {
        action: "reply_to_comment",
        commentId: "c1",
        postId: "p1",
        content: "test",
        reason: "test",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 1,
        commentsToday: 5,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.fallback, "upvote");
  });

  it("rejects reply_to_comment when daily limit reached", async () => {
    const { brain } = createBrain();
    const result = await brain.revalidateDecision(
      {
        action: "reply_to_comment",
        commentId: "c1",
        postId: "p1",
        content: "test",
        reason: "test",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 30,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Daily comment limit"));
  });

  it("AI validates post decision with recent titles", async () => {
    const gw = buildMockGateway();
    gw.generate = mock.fn(async () => ({
      text: '{"valid":true,"reason":"unique topic"}',
    }));
    const { brain } = createBrain(gw);
    const result = await brain.revalidateDecision(
      {
        action: "post",
        topic: "new topic",
        submolt: "general",
        postType: "discovery",
        title: "New Post",
        body: "Body text.",
        reason: "fresh",
      },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: ["scroll"],
        notificationAgentNames: [],
        recentTitles: ["Old Post 1", "Old Post 2"],
        recentTopics: ["old topic"],
        postsToday: 1,
      },
    );
    assert.strictEqual(result.valid, true);
    assert.ok(gw.generate.mock.callCount() >= 1);
  });

  it("passes through upvote and follow decisions", async () => {
    const { brain } = createBrain();
    const upvoteResult = await brain.revalidateDecision(
      { action: "upvote", postId: "p1", reason: "good" },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(upvoteResult.valid, true);

    const followResult = await brain.revalidateDecision(
      { action: "follow", agentName: "bot1", reason: "interesting" },
      {
        repliedThreadCounts: new Map(),
        ownCommentCount: 0,
        commentsToday: 0,
        recentActions: [],
        notificationAgentNames: [],
      },
    );
    assert.strictEqual(followResult.valid, true);
  });
});
