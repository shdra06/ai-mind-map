/**
 * AI Mind Map — Change Log (Persistent Change History)
 *
 * SQLite-backed change-history store with FTS5 full-text search and
 * BM25-ranked retrieval. Provides session management, time-range queries,
 * pruning, and aggregate statistics.
 *
 * Inspired by context-mode's BM25-ranked session history and Mem0's
 * persistent memory layer.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileChange, ChangeSession, ChangeType } from '../types.js';

// ----------------------------------------------------------------- types --

/** Query options for retrieving change records. */
export interface ChangeQueryOptions {
  sessionId?: string;
  filePath?: string;
  /** Return only changes that affected this symbol name. */
  symbol?: string;
  /** Only changes of this type. */
  changeType?: ChangeType;
  /** Only changes after this epoch (ms). */
  since?: number;
  /** Only changes before this epoch (ms). */
  until?: number;
  /** Max records to return (default 100). */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
}

/** A single result from a BM25-ranked search. */
export interface RankedChangeResult {
  change: FileChange;
  /** BM25 relevance score (lower = more relevant in SQLite FTS5). */
  rank: number;
}

/** Aggregate statistics for the change log. */
export interface ChangeLogStats {
  totalChanges: number;
  totalSessions: number;
  activeSessions: number;
  mostChangedFiles: { filePath: string; changeCount: number }[];
  mostActiveSessions: { sessionId: string; changeCount: number; startedAt: number }[];
  linesAddedAllTime: number;
  linesRemovedAllTime: number;
}

/** Configuration for change-log behavior. */
export interface ChangeLogConfig {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Number of days to retain change history (default 30). */
  retentionDays?: number;
  /** Max results for ranked retrieval (default 20). */
  defaultSearchLimit?: number;
  /** Optional: share an existing Database connection instead of creating a new one.
   *  C-2 FIX: Prevents SQLITE_BUSY errors from multiple connections. */
  db?: Database.Database;
}

// ------------------------------------------------------------------- db --

/**
 * Persistent change log backed by SQLite with FTS5.
 *
 * ```ts
 * const log = new ChangeLog({ dbPath: '.mindmap/mindmap.db' });
 * const session = log.startSession();
 * log.recordChange({ … });
 * log.endSession(session.sessionId, 'Implemented auth flow');
 * ```
 */
export class ChangeLog {
  private readonly db: Database.Database;
  private readonly retentionDays: number;
  private readonly defaultSearchLimit: number;

  // ----- prepared statements (lazy) ------------------------------------
  private stmtInsertChange!: Database.Statement;
  private stmtInsertSession!: Database.Statement;
  private stmtEndSession!: Database.Statement;
  private stmtGetSession!: Database.Statement;
  private stmtDeleteOldChanges!: Database.Statement;
  private stmtDeleteOldSessions!: Database.Statement;

  constructor(config: ChangeLogConfig) {
    this.retentionDays = config.retentionDays ?? 30;
    this.defaultSearchLimit = config.defaultSearchLimit ?? 20;

    if (config.db) {
      // C-2 FIX: Use shared connection — PRAGMAs already set
      this.db = config.db;
    } else {
      // Legacy path: create own connection (for backward compatibility)
      const dbPath = path.resolve(config.dbPath);
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
    }

    this.initSchema();
    this.prepareStatements();
  }

  // ----------------------------------------------------------- schema ---

