# findMyJob

一个本地运行的个人求职工作台，用来记录每天查阅的招聘岗位、网页内容、评论观点和自己的工作思考。

## 使用方式

安装依赖：

```bash
python -m pip install -r requirements.txt
```

启动本地服务：

```bash
python server.py
```

然后打开：

```text
http://127.0.0.1:8000
```

数据会保存在项目本地文件 `data/workspace.json` 中。页面右上角也可以导出或导入 JSON 备份。

服务使用 Flask，安装了 Waitress 时会优先用 Waitress 运行；链接分析会进入后台线程池，不会卡住岗位、摘录、笔记等普通操作。页面顶部有服务状态和重新加载按钮，分析失败后可以在任务列表里重试。

## 大模型总结

链接分析功能会先抓取网页正文，再生成求职视角总结。

默认没有 API Key 时，会生成一个本地规则版摘要。配置环境变量后会调用兼容 OpenAI Chat Completions 的接口：

```bash
$env:OPENAI_API_KEY="你的 API Key"
$env:AI_MODEL="gpt-4o-mini"
python server.py
```

也可以复制 `.env.example` 为 `.env`，再填写 `OPENAI_API_KEY`、`AI_MODEL`、`AI_API_BASE` 和 `PORT`。启动时会自动读取 `.env`。

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
- 链接分析：粘贴网页链接，后端后台抓取正文并生成总结，同时保存为摘录和笔记
- 任务重试：链接分析失败后可以刷新任务状态或重试
- 搜索筛选：按公司、岗位、关键词、渠道、笔记内容搜索
- 文件存储：数据保存到 `data/workspace.json`
- 数据备份：JSON 导入导出
