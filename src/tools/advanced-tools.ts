/**
 * AI Mind Map — Advanced MCP Tools
 *
 * Registers advanced analysis and utility tools on the MCP server.
 * These tools provide Cypher-like graph queries, dead code detection,
 * architecture analysis, code snippet retrieval, text search, project
 * listing, and health diagnostics.
 *
 * Each tool returns structured JSON wrapped in the standard MCP
 * text-content envelope.
 */

import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig, GraphNode } from '../types.js';

import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import { CypherEngine } from '../knowledge-graph/cypher.js';
import { DeadCodeDetector } from '../knowledge-graph/dead-code.js';
import { ArchitectureAnalyzer } from '../knowledge-graph/architecture.js';

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
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
 * Build a successful ToolResult with estimated tokens saved vs naïve approach.
 */
function okWithSavings(
  data: unknown,
  tokensSaved: number,
  estimator: ITokenEstimator,
): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved };
}

/**
 * Build an error ToolResult.
 */
function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

/**
 * Read specific lines from a file, returning the text.
 * Lines are 1-indexed, inclusive on both ends.
 */
function readLines(
  filePath: string,
  startLine: number,
  endLine: number,
): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  // Clamp to valid range
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end);
}

/**
 * Check if a file path matches a glob-like pattern (simple implementation).
 * Supports `*` for any characters and `**` for directory traversal.
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')      // Placeholder for **
    .replace(/\*/g, '[^/\\\\]*')  // * matches anything except separators
    .replace(/§§/g, '.*')         // ** matches everything
    .replace(/\?/g, '.');         // ? matches single char
  const regex = new RegExp(`(^|[\\\\/])${escaped}$`, 'i');
  return regex.test(filePath);
}

// ============================================================
// Registration
// ============================================================

/**
 * Register all Advanced tools on the given MCP server.
 *
 * @param server     The MCP server instance.
 * @param graph      Direct reference to the KnowledgeGraph.
 * @param config     The MindMapConfig for project settings.
 * @param estimator  Optional token estimator (defaults to 4-char heuristic).
 */
