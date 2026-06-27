/**
 * AI Mind Map — Quality MCP Tools
 *
 * Registers code-quality analysis tools on the MCP server:
 *   1. mindmap_code_metrics   – cyclomatic/cognitive complexity & health scoring
 *   2. mindmap_security_scan  – pattern-based SAST-lite vulnerability detection
 *   3. mindmap_code_duplication – duplicated code block detection
 *
 * Each tool returns structured JSON wrapped in the standard MCP
 * text-content envelope.
 */

import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig, GraphNode } from '../types.js';

import { KnowledgeGraph } from '../knowledge-graph/graph.js';

// ============================================================
// Token Estimation Interface
// ============================================================

/**
 * Minimal interface for estimating token counts.
 * Used to populate ToolResult.tokenCount / tokensSaved.
 */
export interface ITokenEstimator {
  /** Rough token count for a string (4 chars ≈ 1 token). */
  estimate(text: string): number;
}

/** Simple 4-chars-per-token estimator used as default. */
const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

// ============================================================
// Helpers
// ============================================================

/**
 * Wrap a ToolResult in the MCP text-content format.
 */
function mcpText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

/**
 * Build a successful ToolResult.
 */
function ok(data: unknown, estimator: ITokenEstimator): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved: 0 };
}

/**
 * Build an error ToolResult.
 */
function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

/**
 * Check if a file appears to be binary by inspecting its first 512 bytes
 * for null bytes.
 */
