import numpy as np
import math
import cv2

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

# Pre-compute ray-casting angles for maximum performance
ANGLES = [(i / NUM_RAYS_FOR_RADIUS) * 2 * math.pi for i in range(NUM_RAYS_FOR_RADIUS)]
COS_ANGLES = [math.cos(a) for a in ANGLES]
SIN_ANGLES = [math.sin(a) for a in ANGLES]

def draw_outlined_text(img, text, pos, font_scale, thickness=2, color=COLOR_TEXT, outline_color=COLOR_TEXT_OUTLINE):
    """Draws text with a thick outline for high contrast (like subtitles)."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    x, y = int(pos[0]), int(pos[1])
    
    # Draw Outline (Thick black)
    cv2.putText(img, text, (x, y), font, font_scale, outline_color, thickness * 3, cv2.LINE_AA)
    # Draw Inner (White)
    cv2.putText(img, text, (x, y), font, font_scale, color, thickness, cv2.LINE_AA)

def draw_label_with_box(img, text, center_pos, font_scale=0.5, bg_alpha=0.6):
    """Draws text inside a semi-transparent box centered at pos."""
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
    Robustly detects the rod edge and radius using Canny Edge detection and Ray-Casting.
    Returns: (center_point, radius, is_fallback)
    """
    seed_x, seed_y = int(seed_point[0]), int(seed_point[1])
    
    # Define Region of Interest (ROI) limits
    half_roi = ROI_SIZE // 2
    x_start = max(seed_x - half_roi, 0)
    y_start = max(seed_y - half_roi, 0)
    x_end = min(x_start + ROI_SIZE, image.shape[1])
    y_end = min(y_start + ROI_SIZE, image.shape[0])
    
    # Check if ROI is valid
    if x_end - x_start < 20 or y_end - y_start < 20:
        return seed_point, DEFAULT_ROD_RADIUS_PX, True

    # Extract ROI
    roi = image[y_start:y_end, x_start:x_end]
    roi_seed_x = seed_x - x_start
    roi_seed_y = seed_y - y_start
    
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    
    # Bilateral filter preserves sharp edges while heavily blurring concrete noise/rust
    blurred = cv2.bilateralFilter(gray, 9, 75, 75)
    
    # Adaptive Otsu thresholding finds the optimal cutoff between the dark rod and background
    high_thresh, _ = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    low_thresh = 0.5 * high_thresh
    edges = cv2.Canny(blurred, low_thresh, high_thresh)
    
    # Ray-casting to find actual radius using the pre-computed angles
    radii_found = []
    for i in range(NUM_RAYS_FOR_RADIUS):
        cos_a = COS_ANGLES[i]
        sin_a = SIN_ANGLES[i]
        
        # Start at r=4 to ignore any immediate micro-noise directly on the click point
        for r in range(4, half_roi):
            tx = int(roi_seed_x + r * cos_a)
            ty = int(roi_seed_y + r * sin_a)
            
            # Check bounds
            if not (0 <= tx < edges.shape[1] and 0 <= ty < edges.shape[0]):
                break
                
            # If we hit an edge pixel (Canny contour), we found the boundary
            if edges[ty, tx] > 0:
                radii_found.append(r)
                break
    
    # Determine final radius
    if not radii_found or len(radii_found) < (NUM_RAYS_FOR_RADIUS * 0.25):
        # Fallback if detection wasn't confident (broken edges)
        return seed_point, DEFAULT_ROD_RADIUS_PX, True
        
    # Sort and take the median of the inner 60% of found edges.
    # This prevents the circle from bloating outwards due to rust stains or concrete craters.
    radii_found.sort()
    valid_radii = radii_found[:int(len(radii_found) * 0.6)]
    
    if not valid_radii:
        return seed_point, DEFAULT_ROD_RADIUS_PX, True
        
    final_radius = np.median(valid_radii)
    
    # Enforce minimum physical radius
    if final_radius < 5:
        final_radius = 5
        
    return seed_point, final_radius, False

