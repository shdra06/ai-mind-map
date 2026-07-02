/**
 * AI Mind Map — SQLite-backed Knowledge Graph with FTS5
 *
 * Stores and queries the structural knowledge graph of a codebase.
 * Provides CRUD operations, graph traversal, dependency chain tracing,
 * full-text search, and statistics.
 *
 * Inspired by codebase-memory-mcp's Cypher-like queries.
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';
import type {
  GraphNode,
  GraphEdge,
  NodeType,
  EdgeType,
} from '../types.js';

// ============================================================
// Schema SQL
// ============================================================

const SCHEMA_SQL = `
-- Core nodes table
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  qualifiedName TEXT NOT NULL,
  filePath TEXT NOT NULL,
  startLine INTEGER NOT NULL,
  endLine INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  docComment TEXT,
  hash TEXT NOT NULL,
  language TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'unknown',
  isAsync INTEGER NOT NULL DEFAULT 0,
  isStatic INTEGER NOT NULL DEFAULT 0,
  isExported INTEGER NOT NULL DEFAULT 0,
  parameters TEXT,
  returnType TEXT,
  updatedAt INTEGER NOT NULL
);

-- Edges table with composite primary key
CREATE TABLE IF NOT EXISTS edges (
  sourceId TEXT NOT NULL,
  targetId TEXT NOT NULL,
  type TEXT NOT NULL,
  metadata TEXT,
  PRIMARY KEY (sourceId, targetId, type)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_nodes_filePath ON nodes(filePath);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_hash ON nodes(hash);
-- Composite indexes for common edge queries (type is always in WHERE clause)
CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(sourceId, type);
CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(targetId, type);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

-- FTS5 virtual table for full-text search across names, signatures, and doc comments
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  qualifiedName,
  signature,
  docComment,
  content='nodes',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync with nodes table
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, qualifiedName, signature, docComment)
  VALUES (new.rowid, new.id, new.name, new.qualifiedName, new.signature, new.docComment);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualifiedName, signature, docComment)
  VALUES ('delete', old.rowid, old.id, old.name, old.qualifiedName, old.signature, old.docComment);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualifiedName, signature, docComment)
  VALUES ('delete', old.rowid, old.id, old.name, old.qualifiedName, old.signature, old.docComment);
  INSERT INTO nodes_fts(rowid, id, name, qualifiedName, signature, docComment)
  VALUES (new.rowid, new.id, new.name, new.qualifiedName, new.signature, new.docComment);
END;

-- Metadata table for tracking schema version and stats
CREATE TABLE IF NOT EXISTS graph_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Learned rules: AI-taught patterns that persist per-project
CREATE TABLE IF NOT EXISTS learned_rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,          -- 'classification' | 'search_alias' | 'code_pattern' | 'convention'
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  rule TEXT NOT NULL,           -- JSON: the actual rule definition
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_by TEXT NOT NULL DEFAULT 'ai'
);

CREATE INDEX IF NOT EXISTS idx_learned_rules_type ON learned_rules(type);
CREATE INDEX IF NOT EXISTS idx_learned_rules_name ON learned_rules(name);

-- File index for fast staleness detection via mtime
CREATE TABLE IF NOT EXISTS file_index (
  file_path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- FTS5 table for full-text code search across file contents
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
  file_path,
  content,
  tokenize='unicode61'
);
`;

const SCHEMA_VERSION = '6';

// ============================================================
// KnowledgeGraph Class
// ============================================================

/**
 * SQLite-backed knowledge graph with FTS5 full-text search.
 *
 * All write operations use transactions for atomicity.
 * Supports graph traversal, dependency analysis, and full-text search.
 */
export class KnowledgeGraph {
  private db: Database.Database;

  // Cached prepared statements for hot-path queries (parse once, reuse forever)
  private _stmtCache = new Map<string, any>();

