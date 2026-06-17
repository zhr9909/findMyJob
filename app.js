const state = {
  jobs: [],
  sources: [],
  notes: [],
  agentConversations: [],
  activeConversationId: null,
  activeMessages: [],
  activeEvents: [],
  activeMatches: [],
};

let activePollTimer = null;

const els = {
  todayLabel: document.querySelector("#todayLabel"),
  searchInput: document.querySelector("#searchInput"),
  serverStatus: document.querySelector("#serverStatus"),
  statJobs: document.querySelector("#statJobs"),
  statSources: document.querySelector("#statSources"),
  statNotes: document.querySelector("#statNotes"),
  matchedJobs: document.querySelector("#matchedJobs"),
  recentSources: document.querySelector("#recentSources"),
  keywordCloud: document.querySelector("#keywordCloud"),
  jobsList: document.querySelector("#jobsList"),
  sourcesList: document.querySelector("#sourcesList"),
  notesList: document.querySelector("#notesList"),
  noteDate: document.querySelector("#noteDate"),
  noteTitle: document.querySelector("#noteTitle"),
  noteBody: document.querySelector("#noteBody"),
  analysisResult: document.querySelector("#analysisResult"),
  analysisSubmitBtn: document.querySelector("#analysisSubmitBtn"),
  analysisTasks: document.querySelector("#analysisTasks"),
  agentPrompt: document.querySelector("#agentPrompt"),
  agentSubmitBtn: document.querySelector("#agentSubmitBtn"),
  agentMessages: document.querySelector("#agentMessages"),
  agentConversationList: document.querySelector("#agentConversationList"),
  agentConversationTitle: document.querySelector("#agentConversationTitle"),
  agentConversationMeta: document.querySelector("#agentConversationMeta"),
  agentTrace: document.querySelector("#agentTrace"),
  agentMatches: document.querySelector("#agentMatches"),
  agentSummary: document.querySelector("#agentSummary"),
  agentMode: document.querySelector("#agentMode"),
  reviewPanel: document.querySelector("#reviewPanel"),
  reviewTitle: document.querySelector("#reviewTitle"),
  reviewUrl: document.querySelector("#reviewUrl"),
  reviewContent: document.querySelector("#reviewContent"),
  reviewQuestion: document.querySelector("#reviewQuestion"),
  reviewBtn: document.querySelector("#reviewBtn"),
  reviewMode: document.querySelector("#reviewMode"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const today = new Date();
  els.todayLabel.textContent = today.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  els.noteDate.value = toDateInput(today);

  bindTabs();
  bindForms();
  bindActions();
  await reloadWorkspace();
  checkHealth();
  setInterval(checkHealth, 10000);
}

function bindTabs() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });
}

function bindForms() {
  document.querySelector("#jobForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      await createItem("jobs", {
        company: value("#jobCompany"),
        title: value("#jobTitle"),
        source: value("#jobSource"),
        url: value("#jobUrl"),
        stage: value("#jobStage"),
        fit: Number(value("#jobFit")),
        keywords: splitTags(value("#jobKeywords")),
        description: value("#jobDescription"),
        reflection: value("#jobReflection"),
      });
      event.target.reset();
      document.querySelector("#jobFit").value = 3;
    });
  });

  document.querySelector("#sourceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      await createItem("sources", {
        channel: value("#sourceChannel"),
        title: value("#sourceTitle"),
        url: value("#sourceUrl"),
        content: value("#sourceContent"),
        insight: value("#sourceInsight"),
        tags: splitTags(value("#sourceTags")),
      });
      event.target.reset();
    });
  });

  document.querySelector("#noteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      await createItem("notes", {
        date: value("#noteDate"),
        title: value("#noteTitle"),
        body: value("#noteBody"),
      });
      event.target.reset();
      els.noteDate.value = toDateInput(new Date());
    });
  });

  document.querySelector("#analysisForm").addEventListener("submit", analyzeUrl);
  document.querySelector("#agentForm").addEventListener("submit", runAgent);
}

