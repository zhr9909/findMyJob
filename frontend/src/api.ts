import type {
  AgentFrame,
  AgentResult,
  AnalysisTask,
  Bucket,
  Conversation,
  ConversationDetail,
  WorkspaceData,
} from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function api<T>(path: string, options: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      headers: JSON_HEADERS,
      signal: controller.signal,
      ...options,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.error || `请求失败：${response.status}`);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("请求超时，请刷新或稍后重试");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getWorkspace() {
  return api<WorkspaceData>("/api/data", {}, 8000);
}

export function saveWorkspace(data: WorkspaceData) {
  return api<WorkspaceData>(
    "/api/data",
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
    12000,
  );
}

export function createRecord<T>(bucket: Bucket, item: Partial<T>) {
  return api<T>(
    `/api/${bucket}`,
    {
      method: "POST",
      body: JSON.stringify(item),
    },
    12000,
  );
}

export function deleteRecord(bucket: Bucket, id: string) {
  return api<{ ok: boolean }>(
    `/api/${bucket}/${id}`,
    {
      method: "DELETE",
    },
    12000,
  );
}

export function getConversations() {
  return api<{ conversations: Conversation[] }>("/api/agent/conversations", {}, 8000);
}

export function getConversation(id: string) {
  return api<ConversationDetail>(`/api/agent/conversations/${id}`, {}, 10000);
}

export function runAgent(prompt: string, conversationId?: string | null) {
  return api<AgentResult>(
    "/api/agent",
    {
      method: "POST",
      body: JSON.stringify({ prompt, conversationId }),
    },
    70000,
  );
}

export async function streamAgent(
  prompt: string,
  conversationId: string | null | undefined,
  onFrame: (frame: AgentFrame) => void,
) {
  const response = await fetch("/api/agent/stream", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ prompt, conversationId }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    throw new Error(payload?.error || `请求失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .find((item) => item.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      onFrame(JSON.parse(json) as AgentFrame);
    }
  }
}

export function getAnalysisTasks() {
  return api<{ tasks: AnalysisTask[] }>("/api/analysis-tasks", {}, 8000);
}

export function createAnalysisTask(payload: {
  url: string;
  channel: string;
  question?: string;
  tags?: string[];
}) {
  return api<{ task: AnalysisTask }>(
    "/api/analysis-tasks",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    12000,
  );
}

export function health() {
  return api<{ ok: boolean; runningTasks: number; workers: number }>("/api/health", {}, 5000);
}
