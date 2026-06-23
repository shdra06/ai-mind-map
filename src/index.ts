#!/usr/bin/env node

/**
 * AI Mind Map — MCP Server Entry Point
 *
 * Creates the MCP server with stdio transport, registers all tools,
 * initialises ALL real subsystems (knowledge graph, change tracker,
 * persistent memory, context engine), and handles graceful shutdown.
 *
 * Usage:
 *   ai-mind-map [--project-root <path>] [--db-path <path>] [--log-level debug|info|warn|error]
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';

import { loadConfig, parseCliArgs } from './config.js';
import type { LogLevel } from './config.js';
import type {
  MindMapConfig,
  MindMapStats,
  ContextPackage,
  Memory,
  Decision,
  MemoryCategory,
  CompressionLevel,
  ContentType,
  GraphNode,
  GraphEdge,
  FileChange,
  NodeType,
  SessionSummary,
} from './types.js';

// ── Knowledge Graph ───────────────────────────────────────────
import { KnowledgeGraph } from './knowledge-graph/graph.js';
// Note: parser.ts exports functions (parseFile, parseFiles, etc.), not a class
import { Indexer } from './knowledge-graph/indexer.js';
import { PageRankEngine } from './knowledge-graph/pagerank.js';

// ── Change Tracker ────────────────────────────────────────────
import { FileWatcher } from './change-tracker/watcher.js';
import type { WatcherEvent } from './change-tracker/watcher.js';
import { DiffEngine } from './change-tracker/diff-engine.js';
import { ChangeLog } from './change-tracker/change-log.js';

// ── Memory ────────────────────────────────────────────────────
import { SessionMemory } from './memory/session-memory.js';
import { PersistentMemory } from './memory/persistent-memory.js';
import type { CreateMemoryInput } from './memory/persistent-memory.js';
import { DecisionLog } from './memory/decision-log.js';
import type { CreateDecisionInput } from './memory/decision-log.js';

// ── Context Engine ────────────────────────────────────────────
// compressor.ts exports functions: compress, detectContentType
import { compress as compressContent } from './context/compressor.js';
// progressive-disclosure.ts exports function: buildContextPackage
import { buildContextPackage } from './context/progressive-disclosure.js';
import type { ProjectInfo, Tier2Data, Tier3Data } from './context/progressive-disclosure.js';
import { TokenBudgetManager } from './context/token-budget.js';

// ── Utils ─────────────────────────────────────────────────────
import { Logger } from './utils/logger.js';
import { estimateTokens } from './utils/token-counter.js';

// ── Tools ─────────────────────────────────────────────────────
import { registerGraphTools } from './tools/graph-tools.js';
import type { IKnowledgeGraph, ITokenEstimator } from './tools/graph-tools.js';
import { registerChangeTools } from './tools/change-tools.js';
import type { IChangeTracker } from './tools/change-tools.js';
import { registerMemoryTools } from './tools/memory-tools.js';
import type { IMemoryStore, ISessionProvider } from './tools/memory-tools.js';
import { registerContextTools } from './tools/context-tools.js';
import type { IContextEngine, IIndexer } from './tools/context-tools.js';
import { registerDebugTools } from './tools/debug-tools.js';
import { registerFlowTools } from './tools/flow-tools.js';
import { registerSnapshotTools } from './tools/snapshot-tools.js';
import { registerSmartTools } from './tools/smart-tools.js';
import { registerEvolvingTools } from './tools/evolving-tools.js';

// ============================================================
// Logger — writes to stderr so MCP stdio is uncontaminated
// ============================================================

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLogLevel: number = LOG_LEVELS.info;

function setLogLevel(level: LogLevel): void {
  currentLogLevel = LOG_LEVELS[level];
}

function log(level: LogLevel, message: string, ...extra: unknown[]): void {
  if (LOG_LEVELS[level] < currentLogLevel) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (extra.length > 0) {
    process.stderr.write(`${prefix} ${message} ${JSON.stringify(extra)}\n`);
  } else {
    process.stderr.write(`${prefix} ${message}\n`);
  }
}

// ============================================================
// Adapters — Bridge real implementations to tool interfaces
// ============================================================

/**
 * Creates an adapter that satisfies IKnowledgeGraph from the real
 * KnowledgeGraph and PageRankEngine classes.
 *
 * Key API mappings:
 * - graph.search(query, limit) — FTS5 search, no type filter param
 * - graph.getProjectOverview() — returns Map<string, GraphNode[]>, no args
 * - graph.findCallers(nodeId) / graph.findCallees(nodeId) — single nodeId arg
 * - graph.getNodesByName(name) — returns GraphNode[]
 * - graph.getFileStructure(filePath) — returns GraphNode[]
 */
