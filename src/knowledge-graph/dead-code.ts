/**
 * AI Mind Map — Dead Code Detection
 *
 * Scans the knowledge graph to find functions and methods with zero callers,
 * classifying them by confidence level (definitely dead vs possibly dead).
 *
 * Entry points, lifecycle hooks, test utilities, and exported symbols are
 * handled with special heuristics to reduce false positives.
 */

import type Database from 'better-sqlite3';
import type { KnowledgeGraph } from './graph.js';

// ============================================================
// Types
// ============================================================

/** Confidence level for dead code detection */
export type DeadCodeConfidence = 'definitely_dead' | 'possibly_dead' | 'low_confidence';

/** Options for the dead code detector */
export interface DeadCodeOptions {
  /** Node types to scan (default: ['function', 'method']) */
  nodeTypes?: string[];
  /** Additional entry point function names to exclude */
  additionalEntryPoints?: string[];
  /** Whether to include exported symbols as possibly dead (default: true) */
  includeExported?: boolean;
  /** Maximum number of results to return (default: 100) */
  limit?: number;
  /** Minimum confidence level to include (default: 'possibly_dead') */
  minConfidence?: DeadCodeConfidence;
  /** File path pattern to restrict scanning (e.g., 'src/') */
  filePath?: string;
}

/** A single dead code detection result */
export interface DeadCodeResult {
  /** Node ID in the graph */
  nodeId: string;
  /** Function/method name */
  name: string;
  /** Fully qualified name (e.g., MyClass.myMethod) */
  qualifiedName: string;
  /** File path containing the symbol */
  filePath: string;
  /** Start line number */
  startLine: number;
  /** End line number */
  endLine: number;
  /** Function/method signature */
  signature: string;
  /** Whether the symbol is exported */
  isExported: boolean;
  /** Node type (function, method, etc.) */
  nodeType: string;
  /** Confidence that this is truly dead code */
  confidence: DeadCodeConfidence;
  /** Human-readable reason for the classification */
  reason: string;
  /** Number of incoming CALLS edges (should be 0 for dead code candidates) */
  callerCount: number;
  /** Number of outgoing CALLS edges (what this function calls) */
  calleeCount: number;
}

/** Summary statistics for the dead code scan */
export interface DeadCodeSummary {
  /** Total symbols scanned */
  totalScanned: number;
  /** Total dead code candidates found */
  totalDead: number;
  /** Breakdown by confidence level */
  byConfidence: Record<DeadCodeConfidence, number>;
  /** Breakdown by file */
  byFile: Record<string, number>;
  /** Dead code percentage (candidates / total scanned) */
  deadPercentage: number;
  /** Individual results */
  results: DeadCodeResult[];
}

// ============================================================
// Known Entry Points & Lifecycle Hooks
// ============================================================

/**
 * Function/method names that are recognized entry points or framework
 * lifecycle hooks and should NOT be flagged as dead code.
 */
const KNOWN_ENTRY_POINTS = new Set<string>([
  // General entry points
  'main', 'index', 'app', 'server', 'init', 'start', 'run',
  'bootstrap', 'setup', 'configure', 'register', 'activate',

  // Testing frameworks
  'describe', 'it', 'test', 'beforeAll', 'afterAll',
  'beforeEach', 'afterEach', 'before', 'after',
  'expect', 'assert', 'suite', 'spec',

  // React lifecycle / hooks
  'constructor', 'render',
  'componentDidMount', 'componentDidUpdate', 'componentWillUnmount',
  'shouldComponentUpdate', 'getSnapshotBeforeUpdate',
  'getDerivedStateFromProps', 'getDerivedStateFromError',
  'componentDidCatch',
  'useEffect', 'useState', 'useCallback', 'useMemo', 'useRef',
  'useReducer', 'useContext', 'useLayoutEffect',

  // Angular lifecycle
  'ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngDoCheck',
  'ngAfterContentInit', 'ngAfterContentChecked',
  'ngAfterViewInit', 'ngAfterViewChecked',

  // Vue lifecycle
  'created', 'mounted', 'updated', 'destroyed',
  'beforeCreate', 'beforeMount', 'beforeUpdate', 'beforeDestroy',
  'activated', 'deactivated', 'errorCaptured',
  'onMounted', 'onUnmounted', 'onUpdated', 'onBeforeMount',
  'onBeforeUpdate', 'onBeforeUnmount', 'onActivated', 'onDeactivated',

  // Express / HTTP handlers
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head',
  'use', 'all', 'listen',

  // Python dunder methods
  '__init__', '__str__', '__repr__', '__eq__', '__hash__',
  '__len__', '__getitem__', '__setitem__', '__delitem__',
  '__iter__', '__next__', '__enter__', '__exit__',
  '__call__', '__del__', '__new__',

  // Java / Kotlin
  'onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy',
  'toString', 'equals', 'hashCode', 'compareTo',

  // CLI / script patterns
  'cli', 'command', 'handler', 'middleware',

  // Module patterns
  'default', 'module', 'exports',
]);