function isBinaryFile(absPath: string): boolean {
  try {
    const fd = require('node:fs').openSync(absPath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = require('node:fs').readSync(fd, buf, 0, 512, 0);
    require('node:fs').closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Simple fast hash function for strings.
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Clamp a number to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================
// Complexity Analysis Helpers
// ============================================================

interface FunctionMetrics {
  name: string;
  line: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  loc: number;
  params: number;
  maxNesting: number;
  healthScore: number;
  risk: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Count decision-point patterns in a block of source code lines.
 */
function analyzeComplexity(bodyLines: string[]): {
  cyclomatic: number;
  cognitive: number;
  maxNesting: number;
} {
  let cyclomatic = 1; // base complexity
  let cognitive = 0;
  let currentNesting = 0;
  let maxNesting = 0;

  for (const rawLine of bodyLines) {
    const line = rawLine.trim();

    // Skip empty lines and single-line comments
    if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('*')) {
      continue;
    }

    // Track nesting via braces
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Close braces first to handle `} else {` correctly
    currentNesting -= closeBraces;
    if (currentNesting < 0) currentNesting = 0;

    const nestLevel = Math.max(1, currentNesting + 1);

    // Cyclomatic & cognitive complexity patterns
    // if / else if / elif
    if (/\b(if|else\s+if|elif)\b/.test(line)) {
      cyclomatic += 1;
      cognitive += nestLevel;
    }
    // for / foreach / while / do
    if (/\b(for|foreach|while|do)\b/.test(line) && !/\bdo\s*\{?\s*$/.test(line) === false) {
      // Match loop keywords
    }
    if (/\b(for|foreach|while)\b/.test(line)) {
      cyclomatic += 1;
      cognitive += nestLevel;
    }
    if (/\bdo\b/.test(line) && !/\bdo\s*\(/.test(line)) {
      // 'do' keyword for do-while (but not Ruby do blocks with parens)
      cyclomatic += 1;
      cognitive += nestLevel;
    }
    // switch case
    if (/\bcase\b/.test(line) && !/\blowerCase\b|\bupperCase\b|\bcamelCase\b/.test(line)) {
      cyclomatic += 1;
    }
    // catch / except
    if (/\b(catch|except)\b/.test(line)) {
      cyclomatic += 1;
      cognitive += 1;
    }
    // Logical operators
    const andOr = line.match(/&&|\|\||\band\b|\bor\b/g);
    if (andOr) {
      cyclomatic += andOr.length;
    }
    // Ternary operator
    const ternary = line.match(/\?(?!=)/g);
    if (ternary) {
      // Filter out ?. (optional chaining) and ?? (nullish coalescing)
      for (const _match of ternary) {
        const idx = line.indexOf('?');
        if (idx >= 0) {
          const nextChar = line[idx + 1];
          if (nextChar !== '.' && nextChar !== '?') {
            cyclomatic += 1;
            cognitive += 1;
          }
        }
      }
    }

    // Update nesting after processing the line
    currentNesting += openBraces;
    if (currentNesting > maxNesting) {
      maxNesting = currentNesting;
    }
  }

  return { cyclomatic, cognitive, maxNesting };
}

/**
 * Extract parameter count from a function signature.
 */
function countParams(signature: string): number {
  // Find content inside first pair of parentheses
  const match = signature.match(/\(([^)]*)\)/);
  if (!match || !match[1].trim()) return 0;
  // Count commas + 1
  return match[1].split(',').filter(p => p.trim().length > 0).length;
}

/**
 * Calculate health score from metrics.
 */
function calculateHealthScore(
  cyclomatic: number,
  cognitive: number,
  loc: number,
  params: number,
  nesting: number,
): number {
  let score = 10;
  if (cyclomatic > 10) score -= 2;
  if (cyclomatic > 20) score -= 2;
  if (cognitive > 15) score -= 2;
  if (cognitive > 30) score -= 2;
  if (loc > 100) score -= 1;
  if (loc > 200) score -= 1;
  if (params > 5) score -= 1;
  if (nesting > 4) score -= 1;
  return clamp(score, 1, 10);
}

/**
 * Determine risk level from health score.
 */
function riskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 8) return 'low';
  if (score >= 5) return 'medium';
  if (score >= 3) return 'high';
  return 'critical';
}

/**
 * Analyze a set of graph nodes for complexity metrics.
 * Reads source files and calculates per-function metrics.
 */
function analyzeFunctions(
  nodes: GraphNode[],
  config: MindMapConfig,
): FunctionMetrics[] {
  const functionTypes = new Set([
    'function', 'method', 'constructor', 'hook',
  ]);

  const functionNodes = nodes.filter(n => functionTypes.has(n.type));
  const metrics: FunctionMetrics[] = [];

  // Group by file to avoid re-reading the same file
  const byFile = new Map<string, GraphNode[]>();
  for (const node of functionNodes) {
    const list = byFile.get(node.filePath) || [];
    list.push(node);
    byFile.set(node.filePath, list);
  }

  for (const [filePath, fnNodes] of byFile) {
    const absPath = resolve(config.projectRoot, filePath);
    let fileLines: string[];
    try {
      const content = readFileSync(absPath, 'utf-8');
      fileLines = content.split('\n');
    } catch {
      continue; // Skip unreadable files
    }

    for (const node of fnNodes) {
      const startIdx = Math.max(0, node.startLine - 1);
      const endIdx = Math.min(fileLines.length, node.endLine);
      const bodyLines = fileLines.slice(startIdx, endIdx);
      const loc = node.endLine - node.startLine;

      const { cyclomatic, cognitive, maxNesting } = analyzeComplexity(bodyLines);
      const params = node.parameters
        ? node.parameters.length
        : countParams(node.signature);

      const health = calculateHealthScore(cyclomatic, cognitive, loc, params, maxNesting);

      metrics.push({
        name: node.qualifiedName || node.name,
        line: node.startLine,
        cyclomaticComplexity: cyclomatic,
        cognitiveComplexity: cognitive,
        loc,
        params,
        maxNesting,
        healthScore: health,
        risk: riskLevel(health),
      });
    }
  }

  return metrics;
}

// ============================================================
// Security Scan Helpers
// ============================================================

interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  rule: string;
  file: string;
  line: number;
  code: string;
  remediation: string;
}

interface VulnPattern {
  severity: 'critical' | 'high' | 'medium' | 'low';
  rule: string;
  pattern: RegExp;
  remediation: string;
}

const VULN_PATTERNS: VulnPattern[] = [
  // Critical
  {
    severity: 'critical',
    rule: 'hardcoded_password',
    pattern: /password\s*=\s*['"][^'"]+['"]/i,
    remediation: 'Use environment variables or a secrets manager',
  },
  {
    severity: 'critical',
    rule: 'hardcoded_api_key',
    pattern: /(api_key|apikey|api_secret|secret_key)\s*=\s*['"][^'"]+['"]/i,
    remediation: 'Use environment variables or a secrets manager',
  },
  {
    severity: 'critical',
    rule: 'private_key',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    remediation: 'Remove private keys from source code. Use a key vault or secrets manager',
  },
  {
    severity: 'critical',
    rule: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/,
    remediation: 'Remove AWS access keys. Use IAM roles or environment variables',
  },

  // High
  {
    severity: 'high',
    rule: 'sql_injection',
    pattern: /(query|execute|exec)\s*\([^)]*(\+|\$\{)/,
    remediation: 'Use parameterized queries or prepared statements',
  },
  {
    severity: 'high',
    rule: 'sql_injection_fstring',
    pattern: /f['"].*SELECT/i,
    remediation: 'Use parameterized queries instead of f-strings for SQL',
  },
  {
    severity: 'high',
    rule: 'sql_injection_format',
    pattern: /string\.Format.*SELECT/i,
    remediation: 'Use parameterized queries instead of string.Format for SQL',
  },
  {
    severity: 'high',
    rule: 'command_injection',
    pattern: /(exec|system|popen|subprocess\.call|Runtime\.exec)\s*\(/,
    remediation: 'Validate and sanitize all inputs. Use allowlists for permitted commands',
  },
  {
    severity: 'high',
    rule: 'xss',
    pattern: /innerHTML\s*=|document\.write\s*\(|dangerouslySetInnerHTML/,
    remediation: 'Use textContent or a sanitization library like DOMPurify',
  },
  {
    severity: 'high',
    rule: 'eval_usage',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    remediation: 'Avoid eval/Function constructor. Use safer alternatives like JSON.parse',
  },

  // Medium
  {
    severity: 'medium',
    rule: 'weak_crypto',
    pattern: /\b(MD5|SHA1|DES|RC4)\b/,
    remediation: 'Use stronger algorithms: SHA-256+, AES-256, bcrypt/scrypt for passwords',
  },
  {
    severity: 'medium',
    rule: 'http_not_https',
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    remediation: 'Use HTTPS for all external communication',
  },
  {
    severity: 'medium',
    rule: 'hardcoded_ip',
    pattern: /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    remediation: 'Use configuration or environment variables for IP addresses',
  },

  // Low
  {
    severity: 'low',
    rule: 'security_todo',
    pattern: /(TODO|FIXME|HACK|XXX).*(security|vuln|auth|password|encrypt)/i,
    remediation: 'Address security-related TODOs before deployment',
  },
  {
    severity: 'low',
    rule: 'sensitive_log',
    pattern: /console\.log.*(password|token|secret|key|credential)/i,
    remediation: 'Remove sensitive data from log statements',
  },
  {
    severity: 'low',
    rule: 'disabled_ssl',
    pattern: /verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED/,
    remediation: 'Enable SSL/TLS verification in production',
  },
];

/**
 * Check if a line is a comment.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('<!--')
  );
}

// ============================================================
// Registration
// ============================================================

/**
 * Register all Quality tools on the given MCP server.
 *
 * @param server         The MCP server instance.
 * @param graph          Direct reference to the KnowledgeGraph.
 * @param config         The MindMapConfig for project settings.
 * @param tokenEstimator Optional token estimator (defaults to 4-char heuristic).
 */
export function registerQualityTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  tokenEstimator: ITokenEstimator = defaultEstimator,
): void {
  // ── mindmap_code_metrics ──────────────────────────────────────
  server.tool(
    'mindmap_code_metrics',
    'Calculate code complexity and health scoring for files/functions. ' +
      'Returns cyclomatic complexity, cognitive complexity, LOC, parameter count, ' +
      'nesting depth, health score (1-10), and risk level for each function.',
    {
      filePath: z
        .string()
        .optional()
        .describe('Analyze a specific file (relative to projectRoot)'),
      symbol: z
        .string()
        .optional()
        .describe('Analyze a specific function/method by name'),
      top: z
        .number()
        .optional()
        .default(20)
        .describe('Show top N most complex functions (default: 20)'),
    },
    async ({ filePath, symbol, top }) => {
      try {
        let targetNodes: GraphNode[];
        let targetFile: string | undefined = filePath;

        if (symbol) {
          // Find symbol via graph search
          const results = graph.search(symbol, 10);
          const functionTypes = new Set([
            'function', 'method', 'constructor', 'hook',
          ]);
          targetNodes = results.filter(n => functionTypes.has(n.type));
          if (targetNodes.length === 0) {
            return mcpText(fail(`Symbol "${symbol}" not found in the knowledge graph`));
          }
          if (!targetFile) {
            targetFile = targetNodes[0].filePath;
          }
        } else if (filePath) {
          // Get all nodes for the file
          targetNodes = graph.getFileStructure(filePath);
          if (targetNodes.length === 0) {
            // Try with resolved path relative to project root
            const allFiles = graph.getIndexedFiles();
            const match = allFiles.find(f =>
              f === filePath || f.endsWith(filePath) || filePath.endsWith(f),
            );
            if (match) {
              targetNodes = graph.getFileStructure(match);
              targetFile = match;
            } else {
              return mcpText(fail(`File "${filePath}" not found in the index`));
            }
          }
        } else {
          // Analyze all indexed files
          targetNodes = graph.getAllNodes();
        }

        const metrics = analyzeFunctions(targetNodes, config);

        // Sort by health score ascending (worst first), then by cyclomatic descending
        metrics.sort((a, b) => a.healthScore - b.healthScore || b.cyclomaticComplexity - a.cyclomaticComplexity);

        const topN = metrics.slice(0, top);

        const totalFunctions = metrics.length;
        const avgComplexity = totalFunctions > 0
          ? Math.round((metrics.reduce((s, m) => s + m.cyclomaticComplexity, 0) / totalFunctions) * 10) / 10
          : 0;
        const avgHealth = totalFunctions > 0
          ? Math.round((metrics.reduce((s, m) => s + m.healthScore, 0) / totalFunctions) * 10) / 10
          : 0;
        const criticalCount = metrics.filter(m => m.risk === 'critical').length;
        const highRiskCount = metrics.filter(m => m.risk === 'high').length;

        const fileHealthScore = totalFunctions > 0
          ? Math.round(avgHealth * 10) / 10
          : 10;

        const result = {
          file: targetFile || '(all files)',
          fileHealthScore,
          totalFunctions,
          functions: topN,
          summary: {
            avgComplexity,
            avgHealth,
            criticalCount,
            highRiskCount,
          },
        };

        return mcpText(ok(result, tokenEstimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Code metrics analysis failed: ${msg}`));
      }
    },
  );

  // ── mindmap_security_scan ─────────────────────────────────────
  server.tool(
    'mindmap_security_scan',
    'Pattern-based vulnerability detection (SAST lite). ' +
      'Scans files for hardcoded secrets, injection vulnerabilities, weak crypto, ' +
      'and other security issues. Returns findings with severity, location, and remediation.',
    {
      filePath: z
        .string()
        .optional()
        .describe('Scan a specific file (relative to projectRoot)'),
      severity: z
        .string()
        .optional()
        .default('all')
        .describe("Filter by severity: 'critical', 'high', 'medium', 'low', or 'all' (default: 'all')"),
    },
    async ({ filePath, severity }) => {
      try {
        const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
        let filesToScan: string[];

        if (filePath) {
          // Try to resolve to an indexed file
          const allFiles = graph.getIndexedFiles();
          const match = allFiles.find(f =>
            f === filePath || f.endsWith(filePath) || filePath.endsWith(f),
          );
          filesToScan = match ? [match] : [filePath];
        } else {
          filesToScan = graph.getIndexedFiles();
        }

        // Filter patterns by severity if requested
        const patterns = severity === 'all'
          ? VULN_PATTERNS
          : VULN_PATTERNS.filter(p => p.severity === severity);

        if (patterns.length === 0) {
          return mcpText(fail(`Invalid severity filter: "${severity}". Use 'critical', 'high', 'medium', 'low', or 'all'`));
        }

        const findings: SecurityFinding[] = [];
        let filesScanned = 0;
        const summaryCounts = { critical: 0, high: 0, medium: 0, low: 0 };

        for (const file of filesToScan) {
          const absPath = resolve(config.projectRoot, file);

          // Skip large files
          try {
            const stat = statSync(absPath);
            if (stat.size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }

          // Skip binary files
          if (isBinaryFile(absPath)) continue;

          let content: string;
          try {
            content = readFileSync(absPath, 'utf-8');
          } catch {
            continue;
          }

          filesScanned++;
          const lines = content.split('\n');
          let inBlockComment = false;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Track block comments
            if (trimmedLine.includes('/*')) inBlockComment = true;
            if (trimmedLine.includes('*/')) {
              inBlockComment = false;
              continue;
            }
            if (inBlockComment) continue;

            // Skip single-line comments
            if (isCommentLine(line)) continue;

            // Test each pattern
            for (const vuln of patterns) {
              if (vuln.pattern.test(line)) {
                findings.push({
                  severity: vuln.severity,
                  rule: vuln.rule,
                  file,
                  line: i + 1,
                  code: trimmedLine.substring(0, 120), // Limit code context length
                  remediation: vuln.remediation,
                });
                summaryCounts[vuln.severity]++;
              }
            }
          }
        }

        // Sort by severity priority
        const severityOrder: Record<string, number> = {
          critical: 0,
          high: 1,
          medium: 2,
          low: 3,
        };
        findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

        const result = {
          totalFiles: filesToScan.length,
          filesScanned,
          totalFindings: findings.length,
          findings,
          summary: summaryCounts,
        };

        return mcpText(ok(result, tokenEstimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Security scan failed: ${msg}`));
      }
    },
  );

  // ── mindmap_code_duplication ───────────────────────────────────
  server.tool(
    'mindmap_code_duplication',
    'Detect duplicated code blocks across the codebase. ' +
      'Uses sliding-window hashing to find exact code clones (Type 1). ' +
      'Returns clone groups sorted by size with file locations.',
    {
      minLines: z
        .number()
        .optional()
        .default(6)
        .describe('Minimum consecutive lines to consider a clone (default: 6)'),
      filePath: z
        .string()
        .optional()
        .describe('Check a specific file for clones (relative to projectRoot)'),
      threshold: z
        .number()
        .optional()
        .default(0.8)
        .describe('Similarity threshold 0-1 (default: 0.8). Currently only exact matches (1.0) are detected'),
    },
    async ({ minLines, filePath, threshold: _threshold }) => {
      try {
        const MAX_FILE_SIZE = 500 * 1024; // 500KB
        const MAX_FILES = 200;

        let filesToScan: string[];
        if (filePath) {
          const allFiles = graph.getIndexedFiles();
          const match = allFiles.find(f =>
            f === filePath || f.endsWith(filePath) || filePath.endsWith(f),
          );
          filesToScan = match ? [match] : [filePath];
        } else {
          filesToScan = graph.getIndexedFiles().slice(0, MAX_FILES);
        }

        // Map from hash -> list of { file, startLine }
        const hashMap = new Map<number, { file: string; startLine: number; endLine: number; normalized: string }[]>();
        let totalLinesScanned = 0;

        for (const file of filesToScan) {
          const absPath = resolve(config.projectRoot, file);

          // Skip large files
          try {
            const stat = statSync(absPath);
            if (stat.size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }

          // Skip binary files
          if (isBinaryFile(absPath)) continue;

          let content: string;
          try {
            content = readFileSync(absPath, 'utf-8');
          } catch {
            continue;
          }

          const rawLines = content.split('\n');

          // Normalize lines: trim, remove blank lines, remove single-line comments
          const normalized: { text: string; originalLine: number }[] = [];
          for (let i = 0; i < rawLines.length; i++) {
            const trimmed = rawLines[i].trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
            if (trimmed === '{' || trimmed === '}') continue; // Skip lone braces
            normalized.push({ text: trimmed.toLowerCase(), originalLine: i + 1 });
          }

          totalLinesScanned += normalized.length;

          // Sliding window
          for (let i = 0; i <= normalized.length - minLines; i++) {
            const windowText = normalized
              .slice(i, i + minLines)
              .map(l => l.text)
              .join('\n');
            const hash = simpleHash(windowText);

            const entry = {
              file,
              startLine: normalized[i].originalLine,
              endLine: normalized[i + minLines - 1].originalLine,
              normalized: windowText,
            };

            const existing = hashMap.get(hash);
            if (existing) {
              existing.push(entry);
            } else {
              hashMap.set(hash, [entry]);
            }
          }
        }

        // Collect clone groups (hashes with 2+ entries)
        interface CloneGroup {
          lines: number;
          similarity: number;
          locations: { file: string; startLine: number; endLine: number }[];
        }

        const rawCloneGroups: CloneGroup[] = [];

        for (const [_hash, entries] of hashMap) {
          if (entries.length < 2) continue;

          // Deduplicate overlapping windows within the same file
          const uniqueLocations: typeof entries = [];
          for (const entry of entries) {
            const overlapping = uniqueLocations.find(
              u => u.file === entry.file && Math.abs(u.startLine - entry.startLine) < minLines,
            );
            if (!overlapping) {
              uniqueLocations.push(entry);
            }
          }

          if (uniqueLocations.length < 2) continue;

          // Verify actual string equality (not just hash collision)
          const firstNorm = uniqueLocations[0].normalized;
          const matched = uniqueLocations.filter(e => e.normalized === firstNorm);
          if (matched.length < 2) continue;

          rawCloneGroups.push({
            lines: minLines,
            similarity: 1.0,
            locations: matched.map(e => ({
              file: e.file,
              startLine: e.startLine,
              endLine: e.endLine,
            })),
          });
        }

        // Try to merge adjacent clone groups into larger clones
        // Sort by file+startLine for merge detection
        rawCloneGroups.sort((a, b) => {
          const aFirst = a.locations[0];
          const bFirst = b.locations[0];
          return aFirst.file.localeCompare(bFirst.file) || aFirst.startLine - bFirst.startLine;
        });

        // Deduplicate: remove groups where all locations are subsets of a larger group
        const seen = new Set<string>();
        const deduped: CloneGroup[] = [];
        for (const group of rawCloneGroups) {
          const key = group.locations
            .map(l => `${l.file}:${l.startLine}`)
            .sort()
            .join('|');
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(group);
          }
        }

        // Sort by lines descending (largest clones first), take top 20
        deduped.sort((a, b) => b.lines - a.lines || b.locations.length - a.locations.length);
        const topClones = deduped.slice(0, 20);

        // Calculate total duplicated lines
        const totalDuplicatedLines = topClones.reduce(
          (sum, g) => sum + g.lines * (g.locations.length - 1),
          0,
        );
        const duplicationPercentage = totalLinesScanned > 0
          ? Math.round((totalDuplicatedLines / totalLinesScanned) * 1000) / 10
          : 0;

        const result = {
          totalFilesScanned: filesToScan.length,
          totalCloneGroups: deduped.length,
          totalDuplicatedLines,
          duplicationPercentage,
          clones: topClones,
        };

        return mcpText(ok(result, tokenEstimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Code duplication detection failed: ${msg}`));
      }
    },
  );
}
