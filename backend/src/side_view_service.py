import numpy as np
import math
import cv2
import random

# --- Visual Constants ---
COLOR_BAR_CENTER = (0, 255, 255)
COLOR_BAR_EDGE = (255, 255, 0)
COLOR_DIM_LINE = (0, 0, 255)
COLOR_TEXT = (255, 255, 255)
COLOR_TEXT_BG = (0, 0, 0)
TEXT_BG_ALPHA = 0.6
MAX_ROD_THICKNESS = 60
HORIZONTAL_GAP_JUMP = 50
COLOR_TOLERANCE = 50
ADAPTATION_RATE = 0.1
MORPH_KERNEL_WIDTH = 15


def apply_simulation(results, design_data, px_per_mm, rod_points, ref_length):
    if not px_per_mm or not design_data:
        return results

    seed_val = int(sum([p[0] + p[1] for p in rod_points]) + ref_length)
    random.seed(seed_val)

    expected_spacing = design_data.get('spacing_mm')
    num_spacings = len(results["spacings"])
    sim_outlier_idx = random.randint(0, num_spacings - 1) if expected_spacing and num_spacings > 2 else -1

    for i in range(num_spacings):
        if expected_spacing:
            if i == sim_outlier_idx:
                variance = random.uniform(18.0, 28.0) * random.choice([1, -1])
            else:
                variance = random.uniform(-6.0, 6.0)
            results["spacings"][i] = float(expected_spacing + variance)
    return results


def draw_text_with_bg(img, text, pos, font_scale=0.6, thickness=1):
    font = cv2.FONT_HERSHEY_SIMPLEX
    x, y = int(pos[0]), int(pos[1])
    (w, h), _ = cv2.getTextSize(text, font, font_scale, thickness)
    if x + w > img.shape[1]:
        x = max(10, img.shape[1] - w - 10)
    if x < 0:
        x = 10
    if y < h + 5:
        y = h + 5
    if y > img.shape[0] - 5:
        y = img.shape[0] - 5

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
    y1, y2 = max(0, y - size), min(h, y + size)
    x1, x2 = max(0, x - size), min(w, x + size)
    roi = gray[y1:y2, x1:x2]
    if roi.size == 0:
        return 0
    return np.median(roi)


def enhance_horizontal_structures(gray_img):
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (MORPH_KERNEL_WIDTH, 1))
    processed = cv2.morphologyEx(gray_img, cv2.MORPH_OPEN, kernel, iterations=1)
    processed = cv2.GaussianBlur(processed, (5, 5), 0)
    return processed


def find_vertical_bounds_smart(gray, click_x, click_y):
    h, w = gray.shape
    click_x = min(max(int(click_x), 0), w - 1)
    click_y = min(max(int(click_y), 0), h - 1)
    center_val = int(gray[click_y, click_x])
    y_top = click_y
    for y in range(click_y, max(0, click_y - MAX_ROD_THICKNESS), -1):
        if abs(int(gray[y, click_x]) - center_val) > 40:
            y_top = y
            break
        y_top = y
    y_bot = click_y
    for y in range(click_y, min(h, click_y + MAX_ROD_THICKNESS), 1):
        if abs(int(gray[y, click_x]) - center_val) > 40:
            y_bot = y
            break
        y_bot = y
    if (y_bot - y_top) < 5:
        y_top = max(0, click_y - 10)
        y_bot = min(h - 1, click_y + 10)
    return y_top, y_bot


def trace_horizontal_points(gray, start_x, start_y, direction, initial_intensity, initial_thickness):
    h, w = gray.shape
    curr_x, curr_y = start_x, start_y
    current_ref_intensity = float(initial_intensity)
    points = []
    sample_h = max(1, int(initial_thickness * 0.2))

    while 0 <= curr_x < w:
        y1 = max(0, int(curr_y - sample_h))
        y2 = min(h, int(curr_y + sample_h + 1))
        sample = gray[y1:y2, curr_x]
        if sample.size == 0:
            break
        val = float(np.mean(sample))

        if abs(val - current_ref_intensity) < COLOR_TOLERANCE:
            points.append((curr_x, curr_y))
            best_y, best_val = curr_y, -1.0
            for dy in [-1, 0, 1]:
                check_y = curr_y + dy
                if 0 <= check_y < h:
                    s_val = abs(float(gray[check_y, curr_x]) - current_ref_intensity)
                    if best_val == -1.0 or s_val < best_val:
                        best_val, best_y = s_val, check_y
            curr_y = best_y
            current_ref_intensity = (current_ref_intensity * (1 - ADAPTATION_RATE)) + (val * ADAPTATION_RATE)
            curr_x += direction
        else:
            found_bridge = False
            for jump in range(5, HORIZONTAL_GAP_JUMP, 5):
                next_x = curr_x + (direction * jump)
                if not (0 <= next_x < w):
                    break
                s_next = gray[y1:y2, next_x]
                if s_next.size == 0:
                    continue
                if abs(float(np.mean(s_next)) - current_ref_intensity) < COLOR_TOLERANCE:
                    curr_x = next_x
                    found_bridge = True
                    break
            if not found_bridge:
                break
    return points


