/**
 * AI Mind Map — Content-Aware Compression Engine
 *
 * Provides intelligent content compression that understands different
 * content types and applies appropriate strategies.
 *
 * Inspired by context-mode (98% reduction) and context-mem's content-aware
 * summarisers.  Each content type gets a specialised compressor that
 * preserves the most semantically valuable information while aggressively
 * stripping noise.
 *
 * Three compression levels:
 *  - `minimal`    – whitespace / comment cleanup
 *  - `moderate`   – content-specific compression
 *  - `aggressive` – maximum reduction (signatures-only, errors-only, etc.)
 */

import type { CompressionLevel, ContentType } from '../types.js';
import { estimateTokens } from '../utils/token-counter.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger({ prefix: 'Compressor' });

// ── Result type ──────────────────────────────────────────────

/** Result returned from any compression operation. */
export interface CompressionResult {
  /** The compressed text. */
  compressed: string;
  /** Original token estimate. */
  originalTokens: number;
  /** Compressed token estimate. */
  compressedTokens: number;
  /** Compression ratio — `1 - compressedTokens / originalTokens`. */
  ratio: number;
  /** The detected (or supplied) content type. */
  contentType: ContentType;
  /** The compression level applied. */
  level: CompressionLevel;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Auto-detect the content type of arbitrary text.
 *
 * Applies a series of heuristics in priority order.  Returns
 * `'plain_text'` as a fallback.
 */
export function detectContentType(text: string): ContentType {
  if (!text || text.trim().length === 0) {
    return 'plain_text';
  }

  const trimmed = text.trim();

  // ── Diff ──────────────────────────────────────────────
  if (
    trimmed.startsWith('diff --git') ||
    trimmed.startsWith('--- a/') ||
    trimmed.startsWith('+++ b/') ||
    /^@@\s+-\d+/.test(trimmed)
  ) {
    return 'diff';
  }

  // ── Stack trace ───────────────────────────────────────
  if (
    /^\s*at\s+.+\(.+:\d+:\d+\)/m.test(trimmed) ||          // Node / JS
    /^\s*File ".+", line \d+/m.test(trimmed) ||              // Python
    /^\s+at .+\(.*\.java:\d+\)/m.test(trimmed) ||            // Java
    /^Traceback \(most recent call last\)/m.test(trimmed) ||  // Python header
    /panic:.*goroutine/m.test(trimmed)                        // Go
  ) {
    return 'stack_trace';
  }

  // ── Test output ───────────────────────────────────────
  if (
    /^(PASS|FAIL|ok|not ok|Tests:)/m.test(trimmed) ||
    /\d+ (passing|failing|passed|failed)/m.test(trimmed) ||
    /^(Test Suite|RUNS?|\u2713|\u2717|\u2718|\u25CF)/m.test(trimmed) ||
    /(PASSED|FAILED|ERROR)\s+\[/m.test(trimmed) ||
    /^={3,}\s*(FAILURES|ERRORS)\s*={3,}/m.test(trimmed)
  ) {
    return 'test_output';
  }

  // ── Build log ─────────────────────────────────────────
  if (
    /^(warning|error|note)\s*:/mi.test(trimmed) ||
    /^\[\d{2}:\d{2}:\d{2}\]/m.test(trimmed) ||
    /^(>|\\$)\s+(tsc|npm|yarn|pnpm|make|cmake|gradle|cargo|go\s+build)/m.test(trimmed) ||
    /^(BUILD|COMPILE)\s+(SUCCEEDED|FAILED)/m.test(trimmed) ||
    /error TS\d+:/m.test(trimmed)
  ) {
    return 'build_log';
  }

  // ── JSON data ─────────────────────────────────────────
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return 'json_data';
    } catch {
      // Not valid JSON – fall through.
    }
  }

  // ── Config file ───────────────────────────────────────
  if (
    /^\[[\w.-]+\]\s*$/m.test(trimmed) ||                    // INI/TOML section
    /^[\w_][\w._-]*\s*[:=]\s*/m.test(trimmed) ||             // key=value
    /^(apiVersion|kind|metadata|spec):/m.test(trimmed)       // K8s YAML
  ) {
    return 'config_file';
  }

