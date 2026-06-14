import json
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

import requests

try:
    from flask import Flask, jsonify, request, send_file, send_from_directory
except ImportError:
    print("缺少 Flask 依赖。请先运行：python -m pip install -r requirements.txt")
    sys.exit(1)


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "workspace.json"
ENV_FILE = ROOT / ".env"
EXPORT_NAME = "find-my-job-export.json"
DEFAULT_DATA = {"jobs": [], "sources": [], "notes": []}

MAX_WORKERS = int(os.getenv("ANALYSIS_WORKERS", "4"))
FETCH_TIMEOUT = int(os.getenv("FETCH_TIMEOUT", "15"))
MODEL_TIMEOUT = int(os.getenv("MODEL_TIMEOUT", "45"))

data_lock = threading.RLock()
task_lock = threading.RLock()
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
tasks = {}

app = Flask(__name__, static_folder=str(ROOT), static_url_path="")


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


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/api/health")
def health():
    with task_lock:
        running = sum(1 for task in tasks.values() if task["status"] in {"queued", "running"})
    return jsonify(
        {
            "ok": True,
            "server": "flask",
            "workers": MAX_WORKERS,
            "runningTasks": running,
            "time": now_iso(),
        }
    )


@app.get("/api/data")
def get_data():
    return jsonify(load_data())


@app.put("/api/data")
def put_data():
    data = normalize_data(request.get_json(silent=True) or {})
    save_data(data)
    return jsonify(data)


@app.get("/api/export")
def export_data():
    ensure_data_file()
    return send_file(DATA_FILE, as_attachment=True, download_name=EXPORT_NAME, mimetype="application/json")


@app.post("/api/<bucket>")
def create_item(bucket):
    invalid = validate_bucket(bucket)
    if invalid:
        return invalid
    item = dict(request.get_json(silent=True) or {})
    item.setdefault("id", str(uuid.uuid4()))
    item.setdefault("createdAt", now_iso())
    with data_lock:
        data = load_data_unlocked()
        data[bucket].insert(0, item)
        save_data_unlocked(data)
    return jsonify(item), 201


@app.delete("/api/<bucket>/<item_id>")
def delete_item(bucket, item_id):
    invalid = validate_bucket(bucket)
    if invalid:
        return invalid
    with data_lock:
        data = load_data_unlocked()
        data[bucket] = [item for item in data[bucket] if item.get("id") != item_id]
        save_data_unlocked(data)
    return jsonify({"ok": True})


@app.post("/api/analysis-tasks")
def create_analysis_task():
    payload = request.get_json(silent=True) or {}
    url = payload.get("url", "").strip()
    if not url:
        return error_response("请提供链接", 400)
    if urlparse(url).scheme not in {"http", "https"}:
        return error_response("只支持 http 或 https 链接", 400)

    task_id = str(uuid.uuid4())
    task = {
        "id": task_id,
        "status": "queued",
        "message": "任务已进入后台队列",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "payload": {
            "url": url,
            "channel": payload.get("channel") or "其他",
            "question": payload.get("question") or "",
            "tags": payload.get("tags") if isinstance(payload.get("tags"), list) else [],
        },
        "report": "",
        "source": None,
        "note": None,
        "error": "",
    }
    with task_lock:
        tasks[task_id] = task
    executor.submit(run_analysis_task, task_id)
    return jsonify({"task": public_task(task)}), 202


@app.get("/api/analysis-tasks")
def list_analysis_tasks():
    with task_lock:
        latest = sorted(tasks.values(), key=lambda item: item["createdAt"], reverse=True)[:20]
        return jsonify({"tasks": [public_task(task) for task in latest]})


@app.get("/api/analysis-tasks/<task_id>")
def get_analysis_task(task_id):
    with task_lock:
        task = tasks.get(task_id)
        if not task:
            return error_response("任务不存在，可能服务已重启。请重新提交链接。", 404)
        return jsonify({"task": public_task(task), "data": load_data() if task["status"] == "done" else None})


