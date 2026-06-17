import type { ReactNode } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import type { AgentMatch, Bucket, JobRecord, NoteRecord, SourceRecord, ToolEvent } from "./types";
import { bucketLabel, cx, formatDate, markdownBlocks, scoreTone } from "./utils";

export function EmptyState({ title, body }: { title?: string; body?: string }) {
  return (
    <div className="empty-state">
      <strong>{title || "还没有内容"}</strong>
      <span>{body || "添加几条记录后，这里会自动变得有料。"}</span>
    </div>
  );
}

export function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="markdown-lite">
      {markdownBlocks(text).map((block) => {
        if (block.type === "space") return <br key={block.key} />;
        if (block.type === "h3") return <h3 key={block.key}>{block.text}</h3>;
        if (block.type === "h4") return <h4 key={block.key}>{block.text}</h4>;
        if (block.type === "li") return <p key={block.key} className="md-bullet">{block.text}</p>;
        return <p key={block.key}>{block.text}</p>;
      })}
    </div>
  );
}

export function MetricCard({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={cx("metric-card", tone)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ToolTimeline({ events }: { events: ToolEvent[] }) {
  if (!events.length) {
    return <EmptyState title="等待执行" body="智能体开始工作后，会在这里显示工具调用过程。" />;
  }
  return (
    <div className="tool-timeline">
      {events.map((event, index) => (
        <article key={event.id || `${event.name}-${index}`} className={cx("tool-event", event.status)}>
          <div className="event-rail" />
          <div className="event-dot" />
          <div>
            <strong>{event.label || event.name || "工具"}</strong>
            <span>{event.detail || "执行完成"}</span>
            <small>{event.status === "running" ? "运行中" : event.status === "failed" ? "失败" : "完成"}</small>
          </div>
        </article>
      ))}
    </div>
  );
}

export function MatchList({ matches }: { matches: AgentMatch[] }) {
  if (!matches.length) {
    return <EmptyState title="暂无命中" body="这轮问题没有直接命中本地记录，回答会更多依赖通用判断。" />;
  }
  return (
    <div className="match-list">
      {matches.map((item, index) => (
        <article key={item.id || `${item.title}-${index}`} className="match-row">
          <div className={cx("match-avatar", scoreTone(item.score))}>{(item.title || "?").slice(0, 1)}</div>
          <div className="match-copy">
            <strong>{item.title}</strong>
            <span>{item.subtitle || bucketLabel(item.bucket)}</span>
            {item.snippet ? <p>{item.snippet}</p> : null}
            {item.hits?.length ? (
              <div className="mini-tags">
                {item.hits.slice(0, 4).map((hit) => (
                  <span key={hit}>{hit}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="match-actions">
            <span>{item.score || 0}%</span>
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer" title="打开来源">
                <ExternalLink size={15} />
              </a>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

export function JobCard({ job, onDelete }: { job: JobRecord; onDelete: (bucket: Bucket, id: string) => void }) {
  return (
    <article className="record-card">
      <div className="card-head">
        <div>
          <strong>{job.company || "未命名公司"}</strong>
          <span>{job.title || "未命名岗位"}</span>
        </div>
        <button type="button" className="ghost-icon danger" onClick={() => onDelete("jobs", job.id)} title="删除">
          <Trash2 size={15} />
        </button>
      </div>
      <p>{job.description || "暂无 JD 要点"}</p>
      <div className="meta-line">
        <span>{job.stage || "关注"}</span>
        <span>匹配 {job.fit || 0}/5</span>
        {job.source ? <span>{job.source}</span> : null}
      </div>
      {job.keywords?.length ? (
        <div className="mini-tags">
          {job.keywords.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function SourceCard({
  source,
  onDelete,
}: {
  source: SourceRecord;
  onDelete: (bucket: Bucket, id: string) => void;
}) {
  return (
    <article className="record-card">
      <div className="card-head">
        <div>
          <strong>{source.title || "未命名摘录"}</strong>
          <span>{source.channel || "摘录"}</span>
        </div>
        <button type="button" className="ghost-icon danger" onClick={() => onDelete("sources", source.id)} title="删除">
          <Trash2 size={15} />
        </button>
      </div>
      <p>{source.content || "暂无内容"}</p>
      {source.insight ? <p className="muted-copy">{source.insight}</p> : null}
      {source.tags?.length ? (
        <div className="mini-tags">
          {source.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function NoteCard({ note, onDelete }: { note: NoteRecord; onDelete: (bucket: Bucket, id: string) => void }) {
  return (
    <article className="record-card">
      <div className="card-head">
        <div>
          <strong>{note.title || "未命名笔记"}</strong>
          <span>{note.date || formatDate(note.createdAt)}</span>
        </div>
        <button type="button" className="ghost-icon danger" onClick={() => onDelete("notes", note.id)} title="删除">
          <Trash2 size={15} />
        </button>
      </div>
      <p>{note.body || "暂无内容"}</p>
    </article>
  );
}
