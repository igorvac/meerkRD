"""
End-to-end tests for the RD service: headless core and HTTP API.

Run from the repository root:

    python -m pytest service/tests -v
"""

import importlib
import json
import shutil
import time
from pathlib import Path

import pytest

from meerk40t.ruida.rdjob import (
    RDJob,
    decode32,
    determine_magic_via_histogram,
    parse_commands,
)
from service.core.runner import run_job

SERVICE_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = SERVICE_ROOT / "web" / "exemplo.dxf"

PROFILE = {
    "id": "ruida-900x600",
    "driver": "ruida-beta",
    "bed_mm": [900, 600],
    "home_corner": "top-left",
    "magic": 136,
    "max_speed_mm_s": 500,
    "min_power_pct": 10,
}

PARAMS = {
    "optimize": {"enabled": True, "inner_first": True, "reduce_travel": True},
    "operations": [
        {"id": "op_1", "source": {"layer": "CUT"}, "type": "cut", "order": 2,
         "speed_mm_s": 12, "power_pct": 65, "passes": 2, "kerf_mm": 0, "color": "#ff0000"},
        {"id": "op_2", "source": {"layer": "ENGRAVE"}, "type": "engrave", "order": 1,
         "speed_mm_s": 200, "power_pct": 20, "passes": 1, "color": "#0000ff"},
        {"id": "op_3", "source": {"layer": "LOGO"}, "type": "raster", "order": 0,
         "speed_mm_s": 300, "power_pct": 25, "passes": 1, "dpi": 254,
         "direction": "top_to_bottom", "color": "#00ff00"},
    ],
}


def decode_rd(data):
    magic = determine_magic_via_histogram(data)
    job = RDJob()
    job.set_magic(magic)
    cmds = list(parse_commands(job.unswizzle(data)))
    speeds = []
    for c in cmds:
        if c[:2] == b"\xc9\x02":
            v = 0
            for b in c[3:8]:
                v = (v << 7) | (b & 0x7F)
            speeds.append(round(v / 1000, 1))
    return magic, cmds, speeds


@pytest.fixture
def job_dir(tmp_path):
    shutil.copy(EXAMPLE, tmp_path / "input.dxf")
    return tmp_path


def test_analyze_detects_layers(job_dir):
    result = run_job(job_dir, "analyze", "input.dxf", PROFILE)
    assert result["ok"], result.get("error")
    layers = {op["source"].get("layer"): op["type"] for op in result["operations"]}
    assert layers == {"CUT": "cut", "ENGRAVE": "engrave", "LOGO": "raster"}
    assert (job_dir / "preview.svg").exists()
    assert result["outside_bed"] is False


def test_generate_produces_valid_rd(job_dir):
    result = run_job(job_dir, "generate", "input.dxf", PROFILE, PARAMS)
    assert result["ok"], result.get("error")
    data = (job_dir / "job.rd").read_bytes()
    magic, cmds, speeds = decode_rd(data)
    assert magic == 0x88
    assert cmds[-1] == b"\xd7"
    assert {12.0, 200.0, 300.0} <= set(speeds)
    est = result["estimate"]
    assert est["total_s"] > 0
    assert est["by_operation"]["op_3"]["cuts"] > 0, "raster op must produce cuts headlessly"
    assert est["by_operation"]["op_1"]["cut_mm"] == pytest.approx(952, rel=0.02)
    assert (job_dir / "path.svg").exists()
    assert result["warnings"] == []


def test_generate_warns_on_bad_speed(job_dir):
    params = json.loads(json.dumps(PARAMS))
    params["operations"][0]["speed_mm_s"] = 900
    result = run_job(job_dir, "generate", "input.dxf", PROFILE, params)
    assert result["ok"]
    assert any(w["code"] == "speed_too_high" for w in result["warnings"])


