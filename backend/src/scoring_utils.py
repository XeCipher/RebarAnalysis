import numpy as np

def safe_float(value, default=0.0):
    """Safely converts value to float, handling None and strings."""
    try:
        if value is None:
            return default
        return float(value)
    except (ValueError, TypeError):
        return default

def safe_int(value, default=0):
    """Safely converts value to int."""
    try:
        if value is None:
            return default
        return int(float(value)) # Handle "6.0" strings
    except (ValueError, TypeError):
        return default

# --- TOP VIEW SCORING ---
def calculate_similarity_and_table(design_data, actual_data, has_scale):
    """
    Compares extracted design data vs actual calculated data sequentially.
    Returns (similarity_score, comparison_table_list)
    """
    
    table_rows = []
    
    # 1. Number of Bars (Weight: 40%)
    d_count = safe_int(design_data.get('count'))
    a_count = safe_int(actual_data.get('count'))
    
    diff_count = abs(d_count - a_count)
    score_count = max(0, 100 - (diff_count * 25))
    
    table_rows.append({
        "parameter": "Number of rods",
        "design": str(d_count),
        "actual": str(a_count),
        "status": "Acceptable" if diff_count == 0 else "Not Acceptable"
    })

    # 2. Radius (Weight: 20%)
    score_radius = 100 # Default neutral if no scale
    d_rad = safe_float(design_data.get('radius_mm'))
    a_rad = safe_float(actual_data.get('avg_radius'))
    
    radius_status = "NA"
    actual_display = ""

    if has_scale and d_rad > 0:
        # Compare mm to mm
        err_rad = abs(d_rad - a_rad)
        percent_err = (err_rad / d_rad) * 100
        score_radius = max(0, 100 - percent_err)
        
        if percent_err <= 5: radius_status = "Acceptable"
        elif percent_err <= 15: radius_status = "Minor Mismatch"
        else: radius_status = "Not Acceptable"
        
        actual_display = f"{a_rad:.2f} mm"
    else:
        # Pixel vs mm -> NA
        unit = "mm" if has_scale else "px"
        actual_display = f"{a_rad:.2f} {unit}"
        score_radius = 100

    table_rows.append({
        "parameter": "Radius of rods (avg)",
        "design": f"{d_rad} mm" if d_rad > 0 else "Not Specified",
        "actual": actual_display,
        "status": radius_status
    })

    # 3. Sequential Spacing (Weight: 40%)
    raw_d_spacings = design_data.get('spacings_mm')
    if raw_d_spacings is None: raw_d_spacings = []
    d_spacings = [safe_float(x) for x in raw_d_spacings]

    raw_a_spacings = actual_data.get('distances')
    if raw_a_spacings is None: raw_a_spacings = []
    a_spacings = [safe_float(x) for x in raw_a_spacings]
    
    score_spacing_accum = 0
    valid_spacing_checks = 0
    
    if a_count > 1:
        # Get Max for Relative Comparison
        d_max = max(d_spacings) if d_spacings and max(d_spacings) > 0 else 1.0
        a_max = max(a_spacings) if a_spacings and max(a_spacings) > 0 else 1.0

        for i in range(a_count):
            r_start = i + 1
            r_end = (i + 1) % a_count + 1
            param_label = f"Distance R{r_start} to R{r_end}"
            
            val_actual = a_spacings[i] if i < len(a_spacings) else 0.0
            val_design = d_spacings[i] if i < len(d_spacings) else None
            
            row_status = "NA" 
            
            if val_design is not None:
                if has_scale:
                    # Absolute (mm vs mm)
                    if val_design > 0:
                        err = abs(val_design - val_actual)
                        pct = (err / val_design) * 100
                        
                        if pct <= 5: row_status = "Acceptable"
                        elif pct <= 15: row_status = "Minor Mismatch"
                        else: row_status = "Not Acceptable"
                        
                        score_spacing_accum += max(0, 100 - pct)
                        valid_spacing_checks += 1
                else:
                    # Relative (Ratio comparison)
                    if val_design > 0:
                        d_norm = val_design / d_max
                        a_norm = val_actual / a_max
                        diff_ratio = abs(d_norm - a_norm)
                        
                        score_spacing_accum += max(0, 100 - (diff_ratio * 100))
                        valid_spacing_checks += 1
                        row_status = "NA" 
            
            table_rows.append({
                "parameter": param_label,
                "design": f"{val_design} mm" if val_design is not None else "Not Specified",
                "actual": f"{val_actual:.2f} {'mm' if has_scale else 'px'}",
                "status": row_status
            })

    score_spacing = score_spacing_accum / valid_spacing_checks if valid_spacing_checks > 0 else (100 if a_count == d_count else 0)
    
    if has_scale:
        final_score = (0.4 * score_count) + (0.4 * score_spacing) + (0.2 * score_radius)
    else:
        final_score = (0.5 * score_count) + (0.5 * score_spacing)
        
    return int(final_score), table_rows

# --- SIDE VIEW SCORING ---
def calculate_side_view_score(design_data, actual_data, has_scale):
    """
    Scoring for Side View. Only compares vertical spacing. 
    Ignores angle.
    """
    d_spacing = safe_float(design_data.get('spacing_mm'))
    a_spacing = safe_float(actual_data.get('spacing')) 
    
    table_rows = []
    score = 0
    status = "NA"
    
    if has_scale and d_spacing > 0:
        # Compare mm vs mm
        diff = abs(d_spacing - a_spacing)
        error_pct = (diff / d_spacing) * 100
        score = max(0, 100 - error_pct)
        
        if error_pct <= 5: status = "Acceptable"
        elif error_pct <= 15: status = "Minor Mismatch"
        else: status = "Not Acceptable"
        
        actual_str = f"{a_spacing:.2f} mm"
    else:
        # No Scale or No Design data found
        # We return a generic 85% score if detection worked but we can't verify dimension
        if a_spacing > 0:
            score = 85 
        else:
            score = 0
            
        unit = "mm" if has_scale else "px"
        actual_str = f"{a_spacing:.2f} {unit}"
    
    table_rows.append({
        "parameter": "Vertical Spacing",
        "design": f"{d_spacing} mm" if d_spacing > 0 else "Not Specified",
        "actual": actual_str,
        "status": status
    })
    
    return int(score), table_rows