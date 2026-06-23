/**
 * AI Mind Map — Snapshot & Delta MCP Tools
 *
 * The most important tools in the entire system for token savings.
 * These replace the need to read the full codebase at session start.
 *
 * mindmap_project_map   → THE map. One call = entire project understood.
 * mindmap_change_delta  → Only what changed since last time.
 * mindmap_session_kickoff → Everything combined: map + delta + memories.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig } from '../types.js';

import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import { SnapshotEngine } from '../knowledge-graph/snapshot.js';

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

export function registerSnapshotTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  const engine = new SnapshotEngine(graph, config);

  // ── mindmap_project_map ───────────────────────────────────
  server.tool(
    'mindmap_project_map',
    `🗺️ THE PROJECT MAP. Returns a compact representation of the ENTIRE project 
in ~1500-3000 tokens instead of 50,000+. Contains:
- Every file with its symbols (functions, classes, types)
- Architecture layer classification (UI, service, controller, DB, etc.)
- Entry points (main files, routes)
- Most-connected symbols (hotspots)
- Token savings report

THIS IS THE #1 TOKEN SAVER. Call this ONCE at the start of any session 
instead of reading the whole codebase.`,
    {},
    async () => {
      try {
        const snapshot = engine.generateSnapshot();

        return mcpText(ok({
          projectMap: snapshot.fileMap,
          layers: snapshot.layers,
          entryPoints: snapshot.entryPoints,
          hotspots: snapshot.hotspots,
          stats: snapshot.stats,
          tokenSavings: snapshot.tokenCost,
        }, estimator, snapshot.tokenCost.saved));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`project_map failed: ${msg}`));
      }
    },
  );

  // ── mindmap_change_delta ──────────────────────────────────
  server.tool(
    'mindmap_change_delta',
    `🔄 CHANGE DELTA. Shows ONLY what changed since the last session or a given time.
Instead of re-reading the whole project, the AI gets a compact list of:
- Which files were added/modified/deleted
- Which symbols were affected in each file
- New symbols that were created
- Hot files (most changed)

Use this at session start AFTER mindmap_project_map to understand the current state.`,
    {
      since: z
        .union([
          z.enum(['last_session', 'today', 'this_week', '1h', '3h', '6h', '12h', '24h']),
          z.string().datetime(),
        ])
        .default('last_session')
        .describe('How far back to look'),
    },
    async ({ since }) => {
      try {
        const timestamp = resolveTimestamp(since);
        const delta = await engine.generateChangeDelta(timestamp, since);

        return mcpText(ok(delta, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`change_delta failed: ${msg}`));
      }
    },
  );

  // ── mindmap_session_kickoff ─────────────────────────────────
  server.tool(
    'mindmap_session_kickoff',
    `🚀 SESSION START — the SINGLE most important tool call.
Returns EVERYTHING the AI needs to start working in ONE call:
1. Complete project map (all files + symbols)
2. Change delta (what changed since last session)
3. Stored memories (important facts from previous sessions)

Call this ONCE at the very beginning of every conversation.
This single call replaces reading the entire codebase.
Typical cost: ~2000-4000 tokens vs 50,000+ for full read.`,
    {
      since: z
        .union([
          z.enum(['last_session', 'today', 'this_week', '1h', '3h', '6h', '12h', '24h']),
          z.string().datetime(),
        ])
        .default('last_session')
        .describe('How far back to look for changes'),
    },
    async ({ since }) => {
      try {
        const timestamp = resolveTimestamp(since);
        const preamble = await engine.generatePreamble(timestamp);

        return mcpText(ok({
          projectMap: preamble.projectMap,
          changeDelta: preamble.changeDelta,
          memories: preamble.memories,
          tokenCost: preamble.tokenCost,
          tip: 'You now have full project context. Use mindmap_trace_flow, mindmap_get_code_snippet, or mindmap_debug_changes for specific tasks.',
        }, estimator, Math.max(0, 50000 - preamble.tokenCost)));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`session_start failed: ${msg}`));
      }
    },
  );
}

// ============================================================
// Utilities
// ============================================================

function resolveTimestamp(since: string): number {
  const now = Date.now();
  switch (since) {
    case 'last_session': return now - 4 * 60 * 60 * 1000;
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    case 'this_week': {
      const d = new Date(); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    case '1h': return now - 1 * 3600000;
    case '3h': return now - 3 * 3600000;
    case '6h': return now - 6 * 3600000;
    case '12h': return now - 12 * 3600000;
    case '24h': return now - 24 * 3600000;
    default: return new Date(since).getTime();
  }
}
