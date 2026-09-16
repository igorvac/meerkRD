"""
Bounding-box "shelf" bin packing for laying out multiple parts on a bed.

This is deliberately NOT true irregular nesting (no-fit-polygon / rotation
search over arbitrary angles) - that is a substantially harder problem
(SVGnest/Deepnest-class) that needs careful validation against real
hardware before it can be trusted blindly. Shelf packing on each part's
axis-aligned bounding box, with an optional 90-degree rotation, is a
well-understood, predictable algorithm: easy to verify by hand, and a
reasonable default for laser-cut parts, which are frequently close to
rectangular anyway.
"""

from dataclasses import dataclass, field
from typing import List

EPS = 1e-6


@dataclass
class NestItem:
    id: str  # caller-assigned identifier for this specific instance
    width: float
    height: float
    rotatable: bool = True


@dataclass
class Placement:
    id: str
    x: float
    y: float
    width: float
    height: float
    rotated: bool


@dataclass
class NestResult:
    placements: List[Placement] = field(default_factory=list)
    unplaced: List[str] = field(default_factory=list)
    used_width: float = 0.0
    used_height: float = 0.0


def _orientations(item: NestItem):
    options = [(item.width, item.height, False)]
    if item.rotatable and (item.width, item.height) != (item.height, item.width):
        options.append((item.height, item.width, True))
    return options


def _best_fit(options, predicate):
    """Among options where predicate(w, h) holds, return the one with the
    smallest height (a flatter item keeps the shelf more compact for
    whatever comes next), or None if nothing fits."""
    best = None
    for w, h, rotated in options:
        if predicate(w, h):
            if best is None or h < best[1]:
                best = (w, h, rotated)
    return best


def pack_shelves(
    items: List[NestItem],
    bed_width: float,
    bed_height: float,
    spacing: float = 5.0,
    margin: float = 5.0,
) -> NestResult:
    """
    Greedy shelf packing, largest item first. Each item is tried on the
    current shelf first (in whichever orientation - original or rotated 90
    degrees - fits and is flattest); if neither orientation fits the
    remaining width (or would grow the shelf past the bed height), a new
    shelf is opened above the previous one.

    Coordinates are returned with (0, 0) at the top-left usable corner,
    already inset by `margin` on every side; the caller maps that onto
    whatever origin convention the device itself uses.
    """
    usable_w = bed_width - 2 * margin
    usable_h = bed_height - 2 * margin
    result = NestResult()
    if usable_w <= 0 or usable_h <= 0:
        result.unplaced = [it.id for it in items]
        return result

    ordered = sorted(items, key=lambda it: max(it.width, it.height), reverse=True)

    cursor_x = 0.0
    cursor_y = 0.0
    shelf_h = 0.0

    for it in ordered:
        options = _orientations(it)

        # 1) Try the current shelf without starting a new one.
        fit = _best_fit(
            options,
            lambda w, h: w <= usable_w + EPS
            and cursor_x + w <= usable_w + EPS
            and cursor_y + max(shelf_h, h) <= usable_h + EPS,
        )
        if fit is not None:
            w, h, rotated = fit
            x, y = cursor_x, cursor_y
            cursor_x += w + spacing
            shelf_h = max(shelf_h, h)
        else:
            # 2) Doesn't fit the current shelf - open a new one above it.
            new_shelf_y = cursor_y + shelf_h + (spacing if shelf_h > 0 else 0.0)
            fit = _best_fit(
                options,
                lambda w, h: w <= usable_w + EPS and new_shelf_y + h <= usable_h + EPS,
            )
            if fit is None:
                result.unplaced.append(it.id)
                continue
            w, h, rotated = fit
            cursor_y = new_shelf_y
            cursor_x = w + spacing
            shelf_h = h
            x, y = 0.0, cursor_y

        result.placements.append(
            Placement(id=it.id, x=margin + x, y=margin + y, width=w, height=h, rotated=rotated)
        )
        result.used_width = max(result.used_width, margin + x + w)
        result.used_height = max(result.used_height, margin + cursor_y + shelf_h)

    return result


def expand_quantities(parts) -> List[NestItem]:
    """
    parts: iterable of objects/dicts with id, width, height, quantity,
    rotatable. Returns one NestItem per physical copy, ids suffixed "#1",
    "#2", ... so each instance can be traced back to its source part (the
    text before '#').
    """
    items = []
    for p in parts:
        qty = max(1, int(p["quantity"]))
        for i in range(1, qty + 1):
            items.append(
                NestItem(
                    id=f"{p['id']}#{i}",
                    width=float(p["width"]),
                    height=float(p["height"]),
                    rotatable=bool(p.get("rotatable", True)),
                )
            )
    return items
