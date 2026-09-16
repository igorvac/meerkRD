"""
FastAPI application: turns MeerK40t into a file-conversion service.

    uvicorn service.api.main:app --reload

Environment:
    RD_DATA_DIR       where jobs and profiles live (default: service/data)
    RD_API_KEY        if set, every /api request needs header X-API-Key
    RD_WORKERS        parallel MeerK40t subprocesses (default: 2)
    RD_JOB_TIMEOUT    seconds per subprocess (default: 180)
    RD_MAX_UPLOAD_MB  upload size limit (default: 25)
"""

import json
import os
import re
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from service.core.runner import run_job

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("RD_DATA_DIR", SERVICE_ROOT / "data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
SEED_DIR = SERVICE_ROOT / "seed"
WEB_DIR = SERVICE_ROOT / "web"
API_KEY = os.environ.get("RD_API_KEY")
WORKERS = int(os.environ.get("RD_WORKERS", "2"))
MAX_UPLOAD = int(os.environ.get("RD_MAX_UPLOAD_MB", "25")) * 1024 * 1024
ALLOWED_EXT = {"dxf", "svg", "svgz", "lbrn", "lbrn2", "xcs", "png", "jpg", "jpeg", "bmp"}

OP_DEFAULTS = {
    "cut": {"speed_mm_s": 10, "power_pct": 60, "passes": 1, "kerf_mm": 0.0},
    "engrave": {"speed_mm_s": 200, "power_pct": 20, "passes": 1},
    "raster": {"speed_mm_s": 300, "power_pct": 25, "passes": 1, "dpi": 254, "direction": "top_to_bottom"},
    "image": {"speed_mm_s": 300, "power_pct": 25, "passes": 1, "dpi": 254, "direction": "top_to_bottom"},
}

@asynccontextmanager
async def lifespan(_app):
    ensure_data()
    # Jobs interrupted by a restart are marked failed rather than left spinning.
    for path in JOBS_DIR.glob("j_*/job.json"):
        job = read_json(path)
        if job.get("status") in ("analyzing", "generating"):
            job["status"] = "failed"
            job["error"] = {"code": "interrupted", "message": "Serviço reiniciado durante o processamento."}
            write_json(path, job)
    yield
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="MeerK40t RD Service", version="0.1.0", lifespan=lifespan)
executor = ThreadPoolExecutor(max_workers=WORKERS)
_lock = threading.Lock()


# --------------------------------------------------------------------------- models
class OperationSource(BaseModel):
    layer: Optional[str] = None
    color: Optional[str] = None
    element_ids: Optional[List[str]] = None


class OperationParams(BaseModel):
    id: str
    source: OperationSource
    type: Literal["cut", "engrave", "raster", "image"] = "cut"
    label: Optional[str] = None
    enabled: bool = True
    order: int = 0
    speed_mm_s: float = Field(gt=0, le=5000)
    power_pct: float = Field(ge=0, le=100)
    passes: int = Field(default=1, ge=1, le=50)
    kerf_mm: Optional[float] = Field(default=None, ge=0, le=5)
    dpi: Optional[int] = Field(default=None, ge=50, le=1200)
    direction: Optional[
        Literal["top_to_bottom", "bottom_to_top", "left_to_right", "right_to_left", "hatch", "crossover"]
    ] = None
    color: Optional[str] = None

    @field_validator("color")
    @classmethod
    def _hex_color(cls, value):
        if value is None:
            return value
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise ValueError("cor deve estar no formato #RRGGBB")
        return value.lower()


class OptimizeParams(BaseModel):
    enabled: bool = True
    inner_first: bool = True
    reduce_travel: bool = True
    merge_passes: bool = False
    merge_ops: bool = False


class JobParams(BaseModel):
    operations: List[OperationParams]
    optimize: OptimizeParams = OptimizeParams()
    material_preset: Optional[str] = None

    @field_validator("operations")
    @classmethod
    def _unique_ids(cls, value):
        ids = [op.id for op in value]
        if len(ids) != len(set(ids)):
            raise ValueError("ids de operação repetidos")
        if not value:
            raise ValueError("pelo menos uma operação é necessária")
        return value


class MachineProfile(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,40}$")
    name: str
    driver: str = "ruida-beta"
    bed_mm: List[float] = Field(min_length=2, max_length=2)
    home_corner: Literal["auto", "top-left", "top-right", "bottom-left", "bottom-right", "center"] = "top-left"
    flip_x: bool = False
    flip_y: bool = False
    swap_xy: bool = False
    magic: int = 136
    job_reference: Literal["absolute", "anchor"] = "absolute"
    max_speed_mm_s: Optional[float] = None
    min_power_pct: Optional[float] = None
    notes: str = ""


class MaterialPreset(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,40}$")
    name: str
    settings: Dict[str, Dict[str, float]]


