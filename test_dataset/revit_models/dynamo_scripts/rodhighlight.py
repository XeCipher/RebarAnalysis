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
    rebar_sets.sort(key=lambda r: r.Id.Value)

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

    elif TARGET_ROD is None or TARGET_ROD < 1 or TARGET_ROD > 8:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: Invalid rod number in JSON. Must be 1-8."

    else:
        zero_index = TARGET_ROD - 1
        set_index  = zero_index // 4
        bar_index  = zero_index % 4

        target_set = rebar_sets[set_index]

        base_curves = list(target_set.GetCenterlineCurves(
            False, False, False,
            MultiplanarOption.IncludeOnlyPlanarCurves, 0))
        base_point = base_curves[0].Evaluate(0.5, True)
        world_x = base_point.X
        world_y = base_point.Y

        accessor = target_set.GetShapeDrivenAccessor()
        local_offset_y = accessor.GetBarPositionTransform(bar_index).Origin.Y

        cx = world_x
        cy = world_y + local_offset_y

        rebar_type = doc.GetElement(target_set.GetTypeId())
        bar_diameter = rebar_type.LookupParameter("Bar Diameter").AsDouble()
        r = bar_diameter * 0.1

        view_bb = active_view.get_BoundingBox(None)
        cz = view_bb.Max.Z - 0.05

        plane = Plane.CreateByOriginAndBasis(
            XYZ(cx, cy, cz), XYZ(1, 0, 0), XYZ(0, 1, 0))

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