function bindActions() {
  els.searchInput.addEventListener("input", render);
  document.querySelector("#composeNoteBtn").addEventListener("click", composeTodayNote);
  document.querySelector("#refreshBtn").addEventListener("click", reloadWorkspace);
  document.querySelector("#reloadTasksBtn").addEventListener("click", loadTasks);
  document.querySelector("#newAgentChatBtn").addEventListener("click", newAgentChat);
  document.querySelector("#exportBtn").addEventListener("click", exportData);
  document.querySelector("#importInput").addEventListener("change", importData);
  document.querySelectorAll("[data-agent-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      els.agentPrompt.value = button.dataset.agentPreset;
      els.agentPrompt.focus();
    });
  });
  els.agentPrompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.querySelector("#agentForm").requestSubmit();
    }
  });
  document.querySelector("#clearBtn").addEventListener("click", async () => {
    if (!confirm("确定清空全部本地数据？这会重写 data/workspace.json。")) return;
    await runAction(() => saveAll({ jobs: [], sources: [], notes: [] }));
  });
}

async function reloadWorkspace() {
  await runAction(async () => {
    await loadData();
    await loadTasks();
    await loadAgentConversations();
  });
}

async function loadData() {
  const data = await api("/api/data", {}, 8000);
  replaceState(data);
  render();
}

async function loadTasks() {
  const result = await api("/api/analysis-tasks", {}, 8000);
  renderTasks(result.tasks || []);
  const active = (result.tasks || []).find((task) => ["queued", "running", "waiting_review"].includes(task.status));
  if (active) startPollingTask(active.id);
}

async function createItem(bucket, item) {
  const created = await api(`/api/${bucket}`, {
    method: "POST",
    body: JSON.stringify(item),
  });
  state[bucket].unshift(created);
  render();
}

async function saveAll(nextState) {
  const saved = await api("/api/data", {
    method: "PUT",
    body: JSON.stringify(nextState),
  });
  replaceState(saved);
  render();
}

async function deleteItem(bucket, id) {
  await api(`/api/${bucket}/${id}`, { method: "DELETE" });
  state[bucket] = state[bucket].filter((item) => item.id !== id);
  render();
}

async function analyzeUrl(event) {
  event.preventDefault();
  els.analysisSubmitBtn.disabled = true;
  els.analysisSubmitBtn.textContent = "已提交";
  els.analysisResult.textContent = "任务已提交到后台。你可以继续记录岗位或刷新页面，完成后会自动保存为摘录和笔记。";

  try {
    const result = await api("/api/analysis-tasks", {
      method: "POST",
      body: JSON.stringify({
        url: value("#analysisUrl"),
        channel: value("#analysisChannel"),
        question: value("#analysisQuestion"),
        tags: splitTags(value("#analysisTags")),
      }),
    });
    event.target.reset();
    await loadTasks();
    startPollingTask(result.task.id);
  } catch (error) {
    els.analysisResult.textContent = error.message;
  } finally {
    els.analysisSubmitBtn.disabled = false;
    els.analysisSubmitBtn.textContent = "抓取并生成总结";
  }
}

function startPollingTask(taskId) {
  if (activePollTimer) clearInterval(activePollTimer);
  activePollTimer = setInterval(async () => {
    try {
      const result = await api(`/api/analysis-tasks/${taskId}`, {}, 8000);
      renderTasks([result.task]);
      if (result.task.status === "waiting_review") {
        clearInterval(activePollTimer);
        activePollTimer = null;
        showReviewPanel(result.task);
      }
      if (result.task.status === "done") {
        clearInterval(activePollTimer);
        activePollTimer = null;
        els.analysisResult.textContent = result.task.report || "分析完成。";
        if (result.data) {
          replaceState(result.data);
          render();
        } else {
          await loadData();
        }
      }
      if (result.task.status === "failed") {
        clearInterval(activePollTimer);
        activePollTimer = null;
        els.analysisResult.textContent = result.task.error || result.task.message;
      }
    } catch (error) {
      clearInterval(activePollTimer);
      activePollTimer = null;
      els.analysisResult.textContent = `${error.message}。你可以点击“刷新任务”或重新提交链接。`;
    }
  }, 1600);
}