  private initSchema(): void {
    this.db.exec(`
      -- Sessions table
      CREATE TABLE IF NOT EXISTS change_sessions (
        session_id   TEXT PRIMARY KEY,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        total_changes INTEGER NOT NULL DEFAULT 0,
        files_modified TEXT NOT NULL DEFAULT '[]',
        summary      TEXT NOT NULL DEFAULT ''
      );

      -- Change records table
      CREATE TABLE IF NOT EXISTS change_records (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path        TEXT NOT NULL,
        change_type      TEXT NOT NULL,
        old_path         TEXT,
        summary          TEXT NOT NULL DEFAULT '',
        symbols_affected TEXT NOT NULL DEFAULT '[]',
        lines_added      INTEGER NOT NULL DEFAULT 0,
        lines_removed    INTEGER NOT NULL DEFAULT 0,
        timestamp        INTEGER NOT NULL,
        session_id       TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES change_sessions(session_id)
          ON DELETE CASCADE
      );

      -- Indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_change_records_session
        ON change_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_change_records_file
        ON change_records(file_path);
      CREATE INDEX IF NOT EXISTS idx_change_records_timestamp
        ON change_records(timestamp);
      CREATE INDEX IF NOT EXISTS idx_change_records_change_type
        ON change_records(change_type);

      -- FTS5 virtual table for full-text search across summaries and symbols
      CREATE VIRTUAL TABLE IF NOT EXISTS change_records_fts USING fts5(
        file_path,
        summary,
        symbols_affected,
        content = 'change_records',
        content_rowid = 'id',
        tokenize = 'porter unicode61'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS trg_change_records_ai
        AFTER INSERT ON change_records BEGIN
          INSERT INTO change_records_fts(rowid, file_path, summary, symbols_affected)
          VALUES (new.id, new.file_path, new.summary, new.symbols_affected);
        END;

      CREATE TRIGGER IF NOT EXISTS trg_change_records_ad
        AFTER DELETE ON change_records BEGIN
          INSERT INTO change_records_fts(change_records_fts, rowid, file_path, summary, symbols_affected)
          VALUES ('delete', old.id, old.file_path, old.summary, old.symbols_affected);
        END;

      CREATE TRIGGER IF NOT EXISTS trg_change_records_au
        AFTER UPDATE ON change_records BEGIN
          INSERT INTO change_records_fts(change_records_fts, rowid, file_path, summary, symbols_affected)
          VALUES ('delete', old.id, old.file_path, old.summary, old.symbols_affected);
          INSERT INTO change_records_fts(rowid, file_path, summary, symbols_affected)
          VALUES (new.id, new.file_path, new.summary, new.symbols_affected);
        END;
    `);
  }

