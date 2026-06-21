import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

// --- COMBINED PROMPTS ---
const PROMPT_COMBINED_TOP = `You are an expert structural inspector. Analyze the two provided images:
Image 1: Architectural Design Drawing
Image 2: Annotated Site Photograph (with R1, R2, etc. labels)

PART 1: DESIGN EXTRACTION (From Drawing)
Extract the following specifications:
1. Count: Count the main round black circles (rods).
2. Radius: Look for labels like "12mm" or "8mm". Diameter 12mm = Radius 6mm.
3. Spacings (The Perimeter):
   - You MUST generate a list of distances between adjacent rods following a Clockwise Path starting from Top-Left.
   - Horizontal Spacings: Look for labels like "125mm" or "200mm" between vertical lines.
   - Vertical Spacings: Look for side labels like "230mm" or "300mm".
   - Symmetry Rule: If a distance is labeled on one side, assume the opposite side is identical unless marked otherwise.
   - Total Width Rule: If a total width is given and rods look evenly spaced, divide accordingly.

PART 2: DEFECT DETECTION (From Annotated Photo)
Look at the annotated site photograph where the rods are explicitly labeled (R1, R2, R3...).
Identify if any specific rod is significantly misplaced, bent, or missing compared to a standard symmetrical rectangular arrangement.
- If all rods look generally aligned and acceptable, set reset=true, rods=[].
- If rods are clearly out of alignment, set reset=false and provide a list of their integer numbers (e.g., [3] or [2, 4]).

Output Structure (Strict JSON):
{
  "design": {
    "count": Integer,
    "radius_mm": Float,
    "spacings_mm": [List of Floats]
  },
  "defect": {
    "reset": Boolean,
    "rods": [List of Integers]
  }
}`;

const PROMPT_COMBINED_SIDE = `Analyze the architectural rebar drawing (Side/Elevation View).
Extract the **Vertical Spacing** (pitch) between the horizontal bars (stirrups/ties).
Also extract the **Least lateral dimension** of the column (if specified) and the **diameter** of the smallest longitudinal (main vertical) bar.

Look for labels like:
- "8mm @ 150mm c/c" (Spacing is 150)
- "Stirrups @ 200mm" (Spacing is 200)
- "Column 400x600" (Least lateral dim is 400)
- "6 - 20mm dia" (Longitudinal bar dia is 20)

Output Structure (Strict JSON):
{
  "design": {
    "spacing_mm": Float or null,
    "least_lateral_dim_mm": Float or null,
    "longitudinal_bar_dia_mm": Float or null
  },
  "defect": {
    "reset": true,
    "rods": []
  }
}`;

const PROMPT_AUTO_DETECT_TOP = `You are an expert AI vision system. Analyze this Site Photograph of a concrete block.
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
}`;

const PROMPT_AUTO_DETECT_SIDE = `You are an expert AI vision system. Analyze this Site Photograph of a 3D rebar column cage from the side elevation.
Identify the center points of the FOREGROUND horizontal bars (stirrups / ties).

CRITICAL RULES:
1. The structure is 3D. You will easily see horizontal bars on the front face (closest to camera) and the back face (further away/behind).
2. STRICTLY IGNORE all horizontal bars at the back. Do not place points on the rear ties.
3. ONLY mark the horizontal segments that are on the FRONT face, crossing between the two closest vertical rods in the foreground.
4. Provide exactly one center point for each visible front horizontal tie.
5. Return their exact coordinates as normalized floats between 0.000 and 1.000.
(x=0.0 is the left edge, x=1.0 is the right edge, y=0.0 is the top edge, y=1.0 is the bottom edge).
6. Sort the points strictly from top to bottom based on the y-coordinate.

Output Structure (Strict JSON):
{
  "rods": [
    {"x": 0.500, "y": 0.200},
    {"x": 0.500, "y": 0.400},
    {"x": 0.500, "y": 0.600},
    {"x": 0.500, "y": 0.800}
  ]
}`;

@Injectable({ providedIn: 'root' })
export class GeminiService {
  constructor(private http: HttpClient) {}

  async fileToBase64(file: File, maxDim: number = 1000): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let w = img.width;
        let h = img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
        
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        resolve(dataUrl.split(',')[1]); 
      };
      img.src = objectUrl;
    });
  }

  async analyzeDesignAndDefects(designB64: string, annotatedB64: string | null, viewMode: 'top' | 'side'): Promise<any> {
    const prompt = viewMode === 'side' ? PROMPT_COMBINED_SIDE : PROMPT_COMBINED_TOP;
    const images = (annotatedB64 && viewMode === 'top') ? [designB64, annotatedB64] : [designB64];
    
    const data = await this.askGemini(prompt, images);

    if (!data) {
      if (viewMode === 'side') return { design: { spacing_mm: 0, least_lateral_dim_mm: 0, longitudinal_bar_dia_mm: 0 }, defect: { reset: true, rods: [] } };
      return { design: { count: 0, radius_mm: 0, spacings_mm: [] }, defect: { reset: true, rods: [] } };
    }

    return {
      design: data.design || (viewMode === 'side' ? { spacing_mm: 0, least_lateral_dim_mm: 0, longitudinal_bar_dia_mm: 0 } : { count: 0, radius_mm: 0, spacings_mm: [] }),
      defect: data.defect || { reset: true, rods: [] }
    };
  }

  async getAutoDetectPoints(base64: string, viewMode: 'top' | 'side'): Promise<any[]> {
    const prompt = viewMode === 'side' ? PROMPT_AUTO_DETECT_SIDE : PROMPT_AUTO_DETECT_TOP;
    const data = await this.askGemini(prompt, [base64]);
    return data?.rods || [];
  }

  private async askGemini(prompt: string, base64Images: string[], retries: number = 1): Promise<any> {
    try {
      const url = `${environment.gemprismBaseUrl}/api/proxy/v1beta/models/gemini-flash-latest:generateContent?key=${environment.gemprismApiKey}`;
      
      const parts: any[] = [{ text: prompt }];
      base64Images.forEach(b64 => {
        if (b64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
      });

      const payload = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' }
      };

      const response: any = await firstValueFrom(this.http.post(url, payload));
      const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      try {
        return JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        return null;
      }
    } catch (err) {
      if (retries > 0) {
        console.warn(`Gemini Gateway timeout, retrying... (${retries} retries left)`, err);
        return await this.askGemini(prompt, base64Images, retries - 1);
      }
      console.error("Gemini API Error:", err);
      return null;
    }
  }
}