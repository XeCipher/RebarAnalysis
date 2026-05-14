import { Component, ElementRef, ViewChild, ChangeDetectionStrategy, ChangeDetectorRef, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { LucideAngularModule, Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson, Wand2, Info } from 'lucide-angular';
import { FormsModule } from '@angular/forms';
import { forkJoin, from, Subscription } from 'rxjs';
import { environment } from '../environments/environment';
import { GeminiService } from './services/gemini.service';
import { ScoringService, ComparisonRow } from './services/scoring.service';

export interface ApiResponse {
  status: string;
  score: number;
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
  icons = { Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson, Wand2, Info };

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

  // Email notification state
  columnNumber: string = '';
  authorityEmail: string = '';
  isEmailSending: boolean = false;
  emailSent: boolean = false;

  // Drag Drop Variables
  draggingPointIndex: number | null = null;
  draggingPointType: 'rod' | 'ref' | null = null;
  dragStartX = 0;
  dragStartY = 0;
  dragStartPointX = 0;
  dragStartPointY = 0;
  hasMoved = false;

  @ViewChild('imageRef') imageElement!: ElementRef<HTMLImageElement>;

  constructor(
    private http: HttpClient, 
    private cdr: ChangeDetectorRef,
    private gemini: GeminiService,
    private scoring: ScoringService
  ) {}

  ngOnInit() {
    // 1. Backend Wake-up Ping (Fixes Render 50s cold start delay)
    this.http.get(environment.apiBaseUrl + '/', { responseType: 'text' }).subscribe({
      next: () => console.log('Backend warmed up successfully.'),
      error: () => console.log('Ping sent to wake up backend.')
    });

    // 2. Setup Google Analytics dynamically (Safely fallback if omitted from environment)
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
    if (this.analysisSub) this.analysisSub.unsubscribe();
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
    if (this.viewMode === 'side' && this.mode === 'rods' && this.rodPoints.length >= 2) {
      alert("For Side View spacing, please mark exactly 2 horizontal bars.");
      return;
    }

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

  async autoDetect() {
    if (!this.realImageFile) return;
    this.isAutoDetecting = true;
    this.cdr.markForCheck();

    try {
      const tinyB64 = await this.gemini.fileToBase64(this.realImageFile);
      const aiPoints = await this.gemini.getAutoDetectPoints(tinyB64, this.viewMode);
      
      const formData = new FormData();
      formData.append('image', this.realImageFile);
      formData.append('view_mode', this.viewMode);
      formData.append('gemini_points', JSON.stringify(aiPoints));

      this.http.post<any>(`${environment.apiBaseUrl}/refine-points`, formData).subscribe({
        next: (res) => {
          if (res.status === 'success' && res.points) this.rodPoints = res.points;
          this.isAutoDetecting = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error(err);
          this.isAutoDetecting = false;
          this.cdr.markForCheck();
        }
      });
    } catch (e) {
      console.error(e);
      this.isAutoDetecting = false;
      this.cdr.markForCheck();
    }
  }

  cancelAutoDetect() {
    this.isAutoDetecting = false;
    this.cdr.markForCheck();
  }

  cancelAnalysis() {
    this.isAnalyzing = false;
    if (this.analysisSub) {
      this.analysisSub.unsubscribe();
      this.analysisSub = null;
    }
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
    this.cdr.markForCheck();
    
    // Setup Parallel Processing Data
    const formData = new FormData();
    formData.append('real_image', this.realImageFile);
    formData.append('rod_points', JSON.stringify(this.rodPoints));
    formData.append('ref_points', JSON.stringify(this.refPoints));
    formData.append('ref_length', this.refPoints.length === 2 ? this.refLengthInput.toString() : '0');

    const endpoint = this.viewMode === 'top' ? '/analyze-cv' : '/analyze-cv/side';
    
    // 1. Backend CV Observable
    const cvObs = this.http.post<any>(`${environment.apiBaseUrl}${endpoint}`, formData);

    // 2. Gemini Design Extraction Promise
    let designPromise = Promise.resolve({ count: 0, radius_mm: 0, spacings_mm: [] } as any);
    let designB64 = '';
    if (this.designImageFile) {
      designB64 = await this.gemini.fileToBase64(this.designImageFile);
      designPromise = this.gemini.extractDesignData(designB64, this.viewMode);
    }

    // 3. Gemini Defect Search Promise
    let defectPromise = Promise.resolve({ reset: true, rod: null } as any);
    if (this.viewMode === 'top' && this.designImageFile) {
      const realB64 = await this.gemini.fileToBase64(this.realImageFile);
      defectPromise = this.gemini.detectDefects(realB64, designB64, this.rodPoints.length);
    }

    // Execute Concurrently & Store Subscription for easy cancellation
    this.analysisSub = forkJoin({
      cvRes: cvObs,
      designData: from(designPromise),
      defectData: from(defectPromise)
    }).subscribe({
      next: ({ cvRes, designData, defectData }) => {
        if (cvRes?.status !== 'success') {
          this.errorMsg = "Computer Vision processing failed.";
          this.isAnalyzing = false;
          this.cdr.markForCheck();
          return;
        }

        // Calculate score locally on frontend
        let scoreData;
        if (this.viewMode === 'top') {
          scoreData = this.scoring.calculateTopScore(designData, cvRes.actual_data, cvRes.has_scale);
        } else {
          scoreData = this.scoring.calculateSideScore(designData, cvRes.actual_data, cvRes.has_scale);
        }

        this.result = {
          status: 'success',
          score: scoreData.score,
          comparison_table: scoreData.table,
          annotated_image: cvRes.annotated_image,
        };
        
        this.revitData = defectData;
        this.isAnalyzing = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error(err);
        this.errorMsg = `Analysis Error: ${err.message || 'Server timeout or network failure.'}`;
        this.isAnalyzing = false;
        this.cdr.markForCheck();
      }
    });
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

    const rodLinesData = { reset: lines.length === 0, lines: lines };
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