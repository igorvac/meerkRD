"""
FastAPI application: turns MeerK40t into a file-conversion service.

    uvicorn service.api.main:app --reload

A job is a small project: one or more uploaded files ("parts"), each cut any
number of times ("quantity"). Parts are analyzed individually (size, layers)
as soon as they're uploaded; "nest" then lays every requested copy out on the
machine's bed (service/core/nesting.py - bounding-box shelf packing, not true
irregular nesting) and a combined analysis (elements + suggested operations,
merged by layer name across every part) follows automatically. Editing
operations works against an explicit element_id -> operation_id assignment
map, so a user can select individual shapes and move them between operations.

Environment:
    RD_DATA_DIR       where jobs and profiles live (default: service/data)
    RD_API_KEY        if set, every /api request needs header X-API-Key
    RD_WORKERS        parallel MeerK40t subprocesses (default: 2)
    RD_JOB_TIMEOUT    seconds per subprocess (default: 180)
    RD_MAX_UPLOAD_MB  upload size limit per file (default: 25)
    RD_MAX_PARTS      max parts per job (default: 40)
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
from functools import partial
from pathlib import Path
from typing import Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from service.core.nesting import expand_quantities, pack_shelves
from service.core.runner import run_job

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("RD_DATA_DIR", SERVICE_ROOT / "data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
SEED_DIR = SERVICE_ROOT / "seed"
WEB_DIR = SERVICE_ROOT / "web"
API_KEY = os.environ.get("RD_API_KEY")
WORKERS = int(os.environ.get("RD_WORKERS", "2"))
MAX_UPLOAD = int(os.environ.get("RD_MAX_UPLOAD_MB", "25")) * 1024 * 1024
MAX_PARTS = int(os.environ.get("RD_MAX_PARTS", "40"))
ALLOWED_EXT = {"dxf", "svg", "svgz", "lbrn", "lbrn2", "xcs", "png", "jpg", "jpeg", "bmp"}
BUSY_STATUSES = ("analyzing_parts", "nesting", "relayout", "generating")

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
        if job.get("status") in (*BUSY_STATUSES, "analyzing"):
            job["status"] = "failed"
            job["error"] = {"code": "interrupted", "message": "Serviço reiniciado durante o processamento."}
            write_json(path, job)
    yield
    executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="MeerK40t RD Service", version="0.2.0", lifespan=lifespan)
executor = ThreadPoolExecutor(max_workers=WORKERS)
_lock = threading.Lock()


# --------------------------------------------------------------------------- models
class OperationSource(BaseModel):
    layer: Optional[str] = None
    color: Optional[str] = None


class OperationParams(BaseModel):
    id: str
    source: Optional[OperationSource] = None
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
    assignments: Dict[str, str] = {}
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

    @field_validator("assignments")
    @classmethod
    def _assignments_target_known_ops(cls, value, info):
        ops = info.data.get("operations") or []
        known = {op.id for op in ops}
        bad = sorted({v for v in value.values() if v not in known})
        if bad:
            raise ValueError(f"Atribuições apontam para operações inexistentes: {', '.join(bad[:5])}")
        return value


class PlacementUpdate(BaseModel):
    """Where one copy of a part sits on the bed. Scale and rotation are about
    the center of the copy's own bounding box, then that center goes to
    (cx_mm, cy_mm) - see service/core/mk_job.py:position_part_instance."""

    part_id: str
    instance_index: int = Field(ge=1)
    cx_mm: float
    cy_mm: float
    rotation_deg: float = 0.0
    scale: float = Field(default=1.0, ge=0.1, le=10)

    @field_validator("rotation_deg")
    @classmethod
    def _normalize_angle(cls, value):
        value = float(value) % 360.0
        return 0.0 if abs(value) < 1e-9 or abs(value - 360.0) < 1e-9 else value


class LayoutUpdate(BaseModel):
    placements: List[PlacementUpdate]


class PartUpdate(BaseModel):
    quantity: Optional[int] = Field(default=None, ge=1, le=500)
    rotatable: Optional[bool] = None
    enabled: Optional[bool] = None


class JobProfileUpdate(BaseModel):
    profile_id: str
    force: bool = False  # re-nest even if the id is unchanged (profile was edited)


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


def normalize_placement(p):
    """Layouts written before manual editing existed only have the nesting's
    top-left corner and 90-degree flag; give them the center/rotation/scale
    form everything now reads. For 0/90-degree boxes the two are identical."""
    if p.get("cx_mm") is not None:
        return p
    p = dict(p)
    p.update(
        {
            "cx_mm": p["x_mm"] + p["width_mm"] / 2,
            "cy_mm": p["y_mm"] + p["height_mm"] / 2,
            "rotation_deg": 90.0 if p.get("rotated") else 0.0,
            "scale": 1.0,
        }
    )
    return p


def normalize_job(job):
    if job.get("placements"):
        job["placements"] = [normalize_placement(p) for p in job["placements"]]
        if not job.get("nest_placements"):
            job["nest_placements"] = [dict(p) for p in job["placements"]]
        if not job.get("rendered_placements") and job.get("analysis"):
            job["rendered_placements"] = [dict(p) for p in job["placements"]]
    return job


def read_job(path):
    return normalize_job(read_json(path))


def load_job(job_id):
    return read_job(job_path(job_id) / "job.json")


def save_job(job):
    with _lock:
        write_json(JOBS_DIR / job["id"] / "job.json", job)


def update_job(job_id, **changes):
    with _lock:
        path = JOBS_DIR / job_id / "job.json"
        job = read_job(path)
        job.update(changes)
        job["updated_at"] = now()
        write_json(path, job)
        return job


def mutate_part(job_id, part_id, mutator):
    """Read-modify-write a single part inside a job under the shared lock -
    used by the per-part analysis workers, which may finish in any order and
    concurrently with each other."""
    with _lock:
        path = JOBS_DIR / job_id / "job.json"
        job = read_job(path)
        for p in job["parts"]:
            if p["id"] == part_id:
                mutator(p)
                break
        if job["status"] == "analyzing_parts" and all(p["status"] in ("ready", "failed") for p in job["parts"]):
            job["status"] = "parts_ready"
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
    return dict(job)


def reset_nesting_state(job):
    """Called whenever the part list changes (add/remove/quantity/rotate):
    any existing layout, analysis, operation params and generated output are
    invalidated, since element ids and positions depend on the exact set of
    loaded instances."""
    job = dict(job)
    any_pending = any(p["status"] not in ("ready", "failed") for p in job["parts"])
    job.update(
        {
            "status": "analyzing_parts" if any_pending else "parts_ready",
            "placements": None,
            "nest_placements": None,
            "rendered_placements": None,
            "unplaced_part_ids": [],
            "analysis": None,
            "params": None,
            "estimate": None,
            "warnings": [],
            "colors": None,
            "result_operations": None,
            "artifacts": {},
            "error": None,
            "stale": False,
        }
    )
    return job


def part_id_from_filename(name, existing_ids):
    stem = Path(name).stem.lower()
    base = re.sub(r"[^a-z0-9]+", "-", stem).strip("-")[:30] or "peca"
    part_id = base
    i = 2
    while part_id in existing_ids:
        part_id = f"{base}-{i}"
        i += 1
    return part_id


async def save_part_file(job_dir, upload, existing_ids):
    original = Path(upload.filename or "arquivo").name
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Formato não suportado: .{ext or '?'} ({original})")
    content = await upload.read()
    if len(content) > MAX_UPLOAD:
        raise HTTPException(413, f"Arquivo maior que o limite permitido: {original}")
    if not content:
        raise HTTPException(400, f"Arquivo vazio: {original}")
    part_id = part_id_from_filename(original, existing_ids)
    filename = f"{part_id}.{ext}"
    (job_dir / filename).write_bytes(content)
    return {
        "id": part_id,
        "file": filename,
        "name": original,
        "quantity": 1,
        "rotatable": True,
        "enabled": True,
        "status": "analyzing",
        "width_mm": None,
        "height_mm": None,
        "layers": [],
        "elements": None,
        "error": None,
    }


# --------------------------------------------------------------------------- auth
def require_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(401, "API key inválida")


# --------------------------------------------------------------------------- workers
def default_params(analysis):
    operations = []
    for index, op in enumerate(analysis["operations"]):
        op_type = op["type"]
        values = dict(OP_DEFAULTS[op_type])
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
    return {
        "operations": operations,
        "assignments": analysis.get("assignments", {}),
        "optimize": OptimizeParams().model_dump(),
        "material_preset": None,
    }


def enabled_parts_for_engine(job):
    return [{"id": p["id"], "file": p["file"]} for p in job["parts"] if p["enabled"]]


def analyze_part_worker(job_id, part_id):
    job = load_job(job_id)
    part = next(p for p in job["parts"] if p["id"] == part_id)
    result = run_job(JOBS_DIR / job_id, {"action": "analyze_part", "part": {"id": part["id"], "file": part["file"]}})

    def apply(p):
        if result.get("ok"):
            p.update(
                {
                    "status": "ready",
                    "width_mm": result["width_mm"],
                    "height_mm": result["height_mm"],
                    "layers": result["layers"],
                    "elements": result["elements"],
                    "error": None,
                }
            )
        else:
            p["status"] = "failed"
            p["error"] = result.get("error")

    mutate_part(job_id, part_id, apply)


def analyze_nested_worker(job_id):
    job = load_job(job_id)
    profile = get_profile(job["profile_id"])
    result = run_job(
        JOBS_DIR / job_id,
        {
            "action": "analyze_nested",
            "parts": enabled_parts_for_engine(job),
            "placements": job["placements"],
            "profile": profile,
        },
    )
    if not result.get("ok"):
        update_job(job_id, status="failed", error=result.get("error"))
        return
    analysis = analysis_from_result(result)
    params = default_params(analysis)
    update_job(
        job_id,
        status="ready_for_params",
        analysis=analysis,
        params=params,
        placements=placements_with_bounds(job["placements"], result),
        rendered_placements=placements_with_bounds(job["placements"], result),
        artifacts={"preview_svg": f"/api/jobs/{job_id}/artifacts/preview.svg"},
        error=None,
    )


def analysis_from_result(result):
    return {k: result[k] for k in ("elements", "operations", "assignments", "bbox_mm", "bed_mm", "outside_bed")}


def layout_key(placements):
    """What actually defines a layout: x/y/width/height are informational."""
    return [
        (p["part_id"], p["instance_index"], round(p["cx_mm"], 4), round(p["cy_mm"], 4), round(p["rotation_deg"], 4), round(p["scale"], 6))
        for p in placements or []
    ]


def placements_with_bounds(placements, result):
    """Copies the engine-measured bounding box of every instance back into
    its placement (x/y/width/height are informational: the engine positions
    by center, and after a rotation only it knows the exact box)."""
    boxes = result.get("instances") or {}
    out = []
    for p in placements:
        p = dict(p)
        box = boxes.get(f"{p['part_id']}#{p['instance_index']}")
        if box:
            p.update({"x_mm": box[0], "y_mm": box[1], "width_mm": box[2] - box[0], "height_mm": box[3] - box[1]})
        out.append(p)
    return out


def relayout_worker(job_id):
    """Re-runs analyze_nested after the user moved/rotated/scaled copies on
    the canvas, so preview.svg and the bounding boxes match the new layout.
    Element ids only depend on load order (part, copy), never on position,
    so operations and assignments survive untouched. Loops while placements
    keep changing underneath (the canvas commits every drag as it ends), so a
    burst of edits costs at most one extra run."""
    while True:
        job = load_job(job_id)
        placements = job["placements"]
        profile = get_profile(job["profile_id"])
        result = run_job(
            JOBS_DIR / job_id,
            {
                "action": "analyze_nested",
                "parts": enabled_parts_for_engine(job),
                "placements": placements,
                "profile": profile,
            },
        )
        if not result.get("ok"):
            update_job(job_id, status="failed", error=result.get("error"))
            return
        analysis = analysis_from_result(result)
        with _lock:
            path = JOBS_DIR / job_id / "job.json"
            job = read_job(path)
            same_ids = job.get("analysis") and {e["id"] for e in job["analysis"]["elements"]} == {e["id"] for e in analysis["elements"]}
            job["analysis"] = analysis
            if not (same_ids and job.get("params")):
                job["params"] = default_params(analysis)
            rendered = placements_with_bounds(placements, result)
            job["rendered_placements"] = rendered
            if layout_key(job["placements"]) == layout_key(placements):
                job["placements"] = rendered
            job["updated_at"] = now()
            done = layout_key(job["placements"]) == layout_key(rendered)
            if done:
                job["status"] = job.pop("status_before_relayout", None) or "ready_for_params"
            write_json(path, job)
        if done:
            return


def generate_worker(job_id):
    job = load_job(job_id)
    profile = get_profile(job["profile_id"])
    result = run_job(
        JOBS_DIR / job_id,
        {
            "action": "generate",
            "parts": enabled_parts_for_engine(job),
            "placements": job["placements"],
            "profile": profile,
            "params": job["params"],
            "unplaced_parts": job.get("unplaced_part_ids"),
        },
    )
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


def submit(fn, job_id):
    def guarded():
        try:
            fn()
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
        {
            "id": j["id"],
            "name": j.get("name"),
            "created_at": j["created_at"],
            "status": j.get("status"),
            "profile_id": j.get("profile_id"),
            "estimate": j.get("estimate"),
            "stale": j.get("stale"),
            "parts_count": len(j.get("parts", [])),
        }
        for j in jobs
    ]


@app.post("/api/jobs", dependencies=[Depends(require_key)], status_code=201)
async def create_job(files: List[UploadFile] = File(...), profile_id: str = Form(...)):
    get_profile(profile_id)
    if not files:
        raise HTTPException(400, "Envie ao menos um arquivo")
    if len(files) > MAX_PARTS:
        raise HTTPException(400, f"Máximo de {MAX_PARTS} peças por projeto")
    job_id = "j_" + uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True)
    existing_ids = set()
    parts = []
    for f in files:
        part = await save_part_file(job_dir, f, existing_ids)
        existing_ids.add(part["id"])
        parts.append(part)
    name = files[0].filename if len(files) == 1 else f"Projeto com {len(files)} peças"
    job = {
        "id": job_id,
        "name": name,
        "parts": parts,
        "placements": None,
        "unplaced_part_ids": [],
        "created_at": now(),
        "updated_at": now(),
        "status": "analyzing_parts",
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
    for part in parts:
        submit(partial(analyze_part_worker, job_id, part["id"]), job_id)
    return public_job(job)


@app.post("/api/jobs/{job_id}/parts", dependencies=[Depends(require_key)], status_code=201)
async def add_parts(job_id: str, files: List[UploadFile] = File(...)):
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    if not files:
        raise HTTPException(400, "Envie ao menos um arquivo")
    if len(job["parts"]) + len(files) > MAX_PARTS:
        raise HTTPException(400, f"Máximo de {MAX_PARTS} peças por projeto")
    job_dir = job_path(job_id)
    existing_ids = {p["id"] for p in job["parts"]}
    new_parts = []
    for f in files:
        part = await save_part_file(job_dir, f, existing_ids)
        existing_ids.add(part["id"])
        new_parts.append(part)
    job = dict(job)
    job["parts"] = job["parts"] + new_parts
    job = reset_nesting_state(job)
    save_job(job)
    for part in new_parts:
        submit(partial(analyze_part_worker, job_id, part["id"]), job_id)
    return public_job(job)


@app.put("/api/jobs/{job_id}/parts/{part_id}", dependencies=[Depends(require_key)])
def update_part(job_id: str, part_id: str, patch: PartUpdate):
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    found = False
    for p in job["parts"]:
        if p["id"] == part_id:
            found = True
            if patch.quantity is not None:
                p["quantity"] = patch.quantity
            if patch.rotatable is not None:
                p["rotatable"] = patch.rotatable
            if patch.enabled is not None:
                p["enabled"] = patch.enabled
    if not found:
        raise HTTPException(404, "Peça não encontrada")
    job = reset_nesting_state(job)
    save_job(job)
    return public_job(job)


@app.put("/api/jobs/{job_id}/profile", dependencies=[Depends(require_key)])
def update_job_profile(job_id: str, body: JobProfileUpdate):
    """Switches the job to another machine. The bed size drives the nesting
    and element ids, so this invalidates the layout exactly like editing the
    part list does - parts, quantities and rotation flags are kept."""
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    get_profile(body.profile_id)
    if body.profile_id == job["profile_id"] and not body.force:
        return public_job(job)
    job = dict(job)
    job["profile_id"] = body.profile_id
    job = reset_nesting_state(job)
    save_job(job)
    return public_job(job)


@app.delete("/api/jobs/{job_id}/parts/{part_id}", dependencies=[Depends(require_key)])
def delete_part(job_id: str, part_id: str):
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    remaining = [p for p in job["parts"] if p["id"] != part_id]
    if len(remaining) == len(job["parts"]):
        raise HTTPException(404, "Peça não encontrada")
    if not remaining:
        raise HTTPException(409, "O projeto precisa de ao menos uma peça — exclua o trabalho inteiro em vez disso")
    removed = next(p for p in job["parts"] if p["id"] == part_id)
    job = dict(job)
    job["parts"] = remaining
    job = reset_nesting_state(job)
    save_job(job)
    file_path = job_path(job_id) / removed["file"]
    if file_path.exists():
        file_path.unlink()
    return public_job(job)


@app.post("/api/jobs/{job_id}/nest", dependencies=[Depends(require_key)], status_code=202)
def nest(job_id: str, spacing_mm: float = 5.0, margin_mm: float = 5.0):
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    active = [p for p in job["parts"] if p["enabled"]]
    if not active:
        raise HTTPException(409, "Nenhuma peça ativa para posicionar")
    if any(p["status"] != "ready" for p in active):
        raise HTTPException(409, "Aguarde a análise de todas as peças terminar")
    profile = get_profile(job["profile_id"])
    items = expand_quantities(
        [
            {
                "id": p["id"],
                "width": p["width_mm"],
                "height": p["height_mm"],
                "quantity": p["quantity"],
                "rotatable": p["rotatable"],
            }
            for p in active
        ]
    )
    result = pack_shelves(
        items,
        bed_width=profile["bed_mm"][0],
        bed_height=profile["bed_mm"][1],
        spacing=spacing_mm,
        margin=margin_mm,
    )
    placements = []
    for p in result.placements:
        part_id, instance_index = p.id.rsplit("#", 1)
        placements.append(
            {
                "part_id": part_id,
                "instance_index": int(instance_index),
                "cx_mm": p.x + p.width / 2,
                "cy_mm": p.y + p.height / 2,
                "rotation_deg": 90.0 if p.rotated else 0.0,
                "scale": 1.0,
                "x_mm": p.x,
                "y_mm": p.y,
                "width_mm": p.width,
                "height_mm": p.height,
                "rotated": p.rotated,
            }
        )
    unplaced_part_ids = sorted({pid.rsplit("#", 1)[0] for pid in result.unplaced})
    job = reset_nesting_state(job)
    job.update(
        {
            "status": "nesting",
            "placements": placements,
            "nest_placements": [dict(p) for p in placements],
            "unplaced_part_ids": unplaced_part_ids,
            "used_height_mm": result.used_height,
        }
    )
    save_job(job)
    submit(partial(analyze_nested_worker, job_id), job_id)
    return public_job(job)


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_key)])
def get_job(job_id: str):
    return public_job(load_job(job_id))


def start_relayout(job):
    """Stores the layout as-is and makes sure a relayout worker is running.
    Safe to call while one already is: the worker re-reads placements and
    loops until what it analyzed is what is stored."""
    job = dict(job)
    if job["status"] != "relayout":
        job["status_before_relayout"] = job["status"]
        job["status"] = "relayout"
        # The toolpath drawn for the previous layout no longer applies.
        job["artifacts"] = {k: v for k, v in job.get("artifacts", {}).items() if k != "path_svg"}
        save_job(job)
        submit(partial(relayout_worker, job["id"]), job["id"])
    else:
        save_job(job)
    return job


@app.put("/api/jobs/{job_id}/layout", dependencies=[Depends(require_key)])
def set_layout(job_id: str, body: LayoutUpdate):
    """Manual layout: moves, rotates and scales copies the nesting placed.
    The set of copies cannot change here (that is what re-nesting is for),
    so analysis, operations and assignments are all kept."""
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES and job["status"] != "relayout":
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    if not job.get("placements") or not job.get("analysis"):
        raise HTTPException(409, "Posicione as peças (Nestear) antes de editar o layout")
    current = {(p["part_id"], p["instance_index"]): p for p in job["placements"]}
    incoming = {(p.part_id, p.instance_index): p for p in body.placements}
    if set(current) != set(incoming):
        raise HTTPException(400, "O layout precisa conter exatamente as mesmas cópias do nesting")
    placements = []
    for key, old in current.items():
        new = incoming[key]
        merged = dict(old)
        merged.update({"cx_mm": new.cx_mm, "cy_mm": new.cy_mm, "rotation_deg": new.rotation_deg, "scale": new.scale})
        placements.append(merged)
    job = dict(job)
    job["placements"] = placements
    job["updated_at"] = now()
    if job.get("status") == "ready" or job.get("status_before_relayout") == "ready":
        job["stale"] = True
    return public_job(start_relayout(job))


@app.post("/api/jobs/{job_id}/layout/reset", dependencies=[Depends(require_key)])
def reset_layout(job_id: str):
    """Puts every copy back where the nesting left it."""
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES and job["status"] != "relayout":
        raise HTTPException(409, "Aguarde o processamento atual terminar")
    if not job.get("nest_placements"):
        raise HTTPException(409, "Este trabalho não tem um nesting para restaurar")
    job = dict(job)
    job["placements"] = [dict(p) for p in job["nest_placements"]]
    job["updated_at"] = now()
    if job.get("status") == "ready" or job.get("status_before_relayout") == "ready":
        job["stale"] = True
    return public_job(start_relayout(job))


@app.put("/api/jobs/{job_id}/params", dependencies=[Depends(require_key)])
def set_params(job_id: str, params: JobParams):
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Aguarde o processamento terminar")
    if not job.get("analysis"):
        raise HTTPException(409, "Posicione as peças (Nestear) antes de definir operações")
    data = params.model_dump(exclude_none=True)
    changes = {"params": data}
    if job["status"] == "ready":
        changes["stale"] = True
    return public_job(update_job(job_id, **changes))


@app.post("/api/jobs/{job_id}/generate", dependencies=[Depends(require_key)], status_code=202)
def generate(job_id: str):
    job = load_job(job_id)
    if job["status"] in BUSY_STATUSES:
        raise HTTPException(409, "Já está em processamento")
    if not job.get("params"):
        raise HTTPException(409, "Defina os parâmetros antes de gerar")
    JobParams.model_validate(job["params"])
    job = update_job(job_id, status="generating", error=None)
    submit(partial(generate_worker, job_id), job_id)
    return public_job(job)


@app.post("/api/jobs/{job_id}/duplicate", dependencies=[Depends(require_key)], status_code=201)
def duplicate(job_id: str):
    source = load_job(job_id)
    new_id = "j_" + uuid.uuid4().hex[:12]
    new_dir = JOBS_DIR / new_id
    new_dir.mkdir(parents=True)
    src_dir = job_path(job_id)
    for part in source["parts"]:
        if (src_dir / part["file"]).exists():
            shutil.copy(src_dir / part["file"], new_dir / part["file"])
    if (src_dir / "preview.svg").exists():
        shutil.copy(src_dir / "preview.svg", new_dir / "preview.svg")
    job = dict(source)
    job.update(
        {
            "id": new_id,
            "created_at": now(),
            "updated_at": now(),
            "status": "ready_for_params" if source.get("analysis") else "parts_ready",
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


class RevalidatingStaticFiles(StaticFiles):
    """
    Force every static asset to be revalidated (If-None-Match) instead of
    reused blindly from the browser's disk cache. The dev/service loop here
    is "edit web/app.js, reload" - a stale cached copy served silently is a
    much worse failure mode than one extra 304 round-trip per load.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", RevalidatingStaticFiles(directory=str(WEB_DIR), html=True), name="web")