@app.post("/api/analysis-tasks/<task_id>/retry")
def retry_analysis_task(task_id):
    with task_lock:
        old_task = tasks.get(task_id)
        if not old_task:
            return error_response("任务不存在，无法重试", 404)
        payload = dict(old_task["payload"])
    with app.test_request_context(json=payload):
        return create_analysis_task()


def run_analysis_task(task_id):
    update_task(task_id, status="running", message="正在抓取网页")
    with task_lock:
        payload = dict(tasks[task_id]["payload"])

    try:
        page = fetch_page(payload["url"])
        update_task(task_id, message="网页已抓取，正在生成总结")
        report = generate_report(
            title=page["title"],
            url=payload["url"],
            content=page["text"],
            question=payload.get("question", ""),
        )
        source, note, data = save_analysis_result(payload, page, report)
        update_task(
            task_id,
            status="done",
            message="分析完成，已保存为摘录和笔记",
            report=report,
            source=source,
            note=note,
        )
    except Exception as exc:
        update_task(task_id, status="failed", message="分析失败，可以重试或手动摘录正文", error=str(exc))


def save_analysis_result(payload, page, report):
    source = {
        "id": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "channel": payload.get("channel") or "其他",
        "title": page["title"] or payload["url"],
        "url": payload["url"],
        "content": page["text"][:5000],
        "insight": report,
        "tags": payload.get("tags") if isinstance(payload.get("tags"), list) else [],
    }
    note = {
        "id": str(uuid.uuid4()),
        "createdAt": now_iso(),
        "date": datetime.now().date().isoformat(),
        "title": f"链接分析：{source['title'][:40]}",
        "body": report,
    }
    with data_lock:
        data = load_data_unlocked()
        data["sources"].insert(0, source)
        data["notes"].insert(0, note)
        save_data_unlocked(data)
    return source, note, data


def update_task(task_id, **changes):
    with task_lock:
        task = tasks.get(task_id)
        if not task:
            return
        task.update(changes)
        task["updatedAt"] = now_iso()


def public_task(task):
    return {
        "id": task["id"],
        "status": task["status"],
        "message": task["message"],
        "createdAt": task["createdAt"],
        "updatedAt": task["updatedAt"],
        "url": task["payload"]["url"],
        "channel": task["payload"]["channel"],
        "report": task.get("report", ""),
        "source": task.get("source"),
        "note": task.get("note"),
        "error": task.get("error", ""),
    }


def load_data():
    with data_lock:
        return load_data_unlocked()


def load_data_unlocked():
    ensure_data_file_unlocked()
    try:
        with DATA_FILE.open("r", encoding="utf-8") as file:
            return normalize_data(json.load(file))
    except (OSError, json.JSONDecodeError):
        return DEFAULT_DATA.copy()


def save_data(data):
    with data_lock:
        save_data_unlocked(data)


def save_data_unlocked(data):
    DATA_DIR.mkdir(exist_ok=True)
    tmp_file = DATA_FILE.with_suffix(".tmp")
    with tmp_file.open("w", encoding="utf-8") as file:
        json.dump(normalize_data(data), file, ensure_ascii=False, indent=2)
        file.write("\n")
    tmp_file.replace(DATA_FILE)


def ensure_data_file():
    with data_lock:
        ensure_data_file_unlocked()


def ensure_data_file_unlocked():
    if not DATA_FILE.exists():
        save_data_unlocked(DEFAULT_DATA.copy())


def normalize_data(data):
    data = data if isinstance(data, dict) else {}
    return {
        "jobs": data.get("jobs") if isinstance(data.get("jobs"), list) else [],
        "sources": data.get("sources") if isinstance(data.get("sources"), list) else [],
        "notes": data.get("notes") if isinstance(data.get("notes"), list) else [],
    }