  // ── Markdown ──────────────────────────────────────────
  if (
    /^#{1,6}\s+.+/m.test(trimmed) ||
    /^\*{3,}$|^-{3,}$/m.test(trimmed) ||
    /^\s*[-*+]\s+.+/m.test(trimmed) && /^#{1,6}\s/m.test(trimmed)
  ) {
    return 'markdown';
  }

  // ── Source code ───────────────────────────────────────
  if (
    /^(import|export|from|require|use|using|package|module)\s/m.test(trimmed) ||
    /^(function|class|interface|type|enum|const|let|var|def|fn|pub|func)\s/m.test(trimmed) ||
    /^(public|private|protected|static|abstract|async)\s/m.test(trimmed) ||
    /[{};]\s*$/m.test(trimmed) ||
    /^\s*(\/\/|#|\/\*|\*|""")/m.test(trimmed)
  ) {
    return 'source_code';
  }

  return 'plain_text';
}

/**
 * Compress content intelligently based on its type and the chosen level.
 *
 * @param text          - Raw content to compress.
 * @param level         - Compression level (`minimal`, `moderate`, `aggressive`).
 * @param contentType   - If known; otherwise auto-detected.
 * @returns A {@link CompressionResult} with the compressed text and metrics.
 */
export function compress(
  text: string,
  level: CompressionLevel = 'moderate',
  contentType?: ContentType,
): CompressionResult {
  const detectedType = contentType ?? detectContentType(text);
  const originalTokens = estimateTokens(text);

  if (!text || text.trim().length === 0) {
    return buildResult('', originalTokens, detectedType, level);
  }

  try {
    let compressed: string;

    switch (level) {
      case 'minimal':
        compressed = applyMinimal(text);
        break;
      case 'moderate':
        compressed = applyModerate(text, detectedType);
        break;
      case 'aggressive':
        compressed = applyAggressive(text, detectedType);
        break;
      default:
        compressed = applyModerate(text, detectedType);
    }

    return buildResult(compressed, originalTokens, detectedType, level);
  } catch (err) {
    logger.warn('Compression failed, returning minimally cleaned text', err);
    return buildResult(applyMinimal(text), originalTokens, detectedType, level);
  }
}

// ── Minimal compression ──────────────────────────────────────

/** Level 1: whitespace / comment cleanup only. */
function applyMinimal(text: string): string {
  let result = text;

  // Remove trailing whitespace on every line.
  result = result.replace(/[ \t]+$/gm, '');

  // Collapse multiple blank lines into at most one.
  result = result.replace(/\n{3,}/g, '\n\n');

  // Reduce block-comment verbosity (collapse multi-line `*` padding).
  result = result.replace(/^[ \t]*\*[ \t]*\n/gm, '');

  return result.trim();
}

// ── Moderate compression ─────────────────────────────────────

/** Level 2: content-type-specific compression. */
function applyModerate(text: string, type: ContentType): string {
  // Always start with minimal cleanup.
  const cleaned = applyMinimal(text);

  switch (type) {
    case 'source_code':
      return compressSourceModerate(cleaned);
    case 'build_log':
      return compressBuildLog(cleaned, false);
    case 'test_output':
      return compressTestOutput(cleaned, false);
    case 'stack_trace':
      return compressStackTrace(cleaned, false);
    case 'json_data':
      return compressJson(cleaned, false);
    case 'markdown':
      return compressMarkdown(cleaned, false);
    case 'diff':
      return compressDiff(cleaned, false);
    case 'config_file':
      return compressConfig(cleaned, false);
    case 'plain_text':
    default:
      return cleaned;
  }
}

// ── Aggressive compression ───────────────────────────────────

/** Level 3: maximum reduction. */
function applyAggressive(text: string, type: ContentType): string {
  const cleaned = applyMinimal(text);

  switch (type) {
    case 'source_code':
      return compressSourceAggressive(cleaned);
    case 'build_log':
      return compressBuildLog(cleaned, true);
    case 'test_output':
      return compressTestOutput(cleaned, true);
    case 'stack_trace':
      return compressStackTrace(cleaned, true);
    case 'json_data':
      return compressJson(cleaned, true);
    case 'markdown':
      return compressMarkdown(cleaned, true);
    case 'diff':
      return compressDiff(cleaned, true);
    case 'config_file':
      return compressConfig(cleaned, true);
    case 'plain_text':
    default:
      return compressPlainTextAggressive(cleaned);
  }
}

// ================================================================
// Content-specific compressors
// ================================================================

// ── Source Code ──────────────────────────────────────────────

/**
 * Moderate source-code compression:
 *  - Keep signatures & doc comments.
 *  - Replace function/method bodies with `{ ... }`.
 *  - Keep import/export statements.
 */
function compressSourceModerate(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let braceDepth = 0;
  let insideBody = false;
  let bodyStartDepth = 0;
  let lastWasSignature = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Always keep imports, exports, and empty structural lines.
    if (isImportOrExport(trimmedLine)) {
      output.push(line);
      lastWasSignature = false;
      continue;
    }

    // Keep doc comments / JSDoc.
    if (isDocComment(trimmedLine)) {
      output.push(line);
      lastWasSignature = false;
      continue;
    }

    // Keep single-line type declarations, interfaces with no body.
    if (isTypeDeclaration(trimmedLine)) {
      output.push(line);
      lastWasSignature = false;
      continue;
    }

    // Detect function / class / method signatures.
    if (!insideBody && isSignatureLine(trimmedLine)) {
      output.push(line);
      lastWasSignature = true;

      // If the signature opens a body on the same line…
      // Strip strings and comments before counting braces to avoid false counts
      const strippedLine = stripStringsAndComments(trimmedLine);
      const opens = countChar(strippedLine, '{');
      const closes = countChar(strippedLine, '}');
      if (opens > closes) {
        insideBody = true;
        bodyStartDepth = braceDepth + opens - closes;
        braceDepth += opens - closes;
        // Replace the body start.
        if (!trimmedLine.endsWith('{')) {
          // Body opener is embedded – keep the line as-is.
        }
      }
      continue;
    }

    // Track brace depth.
    // Strip strings and comments before counting braces to avoid false counts
    const strippedLine = stripStringsAndComments(trimmedLine);
    const opens = countChar(strippedLine, '{');
    const closes = countChar(strippedLine, '}');
    braceDepth += opens - closes;

    if (insideBody) {
      if (braceDepth < bodyStartDepth) {
        // Body closed — emit placeholder and closing brace.
        if (lastWasSignature) {
          output.push(`${indentOf(line)}  // ... implementation`);
        }
        output.push(line); // closing brace
        insideBody = false;
        lastWasSignature = false;
      }
      // Skip lines inside the body.
      continue;
    }

    // Keep everything else (structural code outside bodies).
    output.push(line);
    lastWasSignature = false;
  }