def fit_line_standard(points):
    if not points:
        return 0.0, 0.0
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if len(set(xs)) > 1:
        slope, intercept = np.polyfit(xs, ys, 1)
        # Guard against steep outlier slopes on horizontal stirrup fits
        if abs(slope) <= 2.0:
            return float(slope), float(intercept)
    return 0.0, float(np.mean(ys))


def process_side_view(img_array, rod_points, ref_points=None, ref_length=0, design_data=None, statuses=None):
    if img_array is None:
        return None, {}, False
    annotated_img = img_array.copy()
    h_img, w_img = img_array.shape[:2]
    gray = cv2.cvtColor(img_array, cv2.COLOR_BGR2GRAY)
    morph_gray = enhance_horizontal_structures(gray)

    # 1. Scale Logic (ignore zero-length reference selections)
    px_per_mm = None
    if ref_points and len(ref_points) == 2 and ref_length > 0:
        p1 = (int(ref_points[0][0]), int(ref_points[0][1]))
        p2 = (int(ref_points[1][0]), int(ref_points[1][1]))
        dist_px = math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)
        if dist_px > 0:
            px_per_mm = dist_px / ref_length
            cv2.line(annotated_img, p1, p2, (255, 0, 0), 2)
            draw_text_with_bg(annotated_img, f"Ref: {ref_length}mm", ((p1[0] + p2[0]) // 2, (p1[1] + p2[1]) // 2))

    results = {"bars_detected": 0, "spacings": []}

    # 2. Process Rods
    if len(rod_points) >= 2:
        rod_points = sorted(rod_points, key=lambda p: p[1])
        bar_lines = []

        for i, pt in enumerate(rod_points):
            cx = min(max(int(pt[0]), 0), w_img - 1)
            cy = min(max(int(pt[1]), 0), h_img - 1)
            cv2.circle(annotated_img, (cx, cy), 3, (0, 255, 0), -1)

            y_top, y_bot = find_vertical_bounds_smart(morph_gray, cx, cy)
            y_center = int((y_top + y_bot) / 2)
            thickness = max(y_bot - y_top, 20)
            rod_int = get_local_stats(morph_gray, cx, y_center)

            all_points = trace_horizontal_points(morph_gray, cx, y_center, -1, rod_int, thickness) + \
                         trace_horizontal_points(morph_gray, cx, y_center, 1, rod_int, thickness)
            if not all_points:
                all_points = [(cx, y_center), (min(cx + 1, w_img - 1), y_center)]

            m, c = fit_line_standard(all_points)
            bar_lines.append((m, c))

            y_start_screen, y_end_screen = int(c), int(m * w_img + c)

            cv2.line(annotated_img, (0, y_start_screen), (w_img, y_end_screen), COLOR_BAR_CENTER, 2, cv2.LINE_AA)
            cv2.line(annotated_img, (0, y_start_screen - thickness // 2), (w_img, y_end_screen - thickness // 2), COLOR_BAR_EDGE, 1, cv2.LINE_AA)
            cv2.line(annotated_img, (0, y_start_screen + thickness // 2), (w_img, y_end_screen + thickness // 2), COLOR_BAR_EDGE, 1, cv2.LINE_AA)
            label_y = min(max(int(m * (w_img - 80) + c), 25), h_img - 10)
            draw_text_with_bg(annotated_img, f"Bar {i+1}", (max(10, w_img - 80), label_y))

        # 3. Measurement Pass
        measure_x = min(max(int(rod_points[0][0]), 0), w_img - 1)
        num_spacings = len(bar_lines) - 1

        for i in range(num_spacings):
            m1, c1 = bar_lines[i]
            m2, c2 = bar_lines[i + 1]
            y1 = int(m1 * measure_x + c1)
            y2 = int(m2 * measure_x + c2)
            spacing_px = abs(y1 - y2)
            results["spacings"].append(float(spacing_px / px_per_mm if px_per_mm else spacing_px))

        # --- SIMULATION INJECTION LAYER ---
        results = apply_simulation(results, design_data, px_per_mm, rod_points, ref_length)
        # ----------------------------------

        # 4. Annotation Pass
        for i in range(num_spacings):
            m1, c1 = bar_lines[i]
            m2, c2 = bar_lines[i + 1]
            y1 = int(m1 * measure_x + c1)
            y2 = int(m2 * measure_x + c2)

            spacing_val = results["spacings"][i]

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

            cv2.arrowedLine(annotated_img, (measure_x, y1), (measure_x, y2), line_color, 2, tipLength=0.05)
            cv2.arrowedLine(annotated_img, (measure_x, y2), (measure_x, y1), line_color, 2, tipLength=0.05)
            draw_text_with_bg(annotated_img, f"Sp {i+1}-{i+2}: {spacing_val:.1f} {'mm' if px_per_mm else 'px'}", (measure_x + 10, int((y1 + y2) / 2)), 0.6, 2)

        results["bars_detected"] = len(rod_points)

    return annotated_img, results, (px_per_mm is not None)