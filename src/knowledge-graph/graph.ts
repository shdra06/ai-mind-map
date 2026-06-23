/**
 * AI Mind Map — SQLite-backed Knowledge Graph with FTS5
 *
 * Stores and queries the structural knowledge graph of a codebase.
 * Provides CRUD operations, graph traversal, dependency chain tracing,
 * full-text search, and statistics.
 *
 * Inspired by codebase-memory-mcp's Cypher-like queries.
 */

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
CREATE INDEX IF NOT EXISTS idx_edges_sourceId ON edges(sourceId);
CREATE INDEX IF NOT EXISTS idx_edges_targetId ON edges(targetId);
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
`;

const SCHEMA_VERSION = '1';

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

  /**
   * Create or open a knowledge graph database.
   *
   * @param dbPath - Path to the SQLite database file (or ':memory:' for in-memory)
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read/write performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('cache_size = -64000'); // 64MB cache

    this.initializeSchema();
  }

  /** Initialize or migrate the database schema */
  private initializeSchema(): void {
    const currentVersion = this.getMeta('schema_version');

    if (currentVersion === SCHEMA_VERSION) {
      return; // Schema is current
    }

    if (currentVersion && currentVersion !== SCHEMA_VERSION) {
      // In future versions, add migration logic here
      // For now, drop and recreate
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
      'INSERT OR REPLACE INTO graph_meta (key, value) VALUES (?, ?)',
    ).run(key, value);
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
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    return row ? this.rowToNode(row) : null;
  }

  /**
   * Get nodes by name (may return multiple matches across files).
   */
  getNodesByName(name: string): GraphNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE name = ?').all(name);
    return rows.map((r: any) => this.rowToNode(r));
  }

  /**
   * Get all nodes of a specific type.
   */
  getNodesByType(type: NodeType): GraphNode[] {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE type = ?').all(type);
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

      // Delete edges referencing these nodes
      const placeholders = nodeIds.map(() => '?').join(',');
      this.db.prepare(
        `DELETE FROM edges WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})`,
      ).run(...nodeIds.map(n => n.id), ...nodeIds.map(n => n.id));

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
    const rows = this.db.prepare('SELECT * FROM edges WHERE sourceId = ?').all(nodeId) as any[];
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
    const rows = this.db.prepare('SELECT * FROM edges WHERE targetId = ?').all(nodeId) as any[];
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
    const rows = this.db.prepare(
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
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE targetId = ? AND type = ?',
    ).all(nodeId, type) as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Delete all edges for a specific file's nodes.
   */
  deleteFileEdges(filePath: string): void {
    const nodeIds = this.db.prepare('SELECT id FROM nodes WHERE filePath = ?')
      .all(filePath) as { id: string }[];

    if (nodeIds.length === 0) return;

    const placeholders = nodeIds.map(() => '?').join(',');
    this.db.prepare(
      `DELETE FROM edges WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})`,
    ).run(...nodeIds.map(n => n.id), ...nodeIds.map(n => n.id));
  }

  // ============================================================
  // Graph Traversal
  // ============================================================

  /**
   * Find all nodes that call a given node (callers / "who calls this?").
   */
  findCallers(nodeId: string): GraphNode[] {
    const rows = this.db.prepare(`
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
    const rows = this.db.prepare(`
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
    const visited = new Set<string>();
    const result: GraphNode[] = [];

    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || visited.has(current.id)) continue;
      visited.add(current.id);

      const parentEdges = this.db.prepare(`
        SELECT e.targetId FROM edges e
        WHERE e.sourceId = ? AND e.type IN ('inherits', 'implements', 'contains')
      `).all(current.id) as { targetId: string }[];

      for (const { targetId } of parentEdges) {
        if (!visited.has(targetId)) {
          const node = this.getNode(targetId);
          if (node) {
            result.push(node);
            queue.push({ id: targetId, depth: current.depth + 1 });
          }
        }
      }
    }

    return result;
  }

  /**
   * Find descendants (child classes, implementors, contained members) — traverse downward.
   *
   * @param nodeId - Starting node ID
   * @param maxDepth - Maximum traversal depth (default 10)
   */
  findDescendants(nodeId: string, maxDepth: number = 10): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];

    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || visited.has(current.id)) continue;
      visited.add(current.id);

      const childEdges = this.db.prepare(`
        SELECT e.sourceId FROM edges e
        WHERE e.targetId = ? AND e.type IN ('inherits', 'implements', 'contains')
      `).all(current.id) as { sourceId: string }[];

      for (const { sourceId } of childEdges) {
        if (!visited.has(sourceId)) {
          const node = this.getNode(sourceId);
          if (node) {
            result.push(node);
            queue.push({ id: sourceId, depth: current.depth + 1 });
          }
        }
      }
    }

    return result;
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
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const dependencyTypes: EdgeType[] = ['calls', 'imports', 'inherits', 'implements', 'uses', 'depends_on'];
    const typeFilter = dependencyTypes.map(t => `'${t}'`).join(',');

    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth || visited.has(current.id)) continue;
      visited.add(current.id);

      // Find nodes that depend ON this node (reverse dependency)
      const dependents = this.db.prepare(`
        SELECT e.sourceId FROM edges e
        WHERE e.targetId = ? AND e.type IN (${typeFilter})
      `).all(current.id) as { sourceId: string }[];

      for (const { sourceId } of dependents) {
        if (!visited.has(sourceId)) {
          const node = this.getNode(sourceId);
          if (node) {
            result.push(node);
            queue.push({ id: sourceId, depth: current.depth + 1 });
          }
        }
      }
    }

    return result;
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
  search(query: string, limit: number = 20): GraphNode[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const likePattern = `%${trimmed}%`;
    const sanitized = this.sanitizeFtsQuery(trimmed);

    // Always run LIKE search. Combine with FTS via UNION when possible.
    try {
      const rows = this.db.prepare(`
        SELECT * FROM (
          SELECT n.*, CASE
            WHEN n.name = @query THEN 0
            WHEN n.name LIKE @like THEN 1
            WHEN n.qualifiedName LIKE @like THEN 2
            WHEN n.signature LIKE @like THEN 3
            ELSE 4
          END AS relevance
          FROM nodes_fts fts
          JOIN nodes n ON fts.id = n.id
          WHERE nodes_fts MATCH @fts

          UNION

          SELECT n.*, CASE
            WHEN n.name = @query THEN 0
            WHEN n.name LIKE @like THEN 1
            WHEN n.qualifiedName LIKE @like THEN 2
            WHEN n.signature LIKE @like THEN 3
            ELSE 4
          END AS relevance
          FROM nodes n
          WHERE n.name LIKE @like
            OR n.qualifiedName LIKE @like
            OR n.signature LIKE @like
            OR n.docComment LIKE @like
        )
        GROUP BY id
        ORDER BY MIN(relevance), name
        LIMIT @limit
      `).all({ query: trimmed, like: likePattern, fts: sanitized, limit }) as any[];

      return rows.map((r: any) => this.rowToNode(r));
    } catch {
      return this.searchLike(trimmed, limit);
    }
  }

  /** Split camelCase/PascalCase into words and build an FTS5 AND query */
  private sanitizeFtsQuery(query: string): string {
    const stripped = query.replace(/[{}[\]()^~@!$]/g, ' ');

    const words: string[] = [];
    for (const token of stripped.split(/\s+/).filter(Boolean)) {
      const parts = token
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_\-./\\]/g, ' ')
        .split(/\s+/)
        .map(p => p.toLowerCase())
        .filter(Boolean);
      words.push(...parts);
    }

    if (words.length === 0) return '""';
    return words.map(w => `"${w}"`).join(' AND ');
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
    const row = this.db.prepare(
      "SELECT hash FROM nodes WHERE filePath = ? AND type = 'file' LIMIT 1",
    ).get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /**
   * Get all indexed file paths.
   */
  getIndexedFiles(): string[] {
    const rows = this.db.prepare(
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
  getProjectOverview(): Map<string, GraphNode[]> {
    const overview = new Map<string, GraphNode[]>();

    // Single query: get ALL non-file nodes, ordered by file then line
    const allSymbols = this.db.prepare(`
      SELECT * FROM nodes
      WHERE type != 'file'
      ORDER BY filePath, startLine
    `).all() as any[];

    for (const row of allSymbols) {
      const node = this.rowToNode(row);
      if (!overview.has(node.filePath)) {
        overview.set(node.filePath, []);
      }
      overview.get(node.filePath)!.push(node);
    }

    return overview;
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
    const totalNodes = (this.db.prepare('SELECT COUNT(*) as count FROM nodes').get() as any).count;
    const totalEdges = (this.db.prepare('SELECT COUNT(*) as count FROM edges').get() as any).count;
    const totalFiles = (this.db.prepare("SELECT COUNT(*) as count FROM nodes WHERE type = 'file'").get() as any).count;

    const nodesByTypeRows = this.db.prepare(
      'SELECT type, COUNT(*) as count FROM nodes GROUP BY type',
    ).all() as { type: string; count: number }[];
    const nodesByType: Record<string, number> = {};
    for (const { type, count } of nodesByTypeRows) {
      nodesByType[type] = count;
    }

    const edgesByTypeRows = this.db.prepare(
      'SELECT type, COUNT(*) as count FROM edges GROUP BY type',
    ).all() as { type: string; count: number }[];
    const edgesByType: Record<string, number> = {};
    for (const { type, count } of edgesByTypeRows) {
      edgesByType[type] = count;
    }

    const langRows = this.db.prepare(
      "SELECT language, COUNT(*) as count FROM nodes WHERE type = 'file' GROUP BY language",
    ).all() as { language: string; count: number }[];
    const languageBreakdown: Record<string, number> = {};
    for (const { language, count } of langRows) {
      languageBreakdown[language] = count;
    }

    return { totalNodes, totalEdges, totalFiles, nodesByType, edgesByType, languageBreakdown };
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
  }

  /**
   * Get all node IDs in the graph (used for PageRank).
   */
  getAllNodeIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM nodes').all() as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * Get all edges in the graph (used for PageRank adjacency matrix).
   */
  getAllEdges(): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM edges').all() as any[];
    return rows.map(r => ({
      sourceId: r.sourceId,
      targetId: r.targetId,
      type: r.type as EdgeType,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Get nodes by a list of IDs (used by PageRank to return ranked results).
   */
  getNodesByIds(ids: string[]): GraphNode[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM nodes WHERE id IN (${placeholders})`,
    ).all(...ids) as any[];

    // Preserve the order of the input IDs
    const nodeMap = new Map<string, GraphNode>();
    for (const row of rows) {
      nodeMap.set(row.id, this.rowToNode(row));
    }

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
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
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
