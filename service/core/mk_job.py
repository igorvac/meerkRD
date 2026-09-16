"""
Headless MeerK40t job runner.

Executed as a subprocess by the service worker:

    python -m service.core.mk_job <job_dir> [request.json] [result.json]

Reads the request JSON and writes the result JSON given on the command line
(defaulting to ``<job_dir>/request.json`` / ``<job_dir>/result.json``) plus the
requested artifacts (preview.svg, path.svg, stats.json, job.rd).

This module is the only place that imports the MeerK40t kernel. Everything it
does could be expressed as console commands, but driving the element tree
directly keeps the layer -> operation mapping deterministic and avoids string
interpolation of user-controlled values into the console.

A project can contain several uploaded files ("parts"), each cut any number
of times ("instances" - quantity). Every instance gets its own copy of the
part's geometry (loaded fresh, positioned by the nesting layout computed
separately in ``service/core/nesting.py``) and every individual shape gets a
stable id of the form ``<part_id>#<instance_index>:<shape_index>``, assigned
by this module rather than left to MeerK40t's own counter, so that an
element-to-operation assignment made by the user against one analysis run
still refers to the same shape in a later run (a fresh subprocess/kernel
each time) as long as parts are loaded in the same order - which every
action here does.
"""

import json
import math
import os
import sys
import traceback
from pathlib import Path

from meerk40t.constants import (
    RASTER_B2T,
    RASTER_CROSSOVER,
    RASTER_HATCH,
    RASTER_L2R,
    RASTER_R2L,
    RASTER_T2B,
)
from meerk40t.core.cutcode.cubiccut import CubicCut
from meerk40t.core.cutcode.cutcode import CutCode
from meerk40t.core.cutcode.linecut import LineCut
from meerk40t.core.cutcode.quadcut import QuadCut
from meerk40t.core.cutcode.rastercut import RasterCut
from meerk40t.core.units import UNITS_PER_MM
from meerk40t.internal_plugins import plugin as internal_plugins
from meerk40t.kernel import Kernel
from meerk40t.main import APPLICATION_NAME, APPLICATION_VERSION, parser
from meerk40t.svgelements import Color

from service.core.headless_raster import make_raster

OP_TYPES = {
    "cut": "op cut",
    "engrave": "op engrave",
    "raster": "op raster",
    "image": "op image",
}

RASTER_DIRECTIONS = {
    "top_to_bottom": RASTER_T2B,
    "bottom_to_top": RASTER_B2T,
    "right_to_left": RASTER_R2L,
    "left_to_right": RASTER_L2R,
    "hatch": RASTER_HATCH,
    "crossover": RASTER_CROSSOVER,
}

OP_ID_KEY = "svc_op_id"
LEAF_TYPES_SKIP = ("file", "group", "branch elems", "branch ops", "branch reg", "root")


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def boot_kernel(log):
    args = parser.parse_args(["-z", "-Z", "-X", "-p", "-A"])
    kernel = Kernel(
        APPLICATION_NAME,
        APPLICATION_VERSION,
        "rdservice",
        ansi=False,
        ignore_settings=True,
    )
    kernel.args = args
    kernel.add_plugin(internal_plugins)
    kernel(partial=True)
    kernel.channel("console").watch(log)
    kernel.register("render-op/make_raster", make_raster)
    return kernel


def mm(value):
    return float(value) / UNITS_PER_MM


def configure_device(kernel, profile):
    driver = profile.get("driver", "ruida-beta")
    kernel.console(f"device add {driver}\n")
    device = kernel.device
    bed = profile.get("bed_mm", [900, 600])
    device.bedwidth = f"{float(bed[0])}mm"
    device.bedheight = f"{float(bed[1])}mm"
    for attr in ("flip_x", "flip_y", "swap_xy"):
        if attr in profile:
            setattr(device, attr, bool(profile[attr]))
    if "home_corner" in profile:
        device.home_corner = str(profile["home_corner"])
    if "magic" in profile and hasattr(device, "magic"):
        device.magic = int(profile["magic"])
    device.job_reference = str(profile.get("job_reference", "absolute"))
    device.realize()
    return device


def node_layer(node):
    label = getattr(node, "label", None)
    if label:
        return str(label)
    parent = getattr(node, "parent", None)
    while parent is not None and getattr(parent, "type", "") in ("group", "file"):
        label = getattr(parent, "label", None)
        if label and parent.type == "group":
            return str(label)
        parent = getattr(parent, "parent", None)
    return ""