async function retryTask(taskId) {
  await runAction(async () => {
    const result = await api(`/api/analysis-tasks/${taskId}/retry`, { method: "POST" });
    await loadTasks();
    startPollingTask(result.task.id);
  });
}

async function loadAgentConversations() {
  const result = await api("/api/agent/conversations", {}, 8000);
  state.agentConversations = result.conversations || [];
  renderAgentConversations();
}

async function openAgentConversation(conversationId) {
  const result = await api(`/api/agent/conversations/${conversationId}`, {}, 10000);
  state.activeConversationId = result.conversation.id;
  state.activeMessages = result.messages || [];
  state.activeEvents = result.events || [];
  state.activeMatches = result.matches || [];
  renderAgentWorkspace(result);
}

function newAgentChat() {
  state.activeConversationId = null;
  state.activeMessages = [];
  state.activeEvents = [];
  state.activeMatches = [];
  els.agentConversationTitle.textContent = "新的求职对话";
  els.agentConversationMeta.textContent = "本地知识库 + DeepSeek";
  els.agentSummary.innerHTML = "";
  els.agentMode.textContent = "";
  renderAgentMessages();
  renderAgentTrace([]);
  renderAgentMatches([]);
  renderAgentConversations();
  els.agentPrompt.focus();
}

async function runAgent(event) {
  event.preventDefault();
  const prompt = els.agentPrompt.value.trim();
  if (!prompt) {
    alert("先写一个问题，我再开工。");
    return;
  }
  els.agentSubmitBtn.disabled = true;
  els.agentSubmitBtn.textContent = "…";
  state.activeMessages.push({ id: `local-${Date.now()}`, role: "user", content: prompt, createdAt: new Date().toISOString() });
  state.activeEvents = [{ label: "提交问题", status: "running", detail: prompt }];
  renderAgentMessages();
  renderAgentTrace(state.activeEvents);
  renderAgentMatches([]);
  els.agentSummary.innerHTML = "";
  els.agentMode.textContent = "";
  els.agentPrompt.value = "";
  try {
    const result = await api("/api/agent", {
      method: "POST",
      body: JSON.stringify({ prompt, conversationId: state.activeConversationId }),
    }, 60000);
    renderAgentResult(result);
    await loadAgentConversations();
  } catch (error) {
    state.activeMessages.push({ id: `error-${Date.now()}`, role: "assistant", content: error.message, createdAt: new Date().toISOString() });
    state.activeEvents = [{ label: "运行失败", status: "failed", detail: error.message }];
    renderAgentMessages();
    renderAgentTrace(state.activeEvents);
  } finally {
    els.agentSubmitBtn.disabled = false;
    els.agentSubmitBtn.textContent = "↑";
  }
}

function renderAgentResult(result) {
  state.activeConversationId = result.conversationId || state.activeConversationId;
  state.activeMessages = result.messages || state.activeMessages;
  state.activeEvents = result.events || result.tools || [];
  state.activeMatches = result.flatMatches || flattenAgentMatches(result.matches || {});
  els.agentMode.textContent = result.mode === "llm" ? "大模型增强" : "本地规则";
  renderAgentMessages();
  renderAgentTrace(state.activeEvents.length ? state.activeEvents : result.tools || []);
  renderAgentMatches(state.activeMatches.length ? state.activeMatches : result.matches || {});
  const summary = result.summary || {};
  els.agentSummary.innerHTML = `
    <span class="pill">岗位 ${summary.jobs || 0}</span>
    <span class="pill">摘录 ${summary.sources || 0}</span>
    <span class="pill">笔记 ${summary.notes || 0}</span>
    <span class="pill amber">命中 ${(summary.matchedJobs || 0) + (summary.matchedSources || 0) + (summary.matchedNotes || 0)}</span>
  `;
  if (result.conversation) {
    els.agentConversationTitle.textContent = result.conversation.title;
    els.agentConversationMeta.textContent = `更新于 ${formatDate(result.conversation.updatedAt)}`;
  }
}

