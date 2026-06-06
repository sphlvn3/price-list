/**
 * ErrorLogger - Centralized error logging service for scripts
 * Logs errors to data/errors.json for display in /errors page
 */

import * as fs from 'fs';
import * as path from 'path';
import { saveToMongo } from './mongodb';

export type ErrorSeverity = 'error' | 'warning' | 'info';
export type ErrorCategory = 'HTTP_ERROR' | 'PARSE_ERROR' | 'VALIDATION_ERROR' | 'FILE_ERROR' | 'DATA_QUALITY_ERROR';
export type ErrorSource = 'collection' | 'generation' | 'health' | 'frontend';

export interface SystemError {
  id: string;
  timestamp: string;
  severity: ErrorSeverity;
  category: ErrorCategory;
  source: ErrorSource;
  brand?: string;
  brandId?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
  recovered: boolean;
  recoveryMethod?: string;
}

export interface ErrorLog {
  generatedAt: string;
  clearedAt: string;
  errors: SystemError[];
  summary: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    bySource: Record<string, number>;
  };
}

interface LogErrorInput {
  severity?: ErrorSeverity;
  category: ErrorCategory;
  source: ErrorSource;
  brand?: string;
  brandId?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
  recovered?: boolean;
  recoveryMethod?: string;
}

class ErrorLoggerClass {
  private errors: SystemError[] = [];
  private clearedAt: string = new Date().toISOString();
  private dataDir: string;
  private outputPath: string;

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
    this.outputPath = path.join(this.dataDir, 'errors.json');
  }

  /**
   * Generate unique error ID
   */
  private generateId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Clear all errors - call at start of each script run
   */
  clearErrors(): void {
    this.errors = [];
    this.clearedAt = new Date().toISOString();
    console.log('[ErrorLogger] Errors cleared');
  }

  /**
   * Load errors previously written to errors.json into memory.
   *
   * Call this at the start of pipeline stages that run AFTER the collector
   * (e.g. generateArtifacts, healthCheck) so their saveErrors() appends to the
   * collector's errors instead of overwriting them with an empty list.
   */
  loadExisting(): void {
    try {
      if (!fs.existsSync(this.outputPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.outputPath, 'utf-8')) as Partial<ErrorLog>;
      if (!Array.isArray(parsed.errors)) return;
      const existingIds = new Set(this.errors.map(e => e.id));
      for (const err of parsed.errors) {
        if (err && err.id && !existingIds.has(err.id)) {
          this.errors.push(err);
          existingIds.add(err.id);
        }
      }
      if (parsed.clearedAt) this.clearedAt = parsed.clearedAt;
    } catch {
      // Corrupt/unreadable file: start fresh rather than crash the stage.
    }
  }

  /**
   * Log an error
   */
  logError(input: LogErrorInput): void {
    const error: SystemError = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      severity: input.severity || 'error',
      category: input.category,
      source: input.source,
      brand: input.brand,
      brandId: input.brandId,
      code: input.code,
      message: input.message,
      details: input.details,
      stack: input.stack,
      recovered: input.recovered || false,
      recoveryMethod: input.recoveryMethod,
    };

    this.errors.push(error);

    // Log to console as well
    const prefix = error.severity === 'error' ? '❌' : error.severity === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`${prefix} [${error.source}] ${error.code}: ${error.message}`);
    if (error.details) {
      console.log('   Details:', JSON.stringify(error.details, null, 2));
    }
  }

  /**
   * Log a warning (convenience method)
   */
  logWarning(input: Omit<LogErrorInput, 'severity'>): void {
    this.logError({ ...input, severity: 'warning' });
  }

  /**
   * Log an info (convenience method)
   */
  logInfo(input: Omit<LogErrorInput, 'severity'>): void {
    this.logError({ ...input, severity: 'info' });
  }

  /**
   * Get all errors
   */
  getErrors(): SystemError[] {
    return [...this.errors];
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(): ErrorLog['summary'] {
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const error of this.errors) {
      byCategory[error.category] = (byCategory[error.category] || 0) + 1;
      bySeverity[error.severity] = (bySeverity[error.severity] || 0) + 1;
      bySource[error.source] = (bySource[error.source] || 0) + 1;
    }

    return {
      total: this.errors.length,
      byCategory,
      bySeverity,
      bySource,
    };
  }

  /**
   * Save errors to JSON file
   */
  async saveErrors(): Promise<void> {
    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    const errorLog: ErrorLog = {
      generatedAt: new Date().toISOString(),
      clearedAt: this.clearedAt,
      errors: this.errors,
      summary: this.calculateSummary(),
    };

    fs.writeFileSync(this.outputPath, JSON.stringify(errorLog, null, 2), 'utf-8');
    await saveToMongo('errors', errorLog as unknown as Record<string, unknown>);
    console.log(`[ErrorLogger] Saved ${this.errors.length} errors to ${this.outputPath}`);
  }

  /**
   * Check if there are any errors
   */
  hasErrors(): boolean {
    return this.errors.some(e => e.severity === 'error');
  }

  /**
   * Get error count by severity
   */
  getErrorCount(severity?: ErrorSeverity): number {
    if (!severity) return this.errors.length;
    return this.errors.filter(e => e.severity === severity).length;
  }
}

// Export singleton instance
export const ErrorLogger = new ErrorLoggerClass();

/**
 * Safe JSON parse helper with error logging
 */
export function safeParseJSON<T>(
  filePath: string,
  fallback: T,
  source: ErrorSource = 'generation'
): T {
  try {
    if (!fs.existsSync(filePath)) {
      ErrorLogger.logWarning({
        category: 'FILE_ERROR',
        source,
        code: 'FILE_NOT_FOUND',
        message: `File not found: ${filePath}`,
        details: { filePath },
        recovered: true,
        recoveryMethod: 'Using fallback value',
      });
      return fallback;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    ErrorLogger.logError({
      category: 'PARSE_ERROR',
      source,
      code: 'JSON_PARSE_FAILED',
      message: `Failed to parse JSON: ${filePath}`,
      details: {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      },
      stack: error instanceof Error ? error.stack : undefined,
      recovered: true,
      recoveryMethod: 'Using fallback value',
    });
    return fallback;
  }
}

/**
 * Safe file read helper with error logging
 */
export function safeReadFile(
  filePath: string,
  fallback: string = '',
  source: ErrorSource = 'generation'
): string {
  try {
    if (!fs.existsSync(filePath)) {
      ErrorLogger.logWarning({
        category: 'FILE_ERROR',
        source,
        code: 'FILE_NOT_FOUND',
        message: `File not found: ${filePath}`,
        details: { filePath },
        recovered: true,
        recoveryMethod: 'Using fallback value',
      });
      return fallback;
    }

    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    ErrorLogger.logError({
      category: 'FILE_ERROR',
      source,
      code: 'FILE_READ_FAILED',
      message: `Failed to read file: ${filePath}`,
      details: {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      },
      stack: error instanceof Error ? error.stack : undefined,
      recovered: true,
      recoveryMethod: 'Using fallback value',
    });
    return fallback;
  }
}
