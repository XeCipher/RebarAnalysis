import numpy as np
import math

# --- Constants ---
ROI_SIZE = 120
NUM_RAYS_FOR_RADIUS = 36
DEFAULT_ROD_RADIUS_PX = 15
TEXT_BG_ALPHA = 0.6

# Colors (BGR Format)
COLOR_ROD_CIRCLE = (50, 205, 50)       # Lime Green (Detected)
COLOR_FALLBACK_CIRCLE = (0, 165, 255)  # Orange (Fallback)
COLOR_LINE = (0, 0, 255)               # Red
COLOR_REF_LINE = (255, 255, 0)         # Cyan
COLOR_TEXT = (255, 255, 255)           # White
COLOR_TEXT_OUTLINE = (0, 0, 0)         # Black

def draw_outlined_text(img, text, pos, font_scale, thickness=2, color=COLOR_TEXT, outline_color=COLOR_TEXT_OUTLINE):
    """Draws text with a thick outline for high contrast (like subtitles)."""
    import cv2
    font = cv2.FONT_HERSHEY_SIMPLEX
    x, y = int(pos[0]), int(pos[1])
    
    # Draw Outline (Thick black)
    cv2.putText(img, text, (x, y), font, font_scale, outline_color, thickness * 3, cv2.LINE_AA)
    # Draw Inner (White)
    cv2.putText(img, text, (x, y), font, font_scale, color, thickness, cv2.LINE_AA)