def color_hex(color):
    if color is None:
        return None
    try:
        if color.value is None:
            return None
        return color.hexrgb
    except AttributeError:
        return None


# --------------------------------------------------------------------------- loading & placement
def leaf_elements_under(node):
    """Depth-first descendant leaf elements (skips file/group containers)."""
    if node.type not in LEAF_TYPES_SKIP:
        yield node
        return
    for child in list(node.children):
        yield from leaf_elements_under(child)


def load_part_instance(kernel, path, part_id, instance_index):
    """
    Load one copy of a part's file into the current document and give every
    shape in it a stable, self-describing id. Returns the wrapping file node.
    """
    elements = kernel.elements
    before = set(elements.elem_branch.children)
    if not elements.load(str(path)):
        raise JobError("load_failed", f"Não foi possível abrir {path.name}.")
    added = [c for c in elements.elem_branch.children if c not in before]
    if not added:
        raise JobError("load_failed", f"O arquivo {path.name} não adicionou geometria.")
    file_node = added[-1]
    for shape_index, leaf in enumerate(leaf_elements_under(file_node)):
        leaf.id = f"{part_id}#{instance_index}:{shape_index}"
    return file_node


def leaves_bounds(leaves):
    boxes = [l.bounds for l in leaves if l.bounds is not None]
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def position_part_instance(elements, file_node, placement):
    """
    placement: {"x_mm": .., "y_mm": .., "rotated": bool} - x/y are the target
    top-left corner of the instance's bounding box, in mm, in the document's
    native (pre-device-transform) coordinate space.
    """
    leaves = list(leaf_elements_under(file_node))
    if not leaves:
        return
    bounds = leaves_bounds(leaves)
    if bounds is None:
        return
    if placement.get("rotated"):
        min_x, min_y, max_x, max_y = bounds
        cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
        for leaf in leaves:
            leaf.matrix.post_rotate(math.pi / 2, cx, cy)
            leaf.modified()
        bounds = leaves_bounds(leaves)
    min_x, min_y, _, _ = bounds
    target_x = float(placement["x_mm"]) * UNITS_PER_MM
    target_y = float(placement["y_mm"]) * UNITS_PER_MM
    dx = target_x - min_x
    dy = target_y - min_y
    if abs(dx) > 1e-6 or abs(dy) > 1e-6:
        elements.translate_node(file_node, dx, dy)


def load_all_parts(kernel, job_dir, parts, placements=None):
    """
    parts: [{"id":..., "file": "relative/path.dxf"}]
    placements: optional [{"part_id":..., "instance_index":..., "x_mm":..., "y_mm":..., "rotated":...}]
                one entry per instance to load; if omitted, each part is
                loaded exactly once, unplaced (used for the lightweight
                per-part analysis before nesting has run).
    Returns the flat list of leaf element nodes across every loaded instance,
    in load order.
    """
    elements = kernel.elements
    leaves = []
    if placements is None:
        for part in parts:
            path = job_dir / part["file"]
            file_node = load_part_instance(kernel, path, part["id"], 0)
            leaves.extend(leaf_elements_under(file_node))
        return leaves

    by_part = {p["id"]: p for p in parts}
    for placement in sorted(placements, key=lambda p: (p["part_id"], p["instance_index"])):
        part = by_part.get(placement["part_id"])
        if part is None:
            continue
        path = job_dir / part["file"]
        file_node = load_part_instance(kernel, path, part["id"], placement["instance_index"])
        position_part_instance(elements, file_node, placement)
        leaves.extend(leaf_elements_under(file_node))
    return leaves


# --------------------------------------------------------------------------- element/operation info
def element_info(leaves):
    infos = []
    for node in leaves:
        try:
            bounds = node.bounds
        except Exception:  # noqa: BLE001 - bounds can fail on degenerate nodes
            bounds = None
        part_id, _, _ = str(node.id).partition("#")
        infos.append(
            {
                "id": node.id,
                "part_id": part_id,
                "type": node.type,
                "layer": node_layer(node),
                "stroke": color_hex(getattr(node, "stroke", None)),
                "fill": color_hex(getattr(node, "fill", None)),
                "bbox_mm": [mm(b) for b in bounds] if bounds else None,
                "assigned": len(node._references) > 0,
            }
        )
    return infos


def suggested_type(node_info):
    layer = (node_info["layer"] or "").upper()
    if node_info["type"] == "elem image":
        return "image"
    for key, value in (("RASTER", "raster"), ("ENGRAVE", "engrave"), ("CUT", "cut")):
        if key in layer:
            return value
    if node_info["fill"] and node_info["type"] != "elem image":
        return "raster"
    return "cut"