def process_image(img_array, rod_points, ref_points, ref_length_mm):
    """
    Main orchestrator logic.
    """
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

def sort_points_clockwise(points):
    """
    Sorts a list of [x, y] points in a clockwise order starting precisely from the Top-Left corner.
    """
    if not points:
        return []
        
    # Calculate geometric centroid
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    
    def angle_from_centroid(p):
        # math.atan2(y, x) maps Top to -pi/2, Right to 0, Bottom to pi/2, Left to pi.
        # This naturally flows clockwise when sorted.
        return math.atan2(p[1] - cy, p[0] - cx)
        
    sorted_pts = sorted(points, key=angle_from_centroid)
    
    # Locate the absolute top-left point by finding minimum (x + y) value
    top_left_idx = 0
    min_sum = float('inf')
    
    for i, p in enumerate(sorted_pts):
        if (p[0] + p[1]) < min_sum:
            min_sum = (p[0] + p[1])
            top_left_idx = i
            
    # Rotate the sorted array so the Top-Left point becomes Index 0
    return sorted_pts[top_left_idx:] + sorted_pts[:top_left_idx]

def refine_gemini_points(img_array, gemini_data):
    """
    Takes normalized coordinates from Gemini [0.0 - 1.0] and refines them 
    to the exact pixel center of the dark rod using localized OpenCV thresholding and MinEnclosingCircle.
    """
    h, w = img_array.shape[:2]
    refined_points = []
    
    # Use a tightly constricted window (approx 4% of image size) so we only see the rod tip, not the shaft
    window_size = max(40, int(max(h, w) * 0.04)) 
    
    # Pre-instantiate CLAHE for lightning fast localized contrast enhancements
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    
    for pt in gemini_data:
        cx = int(pt.get('x', 0.5) * w)
        cy = int(pt.get('y', 0.5) * h)
        
        # Bound the local micro-window
        x1 = max(0, cx - window_size // 2)
        y1 = max(0, cy - window_size // 2)
        x2 = min(w, cx + window_size // 2)
        y2 = min(h, cy + window_size // 2)
        
        patch = img_array[y1:y2, x1:x2]
        
        if patch.size == 0:
            refined_points.append([cx, cy])
            continue
            
        gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
        
        # Apply CLAHE to dramatically improve contrast in highly shaded or brightly lit areas
        gray_clahe = clahe.apply(gray)
        blurred = cv2.GaussianBlur(gray_clahe, (5, 5), 0)
        
        # Otsu's binarization automatically finds the perfect threshold to separate the dark metal tip from the background
        _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        
        # Find dark blobs in the window
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        best_local_cx, best_local_cy = cx, cy
        found_valid = False
        
        if contours:
            # Filter extremely small noise dots
            valid_cnts = [c for c in contours if cv2.contourArea(c) > 10]
            if valid_cnts:
                patch_center = (window_size // 2, window_size // 2)
                
                # We want the contour that is closest to the Gemini prediction (the center of our patch)
                def dist_to_center(c):
                    M = cv2.moments(c)
                    if M["m00"] == 0: return 999999
                    mcx = int(M["m10"] / M["m00"])
                    mcy = int(M["m01"] / M["m00"])
                    return (mcx - patch_center[0])**2 + (mcy - patch_center[1])**2
                    
                best_c = min(valid_cnts, key=dist_to_center)
                
                # Minimum Enclosing Circle provides a mathematically perfect center for circular rod tips
                (center_x, center_y), radius = cv2.minEnclosingCircle(best_c)
                
                # Transform back to full image coordinates
                best_local_cx = x1 + int(center_x)
                best_local_cy = y1 + int(center_y)
                found_valid = True
        
        if found_valid:
            refined_points.append([best_local_cx, best_local_cy])
        else:
            # Fallback
            refined_points.append([cx, cy]) 
            
    # Return the points sorted strictly clockwise starting from Top-Left
    return sort_points_clockwise(refined_points)