# --------------------------------------------------------------------------- storage
def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_data():
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("machine_profiles.json", "material_presets.json"):
        target = DATA_DIR / name
        if not target.exists():
            shutil.copy(SEED_DIR / name, target)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, data):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def job_path(job_id):
    if not re.fullmatch(r"j_[0-9a-f]{12}", job_id or ""):
        raise HTTPException(404, "Job não encontrado")
    path = JOBS_DIR / job_id
    if not path.is_dir():
        raise HTTPException(404, "Job não encontrado")
    return path


def load_job(job_id):
    return read_json(job_path(job_id) / "job.json")


def save_job(job):
    with _lock:
        write_json(JOBS_DIR / job["id"] / "job.json", job)


def update_job(job_id, **changes):
    with _lock:
        path = JOBS_DIR / job_id / "job.json"
        job = read_json(path)
        job.update(changes)
        job["updated_at"] = now()
        write_json(path, job)
        return job


def profiles():
    return read_json(DATA_DIR / "machine_profiles.json")


def presets():
    return read_json(DATA_DIR / "material_presets.json")


def get_profile(profile_id):
    for profile in profiles():
        if profile["id"] == profile_id:
            return profile
    raise HTTPException(400, f"Perfil de máquina desconhecido: {profile_id}")


def public_job(job):
    job = dict(job)
    job.pop("analysis_raw", None)
    return job


# --------------------------------------------------------------------------- auth
def require_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(401, "API key inválida")


# --------------------------------------------------------------------------- workers
def default_params(analysis, preset=None):
    settings = (preset or {}).get("settings", {})
    operations = []
    for index, op in enumerate(analysis["operations"]):
        op_type = op["type"]
        values = dict(OP_DEFAULTS[op_type])
        values.update(settings.get(op_type, {}))
        operations.append(
            {
                "id": op["id"],
                "source": op["source"],
                "type": op_type,
                "label": op["source"].get("layer") or op["source"].get("color") or op["id"],
                "enabled": True,
                "order": {"raster": 0, "image": 0, "engrave": 1, "cut": 2}[op_type] * 100 + index,
                "color": op.get("color") or "#000000",
                **values,
            }
        )
    return {"operations": operations, "optimize": OptimizeParams().model_dump(), "material_preset": None}


def analyze_worker(job_id):
    job = load_job(job_id)
    profile = get_profile(job["profile_id"])
    result = run_job(JOBS_DIR / job_id, "analyze", job["input_file"], profile)
    if not result.get("ok"):
        update_job(job_id, status="failed", error=result.get("error"))
        return
    analysis = {k: result[k] for k in ("elements", "operations", "bbox_mm", "bed_mm", "outside_bed")}
    params = default_params(analysis)
    update_job(
        job_id,
        status="ready_for_params",
        analysis=analysis,
        params=params,
        artifacts={"preview_svg": f"/api/jobs/{job_id}/artifacts/preview.svg"},
        error=None,
    )


def generate_worker(job_id):
    job = load_job(job_id)
    profile = get_profile(job["profile_id"])
    result = run_job(JOBS_DIR / job_id, "generate", job["input_file"], profile, job["params"])
    if not result.get("ok"):
        update_job(job_id, status="failed", error=result.get("error"))
        return
    update_job(
        job_id,
        status="ready",
        error=None,
        stale=False,
        estimate=result["estimate"],
        warnings=result["warnings"],
        colors=result["colors"],
        result_operations=result["operations"],
        artifacts={
            "preview_svg": f"/api/jobs/{job_id}/artifacts/preview.svg",
            "path_svg": f"/api/jobs/{job_id}/artifacts/path.svg",
            "stats": f"/api/jobs/{job_id}/artifacts/stats.json",
            "rd": f"/api/jobs/{job_id}/file",
            "rd_bytes": result["artifacts"]["rd_bytes"],
        },
    )


def submit(worker, job_id):
    def guarded():
        try:
            worker(job_id)
        except Exception as e:  # noqa: BLE001 - never lose a job silently
            update_job(job_id, status="failed", error={"code": "internal", "message": str(e)})

    executor.submit(guarded)


# --------------------------------------------------------------------------- routes
@app.get("/api/health")
def health():
    return {"ok": True, "workers": WORKERS, "jobs": len(list(JOBS_DIR.glob("j_*")))}


@app.get("/api/machine-profiles", dependencies=[Depends(require_key)])
def list_profiles():
    return profiles()


@app.post("/api/machine-profiles", dependencies=[Depends(require_key)], status_code=201)
def create_profile(profile: MachineProfile):
    items = [p for p in profiles() if p["id"] != profile.id]
    items.append(profile.model_dump())
    write_json(DATA_DIR / "machine_profiles.json", items)
    return profile


@app.get("/api/material-presets", dependencies=[Depends(require_key)])
def list_presets():
    return presets()


@app.post("/api/material-presets", dependencies=[Depends(require_key)], status_code=201)
def create_preset(preset: MaterialPreset):
    items = [p for p in presets() if p["id"] != preset.id]
    items.append(preset.model_dump())
    write_json(DATA_DIR / "material_presets.json", items)
    return preset


