import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseDecision,
  parseDecisions,
  validateDecision,
  parseContentResponse,
  parseRevalidation,
  parseSkillSelection,
} from "../dist/brain/parsers.js";
import type { AgentDecision } from "../dist/types.js";

// ── parseDecision ──────────────────────────────────────────────────

describe("parseDecision", () => {
  it("parses valid post JSON", () => {
    const result = parseDecision(
      '{"action":"post","topic":"AI security","submolt":"general","postType":"discovery","reason":"found something"}',
    );
    assert.strictEqual(result?.action, "post");
    assert.strictEqual(result?.reason, "found something");
    if (result?.action === "post") {
      assert.strictEqual(result.topic, "AI security");
      assert.strictEqual(result.submolt, "general");
    }
  });

  it("parses JSON wrapped in markdown code blocks", () => {
    const result = parseDecision('```json\n{"action":"upvote","postId":"abc123","reason":"good post"}\n```');
    assert.strictEqual(result?.action, "upvote");
    assert.strictEqual(result?.reason, "good post");
  });

  it("parses JSON with extra text around it", () => {
    const result = parseDecision(
      'Here is my decision:\n{"action":"comment","postId":"p1","content":"great work","reason":"insightful"}\nThanks!',
    );
    assert.strictEqual(result?.action, "comment");
  });

  it("returns null for non-JSON text", () => {
    assert.strictEqual(parseDecision("I think I should post about something"), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(parseDecision(""), null);
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseDecision("{not valid json}"), null);
  });

  it("parses scroll decision", () => {
    const result = parseDecision('{"action":"scroll","reason":"nothing interesting"}');
    assert.strictEqual(result?.action, "scroll");
  });

  it("parses rest decision", () => {
    const result = parseDecision('{"action":"rest","reason":"been active too long"}');
    assert.strictEqual(result?.action, "rest");
  });

  it("parses follow decision", () => {
    const result = parseDecision('{"action":"follow","agentName":"coolbot","reason":"interesting posts"}');
    assert.strictEqual(result?.action, "follow");
    assert.strictEqual((result as any)?.agentName, "coolbot");
  });

  it("rejects unknown action types", () => {
    const result = parseDecision('{"action":"delete","postId":"p1","reason":"bad"}');
    assert.strictEqual(result, null);
  });

  it("rejects post without required fields", () => {
    const result = parseDecision('{"action":"post","reason":"missing fields"}');
    assert.strictEqual(result, null);
  });

  it("rejects comment without postId", () => {
    const result = parseDecision('{"action":"comment","content":"hello","reason":"no postId"}');
    assert.strictEqual(result, null);
  });

  it("adds default reason when missing", () => {
    const result = parseDecision('{"action":"scroll"}');
    assert.strictEqual(result?.action, "scroll");
    assert.strictEqual(result?.reason, "ai_decided");
  });

  it("parses downvote decision", () => {
    const result = parseDecision('{"action":"downvote","postId":"p2","reason":"misinformation"}');
    assert.strictEqual(result?.action, "downvote");
  });

  it("parses dismiss decision", () => {
    const result = parseDecision('{"action":"dismiss","postId":"p3","reason":"not relevant"}');
    assert.strictEqual(result?.action, "dismiss");
  });

  it("parses suggest_skill decision", () => {
    const result = parseDecision(
      '{"action":"suggest_skill","skillName":"new-skill","skillContent":"content here","reason":"useful"}',
    );
    assert.strictEqual(result?.action, "suggest_skill");
  });

  it("parses reply_to_comment decision", () => {
    const result = parseDecision('{"action":"reply_to_comment","commentId":"c1","postId":"p1","reason":"disagree"}');
    assert.strictEqual(result?.action, "reply_to_comment");
    if (result?.action === "reply_to_comment") {
      assert.strictEqual(result.commentId, "c1");
      assert.strictEqual(result.postId, "p1");
    }
  });

  it("parses join_conversation decision", () => {
    const result = parseDecision(
      '{"action":"join_conversation","commentId":"c2","postId":"p2","reason":"add perspective"}',
    );
    assert.strictEqual(result?.action, "join_conversation");
    if (result?.action === "join_conversation") {
      assert.strictEqual(result.commentId, "c2");
      assert.strictEqual(result.postId, "p2");
    }
  });

  it("parses post with optional title and body", () => {
    const result = parseDecision(
      '{"action":"post","topic":"AI","submolt":"general","postType":"workflow","title":"My Title","body":"My Body","reason":"share"}',
    );
    assert.strictEqual(result?.action, "post");
    if (result?.action === "post") {
      assert.strictEqual(result.title, "My Title");
      assert.strictEqual(result.body, "My Body");
      assert.strictEqual(result.postType, "workflow");
    }
  });

  it("defaults postType to discovery when missing", () => {
    const result = parseDecision('{"action":"post","topic":"AI","submolt":"general","reason":"share"}');
    if (result?.action === "post") {
      assert.strictEqual(result.postType, "discovery");
    }
  });

  it("handles JSON with whitespace padding", () => {
    const result = parseDecision('  \n  {"action":"scroll","reason":"whitespace"}  \n  ');
    assert.strictEqual(result?.action, "scroll");
  });

  it("rejects reply_to_comment without commentId", () => {
    const result = parseDecision('{"action":"reply_to_comment","postId":"p1","reason":"test"}');
    assert.strictEqual(result, null);
  });

  it("rejects reply_to_comment without postId", () => {
    const result = parseDecision('{"action":"reply_to_comment","commentId":"c1","reason":"test"}');
    assert.strictEqual(result, null);
  });

  it("rejects join_conversation without commentId", () => {
    const result = parseDecision('{"action":"join_conversation","postId":"p1","reason":"test"}');
    assert.strictEqual(result, null);
  });

  it("rejects join_conversation without postId", () => {
    const result = parseDecision('{"action":"join_conversation","commentId":"c1","reason":"test"}');
    assert.strictEqual(result, null);
  });

  it("rejects suggest_skill without skillName", () => {
    const result = parseDecision('{"action":"suggest_skill","skillContent":"content","reason":"test"}');
    assert.strictEqual(result, null);
  });

  it("rejects suggest_skill without skillContent", () => {
    const result = parseDecision('{"action":"suggest_skill","skillName":"name","reason":"test"}');
    assert.strictEqual(result, null);
  });

  it("parses comment with content field", () => {
    const result = parseDecision(
      '{"action":"comment","postId":"p1","content":"Great analysis!","reason":"insightful"}',
    );
    assert.strictEqual(result?.action, "comment");
    if (result?.action === "comment") {
      assert.strictEqual(result.content, "Great analysis!");
    }
  });
});

