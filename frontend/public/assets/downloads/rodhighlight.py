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
    COLUMN_ID = data.get("column_id", "C8") # Default to C8 if not provided

    doc = DocumentManager.Instance.CurrentDBDocument
    active_view = doc.ActiveView

    # 1. Collect all Rebar elements
    rebar_elements = list(
        FilteredElementCollector(doc)
        .OfClass(Rebar)
        .WhereElementIsNotElementType()
        .ToElements()
    )

    # 2. Filter to only the specified column
    column_rebar = []
    for r in rebar_elements:
        mark_param = r.LookupParameter("Host Mark")
        if mark_param and mark_param.AsString() == COLUMN_ID:
            column_rebar.append(r)
            
    # Sort to ensure consistent processing order
    column_rebar.sort(key=lambda r: r.Id.Value)

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

    # Always reset all rebar overrides for the selected column
    empty_override = OverrideGraphicSettings()
    for rs in column_rebar:
        active_view.SetElementOverrides(rs.Id, empty_override)

    if reset:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Reset done. All highlights cleared for " + COLUMN_ID

    elif not column_rebar:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: No rebar found for column with Host Mark: " + COLUMN_ID

    elif TARGET_ROD is None:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: No rod specified in JSON."

    else:
        # 3. Dynamically map rods and build dictionary
        rebar_refs = {}
        rod_number = 1
        
        for rebar_set in column_rebar:
            accessor = rebar_set.GetShapeDrivenAccessor()
            count = rebar_set.Quantity
            for b_idx in range(count):
                rebar_refs[rod_number] = (rebar_set, b_idx)
                rod_number += 1
                
        total_rods = len(rebar_refs)
        
        # Select dictionary based on total rods
        if total_rods == 8:
            FRONTEND_TO_REVIT = {1: 1, 2: 2, 3: 3, 4: 4, 5: 8, 6: 7, 7: 6, 8: 5}
        elif total_rods == 4:
            FRONTEND_TO_REVIT = {1: 1, 2: 2, 3: 4, 4: 3}
        else:
            # Fallback direct mapping
            FRONTEND_TO_REVIT = {i: i for i in range(1, total_rods + 1)}

        # Get the actual Revit index
        revit_rod_num = FRONTEND_TO_REVIT.get(TARGET_ROD)
        
        if revit_rod_num is None or revit_rod_num not in rebar_refs:
            TransactionManager.Instance.TransactionTaskDone()
            OUT = "ERROR: Target rod " + str(TARGET_ROD) + " could not be mapped."
        else:
            target_set, bar_index = rebar_refs[revit_rod_num]

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

            OUT = "Rod " + str(TARGET_ROD) + " highlighted in " + COLUMN_ID