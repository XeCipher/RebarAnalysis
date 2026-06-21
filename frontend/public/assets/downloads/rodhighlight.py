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
    TARGET_RODS = data.get("rods", [])
    if "rod" in data and data["rod"] is not None:
        TARGET_RODS.append(data["rod"])
    COLUMN_ID = data.get("column_id", "C8_Rect") 
    FRONTEND_POINTS = data.get("frontend_points", [])

    doc = DocumentManager.Instance.CurrentDBDocument
    active_view = doc.ActiveView

    rebar_elements = list(FilteredElementCollector(doc).OfClass(Rebar).WhereElementIsNotElementType().ToElements())

    column_rebar = []
    for r in rebar_elements:
        mark_param = r.LookupParameter("Host Mark")
        if mark_param and mark_param.AsString() == COLUMN_ID:
            column_rebar.append(r)

    TransactionManager.Instance.EnsureInTransaction(doc)

    for el in list(FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Lines).WhereElementIsNotElementType().ToElements()):
        try: doc.Delete(el.Id)
        except: pass

    empty_override = OverrideGraphicSettings()
    for rs in column_rebar:
        active_view.SetElementOverrides(rs.Id, empty_override)

    if reset:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Reset done. Highlights cleared for " + COLUMN_ID

    elif not column_rebar:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "ERROR: No rebar found for column with Host Mark: " + COLUMN_ID

    else:
        raw_rods = []
        for rs in column_rebar:
            curves = list(rs.GetCenterlineCurves(False, False, False, MultiplanarOption.IncludeOnlyPlanarCurves, 0))
            if not curves: continue
            
            p_start = curves[0].GetEndPoint(0)
            p_end = curves[0].GetEndPoint(1)
            if abs(p_start.Z - p_end.Z) < 0.5: continue 
                
            base_point = curves[0].Evaluate(0.5, True)
            accessor = rs.GetShapeDrivenAccessor()
            
            for b_idx in range(rs.Quantity):
                transform = accessor.GetBarPositionTransform(b_idx)
                tx = base_point.X + transform.Origin.X
                ty = base_point.Y + transform.Origin.Y
                raw_rods.append({'x': tx, 'y': ty, 'z': base_point.Z, 'rs': rs})

        if not raw_rods or not FRONTEND_POINTS:
            TransactionManager.Instance.TransactionTaskDone()
            OUT = "ERROR: Could not map rods to sequence properly. Check JSON inputs."
        else:
            # === Intelligent Aspect-Ratio Rotation Mapping ===
            min_rx = min(r['x'] for r in raw_rods)
            max_rx = max(r['x'] for r in raw_rods)
            min_ry = min(r['y'] for r in raw_rods)
            max_ry = max(r['y'] for r in raw_rods)
            rw = max_rx - min_rx if (max_rx - min_rx) > 0.001 else 1.0
            rh = max_ry - min_ry if (max_ry - min_ry) > 0.001 else 1.0

            for r in raw_rods:
                r['nx'] = (r['x'] - min_rx) / rw
                r['ny'] = (max_ry - r['y']) / rh 

            min_fx = min(p[0] for p in FRONTEND_POINTS)
            max_fx = max(p[0] for p in FRONTEND_POINTS)
            min_fy = min(p[1] for p in FRONTEND_POINTS)
            max_fy = max(p[1] for p in FRONTEND_POINTS)
            fw = max_fx - min_fx if (max_fx - min_fx) > 0.001 else 1.0
            fh = max_fy - min_fy if (max_fy - min_fy) > 0.001 else 1.0

            norm_front = []
            for p in FRONTEND_POINTS:
                xf = (p[0] - min_fx) / fw
                yf = (p[1] - min_fy) / fh 
                norm_front.append({'nx': xf, 'ny': yf})

            is_revit_vert = rh > rw * 1.15
            is_revit_horiz = rw > rh * 1.15
            is_front_vert = fh > fw * 1.15
            is_front_horiz = fw > fh * 1.15

            if is_front_horiz and is_revit_vert:
                for fp in norm_front:
                    old_x, old_y = fp['nx'], fp['ny']
                    fp['nx'] = 1.0 - old_y
                    fp['ny'] = old_x
            elif is_front_vert and is_revit_horiz:
                for fp in norm_front:
                    old_x, old_y = fp['nx'], fp['ny']
                    fp['nx'] = old_y
                    fp['ny'] = 1.0 - old_x

            mapping = {}
            avail = list(range(len(raw_rods)))
            
            for f_idx, fp in enumerate(norm_front):
                best_r = -1
                best_dist = float('inf')
                for r_idx in avail:
                    rp = raw_rods[r_idx]
                    dist = (fp['nx'] - rp['nx'])**2 + (fp['ny'] - rp['ny'])**2
                    if dist < best_dist:
                        best_dist = dist
                        best_r = r_idx
                
                mapping[f_idx] = best_r
                if best_r in avail: avail.remove(best_r)

            rod_mapping = { (f_idx + 1): raw_rods[r_idx] for f_idx, r_idx in mapping.items() }

            view_bb = active_view.get_BoundingBox(None)
            cz_lines = view_bb.Max.Z + 0.1
            plane_lines = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ(0, 0, cz_lines))
            sketch_plane_lines = SketchPlane.Create(doc, plane_lines)

            for rod_id in TARGET_RODS:
                if rod_id in rod_mapping:
                    rp = rod_mapping[rod_id]
                    target_set = rp['rs']
                    rebar_type = doc.GetElement(target_set.GetTypeId())
                    r = rebar_type.LookupParameter("Bar Diameter").AsDouble() * 0.1

                    arc1 = Arc.Create(plane_lines, r, 0, math.pi)
                    arc2 = Arc.Create(plane_lines, r, math.pi, 2 * math.pi)

                    t1 = Transform.CreateTranslation(XYZ(rp['x'], rp['y'], 0))
                    arc1 = arc1.CreateTransformed(t1)
                    arc2 = arc2.CreateTransformed(t1)

                    mc1 = doc.Create.NewModelCurve(arc1, sketch_plane_lines)
                    mc2 = doc.Create.NewModelCurve(arc2, sketch_plane_lines)

                    red = Color(255, 0, 0)
                    override = OverrideGraphicSettings()
                    override.SetProjectionLineColor(red)
                    override.SetProjectionLineWeight(6)

                    active_view.SetElementOverrides(mc1.Id, override)
                    active_view.SetElementOverrides(mc2.Id, override)

            TransactionManager.Instance.TransactionTaskDone()
            OUT = "Highlighted " + str(len(TARGET_RODS)) + " incorrect rods for " + COLUMN_ID