function createGraphAdapter(
  graph: KnowledgeGraph,
  pagerank: PageRankEngine,
): IKnowledgeGraph {
  return {
    search: (query: string, type?: NodeType, limit?: number): GraphNode[] => {
      const maxResults = limit ?? 20;
      let results = graph.search(query, maxResults);

      // Expand with learned search aliases
      try {
        const aliases = graph.getLearnedSearchAliases();
        const lowerQuery = query.toLowerCase();
        for (const alias of aliases) {
          if (alias.term.toLowerCase() === lowerQuery) {
            for (const alt of alias.aliases) {
              if (results.length >= maxResults) break;
              const aliasResults = graph.search(alt, Math.max(3, maxResults - results.length));
              const existingIds = new Set(results.map(r => r.id));
              for (const r of aliasResults) {
                if (!existingIds.has(r.id) && results.length < maxResults) {
                  results.push(r);
                  existingIds.add(r.id);
                }
              }
            }
            // Touch the alias to track usage
            try { graph.touchLearnedRule(alias.id); } catch {}
            break;
          }
        }
      } catch {
        // Learned rules table might not exist
      }

      if (type) {
        return results.filter((n: GraphNode) => n.type === type);
      }
      return results;
    },

    getStructure: (depth: number) => {
      // graph.getProjectOverview() returns Map<string, GraphNode[]>
      // We convert it to the shape expected by IKnowledgeGraph.getStructure
      const overview = graph.getProjectOverview();
      const files: { path: string; symbols: Pick<GraphNode, 'name' | 'type' | 'signature'>[] }[] = [];
      for (const [filePath, nodes] of overview) {
        files.push({
          path: filePath,
          symbols: nodes.map(n => ({
            name: n.name,
            type: n.type,
            signature: n.signature,
          })),
        });
      }
      // depth is accepted but getProjectOverview doesn't take a depth arg;
      // we can slice results if needed, but return all for now.
      return { files };
    },

    traceDependencies: (
      symbolName: string,
      direction: 'callers' | 'callees' | 'both',
      depth: number,
    ) => {
      const nodes = graph.getNodesByName(symbolName);
      if (nodes.length === 0) {
        return { root: symbolName, direction, depth, nodes: [], edges: [] };
      }
      const rootNode = nodes[0];
      let traced: GraphNode[] = [];

      // findCallers(nodeId) and findCallees(nodeId) each take a single string arg
      if (direction === 'callers' || direction === 'both') {
        traced = traced.concat(graph.findCallers(rootNode.id));
      }
      if (direction === 'callees' || direction === 'both') {
        traced = traced.concat(graph.findCallees(rootNode.id));
      }

      // Deduplicate
      const seen = new Set<string>();
      const unique = traced.filter(n => {
        if (seen.has(n.id)) return false;
        seen.add(n.id);
        return true;
      });

      // Collect relevant edges
      const edgeSet: GraphEdge[] = [];
      for (const n of unique) {
        const outEdges = graph.getOutEdges(n.id);
        const inEdges = graph.getInEdges(n.id);
        edgeSet.push(...outEdges, ...inEdges);
      }

      return {
        root: symbolName,
        direction,
        depth,
        nodes: unique,
        edges: edgeSet,
      };
    },

    getSignature: (symbolName: string, filePath?: string) => {
      const nodes = graph.getNodesByName(symbolName);
      let match: GraphNode | undefined;
      if (filePath) {
        match = nodes.find((n: GraphNode) => n.filePath === filePath);
      } else {
        match = nodes[0];
      }
      if (!match) return null;

      // Return the shape expected by IKnowledgeGraph.getSignature
      return {
        node: match,
        parameters: match.parameters,
        returnType: match.returnType,
        docComment: match.docComment,
      };
    },

    findReferences: (symbolName: string) => {
      const nodes = graph.getNodesByName(symbolName);
      if (nodes.length === 0) {
        return { symbol: symbolName, references: [] };
      }
      // Find all callers of the first matching node as "references"
      const callers = graph.findCallers(nodes[0].id);
      return {
        symbol: symbolName,
        references: callers.map((n: GraphNode) => ({
          filePath: n.filePath,
          line: n.startLine,
          context: n.signature,
        })),
      };
    },

    getFileMap: (filePath: string) => {
      const nodes = graph.getFileStructure(filePath);
      if (!nodes || nodes.length === 0) return null;
      return {
        filePath,
        symbols: nodes
          .filter(n => n.type !== 'file')
          .map(n => ({
            name: n.name,
            type: n.type,
            signature: n.signature,
            startLine: n.startLine,
            endLine: n.endLine,
            visibility: n.visibility,
            isExported: n.isExported,
          })),
      };
    },
  };
}

