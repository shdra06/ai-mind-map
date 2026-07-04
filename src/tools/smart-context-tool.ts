/**
 * AI Mind Map — Smart Context Tool
 *
 * Replaces 10+ tool calls with 1. Given symbols or a task description,
 * returns all relevant context the AI needs to start coding immediately.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig } from '../types.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import type { ChangelogEngine } from '../knowledge-graph/changelog.js';

// ============================================================
// Token Estimation Interface
// ============================================================

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
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

function ok(data: unknown, estimator: ITokenEstimator, saved = 0): ToolResult {
  const s = JSON.stringify(data);
  return { success: true, data, tokenCount: estimator.estimate(s), tokensSaved: saved };
}

function fail(msg: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message: msg };
}

// ============================================================
// Registration
// ============================================================

export function registerSmartContextTools(
  server: McpServer,
  graph: KnowledgeGraph,
  changelog: ChangelogEngine,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  server.tool(
    'mindmap_get_context',
    'Get ALL context needed to work on a task in ONE call. ' +
      'Instead of reading multiple files and searching, this returns: ' +
      'relevant code snippets, call chains, related types (base classes, interfaces), ' +
      'recent changes, and configuration — everything the AI needs to start coding immediately. ' +
      'USE THIS instead of reading files one by one.',
    {
      symbols: z.array(z.string()).min(1).describe(
        'Symbol names to get context for (function names, class names, variable names)',
      ),
      task: z.string().optional().describe(
        'Brief description of what you need to do (helps prioritize context)',
      ),
      maxTokens: z.number().default(6000).describe(
        'Max tokens for the response (default 6000)',
      ),
    },
    async ({ symbols, task, maxTokens }) => {
      try {
        const result: Record<string, unknown> = {};
        const allRelatedNodeIds = new Set<string>();
        let tokenBudget = maxTokens;

        // 1. Find all nodes matching the requested symbols
        const matchedNodes: Array<{
          name: string;
          type: string;
          file: string;
          line: number;
          signature: string;
          snippet?: string;
          nodeId: string;
        }> = [];

        for (const sym of symbols) {
          // Search by name (exact + fuzzy)
          const nodes = graph.search(sym, 10);
          for (const node of nodes) {
            const relPath = relative(config.projectRoot, node.filePath).replace(/\\/g, '/');

            // Read the actual code snippet (compact)
            let snippet: string | undefined;
            try {
              const lines = readFileSync(node.filePath, 'utf-8').split('\n');
              const start = Math.max(0, node.startLine - 1);
              const end = Math.min(lines.length, node.endLine);
              const codeLines = lines.slice(start, end);
              // Truncate very long functions
              if (codeLines.length > 40) {
                snippet = [
                  ...codeLines.slice(0, 35),
                  '  // ... (truncated)',
                  ...codeLines.slice(-3),
                ].join('\n');
              } else {
                snippet = codeLines.join('\n');
              }
            } catch { /* file might not exist */ }

            matchedNodes.push({
              name: node.qualifiedName || node.name,
              type: node.type,
              file: relPath,
              line: node.startLine,
              signature: node.signature,
              snippet,
              nodeId: node.id,
            });
            allRelatedNodeIds.add(node.id);
          }
        }

        if (matchedNodes.length === 0) {
          return mcpText(fail(
            `No symbols found matching: ${symbols.join(', ')}. ` +
            'Try mindmap_smart_search for broader search.',
          ));
        }

        result.symbols = matchedNodes;
        tokenBudget -= estimator.estimate(JSON.stringify(matchedNodes));

        // 2. Get call chain (who calls these, what they call)
        if (tokenBudget > 500) {
          const callChains: Array<{ symbol: string; callers: string[]; callees: string[] }> = [];
          for (const node of matchedNodes.slice(0, 5)) { // limit to first 5
            const callers = graph.getInEdges(node.nodeId)
              .filter(e => e.type === 'calls')
              .map(e => {
                const src = graph.getNode(e.sourceId);
                return src
                  ? `${src.name} (${relative(config.projectRoot, src.filePath).replace(/\\/g, '/')})`
                  : e.sourceId;
              });
            const callees = graph.getOutEdges(node.nodeId)
              .filter(e => e.type === 'calls')
              .map(e => {
                const tgt = graph.getNode(e.targetId);
                return tgt
                  ? `${tgt.name} (${relative(config.projectRoot, tgt.filePath).replace(/\\/g, '/')})`
                  : e.targetId;
              });
            if (callers.length > 0 || callees.length > 0) {
              callChains.push({ symbol: node.name, callers, callees });
            }
          }
          if (callChains.length > 0) {
            result.callChains = callChains;
            tokenBudget -= estimator.estimate(JSON.stringify(callChains));
          }
        }

        // 3. Get related types (base classes, interfaces, siblings)
        if (tokenBudget > 500) {
          const relatedTypes: Array<{
            symbol: string;
            relation: string;
            name: string;
            file: string;
            signature: string;
          }> = [];

          for (const node of matchedNodes.slice(0, 5)) {
            // Inherits (parent classes)
            const inheritsEdges = graph.getOutEdges(node.nodeId).filter(e => e.type === 'inherits');
            for (const edge of inheritsEdges) {
              const target = graph.getNode(edge.targetId);
              if (target) {
                relatedTypes.push({
                  symbol: node.name,
                  relation: 'extends',
                  name: target.qualifiedName || target.name,
                  file: relative(config.projectRoot, target.filePath).replace(/\\/g, '/'),
                  signature: target.signature,
                });
              }
            }
            // Implements (interfaces)
            const implEdges = graph.getOutEdges(node.nodeId).filter(e => e.type === 'implements');
            for (const edge of implEdges) {
              const target = graph.getNode(edge.targetId);
              if (target) {
                relatedTypes.push({
                  symbol: node.name,
                  relation: 'implements',
                  name: target.qualifiedName || target.name,
                  file: relative(config.projectRoot, target.filePath).replace(/\\/g, '/'),
                  signature: target.signature,
                });
              }
            }
            // Contains (class members)
            const containsEdges = graph.getOutEdges(node.nodeId).filter(e => e.type === 'contains');
            for (const edge of containsEdges.slice(0, 10)) {
              const child = graph.getNode(edge.targetId);
              if (child && child.type !== 'file') {
                relatedTypes.push({
                  symbol: node.name,
                  relation: 'contains',
                  name: child.name,
                  file: relative(config.projectRoot, child.filePath).replace(/\\/g, '/'),
                  signature: child.signature,
                });
              }
            }
          }
          if (relatedTypes.length > 0) {
            result.relatedTypes = relatedTypes;
            tokenBudget -= estimator.estimate(JSON.stringify(relatedTypes));
          }
        }

        // 4. Recent changes to these symbols
        if (tokenBudget > 300) {
          try {
            const recentChanges = changelog.getChangesSince(Date.now() - 7 * 24 * 3600_000);
            const relevantChanges = recentChanges.files.filter(f =>
              matchedNodes.some(n => {
                const absFile = resolve(config.projectRoot, n.file);
                return f.filePath === absFile || f.filePath === n.file;
              }),
            );
            if (relevantChanges.length > 0) {
              result.recentChanges = relevantChanges.map(f => ({
                file: relative(config.projectRoot, f.filePath).replace(/\\/g, '/'),
                added: f.added.map(a => `+ ${a.type} ${a.name}`),
                modified: f.modified.map(m => `~ ${m.type} ${m.name}`),
                deleted: f.deleted.map(d => `- ${d.type} ${d.name}`),
              }));
            }
          } catch { /* changelog may not have data */ }
        }

        // 5. Count tokens saved
        const tokensSaved = matchedNodes.reduce((sum, n) => {
          // Each file read typically costs 500-2000 tokens
          return sum + (n.snippet ? estimator.estimate(n.snippet) + 200 : 500);
        }, 0);

        result._meta = {
          symbolsFound: matchedNodes.length,
          filesInvolved: [...new Set(matchedNodes.map(n => n.file))].length,
          tokensSaved: `~${tokensSaved} tokens saved vs reading ${matchedNodes.length} files individually`,
        };

        return mcpText(ok(result, estimator, tokensSaved));
      } catch (err: unknown) {
        return mcpText(fail(`get_context failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );
}
