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
import { relative, resolve } from 'node:path';
import type { KnowledgeGraph } from '../knowledge-graph/graph.js';
import type { ChangelogEngine } from '../knowledge-graph/changelog.js';
import type { MindMapConfig } from '../types.js';
import type { ITokenEstimator } from './advanced-tools.js';
import type { PersistentMemory } from '../memory/persistent-memory.js';

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
  persistentMemory?: PersistentMemory,
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
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
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

        // Include relevant memories for context
        if (persistentMemory) {
          try {
            const memories = persistentMemory.queryMemories({
              text: config.projectRoot,
              limit: 5,
              minImportance: 0.3,
            });
            if (memories && memories.length > 0) {
              result.relevantMemories = memories.map(m => ({
                category: m.category,
                content: m.content,
                importance: m.importance,
              }));
            }
          } catch { /* non-fatal */ }
        }

        // CRITICAL: If index is empty, tell the AI to index first
        if (stats.totalNodes === 0) {
          result._indexRequired = true;
          result._action = 'Call mindmap_set_project({ projectPath: "<USER_WORKSPACE_PATH>" }) to instantly load existing index. ' +
            'If it returns NEEDS_INDEX, then call mindmap_reindex with the project path. ' +
            'After setup, call mindmap_session_resume again for full project context.';
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
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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

        // Auto-create memories from significant session changes
        if (persistentMemory && changes && changes.length > 0) {
          try {
            if (args.summary) {
              persistentMemory.createMemory({
                content: `Session: ${args.summary}. Files modified: ${currentSession.filesModified.length}`,
                category: 'context',
                importance: 0.6,
                tags: ['auto-session', 'changes'],
              });
            }
          } catch { /* non-fatal */ }
        }

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
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
            : resolve(config.projectRoot, args.file);
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
        const limit = args.limit || 15;
        const hotspots = changelog.getHotspots(limit);

        if (hotspots.length > 0) {
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
        }

        // Fallback: use graph degree centrality when no changelog data
        const allNodes = graph.getAllNodes().filter(n => n.type !== 'file');
        const nodeDegrees: { node: typeof allNodes[0]; degree: number }[] = [];

        for (const node of allNodes) {
          const inEdges = graph.getInEdges(node.id);
          const outEdges = graph.getOutEdges(node.id);
          nodeDegrees.push({ node, degree: inEdges.length + outEdges.length });
        }

        nodeDegrees.sort((a, b) => b.degree - a.degree);
        const topNodes = nodeDegrees.slice(0, limit);

        // Group by file
        const fileMap = new Map<string, { degree: number; symbols: { name: string; type: string; degree: number }[] }>();
        for (const { node, degree } of topNodes) {
          const relPath = relative(config.projectRoot, node.filePath).replace(/\\/g, '/') || node.filePath;
          if (!fileMap.has(relPath)) {
            fileMap.set(relPath, { degree: 0, symbols: [] });
          }
          const entry = fileMap.get(relPath)!;
          entry.degree += degree;
          entry.symbols.push({ name: node.name, type: node.type, degree });
        }

        const fallbackResult = Array.from(fileMap.entries())
          .sort(([, a], [, b]) => b.degree - a.degree)
          .slice(0, limit)
          .map(([file, info]) => ({
            file,
            totalChanges: 0,
            connectivity: info.degree,
            hotSymbols: info.symbols
              .sort((a, b) => b.degree - a.degree)
              .slice(0, 5)
              .map(s => ({ name: s.name, type: s.type, connections: s.degree })),
          }));

        return mcpText(ok({
          hotspots: fallbackResult,
          source: 'graph-degree-centrality',
          tip: 'No change history available. Showing most connected symbols by graph degree centrality instead.',
        }, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Failed to get hotspots: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  // ── mindmap_verify_changes ─────────────────────────────────
  server.tool(
    'mindmap_verify_changes',
    'Verify what actually changed in files after editing them. ' +
      'Re-parses the specified files and compares with the stored index to show ' +
      'exactly which functions/classes were added, modified, or deleted. ' +
      'Use this INSTEAD of re-reading files to verify your edits took effect. ' +
      'Also updates the index with the new file state.',
    {
      files: z.array(z.string()).describe(
        'List of file paths (absolute or relative to project root) to verify'
      ),
    },
    async ({ files }) => {
      try {
        const { parseFile: parse } = await import('../knowledge-graph/parser.js');
        const { resolve, relative: rel } = await import('node:path');

        const results: Array<{
          file: string;
          status: 'modified' | 'added' | 'unchanged' | 'deleted' | 'error';
          symbolChanges?: {
            added: string[];
            modified: string[];
            deleted: string[];
          };
          error?: string;
        }> = [];

        for (const filePath of files) {
          // Resolve relative paths against project root
          const absPath = resolve(config.projectRoot, filePath);
          const relPath = rel(config.projectRoot, absPath).replace(/\\/g, '/');

          try {
            // Get old nodes from graph
            const oldNodes = graph.getNodesForFile(absPath);

            // Re-parse the file
            const parseResult = await parse(absPath);

            if (!parseResult || parseResult.nodes.length === 0) {
              if (oldNodes.length > 0) {
                // File was deleted or emptied
                results.push({
                  file: relPath,
                  status: 'deleted',
                  symbolChanges: {
                    added: [],
                    modified: [],
                    deleted: oldNodes
                      .filter(n => n.type !== 'file')
                      .map(n => `${n.type} ${n.name}`),
                  },
                });
              } else {
                results.push({ file: relPath, status: 'unchanged' });
              }
              continue;
            }

            // Build name→signature maps for comparison
            const oldMap = new Map(
              oldNodes
                .filter(n => n.type !== 'file')
                .map(n => [n.name, { type: n.type, signature: n.signature || '' }])
            );
            const newMap = new Map(
              parseResult.nodes
                .filter(n => n.type !== 'file')
                .map(n => [n.name, { type: n.type, signature: n.signature || '' }])
            );

            const added: string[] = [];
            const modified: string[] = [];
            const deleted: string[] = [];

            // Find added and modified
            for (const [name, info] of newMap) {
              const old = oldMap.get(name);
              if (!old) {
                added.push(`${info.type} ${name}`);
              } else if (old.signature !== info.signature) {
                modified.push(`${info.type} ${name} (signature changed)`);
              }
            }

            // Find deleted
            for (const [name, info] of oldMap) {
              if (!newMap.has(name)) {
                deleted.push(`${info.type} ${name}`);
              }
            }

            // Determine status
            let status: 'modified' | 'added' | 'unchanged' = 'unchanged';
            if (oldNodes.length === 0 && parseResult.nodes.length > 0) {
              status = 'added';
            } else if (added.length > 0 || modified.length > 0 || deleted.length > 0) {
              status = 'modified';
            }

            // Update the graph with new data
            graph.replaceFileData(absPath, parseResult.nodes, parseResult.edges);

            results.push({
              file: relPath,
              status,
              symbolChanges: { added, modified, deleted },
            });

          } catch (err) {
            results.push({
              file: relPath,
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const totalChanges = results.reduce((sum, r) =>
          sum + (r.symbolChanges
            ? r.symbolChanges.added.length + r.symbolChanges.modified.length + r.symbolChanges.deleted.length
            : 0), 0);

        return mcpText(ok({
          verified: true,
          filesChecked: files.length,
          totalSymbolChanges: totalChanges,
          files: results,
          message: totalChanges > 0
            ? ` Verified ${files.length} file(s): ${totalChanges} symbol-level changes detected and index updated.`
            : ` Verified ${files.length} file(s): no symbol-level changes detected.`,
        }, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`verify_changes failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );
}
