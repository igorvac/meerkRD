"""
End-to-end tests for the RD service: headless core and HTTP API.

Run from the repository root:

    python -m pytest service/tests -v
"""

import importlib
import json
import time
from pathlib import Path

import pytest

from meerk40t.ruida.rdjob import RDJob, determine_magic_via_histogram, parse_commands

SERVICE_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = SERVICE_ROOT / "web" / "exemplo.dxf"  # CUT/ENGRAVE/LOGO layers, 120x80mm

PROFILE_PAYLOAD = {
    "id": "ruida-900x600",
    "name": "CO2 90x60",
    "driver": "ruida-beta",
    "bed_mm": [900, 600],
    "home_corner": "top-left",
    "magic": 136,
    "max_speed_mm_s": 500,
    "min_power_pct": 10,
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
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RD_API_KEY", raising=False)
    import service.api.main as main

    importlib.reload(main)
    from fastapi.testclient import TestClient

    with TestClient(main.app) as tc:
        tc.post("/api/machine-profiles", json=PROFILE_PAYLOAD)
        yield tc


def wait_status(client, job_id, wanted, timeout=60):
    deadline = time.time() + timeout
    job = None
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in wanted:
            return job
        time.sleep(0.2)
    raise AssertionError(f"job {job_id} never reached {wanted}: {job and job['status']} {job and job.get('error')}")


def upload(client, files, profile_id="ruida-900x600"):
    file_tuples = [("files", (name, open(path, "rb"), "application/dxf")) for name, path in files]
    res = client.post("/api/jobs", files=file_tuples, data={"profile_id": profile_id})
    for _, (_, fh, _) in file_tuples:
        fh.close()
    return res


def test_upload_analyzes_every_part_then_nest_builds_combined_analysis(client):
    res = upload(client, [("bracket.dxf", EXAMPLE)])
    assert res.status_code == 201, res.text
    job_id = res.json()["id"]

    job = wait_status(client, job_id, {"parts_ready", "failed"})
    assert job["status"] == "parts_ready", job.get("error")
    part = job["parts"][0]
    assert part["status"] == "ready"
    assert part["width_mm"] == pytest.approx(120, abs=0.01)
    assert set(part["layers"]) == {"CUT", "ENGRAVE", "LOGO"}

    res = client.post(f"/api/jobs/{job_id}/nest")
    assert res.status_code == 202, res.text
    job = wait_status(client, job_id, {"ready_for_params", "failed"})
    assert job["status"] == "ready_for_params", job.get("error")
    assert len(job["params"]["operations"]) == 3
    assert len(job["params"]["assignments"]) == 5  # every shape in the file
    assert client.get(job["artifacts"]["preview_svg"]).status_code == 200


def test_two_parts_with_quantity_merge_layers_into_shared_operations(client):
    res = upload(client, [("bracket.dxf", EXAMPLE), ("bracket2.dxf", EXAMPLE)])
    assert res.status_code == 201, res.text
    job_id = res.json()["id"]
    job = wait_status(client, job_id, {"parts_ready", "failed"})
    assert job["status"] == "parts_ready"
    assert all(p["status"] == "ready" for p in job["parts"]), [p["error"] for p in job["parts"]]
    assert len(job["parts"]) == 2
    assert {p["id"] for p in job["parts"]} == {"bracket", "bracket2"}

    # Ask for 3 copies of the first part.
    part_id = job["parts"][0]["id"]
    res = client.put(f"/api/jobs/{job_id}/parts/{part_id}", json={"quantity": 3})
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "parts_ready"  # reset, but parts were already analyzed

    res = client.post(f"/api/jobs/{job_id}/nest")
    assert res.status_code == 202, res.text
    job = wait_status(client, job_id, {"ready_for_params", "failed"})
    assert job["status"] == "ready_for_params", job.get("error")
    assert not job["unplaced_part_ids"]

    # 3 copies of bracket + 1 copy of bracket2 = 4 instances x 2 CUT shapes = 8.
    cut_ops = [op for op in job["analysis"]["operations"] if op["source"].get("layer") == "CUT"]
    assert len(cut_ops) == 1
    assert cut_ops[0]["elements"] == 8


def test_reassigning_an_element_to_a_different_operation_changes_the_rd(client):
    res = upload(client, [("bracket.dxf", EXAMPLE)])
    job_id = res.json()["id"]
    wait_status(client, job_id, {"parts_ready"})
    client.post(f"/api/jobs/{job_id}/nest")
    job = wait_status(client, job_id, {"ready_for_params"})

    params = job["params"]
    engrave_op = next(op for op in params["operations"] if op["type"] == "engrave")
    cut_op = next(op for op in params["operations"] if op["type"] == "cut")
    # Move one element that was auto-assigned to "cut" over to "engrave".
    moved_element = next(eid for eid, op in params["assignments"].items() if op == cut_op["id"])
    params["assignments"][moved_element] = engrave_op["id"]

    res = client.put(f"/api/jobs/{job_id}/params", json=params)
    assert res.status_code == 200, res.text
    assert res.json()["params"]["assignments"][moved_element] == engrave_op["id"]

    res = client.post(f"/api/jobs/{job_id}/generate")
    assert res.status_code == 202, res.text
    job = wait_status(client, job_id, {"ready", "failed"})
    assert job["status"] == "ready", job.get("error")
    # The moved element (a cut line) now has fewer cuts in "cut" and one more in "engrave".
    result_by_id = {op["id"]: op for op in job["result_operations"]}
    assert result_by_id[cut_op["id"]]["elements"] == 1  # 2 cut shapes minus the one we moved
    assert result_by_id[engrave_op["id"]]["elements"] == 3  # 2 engrave shapes plus the one we moved


def test_params_rejects_assignment_to_unknown_operation(client):
    res = upload(client, [("bracket.dxf", EXAMPLE)])
    job_id = res.json()["id"]
    wait_status(client, job_id, {"parts_ready"})
    client.post(f"/api/jobs/{job_id}/nest")
    job = wait_status(client, job_id, {"ready_for_params"})
    params = job["params"]
    params["assignments"][next(iter(params["assignments"]))] = "op_does_not_exist"
    res = client.put(f"/api/jobs/{job_id}/params", json=params)
    assert res.status_code == 422


def test_full_flow_download_and_duplicate(client):
    res = upload(client, [("peca.dxf", EXAMPLE)])
    job_id = res.json()["id"]
    wait_status(client, job_id, {"parts_ready"})
    client.post(f"/api/jobs/{job_id}/nest")
    job = wait_status(client, job_id, {"ready_for_params"})

    bad = json.loads(json.dumps(job["params"]))
    bad["operations"][0]["speed_mm_s"] = -1
    assert client.put(f"/api/jobs/{job_id}/params", json=bad).status_code == 422

    assert client.put(f"/api/jobs/{job_id}/params", json=job["params"]).status_code == 200
    assert client.post(f"/api/jobs/{job_id}/generate").status_code == 202
    job = wait_status(client, job_id, {"ready", "failed"})
    assert job["status"] == "ready", job.get("error")
    assert job["estimate"]["total_s"] > 0

    rd = client.get(f"/api/jobs/{job_id}/file")
    assert rd.status_code == 200
    assert "peca_ruida-900x600.rd" in rd.headers["content-disposition"]
    magic, cmds, speeds = decode_rd(rd.content)
    assert cmds[-1] == b"\xd7"

    changed = json.loads(json.dumps(job["params"]))
    changed["operations"][0]["speed_mm_s"] = 8
    assert client.put(f"/api/jobs/{job_id}/params", json=changed).json()["stale"] is True

    dup = client.post(f"/api/jobs/{job_id}/duplicate")
    assert dup.status_code == 201
    assert dup.json()["status"] == "ready_for_params"

    assert client.delete(f"/api/jobs/{job_id}").status_code == 204
    assert client.get(f"/api/jobs/{job_id}").status_code == 404


def test_removing_the_last_part_is_rejected(client):
    res = upload(client, [("only.dxf", EXAMPLE)])
    job_id = res.json()["id"]
    job = wait_status(client, job_id, {"parts_ready"})
    part_id = job["parts"][0]["id"]
    res = client.delete(f"/api/jobs/{job_id}/parts/{part_id}")
    assert res.status_code == 409


def test_adding_a_part_resets_a_generated_job(client):
    res = upload(client, [("a.dxf", EXAMPLE)])
    job_id = res.json()["id"]
    wait_status(client, job_id, {"parts_ready"})
    client.post(f"/api/jobs/{job_id}/nest")
    job = wait_status(client, job_id, {"ready_for_params"})
    client.put(f"/api/jobs/{job_id}/params", json=job["params"])
    client.post(f"/api/jobs/{job_id}/generate")
    job = wait_status(client, job_id, {"ready"})
    assert job["artifacts"].get("rd")

    with open(EXAMPLE, "rb") as fh:
        res = client.post(f"/api/jobs/{job_id}/parts", files={"files": ("b.dxf", fh, "application/dxf")})
    assert res.status_code == 201, res.text
    job = res.json()
    assert job["status"] in ("analyzing_parts", "parts_ready")
    assert job["params"] is None
    assert job["placements"] is None


def test_api_rejects_bad_upload(client):
    res = client.post(
        "/api/jobs",
        files={"files": ("x.exe", b"MZ", "application/octet-stream")},
        data={"profile_id": "ruida-900x600"},
    )
    assert res.status_code == 400
    res = client.post(
        "/api/jobs",
        files={"files": ("x.dxf", b"", "application/dxf")},
        data={"profile_id": "ruida-900x600"},
    )
    assert res.status_code == 400


def test_changing_the_machine_keeps_parts_and_resets_the_layout(client):
    client.post("/api/machine-profiles", json={**PROFILE_PAYLOAD, "id": "ruida-small", "name": "Pequena", "bed_mm": [300, 200]})
    res = upload(client, [("a.dxf", EXAMPLE)])
    job_id = res.json()["id"]
    wait_status(client, job_id, {"parts_ready"})
    client.put(f"/api/jobs/{job_id}/parts/a", json={"quantity": 2})
    client.post(f"/api/jobs/{job_id}/nest")
    job = wait_status(client, job_id, {"ready_for_params"})
    assert job["analysis"]["bed_mm"] == [900, 600]

    assert client.put(f"/api/jobs/{job_id}/profile", json={"profile_id": "nope"}).status_code == 400

    res = client.put(f"/api/jobs/{job_id}/profile", json={"profile_id": "ruida-small"})
    assert res.status_code == 200, res.text
    job = res.json()
    assert job["profile_id"] == "ruida-small"
    assert job["status"] == "parts_ready"
    assert job["analysis"] is None and job["params"] is None
    assert job["parts"][0]["quantity"] == 2  # part settings survive

    client.post(f"/api/jobs/{job_id}/nest")
    job = wait_status(client, job_id, {"ready_for_params"})
    assert job["analysis"]["bed_mm"] == [300, 200]

    # Same id without force is a no-op; with force it re-nests (profile edited).
    assert client.put(f"/api/jobs/{job_id}/profile", json={"profile_id": "ruida-small"}).json()["status"] == "ready_for_params"
    assert client.put(f"/api/jobs/{job_id}/profile", json={"profile_id": "ruida-small", "force": True}).json()["status"] == "parts_ready"
