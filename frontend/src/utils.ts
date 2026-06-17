import type { AgentMatch, Bucket, WorkspaceData } from "./types";

export function cx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

export function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function todayInput() {
  return new Date().toISOString().slice(0, 10);
}

export function splitTags(text: string) {
  return text
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeWorkspace(data?: Partial<WorkspaceData>): WorkspaceData {
  return {
    jobs: Array.isArray(data?.jobs) ? data.jobs : [],
    sources: Array.isArray(data?.sources) ? data.sources : [],
    notes: Array.isArray(data?.notes) ? data.notes : [],
  };
}

export function filterRecords<T>(items: T[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
}

export function bucketLabel(bucket: Bucket | string) {
  return {
    jobs: "岗位",
    sources: "摘录",
    notes: "笔记",
  }[bucket] || bucket;
}

export function flattenMatches(matches?: Record<string, AgentMatch[]> | AgentMatch[]) {
  if (!matches) return [];
  if (Array.isArray(matches)) return matches;
  return Object.entries(matches).flatMap(([bucket, items]) =>
    (items || []).map((item) => ({ ...item, bucket: item.bucket || bucket })),
  );
}

export function buildKeywordCloud(data: WorkspaceData) {
  const counts = new Map<string, number>();
  const add = (word?: string) => {
    const cleaned = String(word || "").trim();
    if (!cleaned || cleaned.length < 2 || cleaned.length > 18) return;
    counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
  };
  const tokenize = (text?: string) =>
    String(text || "")
      .split(/[\s,，.。;；:：/、|()（）[\]【】"'“”]+/)
      .filter(Boolean);

  data.jobs.forEach((job) => {
    (job.keywords || []).forEach(add);
    tokenize(job.description).forEach(add);
    tokenize(job.reflection).forEach(add);
  });
  data.sources.forEach((source) => {
    (source.tags || []).forEach(add);
    tokenize(source.content).forEach(add);
    tokenize(source.insight).forEach(add);
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 24);
}

export function markdownBlocks(text: string) {
  return String(text || "")
    .split("\n")
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return { type: "space" as const, text: "", key: index };
      if (trimmed.startsWith("### ")) return { type: "h4" as const, text: trimmed.slice(4), key: index };
      if (trimmed.startsWith("## ")) return { type: "h3" as const, text: trimmed.slice(3), key: index };
      if (trimmed.startsWith("# ")) return { type: "h3" as const, text: trimmed.slice(2), key: index };
      if (trimmed.startsWith("- ")) return { type: "li" as const, text: trimmed.slice(2), key: index };
      if (/^\d+\.\s/.test(trimmed)) {
        return { type: "li" as const, text: trimmed.replace(/^\d+\.\s/, ""), key: index };
      }
      return { type: "p" as const, text: trimmed, key: index };
    });
}

export function scoreTone(score = 0) {
  if (score >= 80) return "high";
  if (score >= 60) return "mid";
  return "low";
}