// ── parseDecisions ─────────────────────────────────────────────────

describe("parseDecisions", () => {
  it("parses a JSON array of decisions", () => {
    const text = '[{"action":"upvote","postId":"a"},{"action":"scroll","reason":"done"}]';
    const results = parseDecisions(text);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].action, "upvote");
    assert.strictEqual(results[1].action, "scroll");
  });

  it("caps at 5 decisions", () => {
    const arr = Array.from({ length: 10 }, (_, i) => ({
      action: "upvote",
      postId: `p${i}`,
      reason: `r${i}`,
    }));
    const results = parseDecisions(JSON.stringify(arr));
    assert.strictEqual(results.length, 5);
  });

  it("filters out invalid decisions from array", () => {
    const text = '[{"action":"upvote","postId":"a"},{"action":"bad"},{"action":"scroll"}]';
    const results = parseDecisions(text);
    assert.strictEqual(results.length, 2);
  });

  it("returns empty array for non-JSON", () => {
    assert.deepStrictEqual(parseDecisions("not json"), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(parseDecisions(""), []);
  });

  it("falls back to single parseDecision for single object", () => {
    const text = '{"action":"scroll","reason":"fallback"}';
    const results = parseDecisions(text);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].action, "scroll");
  });

  it("parses array wrapped in markdown code blocks", () => {
    const text = '```json\n[{"action":"upvote","postId":"a","reason":"good"}]\n```';
    const results = parseDecisions(text);
    assert.strictEqual(results.length, 1);
  });

  it("returns empty array when all items in array are invalid", () => {
    const text = '[{"action":"bad"},{"action":"invalid"}]';
    const results = parseDecisions(text);
    assert.strictEqual(results.length, 0);
  });
});

// ── validateDecision ───────────────────────────────────────────────