def detect_operations(infos):
    """
    Groups elements by layer name (falling back to stroke color), merging
    same-named layers across every part/instance - so e.g. every uploaded
    part's own "CUT" layer becomes one combined Cut operation. Returns both
    the operation groups and a default element_id -> operation_id mapping.
    """
    groups = {}
    for info in infos:
        key = ("layer", info["layer"]) if info["layer"] else ("color", info["stroke"] or "")
        group = groups.setdefault(
            key,
            {
                "source": {key[0]: key[1]},
                "type": suggested_type(info),
                "color": info["stroke"] or info["fill"] or "#000000",
                "elements": 0,
                "element_ids": [],
                "element_types": set(),
            },
        )
        group["elements"] += 1
        group["element_ids"].append(info["id"])
        group["element_types"].add(info["type"].replace("elem ", ""))
    result = []
    assignments = {}
    for index, group in enumerate(groups.values()):
        op_id = f"op_{index + 1}"
        group["element_types"] = sorted(group["element_types"])
        group["id"] = op_id
        for eid in group["element_ids"]:
            assignments[eid] = op_id
        del group["element_ids"]
        result.append(group)
    return result, assignments


def union_bbox(infos):
    boxes = [i["bbox_mm"] for i in infos if i["bbox_mm"]]
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


# --------------------------------------------------------------------------- actions
def analyze_part(kernel, job_dir, request):
    """Lightweight, single-part analysis used right after a file is uploaded:
    just enough (bounding box, element/layer summary) to add it to the parts
    list and feed the nesting step. Does not touch the device profile."""
    part = request["part"]
    leaves = load_all_parts(kernel, job_dir, [part], placements=None)
    if not leaves:
        raise JobError("empty_file", "O arquivo não contém geometria utilizável.")
    infos = element_info(leaves)
    bbox = union_bbox(infos)
    if bbox is None:
        raise JobError("empty_file", "O arquivo não contém geometria com dimensões válidas.")
    layers = sorted({i["layer"] for i in infos if i["layer"]})
    return {
        "elements": len(infos),
        "layers": layers,
        "bbox_mm": bbox,
        "width_mm": bbox[2] - bbox[0],
        "height_mm": bbox[3] - bbox[1],
    }


def analyze_nested(kernel, job_dir, request):
    """Loads every part instance at its nested position and reports the
    combined element list, suggested (default) operation grouping, and a
    preview.svg of the whole laid-out sheet."""
    profile = request["profile"]
    configure_device(kernel, profile)
    elements = kernel.elements
    leaves = load_all_parts(kernel, job_dir, request["parts"], request.get("placements"))
    if not leaves:
        raise JobError("empty_file", "Nenhuma peça pôde ser carregada.")
    elements.validate_ids()  # covers any node our own numbering didn't reach (e.g. regmarks)
    infos = element_info(leaves)
    operations, assignments = detect_operations(infos)
    preview = job_dir / "preview.svg"
    elements.save(str(preview), version="plain")
    bbox = union_bbox(infos)
    bed = profile.get("bed_mm", [900, 600])
    return {
        "elements": infos,
        "operations": operations,
        "assignments": assignments,
        "bbox_mm": bbox,
        "bed_mm": bed,
        "outside_bed": bool(
            bbox
            and (bbox[0] < 0 or bbox[1] < 0 or bbox[2] > bed[0] or bbox[3] > bed[1])
        ),
        "artifacts": {"preview_svg": "preview.svg"},
    }


