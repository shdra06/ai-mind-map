/**
 * AI Mind Map — Knowledge Graph MCP Tools
 *
 * Registers all knowledge-graph-related tools on the MCP server.
 * Each tool returns structured JSON data wrapped in the standard
 * MCP text-content envelope.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  GraphNode,
  GraphEdge,
  NodeType,
  ToolResult,
} from '../types.js';

// ============================================================
// Subsystem interfaces
// ============================================================

/**
 * Minimal interface expected of the Knowledge Graph subsystem.
 * The concrete implementation lives elsewhere; we depend on the
 * contract only.
 */
export interface IKnowledgeGraph {
  /** Full-text / name search across all indexed nodes. */
  search(query: string, type?: NodeType, limit?: number): GraphNode[];

  /** Get project file tree with top-level symbols per file. */
  getStructure(depth: number): {
    files: { path: string; symbols: Pick<GraphNode, 'name' | 'type' | 'signature'>[] }[];
  };

  /** Trace dependency chain of a symbol (callers / callees). */
  traceDependencies(
    symbolName: string,
    direction: 'callers' | 'callees' | 'both',
    depth: number,
  ): {
    root: string;
    direction: string;
    depth: number;
    nodes: GraphNode[];
    edges: GraphEdge[];
  };

  /** Get the full signature (no body) for a symbol. */
  getSignature(
    symbolName: string,
    filePath?: string,
  ): {
    node: GraphNode;
    parameters: GraphNode['parameters'];
    returnType: GraphNode['returnType'];
    docComment: GraphNode['docComment'];
  } | null;

  /** Find every location a symbol is referenced. */
  findReferences(
    symbolName: string,
  ): {
    symbol: string;
    references: { filePath: string; line: number; context: string }[];
  };

  /** Get structural map of all symbols in a single file. */
  getFileMap(
    filePath: string,
  ): {
    filePath: string;
    symbols: Pick<GraphNode, 'name' | 'type' | 'signature' | 'startLine' | 'endLine' | 'visibility' | 'isExported'>[];
  } | null;
}

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

// ============================================================
// Node type enum values for Zod
// ============================================================

const NODE_TYPES: [NodeType, ...NodeType[]] = [
  'file', 'function', 'class', 'method', 'interface', 'type_alias',
  'enum', 'variable', 'constant', 'module', 'namespace', 'property',
  'constructor', 'decorator', 'route', 'component', 'hook', 'test', 'config',
];

// ============================================================
// Registration
// ============================================================

/**
 * Register all Knowledge Graph tools on the given MCP server.
 *
 * @param server   The MCP server instance.
 * @param graph    Concrete knowledge-graph implementation.
 * @param estimator  Optional token estimator (defaults to 4-char heuristic).
 */
export function registerGraphTools(
  server: McpServer,
  graph: IKnowledgeGraph,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  // ── mindmap_search ──────────────────────────────────────────
  server.tool(
    'mindmap_search',
    'Search the codebase by symbol name, type, or free-text query. Returns matching nodes with their signatures.',
    {
      query: z.string().describe('Search query (name, keyword, or free text)'),
      type: z.enum(NODE_TYPES).optional().describe('Optional node-type filter'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
    },
    async ({ query, type, limit }) => {
      try {
        const nodes = graph.search(query, type, limit);
        return mcpText(ok(nodes, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Search failed: ${msg}`));
      }
    },
  );

  // ── mindmap_get_structure ───────────────────────────────────
  server.tool(
    'mindmap_get_structure',
    'Get the project architecture overview — file tree with top-level symbols per file.',
    {
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(2)
        .describe('Directory tree depth (1-3)'),
    },
    async ({ depth }) => {
      try {
        const structure = graph.getStructure(depth);
        return mcpText(ok(structure, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Get structure failed: ${msg}`));
      }
    },
  );

  // ── mindmap_trace_dependencies ──────────────────────────────
  server.tool(
    'mindmap_trace_dependencies',
    'Trace the dependency chain of a symbol — who calls it, what it calls, or both.',
    {
      symbolName: z.string().optional().describe('Qualified or simple symbol name (alias: symbol)'),
      symbol: z.string().optional().describe('Qualified or simple symbol name (preferred alias for symbolName)'),
      direction: z
        .enum(['callers', 'callees', 'both'])
        .default('both')
        .describe('Direction to trace'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe('Max depth of traversal'),
    },
    async ({ symbolName, symbol, direction, depth }) => {
      try {
        const name = symbol ?? symbolName;
        if (!name) {
          return mcpText(fail('Either symbol or symbolName must be provided'));
        }
        const result = graph.traceDependencies(name, direction, depth);
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Trace dependencies failed: ${msg}`));
      }
    },
  );

  // ── mindmap_get_signature ───────────────────────────────────
  server.tool(
    'mindmap_get_signature',
    'Get the full signature of a function or class (parameters, return type, doc comment) — without the body.',
    {
      symbolName: z.string().optional().describe('Name of the symbol to look up (alias: symbol)'),
      symbol: z.string().optional().describe('Name of the symbol to look up (preferred alias for symbolName)'),
      filePath: z
        .string()
        .optional()
        .describe('Optional file path to disambiguate'),
    },
    async ({ symbolName, symbol, filePath }) => {
      try {
        const name = symbol ?? symbolName;
        if (!name) {
          return mcpText(fail('Either symbol or symbolName must be provided'));
        }
        const result = graph.getSignature(name, filePath);
        if (!result) {
          return mcpText(fail(`Symbol not found: ${name}`));
        }
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Get signature failed: ${msg}`));
      }
    },
  );

  // ── mindmap_find_references ─────────────────────────────────
  server.tool(
    'mindmap_find_references',
    'Find every location where a symbol is referenced across the codebase.',
    {
      symbolName: z.string().optional().describe('Name of the symbol to find references for (alias: symbol)'),
      symbol: z.string().optional().describe('Name of the symbol to find references for (preferred alias for symbolName)'),
    },
    async ({ symbolName, symbol }) => {
      try {
        const name = symbol ?? symbolName;
        if (!name) {
          return mcpText(fail('Either symbol or symbolName must be provided'));
        }
        const result = graph.findReferences(name);
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Find references failed: ${msg}`));
      }
    },
  );

  // ── mindmap_get_file_map ────────────────────────────────────
  server.tool(
    'mindmap_get_file_map',
    'Get the structural map of a specific file — all symbols with their signatures, visibility, and line ranges.',
    {
      filePath: z.string().describe('Relative or absolute path to the file'),
    },
    async ({ filePath }) => {
      try {
        const result = graph.getFileMap(filePath);
        if (!result) {
          return mcpText(fail(`File not found in index: ${filePath}`));
        }
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Get file map failed: ${msg}`));
      }
    },
  );
}