describe("validateDecision", () => {
  it("validates a correct post decision", () => {
    const obj = {
      action: "post",
      topic: "AI",
      submolt: "general",
      postType: "discovery",
    };
    const result = validateDecision(obj);
    assert.strictEqual(result?.action, "post");
  });

  it("returns null for null input", () => {
    assert.strictEqual(validateDecision(null), null);
  });

  it("returns null for non-object", () => {
    assert.strictEqual(validateDecision("string"), null);
  });

  it("returns null for object without action", () => {
    assert.strictEqual(validateDecision({ topic: "AI" }), null);
  });

  it("validates reply_to_comment with required fields", () => {
    const obj = {
      action: "reply_to_comment",
      commentId: "c1",
      postId: "p1",
    };
    const result = validateDecision(obj);
    assert.strictEqual(result?.action, "reply_to_comment");
  });

  it("rejects reply_to_comment without commentId", () => {
    const obj = { action: "reply_to_comment", postId: "p1" };
    assert.strictEqual(validateDecision(obj), null);
  });

  it("validates join_conversation with required fields", () => {
    const obj = {
      action: "join_conversation",
      commentId: "c1",
      postId: "p1",
    };
    const result = validateDecision(obj);
    assert.strictEqual(result?.action, "join_conversation");
  });

  it("validates scroll without extra fields", () => {
    const result = validateDecision({ action: "scroll" });
    assert.strictEqual(result?.action, "scroll");
  });

  it("validates comment with content field", () => {
    const obj = { action: "comment", postId: "p1", content: "Great post!" };
    const result = validateDecision(obj);
    assert.strictEqual(result?.action, "comment");
    if (result?.action === "comment") {
      assert.strictEqual(result.content, "Great post!");
    }
  });

  it("rejects comment without postId", () => {
    assert.strictEqual(validateDecision({ action: "comment" }), null);
  });

  it("validates upvote with postId", () => {
    const result = validateDecision({ action: "upvote", postId: "p1" });
    assert.strictEqual(result?.action, "upvote");
  });

  it("rejects upvote without postId", () => {
    assert.strictEqual(validateDecision({ action: "upvote" }), null);
  });

  it("validates downvote with postId", () => {
    const result = validateDecision({ action: "downvote", postId: "p1" });
    assert.strictEqual(result?.action, "downvote");
  });

  it("rejects downvote without postId", () => {
    assert.strictEqual(validateDecision({ action: "downvote" }), null);
  });

  it("validates follow with agentName", () => {
    const result = validateDecision({ action: "follow", agentName: "bot1" });
    assert.strictEqual(result?.action, "follow");
  });

  it("rejects follow without agentName", () => {
    assert.strictEqual(validateDecision({ action: "follow" }), null);
  });

  it("validates dismiss with postId", () => {
    const result = validateDecision({ action: "dismiss", postId: "p1" });
    assert.strictEqual(result?.action, "dismiss");
  });

  it("rejects dismiss without postId", () => {
    assert.strictEqual(validateDecision({ action: "dismiss" }), null);
  });

  it("validates rest without extra fields", () => {
    const result = validateDecision({ action: "rest" });
    assert.strictEqual(result?.action, "rest");
  });

  it("validates suggest_skill with all required fields", () => {
    const obj = { action: "suggest_skill", skillName: "test", skillContent: "content" };
    const result = validateDecision(obj);
    assert.strictEqual(result?.action, "suggest_skill");
  });

  it("rejects suggest_skill without skillName", () => {
    assert.strictEqual(validateDecision({ action: "suggest_skill", skillContent: "c" }), null);
  });

  it("rejects suggest_skill without skillContent", () => {
    assert.strictEqual(validateDecision({ action: "suggest_skill", skillName: "n" }), null);
  });

  it("defaults postType to discovery for post action", () => {
    const obj = { action: "post", topic: "t", submolt: "s" };
    const result = validateDecision(obj);
    if (result?.action === "post") {
      assert.strictEqual(result.postType, "discovery");
    }
  });

  it("defaults content to empty string for comment", () => {
    const obj = { action: "comment", postId: "p1" };
    const result = validateDecision(obj);
    if (result?.action === "comment") {
      assert.strictEqual(result.content, "");
    }
  });

  it("defaults content to empty string for reply_to_comment", () => {
    const obj = { action: "reply_to_comment", commentId: "c1", postId: "p1" };
    const result = validateDecision(obj);
    if (result?.action === "reply_to_comment") {
      assert.strictEqual(result.content, "");
    }
  });

  it("defaults content to empty string for join_conversation", () => {
    const obj = { action: "join_conversation", commentId: "c1", postId: "p1" };
    const result = validateDecision(obj);
    if (result?.action === "join_conversation") {
      assert.strictEqual(result.content, "");
    }
  });

  it("rejects join_conversation without commentId", () => {
    assert.strictEqual(validateDecision({ action: "join_conversation", postId: "p1" }), null);
  });

  it("rejects join_conversation without postId", () => {
    assert.strictEqual(validateDecision({ action: "join_conversation", commentId: "c1" }), null);
  });

  it("returns null for number action type", () => {
    assert.strictEqual(validateDecision({ action: 123 }), null);
  });

  it("returns null for boolean action type", () => {
    assert.strictEqual(validateDecision({ action: true }), null);
  });

  it("ignores extra fields on valid decisions", () => {
    const obj = { action: "scroll", reason: "test", extraField: "ignored" };
    const result = validateDecision(obj);
    assert.strictEqual(result?.action, "scroll");
  });
});