  return output.join('\n');
}

/**
 * Aggressive source-code compression:
 *  - Signatures only (no doc comments, no implementations).
 */
function compressSourceAggressive(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let braceDepth = 0;
  let insideBody = false;
  let bodyStartDepth = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Keep imports (collapsed).
    if (isImportOrExport(trimmedLine)) {
      output.push(line);
      continue;
    }

    // Skip all comments in aggressive mode.
    if (isComment(trimmedLine)) {
      continue;
    }

    // Type declarations – keep.
    if (isTypeDeclaration(trimmedLine)) {
      output.push(line);
      continue;
    }

    if (!insideBody && isSignatureLine(trimmedLine)) {
      // Emit signature with ellipsis body.
      // Strip strings and comments before counting braces to avoid false counts
      const strippedLine = stripStringsAndComments(trimmedLine);
      const opens = countChar(strippedLine, '{');
      const closes = countChar(strippedLine, '}');

      if (opens > closes) {
        insideBody = true;
        bodyStartDepth = braceDepth + opens - closes;
        braceDepth += opens - closes;
      }

      // Emit a one-liner skeleton.
      const signaturePart = trimmedLine.replace(/\{.*$/, '').trimEnd();
      output.push(`${indentOf(line)}${signaturePart} { ... }`);
      continue;
    }

    // Strip strings and comments before counting braces to avoid false counts
    const strippedLineAgg = stripStringsAndComments(trimmedLine);
    const opens = countChar(strippedLineAgg, '{');
    const closes = countChar(strippedLineAgg, '}');
    braceDepth += opens - closes;

    if (insideBody) {
      if (braceDepth < bodyStartDepth) {
        insideBody = false;
      }
      continue;
    }

    // Keep structural lines (class declarations, etc.)
    if (trimmedLine.length > 0) {
      output.push(line);
    }
  }

  return output.join('\n');
}

