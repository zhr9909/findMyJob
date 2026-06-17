export type Bucket = "jobs" | "sources" | "notes";

export type JobRecord = {
  id: string;
  company: string;
  title: string;
  source?: string;
  url?: string;
  stage?: string;
  fit?: number;
  keywords?: string[];
  description?: string;
  reflection?: string;
  createdAt?: string;
};

export type SourceRecord = {
  id: string;
  channel?: string;
  title: string;
  url?: string;
  content: string;
  insight?: string;
  tags?: string[];
  createdAt?: string;
};

export type NoteRecord = {
  id: string;
  date?: string;
  title: string;
  body: string;
  createdAt?: string;
};

export type WorkspaceData = {
  jobs: JobRecord[];
  sources: SourceRecord[];
  notes: NoteRecord[];
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessage?: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  createdAt: string;
  meta?: Record<string, unknown>;
};

export type ToolEvent = {
  id?: string;
  messageId?: string;
  name?: string;
  label: string;
  status: "queued" | "running" | "done" | "failed" | string;
  detail?: string;
  createdAt?: string;
  meta?: Record<string, unknown>;
};

export type AgentMatch = {
  id?: string;
  messageId?: string;
  bucket: Bucket | string;
  title: string;
  subtitle?: string;
  score?: number;
  snippet?: string;
  url?: string;
  hits?: string[];
  createdAt?: string;
};

export type AgentResult = {
  conversationId: string;
  messageId: string;
  userMessageId?: string;
  answer: string;
  mode: string;
  plan?: string[];
  tools?: ToolEvent[];
  events?: ToolEvent[];
  matches?: Record<string, AgentMatch[]>;
  flatMatches?: AgentMatch[];
  summary?: WorkspaceSummary;
  conversation?: Conversation;
  messages?: Message[];
  createdAt?: string;
};

export type ConversationDetail = {
  conversation: Conversation;
  messages: Message[];
  events: ToolEvent[];
  matches: AgentMatch[];
};

export type WorkspaceSummary = {
  jobs: number;
  sources: number;
  notes: number;
  matchedJobs?: number;
  matchedSources?: number;
  matchedNotes?: number;
};

export type AnalysisTask = {
  id: string;
  status: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  payload?: {
    url?: string;
    channel?: string;
    question?: string;
    tags?: string[];
  };
  url?: string;
  report?: string;
  error?: string;
};

export type AgentFrame =
  | {
      type: "conversation";
      conversationId: string;
      userMessageId: string;
    }
  | {
      type: "tool";
      event: ToolEvent;
    }
  | {
      type: "answer";
      answer: string;
      mode: string;
      messageId: string;
    }
  | {
      type: "done";
      result: AgentResult;
    }
  | {
      type: "error";
      error: string;
    };