  private prepareStatements(): void {
    this.stmtInsertChange = this.db.prepare(`
      INSERT INTO change_records
        (file_path, change_type, old_path, summary, symbols_affected,
         lines_added, lines_removed, timestamp, session_id)
      VALUES
        (@filePath, @changeType, @oldPath, @summary, @symbolsAffected,
         @linesAdded, @linesRemoved, @timestamp, @sessionId)
    `);

    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO change_sessions (session_id, started_at)
      VALUES (@sessionId, @startedAt)
    `);

    this.stmtEndSession = this.db.prepare(`
      UPDATE change_sessions
      SET ended_at = @endedAt,
          total_changes = (
            SELECT COUNT(*) FROM change_records WHERE session_id = @sessionId
          ),
          files_modified = (
            SELECT json_group_array(DISTINCT file_path)
            FROM change_records WHERE session_id = @sessionId
          ),
          summary = @summary
      WHERE session_id = @sessionId
    `);

    this.stmtGetSession = this.db.prepare(`
      SELECT * FROM change_sessions WHERE session_id = ?
    `);

    this.stmtDeleteOldChanges = this.db.prepare(`
      DELETE FROM change_records WHERE timestamp < ?
    `);

    this.stmtDeleteOldSessions = this.db.prepare(`
      DELETE FROM change_sessions WHERE ended_at IS NOT NULL AND ended_at < ?
    `);
  }

  // ----------------------------------------------------- sessions ------

  /**
   * Start a new change-tracking session.
   *
   * @returns The newly created session record.
   */
  startSession(sessionId?: string): ChangeSession {
    const id = sessionId ?? randomUUID();
    const now = Date.now();

    this.stmtInsertSession.run({ sessionId: id, startedAt: now });

    return {
      sessionId: id,
      startedAt: now,
      endedAt: null,
      totalChanges: 0,
      filesModified: [],
      summary: '',
    };
  }

  /**
   * End an existing session, computing aggregate metadata.
   *
   * @param sessionId  The session to end.
   * @param summary    Optional human-readable summary of the session.
   */
  endSession(sessionId: string, summary = ''): ChangeSession | null {
    const now = Date.now();
    this.stmtEndSession.run({ sessionId, endedAt: now, summary });
    return this.getSession(sessionId);
  }

  /**
   * Retrieve a session by ID.
   */
  getSession(sessionId: string): ChangeSession | null {
    const row = this.stmtGetSession.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  /**
   * Get the most recently started session (active or ended).
   */
  getLatestSession(): ChangeSession | null {
    const row = this.db
      .prepare('SELECT * FROM change_sessions ORDER BY started_at DESC LIMIT 1')
      .get() as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Get all active (un-ended) sessions.
   */
  getActiveSessions(): ChangeSession[] {
    const rows = this.db
      .prepare('SELECT * FROM change_sessions WHERE ended_at IS NULL ORDER BY started_at DESC')
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  // -------------------------------------------------- record changes ----

  /**
   * Persist one or more {@link FileChange} records.
   */
  recordChange(change: FileChange): void {
    this.stmtInsertChange.run({
      filePath: change.filePath,
      changeType: change.changeType,
      oldPath: change.oldPath ?? null,
      summary: change.summary,
      symbolsAffected: JSON.stringify(change.symbolsAffected),
      linesAdded: change.linesAdded,
      linesRemoved: change.linesRemoved,
      timestamp: change.timestamp,
      sessionId: change.sessionId,
    });
  }

  /**
   * Record multiple changes in a single transaction.
   */
  recordChanges(changes: FileChange[]): void {
    const txn = this.db.transaction((items: FileChange[]) => {
      for (const c of items) {
        this.recordChange(c);
      }
    });
    txn(changes);
  }

  // --------------------------------------------------------- queries ----

  /**
   * Query change records with flexible filtering.
   */
  queryChanges(options: ChangeQueryOptions = {}): FileChange[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (options.sessionId) {
      clauses.push('session_id = @sessionId');
      params.sessionId = options.sessionId;
    }
    if (options.filePath) {
      clauses.push('file_path = @filePath');
      params.filePath = options.filePath;
    }
    if (options.changeType) {
      clauses.push('change_type = @changeType');
      params.changeType = options.changeType;
    }
    if (options.since !== undefined) {
      clauses.push('timestamp >= @since');
      params.since = options.since;
    }
    if (options.until !== undefined) {
      clauses.push('timestamp <= @until');
      params.until = options.until;
    }
    if (options.symbol) {
      // JSON array search: symbols_affected LIKE '%"symbolName"%'
      clauses.push("symbols_affected LIKE @symbolPattern");
      params.symbolPattern = `%"${options.symbol}"%`;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const sql = `
      SELECT * FROM change_records
      ${where}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `;

    const rows = this.db.prepare(sql).all({ ...params, limit, offset }) as ChangeRow[];
    return rows.map(rowToFileChange);
  }

  /**
   * Get all changes for a specific file, across all sessions.
   */
  getFileHistory(filePath: string, limit = 50): FileChange[] {
    return this.queryChanges({ filePath, limit });
  }

  /**
   * Get all changes in a specific session.
   */
  getSessionChanges(sessionId: string): FileChange[] {
    return this.queryChanges({ sessionId, limit: 10000 });
  }

  // --------------------------------------------------- FTS5 / BM25 -----

  /**
   * Full-text search across change summaries, file paths, and affected
   * symbols, ranked by BM25 relevance.
   *
   * @param query  FTS5 query string (supports AND, OR, NOT, phrase matching).
   * @param limit  Maximum results to return.
   */
  searchChanges(query: string, limit?: number): RankedChangeResult[] {
    const maxResults = limit ?? this.defaultSearchLimit;

    // Sanitise: escape double-quotes, wrap terms for prefix matching
    const sanitised = sanitiseFtsQuery(query);
    if (!sanitised) return [];

    try {
      const sql = `
        SELECT
          cr.*,
          bm25(change_records_fts, 1.0, 2.0, 1.5) AS rank
        FROM change_records_fts fts
        JOIN change_records cr ON cr.id = fts.rowid
        WHERE change_records_fts MATCH @query
        ORDER BY rank
        LIMIT @limit
      `;

      const rows = this.db.prepare(sql).all({ query: sanitised, limit: maxResults }) as (ChangeRow & { rank: number })[];

      return rows.map((r) => ({
        change: rowToFileChange(r),
        rank: r.rank,
      }));
    } catch {
      // FTS query syntax errors — return empty rather than crashing.
      return [];
    }
  }

  // ------------------------------------------------ session summaries ---

  /**
   * Generate an aggregate summary for a session, combining all its change
   * records.
   */
  generateSessionSummary(sessionId: string): string {
    const session = this.getSession(sessionId);
    if (!session) return `Session ${sessionId} not found.`;

    const changes = this.getSessionChanges(sessionId);
    if (changes.length === 0) return `Session ${sessionId}: no changes recorded.`;

    const created = changes.filter((c) => c.changeType === 'created');
    const modified = changes.filter((c) => c.changeType === 'modified');
    const deleted = changes.filter((c) => c.changeType === 'deleted');
    const renamed = changes.filter((c) => c.changeType === 'renamed');

    const totalAdded = changes.reduce((s, c) => s + c.linesAdded, 0);
    const totalRemoved = changes.reduce((s, c) => s + c.linesRemoved, 0);

    const lines: string[] = [];
    lines.push(`Session ${sessionId}`);
    lines.push(`  Started: ${new Date(session.startedAt).toISOString()}`);
    if (session.endedAt) {
      lines.push(`  Ended:   ${new Date(session.endedAt).toISOString()}`);
    }
    lines.push(`  Total: ${changes.length} changes (+${totalAdded}, -${totalRemoved} lines)`);

    if (created.length > 0) {
      lines.push(`  Created (${created.length}):`);
      for (const c of created.slice(0, 10)) lines.push(`    + ${c.filePath}`);
      if (created.length > 10) lines.push(`    … and ${created.length - 10} more`);
    }
    if (modified.length > 0) {
      lines.push(`  Modified (${modified.length}):`);
      for (const c of modified.slice(0, 10)) lines.push(`    ~ ${c.filePath}: ${c.summary}`);
      if (modified.length > 10) lines.push(`    … and ${modified.length - 10} more`);
    }
    if (deleted.length > 0) {
      lines.push(`  Deleted (${deleted.length}):`);
      for (const c of deleted.slice(0, 10)) lines.push(`    - ${c.filePath}`);
      if (deleted.length > 10) lines.push(`    … and ${deleted.length - 10} more`);
    }
    if (renamed.length > 0) {
      lines.push(`  Renamed (${renamed.length}):`);
      for (const c of renamed.slice(0, 10)) {
        lines.push(`    → ${c.oldPath ?? '?'} → ${c.filePath}`);
      }
      if (renamed.length > 10) lines.push(`    … and ${renamed.length - 10} more`);
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------- pruning ----

  /**
   * Delete change records older than the configured retention period.
   *
   * @returns Number of records deleted.
   */
  pruneOldChanges(): { changesDeleted: number; sessionsDeleted: number } {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;

    const changesResult = this.stmtDeleteOldChanges.run(cutoff);
    const sessionsResult = this.stmtDeleteOldSessions.run(cutoff);

    return {
      changesDeleted: changesResult.changes,
      sessionsDeleted: sessionsResult.changes,
    };
  }

  // ------------------------------------------------------- statistics ---

  /**
   * Compute aggregate statistics across the entire change log.
   */
  getStats(topN = 10): ChangeLogStats {
    const totalChanges = (
      this.db.prepare('SELECT COUNT(*) AS cnt FROM change_records').get() as { cnt: number }
    ).cnt;

    const totalSessions = (
      this.db.prepare('SELECT COUNT(*) AS cnt FROM change_sessions').get() as { cnt: number }
    ).cnt;

    const activeSessions = (
      this.db.prepare('SELECT COUNT(*) AS cnt FROM change_sessions WHERE ended_at IS NULL').get() as { cnt: number }
    ).cnt;

    const mostChangedFiles = this.db
      .prepare(
        `SELECT file_path AS filePath, COUNT(*) AS changeCount
         FROM change_records
         GROUP BY file_path
         ORDER BY changeCount DESC
         LIMIT ?`,
      )
      .all(topN) as { filePath: string; changeCount: number }[];

    const mostActiveSessions = this.db
      .prepare(
        `SELECT cs.session_id AS sessionId,
                COUNT(cr.id) AS changeCount,
                cs.started_at AS startedAt
         FROM change_sessions cs
         LEFT JOIN change_records cr ON cr.session_id = cs.session_id
         GROUP BY cs.session_id
         ORDER BY changeCount DESC
         LIMIT ?`,
      )
      .all(topN) as { sessionId: string; changeCount: number; startedAt: number }[];

    const lineStats = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(lines_added), 0) AS linesAdded,
           COALESCE(SUM(lines_removed), 0) AS linesRemoved
         FROM change_records`,
      )
      .get() as { linesAdded: number; linesRemoved: number };