// ── Build Log ───────────────────────────────────────────────

function compressBuildLog(text: string, aggressive: boolean): string {
  const lines = text.split('\n');
  const seen = new Set<string>();
  const output: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Strip timestamps.
    const noTimestamp = trimmedLine
      .replace(/^\[\d{2}:\d{2}:\d{2}[^\]]*\]\s*/, '')
      .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s*/, '');

    // Keep errors.
    if (/\b(error|fatal|exception)\b/i.test(noTimestamp)) {
      if (!seen.has(noTimestamp)) {
        seen.add(noTimestamp);
        output.push(noTimestamp);
      }
      continue;
    }

    // Keep warnings (unless aggressive).
    if (!aggressive && /\b(warning|warn)\b/i.test(noTimestamp)) {
      if (!seen.has(noTimestamp)) {
        seen.add(noTimestamp);
        output.push(noTimestamp);
      }
      continue;
    }

    // In non-aggressive mode, keep summary / result lines.
    if (
      !aggressive &&
      (/^(BUILD|COMPILE|Finished|Successfully)/i.test(noTimestamp) ||
        /\d+\s+(error|warning)/i.test(noTimestamp))
    ) {
      output.push(noTimestamp);
    }
  }

  if (output.length === 0) {
    return aggressive ? '[No errors found]' : '[No errors or warnings found]';
  }

  const header = aggressive ? '=== Errors ===' : '=== Errors & Warnings ===';
  return `${header}\n${output.join('\n')}`;
}

// ── Test Output ─────────────────────────────────────────────

function compressTestOutput(text: string, aggressive: boolean): string {
  const lines = text.split('\n');
  const failures: string[] = [];
  const summary: string[] = [];
  let capturingFailure = false;
  let failureBuffer: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Detect failure start.
    if (
      /^(FAIL|\u2717|\u2718|\u2715|\u00D7|not ok|FAILED)/i.test(trimmedLine) ||
      /AssertionError|Error:|Expected|Received/i.test(trimmedLine)
    ) {
      if (!capturingFailure) {
        capturingFailure = true;
        failureBuffer = [];
      }
      failureBuffer.push(line);
      continue;
    }

    // If capturing, keep context lines.
    if (capturingFailure) {
      if (
        trimmedLine === '' ||
        /^(PASS|\u2713|ok |Test Suites:|Tests:)/i.test(trimmedLine)
      ) {
        // End of failure block.
        failures.push(failureBuffer.join('\n'));
        capturingFailure = false;
        failureBuffer = [];
      } else {
        failureBuffer.push(line);
        continue;
      }
    }

    // Keep summary lines.
    if (
      /^(Test Suites?:|Tests:|Snapshots:|Time:)/i.test(trimmedLine) ||
      /\d+\s+(passing|failing|passed|failed|skipped)/i.test(trimmedLine)
    ) {
      summary.push(trimmedLine);
    }
  }

  // Flush any remaining failure.
  if (failureBuffer.length > 0) {
    failures.push(failureBuffer.join('\n'));
  }

  const parts: string[] = [];

  if (failures.length > 0) {
    parts.push(`=== Failures (${failures.length}) ===`);
    if (aggressive) {
      // In aggressive mode, limit to first 5 failures.
      parts.push(...failures.slice(0, 5));
      if (failures.length > 5) {
        parts.push(`... and ${failures.length - 5} more failures`);
      }
    } else {
      parts.push(...failures);
    }
  }

  if (summary.length > 0) {
    parts.push('');
    parts.push('=== Summary ===');
    parts.push(...summary);
  }

  return parts.length > 0 ? parts.join('\n') : '[All tests passed]';
}

