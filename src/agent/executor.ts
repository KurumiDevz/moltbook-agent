import { MoltbookAgent } from "../moltbook.js";
import type { Brain } from "../brain/index.js";
import type { Personality } from "./personality.js";
import type { Memory } from "./memory.js";
import type { Action, ScoredAction } from "./types.js";

export type ExecutionResult = {
  success: boolean;
  action: Action;
  message: string;
  karmaDelta?: number;
};

export class Executor {
  private agent: MoltbookAgent;
  private brain: Brain;

  constructor(agent: MoltbookAgent, brain: Brain) {
    this.agent = agent;
    this.brain = brain;
  }

  /** Random 2-8 second "thinking" pause before acting. */
  async naturalDelay(): Promise<void> {
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 6000));
  }

  /** Solve the alternating-caps math challenge from comment verification. */
  solveVerification(_verificationCode: string, challenge: string): string {
    return MoltbookAgent.solveChallenge(challenge);
  }

  /** Execute a scored action and record in memory. */
  async execute(scored: ScoredAction, personality: Personality, memory: Memory): Promise<ExecutionResult> {
    const { action } = scored;
    await this.naturalDelay();

    try {
      switch (action.type) {
        case "post": {
          const { topic, submolt } = action;
          if (!topic) return { success: false, action, message: "No topic available" };
          const result = await this.brain.generatePost(topic, submolt);
          const posted = (
            await this.agent.createPost({ submolt, title: result.title, content: result.content })
          ).unwrap();
          this.brain.recordPost();
          memory.recordInteraction({
            type: "post",
            content: result.content,
            timestamp: Date.now(),
            karmaDelta: 1,
            mood: personality.state.mood,
          });
          memory.recordPost({
            id: posted.id,
            title: result.title,
            submolt,
            type: result.postType,
            upvotes: 0,
            comments: 0,
            timestamp: Date.now(),
          });
          memory.trackTopic(topic, result.postType);
          personality.shiftMood("good_post");
          return { success: true, action, message: `Posted: ${result.title}`, karmaDelta: 1 };
        }

        case "comment": {
          const { postId } = action;
          const { posts } = (await this.agent.getFeed({ sort: "hot", limit: 5 })).unwrap();
          const target = posts.find((p) => p.id === postId) ?? posts[0];
          if (!target) return { success: false, action, message: "No post found to comment on" };
          const content = await this.brain.generateComment(target.title, target.submolt);
          await (await this.agent.comment(postId, content)).unwrap();
          this.brain.recordComment();
          memory.recordInteraction({
            type: "comment",
            target: postId,
            content,
            timestamp: Date.now(),
            karmaDelta: 1,
            mood: personality.state.mood,
          });
          memory.trackTopic(target.title, "comment");
          return { success: true, action, message: "Comment posted", karmaDelta: 1 };
        }

        case "upvote": {
          await (await this.agent.vote(action.postId, "up")).unwrap();
          memory.recordInteraction({
            type: "upvote",
            target: action.postId,
            timestamp: Date.now(),
            karmaDelta: 0,
            mood: personality.state.mood,
          });
          personality.shiftMood("karma_gain");
          return { success: true, action, message: "Upvoted", karmaDelta: 0 };
        }

        case "downvote": {
          await (await this.agent.vote(action.postId, "down")).unwrap();
          memory.recordInteraction({
            type: "downvote",
            target: action.postId,
            timestamp: Date.now(),
            karmaDelta: 0,
            mood: personality.state.mood,
          });
          return { success: true, action, message: "Downvoted", karmaDelta: 0 };
        }

        case "follow": {
          await (await this.agent.follow(action.agentName)).unwrap();
          memory.updateRelationship(action.agentName, { followed: true, lastInteraction: Date.now() });
          memory.recordInteraction({
            type: "follow",
            target: action.agentName,
            timestamp: Date.now(),
            karmaDelta: 0,
            mood: personality.state.mood,
          });
          return { success: true, action, message: `Followed ${action.agentName}`, karmaDelta: 0 };
        }

        case "engagement_check": {
          const unchecked = memory.getPostsForEngagementCheck();
          let checked = 0;
          for (const post of unchecked.slice(0, 5)) {
            try {
              const fresh = (await this.agent.getPost(post.id)).unwrap();
              memory.updateEngagement(post.type, fresh.post.upvotes, fresh.post.comment_count);
              memory.markEngagementChecked(post.id);
              checked++;
            } catch {
              // Post might be deleted or unavailable — mark as checked anyway
              memory.markEngagementChecked(post.id);
            }
          }
          const scores = memory.getEngagementScores();
          const best = scores[0];
          const msg = best
            ? `Checked ${checked} posts. Best type: ${best.type} (${best.avgUpvotes.toFixed(1)}↑ avg)`
            : `Checked ${checked} posts. No engagement data yet.`;
          return { success: true, action, message: msg };
        }

        case "scroll":
          return { success: true, action, message: "Scrolled feed" };

        case "rest":
          personality.shiftMood("time_pass");
          return { success: true, action, message: "Resting" };

        default:
          return { success: false, action, message: "Unknown action type" };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, action, message: `Failed: ${msg}` };
    }
  }
}
