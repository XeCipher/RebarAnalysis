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

    reset = data.get("reset", False)
    COLUMN_ID = data.get("column_id", "C8_Rect")
    lines_data = data.get("lines", [])
    FRONTEND_POINTS = data.get("frontend_points", [])

    doc = DocumentManager.Instance.CurrentDBDocument
    active_view = doc.ActiveView

    rebar_elements = list(FilteredElementCollector(doc).OfClass(Rebar).WhereElementIsNotElementType().ToElements())

    column_rebar = []
    for r in rebar_elements:
        mark_param = r.LookupParameter("Host Mark")
        if mark_param and mark_param.AsString() == COLUMN_ID:
            column_rebar.append(r)

    def get_color(status):
        if status == "Acceptable": return Color(0, 200, 0)
        elif status == "Minor Mismatch": return Color(255, 200, 0)
        elif status == "Not Acceptable": return Color(255, 0, 0)
        else: return Color(180, 180, 180)

    TransactionManager.Instance.EnsureInTransaction(doc)

    # Clean up old lines and any leftover text
    for el in list(FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Lines).WhereElementIsNotElementType().ToElements()):
        try: doc.Delete(el.Id)
        except: pass
    for el in list(FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_ModelText).WhereElementIsNotElementType().ToElements()):
        try: doc.Delete(el.Id)
        except: pass

    if reset:
        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Reset done. All lines cleared for " + COLUMN_ID
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

        # Calculate bounding boxes for normalization
        min_rx = min(r['x'] for r in raw_rods)
        max_rx = max(r['x'] for r in raw_rods)
        min_ry = min(r['y'] for r in raw_rods)
        max_ry = max(r['y'] for r in raw_rods)
        rw = max_rx - min_rx if (max_rx - min_rx) > 0.001 else 1.0
        rh = max_ry - min_ry if (max_ry - min_ry) > 0.001 else 1.0

        # Normalize Revit coordinates (Y inverted so 0.0 is Top)
        for r in raw_rods:
            r['nx'] = (r['x'] - min_rx) / rw
            r['ny'] = (max_ry - r['y']) / rh

        min_fx = min(p[0] for p in FRONTEND_POINTS)
        max_fx = max(p[0] for p in FRONTEND_POINTS)
        min_fy = min(p[1] for p in FRONTEND_POINTS)
        max_fy = max(p[1] for p in FRONTEND_POINTS)
        fw = max_fx - min_fx if (max_fx - min_fx) > 0.001 else 1.0
        fh = max_fy - min_fy if (max_fy - min_fy) > 0.001 else 1.0

        # Normalize Frontend coordinates and retain original 1-based index mapping
        norm_front = []
        for i, p in enumerate(FRONTEND_POINTS):
            xf = (p[0] - min_fx) / fw
            yf = (p[1] - min_fy) / fh # Frontend Y naturally goes down, so 0.0 is Top
            norm_front.append({'nx': xf, 'ny': yf, 'original_index': i + 1})

        # Aspect-Ratio physical orientation alignment
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

        # === Topological Angular Sort (Prevents Criss-Crossing) ===
        cx_r = sum(r['nx'] for r in raw_rods) / len(raw_rods)
        cy_r = sum(r['ny'] for r in raw_rods) / len(raw_rods)
        for r in raw_rods:
            r['angle'] = math.atan2(r['ny'] - cy_r, r['nx'] - cx_r)
            
        cx_f = sum(p['nx'] for p in norm_front) / len(norm_front)
        cy_f = sum(p['ny'] for p in norm_front) / len(norm_front)
        for p in norm_front:
            p['angle'] = math.atan2(p['ny'] - cy_f, p['nx'] - cx_f)

        sorted_revit = sorted(raw_rods, key=lambda r: r['angle'])
        sorted_front = sorted(norm_front, key=lambda p: p['angle'])

        rod_mapping = {}
        
        # If lengths match, utilize perfect Cyclic Shift alignment
        if len(sorted_front) == len(sorted_revit) and len(sorted_front) > 0:
            N = len(sorted_front)
            best_shift = 0
            best_dist = float('inf')
            
            # Find the optimal rotational starting point
            for shift in range(N):
                total_dist = 0
                for i in range(N):
                    f_pt = sorted_front[i]
                    r_pt = sorted_revit[(i + shift) % N]
                    total_dist += (f_pt['nx'] - r_pt['nx'])**2 + (f_pt['ny'] - r_pt['ny'])**2
                
                if total_dist < best_dist:
                    best_dist = total_dist
                    best_shift = shift
            
            # Apply the mapping mathematically
            for i in range(N):
                f_pt = sorted_front[i]
                r_pt = sorted_revit[(i + best_shift) % N]
                rod_mapping[f_pt['original_index']] = r_pt
        else:
            # Fallback Greedy Mapping (Only if counts drastically mismatch)
            avail = list(range(len(raw_rods)))
            for fp in norm_front:
                best_r = -1
                best_dist = float('inf')
                for r_idx in avail:
                    rp = raw_rods[r_idx]
                    dist = (fp['nx'] - rp['nx'])**2 + (fp['ny'] - rp['ny'])**2
                    if dist < best_dist:
                        best_dist = dist
                        best_r = r_idx
                
                rod_mapping[fp['original_index']] = raw_rods[best_r]
                if best_r in avail: avail.remove(best_r)

        # Draw the lines sequentially
        view_bb = active_view.get_BoundingBox(None)
        cz_lines = view_bb.Max.Z + 0.1
        sketch_plane_lines = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ(0, 0, cz_lines)))

        drawn = 0
        skipped = 0
        for entry in lines_data:
            from_rod = entry.get("from")
            to_rod   = entry.get("to")
            status   = entry.get("status", "NA")

            if from_rod not in rod_mapping or to_rod not in rod_mapping:
                skipped += 1
                continue

            rp1 = rod_mapping[from_rod]
            rp2 = rod_mapping[to_rod]

            p1 = XYZ(rp1['x'], rp1['y'], cz_lines)
            p2 = XYZ(rp2['x'], rp2['y'], cz_lines)

            if p1.DistanceTo(p2) < 0.01:
                skipped += 1
                continue

            mc = doc.Create.NewModelCurve(Line.CreateBound(p1, p2), sketch_plane_lines)
            override = OverrideGraphicSettings()
            override.SetProjectionLineColor(get_color(status))
            override.SetProjectionLineWeight(5)
            active_view.SetElementOverrides(mc.Id, override)
            drawn += 1

        TransactionManager.Instance.TransactionTaskDone()
        OUT = "Success! Drew " + str(drawn) + " perfectly sequential lines for " + COLUMN_ID + ". Skipped " + str(skipped) + "."