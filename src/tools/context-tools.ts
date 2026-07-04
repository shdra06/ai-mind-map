/**
 * AI Mind Map — Context Management MCP Tools
 *
 * Registers context-engine tools on the MCP server: smart context
 * loading, content compression, re-indexing, and system status.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ContextPackage,
  CompressionLevel,
  ContentType,
  MindMapConfig,
  MindMapStats,
  ToolResult,
} from '../types.js';

// ============================================================
// Subsystem interfaces
// ============================================================

/**
 * Minimal interface expected of the Context Engine subsystem.
 */
export interface IContextEngine {
  /**
   * Build a smart context package for the given task description.
   * Optionally includes relevant memories and recent changes.
   */
  getContext(params: {
    taskDescription: string;
    includeMemories: boolean;
    includeChanges: boolean;
  }): ContextPackage;

  /**
   * Compress content to reduce token usage.
   *
   * @returns compressed text and statistics.
   */
  compress(params: {
    content: string;
    contentType?: ContentType;
    level: CompressionLevel;
  }): {
    original: string;
    compressed: string;
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
    contentType: ContentType;
  };
}

/**
 * Minimal interface for the Indexer subsystem.
 */
export interface IIndexer {
  /** Force a full re-index of the codebase. Returns stats on completion. */
  reindex(): Promise<{
    filesScanned: number;
    filesIndexed: number;
    nodesCreated: number;
    edgesCreated: number;
    durationMs: number;
    errors: string[];
  }>;

  /** Re-target to a specific project directory and index it. */
  reindexProject(projectPath: string): Promise<{
    filesScanned: number;
    filesIndexed: number;
    nodesCreated: number;
    edgesCreated: number;
    durationMs: number;
    errors: string[];
    projectRoot: string;
  }>;

  /** Get current system statistics. */
  getStats(): MindMapStats;
}

export interface ITokenEstimator {
  estimate(text: string): number;
}

/**
 * Optional interface for running raw SQLite diagnostics.
 * When provided, enables DB integrity and journal-mode checks
 * in the health-check response.
 */
export interface IStatusDb {
  pragma(pragma: string): unknown;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

// ============================================================
// Content-type enum for Zod
// ============================================================

const CONTENT_TYPES: [ContentType, ...ContentType[]] = [
  'source_code',
  'build_log',
  'test_output',
  'stack_trace',
  'json_data',
  'markdown',
  'plain_text',
  'diff',
  'config_file',
];

const COMPRESSION_LEVELS: [CompressionLevel, ...CompressionLevel[]] = [
  'minimal',
  'moderate',
  'aggressive',
];

// ============================================================
// Helpers
// ============================================================

function mcpText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

function mcpErrorText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: true,
  };
}

function ok(data: unknown, estimator: ITokenEstimator): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved: 0 };
}

function okWithSavings(
  data: unknown,
  tokensSaved: number,
  estimator: ITokenEstimator,
): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved };
}

function fail(message: string, recovery?: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message, ...(recovery ? { recovery } : {}) };
}

// ============================================================
// Registration
// ============================================================

/**
 * Register all Context Management tools on the given MCP server.
 *
 * @param server        The MCP server instance.
 * @param context       Concrete context-engine implementation.
 * @param indexer       Concrete indexer implementation.
 * @param estimator     Optional token estimator.
 * @param config        Project configuration (for health-check).
 * @param serverVersion Package version string (for health-check).
 * @param db            Optional raw DB handle for PRAGMA diagnostics.
 */