  /** Get or create a cached prepared statement */
  private stmt(sql: string): any {
    let s = this._stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmtCache.set(sql, s);
    }
    return s;
  }

  // In-memory adjacency cache for ultra-fast graph traversal
  private adjOut = new Map<string, Map<string, string[]>>(); // nodeId → type → targetIds
  private adjIn  = new Map<string, Map<string, string[]>>(); // nodeId → type → sourceIds
  private adjDirty = true; // Rebuilt on first query after index

  // Stats cache with 5-second TTL
  private _statsCache: { data: any; time: number } | null = null;

  /**
   * Create or open a knowledge graph database.
   *
   * @param dbPath - Path to the SQLite database file (or ':memory:' for in-memory)
   */
  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('wal_autocheckpoint = 0'); // Defer checkpointing during bulk ops
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('page_size = 8192');  // 8KB pages for better I/O alignment
      this.db.pragma('cache_size = -64000');  // 64MB cache
      this.initializeSchema();
    } catch (err) {
      // If DB is corrupt, delete and retry once
      try {
        if (dbPath !== ':memory:') {
          if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
            // Also remove WAL/SHM files
            try { fs.unlinkSync(dbPath + '-wal'); } catch {}
            try { fs.unlinkSync(dbPath + '-shm'); } catch {}
          }
          this.db = new Database(dbPath);
          this.db.pragma('journal_mode = WAL');
          this.db.pragma('wal_autocheckpoint = 0'); // Defer checkpointing during bulk ops
          this.db.pragma('synchronous = NORMAL');
          this.db.pragma('foreign_keys = ON');
          this.db.pragma('busy_timeout = 5000');
          this.db.pragma('page_size = 8192');  // 8KB pages for better I/O alignment
          this.db.pragma('cache_size = -64000');  // 64MB cache
          this.initializeSchema();
          console.error('[ai-mind-map] Recovered from corrupt database — rebuilt from scratch');
        } else {
          throw err;
        }
      } catch {
        throw new Error(`[ai-mind-map] Failed to initialize database at ${dbPath}: ${err}`);
      }
    }
  }

  /** Initialize or migrate the database schema */
  private initializeSchema(): void {
    const currentVersion = this.getMeta('schema_version');

    if (currentVersion === SCHEMA_VERSION) {
      return; // Schema is current
    }

    if (currentVersion && currentVersion !== SCHEMA_VERSION) {
      // Migration: preserve changelog/session tables across schema upgrades
      // Only drop core graph tables — changelog survives
      this.db.exec('DROP TABLE IF EXISTS content_fts');
      this.db.exec('DROP TABLE IF EXISTS nodes_fts');
      this.db.exec('DROP TABLE IF EXISTS edges');
      this.db.exec('DROP TABLE IF EXISTS nodes');
      this.db.exec('DROP TABLE IF EXISTS graph_meta');
      // Drop triggers
      this.db.exec('DROP TRIGGER IF EXISTS nodes_ai');
      this.db.exec('DROP TRIGGER IF EXISTS nodes_ad');
      this.db.exec('DROP TRIGGER IF EXISTS nodes_au');
    }

    this.db.exec(SCHEMA_SQL);
    this.setMeta('schema_version', SCHEMA_VERSION);
  }

  // ============================================================
  // Metadata
  // ============================================================

  /** Get a metadata value by key */
  private getMeta(key: string): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Set a metadata key-value pair */
  private setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO graph_meta (key, value) VALUES (?, ?)'
    ).run(key, value);
  }

  /**
   * Get all nodes belonging to a specific file.
   * Used by changelog engine to diff old vs new nodes during re-indexing.
   */
  getNodesForFile(filePath: string): GraphNode[] {
    const rows = this.stmt('SELECT * FROM nodes WHERE filePath = ?').all(filePath);
    return rows.map((r: any) => this.rowToNode(r));
  }

  // ============================================================
  // Node CRUD
  // ============================================================

  /** Serialize parameters array to JSON */
  private serializeParams(params?: GraphNode['parameters']): string | null {
    if (!params || params.length === 0) return null;
    return JSON.stringify(params);
  }

  /** Deserialize parameters JSON string to array */
  private deserializeParams(json: string | null): GraphNode['parameters'] {
    if (!json) return undefined;
    try {
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  }

  /** Convert a database row to a GraphNode */
  private rowToNode(row: any): GraphNode {
    return {
      id: row.id,
      type: row.type as NodeType,
      name: row.name,
      qualifiedName: row.qualifiedName,
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      signature: row.signature,
      docComment: row.docComment ?? null,
      hash: row.hash,
      language: row.language,
      visibility: row.visibility,
      isAsync: Boolean(row.isAsync),
      isStatic: Boolean(row.isStatic),
      isExported: Boolean(row.isExported),
      parameters: this.deserializeParams(row.parameters),
      returnType: row.returnType ?? undefined,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Insert or update a single node.
   */
  upsertNode(node: GraphNode): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO nodes (
        id, type, name, qualifiedName, filePath, startLine, endLine,
        signature, docComment, hash, language, visibility,
        isAsync, isStatic, isExported, parameters, returnType, updatedAt
      ) VALUES (
        @id, @type, @name, @qualifiedName, @filePath, @startLine, @endLine,
        @signature, @docComment, @hash, @language, @visibility,
        @isAsync, @isStatic, @isExported, @parameters, @returnType, @updatedAt
      )
    `).run({
      id: node.id,
      type: node.type,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      signature: node.signature,
      docComment: node.docComment,
      hash: node.hash,
      language: node.language,
      visibility: node.visibility,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isExported: node.isExported ? 1 : 0,
      parameters: this.serializeParams(node.parameters),
      returnType: node.returnType ?? null,
      updatedAt: node.updatedAt,
    });
  }

  /**
   * Bulk insert/update nodes within a transaction.
   */
  upsertNodes(nodes: GraphNode[]): void {
    if (nodes.length === 0) return;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (
        id, type, name, qualifiedName, filePath, startLine, endLine,
        signature, docComment, hash, language, visibility,
        isAsync, isStatic, isExported, parameters, returnType, updatedAt
      ) VALUES (
        @id, @type, @name, @qualifiedName, @filePath, @startLine, @endLine,
        @signature, @docComment, @hash, @language, @visibility,
        @isAsync, @isStatic, @isExported, @parameters, @returnType, @updatedAt
      )
    `);

    const transaction = this.db.transaction((items: GraphNode[]) => {
      for (const node of items) {
        insertStmt.run({
          id: node.id,
          type: node.type,
          name: node.name,
          qualifiedName: node.qualifiedName,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          signature: node.signature,
          docComment: node.docComment,
          hash: node.hash,
          language: node.language,
          visibility: node.visibility,
          isAsync: node.isAsync ? 1 : 0,
          isStatic: node.isStatic ? 1 : 0,
          isExported: node.isExported ? 1 : 0,
          parameters: this.serializeParams(node.parameters),
          returnType: node.returnType ?? null,
          updatedAt: node.updatedAt,
        });
      }
    });

    transaction(nodes);
  }

  /**
   * Get a node by its ID.
   */
  getNode(id: string): GraphNode | null {
    const row = this.stmt('SELECT * FROM nodes WHERE id = ?').get(id);
    return row ? this.rowToNode(row) : null;
  }

  /**
   * Get nodes by name (may return multiple matches across files).
   */
  getNodesByName(name: string): GraphNode[] {
    const rows = this.stmt('SELECT * FROM nodes WHERE name = ?').all(name);
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Get all nodes of a specific type.
   */
  getNodesByType(type: NodeType): GraphNode[] {
    const rows = this.stmt('SELECT * FROM nodes WHERE type = ?').all(type);
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Get all nodes in the graph.
   * @param limit Maximum number of nodes to return (default 50000, prevents OOM)
   */
  getAllNodes(limit: number = 50000): GraphNode[] {
    // Security fix (H-1): cap result set to prevent OOM on large codebases
    const safeLimit = Math.min(Math.max(1, limit), 100000);
    const rows = this.db.prepare('SELECT * FROM nodes LIMIT ?').all(safeLimit);
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Delete a node and all its edges.
   */
  deleteNode(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM edges WHERE sourceId = ? OR targetId = ?').run(id, id);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    })();
  }

  /**
   * Delete all nodes and edges for a specific file.
   */
  deleteFileNodes(filePath: string): number {
    let deletedCount = 0;
    this.db.transaction(() => {
      // Get all node IDs for this file
      const nodeIds = this.db.prepare('SELECT id FROM nodes WHERE filePath = ?')
        .all(filePath) as { id: string }[];

      if (nodeIds.length === 0) return;

      deletedCount = nodeIds.length;

      // Delete edges referencing these nodes — batch in chunks of 500 to stay within SQLite limits
      const idList = nodeIds.map(n => n.id);
      for (let i = 0; i < idList.length; i += 500) {
        const chunk = idList.slice(i, i + 500);
        const placeholders = chunk.map(() => '?').join(',');
        this.db.prepare(
          `DELETE FROM edges WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})`,
        ).run(...chunk, ...chunk);
      }

      // Delete the nodes
      this.db.prepare(`DELETE FROM nodes WHERE filePath = ?`).run(filePath);
    })();

    return deletedCount;
  }

  // ============================================================
  // Edge CRUD
  // ============================================================

  /**
   * Insert or update a single edge.
   */
  upsertEdge(edge: GraphEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO edges (sourceId, targetId, type, metadata)
      VALUES (@sourceId, @targetId, @type, @metadata)
    `).run({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      type: edge.type,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
    });
  }

  /**
   * Bulk insert/update edges within a transaction.
   */
  upsertEdges(edges: GraphEdge[]): void {
    if (edges.length === 0) return;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges (sourceId, targetId, type, metadata)
      VALUES (@sourceId, @targetId, @type, @metadata)
    `);

    const transaction = this.db.transaction((items: GraphEdge[]) => {
      for (const edge of items) {
        insertStmt.run({
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          type: edge.type,
          metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
        });
      }
    });

    transaction(edges);
  }

  /**
   * Get all edges originating from a node.
   */
  getOutEdges(nodeId: string): GraphEdge[] {
    const rows = this.stmt('SELECT * FROM edges WHERE sourceId = ?').all(nodeId) as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get all edges pointing to a node.
   */
  getInEdges(nodeId: string): GraphEdge[] {
    const rows = this.stmt('SELECT * FROM edges WHERE targetId = ?').all(nodeId) as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get edges of a specific type originating from a node.
   */
  getOutEdgesByType(nodeId: string, type: EdgeType): GraphEdge[] {
    const rows = this.stmt(
      'SELECT * FROM edges WHERE sourceId = ? AND type = ?',
    ).all(nodeId, type) as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get edges of a specific type pointing to a node.
   */
  getInEdgesByType(nodeId: string, type: EdgeType): GraphEdge[] {
    const rows = this.stmt(
      'SELECT * FROM edges WHERE targetId = ? AND type = ?',
    ).all(nodeId, type) as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  // ============================================================
  // Graph Traversal
  // ============================================================

  /**
   * Find all nodes that call a given node (callers / "who calls this?").
   */
  findCallers(nodeId: string): GraphNode[] {
    const rows = this.stmt(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.sourceId
      WHERE e.targetId = ? AND e.type = 'calls'
    `).all(nodeId) as any[];
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Find all nodes that a given node calls (callees / "what does this call?").
   */
  findCallees(nodeId: string): GraphNode[] {
    const rows = this.stmt(`
      SELECT n.* FROM nodes n
      JOIN edges e ON n.id = e.targetId
      WHERE e.sourceId = ? AND e.type = 'calls'
    `).all(nodeId) as any[];
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Find ancestors (parent classes, implemented interfaces) — traverse upward.
   *
   * @param nodeId - Starting node ID
   * @param maxDepth - Maximum traversal depth (default 10)
   */
  findAncestors(nodeId: string, maxDepth: number = 10): GraphNode[] {
    // Single recursive CTE replaces N+1 JavaScript BFS loop
    const rows = this.db.prepare(`
      WITH RECURSIVE anc(id, depth) AS (
        SELECT @nodeId, 0
        UNION
        SELECT e.targetId, anc.depth + 1
        FROM edges e
        JOIN anc ON e.sourceId = anc.id
        WHERE anc.depth < @maxDepth AND e.type IN ('inherits', 'implements')
        UNION
        SELECT e.sourceId, anc.depth + 1
        FROM edges e
        JOIN anc ON e.targetId = anc.id
        WHERE anc.depth < @maxDepth AND e.type = 'contains'
      )
      SELECT DISTINCT n.* FROM nodes n
      JOIN anc ON n.id = anc.id
      WHERE n.id != @nodeId
    `).all({ nodeId, maxDepth }) as any[];
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Find descendants (child classes, implementors, contained members) — traverse downward.
   *
   * @param nodeId - Starting node ID
   * @param maxDepth - Maximum traversal depth (default 10)
   */
  findDescendants(nodeId: string, maxDepth: number = 10): GraphNode[] {
    // Single recursive CTE replaces N+1 JavaScript BFS loop
    const rows = this.db.prepare(`
      WITH RECURSIVE desc_tree(id, depth) AS (
        SELECT @nodeId, 0
        UNION
        SELECT e.targetId, desc_tree.depth + 1
        FROM edges e
        JOIN desc_tree ON e.sourceId = desc_tree.id
        WHERE desc_tree.depth < @maxDepth AND e.type = 'contains'
        UNION
        SELECT e.sourceId, desc_tree.depth + 1
        FROM edges e
        JOIN desc_tree ON e.targetId = desc_tree.id
        WHERE desc_tree.depth < @maxDepth AND e.type IN ('inherits', 'implements')
      )
      SELECT DISTINCT n.* FROM nodes n
      JOIN desc_tree ON n.id = desc_tree.id
      WHERE n.id != @nodeId
    `).all({ nodeId, maxDepth }) as any[];
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Blast radius analysis: find all nodes transitively affected if a node changes.
   *
   * Traces through calls, imports, inherits, implements, and uses edges.
   *
   * @param nodeId - The changed node
   * @param maxDepth - Maximum traversal depth (default 5)
   * @returns All nodes that depend on the changed node
   */
  blastRadius(nodeId: string, maxDepth: number = 5): GraphNode[] {
    // Single recursive CTE replaces N+1 JavaScript BFS loop
    // Traces reverse dependencies: who depends on this node, transitively
    const rows = this.db.prepare(`
      WITH RECURSIVE blast(id, depth) AS (
        SELECT @nodeId, 0
        UNION
        SELECT e.sourceId, blast.depth + 1
        FROM edges e
        JOIN blast ON e.targetId = blast.id
        WHERE blast.depth < @maxDepth
          AND e.type IN ('calls','imports','inherits','implements','uses','depends_on')
      )
      SELECT DISTINCT n.* FROM nodes n
      JOIN blast ON n.id = blast.id
      WHERE n.id != @nodeId
    `).all({ nodeId, maxDepth }) as any[];
    return rows.map((r: any) => this.rowToNode(r));
  }

  // ============================================================
  // Full-Text Search
  // ============================================================

  /**
   * Full-text search across node names, signatures, and doc comments.
   *
   * Uses FTS5 with porter stemming and unicode support, combined with
   * LIKE search for exact substring matching. CamelCase/PascalCase queries
   * are split into individual words for FTS5 matching.
   *
   * @param query - Search query
   * @param limit - Maximum results (default 20)
   * @returns Matching nodes sorted by relevance
   */
  search(query: string, limit: number = 40): GraphNode[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const likePattern = `%${trimmed}%`;
    const sanitized = this.sanitizeFtsQuery(trimmed);

    // Always run LIKE search. Combine with FTS via UNION when sanitized query is non-empty.
    try {
      if (sanitized) {
        // Use FTS5 bm25() for proper information-retrieval ranking
        // 4 weights for 4 searchable columns (id is UNINDEXED): name=10, qualifiedName=5, signature=3, docComment=1
        const rows = this.db.prepare(`
          SELECT * FROM (
            SELECT n.*, bm25(nodes_fts, 10, 5, 3, 1) AS bm25_score,
            CASE
              WHEN n.name = @query THEN 0
              WHEN n.name LIKE @like THEN 1
              WHEN n.qualifiedName LIKE @like THEN 2
              ELSE 3
            END AS exact_bonus
            FROM nodes_fts fts
            JOIN nodes n ON fts.id = n.id
            WHERE nodes_fts MATCH @fts

            UNION

            SELECT n.*, 0 AS bm25_score,
            CASE
              WHEN n.name = @query THEN 0
              WHEN n.name LIKE @like THEN 1
              WHEN n.qualifiedName LIKE @like THEN 2
              WHEN n.signature LIKE @like THEN 3
              ELSE 4
            END AS exact_bonus
            FROM nodes n
            WHERE n.name LIKE @like
              OR n.qualifiedName LIKE @like
              OR n.signature LIKE @like
              OR n.docComment LIKE @like
          )
          GROUP BY id
          ORDER BY MIN(exact_bonus), MIN(bm25_score), name
          LIMIT @limit
        `).all({ query: trimmed, like: likePattern, fts: sanitized, limit }) as any[];

        if (rows.length > 0) {
          return rows.map((r: any) => this.rowToNode(r));
        }
        // FTS + LIKE found nothing, try LIKE-only
        const likeResults = this.searchLike(trimmed, limit);
        if (likeResults.length > 0) return likeResults;
      } else {
        // Sanitized FTS query was empty — fall back to LIKE-only search
        const likeResults = this.searchLike(trimmed, limit);
        if (likeResults.length > 0) return likeResults;
      }
    } catch {
      const likeResults = this.searchLike(trimmed, limit);
      if (likeResults.length > 0) return likeResults;
    }

    // Strategy 3: Fuzzy word-level matching (splits query into words, matches each independently)
    return this.searchFuzzy(trimmed, limit);
  }

  /** Split camelCase/PascalCase into words and build an FTS5 AND query.
   *  Returns empty string if the input is empty/whitespace-only or produces no valid words. */
  private sanitizeFtsQuery(query: string): string {
    if (!query || query.trim().length === 0) return '';
    // Security: strip all FTS5 operators including *, :, - to prevent query injection
    const stripped = query.replace(/[{}[\]()^~@!$"*:\-]/g, ' ');

    const words: string[] = [];
    for (const token of stripped.split(/\s+/).filter(Boolean)) {
      const parts = token
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_./\\]/g, ' ')
        .split(/\s+/)
        .map(p => p.toLowerCase())
        .filter(p => /^[a-z0-9]+$/i.test(p))  // Security: only alphanumeric words
        .filter(Boolean);
      words.push(...parts);
    }

    if (words.length === 0) return '';
    return words.map(w => `"${w}"`).join(' AND ');
  }

  /** Fuzzy word-level search: splits query into words and matches each independently */
  private searchFuzzy(query: string, limit: number): GraphNode[] {
    const words = query
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-./\\]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .map(w => `%${w.toLowerCase()}%`);

    if (words.length === 0) return [];

    // Search for nodes where name/qualifiedName/signature contains ANY of the words
    const allMatches: GraphNode[] = [];
    const seen = new Set<string>();

    for (const pattern of words) {
      try {
        const rows = this.db.prepare(`
          SELECT * FROM nodes
          WHERE LOWER(name) LIKE ? OR LOWER(qualifiedName) LIKE ? OR LOWER(signature) LIKE ?
          LIMIT 20
        `).all(pattern, pattern, pattern) as any[];

        for (const row of rows) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            allMatches.push(this.rowToNode(row));
          }
        }
      } catch {
        // ignore
      }
      if (allMatches.length >= limit) break;
    }

    return allMatches.slice(0, limit);
  }

  /** Fallback LIKE-based search */
  private searchLike(query: string, limit: number): GraphNode[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM nodes
      WHERE name LIKE ? OR qualifiedName LIKE ? OR signature LIKE ? OR docComment LIKE ?
      ORDER BY
        CASE
          WHEN name = ? THEN 0
          WHEN name LIKE ? THEN 1
          WHEN qualifiedName LIKE ? THEN 2
          WHEN signature LIKE ? THEN 3
          ELSE 4
        END,
        name
      LIMIT ?
    `).all(pattern, pattern, pattern, pattern, query, pattern, pattern, pattern, limit) as any[];

    return rows.map((r: any) => this.rowToNode(r));
  }

  // ============================================================
  // File & Project Queries
  // ============================================================

  /**
   * Get the structural overview of a single file (all nodes in that file).
   */
  getFileStructure(filePath: string): GraphNode[] {
    const rows = this.db.prepare(
      'SELECT * FROM nodes WHERE filePath = ? ORDER BY startLine',
    ).all(filePath) as any[];
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Get the content hash for a file node (used for change detection).
   */
  getFileHash(filePath: string): string | null {
    const row = this.stmt(
      "SELECT hash FROM nodes WHERE filePath = ? AND type = 'file' LIMIT 1",
    ).get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /**
   * Get all indexed file paths.
   */
  getIndexedFiles(): string[] {
    const rows = this.stmt(
      "SELECT DISTINCT filePath FROM nodes WHERE type = 'file' ORDER BY filePath",
    ).all() as { filePath: string }[];
    return rows.map(r => r.filePath);
  }

  /**
   * Get the project overview: all files with their symbols.
   *
   * Returns a compact representation of the entire project structure,
   * suitable for a repo map / table of contents.
   *
   * Includes nested members (class methods, interface members) — not
   * just top-level symbols — so the AI actually knows what each class does.
   *
   * Uses a single SQL query instead of one-per-file (N+1 → 1).
   */
  getProjectOverview(): { overview: Map<string, GraphNode[]>; totalNodes: number; isTruncated: boolean } {
    const overview = new Map<string, GraphNode[]>();
    const NODE_LIMIT = 50000;

    // Count total non-file nodes first so the caller knows if the result is partial
    const totalNodes = (this.db.prepare(
      "SELECT COUNT(*) as count FROM nodes WHERE type != 'file'"
    ).get() as { count: number }).count;

    // Single query: get non-file nodes, capped at NODE_LIMIT to prevent OOM on huge repos
    const allSymbols = this.db.prepare(`
      SELECT * FROM nodes
      WHERE type != 'file'
      ORDER BY filePath, startLine
      LIMIT ?
    `).all(NODE_LIMIT) as any[];

    for (const row of allSymbols) {
      const node = this.rowToNode(row);
      if (!overview.has(node.filePath)) {
        overview.set(node.filePath, []);
      }
      overview.get(node.filePath)!.push(node);
    }

    return { overview, totalNodes, isTruncated: totalNodes > NODE_LIMIT };
  }

  /**
   * Get a compact string representation of a file's structure.
   * Shows only signatures, not full code — key for token reduction.
   */
  getFileSignatures(filePath: string): string {
    const nodes = this.getFileStructure(filePath);
    if (nodes.length === 0) return '';

    const lines: string[] = [`// ${filePath}`];
    for (const node of nodes) {
      if (node.type === 'file') continue;

      const indent = node.qualifiedName.includes('.') ? '  ' : '';
      const prefix = node.docComment ? `${indent}/** ${node.docComment.split('\n')[0]} */\n` : '';
      lines.push(`${prefix}${indent}${node.signature}`);
    }

    return lines.join('\n');
  }

  // ============================================================
  // Statistics
  // ============================================================

  /**
   * Get graph statistics.
   */
  getStats(): {
    totalNodes: number;
    totalEdges: number;
    totalFiles: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
    languageBreakdown: Record<string, number>;
  } {
    // Return cached stats if <5 seconds old (avoids 6 COUNT queries per tool response)
    const now = Date.now();
    if (this._statsCache && now - this._statsCache.time < 5000) {
      return this._statsCache.data;
    }

    const totalNodes = (this.stmt('SELECT COUNT(*) as count FROM nodes').get() as any).count;
    const totalEdges = (this.stmt('SELECT COUNT(*) as count FROM edges').get() as any).count;
    const totalFiles = (this.stmt("SELECT COUNT(*) as count FROM nodes WHERE type = 'file'").get() as any).count;

    const nodesByTypeRows = this.stmt(
      'SELECT type, COUNT(*) as count FROM nodes GROUP BY type',
    ).all() as { type: string; count: number }[];
    const nodesByType: Record<string, number> = {};
    for (const { type, count } of nodesByTypeRows) {
      nodesByType[type] = count;
    }

    const edgesByTypeRows = this.stmt(
      'SELECT type, COUNT(*) as count FROM edges GROUP BY type',
    ).all() as { type: string; count: number }[];
    const edgesByType: Record<string, number> = {};
    for (const { type, count } of edgesByTypeRows) {
      edgesByType[type] = count;
    }

    const langRows = this.stmt(
      "SELECT language, COUNT(*) as count FROM nodes WHERE type = 'file' GROUP BY language",
    ).all() as { language: string; count: number }[];
    const languageBreakdown: Record<string, number> = {};
    for (const { language, count } of langRows) {
      languageBreakdown[language] = count;
    }

    const result = { totalNodes, totalEdges, totalFiles, nodesByType, edgesByType, languageBreakdown };
    this._statsCache = { data: result, time: now };
    return result;
  }

  // ============================================================
  // Bulk Operations
  // ============================================================

  /**
   * Replace all nodes and edges for a file atomically.
   *
   * Deletes existing nodes/edges for the file, then inserts new ones.
   * This is the primary method used by the indexer during re-parsing.
   */
  replaceFileData(filePath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    this.db.transaction(() => {
      this.deleteFileNodes(filePath);
      this.upsertNodes(nodes);
      this.upsertEdges(edges);
    })();
    this.adjDirty = true;
    this._statsCache = null;
  }

  /**
   * Replace data for MANY files in a single transaction.
   *
   * Used by the indexer's fullIndex to avoid 1-transaction-per-file overhead.
   * Optionally upserts file_index entries when mtime metadata is provided.
   * When skipDelete is true (after clearProject), skips per-file delete for speed.
   */
  batchReplaceFileData(items: Array<{filePath: string, nodes: GraphNode[], edges: GraphEdge[], mtimeMs?: number, sizeBytes?: number, contentHash?: string}>, skipDelete = false): void {
    // Prepare all statements ONCE outside the transaction
    const deleteEdgesForNode = this.db.prepare(
      'DELETE FROM edges WHERE sourceId = ? OR targetId = ?'
    );
    const selectNodeIds = this.db.prepare(
      'SELECT id FROM nodes WHERE filePath = ?'
    );
    const deleteNodes = this.db.prepare(
      'DELETE FROM nodes WHERE filePath = ?'
    );
    const insertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (
        id, type, name, qualifiedName, filePath, startLine, endLine,
        signature, docComment, hash, language, visibility,
        isAsync, isStatic, isExported, parameters, returnType, updatedAt
      ) VALUES (
        @id, @type, @name, @qualifiedName, @filePath, @startLine, @endLine,
        @signature, @docComment, @hash, @language, @visibility,
        @isAsync, @isStatic, @isExported, @parameters, @returnType, @updatedAt
      )
    `);
    const insertEdge = this.db.prepare(`
      INSERT OR REPLACE INTO edges (sourceId, targetId, type, metadata)
      VALUES (@sourceId, @targetId, @type, @metadata)
    `);
    const upsertFileIdx = this.db.prepare(`
      INSERT OR REPLACE INTO file_index (file_path, mtime_ms, size_bytes, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    // ONE transaction for ALL files
    this.db.transaction(() => {
      for (const item of items) {
        // Delete existing nodes/edges for this file (skip if clearProject already ran)
        if (!skipDelete) {
          const nodeIds = selectNodeIds.all(item.filePath) as { id: string }[];
          if (nodeIds.length > 0) {
            for (const { id } of nodeIds) {
              deleteEdgesForNode.run(id, id);
            }
            deleteNodes.run(item.filePath);
          }
        }

        // Insert new nodes
        for (const node of item.nodes) {
          insertNode.run({
            id: node.id,
            type: node.type,
            name: node.name,
            qualifiedName: node.qualifiedName,
            filePath: node.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            docComment: node.docComment,
            hash: node.hash,
            language: node.language,
            visibility: node.visibility,
            isAsync: node.isAsync ? 1 : 0,
            isStatic: node.isStatic ? 1 : 0,
            isExported: node.isExported ? 1 : 0,
            parameters: this.serializeParams(node.parameters),
            returnType: node.returnType ?? null,
            updatedAt: node.updatedAt,
          });
        }

        // Insert new edges
        for (const edge of item.edges) {
          insertEdge.run({
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            type: edge.type,
            metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
          });
        }

        // Update file index
        if (item.mtimeMs !== undefined) {
          upsertFileIdx.run(item.filePath, item.mtimeMs, item.sizeBytes ?? 0, item.contentHash ?? '', Date.now());
        }
      }
    })();
    this.adjDirty = true;
    this._statsCache = null;
  }

  /**
   * Optimized insert for full reindex (no existing data, skip conflict checks).
   * Optimized for full reindex: uses INSERT OR REPLACE but skips per-file deletion.
   */
  batchInsertFileData(items: Array<{filePath: string, nodes: GraphNode[], edges: GraphEdge[], mtimeMs?: number, sizeBytes?: number, contentHash?: string}>): void {
    const insertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (
        id, type, name, qualifiedName, filePath, startLine, endLine,
        signature, docComment, hash, language, visibility,
        isAsync, isStatic, isExported, parameters, returnType, updatedAt
      ) VALUES (
        @id, @type, @name, @qualifiedName, @filePath, @startLine, @endLine,
        @signature, @docComment, @hash, @language, @visibility,
        @isAsync, @isStatic, @isExported, @parameters, @returnType, @updatedAt
      )
    `);
    const insertEdge = this.db.prepare(`
      INSERT OR REPLACE INTO edges (sourceId, targetId, type, metadata)
      VALUES (@sourceId, @targetId, @type, @metadata)
    `);
    const insertFileIdx = this.db.prepare(`
      INSERT OR REPLACE INTO file_index (file_path, mtime_ms, size_bytes, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      for (const item of items) {
        for (const node of item.nodes) {
          insertNode.run({
            id: node.id,
            type: node.type,
            name: node.name,
            qualifiedName: node.qualifiedName,
            filePath: node.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            docComment: node.docComment,
            hash: node.hash,
            language: node.language,
            visibility: node.visibility,
            isAsync: node.isAsync ? 1 : 0,
            isStatic: node.isStatic ? 1 : 0,
            isExported: node.isExported ? 1 : 0,
            parameters: this.serializeParams(node.parameters),
            returnType: node.returnType ?? null,
            updatedAt: node.updatedAt,
          });
        }
        for (const edge of item.edges) {
          insertEdge.run({
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            type: edge.type,
            metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
          });
        }
        if (item.mtimeMs !== undefined) {
          insertFileIdx.run(item.filePath, item.mtimeMs, item.sizeBytes ?? 0, item.contentHash ?? '', Date.now());
        }
      }
    })();
    this.adjDirty = true;
    this._statsCache = null;
  }

  /**
   * Get all node IDs in the graph (used for PageRank).
   */
  getAllNodeIds(): string[] {
    return this.stmt('SELECT id FROM nodes').pluck().all() as string[];
  }

  /**
   * Get all edges in the graph (used for PageRank adjacency matrix).
   * @param limit Maximum number of edges to return (default 200000, prevents OOM)
   */
  getAllEdges(limit: number = 200000): GraphEdge[] {
    // Security fix (H-1): cap result set to prevent OOM on large codebases
    const safeLimit = Math.min(Math.max(1, limit), 500000);
    const rows = this.db.prepare('SELECT * FROM edges LIMIT ?').all(safeLimit) as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? (() => { try { return JSON.parse(r.metadata); } catch { return undefined; } })() : undefined,
    }));
  }

  /**
   * Get nodes by a list of IDs (used by PageRank to return ranked results).
   */
  getNodesByIds(ids: string[]): GraphNode[] {
    if (ids.length === 0) return [];

    const nodeMap = new Map<string, GraphNode>();
    // Chunk to stay within SQLite parameter limits (~999 max)
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT * FROM nodes WHERE id IN (${placeholders})`,
      ).all(...chunk) as any[];
      for (const row of rows) {
        nodeMap.set(row.id, this.rowToNode(row));
      }
    }

    // Preserve input order
    return ids.map(id => nodeMap.get(id)).filter((n): n is GraphNode => n !== undefined);
  }

  /**
   * Clear all data from the graph.
   */
  clear(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM edges').run();
      this.db.prepare('DELETE FROM nodes').run();
    })();
    this.adjDirty = true;
    this._statsCache = null;
  }

  /**
   * Clear only nodes and edges belonging to files under a specific project root.
   * Preserves data from other projects in the graph.
   */
  clearProject(projectRoot: string): number {
    // Normalize: ensure trailing separator for prefix matching
    const prefix = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const altPrefix = projectRoot.replace(/\//g, '\\').replace(/\\$/, '') + '\\';

    const result = this.db.transaction(() => {
      // Find all node IDs for this project
      const nodeIds = this.db.prepare(
        'SELECT id FROM nodes WHERE filePath LIKE ? OR filePath LIKE ?'
      ).all(`${prefix}%`, `${altPrefix}%`) as Array<{ id: string }>;

      if (nodeIds.length === 0) return 0;

      // Delete edges referencing these nodes
      const idList = nodeIds.map(n => n.id);
      // Batch in chunks of 500 to stay within SQLite limits
      for (let i = 0; i < idList.length; i += 500) {
        const chunk = idList.slice(i, i + 500);
        const placeholders = chunk.map(() => '?').join(',');
        this.db.prepare(
          `DELETE FROM edges WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})`
        ).run(...chunk, ...chunk);
      }

      // Delete nodes for this project
      const del = this.db.prepare(
        'DELETE FROM nodes WHERE filePath LIKE ? OR filePath LIKE ?'
      ).run(`${prefix}%`, `${altPrefix}%`);

      // Delete file_index entries for this project
      this.db.prepare(
        'DELETE FROM file_index WHERE file_path LIKE ? OR file_path LIKE ?'
      ).run(`${prefix}%`, `${altPrefix}%`);

      return del.changes;
    })();

    this.adjDirty = true;
    this._statsCache = null;
    return result;
  }

  // ============================================================
  // Learned Rules (Self-Evolving AI)
  // ============================================================

  /** Rule type for the learned_rules table */
  static readonly RULE_TYPES = ['classification', 'search_alias', 'code_pattern', 'convention'] as const;

  /**
   * Teach the system a new rule. The rule persists in SQLite and is
   * loaded automatically on future sessions.
   */
  addLearnedRule(rule: {
    type: 'classification' | 'search_alias' | 'code_pattern' | 'convention';
    name: string;
    description: string;
    rule: Record<string, unknown>;
    createdBy?: 'ai' | 'user';
  }): { id: string; created: boolean } {
    const id = `lr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    // Check for duplicate by name + type
    const existing = this.db.prepare(
      'SELECT id FROM learned_rules WHERE name = ? AND type = ?',
    ).get(rule.name, rule.type) as { id: string } | undefined;

    if (existing) {
      // Update existing rule
      this.db.prepare(
        'UPDATE learned_rules SET description = ?, rule = ?, updated_at = ? WHERE id = ?',
      ).run(rule.description, JSON.stringify(rule.rule), now, existing.id);
      return { id: existing.id, created: false };
    }

    this.db.prepare(`
      INSERT INTO learned_rules (id, type, name, description, rule, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, rule.type, rule.name, rule.description, JSON.stringify(rule.rule), now, now, rule.createdBy ?? 'ai');

    return { id, created: true };
  }

  /**
   * Get all learned rules, optionally filtered by type.
   */
  getLearnedRules(type?: string): Array<{
    id: string;
    type: string;
    name: string;
    description: string;
    rule: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    usedCount: number;
    lastUsedAt: number | null;
    createdBy: string;
  }> {
    let rows: any[];
    if (type) {
      rows = this.db.prepare('SELECT * FROM learned_rules WHERE type = ? ORDER BY used_count DESC').all(type);
    } else {
      rows = this.db.prepare('SELECT * FROM learned_rules ORDER BY type, used_count DESC').all();
    }

    return rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      description: r.description,
      rule: JSON.parse(r.rule),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      usedCount: r.used_count,
      lastUsedAt: r.last_used_at,
      createdBy: r.created_by,
    }));
  }

  /**
   * Increment usage counter for a learned rule (called when the rule is actually applied).
   */
  touchLearnedRule(id: string): void {
    this.db.prepare(
      'UPDATE learned_rules SET used_count = used_count + 1, last_used_at = ? WHERE id = ?',
    ).run(Date.now(), id);
  }

  /**
   * Delete a learned rule by ID or name.
   */
  deleteLearnedRule(idOrName: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM learned_rules WHERE id = ? OR name = ?',
    ).run(idOrName, idOrName);
    return result.changes > 0;
  }

  /**
   * Get classification rules learned by the AI.
   * Returns them in a format ready to merge with CLASSIFICATION_SIGNALS.
   */
  getLearnedClassificationRules(): Array<{
    layer: string;
    source: string;
    patterns: string[];    // regex strings
    weight: number;
    name: string;
    id: string;
  }> {
    const rules = this.getLearnedRules('classification');
    return rules.map(r => ({
      layer: (r.rule as any).layer ?? 'unknown',
      source: (r.rule as any).source ?? 'path',
      patterns: (r.rule as any).patterns ?? [],
      weight: (r.rule as any).weight ?? 2,
      name: r.name,
      id: r.id,
    }));
  }

  /**
   * Get search aliases learned by the AI.
   * When user searches for X, also search for Y, Z.
   */
  getLearnedSearchAliases(): Array<{
    term: string;
    aliases: string[];
    id: string;
  }> {
    const rules = this.getLearnedRules('search_alias');
    return rules.map(r => ({
      term: (r.rule as any).term ?? r.name,
      aliases: (r.rule as any).aliases ?? [],
      id: r.id,
    }));
  }

  // ============================================================
  // File Index (Staleness Detection)
  // ============================================================

  /**
   * Get stored file index entry for staleness comparison.
   */
  getFileIndexEntry(filePath: string): { mtime_ms: number; size_bytes: number; content_hash: string; indexed_at: number } | null {
    return this.stmt(
      'SELECT mtime_ms, size_bytes, content_hash, indexed_at FROM file_index WHERE file_path = ?'
    ).get(filePath) as any ?? null;
  }

  /**
   * Upsert a file index entry after indexing.
   */
  upsertFileIndex(filePath: string, mtimeMs: number, sizeBytes: number, contentHash: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO file_index (file_path, mtime_ms, size_bytes, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(filePath, mtimeMs, sizeBytes, contentHash, Date.now());
  }

  /**
   * Remove a file from the index tracking table.
   */
  removeFileIndex(filePath: string): void {
    this.db.prepare('DELETE FROM file_index WHERE file_path = ?').run(filePath);
  }

  /**
   * Get all tracked files for staleness checking.
   */
  getAllFileIndexEntries(): Array<{ file_path: string; mtime_ms: number; size_bytes: number; content_hash: string; indexed_at: number }> {
    return this.db.prepare('SELECT * FROM file_index').all() as any[];
  }

  /**
   * Count tracked files in file_index.
   */
  getFileIndexCount(): number {
    return (this.stmt('SELECT COUNT(*) as c FROM file_index').get() as any)?.c ?? 0;
  }

  /**
   * Count nodes belonging to a specific project path.
   * Used to check if a project has existing indexed data without scanning files.
   * Returns count instantly from SQLite index.
   */
  getProjectNodeCount(projectRoot: string): number {
    const prefix = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const altPrefix = projectRoot.replace(/\//g, '\\').replace(/\\$/, '') + '\\';
    return (this.db.prepare(
      'SELECT COUNT(*) as c FROM nodes WHERE filePath LIKE ? OR filePath LIKE ?'
    ).get(`${prefix}%`, `${altPrefix}%`) as any)?.c ?? 0;
  }

  /**
   * Remove orphaned edges (edges pointing to non-existent nodes).
   * Should be called periodically or after reindexing.
   */
  cleanOrphanedEdges(): number {
    const result = this.db.prepare(`
      DELETE FROM edges
      WHERE sourceId NOT IN (SELECT id FROM nodes)
         OR targetId NOT IN (SELECT id FROM nodes)
    `).run();
    return result.changes;
  }

  // ============================================================
  // Bulk Mode & Index Management (Performance Optimizations)
  // ============================================================

  /** Drop FTS triggers for bulk operations */
  private dropFtsTriggers(): void {
    this.db.exec('DROP TRIGGER IF EXISTS nodes_ai');
    this.db.exec('DROP TRIGGER IF EXISTS nodes_ad');
    this.db.exec('DROP TRIGGER IF EXISTS nodes_au');
  }

  /** Recreate FTS triggers and rebuild FTS index */
  private recreateFtsTriggers(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, id, name, qualifiedName, signature, docComment)
        VALUES (new.rowid, new.id, new.name, new.qualifiedName, new.signature, new.docComment);
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualifiedName, signature, docComment)
        VALUES ('delete', old.rowid, old.id, old.name, old.qualifiedName, old.signature, old.docComment);
      END;
      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualifiedName, signature, docComment)
        VALUES ('delete', old.rowid, old.id, old.name, old.qualifiedName, old.signature, old.docComment);
        INSERT INTO nodes_fts(rowid, id, name, qualifiedName, signature, docComment)
        VALUES (new.rowid, new.id, new.name, new.qualifiedName, new.signature, new.docComment);
      END;
    `);
  }

  /** Rebuild FTS index from current nodes data */
  private rebuildFts(): void {
    this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  /** Drop all performance indexes (for bulk insert) */
  private dropIndexes(): void {
    this.db.exec('DROP INDEX IF EXISTS idx_nodes_filePath');
    this.db.exec('DROP INDEX IF EXISTS idx_nodes_type');
    this.db.exec('DROP INDEX IF EXISTS idx_nodes_name');
    this.db.exec('DROP INDEX IF EXISTS idx_nodes_language');
    this.db.exec('DROP INDEX IF EXISTS idx_nodes_hash');
    this.db.exec('DROP INDEX IF EXISTS idx_edges_source_type');
    this.db.exec('DROP INDEX IF EXISTS idx_edges_target_type');
    this.db.exec('DROP INDEX IF EXISTS idx_edges_type');
    // Also drop old single-column indexes if they exist from previous versions
    this.db.exec('DROP INDEX IF EXISTS idx_edges_sourceId');
    this.db.exec('DROP INDEX IF EXISTS idx_edges_targetId');
  }

  /** Recreate all performance indexes */
  private recreateIndexes(): void {
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_filePath ON nodes(filePath)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_hash ON nodes(hash)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(sourceId, type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(targetId, type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type)');
  }

  /** Enter bulk insert mode - relaxes safety for speed while maintaining WAL durability */
  enterBulkMode(): void {
    // Security fix (H-2): Use NORMAL instead of OFF to prevent DB corruption on crash
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456');
    this.dropFtsTriggers();
    this.dropIndexes();
    // Clear content FTS before rebuild (it will be repopulated during indexing)
    this.db.exec('DELETE FROM content_fts');
  }

  /** Exit bulk insert mode - restores safety and rebuilds indexes/FTS */
  exitBulkMode(): void {
    this.invalidateAdjCache();
    this.recreateIndexes();
    this.recreateFtsTriggers();
    this.rebuildFts();
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = DEFAULT');
    this.db.pragma('mmap_size = 0');
    // WAL checkpoint after bulk ops, then restore normal auto-checkpointing
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('wal_autocheckpoint = 1000');
  }

  /**
   * Build in-memory adjacency cache for ultra-fast graph traversal.
   * Called automatically on first traversal query after index.
   * ~2MB RAM for 13K edges — negligible.
   */
  buildAdjacencyCache(): void {
    this.adjOut.clear();
    this.adjIn.clear();
    const rows = this.stmt('SELECT sourceId, targetId, type FROM edges').all() as any[];
    for (const r of rows) {
      // Forward: sourceId → type → [targetIds]
      if (!this.adjOut.has(r.sourceId)) this.adjOut.set(r.sourceId, new Map());
      const fwd = this.adjOut.get(r.sourceId)!;
      if (!fwd.has(r.type)) fwd.set(r.type, []);
      fwd.get(r.type)!.push(r.targetId);
      // Reverse: targetId → type → [sourceIds]
      if (!this.adjIn.has(r.targetId)) this.adjIn.set(r.targetId, new Map());
      const rev = this.adjIn.get(r.targetId)!;
      if (!rev.has(r.type)) rev.set(r.type, []);
      rev.get(r.type)!.push(r.sourceId);
    }
    this.adjDirty = false;
  }

  /** Invalidate adjacency cache (call after any edge mutation) */
  invalidateAdjCache(): void {
    this.adjDirty = true;
    this._statsCache = null;
    this._stmtCache.clear(); // Also clear stmt cache on schema changes
  }

  /** Get callers from adjacency cache (in-memory, sub-microsecond) */
  getCallersFromCache(nodeId: string): string[] {
    if (this.adjDirty) this.buildAdjacencyCache();
    return this.adjIn.get(nodeId)?.get('calls') ?? [];
  }

  /** Get callees from adjacency cache (in-memory, sub-microsecond) */
  getCalleesFromCache(nodeId: string): string[] {
    if (this.adjDirty) this.buildAdjacencyCache();
    return this.adjOut.get(nodeId)?.get('calls') ?? [];
  }

  /** Get reverse dependencies from adjacency cache for blast radius */
  getReverseDepsFromCache(nodeId: string, types: string[]): string[] {
    if (this.adjDirty) this.buildAdjacencyCache();
    const byType = this.adjIn.get(nodeId);
    if (!byType) return [];
    const result: string[] = [];
    for (const t of types) {
      const ids = byType.get(t);
      if (ids) result.push(...ids);
    }
    return result;
  }

  /**
   * Shortest path between two nodes via dependency edges.
   * Returns the path as an array of node IDs, or empty if no path exists.
   */
  shortestPath(startId: string, endId: string, maxDepth: number = 10): string[] {
    try {
      const rows = this.db.prepare(`
        WITH RECURSIVE path(id, depth, route) AS (
          SELECT ?1, 0, ?1
          UNION ALL
          SELECT e.targetId, path.depth + 1, path.route || '>' || e.targetId
          FROM edges e
          JOIN path ON e.sourceId = path.id
          WHERE path.depth < ?3
            AND e.type IN ('calls','imports','inherits','implements','uses','depends_on')
            AND instr(path.route, e.targetId) = 0
        )
        SELECT route FROM path WHERE id = ?2
        ORDER BY depth LIMIT 1
      `).get(startId, endId, maxDepth) as { route: string } | undefined;
      return rows ? rows.route.split('>') : [];
    } catch {
      return [];
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /** Check database health — verifies tables exist and are queryable */
  isHealthy(): { healthy: boolean; error?: string; stats?: { nodes: number; edges: number; files: number } } {
    try {
      const nodes = (this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as any).c;
      const edges = (this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as any).c;
      const files = (this.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE type = 'file'").get() as any).c;
      // Verify FTS is working
      this.db.prepare("SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'test' LIMIT 1").all();
      return { healthy: true, stats: { nodes, edges, files } };
    } catch (err: any) {
      return { healthy: false, error: err?.message ?? String(err) };
    }
  }

  // ============================================================
  // Content FTS (Full-Text Code Search)
  // ============================================================

  /** Clear all content FTS entries */
  clearContentFts(): void {
    this.db.exec('DELETE FROM content_fts');
  }

  /** Index file content for FTS5 search */
  indexFileContent(filePath: string, content: string): void {
    // Delete existing entry first
    this.db.prepare('DELETE FROM content_fts WHERE file_path = ?').run(filePath);
    this.db.prepare('INSERT INTO content_fts (file_path, content) VALUES (?, ?)').run(filePath, content);
  }

  /** Batch index file contents. skipDelete=true during full reindex (table already cleared by enterBulkMode). */
  batchIndexContents(items: Array<{ filePath: string; content: string }>, skipDelete: boolean = false): void {
    const ins = this.db.prepare('INSERT INTO content_fts (file_path, content) VALUES (?, ?)');
    if (skipDelete) {
      const txn = this.db.transaction((batch: Array<{ filePath: string; content: string }>) => {
        for (const item of batch) {
          ins.run(item.filePath, item.content);
        }
      });
      txn(items);
    } else {
      const del = this.db.prepare('DELETE FROM content_fts WHERE file_path = ?');
      const txn = this.db.transaction((batch: Array<{ filePath: string; content: string }>) => {
        for (const item of batch) {
          del.run(item.filePath);
          ins.run(item.filePath, item.content);
        }
      });
      txn(items);
    }
  }

  /** Search file contents using FTS5 */
  searchContent(query: string, limit: number = 50): Array<{ filePath: string; snippet: string; rank: number }> {
    // Security fix (C-1): sanitize query to prevent FTS5 injection
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    // Cap limit to prevent unbounded result sets
    const safeLimit = Math.min(Math.max(1, limit), 200);

    try {
      return this.db.prepare(`
        SELECT 
          file_path as filePath,
          snippet(content_fts, 1, '>>>', '<<<', '...', 40) as snippet,
          rank
        FROM content_fts
        WHERE content MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, safeLimit) as any[];
    } catch {
      return [];
    }
  }

  /**
   * Check if the database is open.
   */
  get isOpen(): boolean {
    return this.db.open;
  }

  /**
   * Expose the underlying better-sqlite3 Database instance.
   *
   * Used by advanced query components (CypherEngine, DeadCodeDetector)
   * that need to run raw SQL against the same database.
   */
  getDb(): Database.Database {
    return this.db;
  }
}
