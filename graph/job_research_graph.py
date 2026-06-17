import json
import os
import re
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Dict, List, Literal, Optional, TypedDict

import requests
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt


class ResearchState(TypedDict, total=False):
    url: str
    channel: str
    question: str
    tags: List[str]
    title: str
    content: str
    content_status: Literal["pending", "ready", "insufficient", "manual", "error"]
    source_type: str
    report: str
    source: Dict
    note: Dict
    error: str
    warnings: List[str]


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data):
        text = normalize_space(data)
        if not text:
            return
        if self._in_title:
            self.title += text
        elif not self._skip_depth:
            self._parts.append(text)

    @property
    def text(self):
        return normalize_space(" ".join(self._parts))


def normalize_input(state: ResearchState) -> ResearchState:
    return {
        "url": state.get("url", "").strip(),
        "channel": state.get("channel") or "\u5176\u4ed6",
        "question": state.get("question", "").strip(),
        "tags": state.get("tags") if isinstance(state.get("tags"), list) else [],
        "warnings": [],
        "content_status": "pending",
    }


def fetch_page_node(state: ResearchState) -> ResearchState:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    try:
        response = requests.get(
            state["url"],
            headers=headers,
            timeout=int(os.getenv("FETCH_TIMEOUT", "15")),
        )
        response.raise_for_status()
    except requests.Timeout:
        return {
            "content_status": "error",
            "error": "\u7f51\u9875\u6293\u53d6\u8d85\u65f6\uff0c\u53ef\u80fd\u662f\u76ee\u6807\u7f51\u7ad9\u54cd\u5e94\u8f83\u6162",
            "warnings": state.get("warnings", []) + ["\u8fde\u63a5\u8d85\u65f6"],
        }
    except requests.RequestException as exc:
        return {
            "content_status": "insufficient",
            "title": "\u6293\u53d6\u5931\u8d25",
            "content": "",
            "warnings": state.get("warnings", []) + [f"\u65e0\u6cd5\u81ea\u52a8\u6293\u53d6\u6b64\u94fe\u63a5: {exc}"],
        }

    extractor = TextExtractor()
    extractor.feed(response.text[:2_000_000])
    content = extractor.text[:12000]
    if len(content) < 80:
        return {
            "title": extractor.title.strip()[:120] or "\u672a\u547d\u540d\u7f51\u9875",
            "content": content,
            "content_status": "insufficient",
            "warnings": state.get("warnings", []) + [
                "\u6ca1\u6709\u6293\u53d6\u5230\u8db3\u591f\u6b63\u6587\uff0c\u53ef\u80fd\u9700\u8981\u767b\u5f55\u3001\u53cd\u722c\u6216\u624b\u52a8\u590d\u5236\u5185\u5bb9"
            ],
        }
    return {
        "title": extractor.title.strip()[:120] or "\u672a\u547d\u540d\u7f51\u9875",
        "content": content,
        "content_status": "ready",
    }


def route_after_fetch(state: ResearchState) -> Literal["classify_source", "manual_input", "handle_error"]:
    status = state.get("content_status", "pending")
    if status == "ready":
        return "classify_source"
    elif status == "error":
        return "handle_error"
    return "manual_input"


def manual_input_node(state: ResearchState) -> ResearchState:
    user_data = interrupt("\u8be5\u94fe\u63a5\u65e0\u6cd5\u81ea\u52a8\u83b7\u53d6\u6b63\u6587\uff0c\u8bf7\u624b\u52a8\u7c98\u8d34\u5185\u5bb9\u540e\u7ee7\u7eed\u3002")
    if user_data and isinstance(user_data, dict):
        content = user_data.get("content", "").strip()
        title = user_data.get("title", "").strip() or state.get("title", "")
    else:
        content = str(user_data).strip() if user_data else ""
        title = state.get("title", "")
    if content and len(content) >= 20:
        return {"content": content, "title": title or "\u624b\u52a8\u8f93\u5165", "content_status": "manual"}
    return {
        "content_status": "insufficient",
        "warnings": state.get("warnings", []) + ["\u624b\u52a8\u8f93\u5165\u5185\u5bb9\u4e0d\u8db3\uff0c\u5c06\u7ee7\u7eed\u4f7f\u7528\u5df2\u6709\u5185\u5bb9"],
    }