/**
 * Creates an adapter that satisfies IChangeTracker from the real
 * DiffEngine and ChangeLog classes.
 *
 * Key API mappings:
 * - changeLog.getLatestSession() — returns ChangeSession | null
 * - changeLog.queryChanges(options) — options has `since` (timestamp), not `afterTimestamp`
 * - changeLog.generateSessionSummary(sessionId) — returns string
 * - changeLog.recordChange(change) — records a FileChange
 */
function createChangeAdapter(
  diffEngine: DiffEngine,
  changeLog: ChangeLog,
  graph: KnowledgeGraph,
): IChangeTracker {
  return {
    getChanges: (since: string) => {
      try {
        const latestSession = changeLog.getLatestSession();
        const sinceTimestamp = since === 'last_session'
          ? (latestSession?.endedAt ?? Date.now() - 86400000)
          : since === 'today'
            ? new Date().setHours(0, 0, 0, 0)
            : since === 'this_week'
              ? Date.now() - 7 * 86400000
              : new Date(since).getTime();

        // ChangeLog.queryChanges uses ChangeQueryOptions with `since` field (timestamp)
        const changes = changeLog.queryChanges({
          since: sinceTimestamp,
        });

        return {
          since,
          resolvedTimestamp: sinceTimestamp,
          changes,
          totalFilesChanged: new Set(changes.map(c => c.filePath)).size,
          totalLinesAdded: changes.reduce((sum, c) => sum + c.linesAdded, 0),
          totalLinesRemoved: changes.reduce((sum, c) => sum + c.linesRemoved, 0),
          summary: changes.length > 0
            ? changes.map(c => `- ${c.filePath}: ${c.summary}`).join('\n')
            : 'No changes found since the specified time.',
        };
      } catch {
        return {
          since,
          resolvedTimestamp: Date.now(),
          changes: [],
          totalFilesChanged: 0,
          totalLinesAdded: 0,
          totalLinesRemoved: 0,
          summary: 'Unable to retrieve changes.',
        };
      }
    },

    getSessionDiff: () => {
      try {
        const latestSession = changeLog.getLatestSession();
        if (!latestSession) {
          return {
            previousSession: null,
            changes: [],
            affectedSymbols: [],
            summary: 'No previous session found.',
          };
        }
        const changes = changeLog.queryChanges({
          since: latestSession.endedAt ?? latestSession.startedAt,
        });
        const symbols = changes.flatMap(c => c.symbolsAffected);
        return {
          previousSession: latestSession,
          changes,
          affectedSymbols: [...new Set(symbols)],
          summary: changeLog.generateSessionSummary(latestSession.sessionId),
        };
      } catch {
        return {
          previousSession: null,
          changes: [],
          affectedSymbols: [],
          summary: 'Unable to compute session diff.',
        };
      }
    },

    analyseImpact: (params: { filePath?: string; symbolName?: string }) => {
      const target = params.filePath ?? params.symbolName ?? 'unknown';

      // Try to find the node and compute blast radius
      let directlyAffected: { node: GraphNode; relationship: string }[] = [];
      let transitivelyAffected: { node: GraphNode; depth: number }[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';

      try {
        if (params.symbolName) {
          const nodes = graph.getNodesByName(params.symbolName);
          if (nodes.length > 0) {
            const rootNode = nodes[0];
            const callers = graph.findCallers(rootNode.id);
            directlyAffected = callers.map(n => ({
              node: n,
              relationship: 'calls',
            }));

            const blastNodes = graph.blastRadius(rootNode.id, 3);
            transitivelyAffected = blastNodes.map((n, idx) => ({
              node: n,
              depth: Math.min(idx + 1, 3),
            }));

            const total = directlyAffected.length + transitivelyAffected.length;
            riskLevel = total > 20 ? 'high' : total > 5 ? 'medium' : 'low';
          }
        } else if (params.filePath) {
          const fileNodes = graph.getFileStructure(params.filePath);
          for (const node of fileNodes) {
            if (node.type === 'file') continue;
            const callers = graph.findCallers(node.id);
            for (const caller of callers) {
              directlyAffected.push({ node: caller, relationship: 'calls' });
            }
          }
          riskLevel = directlyAffected.length > 10 ? 'high'
            : directlyAffected.length > 3 ? 'medium' : 'low';
        }
      } catch {
        // Fall through with empty arrays
      }

      return {
        target,
        directlyAffected,
        transitivelyAffected,
        riskLevel,
        summary: directlyAffected.length > 0
          ? `${target}: ${directlyAffected.length} directly affected, ${transitivelyAffected.length} transitively affected. Risk: ${riskLevel}.`
          : `${target}: No dependents found. Use mindmap_trace_dependencies for full dependency chain.`,
      };
    },
  };
}

/**
 * Creates an adapter that satisfies IMemoryStore from PersistentMemory,
 * DecisionLog, and SessionMemory.
 *
 * Key API mappings:
 * - persistentMemory.queryMemories(query) — query uses MemoryQuery shape
 * - persistentMemory.createMemory(input) — input is CreateMemoryInput
 * - persistentMemory.getStats() — returns MemoryStats
 * - decisionLog.queryDecisions(query) — query uses DecisionQuery
 * - decisionLog.createDecision(input) — returns { decision, conflicts }
 * - decisionLog.getActiveDecisions() — returns Decision[]
 * - sessionMemory.listRecentSessions(limit) — returns SessionListItem[]
 */
function createMemoryAdapter(
  persistentMemory: PersistentMemory,
  decisionLog: DecisionLog,
  sessionMemory: SessionMemory,
): IMemoryStore {
  return {
    recall: (query: string, category?: MemoryCategory, limit?: number): Memory[] => {
      return persistentMemory.queryMemories({
        text: query,
        categories: category ? [category] : undefined,
        limit: limit ?? 10,
      });
    },

    remember: (params: {
      content: string;
      category: MemoryCategory;
      tags: string[];
      relatedFiles: string[];
      importance?: number;
      sessionId: string;
      source: 'agent' | 'user' | 'auto';
    }): Memory => {
      return persistentMemory.createMemory({
        category: params.category,
        content: params.content,
        importance: params.importance,
        tags: params.tags,
        relatedFiles: params.relatedFiles,
        sessionId: params.sessionId,
        source: params.source,
      });
    },

    getDecisions: (params: {
      status?: 'active' | 'all';
      query?: string;
    }): Decision[] => {
      if (params.query) {
        // Use DecisionLog.queryDecisions with text search
        const results = decisionLog.queryDecisions({
          text: params.query,
          status: params.status === 'all' ? undefined : (params.status ?? 'active'),
        });
        return results;
      }
      if (!params.status || params.status === 'active') {
        return decisionLog.getActiveDecisions();
      }
      // 'all' — query with no filters
      return decisionLog.queryDecisions({});
    },

    decide: (params: {
      title: string;
      description: string;
      rationale: string;
      alternatives: string[];
      consequences: string[];
      relatedFiles: string[];
      tags: string[];
      decidedBy: string;
    }): Decision => {
      // DecisionLog.createDecision returns { decision, conflicts }
      const result = decisionLog.createDecision({
        title: params.title,
        description: params.description,
        rationale: params.rationale,
        alternatives: params.alternatives,
        consequences: params.consequences,
        relatedFiles: params.relatedFiles,
        tags: params.tags,
        decidedBy: params.decidedBy,
      });
      return result.decision;
    },

    getSessionSummaries: (count: number): SessionSummary[] => {
      // sessionMemory.listRecentSessions returns SessionListItem[]
      // We need to return SessionSummary[], so we adapt
      const sessions = sessionMemory.listRecentSessions(count);
      return sessions.map(s => {
        // Try to get full session details if available
        const full = sessionMemory.getSession(s.sessionId);
        if (full) {
          return {
            sessionId: full.sessionId,
            startedAt: full.startedAt,
            endedAt: full.endedAt,
            tasksCompleted: full.tasksCompleted,
            filesModified: full.filesModified,
            decisionseMade: full.decisionseMade,
            memoriesCreated: full.memoriesCreated,
            tokensSaved: full.tokensSaved,
            summary: full.summary,
          };
        }
        // Fallback: return minimal SessionSummary from SessionListItem
        return {
          sessionId: s.sessionId,
          startedAt: s.startedAt,
          endedAt: s.endedAt ?? Date.now(),
          tasksCompleted: [],
          filesModified: [],
          decisionseMade: [],
          memoriesCreated: 0,
          tokensSaved: 0,
          summary: s.summary,
        };
      });
    },
  };
}

/**
 * Creates an adapter that satisfies ISessionProvider.
 * sessionMemory.getCurrentSessionId() returns string | null.
 * The interface expects string, so we provide a fallback.
 */
function createSessionAdapter(sessionMemory: SessionMemory): ISessionProvider {
  return {
    currentSessionId: (): string => {
      return sessionMemory.getCurrentSessionId() ?? 'no-session';
    },
  };
}

/**
 * Creates an adapter that satisfies IContextEngine.
 *
 * Key API mappings:
 * - compress(text, level, contentType) — module-level function from compressor.ts
 * - buildContextPackage(...) — module-level function from progressive-disclosure.ts
 */
function createContextAdapter(
  graph: KnowledgeGraph,
  persistentMemory: PersistentMemory,
  decisionLog: DecisionLog,
  changeLog: ChangeLog,
  config: MindMapConfig,
): IContextEngine {
  return {
    getContext: (params: {
      taskDescription: string;
      includeMemories: boolean;
      includeChanges: boolean;
    }): ContextPackage => {
      try {
        // Build ProjectInfo for Tier 1
        const overview = graph.getProjectOverview();
        const stats = graph.getStats();

        const directoryTree = Array.from(overview.keys())
          .slice(0, 20)
          .map(f => `  ${f}`)
          .join('\n');

        const projectInfo: ProjectInfo = {
          name: path.basename(config.projectRoot),
          description: params.taskDescription,
          techStack: Object.keys(stats.languageBreakdown),
          directoryTree,
          conventions: [],
          currentTask: params.taskDescription,
        };

        // Build Tier 2 data
        const tier2Data: Tier2Data = {};

        if (params.includeMemories) {
          tier2Data.memories = persistentMemory.queryMemories({
            text: params.taskDescription,
            limit: 5,
          });
          tier2Data.decisions = decisionLog.getActiveDecisions();
        }

        if (params.includeChanges) {
          tier2Data.recentChanges = changeLog.queryChanges({
            limit: 10,
          });
        }

        // Search graph for relevant nodes
        const graphNodes = graph.search(params.taskDescription, 10);
        if (graphNodes.length > 0) {
          tier2Data.graphNodes = graphNodes;
        }

        // Build context package
        const pkg = buildContextPackage(
          projectInfo,
          tier2Data,
          {}, // Tier 3 data — empty for initial load
          config.tokenBudgets,
          params.taskDescription,
        );
        return pkg;
      } catch {
        return {
          tier1: 'Project context loading failed.',
          tier2: '',
          tier3: '',
          totalTokens: 10,
          tokensSaved: 0,
          breakdown: [],
        };
      }
    },

    compress: (params: {
      content: string;
      contentType?: ContentType;
      level: CompressionLevel;
    }) => {
      // compress(text, level, contentType?) from compressor.ts
      // Returns CompressionResult { compressed, originalTokens, compressedTokens, ratio, contentType, level }
      const result = compressContent(params.content, params.level, params.contentType);
      return {
        original: params.content,
        compressed: result.compressed,
        originalTokens: result.originalTokens,
        compressedTokens: result.compressedTokens,
        ratio: result.ratio,
        contentType: result.contentType,
      };
    },
  };
}

/**
 * Creates an adapter that satisfies IIndexer.
 *
 * Key API mappings:
 * - indexer.fullIndex(onProgress?) — returns Promise<IndexStats>
 *   IndexStats has: filesScanned, filesParsed, filesSkipped, filesDeleted,
 *                   nodesCreated, edgesCreated, parseErrors, durationMs, languages
 * - graph.getStats() — returns { totalNodes, totalEdges, totalFiles, nodesByType, edgesByType, languageBreakdown }
 * - persistentMemory.getStats() — returns MemoryStats
 * - changeLog.getStats(topN?) — returns ChangeLogStats
 */
function createIndexerAdapter(
  indexer: Indexer,
  graph: KnowledgeGraph,
  persistentMemory: PersistentMemory,
  decisionLog: DecisionLog,
  changeLog: ChangeLog,
  config: MindMapConfig,
): IIndexer {
  return {
    reindex: async () => {
      const startTime = Date.now();
      try {
        const result = await indexer.fullIndex();
        return {
          filesScanned: result.filesScanned,
          filesIndexed: result.filesParsed,
          nodesCreated: result.nodesCreated,
          edgesCreated: result.edgesCreated,
          durationMs: result.durationMs,
          errors: result.parseErrors > 0
            ? [`${result.parseErrors} parse errors encountered`]
            : [],
        };
      } catch (err) {
        return {
          filesScanned: 0,
          filesIndexed: 0,
          nodesCreated: 0,
          edgesCreated: 0,
          durationMs: Date.now() - startTime,
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    },

    getStats: (): MindMapStats => {
      let dbSize = 0;
      try {
        if (existsSync(config.dbPath)) {
          dbSize = statSync(config.dbPath).size;
        }
      } catch {
        // ignore
      }

      const graphStats = graph.getStats();
      const memoryStats = persistentMemory.getStats();
      const changeStats = changeLog.getStats();

      // DecisionLog doesn't have a count() method; use queryDecisions
      const allDecisions = decisionLog.queryDecisions({});

      return {
        indexedFiles: graphStats.totalFiles,
        totalNodes: graphStats.totalNodes,
        totalEdges: graphStats.totalEdges,
        totalMemories: memoryStats.totalMemories,
        totalDecisions: allDecisions.length,
        totalChangesTracked: changeStats.totalChanges,
        lastIndexedAt: null, // Graph doesn't track this directly
        lastChangeAt: null,
        dbSizeBytes: dbSize,
        languageBreakdown: graphStats.languageBreakdown,
        tokensSavedEstimate: graphStats.totalNodes * 500,
      };
    },
  };
}

// ============================================================
// Ensure database directory exists
// ============================================================

function ensureDbDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log('info', `Created database directory: ${dir}`);
  }
}

// ============================================================
// Main entry point
// ============================================================

async function main(): Promise<void> {
  // ── 1. Parse CLI & load config ──────────────────────────────
  let cliArgs;
  try {
    cliArgs = parseCliArgs();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error parsing CLI arguments: ${msg}\n`);
    process.exit(1);
  }

  setLogLevel(cliArgs.logLevel);
  log('info', '🧠 AI Mind Map MCP Server starting…');

  let config: MindMapConfig;
  try {
    config = await loadConfig(cliArgs);
    log('info', `Project root: ${config.projectRoot}`);
    log('info', `Database path: ${config.dbPath}`);
    log('debug', 'Loaded config', config);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to load configuration: ${msg}`);
    process.exit(1);
  }

  // ── 2. Initialise database directory ────────────────────────
  try {
    ensureDbDirectory(config.dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to create DB directory: ${msg}`);
    process.exit(1);
  }

  // ── 3. Initialise SQLite database ──────────────────────────
  // KnowledgeGraph manages its own db connection, but ChangeLog,
  // SessionMemory, PersistentMemory, and DecisionLog each need
  // a shared Database instance for their tables.
  log('info', 'Initialising database…');
  let sharedDb: Database.Database;
  try {
    sharedDb = new Database(config.dbPath);
    sharedDb.pragma('journal_mode = WAL');
    sharedDb.pragma('foreign_keys = ON');
    sharedDb.pragma('busy_timeout = 5000');
    log('info', 'Database initialized with WAL mode');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to initialize database: ${msg}`);
    process.exit(1);
  }

  // ── 4. Initialise real subsystems ──────────────────────────
  log('info', 'Initialising subsystems…');

  // Knowledge Graph — constructor takes dbPath string
  const graph = new KnowledgeGraph(config.dbPath);
  // Indexer — constructor is Indexer(graph, config)
  const indexer = new Indexer(graph, config);
  // PageRankEngine — constructor is PageRankEngine(graph, config?)
  const pagerank = new PageRankEngine(graph);
  log('info', '✅ Knowledge Graph initialized');

  // Change Tracker
  // ChangeLog constructor takes ChangeLogConfig: { dbPath, retentionDays?, defaultSearchLimit? }
  const changeLog = new ChangeLog({ dbPath: config.dbPath });
  const diffEngine = new DiffEngine(config.projectRoot);
  let watcher: FileWatcher | null = null;

  // SessionMemory — must be created before watcher so it's available in the handler
  // SessionMemory constructor takes Database.Database instance
  const sessionMemory = new SessionMemory(sharedDb);
  const sessionId = sessionMemory.startSession();
  log('info', `Session started: ${sessionId}`);

  if (config.watchEnabled) {
    // FileWatcher constructor: config with { projectRoot, watchDebounceMs?, maxFileSize?, ignore? }
    watcher = new FileWatcher({
      projectRoot: config.projectRoot,
      ignore: config.ignore,
      watchDebounceMs: config.watchDebounceMs,
      maxFileSize: config.maxFileSize,
    });

    // FileWatcher emits 'changes' with WatcherEvent[]
    watcher.on('changes', async (events: WatcherEvent[]) => {
      log('debug', `File watcher detected ${events.length} changes`);
      for (const event of events) {
        try {
          if (event.changeType === 'deleted') {
            indexer.removeFile(event.filePath);
          } else {
            await indexer.indexFile(event.filePath);
          }
          const currentSessionId = sessionMemory.getCurrentSessionId() ?? 'no-session';
          changeLog.recordChange({
            filePath: event.filePath,
            changeType: event.changeType,
            summary: `File ${event.changeType}: ${path.basename(event.filePath)}`,
            symbolsAffected: [],
            linesAdded: 0,
            linesRemoved: 0,
            timestamp: event.timestamp,
            sessionId: currentSessionId,
          });
        } catch (err) {
          log('warn', `Failed to process file change: ${event.filePath}`, err);
        }
      }
      // Invalidate PageRank cache when graph changes
      pagerank.invalidateCache();
    });
  }
  log('info', `✅ Change Tracker initialized (watcher: ${config.watchEnabled ? 'enabled' : 'disabled'})`);

  // Memory
  // PersistentMemory constructor: (db, config?) where config is Pick<MindMapConfig['memory'], 'decayRate' | 'maxMemories' | 'importanceThreshold'>
  const persistentMemory = new PersistentMemory(sharedDb, {
    decayRate: config.memory.decayRate,
    maxMemories: config.memory.maxMemories,
    importanceThreshold: config.memory.importanceThreshold,
  });
  // DecisionLog constructor: (db, config?) where config is Pick<MindMapConfig['memory'], 'maxDecisions'>
  const decisionLog = new DecisionLog(sharedDb, {
    maxDecisions: config.memory.maxDecisions,
  });
  log('info', `✅ Memory initialized (session: ${sessionMemory.getCurrentSessionId()})`);

  // Context Engine — no class instances needed; uses module-level functions
  log('info', '✅ Context Engine initialized');

  // ── 5. Build adapters ──────────────────────────────────────
  const graphAdapter = createGraphAdapter(graph, pagerank);
  const changeAdapter = createChangeAdapter(diffEngine, changeLog, graph);
  const memoryAdapter = createMemoryAdapter(persistentMemory, decisionLog, sessionMemory);
  const sessionAdapter = createSessionAdapter(sessionMemory);
  const contextAdapter = createContextAdapter(
    graph, persistentMemory, decisionLog, changeLog, config,
  );
  const indexerAdapter = createIndexerAdapter(
    indexer, graph, persistentMemory, decisionLog, changeLog, config,
  );

  // Token estimator using the exported estimateTokens function
  const tokenEstimator: ITokenEstimator = {
    estimate: (text: string) => estimateTokens(text),
  };

  // ── 6. Create MCP server ──────────────────────────────────
  const server = new McpServer({
    name: 'ai-mind-map',
    version: '1.0.0',
  });

  // ── 7. Register all tools ─────────────────────────────────
  log('info', 'Registering MCP tools…');

  registerGraphTools(server, graphAdapter, tokenEstimator);
  log('debug', 'Registered graph tools (6)');

  registerChangeTools(server, changeAdapter, tokenEstimator);
  log('debug', 'Registered change tools (3)');

  registerMemoryTools(server, memoryAdapter, sessionAdapter, tokenEstimator);
  log('debug', 'Registered memory tools (5)');

  registerContextTools(server, contextAdapter, indexerAdapter, tokenEstimator);
  log('debug', 'Registered context tools (4)');

  registerDebugTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered debug tools (3)');

  registerFlowTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered flow tools (4)');

  registerSnapshotTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered snapshot tools (3)');

  registerSmartTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered smart tools (3)');

  registerEvolvingTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered evolving tools (3)');

  log('info', '🔧 All 41 MCP tools registered:');
  log('info', '  Graph:    mindmap_search, mindmap_get_structure, mindmap_trace_dependencies, mindmap_get_signature, mindmap_find_references, mindmap_get_file_map');
  log('info', '  Changes:  mindmap_what_changed, mindmap_session_diff, mindmap_impact_analysis');
  log('info', '  Memory:   mindmap_recall, mindmap_remember, mindmap_get_decisions, mindmap_decide, mindmap_session_summary');
  log('info', '  Context:  mindmap_get_context, mindmap_compress, mindmap_reindex, mindmap_status');
  log('info', '  Debug:    mindmap_debug_changes, mindmap_file_before, mindmap_file_history');
  log('info', '  Flow:     mindmap_trace_flow, mindmap_interaction_map, mindmap_classify_file, mindmap_layer_overview');
  log('info', '  Snapshot: mindmap_project_map, mindmap_change_delta, mindmap_session_start ⭐');
  log('info', '  Advanced: mindmap_query_graph, mindmap_dead_code, mindmap_architecture, mindmap_get_code_snippet, mindmap_search_code, mindmap_list_projects, mindmap_health');
  log('info', '  Smart:    mindmap_explain ⭐, mindmap_git_changes ⭐, mindmap_smart_search ⭐');
  log('info', '  Evolving: mindmap_teach ⭐, mindmap_get_learned, mindmap_forget');

  // ── 8. Auto-index on first run ─────────────────────────────
  const stats = graph.getStats();
  if (stats.totalNodes === 0) {
    log('info', '📋 No existing index found. Running initial codebase indexing…');
    try {
      const result = await indexer.fullIndex();
      log('info', `✅ Initial index complete: ${result.filesParsed} files, ${result.nodesCreated} nodes, ${result.edgesCreated} edges`);
      if (result.parseErrors > 0) {
        log('warn', `⚠️ ${result.parseErrors} parse errors (non-fatal)`);
      }
    } catch (err) {
      log('warn', `⚠️ Initial indexing failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('info', `📋 Existing index found: ${stats.totalNodes} nodes. Running incremental update…`);
    try {
      const result = await indexer.incrementalIndex();
      log('info', `✅ Incremental update: ${result.filesParsed} files reindexed`);
    } catch (err) {
      log('warn', `⚠️ Incremental update failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 9. Start file watcher ──────────────────────────────────
  if (watcher) {
    try {
      await watcher.start();
      log('info', '👁️ File watcher started');
    } catch (err) {
      log('warn', `⚠️ File watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 10. Graceful shutdown ──────────────────────────────────
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log('info', `Received ${signal}, shutting down gracefully…`);

    try {
      // Stop file watcher
      if (watcher) {
        await watcher.stop();
        log('debug', 'File watcher stopped');
      }

      // End current session
      try {
        sessionMemory.endSession();
        log('debug', 'Session ended');
      } catch {
        // Ignore session end errors
      }

      // Apply memory decay
      try {
        persistentMemory.applyDecay();
        log('debug', 'Memory decay applied');
      } catch {
        // Ignore decay errors
      }

      // Close change log database
      try {
        changeLog.close();
        log('debug', 'Change log closed');
      } catch {
        // Ignore close errors
      }

      // Close graph database
      try {
        graph.close();
        log('debug', 'Knowledge graph closed');
      } catch {
        // Ignore close errors
      }

      // Close shared database
      try {
        sharedDb.close();
        log('debug', 'Shared database closed');
      } catch {
        // Ignore close errors
      }

      log('info', '✅ Cleanup complete. Goodbye!');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', `Error during shutdown: ${msg}`);
    }

    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (err) => {
    log('error', `Uncaught exception: ${err.message}`, err.stack);
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log('error', `Unhandled rejection: ${msg}`);
  });

  // ── 11. Connect transport and start serving ────────────────
  log('info', 'Connecting stdio transport…');

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('info', '🧠 AI Mind Map MCP Server is LIVE. Waiting for requests…');
    log('info', `   Project: ${config.projectRoot}`);
    log('info', `   Database: ${config.dbPath}`);
    log('info', `   Session: ${sessionMemory.getCurrentSessionId()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to start MCP server: ${msg}`);
    process.exit(1);
  }
}

// ── Kick off ────────────────────────────────────────────────
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});
