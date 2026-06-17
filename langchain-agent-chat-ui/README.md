# FindMyJob LangChain Agent Chat UI

这是基于 LangChain 官方 `create-agent-chat-app` 生成的 Agent Chat UI 版本。

## 启动全部服务

推荐用 CMD：

```cmd
cd /d E:\AgentProjects\findMyJob\langchain-agent-chat-ui
set PATH=E:\nodeJs;%PATH%
npm run dev:all
```

如果用 PowerShell，直接调用 `npm.cmd`，避免触发 `npm.ps1` 执行策略限制：

```powershell
cd E:\AgentProjects\findMyJob\langchain-agent-chat-ui
$env:Path="E:\nodeJs;" + $env:Path
& "E:\nodeJs\npm.cmd" run dev:all
```

默认会启动：

- Web UI: `http://localhost:5173`
- LangGraph Agent Server: `http://localhost:2024`
- Flask Workbench API: `http://127.0.0.1:8000`

## 当前接入

- Graph ID: `agent`
- Agent: `apps/agents/src/react-agent`
- 数据服务: Flask `GET http://127.0.0.1:8000/api/data`
- 离线兜底: `E:\AgentProjects\findMyJob\data\workspace.json`
- 模型配置来自 `.env`：`OPENAI_API_KEY`、`AI_MODEL`、`AI_API_BASE`

这个 agent 已经替换成 FindMyJob 求职智能体，会通过工具向 Flask 工作台 API 读取本地岗位、摘录和笔记。Web UI 右侧也会显示工作台摘要。
