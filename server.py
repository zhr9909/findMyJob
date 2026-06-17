import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests

try:
    from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context
except ImportError:
    print("缺少 Flask 依赖。请先运行：python -m pip install -r requirements.txt")
    sys.exit(1)

try:
    from graph import run_job_research_graph, get_graph, get_graph_state, get_task_phase
    from langgraph.types import Command
except ImportError as exc:
    print(f"缺少 LangGraph 依赖或图模块加载失败：{exc}")
    print("请先运行：python -m pip install -r requirements.txt")
    sys.exit(1)


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATA_FILE = DATA_DIR / "workspace.json"
DB_FILE = DATA_DIR / "findmyjob.db"
DIST_DIR = ROOT / "dist"
ENV_FILE = ROOT / ".env"
EXPORT_NAME = "find-my-job-export.json"
DEFAULT_DATA = {"jobs": [], "sources": [], "notes": []}


def load_env_file():
    if not ENV_FILE.exists():
        return
    with ENV_FILE.open("r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip().lstrip("\ufeff")
            value = value.strip().strip('"').strip("'")
            if key and not os.environ.get(key):
                os.environ[key] = value


load_env_file()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")

MAX_WORKERS = int(os.getenv("ANALYSIS_WORKERS", "4"))
FETCH_TIMEOUT = int(os.getenv("FETCH_TIMEOUT", "15"))
MODEL_TIMEOUT = int(os.getenv("MODEL_TIMEOUT", "45"))
AI_PROXY = os.getenv("AI_PROXY", "").strip()

data_lock = threading.RLock()
task_lock = threading.RLock()
db_lock = threading.RLock()
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
tasks = {}

app = Flask(__name__, static_folder=None)


@app.after_request
def add_local_cors_headers(response):
    origin = request.headers.get("Origin", "")
    allowed_origins = {
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    }
    if origin in allowed_origins:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Api-Key"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    return response


@app.route("/api/<path:_path>", methods=["OPTIONS"])
def api_options(_path):
    return ("", 204)


@app.get("/")
def index():
    if (DIST_DIR / "index.html").exists():
        return send_from_directory(DIST_DIR, "index.html")
    return send_from_directory(ROOT, "index.html")


@app.get("/app.js")
def legacy_app_js():
    return send_from_directory(ROOT, "app.js", mimetype="application/javascript")


@app.get("/styles.css")
def legacy_styles_css():
    return send_from_directory(ROOT, "styles.css", mimetype="text/css")


@app.get("/assets/<path:filename>")
def frontend_assets(filename):
    if (DIST_DIR / "assets" / filename).exists():
        if filename.endswith(".js"):
            return send_from_directory(DIST_DIR / "assets", filename, mimetype="application/javascript")
        if filename.endswith(".css"):
            return send_from_directory(DIST_DIR / "assets", filename, mimetype="text/css")
        return send_from_directory(DIST_DIR / "assets", filename)
    return error_response("前端资源不存在", 404)


@app.get("/legacy/<path:filename>")
def legacy_static(filename):
    if filename not in {"index.html", "app.js", "styles.css"}:
        return error_response("文件不存在", 404)
    return send_from_directory(ROOT, filename)


@app.get("/api/health")
def health():
    with task_lock:
        running = sum(1 for task in tasks.values() if task["status"] in {"queued", "running", "waiting_review"})
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


@app.post("/api/agent")
def run_agent():
    payload = request.get_json(silent=True) or {}
    prompt = payload.get("prompt", "").strip()
    if not prompt:
        return error_response("请描述你想让求职 Agent 处理的问题", 400)
    conversation_id = payload.get("conversationId") or None
    return jsonify(run_job_agent(prompt, load_data(), conversation_id=conversation_id))


@app.post("/api/agent/stream")
def stream_agent():
    payload = request.get_json(silent=True) or {}
    prompt = payload.get("prompt", "").strip()
    if not prompt:
        return error_response("请描述你想让求职 Agent 处理的问题", 400)
    conversation_id = payload.get("conversationId") or None

    @stream_with_context
    def generate():
        yield from run_job_agent_stream(prompt, load_data(), conversation_id=conversation_id)

    return Response(generate(), mimetype="text/event-stream")


@app.get("/api/agent/conversations")
def list_agent_conversations():
    return jsonify({"conversations": list_conversations()})


@app.get("/api/agent/conversations/<conversation_id>")
def get_agent_conversation(conversation_id):
    conversation = load_conversation(conversation_id)
    if not conversation:
        return error_response("对话不存在", 404)
    return jsonify(conversation)


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
    update_task(task_id, status="running", message="正在运行分析工作流")
    with task_lock:
        payload = dict(tasks[task_id]["payload"])
    try:
        result = run_job_research_graph(payload, thread_id=task_id)
        if result.get("source") and result.get("note"):
            source, note, data = save_analysis_result(result)
            update_task(task_id, status="done", message="分析完成，已保存", report=result.get("report", ""))
            return
        if result.get("source"):
            source, note, data = save_analysis_result(result)
            update_task(task_id, status="done", message=result.get("report", "处理完成"), report=result.get("report", ""))
            return
        phase = get_task_phase(task_id)
        update_task(task_id, status="waiting_review", message=f"等待用户确认 ({phase})")
    except Exception as exc:
        update_task(task_id, status="failed", message="分析失败", error=str(exc))
def save_analysis_result(result):
    source = result["source"]
    note = result["note"]
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


def validate_bucket(bucket):
    if bucket not in {"jobs", "sources", "notes"}:
        return error_response("数据类型不存在", 404)
    return None


def error_response(message, status):
    return jsonify({"error": message}), status


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def normalize_space(text):
    return re.sub(r"\s+", " ", text or "").strip()


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    with db_lock, sqlite3.connect(DB_FILE) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );
            CREATE TABLE IF NOT EXISTS tool_events (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                message_id TEXT,
                name TEXT NOT NULL,
                label TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT NOT NULL,
                created_at TEXT NOT NULL,
                meta_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (conversation_id) REFERENCES conversations(id),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            );
            CREATE TABLE IF NOT EXISTS agent_matches (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                message_id TEXT,
                bucket TEXT NOT NULL,
                title TEXT NOT NULL,
                subtitle TEXT NOT NULL,
                score INTEGER NOT NULL,
                snippet TEXT NOT NULL,
                url TEXT NOT NULL,
                hits_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id),
                FOREIGN KEY (message_id) REFERENCES messages(id)
            );
            """
        )


def db_connect():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_conversation(conversation_id, prompt):
    now = now_iso()
    title = make_conversation_title(prompt)
    with db_lock, db_connect() as conn:
        if conversation_id:
            row = conn.execute("SELECT id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row:
                conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
                return conversation_id
        conversation_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (conversation_id, title, now, now),
        )
        return conversation_id


def make_conversation_title(prompt):
    cleaned = normalize_space(prompt)
    return cleaned[:28] + ("..." if len(cleaned) > 28 else "") or "新的求职对话"


def insert_message(conversation_id, role, content, meta=None, message_id=None):
    message_id = message_id or str(uuid.uuid4())
    now = now_iso()
    with db_lock, db_connect() as conn:
        conn.execute(
            """
            INSERT INTO messages (id, conversation_id, role, content, created_at, meta_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (message_id, conversation_id, role, content, now, json.dumps(meta or {}, ensure_ascii=False)),
        )
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
    return message_id