// ── Stack Trace ─────────────────────────────────────────────

/** Patterns for framework / library frames to skip. */
const FRAMEWORK_FRAME_RE =
  /node_modules|internal\/|node:|<anonymous>|webpack|__webpack|\.next\/|turbopack|jest-|mocha|karma|angular[\\/]core|react-dom|zone\.js/i;

function compressStackTrace(text: string, aggressive: boolean): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let consecutiveSkipped = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Keep the error message line(s) at the top.
    if (
      !trimmedLine.startsWith('at ') &&
      !trimmedLine.startsWith('File "') &&
      !/^\s+at\s/.test(line)
    ) {
      if (consecutiveSkipped > 0) {
        output.push(`    ... ${consecutiveSkipped} framework frames`);
        consecutiveSkipped = 0;
      }
      output.push(line);
      continue;
    }

    // It's a stack frame.  Skip framework frames.
    if (FRAMEWORK_FRAME_RE.test(trimmedLine)) {
      consecutiveSkipped++;
      continue;
    }

    // Keep user frames.
    if (consecutiveSkipped > 0) {
      output.push(`    ... ${consecutiveSkipped} framework frames`);
      consecutiveSkipped = 0;
    }
    output.push(line);
  }

  if (consecutiveSkipped > 0) {
    output.push(`    ... ${consecutiveSkipped} framework frames`);
  }

  // Aggressive: deduplicate identical traces.
  if (aggressive) {
    return deduplicateLines(output).join('\n');
  }

  return output.join('\n');
}

// ── JSON Data ───────────────────────────────────────────────

function compressJson(text: string, aggressive: boolean): string {
  try {
    const parsed = JSON.parse(text);
    return compressJsonValue(parsed, aggressive, 0);
  } catch {
    // Not valid JSON – just apply minimal.
    return text;
  }
}

function compressJsonValue(
  value: unknown,
  aggressive: boolean,
  depth: number,
): string {
  const indent = '  '.repeat(depth);
  const childIndent = '  '.repeat(depth + 1);

  if (value === null || value === undefined) {
    return `${indent}null`;
  }
  if (typeof value === 'string') {
    const truncated =
      value.length > 100 ? `${value.slice(0, 100)}... (${value.length} chars)` : value;
    return `${indent}"${truncated}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${indent}${String(value)}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[]`;

    // Show schema + first example + count.
    const first = value[0];
    const firstStr = compressJsonValue(first, aggressive, depth + 1);

    if (aggressive && value.length > 1) {
      return `${indent}[\n${firstStr}\n${childIndent}// ... ${value.length - 1} more items (schema same as above)\n${indent}]`;
    }

    if (value.length <= 3 && !aggressive) {
      const items = value
        .map((v) => compressJsonValue(v, aggressive, depth + 1))
        .join(',\n');
      return `${indent}[\n${items}\n${indent}]`;
    }

    return `${indent}[\n${firstStr},\n${childIndent}// ... ${value.length - 1} more items\n${indent}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${indent}{}`;

    if (aggressive && depth > 1) {
      const keys = entries.map(([k]) => k).join(', ');
      return `${indent}{ ${keys} }`;
    }

    const maxEntries = aggressive ? 5 : 15;
    const shown = entries.slice(0, maxEntries);
    const lines = shown.map(([k, v]) => {
      const vStr =
        typeof v === 'object' && v !== null
          ? compressJsonValue(v, aggressive, depth + 1).trimStart()
          : JSON.stringify(v);
      return `${childIndent}"${k}": ${vStr}`;
    });

    if (entries.length > maxEntries) {
      lines.push(
        `${childIndent}// ... ${entries.length - maxEntries} more keys`,
      );
    }

    return `${indent}{\n${lines.join(',\n')}\n${indent}}`;
  }

  return `${indent}${String(value)}`;
}