def fetch_page(url):
    headers = {
        "User-Agent": "Mozilla/5.0 findMyJob local research assistant",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    try:
        response = requests.get(url, headers=headers, timeout=FETCH_TIMEOUT)
        response.raise_for_status()
    except requests.Timeout as exc:
        raise RuntimeError("网页抓取超时") from exc
    except requests.RequestException as exc:
        raise RuntimeError(f"网页抓取失败：{exc}") from exc

    extractor = TextExtractor()
    extractor.feed(response.text[:2_000_000])
    text = extractor.text[:12000]
    if len(text) < 80:
        raise RuntimeError("没有抓取到足够正文，可能需要登录、反爬或手动复制内容。")
    return {"title": extractor.title.strip()[:120] or "未命名网页", "text": text}


def generate_report(title, url, content, question):
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AI_API_KEY")
    if api_key:
        try:
            return call_llm(api_key, title, url, content, question)
        except RuntimeError as exc:
            return fallback_report(title, url, content, question, warning=str(exc))
    return fallback_report(title, url, content, question)


def call_llm(api_key, title, url, content, question):
    endpoint = os.getenv("AI_API_BASE", "https://api.openai.com/v1/chat/completions")
    model = os.getenv("AI_MODEL", "gpt-4o-mini")
    prompt = f"""你是我的求职研究助手。请基于网页内容生成中文总结。

标题：{title}
链接：{url}
我关心的问题：{question or "请从求职决策角度分析。"}

网页内容：
{content[:10000]}

请输出：
1. 关键信息
2. 对岗位/公司/行业的判断
3. 评论或外部信号里值得警惕的点
4. 我可以写进简历或面试表达的素材
5. 下一步行动
"""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你擅长把招聘信息、网页内容和评论整理成务实的求职判断。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
    }
    try:
        response = requests.post(
            endpoint,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=MODEL_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except requests.Timeout as exc:
        raise RuntimeError("模型接口超时") from exc
    except requests.RequestException as exc:
        raise RuntimeError(f"模型接口失败：{exc}") from exc
    except ValueError as exc:
        raise RuntimeError("模型接口返回的不是 JSON") from exc

    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("模型接口返回格式不符合预期") from exc


def fallback_report(title, url, content, question, warning=None):
    sentences = re.split(r"(?<=[。！？!?])\s*", content)
    highlights = [item for item in sentences if 20 <= len(item) <= 180][:6]
    lines = []
    if warning:
        lines.append(f"模型总结未成功，已生成本地规则版摘要。原因：{warning}")
        lines.append("")
    lines.extend(
        [
            f"标题：{title}",
            f"链接：{url}",
            "",
            "关键信息：",
            *(f"- {item}" for item in highlights[:4]),
            "",
            "求职判断：",
            "- 这条内容已经保存为摘录，建议结合岗位要求、公司评价和自己的能力证据继续补充判断。",
            "- 如果这是招聘页，重点核对职责、硬性要求、业务方向、薪资范围和投递动作。",
            "- 如果这是评论或经验帖，重点区分事实、情绪和个体经历，避免单条信息决定方向。",
            "",
            "下一步行动：",
            "- 补充自己的观察，标记是否值得投递或继续研究。",
            "- 把能证明匹配度的项目经历写成简历 bullet。",
            "- 设置 OPENAI_API_KEY 后可获得更完整的大模型总结。",
        ]
    )
    if question:
        lines.insert(3, f"我关心的问题：{question}")
    return "\n".join(lines)


def validate_bucket(bucket):
    if bucket not in {"jobs", "sources", "notes"}:
        return error_response("数据类型不存在", 404)
    return None


def error_response(message, status):
    return jsonify({"error": message}), status


def normalize_space(text):
    return re.sub(r"\s+", " ", text or "").strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_env_file():
    if not ENV_FILE.exists():
        return
    with ENV_FILE.open("r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def run():
    load_env_file()
    ensure_data_file()
    port = int(os.getenv("PORT", "8000"))
    use_waitress = os.getenv("USE_WAITRESS", "1") != "0"
    if use_waitress:
        try:
            from waitress import serve

            print(f"findMyJob running with Waitress at http://127.0.0.1:{port}")
            print(f"Data file: {DATA_FILE}")
            serve(app, host="127.0.0.1", port=port, threads=MAX_WORKERS + 2)
            return
        except ImportError:
            pass

    print(f"findMyJob running with Flask at http://127.0.0.1:{port}")
    print(f"Data file: {DATA_FILE}")
    app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=True)


if __name__ == "__main__":
    run()
