"""
Runs a MeerK40t job in an isolated subprocess.

The kernel terminates its own process on unhandled errors and keeps global
state (settings, active device), so every job gets a fresh interpreter with a
hard timeout. The result contract is ``result.json`` written by ``mk_job``.
"""

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TIMEOUT = int(os.environ.get("RD_JOB_TIMEOUT", "180"))


def run_job(job_dir, request, timeout=None):
    """
    request: the full JSON body mk_job.py expects, e.g.
        {"action": "analyze_part", "part": {...}}
        {"action": "analyze_nested", "parts": [...], "placements": [...], "profile": {...}}
        {"action": "generate", "parts": [...], "placements": [...], "profile": {...}, "params": {...}}
    """
    job_dir = Path(job_dir)
    action = request.get("action", "job")
    # Several runs can target the same job directory at once (one analyze_part
    # per part), so every run gets its own request/result/log files.
    run_id = f"{action}-{uuid.uuid4().hex[:8]}"
    request_path = job_dir / f"request-{run_id}.json"
    result_path = job_dir / f"result-{run_id}.json"
    log_path = job_dir / f"worker-{run_id}.log"
    request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONUNBUFFERED"] = "1"
    cmd = [sys.executable, "-m", "service.core.mk_job", str(job_dir), str(request_path), str(result_path)]
    try:
        with open(log_path, "wb") as log:
            subprocess.run(
                cmd,
                cwd=str(REPO_ROOT),
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=timeout or DEFAULT_TIMEOUT,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": {
                "code": "timeout",
                "message": "O processamento excedeu o tempo limite. "
                "Reduza o DPI do raster ou simplifique o desenho.",
            },
        }
    if not result_path.exists():
        tail = ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
        except OSError:
            pass
        return {
            "ok": False,
            "error": {
                "code": "crash",
                "message": "O motor de processamento encerrou inesperadamente.",
                "detail": tail,
            },
        }
    result = json.loads(result_path.read_text(encoding="utf-8"))
    for path in (request_path, result_path):
        try:
            path.unlink()
        except OSError:
            pass
    return result