// ── Markdown ────────────────────────────────────────────────

function compressMarkdown(text: string, aggressive: boolean): string {
  let result = text;

  // Strip images.
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // Strip external links but keep link text.
  result = result.replace(
    /\[([^\]]*)\]\(https?:\/\/[^)]*\)/g,
    aggressive ? '' : '$1',
  );

  // Strip HTML tags.
  result = result.replace(/<[^>]+>/g, '');

  // Strip horizontal rules.
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');

  if (aggressive) {
    // Flatten heading hierarchy to max 2 levels.
    result = result.replace(/^#{3,}\s+/gm, '## ');

    // Remove emphasis markers.
    result = result.replace(/\*{1,3}|_{1,3}/g, '');

    // Strip code fences — keep only the code.
    result = result.replace(/^```\w*\n?/gm, '');

    // Collapse list nesting.
    result = result.replace(/^(\s{4,})[-*+]/gm, '  -');
  }

  // Collapse multiple blank lines.
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

// ── Diff ────────────────────────────────────────────────────

function compressDiff(text: string, aggressive: boolean): string {
  const lines = text.split('\n');
  const output: string[] = [];
  const contextLines = aggressive ? 1 : 2;

  let contextBuffer: string[] = [];

  for (const line of lines) {
    // Always keep diff headers.
    if (
      line.startsWith('diff ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@')
    ) {
      // Flush context buffer – only keep last N lines.
      if (contextBuffer.length > contextLines) {
        output.push(`  ... ${contextBuffer.length - contextLines} unchanged lines`);
      }
      output.push(
        ...contextBuffer.slice(-contextLines),
      );
      contextBuffer = [];
      output.push(line);
      continue;
    }

    // Changed lines — always keep.
    if (line.startsWith('+') || line.startsWith('-')) {
      // Flush context before the change.
      if (contextBuffer.length > contextLines) {
        output.push(`  ... ${contextBuffer.length - contextLines} unchanged lines`);
      }
      output.push(...contextBuffer.slice(-contextLines));
      contextBuffer = [];
      output.push(line);
      continue;
    }

    // Context (unchanged) line — buffer it.
    contextBuffer.push(line);
  }

  // Flush remaining context.
  if (contextBuffer.length > contextLines) {
    output.push(`  ... ${contextBuffer.length - contextLines} unchanged lines`);
    output.push(...contextBuffer.slice(-contextLines));
  } else {
    output.push(...contextBuffer);
  }

  return output.join('\n');
}

// ── Config Files ────────────────────────────────────────────

function compressConfig(text: string, aggressive: boolean): string {
  const lines = text.split('\n');
  const output: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || isComment(trimmedLine)) {
      if (!aggressive) output.push(line);
      continue;
    }

    // Section headers — always keep.
    if (/^\[.*\]$/.test(trimmedLine) || /^[\w.]+:$/.test(trimmedLine)) {
      output.push(line);
      continue;
    }

    // Key-value lines.
    const kvMatch = trimmedLine.match(
      /^([\w][\w._-]*)\s*[:=]\s*(.*)/,
    );
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (aggressive) {
        // Show key and inferred type only.
        const type = inferValueType(value);
        output.push(`${indentOf(line)}${key}: <${type}>`);
      } else {
        // Keep keys and values, but truncate long values.
        const truncValue =
          value.length > 80
            ? `${value.slice(0, 80)}... (${value.length} chars)`
            : value;
        output.push(`${indentOf(line)}${key} = ${truncValue}`);
      }
      continue;
    }

    if (!aggressive) {
      output.push(line);
    }
  }

  if (aggressive) {
    return `[Config structure — ${output.length} entries]\n${output.join('\n')}`;
  }

  return output.join('\n');
}

// ── Plain Text (aggressive only) ────────────────────────────

function compressPlainTextAggressive(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length <= 10) {
    return lines.join('\n');
  }

  // Keep first 5 and last 5 lines.
  const head = lines.slice(0, 5);
  const tail = lines.slice(-5);
  const skipped = lines.length - 10;

  return [...head, `\n... ${skipped} lines omitted ...\n`, ...tail].join('\n');
}

// ================================================================
// Helpers
// ================================================================

function buildResult(
  compressed: string,
  originalTokens: number,
  contentType: ContentType,
  level: CompressionLevel,
): CompressionResult {
  const compressedTokens = estimateTokens(compressed);
  const ratio =
    originalTokens > 0
      ? Math.round((1 - compressedTokens / originalTokens) * 10000) / 10000
      : 0;

  return {
    compressed,
    originalTokens,
    compressedTokens,
    ratio,
    contentType,
    level,
  };
}

function isImportOrExport(line: string): boolean {
  return /^(import|export|from|require)\b/.test(line);
}

function isDocComment(line: string): boolean {
  return (
    line.startsWith('/**') ||
    line.startsWith(' *') ||
    line.startsWith('///') ||
    line.startsWith('#:') ||
    line.startsWith('"""') ||
    line.startsWith("'''")
  );
}

function isComment(line: string): boolean {
  return (
    line.startsWith('//') ||
    // Intentional: # is used as a comment marker in many languages (Python, Ruby, Bash, etc.)
    line.startsWith('#') ||
    line.startsWith('/*') ||
    line.startsWith('*') ||
    line.startsWith('*/') ||
    line.startsWith('"""') ||
    line.startsWith("'''")
  );
}

function isTypeDeclaration(line: string): boolean {
  return /^(export\s+)?(type|interface|enum)\s+\w/.test(line);
}

function isSignatureLine(line: string): boolean {
  return (
    /^(export\s+)?(async\s+)?(function|class)\s/.test(line) ||
    /^(public|private|protected|static|abstract|async)\s/.test(line) ||
    /^(def|fn|func|pub\s+fn|pub\s+func)\s/.test(line) ||
    /^\w[\w<>,\s]*\(.*\)\s*(:\s*\w)?\s*\{?\s*$/.test(line) ||
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(line) ||
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?function/.test(line)
  );
}

/** Strip string literals and comments from a line to avoid counting braces inside them. */
function stripStringsAndComments(line: string): string {
  let result = line.replace(/(['"`])(?:(?!\1|\\).|\\.)*.\1/g, '');
  result = result.replace(/\/\/.*$/, '');
  result = result.replace(/\/\*.*?\*\//g, '');
  return result;
}

function countChar(str: string, char: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) count++;
  }
  return count;
}

function indentOf(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

function inferValueType(value: string): string {
  if (value === 'true' || value === 'false') return 'boolean';
  if (/^-?\d+$/.test(value)) return 'integer';
  if (/^-?\d+\.\d+$/.test(value)) return 'float';
  if (/^\[/.test(value)) return 'array';
  if (/^\{/.test(value)) return 'object';
  if (/^["']/.test(value)) return 'string';
  if (value === '' || value === 'null' || value === 'nil') return 'null';
  return 'string';
}

function deduplicateLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  let duplicateCount = 0;

  for (const line of lines) {
    const key = line.trim();
    if (seen.has(key) && key.length > 0) {
      duplicateCount++;
      continue;
    }
    if (duplicateCount > 0) {
      output.push(`    ... ${duplicateCount} duplicate lines`);
      duplicateCount = 0;
    }
    seen.add(key);
    output.push(line);
  }

  if (duplicateCount > 0) {
    output.push(`    ... ${duplicateCount} duplicate lines`);
  }

  return output;
}