def build_operations(kernel, params):
    """Rebuilds the operations tree from explicit params.operations. Element
    assignment happens separately in assign_elements() - no layer/color
    re-matching, so a manual reassignment always wins."""
    elements = kernel.elements
    for op in list(elements.ops()):
        op.remove_node(children=True, destroy=True)
    ops_out = []
    ordered = sorted(params["operations"], key=lambda o: o.get("order", 0))
    op_nodes = {}
    for spec in ordered:
        op_type = OP_TYPES.get(spec.get("type", "cut"))
        if op_type is None:
            raise JobError("bad_params", f"Tipo de operação inválido: {spec.get('type')}")
        op = elements.op_branch.add(type=op_type)
        op.label = spec.get("label") or spec["id"]
        op.output = bool(spec.get("enabled", True))
        op.speed = float(spec["speed_mm_s"])
        op.power = int(round(float(spec["power_pct"]) * 10))
        passes = int(spec.get("passes", 1) or 1)
        op.passes_custom = passes > 1
        op.passes = passes
        if op_type == "op cut" and "kerf_mm" in spec:
            op.kerf = float(spec["kerf_mm"])
        if op_type in ("op raster", "op image"):
            if "dpi" in spec:
                op.dpi = int(spec["dpi"])
            direction = spec.get("direction")
            if direction in RASTER_DIRECTIONS:
                op.raster_direction = RASTER_DIRECTIONS[direction]
        color = spec.get("color")
        if color:
            op.color = Color(color)
        op.settings[OP_ID_KEY] = spec["id"]
        op_nodes[spec["id"]] = op
        ops_out.append({"id": spec["id"], "elements": 0, "enabled": op.output})
    ops_by_id = {o["id"]: o for o in ops_out}
    return op_nodes, ops_by_id


def assign_elements(elements_by_id, op_nodes, ops_by_id, assignments):
    for element_id, op_id in assignments.items():
        node = elements_by_id.get(element_id)
        op = op_nodes.get(op_id)
        if node is None or op is None:
            continue
        op.add_reference(node)
        ops_by_id[op_id]["elements"] += 1


def apply_optimization(kernel, params):
    planner = kernel.planner
    opt = params.get("optimize", {})
    enabled = bool(opt.get("enabled", True))
    planner.opt_reduce_travel = enabled and bool(opt.get("reduce_travel", True))
    planner.opt_inner_first = enabled and bool(opt.get("inner_first", True))
    planner.opt_inners_grouped = enabled and bool(opt.get("inner_first", True))
    planner.opt_merge_passes = enabled and bool(opt.get("merge_passes", False))
    planner.opt_merge_ops = enabled and bool(opt.get("merge_ops", False))
    return enabled


def cut_duration(cut):
    cs = cut.settings
    native_mm = cs.get("native_mm", 39.3701)
    default_speed = cs.get("speed", 0) * native_mm
    native_speed = cs.get("native_speed", default_speed) * 0.91
    length = cut.internal_length() + cut.internal_travel()
    if native_speed == 0:
        return 0.0, length
    return length / native_speed + cut.extra(), length


def statistics(cutcodes, ops_out):
    per_op = {o["id"]: {"cut_s": 0.0, "cut_mm": 0.0, "cuts": 0} for o in ops_out}
    totals = {"total_s": 0.0, "cut_s": 0.0, "travel_s": 0.0, "cut_mm": 0.0, "travel_mm": 0.0}
    for cutcode in cutcodes:
        stats = cutcode.provide_statistics(include_start=True)
        last = stats[-1]
        native_mm = 39.3701
        for cut in cutcode.flat():
            native_mm = cut.settings.get("native_mm", native_mm)
            op_id = cut.settings.get(OP_ID_KEY)
            duration, length = cut_duration(cut)
            entry = per_op.setdefault(op_id, {"cut_s": 0.0, "cut_mm": 0.0, "cuts": 0})
            entry["cut_s"] += duration
            entry["cut_mm"] += length / native_mm
            entry["cuts"] += 1
        totals["cut_s"] += last["total_time_cut"] + last["total_time_extra"]
        totals["travel_s"] += last["total_time_travel"]
        totals["cut_mm"] += last["total_distance_cut"] / native_mm
        totals["travel_mm"] += last["total_distance_travel"] / native_mm
    totals["total_s"] = totals["cut_s"] + totals["travel_s"]
    by_op = {
        op_id: {
            "cut_s": round(entry["cut_s"], 1),
            "cut_mm": round(entry["cut_mm"], 1),
            "cuts": entry["cuts"],
        }
        for op_id, entry in per_op.items()
    }
    return {k: round(v, 1) for k, v in totals.items()}, by_op


