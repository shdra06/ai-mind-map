/**
 * AI Mind Map — Session Memory Manager
 *
 * Session-scoped memory management. Tracks facts and context within a single
 * AI session: files worked on, tasks completed, decisions made, and token usage.
 *
 * Persists session data to SQLite so downstream components can query across
 * sessions. Auto-generates a summary at session end.
 *
 * @module memory/session-memory
 */

import Database from 'better-sqlite3';
import type { SessionSummary } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Internal Types
// ────────────────────────────────────────────────────────────────

/** A fact recorded during a session. */
export interface SessionFact {
  id: number;
  sessionId: string;
  kind: 'file_worked_on' | 'task_completed' | 'decision_made' | 'note' | 'error' | 'context';
  content: string;
  /** Optional JSON-serialized metadata (e.g. { filePath, lineRange }). */
  metadata: string | null;
  createdAt: number;
}

/** Lightweight view returned by `listRecentSessions`. */
export interface SessionListItem {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  totalFacts: number;
  summary: string;
}

/** Token usage counters tracked per session. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  savedTokens: number;
}

// ────────────────────────────────────────────────────────────────
// SessionMemory Class
// ────────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle and content of an AI session.
 *
 * Usage:
 * ```ts
 * const sm = new SessionMemory(db);
 * const id = sm.startSession();
 * sm.addFact('file_worked_on', 'src/types.ts');
 * sm.addFact('task_completed', 'Added Memory types');
 * const summary = sm.endSession();
 * ```
 */
