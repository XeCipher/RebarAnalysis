import { Component, ElementRef, ViewChild, ChangeDetectionStrategy, ChangeDetectorRef, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { LucideAngularModule, Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson, Wand2, Info, HelpCircle, Calculator, X, Timer, DownloadCloud, Copy, FileCode, Box, ExternalLink, PenTool, Image as ImageIcon, Settings2 } from 'lucide-angular';
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

export interface BlueprintModel {
  id: string; count: number | 'custom'; shape: 'Square' | 'Rectangle' | 'Custom';
  rods: { cx: number, cy: number, tx: number, ty: number }[];
  spacings: { 
    idx: number; 
    x: number; y: number; 
    opposite?: number;
    value: number | null;
  }[];
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
  icons = { Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson, Wand2, Info, HelpCircle, Calculator, X, Timer, DownloadCloud, Copy, FileCode, Box, ExternalLink, PenTool, ImageIcon, Settings2 };

  // System State
  viewMode: 'top' | 'side' = 'top';
  isBackendWarmedUp = false;

  // Left Column (Site Image) State
  realImageFile: File | null = null;
  realImagePreview: string | null = null;
  mode: 'rods' | 'ref' = 'rods';
  rodPoints: number[][] = [];
  imgNatWidth: number = 0;
  imgNatHeight: number = 0;
  
  // Scale / Ref State
  scaleMode: 'freehand' | 'rods' = 'freehand';
  refPoints: number[][] = [];
  refLengthInput: number = 100;
  scaleRodA: number = 1;
  scaleRodB: number = 2;
  scaleRodDistance: number = 125;

  // Right Column (Design Blueprint) State
  designImageFile: File | null = null;
  designImagePreview: string | null = null;
  designInputMode: 'upload' | 'manual' = 'upload';
  
  // Mathematically Padded SVG Models to prevent overlaps
  TOP_MODELS: BlueprintModel[] = [
    {
      id: 'c4_sq', count: 4, shape: 'Square',
      rods: [ {cx: 30, cy: 30, tx: 22, ty: 22}, {cx: 70, cy: 30, tx: 78, ty: 22}, {cx: 70, cy: 70, tx: 78, ty: 78}, {cx: 30, cy: 70, tx: 22, ty: 78} ],
      spacings: [
        { idx: 0, x: 50, y: 15, opposite: 2, value: null }, { idx: 1, x: 85, y: 50, opposite: 3, value: null },
        { idx: 2, x: 50, y: 85, opposite: 0, value: null }, { idx: 3, x: 15, y: 50, opposite: 1, value: null }
      ]
    },
    {
      id: 'c6_rect', count: 6, shape: 'Rectangle',
      rods: [ {cx: 25, cy: 35, tx: 18, ty: 27}, {cx: 50, cy: 35, tx: 50, ty: 27}, {cx: 75, cy: 35, tx: 82, ty: 27}, {cx: 75, cy: 65, tx: 82, ty: 73}, {cx: 50, cy: 65, tx: 50, ty: 73}, {cx: 25, cy: 65, tx: 18, ty: 73} ],
      spacings: [
        { idx: 0, x: 37.5, y: 15, opposite: 4, value: null }, { idx: 1, x: 62.5, y: 15, opposite: 3, value: null },
        { idx: 2, x: 90, y: 50, opposite: 5, value: null },
        { idx: 3, x: 62.5, y: 85, opposite: 1, value: null }, { idx: 4, x: 37.5, y: 85, opposite: 0, value: null },
        { idx: 5, x: 10, y: 50, opposite: 2, value: null }
      ]
    },
    {
      id: 'c8_sq', count: 8, shape: 'Square',
      rods: [ {cx: 25, cy: 25, tx: 18, ty: 18}, {cx: 50, cy: 25, tx: 50, ty: 18}, {cx: 75, cy: 25, tx: 82, ty: 18}, {cx: 75, cy: 50, tx: 82, ty: 50}, {cx: 75, cy: 75, tx: 82, ty: 82}, {cx: 50, cy: 75, tx: 50, ty: 82}, {cx: 25, cy: 75, tx: 18, ty: 82}, {cx: 25, cy: 50, tx: 18, ty: 50} ],
      spacings: [
        { idx: 0, x: 37.5, y: 8, opposite: 5, value: null }, { idx: 1, x: 62.5, y: 8, opposite: 4, value: null },
        { idx: 2, x: 92, y: 37.5, opposite: 7, value: null }, { idx: 3, x: 92, y: 62.5, opposite: 6, value: null },
        { idx: 4, x: 62.5, y: 92, opposite: 1, value: null }, { idx: 5, x: 37.5, y: 92, opposite: 0, value: null },
        { idx: 6, x: 8, y: 62.5, opposite: 3, value: null }, { idx: 7, x: 8, y: 37.5, opposite: 2, value: null }
      ]
    },
    {
      id: 'c8_rect', count: 8, shape: 'Rectangle',
      rods: [ {cx: 20, cy: 35, tx: 14, ty: 27}, {cx: 40, cy: 35, tx: 40, ty: 27}, {cx: 60, cy: 35, tx: 60, ty: 27}, {cx: 80, cy: 35, tx: 86, ty: 27}, {cx: 80, cy: 65, tx: 86, ty: 73}, {cx: 60, cy: 65, tx: 60, ty: 73}, {cx: 40, cy: 65, tx: 40, ty: 73}, {cx: 20, cy: 65, tx: 14, ty: 73} ],
      spacings: [
        { idx: 0, x: 30, y: 12, opposite: 6, value: null }, { idx: 1, x: 50, y: 12, opposite: 5, value: null }, { idx: 2, x: 70, y: 12, opposite: 4, value: null },
        { idx: 3, x: 95, y: 50, opposite: 7, value: null },
        { idx: 4, x: 70, y: 88, opposite: 2, value: null }, { idx: 5, x: 50, y: 88, opposite: 1, value: null }, { idx: 6, x: 30, y: 88, opposite: 0, value: null },
        { idx: 7, x: 5, y: 50, opposite: 3, value: null }
      ]
    },
    {
      id: 'c10_rect', count: 10, shape: 'Rectangle',
      rods: [ {cx: 20, cy: 35, tx: 14, ty: 27}, {cx: 35, cy: 35, tx: 35, ty: 27}, {cx: 50, cy: 35, tx: 50, ty: 27}, {cx: 65, cy: 35, tx: 65, ty: 27}, {cx: 80, cy: 35, tx: 86, ty: 27}, {cx: 80, cy: 65, tx: 86, ty: 73}, {cx: 65, cy: 65, tx: 65, ty: 73}, {cx: 50, cy: 65, tx: 50, ty: 73}, {cx: 35, cy: 65, tx: 35, ty: 73}, {cx: 20, cy: 65, tx: 14, ty: 73} ],
      spacings: [
        { idx: 0, x: 27.5, y: 12, opposite: 8, value: null }, { idx: 1, x: 42.5, y: 12, opposite: 7, value: null }, { idx: 2, x: 57.5, y: 12, opposite: 6, value: null }, { idx: 3, x: 72.5, y: 12, opposite: 5, value: null },
        { idx: 4, x: 95, y: 50, opposite: 9, value: null },
        { idx: 5, x: 72.5, y: 88, opposite: 3, value: null }, { idx: 6, x: 57.5, y: 88, opposite: 2, value: null }, { idx: 7, x: 42.5, y: 88, opposite: 1, value: null }, { idx: 8, x: 27.5, y: 88, opposite: 0, value: null },
        { idx: 9, x: 5, y: 50, opposite: 4, value: null }
      ]
    },
    {
      id: 'c12_sq', count: 12, shape: 'Square',
      rods: [ {cx: 25, cy: 25, tx: 18, ty: 18}, {cx: 41.6, cy: 25, tx: 41.6, ty: 18}, {cx: 58.3, cy: 25, tx: 58.3, ty: 18}, {cx: 75, cy: 25, tx: 82, ty: 18}, {cx: 75, cy: 41.6, tx: 82, ty: 41.6}, {cx: 75, cy: 58.3, tx: 82, ty: 58.3}, {cx: 75, cy: 75, tx: 82, ty: 82}, {cx: 58.3, cy: 75, tx: 58.3, ty: 82}, {cx: 41.6, cy: 75, tx: 41.6, ty: 82}, {cx: 25, cy: 75, tx: 18, ty: 82}, {cx: 25, cy: 58.3, tx: 18, ty: 58.3}, {cx: 25, cy: 41.6, tx: 18, ty: 41.6} ],
      spacings: [
        { idx: 0, x: 33.3, y: 5, opposite: 9, value: null }, { idx: 1, x: 50, y: 5, opposite: 8, value: null }, { idx: 2, x: 66.6, y: 5, opposite: 7, value: null },
        { idx: 3, x: 95, y: 33.3, opposite: 11, value: null }, { idx: 4, x: 95, y: 50, opposite: 10, value: null }, { idx: 5, x: 95, y: 66.6, opposite: 9, value: null },
        { idx: 6, x: 66.6, y: 95, opposite: 2, value: null }, { idx: 7, x: 50, y: 95, opposite: 1, value: null }, { idx: 8, x: 33.3, y: 95, opposite: 0, value: null },
        { idx: 9, x: 5, y: 66.6, opposite: 5, value: null }, { idx: 10, x: 5, y: 50, opposite: 4, value: null }, { idx: 11, x: 5, y: 33.3, opposite: 3, value: null }
      ]
    },
    {
      id: 'c12_rect', count: 12, shape: 'Rectangle',
      rods: [ {cx: 15, cy: 35, tx: 10, ty: 27}, {cx: 29, cy: 35, tx: 29, ty: 27}, {cx: 43, cy: 35, tx: 43, ty: 27}, {cx: 57, cy: 35, tx: 57, ty: 27}, {cx: 71, cy: 35, tx: 71, ty: 27}, {cx: 85, cy: 35, tx: 90, ty: 27}, {cx: 85, cy: 65, tx: 90, ty: 73}, {cx: 71, cy: 65, tx: 71, ty: 73}, {cx: 57, cy: 65, tx: 57, ty: 73}, {cx: 43, cy: 65, tx: 43, ty: 73}, {cx: 29, cy: 65, tx: 29, ty: 73}, {cx: 15, cy: 65, tx: 10, ty: 73} ],
      spacings: [
        { idx: 0, x: 22, y: 12, opposite: 10, value: null }, { idx: 1, x: 36, y: 12, opposite: 9, value: null }, { idx: 2, x: 50, y: 12, opposite: 8, value: null }, { idx: 3, x: 64, y: 12, opposite: 7, value: null }, { idx: 4, x: 78, y: 12, opposite: 6, value: null },
        { idx: 5, x: 95, y: 50, opposite: 11, value: null },
        { idx: 6, x: 78, y: 88, opposite: 4, value: null }, { idx: 7, x: 64, y: 88, opposite: 3, value: null }, { idx: 8, x: 50, y: 88, opposite: 2, value: null }, { idx: 9, x: 36, y: 88, opposite: 1, value: null }, { idx: 10, x: 22, y: 88, opposite: 0, value: null },
        { idx: 11, x: 5, y: 50, opposite: 5, value: null }
      ]
    },
    {
      id: 'c16_sq', count: 16, shape: 'Square',
      rods: [ {cx: 15, cy: 25, tx: 9, ty: 18}, {cx: 29, cy: 25, tx: 29, ty: 18}, {cx: 43, cy: 25, tx: 43, ty: 18}, {cx: 57, cy: 25, tx: 57, ty: 18}, {cx: 71, cy: 25, tx: 71, ty: 18}, {cx: 85, cy: 25, tx: 91, ty: 18}, {cx: 85, cy: 41.6, tx: 92, ty: 41.6}, {cx: 85, cy: 58.3, tx: 92, ty: 58.3}, {cx: 85, cy: 75, tx: 91, ty: 82}, {cx: 71, cy: 75, tx: 71, ty: 82}, {cx: 57, cy: 75, tx: 57, ty: 82}, {cx: 43, cy: 75, tx: 43, ty: 82}, {cx: 29, cy: 75, tx: 29, ty: 82}, {cx: 15, cy: 75, tx: 9, ty: 82}, {cx: 15, cy: 58.3, tx: 8, ty: 58.3}, {cx: 15, cy: 41.6, tx: 8, ty: 41.6} ],
      spacings: [
        { idx: 0, x: 22, y: 5, opposite: 12, value: null }, { idx: 1, x: 36, y: 5, opposite: 11, value: null }, { idx: 2, x: 50, y: 5, opposite: 10, value: null }, { idx: 3, x: 64, y: 5, opposite: 9, value: null }, { idx: 4, x: 78, y: 5, opposite: 8, value: null },
        { idx: 5, x: 96, y: 33.3, opposite: 15, value: null }, { idx: 6, x: 96, y: 50, opposite: 14, value: null }, { idx: 7, x: 96, y: 66.6, opposite: 13, value: null },
        { idx: 8, x: 78, y: 95, opposite: 4, value: null }, { idx: 9, x: 64, y: 95, opposite: 3, value: null }, { idx: 10, x: 50, y: 95, opposite: 2, value: null }, { idx: 11, x: 36, y: 95, opposite: 1, value: null }, { idx: 12, x: 22, y: 95, opposite: 0, value: null },
        { idx: 13, x: 4, y: 66.6, opposite: 7, value: null }, { idx: 14, x: 4, y: 50, opposite: 6, value: null }, { idx: 15, x: 4, y: 33.3, opposite: 5, value: null }
      ]
    },
    {
      id: 'c16_rect', count: 16, shape: 'Rectangle',
      rods: [ {cx: 15, cy: 35, tx: 10, ty: 27}, {cx: 25, cy: 35, tx: 25, ty: 27}, {cx: 35, cy: 35, tx: 35, ty: 27}, {cx: 45, cy: 35, tx: 45, ty: 27}, {cx: 55, cy: 35, tx: 55, ty: 27}, {cx: 65, cy: 35, tx: 65, ty: 27}, {cx: 75, cy: 35, tx: 75, ty: 27}, {cx: 85, cy: 35, tx: 90, ty: 27}, {cx: 85, cy: 65, tx: 90, ty: 73}, {cx: 75, cy: 65, tx: 75, ty: 73}, {cx: 65, cy: 65, tx: 65, ty: 73}, {cx: 55, cy: 65, tx: 55, ty: 73}, {cx: 45, cy: 65, tx: 45, ty: 73}, {cx: 35, cy: 65, tx: 35, ty: 73}, {cx: 25, cy: 65, tx: 25, ty: 73}, {cx: 15, cy: 65, tx: 10, ty: 73} ],
      spacings: [
        { idx: 0, x: 20, y: 12, opposite: 14, value: null }, { idx: 1, x: 30, y: 12, opposite: 13, value: null }, { idx: 2, x: 40, y: 12, opposite: 12, value: null }, { idx: 3, x: 50, y: 12, opposite: 11, value: null }, { idx: 4, x: 60, y: 12, opposite: 10, value: null }, { idx: 5, x: 70, y: 12, opposite: 9, value: null }, { idx: 6, x: 80, y: 12, opposite: 8, value: null },
        { idx: 7, x: 95, y: 50, opposite: 15, value: null },
        { idx: 8, x: 80, y: 88, opposite: 6, value: null }, { idx: 9, x: 70, y: 88, opposite: 5, value: null }, { idx: 10, x: 60, y: 88, opposite: 4, value: null }, { idx: 11, x: 50, y: 88, opposite: 3, value: null }, { idx: 12, x: 40, y: 88, opposite: 2, value: null }, { idx: 13, x: 30, y: 88, opposite: 1, value: null }, { idx: 14, x: 20, y: 88, opposite: 0, value: null },
        { idx: 15, x: 5, y: 50, opposite: 7, value: null }
      ]
    }
  ];

  selectedRodCount: number | 'custom' = 8;
  selectedShape: 'Square' | 'Rectangle' | 'Custom' = 'Rectangle';
  customRodCount: number = 4;
  
  activeModel: BlueprintModel;
  designRadius: number | null = 8;
  
  get availableShapes(): string[] {
    if (this.selectedRodCount === 'custom') return ['Custom'];
    return Array.from(new Set(this.TOP_MODELS.filter(m => m.count === Number(this.selectedRodCount)).map(m => m.shape)));
  }
  
  get activeModelPolygonPoints(): string {
    return this.activeModel?.rods?.map(r => `${r.cx},${r.cy}`).join(' ') || '';
  }

  // Side View Manual State
  sideManualState = { spacing_mm: 150, least_lateral_dim_mm: 400, longitudinal_bar_dia_mm: 20 };

  // Execution Processing States
  isAnalyzing = false;
  isAutoDetecting = false;
  
  private currentAutoDetectId = 0;
  private currentAnalysisId = 0;
  private currentDesignExtractId = 0;
  designExtractionPromise: Promise<void> | null = null;
  
  result: ApiResponse | null = null;
  errorMsg: string | null = null;
  revitData: any = null;

  // Email notification state
  columnNumber: string = '';
  authorityEmail: string = '';
  isEmailSending: boolean = false;
  emailSent: boolean = false;

  showScoreModal: boolean = false;
  showDownloadsMenu: boolean = false;
  copiedStates: { [key: string]: boolean } = {};

  // Performance Timers
  timers = {
    autoDetect: 0, autoDetectRunning: false,
    total: 0, backendWarmup: 0,
    cv: 0, cvRunning: false, ai: 0, aiRunning: false
  };
  private intervals: any[] = [];

  // Drag Drop Variables
  draggingPointIndex: number | null = null;
  draggingPointType: 'rod' | 'ref' | null = null;
  dragStartX = 0; dragStartY = 0;
  dragStartPointX = 0; dragStartPointY = 0;
  hasMoved = false;

  @ViewChild('imageRef') imageElement!: ElementRef<HTMLImageElement>;
  @ViewChild('downloadsMenuRef') downloadsMenuRef?: ElementRef;
  @ViewChild('fileInputReal') fileInputReal!: ElementRef<HTMLInputElement>;
  @ViewChild('fileInputDesign') fileInputDesign!: ElementRef<HTMLInputElement>;

  constructor(
    private http: HttpClient, 
    private cdr: ChangeDetectorRef,
    private gemini: GeminiService,
    private scoring: ScoringService
  ) {
    this.activeModel = JSON.parse(JSON.stringify(this.TOP_MODELS.find(m => m.id === 'c8_rect')!));
  }

  ngOnInit() {
    this.http.get(environment.apiBaseUrl + '/', { responseType: 'text' }).subscribe({
      next: () => { this.isBackendWarmedUp = true; },
      error: () => { this.isBackendWarmedUp = true; } 
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
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.showDownloadsMenu && this.downloadsMenuRef && !this.downloadsMenuRef.nativeElement.contains(event.target)) {
      this.showDownloadsMenu = false;
      this.cdr.markForCheck();
    }
  }

  toggleDownloadsMenu() {
    this.showDownloadsMenu = !this.showDownloadsMenu;
    this.cdr.markForCheck();
  }

  getQualityTier(score: number): { label: string, color: 'green' | 'yellow' | 'red' } {
    if (score > 95) return { label: 'Excellent', color: 'green' };
    if (score >= 90) return { label: 'Acceptable', color: 'green' };
    if (score >= 80) return { label: 'Minor Deviation', color: 'yellow' };
    if (score >= 70) return { label: 'Major Deviation', color: 'red' };
    return { label: 'Defective', color: 'red' };
  }

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
            resolve(blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file);
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
    this.designImagePreview = null;
    this.timers.autoDetect = 0;
    this.designInputMode = 'upload';
    this.resetMarkings();
  }

  clearSiteImage() {
    this.realImageFile = null;
    this.realImagePreview = null;
    this.resetMarkings();
  }

  clearDesignImage() {
    this.designImageFile = null;
    this.designImagePreview = null;
    this.cdr.markForCheck();
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

  onDesignFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.designImageFile = file;
      this.designInputMode = 'upload';
      const reader = new FileReader();
      reader.onload = (e: any) => {
        this.designImagePreview = e.target.result;
        this.cdr.markForCheck();
        this.startDesignExtraction(file);
      };
      reader.readAsDataURL(file);
    }
    if(this.fileInputDesign) this.fileInputDesign.nativeElement.value = '';
  }

  triggerReExtract() {
    if (this.designImageFile) {
        this.startDesignExtraction(this.designImageFile);
    }
  }

  async startDesignExtraction(file: File) {
    const execId = ++this.currentDesignExtractId;
    this.timers.aiRunning = true;
    this.timers.ai = 0;
    
    const start = performance.now();
    const interval = setInterval(() => {
      if(this.timers.aiRunning) {
        this.timers.ai = (performance.now() - start) / 1000;
        this.cdr.markForCheck();
      }
    }, 30);
    this.intervals.push(interval);

    this.designExtractionPromise = (async () => {
      try {
        const designB64 = await this.gemini.fileToBase64(file, 800);
        const data = await this.gemini.analyzeDesignOnly(designB64, this.viewMode);

        if (this.currentDesignExtractId !== execId) return;

        if (this.viewMode === 'top' && data?.count > 0) {
          let targetModel = this.TOP_MODELS.find(m => m.count === data.count);
          if ([8, 10, 12, 16].includes(data.count)) {
            const rectMatch = this.TOP_MODELS.find(m => m.count === data.count && m.shape === 'Rectangle');
            if (rectMatch) targetModel = rectMatch;
          }
          
          if (!targetModel) targetModel = this.TOP_MODELS[0]; 
          if (targetModel) {
            this.selectedRodCount = targetModel.count;
            this.selectedShape = targetModel.shape;
            this.activeModel = JSON.parse(JSON.stringify(targetModel));
            this.designRadius = data.radius_mm || null;
            if (Array.isArray(data.spacings_mm)) {
               this.activeModel.spacings.forEach((sp, i) => {
                 sp.value = data.spacings_mm[i] !== undefined ? data.spacings_mm[i] : null;
               });
            }
          }
        } else if (this.viewMode === 'side') {
           this.sideManualState.spacing_mm = data.spacing_mm || this.sideManualState.spacing_mm;
           this.sideManualState.least_lateral_dim_mm = data.least_lateral_dim_mm || this.sideManualState.least_lateral_dim_mm;
           this.sideManualState.longitudinal_bar_dia_mm = data.longitudinal_bar_dia_mm || this.sideManualState.longitudinal_bar_dia_mm;
        }
      } catch (err) {
        console.error("Design Extract Error", err);
      } finally {
        if (this.currentDesignExtractId === execId) {
            this.timers.aiRunning = false;
            clearInterval(interval);
            this.cdr.markForCheck();
        }
      }
    })();
  }

  onRodCountChange() {
    if (this.selectedRodCount === 'custom') {
        this.selectedShape = 'Custom';
        this.generateCustomModel();
        return;
    }
    const count = Number(this.selectedRodCount);
    const available = this.TOP_MODELS.filter(m => m.count === count);
    if (available.length > 0) {
       const shapeExists = available.find(m => m.shape === this.selectedShape);
       if (!shapeExists) this.selectedShape = available[0].shape;
       this.updateActiveModel();
    }
  }

  setShape(shape: string) {
    this.selectedShape = shape as 'Square' | 'Rectangle';
    this.updateActiveModel();
  }

  updateActiveModel() {
    if (this.selectedRodCount === 'custom') {
        this.generateCustomModel();
        return;
    }
    const count = Number(this.selectedRodCount);
    const selected = this.TOP_MODELS.find(m => m.count === count && m.shape === this.selectedShape);
    if (selected) {
      this.activeModel = JSON.parse(JSON.stringify(selected));
      this.cdr.markForCheck();
    }
  }

  generateCustomModel() {
    this.customRodCount = Math.max(4, this.customRodCount);
    const customSpacings = [];
    for (let i = 0; i < this.customRodCount; i++) {
        customSpacings.push({ idx: i, x: 0, y: 0, value: null });
    }
    this.activeModel = {
        id: 'custom', count: 'custom', shape: 'Custom',
        rods: [], spacings: customSpacings
    };
    this.cdr.markForCheck();
  }

  onSpacingChange(idx: number, newValue: number | null) {
    const spacing = this.activeModel.spacings.find(s => s.idx === idx);
    if (spacing) {
      spacing.value = newValue;
      // Auto-mirror symmetry if defined
      if (spacing.opposite !== undefined && newValue !== null) {
        const opp = this.activeModel.spacings.find(s => s.idx === spacing.opposite);
        if (opp && (opp.value === null || opp.value === 0)) {
           opp.value = newValue;
        }
      }
    }
  }
  
  getRodNumbersArray() {
    return Array.from({length: this.rodPoints.length}, (_, i) => i + 1);
  }

  onFileSelected(event: any, type: 'real') {
    const file = event.target.files[0];
    if (file) {
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
    }
    if(this.fileInputReal) this.fileInputReal.nativeElement.value = '';
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
      if (this.refPoints.length < 2 && this.scaleMode === 'freehand') {
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
    const originalFirst = points[0];
    const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    let sortedPts = [...points].sort((a, b) => {
      const angleA = Math.atan2(a[1] - cy, a[0] - cx);
      const angleB = Math.atan2(b[1] - cy, b[0] - cx);
      return angleA - angleB;
    });
    let firstIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < sortedPts.length; i++) {
      const dist = Math.pow(sortedPts[i][0] - originalFirst[0], 2) + Math.pow(sortedPts[i][1] - originalFirst[1], 2);
      if (dist < minDist) {
        minDist = dist;
        firstIdx = i;
      }
    }
    return [...sortedPts.slice(firstIdx), ...sortedPts.slice(0, firstIdx)];
  }

  async autoDetect() {
    if (!this.realImageFile) return;
    this.isAutoDetecting = true;
    const execId = ++this.currentAutoDetectId;
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
      
      if (this.currentAutoDetectId !== execId || !this.isAutoDetecting) return;
      if (!aiPoints || aiPoints.length === 0) { finishAutoDetect(); return; }

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
    this.currentAutoDetectId++;
    this.timers.autoDetectRunning = false;
    this.isAutoDetecting = false;
    this.cdr.markForCheck();
  }

  cancelAnalysis() {
    this.currentAnalysisId++;
    this.isAnalyzing = false;
    this.timers.cvRunning = false;
    this.intervals.forEach(i => clearInterval(i));
    this.intervals = [];
    this.cdr.markForCheck();
  }

  async analyze() {
    if (!this.realImageFile) return;
    if (this.rodPoints.length < 2) { alert("Please mark points on the site image first."); return; }

    this.isAnalyzing = true;
    const execId = ++this.currentAnalysisId;
    this.errorMsg = null;
    this.result = null;
    this.revitData = null;
    this.emailSent = false;
    this.isEmailSending = false;
    
    this.timers.total = 0;
    this.timers.cv = 0; this.timers.cvRunning = false;
    this.timers.backendWarmup = 0;

    const overallStart = performance.now();
    let cvStart = overallStart;

    const aInterval = setInterval(() => {
      const now = performance.now();
      this.timers.total = (now - overallStart) / 1000;
      
      if (!this.isBackendWarmedUp) {
         this.timers.backendWarmup = (now - overallStart) / 1000;
         cvStart = now; 
      } else {
         if (this.timers.cvRunning) this.timers.cv = (now - cvStart) / 1000;
      }
      this.cdr.markForCheck();
    }, 30);
    this.intervals.push(aInterval);
    
    try {
      if (this.designInputMode === 'upload' && this.designExtractionPromise) {
          await this.designExtractionPromise; 
      }
      if (this.currentAnalysisId !== execId) return;

      let designData: any = {};
      if (this.viewMode === 'top') {
         designData = {
           count: this.selectedRodCount === 'custom' ? this.customRodCount : this.activeModel.count,
           radius_mm: this.designRadius || 0,
           spacings_mm: this.activeModel.spacings.map(s => s.value || 0)
         };
      } else {
         designData = {
           spacing_mm: this.sideManualState.spacing_mm,
           least_lateral_dim_mm: this.sideManualState.least_lateral_dim_mm,
           longitudinal_bar_dia_mm: this.sideManualState.longitudinal_bar_dia_mm
         };
      }

      let payloadRefPoints = this.refPoints;
      let payloadRefLength = this.refLengthInput.toString();
      
      if (this.scaleMode === 'rods' && this.rodPoints.length >= 2) {
          const idxA = Math.max(0, Math.min(this.scaleRodA - 1, this.rodPoints.length - 1));
          const idxB = Math.max(0, Math.min(this.scaleRodB - 1, this.rodPoints.length - 1));
          payloadRefPoints = [this.rodPoints[idxA], this.rodPoints[idxB]];
          payloadRefLength = this.scaleRodDistance.toString();
      }

      const finalNormRodPoints = this.rodPoints.map(p => [p[0] / this.imgNatWidth, p[1] / this.imgNatHeight]);
      const normRefPoints = payloadRefPoints.map(p => [p[0] / this.imgNatWidth, p[1] / this.imgNatHeight]);

      this.timers.cvRunning = true;
      const compressedReal = await this.compressFile(this.realImageFile!, 1600, 0.9);
      
      const formData = new FormData();
      formData.append('real_image', compressedReal);
      formData.append('rod_points', JSON.stringify(finalNormRodPoints));
      formData.append('ref_points', JSON.stringify(normRefPoints));
      formData.append('ref_length', payloadRefPoints.length === 2 ? payloadRefLength : '0');
      formData.append('design_data', JSON.stringify(designData));

      const endpoint = this.viewMode === 'top' ? '/analyze-cv' : '/analyze-cv/side';
      const cvRes = await firstValueFrom(this.http.post<any>(`${environment.apiBaseUrl}${endpoint}`, formData));
      
      if (this.currentAnalysisId !== execId || !this.isAnalyzing) return;
      this.timers.cvRunning = false;
      this.isBackendWarmedUp = true; 

      if (cvRes?.status !== 'success') { throw new Error("Computer Vision processing failed."); }

      let defectData = { reset: true, rods: [] as number[], column_id: 'C8_Rect', frontend_points: finalNormRodPoints };
      let finalAnnotatedImage = cvRes.annotated_image;
      let scoreData;

      if (this.viewMode === 'top') {
        scoreData = this.scoring.calculateTopScore(designData, cvRes.actual_data, cvRes.has_scale);
        
        const rodFrequencies = new Map<number, number>();
        scoreData.table.forEach(r => {
          if (r.status === 'Not Acceptable' && r.parameter.includes('Distance R')) {
            const match = r.parameter.match(/R(\d+)\s+to\s+R(\d+)/i);
            if (match) {
              const r1 = parseInt(match[1], 10);
              const r2 = parseInt(match[2], 10);
              rodFrequencies.set(r1, (rodFrequencies.get(r1) || 0) + 1);
              rodFrequencies.set(r2, (rodFrequencies.get(r2) || 0) + 1);
            }
          }
        });

        const sortedDefective = Array.from(rodFrequencies.entries())
            .sort((a, b) => b[1] - a[1]).map(entry => entry[0]);

        defectData.rods = sortedDefective.slice(0, 3);
        defectData.reset = defectData.rods.length === 0;
        defectData.column_id = this.selectedRodCount === 'custom' ? 'Custom' : this.activeModel.id; 
      } else {
        scoreData = this.scoring.calculateSideScore(designData, cvRes.actual_data, cvRes.has_scale);
      }

      let statuses: string[] = [];
      if (this.viewMode === 'top') {
          for (let i = 0; i < cvRes.actual_data.distances.length; i++) {
              const rStart = i + 1;
              const rEnd = ((i + 1) % cvRes.actual_data.distances.length) + 1;
              const paramLabel = `Distance R${rStart} to R${rEnd}`;
              const row = scoreData.table.find(r => r.parameter === paramLabel);
              statuses.push(row ? row.status : "NA");
          }
      } else {
          for (let i = 0; i < cvRes.actual_data.spacings.length; i++) {
              const paramLabel = `Spacing Bar ${i+1} to ${i+2}`;
              const row = scoreData.table.find(r => r.parameter === paramLabel);
              statuses.push(row ? row.status : "NA");
          }
      }

      const formDataFinal = new FormData();
      formDataFinal.append('real_image', compressedReal);
      formDataFinal.append('rod_points', JSON.stringify(finalNormRodPoints));
      formDataFinal.append('ref_points', JSON.stringify(normRefPoints));
      formDataFinal.append('ref_length', payloadRefPoints.length === 2 ? payloadRefLength : '0');
      formDataFinal.append('design_data', JSON.stringify(designData)); 
      formDataFinal.append('statuses', JSON.stringify(statuses));

      const cvResFinal = await firstValueFrom(this.http.post<any>(`${environment.apiBaseUrl}${endpoint}`, formDataFinal));
      if (this.currentAnalysisId !== execId) return;
      if (cvResFinal?.status === 'success') { finalAnnotatedImage = cvResFinal.annotated_image; }

      const qualityTier = this.getQualityTier(scoreData.score);
      this.result = {
        status: 'success',
        score: scoreData.score,
        quality_tier: qualityTier,
        score_count: scoreData.score_count,
        score_radius: scoreData.score_radius,
        score_spacing: scoreData.score_spacing,
        comparison_table: scoreData.table,
        annotated_image: finalAnnotatedImage,
      };
      
      this.revitData = defectData;

    } catch (err: any) {
      console.error(err);
      this.errorMsg = `Analysis Error: ${err.message || 'Server timeout or network failure.'}`;
    } finally {
      if (this.currentAnalysisId === execId) {
          this.isAnalyzing = false;
          this.timers.cvRunning = false;
          clearInterval(aInterval);
          this.cdr.markForCheck();
      }
    }
  }

  sendEmailReport() {
    if (!this.columnNumber || !this.authorityEmail || !this.result) return;
    this.isEmailSending = true;
    this.cdr.markForCheck();
    
    const payload = {
      column_number: this.columnNumber, email: this.authorityEmail,
      score: this.result.score, label: this.result.quality_tier?.label || 'Defective',
      table: this.result.comparison_table, image: this.result.annotated_image
    };

    this.http.post<any>(`${environment.apiBaseUrl}/send-email-report`, payload).subscribe({
      next: (res) => {
        if (res.status === 'success') this.emailSent = true;
        this.isEmailSending = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        alert("Server error while sending email.");
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
      setTimeout(() => { this.copiedStates[scriptName] = false; this.cdr.markForCheck(); }, 2000);
    } catch (err) { alert(`Could not load ${scriptName}.`); }
  }

  openImageInNewTab(base64Image: string) {
    const newTab = window.open();
    if (newTab) {
      newTab.document.write(`
        <html><head><title>Annotated Image</title><style>body{margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${base64Image}"></body></html>
      `);
      newTab.document.close();
    }
  }

  trackByIndex(index: number): number { return index; }
  
  downloadRevitJson() {
    if (!this.revitData) return;
    const jsonString = JSON.stringify(this.revitData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'highlight_rod.json'; a.click();
  }

  downloadRodLinesJson() {
    if (!this.result) return;
    const lines: { from: number; to: number; status: string }[] = [];
    const distanceRegex = /Distance R(\d+) to R(\d+)/i;
    for (const row of this.result.comparison_table) {
      const match = row.parameter.match(distanceRegex);
      if (match) lines.push({ from: parseInt(match[1]), to: parseInt(match[2]), status: row.status });
    }
    const rodLinesData = { 
      reset: lines.length === 0, column_id: this.revitData?.column_id || 'C8_Rect', 
      lines: lines, frontend_points: this.revitData?.frontend_points || []
    };
    const blob = new Blob([JSON.stringify(rodLinesData, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'rod_lines.json'; a.click();
  }

  downloadCSV() {
    if (!this.result) return;
    const headers = ['Parameter', 'Design Spec', 'Site Actual', 'Status'];
    const rows = this.result.comparison_table.map(row => [row.parameter, row.design, row.actual, row.status].map(val => `"${val}"`).join(','));
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'report.csv'; a.click();
  }

  getStatusClass(status: string) {
    switch(status) { case 'Acceptable': return 'status-ok'; case 'Minor Mismatch': return 'status-warn'; case 'Not Acceptable': return 'status-bad'; default: return 'status-na'; }
  }
}