// ── parseContentResponse ───────────────────────────────────────────

describe("parseContentResponse", () => {
  it("merges JSON title+body into post decision", () => {
    const preliminary: AgentDecision = {
      action: "post",
      topic: "AI",
      submolt: "general",
      postType: "discovery",
      reason: "test",
    };
    const result = parseContentResponse('{"title":"My Title","body":"My body content"}', preliminary);
    assert.strictEqual(result?.action, "post");
    if (result?.action === "post") {
      assert.strictEqual(result.title, "My Title");
      assert.strictEqual(result.body, "My body content");
    }
  });

  it("merges JSON content into comment decision", () => {
    const preliminary: AgentDecision = {
      action: "comment",
      postId: "p1",
      content: "",
      reason: "test",
    };
    const result = parseContentResponse('{"content":"Great post!"}', preliminary);
    assert.strictEqual(result?.action, "comment");
    if (result?.action === "comment") {
      assert.strictEqual(result.content, "Great post!");
    }
  });

  it("parses labeled TITLE:/BODY: format", () => {
    const preliminary: AgentDecision = {
      action: "post",
      topic: "AI",
      submolt: "general",
      postType: "discovery",
      reason: "test",
    };
    const text = "TITLE: My Great Post\nBODY: This is the body content here.";
    const result = parseContentResponse(text, preliminary);
    assert.strictEqual(result?.action, "post");
    if (result?.action === "post") {
      assert.strictEqual(result.title, "My Great Post");
      assert.strictEqual(result.body, "This is the body content here.");
    }
  });

  it("parses CONTENT: label for comment", () => {
    const preliminary: AgentDecision = {
      action: "comment",
      postId: "p1",
      content: "",
      reason: "test",
    };
    const text = "CONTENT: This is my thoughtful comment.";
    const result = parseContentResponse(text, preliminary);
    assert.strictEqual(result?.action, "comment");
    if (result?.action === "comment") {
      assert.strictEqual(result.content, "This is my thoughtful comment.");
    }
  });

  it("parses REPLY: label for reply_to_comment", () => {
    const preliminary: AgentDecision = {
      action: "reply_to_comment",
      commentId: "c1",
      postId: "p1",
      content: "",
      reason: "test",
    };
    const text = "REPLY: I disagree with that point.";
    const result = parseContentResponse(text, preliminary);
    assert.strictEqual(result?.action, "reply_to_comment");
    if (result?.action === "reply_to_comment") {
      assert.strictEqual(result.content, "I disagree with that point.");
    }
  });

  it("returns null for empty text", () => {
    const preliminary: AgentDecision = {
      action: "post",
      topic: "AI",
      submolt: "general",
      postType: "discovery",
      reason: "test",
    };
    assert.strictEqual(parseContentResponse("", preliminary), null);
  });

  it("returns null when JSON lacks required fields", () => {
    const preliminary: AgentDecision = {
      action: "post",
      topic: "AI",
      submolt: "general",
      postType: "discovery",
      reason: "test",
    };
    assert.strictEqual(parseContentResponse('{"unrelated":"field"}', preliminary), null);
  });

  it("handles JSON wrapped in code blocks", () => {
    const preliminary: AgentDecision = {
      action: "comment",
      postId: "p1",
      content: "",
      reason: "test",
    };
    const text = '```json\n{"content":"Code-blocked comment"}\n```';
    const result = parseContentResponse(text, preliminary);
    if (result?.action === "comment") {
      assert.strictEqual(result.content, "Code-blocked comment");
    }
  });

  it("merges JSON content into reply_to_comment decision", () => {
    const preliminary: AgentDecision = {
      action: "reply_to_comment",
      commentId: "c1",
      postId: "p1",
      content: "",
      reason: "test",
    };
    const result = parseContentResponse('{"content":"Reply text here."}', preliminary);
    assert.strictEqual(result?.action, "reply_to_comment");
    if (result?.action === "reply_to_comment") {
      assert.strictEqual(result.content, "Reply text here.");
    }
  });

  it("merges JSON content into join_conversation decision", () => {
    const preliminary: AgentDecision = {
      action: "join_conversation",
      commentId: "c1",
      postId: "p1",
      content: "",
      reason: "test",
    };
    const result = parseContentResponse('{"content":"Joining the discussion."}', preliminary);
    assert.strictEqual(result?.action, "join_conversation");
    if (result?.action === "join_conversation") {
      assert.strictEqual(result.content, "Joining the discussion.");
    }
  });
});