def handle_error_node(state: ResearchState) -> ResearchState:
    error_msg = state.get("error", "\u672a\u77e5\u9519\u8bef")
    source = {
        "id": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "channel": state.get("channel") or "\u5176\u4ed6",
        "title": state.get("title") or f"\u6293\u53d6\u5931\u8d25: {state['url'][:60]}",
        "url": state["url"],
        "content": f"[No content] {error_msg}",
        "insight": "\u94fe\u63a5\u5206\u6790\u5931\u8d25: " + error_msg + "\n\n\u5efa\u8bae\uff1a\u68c0\u67e5\u94fe\u63a5\u662f\u5426\u6709\u6548\uff0c\u6216\u624b\u52a8\u590d\u5236\u5185\u5bb9\u540e\u901a\u8fc7\u2018\u6458\u5f55\u2019\u529f\u80fd\u4fdd\u5b58\u3002",
        "tags": state.get("tags") if isinstance(state.get("tags"), list) else [],
        "sourceType": "error",
    }
    note = {
        "id": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "date": datetime.now().date().isoformat(),
        "title": f"\u94fe\u63a5\u6293\u53d6\u5931\u8d25: {state['url'][:40]}",
        "body": "\u94fe\u63a5: " + state['url'] + "\n\u9519\u8bef: " + error_msg + "\n\n\u5efa\u8bae\u624b\u52a8\u6d4f\u89c8\u540e\u901a\u8fc7\u6458\u5f55\u529f\u80fd\u8bb0\u5f55\u3002",
    }
    return {"source": source, "note": note, "report": f"\u6293\u53d6\u5931\u8d25: {error_msg}"}


def classify_source_node(state: ResearchState) -> ResearchState:
    text = f"{state.get('title', '')} {state.get('content', '')}".lower()
    keywords = ["\u5c97\u4f4d", "\u804c\u4f4d", "jd", "\u804c\u8d23", "\u4efb\u804c\u8981\u6c42", "\u85aa\u8d44"]
    if any(word in text for word in keywords):
        source_type = "job_post"
    elif any(word in text for word in ["\u9762\u8bd5", "\u9762\u7ecf", "\u7b14\u8bd5"]):
        source_type = "interview"
    elif any(word in text for word in ["\u8bc4\u8bba", "\u907f\u96f7", "\u52a0\u73ed", "\u516c\u53f8\u8bc4\u4ef7", "\u6c1b\u56f4"]):
        source_type = "company_signal"
    else:
        source_type = "general_research"
    return {"source_type": source_type}


def analyze_node(state: ResearchState) -> ResearchState:
    user_feedback = interrupt("\u8bf7\u5ba1\u6838\u6293\u53d6\u7684\u5185\u5bb9\uff0c\u786e\u8ba4\u6216\u7f16\u8f91\u540e\u7ee7\u7eed\u751f\u6210\u5206\u6790\u62a5\u544a\u3002")
    if user_feedback and isinstance(user_feedback, dict):
        content = user_feedback.get("content", state.get("content", ""))
        question = user_feedback.get("question", state.get("question", ""))
        state["content"] = content
        state["question"] = question
    report = generate_report(
        title=state.get("title", ""),
        url=state["url"],
        content=state.get("content", ""),
        question=state.get("question", ""),
        source_type=state.get("source_type", "general_research"),
        warnings=state.get("warnings", []),
    )
    return {"report": report}


def build_records_node(state: ResearchState) -> ResearchState:
    report = state.get("report", "")
    title = state.get("title", "") or state["url"]
    source = {
        "id": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "channel": state.get("channel") or "\u5176\u4ed6",
        "title": title,
        "url": state["url"],
        "content": state.get("content", "")[:5000],
        "insight": report,
        "tags": state.get("tags") if isinstance(state.get("tags"), list) else [],
        "sourceType": state.get("source_type", "general_research"),
    }
    note = {
        "id": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "date": datetime.now().date().isoformat(),
        "title": f"\u94fe\u63a5\u5206\u6790: {title[:40]}",
        "body": report,
    }
    return {"source": source, "note": note}


