"""
Pillow-based replacement for the wxPython ``render-op/make_raster`` renderer.

The GUI registers ``LaserRender.make_raster`` which rasterizes vector nodes for
``op raster`` planning. Without wxPython that lookup is empty and raster
operations silently produce nothing. This module provides the same contract
using Pillow and the node geometry (Geomstr), which is enough for filled and
stroked shapes. Text nodes are skipped: they need font rendering that only the
GUI provides, so text must be converted to curves before upload.
"""

from math import ceil

from PIL import Image, ImageDraw

from meerk40t.svgelements import Matrix

RASTERIZABLE = (
    "elem path",
    "elem rect",
    "elem ellipse",
    "elem polyline",
    "elem line",
    "elem image",
)


def _node_bounds(node):
    bb = getattr(node, "paint_bounds", None)
    if bb is None:
        bb = getattr(node, "bounds", None)
    return bb


def _color_tuple(color, default):
    if color is None:
        return default
    try:
        if color.value is None:
            return default
        return (color.red, color.green, color.blue)
    except AttributeError:
        return default


def _subpaths(geometry):
    current = []
    for point in geometry.as_interpolated_points(interpolate=64):
        if point is None:
            if len(current) > 1:
                yield current
            current = []
            continue
        current.append((point.real, point.imag))
    if len(current) > 1:
        yield current


def _draw_node(draw, node, matrix, scale):
    if node.type == "elem image":
        return
    geometry = node.as_geometry()
    geometry.transform(matrix)
    fill = _color_tuple(getattr(node, "fill", None), None)
    stroke = _color_tuple(getattr(node, "stroke", None), None)
    stroke_width = getattr(node, "stroke_width", None)
    if getattr(node, "stroke_scaled", True) and stroke_width:
        width = max(1, int(round(abs(stroke_width) * scale)))
    else:
        width = 1
    for points in _subpaths(geometry):
        if fill is not None and len(points) > 2:
            draw.polygon(points, fill=fill)
        if stroke is not None:
            draw.line(points, fill=stroke, width=width)


def make_raster(
    nodes,
    bounds,
    width=None,
    height=None,
    bitmap=False,
    step_x=1,
    step_y=1,
    keep_ratio=False,
):
    if bounds is None:
        return None
    step_x = step_x or 1
    step_y = step_y or 1
    node_list = [nodes] if not isinstance(nodes, (tuple, list)) else list(nodes)
    x_min = y_min = float("inf")
    x_max = y_max = -float("inf")
    for node in node_list:
        bb = _node_bounds(node)
        if bb is None:
            continue
        x_min, y_min = min(x_min, bb[0]), min(y_min, bb[1])
        x_max, y_max = max(x_max, bb[2]), max(y_max, bb[3])
    if x_min == float("inf"):
        x_min, y_min, x_max, y_max = bounds
    raster_width = max(x_max - x_min, 1)
    raster_height = max(y_max - y_min, 1)
    if width is None:
        width = raster_width / step_x
    if height is None:
        height = raster_height / step_y
    width = max(width, 1)
    height = max(height, 1)
    pixel_w = int(ceil(abs(width)))
    pixel_h = int(ceil(abs(height)))
    if pixel_w * pixel_h > 64_000_000:
        raise MemoryError("Raster too large")

    scale_x = width / raster_width
    scale_y = height / raster_height
    if keep_ratio:
        scale_x = scale_y = min(scale_x, scale_y)
    matrix = Matrix()
    matrix.post_translate(-x_min, -y_min)
    matrix.post_scale(scale_x, scale_y)
    if scale_y < 0:
        matrix.pre_translate(0, -raster_height)
    if scale_x < 0:
        matrix.pre_translate(-raster_width, 0)

    image = Image.new("RGB", (pixel_w, pixel_h), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for node in node_list:
        if node.type == "reference":
            node = node.node
        if node.type not in RASTERIZABLE:
            continue
        try:
            _draw_node(draw, node, matrix, abs(scale_x))
        except (AttributeError, TypeError, ValueError):
            continue
    return image
