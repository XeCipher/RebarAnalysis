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
  viewBox?: string; maxWidth?: number;
  firstEditedIdx?: number | null; // Tracks the "master field" to allow continuous multi-digit typing broadcasts
  rods: { cx: number, cy: number }[];
  spacings: { 
    idx: number; 
    x: number; y: number; 
    opposite?: number;
    value: number | null;
    userEdited?: boolean;
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
  
  TOP_MODELS: BlueprintModel[] = [];

  selectedRodCount: number | 'custom' = 8;
  selectedShape: 'Square' | 'Rectangle' | 'Custom' = 'Rectangle';
  customRodCount: number = 4;
  
  // Separation of AI extracted vs Manual configurations
  activeModel!: BlueprintModel;
  extractedModel: BlueprintModel | null = null;
  
  designRadius: number | null = 8;
  extractedRadius: number | null = null;
  
  get availableShapes(): string[] {
    if (this.selectedRodCount === 'custom') return ['Custom'];
    return Array.from(new Set(this.TOP_MODELS.filter(m => m.count === Number(this.selectedRodCount)).map(m => m.shape)));
  }
  
  getPolygonPoints(model: BlueprintModel): string {
    return model?.rods?.map(r => `${r.cx},${r.cy}`).join(' ') || '';
  }

  // Side View Manual States
  sideExtractedState = { spacing_mm: 150 };
  sideManualState: { stirrupCount: number, firstEditedIdx: number | null, spacings_mm: any[] } = { 
    stirrupCount: 5, 
    firstEditedIdx: null,
    spacings_mm: [
      {idx: 0, value: null, userEdited: false}, 
      {idx: 1, value: null, userEdited: false}, 
      {idx: 2, value: null, userEdited: false}, 
      {idx: 3, value: null, userEdited: false}
    ] 
  };

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
    autoDetect: 0, autoDetectRunning: false, autoDetectCancelled: false, autoDetectRun: false,
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
    this.initModels();
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

  getRevitColumnId(count: number, shape: 'Square' | 'Rectangle'): string {
    if (count === 4) return 'C4';
    if (count === 10) return 'C10';
    if (shape === 'Square') return `C${count}_Square`;
    if (shape === 'Rectangle') return `C${count}_Rect`;
    return `C${count}`;
  }

  initModels() {
    const configs = [
      { c: 4, s: 'Square' }, { c: 6, s: 'Rectangle' }, { c: 8, s: 'Square' },
      { c: 8, s: 'Rectangle' }, { c: 10, s: 'Rectangle' }, { c: 12, s: 'Square' },
      { c: 12, s: 'Rectangle' }, { c: 16, s: 'Square' }, { c: 16, s: 'Rectangle' }
    ];
    this.TOP_MODELS = configs.map(conf => this.generateModel(conf.c, conf.s as 'Square' | 'Rectangle'));
    this.activeModel = JSON.parse(JSON.stringify(this.TOP_MODELS.find(m => m.id === 'C8_Rect')!));
  }

  generateModel(count: number, shape: 'Square' | 'Rectangle'): BlueprintModel {
    const rods: any[] = [];
    const spacings: any[] = [];
    let L = 0; let S = 0;
    
    if (shape === 'Square') {
      if (count === 16) {
        // Special case: 16-Rod "Square" configuration translates to a 6x4 layout (L=5, S=3)
        L = 5; 
        S = 3;
      } else {
        const N = count / 4;
        L = N; S = N;
      }
    } else {
      S = 1; L = (count / 2) - 1;
    }
    
    const segmentLen = 65;
    const width = L * segmentLen; 
    const height = S * segmentLen;
    const padX = 60; const padY = 60; // Base margin to prevent edge cropping
    const vbW = width + padX * 2;
    const vbH = height + padY * 2;
    
    // Top Edge (L-R)
    for (let i = 0; i < L; i++) rods.push({ cx: padX + (width / L) * i, cy: padY });
    // Right Edge (T-B)
    for (let i = 0; i < S; i++) rods.push({ cx: padX + width, cy: padY + (height / S) * i });
    // Bottom Edge (R-L)
    for (let i = 0; i < L; i++) rods.push({ cx: padX + width - (width / L) * i, cy: padY + height });
    // Left Edge (B-T)
    for (let i = 0; i < S; i++) rods.push({ cx: padX, cy: padY + height - (height / S) * i });

    // Calculate input box positions with a uniform physical offset across all aspect ratios
    const offsetPx = 34; // Uniform SVG pixel offset distance from the rebar boundary line

    for (let i = 0; i < rods.length; i++) {
        const r1 = rods[i];
        const r2 = rods[(i + 1) % rods.length];
        const mx = (r1.cx + r2.cx) / 2;
        const my = (r1.cy + r2.cy) / 2;
        
        let offsetX = 0; let offsetY = 0;
        
        // Match edge orientation with threshold tolerance for precision
        if (Math.abs(r1.cy - padY) < 1 && Math.abs(r2.cy - padY) < 1) offsetY = -offsetPx; 
        else if (Math.abs(r1.cx - (padX + width)) < 1 && Math.abs(r2.cx - (padX + width)) < 1) offsetX = offsetPx; 
        else if (Math.abs(r1.cy - (padY + height)) < 1 && Math.abs(r2.cy - (padY + height)) < 1) offsetY = offsetPx; 
        else if (Math.abs(r1.cx - padX) < 1 && Math.abs(r2.cx - padX) < 1) offsetX = -offsetPx; 

        spacings.push({
            idx: i,
            x: ((mx + offsetX) / vbW) * 100,
            y: ((my + offsetY) / vbH) * 100,
            value: null,
            userEdited: false,
            opposite: (i + (L + S)) % ((L + S) * 2)
        });
    }

    let calculatedMaxWidth = shape === 'Square' ? Math.min(vbW * 1.2, 350) : Math.min(Math.max(vbW * 1.5, 300), 500);
    
    // Override max width specifically for 16-rod models so they render cleanly on both desktop and mobile
    if (count === 16) {
        calculatedMaxWidth = Math.min(Math.max(vbW * 1.5, 300), 500);
    }

    return {
        id: this.getRevitColumnId(count, shape), count, shape,
        viewBox: `0 0 ${vbW} ${vbH}`, maxWidth: calculatedMaxWidth,
        firstEditedIdx: null,
        rods, spacings
    };
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
    this.timers.autoDetectRun = false;
    this.timers.autoDetectCancelled = false;
    this.designInputMode = 'upload';
    this.resetMarkings();
  }

  clearSiteImage() {
    this.realImageFile = null;
    this.realImagePreview = null;
    this.timers.autoDetect = 0;
    this.timers.autoDetectRun = false;
    this.timers.autoDetectCancelled = false;
    this.resetMarkings();
  }

  clearDesignImage() {
    this.designImageFile = null;
    this.designImagePreview = null;
    this.extractedModel = null;
    this.extractedRadius = null; 
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

  alignSpacings(spacings: number[], targetL: number, targetS: number): number[] {
    const total = (targetL + targetS) * 2;
    if (spacings.length !== total) return spacings;
    
    let bestShift = 0;
    let minVariance = Infinity;

    const getVariance = (arr: number[]) => {
        if (arr.length <= 1) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0);
    };

    for (let shift = 0; shift < total; shift++) {
        const rotated = [...spacings.slice(shift), ...spacings.slice(0, shift)];
        const l1 = rotated.slice(0, targetL);
        const l2 = rotated.slice(targetL + targetS, targetL + targetS + targetL);
        
        const v1 = getVariance(l1);
        const v2 = getVariance(l2);
        
        if ((v1 + v2) < minVariance) {
            minVariance = v1 + v2;
            bestShift = shift;
        }
    }
    return [...spacings.slice(bestShift), ...spacings.slice(0, bestShift)];
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
          
          if ([8, 10, 12].includes(data.count)) {
            const rectMatch = this.TOP_MODELS.find(m => m.count === data.count && m.shape === 'Rectangle');
            if (rectMatch) targetModel = rectMatch;
          }
          
          if (!targetModel) targetModel = this.TOP_MODELS[0]; 
          if (targetModel) {
            const modelToPopulate = JSON.parse(JSON.stringify(targetModel));
            this.extractedRadius = data.radius_mm || null;
            
            if (Array.isArray(data.spacings_mm)) {
               let mappedSpacings = data.spacings_mm;
               
               if (targetModel.shape === 'Rectangle' || (targetModel.count === 16 && targetModel.shape === 'Square')) {
                  let S_align = 1; 
                  let L_align = (data.count / 2) - 1;
                  
                  if (targetModel.count === 16 && targetModel.shape === 'Square') {
                      L_align = 5;
                      S_align = 3;
                  }
                  
                  mappedSpacings = this.alignSpacings(data.spacings_mm, L_align, S_align);
               }
               
               modelToPopulate.spacings.forEach((sp: any, i: number) => {
                 sp.value = mappedSpacings[i] !== undefined ? mappedSpacings[i] : null;
                 sp.userEdited = true; // Mark AI extracted as explicitly touched
               });
               modelToPopulate.firstEditedIdx = -1; // Disables the auto-population override for AI extracted models
            }
            this.extractedModel = modelToPopulate;
          }
        } else if (this.viewMode === 'side') {
           this.sideExtractedState.spacing_mm = data.spacing_mm || this.sideExtractedState.spacing_mm;
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

  onSideStirrupCountChange() {
    const count = Math.max(2, this.sideManualState.stirrupCount);
    const numSpacings = count - 1;
    
    const newSpacings = [];
    for (let i = 0; i < numSpacings; i++) {
        newSpacings.push({
            idx: i,
            value: this.sideManualState.spacings_mm[i]?.value || null,
            userEdited: this.sideManualState.spacings_mm[i]?.userEdited || false
        });
    }
    this.sideManualState.spacings_mm = newSpacings;
    this.cdr.markForCheck();
  }

  onSideSpacingChange(idx: number, newValue: number | null) {
    const spacing = this.sideManualState.spacings_mm[idx];
    if (!spacing) return;
    
    spacing.value = newValue;
    spacing.userEdited = true;
    
    if (this.sideManualState.firstEditedIdx === null) {
        this.sideManualState.firstEditedIdx = idx;
    }
    
    if (this.sideManualState.firstEditedIdx === idx) {
        this.sideManualState.spacings_mm.forEach((s, i) => {
            if (i !== idx && !s.userEdited) {
                s.value = newValue;
            }
        });
    }
    this.cdr.markForCheck();
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
       if (!shapeExists) this.selectedShape = available[0].shape as 'Square' | 'Rectangle';
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
        customSpacings.push({ idx: i, x: 0, y: 0, value: null, userEdited: false });
    }
    this.activeModel = {
        id: 'custom', count: 'custom', shape: 'Custom',
        rods: [], spacings: customSpacings, firstEditedIdx: null
    };
    this.cdr.markForCheck();
  }

  onSpacingChange(idx: number, newValue: number | null) {
    this.updateSpacingValue(this.activeModel, idx, newValue);
  }

  onSpacingChangeExtracted(idx: number, newValue: number | null) {
    if (this.extractedModel) this.updateSpacingValue(this.extractedModel, idx, newValue);
  }

  private updateSpacingValue(model: BlueprintModel, idx: number, newValue: number | null) {
    const spacing = model.spacings.find(s => s.idx === idx);
    if (spacing) {
      spacing.value = newValue;
      spacing.userEdited = true;
      
      if (model.firstEditedIdx === undefined) model.firstEditedIdx = null;
      
      if (model.firstEditedIdx === null) {
        model.firstEditedIdx = idx;
      }
      
      if (model.firstEditedIdx === idx) {
        // Master field seamlessly broadcasts multiple typing keystrokes to all untouched fields
        model.spacings.forEach(s => {
          if (s.idx !== idx && !s.userEdited) {
            s.value = newValue;
          }
        });
      } else if (spacing.opposite !== undefined) {
        // Apply secondary mirroring to the geometric opposite edge unless explicitly modified
        const opp = model.spacings.find(s => s.idx === spacing.opposite);
        if (opp && !opp.userEdited) {
           opp.value = newValue;
        }
      }
    }
  }
  
  getRodNumbersArray() {
    return Array.from({length: this.rodPoints.length}, (_, i) => i + 1);
  }

  getToRodNumbersArray() {
    const rodA = Number(this.scaleRodA);
    return this.getRodNumbersArray().filter(i => i !== rodA);
  }

  onScaleRodAChange() {
    if (Number(this.scaleRodA) === Number(this.scaleRodB)) {
      const available = this.getToRodNumbersArray();
      if (available.length > 0) {
        this.scaleRodB = available[0];
      }
    }
  }

  onFileSelected(event: any, type: 'real') {
    const file = event.target.files[0];
    if (file) {
      this.realImageFile = file;
      this.imgNatWidth = 0; 
      this.imgNatHeight = 0;
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
    this.timers.autoDetectCancelled = false;
    this.timers.autoDetectRun = true;
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
    this.timers.autoDetectCancelled = true;
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
      
      if (!this.isBackendWarmedUp || this.timers.aiRunning) {
         if (!this.isBackendWarmedUp) {
             this.timers.backendWarmup = (now - overallStart) / 1000;
         }
         cvStart = now; // Constantly reset cvStart while awaiting backend boot or AI extraction
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
      const modelToUse = (this.designInputMode === 'upload' && this.extractedModel) ? this.extractedModel : this.activeModel;
      const radToUse = (this.designInputMode === 'upload' && this.extractedModel) ? this.extractedRadius : this.designRadius;
      
      if (this.viewMode === 'top') {
         designData = {
           count: this.selectedRodCount === 'custom' && this.designInputMode === 'manual' ? this.customRodCount : modelToUse.count,
           radius_mm: radToUse || 0,
           spacings_mm: modelToUse.spacings.map(s => s.value || 0)
         };
      } else {
         if (this.designInputMode === 'upload') {
            designData = {
              spacing_mm: this.sideExtractedState.spacing_mm
            };
         } else {
            designData = {
              spacings_mm: this.sideManualState.spacings_mm.map(s => s.value || 0)
            };
         }
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
        
        // Root Cause Analysis: Identify defective rod(s) by tracking frequency of defective spacing pairs
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
        defectData.column_id = this.selectedRodCount === 'custom' ? 'Custom' : modelToUse.id; 
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