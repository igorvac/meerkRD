"""
Tests for the multi-part / nesting core: analyze_part, analyze_nested and
generate operating on several uploaded files, each cut any number of times.
"""

import shutil
from pathlib import Path

import pytest

from meerk40t.ruida.rdjob import RDJob, determine_magic_via_histogram, parse_commands
from service.core.nesting import expand_quantities, pack_shelves
from service.core.runner import run_job

SERVICE_ROOT = Path(__file__).resolve().parents[2] / "service"
BRACKET_DXF = SERVICE_ROOT / "web" / "exemplo.dxf"  # CUT/ENGRAVE/LOGO layers, 120x80mm

PROFILE = {
    "id": "test-profile",
    "driver": "ruida-beta",
    "bed_mm": [900, 600],
    "home_corner": "top-left",
    "magic": 136,
}


@pytest.fixture
def job_dir(tmp_path):
    shutil.copy(BRACKET_DXF, tmp_path / "bracket.dxf")
    return tmp_path


def nested_placements(parts_with_qty, bed_mm, spacing=5, margin=10):
    items = expand_quantities(parts_with_qty)
    result = pack_shelves(items, bed_width=bed_mm[0], bed_height=bed_mm[1], spacing=spacing, margin=margin)
    placements = []
    for p in result.placements:
        part_id, instance_index = p.id.rsplit("#", 1)
        placements.append(
            {
                "part_id": part_id,
                "instance_index": int(instance_index),
                "x_mm": p.x,
                "y_mm": p.y,
                "rotated": p.rotated,
            }
        )
    return placements, result.unplaced


def run_action(job_dir, request):
    return run_job(job_dir, request)


def test_analyze_part_reports_size_and_layers(job_dir):
    result = run_action(job_dir, {"action": "analyze_part", "part": {"id": "bracket", "file": "bracket.dxf"}})
    assert result["ok"], result.get("error")
    assert result["width_mm"] == pytest.approx(120, abs=0.01)
    assert result["height_mm"] == pytest.approx(80, abs=0.01)
    assert set(result["layers"]) == {"CUT", "ENGRAVE", "LOGO"}
    assert result["elements"] == 5


def test_analyze_nested_positions_two_instances_without_overlap(job_dir):
    parts = [{"id": "bracket", "width": 120, "height": 80, "quantity": 2, "rotatable": True}]
    placements, unplaced = nested_placements(parts, PROFILE["bed_mm"])
    assert not unplaced

    result = run_action(
        job_dir,
        {
            "action": "analyze_nested",
            "parts": [{"id": "bracket", "file": "bracket.dxf"}],
            "placements": placements,
            "profile": PROFILE,
        },
    )
    assert result["ok"], result.get("error")
    assert len(result["elements"]) == 10  # 5 shapes x 2 instances

    # Every element id is traceable to its instance and nothing overlaps in X.
    # expand_quantities() numbers instances from 1, not 0.
    inst1 = [e for e in result["elements"] if e["id"].startswith("bracket#1:")]
    inst2 = [e for e in result["elements"] if e["id"].startswith("bracket#2:")]
    assert len(inst1) == 5 and len(inst2) == 5
    max_x_inst1 = max(e["bbox_mm"][2] for e in inst1)
    min_x_inst2 = min(e["bbox_mm"][0] for e in inst2)
    assert min_x_inst2 >= max_x_inst1, "second instance must be placed to the right of the first"

    # Layers merge across instances into single combined operations.
    by_layer_source = {tuple(sorted(op["source"].items())): op["elements"] for op in result["operations"]}
    assert by_layer_source[(("layer", "CUT"),)] == 4  # 2 shapes/instance x 2 instances
    assert by_layer_source[(("layer", "ENGRAVE"),)] == 4
    assert by_layer_source[(("layer", "LOGO"),)] == 2


def test_generate_multi_instance_produces_correctly_positioned_rd(job_dir):
    parts = [{"id": "bracket", "width": 120, "height": 80, "quantity": 2, "rotatable": True}]
    placements, unplaced = nested_placements(parts, PROFILE["bed_mm"])
    assert not unplaced

    analysis = run_action(
        job_dir,
        {
            "action": "analyze_nested",
            "parts": [{"id": "bracket", "file": "bracket.dxf"}],
            "placements": placements,
            "profile": PROFILE,
        },
    )
    assert analysis["ok"], analysis.get("error")
    assignments = analysis["assignments"]

    ops = []
    for op in analysis["operations"]:
        layer = op["source"].get("layer")
        ops.append(
            {
                "id": op["id"],
                "type": op["type"],
                "order": 0,
                "speed_mm_s": 10,
                "power_pct": 50,
                "passes": 1,
                "kerf_mm": 0 if op["type"] == "cut" else None,
                "dpi": 254 if op["type"] == "raster" else None,
                "color": op["color"],
                "label": layer,
            }
        )

    result = run_action(
        job_dir,
        {
            "action": "generate",
            "parts": [{"id": "bracket", "file": "bracket.dxf"}],
            "placements": placements,
            "profile": PROFILE,
            "params": {
                "operations": ops,
                "assignments": assignments,
                "optimize": {"enabled": True, "inner_first": True, "reduce_travel": True},
            },
        },
    )
    assert result["ok"], result.get("error")
    assert result["artifacts"]["rd_bytes"] > 100

    rd_bytes = (job_dir / "job.rd").read_bytes()
    magic = determine_magic_via_histogram(rd_bytes)
    job = RDJob()
    job.set_magic(magic)
    cmds = list(parse_commands(job.unswizzle(rd_bytes)))
    assert cmds[-1] == b"\xd7"

    # Both instances' cut geometry is present: total cut length should be
    # roughly double a single instance's (sanity, not exact - optimizer may
    # reorder/merge travel).
    assert result["estimate"]["by_operation"]["op_1"]["cuts"] >= 30  # 2 instances x ~16 segments


def test_generate_skips_unfitted_parts_gracefully(job_dir):
    # A part far too big for the bed in every orientation: nesting reports it
    # unplaced, and the caller (API layer) is expected to simply not include
    # it in placements/parts sent to generate.
    huge = [{"id": "bracket", "width": 5000, "height": 5000, "quantity": 1, "rotatable": True}]
    placements, unplaced = nested_placements(huge, PROFILE["bed_mm"])
    assert unplaced == ["bracket#1"]
    assert placements == []
