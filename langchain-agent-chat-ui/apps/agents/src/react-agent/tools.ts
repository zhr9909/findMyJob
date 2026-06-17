import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type WorkspaceData = {
  jobs?: Record<string, unknown>[];
  sources?: Record<string, unknown>[];
  notes?: Record<string, unknown>[];
};

const WORKSPACE_FILE_CANDIDATES = [
  process.env.FINDMYJOB_WORKSPACE_FILE,
  resolve(process.cwd(), "..", "data", "workspace.json"),
  resolve(process.cwd(), "data", "workspace.json"),
  resolve(process.cwd(), "..", "..", "data", "workspace.json"),
].filter(Boolean) as string[];

const FINDMYJOB_API_URL =
  process.env.FINDMYJOB_API_URL ?? "http://127.0.0.1:8000";

async function loadWorkspace(): Promise<WorkspaceData> {
  try {
    const response = await fetch(`${FINDMYJOB_API_URL}/api/data`);
    if (response.ok) {
      const parsed = (await response.json()) as WorkspaceData;
      return {
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      };
    }
  } catch {
    // Fall back to local JSON for offline development.
  }

  for (const file of WORKSPACE_FILE_CANDIDATES) {
    try {
      const raw = await readFile(file, "utf-8");
      const parsed = JSON.parse(raw) as WorkspaceData;
      return {
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      };
    } catch {
      continue;
    }
  }
  return { jobs: [], sources: [], notes: [] };
}

function compactRecord(record: Record<string, unknown>, maxLength = 900) {
  const copy = { ...record };
  const json = JSON.stringify(copy, null, 2);
  return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
}

function textOf(record: Record<string, unknown>) {
  return Object.values(record)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
}

function rankRecords(
  records: Record<string, unknown>[],
  query: string,
  limit: number,
) {
  const keywords = query
    .toLowerCase()
    .split(/[\s,，、。;；:：/|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);

  return records
    .map((record) => {
      const text = textOf(record);
      const score = keywords.reduce(
        (sum, keyword) => sum + (text.includes(keyword) ? keyword.length : 0),
        0,
      );
      return { record, score };
    })
    .filter((item) => item.score > 0 || !keywords.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.record);
}

export const workspaceSummaryTool = tool(
  async () => {
    const workspace = await loadWorkspace();
    return JSON.stringify(
      {
        jobs: workspace.jobs?.length ?? 0,
        sources: workspace.sources?.length ?? 0,
        notes: workspace.notes?.length ?? 0,
      },
      null,
      2,
    );
  },
  {
    name: "findmyjob_workspace_summary",
    description: "查看 FindMyJob 本地工作台里岗位、摘录、笔记的数量摘要。",
    schema: z.object({}),
  },
);

export const searchWorkspaceTool = tool(
  async ({ query, limit }) => {
    const workspace = await loadWorkspace();
    const count = Math.max(1, Math.min(limit ?? 5, 10));
    const jobs = rankRecords(workspace.jobs ?? [], query, count);
    const sources = rankRecords(workspace.sources ?? [], query, count);
    const notes = rankRecords(workspace.notes ?? [], query, count);
    return JSON.stringify(
      {
        query,
        jobs: jobs.map((item) => compactRecord(item)),
        sources: sources.map((item) => compactRecord(item)),
        notes: notes.map((item) => compactRecord(item)),
      },
      null,
      2,
    );
  },
  {
    name: "findmyjob_search_workspace",
    description:
      "按关键词检索 FindMyJob 本地工作台中的岗位、摘录和笔记，适合回答岗位匹配、简历优化、投递优先级和公司风险问题。",
    schema: z.object({
      query: z.string().describe("用户问题或检索关键词"),
      limit: z.number().optional().describe("每类最多返回多少条，默认 5，最多 10"),
    }),
  },
);

export const listRecentJobsTool = tool(
  async ({ limit }) => {
    const workspace = await loadWorkspace();
    return JSON.stringify(
      (workspace.jobs ?? []).slice(0, Math.max(1, Math.min(limit ?? 5, 10))).map((item) => compactRecord(item)),
      null,
      2,
    );
  },
  {
    name: "findmyjob_list_recent_jobs",
    description: "列出最近保存的岗位记录。",
    schema: z.object({
      limit: z.number().optional().describe("最多返回多少条，默认 5，最多 10"),
    }),
  },
);

export const listRecentSourcesTool = tool(
  async ({ limit }) => {
    const workspace = await loadWorkspace();
    return JSON.stringify(
      (workspace.sources ?? []).slice(0, Math.max(1, Math.min(limit ?? 5, 10))).map((item) => compactRecord(item)),
      null,
      2,
    );
  },
  {
    name: "findmyjob_list_recent_sources",
    description: "列出最近保存的网页、评论和资料摘录。",
    schema: z.object({
      limit: z.number().optional().describe("最多返回多少条，默认 5，最多 10"),
    }),
  },
);

export const listRecentNotesTool = tool(
  async ({ limit }) => {
    const workspace = await loadWorkspace();
    return JSON.stringify(
      (workspace.notes ?? []).slice(0, Math.max(1, Math.min(limit ?? 5, 10))).map((item) => compactRecord(item)),
      null,
      2,
    );
  },
  {
    name: "findmyjob_list_recent_notes",
    description: "列出最近保存的求职复盘笔记。",
    schema: z.object({
      limit: z.number().optional().describe("最多返回多少条，默认 5，最多 10"),
    }),
  },
);

export const TOOLS = [
  workspaceSummaryTool,
  searchWorkspaceTool,
  listRecentJobsTool,
  listRecentSourcesTool,
  listRecentNotesTool,
];