/**
 * File-name patterns that indicate entry point files
 * (any function in these files is likely intentionally top-level).
 */
const ENTRY_POINT_FILE_PATTERNS = [
  /[/\\]index\.[^/\\]+$/i,
  /[/\\]main\.[^/\\]+$/i,
  /[/\\]app\.[^/\\]+$/i,
  /[/\\]server\.[^/\\]+$/i,
  /[/\\]cli\.[^/\\]+$/i,
  /[/\\]bin[/\\]/i,
  /[/\\]scripts[/\\]/i,
];

/**
 * File-name patterns that indicate test files.
 * Functions in test files are typically not called by production code.
 */
const TEST_FILE_PATTERNS = [
  /\.test\.[^/\\]+$/i,
  /\.spec\.[^/\\]+$/i,
  /[/\\]__tests__[/\\]/i,
  /[/\\]test[/\\]/i,
  /[/\\]tests[/\\]/i,
];

// ============================================================
// DeadCodeDetector Class
// ============================================================

/**
 * Detects potentially dead (unreachable) functions and methods
 * in the knowledge graph by analyzing incoming CALLS edges.
 *
 * @example
 * ```ts
 * const detector = new DeadCodeDetector(db);
 * const summary = detector.detect({ minConfidence: 'possibly_dead' });
 * for (const result of summary.results) {
 *   console.log(`${result.confidence}: ${result.qualifiedName} in ${result.filePath}`);
 * }
 * ```
 */
export class DeadCodeDetector {
  private db: Database.Database;

  /**
   * Create a new DeadCodeDetector.
   *
   * @param graph - A KnowledgeGraph instance (the DB is extracted via graph.getDb())
   */
  constructor(graph: KnowledgeGraph) {
    this.db = graph.getDb();
  }

  /**
   * Scan the graph for dead code candidates.
   *
   * @param options - Detection options (node types, confidence threshold, etc.)
   * @returns Summary with all dead code results and statistics
   */
  detect(options?: DeadCodeOptions): DeadCodeSummary {
    const opts = this.resolveOptions(options);
    const entryPointNames = new Set([
      ...KNOWN_ENTRY_POINTS,
      ...(opts.additionalEntryPoints ?? []),
    ]);

    // Fetch all candidate nodes with their caller counts
    const candidates = this.fetchCandidates(opts);
    const results: DeadCodeResult[] = [];

    for (const candidate of candidates) {
      // Skip known entry points by name
      if (entryPointNames.has(candidate.name)) continue;

      // Skip constructors (they're called implicitly via `new`)
      if (candidate.nodeType === 'constructor') continue;

      // Skip nodes in entry-point files (with lower confidence, not skip entirely)
      const isInEntryFile = ENTRY_POINT_FILE_PATTERNS.some(p => p.test(candidate.filePath));
      const isInTestFile = TEST_FILE_PATTERNS.some(p => p.test(candidate.filePath));

      // Determine confidence
      const { confidence, reason } = this.classifyConfidence(
        candidate,
        isInEntryFile,
        isInTestFile,
      );

      // Apply confidence filter
      if (!this.meetsConfidenceThreshold(confidence, opts.minConfidence ?? 'possibly_dead')) {
        continue;
      }

      // Skip exported if option says so
      if (!opts.includeExported && candidate.isExported) {
        continue;
      }

      results.push({
        nodeId: candidate.nodeId,
        name: candidate.name,
        qualifiedName: candidate.qualifiedName,
        filePath: candidate.filePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        signature: candidate.signature,
        isExported: candidate.isExported,
        nodeType: candidate.nodeType,
        confidence,
        reason,
        callerCount: candidate.callerCount,
        calleeCount: candidate.calleeCount,
      });
    }

    // Sort: definitely_dead first, then possibly_dead, then low_confidence
    results.sort((a, b) => {
      const order: Record<DeadCodeConfidence, number> = {
        definitely_dead: 0,
        possibly_dead: 1,
        low_confidence: 2,
      };
      const diff = order[a.confidence] - order[b.confidence];
      if (diff !== 0) return diff;
      return a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine;
    });

    // Apply limit
    const limited = results.slice(0, opts.limit ?? 100);

    // Build summary
    return this.buildSummary(candidates.length, limited);
  }

  /**
   * Merge user options with defaults.
   */
  private resolveOptions(options?: DeadCodeOptions): Required<DeadCodeOptions> {
    return {
      nodeTypes: options?.nodeTypes ?? ['function', 'method'],
      additionalEntryPoints: options?.additionalEntryPoints ?? [],
      includeExported: options?.includeExported ?? true,
      limit: options?.limit ?? 100,
      minConfidence: options?.minConfidence ?? 'possibly_dead',
      filePath: options?.filePath ?? '',
    };
  }

