import { FormEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  BriefcaseBusiness,
  ClipboardList,
  Database,
  Download,
  FileText,
  Inbox,
  Loader2,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Upload,
} from "lucide-react";
import {
  createAnalysisTask,
  createRecord,
  deleteRecord,
  getAnalysisTasks,
  getConversation,
  getConversations,
  getWorkspace,
  health,
  saveWorkspace,
  streamAgent,
} from "./api";
import {
  EmptyState,
  JobCard,
  MarkdownLite,
  MatchList,
  MetricCard,
  NoteCard,
  SourceCard,
  ToolTimeline,
} from "./components";
import type {
  AgentMatch,
  AnalysisTask,
  Bucket,
  Conversation,
  Message,
  NoteRecord,
  ToolEvent,
  WorkspaceData,
} from "./types";
import { buildKeywordCloud, cx, filterRecords, flattenMatches, formatDate, normalizeWorkspace, splitTags, todayInput } from "./utils";

const EMPTY_WORKSPACE: WorkspaceData = { jobs: [], sources: [], notes: [] };

const promptPresets = [
  "帮我从当前工作台里筛选最适合投递的 5 个岗位，并按匹配度排序。",
  "结合岗位和摘录，帮我判断现在最该优先投递哪几类职位。",
  "帮我找出当前记录里最值得警惕的公司风险和面试信号。",
  "基于当前岗位记录，帮我把简历中最该强化的 3 个点整理出来。",
];