def test_generate_anchor_mode_rebases_to_bbox_corner(job_dir):
    """
    'anchor' mode must emit Ref Point 1 (D8 11), not Ref Point 2 (D8 10), and
    must not depend on bed_mm/home_corner for placement: the job is re-based
    onto its own bounding-box corner so it's small offsets from (0,0) that
    the controller then adds to whatever origin point is live on the console
    (the RDWorks-compatible "piece zero" workflow).
    """
    profile = dict(PROFILE, job_reference="anchor", bed_mm=[10, 10])  # bed too small to matter
    result = run_job(job_dir, "generate", "input.dxf", profile, PARAMS)
    assert result["ok"], result.get("error")
    data = (job_dir / "job.rd").read_bytes()
    magic = determine_magic_via_histogram(data)
    job = RDJob()
    job.set_magic(magic)
    cmds = list(parse_commands(job.unswizzle(data)))
    assert cmds[0] == b"\xd8\x11", "anchor mode must open with Ref Point 1 (Anchor Point)"
    assert b"\xd8\x10" not in cmds, "anchor mode must never reference machine-absolute zero"

    def abs_coords(cmd):
        if cmd[0] == 0x88:  # MoveAbs
            return decode32(cmd[1:6]), decode32(cmd[6:11])
        if cmd[0] == 0xA8:  # CutAbs
            return decode32(cmd[1:6]), decode32(cmd[6:11])
        return None

    xs, ys = [], []
    for c in cmds:
        pos = abs_coords(c)
        if pos:
            xs.append(pos[0])
            ys.append(pos[1])
    assert xs and ys
    # Re-based near (0,0): nothing should be anywhere near the (deliberately
    # tiny, and therefore obviously-exceeded-if-unmodified) 10x10mm bed.
    assert min(xs) == 0 or min(ys) == 0, "job should be anchored at its own bbox corner"
    assert max(max(xs), max(ys)) < 200_000, "coordinates must be small offsets, not absolute bed-space"


def test_generate_fails_without_elements(job_dir):
    params = json.loads(json.dumps(PARAMS))
    for op in params["operations"]:
        op["source"] = {"layer": "NOPE"}
    result = run_job(job_dir, "generate", "input.dxf", PROFILE, params)
    assert not result["ok"]
    assert result["error"]["code"] == "nothing_to_burn"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RD_API_KEY", raising=False)
    import service.api.main as main

    importlib.reload(main)
    from fastapi.testclient import TestClient

    with TestClient(main.app) as tc:
        yield tc


def wait_status(client, job_id, wanted, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in wanted:
            return job
        time.sleep(0.3)
    raise AssertionError(f"job {job_id} never reached {wanted}: {job['status']} {job.get('error')}")


def test_api_full_flow(client):
    profiles = client.get("/api/machine-profiles").json()
    assert profiles[0]["id"] == "ruida-900x600"

    with open(EXAMPLE, "rb") as f:
        res = client.post("/api/jobs", files={"file": ("peca.dxf", f, "application/dxf")},
                          data={"profile_id": "ruida-900x600"})
    assert res.status_code == 201, res.text
    job_id = res.json()["id"]

    job = wait_status(client, job_id, {"ready_for_params", "failed"})
    assert job["status"] == "ready_for_params", job.get("error")
    assert len(job["params"]["operations"]) == 3
    assert client.get(job["artifacts"]["preview_svg"]).status_code == 200

    bad = json.loads(json.dumps(job["params"]))
    bad["operations"][0]["speed_mm_s"] = -1
    assert client.put(f"/api/jobs/{job_id}/params", json=bad).status_code == 422

    assert client.put(f"/api/jobs/{job_id}/params", json=PARAMS).status_code == 200
    assert client.post(f"/api/jobs/{job_id}/generate").status_code == 202
    job = wait_status(client, job_id, {"ready", "failed"})
    assert job["status"] == "ready", job.get("error")
    assert job["estimate"]["total_s"] > 0

    rd = client.get(f"/api/jobs/{job_id}/file")
    assert rd.status_code == 200
    assert "peca_ruida-900x600.rd" in rd.headers["content-disposition"]
    magic, cmds, speeds = decode_rd(rd.content)
    assert cmds[-1] == b"\xd7"

    # Changing params after generation marks the job stale and blocks download.
    changed = json.loads(json.dumps(PARAMS))
    changed["operations"][0]["speed_mm_s"] = 8
    assert client.put(f"/api/jobs/{job_id}/params", json=changed).json()["stale"] is True

    dup = client.post(f"/api/jobs/{job_id}/duplicate")
    assert dup.status_code == 201
    assert dup.json()["status"] == "ready_for_params"

    assert client.delete(f"/api/jobs/{job_id}").status_code == 204
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_api_rejects_bad_upload(client):
    res = client.post("/api/jobs", files={"file": ("x.exe", b"MZ", "application/octet-stream")},
                      data={"profile_id": "ruida-900x600"})
    assert res.status_code == 400
    res = client.post("/api/jobs", files={"file": ("x.dxf", b"", "application/dxf")},
                      data={"profile_id": "ruida-900x600"})
    assert res.status_code == 400
