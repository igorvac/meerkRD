from service.core.nesting import NestItem, expand_quantities, pack_shelves


def overlaps(a, b):
    ax0, ay0, ax1, ay1 = a.x, a.y, a.x + a.width, a.y + a.height
    bx0, by0, bx1, by1 = b.x, b.y, b.x + b.width, b.y + b.height
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def assert_no_overlaps(placements):
    for i, a in enumerate(placements):
        for b in placements[i + 1 :]:
            assert not overlaps(a, b), f"{a} overlaps {b}"


def assert_within_bed(placements, bed_w, bed_h, margin):
    for p in placements:
        assert p.x >= margin - 1e-6
        assert p.y >= margin - 1e-6
        assert p.x + p.width <= bed_w - margin + 1e-6
        assert p.y + p.height <= bed_h - margin + 1e-6


def test_single_item_fits_top_left():
    items = [NestItem("a", 100, 50)]
    result = pack_shelves(items, bed_width=900, bed_height=600, spacing=5, margin=10)
    assert not result.unplaced
    p = result.placements[0]
    assert p.x == 10 and p.y == 10
    assert (p.width, p.height) == (100, 50)


def test_many_small_squares_pack_without_overlap():
    items = [NestItem(f"sq{i}", 50, 50) for i in range(20)]
    result = pack_shelves(items, bed_width=300, bed_height=300, spacing=2, margin=5)
    assert not result.unplaced
    assert len(result.placements) == 20
    assert_no_overlaps(result.placements)
    assert_within_bed(result.placements, 300, 300, 5)


def test_rotation_lets_a_tall_part_fit_a_shelf():
    # A 40x120 item won't fit a 100-wide shelf upright, but rotated (120x40)
    # its width becomes 120 > 100 too - so use a bed where rotation clearly
    # matters: item taller than wide, bed narrower than the item's width.
    items = [NestItem("tall", width=30, height=150, rotatable=True)]
    result = pack_shelves(items, bed_width=200, bed_height=100, spacing=0, margin=0)
    assert not result.unplaced
    p = result.placements[0]
    assert p.rotated is True
    assert (p.width, p.height) == (150, 30)


def test_item_wider_than_bed_in_every_orientation_is_unplaced():
    items = [NestItem("huge", width=500, height=500, rotatable=True)]
    result = pack_shelves(items, bed_width=300, bed_height=300, spacing=0, margin=0)
    assert result.unplaced == ["huge"]
    assert result.placements == []


def test_overflow_quantity_reports_unplaced_not_a_crash():
    items = [NestItem(f"p{i}", 100, 100) for i in range(50)]
    result = pack_shelves(items, bed_width=300, bed_height=300, spacing=1, margin=1)
    assert result.unplaced, "50 100x100 squares cannot fit a 300x300 bed"
    assert_no_overlaps(result.placements)
    assert_within_bed(result.placements, 300, 300, 1)
    assert len(result.placements) + len(result.unplaced) == 50


def test_expand_quantities_generates_one_item_per_copy():
    parts = [
        {"id": "bracket", "width": 40, "height": 20, "quantity": 3, "rotatable": True},
        {"id": "plate", "width": 80, "height": 80, "quantity": 1, "rotatable": False},
    ]
    items = expand_quantities(parts)
    ids = sorted(i.id for i in items)
    assert ids == ["bracket#1", "bracket#2", "bracket#3", "plate#1"]
    plate = next(i for i in items if i.id == "plate#1")
    assert plate.rotatable is False


def test_mixed_parts_with_quantities_pack_without_overlap():
    parts = [
        {"id": "bracket", "width": 40, "height": 20, "quantity": 6, "rotatable": True},
        {"id": "plate", "width": 80, "height": 80, "quantity": 2, "rotatable": False},
        {"id": "strip", "width": 200, "height": 10, "quantity": 3, "rotatable": True},
    ]
    items = expand_quantities(parts)
    result = pack_shelves(items, bed_width=780, bed_height=580, spacing=5, margin=10)
    assert not result.unplaced
    assert len(result.placements) == len(items)
    assert_no_overlaps(result.placements)
    assert_within_bed(result.placements, 780, 580, 10)


def test_negative_or_zero_usable_area_marks_everything_unplaced():
    items = [NestItem("a", 10, 10)]
    result = pack_shelves(items, bed_width=20, bed_height=20, spacing=0, margin=15)
    assert result.unplaced == ["a"]