export class SessionMemory {
  private db: Database.Database;
  private currentSessionId: string | null = null;
  private currentStartedAt: number | null = null;
  private tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, contextTokens: 0, savedTokens: 0 };

  // ── Prepared statements (lazy-initialized) ─────────────────
  private stmtInsertSession!: Database.Statement;
  private stmtEndSession!: Database.Statement;
  private stmtInsertFact!: Database.Statement;
  private stmtGetFacts!: Database.Statement;
  private stmtGetSession!: Database.Statement;
  private stmtRecentSessions!: Database.Statement;
  private stmtFactCountByKind!: Database.Statement;
  private stmtUpdateTokenUsage!: Database.Statement;
  private stmtDeleteSession!: Database.Statement;
  private stmtDeleteFacts!: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureSchema();
    this.prepareStatements();
  }

  // ────────────────────────────────────────────────────────────
  // Schema
  // ────────────────────────────────────────────────────────────

  /** Create tables if they don't already exist. */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT PRIMARY KEY,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        summary      TEXT NOT NULL DEFAULT '',
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        saved_tokens  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_facts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        metadata   TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_facts_session
        ON session_facts(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_facts_kind
        ON session_facts(session_id, kind);
      CREATE INDEX IF NOT EXISTS idx_sessions_started
        ON sessions(started_at DESC);
    `);
  }

  /** Prepare reusable statements. */
  private prepareStatements(): void {
    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions (session_id, started_at) VALUES (?, ?)
    `);
    this.stmtEndSession = this.db.prepare(`
      UPDATE sessions SET ended_at = ?, summary = ? WHERE session_id = ?
    `);
    this.stmtInsertFact = this.db.prepare(`
      INSERT INTO session_facts (session_id, kind, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.stmtGetFacts = this.db.prepare(`
      SELECT id, session_id AS sessionId, kind, content, metadata, created_at AS createdAt
      FROM session_facts WHERE session_id = ? ORDER BY created_at ASC
    `);
    this.stmtGetSession = this.db.prepare(`
      SELECT session_id AS sessionId, started_at AS startedAt, ended_at AS endedAt,
             summary, input_tokens AS inputTokens, output_tokens AS outputTokens,
             context_tokens AS contextTokens, saved_tokens AS savedTokens
      FROM sessions WHERE session_id = ?
    `);
    this.stmtRecentSessions = this.db.prepare(`
      SELECT s.session_id AS sessionId, s.started_at AS startedAt,
             s.ended_at   AS endedAt,   s.summary,
             (SELECT COUNT(*) FROM session_facts f WHERE f.session_id = s.session_id) AS totalFacts
      FROM sessions s ORDER BY s.started_at DESC LIMIT ?
    `);
    this.stmtFactCountByKind = this.db.prepare(`
      SELECT kind, COUNT(*) AS cnt FROM session_facts WHERE session_id = ? GROUP BY kind
    `);
    this.stmtUpdateTokenUsage = this.db.prepare(`
      UPDATE sessions
      SET input_tokens = ?, output_tokens = ?, context_tokens = ?, saved_tokens = ?
      WHERE session_id = ?
    `);
    this.stmtDeleteSession = this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`);
    this.stmtDeleteFacts = this.db.prepare(`DELETE FROM session_facts WHERE session_id = ?`);
  }

  // ────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ────────────────────────────────────────────────────────────

  /**
   * Start a new session.
   *
   * @param sessionId - Optional custom ID. If omitted, a timestamped UUID-ish
   *                    ID is generated.
   * @returns The session ID.
   * @throws If a session is already active.
   */
  startSession(sessionId?: string): string {
    if (this.currentSessionId !== null) {
      throw new Error(`Session "${this.currentSessionId}" is already active. End it first.`);
    }

    const id = sessionId ?? this.generateSessionId();
    const now = Date.now();

    this.stmtInsertSession.run(id, now);
    this.currentSessionId = id;
    this.currentStartedAt = now;
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, contextTokens: 0, savedTokens: 0 };
    return id;
  }

  /**
   * End the current session.
   *
   * Generates a summary from facts, persists token usage, and clears state.
   *
   * @returns The completed `SessionSummary`.
   * @throws If no session is active.
   */
  endSession(): SessionSummary {
    this.assertActiveSession();

    const sessionId = this.currentSessionId!;
    const now = Date.now();
    const facts = this.getFactsInternal(sessionId);
    const summary = this.generateSummary(sessionId, facts);

    // Persist
    this.stmtEndSession.run(now, summary.summary, sessionId);
    this.stmtUpdateTokenUsage.run(
      this.tokenUsage.inputTokens,
      this.tokenUsage.outputTokens,
      this.tokenUsage.contextTokens,
      this.tokenUsage.savedTokens,
      sessionId,
    );

    // Reset
    this.currentSessionId = null;
    this.currentStartedAt = null;
    this.tokenUsage = { inputTokens: 0, outputTokens: 0, contextTokens: 0, savedTokens: 0 };

    return summary;
  }

  /**
   * Get the current active session ID (or `null`).
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Return full information about the currently active session.
   */
  getCurrentSessionInfo(): {
    sessionId: string;
    startedAt: number;
    facts: SessionFact[];
    tokenUsage: TokenUsage;
    durationMs: number;
  } | null {
    if (this.currentSessionId === null || this.currentStartedAt === null) {
      return null;
    }
    return {
      sessionId: this.currentSessionId,
      startedAt: this.currentStartedAt,
      facts: this.getFactsInternal(this.currentSessionId),
      tokenUsage: { ...this.tokenUsage },
      durationMs: Date.now() - this.currentStartedAt,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Facts
  // ────────────────────────────────────────────────────────────

  /**
   * Record a fact in the current session.
   *
   * @param kind     - Category of fact.
   * @param content  - Human-readable description.
   * @param metadata - Optional structured metadata (will be JSON-stringified).
   * @returns The inserted fact ID.
   */
  addFact(
    kind: SessionFact['kind'],
    content: string,
    metadata?: Record<string, unknown>,
  ): number {
    this.assertActiveSession();

    const now = Date.now();
    const metaStr = metadata ? JSON.stringify(metadata) : null;
    const info = this.stmtInsertFact.run(this.currentSessionId!, kind, content, metaStr, now);
    return Number(info.lastInsertRowid);
  }

  /**
   * Retrieve all facts for a specific session.
   */
  getSessionFacts(sessionId: string): SessionFact[] {
    return this.getFactsInternal(sessionId);
  }

  /**
   * Get distinct files worked on in the current session.
   */
  getFilesWorkedOn(): string[] {
    this.assertActiveSession();
    const facts = this.getFactsInternal(this.currentSessionId!);
    return [...new Set(
      facts
        .filter(f => f.kind === 'file_worked_on')
        .map(f => f.content),
    )];
  }

  /**
   * Get tasks completed in the current session.
   */
  getTasksCompleted(): string[] {
    this.assertActiveSession();
    return this.getFactsInternal(this.currentSessionId!)
      .filter(f => f.kind === 'task_completed')
      .map(f => f.content);
  }

  /**
   * Get decisions made in the current session.
   */
  getDecisionsMade(): string[] {
    this.assertActiveSession();
    return this.getFactsInternal(this.currentSessionId!)
      .filter(f => f.kind === 'decision_made')
      .map(f => f.content);
  }

  // ────────────────────────────────────────────────────────────
  // Token Tracking
  // ────────────────────────────────────────────────────────────

  /**
   * Record token usage for the current session.
   *
   * Values are *accumulated* (added to running totals).
   */
  recordTokenUsage(usage: Partial<TokenUsage>): void {
    this.assertActiveSession();
    if (typeof usage.inputTokens === 'number') this.tokenUsage.inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === 'number') this.tokenUsage.outputTokens += usage.outputTokens;
    if (typeof usage.contextTokens === 'number') this.tokenUsage.contextTokens += usage.contextTokens;
    if (typeof usage.savedTokens === 'number') this.tokenUsage.savedTokens += usage.savedTokens;
  }

  /** Read token usage counters for the active session. */
  getTokenUsage(): TokenUsage {
    this.assertActiveSession();
    return { ...this.tokenUsage };
  }

  // ────────────────────────────────────────────────────────────
  // Queries (cross-session)
  // ────────────────────────────────────────────────────────────

  /**
   * List the N most recent sessions.
   *
   * @param limit - Maximum number of sessions to return (default 10).
   */
  listRecentSessions(limit = 10): SessionListItem[] {
    return this.stmtRecentSessions.all(limit) as SessionListItem[];
  }

  /**
   * Get full details of a session by its ID.
   */
  getSession(sessionId: string): (SessionSummary & { tokenUsage: TokenUsage }) | null {
    const row = this.stmtGetSession.get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const facts = this.getFactsInternal(sessionId);
    return {
      sessionId: row.sessionId as string,
      startedAt: row.startedAt as number,
      endedAt: (row.endedAt as number) ?? Date.now(),
      tasksCompleted: facts.filter(f => f.kind === 'task_completed').map(f => f.content),
      filesModified: [...new Set(facts.filter(f => f.kind === 'file_worked_on').map(f => f.content))],
      decisionsMade: facts.filter(f => f.kind === 'decision_made').map(f => f.content),
      memoriesCreated: 0, // Populated by caller if needed
      tokensSaved: row.savedTokens as number,
      summary: row.summary as string,
      tokenUsage: {
        inputTokens: row.inputTokens as number,
        outputTokens: row.outputTokens as number,
        contextTokens: row.contextTokens as number,
        savedTokens: row.savedTokens as number,
      },
    };
  }

  /**
   * Delete a session and all its facts.
   *
   * @returns `true` if the session existed and was deleted.
   */
  deleteSession(sessionId: string): boolean {
    if (sessionId === this.currentSessionId) {
      throw new Error('Cannot delete the currently active session.');
    }
    const txn = this.db.transaction(() => {
      this.stmtDeleteFacts.run(sessionId);
      const info = this.stmtDeleteSession.run(sessionId);
      return info.changes > 0;
    });
    return txn();
  }

  // ────────────────────────────────────────────────────────────
  // Summary Generation
  // ────────────────────────────────────────────────────────────

  /**
   * Build a `SessionSummary` from raw facts.
   *
   * Auto-generates a human-readable paragraph summarising the session's work.
   */
  private generateSummary(sessionId: string, facts: SessionFact[]): SessionSummary {
    const files = [...new Set(facts.filter(f => f.kind === 'file_worked_on').map(f => f.content))];
    const tasks = facts.filter(f => f.kind === 'task_completed').map(f => f.content);
    const decisions = facts.filter(f => f.kind === 'decision_made').map(f => f.content);
    const errors = facts.filter(f => f.kind === 'error');
    const notes = facts.filter(f => f.kind === 'note' || f.kind === 'context');

    // Build text summary
    const parts: string[] = [];
    if (tasks.length > 0) {
      parts.push(`Completed ${tasks.length} task(s): ${tasks.join('; ')}.`);
    }
    if (files.length > 0) {
      parts.push(`Modified ${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` (+${files.length - 10} more)` : ''}.`);
    }
    if (decisions.length > 0) {
      parts.push(`Made ${decisions.length} decision(s): ${decisions.join('; ')}.`);
    }
    if (errors.length > 0) {
      parts.push(`Encountered ${errors.length} error(s).`);
    }
    if (notes.length > 0) {
      parts.push(`Recorded ${notes.length} note(s)/context item(s).`);
    }
    if (parts.length === 0) {
      parts.push('No significant activity recorded.');
    }

    return {
      sessionId,
      startedAt: this.currentStartedAt ?? Date.now(),
      endedAt: Date.now(),
      tasksCompleted: tasks,
      filesModified: files,
      decisionsMade: decisions,
      memoriesCreated: 0,
      tokensSaved: this.tokenUsage.savedTokens,
      summary: parts.join(' '),
    };
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private getFactsInternal(sessionId: string): SessionFact[] {
    return this.stmtGetFacts.all(sessionId) as SessionFact[];
  }

  private assertActiveSession(): void {
    if (this.currentSessionId === null) {
      throw new Error('No active session. Call startSession() first.');
    }
  }

  /** Generate a session ID based on timestamp + random suffix. */
  private generateSessionId(): string {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `session-${ts}-${rand}`;
  }
}
