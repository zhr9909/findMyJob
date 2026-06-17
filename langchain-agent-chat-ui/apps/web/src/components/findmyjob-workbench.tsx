import { type ReactNode, useEffect, useMemo, useState } from "react";
import { RefreshCw, BriefcaseBusiness, BookOpen, NotebookPen } from "lucide-react";
import { fetchWorkspace, type WorkspaceData } from "@/lib/findmyjob-api";
import { Button } from "@/components/ui/button";

const EMPTY: WorkspaceData = { jobs: [], sources: [], notes: [] };

export function FindMyJobWorkbench() {
  const [workspace, setWorkspace] = useState<WorkspaceData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const data = await fetchWorkspace();
      setWorkspace(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const topJobs = useMemo(() => workspace.jobs.slice(0, 5), [workspace.jobs]);
  const topSources = useMemo(() => workspace.sources.slice(0, 5), [workspace.sources]);
  const topNotes = useMemo(() => workspace.notes.slice(0, 5), [workspace.notes]);

  return (
    <aside className="fixed right-4 top-4 bottom-4 w-[360px] rounded-2xl border bg-white shadow-xl overflow-hidden hidden xl:flex flex-col z-20">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-50">
        <div>
          <h2 className="text-sm font-semibold">FindMyJob 工作台</h2>
          <p className="text-xs text-slate-500">岗位 / 摘录 / 笔记</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : ""} size={16} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        {error ? <div className="rounded-md bg-red-50 text-red-700 p-3">{error}</div> : null}

        <Section icon={<BriefcaseBusiness size={16} />} title={`岗位 ${workspace.jobs.length}`}>
          {topJobs.map((job) => (
            <Item key={job.id} title={`${job.company || ""} ${job.title || ""}`} subtitle={`${job.stage || "关注"} · 匹配 ${job.fit || 0}/5`} />
          ))}
        </Section>

        <Section icon={<BookOpen size={16} />} title={`摘录 ${workspace.sources.length}`}>
          {topSources.map((source) => (
            <Item key={source.id} title={source.title || "未命名摘录"} subtitle={source.channel || "摘录"} />
          ))}
        </Section>

        <Section icon={<NotebookPen size={16} />} title={`笔记 ${workspace.notes.length}`}>
          {topNotes.map((note) => (
            <Item key={note.id} title={note.title || "未命名笔记"} subtitle={note.date || ""} />
          ))}
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-slate-700 font-medium">
        {icon}
        <span>{title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Item({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="rounded-lg border p-3 bg-white">
      <div className="font-medium text-slate-900 line-clamp-2">{title}</div>
      {subtitle ? <div className="text-xs text-slate-500 mt-1">{subtitle}</div> : null}
    </div>
  );
}