@app.get("/api/jobs", dependencies=[Depends(require_key)])
def list_jobs():
    jobs = [read_json(p) for p in JOBS_DIR.glob("j_*/job.json")]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return [
        {k: j.get(k) for k in ("id", "name", "created_at", "status", "profile_id", "estimate", "stale")}
        for j in jobs
    ]


@app.post("/api/jobs", dependencies=[Depends(require_key)], status_code=201)
async def create_job(file: UploadFile = File(...), profile_id: str = Form(...)):
    get_profile(profile_id)
    original = Path(file.filename or "arquivo").name
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Formato não suportado: .{ext or '?'}")
    content = await file.read()
    if len(content) > MAX_UPLOAD:
        raise HTTPException(413, "Arquivo maior que o limite permitido")
    if not content:
        raise HTTPException(400, "Arquivo vazio")
    job_id = "j_" + uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True)
    input_name = f"input.{ext}"
    (job_dir / input_name).write_bytes(content)
    job = {
        "id": job_id,
        "name": original,
        "input_file": input_name,
        "created_at": now(),
        "updated_at": now(),
        "status": "analyzing",
        "profile_id": profile_id,
        "params": None,
        "analysis": None,
        "estimate": None,
        "warnings": [],
        "artifacts": {},
        "error": None,
        "stale": False,
    }
    save_job(job)
    submit(analyze_worker, job_id)
    return public_job(job)


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_key)])
def get_job(job_id: str):
    return public_job(load_job(job_id))


@app.put("/api/jobs/{job_id}/params", dependencies=[Depends(require_key)])
def set_params(job_id: str, params: JobParams):
    job = load_job(job_id)
    if job["status"] in ("analyzing", "generating"):
        raise HTTPException(409, "Aguarde o processamento terminar")
    if job["status"] == "failed" and not job.get("analysis"):
        raise HTTPException(409, "A análise do arquivo falhou; envie o arquivo novamente")
    data = params.model_dump(exclude_none=True)
    changes = {"params": data}
    if job["status"] == "ready":
        changes["stale"] = True
    return public_job(update_job(job_id, **changes))


@app.post("/api/jobs/{job_id}/generate", dependencies=[Depends(require_key)], status_code=202)
def generate(job_id: str):
    job = load_job(job_id)
    if job["status"] in ("analyzing", "generating"):
        raise HTTPException(409, "Já está em processamento")
    if not job.get("params"):
        raise HTTPException(409, "Defina os parâmetros antes de gerar")
    JobParams.model_validate(job["params"])
    job = update_job(job_id, status="generating", error=None)
    submit(generate_worker, job_id)
    return public_job(job)


@app.post("/api/jobs/{job_id}/duplicate", dependencies=[Depends(require_key)], status_code=201)
def duplicate(job_id: str):
    source = load_job(job_id)
    new_id = "j_" + uuid.uuid4().hex[:12]
    new_dir = JOBS_DIR / new_id
    new_dir.mkdir(parents=True)
    src_dir = JOBS_DIR / job_id
    for name in (source["input_file"], "preview.svg"):
        if (src_dir / name).exists():
            shutil.copy(src_dir / name, new_dir / name)
    job = dict(source)
    job.update(
        {
            "id": new_id,
            "name": source["name"],
            "created_at": now(),
            "updated_at": now(),
            "status": "ready_for_params" if source.get("analysis") else "analyzing",
            "estimate": None,
            "warnings": [],
            "error": None,
            "stale": False,
            "artifacts": {"preview_svg": f"/api/jobs/{new_id}/artifacts/preview.svg"}
            if source.get("analysis")
            else {},
        }
    )
    job.pop("result_operations", None)
    job.pop("colors", None)
    save_job(job)
    if job["status"] == "analyzing":
        submit(analyze_worker, new_id)
    return public_job(job)


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_key)], status_code=204)
def delete_job(job_id: str):
    shutil.rmtree(job_path(job_id))
    return JSONResponse(status_code=204, content=None)


@app.get("/api/jobs/{job_id}/file", dependencies=[Depends(require_key)])
def download_rd(job_id: str):
    job = load_job(job_id)
    path = job_path(job_id) / "job.rd"
    if job["status"] != "ready" or not path.exists():
        raise HTTPException(409, "O arquivo ainda não foi gerado")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(job["name"]).stem)[:40] or "job"
    filename = f"{stem}_{job['profile_id']}.rd"
    return FileResponse(path, media_type="application/octet-stream", filename=filename)


@app.get("/api/jobs/{job_id}/artifacts/{name}", dependencies=[Depends(require_key)])
def artifact(job_id: str, name: str):
    if name not in ("preview.svg", "path.svg", "stats.json"):
        raise HTTPException(404, "Artefato desconhecido")
    path = job_path(job_id) / name
    if not path.exists():
        raise HTTPException(404, "Artefato ainda não disponível")
    media = "image/svg+xml" if name.endswith(".svg") else "application/json"
    return FileResponse(path, media_type=media)


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
