/**
 * AI Mind Map — Logger Utility
 *
 * Simple structured logger that writes to stderr so it does not interfere
 * with the MCP JSON-RPC protocol on stdout.
 *
 * Features:
 * - Four log levels: debug, info, warn, error
 * - ISO-8601 timestamp prefix
 * - Optional file logging (append mode)
 * - Runtime-configurable log level
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WriteStream } from 'node:fs';

/** Supported log levels ordered by severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric severity for comparison — lower means more verbose. */
const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** ANSI colour codes used only for stderr output (not file). */
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // grey
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';

/** Configuration for the Logger. */
export interface LoggerOptions {
  /** Minimum level to emit. Default: `'info'`. */
  level?: LogLevel;
  /** Optional file path to append log lines to. */
  filePath?: string;
  /** Prefix prepended to every message (e.g. component name). */
  prefix?: string;
  /** Whether to include colours in stderr output. Default: `true`. */
  colors?: boolean;
}

/**
 * Lightweight logger that writes to stderr and optionally to a file.
 *
 * ```ts
 * const log = new Logger({ level: 'debug', prefix: 'Indexer' });
 * log.info('Indexed 42 files');
 * log.error('Failed to parse', filePath);
 * ```
 */
export class Logger {
  private level: number;
  private prefix: string;
  private colors: boolean;
  private fileStream: WriteStream | null = null;

  constructor(options: LoggerOptions = {}) {
    this.level = LEVEL_VALUE[options.level ?? 'info'];
    this.prefix = options.prefix ?? 'MindMap';
    this.colors = options.colors ?? true;

    if (options.filePath) {
      try {
        mkdirSync(dirname(options.filePath), { recursive: true });
        this.fileStream = createWriteStream(options.filePath, { flags: 'a' });
      } catch {
        // If we can't open the log file, silently fall back to stderr-only.
        process.stderr.write(
          `[Logger] WARNING: Could not open log file at ${options.filePath}\n`,
        );
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────

  /** Log a debug-level message. */
  debug(...args: unknown[]): void {
    this.emit('debug', args);
  }

  /** Log an info-level message. */
  info(...args: unknown[]): void {
    this.emit('info', args);
  }

  /** Log a warning-level message. */
  warn(...args: unknown[]): void {
    this.emit('warn', args);
  }

  /** Log an error-level message. */
  error(...args: unknown[]): void {
    this.emit('error', args);
  }

  /** Update the minimum log level at runtime. */
  setLevel(level: LogLevel): void {
    this.level = LEVEL_VALUE[level];
  }

  /** Return the current effective log level. */
  getLevel(): LogLevel {
    const entries = Object.entries(LEVEL_VALUE) as [LogLevel, number][];
    const match = entries.find(([, v]) => v === this.level);
    return match ? match[0] : 'info';
  }

  /** Create a child logger that inherits settings but adds a sub-prefix. */
  child(subPrefix: string): Logger {
    const child = new Logger({
      level: this.getLevel(),
      prefix: `${this.prefix}:${subPrefix}`,
      colors: this.colors,
    });
    // Share the same file stream so we don't open multiple handles.
    child.fileStream = this.fileStream;
    return child;
  }

  /** Flush and close the file stream (if any). */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }

  // ── Internals ──────────────────────────────────────────────

  private emit(level: LogLevel, args: unknown[]): void {
    if (LEVEL_VALUE[level] < this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase().padEnd(5);
    const message = args
      .map((a) => {
        if (a instanceof Error) {
          return a.stack ?? a.message;
        }
        if (typeof a === 'string') {
          return a;
        }
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');

    // Plain line for file logging.
    const plainLine = `${timestamp} [${levelTag}] [${this.prefix}] ${message}\n`;

    // Coloured line for stderr.
    if (this.colors) {
      const color = LEVEL_COLOR[level];
      process.stderr.write(
        `${color}${timestamp} [${levelTag}]${RESET} [${this.prefix}] ${message}\n`,
      );
    } else {
      process.stderr.write(plainLine);
    }

    if (this.fileStream) {
      this.fileStream.write(plainLine);
    }
  }
}
