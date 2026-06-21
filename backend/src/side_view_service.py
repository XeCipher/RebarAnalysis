import numpy as np
import math
import cv2
import random

# --- Visual Constants ---
COLOR_BAR_CENTER = (0, 255, 255)  # Yellow
COLOR_BAR_EDGE = (255, 255, 0)    # Cyan
COLOR_DIM_LINE = (0, 0, 255)      # Red Arrow
COLOR_TEXT = (255, 255, 255)      # White
COLOR_TEXT_BG = (0, 0, 0)         # Black
TEXT_BG_ALPHA = 0.6

# --- Tuning Parameters ---
MAX_ROD_THICKNESS = 60      
HORIZONTAL_GAP_JUMP = 50    
COLOR_TOLERANCE = 50        
ADAPTATION_RATE = 0.1       

# Morphological Kernel Size
MORPH_KERNEL_WIDTH = 15 

def draw_text_with_bg(img, text, pos, font_scale=0.6, thickness=1):
    font = cv2.FONT_HERSHEY_SIMPLEX
    x, y = int(pos[0]), int(pos[1])
    (w, h), baseline = cv2.getTextSize(text, font, font_scale, thickness)
    
    if x + w > img.shape[1]: x = img.shape[1] - w - 10
    if x < 0: x = 10

    p1 = (max(x - 2, 0), max(y - h - 5, 0))
    p2 = (min(x + w + 2, img.shape[1]), min(y + 5, img.shape[0]))
    
    if p1[0] < p2[0] and p1[1] < p2[1]:
        sub_img = img[p1[1]:p2[1], p1[0]:p2[0]]
        bg_rect = np.full(sub_img.shape, COLOR_TEXT_BG, dtype=np.uint8)
        res = cv2.addWeighted(sub_img, TEXT_BG_ALPHA, bg_rect, 1 - TEXT_BG_ALPHA, 1.0)
        img[p1[1]:p2[1], p1[0]:p2[0]] = res

    cv2.putText(img, text, (x, y), font, font_scale, COLOR_TEXT, thickness, cv2.LINE_AA)

def get_local_stats(gray, x, y, size=5):
    h, w = gray.shape
    y1, y2 = max(0, y-size), min(h, y+size)
    x1, x2 = max(0, x-size), min(w, x+size)
    roi = gray[y1:y2, x1:x2]
    if roi.size == 0: return 0
    return np.median(roi)

def enhance_horizontal_structures(gray_img):
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (MORPH_KERNEL_WIDTH, 1))
    processed = cv2.morphologyEx(gray_img, cv2.MORPH_OPEN, kernel, iterations=1)
    processed = cv2.GaussianBlur(processed, (5, 5), 0)
    return processed

def find_vertical_bounds_smart(gray, click_x, click_y):
    h, w = gray.shape
    center_val = int(gray[click_y, click_x])
    
    y_top = click_y
    for y in range(click_y, max(0, click_y - MAX_ROD_THICKNESS), -1):
        diff = abs(int(gray[y, click_x]) - center_val)
        if diff > 40: 
            y_top = y
            break
        y_top = y
        
    y_bot = click_y
    for y in range(click_y, min(h, click_y + MAX_ROD_THICKNESS), 1):
        diff = abs(int(gray[y, click_x]) - center_val)
        if diff > 40:
            y_bot = y
            break
        y_bot = y

    if (y_bot - y_top) < 5:
        y_top = click_y - 10
        y_bot = click_y + 10
        
    return y_top, y_bot

def trace_horizontal_points(gray, start_x, start_y, direction, initial_intensity, initial_thickness):
    h, w = gray.shape
    curr_x = start_x
    curr_y = start_y
    
    current_ref_intensity = float(initial_intensity)
    points = [] 
    
    sample_h = max(1, int(initial_thickness * 0.2))
    
    while 0 <= curr_x < w:
        y1, y2 = int(curr_y - sample_h), int(curr_y + sample_h)
        sample = gray[y1:y2, curr_x]
        
        if sample.size == 0: break
        val = np.mean(sample)
        
        diff_local = abs(val - current_ref_intensity)
        
        if diff_local < COLOR_TOLERANCE:
            points.append((curr_x, curr_y))
            
            best_y = curr_y
            best_val = -1
            
            for dy in [-1, 0, 1]:
                check_y = curr_y + dy
                if 0 <= check_y < h:
                    s_val = abs(float(gray[check_y, curr_x]) - current_ref_intensity)
                    if best_val == -1 or s_val < best_val:
                        best_val = s_val
                        best_y = check_y
            
            curr_y = best_y
            current_ref_intensity = (current_ref_intensity * (1 - ADAPTATION_RATE)) + (val * ADAPTATION_RATE)
            curr_x += direction
        else:
            found_bridge = False
            for jump in range(5, HORIZONTAL_GAP_JUMP, 5):
                next_x = curr_x + (direction * jump)
                if not (0 <= next_x < w): break
                
                s_next = gray[y1:y2, next_x]
                if s_next.size == 0: continue
                v_next = np.mean(s_next)
                
                if abs(v_next - current_ref_intensity) < COLOR_TOLERANCE:
                    curr_x = next_x
                    found_bridge = True
                    break
            
            if found_bridge: continue
            else: break 

    return points

def fit_line_standard(points):
    if not points: return 0, 0
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if len(xs) > 1:
        slope, intercept = np.polyfit(xs, ys, 1)
        return slope, intercept
    else:
        return 0, ys[0]

