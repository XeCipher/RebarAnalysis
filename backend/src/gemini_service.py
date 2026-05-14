from google import genai
from google.genai import types
from PIL import Image
import os
import json
import re
import io
from dotenv import load_dotenv

load_dotenv()

GEMPRISM_API_KEY = os.getenv("GEMPRISM_API_KEY")
GEMPRISM_BASE_URL = os.getenv("GEMPRISM_BASE_URL", "https://gemprism.vercel.app")

MODEL = 'gemini-flash-latest'

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

# --- AUTO DETECT PROMPTS (HYBRID CV-AI) ---
PROMPT_AUTO_DETECT_TOP = """
You are an expert AI vision system. Analyze this Site Photograph of a concrete block.
Identify the center points of all protruding rusty rebar rod top-ends.
There are usually exactly 4, exactly 6, exactly 8 or any even number of rods in these images.
Return their exact coordinates as normalized floats between 0.000 and 1.000.
(x=0.0 is the left edge, x=1.0 is the right edge, y=0.0 is the top edge, y=1.0 is the bottom edge).
Ignore chalk marks, wooden planks, and background objects. Only mark the actual protruding rebar rods.

Output Structure (Strict JSON):
{
  "rods": [
    {"x": 0.250, "y": 0.300},
    {"x": 0.750, "y": 0.300}
  ]
}
"""

PROMPT_AUTO_DETECT_SIDE = """
You are an expert AI vision system. Analyze this Site Photograph of a concrete column from the side elevation.
Identify the center points of exactly TWO prominent horizontal bars (stirrups / ties).
Pick two clear distinct bars separated by a gap vertically.
Return their exact coordinates as normalized floats between 0.000 and 1.000.
(x=0.0 is the left edge, x=1.0 is the right edge, y=0.0 is the top edge, y=1.0 is the bottom edge).

Output Structure (Strict JSON):
{
  "rods": [
    {"x": 0.500, "y": 0.350},
    {"x": 0.500, "y": 0.650}
  ]
}
"""

def _get_json_from_gemini(model, prompt, img_list):
    """Helper to call Gemini and parse JSON safely, forcing application/json type."""
    try:
        client = genai.Client(
            api_key=GEMPRISM_API_KEY,
            http_options={'base_url': f"{GEMPRISM_BASE_URL}/api/proxy"}
        )
        
        contents = [prompt]
        if isinstance(img_list, list):
            contents.extend(img_list)
        else:
            contents.append(img_list)

        response = client.models.generate_content(
            model=model, 
            contents=contents,
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            )
        )
        text = response.text
        
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            json_match = re.search(r'\{.*\}', text, re.DOTALL)
            if json_match:
                return json.loads(json_match.group(0))
            else:
                print(f"Gemini Warning: No JSON found in response: {text}")
                return None
    except Exception as e:
        print(f"Gemini Error: {e}")
        return None

def extract_design_data(design_image_bytes):
    """Top View Extraction. Expects raw bytes."""
    data = _get_json_from_gemini(MODEL, PROMPT_TOP, Image.open(io.BytesIO(design_image_bytes)))
    return data if data else {"count": 0, "radius_mm": 0, "spacings_mm": []}

def extract_side_design_data(design_image_bytes):
    """Side View Extraction. Expects raw bytes."""
    data = _get_json_from_gemini(MODEL, PROMPT_SIDE, Image.open(io.BytesIO(design_image_bytes)))
    return data if data else {"spacing_mm": 0}

def detect_defects_for_revit(real_image_bytes, design_image_bytes=None, rod_count=8):
    """
    Analyzes the Real Image to find a specific misplaced rod for Revit highlighting.
    Returns JSON: { "reset": bool, "rod": int }. Expects raw bytes.
    """
    images = [Image.open(io.BytesIO(real_image_bytes))]
    if design_image_bytes:
        images.append(Image.open(io.BytesIO(design_image_bytes)))

    prompt = PROMPT_DEFECT_4 if rod_count == 4 else PROMPT_DEFECT
        
    data = _get_json_from_gemini(MODEL, prompt, images)
    
    if not data:
        return {"reset": True, "rod": None}
    return data

def get_auto_detect_points(image_bytes, view_mode='top'):
    """
    Uses Gemini Vision to map the coordinates of the rods contextually.
    Returns a list of dicts: [{"x": float, "y": float}, ...]
    """
    prompt = PROMPT_AUTO_DETECT_SIDE if view_mode == 'side' else PROMPT_AUTO_DETECT_TOP
    data = _get_json_from_gemini(MODEL, prompt, Image.open(io.BytesIO(image_bytes)))
    if data and 'rods' in data:
        return data['rods']
    return []