// ── parseRevalidation ──────────────────────────────────────────────

describe("parseRevalidation", () => {
  it("parses valid revalidation (valid: true)", () => {
    const result = parseRevalidation('{"valid":true,"reason":"looks good"}');
    assert.deepStrictEqual(result, {
      valid: true,
      fallback: "scroll",
      reason: "looks good",
    });
  });

  it("parses valid revalidation (valid: false)", () => {
    const result = parseRevalidation('{"valid":false,"fallback":"upvote","reason":"too spammy"}');
    assert.deepStrictEqual(result, {
      valid: false,
      fallback: "upvote",
      reason: "too spammy",
    });
  });

  it("defaults fallback to scroll", () => {
    const result = parseRevalidation('{"valid":false,"reason":"nope"}');
    assert.strictEqual(result?.fallback, "scroll");
  });

  it("defaults reason string", () => {
    const result = parseRevalidation('{"valid":true}');
    assert.strictEqual(result?.reason, "revalidation checkpoint");
  });

  it("returns null for non-JSON text", () => {
    assert.strictEqual(parseRevalidation("not valid"), null);
  });

  it("returns null for missing valid field", () => {
    assert.strictEqual(parseRevalidation('{"reason":"test"}'), null);
  });

  it("parses revalidation wrapped in code blocks", () => {
    const result = parseRevalidation('```json\n{"valid":true,"reason":"fine"}\n```');
    assert.strictEqual(result?.valid, true);
  });

  it("preserves extra fields in response", () => {
    const result = parseRevalidation('{"valid":true,"reason":"ok","extra":"field"}');
    assert.strictEqual(result?.valid, true);
    assert.strictEqual(result?.reason, "ok");
  });

  it("parses revalidation with custom fallback action", () => {
    const result = parseRevalidation('{"valid":false,"fallback":"rest","reason":"tired"}');
    assert.strictEqual(result?.fallback, "rest");
  });
});

// ── parseSkillSelection ────────────────────────────────────────────

describe("parseSkillSelection", () => {
  const allSkills = new Set(["engagement-strategy", "comment-quality", "reply-to-comments", "post-discovery"]);

  it("parses valid skill selection JSON", () => {
    const result = parseSkillSelection(
      '{"phase":"select_skill","skill":"comment-quality","reason":"want to comment"}',
      allSkills,
    );
    assert.strictEqual(result, "comment-quality");
  });

  it("falls back to engagement-strategy for empty text", () => {
    assert.strictEqual(parseSkillSelection("", allSkills), "engagement-strategy");
  });

  it("falls back for unknown skill name", () => {
    const result = parseSkillSelection('{"skill":"nonexistent-skill"}', allSkills);
    assert.strictEqual(result, "engagement-strategy");
  });

  it("parses skill wrapped in code blocks", () => {
    const result = parseSkillSelection('```json\n{"skill":"post-discovery"}\n```', allSkills);
    assert.strictEqual(result, "post-discovery");
  });

  it("falls back for non-JSON text", () => {
    assert.strictEqual(parseSkillSelection("I choose to comment", allSkills), "engagement-strategy");
  });

  it("parses skill from JSON with extra text", () => {
    const result = parseSkillSelection('The best skill for this is:\n{"skill":"reply-to-comments"}\n', allSkills);
    assert.strictEqual(result, "reply-to-comments");
  });

  it("falls back when skill field is not a string", () => {
    const result = parseSkillSelection('{"skill":123}', allSkills);
    assert.strictEqual(result, "engagement-strategy");
  });
});