def save_tool_events(conversation_id, message_id, tools):
    now = now_iso()
    with db_lock, db_connect() as conn:
        for tool in tools:
            conn.execute(
                """
                INSERT INTO tool_events (id, conversation_id, message_id, name, label, status, detail, created_at, meta_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    conversation_id,
                    message_id,
                    tool.get("name", ""),
                    tool.get("label", tool.get("name", "工具")),
                    tool.get("status", "done"),
                    tool.get("detail", ""),
                    now,
                    json.dumps(tool.get("meta") or {}, ensure_ascii=False),
                ),
            )


def save_agent_matches(conversation_id, message_id, matches):
    rows = []
    for bucket, items in matches.items():
        for item in items:
            rows.append((bucket, item))
    now = now_iso()
    with db_lock, db_connect() as conn:
        for bucket, item in rows:
            conn.execute(
                """
                INSERT INTO agent_matches (id, conversation_id, message_id, bucket, title, subtitle, score, snippet, url, hits_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    conversation_id,
                    message_id,
                    bucket,
                    item.get("title", ""),
                    item.get("subtitle", ""),
                    int(item.get("score", 0)),
                    item.get("snippet", ""),
                    item.get("url", ""),
                    json.dumps(item.get("hits") or [], ensure_ascii=False),
                    now,
                ),
            )


