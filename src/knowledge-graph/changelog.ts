/**
 * AI Mind Map — Changelog Engine
 *
 * Tracks node-level changes (added / modified / deleted symbols) across
 * re-indexing runs, and maintains AI agent session history.
 *
 * This is the core component that lets AI agents ask "what changed since
 * I last looked?" instead of re-reading entire files.
 *
 * Tables managed:
 *   changelog       — per-symbol change records
 *   changelog_sessions — AI agent session tracking (changelog context)
 *   session_files   — files touched per session
 *   file_hotspots   — change frequency tracking
 *   digest_cache    — cached codebase digests
 */

import type Database from 'better-sqlite3';
import type { GraphNode, NodeType } from '../types.js';
import { createHash } from 'node:crypto';

// ============================================================
// Types
// ============================================================

export interface ChangelogEntry {
  id: number;
  timestamp: number;
  sessionId: string | null;
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  symbolName: string;
  symbolType: string;
  oldSignature: string | null;
  newSignature: string | null;
  oldHash: string | null;
  newHash: string | null;
  oldStartLine: number | null;
  oldEndLine: number | null;
  newStartLine: number | null;
  newEndLine: number | null;
}

export interface FileChangelog {
  filePath: string;
  added: ChangelogEntry[];
  modified: ChangelogEntry[];
  deleted: ChangelogEntry[];
}

export interface SessionInfo {
  id: string;
  agentName: string;
  taskDescription: string | null;
  startedAt: number;
  endedAt: number | null;
  filesModified: string[];
  summary: string | null;
  tokensSavedEstimate: number;
}

export interface FileHotspot {
  filePath: string;
  changeCount: number;
  lastChangedAt: number;
  symbolChanges: Record<string, number>;
}

export interface ChangesSinceSummary {
  since: number;
  sinceLabel: string;
  totalChanges: number;
  filesChanged: number;
  files: {
    filePath: string;
    added: { name: string; type: string; signature?: string }[];
    modified: { name: string; type: string; oldSignature?: string; newSignature?: string }[];
    deleted: { name: string; type: string }[];
  }[];
}

// ============================================================
// Schema SQL
// ============================================================

export const CHANGELOG_SCHEMA_SQL = `
-- Node-level change history
CREATE TABLE IF NOT EXISTS changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  session_id TEXT,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  old_signature TEXT,
  new_signature TEXT,
  old_hash TEXT,
  new_hash TEXT,
  old_start_line INTEGER,
  old_end_line INTEGER,
  new_start_line INTEGER,
  new_end_line INTEGER
);

CREATE INDEX IF NOT EXISTS idx_changelog_file ON changelog(file_path);
CREATE INDEX IF NOT EXISTS idx_changelog_time ON changelog(timestamp);
CREATE INDEX IF NOT EXISTS idx_changelog_session ON changelog(session_id);

-- AI agent session tracking (named changelog_sessions to avoid conflict with session-memory)
CREATE TABLE IF NOT EXISTS changelog_sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL DEFAULT 'unknown',
  task_description TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  files_modified TEXT,
  summary TEXT,
  tokens_saved_estimate INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_changelog_sessions_started ON changelog_sessions(started_at);

-- Change frequency hotspots
CREATE TABLE IF NOT EXISTS file_hotspots (
  file_path TEXT PRIMARY KEY,
  change_count INTEGER NOT NULL DEFAULT 0,
  last_changed_at INTEGER NOT NULL,
  symbols_changed TEXT
);

-- Codebase digest cache
CREATE TABLE IF NOT EXISTS digest_cache (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL
);
`;

// ============================================================
// ChangelogEngine Class
// ============================================================