export default function App() {
  const [activeView, setActiveView] = useState("agent");
  const [workspace, setWorkspace] = useState<WorkspaceData>(EMPTY_WORKSPACE);
  const [query, setQuery] = useState("");
  const [statusText, setStatusText] = useState("连接中");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [matches, setMatches] = useState<AgentMatch[]>([]);
  const [agentSummary, setAgentSummary] = useState<Record<string, number>>({});
  const [agentMode, setAgentMode] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [tasks, setTasks] = useState<AnalysisTask[]>([]);
  const [notice, setNotice] = useState("");
  const messagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void reloadAll();
    const timer = window.setInterval(() => {
      void refreshHealth();
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const todayLabel = useMemo(
    () =>
      new Date().toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      }),
    [],
  );

  const filteredJobs = useMemo(() => filterRecords(workspace.jobs, query), [workspace.jobs, query]);
  const filteredSources = useMemo(() => filterRecords(workspace.sources, query), [workspace.sources, query]);
  const filteredNotes = useMemo(() => filterRecords(workspace.notes, query), [workspace.notes, query]);
  const keywordCloud = useMemo(() => buildKeywordCloud(workspace), [workspace]);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  async function reloadAll() {
    try {
      const [data, conversationResult, taskResult] = await Promise.all([
        getWorkspace(),
        getConversations(),
        getAnalysisTasks(),
      ]);
      setWorkspace(normalizeWorkspace(data));
      setConversations(conversationResult.conversations || []);
      setTasks(taskResult.tasks || []);
      await refreshHealth();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "加载失败");
      setStatusText("服务异常");
    }
  }

  async function refreshHealth() {
    try {
      const result = await health();
      setStatusText(result.ok ? `在线 · ${result.runningTasks} 个任务` : "异常");
    } catch {
      setStatusText("离线");
    }
  }

  async function refreshWorkspace() {
    const data = await getWorkspace();
    setWorkspace(normalizeWorkspace(data));
  }

  async function refreshConversations() {
    const result = await getConversations();
    setConversations(result.conversations || []);
  }

  async function openConversation(id: string) {
    const detail = await getConversation(id);
    setActiveConversationId(id);
    setMessages(detail.messages || []);
    setEvents(detail.events || []);
    setMatches(detail.matches || []);
    setAgentSummary({});
    setAgentMode("");
    setActiveView("agent");
  }

  function newConversation() {
    setActiveConversationId(null);
    setMessages([]);
    setEvents([]);
    setMatches([]);
    setAgentSummary({});
    setAgentMode("");
    setAgentPrompt("");
  }

  async function submitAgent(event: FormEvent) {
    event.preventDefault();
    const prompt = agentPrompt.trim();
    if (!prompt || agentRunning) return;
    const localUser: Message = {
      id: `local-${Date.now()}`,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    setAgentRunning(true);
    setAgentPrompt("");
    setMessages((current) => [...current, localUser]);
    setEvents([{ label: "提交问题", status: "running", detail: prompt }]);
    setMatches([]);
    setAgentSummary({});
    setAgentMode("");

    try {
      await streamAgent(prompt, activeConversationId, (frame) => {
        if (frame.type === "conversation") {
          setActiveConversationId(frame.conversationId);
        }
        if (frame.type === "tool") {
          setEvents((current) => [...current.filter((item) => item.label !== "提交问题"), frame.event]);
        }
        if (frame.type === "answer") {
          setAgentMode(frame.mode === "llm" ? "大模型增强" : "本地规则");
          setMessages((current) => [
            ...current.filter((item) => item.id !== frame.messageId),
            {
              id: frame.messageId,
              role: "assistant",
              content: frame.answer,
              createdAt: new Date().toISOString(),
            },
          ]);
        }
        if (frame.type === "done") {
          const result = frame.result;
          setActiveConversationId(result.conversationId);
          setMessages(result.messages || []);
          setEvents(result.events || result.tools || []);
          setMatches(result.flatMatches || flattenMatches(result.matches));
          setAgentSummary(result.summary || {});
          setAgentMode(result.mode === "llm" ? "大模型增强" : "本地规则");
        }
        if (frame.type === "error") {
          throw new Error(frame.error);
        }
      });
      await refreshConversations();
    } catch (error) {
      setEvents([{ label: "运行失败", status: "failed", detail: error instanceof Error ? error.message : "未知错误" }]);
      setMessages((current) => [
        ...current,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: error instanceof Error ? error.message : "智能体运行失败",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setAgentRunning(false);
    }
  }

  async function handleDelete(bucket: Bucket, id: string) {
    if (!window.confirm("确定删除这条记录吗？")) return;
    await deleteRecord(bucket, id);
    await refreshWorkspace();
  }

  async function clearWorkspace() {
    if (!window.confirm("确定清空全部岗位、摘录和笔记吗？智能体历史不会被删除。")) return;
    const saved = await saveWorkspace(EMPTY_WORKSPACE);
    setWorkspace(saved);
  }

  async function importJson(file?: File) {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    const saved = await saveWorkspace(normalizeWorkspace(parsed));
    setWorkspace(saved);
  }

  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await createRecord("jobs", {
      company: String(form.get("company") || ""),
      title: String(form.get("title") || ""),
      source: String(form.get("source") || ""),
      url: String(form.get("url") || ""),
      stage: String(form.get("stage") || "关注"),
      fit: Number(form.get("fit") || 3),
      keywords: splitTags(String(form.get("keywords") || "")),
      description: String(form.get("description") || ""),
      reflection: String(form.get("reflection") || ""),
    });
    event.currentTarget.reset();
    await refreshWorkspace();
  }

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await createRecord("sources", {
      channel: String(form.get("channel") || "其他"),
      title: String(form.get("title") || ""),
      url: String(form.get("url") || ""),
      content: String(form.get("content") || ""),
      insight: String(form.get("insight") || ""),
      tags: splitTags(String(form.get("tags") || "")),
    });
    event.currentTarget.reset();
    await refreshWorkspace();
  }

  async function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await createRecord<NoteRecord>("notes", {
      date: String(form.get("date") || todayInput()),
      title: String(form.get("title") || ""),
      body: String(form.get("body") || ""),
    });
    event.currentTarget.reset();
    await refreshWorkspace();
  }

  async function submitAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await createAnalysisTask({
      url: String(form.get("url") || ""),
      channel: String(form.get("channel") || "其他"),
      question: String(form.get("question") || ""),
      tags: splitTags(String(form.get("tags") || "")),
    });
    setTasks((current) => [result.task, ...current]);
    event.currentTarget.reset();
  }

  function composeTodayNote() {
    setActiveView("notes");
    window.setTimeout(() => {
      const title = document.querySelector<HTMLInputElement>("[name='noteTitle']");
      const body = document.querySelector<HTMLTextAreaElement>("[name='noteBody']");
      if (title) title.value = `求职复盘 ${todayInput()}`;
      if (body) {
        body.value = [
          "今天重点观察：",
          `- 高匹配岗位：${workspace.jobs.slice(0, 3).map((job) => `${job.company} ${job.title}`).join("；") || "暂无"}`,
          `- 新增摘录：${workspace.sources.slice(0, 3).map((source) => source.title).join("；") || "暂无"}`,
          "",
          "下一步：",
          "- 调整简历中的一个表达。",
          "- 深挖一个目标公司或岗位方向。",
          "- 为一个高匹配岗位准备投递材料。",
        ].join("\n");
      }
    }, 0);
  }

  const navItems = [
    { id: "agent", label: "智能体", icon: Bot },
    { id: "dashboard", label: "总览", icon: Database },
    { id: "jobs", label: "岗位", icon: BriefcaseBusiness },
    { id: "sources", label: "摘录", icon: BookOpen },
    { id: "notes", label: "笔记", icon: FileText },
    { id: "analysis", label: "链接分析", icon: ClipboardList },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <h1>FindMyJob</h1>
            <p>{todayLabel}</p>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="主要视图">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={cx("nav-tab", activeView === item.id && "active")}
                type="button"
                onClick={() => setActiveView(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="quick-stats">
          <MetricCard label="岗位" value={workspace.jobs.length} />
          <MetricCard label="摘录" value={workspace.sources.length} />
          <MetricCard label="笔记" value={workspace.notes.length} />
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="search-wrap">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索岗位、公司、渠道、关键词、笔记" />
          </div>
          <div className="toolbar">
            <span className="status-pill">{statusText}</span>
            <button className="icon-button" type="button" onClick={() => void reloadAll()} title="重新加载">
              <RefreshCw size={17} />
            </button>
            <a className="icon-button" href="/api/export" title="导出 JSON">
              <Download size={17} />
            </a>
            <label className="icon-button file-button" title="导入 JSON">
              <Upload size={17} />
              <input type="file" accept="application/json" onChange={(event) => void importJson(event.target.files?.[0])} />
            </label>
            <button className="icon-button danger" type="button" onClick={() => void clearWorkspace()} title="清空数据">
              <Inbox size={17} />
            </button>
          </div>
        </header>

        {notice ? <div className="notice">{notice}</div> : null}

        {activeView === "agent" ? (
          <AgentView
            conversations={conversations}
            activeConversationId={activeConversationId}
            activeConversation={activeConversation}
            messages={messages}
            events={events}
            matches={matches}
            summary={agentSummary}
            mode={agentMode}
            prompt={agentPrompt}
            running={agentRunning}
            messagesRef={messagesRef}
            onPromptChange={setAgentPrompt}
            onSubmit={submitAgent}
            onOpenConversation={(id) => void openConversation(id)}
            onNewConversation={newConversation}
          />
        ) : null}

        {activeView === "dashboard" ? (
          <DashboardView
            workspace={workspace}
            keywordCloud={keywordCloud}
            onComposeNote={composeTodayNote}
            onAgentPrompt={(prompt) => {
              setAgentPrompt(prompt);
              setActiveView("agent");
            }}
          />
        ) : null}

        {activeView === "jobs" ? (
          <JobsView jobs={filteredJobs} onSubmit={submitJob} onDelete={handleDelete} />
        ) : null}

        {activeView === "sources" ? (
          <SourcesView sources={filteredSources} onSubmit={submitSource} onDelete={handleDelete} />
        ) : null}

        {activeView === "notes" ? (
          <NotesView notes={filteredNotes} onSubmit={submitNote} onDelete={handleDelete} />
        ) : null}

        {activeView === "analysis" ? (
          <AnalysisView tasks={tasks} onSubmit={submitAnalysis} onReload={async () => setTasks((await getAnalysisTasks()).tasks || [])} />
        ) : null}
      </main>
    </div>
  );
}

type AgentViewProps = {
  conversations: Conversation[];
  activeConversationId: string | null;
  activeConversation?: Conversation;
  messages: Message[];
  events: ToolEvent[];
  matches: AgentMatch[];
  summary: Record<string, number>;
  mode: string;
  prompt: string;
  running: boolean;
  messagesRef: RefObject<HTMLDivElement | null>;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onOpenConversation: (id: string) => void;
  onNewConversation: () => void;
};

function AgentView(props: AgentViewProps) {
  const totalMatches = (props.summary.matchedJobs || 0) + (props.summary.matchedSources || 0) + (props.summary.matchedNotes || 0);
  return (
    <section className="agent-shell">
      <aside className="agent-history-panel">
        <div className="agent-history-head">
          <div>
            <h2>Ask FindMyJob</h2>
            <p>多轮求职研究</p>
          </div>
          <button className="small-button" type="button" onClick={props.onNewConversation}>
            <MessageSquarePlus size={15} />
            新对话
          </button>
        </div>
        <div className="prompt-chips">
          {promptPresets.map((preset) => (
            <button key={preset} className="chip" type="button" onClick={() => props.onPromptChange(preset)}>
              {preset.slice(0, 8)}
            </button>
          ))}
        </div>
        <div className="conversation-list">
          {props.conversations.length ? (
            props.conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={cx("conversation-item", conversation.id === props.activeConversationId && "active")}
                type="button"
                onClick={() => props.onOpenConversation(conversation.id)}
              >
                <strong>{conversation.title}</strong>
                <span>{conversation.lastMessage || "暂无消息"}</span>
              </button>
            ))
          ) : (
            <EmptyState title="暂无历史" body="开始第一轮提问后，会话会自动保存到本地。" />
          )}
        </div>
      </aside>

      <section className="agent-chat-panel">
        <div className="agent-chat-top">
          <div>
            <h3>{props.activeConversation?.title || "新的求职对话"}</h3>
            <p>{props.activeConversation ? `更新于 ${formatDate(props.activeConversation.updatedAt)}` : "本地知识库 + DeepSeek"}</p>
          </div>
          <div className="agent-summary">
            {props.summary.jobs !== undefined ? <span>岗位 {props.summary.jobs}</span> : null}
            {props.summary.sources !== undefined ? <span>摘录 {props.summary.sources}</span> : null}
            {props.summary.notes !== undefined ? <span>笔记 {props.summary.notes}</span> : null}
            {totalMatches ? <span className="amber">命中 {totalMatches}</span> : null}
          </div>
        </div>

        <div className="agent-messages" ref={props.messagesRef}>
          {props.messages.length ? (
            props.messages.map((message) => (
              <article key={message.id} className={cx("chat-message", message.role === "user" ? "user" : "assistant")}>
                <div className="message-meta">{message.role === "user" ? "你" : "FindMyJob Agent"} · {formatDate(message.createdAt)}</div>
                <div className="message-bubble">
                  <MarkdownLite text={message.content} />
                </div>
              </article>
            ))
          ) : (
            <div className="agent-empty">
              <Sparkles size={22} />
              <strong>问我一个求职问题</strong>
              <span>我会检索岗位、摘录和笔记，显示工具调用过程，并把对话保存到本地。</span>
            </div>
          )}
          {props.running ? (
            <div className="agent-running">
              <Loader2 size={16} />
              智能体正在检索和推理
            </div>
          ) : null}
        </div>

        <form className="agent-compose" onSubmit={props.onSubmit}>
          <button className="compose-tool" type="button" title="工具">
            <Plus size={18} />
          </button>
          <textarea
            rows={2}
            value={props.prompt}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask FindMyJob"
          />
          <button className="send-button" type="submit" disabled={props.running || !props.prompt.trim()} title="发送">
            {props.running ? <Loader2 size={17} /> : <Send size={17} />}
          </button>
        </form>
      </section>

      <aside className="agent-inspector">
        <div className="panel-title-row">
          <h3>执行日志</h3>
          <span className="mode-pill">{props.mode}</span>
        </div>
        <ToolTimeline events={props.events} />
        <div className="panel-title-row inspector-section">
          <h3>命中记录</h3>
        </div>
        <MatchList matches={props.matches} />
      </aside>
    </section>
  );
}