def build_graph():
    builder = StateGraph(ResearchState)
    builder.add_node("normalize_input", normalize_input)
    builder.add_node("fetch_page", fetch_page_node)
    builder.add_node("manual_input", manual_input_node)
    builder.add_node("handle_error", handle_error_node)
    builder.add_node("classify_source", classify_source_node)
    builder.add_node("analyze", analyze_node)
    builder.add_node("build_records", build_records_node)

    builder.add_edge(START, "normalize_input")
    builder.add_edge("normalize_input", "fetch_page")
    builder.add_conditional_edges(
        "fetch_page",
        route_after_fetch,
        {
            "classify_source": "classify_source",
            "manual_input": "manual_input",
            "handle_error": "handle_error",
        },
    )
    builder.add_edge("manual_input", "classify_source")
    builder.add_edge("classify_source", "analyze")
    builder.add_edge("analyze", "build_records")
    builder.add_edge("build_records", END)
    builder.add_edge("handle_error", END)

    return builder.compile(
        checkpointer=MemorySaver(),
        interrupt_before=["analyze", "manual_input"],
    )


def resume_graph(thread_id: str, resume_data: dict) -> ResearchState:
    graph = get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    return graph.invoke(Command(resume=resume_data), config)


def get_graph_state(thread_id: str) -> Optional[dict]:
    graph = get_graph()
    snap = graph.get_state({"configurable": {"thread_id": thread_id}})
    return dict(snap.values) if snap else None


def get_task_phase(thread_id: str) -> str:
    state = get_graph_state(thread_id)
    if state is None:
        return "completed"
    cs = state.get("content_status", "")
    if cs in ("insufficient", "pending"):
        return "waiting_content"
    if not state.get("report"):
        return "waiting_review"
    return "waiting_save"


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


def run_job_research_graph(payload: Dict, thread_id: Optional[str] = None) -> ResearchState:
    graph = get_graph()
    config = {"configurable": {"thread_id": thread_id or str(uuid.uuid4())}}
    return graph.invoke(
        {
            "url": payload["url"],
            "channel": payload.get("channel") or "\u5176\u4ed6",
            "question": payload.get("question") or "",
            "tags": payload.get("tags") if isinstance(payload.get("tags"), list) else [],
        },
        config,
    )


def generate_report(title, url, content, question, source_type, warnings=None):
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AI_API_KEY")
    if api_key:
        try:
            return call_llm(api_key, title, url, content, question, source_type, warnings or [])
        except RuntimeError as exc:
            return fallback_report(title, url, content, question, source_type, warnings or [], warning=str(exc))
    return fallback_report(title, url, content, question, source_type, warnings or [])


def call_llm(api_key, title, url, content, question, source_type, warnings):
    endpoint = os.getenv("AI_API_BASE", "https://api.openai.com/v1/chat/completions")
    model = os.getenv("AI_MODEL", "gpt-4o-mini")
    proxy = os.getenv("AI_PROXY", "").strip()
    prompt_template = "You are a job research assistant. Summarize in Chinese.\n"
    prompt_template += "Title: " + title + "\n"
    prompt_template += "URL: " + url + "\n"
    prompt_template += "Content type: " + source_type + "\n"
    prompt_template += "Questions: " + (question or "Analyze from job-hunting perspective.") + "\n\n"
    prompt_template += "Page content:\n" + (content[:10000] if content else "") + "\n\n"
    prompt_template += "Output in Chinese:\n"
    prompt_template += "1. Key information\n"
    prompt_template += "2. Assessment of the position/company/industry\n"
    prompt_template += "3. Warning signs worth noting in reviews or signals\n"
    prompt_template += "4. Material I can use in resume or interviews\n"
    prompt_template += "5. Next-step actions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a job-hunting research assistant. Extract actionable insights from job postings, articles, and reviews."},
            {"role": "user", "content": prompt_template},
        ],
        "temperature": 0.3,
    }
    if "deepseek" in endpoint or "deepseek" in model:
        payload["thinking"] = {"type": "disabled"}
    try:
        response = requests.post(
            endpoint,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=int(os.getenv("MODEL_TIMEOUT", "45")),
            proxies={"http": proxy, "https": proxy} if proxy else None,
        )
        response.raise_for_status()
        data = response.json()
    except requests.Timeout as exc:
        raise RuntimeError(f"Model API timeout ({endpoint})") from exc
    except requests.RequestException as exc:
        if exc.response is not None and exc.response.status_code == 401:
            raise RuntimeError("模型接口认证失败：请检查 OPENAI_API_KEY 是否有效，或确认 AI_API_BASE 是否匹配你的 API 服务商。") from exc
        raise RuntimeError(f"Model API error: {exc}") from exc
    except ValueError as exc:
        raise RuntimeError(f"Model API returned non-JSON: {exc}") from exc
    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Model API response format unexpected: {exc}") from exc


