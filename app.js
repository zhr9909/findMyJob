const state = {
  jobs: [],
  sources: [],
  notes: [],
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
}

function bindActions() {
  els.searchInput.addEventListener("input", render);
  document.querySelector("#composeNoteBtn").addEventListener("click", composeTodayNote);
  document.querySelector("#refreshBtn").addEventListener("click", reloadWorkspace);
  document.querySelector("#reloadTasksBtn").addEventListener("click", loadTasks);
  document.querySelector("#exportBtn").addEventListener("click", exportData);
  document.querySelector("#importInput").addEventListener("change", importData);
  document.querySelector("#clearBtn").addEventListener("click", async () => {
    if (!confirm("确定清空全部本地数据？这会重写 data/workspace.json。")) return;
    await runAction(() => saveAll({ jobs: [], sources: [], notes: [] }));
  });
}

async function reloadWorkspace() {
  await runAction(async () => {
    await loadData();
    await loadTasks();
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
  const running = (result.tasks || []).find((task) => ["queued", "running"].includes(task.status));
  if (running) startPollingTask(running.id);
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
        <span class="pill ${task.status === "failed" ? "error" : ""}">${statusText(task.status)}</span>
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
  }[status] || status;
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
