from google import genai
from PIL import Image
import os
import json
import re
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY")
MODEL = 'gemini-flash-lite-latest'

# --- TOP VIEW PROMPT ---
PROMPT_TOP = """
Analyze the architectural rebar drawing to extract technical specifications.

Extraction rules:
1. Count: Count the main round black circles (rods).
2. Radius: Look for labels like "12mm" or "8mm". Diameter 12mm = Radius 6mm.
3. Spacings (The Perimeter):
   - You MUST generate a list of distances between adjacent rods following a Clockwise Path starting from Top-Left.
   - Horizontal Spacings: Look for labels like "125mm" or "200mm" between vertical lines.
   - Vertical Spacings: Look for side labels like "230mm" or "300mm".
   - Symmetry Rule: If a distance is labeled on one side (e.g., Bottom = 125mm), assume the opposite side (Top) is identical unless marked otherwise.
   - Total Width Rule: If a total width is given (e.g. 375mm) and rods look evenly spaced, divide accordingly.

Output Structure (Strict JSON):
{
  "count": Integer,
  "radius_mm": Float,
  "spacings_mm": [List of Floats representing the perimeter gaps in mm]
}

Example Logic:
- If drawing shows 6 rods (3 top, 3 bottom).
- Bottom label: "125mm" between rods. Side label: "230mm".
- List should represent: [Top-Left to Top-Mid, Top-Mid to Top-Right, Top-Right to Bot-Right, Bot-Right to Bot-Mid, Bot-Mid to Bot-Left, Bot-Left to Top-Left].
- Result: [125, 125, 230, 125, 125, 230]
"""

# --- SIDE VIEW PROMPT ---
PROMPT_SIDE = """
Analyze the architectural rebar drawing (Side/Elevation View).
Extract the **Vertical Spacing** (pitch) between the horizontal bars (stirrups/ties).

Look for labels like:
- "8mm @ 150mm c/c" (Spacing is 150)
- "Stirrups @ 200mm" (Spacing is 200)
- Arrows indicating vertical gap.

Output Structure (Strict JSON):
{
  "spacing_mm": Float (The target vertical distance between bars)
}
If not found, return 0.
"""

# --- DEFECT DETECTION PROMPT (REVIT) ---
PROMPT_DEFECT = """
Analyze the provided Site Photograph of a rebar column (Top View).
Your goal is to identify if any specific rod is significantly **misplaced, bent, or missing** compared to a standard symmetrical rectangular arrangement.

**Context - The Revit Model Numbering Scheme:**
The column consists of 8 main vertical rods arranged in 2 vertical lines.
- **Left Side (Top to Bottom):** Rod 1, Rod 2, Rod 3, Rod 4.
- **Right Side (Top to Bottom):** Rod 5, Rod 6, Rod 7, Rod 8.

**Visual Map:**
[1]      [5]
[2]      [6]
[3]      [7]
[4]      [8]

**Task:**
1. Look at the photo. Is there a rod that is clearly out of alignment, bent inward/outward, or missing compared to the others?
2. Map that specific rod to the Numbering Scheme above (1-8).
3. If all rods look generally okay/acceptable, set reset=true.
4. If a rod is wrong, set reset=false and provide the rod number.

**Output Structure (Strict JSON):**
{
  "reset": Boolean,   // true if no major defects, false if a defect exists
  "rod": Integer      // The Rod Number (1-8) to highlight. null if reset is true.
}
"""

# --- DEFECT DETECTION PROMPT (REVIT) - 4 RODS ---
PROMPT_DEFECT_4 = """
Analyze the provided Site Photograph of a rebar column (Top View).
Your goal is to identify if any specific rod is significantly **misplaced, bent, or missing** compared to a standard symmetrical rectangular arrangement.

**Context - The Revit Model Numbering Scheme:**
The column consists of 4 main vertical rods, one at each corner.

**Visual Map:**
[1] Top-Left     [2] Top-Right
[4] Bot-Left     [3] Bot-Right

**Task:**
1. Look at the photo. Is there a rod that is clearly out of alignment, bent inward/outward, or missing compared to the others?
2. Map that specific rod to the Numbering Scheme above (1-4).
3. If all rods look generally okay/acceptable, set reset=true.
4. If a rod is wrong, set reset=false and provide the rod number.

**Output Structure (Strict JSON):**
{
  "reset": Boolean,
  "rod": Integer   // The Rod Number (1-4) to highlight. null if reset is true.
}
"""

def _get_json_from_gemini(model, prompt, img_list):
    """Helper to call Gemini and parse JSON safely."""
    try:
        client = genai.Client(api_key=API_KEY)
        
        # Ensure contents is a list of [prompt, image1, image2...]
        contents = [prompt]
        if isinstance(img_list, list):
            contents.extend(img_list)
        else:
            contents.append(img_list)

        response = client.models.generate_content(
            model=model, 
            contents=contents
        )
        text = response.text
        
        # Regex to find JSON block within potential conversational text
        json_match = re.search(r'\{.*\}', text, re.DOTALL)
        
        if json_match:
            clean_json_string = json_match.group(0)
            return json.loads(clean_json_string)
        else:
            print(f"Gemini Warning: No JSON found in response: {text}")
            return None
    except Exception as e:
        print(f"Gemini Error: {e}")
        return None

def extract_design_data(design_image_path):
    """Top View Extraction"""
    data = _get_json_from_gemini(MODEL, PROMPT_TOP, Image.open(design_image_path))
    return data if data else {"count": 0, "radius_mm": 0, "spacings_mm": []}

def extract_side_design_data(design_image_path):
    """Side View Extraction"""
    data = _get_json_from_gemini(MODEL, PROMPT_SIDE, Image.open(design_image_path))
    return data if data else {"spacing_mm": 0}

def detect_defects_for_revit(real_image_path, design_image_path=None, rod_count=8):
    """
    Analyzes the Real Image to find a specific misplaced rod for Revit highlighting.
    Returns JSON: { "reset": bool, "rod": int }
    """
    images = [Image.open(real_image_path)]
    if design_image_path:
        images.append(Image.open(design_image_path))

    prompt = PROMPT_DEFECT_4 if rod_count == 4 else PROMPT_DEFECT
        
    data = _get_json_from_gemini(MODEL, prompt, images)
    
    if not data:
        return {"reset": True, "rod": None}
    return data
