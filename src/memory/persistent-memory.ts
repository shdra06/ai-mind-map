/**
 * AI Mind Map — Persistent Memory Store
 *
 * Long-term memory with importance decay, BM25 text search (FTS5),
 * category/tag filtering, deduplication via text similarity, and
 * token-budget-constrained retrieval.
 *
 * Inspired by Mem0's memory lifecycle:
 *   create → access (boost) → decay → prune
 *
 * @module memory/persistent-memory
 */

import Database from 'better-sqlite3';
import type { Memory, MemoryCategory, MindMapConfig } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Default importance by category (higher = more important). */
const CATEGORY_IMPORTANCE: Record<MemoryCategory, number> = {
  architecture: 0.9,
  gotcha: 0.85,
  convention: 0.8,
  decision: 0.8,
  lesson_learned: 0.75,
  dependency: 0.7,
  workflow: 0.7,
  context: 0.6,
  preference: 0.55,
  todo: 0.5,
};

/** Rough estimate: 1 token ≈ 4 characters. */
const CHARS_PER_TOKEN = 4;

// ────────────────────────────────────────────────────────────────
// Public Types
// ────────────────────────────────────────────────────────────────

/** Parameters accepted when creating a new memory. */
export interface CreateMemoryInput {
  category: MemoryCategory;
  content: string;
  tags?: string[];
  relatedFiles?: string[];
  importance?: number;
  sessionId?: string;
  source?: Memory['source'];
}

/** Parameters for querying memories. */
export interface MemoryQuery {
  /** Free-text query matched via FTS5 BM25. */
  text?: string;
  /** Filter by one or more categories. */
  categories?: MemoryCategory[];
  /** Filter by tags (any match). */
  tags?: string[];
  /** Filter by related file paths (any match). */
  relatedFiles?: string[];
  /** Minimum importance score. */
  minImportance?: number;
  /** Maximum number of results. */
  limit?: number;
  /** Maximum total token budget for results. */
  tokenBudget?: number;
}

/** Aggregate statistics about stored memories. */
export interface MemoryStats {
  totalMemories: number;
  byCategory: Record<string, number>;
  averageImportance: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  totalAccessCount: number;
}

// ────────────────────────────────────────────────────────────────
// PersistentMemory Class
// ────────────────────────────────────────────────────────────────

/**
 * Long-term memory store with decay, boosting, FTS5 search, and deduplication.
 *
 * All mutations are synchronous (better-sqlite3) and WAL-mode safe.
 */
export class PersistentMemory {
  private db: Database.Database;
  private decayRate: number;
  private maxMemories: number;
  private importanceThreshold: number;

  // ── Prepared statements ────────────────────────────────────
  private stmtInsert!: Database.Statement;
  private stmtUpdate!: Database.Statement;
  private stmtDelete!: Database.Statement;
  private stmtGetById!: Database.Statement;
  private stmtBumpAccess!: Database.Statement;
  private stmtAll!: Database.Statement;
  private stmtCount!: Database.Statement;
  private stmtCategoryCount!: Database.Statement;
  private stmtAvgImportance!: Database.Statement;
  private stmtOldest!: Database.Statement;
  private stmtNewest!: Database.Statement;
  private stmtTotalAccess!: Database.Statement;
  private stmtPrunable!: Database.Statement;
  private stmtSearchFts!: Database.Statement;

  constructor(
    db: Database.Database,
    config?: Pick<MindMapConfig['memory'], 'decayRate' | 'maxMemories' | 'importanceThreshold'>,
  ) {
    this.db = db;
    this.decayRate = config?.decayRate ?? 0.95;
    this.maxMemories = config?.maxMemories ?? 500;
    this.importanceThreshold = config?.importanceThreshold ?? 0.1;

    this.ensureSchema();
    this.prepareStatements();
  }

