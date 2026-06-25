#!/usr/bin/env node

/**
 * AI Mind Map â€” MCP Server Entry Point
 *
 * Creates the MCP server with stdio transport, registers all tools,
 * initialises ALL real subsystems (knowledge graph, change tracker,
 * persistent memory, context engine), and handles graceful shutdown.
 *
 * Usage:
 *   ai-mind-map [--project-root <path>] [--db-path <path>] [--log-level debug|info|warn|error]
 */

import { existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// â”€â”€ Knowledge Graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { KnowledgeGraph } from './knowledge-graph/graph.js';
// Note: parser.ts exports functions (parseFile, parseFiles, etc.), not a class
import { Indexer } from './knowledge-graph/indexer.js';
import { PageRankEngine } from './knowledge-graph/pagerank.js';

// â”€â”€ Change Tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { FileWatcher } from './change-tracker/watcher.js';
import type { WatcherEvent } from './change-tracker/watcher.js';
import { DiffEngine } from './change-tracker/diff-engine.js';
import { ChangeLog } from './change-tracker/change-log.js';

// â”€â”€ Memory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { SessionMemory } from './memory/session-memory.js';
import { PersistentMemory } from './memory/persistent-memory.js';
import type { CreateMemoryInput } from './memory/persistent-memory.js';
import { DecisionLog } from './memory/decision-log.js';
import type { CreateDecisionInput } from './memory/decision-log.js';
import { syncSharedContext } from './memory/shared-sync.js';

// â”€â”€ Context Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// compressor.ts exports functions: compress, detectContentType
import { compress as compressContent } from './context/compressor.js';
// progressive-disclosure.ts exports function: buildContextPackage
import { buildContextPackage } from './context/progressive-disclosure.js';
import type { ProjectInfo, Tier2Data, Tier3Data } from './context/progressive-disclosure.js';
import { TokenBudgetManager } from './context/token-budget.js';

// â”€â”€ Utils â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { Logger } from './utils/logger.js';
import { estimateTokens } from './utils/token-counter.js';

// â”€â”€ Tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
import { registerAdvancedTools } from './tools/advanced-tools.js';
import { registerSemanticTools } from './tools/semantic-tools.js';
import { SemanticSearchEngine } from './knowledge-graph/semantic-search.js';
import { ChangelogEngine } from './knowledge-graph/changelog.js';
import { registerSessionTools } from './tools/session-tools.js';
import { registerDigestTools } from './tools/digest-tools.js';
import { registerExploreTools } from './tools/explore-tools.js';
import { registerFilesystemTools } from './tools/filesystem-tools.js';


// Read version from package.json dynamically
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

// ============================================================
// Logger â€” writes to stderr so MCP stdio is uncontaminated
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
// Adapters â€” Bridge real implementations to tool interfaces
// ============================================================

/**
 * Creates an adapter that satisfies IKnowledgeGraph from the real
 * KnowledgeGraph and PageRankEngine classes.
 *
 * Key API mappings:
 * - graph.search(query, limit) â€” FTS5 search, no type filter param
 * - graph.getProjectOverview() â€” returns Map<string, GraphNode[]>, no args
 * - graph.findCallers(nodeId) / graph.findCallees(nodeId) â€” single nodeId arg
 * - graph.getNodesByName(name) â€” returns GraphNode[]
 * - graph.getFileStructure(filePath) â€” returns GraphNode[]
 */
function createGraphAdapter(
  graph: KnowledgeGraph,
  pagerank: PageRankEngine,
  config: MindMapConfig,
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
      // graph.getProjectOverview() returns { overview, totalNodes, isTruncated }
      // We convert it to the shape expected by IKnowledgeGraph.getStructure
      const { overview } = graph.getProjectOverview();
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
        // No node found — try text-based fallback
        const textRefs: { filePath: string; line: number; context: string }[] = [];
        const indexedFiles = graph.getIndexedFiles();
        // Cap text search to first 50 files to avoid blocking
        const filesToSearch = indexedFiles.slice(0, 50);
        for (const file of filesToSearch) {
          if (textRefs.length >= 20) break;
          try {
            const absPath = path.resolve(config.projectRoot, file);
            const content = readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (textRefs.length >= 20) break;
              if (lines[i].includes(symbolName)) {
                textRefs.push({
                  filePath: file,
                  line: i + 1,
                  context: lines[i].trim(),
                });
              }
            }
          } catch {
            continue;
          }
        }
        return { symbol: symbolName, references: textRefs, fallback: 'text' as const };
      }
      // Find all callers of the first matching node as "references"
      const callers = graph.findCallers(nodes[0].id);
      if (callers.length === 0) {
        // Graph edges empty — try text-based fallback
        const textRefs: { filePath: string; line: number; context: string }[] = [];
        const indexedFiles = graph.getIndexedFiles();
        // Cap text search to first 50 files to avoid blocking
        const filesToSearch = indexedFiles.slice(0, 50);
        for (const file of filesToSearch) {
          if (textRefs.length >= 20) break;
          try {
            const absPath = path.resolve(config.projectRoot, file);
            const content = readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (textRefs.length >= 20) break;
              if (lines[i].includes(symbolName)) {
                textRefs.push({
                  filePath: file,
                  line: i + 1,
                  context: lines[i].trim(),
                });
              }
            }
          } catch {
            continue;
          }
        }
        return { symbol: symbolName, references: textRefs, fallback: 'text' as const };
      }
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
      // Try the raw path first
      let nodes = graph.getFileStructure(filePath);

      // If no results and path looks relative, resolve against projectRoot
      if ((!nodes || nodes.length === 0) && !path.isAbsolute(filePath)) {
        const resolved = path.resolve(config.projectRoot, filePath);
        nodes = graph.getFileStructure(resolved);

        // Try with normalized separators
        if (!nodes || nodes.length === 0) {
          const withForward = resolved.replace(/\\/g, '/');
          nodes = graph.getFileStructure(withForward);
        }
        if (!nodes || nodes.length === 0) {
          const withBack = resolved.replace(/\//g, '\\');
          nodes = graph.getFileStructure(withBack);
        }
      }

      // Try case-insensitive match against indexed files
      if (!nodes || nodes.length === 0) {
        const indexedFiles = graph.getIndexedFiles();
        const lowerPath = filePath.toLowerCase().replace(/\\/g, '/');
        const match = indexedFiles.find(f =>
          f.toLowerCase().replace(/\\/g, '/') === lowerPath ||
          f.toLowerCase().replace(/\\/g, '/').endsWith('/' + lowerPath) ||
          f.toLowerCase().replace(/\\/g, '/') === lowerPath.replace(/^\.\//, '')
        );
        if (match) {
          nodes = graph.getFileStructure(match);
        }
      }

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
 * - changeLog.getLatestSession() â€” returns ChangeSession | null
 * - changeLog.queryChanges(options) â€” options has `since` (timestamp), not `afterTimestamp`
 * - changeLog.generateSessionSummary(sessionId) â€” returns string
 * - changeLog.recordChange(change) â€” records a FileChange
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
 * - persistentMemory.queryMemories(query) â€” query uses MemoryQuery shape
 * - persistentMemory.createMemory(input) â€” input is CreateMemoryInput
 * - persistentMemory.getStats() â€” returns MemoryStats
 * - decisionLog.queryDecisions(query) â€” query uses DecisionQuery
 * - decisionLog.createDecision(input) â€” returns { decision, conflicts }
 * - decisionLog.getActiveDecisions() â€” returns Decision[]
 * - sessionMemory.listRecentSessions(limit) â€” returns SessionListItem[]
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
      // 'all' â€” query with no filters
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
            decisionsMade: full.decisionsMade,
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
          decisionsMade: [],
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
 * - compress(text, level, contentType) â€” module-level function from compressor.ts
 * - buildContextPackage(...) â€” module-level function from progressive-disclosure.ts
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
        const { overview } = graph.getProjectOverview();
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
          {}, // Tier 3 data â€” empty for initial load
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
  watcher?: { addRoot(root: string): void } | null,
  onProjectSwitch?: () => void,
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

    reindexProject: async (projectPath: string) => {
      const startTime = Date.now();
      const resolvedPath = path.resolve(projectPath);
      try {
        // Re-target the indexer to the new project
        indexer.setProjectRoot(resolvedPath);
        log('info', `ðŸ“ Re-targeted to project: ${resolvedPath}`);

        // Also watch the new project directory for changes
        if (watcher) {
          watcher.addRoot(resolvedPath);
          log('info', `ðŸ‘ï¸ File watcher now also watching: ${resolvedPath}`);
        }

        // Run full index on the new project (don't clear â€” multi-project)
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
          projectRoot: resolvedPath,
        };
      } catch (err) {
        return {
          filesScanned: 0,
          filesIndexed: 0,
          nodesCreated: 0,
          edgesCreated: 0,
          durationMs: Date.now() - startTime,
          errors: [err instanceof Error ? err.message : String(err)],
          projectRoot: resolvedPath,
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
        projectRoot: config.projectRoot,
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
        // L17: Conservative estimate — avg ~200 tokens per node (signatures + metadata)
        tokensSavedEstimate: graphStats.totalNodes * 200,
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
// Session Token Tracker
// ============================================================

/**
 * Tracks cumulative token usage across all tool calls in a session.
 * Every tool response is enriched with `_sessionTokens` metadata
 * so AI agents always know their token footprint.
 */
class SessionTokenTracker {
  totalToolCalls = 0;
  totalOutputTokens = 0;
  totalInputTokens = 0;
  totalTokensSaved = 0;
  private startTime = Date.now();

  /** Record a tool call with its input and output token counts. */
  record(inputTokens: number, outputTokens: number, tokensSaved: number): void {
    this.totalToolCalls++;
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalTokensSaved += tokensSaved;
  }

  /** Get a summary object to include in every tool response. */
  getSummary() {
    return {
      totalToolCalls: this.totalToolCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalTokensSaved: this.totalTokensSaved,
      sessionDurationMs: Date.now() - this.startTime,
    };
  }
}

/**
 * Directories that should NEVER be indexed â€” IDE install dirs, tool dirs, etc.
 */
const BLOCKED_DIRECTORY_PATTERNS = [
  'antigravity', '.gemini', '.cursor', '.vscode-server',
  'program files', 'programdata', 'appdata',
  'node_modules', '.npm', '.yarn',
  'system32', 'windows',
];

/** Check if a path is a known IDE/tool directory that should never be indexed */
function isBlockedDirectory(dirPath: string): boolean {
  const segments = dirPath.toLowerCase().replace(/\\/g, '/').split('/');
  return BLOCKED_DIRECTORY_PATTERNS.some(pattern =>
    segments.some(seg => seg === pattern)
  );
}

/**
 * Intercept an MCP tool response to inject session token metadata.
 *
 * Parses the JSON text content, adds `_sessionTokens` and optionally
 * `_hint` fields, then re-serialises. This works because all our tools
 * return `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`.
 */
function enrichToolResponse(
  response: { content: Array<{ type: string; text: string }> },
  tracker: SessionTokenTracker,
  estimator: { estimate(text: string): number },
  graphNodeCount: () => number,
  getProjectInfo: () => { root: string; indexedFiles: number; totalNodes: number },
  inputTokens: number = 0,
): { content: Array<{ type: string; text: string }> } {
  if (!response?.content || response.content.length === 0) return response;

  // H8: Process the LAST text block, not just content[0]
  let textIdx = -1;
  for (let i = response.content.length - 1; i >= 0; i--) {
    if (response.content[i]?.type === 'text' && response.content[i]?.text) {
      textIdx = i;
      break;
    }
  }
  if (textIdx === -1) return response;

  try {
    const text = response.content[textIdx].text;

    // Fast path: if it looks like a JSON object, use string concat to avoid parse/stringify overhead
    if (text.startsWith('{') && text.endsWith('}')) {
      const outputTokens = estimator.estimate(text);
      // Extract tokensSaved from the raw text if present
      const tokensSavedMatch = text.match(/"tokensSaved"\s*:\s*(\d+)/);
      const tokensSaved = tokensSavedMatch ? parseInt(tokensSavedMatch[1], 10) : 0;
      tracker.record(inputTokens, outputTokens, tokensSaved);

      const projectInfo = getProjectInfo();
      const nodeCount = graphNodeCount();
      const rootIsBlocked = isBlockedDirectory(projectInfo.root);

      // Build the suffix metadata
      const meta: Record<string, unknown> = {
        _project: projectInfo,
        _sessionTokens: tracker.getSummary(),
      };

      if (nodeCount === 0 || rootIsBlocked) {
        meta._indexRequired = true;
        meta._action = 'REQUIRED: Call mindmap_reindex({ projectPath: "<USER_WORKSPACE_PATH>" }). ' +
          'The current root "' + projectInfo.root + '" is NOT a user project. ' +
          'Use the workspace/project directory that the user has open in their editor. ' +
          'IMPORTANT: Before calling reindex, tell the user: "Indexing your project for the first time. ' +
          'This builds a full knowledge graph of all functions, classes, and relationships. ' +
          'It takes about 30-90 seconds on the first run, but after that all tools respond instantly."';
      }

      const suffix = JSON.stringify(meta);
      // Remove closing } from text, append suffix properties, close
      response.content[textIdx].text = text.slice(0, -1) + ',' + suffix.slice(1);
    } else {
      // Fallback: parse and re-stringify for non-object responses
      const result = JSON.parse(text);

    // Estimate tokens for this response
    const outputTokens = estimator.estimate(response.content[textIdx].text);
    const tokensSaved = result.tokensSaved ?? 0;

    // Record in tracker (inputTokens passed from caller)
    tracker.record(inputTokens, outputTokens, tokensSaved);

    // Always add project metadata
    const projectInfo = getProjectInfo();
    result._project = projectInfo;

    // ALWAYS tell the agent to provide project path if no real project is indexed
    const nodeCount = graphNodeCount();
    const rootIsBlocked = isBlockedDirectory(projectInfo.root);

    if (nodeCount === 0 || rootIsBlocked) {
      result._indexRequired = true;
      result._action = 'REQUIRED: Call mindmap_reindex({ projectPath: "<USER_WORKSPACE_PATH>" }). ' +
        'The current root "' + projectInfo.root + '" is NOT a user project. ' +
        'Use the workspace/project directory that the user has open in their editor. ' +
        'IMPORTANT: Before calling reindex, tell the user: "Indexing your project for the first time. ' +
        'This builds a full knowledge graph of all functions, classes, and relationships. ' +
        'It takes about 30-90 seconds on the first run, but after that all tools respond instantly."';
    }

    // Always add session token metadata
    result._sessionTokens = tracker.getSummary();

    response.content[textIdx].text = JSON.stringify(result);
    }
  } catch {
    // If parsing fails, return original response unchanged
  }

  return response;
}

// ============================================================
// Main entry point
// ============================================================

async function main(): Promise<void> {
  // â”€â”€ 1. Parse CLI & load config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let cliArgs;
  try {
    cliArgs = parseCliArgs();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error parsing CLI arguments: ${msg}\n`);
    process.exit(1);
  }

  setLogLevel(cliArgs.logLevel);
  log('info', 'ðŸ§  AI Mind Map MCP Server startingâ€¦');

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

  // â”€â”€ 2. Initialise database directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  try {
    ensureDbDirectory(config.dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to create DB directory: ${msg}`);
    process.exit(1);
  }

  // â”€â”€ 3. Initialise SQLite database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // KnowledgeGraph manages its own db connection, but ChangeLog,
  // SessionMemory, PersistentMemory, and DecisionLog each need
  // a shared Database instance for their tables.
  log('info', 'Initialising databaseâ€¦');
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

  // â”€â”€ 4. Initialise real subsystems â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  log('info', 'Initialising subsystemsâ€¦');

  // Knowledge Graph â€” constructor takes dbPath string
  const graph = new KnowledgeGraph(config.dbPath);
  // Indexer â€” constructor is Indexer(graph, config)
  const indexer = new Indexer(graph, config);
  // PageRankEngine â€” constructor is PageRankEngine(graph, config?)
  const pagerank = new PageRankEngine(graph);

  // Changelog Engine â€” node-level change tracking (v1.4.0)
  const changelogEngine = new ChangelogEngine(graph.getDb());
  indexer.setChangelog(changelogEngine);
  log('info', 'âœ… Knowledge Graph initialized (with changelog engine)');

  // Change Tracker
  // ChangeLog constructor takes ChangeLogConfig: { dbPath, retentionDays?, defaultSearchLimit? }
  const changeLog = new ChangeLog({ dbPath: config.dbPath });
  const diffEngine = new DiffEngine(config.projectRoot);
  let watcher: FileWatcher | null = null;

  // SessionMemory â€” must be created before watcher so it's available in the handler
  // SessionMemory constructor takes Database.Database instance
  const sessionMemory = new SessionMemory(sharedDb);
  const sessionId = sessionMemory.startSession();
  log('info', `Session started: ${sessionId}`);

  if (config.watchEnabled && !config.memoryOnly) {
    // FileWatcher constructor: config with { projectRoot, watchDebounceMs?, maxFileSize?, ignore? }
    watcher = new FileWatcher({
      projectRoot: config.projectRoot,
      ignore: config.ignore,
      watchDebounceMs: config.watchDebounceMs,
      maxFileSize: config.maxFileSize,
    });

    // Wire watcher to indexer so fullIndex() can pause/resume it
    indexer.setWatcher(watcher);

    // FileWatcher emits 'changes' with WatcherEvent[]
    watcher.on('changes', async (events: WatcherEvent[]) => {
      log('debug', `File watcher detected ${events.length} changes`);
      for (const event of events) {
        try {
          if (event.changeType === 'deleted') {
            await indexer.removeFile(event.filePath);
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
  log('info', `âœ… Change Tracker initialized (watcher: ${config.watchEnabled ? 'enabled' : 'disabled'})`);

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
  log('info', `âœ… Memory initialized (session: ${sessionMemory.getCurrentSessionId()})`);

  // Apply memory decay on startup
  try {
    const decayed = persistentMemory.applyDecay();
    log('info', `Applied time-based memory decay at startup (${decayed} memories decayed)`);
  } catch (err) {
    log('warn', 'Failed to apply memory decay at startup', err);
  }


  // Context Engine â€” no class instances needed; uses module-level functions
  log('info', 'âœ… Context Engine initialized');

  // â”€â”€ 5. Build adapters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const graphAdapter = createGraphAdapter(graph, pagerank, config);
  const changeAdapter = createChangeAdapter(diffEngine, changeLog, graph);
  const memoryAdapter = createMemoryAdapter(persistentMemory, decisionLog, sessionMemory);
  const sessionAdapter = createSessionAdapter(sessionMemory);
  const contextAdapter = createContextAdapter(
    graph, persistentMemory, decisionLog, changeLog, config,
  );
  // Mutable ref for semantic engine (created later, wired via callback)
  let _semanticEngineRef: { clear(): void } | null = null;
  const indexerAdapter = createIndexerAdapter(
    indexer, graph, persistentMemory, decisionLog, changeLog, config, watcher,
    () => { _semanticEngineRef?.clear(); },
  );

  // Token estimator using the exported estimateTokens function
  const tokenEstimator: ITokenEstimator = {
    estimate: (text: string) => estimateTokens(text),
  };

  // â”€â”€ 6. Create MCP server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const server = new McpServer(
    {
      name: 'ai-mind-map',
      version: pkg.version,
    },
    {
      instructions: [
        '# AI Mind Map — Code Memory Engine',
        '',
        '## ⚠ CRITICAL: FIRST STEP IN EVERY CONVERSATION',
        'Before calling ANY other tool, you MUST ensure a project is indexed:',
        '1. Check if `_indexRequired: true` appears in any response — if so, the index is empty or pointing at an IDE directory.',
        '2. Call `mindmap_reindex({ projectPath: "<WORKSPACE>" })` where <WORKSPACE> is the user project directory from their open editor.',
        '3. NEVER use paths containing: .gemini, antigravity, .cursor, .vscode, AppData, Program Files — these are IDE directories, NOT projects.',
        '4. Example: `mindmap_reindex({ projectPath: "E:\\myproject" })`',
        '',
        '## After Indexing - Resume Session:',
        'Call `mindmap_session_resume`. It returns:',
        '- What the previous AI worked on',
        '- What code changed since then (function-level diffs)',
        '- Project structure + tech stack',
        '- Hot files (most frequently changed)',
        '',
        '## Token Tracking:',
        'Every response includes `_sessionTokens` with cumulative usage.',
        '',
        '##  Tool Selection Guide:',
        '',
        '### When you need to UNDERSTAND the project:',
        '- `mindmap_digest` → Full project summary in <2000 tokens',
        '- `mindmap_architecture` → Layers, patterns, component overview',
        '- `mindmap_file_digest` → Understand a file WITHOUT reading it',
        '',
        '### When you need to FIND code:',
        '- `mindmap_smart_search` → Search by name/concept (best for most lookups)',
        '- `mindmap_semantic_search` → Search by meaning ("authentication", "error handling")',
        '- `mindmap_search_code` → Grep-like text search in code bodies',
        '- `mindmap_trace_dependencies` → Who calls X? What does X call?',
        '',
        '### When you need to READ code:',
        '- `mindmap_get_code_snippet` â†’ Read actual source code for a function/class',
        '- `mindmap_get_file_map` â†’ All symbols in a file with signatures + line ranges',
        '',
        '### When you need to know WHAT CHANGED:',
        '- `mindmap_changelog` â†’ Symbol-level diffs (added/modified/deleted functions)',
        '- `mindmap_git_changes` â†’ Git-aware changes with symbol mapping',
        '- `mindmap_verify` â†’ Check if your cached knowledge is still valid',
        '- `mindmap_hotspots` â†’ Most frequently changed files + symbols',
        '',
        '### When you need to REMEMBER:',
        '- `mindmap_remember` â†’ Save a fact/convention for future sessions',
        '- `mindmap_recall` â†’ Retrieve relevant memories for current task',
        '- `mindmap_decide` â†’ Record architectural decisions with rationale',
        '',
        '### When you finish work:',
        '- `mindmap_session_end` â†’ Save summary so next AI can resume instantly',
        '',
        '### After editing code:',
        '- `mindmap_verify_changes` â†’ Verify your edits at the symbol level WITHOUT re-reading files',
        '',
        '## âš¡ Token-Saving Rules:',
        '1. ALWAYS call `mindmap_session_resume` first â€” never start blind',
        '2. Use `mindmap_file_digest` BEFORE reading a full file â€” you may not need the full file',
        '3. Use `mindmap_verify_changes` after editing to verify changes â€” do NOT re-read whole files',
        '4. Use `mindmap_changelog` instead of re-reading files to see what changed',
        '5. Call `mindmap_session_end` when done â€” save context for next session',
      ].join('\n'),
    },
  );

  // â”€â”€ 7. Register all tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  log('info', 'Registering MCP toolsâ€¦');

  // â”€â”€ 7.0 Token tracking middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Wrap every tool handler to inject session token metadata
  const tokenTracker = new SessionTokenTracker();
  const originalToolFn = server.tool.bind(server) as Function;

  // Fix 4: Cache graph.getStats() with 5-second TTL to avoid calling it twice per response
  let cachedStats: { data: ReturnType<typeof graph.getStats>; timestamp: number } | null = null;
  function getCachedStats() {
    const now = Date.now();
    if (!cachedStats || now - cachedStats.timestamp > 5000) {
      cachedStats = { data: graph.getStats(), timestamp: now };
    }
    return cachedStats.data;
  }

  // M1: Override server.tool to wrap every handler with token tracking
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (server as any).tool !== 'function') {
    process.stderr.write('[WARN] server.tool is not a function — token tracking middleware cannot be installed\n');
  } else {
  (server as any).tool = function (...args: any[]) {
    // server.tool(name, description, schema, handler) or server.tool(name, description, handler)
    const lastArgIdx = args.length - 1;
    const originalHandler = args[lastArgIdx];

    if (typeof originalHandler === 'function') {
      args[lastArgIdx] = async (...handlerArgs: unknown[]) => {
        // Estimate input tokens from args
        const inputStr = JSON.stringify(handlerArgs);
        const inputTokens = tokenEstimator.estimate(inputStr);

        // Call original handler
        const response = await originalHandler(...handlerArgs);

        // Enrich response with token tracking + project metadata
        return enrichToolResponse(
          response,
          tokenTracker,
          tokenEstimator,
          () => getCachedStats().totalNodes,
          () => {
            const s = getCachedStats();
            return { root: config.projectRoot, indexedFiles: s.totalFiles, totalNodes: s.totalNodes };
          },
          inputTokens,
        );
      };
    }

    return originalToolFn.apply(server, args);
  };
  } // end M1 defensive check

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

  // Initialize semantic search engine
  const semanticEngine = new SemanticSearchEngine(graph.getDb());
  _semanticEngineRef = semanticEngine; // Wire to onProjectSwitch callback
  log('debug', 'Initialized semantic search engine');

  registerSmartTools(server, graph, config, tokenEstimator, semanticEngine);
  log('debug', 'Registered smart tools (3)');

  registerEvolvingTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered evolving tools (3)');

  registerAdvancedTools(server, graph, config, tokenEstimator, semanticEngine);
  log('debug', 'Registered advanced tools (7)');

  registerSemanticTools(server, graph, semanticEngine, config, tokenEstimator);
  log('debug', 'Registered semantic search tools (3)');

  // Session, Changelog & Digest tools (v1.4.0)
  registerSessionTools(server, graph, changelogEngine, config, tokenEstimator);
  log('debug', 'Registered session tools (5)');

  registerDigestTools(server, graph, changelogEngine, config, tokenEstimator);
  log('debug', 'Registered digest tools (3)');

  registerExploreTools(server, graph, indexer, config, tokenEstimator);
  log('debug', 'Registered explore tools (1)');

  registerFilesystemTools(server, graph, config, tokenEstimator);
  log('debug', 'Registered filesystem tools (3)');

  // â”€â”€ mindmap_sync_shared_context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  server.tool(
    'mindmap_sync_shared_context',
    'Synchronise local memories, decisions, and learned rules with the team-shared `.mindmap-shared.json` file. ' +
      'Performs a bidirectional sync to import new conventions/decisions and export local updates.',
    {},
    async () => {
      try {
        const syncStats = await syncSharedContext(config, graph, persistentMemory, decisionLog);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Bidirectional synchronization completed successfully.',
                stats: syncStats
              })
            }
          ]
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                message: `Synchronization failed: ${msg}`
              })
            }
          ]
        };
      }
    }
  );
  log('debug', 'Registered shared context sync tool');


  log('info', 'ðŸ”§ All MCP tools registered:');
  log('info', '  Graph:    mindmap_search, mindmap_get_structure, mindmap_trace_dependencies, mindmap_get_signature, mindmap_find_references, mindmap_get_file_map');
  log('info', '  Changes:  mindmap_what_changed, mindmap_session_diff, mindmap_impact_analysis');
  log('info', '  Memory:   mindmap_recall, mindmap_remember, mindmap_get_decisions, mindmap_decide, mindmap_session_summary, mindmap_sync_shared_context');
  log('info', '  Context:  mindmap_get_context, mindmap_compress, mindmap_reindex, mindmap_status');
  log('info', '  Debug:    mindmap_debug_changes, mindmap_file_before, mindmap_file_history');
  log('info', '  Flow:     mindmap_trace_flow, mindmap_interaction_map, mindmap_classify_file, mindmap_layer_overview');
  log('info', '  Snapshot: mindmap_project_map, mindmap_change_delta, mindmap_session_kickoff â­');
  log('info', '  Advanced: mindmap_query_graph, mindmap_dead_code, mindmap_architecture, mindmap_get_code_snippet, mindmap_search_code, mindmap_list_projects, mindmap_health');
  log('info', '  Smart:    mindmap_explain â­, mindmap_git_changes â­, mindmap_smart_search â­');
  log('info', '  Evolving: mindmap_teach â­, mindmap_get_learned, mindmap_forget');
  log('info', '  Semantic: mindmap_semantic_search â­, mindmap_semantic_stats, mindmap_synonyms');
  log('info', '  Session:  mindmap_session_start ðŸ†•, mindmap_session_resume ðŸ”¥ðŸ†•, mindmap_session_end, mindmap_changelog ðŸ†•, mindmap_hotspots, mindmap_verify_changes ðŸ†•');
  log('info', '  Digest:   mindmap_digest â­, mindmap_file_digest â­, mindmap_verify');

  // â”€â”€ 7.3 Register MCP Prompts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // These are interactive workflow templates that AI agents can request

  server.prompt(
    'start_session',
    'Recommended first prompt for any AI coding session. Calls mindmap_session_resume and returns a complete project briefing.',
    async () => {
      // Auto-start session
      const sessionId = changelogEngine.ensureSession('ai-agent');
      const lastSession = changelogEngine.getLastSession();
      const stats = graph.getStats();
      const since = lastSession?.endedAt || lastSession?.startedAt || (Date.now() - 24 * 3600_000);
      const changes = changelogEngine.getChangesSince(since);

      const lines: string[] = [
        '# Session Briefing',
        '',
        `**Project**: ${path.basename(config.projectRoot)}`,
        `**Files**: ${stats.totalFiles} | **Symbols**: ${stats.totalNodes} | **Relationships**: ${stats.totalEdges}`,
        `**Languages**: ${Object.entries(stats.languageBreakdown).map(([l, c]) => `${l}(${c})`).join(', ')}`,
        '',
      ];

      if (lastSession) {
        lines.push(
          '## Previous Session',
          `- **Agent**: ${lastSession.agentName}`,
          `- **Task**: ${lastSession.taskDescription || 'Not specified'}`,
          `- **Summary**: ${lastSession.summary || 'No summary'}`,
          `- **Files modified**: ${lastSession.filesModified.length}`,
          '',
        );
      }

      if (changes.totalChanges > 0) {
        lines.push(
          `## Changes Since Last Session (${changes.sinceLabel})`,
          `${changes.filesChanged} files, ${changes.totalChanges} symbol changes:`,
        );
        for (const f of changes.files.slice(0, 8)) {
          const rel = path.relative(config.projectRoot, f.filePath).replace(/\\/g, '/');
          const parts: string[] = [];
          if (f.added.length > 0) parts.push(`+${f.added.length}`);
          if (f.modified.length > 0) parts.push(`~${f.modified.length}`);
          if (f.deleted.length > 0) parts.push(`-${f.deleted.length}`);
          lines.push(`  ${rel}: ${parts.join(', ')}`);
        }
        lines.push('');
      }

      lines.push(
        '## What to do next',
        '- Use `mindmap_smart_search` to find specific code',
        '- Use `mindmap_explain` to understand a symbol',
        '- Use `mindmap_changelog` for detailed change diffs',
        '- Use `mindmap_session_end` when done',
      );

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );

  server.prompt(
    'tool_guide',
    'Complete guide to all AI Mind Map tools â€” when to use each one, organized by task.',
    async () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            '# AI Mind Map â€” Complete Tool Guide',
            '',
            '## ðŸš€ Session Lifecycle (use these to avoid re-reading code)',
            '| Tool | When to Use |',
            '|------|------------|',
            '| `mindmap_session_resume` | **FIRST call every conversation** â€” returns project context + changes |',
            '| `mindmap_session_kickoff` | Full preamble: project map + change delta + memories in ONE call |',
            '| `mindmap_session_start` | Start tracking a new task (records agent name + task) |',
            '| `mindmap_session_end` | Save summary for next AI session |',
            '',
            '## ðŸ” Finding Code (instead of grep/reading files)',
            '| Tool | When to Use |',
            '|------|------------|',
            '| `mindmap_smart_search` | Search by function/class name â€” returns full context |',
            '| `mindmap_semantic_search` | Search by concept ("error handling", "auth") |',
            '| `mindmap_search_code` | Grep-like text search in code bodies |',
            '| `mindmap_find_references` | Find all usages of a symbol |',
            '| `mindmap_trace_dependencies` | Who calls X? What does X call? |',
            '',
            '## ðŸ“– Reading Code (without reading full files)',
            '| Tool | When to Use |',
            '|------|------------|',
            '| `mindmap_explain` | Get EVERYTHING about a symbol in one call |',
            '| `mindmap_get_code_snippet` | Read actual source for a function |',
            '| `mindmap_file_digest` | Understand a file without reading it |',
            '| `mindmap_get_file_map` | All symbols in a file with signatures |',
            '| `mindmap_get_signature` | Just the signature (cheapest read) |',
            '',
            '## ðŸ“Š Understanding the Project',
            '| Tool | When to Use |',
            '|------|------------|',
            '| `mindmap_digest` | Full project summary in <2000 tokens |',
            '| `mindmap_architecture` | Architecture layers + patterns |',
            '| `mindmap_project_map` | Complete project map |',
            '',
            '## ðŸ”„ Change Tracking',
            '| Tool | When to Use |',
            '|------|------------|',
            '| `mindmap_changelog` | Symbol-level diffs since a time |',
            '| `mindmap_git_changes` | Git-aware change detection |',
            '| `mindmap_verify` | Check if cached code is still valid |',
            '| `mindmap_hotspots` | Most frequently changed files |',
            '',
            '## ðŸ§  Memory & Decisions',
            '| Tool | When to Use |',
            '|------|------------|',
            '| `mindmap_remember` | Save important facts for future |',
            '| `mindmap_recall` | Retrieve relevant memories |',
            '| `mindmap_decide` | Record architectural decisions |',
            '| `mindmap_teach` | Teach persistent rules |',
          ].join('\n'),
        },
      }],
    }),
  );

  log('debug', 'Registered 2 MCP prompts (start_session, tool_guide)');

  // â”€â”€ 7.5 Auto-sync shared context on startup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (config.autoSyncSharedContext) {
    log('info', 'ðŸ”„ Auto-syncing shared contextâ€¦');
    try {
      const syncStats = await syncSharedContext(config, graph, persistentMemory, decisionLog);
      log('info', `âœ… Shared context sync complete: ` +
        `Imported: ${syncStats.memoriesImported} memories, ${syncStats.decisionsImported} decisions, ${syncStats.rulesImported} rules. ` +
        `Exported: ${syncStats.memoriesExported} memories, ${syncStats.decisionsExported} decisions, ${syncStats.rulesExported} rules.`);
    } catch (err) {
      log('warn', `âš ï¸ Auto-sync of shared context failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // â”€â”€ 8. Smart auto-index (only if projectRoot looks like a real project) â”€â”€
  if (config.memoryOnly) {
    log('info', 'ðŸ§  Running in memoryOnly mode. Bypassing codebase parsing and indexing.');
  } else {
    // Check if projectRoot is a real project (not an IDE install directory)
    const projectMarkers = [
      '.git', 'package.json', 'build.gradle', 'build.gradle.kts',
      'Cargo.toml', 'go.mod', 'pom.xml', 'CMakeLists.txt',
      'Makefile', '.project', 'setup.py', 'pyproject.toml',
      'pubspec.yaml', 'Gemfile',
    ];
    const isRealProject = projectMarkers.some(marker =>
      existsSync(path.join(config.projectRoot, marker))
    );

    if (!isRealProject || isBlockedDirectory(config.projectRoot)) {
      log('info', `âš ï¸ Project root "${config.projectRoot}" does not look like a code project (no .git, package.json, etc.).`);
      log('info', '   Skipping auto-index. The AI agent will be prompted to call mindmap_reindex with the correct project path.');
    } else {
      const stats = graph.getStats();
      if (stats.totalNodes === 0) {
        log('info', `ðŸ“‹ Real project detected at: ${config.projectRoot}. Running initial indexingâ€¦`);
        try {
          const result = await indexer.fullIndex();
          log('info', `âœ… Initial index complete: ${result.filesParsed} files, ${result.nodesCreated} nodes, ${result.edgesCreated} edges`);
          if (result.parseErrors > 0) {
            log('warn', `âš ï¸ ${result.parseErrors} parse errors (non-fatal)`);
          }
        } catch (err) {
          log('warn', `âš ï¸ Initial indexing failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log('info', `ðŸ“‹ Existing index found: ${stats.totalNodes} nodes. Running incremental updateâ€¦`);
        try {
          const result = await indexer.incrementalIndex();
          log('info', `âœ… Incremental update: ${result.filesParsed} files reindexed`);
        } catch (err) {
          log('warn', `âš ï¸ Incremental update failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Build semantic search TF-IDF index from existing graph nodes (if any)
    try {
      const allNodes = graph.getAllNodes();
      const nonFileNodes = allNodes.filter(n => n.type !== 'file');
      if (nonFileNodes.length > 0) {
        semanticEngine.indexNodes(
          nonFileNodes.map(n => ({
            id: n.id,
            name: n.name,
            qualifiedName: n.qualifiedName,
            signature: n.signature,
            docComment: n.docComment,
            filePath: n.filePath,
          }))
        );
        semanticEngine.rebuildIDF();
        log('info', `ðŸ§  Semantic index built: ${nonFileNodes.length} symbols indexed`);
      }
    } catch (err) {
      log('warn', `âš ï¸ Semantic index build failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // â”€â”€ 9. Start file watcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (watcher && !config.memoryOnly) {
    try {
      await watcher.start();
      log('info', 'ðŸ‘ï¸ File watcher started');
    } catch (err) {
      log('warn', `âš ï¸ File watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // â”€â”€ 10. Graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log('info', `Received ${signal}, shutting down gracefullyâ€¦`);

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

      log('info', 'âœ… Cleanup complete. Goodbye!');
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

  // â”€â”€ 11. Connect transport and start serving â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  log('info', 'Connecting stdio transportâ€¦');

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('info', 'ðŸ§  AI Mind Map MCP Server is LIVE. Waiting for requestsâ€¦');
    log('info', `   Project: ${config.projectRoot}`);
    log('info', `   Database: ${config.dbPath}`);
    log('info', `   Session: ${sessionMemory.getCurrentSessionId()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to start MCP server: ${msg}`);
    process.exit(1);
  }
}

// â”€â”€ Kick off â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});
