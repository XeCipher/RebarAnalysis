import { Injectable } from '@angular/core';

export interface ComparisonRow {
  parameter: string;
  design: string;
  actual: string;
  status: 'Acceptable' | 'Not Acceptable' | 'NA';
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
    
    // 1. Number of Bars (Rc) - Strict 100 / 0
    const dCount = this.safeInt(designData.count);
    const aCount = this.safeInt(actualData.count);
    const diffCount = Math.abs(dCount - aCount);
    
    const scoreCount = diffCount === 0 ? 100 : 0;
    
    tableRows.push({
      parameter: "Number of rods",
      design: String(dCount),
      actual: String(aCount),
      status: diffCount === 0 ? "Acceptable" : "Not Acceptable"
    });

    // 2. Radius (Rr) - Based on IS 1786:2008 Mass/Dia Tolerance limits
    let scoreRadius = 100;
    const dRad = this.safeFloat(designData.radius_mm);
    const aRad = this.safeFloat(actualData.avg_radius);
    
    let radiusStatus: ComparisonRow['status'] = "NA";
    let actualDisplay = "";

    if (hasScale) {
      if (dRad > 0) {
        const diameter = dRad * 2;
        
        // IS 1786:2008 Approximations for Diametrical Tolerance based on unit weight
        let tol_pct = 2.0;
        if (diameter <= 10) tol_pct = 3.5;
        else if (diameter <= 16) tol_pct = 2.5; // Covers 12mm to 16mm
        else tol_pct = 2.0; // Over 16mm

        const errRad = Math.abs(dRad - aRad);
        const percentErr = (errRad / dRad) * 100;
        
        if (percentErr <= tol_pct) {
          radiusStatus = "Acceptable";
          scoreRadius = 100;
        } else {
          radiusStatus = "Not Acceptable";
          scoreRadius = 0;
        }
        actualDisplay = `${aRad.toFixed(2)} mm`;
      } else {
        radiusStatus = "Not Acceptable";
        scoreRadius = 0;
        actualDisplay = `${aRad.toFixed(2)} mm`;
      }
    } else {
      actualDisplay = `${aRad.toFixed(2)} px`;
    }

    tableRows.push({
      parameter: "Radius of rods (avg)",
      design: dRad > 0 ? `${dRad} mm` : "Not Specified",
      actual: actualDisplay,
      status: radiusStatus
    });

    // 3. Sequential Spacing (Rs) - Based on IS 456:2000
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
        let rowScore = 100;
        
        if (valDesign !== null) {
          if (hasScale) {
            if (valDesign > 0) {
              // IS 456:2000 Tolerance limit checks
              const tol_mm = valDesign <= 200 ? 10 : 15;
              const err_mm = Math.abs(valDesign - valActual);
              
              if (err_mm <= tol_mm) {
                rowStatus = "Acceptable";
                rowScore = 100;
              } else {
                rowStatus = "Not Acceptable";
                rowScore = 0;
              }
              
              scoreSpacingAccum += rowScore;
              validSpacingChecks++;
            }
          } else {
            if (valDesign > 0) {
              const dNorm = valDesign / (dMax > 0 ? dMax : 1);
              const aNorm = valActual / (aMax > 0 ? aMax : 1);
              const diffRatio = Math.abs(dNorm - aNorm);
              
              // Visual pixel-ratio fallback tolerance
              if (diffRatio <= 0.05) {
                rowStatus = "Acceptable";
                rowScore = 100;
              } else {
                rowStatus = "Not Acceptable";
                rowScore = 0;
              }
              
              scoreSpacingAccum += rowScore;
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
    
    // Formula: Final Score = (Rc + Rr + Rs) / 3
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
    const singleDSpacing = this.safeFloat(designData.spacing_mm, -1);
    const dSpacings = Array.isArray(designData.spacings_mm) ? designData.spacings_mm.map((x: any) => this.safeFloat(x, 0)) : [];
    
    const leastDim = this.safeFloat(designData.least_lateral_dim_mm, 0);
    const longBarDia = this.safeFloat(designData.longitudinal_bar_dia_mm, 0);
    const aSpacings: number[] = Array.isArray(actualData.spacings) ? actualData.spacings : [];
    
    // IS 456:2000 Clause 26.5.3.2 Max Spacing Limit
    let maxSpacingLimit = 300;
    if (leastDim > 0) maxSpacingLimit = Math.min(maxSpacingLimit, leastDim);
    if (longBarDia > 0) maxSpacingLimit = Math.min(maxSpacingLimit, 16 * longBarDia);
    
    const tableRows: ComparisonRow[] = [];
    
    if (aSpacings.length === 0) {
      return { 
        score: 0, 
        score_count: null,
        score_radius: null,
        score_spacing: 0,
        table: [{ parameter: "Vertical Spacing", design: singleDSpacing > 0 ? `${singleDSpacing} mm` : "Not Specified", actual: "None detected", status: "Not Acceptable" }] 
      };
    }

    let totalScore = 0;

    aSpacings.forEach((aSpacing, i) => {
      // Pick current target spacing from array (if provided), otherwise fallback to single spacing or 0
      const dSpacing = singleDSpacing !== -1 ? singleDSpacing : (i < dSpacings.length ? dSpacings[i] : (dSpacings.length > 0 ? dSpacings[dSpacings.length - 1] : 0));
      let score = 0;
      let status: ComparisonRow['status'] = "NA";
      let actualStr = "";
      
      if (hasScale) {
        if (aSpacing > maxSpacingLimit) {
          status = "Not Acceptable";
          score = 0;
          actualStr = `${aSpacing.toFixed(2)} mm (Exceeds IS Max: ${maxSpacingLimit}mm)`;
        } else if (dSpacing > 0) {
          // IS 456:2000 Tolerance limit checks
          const tol_mm = dSpacing <= 200 ? 10 : 15;
          const err_mm = Math.abs(dSpacing - aSpacing);
          
          if (err_mm <= tol_mm) {
            status = "Acceptable";
            score = 100;
            actualStr = `${aSpacing.toFixed(2)} mm`;
          } else {
            status = "Not Acceptable";
            score = 0;
            actualStr = `${aSpacing.toFixed(2)} mm (Deviates from design ${dSpacing}mm)`;
          }
        } else {
          status = "Acceptable";
          score = 100;
          actualStr = `${aSpacing.toFixed(2)} mm`;
        }
      } else {
        if (aSpacing > 0) {
          score = 100; // Baseline fallback without physical scale
          status = "NA";
        }
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