def fallback_report(title, url, content, question, source_type, warnings, warning=None):
    sentences = re.split(r"(?<=[\u3002\uff01\uff1f\u003F\u0021])\s*", content)
    highlights = [item for item in sentences if 20 <= len(item) <= 180][:6]
    lines = []
    if warning:
        lines.append("[\u6a21\u578b\u603b\u7ed3\u672a\u6210\u529f\uff0c\u5df2\u751f\u6210\u672c\u5730\u89c4\u5219\u7248\u6458\u8981] \u539f\u56e0: " + warning)
        lines.append("")
    if warnings:
        lines.append("\u6293\u53d6\u63d0\u793a: " + "; ".join(warnings))
        lines.append("")
    lines.extend([
        "\u6807\u9898: " + title,
        "\u94fe\u63a5: " + url,
        "\u5185\u5bb9\u7c7b\u578b: " + source_type,
        "",
        "\u5173\u952e\u4fe1\u606f:",
    ])
    for item in highlights[:4]:
        lines.append("- " + item)
    lines.extend([
        "",
        "\u6c42\u804c\u5224\u65ad:",
        "- \u8fd9\u6761\u5185\u5bb9\u5df2\u4fdd\u5b58\u4e3a\u6458\u5f55\uff0c\u5efa\u8bae\u7ed3\u5408\u5c97\u4f4d\u8981\u6c42\u3001\u516c\u53f8\u8bc4\u4ef7\u548c\u81ea\u5df1\u7684\u80fd\u529b\u8bc1\u636e\u7ee7\u7eed\u8865\u5145\u5224\u65ad\u3002",
        "- \u5982\u679c\u662f\u62db\u8058\u9875\uff0c\u91cd\u70b9\u6838\u5bf9\u804c\u8d23\u3001\u786c\u6027\u8981\u6c42\u3001\u4e1a\u52a1\u65b9\u5411\u3001\u85aa\u8d44\u8303\u56f4\u548c\u6295\u9012\u52a8\u4f5c\u3002",
        "- \u5982\u679c\u662f\u8bc4\u8bba\u6216\u7ecf\u9a8c\u5e16\uff0c\u91cd\u70b9\u533a\u5206\u4e8b\u5b9e\u3001\u60c5\u7eea\u548c\u4e2a\u4f53\u7ecf\u5386\uff0c\u907f\u514d\u5355\u6761\u4fe1\u606f\u51b3\u5b9a\u65b9\u5411\u3002",
        "",
        "\u4e0b\u4e00\u6b65\u884c\u52a8:",
        "- \u8865\u5145\u81ea\u5df1\u7684\u89c2\u5bdf\uff0c\u6807\u8bb0\u662f\u5426\u503c\u5f97\u6295\u9012\u6216\u7ee7\u7eed\u7814\u7a76\u3002",
        "- \u628a\u80fd\u8bc1\u660e\u5339\u914d\u5ea6\u7684\u9879\u76ee\u7ecf\u5386\u5199\u6210\u7b80\u5386 bullet\u3002",
        "- \u8bbe\u7f6e OPENAI_API_KEY \u540e\u53ef\u83b7\u5f97\u66f4\u5b8c\u6574\u7684\u5927\u6a21\u578b\u603b\u7ed3\u3002",
    ])
    if question:
        lines.insert(4, "\u6211\u5173\u5fc3\u7684\u95ee\u9898: " + question)
    return "\n".join(lines)


def normalize_space(text):
    return re.sub(r"\s+", " ", text or "").strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()
