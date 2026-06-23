/**
 * AI Mind Map — Change Tracking MCP Tools
 *
 * Registers all change-tracking-related tools on the MCP server.
 * Each tool returns structured JSON wrapped in the standard MCP
 * text-content envelope.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  FileChange,
  ChangeSession,
  GraphNode,
  ToolResult,
} from '../types.js';

// ============================================================
// Subsystem interfaces
// ============================================================

/**
 * Minimal interface expected of the Change Tracker subsystem.
 */
export interface IChangeTracker {
  /**
   * Get a summary of changes since a given time reference.
   *
   * Accepted values for `since`:
   *   - 'last_session' — changes since the last AI session ended
   *   - 'today'        — changes since midnight local time
   *   - 'this_week'    — changes in the current calendar week
   *   - ISO-8601 string — exact timestamp
   */
  getChanges(since: string): {
    since: string;
    resolvedTimestamp: number;
    changes: FileChange[];
    totalFilesChanged: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    summary: string;
  };

  /**
   * Get a diff summary compared with the last recorded AI session.
   */
  getSessionDiff(): {
    previousSession: ChangeSession | null;
    changes: FileChange[];
    affectedSymbols: string[];
    summary: string;
  };

  /**
   * Analyse the blast radius of changes to a file or symbol.
   * At least one of `filePath` or `symbolName` must be provided.
   */
  analyseImpact(params: {
    filePath?: string;
    symbolName?: string;
  }): {
    target: string;
    directlyAffected: { node: GraphNode; relationship: string }[];
    transitivelyAffected: { node: GraphNode; depth: number }[];
    riskLevel: 'low' | 'medium' | 'high';
    summary: string;
  };
}

/**
 * Minimal interface for estimating token counts.
 */
export interface ITokenEstimator {
  estimate(text: string): number;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

// ============================================================
// Helpers
// ============================================================

function mcpText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

function ok(data: unknown, estimator: ITokenEstimator): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved: 0 };
}

function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

// ============================================================
// Registration
// ============================================================

/**
 * Register all Change Tracking tools on the given MCP server.
 *
 * @param server   The MCP server instance.
 * @param tracker  Concrete change-tracker implementation.
 * @param estimator  Optional token estimator.
 */
export function registerChangeTools(
  server: McpServer,
  tracker: IChangeTracker,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  // ── mindmap_what_changed ────────────────────────────────────
  server.tool(
    'mindmap_what_changed',
    'Get a summary of recent codebase changes. Useful for understanding what happened while the AI was away.',
    {
      since: z
        .union([
          z.enum(['last_session', 'today', 'this_week']),
          z.string().datetime({ message: 'Must be an ISO-8601 timestamp' }),
        ])
        .default('last_session')
        .describe(
          "Time reference: 'last_session', 'today', 'this_week', or an ISO-8601 timestamp",
        ),
    },
    async ({ since }) => {
      try {
        const result = tracker.getChanges(since);
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`what_changed failed: ${msg}`));
      }
    },
  );

  // ── mindmap_session_diff ────────────────────────────────────
  server.tool(
    'mindmap_session_diff',
    `Get what changed since the last AI session ended. Returns a diff summary with affected symbols.`,
    {},
    async () => {
      try {
        const result = tracker.getSessionDiff();
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`session_diff failed: ${msg}`));
      }
    },
  );

  // ── mindmap_impact_analysis ─────────────────────────────────
  server.tool(
    'mindmap_impact_analysis',
    'Analyse the blast radius of changes to a file or symbol — what else is affected.',
    {
      filePath: z
        .string()
        .optional()
        .describe('File path to analyse (provide filePath or symbolName, or both)'),
      symbolName: z
        .string()
        .optional()
        .describe('Symbol name to analyse (provide filePath or symbolName, or both)'),
    },
    async ({ filePath, symbolName }) => {
      if (!filePath && !symbolName) {
        return mcpText(
          fail('At least one of filePath or symbolName must be provided'),
        );
      }
      try {
        const result = tracker.analyseImpact({ filePath, symbolName });
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`impact_analysis failed: ${msg}`));
      }
    },
  );
}
