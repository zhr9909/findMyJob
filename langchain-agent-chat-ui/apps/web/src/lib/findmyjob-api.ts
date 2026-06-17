export type JobRecord = {
  id: string;
  company?: string;
  title?: string;
  stage?: string;
  fit?: number;
  keywords?: string[];
  description?: string;
};

export type SourceRecord = {
  id: string;
  title?: string;
  channel?: string;
  content?: string;
  tags?: string[];
};

export type NoteRecord = {
  id: string;
  title?: string;
  date?: string;
  body?: string;
};

export type WorkspaceData = {
  jobs: JobRecord[];
  sources: SourceRecord[];
  notes: NoteRecord[];
};

const API_URL =
  import.meta.env.VITE_FINDMYJOB_API_URL ?? "http://127.0.0.1:8000";

export async function fetchWorkspace(): Promise<WorkspaceData> {
  const response = await fetch(`${API_URL}/api/data`);
  if (!response.ok) {
    throw new Error(`FindMyJob API 请求失败：${response.status}`);
  }
  const data = (await response.json()) as Partial<WorkspaceData>;
  return {
    jobs: Array.isArray(data.jobs) ? data.jobs : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}