  // ────────────────────────────────────────────────────────────
  // Schema
  // ────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        category        TEXT NOT NULL,
        content         TEXT NOT NULL,
        importance      REAL NOT NULL,
        tags            TEXT NOT NULL DEFAULT '[]',
        related_files   TEXT NOT NULL DEFAULT '[]',
        created_at      INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_count    INTEGER NOT NULL DEFAULT 0,
        session_id      TEXT NOT NULL DEFAULT '',
        source          TEXT NOT NULL DEFAULT 'agent'
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category   ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_importance  ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_accessed    ON memories(last_accessed_at DESC);
    `);

    // FTS5 virtual table — created only if it doesn't already exist.
    // We use a content-sync approach: manual sync via triggers.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          category,
          tags,
          content='memories',
          content_rowid='id',
          tokenize='porter unicode61'
        );
      `);
    } catch {
      // FTS table may already exist; ignore duplicate errors.
    }

    // Sync triggers — keep FTS in lockstep with the main table.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category, tags)
        VALUES (new.id, new.content, new.category, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
        VALUES ('delete', old.id, old.content, old.category, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, category, tags ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category, tags)
        VALUES ('delete', old.id, old.content, old.category, old.tags);
        INSERT INTO memories_fts(rowid, content, category, tags)
        VALUES (new.id, new.content, new.category, new.tags);
      END;
    `);
  }

  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO memories (category, content, importance, tags, related_files,
                            created_at, last_accessed_at, access_count, session_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    this.stmtUpdate = this.db.prepare(`
      UPDATE memories
      SET category = ?, content = ?, importance = ?, tags = ?, related_files = ?,
          last_accessed_at = ?, session_id = ?, source = ?
      WHERE id = ?
    `);
    this.stmtDelete = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    this.stmtGetById = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    this.stmtBumpAccess = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed_at = ?,
          importance = MIN(1.0, importance + 0.1)
      WHERE id = ?
    `);
    this.stmtAll = this.db.prepare(`SELECT * FROM memories ORDER BY importance DESC`);
    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM memories`);
    this.stmtCategoryCount = this.db.prepare(
      `SELECT category, COUNT(*) AS cnt FROM memories GROUP BY category`,
    );
    this.stmtAvgImportance = this.db.prepare(
      `SELECT AVG(importance) AS avg FROM memories`,
    );
    this.stmtOldest = this.db.prepare(
      `SELECT MIN(created_at) AS ts FROM memories`,
    );
    this.stmtNewest = this.db.prepare(
      `SELECT MAX(created_at) AS ts FROM memories`,
    );
    this.stmtTotalAccess = this.db.prepare(
      `SELECT SUM(access_count) AS total FROM memories`,
    );
    this.stmtPrunable = this.db.prepare(`
      SELECT id FROM memories
      WHERE importance < ?
      ORDER BY importance ASC, last_accessed_at ASC
      LIMIT ?
    `);
    this.stmtSearchFts = this.db.prepare(`
      SELECT m.*, bm25(memories_fts, 10.0, 5.0, 2.0) AS rank
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
    `);
  }

  // ────────────────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────────────────

  /**
   * Create a new memory, with automatic deduplication.
   *
   * If a sufficiently similar memory already exists (≥ 0.8 Jaccard similarity
   * on word sets), the existing memory is *merged* instead of creating a
   * duplicate.
   *
   * @returns The memory (new or merged).
   */
  createMemory(input: CreateMemoryInput): Memory {
    // Input validation
    if (input.content?.length > 50000) {
      input.content = input.content.substring(0, 50000) + '... [truncated]';
    }
    if (input.tags && input.tags.length > 50) {
      input.tags = input.tags.slice(0, 50);
    }

    const now = Date.now();
    const importance = input.importance ?? CATEGORY_IMPORTANCE[input.category] ?? 0.5;
    const tags = input.tags ?? [];
    const relatedFiles = input.relatedFiles ?? [];
    const sessionId = input.sessionId ?? '';
    const source = input.source ?? 'agent';

    // ── Deduplication ────────────────────────────────────────
    const existing = this.findDuplicate(input.content, input.category);
    if (existing) {
      return this.mergeMemory(existing, input, now);
    }

    // ── Insert ───────────────────────────────────────────────
    const info = this.stmtInsert.run(
      input.category,
      input.content,
      importance,
      JSON.stringify(tags),
      JSON.stringify(relatedFiles),
      now,
      now,
      sessionId,
      source,
    );

    // ── Prune if over capacity ───────────────────────────────
    this.pruneIfNeeded();

    return this.rowToMemory({
      id: Number(info.lastInsertRowid),
      category: input.category,
      content: input.content,
      importance,
      tags: JSON.stringify(tags),
      related_files: JSON.stringify(relatedFiles),
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
      session_id: sessionId,
      source,
    });
  }

  /**
   * Retrieve a single memory by ID, boosting its importance.
   */
  getMemory(id: number): Memory | null {
    const row = this.stmtGetById.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    // Boost on access
    this.stmtBumpAccess.run(Date.now(), id);

    // Re-read after boost
    const updated = this.stmtGetById.get(id) as Record<string, unknown>;
    return this.rowToMemory(updated);
  }

  /**
   * Update an existing memory.
   */
  updateMemory(id: number, updates: Partial<CreateMemoryInput>): Memory | null {
    const existing = this.stmtGetById.get(id) as Record<string, unknown> | undefined;
    if (!existing) return null;

    const now = Date.now();
    this.stmtUpdate.run(
      updates.category ?? existing.category,
      updates.content ?? existing.content,
      updates.importance ?? existing.importance,
      JSON.stringify(updates.tags ?? JSON.parse(existing.tags as string)),
      JSON.stringify(updates.relatedFiles ?? JSON.parse(existing.related_files as string)),
      now,
      updates.sessionId ?? existing.session_id,
      updates.source ?? existing.source,
      id,
    );

    const updated = this.stmtGetById.get(id) as Record<string, unknown>;
    return this.rowToMemory(updated);
  }

  /**
   * Delete a memory by ID.
   *
   * @returns `true` if the memory existed.
   */
  deleteMemory(id: number): boolean {
    const info = this.stmtDelete.run(id);
    return info.changes > 0;
  }

  // ────────────────────────────────────────────────────────────
  // Retrieval
  // ────────────────────────────────────────────────────────────

  /**
   * Query memories with optional FTS5 text search, category/tag filters,
   * importance threshold, and token budget.
   *
   * Results are ranked by a composite score:
   *   0.5 × textRelevance  +  0.3 × importance  +  0.2 × recency
   */
  queryMemories(query: MemoryQuery): Memory[] {
    const limit = query.limit ?? 20;

    let rows: Record<string, unknown>[];

    // ── FTS path ─────────────────────────────────────────────
    if (query.text && query.text.trim().length > 0) {
      const ftsQuery = this.buildFtsQuery(query.text);
      try {
        rows = this.stmtSearchFts.all(ftsQuery) as Record<string, unknown>[];
      } catch {
        // FTS query syntax error — fall back to LIKE search
        rows = this.fallbackLikeSearch(query.text);
      }
    } else {
      rows = this.stmtAll.all() as Record<string, unknown>[];
    }

    // ── Post-filter ──────────────────────────────────────────
    let memories = rows.map(r => this.rowToMemory(r));

    if (query.categories && query.categories.length > 0) {
      const set = new Set(query.categories);
      memories = memories.filter(m => set.has(m.category));
    }

    if (query.tags && query.tags.length > 0) {
      const tagSet = new Set(query.tags.map(t => t.toLowerCase()));
      memories = memories.filter(m =>
        m.tags.some(t => tagSet.has(t.toLowerCase())),
      );
    }

    if (query.relatedFiles && query.relatedFiles.length > 0) {
      const fileSet = new Set(query.relatedFiles.map(f => this.normalizePath(f)));
      memories = memories.filter(m =>
        m.relatedFiles.some(rf => fileSet.has(this.normalizePath(rf))),
      );
    }

    if (query.minImportance !== undefined) {
      memories = memories.filter(m => m.importance >= query.minImportance!);
    }

    // ── Rank by composite score ──────────────────────────────
    const now = Date.now();
    const maxRank = rows.length > 0
      ? Math.max(...rows.map(r => Math.abs((r.rank as number) ?? 0)), 1)
      : 1;

    memories.sort((a, b) => {
      const scoreA = this.compositeScore(a, rows, maxRank, now);
      const scoreB = this.compositeScore(b, rows, maxRank, now);
      return scoreB - scoreA; // descending
    });

    // ── Apply limit ──────────────────────────────────────────
    memories = memories.slice(0, limit);

    // ── Apply token budget ───────────────────────────────────
    if (query.tokenBudget !== undefined && query.tokenBudget > 0) {
      memories = this.applyTokenBudget(memories, query.tokenBudget);
    }



    return memories;
  }

  // ────────────────────────────────────────────────────────────
  // Decay & Pruning
  // ────────────────────────────────────────────────────────────

  /**
   * Apply time-based importance decay to all memories.
   *
   * Each memory's importance is multiplied by `decayRate ^ daysSinceLastAccess`.
   * Call this periodically (e.g. once per session start).
   */
  applyDecay(): number {
    const now = Date.now();
    const allRows = this.stmtAll.all() as Record<string, unknown>[];
    let decayed = 0;

    const txn = this.db.transaction(() => {
      const updateStmt = this.db.prepare(
        `UPDATE memories SET importance = ? WHERE id = ?`,
      );
      for (const row of allRows) {
        const lastAccessed = row.last_accessed_at as number;
        const daysSince = (now - lastAccessed) / (1000 * 60 * 60 * 24);
        if (daysSince < 0.01) continue; // Skip very recent

        const currentImportance = row.importance as number;
        const newImportance = currentImportance * Math.pow(this.decayRate, daysSince);

        if (Math.abs(newImportance - currentImportance) > 0.001) {
          updateStmt.run(Math.max(0, newImportance), row.id);
          decayed++;
        }
      }
    });
    txn();

    // Prune memories that fell below threshold
    this.pruneIfNeeded();

    return decayed;
  }

  /**
   * Remove low-importance memories when capacity is exceeded.
   *
   * @returns Number of memories pruned.
   */
  pruneIfNeeded(): number {
    const countRow = this.stmtCount.get() as { cnt: number };
    const excess = countRow.cnt - this.maxMemories;
    if (excess <= 0) return 0;

    const toPrune = this.stmtPrunable.all(this.importanceThreshold, excess) as { id: number }[];
    if (toPrune.length === 0) return 0;

    const txn = this.db.transaction(() => {
      for (const { id } of toPrune) {
        this.stmtDelete.run(id);
      }
    });
    txn();

    return toPrune.length;
  }

  // ────────────────────────────────────────────────────────────
  // Bulk Operations
  // ────────────────────────────────────────────────────────────

  /**
   * Export all memories as a JSON-serializable array.
   */
  exportMemories(): Memory[] {
    const rows = this.stmtAll.all() as Record<string, unknown>[];
    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * Import memories from a JSON array.
   *
   * Deduplication is applied per memory. Existing memories are merged.
   *
   * @returns Number of memories imported (created + merged).
   */
  importMemories(memories: CreateMemoryInput[]): number {
    let imported = 0;
    const txn = this.db.transaction(() => {
      for (const mem of memories) {
        this.createMemory(mem);
        imported++;
      }
    });
    txn();
    return imported;
  }

  // ────────────────────────────────────────────────────────────
  // Statistics
  // ────────────────────────────────────────────────────────────

  /** Aggregate statistics about the memory store. */
  getStats(): MemoryStats {
    const countRow = this.stmtCount.get() as { cnt: number };
    const avgRow = this.stmtAvgImportance.get() as { avg: number | null };
    const oldestRow = this.stmtOldest.get() as { ts: number | null };
    const newestRow = this.stmtNewest.get() as { ts: number | null };
    const totalAccessRow = this.stmtTotalAccess.get() as { total: number | null };
    const catRows = this.stmtCategoryCount.all() as { category: string; cnt: number }[];

    const byCategory: Record<string, number> = {};
    for (const { category, cnt } of catRows) {
      byCategory[category] = cnt;
    }

    return {
      totalMemories: countRow.cnt,
      byCategory,
      averageImportance: avgRow.avg ?? 0,
      oldestCreatedAt: oldestRow.ts,
      newestCreatedAt: newestRow.ts,
      totalAccessCount: totalAccessRow.total ?? 0,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Deduplication
  // ────────────────────────────────────────────────────────────

  /**
   * Find an existing memory that's similar enough to be considered a duplicate.
   *
   * Uses Jaccard similarity on word sets with a threshold of 0.8.
   */
  private findDuplicate(
    content: string,
    category: MemoryCategory,
  ): Record<string, unknown> | null {
    // Pre-filter with FTS5 for performance
    const words = content.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    let candidates: Record<string, unknown>[];

    if (words.length === 0) {
      candidates = this.db.prepare('SELECT * FROM memories WHERE category = ? LIMIT 50').all(category) as Record<string, unknown>[];
    } else {
      const ftsQuery = words.map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
      try {
        candidates = this.db.prepare(
          'SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.content MATCH ? AND m.category = ? LIMIT 50'
        ).all(ftsQuery, category) as Record<string, unknown>[];
      } catch {
        // FTS fallback
        candidates = this.db.prepare('SELECT * FROM memories WHERE category = ? LIMIT 50').all(category) as Record<string, unknown>[];
      }
    }

    const inputWords = this.tokenize(content);
    const SIMILARITY_THRESHOLD = 0.8;

    for (const row of candidates) {
      const existingWords = this.tokenize(row.content as string);
      const sim = this.jaccardSimilarity(inputWords, existingWords);
      if (sim >= SIMILARITY_THRESHOLD) {
        return row;
      }
    }
    return null;
  }

  /**
   * Merge new content into an existing memory.
   *
   * Strategy:
   * - Content: keep longer text (or combine if meaningfully different)
   * - Tags: union
   * - Files: union
   * - Importance: max
   * - Bump access count
   */
  private mergeMemory(
    existing: Record<string, unknown>,
    input: CreateMemoryInput,
    now: number,
  ): Memory {
    const existingTags: string[] = JSON.parse(existing.tags as string);
    const existingFiles: string[] = JSON.parse(existing.related_files as string);

    const mergedTags = [...new Set([...existingTags, ...(input.tags ?? [])])];
    const mergedFiles = [...new Set([...existingFiles, ...(input.relatedFiles ?? [])])];

    // Keep the longer/more detailed content
    const existingContent = existing.content as string;
    const mergedContent = input.content.length > existingContent.length
      ? input.content
      : existingContent;

    const mergedImportance = Math.min(
      1.0,
      Math.max(
        existing.importance as number,
        input.importance ?? CATEGORY_IMPORTANCE[input.category] ?? 0.5,
      ) + 0.05, // Small boost for re-encounter
    );

    const id = existing.id as number;
    this.stmtUpdate.run(
      input.category,
      mergedContent,
      mergedImportance,
      JSON.stringify(mergedTags),
      JSON.stringify(mergedFiles),
      now,
      input.sessionId ?? existing.session_id,
      input.source ?? existing.source,
      id,
    );

    // Bump access
    this.stmtBumpAccess.run(now, id);

    const updated = this.stmtGetById.get(id) as Record<string, unknown>;
    return this.rowToMemory(updated);
  }

  // ────────────────────────────────────────────────────────────
  // FTS Helpers
  // ────────────────────────────────────────────────────────────

  /**
   * Sanitize user input for FTS5 query syntax.
   *
   * Wraps each word in quotes to avoid operators being misinterpreted.
   */
  private buildFtsQuery(text: string): string {
    const words = text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);

    if (words.length === 0) return '""';

    // Join with OR for broader matching
    return words.map(w => `"${w}"`).join(' OR ');
  }

  /**
   * Fallback search when FTS query fails (e.g. special characters).
   */
  private fallbackLikeSearch(text: string): Record<string, unknown>[] {
    const escaped = text.replace(/[%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    return this.db
      .prepare(
        `SELECT *, 0 AS rank FROM memories WHERE content LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT 50`,
      )
      .all(pattern) as Record<string, unknown>[];
  }

  // ────────────────────────────────────────────────────────────
  // Scoring & Token Budget
  // ────────────────────────────────────────────────────────────

  /**
   * Compute composite relevance score for ranking.
   *
   * Score = 0.5 × textRelevance + 0.3 × importance + 0.2 × recency
   */
  private compositeScore(
    memory: Memory,
    rawRows: Record<string, unknown>[],
    maxRank: number,
    now: number,
  ): number {
    // Text relevance (from BM25 rank — lower is more relevant)
    const rawRow = rawRows.find(r => (r.id as number) === memory.id);
    const rank = rawRow ? Math.abs((rawRow.rank as number) ?? 0) : 0;
    const textScore = maxRank > 0 ? 1 - rank / maxRank : 0;

    // Recency (exponential decay over 30 days)
    const daysSinceAccess = (now - memory.lastAccessedAt) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-daysSinceAccess / 30);

    return 0.5 * textScore + 0.3 * memory.importance + 0.2 * recencyScore;
  }

  /**
   * Trim the result set so total estimated tokens ≤ budget.
   */
  private applyTokenBudget(memories: Memory[], budget: number): Memory[] {
    const result: Memory[] = [];
    let usedTokens = 0;

    for (const mem of memories) {
      const estimatedTokens = Math.ceil(mem.content.length / CHARS_PER_TOKEN);
      if (usedTokens + estimatedTokens > budget) break;
      result.push(mem);
      usedTokens += estimatedTokens;
    }

    return result;
  }

  // ────────────────────────────────────────────────────────────
  // Text Similarity Helpers
  // ────────────────────────────────────────────────────────────

  /** Tokenize content into a set of lowercase words. */
  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1),
    );
  }

  /** Jaccard similarity between two word sets. */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** Normalize file paths for comparison. */
  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  // ────────────────────────────────────────────────────────────
  // Row → Domain Object
  // ────────────────────────────────────────────────────────────

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as number,
      category: row.category as MemoryCategory,
      content: row.content as string,
      importance: row.importance as number,
      tags: JSON.parse((row.tags as string) || '[]'),
      relatedFiles: JSON.parse((row.related_files as string) || '[]'),
      createdAt: row.created_at as number,
      lastAccessedAt: row.last_accessed_at as number,
      accessCount: row.access_count as number,
      sessionId: row.session_id as string,
      source: row.source as Memory['source'],
    };
  }
}
