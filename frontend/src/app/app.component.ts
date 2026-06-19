import { Component, ElementRef, ViewChild, ChangeDetectionStrategy, ChangeDetectorRef, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { LucideAngularModule, Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson, Wand2, Info, HelpCircle, Calculator, X, Timer, DownloadCloud, Copy, FileCode, Box } from 'lucide-angular';
import { FormsModule } from '@angular/forms';
import { Subscription, firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';
import { GeminiService } from './services/gemini.service';
import { ScoringService, ComparisonRow } from './services/scoring.service';

export interface ApiResponse {
  status: string;
  score: number;
  quality_tier?: { label: string; color: 'green' | 'yellow' | 'red' };
  score_count?: number | null;
  score_radius?: number | null;
  score_spacing?: number | null;
  comparison_table: ComparisonRow[];
  annotated_image: string;
  revit_data?: any;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush 
})
export class AppComponent implements OnInit, OnDestroy {
  icons = { Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson, Wand2, Info, HelpCircle, Calculator, X, Timer, DownloadCloud, Copy, FileCode, Box };

  // State
  viewMode: 'top' | 'side' = 'top';
  realImageFile: File | null = null;
  designImageFile: File | null = null;
  realImagePreview: string | null = null;
  mode: 'rods' | 'ref' = 'rods';
  
  rodPoints: number[][] = [];
  refPoints: number[][] = [];
  refLengthInput: number = 100;
  
  imgNatWidth: number = 0;
  imgNatHeight: number = 0;
  
  isAnalyzing = false;
  isAutoDetecting = false;
  analysisSub: Subscription | null = null;
  
  result: ApiResponse | null = null;
  errorMsg: string | null = null;
  revitData: any = null;

  showScoreModal: boolean = false;
  showDownloadsMenu: boolean = false;
  copiedStates: { [key: string]: boolean } = {};

  // Email notification state
  columnNumber: string = '';
  authorityEmail: string = '';
  isEmailSending: boolean = false;
  emailSent: boolean = false;

  // Performance Timers (Merged AI)
  timers = {
    autoDetect: 0,
    autoDetectRunning: false,
    total: 0,
    cv: 0,
    cvRunning: false,
    ai: 0,
    aiRunning: false
  };
  private intervals: any[] = [];

  // Drag Drop Variables
  draggingPointIndex: number | null = null;
  draggingPointType: 'rod' | 'ref' | null = null;
  dragStartX = 0;
  dragStartY = 0;
  dragStartPointX = 0;
  dragStartPointY = 0;
  hasMoved = false;

  @ViewChild('imageRef') imageElement!: ElementRef<HTMLImageElement>;
  @ViewChild('downloadsMenuRef') downloadsMenuRef?: ElementRef;

  constructor(
    private http: HttpClient, 
    private cdr: ChangeDetectorRef,
    private gemini: GeminiService,
    private scoring: ScoringService
  ) {}

  ngOnInit() {
    this.http.get(environment.apiBaseUrl + '/', { responseType: 'text' }).subscribe({
      next: () => console.log('Backend warmed up successfully.'),
      error: () => console.log('Ping sent to wake up backend.')
    });

    const analyticsId = (environment as any).googleAnalyticsId;
    if (analyticsId) {
      const script = document.createElement('script');
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${analyticsId}`;
      document.head.appendChild(script);

      (window as any).dataLayer = (window as any).dataLayer || [];
      function gtag(...args: any[]) { (window as any).dataLayer.push(args); }
      gtag('js', new Date());
      gtag('config', analyticsId);
    }
  }

  ngOnDestroy() {
    this.intervals.forEach(i => clearInterval(i));
    if (this.analysisSub) this.analysisSub.unsubscribe();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    // Closes the downloads dropdown if the click target is outside the dropdown container
    if (this.showDownloadsMenu && this.downloadsMenuRef && !this.downloadsMenuRef.nativeElement.contains(event.target)) {
      this.showDownloadsMenu = false;
      this.cdr.markForCheck();
    }
  }

  toggleDownloadsMenu() {
    this.showDownloadsMenu = !this.showDownloadsMenu;
    this.cdr.markForCheck();
  }

  // --- Quality Status Classifier ---
  getQualityTier(score: number): { label: string, color: 'green' | 'yellow' | 'red' } {
    if (score > 95) return { label: 'Excellent', color: 'green' };
    if (score >= 90) return { label: 'Acceptable', color: 'green' };
    if (score >= 80) return { label: 'Minor Deviation', color: 'yellow' };
    if (score >= 70) return { label: 'Major Deviation', color: 'red' };
    return { label: 'Defective', color: 'red' };
  }

  // --- Image Handling & Compression Tool ---
  async compressFile(file: File, maxDim: number, quality: number = 0.85): Promise<File> {
    return new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let w = img.width;
        let h = img.height;
        if (w <= maxDim && h <= maxDim) {
            resolve(file);
            return;
        }
        const scale = maxDim / Math.max(w, h);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
        
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, w, h);
        
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(new File([blob], file.name, { type: 'image/jpeg' }));
            } else {
                resolve(file);
            }
        }, 'image/jpeg', quality);
      };
      img.src = objectUrl;
    });
  }

  toggleScoreModal() {
    this.showScoreModal = !this.showScoreModal;
    this.cdr.markForCheck();
  }

  toggleViewMode() {
    const newMode = this.viewMode === 'top' ? 'side' : 'top';
    this.setViewMode(newMode);
  }

  setViewMode(mode: 'top' | 'side') {
    if (this.viewMode !== mode) {
      this.viewMode = mode;
      this.fullReset();
    }
  }

  fullReset() {
    this.cancelAutoDetect();
    this.cancelAnalysis();
    this.realImageFile = null;
    this.designImageFile = null;
    this.realImagePreview = null;
    this.timers.autoDetect = 0;
    this.resetMarkings();
  }

  resetMarkings() {
    this.rodPoints = [];
    this.refPoints = [];
    this.result = null;
    this.revitData = null;
    this.mode = 'rods';
    this.errorMsg = null;
    this.columnNumber = '';
    this.authorityEmail = '';
    this.isEmailSending = false;
    this.emailSent = false;
    this.cdr.markForCheck();
  }

  onFileSelected(event: any, type: 'real' | 'design') {
    const file = event.target.files[0];
    if (file) {
      if (type === 'real') {
        this.realImageFile = file;
        const reader = new FileReader();
        reader.onload = (e: any) => {
          this.realImagePreview = e.target.result;
          this.resetMarkings();
          setTimeout(() => {
            this.mode = 'rods';
            this.autoDetect();
          }, 150);
        };
        reader.readAsDataURL(file);
      } else {
        this.designImageFile = file;
      }
      this.cdr.markForCheck();
    }
  }

  onImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    this.imgNatWidth = img.naturalWidth;
    this.imgNatHeight = img.naturalHeight;
    this.cdr.markForCheck();
  }

  onImageClick(event: MouseEvent) {
    if (!this.realImagePreview) return;

    const img = this.imageElement.nativeElement;
    this.imgNatWidth = img.naturalWidth;
    this.imgNatHeight = img.naturalHeight;

    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    const x = Math.round((event.clientX - rect.left) * scaleX);
    const y = Math.round((event.clientY - rect.top) * scaleY);

    if (this.mode === 'rods') {
      this.rodPoints = [...this.rodPoints, [x, y]];
    } else {
      if (this.refPoints.length < 2) {
        this.refPoints = [...this.refPoints, [x, y]];
      }
    }
    this.cdr.markForCheck();
  }

  onPointerDown(event: PointerEvent, index: number, type: 'rod' | 'ref') {
    event.preventDefault();
    event.stopPropagation();
    this.draggingPointIndex = index;
    this.draggingPointType = type;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    
    const pt = type === 'rod' ? this.rodPoints[index] : this.refPoints[index];
    this.dragStartPointX = pt[0];
    this.dragStartPointY = pt[1];
    this.hasMoved = false;

    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent) {
    if (this.draggingPointIndex === null) return;
    event.preventDefault();
    event.stopPropagation();

    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.hasMoved = true;

    if (this.hasMoved) {
      const img = this.imageElement.nativeElement;
      const rect = img.getBoundingClientRect();
      const scaleX = img.naturalWidth / rect.width;
      const scaleY = img.naturalHeight / rect.height;

      const newX = this.dragStartPointX + (dx * scaleX);
      const newY = this.dragStartPointY + (dy * scaleY);

      const clampedX = Math.round(Math.max(0, Math.min(newX, img.naturalWidth)));
      const clampedY = Math.round(Math.max(0, Math.min(newY, img.naturalHeight)));

      if (this.draggingPointType === 'rod') {
        const newPoints = [...this.rodPoints];
        newPoints[this.draggingPointIndex] = [clampedX, clampedY];
        this.rodPoints = newPoints;
      } else {
        const newPoints = [...this.refPoints];
        newPoints[this.draggingPointIndex] = [clampedX, clampedY];
        this.refPoints = newPoints;
      }
      this.cdr.markForCheck();
    }
  }

  onPointerUp(event: PointerEvent, index: number, type: 'rod' | 'ref') {
    if (this.draggingPointIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);

    if (!this.hasMoved) {
      if (type === 'rod') this.rodPoints = this.rodPoints.filter((_, i) => i !== index);
      else this.refPoints = this.refPoints.filter((_, i) => i !== index);
      this.cdr.markForCheck();
    }
    this.draggingPointIndex = null;
    this.draggingPointType = null;
  }

  undoLast() {
    if (this.mode === 'rods' && this.rodPoints.length > 0) this.rodPoints = this.rodPoints.slice(0, -1);
    else if (this.mode === 'ref' && this.refPoints.length > 0) this.refPoints = this.refPoints.slice(0, -1);
    this.cdr.markForCheck();
  }

  setMode(m: 'rods' | 'ref') {
    this.mode = m;
    this.cdr.markForCheck();
  }

  sortPointsClockwise(points: number[][]): number[][] {
    if (!points || points.length === 0) return [];
    
    // Calculate geometric centroid
    const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    
    // Sort around the centroid
    let sortedPts = [...points].sort((a, b) => {
      const angleA = Math.atan2(a[1] - cy, a[0] - cx);
      const angleB = Math.atan2(b[1] - cy, b[0] - cx);
      return angleA - angleB;
    });
    
    // Locate the absolute top-left point by finding minimum (x + y) value
    let topLeftIdx = 0;
    let minSum = Infinity;
    
    for (let i = 0; i < sortedPts.length; i++) {
      const sum = sortedPts[i][0] + sortedPts[i][1];
      if (sum < minSum) {
        minSum = sum;
        topLeftIdx = i;
      }
    }
    
    return [...sortedPts.slice(topLeftIdx), ...sortedPts.slice(0, topLeftIdx)];
  }

  async autoDetect() {
    if (!this.realImageFile) return;
    this.isAutoDetecting = true;
    
    this.timers.autoDetectRunning = true;
    this.timers.autoDetect = 0;
    const adStart = performance.now();
    const adInterval = setInterval(() => {
      if(this.timers.autoDetectRunning) {
        this.timers.autoDetect = (performance.now() - adStart) / 1000;
        this.cdr.markForCheck();
      }
    }, 30);
    this.intervals.push(adInterval);

    const finishAutoDetect = () => {
      this.timers.autoDetectRunning = false;
      this.isAutoDetecting = false;
      clearInterval(adInterval);
      this.cdr.markForCheck();
    };

    try {
      if (this.imgNatWidth === 0 && this.imageElement?.nativeElement) {
         this.imgNatWidth = this.imageElement.nativeElement.naturalWidth;
         this.imgNatHeight = this.imageElement.nativeElement.naturalHeight;
      }

      const tinyB64 = await this.gemini.fileToBase64(this.realImageFile, 400);
      const aiPoints = await this.gemini.getAutoDetectPoints(tinyB64, this.viewMode);
      
      if (!aiPoints || aiPoints.length === 0) {
          finishAutoDetect();
          return;
      }

      let mappedPoints = aiPoints.map((pt: any) => [
          Math.round((pt.x || 0.5) * this.imgNatWidth),
          Math.round((pt.y || 0.5) * this.imgNatHeight)
      ]);

      if (this.viewMode === 'top') {
        this.rodPoints = this.sortPointsClockwise(mappedPoints);
      } else {
        this.rodPoints = mappedPoints.sort((a, b) => a[1] - b[1]);
      }

      finishAutoDetect();
      
    } catch (e) {
      console.error("Auto detection engine failed:", e);
      finishAutoDetect();
    }
  }

  cancelAutoDetect() {
    this.timers.autoDetectRunning = false;
    this.isAutoDetecting = false;
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
    this.cdr.markForCheck();
  }

  cancelAnalysis() {
    this.isAnalyzing = false;
    if (this.analysisSub) {
      this.analysisSub.unsubscribe();
      this.analysisSub = null;
    }
    this.timers.cvRunning = false;
    this.timers.aiRunning = false;
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
    this.cdr.markForCheck();
  }

  async analyze() {
    if (!this.realImageFile) return;
    if (this.rodPoints.length < 2) { alert("Please mark points on the image first."); return; }
    if (!this.designImageFile) {
      const proceed = confirm("No Design Drawing uploaded. Comparison score will be based on geometry only. Continue?");
      if (!proceed) return;
    }

    this.isAnalyzing = true;
    this.errorMsg = null;
    this.result = null;
    this.revitData = null;
    this.emailSent = false;
    this.isEmailSending = false;
    
    this.timers.total = 0;
    this.timers.cv = 0; this.timers.cvRunning = false;
    this.timers.ai = 0; this.timers.aiRunning = false;

    const overallStart = performance.now();
    let cvStart = overallStart;
    let aiStart = overallStart;

    const aInterval = setInterval(() => {
      const now = performance.now();
      this.timers.total = (now - overallStart) / 1000;
      if (this.timers.cvRunning) this.timers.cv = (now - cvStart) / 1000;
      if (this.timers.aiRunning) this.timers.ai = (now - aiStart) / 1000;
      this.cdr.markForCheck();
    }, 30);
    this.intervals.push(aInterval);

    this.cdr.markForCheck();
    
    try {
      const normRodPoints = this.rodPoints.map(p => [p[0] / this.imgNatWidth, p[1] / this.imgNatHeight]);
      const normRefPoints = this.refPoints.map(p => [p[0] / this.imgNatWidth, p[1] / this.imgNatHeight]);

      // 1. Run Computer Vision Service
      this.timers.cvRunning = true;
      cvStart = performance.now();
      
      const compressedReal = await this.compressFile(this.realImageFile!, 1600, 0.9);
      const formData = new FormData();
      formData.append('real_image', compressedReal);
      formData.append('rod_points', JSON.stringify(normRodPoints));
      formData.append('ref_points', JSON.stringify(normRefPoints));
      formData.append('ref_length', this.refPoints.length === 2 ? this.refLengthInput.toString() : '0');

      const endpoint = this.viewMode === 'top' ? '/analyze-cv' : '/analyze-cv/side';
      const cvRes = await firstValueFrom(this.http.post<any>(`${environment.apiBaseUrl}${endpoint}`, formData));
      
      this.timers.cvRunning = false;
      this.timers.cv = (performance.now() - cvStart) / 1000;

      if (cvRes?.status !== 'success') {
         throw new Error("Computer Vision processing failed.");
      }

      // 2. Run Gemini Engine, passing the annotated image
      let designData: any = this.viewMode === 'side' 
        ? { spacing_mm: 0, least_lateral_dim_mm: 0, longitudinal_bar_dia_mm: 0 } 
        : { count: 0, radius_mm: 0, spacings_mm: [] };
      let defectData = { reset: true, rod: null as number | null, column_id: 'C8' };

      if (this.designImageFile) {
        this.timers.aiRunning = true;
        aiStart = performance.now();
        
        const designB64 = await this.gemini.fileToBase64(this.designImageFile, 700);
        const annotatedB64 = cvRes.annotated_image.split(',')[1];
        
        // Use analyzeDesignAndDefects for the original website
        const aiRes = await this.gemini.analyzeDesignAndDefects(designB64, annotatedB64, this.viewMode);
        
        designData = aiRes.design;
        defectData = aiRes.defect;

        this.timers.aiRunning = false;
        this.timers.ai = (performance.now() - aiStart) / 1000;
      }

      // 3. Final Scoring Calculations
      let scoreData;
      if (this.viewMode === 'top') {
        scoreData = this.scoring.calculateTopScore(designData, cvRes.actual_data, cvRes.has_scale);
      } else {
        scoreData = this.scoring.calculateSideScore(designData, cvRes.actual_data, cvRes.has_scale);
      }

      // --- Feature 1: Force Rod Highlight fallback if AI misses an unacceptable distance ---
      if (this.viewMode === 'top' && defectData.reset) {
        const badDistanceRow = scoreData.table.find(r => r.status === 'Not Acceptable' && r.parameter.includes('Distance'));
        if (badDistanceRow) {
          const match = badDistanceRow.parameter.match(/Distance R(\d+)/i);
          if (match && match[1]) {
            defectData.reset = false;
            defectData.rod = parseInt(match[1], 10);
          }
        }
      }

      // 4. Inject Dynamic Column ID for Revit Scripts
      const aCount = cvRes.actual_data.count || 8;
      defectData.column_id = 'C' + aCount;

      // 5. Quality Tier evaluation
      const qualityTier = this.getQualityTier(scoreData.score);

      this.result = {
        status: 'success',
        score: scoreData.score,
        quality_tier: qualityTier,
        score_count: scoreData.score_count,
        score_radius: scoreData.score_radius,
        score_spacing: scoreData.score_spacing,
        comparison_table: scoreData.table,
        annotated_image: cvRes.annotated_image,
      };
      
      this.revitData = defectData;

    } catch (err: any) {
      console.error(err);
      this.errorMsg = `Analysis Error: ${err.message || 'Server timeout or network failure.'}`;
    } finally {
      this.isAnalyzing = false;
      this.timers.cvRunning = false;
      this.timers.aiRunning = false;
      clearInterval(aInterval);
      this.cdr.markForCheck();
    }
  }

  sendEmailReport() {
    if (!this.columnNumber) { alert("Please enter the Column Number (e.g., C1)."); return; }
    if (!this.authorityEmail) { alert("Please enter the Authority's Email Address."); return; }
    if (!this.result) return;

    this.isEmailSending = true;
    this.cdr.markForCheck();
    
    const payload = {
      column_number: this.columnNumber,
      email: this.authorityEmail,
      score: this.result.score,
      label: this.result.quality_tier?.label || 'Defective',
      table: this.result.comparison_table,
      image: this.result.annotated_image
    };

    this.http.post<any>(`${environment.apiBaseUrl}/send-email-report`, payload).subscribe({
      next: (res) => {
        if (res.status === 'success') this.emailSent = true;
        else alert("Failed to send email: " + res.message);
        this.isEmailSending = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        alert("Server error while sending email.");
        console.error(err);
        this.isEmailSending = false;
        this.cdr.markForCheck();
      }
    });
  }

  async copyScript(scriptName: string) {
    try {
      const response = await firstValueFrom(this.http.get(`assets/downloads/${scriptName}`, { responseType: 'text' }));
      await navigator.clipboard.writeText(response);
      
      this.copiedStates[scriptName] = true;
      this.cdr.markForCheck();
      
      setTimeout(() => {
        this.copiedStates[scriptName] = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch (err) {
      console.error(err);
      alert(`Could not load ${scriptName}. Make sure it is placed in the frontend/public/assets/downloads/ folder.`);
    }
  }

  trackByIndex(index: number): number { return index; }

  downloadRevitJson() {
    if (!this.revitData) return;
    const jsonString = JSON.stringify(this.revitData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'highlight_rod.json'; a.click();
    window.URL.revokeObjectURL(url);
  }

  downloadRodLinesJson() {
    if (!this.result) return;
    const lines: { from: number; to: number; status: string }[] = [];
    const distanceRegex = /Distance R(\d+) to R(\d+)/i;

    for (const row of this.result.comparison_table) {
      const match = row.parameter.match(distanceRegex);
      if (match) {
        lines.push({ from: parseInt(match[1]), to: parseInt(match[2]), status: row.status });
      }
    }

    const rodCount = this.result.comparison_table.find(r => r.parameter === 'Number of rods')?.actual || '8';
    const rodLinesData = { reset: lines.length === 0, column_id: 'C' + rodCount, lines: lines };
    
    const jsonString = JSON.stringify(rodLinesData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rod_lines.json'; a.click();
    window.URL.revokeObjectURL(url);
  }

  downloadCSV() {
    if (!this.result) return;
    const headers = ['Parameter', 'Design Spec', 'Site Actual', 'Status'];
    const rows = this.result.comparison_table.map(row => [row.parameter, row.design, row.actual, row.status]
        .map(val => `"${val}"`).join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'report.csv'; a.click();
    window.URL.revokeObjectURL(url);
  }

  getStatusClass(status: string) {
    switch(status) {
      case 'Acceptable': return 'status-ok';
      case 'Minor Mismatch': return 'status-warn';
      case 'Not Acceptable': return 'status-bad';
      default: return 'status-na';
    }
  }
}