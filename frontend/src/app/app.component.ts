import { Component, ElementRef, ViewChild, isDevMode, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { LucideAngularModule, Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson } from 'lucide-angular';
import { FormsModule } from '@angular/forms';

const API_BASE_URL = isDevMode() 
  ? 'http://localhost:5000' 
  : 'https://rebaranalysis.onrender.com';

interface ComparisonRow {
  parameter: string;
  design: string;
  actual: string;
  status: 'Acceptable' | 'Minor Mismatch' | 'Not Acceptable' | 'NA';
}

interface ApiResponse {
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
  changeDetection: ChangeDetectionStrategy.OnPush // Optimization: drastically reduces re-renders
})
export class AppComponent {
  icons = { Upload, ScanLine, Ruler, CheckCircle2, AlertCircle, Trash2, Undo2, ArrowRight, Layers, ArrowUpDown, FileJson };

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
  result: ApiResponse | null = null;
  errorMsg: string | null = null;
  
  revitData: any = null;

  // Email notification state
  columnNumber: string = '';
  authorityEmail: string = '';
  isEmailSending: boolean = false;
  emailSent: boolean = false;

  @ViewChild('imageRef') imageElement!: ElementRef<HTMLImageElement>;

  constructor(private http: HttpClient, private cdr: ChangeDetectorRef) {}

  setViewMode(mode: 'top' | 'side') {
    if (this.viewMode !== mode) {
      this.viewMode = mode;
      this.fullReset();
    }
  }

  fullReset() {
    this.realImageFile = null;
    this.designImageFile = null;
    this.realImagePreview = null;
    this.resetMarkings();
  }

  resetMarkings() {
    // Immutable updates for OnPush change detection
    this.rodPoints = [];
    this.refPoints = [];
    this.result = null;
    this.revitData = null;
    this.mode = 'rods';
    this.errorMsg = null;
    
    // Reset Email State
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

    // Using spread operator for immutable state updates (crucial for OnPush)
    if (this.mode === 'rods') {
      this.rodPoints = [...this.rodPoints, [x, y]];
    } else {
      if (this.refPoints.length < 2) {
        this.refPoints = [...this.refPoints, [x, y]];
      }
    }
    this.cdr.markForCheck();
  }

  undoLast() {
    if (this.mode === 'rods' && this.rodPoints.length > 0) {
      this.rodPoints = this.rodPoints.slice(0, -1);
    } else if (this.mode === 'ref' && this.refPoints.length > 0) {
      this.refPoints = this.refPoints.slice(0, -1);
    }
    this.cdr.markForCheck();
  }

  setMode(m: 'rods' | 'ref') {
    this.mode = m;
    this.cdr.markForCheck();
  }

  analyze() {
    if (!this.realImageFile) return;
    if (this.rodPoints.length < 2) {
      alert("Please mark points on the image first.");
      return;
    }
    
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
    
    const formData = new FormData();
    formData.append('real_image', this.realImageFile);
    if (this.designImageFile) {
        formData.append('design_image', this.designImageFile);
    }
    
    formData.append('rod_points', JSON.stringify(this.rodPoints));
    formData.append('ref_points', JSON.stringify(this.refPoints));
    formData.append('ref_length', this.refPoints.length === 2 ? this.refLengthInput.toString() : '0');
    formData.append('rod_count', this.rodPoints.length.toString());

    const endpoint = this.viewMode === 'top' ? '/analyze' : '/analyze/side';

    this.http.post<ApiResponse>(`${API_BASE_URL}${endpoint}`, formData)
      .subscribe({
        next: (res) => {
          this.result = res;
          if (res.revit_data) {
            this.revitData = res.revit_data;
          }
          this.isAnalyzing = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error(err);
          this.errorMsg = `Server Error: ${err.message || 'Unknown Error'}. Is the backend running?`;
          this.isAnalyzing = false;
          this.cdr.markForCheck();
        }
      });
  }

  sendEmailReport() {
    if (!this.columnNumber) {
      alert("Please enter the Column Number (e.g., C1).");    
      return;                                                 
    }
    if (!this.authorityEmail) {
      alert("Please enter the Authority's Email Address.");
      return;
    }
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

    this.http.post<any>(`${API_BASE_URL}/send-email-report`, payload).subscribe({
      next: (res) => {
        if (res.status === 'success') {
          this.emailSent = true;
        } else {
          alert("Failed to send email: " + res.message);
        }
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

  // Optimize ngFor rendering
  trackByIndex(index: number): number {
    return index;
  }

  downloadRevitJson() {
    if (!this.revitData) return;
    const jsonString = JSON.stringify(this.revitData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'highlight_rod.json';
    a.click();
    window.URL.revokeObjectURL(url);
  }

  downloadRodLinesJson() {
    if (!this.result) return;
    const lines: { from: number; to: number; status: string }[] = [];
    const distanceRegex = /Distance R(\d+) to R(\d+)/i;

    for (const row of this.result.comparison_table) {
      const match = row.parameter.match(distanceRegex);
      if (match) {
        lines.push({
          from: parseInt(match[1]),
          to: parseInt(match[2]),
          status: row.status
        });
      }
    }

    const rodLinesData = { reset: lines.length === 0, lines: lines };
    const jsonString = JSON.stringify(rodLinesData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rod_lines.json';
    a.click();
    window.URL.revokeObjectURL(url);
  }

  downloadCSV() {
    if (!this.result) return;
    const headers = ['Parameter', 'Design Spec', 'Site Actual', 'Status'];
    const rows = this.result.comparison_table.map(row => [row.parameter, row.design, row.actual, row.status]
        .map(val => `"${val}"`)
        .join(',')
    );

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report.csv';
    a.click();
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