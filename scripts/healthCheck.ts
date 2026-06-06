/**
 * Data Health Check Script
 * Validates collected data and generates a health report
 *
 * Usage: npx tsx scripts/healthCheck.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ErrorLogger, safeParseJSON } from './lib/errorLogger';
import { disconnectMongo } from './lib/mongodb';

interface IndexData {
  lastUpdated: string;
  brands: {
    [brandId: string]: {
      name: string;
      availableDates: string[];
      latestDate: string;
      totalRecords: number;
    };
  };
}

interface StoredData {
  collectedAt: string;
  brand: string;
  brandId: string;
  rowCount: number;
  rows: any[];
}

interface HealthReport {
  timestamp: string;
  status: 'healthy' | 'warning' | 'error';
  summary: {
    totalBrands: number;
    totalVehicles: number;
    lastUpdate: string;
    dataDate: string;
  };
  brands: {
    id: string;
    name: string;
    status: 'ok' | 'warning' | 'error';
    vehicleCount: number;
    latestDate: string;
    issues: string[];
  }[];
  issues: string[];
  warnings: string[];
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Data Health Check');
  console.log('='.repeat(60));
  console.log('');

  // Preserve errors logged by earlier pipeline stages (collector, artifacts)
  // so this final stage appends to them instead of overwriting errors.json.
  ErrorLogger.loadExisting();

  const dataDir = path.join(process.cwd(), 'data');
  const indexPath = path.join(dataDir, 'index.json');

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    status: 'healthy',
    summary: {
      totalBrands: 0,
      totalVehicles: 0,
      lastUpdate: '',
      dataDate: '',
    },
    brands: [],
    issues: [],
    warnings: [],
  };

  // Check if index exists
  if (!fs.existsSync(indexPath)) {
    report.status = 'error';
    report.issues.push('index.json not found');
    ErrorLogger.logError({
      category: 'FILE_ERROR',
      source: 'health',
      code: 'INDEX_NOT_FOUND',
      message: 'index.json not found',
    });
    await ErrorLogger.saveErrors();
    outputReport(report);
    process.exit(1);
  }

  const index = safeParseJSON<IndexData>(indexPath, { lastUpdated: '', brands: {} }, 'health');
  report.summary.lastUpdate = index.lastUpdated;

  const brandIds = Object.keys(index.brands);
  report.summary.totalBrands = brandIds.length;

  if (brandIds.length === 0) {
    report.status = 'error';
    report.issues.push('No brands found in index');
    outputReport(report);
    process.exit(1);
  }

  let latestDate = '';
  let totalVehicles = 0;

  for (const brandId of brandIds) {
    const brandInfo = index.brands[brandId];
    const brandReport = {
      id: brandId,
      name: brandInfo.name,
      status: 'ok' as 'ok' | 'warning' | 'error',
      vehicleCount: 0,
      latestDate: brandInfo.latestDate,
      issues: [] as string[],
    };

    console.log(`[${brandInfo.name}]`);

    // Check if latest data file exists
    const [year, month, day] = brandInfo.latestDate.split('-');
    const filePath = path.join(dataDir, year, month, brandId, `${day}.json`);

    if (!fs.existsSync(filePath)) {
      brandReport.status = 'error';
      brandReport.issues.push(`Data file not found: ${filePath}`);
      report.issues.push(`${brandInfo.name}: Data file not found`);
      ErrorLogger.logError({
        category: 'FILE_ERROR',
        source: 'health',
        brand: brandInfo.name,
        brandId: brandId,
        code: 'DATA_FILE_NOT_FOUND',
        message: `Data file not found: ${filePath}`,
      });
    } else {
      const storedData = safeParseJSON<StoredData>(filePath, { collectedAt: '', brand: '', brandId: '', rowCount: 0, rows: [] }, 'health');

      brandReport.vehicleCount = storedData.rowCount;
      totalVehicles += storedData.rowCount;

      // Check for empty data
      if (storedData.rowCount === 0) {
        brandReport.status = 'warning';
        brandReport.issues.push('No vehicles in data file');
        report.warnings.push(`${brandInfo.name}: No vehicles`);
      }

      // Check for price anomalies
      const prices = storedData.rows
        .map((r: any) => r.priceNumeric)
        .filter((p: number) => p > 0);

      if (prices.length > 0) {
        const avgPrice = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);

        // Warning if min price is suspiciously low
        if (minPrice < 100000) {
          brandReport.issues.push(`Suspiciously low price: ${minPrice}`);
          report.warnings.push(`${brandInfo.name}: Suspiciously low price (${minPrice})`);
          if (brandReport.status === 'ok') brandReport.status = 'warning';
          ErrorLogger.logWarning({
            category: 'DATA_QUALITY_ERROR',
            source: 'health',
            brand: brandInfo.name,
            brandId: brandId,
            code: 'SUSPICIOUSLY_LOW_PRICE',
            message: `Suspiciously low price: ${minPrice}`,
            details: { minPrice },
          });
        }

        // Warning if max price is suspiciously high
        if (maxPrice > 50000000) {
          brandReport.issues.push(`Suspiciously high price: ${maxPrice}`);
          report.warnings.push(`${brandInfo.name}: Suspiciously high price (${maxPrice})`);
          if (brandReport.status === 'ok') brandReport.status = 'warning';
          ErrorLogger.logWarning({
            category: 'DATA_QUALITY_ERROR',
            source: 'health',
            brand: brandInfo.name,
            brandId: brandId,
            code: 'SUSPICIOUSLY_HIGH_PRICE',
            message: `Suspiciously high price: ${maxPrice}`,
            details: { maxPrice },
          });
        }

        console.log(`  Vehicles: ${brandReport.vehicleCount}`);
        console.log(`  Price range: ${minPrice.toLocaleString('tr-TR')} - ${maxPrice.toLocaleString('tr-TR')}`);
        console.log(`  Average: ${Math.round(avgPrice).toLocaleString('tr-TR')}`);
      }

      // Check for missing fields
      const missingFields = storedData.rows.filter((r: any) =>
        !r.model || !r.priceNumeric || r.priceNumeric === 0
      );
      if (missingFields.length > 0) {
        brandReport.issues.push(`${missingFields.length} rows with missing data`);
        report.warnings.push(`${brandInfo.name}: ${missingFields.length} rows with missing data`);
        if (brandReport.status === 'ok') brandReport.status = 'warning';
      }

      // Detect malformed rows: a marketing badge captured as the model (e.g. "YENİ"),
      // or specs/prices mashed into the model/trim field (broken column parsing).
      // Normalize for the badge test so Turkish "İ"/"I" fold to "i" (JS /i flag won't).
      const normBadge = (s: string) => s.trim().replace(/[İI]/g, 'i').toLowerCase();
      const looksLikeBadge = (s: string) => /^(yeni|new|all[- ]?new|t[uü]m)$/.test(normBadge(s));
      // A model/trim must never contain a full price, a percentage, or a combined
      // kW/hp power block — those only appear when columns get mashed into one field.
      // (Plain "130 HP" in a trim is legitimate, so it is intentionally NOT flagged.)
      const looksMangled = (s: string) =>
        !!s && (
          /\d{1,3}[.,]\d{3}[.,]\d{3}/.test(s) ||        // contains a full price
          /%/.test(s) ||                                 // contains a percentage (ÖTV etc.)
          /\d+\s*k?w\s*\/\s*\d+\s*hp/i.test(s)           // contains a combined kW/hp block
        );
      const malformedRows = storedData.rows.filter((r: any) =>
        looksLikeBadge(String(r.model || '')) ||
        looksMangled(String(r.model || '')) ||
        looksMangled(String(r.trim || ''))
      );
      if (malformedRows.length > 0) {
        brandReport.issues.push(`${malformedRows.length} malformed rows (badge/mangled fields)`);
        report.warnings.push(`${brandInfo.name}: ${malformedRows.length} malformed rows`);
        if (brandReport.status === 'ok') brandReport.status = 'warning';
        ErrorLogger.logWarning({
          category: 'DATA_QUALITY_ERROR',
          source: 'health',
          brand: brandInfo.name,
          brandId: brandId,
          code: 'MALFORMED_ROWS',
          message: `${malformedRows.length} malformed rows in ${brandInfo.name}`,
          details: {
            count: malformedRows.length,
            sample: malformedRows.slice(0, 3).map((r: any) => ({ model: r.model, trim: r.trim })),
          },
        });
      }

      // Detect a sudden collapse in row count vs the previous collection day.
      const prevDate = (brandInfo.availableDates || [])
        .filter(d => d < brandInfo.latestDate)
        .sort()
        .pop();
      if (prevDate) {
        const [py, pm, pd] = prevDate.split('-');
        const prevPath = path.join(dataDir, py, pm, brandId, `${pd}.json`);
        if (fs.existsSync(prevPath)) {
          const prev = safeParseJSON<StoredData>(prevPath, { collectedAt: '', brand: '', brandId: '', rowCount: 0, rows: [] }, 'health');
          if (prev.rowCount >= 5 && storedData.rowCount < prev.rowCount * 0.6) {
            brandReport.issues.push(`Row count dropped ${prev.rowCount}->${storedData.rowCount}`);
            report.warnings.push(`${brandInfo.name}: row count dropped ${prev.rowCount}->${storedData.rowCount}`);
            if (brandReport.status === 'ok') brandReport.status = 'warning';
            ErrorLogger.logWarning({
              category: 'DATA_QUALITY_ERROR',
              source: 'health',
              brand: brandInfo.name,
              brandId: brandId,
              code: 'ROW_COUNT_DROP',
              message: `${brandInfo.name} row count dropped from ${prev.rowCount} to ${storedData.rowCount}`,
              details: { previous: prev.rowCount, current: storedData.rowCount },
            });
          }
        }
      }
    }

    if (brandReport.issues.length > 0) {
      console.log(`  Issues: ${brandReport.issues.join(', ')}`);
    } else {
      console.log('  Status: OK');
    }

    // Track latest date across all brands
    if (!latestDate || brandInfo.latestDate > latestDate) {
      latestDate = brandInfo.latestDate;
    }

    report.brands.push(brandReport);
    console.log('');
  }

  report.summary.totalVehicles = totalVehicles;
  report.summary.dataDate = latestDate;

  // Count failed brands (those with 'error' status)
  const failedBrands = report.brands.filter(b => b.status === 'error');
  const failedCount = failedBrands.length;

  // Determine overall status
  if (report.issues.length > 0) {
    report.status = 'error';
  } else if (report.warnings.length > 0) {
    report.status = 'warning';
  }

  // Check if data is stale (more than 2 days old)
  const latestDateObj = new Date(latestDate);
  const daysSinceUpdate = Math.floor((Date.now() - latestDateObj.getTime()) / (1000 * 60 * 60 * 24));
  if (daysSinceUpdate > 2) {
    report.warnings.push(`Data is ${daysSinceUpdate} days old`);
    if (report.status === 'healthy') report.status = 'warning';
  }

  outputReport(report);

  // Save errors to central error log
  await ErrorLogger.saveErrors();

  // Save health report
  const reportPath = path.join(dataDir, 'health-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Health report saved to ${reportPath}`);

  // Close MongoDB connection to allow process to exit
  await disconnectMongo();

  // Only fail if more than 5 brands have errors
  // This allows partial failures without breaking the entire pipeline
  const MAX_ALLOWED_FAILURES = 5;
  if (failedCount > MAX_ALLOWED_FAILURES) {
    console.log(`\n❌ Critical: ${failedCount} brands failed (threshold: ${MAX_ALLOWED_FAILURES})`);
    process.exit(1);
  } else if (failedCount > 0) {
    console.log(`\n⚠️ Warning: ${failedCount} brand(s) failed, but below threshold (${MAX_ALLOWED_FAILURES})`);
    console.log(`   Failed brands: ${failedBrands.map(b => b.name).join(', ')}`);
  }
}

function outputReport(report: HealthReport): void {
  console.log('='.repeat(60));
  console.log('Health Report');
  console.log('='.repeat(60));
  console.log(`Status: ${report.status.toUpperCase()}`);
  console.log(`Brands: ${report.summary.totalBrands}`);
  console.log(`Vehicles: ${report.summary.totalVehicles}`);
  console.log(`Data Date: ${report.summary.dataDate}`);

  if (report.issues.length > 0) {
    console.log('\nIssues:');
    report.issues.forEach(i => console.log(`  - ${i}`));
  }

  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    report.warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('');
}

main().catch(async error => {
  console.error('Fatal error:', error);
  ErrorLogger.logError({
    category: 'FILE_ERROR',
    source: 'health',
    code: 'FATAL_ERROR',
    message: `Fatal error in health check: ${error instanceof Error ? error.message : String(error)}`,
    stack: error instanceof Error ? error.stack : undefined,
  });
  await ErrorLogger.saveErrors();
  await disconnectMongo();
  process.exit(1);
});