/** Auto-prune: max entries to keep */
const MAX_CHANGELOG_ENTRIES = 10000;
/** Auto-prune: max age in ms (90 days) */
const MAX_CHANGELOG_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Session auto-end after 4 hours of inactivity */
const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export class ChangelogEngine {
  private db: Database.Database;
  private currentSessionId: string | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureSchema();
    // Auto-prune on startup to prevent unbounded growth
    this.startupCleanup();
  }

  /** Run cleanup tasks on startup: prune old changelogs, end stale sessions */
  private startupCleanup(): void {
    try {
      this.pruneChangelog();
      this.autoEndStaleSession();
      // Also clean up very old sessions (>90 days)
      this.db.prepare(
        `DELETE FROM changelog_sessions WHERE started_at < ?`
      ).run(Date.now() - MAX_CHANGELOG_AGE_MS);
    } catch {
      // Non-critical — don't block startup
    }
  }

  /** Create changelog tables if they don't exist, with migration support */
  private ensureSchema(): void {
    // Migrate: if old 'sessions' table exists with 'id' column (from v1.4.0-1.4.1),
    // rename it to 'changelog_sessions' to avoid conflict with session-memory's 'sessions'
    try {
      const hasOldTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get() as { name: string } | undefined;

      if (hasOldTable) {
        // Check if it has the changelog schema (id column, not session_id)
        const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
        const hasIdCol = cols.some(c => c.name === 'id');
        const hasAgentName = cols.some(c => c.name === 'agent_name');
        if (hasIdCol && hasAgentName) {
          // This is the changelog's sessions table — migrate it
          this.db.exec('ALTER TABLE sessions RENAME TO changelog_sessions');
        }
      }
    } catch {
      // Migration not needed or already done
    }

    this.db.exec(CHANGELOG_SCHEMA_SQL);
  }

  // ── Node-Level Change Recording ─────────────────────────

  /**
   * Compare old nodes vs new nodes for a file and record the diffs.
   * Called during re-indexing when a file is updated.
   */
  recordChanges(
    filePath: string,
    oldNodes: GraphNode[],
    newNodes: GraphNode[],
  ): FileChangelog {
    const now = Date.now();
    const sessionId = this.currentSessionId;

    // Build maps keyed by qualifiedName for matching
    const oldMap = new Map<string, GraphNode>();
    const newMap = new Map<string, GraphNode>();

    for (const n of oldNodes) {
      if (n.type !== 'file') oldMap.set(n.qualifiedName, n);
    }
    for (const n of newNodes) {
      if (n.type !== 'file') newMap.set(n.qualifiedName, n);
    }

    const changelog: FileChangelog = {
      filePath,
      added: [],
      modified: [],
      deleted: [],
    };

    const insertStmt = this.db.prepare(`
      INSERT INTO changelog (
        timestamp, session_id, file_path, change_type,
        symbol_name, symbol_type,
        old_signature, new_signature,
        old_hash, new_hash,
        old_start_line, old_end_line,
        new_start_line, new_end_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const recordInTransaction = this.db.transaction(() => {
      // 1. Find ADDED symbols (in new but not in old)
      for (const [qName, newNode] of newMap) {
        if (!oldMap.has(qName)) {
          const entry: ChangelogEntry = {
            id: 0,
            timestamp: now,
            sessionId,
            filePath,
            changeType: 'added',
            symbolName: newNode.name,
            symbolType: newNode.type,
            oldSignature: null,
            newSignature: newNode.signature || null,
            oldHash: null,
            newHash: newNode.hash,
            oldStartLine: null,
            oldEndLine: null,
            newStartLine: newNode.startLine,
            newEndLine: newNode.endLine,
          };
          insertStmt.run(
            now, sessionId, filePath, 'added',
            newNode.name, newNode.type,
            null, newNode.signature || null,
            null, newNode.hash,
            null, null,
            newNode.startLine, newNode.endLine,
          );
          changelog.added.push(entry);
        }
      }

      // 2. Find DELETED symbols (in old but not in new)
      for (const [qName, oldNode] of oldMap) {
        if (!newMap.has(qName)) {
          const entry: ChangelogEntry = {
            id: 0,
            timestamp: now,
            sessionId,
            filePath,
            changeType: 'deleted',
            symbolName: oldNode.name,
            symbolType: oldNode.type,
            oldSignature: oldNode.signature || null,
            newSignature: null,
            oldHash: oldNode.hash,
            newHash: null,
            oldStartLine: oldNode.startLine,
            oldEndLine: oldNode.endLine,
            newStartLine: null,
            newEndLine: null,
          };
          insertStmt.run(
            now, sessionId, filePath, 'deleted',
            oldNode.name, oldNode.type,
            oldNode.signature || null, null,
            oldNode.hash, null,
            oldNode.startLine, oldNode.endLine,
            null, null,
          );
          changelog.deleted.push(entry);
        }
      }

      // 3. Find MODIFIED symbols (in both, but hash changed)
      for (const [qName, newNode] of newMap) {
        const oldNode = oldMap.get(qName);
        if (oldNode && oldNode.hash !== newNode.hash) {
          const entry: ChangelogEntry = {
            id: 0,
            timestamp: now,
            sessionId,
            filePath,
            changeType: 'modified',
            symbolName: newNode.name,
            symbolType: newNode.type,
            oldSignature: oldNode.signature || null,
            newSignature: newNode.signature || null,
            oldHash: oldNode.hash,
            newHash: newNode.hash,
            oldStartLine: oldNode.startLine,
            oldEndLine: oldNode.endLine,
            newStartLine: newNode.startLine,
            newEndLine: newNode.endLine,
          };
          insertStmt.run(
            now, sessionId, filePath, 'modified',
            newNode.name, newNode.type,
            oldNode.signature || null, newNode.signature || null,
            oldNode.hash, newNode.hash,
            oldNode.startLine, oldNode.endLine,
            newNode.startLine, newNode.endLine,
          );
          changelog.modified.push(entry);
        }
      }

      // Update hotspot tracking
      const totalChanges = changelog.added.length + changelog.modified.length + changelog.deleted.length;
      if (totalChanges > 0) {
        const symbolChanges: Record<string, number> = {};
        for (const e of [...changelog.added, ...changelog.modified, ...changelog.deleted]) {
          symbolChanges[e.symbolName] = (symbolChanges[e.symbolName] || 0) + 1;
        }

        // Upsert hotspot
        const existing = this.db.prepare(
          'SELECT change_count, symbols_changed FROM file_hotspots WHERE file_path = ?'
        ).get(filePath) as any;

        if (existing) {
          const prevSymbols = JSON.parse(existing.symbols_changed || '{}');
          for (const [name, count] of Object.entries(symbolChanges)) {
            prevSymbols[name] = (prevSymbols[name] || 0) + (count as number);
          }
          this.db.prepare(
            'UPDATE file_hotspots SET change_count = change_count + ?, last_changed_at = ?, symbols_changed = ? WHERE file_path = ?'
          ).run(totalChanges, now, JSON.stringify(prevSymbols), filePath);
        } else {
          this.db.prepare(
            'INSERT INTO file_hotspots (file_path, change_count, last_changed_at, symbols_changed) VALUES (?, ?, ?, ?)'
          ).run(filePath, totalChanges, now, JSON.stringify(symbolChanges));
        }

        // Track file in current session
        if (sessionId) {
          const sess = this.db.prepare('SELECT files_modified FROM changelog_sessions WHERE id = ?').get(sessionId) as any;
          if (sess) {
            const files: string[] = JSON.parse(sess.files_modified || '[]');
            if (!files.includes(filePath)) {
              files.push(filePath);
              this.db.prepare('UPDATE changelog_sessions SET files_modified = ? WHERE id = ?')
                .run(JSON.stringify(files), sessionId);
            }
          }
        }
      }
    });

    recordInTransaction();
    return changelog;
  }

  // ── Query Changes ───────────────────────────────────────

  /**
   * Get all changes since a timestamp.
   * Returns a compact summary grouped by file.
   */
  getChangesSince(since: number): ChangesSinceSummary {
    const rows = this.db.prepare(
      'SELECT * FROM changelog WHERE timestamp > ? ORDER BY timestamp DESC'
    ).all(since) as any[];

    // Group by file
    const fileMap = new Map<string, {
      added: { name: string; type: string; signature?: string }[];
      modified: { name: string; type: string; oldSignature?: string; newSignature?: string }[];
      deleted: { name: string; type: string }[];
    }>();

    for (const row of rows) {
      if (!fileMap.has(row.file_path)) {
        fileMap.set(row.file_path, { added: [], modified: [], deleted: [] });
      }
      const entry = fileMap.get(row.file_path)!;

      if (row.change_type === 'added') {
        entry.added.push({
          name: row.symbol_name,
          type: row.symbol_type,
          signature: row.new_signature || undefined,
        });
      } else if (row.change_type === 'modified') {
        entry.modified.push({
          name: row.symbol_name,
          type: row.symbol_type,
          oldSignature: row.old_signature || undefined,
          newSignature: row.new_signature || undefined,
        });
      } else if (row.change_type === 'deleted') {
        entry.deleted.push({
          name: row.symbol_name,
          type: row.symbol_type,
        });
      }
    }

    // Calculate "since" label
    const ageMs = Date.now() - since;
    let sinceLabel = '';
    if (ageMs < 3600_000) sinceLabel = `${Math.round(ageMs / 60_000)} minutes ago`;
    else if (ageMs < 86400_000) sinceLabel = `${Math.round(ageMs / 3600_000)} hours ago`;
    else sinceLabel = `${Math.round(ageMs / 86400_000)} days ago`;

    return {
      since,
      sinceLabel,
      totalChanges: rows.length,
      filesChanged: fileMap.size,
      files: Array.from(fileMap.entries()).map(([filePath, changes]) => ({
        filePath,
        ...changes,
      })),
    };
  }

  /**
   * Get changes for a specific file.
   */
  getFileChanges(filePath: string, limit: number = 50): ChangelogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM changelog WHERE file_path = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(filePath, limit) as any[];

    return rows.map(this.rowToEntry);
  }

  /**
   * Get changes for a specific session.
   */
  getSessionChanges(sessionId: string): ChangelogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM changelog WHERE session_id = ? ORDER BY timestamp ASC'
    ).all(sessionId) as any[];

    return rows.map(this.rowToEntry);
  }

  /**
   * Get file hotspots — most frequently changed files.
   */
  getHotspots(limit: number = 20): FileHotspot[] {
    const rows = this.db.prepare(
      'SELECT * FROM file_hotspots ORDER BY change_count DESC LIMIT ?'
    ).all(limit) as any[];

    return rows.map((r: any) => ({
      filePath: r.file_path,
      changeCount: r.change_count,
      lastChangedAt: r.last_changed_at,
      symbolChanges: JSON.parse(r.symbols_changed || '{}'),
    }));
  }

  // ── Session Management ──────────────────────────────────

  /**
   * Start a new AI agent session.
   */
  startSession(agentName: string = 'unknown', taskDescription?: string): string {
    // Auto-end any stale session
    this.autoEndStaleSession();

    const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const now = Date.now();

    this.db.prepare(
      'INSERT INTO changelog_sessions (id, agent_name, task_description, started_at, files_modified) VALUES (?, ?, ?, ?, ?)'
    ).run(id, agentName, taskDescription || null, now, '[]');

    this.currentSessionId = id;
    return id;
  }

  /**
   * End the current session with a summary.
   */
  endSession(sessionId?: string, summary?: string): void {
    const id = sessionId || this.currentSessionId;
    if (!id) return;

    const now = Date.now();
    this.db.prepare(
      'UPDATE changelog_sessions SET ended_at = ?, summary = ? WHERE id = ? AND ended_at IS NULL'
    ).run(now, summary || null, id);

    if (id === this.currentSessionId) {
      this.currentSessionId = null;
    }
  }

  /**
   * Get the current active session.
   */
  getCurrentSession(): SessionInfo | null {
    if (!this.currentSessionId) return null;
    return this.getSession(this.currentSessionId);
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): SessionInfo | null {
    const row = this.db.prepare('SELECT * FROM changelog_sessions WHERE id = ?').get(sessionId) as any;
    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Get the most recent completed session.
   */
  getLastSession(): SessionInfo | null {
    const row = this.db.prepare(
      'SELECT * FROM changelog_sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1'
    ).get() as any;

    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Get recent sessions.
   */
  getRecentSessions(limit: number = 10): SessionInfo[] {
    const rows = this.db.prepare(
      'SELECT * FROM changelog_sessions ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as any[];

    return rows.map(this.rowToSession);
  }

  /**
   * Get the current session ID (for use by indexer).
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Ensure a session exists — auto-start one if needed.
   * Called on first tool invocation.
   */
  ensureSession(agentName: string = 'ai-agent'): string {
    // If there's an active session, reuse it
    if (this.currentSessionId) {
      const session = this.getSession(this.currentSessionId);
      if (session && !session.endedAt) return this.currentSessionId;
    }

    // Check if there's a recent unclosed session (< 30 min old)
    const recent = this.db.prepare(
      'SELECT id FROM changelog_sessions WHERE ended_at IS NULL AND started_at > ? ORDER BY started_at DESC LIMIT 1'
    ).get(Date.now() - SESSION_TIMEOUT_MS) as any;

    if (recent) {
      this.currentSessionId = recent.id;
      return recent.id;
    }

    // Auto-end old sessions and start a new one
    return this.startSession(agentName);
  }

  // ── Digest Cache ────────────────────────────────────────

  /**
   * Get a cached digest. Returns null if expired or missing.
   */
  getCachedDigest(key: string): string | null {
    const row = this.db.prepare(
      'SELECT content FROM digest_cache WHERE key = ? AND valid_until > ?'
    ).get(key, Date.now()) as any;

    return row?.content || null;
  }

  /**
   * Store a digest in cache.
   */
  setCachedDigest(key: string, content: string, ttlMs: number = 300_000): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT OR REPLACE INTO digest_cache (key, content, generated_at, valid_until) VALUES (?, ?, ?, ?)'
    ).run(key, content, now, now + ttlMs);
  }

  /**
   * Invalidate all digest caches (called when index changes).
   */
  invalidateDigestCache(): void {
    this.db.prepare('DELETE FROM digest_cache').run();
  }

  // ── Maintenance ─────────────────────────────────────────

  /**
   * Prune old changelog entries.
   */
  pruneChangelog(): number {
    const cutoff = Date.now() - MAX_CHANGELOG_AGE_MS;

    // Get count before pruning
    const countBefore = (this.db.prepare('SELECT COUNT(*) as c FROM changelog').get() as any).c;

    // Keep only the last MAX_CHANGELOG_ENTRIES (count-based prune first)
    if (countBefore > MAX_CHANGELOG_ENTRIES) {
      const keepFrom = this.db.prepare(
        'SELECT timestamp FROM changelog ORDER BY timestamp DESC LIMIT 1 OFFSET ?'
      ).get(MAX_CHANGELOG_ENTRIES) as any;

      if (keepFrom) {
        this.db.prepare('DELETE FROM changelog WHERE timestamp < ?').run(keepFrom.timestamp);
      }
    }

    // Delete entries older than MAX_CHANGELOG_AGE_MS
    this.db.prepare('DELETE FROM changelog WHERE timestamp < ?').run(cutoff);

    // Get count after pruning
    const countAfter = (this.db.prepare('SELECT COUNT(*) as c FROM changelog').get() as any).c;

    return countBefore - countAfter;
  }

  /**
   * Get stats about the changelog engine.
   */
  getStats(): {
    totalEntries: number;
    totalSessions: number;
    activeSessions: number;
    trackedFiles: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    const entries = (this.db.prepare('SELECT COUNT(*) as c FROM changelog').get() as any).c;
    const sessions = (this.db.prepare('SELECT COUNT(*) as c FROM changelog_sessions').get() as any).c;
    const active = (this.db.prepare('SELECT COUNT(*) as c FROM changelog_sessions WHERE ended_at IS NULL').get() as any).c;
    const hotspots = (this.db.prepare('SELECT COUNT(*) as c FROM file_hotspots').get() as any).c;
    const oldest = (this.db.prepare('SELECT MIN(timestamp) as t FROM changelog').get() as any)?.t ?? null;
    const newest = (this.db.prepare('SELECT MAX(timestamp) as t FROM changelog').get() as any)?.t ?? null;

    return {
      totalEntries: entries,
      totalSessions: sessions,
      activeSessions: active,
      trackedFiles: hotspots,
      oldestEntry: oldest,
      newestEntry: newest,
    };
  }

  // ── Private Helpers ─────────────────────────────────────

  private autoEndStaleSession(): void {
    const cutoff = Date.now() - SESSION_TIMEOUT_MS;
    this.db.prepare(
      'UPDATE changelog_sessions SET ended_at = ?, summary = \'Auto-ended (timeout)\' WHERE ended_at IS NULL AND started_at < ?'
    ).run(Date.now(), cutoff);

    if (this.currentSessionId) {
      const session = this.getSession(this.currentSessionId);
      if (session?.endedAt) {
        this.currentSessionId = null;
      }
    }
  }

  private rowToEntry(row: any): ChangelogEntry {
    return {
      id: row.id,
      timestamp: row.timestamp,
      sessionId: row.session_id,
      filePath: row.file_path,
      changeType: row.change_type,
      symbolName: row.symbol_name,
      symbolType: row.symbol_type,
      oldSignature: row.old_signature,
      newSignature: row.new_signature,
      oldHash: row.old_hash,
      newHash: row.new_hash,
      oldStartLine: row.old_start_line,
      oldEndLine: row.old_end_line,
      newStartLine: row.new_start_line,
      newEndLine: row.new_end_line,
    };
  }

  private rowToSession(row: any): SessionInfo {
    return {
      id: row.id,
      agentName: row.agent_name,
      taskDescription: row.task_description,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      filesModified: JSON.parse(row.files_modified || '[]'),
      summary: row.summary,
      tokensSavedEstimate: row.tokens_saved_estimate || 0,
    };
  }
}