def path_svg(device, cutcodes, ops_out, bed, out_path):
    colors = {}
    palette = ["#d93025", "#1a73e8", "#188038", "#e37400", "#9334e6", "#0b8043"]
    for index, op in enumerate(ops_out):
        colors[op["id"]] = palette[index % len(palette)]

    def pt(x, y):
        sx, sy = device.view.iposition(x, y)
        return mm(sx), mm(sy)

    travel = []
    cuts = {}
    last_end = None
    for cutcode in cutcodes:
        for cut in cutcode.flat():
            op_id = cut.settings.get(OP_ID_KEY, "")
            start = pt(*cut.start)
            end = pt(*cut.end)
            if last_end is not None and last_end != start:
                travel.append(f"M{last_end[0]:.3f},{last_end[1]:.3f}L{start[0]:.3f},{start[1]:.3f}")
            d = cuts.setdefault(op_id, [])
            if isinstance(cut, LineCut):
                d.append(f"M{start[0]:.3f},{start[1]:.3f}L{end[0]:.3f},{end[1]:.3f}")
            elif isinstance(cut, QuadCut):
                c = pt(*cut.c())
                d.append(f"M{start[0]:.3f},{start[1]:.3f}Q{c[0]:.3f},{c[1]:.3f} {end[0]:.3f},{end[1]:.3f}")
            elif isinstance(cut, CubicCut):
                c1 = pt(*cut.c1())
                c2 = pt(*cut.c2())
                d.append(
                    f"M{start[0]:.3f},{start[1]:.3f}C{c1[0]:.3f},{c1[1]:.3f} "
                    f"{c2[0]:.3f},{c2[1]:.3f} {end[0]:.3f},{end[1]:.3f}"
                )
            elif isinstance(cut, RasterCut):
                try:
                    x0, y0 = pt(cut.offset_x, cut.offset_y)
                    x1, y1 = pt(
                        cut.offset_x + cut.width * cut.step_x,
                        cut.offset_y + cut.height * cut.step_y,
                    )
                    d.append(
                        f"M{x0:.3f},{y0:.3f}H{x1:.3f}V{y1:.3f}H{x0:.3f}Z"
                    )
                except (AttributeError, TypeError):
                    d.append(f"M{start[0]:.3f},{start[1]:.3f}L{end[0]:.3f},{end[1]:.3f}")
            else:
                d.append(f"M{start[0]:.3f},{start[1]:.3f}L{end[0]:.3f},{end[1]:.3f}")
            last_end = end
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {bed[0]} {bed[1]}" '
        f'width="{bed[0]}mm" height="{bed[1]}mm">',
        f'<rect class="bed" x="0" y="0" width="{bed[0]}" height="{bed[1]}" fill="none"/>',
        f'<path class="travel" d="{" ".join(travel)}" fill="none" stroke="#9aa0a6" '
        'stroke-width="0.3" stroke-dasharray="1.5 1" vector-effect="non-scaling-stroke"/>',
    ]
    for op_id, d in cuts.items():
        color = colors.get(op_id, "#202124")
        parts.append(
            f'<path class="cut" data-op="{op_id}" d="{" ".join(d)}" fill="none" '
            f'stroke="{color}" stroke-width="0.4" vector-effect="non-scaling-stroke"/>'
        )
    parts.append("</svg>")
    out_path.write_text("\n".join(parts), encoding="utf-8")
    return colors


def warnings_for(profile, params, infos, ops_out, bbox, unplaced_parts=None):
    warnings = []
    bed = profile.get("bed_mm", [900, 600])
    if bbox and (bbox[0] < 0 or bbox[1] < 0 or bbox[2] > bed[0] or bbox[3] > bed[1]):
        warnings.append(
            {
                "code": "outside_bed",
                "severity": "critical",
                "message": "Há geometria fora da área útil da máquina.",
            }
        )
    if unplaced_parts:
        warnings.append(
            {
                "code": "nesting_overflow",
                "severity": "critical",
                "count": len(unplaced_parts),
                "message": (
                    f"{len(unplaced_parts)} peça(s) não couberam na mesa e não serão "
                    "incluídas: reduza a quantidade ou use uma chapa maior."
                ),
            }
        )
    text_nodes = sum(1 for i in infos if i["type"] == "elem text")
    if text_nodes:
        warnings.append(
            {
                "code": "text_not_supported",
                "severity": "normal",
                "count": text_nodes,
                "message": (
                    f"{text_nodes} texto(s) não serão gravados: converta texto em "
                    "curvas no seu CAD antes de enviar."
                ),
            }
        )
    unassigned = sum(1 for i in infos if not i["assigned"])
    if unassigned:
        warnings.append(
            {
                "code": "unassigned_elements",
                "severity": "normal",
                "count": unassigned,
                "message": f"{unassigned} elemento(s) sem operação não serão cortados.",
            }
        )
    max_speed = profile.get("max_speed_mm_s")
    min_power = profile.get("min_power_pct")
    for spec in params["operations"]:
        if max_speed and float(spec["speed_mm_s"]) > float(max_speed):
            warnings.append(
                {
                    "code": "speed_too_high",
                    "severity": "critical",
                    "operation": spec["id"],
                    "message": f"Velocidade acima do máximo do perfil ({max_speed} mm/s).",
                }
            )
        if min_power and float(spec["power_pct"]) < float(min_power) and spec.get("enabled", True):
            warnings.append(
                {
                    "code": "power_too_low",
                    "severity": "normal",
                    "operation": spec["id"],
                    "message": f"Potência abaixo de {min_power} % pode não acender o tubo CO2.",
                }
            )
    for op in ops_out:
        if op["elements"] == 0 and op["enabled"]:
            warnings.append(
                {
                    "code": "empty_operation",
                    "severity": "normal",
                    "operation": op["id"],
                    "message": "Operação sem elementos atribuídos.",
                }
            )
    return warnings