function DashboardView({
  workspace,
  keywordCloud,
  onComposeNote,
  onAgentPrompt,
}: {
  workspace: WorkspaceData;
  keywordCloud: [string, number][];
  onComposeNote: () => void;
  onAgentPrompt: (prompt: string) => void;
}) {
  const topJobs = [...workspace.jobs].sort((a, b) => (b.fit || 0) - (a.fit || 0)).slice(0, 5);
  return (
    <section className="view-grid">
      <div className="section-head">
        <div>
          <h2>今日求职脉络</h2>
          <p>把岗位事实、外部声音和自己的判断放在同一张桌面上。</p>
        </div>
        <div className="head-actions">
          <button className="secondary-button" type="button" onClick={() => onAgentPrompt("基于当前工作台，帮我规划今天最值得推进的 3 个求职动作。")}>
            <Bot size={16} />
            问智能体
          </button>
          <button className="primary-button" type="button" onClick={onComposeNote}>
            生成今日笔记
          </button>
        </div>
      </div>
      <div className="dashboard-grid">
        <section className="panel">
          <h3>高匹配岗位</h3>
          {topJobs.length ? (
            <div className="stack-list">
              {topJobs.map((job) => (
                <div className="stack-row" key={job.id}>
                  <strong>{job.company} · {job.title}</strong>
                  <span>{job.stage || "关注"} · 匹配 {job.fit || 0}/5</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="暂无岗位" />
          )}
        </section>
        <section className="panel">
          <h3>最新摘录</h3>
          {workspace.sources.length ? (
            <div className="stack-list">
              {workspace.sources.slice(0, 5).map((source) => (
                <div className="stack-row" key={source.id}>
                  <strong>{source.title}</strong>
                  <span>{source.channel || "摘录"}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="暂无摘录" />
          )}
        </section>
        <section className="panel wide">
          <h3>关键词热度</h3>
          <div className="keyword-cloud">
            {keywordCloud.length ? keywordCloud.map(([word, count]) => <span key={word}>{word} · {count}</span>) : <EmptyState title="暂无关键词" />}
          </div>
        </section>
      </div>
    </section>
  );
}

function JobsView({
  jobs,
  onSubmit,
  onDelete,
}: {
  jobs: WorkspaceData["jobs"];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: (bucket: Bucket, id: string) => void;
}) {
  return (
    <section className="view-grid">
      <div className="section-head">
        <div>
          <h2>岗位记录</h2>
          <p>记录 JD、要求、薪资、匹配度和下一步动作。</p>
        </div>
      </div>
      <form className="entry-form" onSubmit={onSubmit}>
        <div className="form-grid">
          <label>公司<input name="company" required placeholder="例如：某科技公司" /></label>
          <label>岗位<input name="title" required placeholder="例如：前端开发 / 产品经理" /></label>
          <label>来源<input name="source" placeholder="Boss / 猎聘 / 朋友推荐" /></label>
          <label>链接<input name="url" type="url" placeholder="https://..." /></label>
          <label>阶段<select name="stage" defaultValue="关注"><option>关注</option><option>已投递</option><option>沟通中</option><option>面试中</option><option>搁置</option></select></label>
          <label>匹配度<input name="fit" type="range" min="1" max="5" defaultValue="3" /></label>
          <label className="span-2">关键词<input name="keywords" placeholder="React, AI, 数据分析，用逗号分隔" /></label>
          <label className="span-2">岗位要点<textarea name="description" rows={4} placeholder="粘贴 JD 关键段落、职责、要求、薪资范围" /></label>
          <label className="span-2">我的判断<textarea name="reflection" rows={3} placeholder="为什么适合 / 不适合，我要补什么材料" /></label>
        </div>
        <button className="primary-button" type="submit">保存岗位</button>
      </form>
      <div className="card-grid">
        {jobs.length ? jobs.map((job) => <JobCard key={job.id} job={job} onDelete={onDelete} />) : <EmptyState title="暂无岗位" />}
      </div>
    </section>
  );
}

function SourcesView({
  sources,
  onSubmit,
  onDelete,
}: {
  sources: WorkspaceData["sources"];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: (bucket: Bucket, id: string) => void;
}) {
  return (
    <section className="view-grid">
      <div className="section-head">
        <div>
          <h2>网页与评论摘录</h2>
          <p>沉淀小红书、招聘平台、文章和评论区里的有效信息。</p>
        </div>
      </div>
      <form className="entry-form" onSubmit={onSubmit}>
        <div className="form-grid">
          <label>渠道<select name="channel" defaultValue="其他"><option>小红书</option><option>招聘网站</option><option>公众号文章</option><option>社区论坛</option><option>朋友/前同事</option><option>其他</option></select></label>
          <label>标题<input name="title" required placeholder="内容标题或主题" /></label>
          <label className="span-2">链接<input name="url" type="url" placeholder="https://..." /></label>
          <label className="span-2">内容摘录<textarea name="content" required rows={5} placeholder="粘贴正文、搜索结果摘要、评论观点" /></label>
          <label className="span-2">我的观察<textarea name="insight" rows={3} placeholder="这条信息对定位、简历、投递策略有什么启发" /></label>
          <label className="span-2">标签<input name="tags" placeholder="行业, 公司评价, 面试, 薪资，用逗号分隔" /></label>
        </div>
        <button className="primary-button" type="submit">保存摘录</button>
      </form>
      <div className="card-grid">
        {sources.length ? sources.map((source) => <SourceCard key={source.id} source={source} onDelete={onDelete} />) : <EmptyState title="暂无摘录" />}
      </div>
    </section>
  );
}

function NotesView({
  notes,
  onSubmit,
  onDelete,
}: {
  notes: WorkspaceData["notes"];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: (bucket: Bucket, id: string) => void;
}) {
  return (
    <section className="view-grid">
      <div className="section-head">
        <div>
          <h2>工作思考笔记</h2>
          <p>每天形成一份可复盘、可行动的求职判断。</p>
        </div>
      </div>
      <form className="entry-form" onSubmit={onSubmit}>
        <div className="form-grid">
          <label>日期<input name="date" type="date" defaultValue={todayInput()} /></label>
          <label>标题<input name="title" required placeholder="例如：今天的投递优先级" /></label>
          <label className="span-2">内容<textarea name="body" required rows={6} placeholder="记录判断、疑问、下一步动作" /></label>
        </div>
        <button className="primary-button" type="submit">保存笔记</button>
      </form>
      <div className="card-grid">
        {notes.length ? notes.map((note) => <NoteCard key={note.id} note={note} onDelete={onDelete} />) : <EmptyState title="暂无笔记" />}
      </div>
    </section>
  );
}

function AnalysisView({
  tasks,
  onSubmit,
  onReload,
}: {
  tasks: AnalysisTask[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReload: () => Promise<void>;
}) {
  return (
    <section className="view-grid">
      <div className="section-head">
        <div>
          <h2>链接分析</h2>
          <p>粘贴招聘、文章或评论链接，后端会抓取并生成求职视角总结。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void onReload()}>
          <RefreshCw size={16} />
          刷新任务
        </button>
      </div>
      <form className="entry-form" onSubmit={onSubmit}>
        <div className="form-grid">
          <label className="span-2">链接<input name="url" type="url" required placeholder="https://..." /></label>
          <label>渠道<select name="channel" defaultValue="其他"><option>招聘网站</option><option>公众号文章</option><option>小红书</option><option>社区论坛</option><option>其他</option></select></label>
          <label>标签<input name="tags" placeholder="公司, 面试, 薪资" /></label>
          <label className="span-2">我关心的问题<textarea name="question" rows={3} placeholder="例如：这家公司适合初级前端吗？" /></label>
        </div>
        <button className="primary-button" type="submit">抓取并总结</button>
      </form>
      <div className="task-list">
        {tasks.length ? (
          tasks.map((task) => (
            <article className="task-row" key={task.id}>
              <div>
                <strong>{task.payload?.url || task.url || task.id}</strong>
                <span>{task.message}</span>
              </div>
              <span className={cx("task-status", task.status)}>{task.status}</span>
            </article>
          ))
        ) : (
          <EmptyState title="暂无分析任务" />
        )}
      </div>
    </section>
  );
}