export function registerAdvancedTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  // ── mindmap_query_graph ─────────────────────────────────────
  server.tool(
    'mindmap_query_graph',
    'Execute a Cypher-like query against the knowledge graph. ' +
      'Supports MATCH, WHERE, RETURN clauses for nodes and relationships. ' +
      'Example: MATCH (f:function) WHERE f.name = "handleRequest" RETURN f',
    {
      query: z
        .string()
        .describe('Cypher-like query string'),
      project: z
        .string()
        .optional()
        .describe('Optional project path filter to scope the query'),
    },
    async ({ query, project }) => {
      try {
        const engine = new CypherEngine(graph);
        const results = engine.execute(query, project);
        return mcpText(ok(results, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(
          fail(`Query failed: ${msg}. Supported syntax: MATCH (n:type) WHERE n.prop = value RETURN n`),
        );
      }
    },
  );

  // ── mindmap_dead_code ───────────────────────────────────────
  server.tool(
    'mindmap_dead_code',
    'Detect potentially dead (uncalled) functions and methods in the codebase. ' +
      'Returns a list of symbols with no incoming call edges, ranked by confidence.',
    {
      filePath: z
        .string()
        .optional()
        .describe('Optional file path to scope detection to a single file'),
      includeExported: z
        .boolean()
        .default(false)
        .describe(
          'Include exported symbols (they may be used externally). Default: false',
        ),
    },
    async ({ filePath, includeExported }) => {
      try {
        const detector = new DeadCodeDetector(graph);
        const results = detector.detect({ filePath, includeExported });
        return mcpText(ok(results, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Dead code detection failed: ${msg}`));
      }
    },
  );

  // ── mindmap_architecture ────────────────────────────────────
  server.tool(
    'mindmap_architecture',
    'Get a comprehensive architecture overview of the project. ' +
      'Returns detected languages, entry points, layers, routes, ' +
      'complexity hotspots, and dependency clusters.',
    {
      projectPath: z
        .string()
        .optional()
        .describe('Optional project root path (defaults to configured project root)'),
    },
    async ({ projectPath }) => {
      try {
        const analyzer = new ArchitectureAnalyzer(graph);
        const rootPath = projectPath ?? config.projectRoot;
        const report = analyzer.analyze(rootPath);
        return mcpText(ok(report, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Architecture analysis failed: ${msg}`));
      }
    },
  );

  // ── mindmap_get_code_snippet ────────────────────────────────
  server.tool(
    'mindmap_get_code_snippet',
    'Read the actual source code for a specific function, class, or method by name. ' +
      'Looks up the symbol in the knowledge graph to find its file and line range, ' +
      'then reads exactly those lines (plus 3 lines of context above and below). ' +
      'This is much cheaper than reading an entire file.',
    {
      symbolName: z
        .string()
        .describe('Name or qualified name of the symbol (e.g., "handleRequest" or "MyClass.myMethod")'),
      filePath: z
        .string()
        .optional()
        .describe('Optional file path to disambiguate when multiple symbols share the same name'),
    },
    async ({ symbolName, filePath }) => {
      try {
        // Look up matching nodes in the graph
        const candidates = graph.getNodesByName(symbolName);

        // Also search by qualified name if simple name yields nothing
        let matches: GraphNode[] = candidates;
        if (matches.length === 0) {
          const searchResults = graph.search(symbolName, 5);
          matches = searchResults.filter(
            (n) =>
              n.name === symbolName ||
              n.qualifiedName === symbolName ||
              n.qualifiedName.endsWith(`.${symbolName}`),
          );
        }

        // Filter by file path if provided
        if (filePath && matches.length > 1) {
          const filtered = matches.filter(
            (n) => n.filePath === filePath || n.filePath.endsWith(filePath),
          );
          if (filtered.length > 0) {
            matches = filtered;
          }
        }

        if (matches.length === 0) {
          return mcpText(fail(`Symbol not found: "${symbolName}"`));
        }

        // Use the first (best) match
        const node = matches[0];
        const contextLines = 3;
        const startLine = Math.max(1, node.startLine - contextLines);
        const endLine = node.endLine + contextLines;

        // Resolve the file path
        const absolutePath = resolve(config.projectRoot, node.filePath);
        let sourceLines: string[];
        try {
          sourceLines = readLines(absolutePath, startLine, endLine);
        } catch {
          return mcpText(
            fail(`Could not read source file: ${node.filePath} (resolved to ${absolutePath})`),
          );
        }

        const snippet = sourceLines
          .map((line, i) => `${startLine + i}: ${line}`)
          .join('\n');

        // Estimate tokens saved vs reading entire file
        let totalFileTokens = 0;
        try {
          const fullContent = readFileSync(absolutePath, 'utf-8');
          totalFileTokens = estimator.estimate(fullContent);
        } catch {
          // Ignore — just can't calculate savings
        }
        const snippetTokens = estimator.estimate(snippet);
        const saved = Math.max(0, totalFileTokens - snippetTokens);

        const result = {
          symbol: {
            name: node.name,
            qualifiedName: node.qualifiedName,
            type: node.type,
            filePath: node.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            docComment: node.docComment,
          },
          code: snippet,
          lineRange: { start: startLine, end: startLine + sourceLines.length - 1 },
          otherMatches:
            matches.length > 1
              ? matches.slice(1).map((m) => ({
                  name: m.qualifiedName,
                  filePath: m.filePath,
                  startLine: m.startLine,
                }))
              : undefined,
        };

        return mcpText(okWithSavings(result, saved, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Get code snippet failed: ${msg}`));
      }
    },
  );

  // ── mindmap_search_code ─────────────────────────────────────
  server.tool(
    'mindmap_search_code',
    'Grep-like text search within indexed project files only (respects .gitignore and index scope). ' +
      'Returns matches with file path, line number, line content, and surrounding context lines.',
    {
      pattern: z
        .string()
        .describe('Text pattern to search for (literal string, not regex)'),
      filePattern: z
        .string()
        .optional()
        .describe('Optional glob pattern to filter files (e.g., "*.ts", "src/**/*.py")'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe('Maximum number of matches to return (default 20)'),
    },
    async ({ pattern, filePattern, maxResults }) => {
      try {
        const indexedFiles = graph.getIndexedFiles();
        if (indexedFiles.length === 0) {
          return mcpText(ok({ matches: [], totalFiles: 0, message: 'No files indexed yet' }, estimator));
        }

        // Filter by file glob pattern if provided
        let filesToSearch = indexedFiles;
        if (filePattern) {
          filesToSearch = indexedFiles.filter((f) => matchesGlob(f, filePattern));
          if (filesToSearch.length === 0) {
            return mcpText(
              ok(
                {
                  matches: [],
                  totalFiles: 0,
                  message: `No indexed files match pattern: ${filePattern}`,
                },
                estimator,
              ),
            );
          }
        }

        const matches: {
          filePath: string;
          line: number;
          content: string;
          context: { before: string[]; after: string[] };
        }[] = [];

        const lowerPattern = pattern.toLowerCase();
        let totalFilesSearched = 0;

        for (const file of filesToSearch) {
          if (matches.length >= maxResults) break;

          const absolutePath = resolve(config.projectRoot, file);
          let content: string;
          try {
            content = readFileSync(absolutePath, 'utf-8');
          } catch {
            continue; // File may have been deleted since indexing
          }

          totalFilesSearched++;
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;

            if (lines[i].toLowerCase().includes(lowerPattern)) {
              const contextBefore = lines.slice(Math.max(0, i - 2), i);
              const contextAfter = lines.slice(i + 1, Math.min(lines.length, i + 3));

              matches.push({
                filePath: file,
                line: i + 1,
                content: lines[i],
                context: {
                  before: contextBefore,
                  after: contextAfter,
                },
              });
            }
          }
        }

        const result = {
          pattern,
          filePattern: filePattern ?? null,
          matches,
          totalMatches: matches.length,
          totalFilesSearched,
          truncated: matches.length >= maxResults,
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Code search failed: ${msg}`));
      }
    },
  );

  // ── mindmap_list_projects ───────────────────────────────────
  server.tool(
    'mindmap_list_projects',
    'List all indexed projects with statistics: node counts, edge counts, ' +
      'language breakdown, and last indexed time.',
    {},
    async () => {
      try {
        const stats = graph.getStats();
        const indexedFiles = graph.getIndexedFiles();

        // Group files by top-level directory (project detection heuristic)
        const projectMap = new Map<string, {
          files: string[];
          nodeCount: number;
          languages: Set<string>;
        }>();

        for (const filePath of indexedFiles) {
          // The first path component is the project directory
          const parts = filePath.replace(/\\/g, '/').split('/');
          const projectKey = parts.length > 1 ? parts[0] : basename(config.projectRoot);

          if (!projectMap.has(projectKey)) {
            projectMap.set(projectKey, {
              files: [],
              nodeCount: 0,
              languages: new Set(),
            });
          }
          projectMap.get(projectKey)!.files.push(filePath);
        }

        // Enrich with per-project stats
        const projects = Array.from(projectMap.entries()).map(
          ([name, info]) => ({
            name,
            path: resolve(config.projectRoot, name),
            fileCount: info.files.length,
            languages: Array.from(info.languages),
          }),
        );

        const result = {
          configuredRoot: config.projectRoot,
          totalFiles: stats.totalFiles,
          totalNodes: stats.totalNodes,
          totalEdges: stats.totalEdges,
          languageBreakdown: stats.languageBreakdown,
          nodesByType: stats.nodesByType,
          edgesByType: stats.edgesByType,
          projects,
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`List projects failed: ${msg}`));
      }
    },
  );

  // ── mindmap_health ──────────────────────────────────────────
  server.tool(
    'mindmap_health',
    'Health check and diagnostics for the AI Mind Map system. ' +
      'Returns database size, index freshness, memory count, system info, ' +
      'and detected agent configurations.',
    {},
    async () => {
      try {
        const stats = graph.getStats();
        const indexedFiles = graph.getIndexedFiles();

        // Database file size
        let dbSizeBytes = 0;
        try {
          const dbPath = resolve(config.projectRoot, config.dbPath);
          const stat = statSync(dbPath);
          dbSizeBytes = stat.size;
        } catch {
          // Database might be in-memory or path may differ
        }

        // Detect agent configurations
        const detectedAgents: string[] = [];
        const agentConfigFiles = [
          '.cursorrules',
          '.cursor/rules',
          'CLAUDE.md',
          '.github/copilot-instructions.md',
          '.windsurfrules',
          'rules.md',
          '.clinerules',
          '.aider.conf.yml',
          '.continue/config.json',
        ];

        for (const agentFile of agentConfigFiles) {
          try {
            const agentPath = resolve(config.projectRoot, agentFile);
            statSync(agentPath);
            detectedAgents.push(agentFile);
          } catch {
            // File does not exist — skip
          }
        }

        // Index freshness: check the most recent updatedAt across all nodes
        let lastIndexedAt: number | null = null;
        let oldestIndexAt: number | null = null;
        if (indexedFiles.length > 0) {
          // We query the nodes table directly for timestamps
          const fileNodes = graph.getNodesByType('file');
          if (fileNodes.length > 0) {
            lastIndexedAt = Math.max(...fileNodes.map((n) => n.updatedAt));
            oldestIndexAt = Math.min(...fileNodes.map((n) => n.updatedAt));
          }
        }

        const now = Date.now();
        const indexAgeMs = lastIndexedAt ? now - lastIndexedAt : null;

        const result = {
          status: 'ok',
          database: {
            path: config.dbPath,
            sizeBytes: dbSizeBytes,
            sizeMB: Number((dbSizeBytes / (1024 * 1024)).toFixed(2)),
          },
          index: {
            totalFiles: stats.totalFiles,
            totalNodes: stats.totalNodes,
            totalEdges: stats.totalEdges,
            lastIndexedAt: lastIndexedAt
              ? new Date(lastIndexedAt).toISOString()
              : null,
            oldestIndexAt: oldestIndexAt
              ? new Date(oldestIndexAt).toISOString()
              : null,
            indexAgeSeconds: indexAgeMs !== null ? Math.round(indexAgeMs / 1000) : null,
            isFresh: indexAgeMs !== null ? indexAgeMs < 3600_000 : false, // < 1 hour
          },
          graph: {
            nodesByType: stats.nodesByType,
            edgesByType: stats.edgesByType,
            languageBreakdown: stats.languageBreakdown,
          },
          config: {
            projectRoot: config.projectRoot,
            watchEnabled: config.watchEnabled,
            compression: config.compression,
            maxFileSize: config.maxFileSize,
            pageRankEnabled: config.pageRankEnabled,
            tokenBudgets: config.tokenBudgets,
          },
          detectedAgents,
          system: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            uptime: Math.round(process.uptime()),
            memoryUsageMB: Number(
              (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(2),
            ),
          },
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Health check failed: ${msg}`));
      }
    },
  );
}
