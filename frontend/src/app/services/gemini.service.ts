import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

// --- PROMPTS ---
const PROMPT_TOP = `Analyze the architectural rebar drawing to extract technical specifications.

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
- Result: [125, 125, 230, 125, 125, 230]`;

const PROMPT_SIDE = `Analyze the architectural rebar drawing (Side/Elevation View).
Extract the **Vertical Spacing** (pitch) between the horizontal bars (stirrups/ties).

Look for labels like:
- "8mm @ 150mm c/c" (Spacing is 150)
- "Stirrups @ 200mm" (Spacing is 200)
- Arrows indicating vertical gap.

Output Structure (Strict JSON):
{
  "spacing_mm": Float (The target vertical distance between bars)
}
If not found, return 0.`;

const PROMPT_DEFECT = `Analyze the provided Site Photograph of a rebar column (Top View).
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
}`;

const PROMPT_DEFECT_4 = `Analyze the provided Site Photograph of a rebar column (Top View).
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

const PROMPT_AUTO_DETECT_SIDE = `You are an expert AI vision system. Analyze this Site Photograph of a concrete column from the side elevation.
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
}`;

@Injectable({ providedIn: 'root' })
export class GeminiService {
  constructor(private http: HttpClient) {}

  /** Compress and downscale image to a max dimension to save extreme bandwidth/LLM latency */
  async fileToBase64(file: File, maxDim: number = 600): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
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
        resolve(dataUrl.split(',')[1]); // return pure base64 payload
      };
      img.src = URL.createObjectURL(file);
    });
  }

  async extractDesignData(base64: string, viewMode: 'top' | 'side'): Promise<any> {
    const prompt = viewMode === 'side' ? PROMPT_SIDE : PROMPT_TOP;
    const data = await this.askGemini(prompt, [base64]);
    if (viewMode === 'side') return data || { spacing_mm: 0 };
    return data || { count: 0, radius_mm: 0, spacings_mm: [] };
  }

  async detectDefects(realB64: string, designB64: string, rodCount: number): Promise<any> {
    const prompt = rodCount === 4 ? PROMPT_DEFECT_4 : PROMPT_DEFECT;
    const data = await this.askGemini(prompt, [realB64, designB64]);
    return data || { reset: true, rod: null };
  }

  async getAutoDetectPoints(base64: string, viewMode: 'top' | 'side'): Promise<any[]> {
    const prompt = viewMode === 'side' ? PROMPT_AUTO_DETECT_SIDE : PROMPT_AUTO_DETECT_TOP;
    const data = await this.askGemini(prompt, [base64]);
    return data?.rods || [];
  }

  private async askGemini(prompt: string, base64Images: string[]): Promise<any> {
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
        // Fallback cleanup if Gemini returns markdown block inside JSON MIME
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        return null;
      }
    } catch (err) {
      console.error("Gemini API Error:", err);
      return null;
    }
  }
}