def generate(kernel, job_dir, request):
    profile = request["profile"]
    params = request["params"]
    device = configure_device(kernel, profile)
    elements = kernel.elements
    leaves = load_all_parts(kernel, job_dir, request["parts"], request.get("placements"))
    if not leaves:
        raise JobError("empty_file", "Nenhuma peça pôde ser carregada.")
    elements.validate_ids()
    infos = element_info(leaves)
    elements_by_id = {info["id"]: node for info, node in zip(infos, leaves)}
    op_nodes, ops_by_id = build_operations(kernel, params)
    assign_elements(elements_by_id, op_nodes, ops_by_id, params.get("assignments", {}))
    infos = element_info(leaves)
    ops_out = list(ops_by_id.values())
    optimized = apply_optimization(kernel, params)
    steps = "clear copy preprocess validate blob"
    if optimized:
        steps += " preopt optimize"
    kernel.console(f"plan0 {steps}\n")
    plan = kernel.planner.get_or_make_plan("0")
    cutcodes = [item for item in plan.plan if isinstance(item, CutCode)]
    if not cutcodes or all(len(list(c.flat())) == 0 for c in cutcodes):
        raise JobError("nothing_to_burn", "Nenhuma operação ativa contém elementos.")
    bed = profile.get("bed_mm", [900, 600])
    totals, by_op = statistics(cutcodes, ops_out)
    colors = path_svg(device, cutcodes, ops_out, bed, job_dir / "path.svg")
    os.chdir(job_dir)
    kernel.console("plan0 save_job job.rd\n")
    rd = job_dir / "job.rd"
    if not rd.exists() or rd.stat().st_size < 16:
        raise JobError("export_failed", "O driver não gerou um arquivo válido.")
    stats = {"estimate": {**totals, "by_operation": by_op}, "colors": colors}
    (job_dir / "stats.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")
    bbox = union_bbox(infos)
    return {
        "operations": ops_out,
        "estimate": stats["estimate"],
        "colors": colors,
        "bbox_mm": bbox,
        "warnings": warnings_for(profile, params, infos, ops_out, bbox, request.get("unplaced_parts")),
        "artifacts": {
            "rd": "job.rd",
            "path_svg": "path.svg",
            "stats": "stats.json",
            "rd_bytes": rd.stat().st_size,
        },
    }


ACTIONS = {
    "analyze_part": analyze_part,
    "analyze_nested": analyze_nested,
    "generate": generate,
}


def main(argv):
    job_dir = Path(argv[1]).resolve()
    request_path = Path(argv[2]) if len(argv) > 2 else job_dir / "request.json"
    result_path = Path(argv[3]) if len(argv) > 3 else job_dir / "result.json"
    request = json.loads(request_path.read_text(encoding="utf-8"))
    log_lines = []

    def log(message):
        log_lines.append(str(message))

    result = {"ok": False, "action": request.get("action")}
    kernel = None
    try:
        kernel = boot_kernel(log)
        handler = ACTIONS.get(request.get("action"))
        if handler is None:
            raise JobError("bad_request", f"Ação desconhecida: {request.get('action')}")
        result.update(handler(kernel, job_dir, request))
        result["ok"] = True
    except JobError as e:
        result["error"] = {"code": e.code, "message": str(e)}
    except Exception as e:  # noqa: BLE001 - report anything to the caller
        result["error"] = {
            "code": "internal",
            "message": f"{type(e).__name__}: {e}",
            "trace": traceback.format_exc(),
        }
    finally:
        result["log"] = log_lines[-200:]
        result_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        if kernel is not None:
            try:
                kernel.console("quit\n")
            except Exception:  # noqa: BLE001
                pass
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