    return {
      totalChanges,
      totalSessions,
      activeSessions,
      mostChangedFiles,
      mostActiveSessions,
      linesAddedAllTime: lineStats.linesAdded,
      linesRemovedAllTime: lineStats.linesRemoved,
    };
  }

  // ---------------------------------------------------------- cleanup ---

  /**
   * Close the database connection. Call this during graceful shutdown.
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================ internals ==

/** Raw SQLite row shape for change_records. */
interface ChangeRow {
  id: number;
  file_path: string;
  change_type: string;
  old_path: string | null;
  summary: string;
  symbols_affected: string;
  lines_added: number;
  lines_removed: number;
  timestamp: number;
  session_id: string;
}

/** Raw SQLite row shape for change_sessions. */
interface SessionRow {
  session_id: string;
  started_at: number;
  ended_at: number | null;
  total_changes: number;
  files_modified: string;
  summary: string;
}

/** Convert a raw DB row into a {@link FileChange}. */
function rowToFileChange(row: ChangeRow): FileChange {
  return {
    filePath: row.file_path,
    changeType: row.change_type as ChangeType,
    oldPath: row.old_path ?? undefined,
    summary: row.summary,
    symbolsAffected: safeJsonParse<string[]>(row.symbols_affected, []),
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    timestamp: row.timestamp,
    sessionId: row.session_id,
  };
}

/** Convert a raw DB row into a {@link ChangeSession}. */
function rowToSession(row: SessionRow): ChangeSession {
  return {
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalChanges: row.total_changes,
    filesModified: safeJsonParse<string[]>(row.files_modified, []),
    summary: row.summary,
  };
}

/** Safely parse a JSON string with a fallback. */
function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Sanitise a user-provided query string for FTS5 MATCH.
 *
 * - Removes characters that break FTS5 syntax.
 * - Wraps each term in double-quotes with a `*` suffix for prefix matching.
 *
 * Returns `null` if the query is effectively empty after sanitisation.
 */
function sanitiseFtsQuery(raw: string): string | null {
  // Strip special FTS5 operators that could break syntax
  const cleaned = raw
    .replace(/["""]/g, '')            // remove quotes
    .replace(/[{}()\[\]^~\\:]/g, '')  // remove other specials
    .trim();

  if (cleaned.length === 0) return null;

  // Split into tokens and wrap each for prefix matching
  const terms = cleaned.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;

  // Use OR between terms for broader matching
  return terms.map((t) => `"${t}"*`).join(' OR ');
}