  /**
   * Fetch all candidate nodes (functions/methods) with their caller/callee counts.
   */
  private fetchCandidates(opts: Required<DeadCodeOptions>): CandidateRow[] {
    const typePlaceholders = opts.nodeTypes.map(() => '?').join(', ');

    let fileFilter = '';
    const params: unknown[] = [...opts.nodeTypes];

    if (opts.filePath) {
      fileFilter = ' AND n.filePath LIKE ?';
      params.push(`%${opts.filePath}%`);
    }

    const sql = `
      SELECT
        n.id AS nodeId,
        n.name,
        n.qualifiedName,
        n.filePath,
        n.startLine,
        n.endLine,
        n.signature,
        n.isExported,
        n.type AS nodeType,
        n.visibility,
        COALESCE(callers.cnt, 0) AS callerCount,
        COALESCE(callees.cnt, 0) AS calleeCount
      FROM nodes n
      LEFT JOIN (
        SELECT targetId, COUNT(*) AS cnt
        FROM edges
        WHERE type = 'calls'
        GROUP BY targetId
      ) callers ON callers.targetId = n.id
      LEFT JOIN (
        SELECT sourceId, COUNT(*) AS cnt
        FROM edges
        WHERE type = 'calls'
        GROUP BY sourceId
      ) callees ON callees.sourceId = n.id
      WHERE n.type IN (${typePlaceholders})
        AND COALESCE(callers.cnt, 0) = 0
        ${fileFilter}
      ORDER BY n.filePath, n.startLine
    `;

    const rows = this.db.prepare(sql).all(...params) as RawCandidateRow[];

    return rows.map(row => ({
      nodeId: row.nodeId,
      name: row.name,
      qualifiedName: row.qualifiedName,
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature,
      isExported: Boolean(row.isExported),
      nodeType: row.nodeType,
      visibility: row.visibility,
      callerCount: row.callerCount,
      calleeCount: row.calleeCount,
    }));
  }

  /**
   * Classify the confidence level that a candidate is truly dead code.
   */
  private classifyConfidence(
    candidate: CandidateRow,
    isInEntryFile: boolean,
    isInTestFile: boolean,
  ): { confidence: DeadCodeConfidence; reason: string } {
    // Test helpers are expected to have no production callers
    if (isInTestFile) {
      return {
        confidence: 'low_confidence',
        reason: 'Located in a test file — test functions are invoked by the test runner, not production code',
      };
    }

    // Private/protected + not exported + no callers = definitely dead
    if (!candidate.isExported &&
        (candidate.visibility === 'private' || candidate.visibility === 'protected')) {
      return {
        confidence: 'definitely_dead',
        reason: `${candidate.visibility} symbol with zero callers and not exported`,
      };
    }

    // Not exported + no callers + not in entry file = definitely dead
    if (!candidate.isExported && !isInEntryFile) {
      return {
        confidence: 'definitely_dead',
        reason: 'Not exported and has zero internal callers',
      };
    }

    // In an entry-point file but not exported
    if (!candidate.isExported && isInEntryFile) {
      return {
        confidence: 'possibly_dead',
        reason: 'Not exported but located in an entry-point file (may be invoked at startup)',
      };
    }

    // Exported with no internal callers
    if (candidate.isExported) {
      return {
        confidence: 'possibly_dead',
        reason: 'Exported but has zero internal callers (may be used externally)',
      };
    }

    return {
      confidence: 'low_confidence',
      reason: 'Unable to determine reachability with certainty',
    };
  }

  /**
   * Check if a given confidence meets the minimum threshold.
   */
  private meetsConfidenceThreshold(
    confidence: DeadCodeConfidence,
    minConfidence: DeadCodeConfidence,
  ): boolean {
    const levels: Record<DeadCodeConfidence, number> = {
      definitely_dead: 3,
      possibly_dead: 2,
      low_confidence: 1,
    };
    return levels[confidence] >= levels[minConfidence];
  }

  /**
   * Build the summary statistics from the result set.
   */
  private buildSummary(totalScanned: number, results: DeadCodeResult[]): DeadCodeSummary {
    const byConfidence: Record<DeadCodeConfidence, number> = {
      definitely_dead: 0,
      possibly_dead: 0,
      low_confidence: 0,
    };

    const byFile: Record<string, number> = {};

    for (const result of results) {
      byConfidence[result.confidence]++;
      byFile[result.filePath] = (byFile[result.filePath] ?? 0) + 1;
    }

    return {
      totalScanned,
      totalDead: results.length,
      byConfidence,
      byFile,
      deadPercentage: totalScanned > 0
        ? Math.round((results.length / totalScanned) * 10000) / 100
        : 0,
      results,
    };
  }
}

// ============================================================
// Internal Row Types
// ============================================================

interface RawCandidateRow {
  nodeId: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: number;
  nodeType: string;
  visibility: string;
  callerCount: number;
  calleeCount: number;
}

interface CandidateRow {
  nodeId: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: boolean;
  nodeType: string;
  visibility: string;
  callerCount: number;
  calleeCount: number;
}