def list_conversations(limit=30):
    init_db()
    with db_lock, db_connect() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.title, c.created_at, c.updated_at,
                   (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
            FROM conversations c
            ORDER BY c.updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "lastMessage": row["last_message"] or "",
        }
        for row in rows
    ]


def load_conversation(conversation_id):
    init_db()
    with db_lock, db_connect() as conn:
        convo = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if not convo:
            return None
        messages = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
        events = conn.execute(
            "SELECT * FROM tool_events WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
        matches = conn.execute(
            "SELECT * FROM agent_matches WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
    return {
        "conversation": {
            "id": convo["id"],
            "title": convo["title"],
            "createdAt": convo["created_at"],
            "updatedAt": convo["updated_at"],
        },
        "messages": [
            {
                "id": row["id"],
                "role": row["role"],
                "content": row["content"],
                "createdAt": row["created_at"],
                "meta": parse_json(row["meta_json"], {}),
            }
            for row in messages
        ],
        "events": [
            {
                "id": row["id"],
                "messageId": row["message_id"],
                "name": row["name"],
                "label": row["label"],
                "status": row["status"],
                "detail": row["detail"],
                "createdAt": row["created_at"],
                "meta": parse_json(row["meta_json"], {}),
            }
            for row in events
        ],
        "matches": [
            {
                "id": row["id"],
                "messageId": row["message_id"],
                "bucket": row["bucket"],
                "title": row["title"],
                "subtitle": row["subtitle"],
                "score": row["score"],
                "snippet": row["snippet"],
                "url": row["url"],
                "hits": parse_json(row["hits_json"], []),
                "createdAt": row["created_at"],
            }
            for row in matches
        ],
    }


def load_message_events(conversation_id, message_id):
    with db_lock, db_connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tool_events WHERE conversation_id = ? AND message_id = ? ORDER BY created_at ASC",
            (conversation_id, message_id),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "messageId": row["message_id"],
            "name": row["name"],
            "label": row["label"],
            "status": row["status"],
            "detail": row["detail"],
            "createdAt": row["created_at"],
            "meta": parse_json(row["meta_json"], {}),
        }
        for row in rows
    ]


def load_message_matches(conversation_id, message_id):
    with db_lock, db_connect() as conn:
        rows = conn.execute(
            "SELECT * FROM agent_matches WHERE conversation_id = ? AND message_id = ? ORDER BY score DESC, created_at ASC",
            (conversation_id, message_id),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "messageId": row["message_id"],
            "bucket": row["bucket"],
            "title": row["title"],
            "subtitle": row["subtitle"],
            "score": row["score"],
            "snippet": row["snippet"],
            "url": row["url"],
            "hits": parse_json(row["hits_json"], []),
            "createdAt": row["created_at"],
        }
        for row in rows
    ]


def parse_json(value, fallback):
    try:
        return json.loads(value or "")
    except (TypeError, ValueError):
        return fallback


