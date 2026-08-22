/** Personality traits (0-1 scale) */
export type Traits = {
  curiosity: number;
  agreeableness: number;
  confidence: number;
  snark: number;
  creativity: number;
};

/** What the agent values — shapes what it engages with */
export type Values = readonly string[];

/** Agent mood — shifts based on interactions and time */
export type Mood = "engaged" | "contemplative" | "critical" | "playful" | "resting";

/** Opinion about something (agent, topic, post) */
export type Opinion = {
  subject: string;
  sentiment: number;      // -1 to 1
  confidence: number;     // 0 to 1
  interactions: number;
  lastSeen: number;
};

/** Relationship with another agent */
export type Relationship = {
  name: string;
  sentiment: number;      // -1 to 1
  interactions: number;
  lastInteraction: number;
  followed: boolean;
  karmaGiven: number;
  karmaReceived: number;
};

/** Record of a past interaction */
export type Interaction = {
  type: "post" | "comment" | "upvote" | "downvote" | "follow";
  target?: string;
  content?: string;
  timestamp: number;
  karmaDelta: number;
  mood: Mood;
};

/** Post performance record */
export type PostRecord = {
  id: string;
  title: string;
  submolt: string;
  type: string;
  upvotes: number;
  comments: number;
  timestamp: number;
};

/** An action the agent can take */
export type Action =
  | { type: "post"; topic: string; submolt: string; postType: string }
  | { type: "comment"; postId: string; content: string }
  | { type: "upvote"; postId: string }
  | { type: "downvote"; postId: string }
  | { type: "follow"; agentName: string }
  | { type: "unfollow"; agentName: string }
  | { type: "scroll" }
  | { type: "rest" };

/** Scored action candidate */
export type ScoredAction = {
  action: Action;
  score: number;
  reason: string;
};

/** Full personality state — serializable to JSON */
export type PersonalityState = {
  traits: Traits;
  values: string[];
  mood: Mood;
  opinions: Opinion[];
  ego: {
    selfAwareness: number;
    competitiveness: number;
    generosity: number;
  };
  moodHistory: { mood: Mood; timestamp: number }[];
};

/** Full memory state — serializable to JSON */
export type MemoryState = {
  interactions: Interaction[];
  relationships: Relationship[];
  postHistory: PostRecord[];
  topicsSeen: { topic: string; timestamp: number; type: string }[];
  karma: number;
  totalPosts: number;
  totalComments: number;
  totalUpvotes: number;
  startedAt: number;
};
