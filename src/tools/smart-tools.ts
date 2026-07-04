/**
 * AI Mind Map — Smart MCP Tools
 *
 * The "never read files again" toolkit. These tools aggregate multiple
 * data sources into single, rich responses so the AI never needs to
 * chain tool calls or fall back to reading raw files.
 *
 * Tools:
 *   - mindmap_explain     — Complete intelligence on any symbol in 1 call
 *   - mindmap_git_changes — Git-aware symbol-level change detection
 *   - mindmap_smart_search — Rich contextual search with full details
 */

import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig, GraphNode, GraphEdge } from '../types.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import { FlowAnalyzer } from '../knowledge-graph/flow-analyzer.js';
import type { SemanticSearchEngine } from '../knowledge-graph/semantic-search.js';

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

/**
 * Safe git command execution. Returns stdout or null on failure.
 */
function gitExec(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// ============================================================
// Registration
// ============================================================

/**
 * Register Smart tools — the "never read files" toolkit.
 */
export function registerSmartTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
  semanticEngine?: SemanticSearchEngine,
): void {

  // Create FlowAnalyzer once and reuse across all tool handlers
  const flowAnalyzer = new FlowAnalyzer(graph, config.projectRoot);

  // ── mindmap_explain ──────────────────────────────────────────
  server.tool(
    'mindmap_explain',
    'Get full details about a symbol: signature, callers, callees, and layer.',
    {
      symbol: z.string().describe('Symbol name to explain (function, class, method, etc.)'),
      filePath: z.string().optional().describe('Optional file path to disambiguate'),
      depth: z.number().int().min(1).max(5).default(2).describe('Depth for dependency tracing (default: 2)'),
    },
    async ({ symbol, filePath, depth }) => {
      try {
        // 1. Find the symbol
        let candidates = graph.getNodesByName(symbol);
        if (candidates.length === 0) {
          const searchResults = graph.search(symbol, 10);
          candidates = searchResults.filter(
            n => n.name === symbol ||
              n.qualifiedName === symbol ||
              n.qualifiedName.endsWith(`.${symbol}`) ||
              n.name.toLowerCase() === symbol.toLowerCase(),
          );
          if (candidates.length === 0) {
            candidates = searchResults.slice(0, 3); // fallback to top search results
          }
        }

        // Filter by file if specified
        if (filePath && candidates.length > 1) {
          const filtered = candidates.filter(
            n => n.filePath === filePath || n.filePath.endsWith(filePath),
          );
          if (filtered.length > 0) candidates = filtered;
        }

        if (candidates.length === 0) {
          return mcpErrorText(fail(`Symbol not found: "${symbol}". Try mindmap_search for fuzzy matching.`, 'Ensure the project is indexed via mindmap_set_project'));
        }

        const node = candidates[0]!;
        const relPath = relative(config.projectRoot, node.filePath);

        // 2. Get callers and callees
        const callers = graph.findCallers(node.id).map(n => ({
          name: n.name,
          qualifiedName: n.qualifiedName,
          type: n.type,
          file: relative(config.projectRoot, n.filePath),
          line: n.startLine,
          signature: n.signature,
        }));

        const callees = graph.findCallees(node.id).map(n => ({
          name: n.name,
          qualifiedName: n.qualifiedName,
          type: n.type,
          file: relative(config.projectRoot, n.filePath),
          line: n.startLine,
          signature: n.signature,
        }));

        // 3. Classify layer with confidence
        const absPath = resolve(config.projectRoot, node.filePath);
        const classification = flowAnalyzer.getFileClassification(absPath);

        // 4. Blast radius
        const blastNodes = graph.blastRadius(node.id, depth);
        const blastRadius = {
          directlyAffected: callers.length,
          transitivelyAffected: blastNodes.length,
          riskLevel: blastNodes.length > 20 ? 'critical' as const
            : blastNodes.length > 10 ? 'high' as const
            : blastNodes.length > 3 ? 'medium' as const
            : 'low' as const,
          affectedFiles: [...new Set(blastNodes.map(n => relative(config.projectRoot, n.filePath)))].slice(0, 10),
        };

        // 5. Related symbols (same file, same class)
        const sameFileSymbols = graph.getFileStructure(node.filePath)
          .filter(n => n.type !== 'file' && n.id !== node.id)
          .map(n => ({
            name: n.name,
            type: n.type,
            signature: n.signature,
            reason: 'same file',
          }))
          .slice(0, 10);

        // 6. Git history for this symbol's file
        let gitInfo: {
          lastModified?: string;
          lastAuthor?: string;
          recentCommits?: string[];
        } = {};
        try {
          const absFilePath = resolve(config.projectRoot, node.filePath);
          const lastLog = gitExec(
            ['log', '-1', '--format=%ai|||%an|||%s', '--', absFilePath],
            config.projectRoot,
          );
          if (lastLog) {
            const [date, author, message] = lastLog.split('|||');
            gitInfo.lastModified = date;
            gitInfo.lastAuthor = author;

            const recentLogs = gitExec(
              ['log', '-5', '--format=%h %s', '--', absFilePath],
              config.projectRoot,
            );
            if (recentLogs) {
              gitInfo.recentCommits = recentLogs.split('\n').filter(Boolean);
            }
          }
        } catch {
          // Not a git repo or git not available
        }

        // 7. Other matches (for disambiguation)
        const otherMatches = candidates.length > 1
          ? candidates.slice(1).map(n => ({
              name: n.qualifiedName,
              file: relative(config.projectRoot, n.filePath),
              line: n.startLine,
              type: n.type,
            }))
          : undefined;

        // 8. Estimate tokens saved
        let tokensSaved = 0;
        try {
          const fullFile = readFileSync(resolve(config.projectRoot, node.filePath), 'utf-8');
          tokensSaved = estimator.estimate(fullFile) - 50; // reading the whole file vs this response
        } catch {}

        const result = {
          // Core identity
          symbol: {
            name: node.name,
            qualifiedName: node.qualifiedName,
            type: node.type,
            file: relPath,
            line: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            docComment: node.docComment || undefined,
            visibility: node.visibility,
            isExported: node.isExported,
            isAsync: node.isAsync,
            parameters: node.parameters,
            returnType: node.returnType,
          },
          // Architecture
          layer: classification.layer,
          layerConfidence: classification.confidence,
          layerRunnerUp: classification.runnerUp,
          // Dependencies
          callers: callers.slice(0, 15),
          callees: callees.slice(0, 15),
          callerCount: callers.length,
          calleeCount: callees.length,
          // Impact
          blastRadius,
          // Related code
          relatedSymbols: sameFileSymbols,
          // Git
          git: Object.keys(gitInfo).length > 0 ? gitInfo : undefined,
          // Disambiguation
          otherMatches,
        };

        return mcpText(okWithSavings(result, Math.max(0, tokensSaved), estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpErrorText(fail(`explain failed: ${msg}`, 'Ensure the project is indexed via mindmap_set_project'));
      }
    },
  );

  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  // ── mindmap_git_changes ──────────────────────────────────────
  server.tool(
    'mindmap_git_changes',
    'Git-aware change detection with SYMBOL-LEVEL diffs. Shows which functions/classes ' +
      'were added, modified, or deleted — not just file names. Also maps each changed ' +
      'symbol to its callers to show the impact of recent changes.',
    {
      scope: z.enum([
        'uncommitted',    // git diff (working tree vs HEAD)
        'staged',         // git diff --cached
        'last_commit',    // git diff HEAD~1..HEAD
        'last_3_commits', // git diff HEAD~3..HEAD
        'last_5_commits', // git diff HEAD~5..HEAD
        'branch',         // git diff main..HEAD (or master)
      ]).default('uncommitted').describe('What range of changes to analyze'),
    },
    async ({ scope }) => {
      try {
        // Build git diff arguments based on scope
        let diffArgs: string[];
        let descr: string;

        switch (scope) {
          case 'uncommitted':
            diffArgs = ['diff', '--numstat', 'HEAD'];
            descr = 'Uncommitted changes vs HEAD';
            break;
          case 'staged':
            diffArgs = ['diff', '--cached', '--numstat'];
            descr = 'Staged changes';
            break;
          case 'last_commit':
            diffArgs = ['diff', '--numstat', 'HEAD~1..HEAD'];
            descr = 'Last commit';
            break;
          case 'last_3_commits':
            diffArgs = ['diff', '--numstat', 'HEAD~3..HEAD'];
            descr = 'Last 3 commits';
            break;
          case 'last_5_commits':
            diffArgs = ['diff', '--numstat', 'HEAD~5..HEAD'];
            descr = 'Last 5 commits';
            break;
          case 'branch': {
            // Detect main/master branch
            let defaultBranchRef = gitExec(
              ['symbolic-ref', 'refs/remotes/origin/HEAD'],
              config.projectRoot,
            );
            if (!defaultBranchRef) {
              defaultBranchRef = 'refs/remotes/origin/main';
            }
            const defaultBranch = defaultBranchRef.replace('refs/remotes/origin/', '') || 'main';
            diffArgs = ['diff', '--numstat', `${defaultBranch}..HEAD`];
            descr = `Branch changes vs ${defaultBranch}`;
            break;
          }
        }

        // Get file-level numstat
        const numstat = gitExec(diffArgs, config.projectRoot);
        if (!numstat) {
          return mcpText(ok({
            scope,
            description: descr,
            changedFiles: [],
            changedSymbols: [],
            impactedCallers: [],
            summary: 'No changes found (or not a git repository)',
          }, estimator));
        }

        // Parse numstat: "added\tremoved\tfile"
        const changedFiles: {
          file: string;
          insertions: number;
          deletions: number;
        }[] = [];

        for (const line of numstat.split('\n')) {
          if (!line.trim()) continue;
          const [added, removed, file] = line.split('\t');
          if (file) {
            changedFiles.push({
              file,
              insertions: parseInt(added ?? '0', 10) || 0,
              deletions: parseInt(removed ?? '0', 10) || 0,
            });
          }
        }

        // Map changed files to changed SYMBOLS
        const changedSymbols: {
          name: string;
          qualifiedName: string;
          type: string;
          file: string;
          line: number;
          changeType: 'modified' | 'in_modified_file';
        }[] = [];

        const impactedCallers: {
          name: string;
          file: string;
          line: number;
          reason: string;
        }[] = [];

        const seenCallers = new Set<string>();

        for (const cf of changedFiles) {
          // Look up symbols in this file from our index
          let fileNodes = graph.getFileStructure(cf.file);
          if (fileNodes.length === 0) {
            // Try with absolute path
            const absPath = resolve(config.projectRoot, cf.file);
            fileNodes = graph.getFileStructure(absPath);
            if (fileNodes.length === 0) continue;
          }

          const symbols = fileNodes.filter(n => n.type !== 'file');

          for (const sym of symbols) {
            changedSymbols.push({
              name: sym.name,
              qualifiedName: sym.qualifiedName,
              type: sym.type,
              file: cf.file,
              line: sym.startLine,
              changeType: 'in_modified_file',
            });

            // Find callers of changed symbols
            const callers = graph.findCallers(sym.id);
            for (const caller of callers) {
              const callerRel = relative(config.projectRoot, caller.filePath);
              const key = `${caller.name}@${callerRel}`;
              if (!seenCallers.has(key)) {
                seenCallers.add(key);
                impactedCallers.push({
                  name: caller.name,
                  file: callerRel,
                  line: caller.startLine,
                  reason: `calls ${sym.name} (changed in ${cf.file})`,
                });
              }
            }
          }
        }

        // Get commit messages for context
        let recentCommits: string[] = [];
        if (scope !== 'uncommitted' && scope !== 'staged') {
          const n = scope === 'last_commit' ? 1 : scope === 'last_3_commits' ? 3 : 5;
          const log = gitExec(
            ['log', `-${n}`, '--format=%h %an: %s', '--no-merges'],
            config.projectRoot,
          );
          if (log) {
            recentCommits = log.split('\n').filter(Boolean);
          }
        }

        const result = {
          scope,
          description: descr,
          changedFiles: changedFiles.slice(0, 50),
          totalFilesChanged: changedFiles.length,
          totalInsertions: changedFiles.reduce((s, f) => s + f.insertions, 0),
          totalDeletions: changedFiles.reduce((s, f) => s + f.deletions, 0),
          changedSymbols: changedSymbols.slice(0, 50),
          totalChangedSymbols: changedSymbols.length,
          impactedCallers: impactedCallers.slice(0, 30),
          totalImpactedCallers: impactedCallers.length,
          recentCommits: recentCommits.length > 0 ? recentCommits : undefined,
          riskLevel: impactedCallers.length > 20 ? 'high'
            : impactedCallers.length > 5 ? 'medium'
            : 'low',
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`git_changes failed: ${msg}`));
      }
    },
  );
  } */

  // ── mindmap_smart_search ─────────────────────────────────────
  server.tool(
    'mindmap_smart_search',
    'Rich contextual search returning full details for each result.',
    {
      query: z.string().describe('Search query (name, keyword, or free text)'),
      limit: z.number().int().min(1).max(20).default(5).describe('Max results (default 5, keep small for rich data)'),
      mode: z.enum(['keyword', 'semantic', 'hybrid']).default('hybrid').describe(
        'Search mode: keyword (exact FTS5 matching), semantic (TF-IDF concept matching), '
        + 'or hybrid (both merged, best of both worlds). Default: hybrid.'
      ),
      include: z.array(z.enum([
        'signature',    // function signature (always included)
        'doc',          // doc comment
        'callers',      // who calls this
        'callees',      // what this calls
        'layer',        // architecture layer + confidence
        'code',         // actual source code lines
        'git',          // git history
      ])).default(['signature', 'doc', 'callers', 'layer']).describe('What to include in each result'),
    },
    async ({ query, limit, mode, include }) => {
      try {
        // ── Hybrid/Semantic/Keyword search routing ───────────
        let searchResults: GraphNode[] = [];
        const semanticScores = new Map<string, number>();
        let synonymsExpanded: string[] = [];

        if (mode === 'keyword' || !semanticEngine) {
          // Pure keyword search (existing behavior)
          searchResults = graph.search(query, limit);
        } else if (mode === 'semantic') {
          // Pure semantic search
          const semResults = semanticEngine.search(query, limit);
          synonymsExpanded = semResults[0]?.expandedSynonyms ?? [];
          for (const sr of semResults) {
            const node = graph.getNode(sr.nodeId);
            if (node) {
              searchResults.push(node);
              semanticScores.set(sr.nodeId, sr.score);
            }
          }
        } else {
          // Hybrid: merge keyword + semantic results
          const keywordResults = graph.search(query, limit);
          const semResults = semanticEngine.search(query, limit);
          synonymsExpanded = semResults[0]?.expandedSynonyms ?? [];

          // Build merged set (keyword results first, then semantic-only results)
          const seen = new Set<string>();
          for (const node of keywordResults) {
            seen.add(node.id);
            searchResults.push(node);
          }
          for (const sr of semResults) {
            semanticScores.set(sr.nodeId, sr.score);
            if (!seen.has(sr.nodeId)) {
              const node = graph.getNode(sr.nodeId);
              if (node) {
                seen.add(sr.nodeId);
                searchResults.push(node);
              }
            }
          }

          // Trim to limit
          searchResults = searchResults.slice(0, limit);
        }
        if (searchResults.length === 0) {
          return mcpText(ok({
            query,
            results: [],
            totalResults: 0,
            message: 'No results found. Try a broader query.',
          }, estimator));
        }

        let totalTokensSaved = 0;

        const results = searchResults.map(node => {
          const relPath = relative(config.projectRoot, node.filePath);

          // Base result — always included
          const result: Record<string, unknown> = {
            name: node.name,
            qualifiedName: node.qualifiedName,
            type: node.type,
            file: relPath,
            line: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            visibility: node.visibility,
            isExported: node.isExported,
          };

          // Semantic score (only present in semantic/hybrid modes)
          const semScore = semanticScores.get(node.id);
          if (semScore !== undefined) {
            result.semanticScore = Math.round(semScore * 1000) / 1000;
          }

          // Optional: doc comment
          if (include.includes('doc') && node.docComment) {
            result.docComment = node.docComment;
          }

          // Optional: callers
          if (include.includes('callers')) {
            const callers = graph.findCallers(node.id);
            result.callers = callers.slice(0, 8).map(c => ({
              name: c.name,
              file: relative(config.projectRoot, c.filePath),
              line: c.startLine,
            }));
            result.callerCount = callers.length;
          }

          // Optional: callees
          if (include.includes('callees')) {
            const callees = graph.findCallees(node.id);
            result.callees = callees.slice(0, 8).map(c => ({
              name: c.name,
              file: relative(config.projectRoot, c.filePath),
              line: c.startLine,
            }));
            result.calleeCount = callees.length;
          }

          // Optional: layer classification
          if (include.includes('layer')) {
            try {
              const absPath = resolve(config.projectRoot, node.filePath);
              const cls = flowAnalyzer.getFileClassification(absPath);
              result.layer = cls.layer;
              result.layerConfidence = cls.confidence;
            } catch {
              result.layer = 'unknown';
            }
          }

          // Optional: source code
          if (include.includes('code')) {
            try {
              const absPath = resolve(config.projectRoot, node.filePath);
              const content = readFileSync(absPath, 'utf-8');
              const lines = content.split('\n');
              const start = Math.max(0, node.startLine - 1);
              const end = Math.min(lines.length, node.endLine + 1);
              const codeLines = lines.slice(start, end);
              result.code = codeLines.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
              totalTokensSaved += estimator.estimate(content) - estimator.estimate(result.code as string);
            } catch {
              // Can't read file
            }
          }

          // Optional: git info
          if (include.includes('git')) {
            const absPath = resolve(config.projectRoot, node.filePath);
            const lastLog = gitExec(
              ['log', '-1', '--format=%ar by %an: %s', '--', absPath],
              config.projectRoot,
            );
            if (lastLog) {
              result.gitLastChange = lastLog;
            }
          }

          // Parameters and return type if available
          if (node.parameters && node.parameters.length > 0) {
            result.parameters = node.parameters;
          }
          if (node.returnType) {
            result.returnType = node.returnType;
          }

          return result;
        });

        const response = {
          query,
          results,
          totalResults: results.length,
          includes: include,
          searchMode: mode,
          synonymsExpanded: synonymsExpanded.length > 0 ? synonymsExpanded : undefined,
        };

        return mcpText(okWithSavings(response, Math.max(0, totalTokensSaved), estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpErrorText(fail(`smart_search failed: ${msg}`, 'Ensure the project is indexed via mindmap_set_project'));
      }
    },
  );
}