def draw_label_with_box(img, text, center_pos, font_scale=0.5, bg_alpha=0.6):
    """Draws text inside a semi-transparent box centered at pos."""
    import cv2
    font = cv2.FONT_HERSHEY_SIMPLEX
    thickness = 1
    (text_w, text_h), baseline = cv2.getTextSize(text, font, font_scale, thickness)
    
    x = int(center_pos[0] - text_w // 2)
    y = int(center_pos[1] + text_h // 2)
    
    # Padding
    pad = 5
    x1, y1 = max(0, x - pad), max(0, y - text_h - pad)
    x2, y2 = min(img.shape[1], x + text_w + pad), min(img.shape[0], y + baseline + pad)
    
    # Draw semi-transparent box
    if x1 < x2 and y1 < y2:
        sub_img = img[y1:y2, x1:x2]
        black_rect = np.zeros(sub_img.shape, dtype=np.uint8)
        res = cv2.addWeighted(sub_img, 1 - bg_alpha, black_rect, bg_alpha, 1.0)
        img[y1:y2, x1:x2] = res
        
    # Draw Text
    cv2.putText(img, text, (x, y), font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)

def find_rod_circle(image, seed_point):
    """
    Robustly detects the rod edge and radius using HSV color segmentation and Ray-Casting.
    Returns: (center_point, radius, is_fallback)
    """
    import cv2
    seed_x, seed_y = int(seed_point[0]), int(seed_point[1])
    
    # Define Region of Interest (ROI) limits
    half_roi = ROI_SIZE // 2
    x_start = max(seed_x - half_roi, 0)
    y_start = max(seed_y - half_roi, 0)
    x_end = min(x_start + ROI_SIZE, image.shape[1])
    y_end = min(y_start + ROI_SIZE, image.shape[0])
    
    # Check if ROI is valid
    if x_end - x_start < 10 or y_end - y_start < 10:
        return seed_point, DEFAULT_ROD_RADIUS_PX, True

    # Extract ROI
    roi = image[y_start:y_end, x_start:x_end]
    
    # Convert to HSV color space
    hsv_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    
    # Calculate local coordinates of the seed point inside ROI
    roi_seed_x = seed_x - x_start
    roi_seed_y = seed_y - y_start
    
    # Adaptive Color Sampling (take median of 5x5 area around click)
    patch_y_min = max(0, roi_seed_y - 2)
    patch_y_max = min(hsv_roi.shape[0], roi_seed_y + 3)
    patch_x_min = max(0, roi_seed_x - 2)
    patch_x_max = min(hsv_roi.shape[1], roi_seed_x + 3)
    
    patch = hsv_roi[patch_y_min:patch_y_max, patch_x_min:patch_x_max]
    
    if patch.size == 0:
        return seed_point, DEFAULT_ROD_RADIUS_PX, True

    h_med = np.median(patch[:,:,0])
    s_med = np.median(patch[:,:,1])
    v_med = np.median(patch[:,:,2])
    
    # Define dynamic HSV range - CRITICAL FIX: Ensure dtype=np.uint8
    h_range, s_range, v_range = 20, 70, 70
    
    lower_vals = [int(max(0, h_med - h_range)), int(max(0, s_med - s_range)), int(max(0, v_med - v_range))]
    upper_vals = [int(min(180, h_med + h_range)), int(min(255, s_med + s_range)), int(min(255, v_med + v_range))]
    
    lower_range = np.array(lower_vals, dtype=np.uint8)
    upper_range = np.array(upper_vals, dtype=np.uint8)
    
    # Create mask
    mask = cv2.inRange(hsv_roi, lower_range, upper_range)
    
    # Clean up noise
    kernel = np.ones((3, 3), np.uint8)
    mask_cleaned = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    
    # Find contours
    contours, _ = cv2.findContours(mask_cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if not contours:
        return seed_point, DEFAULT_ROD_RADIUS_PX, True
    
    # Find largest contour (likely the rod)
    best_contour = max(contours, key=cv2.contourArea)
    M = cv2.moments(best_contour)
    
    if M["m00"] == 0:
        return seed_point, DEFAULT_ROD_RADIUS_PX, True
        
    # Calculate refined center from moments
    refined_cx_roi = int(M["m10"] / M["m00"])
    refined_cy_roi = int(M["m01"] / M["m00"])
    
    # Ray-casting to find actual radius
    radii_found = []
    for angle_step in range(NUM_RAYS_FOR_RADIUS):
        angle = (angle_step / NUM_RAYS_FOR_RADIUS) * 2 * math.pi
        
        for r in range(1, int(ROI_SIZE/2)):
            tx = int(refined_cx_roi + r * math.cos(angle))
            ty = int(refined_cy_roi + r * math.sin(angle))
            
            # Check bounds
            if not (0 <= tx < mask_cleaned.shape[1] and 0 <= ty < mask_cleaned.shape[0]):
                break
                
            # If we hit a black pixel (background), we found the edge
            if mask_cleaned[ty, tx] == 0:
                radii_found.append(r)
                break
    
    # Determine final radius
    if not radii_found or len(radii_found) < (NUM_RAYS_FOR_RADIUS * 0.4):
        # Fallback if detection wasn't confident
        return seed_point, DEFAULT_ROD_RADIUS_PX, True
        
    final_radius = np.median(radii_found)
    
    # Convert local ROI coordinates back to global image coordinates
    final_global_center = (refined_cx_roi + x_start, refined_cy_roi + y_start)
    
    return final_global_center, final_radius, False

def process_image(img_array, rod_points, ref_points, ref_length_mm):
    """
    Main orchestrator logic.
    """
    import cv2
    annotated_img = img_array.copy()
    
    # 1. Detect Rods
    detected_circles = [] 
    
    for pt in rod_points:
        seed = (int(pt[0]), int(pt[1]))
        result = find_rod_circle(img_array, seed)
        detected_circles.append(result)

    # 2. Calculate Scale
    px_per_mm = None
    if len(ref_points) == 2 and ref_length_mm > 0:
        p1 = (int(ref_points[0][0]), int(ref_points[0][1]))
        p2 = (int(ref_points[1][0]), int(ref_points[1][1]))
        
        dist_px = math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)
        px_per_mm = dist_px / ref_length_mm
        
        # Draw Reference Line
        cv2.line(annotated_img, p1, p2, COLOR_REF_LINE, 2)
        mid_ref = ((p1[0] + p2[0]) // 2, (p1[1] + p2[1]) // 2)
        label_ref = f"Ref: {ref_length_mm}mm"
        draw_label_with_box(annotated_img, label_ref, mid_ref, 0.6)

    # 3. Data Collection
    rod_data = {
        "count": len(detected_circles),
        "avg_radius": 0,
        "distances": []
    }
    
    radii_values = []
    rod_centers = [c[0] for c in detected_circles]
    
    # Calculate Average Radius first
    for _, r, is_fallback in detected_circles:
        radius_metric = r / px_per_mm if px_per_mm else r
        radii_values.append(radius_metric)

    if radii_values:
        rod_data["avg_radius"] = sum(radii_values) / len(radii_values)

    # 4. Draw Sequential Connections (The Perimeter)
    num_rods = len(rod_centers)
    if num_rods > 1:
        for i in range(num_rods):
            # Connect current to next (wrapping around to start)
            next_idx = (i + 1) % num_rods
            
            p1 = rod_centers[i]
            p2 = rod_centers[next_idx]
            
            # Calculate Distance
            dist_px = math.dist(p1, p2)
            dist_metric = dist_px / px_per_mm if px_per_mm else dist_px
            
            rod_data["distances"].append(dist_metric)
            
            # Draw Line (Red)
            cv2.line(annotated_img, p1, p2, COLOR_LINE, 2, cv2.LINE_AA)
            
            # Draw Label (Distance)
            mid = ((p1[0]+p2[0])//2, (p1[1]+p2[1])//2)
            dist_label = f"{dist_metric:.1f}mm" if px_per_mm else f"{dist_px:.1f}px"
            draw_label_with_box(annotated_img, dist_label, mid, 0.5)

    # 5. Draw Rods & IDs (On top of lines)
    for i, (center, r, is_fallback) in enumerate(detected_circles):
        color = COLOR_FALLBACK_CIRCLE if is_fallback else COLOR_ROD_CIRCLE
        
        # Draw Circle
        cv2.circle(annotated_img, center, int(r), color, 3, cv2.LINE_AA) 
        
        # ID Label (R1, R2...) - Positioned slightly up-left of center
        label_pos = (center[0] - r, center[1] - r)
        draw_outlined_text(annotated_img, f"R{i+1}", label_pos, 0.8, 2)

    # 6. Draw Big Header (Avg Radius)
    header_text = f"Avg. Rod Radius: {rod_data['avg_radius']:.2f}{'mm' if px_per_mm else 'px'}"
    draw_outlined_text(annotated_img, header_text, (20, 50), 1.2, 3)

    has_scale = (px_per_mm is not None)
    
    return annotated_img, rod_data, has_scale