export function registerContextTools(
  server: McpServer,
  context: IContextEngine,
  indexer: IIndexer,
  estimator: ITokenEstimator = defaultEstimator,
  config?: MindMapConfig,
  serverVersion?: string,
  db?: IStatusDb,
): void {
  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  server.tool(
    'mindmap_get_context',
    'Smart context loading for the current task. Returns a tiered ContextPackage with project summary, relevant graph results, memories, and changes.',
    {
      taskDescription: z
        .string()
        .min(1)
        .describe('Describe the task you are working on'),
      includeMemories: z
        .boolean()
        .default(true)
        .describe('Include relevant stored memories'),
      includeChanges: z
        .boolean()
        .default(true)
        .describe('Include recent change summaries'),
    },
    async ({ taskDescription, includeMemories, includeChanges }) => {
      try {
        const pkg = context.getContext({
          taskDescription,
          includeMemories,
          includeChanges,
        });
        return mcpText(
          okWithSavings(pkg, pkg.tokensSaved, estimator),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`get_context failed: ${msg}`));
      }
    },
  );
  } */

  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  server.tool(
    'mindmap_compress',
    'Compress content to reduce token usage before adding to context. Auto-detects content type if not specified.',
    {
      content: z.string().min(1).describe('The content to compress'),
      contentType: z
        .enum(CONTENT_TYPES)
        .optional()
        .describe('Content type (auto-detected if omitted)'),
      level: z
        .enum(COMPRESSION_LEVELS)
        .default('moderate')
        .describe('Compression level'),
    },
    async ({ content, contentType, level }) => {
      try {
        const result = context.compress({ content, contentType, level });
        return mcpText(
          okWithSavings(
            {
              compressed: result.compressed,
              originalTokens: result.originalTokens,
              compressedTokens: result.compressedTokens,
              ratio: result.ratio,
              contentType: result.contentType,
            },
            result.originalTokens - result.compressedTokens,
            estimator,
          ),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`compress failed: ${msg}`));
      }
    },
  );
  } */

  // ── mindmap_reindex ─────────────────────────────────────────
  server.tool(
    'mindmap_reindex',
    'Index or re-index a codebase to build the knowledge graph.',
    {
      projectPath: z.string().optional().describe(
        'Absolute path to the project directory to index. ALWAYS provide this when indexing a new project.'
      ),
    },
    async ({ projectPath }) => {
      try {
        let result;
        if (projectPath) {
          result = await indexer.reindexProject(projectPath);
        } else {
          const raw = await indexer.reindex();
          result = { ...raw, projectRoot: indexer.getStats().projectRoot ?? 'unknown' };
        }
        const isFirstTime = result.nodesCreated > 0 && result.durationMs > 5000;
        const responseData: Record<string, unknown> = {
          ...result,
          message: `Indexed ${result.filesIndexed} files -> ${result.nodesCreated} symbols in ${result.durationMs}ms. Project: ${result.projectRoot}. All tools are now ready.`,
        };
        if (isFirstTime) {
          responseData._userMessage = 'Knowledge graph built successfully. ' +
            'All code intelligence tools are now ready -- searches, architecture analysis, ' +
            'flow tracing, and symbol lookups will respond instantly from now on.';
        }
        return mcpText(ok(responseData, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpErrorText(fail(`reindex failed: ${msg}`, 'Check if the project path exists and is accessible'));
      }
    },
  );

  // ── mindmap_status ──────────────────────────────────────────
  server.tool(
    'mindmap_status',
    'Full health check: DB integrity, index status, memory usage, uptime.',
    {},
    async () => {
      try {
        const stats = indexer.getStats();
        const mem = process.memoryUsage();

        // ── DB diagnostics ────────────────────────────────
        let dbInfo: Record<string, unknown> = {};
        if (config) {
          let sizeBytes = 0;
          try {
            sizeBytes = statSync(config.dbPath).size;
          } catch {
            // DB file may not exist yet
          }

          let integrity = 'unknown';
          let walMode = false;
          if (db) {
            try {
              const intResult = db.pragma('integrity_check') as { integrity_check: string }[];
              integrity = Array.isArray(intResult) && intResult.length > 0
                ? intResult[0].integrity_check
                : 'ok';
            } catch {
              integrity = 'error';
            }
            try {
              const jmResult = db.pragma('journal_mode') as { journal_mode: string }[];
              const mode = Array.isArray(jmResult) && jmResult.length > 0
                ? jmResult[0].journal_mode
                : '';
              walMode = mode === 'wal';
            } catch {
              // leave as false
            }
          }

          dbInfo = {
            path: config.dbPath,
            sizeBytes,
            sizeMB: (sizeBytes / 1024 / 1024).toFixed(1),
            integrity,
            walMode,
          };
        }

        // ── Index status ──────────────────────────────────
        const notIndexed = stats.indexedFiles === 0 && stats.totalNodes === 0;

        // ── Assemble full health-check response ──────────
        const response: Record<string, unknown> = {
          healthy: !notIndexed,
          project: config
            ? {
                root: config.projectRoot,
                name: basename(config.projectRoot),
              }
            : { root: stats.projectRoot ?? 'unknown', name: 'unknown' },
          db: dbInfo,
          index: {
            files: stats.indexedFiles,
            symbols: stats.totalNodes,
            edges: stats.totalEdges,
            languages: stats.languageBreakdown,
            stale: false,
          },
          runtime: {
            heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
            rssMB: (mem.rss / 1024 / 1024).toFixed(1),
            uptimeSeconds: Math.round(process.uptime()),
            nodeVersion: process.version,
            serverVersion: serverVersion ?? 'unknown',
          },
          tools: {
            active: 18,
            disabled: 15,
          },
        };

        // Preserve user-facing guidance when no index exists
        if (notIndexed) {
          response._indexStatus = 'NOT_INDEXED';
          response._message = '⚠ No codebase has been indexed yet. Call mindmap_reindex to index the project.';
        } else {
          response._indexStatus = 'READY';
        }

        return mcpText(ok(response, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`status failed: ${msg}`));
      }
    },
  );
}
