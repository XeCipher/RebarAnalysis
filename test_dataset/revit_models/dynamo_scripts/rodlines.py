import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitServices')

from Autodesk.Revit.DB import *
from Autodesk.Revit.DB.Structure import *
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager
import json
import os

# ── Read JSON ──────────────────────────────────────────────
json_path = os.path.join(os.path.expanduser("~"), "Downloads", "rod_lines.json")

if not os.path.exists(json_path):
    OUT = "ERROR: File not found at " + json_path
else:
    with open(json_path, "r") as f:
        data = json.load(f)

    reset      = data.get("reset", False)
    lines_data = data.get("lines", [])

    doc = DocumentManager.Instance.CurrentDBDocument
    active_view = doc.ActiveView

    # ── Get all 8 rod world positions ─────────────────────────
    rebar_sets = list(
        FilteredElementCollector(doc)
        .OfClass(Rebar)
        .WhereElementIsNotElementType()
        .ToElements()
    )
    rebar_sets.sort(key=lambda r: r.Id.Value)

    # Frontend perimeter order → Revit rod number
    FRONTEND_TO_REVIT = {
        1: 1,
        2: 2,
        3: 3,
        4: 4,
        5: 8,
        6: 7,
        7: 6,
	8: 5
    }

    # Build dict: rod_number (1-8) -> XYZ world position
    rod_positions = {}

    for s_idx, rebar_set in enumerate(rebar_sets):
        base_curves = list(rebar_set.GetCenterlineCurves(
            False, False, False,
            MultiplanarOption.IncludeOnlyPlanarCurves, 0))
        base_point = base_curves[0].Evaluate(0.5, True)
        world_x = base_point.X
        world_y = base_point.Y

        accessor = rebar_set.GetShapeDrivenAccessor()

        for b_idx in range(4):
            rod_number = s_idx * 4 + b_idx + 1  # 1 to 8
            local_offset_y = accessor.GetBarPositionTransform(b_idx).Origin.Y
            rod_positions[rod_number] = (world_x, world_y + local_offset_y)

    # ── Get draw Z from view ───────────────────────────────────
    view_bb = active_view.get_BoundingBox(None)
    cz = view_bb.Max.Z - 0.05

    # ── Status to Color mapping ────────────────────────────────
    def get_color(status):
        if status == "Acceptable":
            return Color(0, 200, 0)       # Green
        elif status == "Minor Mismatch":
            return Color(255, 200, 0)     # Yellow
        elif status == "Not Acceptable":
            return Color(255, 0, 0)       # Red
        else:
            return Color(180, 180, 180)   # Grey for NA

    TransactionManager.Instance.EnsureInTransaction(doc)

    # ── Always delete ALL previous model curves ────────────────
    all_lines = list(
        FilteredElementCollector(doc)
        .OfCategory(BuiltInCategory.OST_Lines)
        .WhereElementIsNotElementType()
        .ToElements()
    )
    for el in all_lines:
        try:
            doc.Delete(el.Id)
        except:
            pass

    # ── Reset: just clear, don't draw ─────────────────────────
    if reset:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Reset done. All lines cleared."

    # ── Draw lines between rods ────────────────────────────────
    else:
        sketch_plane = SketchPlane.Create(
            doc,
            Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ(0, 0, cz))
        )

        drawn   = 0
        skipped = 0

        for entry in lines_data:
            from_rod = FRONTEND_TO_REVIT.get(entry.get("from"))
            to_rod   = FRONTEND_TO_REVIT.get(entry.get("to"))
            status   = entry.get("status", "NA")

            if from_rod not in rod_positions or to_rod not in rod_positions:
                skipped += 1
                continue

            x1, y1 = rod_positions[from_rod]
            x2, y2 = rod_positions[to_rod]

            p1 = XYZ(x1, y1, cz)
            p2 = XYZ(x2, y2, cz)

            # Create line between the two rod centers
            line = Line.CreateBound(p1, p2)
            mc   = doc.Create.NewModelCurve(line, sketch_plane)

            # Apply color override
            color    = get_color(status)
            override = OverrideGraphicSettings()
            override.SetProjectionLineColor(color)
            override.SetProjectionLineWeight(5)
            active_view.SetElementOverrides(mc.Id, override)

            drawn += 1

        TransactionManager.Instance.TransactionTaskDone()

        OUT = "Done! Drew " + str(drawn) + " lines. Skipped " + str(skipped) + " invalid entries."