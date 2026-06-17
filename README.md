# findMyJob

一个本地运行的个人求职工作台，用来记录每天查阅的招聘岗位、网页内容、评论观点和自己的工作思考。

## 使用方式

如果你要用 LangChain 官方 Agent Chat UI 版本，进入：

```cmd
cd /d E:\AgentProjects\findMyJob\langchain-agent-chat-ui
set PATH=E:\nodeJs;%PATH%
npm run dev:all
```

然后打开 `http://localhost:5173`。这个版本会同时启动 Flask 数据 API、官方 Agent Chat UI 和本地 LangGraph agent server。
如果用 PowerShell，建议执行 `& "E:\nodeJs\npm.cmd" run dev:all`，避免 `npm.ps1` 执行策略限制。

安装依赖：

```bash
python -m pip install -r requirements.txt
```

安装前端依赖：

```bash
cd frontend
npm install
```

如果你的 Node.js 像本机一样安装在 `E:\nodeJs` 但当前终端没有识别 `node`，先临时补一次 PATH：

```powershell
$env:Path="E:\nodeJs;" + $env:Path
```

构建新版 React 工作台：

```bash
npm run build
```

回到项目根目录，启动本地服务：

```bash
python server.py
```

然后打开：

```text
http://127.0.0.1:8000
```

Flask 会优先加载 `dist/` 里的新版 React 工作台。如果还没有构建前端，会自动回退到根目录里的旧版静态页面。

岗位、摘录和笔记会保存在项目本地文件 `data/workspace.json` 中。智能体多轮对话、工具日志和命中记录会保存在 `data/findmyjob.db` 中。页面右上角也可以导出或导入 JSON 备份。

服务使用 Flask，安装了 Waitress 时会优先用 Waitress 运行；链接分析会进入后台线程池，不会卡住岗位、摘录、笔记等普通操作。页面顶部有服务状态和重新加载按钮，分析失败后可以在任务列表里重试。

链接分析内部使用 LangGraph 编排，当前图节点是：

```text
normalize_input -> fetch_page -> classify_source -> analyze -> build_records
```

Flask 负责任务队列、接口和文件保存；LangGraph 负责链接研究流程。后续可以继续在图里加入人工确认、断点恢复、偏好记忆和多渠道抓取节点。

## 大模型总结

链接分析功能会先抓取网页正文，再生成求职视角总结。

默认没有 API Key 时，会生成一个本地规则版摘要。配置环境变量后会调用兼容 OpenAI Chat Completions 的接口：

```bash
$env:OPENAI_API_KEY="你的 API Key"
$env:AI_MODEL="gpt-4o-mini"
python server.py
```

也可以复制 `.env.example` 为 `.env`，再填写 `OPENAI_API_KEY`、`AI_MODEL`、`AI_API_BASE` 和 `PORT`。启动时会自动读取 `.env`。
如果本机需要代理访问 OpenAI，可以设置 `AI_PROXY=http://127.0.0.1:7890`。如果使用第三方 OpenAI 兼容服务，`AI_API_BASE` 需要填写该服务商的 `/v1/chat/completions` 地址，不能继续使用官方地址。

后台任务相关配置：

```bash
ANALYSIS_WORKERS=4
FETCH_TIMEOUT=15
MODEL_TIMEOUT=45
USE_WAITRESS=1
```

## 当前功能

- 记录岗位：公司、岗位、来源、链接、阶段、匹配度、关键词、JD 要点和个人判断
- 记录摘录：小红书、招聘网站、文章、论坛、朋友反馈等渠道内容
- 生成笔记：把当天或最近的岗位与摘录整理成求职思考笔记草稿
- 智能体问答：基于当前工作台里的岗位、摘录和笔记，做岗位匹配、风险判断、简历强化和行动建议
- 多轮对话：智能体会把对话历史、工具调用日志和命中记录保存到本地 SQLite
- Agent 事件流：`/api/agent/stream` 会按 SSE 输出会话创建、工具日志、回答和最终结果
- React 工作台：新版前端在 `frontend/`，构建后由 Flask 直接服务，体验接近 DINQ/assistant-ui 风格
- 链接分析：粘贴网页链接，后端后台抓取正文并生成总结，同时保存为摘录和笔记
- 任务重试：链接分析失败后可以刷新任务状态或重试
- 搜索筛选：按公司、岗位、关键词、渠道、笔记内容搜索
- 文件存储：数据保存到 `data/workspace.json`
- 数据备份：JSON 导入导出

## 智能体

页面新增了一个“智能体”入口，默认会先在本地工作台里检索：

- `jobs` 岗位记录
- `sources` 摘录资料
- `notes` 复盘笔记

然后再基于这些结果生成回答。若配置了 `OPENAI_API_KEY`，它会把本地检索上下文发给大模型；如果本地没有对应内容，也会让模型直接给出通用求职建议，而不是停在“请先补充数据”。
智能体界面包含会话历史、聊天流、执行日志和命中记录，风格接近一个本地版求职研究 Agent。

新版前端依赖 React/Vite，并已预留 assistant-ui 相关依赖。当前 UI 先通过自定义 SSE adapter 接 Flask 的 `/api/agent/stream`；后续如果要完全切到 assistant-ui runtime，可以把现有的消息、工具事件和命中结果映射到 assistant-ui 的 Thread/Message/Tool UI。
