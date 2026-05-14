import { Injectable } from '@angular/core';

export interface ComparisonRow {
  parameter: string;
  design: string;
  actual: string;
  status: 'Acceptable' | 'Minor Mismatch' | 'Not Acceptable' | 'NA';
}

@Injectable({ providedIn: 'root' })
export class ScoringService {

  private safeFloat(value: any, def = 0.0): number {
    if (value === null || value === undefined) return def;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? def : parsed;
  }

  private safeInt(value: any, def = 0): number {
    if (value === null || value === undefined) return def;
    const parsed = parseInt(String(value), 10);
    return isNaN(parsed) ? def : parsed;
  }

  calculateTopScore(designData: any, actualData: any, hasScale: boolean): { score: number, table: ComparisonRow[] } {
    const tableRows: ComparisonRow[] = [];
    
    // 1. Number of Bars (Weight: 40%)
    const dCount = this.safeInt(designData.count);
    const aCount = this.safeInt(actualData.count);
    const diffCount = Math.abs(dCount - aCount);
    const scoreCount = Math.max(0, 100 - (diffCount * 25));
    
    tableRows.push({
      parameter: "Number of rods",
      design: String(dCount),
      actual: String(aCount),
      status: diffCount === 0 ? "Acceptable" : "Not Acceptable"
    });

    // 2. Radius (Weight: 20%)
    let scoreRadius = 100;
    const dRad = this.safeFloat(designData.radius_mm);
    const aRad = this.safeFloat(actualData.avg_radius);
    
    let radiusStatus: ComparisonRow['status'] = "NA";
    let actualDisplay = "";

    if (hasScale && dRad > 0) {
      const errRad = Math.abs(dRad - aRad);
      const percentErr = (errRad / dRad) * 100;
      scoreRadius = Math.max(0, 100 - percentErr);
      
      if (percentErr <= 5) radiusStatus = "Acceptable";
      else if (percentErr <= 15) radiusStatus = "Minor Mismatch";
      else radiusStatus = "Not Acceptable";
      
      actualDisplay = `${aRad.toFixed(2)} mm`;
    } else {
      actualDisplay = `${aRad.toFixed(2)} ${hasScale ? 'mm' : 'px'}`;
    }

    tableRows.push({
      parameter: "Radius of rods (avg)",
      design: dRad > 0 ? `${dRad} mm` : "Not Specified",
      actual: actualDisplay,
      status: radiusStatus
    });

    // 3. Sequential Spacing (Weight: 40%)
    const rawDSpacings = Array.isArray(designData.spacings_mm) ? designData.spacings_mm : [];
    const dSpacings = rawDSpacings.map((x: any) => this.safeFloat(x));
    const rawASpacings = Array.isArray(actualData.distances) ? actualData.distances : [];
    const aSpacings = rawASpacings.map((x: any) => this.safeFloat(x));
    
    let scoreSpacingAccum = 0;
    let validSpacingChecks = 0;
    
    if (aCount > 1) {
      const dMax = Math.max(...(dSpacings.length ? dSpacings : [1]));
      const aMax = Math.max(...(aSpacings.length ? aSpacings : [1]));

      for (let i = 0; i < aCount; i++) {
        const rStart = i + 1;
        const rEnd = ((i + 1) % aCount) + 1;
        const paramLabel = `Distance R${rStart} to R${rEnd}`;
        
        const valActual = i < aSpacings.length ? aSpacings[i] : 0.0;
        const valDesign = i < dSpacings.length ? dSpacings[i] : null;
        
        let rowStatus: ComparisonRow['status'] = "NA";
        
        if (valDesign !== null) {
          if (hasScale) {
            if (valDesign > 0) {
              const err = Math.abs(valDesign - valActual);
              const pct = (err / valDesign) * 100;
              
              if (pct <= 5) rowStatus = "Acceptable";
              else if (pct <= 15) rowStatus = "Minor Mismatch";
              else rowStatus = "Not Acceptable";
              
              scoreSpacingAccum += Math.max(0, 100 - pct);
              validSpacingChecks++;
            }
          } else {
            if (valDesign > 0) {
              const dNorm = valDesign / (dMax > 0 ? dMax : 1);
              const aNorm = valActual / (aMax > 0 ? aMax : 1);
              const diffRatio = Math.abs(dNorm - aNorm);
              
              scoreSpacingAccum += Math.max(0, 100 - (diffRatio * 100));
              validSpacingChecks++;
            }
          }
        }
        
        tableRows.push({
          parameter: paramLabel,
          design: valDesign !== null ? `${valDesign} mm` : "Not Specified",
          actual: `${valActual.toFixed(2)} ${hasScale ? 'mm' : 'px'}`,
          status: rowStatus
        });
      }
    }

    let scoreSpacing = 100;
    if (validSpacingChecks > 0) {
      scoreSpacing = scoreSpacingAccum / validSpacingChecks;
    } else if (aCount !== dCount) {
      scoreSpacing = 0;
    }
    
    let finalScore = 0;
    if (hasScale) {
      finalScore = (0.4 * scoreCount) + (0.4 * scoreSpacing) + (0.2 * scoreRadius);
    } else {
      finalScore = (0.5 * scoreCount) + (0.5 * scoreSpacing);
    }
        
    return { score: Math.round(finalScore), table: tableRows };
  }

  calculateSideScore(designData: any, actualData: any, hasScale: boolean): { score: number, table: ComparisonRow[] } {
    const dSpacing = this.safeFloat(designData.spacing_mm);
    const aSpacing = this.safeFloat(actualData.spacing);
    
    const tableRows: ComparisonRow[] = [];
    let score = 0;
    let status: ComparisonRow['status'] = "NA";
    let actualStr = "";
    
    if (hasScale && dSpacing > 0) {
      const diff = Math.abs(dSpacing - aSpacing);
      const errorPct = (diff / dSpacing) * 100;
      score = Math.max(0, 100 - errorPct);
      
      if (errorPct <= 5) status = "Acceptable";
      else if (errorPct <= 15) status = "Minor Mismatch";
      else status = "Not Acceptable";
      
      actualStr = `${aSpacing.toFixed(2)} mm`;
    } else {
      score = aSpacing > 0 ? 85 : 0; // Baseline fallback
      actualStr = `${aSpacing.toFixed(2)} ${hasScale ? 'mm' : 'px'}`;
    }
    
    tableRows.push({
      parameter: "Vertical Spacing",
      design: dSpacing > 0 ? `${dSpacing} mm` : "Not Specified",
      actual: actualStr,
      status: status
    });
    
    return { score: Math.round(score), table: tableRows };
  }
}