def get_recent_messages(conversation_id, limit=8):
    if not conversation_id:
        return []
    init_db()
    with db_lock, db_connect() as conn:
        rows = conn.execute(
            """
            SELECT role, content FROM messages
            WHERE conversation_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (conversation_id, limit),
        ).fetchall()
    return [{"role": row["role"], "content": row["content"]} for row in reversed(rows)]


def run_job_agent(prompt, data, conversation_id=None):
    init_db()
    conversation_id = ensure_conversation(conversation_id, prompt)
    user_message_id = insert_message(conversation_id, "user", prompt)
    history = get_recent_messages(conversation_id)
    context = build_agent_context(prompt, data, history=history)
    answer, mode = generate_agent_answer(prompt, context)
    return finalize_agent_run(conversation_id, user_message_id, answer, mode, context)


def run_job_agent_stream(prompt, data, conversation_id=None):
    init_db()
    try:
        conversation_id = ensure_conversation(conversation_id, prompt)
        user_message_id = insert_message(conversation_id, "user", prompt)
        yield sse_event({"type": "conversation", "conversationId": conversation_id, "userMessageId": user_message_id})
        history = get_recent_messages(conversation_id)
        context = build_agent_context(prompt, data, history=history)
        for tool in context["tools"]:
            yield sse_event({"type": "tool", "event": {**tool, "status": "running"}})
            yield sse_event({"type": "tool", "event": tool})
        answer, mode = generate_agent_answer(prompt, context)
        assistant_message_id = str(uuid.uuid4())
        yield sse_event({"type": "answer", "answer": answer, "mode": mode, "messageId": assistant_message_id})
        result = finalize_agent_run(conversation_id, user_message_id, answer, mode, context, message_id=assistant_message_id)
        yield sse_event({"type": "done", "result": result})
    except Exception as exc:
        yield sse_event({"type": "error", "error": str(exc)})


def sse_event(payload):
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def finalize_agent_run(conversation_id, user_message_id, answer, mode, context, message_id=None):
    assistant_message_id = insert_message(
        conversation_id,
        "assistant",
        answer,
        meta={"mode": mode, "summary": context["summary"], "localEvidenceLevel": context["localEvidenceLevel"]},
        message_id=message_id,
    )
    save_tool_events(conversation_id, assistant_message_id, context["tools"])
    save_agent_matches(conversation_id, assistant_message_id, context["matches"])
    conversation = load_conversation(conversation_id)
    latest_events = load_message_events(conversation_id, assistant_message_id)
    latest_matches = load_message_matches(conversation_id, assistant_message_id)
    return {
        "conversationId": conversation_id,
        "messageId": assistant_message_id,
        "userMessageId": user_message_id,
        "answer": answer,
        "mode": mode,
        "plan": context["plan"],
        "tools": context["tools"],
        "matches": context["matches"],
        "summary": context["summary"],
        "conversation": conversation["conversation"] if conversation else None,
        "messages": conversation["messages"] if conversation else [],
        "events": latest_events,
        "flatMatches": latest_matches,
        "createdAt": now_iso(),
    }


def build_agent_context(prompt, data, history=None):
    keywords = extract_keywords(prompt)
    intent = infer_agent_intent(prompt)
    jobs = rank_records(data.get("jobs", []), prompt, keywords, "jobs")
    sources = rank_records(data.get("sources", []), prompt, keywords, "sources")
    notes = rank_records(data.get("notes", []), prompt, keywords, "notes")
    matches = {
        "jobs": jobs[:5],
        "sources": sources[:5],
        "notes": notes[:3],
    }
    tools = [
        {
            "name": "parse_request",
            "label": "拆解你的问题",
            "status": "done",
            "detail": f"识别为：{intent}；关键词：{', '.join(keywords[:8]) or '暂无明确关键词'}",
        },
        {
            "name": "search_jobs",
            "label": "检索岗位库",
            "status": "done",
            "detail": f"找到 {len(jobs)} 条相关岗位，展示前 {len(matches['jobs'])} 条",
        },
        {
            "name": "search_sources",
            "label": "检索摘录知识库",
            "status": "done",
            "detail": f"找到 {len(sources)} 条相关摘录，展示前 {len(matches['sources'])} 条",
        },
        {
            "name": "search_notes",
            "label": "检索复盘笔记",
            "status": "done",
            "detail": f"找到 {len(notes)} 条相关笔记，展示前 {len(matches['notes'])} 条",
        },
        {
            "name": "job_reasoning",
            "label": "生成求职判断",
            "status": "done",
            "detail": "综合匹配度、证据和下一步动作",
        },
    ]
    total_matches = len(jobs) + len(sources) + len(notes)
    if total_matches == 0:
        evidence_level = "none"
    elif total_matches < 3:
        evidence_level = "weak"
    else:
        evidence_level = "some"
    return {
        "intent": intent,
        "keywords": keywords,
        "history": history or [],
        "matches": matches,
        "tools": tools,
        "plan": build_agent_plan(intent, keywords),
        "localEvidenceLevel": evidence_level,
        "summary": {
            "jobs": len(data.get("jobs", [])),
            "sources": len(data.get("sources", [])),
            "notes": len(data.get("notes", [])),
            "matchedJobs": len(jobs),
            "matchedSources": len(sources),
            "matchedNotes": len(notes),
        },
    }


def infer_agent_intent(prompt):
    lowered = prompt.lower()
    if any(word in lowered for word in ["简历", "resume", "cv"]):
        return "简历优化"
    if any(word in lowered for word in ["面试", "interview", "面经"]):
        return "面试准备"
    if any(word in lowered for word in ["匹配", "适合", "推荐", "投递", "岗位", "jd"]):
        return "岗位匹配"
    if any(word in lowered for word in ["避雷", "评价", "口碑", "风险", "加班"]):
        return "公司风险判断"
    return "求职研究问答"


def build_agent_plan(intent, keywords):
    focus = "、".join(keywords[:5]) if keywords else "你当前工作台里的记录"
    return [
        f"先理解问题类型：{intent}",
        f"围绕 {focus} 检索本地岗位、摘录和笔记",
        "提取可验证证据，区分事实、推测和行动建议",
        "输出推荐排序、风险提示和下一步动作",
    ]


def rank_records(items, prompt, keywords, bucket):
    ranked = []
    prompt_lower = prompt.lower()
    for item in items:
        text = record_search_text(item, bucket)
        text_lower = text.lower()
        hits = []
        score = 0
        for keyword in keywords:
            if keyword.lower() in text_lower:
                hits.append(keyword)
                score += max(2, min(12, len(keyword)))
        if prompt_lower and prompt_lower in text_lower:
            score += 18
        if bucket == "jobs":
            score += int(item.get("fit") or 0) * 5
        if not hits and score == 0:
            score = soft_relevance_score(prompt, text)
        if score <= 0:
            continue
        ranked.append(format_match(item, bucket, score, hits, text))
    ranked.sort(key=lambda item: (item["score"], item["createdAt"]), reverse=True)
    return ranked


def format_match(item, bucket, score, hits, text):
    title = item.get("title") or item.get("company") or item.get("date") or "未命名记录"
    if bucket == "jobs" and item.get("company"):
        title = f"{item.get('company')} · {item.get('title') or '未命名岗位'}"
    subtitle = {
        "jobs": "岗位记录",
        "sources": item.get("channel") or "摘录",
        "notes": item.get("date") or "笔记",
    }[bucket]
    return {
        "id": item.get("id", ""),
        "bucket": bucket,
        "title": title,
        "subtitle": subtitle,
        "score": min(99, max(35, score)),
        "hits": hits[:8],
        "url": item.get("url", ""),
        "snippet": make_snippet(text, hits),
        "createdAt": item.get("createdAt", ""),
    }


def record_search_text(item, bucket):
    if bucket == "jobs":
        parts = [
            item.get("company", ""),
            item.get("title", ""),
            item.get("source", ""),
            item.get("stage", ""),
            " ".join(item.get("keywords", []) if isinstance(item.get("keywords"), list) else []),
            item.get("description", ""),
            item.get("reflection", ""),
        ]
    elif bucket == "sources":
        parts = [
            item.get("channel", ""),
            item.get("title", ""),
            item.get("content", ""),
            item.get("insight", ""),
            " ".join(item.get("tags", []) if isinstance(item.get("tags"), list) else []),
        ]
    else:
        parts = [item.get("date", ""), item.get("title", ""), item.get("body", "")]
    return normalize_space(" ".join(str(part or "") for part in parts))


def extract_keywords(text):
    stopwords = {
        "我", "你", "他", "她", "它", "我们", "你们", "他们", "这个", "那个", "一下", "一个",
        "是否", "可以", "帮我", "帮", "看看", "整理", "分析", "推荐", "适合", "怎么", "什么",
        "the", "and", "for", "with", "from", "this", "that", "are", "can", "should",
    }
    tokens = re.findall(r"[\u4e00-\u9fffA-Za-z0-9+#.-]{2,}", text)
    cleaned = []
    seen = set()
    for token in tokens:
        word = token.strip().strip("，。,.!?！？:：；;、")
        if not word or word.lower() in stopwords or word in stopwords:
            continue
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(word)
    return cleaned[:20]


def soft_relevance_score(prompt, text):
    prompt_chars = set(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", prompt.lower()))
    text_chars = set(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", text.lower()))
    if not prompt_chars or not text_chars:
        return 0
    overlap = len(prompt_chars & text_chars)
    if overlap < 4:
        return 0
    return min(28, overlap)


def make_snippet(text, hits):
    if not text:
        return ""
    position = 0
    for hit in hits:
        found = text.lower().find(hit.lower())
        if found >= 0:
            position = max(0, found - 60)
            break
    snippet = text[position : position + 220]
    return snippet + ("..." if position + 220 < len(text) else "")


def generate_agent_answer(prompt, context):
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AI_API_KEY")
    if api_key:
        try:
            return call_agent_llm(api_key, prompt, context), "llm"
        except RuntimeError as exc:
            fallback = build_fallback_agent_answer(prompt, context)
            return f"{fallback}\n\n[模型调用未成功，已使用本地规则生成。原因：{exc}]", "fallback"
    return build_fallback_agent_answer(prompt, context), "fallback"


def call_agent_llm(api_key, prompt, context):
    endpoint = os.getenv("AI_API_BASE", "https://api.openai.com/v1/chat/completions")
    model = os.getenv("AI_MODEL", "gpt-4o-mini")
    compact_context = {
        "intent": context["intent"],
        "keywords": context["keywords"],
        "local_evidence_level": context.get("localEvidenceLevel", "none"),
        "recent_history": context.get("history", [])[-4:],
        "summary": context["summary"],
        "top_jobs": context["matches"]["jobs"][:4],
        "top_sources": context["matches"]["sources"][:4],
        "top_notes": context["matches"]["notes"][:2],
    }
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是一个中文求职研究 Agent。你在一个多轮对话里工作，要记住上下文并延续上一轮的目标。"
                    "优先使用用户工作台里的岗位、摘录、笔记证据做判断。"
                    "如果本地工作台没有对应内容，或者 local_evidence_level 为 none/weak，你可以直接基于你的通用求职知识、招聘常识和行业经验给出建议。"
                    "不要因为本地证据不足而拒绝回答；相反，请明确说明“本地证据不足，以下为通用建议/经验判断”。"
                    "如果本地有相关内容，先引用本地证据，再补充通用判断。"
                    "不要声称自己真的做了网页检索，除非上下文中提供了可验证的外部来源。"
                ),
            },
            {
                "role": "user",
                "content": (
                    "用户问题：\n"
                    + prompt
                    + "\n\n本地检索上下文 JSON：\n"
                    + json.dumps(compact_context, ensure_ascii=False, indent=2)
                    + "\n\n请用 Markdown 输出：\n"
                    + "1. 结论\n2. 关键依据\n3. 推荐/风险排序\n4. 下一步行动"
                    + "\n\n补充规则：如果本地证据很少或没有，请直接给出通用建议，不要停在‘请补充数据’。"
                ),
            },
        ],
        "temperature": 0.25,
    }
    if "deepseek" in endpoint or "deepseek" in model:
        payload["thinking"] = {"type": "disabled"}
    try:
        response = requests.post(
            endpoint,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=int(os.getenv("MODEL_TIMEOUT", "45")),
            proxies=get_ai_proxies(),
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


def get_ai_proxies():
    if not AI_PROXY:
        return None
    return {"http": AI_PROXY, "https": AI_PROXY}


def build_fallback_agent_answer(prompt, context):
    lines = [
        "## 结论",
        f"我把你的问题识别为「{context['intent']}」。当前工作台里共有 {context['summary']['jobs']} 条岗位、{context['summary']['sources']} 条摘录、{context['summary']['notes']} 条笔记。",
        "",
    ]
    if not any(context["matches"].values()):
        lines.extend(
            [
                "本地知识库里没有明显匹配的记录，下面给你一版通用求职建议。",
                "",
                "## 通用建议",
                "- 如果你在看岗位，优先核对城市、职级、职责、团队方向、薪资、试用期和成长空间。",
                "- 如果你在看公司风险，重点留意流程混乱、信息不透明、薪资承诺反复、候选人反馈集中负面。",
                "- 如果你在改简历，把项目成果、业务指标、技能栈和岗位关键词对应起来。",
                "",
                "## 下一步行动",
                "- 先明确你最关心的是岗位匹配、公司风险还是简历优化。",
                "- 再补充 1-3 条相关记录，我可以把建议收紧到你的具体目标。",
            ]
        )
        return "\n".join(lines)

    lines.extend(["## 关键依据"])
    for label, key in [("岗位", "jobs"), ("摘录", "sources"), ("笔记", "notes")]:
        matches = context["matches"][key]
        if not matches:
            continue
        top = matches[0]
        lines.append(f"- {label}命中：{top['title']}（匹配度 {top['score']}%）")
    lines.extend(["", "## 推荐/风险排序"])
    combined = context["matches"]["jobs"] + context["matches"]["sources"] + context["matches"]["notes"]
    for item in sorted(combined, key=lambda value: value["score"], reverse=True)[:6]:
        evidence = f"；命中：{', '.join(item['hits'])}" if item["hits"] else ""
        lines.append(f"- {item['score']}% · {item['title']}（{item['subtitle']}）{evidence}")
    lines.extend(
        [
            "",
            "## 下一步行动",
            "- 把最高匹配记录补充成一条明确判断：值得投递 / 继续观察 / 暂缓。",
            "- 如果是岗位匹配问题，补充你的简历要点后，我可以继续帮你改成投递版 bullet。",
            "- 如果是公司风险问题，建议再收集 2-3 条不同来源证据，避免单条评价造成误判。",
        ]
    )
    return "\n".join(lines)



@app.get("/api/analysis-tasks/<task_id>/state")
def get_task_state(task_id):
    state = get_graph_state(task_id)
    if state is None:
        return error_response("任务状态不可用", 404)
    return jsonify({"state": state, "phase": get_task_phase(task_id)})


@app.post("/api/analysis-tasks/<task_id>/resume")
def resume_analysis_task(task_id):
    payload = request.get_json(silent=True) or {}
    user_data = payload.get("data", {})
    with task_lock:
        task = tasks.get(task_id)
        if not task:
            return error_response("任务不存在", 404)
        if task["status"] not in {"waiting_review", "running"}:
            return error_response(f"任务状态不允许恢复: {task['status']}", 400)
    try:
        graph = get_graph()
        config = {"configurable": {"thread_id": task_id}}
        result = graph.invoke(Command(resume=user_data), config)
        if result.get("source") and result.get("note"):
            source, note, data = save_analysis_result(result)
            update_task(task_id, status="done", message="分析完成，已保存", report=result.get("report", ""))
        else:
            phase = get_task_phase(task_id)
            update_task(task_id, status="waiting_review", message=f"等待用户确认 ({phase})")
        with task_lock:
            return jsonify({"task": public_task(tasks.get(task_id, task))})
    except Exception as exc:
        update_task(task_id, status="failed", message="恢复失败", error=str(exc))
        return jsonify({"task": public_task(tasks.get(task_id, task))}), 500



def run():
    ensure_data_file()
    init_db()
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
