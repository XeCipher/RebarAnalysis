import clr
import math
import json
import os

clr.AddReference('RevitAPI')
clr.AddReference('RevitServices')

from Autodesk.Revit.DB import *
from Autodesk.Revit.DB.Structure import *
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager

json_path = os.path.join(os.path.expanduser("~"), "Downloads", "rod_lines.json")

if not os.path.exists(json_path):
    OUT = "ERROR: File not found at " + json_path
else:
    with open(json_path, "r") as f:
        data = json.load(f)

    reset      = data.get("reset", False)
    COLUMN_ID  = data.get("column_id", "C8")
    lines_data = data.get("lines", [])

    doc = DocumentManager.Instance.CurrentDBDocument
    active_view = doc.ActiveView

    rebar_elements = list(
        FilteredElementCollector(doc)
        .OfClass(Rebar)
        .WhereElementIsNotElementType()
        .ToElements()
    )

    column_rebar = []
    for r in rebar_elements:
        mark_param = r.LookupParameter("Host Mark")
        if mark_param and mark_param.AsString() == COLUMN_ID:
            column_rebar.append(r)

    # 1. Extract ONLY Vertical Rods (Ignore Stirrups)
    raw_rods = []
    for rs in column_rebar:
        curves = list(rs.GetCenterlineCurves(False, False, False, MultiplanarOption.IncludeOnlyPlanarCurves, 0))
        if not curves: continue
        
        # Check if the bar is vertical by looking at the Z difference of its endpoints
        p_start = curves[0].GetEndPoint(0)
        p_end = curves[0].GetEndPoint(1)
        
        # If Z difference is very small, it's a horizontal stirrup. Skip it!
        if abs(p_start.Z - p_end.Z) < 0.5:
            continue
            
        base_point = curves[0].Evaluate(0.5, True)
        accessor = rs.GetShapeDrivenAccessor()
        count = rs.Quantity
        
        for b_idx in range(count):
            transform = accessor.GetBarPositionTransform(b_idx)
            # Apply both X and Y layout offsets to the base point
            tx = base_point.X + transform.Origin.X
            ty = base_point.Y + transform.Origin.Y
            raw_rods.append({'x': tx, 'y': ty, 'z': base_point.Z})

    # 2. Dynamic Spatial Sorting
    if raw_rods:
        cx = sum(r['x'] for r in raw_rods) / len(raw_rods)
        cy = sum(r['y'] for r in raw_rods) / len(raw_rods)

        def get_angle(r):
            return math.atan2(r['y'] - cy, r['x'] - cx)
            
        raw_rods.sort(key=get_angle, reverse=True)

        top_left_idx = 0
        min_val = float('inf')
        for i, r in enumerate(raw_rods):
            val = r['x'] - r['y']
            if val < min_val:
                min_val = val
                top_left_idx = i

        sorted_rods = raw_rods[top_left_idx:] + raw_rods[:top_left_idx]
        
        rod_positions = {}
        for i, r in enumerate(sorted_rods):
            rod_positions[i + 1] = (r['x'], r['y'])
    else:
        rod_positions = {}

    view_bb = active_view.get_BoundingBox(None)
    cz = view_bb.Max.Z - 0.05

    def get_color(status):
        if status == "Acceptable": return Color(0, 200, 0)
        elif status == "Minor Mismatch": return Color(255, 200, 0)
        elif status == "Not Acceptable": return Color(255, 0, 0)
        else: return Color(180, 180, 180)

    TransactionManager.Instance.EnsureInTransaction(doc)

    all_lines = list(
        FilteredElementCollector(doc)
        .OfCategory(BuiltInCategory.OST_Lines)
        .WhereElementIsNotElementType()
        .ToElements()
    )
    for el in all_lines:
        try: doc.Delete(el.Id)
        except: pass

    if reset:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Reset done. All lines cleared for " + COLUMN_ID
    elif not column_rebar:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: No rebar found for column with Host Mark: " + COLUMN_ID
    else:
        sketch_plane = SketchPlane.Create(
            doc,
            Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ(0, 0, cz))
        )

        drawn = 0
        skipped = 0
        for entry in lines_data:
            from_rod = entry.get("from")
            to_rod   = entry.get("to")
            status   = entry.get("status", "NA")

            if from_rod not in rod_positions or to_rod not in rod_positions:
                skipped += 1
                continue

            x1, y1 = rod_positions[from_rod]
            x2, y2 = rod_positions[to_rod]

            p1 = XYZ(x1, y1, cz)
            p2 = XYZ(x2, y2, cz)

            # Safety Check: Prevent Revit crash if points are identical
            if p1.DistanceTo(p2) < 0.01:
                skipped += 1
                continue

            line = Line.CreateBound(p1, p2)
            mc   = doc.Create.NewModelCurve(line, sketch_plane)

            color    = get_color(status)
            override = OverrideGraphicSettings()
            override.SetProjectionLineColor(color)
            override.SetProjectionLineWeight(5)
            active_view.SetElementOverrides(mc.Id, override)

            drawn += 1

        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Success! Drew " + str(drawn) + " lines for " + COLUMN_ID + ". Skipped " + str(skipped) + " lines."