function renderAgentTrace(tools) {
  renderInto(els.agentTrace, tools, (tool) => `
    <article class="agent-trace-item">
      <div class="trace-line"></div>
      <div>
        <strong>${escapeHtml(tool.label || tool.name || "工具")}</strong>
        <span>${escapeHtml(tool.detail || "")}</span>
        <small>${escapeHtml(agentStatusText(tool.status))}</small>
      </div>
    </article>
  `);
}

function renderAgentMatches(matches) {
  const cards = Array.isArray(matches) ? matches : flattenAgentMatches(matches);
  renderInto(els.agentMatches, cards, (item) => `
    <article class="agent-result-row">
      <div class="avatar-badge">${escapeHtml((item.title || "?").slice(0, 1))}</div>
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.subtitle || item.bucket || "")}</span>
        <p>${escapeHtml(item.snippet || "")}</p>
      </div>
      <div class="result-actions">
        <span class="match-mini">${escapeHtml(item.score || 0)}%</span>
        ${item.url ? `<a class="small-button" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">打开</a>` : ""}
      </div>
    </article>
  `);
}

function renderAgentWorkspace(result) {
  els.agentConversationTitle.textContent = result.conversation.title;
  els.agentConversationMeta.textContent = `更新于 ${formatDate(result.conversation.updatedAt)}`;
  renderAgentMessages();
  renderAgentTrace(state.activeEvents);
  renderAgentMatches(state.activeMatches);
  renderAgentConversations();
  els.agentMode.textContent = "";
  els.agentSummary.innerHTML = "";
}

function renderAgentMessages() {
  if (!state.activeMessages.length) {
    els.agentMessages.innerHTML = `
      <div class="agent-empty">
        <strong>问我一个求职问题</strong>
        <span>我会检索你的岗位、摘录和笔记，显示工具调用过程，并把对话保存到本地。</span>
      </div>
    `;
    return;
  }
  els.agentMessages.innerHTML = state.activeMessages.map((message) => `
    <article class="chat-message ${message.role === "user" ? "user" : "assistant"}">
      <div class="message-meta">${message.role === "user" ? "你" : "FindMyJob Agent"} · ${formatDate(message.createdAt)}</div>
      <div class="message-bubble">${formatMarkdownLite(message.content)}</div>
    </article>
  `).join("");
  els.agentMessages.scrollTop = els.agentMessages.scrollHeight;
}

function renderAgentConversations() {
  renderInto(els.agentConversationList, state.agentConversations, (conversation) => `
    <button class="conversation-item ${conversation.id === state.activeConversationId ? "active" : ""}" data-conversation-id="${escapeAttr(conversation.id)}" type="button">
      <strong>${escapeHtml(conversation.title)}</strong>
      <span>${escapeHtml(conversation.lastMessage || "暂无消息")}</span>
    </button>
  `);
}

function flattenAgentMatches(matches) {
  if (Array.isArray(matches)) return matches;
  const labels = { jobs: "岗位", sources: "摘录", notes: "笔记" };
  return Object.entries(matches || {}).flatMap(([key, items]) =>
    (items || []).map((item) => ({ ...item, groupLabel: labels[key] || key }))
  );
}

let currentReviewTaskId = null;

async function showReviewPanel(task) {
  currentReviewTaskId = task.id;
  els.reviewPanel.style.display = "block";
  els.reviewContent.value = "";
  els.reviewQuestion.value = "";
  els.reviewBtn.disabled = false;
  els.reviewBtn.textContent = "\u786e\u8ba4\u7ee7\u7eed";
  els.reviewUrl.textContent = task.url || "";
  try {
    const r = await api("/api/analysis-tasks/" + task.id + "/state", {}, 5000);
    const s = r.state || {};
    els.reviewTitle.textContent = s.title || task.url || "";
    els.reviewContent.value = s.content || "";
    els.reviewQuestion.value = s.question || "";
    if (s.content_status === "insufficient" || !s.content || s.content.length < 80) {
      els.reviewMode.textContent = "\u26a0\ufe0f \u672a\u80fd\u81ea\u52a8\u6293\u53d6\u5230\u6b63\u6587\uff0c\u8bf7\u624b\u52a8\u7c98\u8d34\u5185\u5bb9\u540e\u7ee7\u7eed";
      els.reviewContent.placeholder = "\u8bf7\u7c98\u8d34\u6293\u53d6\u5931\u8d25\u7684\u9875\u9762\u6b63\u6587...";
    } else {
      els.reviewMode.textContent = "\ud83d\udcc4 \u5df2\u6293\u53d6\u5230\u6b63\u6587\uff0c\u8bf7\u5ba1\u6838\u540e\u7ee7\u7eed";
      els.reviewContent.placeholder = "\u7f16\u8f91\u6216\u786e\u8ba4\u6293\u53d6\u7684\u5185\u5bb9...";
    }
  } catch {
    els.reviewMode.textContent = "\u26a0\ufe0f \u65e0\u6cd5\u83b7\u53d6\u72b6\u6001\uff0c\u8bf7\u624b\u52a8\u7c98\u8d34\u5185\u5bb9";
    els.reviewTitle.textContent = task.url || "";
    els.reviewContent.placeholder = "\u8bf7\u7c98\u8d34\u5185\u5bb9...";
  }
  switchView("analysis");
}

async function resumeCurrentReview() {
  if (!currentReviewTaskId) return;
  const data = {
    content: els.reviewContent.value.trim(),
    question: els.reviewQuestion.value.trim(),
    title: els.reviewTitle.textContent,
  };
  els.reviewBtn.disabled = true;
  els.reviewBtn.textContent = "\u63d0\u4ea4\u4e2d...";
  try {
    await api("/api/analysis-tasks/" + currentReviewTaskId + "/resume", {
      method: "POST",
      body: JSON.stringify({data: data}),
    });
    els.reviewPanel.style.display = "none";
    await loadTasks();
    startPollingTask(currentReviewTaskId);
  } catch (error) {
    els.reviewBtn.disabled = false;
    els.reviewBtn.textContent = "\u786e\u8ba4\u7ee7\u7eed";
    alert(error.message);
  }
}

async function checkHealth() {
  try {
    const health = await api("/api/health", {}, 3000);
    els.serverStatus.textContent = `在线 · ${health.runningTasks} 个任务`;
    els.serverStatus.className = "status-pill online";
  } catch {
    els.serverStatus.textContent = "服务离线，点刷新重试";
    els.serverStatus.className = "status-pill offline";
  }
}

function render() {
  const query = els.searchInput.value.trim().toLowerCase();
  const jobs = filterItems(state.jobs, query);
  const sources = filterItems(state.sources, query);
  const notes = filterItems(state.notes, query);

  els.statJobs.textContent = state.jobs.length;
  els.statSources.textContent = state.sources.length;
  els.statNotes.textContent = state.notes.length;

  renderDashboard(query);
  renderJobs(jobs);
  renderSources(sources);
  renderNotes(notes);
}

function renderDashboard(query) {
  const jobs = filterItems(state.jobs, query)
    .slice()
    .sort((a, b) => b.fit - a.fit || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
  const sources = filterItems(state.sources, query).slice(0, 5);
  const keywords = buildKeywordCloud();

  renderInto(els.matchedJobs, jobs, (job) => `
    <article class="stack-item">
      <strong>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</strong>
      <span>${escapeHtml(job.stage)} · 匹配度 ${"★".repeat(job.fit)}${"☆".repeat(5 - job.fit)}</span>
    </article>
  `);

  renderInto(els.recentSources, sources, (source) => `
    <article class="stack-item">
      <strong>${escapeHtml(source.title)}</strong>
      <span>${escapeHtml(source.channel)} · ${formatDate(source.createdAt)}</span>
    </article>
  `);

  els.keywordCloud.innerHTML = keywords.length
    ? keywords.map(([word, count]) => `<span class="pill">${escapeHtml(word)} · ${count}</span>`).join("")
    : emptyHtml();
}

function renderJobs(jobs) {
  renderInto(els.jobsList, jobs, (job) => `
    <article class="item-card">
      <h3>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</h3>
      <div class="meta-row">
        <span class="pill">${escapeHtml(job.stage)}</span>
        <span class="pill amber">匹配度 ${job.fit}/5</span>
        ${job.source ? `<span class="pill">${escapeHtml(job.source)}</span>` : ""}
      </div>
      ${renderTags(job.keywords)}
      ${job.description ? `<p class="card-text">${escapeHtml(job.description)}</p>` : ""}
      ${job.reflection ? `<p class="card-text"><strong>判断：</strong>${escapeHtml(job.reflection)}</p>` : ""}
      <div class="card-actions">
        ${job.url ? `<a class="small-button" href="${escapeAttr(job.url)}" target="_blank" rel="noreferrer">打开</a>` : ""}
        <button class="small-button" data-delete="jobs" data-id="${job.id}" type="button">删除</button>
      </div>
    </article>
  `);
}

function renderSources(sources) {
  renderInto(els.sourcesList, sources, (source) => `
    <article class="item-card">
      <h3>${escapeHtml(source.title)}</h3>
      <div class="meta-row">
        <span class="pill">${escapeHtml(source.channel)}</span>
        <span class="pill">${formatDate(source.createdAt)}</span>
      </div>
      ${renderTags(source.tags)}
      <p class="card-text">${escapeHtml(source.content)}</p>
      ${source.insight ? `<p class="card-text"><strong>观察：</strong>${escapeHtml(source.insight)}</p>` : ""}
      <div class="card-actions">
        ${source.url ? `<a class="small-button" href="${escapeAttr(source.url)}" target="_blank" rel="noreferrer">打开</a>` : ""}
        <button class="small-button" data-delete="sources" data-id="${source.id}" type="button">删除</button>
      </div>
    </article>
  `);
}

function renderNotes(notes) {
  renderInto(els.notesList, notes, (note) => `
    <article class="note-card">
      <div class="note-date">${escapeHtml(note.date)}</div>
      <h3>${escapeHtml(note.title)}</h3>
      <div class="note-body">${escapeHtml(note.body)}</div>
      <div class="card-actions">
        <button class="small-button" data-delete="notes" data-id="${note.id}" type="button">删除</button>
      </div>
    </article>
  `);
}

function renderTasks(tasks) {
  renderInto(els.analysisTasks, tasks, (task) => `
    <article class="task-item">
      <div>
        <strong>${escapeHtml(task.channel)} · ${escapeHtml(task.statusText || statusText(task.status))}</strong>
        <span>${escapeHtml(task.message || task.error || task.url)}</span>
      </div>
      <div class="task-actions">
        <span class="pill ${task.status === "failed" ? "error" : ""} ${task.status === "waiting_review" ? "amber" : ""}">${statusText(task.status)}</span>
        ${task.status === "failed" ? `<button class="small-button" data-retry="${task.id}" type="button">重试</button>` : ""}
      </div>
    </article>
  `);
}

document.body.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    runAction(() => deleteItem(deleteButton.dataset.delete, deleteButton.dataset.id));
    return;
  }
  const retryButton = event.target.closest("[data-retry]");
  if (retryButton) retryTask(retryButton.dataset.retry);
  const reviewButton = event.target.closest("[data-review]");
  if (reviewButton) showReviewPanel({id: reviewButton.dataset.review});
  if (event.target.id === "reviewBtn") resumeCurrentReview();
  const conversationButton = event.target.closest("[data-conversation-id]");
  if (conversationButton) openAgentConversation(conversationButton.dataset.conversationId);
});

function composeTodayNote() {
  const today = toDateInput(new Date());
  const todaysJobs = state.jobs.filter((item) => item.createdAt.startsWith(today));
  const todaysSources = state.sources.filter((item) => item.createdAt.startsWith(today));
  const pickedJobs = todaysJobs.length ? todaysJobs : state.jobs.slice(0, 3);
  const pickedSources = todaysSources.length ? todaysSources : state.sources.slice(0, 3);
  const keywords = buildKeywordCloud()
    .slice(0, 8)
    .map(([word]) => word)
    .join("、");

  els.noteDate.value = today;
  els.noteTitle.value = `${today} 求职判断`;
  els.noteBody.value = [
    "今天看到的岗位：",
    pickedJobs.length
      ? pickedJobs.map((job) => `- ${job.company} / ${job.title}：${job.stage}，匹配度 ${job.fit}/5。${job.reflection || job.description || ""}`).join("\n")
      : "- 暂无岗位记录。",
    "",
    "外部信息与评论信号：",
    pickedSources.length
      ? pickedSources.map((source) => `- ${source.channel} / ${source.title}：${source.insight || source.content}`).join("\n")
      : "- 暂无摘录记录。",
    "",
    "反复出现的关键词：",
    keywords || "暂无关键词。",
    "",
    "我的判断：",
    "- 哪类岗位更接近我现在的能力与兴趣？",
    "- 哪些要求需要通过简历、作品或面试故事来证明？",
    "- 哪些信息只是噪音，哪些信息值得继续验证？",
    "",
    "下一步动作：",
    "- 调整简历中的一个表达。",
    "- 深挖一个目标公司或岗位方向。",
    "- 为一个高匹配岗位准备投递材料。",
  ].join("\n");

  switchView("notes");
}

function switchView(name) {
  document.querySelectorAll(".nav-tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelector(`#${name}View`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function replaceState(data) {
  state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  state.sources = Array.isArray(data.sources) ? data.sources : [];
  state.notes = Array.isArray(data.notes) ? data.notes : [];
}

async function api(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...options,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.error || `请求失败：${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请刷新或稍后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runAction(action) {
  try {
    await action();
    await checkHealth();
  } catch (error) {
    await checkHealth();
    alert(error.message);
  }
}

function statusText(status) {
  return {
    queued: "排队中",
    running: "运行中",
    done: "完成",
    failed: "失败",
    waiting_review: "待审核",
  }[status] || status;
}

function agentStatusText(status) {
  return {
    done: "完成",
    running: "运行中",
    failed: "失败",
  }[status] || "完成";
}

function buildKeywordCloud() {
  const counts = new Map();
  const add = (word) => {
    const cleaned = word.trim();
    if (!cleaned) return;
    counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
  };

  state.jobs.forEach((job) => {
    (job.keywords || []).forEach(add);
    tokenize(job.description).forEach(add);
    tokenize(job.reflection).forEach(add);
  });
  state.sources.forEach((source) => {
    (source.tags || []).forEach(add);
    tokenize(source.content).forEach(add);
    tokenize(source.insight).forEach(add);
  });

  return [...counts.entries()]
    .filter(([word]) => word.length >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, 24);
}

function tokenize(text) {
  return String(text || "")
    .split(/[\s,，.。;；:：/、|()（）[\]【】"'“”]+/)
    .filter((word) => word.length >= 2 && word.length <= 18);
}

function filterItems(items, query) {
  if (!query) return items;
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(query));
}

function renderInto(container, items, template) {
  container.innerHTML = items.length ? items.map(template).join("") : emptyHtml();
}

function emptyHtml() {
  return document.querySelector("#emptyTemplate").innerHTML;
}

function renderTags(tags) {
  if (!tags || !tags.length) return "";
  return `<div class="meta-row">${tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function formatMarkdownLite(text) {
  const lines = escapeHtml(text).split("\n");
  return lines
    .map((line) => {
      if (line.startsWith("## ")) return `<h3>${line.slice(3)}</h3>`;
      if (line.startsWith("# ")) return `<h3>${line.slice(2)}</h3>`;
      if (line.startsWith("- ")) return `<p class="md-bullet">• ${line.slice(2)}</p>`;
      if (!line.trim()) return "<br />";
      return `<p>${line}</p>`;
    })
    .join("");
}

function value(selector) {
  return document.querySelector(selector).value.trim();
}

function splitTags(text) {
  return text
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function exportData() {
  window.location.href = "/api/export";
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      await saveAll({
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        sources: Array.isArray(data.sources) ? data.sources : [],
        notes: Array.isArray(data.notes) ? data.notes : [],
      });
    } catch {
      alert("导入失败，请选择有效的 JSON 文件。");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function toDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function formatDate(valueText) {
  return new Date(valueText).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll("`", "&#096;");
}