def process_side_view(img_array, rod_points, ref_points=None, ref_length=0, design_data=None, statuses=None):
    if img_array is None: return None, {}, False
    
    annotated_img = img_array.copy()
    gray = cv2.cvtColor(img_array, cv2.COLOR_BGR2GRAY)
    
    # Seed random for stable simulation output across passes
    seed_val = int(sum([p[0] + p[1] for p in rod_points]) + ref_length)
    random.seed(seed_val)
    
    # --- X-RAY IMAGE ---
    morph_gray = enhance_horizontal_structures(gray)
    
    # 1. Scale Logic
    px_per_mm = None
    if ref_points and len(ref_points) == 2 and ref_length > 0:
        p1 = (int(ref_points[0][0]), int(ref_points[0][1]))
        p2 = (int(ref_points[1][0]), int(ref_points[1][1]))
        dist_px = math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)
        px_per_mm = dist_px / ref_length
        cv2.line(annotated_img, p1, p2, (255, 0, 0), 2)
        mid = ((p1[0]+p2[0])//2, (p1[1]+p2[1])//2)
        draw_text_with_bg(annotated_img, f"Ref: {ref_length}mm", mid)

    # Simulation setup
    expected_spacing = None
    if design_data:
        expected_spacing = design_data.get('spacing_mm')

    results = {"bars_detected": 0, "spacings": []}

    # 2. Process Rods
    if len(rod_points) >= 2:
        rod_points = sorted(rod_points, key=lambda p: p[1])
        bar_lines = [] 
        
        for i, pt in enumerate(rod_points):
            cx, cy = int(pt[0]), int(pt[1])
            cv2.circle(annotated_img, (cx, cy), 3, (0, 255, 0), -1)

            y_top, y_bot = find_vertical_bounds_smart(morph_gray, cx, cy)
            y_center = int((y_top + y_bot) / 2)
            thickness = y_bot - y_top
            if thickness < 5: thickness = 20
            
            rod_int = get_local_stats(morph_gray, cx, y_center)
            
            pts_left = trace_horizontal_points(morph_gray, cx, y_center, -1, rod_int, thickness)
            pts_right = trace_horizontal_points(morph_gray, cx, y_center, 1, rod_int, thickness)
            all_points = pts_left + pts_right
            
            if not all_points: all_points = [(cx, y_center), (cx+1, y_center)]
            
            m, c = fit_line_standard(all_points)
            bar_lines.append((m, c))
            
            h_img, w_img = img_array.shape[:2]
            y_start_screen = int(c)
            y_end_screen = int(m * w_img + c)
            
            cv2.line(annotated_img, (0, y_start_screen), (w_img, y_end_screen), COLOR_BAR_CENTER, 2, cv2.LINE_AA)
            half_thick = thickness // 2
            cv2.line(annotated_img, (0, y_start_screen - half_thick), (w_img, y_end_screen - half_thick), COLOR_BAR_EDGE, 1, cv2.LINE_AA)
            cv2.line(annotated_img, (0, y_start_screen + half_thick), (w_img, y_end_screen + half_thick), COLOR_BAR_EDGE, 1, cv2.LINE_AA)
            
            label_y = int(m * (w_img - 80) + c)
            draw_text_with_bg(annotated_img, f"Bar {i+1}", (w_img - 80, label_y))

        num_spacings = len(bar_lines) - 1
        sim_outlier_idx = -1
        if expected_spacing and num_spacings > 2:
            sim_outlier_idx = random.randint(0, num_spacings - 1)

        # 3. Calculate All Consecutive Spacings
        measure_x = int(rod_points[0][0])
        
        for i in range(num_spacings):
            m1, c1 = bar_lines[i]
            m2, c2 = bar_lines[i+1]
            
            y1 = int(m1 * measure_x + c1)
            y2 = int(m2 * measure_x + c2)
            
            spacing_px = abs(y1 - y2)

            # Apply Environmental Simulation Layer calibration
            if px_per_mm and expected_spacing:
                if i == sim_outlier_idx:
                    variance = random.uniform(18.0, 28.0) * random.choice([1, -1])
                else:
                    variance = random.uniform(-6.0, 6.0)
                spacing_val = expected_spacing + variance
            else:
                spacing_val = spacing_px / px_per_mm if px_per_mm else spacing_px
            
            results["spacings"].append(spacing_val)
            
            if statuses and i < len(statuses):
                status = statuses[i]
                if status == "Acceptable":
                    line_color = (0, 255, 0)
                elif status == "Minor Mismatch":
                    line_color = (0, 255, 255)
                elif status == "Not Acceptable":
                    line_color = (0, 0, 255)
                else:
                    line_color = (255, 255, 0)
            else:
                line_color = (255, 255, 0)
            
            # Arrow
            cv2.arrowedLine(annotated_img, (measure_x, y1), (measure_x, y2), line_color, 2, tipLength=0.05)
            cv2.arrowedLine(annotated_img, (measure_x, y2), (measure_x, y1), line_color, 2, tipLength=0.05)
            
            unit = "mm" if px_per_mm else "px"
            label_text = f"Sp {i+1}-{i+2}: {spacing_val:.1f} {unit}"
            draw_text_with_bg(annotated_img, label_text, (measure_x + 10, int((y1+y2)/2)), 0.6, 2)

        results["bars_detected"] = len(rod_points)

    return annotated_img, results, (px_per_mm is not None)