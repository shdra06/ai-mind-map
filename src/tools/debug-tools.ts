/**
 * AI Mind Map — Debug & History MCP Tools
 *
 * Purpose-built tools for the "something broke, what changed?" scenario.
 *
 * These tools give the AI agent the ability to:
 * 1. See ACTUAL code diffs (not just "47 lines added")
 * 2. View what a file looked like BEFORE a change
 * 3. See the commit history of a specific file
 * 4. Get a full crash-debugging context package
 *
 * This is the killer feature that codebase-memory-mcp lacks entirely.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig } from '../types.js';

import { DiffEngine } from '../change-tracker/diff-engine.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';

// ============================================================
// Shared helpers
// ============================================================

interface ITokenEstimator {
  estimate(text: string): number;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

function mcpText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

function ok(data: unknown, estimator: ITokenEstimator, saved = 0): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved: saved };
}

function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

// ============================================================
// Registration
// ============================================================

/**
 * Register all debug/history tools on the MCP server.
 */
export function registerDebugTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  const diffEngine = new DiffEngine(config.projectRoot);

  // ── mindmap_debug_changes ─────────────────────────────────
  // THE crash debugging tool. When user says "X is broken, what happened?"
  // this gives the AI everything it needs to diagnose the issue.
  server.tool(
    'mindmap_debug_changes',
    `🔍 CRASH DEBUGGER: When something broke, use this tool FIRST.
Returns: actual git diffs (real code changes, not just counts), 
list of recently changed files, affected function signatures, 
and blast radius analysis. This is the most powerful debugging tool available.
Use when: user reports a crash, bug, or unexpected behavior.`,
    {
      filePath: z
        .string()
        .optional()
        .describe(
          'Specific file to investigate (e.g. "src/notes.ts"). If omitted, shows ALL recent changes.',
        ),
      since: z
        .union([
          z.enum(['last_session', 'today', 'this_week', '1h', '3h', '6h', '12h', '24h']),
          z.string().datetime({ message: 'Must be an ISO-8601 timestamp' }),
        ])
        .default('last_session')
        .describe(
          'How far back to look: "last_session", "today", "1h", "3h", "6h", "12h", "24h", "this_week", or ISO timestamp',
        ),
      maxDiffLines: z
        .number()
        .int()
        .min(50)
        .max(2000)
        .default(300)
        .describe('Max lines of diff output to return (default 300, max 2000)'),
    },
    async ({ filePath, since, maxDiffLines }) => {
      try {
        // Resolve "since" to a timestamp
        const sinceTimestamp = resolveTimestamp(since);

        // 1. Get the ACTUAL diff (code changes, not just counts)
        const actualDiff = await diffEngine.getActualDiff(sinceTimestamp, {
          filePath,
          maxLines: maxDiffLines,
        });

        // 2. Get structured change summary
        const changeSummary = await diffEngine.getChangesSinceTimestamp(
          sinceTimestamp,
          'debug-session',
        );

        // 3. For each changed file, find what symbols were affected
        const affectedSymbols: Array<{
          file: string;
          functions: string[];
          classes: string[];
        }> = [];

        for (const change of changeSummary.changes) {
          const nodes = graph.getFileStructure(change.filePath);
          const functions = nodes
            .filter((n: import('../types.js').GraphNode) => n.type === 'function' || n.type === 'method')
            .map((n: import('../types.js').GraphNode) => `${n.name}(${(n.parameters ?? []).map((p: import('../types.js').ParameterInfo) => p.name).join(', ')})`);
          const classes = nodes
            .filter((n: import('../types.js').GraphNode) => n.type === 'class')
            .map((n: import('../types.js').GraphNode) => n.name);

          if (functions.length > 0 || classes.length > 0) {
            affectedSymbols.push({
              file: change.filePath,
              functions,
              classes,
            });
          }
        }

        // 4. For the target file (if specified), get blast radius
        let blastRadius: unknown = null;
        if (filePath) {
          const fileNodes = graph.getFileStructure(filePath);
          const dependents: string[] = [];
          for (const node of fileNodes) {
            const callers = graph.findCallers(node.id);
            for (const caller of callers) {
              if (caller.filePath !== filePath) {
                dependents.push(`${caller.name} (${relative(config.projectRoot, caller.filePath)})`);
              }
            }
          }
          blastRadius = {
            file: filePath,
            symbolsInFile: fileNodes.length,
            externalDependents: [...new Set(dependents)],
            riskLevel: dependents.length > 10 ? 'high' : dependents.length > 3 ? 'medium' : 'low',
          };
        }

        const result = {
          title: filePath
            ? `🔍 Debug Report: ${filePath}`
            : `🔍 Debug Report: All changes since ${since}`,
          summary: {
            filesChanged: changeSummary.filesAffected,
            totalLinesAdded: changeSummary.totalLinesAdded,
            totalLinesRemoved: changeSummary.totalLinesRemoved,
            changedFiles: actualDiff.files,
          },
          actualDiff: {
            content: actualDiff.diff,
            truncated: actualDiff.truncated,
            note: 'This is the ACTUAL git diff showing exactly what code changed.',
          },
          affectedSymbols,
          blastRadius,
          debugTip: filePath
            ? `Check the diff above for the exact changes to ${filePath}. Look for: missing null checks, changed function signatures, removed error handlers, new parameters not passed by callers.`
            : `${actualDiff.files.length} files changed. Focus on the ones related to the reported issue. Use mindmap_debug_changes with a specific filePath to drill down.`,
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`debug_changes failed: ${msg}`));
      }
    },
  );

  // ── mindmap_file_before ───────────────────────────────────
  // Show what a file looked like BEFORE the recent changes.
  server.tool(
    'mindmap_file_before',
    `Show what a file looked like BEFORE recent changes (git show).
Use when you need to compare current code with the previous version 
to find what broke. Returns the full file content at a past revision.`,
    {
      filePath: z
        .string()
        .describe('File path relative to project root (e.g. "src/notes.ts")'),
      revision: z
        .string()
        .default('HEAD~1')
        .describe('Git revision to show (default: HEAD~1 = last commit). Can be: HEAD~2, a commit hash, a branch name, a tag'),
    },
    async ({ filePath, revision }) => {
      try {
        const result = await diffEngine.getFileAtRevision(filePath, revision);

        if (!result.found) {
          return mcpText(fail(result.content));
        }

        // Also get current content for comparison
        let currentContent = '';
        try {
          const fullPath = `${config.projectRoot}/${filePath}`;
          currentContent = readFileSync(fullPath, 'utf-8');
        } catch {
          currentContent = '[file not found on disk — may have been deleted]';
        }

        const currentLines = currentContent.split('\n').length;
        const oldLines = result.content.split('\n').length;
        const tokensSaved = estimator.estimate(currentContent) - estimator.estimate(result.content);

        return mcpText(ok({
          filePath,
          revision: result.revision,
          previousContent: result.content,
          stats: {
            previousLines: oldLines,
            currentLines,
            lineDelta: currentLines - oldLines,
          },
          hint: 'Compare this previous version with the current file to find what changed and what might have broken.',
        }, estimator, Math.abs(tokensSaved)));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`file_before failed: ${msg}`));
      }
    },
  );

  // ── mindmap_file_history ──────────────────────────────────
  // Show the commit history for a specific file.
  server.tool(
    'mindmap_file_history',
    `Show the git commit history for a specific file — who changed it, when, and why.
Use when debugging to understand the timeline of changes to a file.`,
    {
      filePath: z
        .string()
        .describe('File path relative to project root (e.g. "src/notes.ts")'),
      maxCommits: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Max number of commits to show (default 10)'),
    },
    async ({ filePath, maxCommits }) => {
      try {
        const history = await diffEngine.getFileHistory(filePath, maxCommits);

        if (history.length === 0) {
          return mcpText(fail(`No git history found for "${filePath}" — file may not be tracked or project is not a git repo.`));
        }

        // For the most recent commit, get the actual diff
        const mostRecentDiff = await diffEngine.getActualDiff(
          new Date(history[0]!.date).getTime() - 1000, // 1s before the commit
          { filePath, maxLines: 100 },
        );

        return mcpText(ok({
          filePath,
          totalCommits: history.length,
          history: history.map((h, i) => ({
            ...h,
            isLatest: i === 0,
            relativeTime: humanTimeDelta(new Date(h.date).getTime()),
          })),
          latestCommitDiff: mostRecentDiff.diff.length > 10
            ? mostRecentDiff.diff
            : 'No diff available for latest commit.',
          tip: `The most recent change was: "${history[0]!.message}" (${humanTimeDelta(new Date(history[0]!.date).getTime())} ago). Use mindmap_file_before to see the full file at any revision.`,
        }, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`file_history failed: ${msg}`));
      }
    },
  );
}

// ============================================================
// Utilities
// ============================================================

/** Resolve a "since" reference to an epoch timestamp in ms. */
function resolveTimestamp(since: string): number {
  const now = Date.now();

  switch (since) {
    case 'last_session':
      // Default to 4 hours ago if no session info
      return now - 4 * 60 * 60 * 1000;
    case 'today': {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return today.getTime();
    }
    case 'this_week': {
      const week = new Date();
      week.setDate(week.getDate() - week.getDay());
      week.setHours(0, 0, 0, 0);
      return week.getTime();
    }
    case '1h':
      return now - 1 * 60 * 60 * 1000;
    case '3h':
      return now - 3 * 60 * 60 * 1000;
    case '6h':
      return now - 6 * 60 * 60 * 1000;
    case '12h':
      return now - 12 * 60 * 60 * 1000;
    case '24h':
      return now - 24 * 60 * 60 * 1000;
    default:
      // ISO-8601 timestamp
      return new Date(since).getTime();
  }
}

/** Convert a past timestamp into a human-friendly delta like "2h ago". */
function humanTimeDelta(pastMs: number): string {
  const delta = Date.now() - pastMs;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
