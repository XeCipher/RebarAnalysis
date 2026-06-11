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

  calculateTopScore(designData: any, actualData: any, hasScale: boolean): { score: number, score_count: number, score_radius: number | null, score_spacing: number, table: ComparisonRow[] } {
    const tableRows: ComparisonRow[] = [];
    
    // 1. Number of Bars (100% Weightage)
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

    // 2. Radius (100% Weightage)
    let scoreRadius = 100;
    const dRad = this.safeFloat(designData.radius_mm);
    const aRad = this.safeFloat(actualData.avg_radius);
    
    let radiusStatus: ComparisonRow['status'] = "NA";
    let actualDisplay = "";

    if (hasScale && dRad > 0) {
      const diameter = dRad * 2;
      // IS 1786:2008 Approximations for Diametrical Tolerance
      let tol_pct = 2.0;
      if (diameter <= 10) tol_pct = 3.5;
      else if (diameter <= 16) tol_pct = 2.5;

      const errRad = Math.abs(dRad - aRad);
      const percentErr = (errRad / dRad) * 100;
      
      scoreRadius = Math.max(0, 100 - percentErr);
      
      if (percentErr <= tol_pct) radiusStatus = "Acceptable";
      else if (percentErr <= tol_pct * 1.5) radiusStatus = "Minor Mismatch";
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

    // 3. Sequential Spacing (100% Weightage)
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
              // IS 456:2000 Tolerance limit checks
              const tol_mm = valDesign <= 200 ? 10 : 15;
              const err_mm = Math.abs(valDesign - valActual);
              const pct = (err_mm / valDesign) * 100;
              
              if (err_mm <= tol_mm) rowStatus = "Acceptable";
              else if (err_mm <= tol_mm * 1.5) rowStatus = "Minor Mismatch";
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
    
    // Calculate final unweighted average using all categories
    let finalScore = 0;
    if (hasScale) {
      finalScore = (scoreCount + scoreSpacing + scoreRadius) / 3;
    } else {
      finalScore = (scoreCount + scoreSpacing) / 2;
    }
        
    return { 
      score: Math.round(finalScore), 
      score_count: Math.round(scoreCount), 
      score_radius: hasScale ? Math.round(scoreRadius) : null,
      score_spacing: Math.round(scoreSpacing),
      table: tableRows 
    };
  }

  calculateSideScore(designData: any, actualData: any, hasScale: boolean): { score: number, score_count: number | null, score_radius: number | null, score_spacing: number | null, table: ComparisonRow[] } {
    const dSpacing = this.safeFloat(designData.spacing_mm);
    const aSpacings: number[] = Array.isArray(actualData.spacings) ? actualData.spacings : [];
    
    const tableRows: ComparisonRow[] = [];
    
    if (aSpacings.length === 0) {
      return { 
        score: 0, 
        score_count: null,
        score_radius: null,
        score_spacing: 0,
        table: [{ parameter: "Vertical Spacing", design: dSpacing > 0 ? `${dSpacing} mm` : "Not Specified", actual: "None detected", status: "Not Acceptable" }] 
      };
    }

    let totalScore = 0;

    aSpacings.forEach((aSpacing, i) => {
      let score = 0;
      let status: ComparisonRow['status'] = "NA";
      let actualStr = "";
      
      if (hasScale && dSpacing > 0) {
        // IS 456:2000 Tolerance limit checks
        const tol_mm = dSpacing <= 200 ? 10 : 15;
        const err_mm = Math.abs(dSpacing - aSpacing);
        const errorPct = (err_mm / dSpacing) * 100;
        score = Math.max(0, 100 - errorPct);
        
        if (err_mm <= tol_mm) status = "Acceptable";
        else if (err_mm <= tol_mm * 1.5) status = "Minor Mismatch";
        else status = "Not Acceptable";
        
        actualStr = `${aSpacing.toFixed(2)} mm`;
      } else {
        score = aSpacing > 0 ? 85 : 0; // Baseline fallback
        actualStr = `${aSpacing.toFixed(2)} ${hasScale ? 'mm' : 'px'}`;
      }
      
      totalScore += score;

      tableRows.push({
        parameter: `Spacing Bar ${i+1} to ${i+2}`,
        design: dSpacing > 0 ? `${dSpacing} mm` : "Not Specified",
        actual: actualStr,
        status: status
      });
    });
    
    const finalScore = Math.round(totalScore / aSpacings.length);
    return { 
      score: finalScore, 
      score_count: null,
      score_radius: null,
      score_spacing: finalScore,
      table: tableRows 
    };
  }
}