import clr
clr.AddReference('RevitAPI')
clr.AddReference('RevitServices')

from Autodesk.Revit.DB import *
from Autodesk.Revit.DB.Structure import *
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager
import math
import json
import os

# Read JSON file
json_path = os.path.join(os.path.expanduser("~"), "Downloads", "highlight_rod.json")

if not os.path.exists(json_path):
    OUT = "ERROR: File not found at " + json_path
else:
    with open(json_path, "r") as f:
        data = json.load(f)

    reset = data.get("reset", False)
    TARGET_ROD = data.get("rod", None)

    doc = DocumentManager.Instance.CurrentDBDocument
    active_view = doc.ActiveView

    rebar_sets = list(
        FilteredElementCollector(doc)
        .OfClass(Rebar)
        .WhereElementIsNotElementType()
        .ToElements()
    )

    # 1. Collect all vertical bars dynamically
    bars = []
    for rebar in rebar_sets:
        if not rebar.IsRebarShapeDriven():
            continue
            
        curves = rebar.GetCenterlineCurves(False, False, False, MultiplanarOption.IncludeOnlyPlanarCurves, 0)
        if not curves: continue
        
        c = curves[0]
        p1 = c.GetEndPoint(0)
        p2 = c.GetEndPoint(1)
        
        # Filter for vertical bars (longitudinal) - Ignore horizontal stirrups
        if abs(p1.Z - p2.Z) < 0.5:
            continue
            
        base_point = c.Evaluate(0.5, True)
        accessor = rebar.GetShapeDrivenAccessor()
        
        for b_idx in range(rebar.NumberOfBarPositions):
            transform = accessor.GetBarPositionTransform(b_idx)
            bar_center = base_point.Add(transform.Origin)
            bars.append({
                'rebar': rebar,
                'x': bar_center.X,
                'y': bar_center.Y,
                'z': bar_center.Z
            })
            
    # 2. Sort bars to match frontend logic (Clockwise from Top-Left in Image Coordinates)
    if bars:
        img_bars = []
        for b in bars:
            img_bars.append({
                'b': b,
                'ix': b['x'],
                'iy': -b['y']  # Invert Y to match image Canvas coordinates
            })

        icx = sum(ib['ix'] for ib in img_bars) / len(img_bars)
        icy = sum(ib['iy'] for ib in img_bars) / len(img_bars)

        def get_angle(ib):
            return math.atan2(ib['iy'] - icy, ib['ix'] - icx)

        img_bars.sort(key=get_angle)

        min_sum = float('inf')
        top_left_idx = 0
        for i, ib in enumerate(img_bars):
            val = ib['ix'] + ib['iy']
            if val < min_sum:
                min_sum = val
                top_left_idx = i

        sorted_bars = img_bars[top_left_idx:] + img_bars[:top_left_idx]
    else:
        sorted_bars = []

    TransactionManager.Instance.EnsureInTransaction(doc)

    # Always delete all previous model curves
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

    # Always reset all rebar overrides
    empty_override = OverrideGraphicSettings()
    for rs in rebar_sets:
        active_view.SetElementOverrides(rs.Id, empty_override)

    if reset:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Reset done. All highlights cleared."

    elif not sorted_bars:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: No vertical bars found in the model."

    elif TARGET_ROD is None or TARGET_ROD < 1 or TARGET_ROD > len(sorted_bars):
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: Invalid rod number in JSON. Must be 1-" + str(len(sorted_bars)) + "."

    else:
        target_data = sorted_bars[TARGET_ROD - 1]['b']
        
        cx = target_data['x']
        cy = target_data['y']

        rebar_type = doc.GetElement(target_data['rebar'].GetTypeId())
        bar_diameter = rebar_type.LookupParameter("Bar Diameter").AsDouble()
        r = bar_diameter * 0.1  # Arbitrary highlight radius scaling

        view_bb = active_view.get_BoundingBox(None)
        cz = view_bb.Max.Z - 0.05

        plane = Plane.CreateByOriginAndBasis(XYZ(cx, cy, cz), XYZ(1, 0, 0), XYZ(0, 1, 0))

        arc1 = Arc.Create(plane, r, 0, math.pi)
        arc2 = Arc.Create(plane, r, math.pi, 2 * math.pi)

        sketch_plane = SketchPlane.Create(doc, plane)

        mc1 = doc.Create.NewModelCurve(arc1, sketch_plane)
        mc2 = doc.Create.NewModelCurve(arc2, sketch_plane)

        red = Color(255, 0, 0)
        override = OverrideGraphicSettings()
        override.SetProjectionLineColor(red)
        override.SetProjectionLineWeight(6)

        active_view.SetElementOverrides(mc1.Id, override)
        active_view.SetElementOverrides(mc2.Id, override)

        TransactionManager.Instance.TransactionTaskDone()

        OUT = "Rod " + str(TARGET_ROD) + " highlighted → X:" + str(round(cx, 4)) + " Y:" + str(round(cy, 4))