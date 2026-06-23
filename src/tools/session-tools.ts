/**
 * AI Mind Map — Session Tools (MCP)
 *
 * Tools for AI agent session management:
 *   - mindmap_session_start   — Start tracking an AI session
 *   - mindmap_session_resume  — Resume from last session (returns what changed)
 *   - mindmap_session_end     — End session with summary
 *   - mindmap_changelog       — What changed since a given time
 *   - mindmap_hotspots        — Most frequently changed files
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { relative } from 'node:path';
import type { KnowledgeGraph } from '../knowledge-graph/graph.js';
import type { ChangelogEngine } from '../knowledge-graph/changelog.js';
import type { MindMapConfig } from '../types.js';
import type { ITokenEstimator } from './advanced-tools.js';

// ── Helpers ─────────────────────────────────────────────────

const defaultEstimator: ITokenEstimator = {
  estimate: (s: string) => Math.ceil(s.length / 4),
};

function ok(data: unknown, estimator: ITokenEstimator): string {
  const json = JSON.stringify(data, null, 2);
  const tokens = estimator.estimate(json);
  return JSON.stringify({ success: true, data, tokenCount: tokens });
}

function fail(message: string): string {
  return JSON.stringify({ success: false, error: message });
}

function mcpText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ============================================================
// Registration
// ============================================================

export function registerSessionTools(
  server: McpServer,
  graph: KnowledgeGraph,
  changelog: ChangelogEngine,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  // ── mindmap_session_start ──────────────────────────────────
  server.tool(
    'mindmap_session_start',
    'Start a new AI coding session. Records the agent name and task ' +
      'for session tracking. Changes made during this session will be ' +
      'attributed to it. Returns the session ID.',
    {
      agent: z.string().optional().describe('Name of the AI agent (e.g., "cursor", "claude", "copilot")'),
      task: z.string().optional().describe('Brief description of what you\'re working on'),
    },
    async (args) => {
      try {
        const sessionId = changelog.startSession(
          args.agent || 'ai-agent',
          args.task,
        );
        return mcpText(ok({
          sessionId,
          message: `Session started. Changes will be tracked under this session.`,
          tip: 'Call mindmap_session_end when done to save a summary for next time.',
        }, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  // ── mindmap_session_resume ─────────────────────────────────
  server.tool(
    'mindmap_session_resume',
    'Resume from the last AI coding session. Returns what was worked on, ' +
      'what files changed since then, and relevant memories. ' +
      'THIS IS THE FIRST TOOL AN AI AGENT SHOULD CALL to avoid re-reading the codebase.',
    {
      agent: z.string().optional().describe('Name of the AI agent resuming'),
    },
    async (args) => {
      try {
        // 1. Get last completed session
        const lastSession = changelog.getLastSession();

        // 2. Start a new session
        const newSessionId = changelog.startSession(args.agent || 'ai-agent');

        // 3. Get changes since last session ended
        const sinceTime = lastSession?.endedAt || lastSession?.startedAt || (Date.now() - 24 * 3600_000);
        const changes = changelog.getChangesSince(sinceTime);

        // 4. Get project stats for context
        const stats = graph.getStats();

        // 5. Get hotspots
        const hotspots = changelog.getHotspots(5);

        // 6. Build resume package
        const result: Record<string, unknown> = {
          newSessionId,
          project: {
            root: config.projectRoot,
            totalFiles: stats.totalFiles,
            totalNodes: stats.totalNodes,
            totalEdges: stats.totalEdges,
            languages: stats.languageBreakdown,
          },
        };

        if (lastSession) {
          result.lastSession = {
            agent: lastSession.agentName,
            task: lastSession.taskDescription,
            startedAt: new Date(lastSession.startedAt).toISOString(),
            endedAt: lastSession.endedAt ? new Date(lastSession.endedAt).toISOString() : null,
            filesModified: lastSession.filesModified.map(f =>
              relative(config.projectRoot, f).replace(/\\/g, '/')
            ),
            summary: lastSession.summary,
          };
        } else {
          result.lastSession = null;
          result.message = 'No previous session found. This appears to be the first session.';
        }

        if (changes.totalChanges > 0) {
          result.changesSinceLastSession = {
            totalChanges: changes.totalChanges,
            filesChanged: changes.filesChanged,
            sinceLabel: changes.sinceLabel,
            files: changes.files.map(f => ({
              file: relative(config.projectRoot, f.filePath).replace(/\\/g, '/'),
              added: f.added.map(a => `+ ${a.type} ${a.name}${a.signature ? `: ${a.signature}` : ''}`),
              modified: f.modified.map(m => {
                if (m.oldSignature !== m.newSignature) {
                  return `~ ${m.type} ${m.name}: ${m.oldSignature} → ${m.newSignature}`;
                }
                return `~ ${m.type} ${m.name} (body changed)`;
              }),
              deleted: f.deleted.map(d => `- ${d.type} ${d.name}`),
            })),
          };
        } else {
          result.changesSinceLastSession = {
            totalChanges: 0,
            message: 'No code changes detected since last session.',
          };
        }

        if (hotspots.length > 0) {
          result.hotFiles = hotspots.map(h => ({
            file: relative(config.projectRoot, h.filePath).replace(/\\/g, '/'),
            changes: h.changeCount,
            topSymbols: Object.entries(h.symbolChanges)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .slice(0, 3)
              .map(([name, count]) => `${name} (${count}x)`),
          }));
        }

        // CRITICAL: If index is empty, tell the AI to index first
        if (stats.totalNodes === 0) {
          result._indexRequired = true;
          result._action = 'Call mindmap_reindex NOW to index the codebase. ' +
            'This is a one-time operation (~10-30 seconds). ' +
            'After indexing, call mindmap_session_resume again for full project context.';
        }

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Failed to resume session: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  // ── mindmap_session_end ────────────────────────────────────
  server.tool(
    'mindmap_session_end',
    'End the current AI coding session with a summary. ' +
      'The summary will be shown to the next AI agent that calls mindmap_session_resume.',
    {
      summary: z.string().optional().describe('Summary of what was accomplished in this session'),
    },
    async (args) => {
      try {
        const currentSession = changelog.getCurrentSession();
        if (!currentSession) {
          return mcpText(fail('No active session to end.'));
        }

        // Get session changes for stats
        const changes = changelog.getSessionChanges(currentSession.id);

        changelog.endSession(currentSession.id, args.summary);

        // Prune old entries
        const pruned = changelog.pruneChangelog();

        return mcpText(ok({
          sessionId: currentSession.id,
          duration: currentSession.startedAt
            ? `${Math.round((Date.now() - currentSession.startedAt) / 60_000)} minutes`
            : 'unknown',
          changesRecorded: changes.length,
          filesModified: currentSession.filesModified.length,
          summary: args.summary || 'No summary provided',
          entriesPruned: pruned,
        }, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Failed to end session: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  // ── mindmap_changelog ──────────────────────────────────────
  server.tool(
    'mindmap_changelog',
    'Get a detailed changelog of what symbols (functions, classes, methods) ' +
      'were added, modified, or deleted since a given time. ' +
      'Use this instead of re-reading files to see what changed.',
    {
      since: z.string().optional().describe(
        'ISO timestamp or relative: "1h", "30m", "1d", "last_session". Default: "last_session"'
      ),
      file: z.string().optional().describe('Filter to a specific file path (relative to project root)'),
    },
    async (args) => {
      try {
        let sinceMs: number;

        if (!args.since || args.since === 'last_session') {
          const lastSession = changelog.getLastSession();
          sinceMs = lastSession?.endedAt || lastSession?.startedAt || (Date.now() - 3600_000);
        } else if (args.since.match(/^\d+[mhd]$/)) {
          const num = parseInt(args.since);
          const unit = args.since.slice(-1);
          const multipliers: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000 };
          sinceMs = Date.now() - (num * (multipliers[unit] || 3600_000));
        } else {
          sinceMs = new Date(args.since).getTime();
          if (isNaN(sinceMs)) sinceMs = Date.now() - 3600_000;
        }

        if (args.file) {
          const filePath = args.file.includes(config.projectRoot)
            ? args.file
            : `${config.projectRoot}/${args.file}`.replace(/\//g, '\\');
          const changes = changelog.getFileChanges(filePath);
          return mcpText(ok({ file: args.file, changes }, estimator));
        }

        const changes = changelog.getChangesSince(sinceMs);

        // Make file paths relative
        const result = {
          ...changes,
          files: changes.files.map(f => ({
            ...f,
            filePath: relative(config.projectRoot, f.filePath).replace(/\\/g, '/'),
          })),
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Failed to get changelog: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  // ── mindmap_hotspots ───────────────────────────────────────
  server.tool(
    'mindmap_hotspots',
    'Get the most frequently changed files and symbols in the codebase. ' +
      'Hot files are more likely to have bugs and benefit from closer review.',
    {
      limit: z.number().optional().describe('Number of hotspots to return (default: 15)'),
    },
    async (args) => {
      try {
        const hotspots = changelog.getHotspots(args.limit || 15);

        const result = hotspots.map(h => ({
          file: relative(config.projectRoot, h.filePath).replace(/\\/g, '/'),
          totalChanges: h.changeCount,
          lastChanged: new Date(h.lastChangedAt).toISOString(),
          hotSymbols: Object.entries(h.symbolChanges)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .slice(0, 5)
            .map(([name, count]) => ({ name, changes: count })),
        }));

        return mcpText(ok({ hotspots: result, tip: 'Files with high change frequency are more likely to contain bugs.' }, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Failed to get hotspots: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );
}
