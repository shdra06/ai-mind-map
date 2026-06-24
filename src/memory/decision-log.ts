/**
 * AI Mind Map — Decision Log
 *
 * Structured decision tracking that prevents agents from re-debating settled
 * decisions. Supports full lifecycle (active → superseded → reversed), FTS5
 * search, conflict detection, context-injection summaries, and markdown export.
 *
 * @module memory/decision-log
 */

import Database from 'better-sqlite3';
import type { Decision, MindMapConfig } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Public Types
// ────────────────────────────────────────────────────────────────

/** Parameters for creating a new decision. */
export interface CreateDecisionInput {
  title: string;
  description: string;
  rationale: string;
  alternatives?: string[];
  consequences?: string[];
  relatedFiles?: string[];
  tags?: string[];
  decidedBy?: string;
}

/** Parameters for querying decisions. */
export interface DecisionQuery {
  /** Full-text search across title, description, rationale. */
  text?: string;
  /** Filter by status. */
  status?: Decision['status'];
  /** Filter by any matching tag. */
  tags?: string[];
  /** Filter by related file path. */
  relatedFile?: string;
  /** Maximum results. */
  limit?: number;
}

/** Conflict detected between a new and existing decision. */
export interface DecisionConflict {
  existingDecision: Decision;
  similarity: number;
  reason: string;
}

// ────────────────────────────────────────────────────────────────
// DecisionLog Class
// ────────────────────────────────────────────────────────────────

/**
 * Manages a structured log of architectural/technical decisions.
 *
 * Each decision has a title, rationale, alternatives considered,
 * consequences, and a lifecycle status. Settled decisions can be
 * injected into agent context to avoid re-debating them.
 */
export class DecisionLog {
  private db: Database.Database;
  private maxDecisions: number;

  // ── Prepared statements ────────────────────────────────────
  private stmtInsert!: Database.Statement;
  private stmtGetById!: Database.Statement;
  private stmtUpdateStatus!: Database.Statement;
  private stmtSupersede!: Database.Statement;
  private stmtDelete!: Database.Statement;
  private stmtAll!: Database.Statement;
  private stmtActive!: Database.Statement;
  private stmtByStatus!: Database.Statement;
  private stmtCount!: Database.Statement;
  private stmtSearchFts!: Database.Statement;

  constructor(
    db: Database.Database,
    config?: Pick<MindMapConfig['memory'], 'maxDecisions'>,
  ) {
    this.db = db;
    this.maxDecisions = config?.maxDecisions ?? 200;

    this.ensureSchema();
    this.prepareStatements();
  }

  // ────────────────────────────────────────────────────────────
  // Schema
  // ────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL,
        rationale      TEXT NOT NULL,
        alternatives   TEXT NOT NULL DEFAULT '[]',
        consequences   TEXT NOT NULL DEFAULT '[]',
        related_files  TEXT NOT NULL DEFAULT '[]',
        tags           TEXT NOT NULL DEFAULT '[]',
        decided_at     INTEGER NOT NULL,
        decided_by     TEXT NOT NULL DEFAULT 'agent',
        status         TEXT NOT NULL DEFAULT 'active',
        superseded_by  INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
      CREATE INDEX IF NOT EXISTS idx_decisions_decided_at ON decisions(decided_at DESC);
    `);

    // FTS5 for full-text search across title, description, rationale
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
          title,
          description,
          rationale,
          tags,
          content='decisions',
          content_rowid='id',
          tokenize='porter unicode61'
        );
      `);
    } catch {
      // Already exists; ignore
    }

    // Sync triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, title, description, rationale, tags)
        VALUES (new.id, new.title, new.description, new.rationale, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, title, description, rationale, tags)
        VALUES ('delete', old.id, old.title, old.description, old.rationale, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS decisions_au
        AFTER UPDATE OF title, description, rationale, tags ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, title, description, rationale, tags)
        VALUES ('delete', old.id, old.title, old.description, old.rationale, old.tags);
        INSERT INTO decisions_fts(rowid, title, description, rationale, tags)
        VALUES (new.id, new.title, new.description, new.rationale, new.tags);
      END;
    `);
  }

  private prepareStatements(): void {
    this.stmtInsert = this.db.prepare(`
      INSERT INTO decisions (title, description, rationale, alternatives, consequences,
                             related_files, tags, decided_at, decided_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `);
    this.stmtGetById = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`);
    this.stmtUpdateStatus = this.db.prepare(
      `UPDATE decisions SET status = ? WHERE id = ?`,
    );
    this.stmtSupersede = this.db.prepare(
      `UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE id = ?`,
    );
    this.stmtDelete = this.db.prepare(`DELETE FROM decisions WHERE id = ?`);
    this.stmtAll = this.db.prepare(
      `SELECT * FROM decisions ORDER BY decided_at DESC`,
    );
    this.stmtActive = this.db.prepare(
      `SELECT * FROM decisions WHERE status = 'active' ORDER BY decided_at DESC`,
    );
    this.stmtByStatus = this.db.prepare(
      `SELECT * FROM decisions WHERE status = ? ORDER BY decided_at DESC`,
    );
    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM decisions`);
    this.stmtSearchFts = this.db.prepare(`
      SELECT d.*, bm25(decisions_fts, 10.0, 5.0, 5.0, 2.0) AS rank
      FROM decisions_fts f
      JOIN decisions d ON d.id = f.rowid
      WHERE decisions_fts MATCH ?
      ORDER BY rank
    `);
  }

  // ────────────────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────────────────

  /**
   * Record a new decision.
   *
   * @returns The decision, plus any conflicts detected with existing active decisions.
   */
  createDecision(input: CreateDecisionInput): {
    decision: Decision;
    conflicts: DecisionConflict[];
  } {
    // Input validation
    if (input.title && input.title.length > 500) input.title = input.title.substring(0, 500);
    if (input.description && input.description.length > 50000) input.description = input.description.substring(0, 50000) + '... [truncated]';
    if (input.rationale && input.rationale.length > 50000) input.rationale = input.rationale.substring(0, 50000) + '... [truncated]';
    if (input.alternatives && input.alternatives.length > 20) input.alternatives = input.alternatives.slice(0, 20);
    if (input.consequences && input.consequences.length > 20) input.consequences = input.consequences.slice(0, 20);

    const now = Date.now();

    // ── Conflict detection ───────────────────────────────────
    const conflicts = this.detectConflicts(input);

    const info = this.stmtInsert.run(
      input.title,
      input.description,
      input.rationale,
      JSON.stringify(input.alternatives ?? []),
      JSON.stringify(input.consequences ?? []),
      JSON.stringify(input.relatedFiles ?? []),
      JSON.stringify(input.tags ?? []),
      now,
      input.decidedBy ?? 'agent',
    );

    // Enforce capacity
    this.enforceCapacity();

    const row = this.stmtGetById.get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    return { decision: this.rowToDecision(row), conflicts };
  }

  /**
   * Get a decision by ID.
   */
  getDecision(id: number): Decision | null {
    const row = this.stmtGetById.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToDecision(row) : null;
  }

  /**
   * Delete a decision by ID.
   *
   * @returns `true` if the decision existed.
   */
  deleteDecision(id: number): boolean {
    const info = this.stmtDelete.run(id);
    return info.changes > 0;
  }

  // ────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────

  /**
   * Supersede an existing decision with a new one.
   *
   * The old decision's status becomes 'superseded' and links to the new one.
   *
   * @param oldId     - The decision to supersede.
   * @param newInput  - The replacement decision.
   * @returns The new decision.
   */
  supersedeDecision(
    oldId: number,
    newInput: CreateDecisionInput,
  ): { decision: Decision; conflicts: DecisionConflict[] } {
    const old = this.stmtGetById.get(oldId) as Record<string, unknown> | undefined;
    if (!old) {
      throw new Error(`Decision #${oldId} not found.`);
    }

    const { decision: newDec, conflicts } = this.createDecision(newInput);

    // Mark old as superseded
    this.stmtSupersede.run(newDec.id, oldId);

    return { decision: newDec, conflicts };
  }

  /**
   * Reverse a decision (mark it as no longer valid).
   *
   * @returns The updated decision, or `null` if not found.
   */
  reverseDecision(id: number): Decision | null {
    const row = this.stmtGetById.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    this.stmtUpdateStatus.run('reversed', id);
    const updated = this.stmtGetById.get(id) as Record<string, unknown>;
    return this.rowToDecision(updated);
  }

  /**
   * Re-activate a previously superseded or reversed decision.
   */
  reactivateDecision(id: number): Decision | null {
    const row = this.stmtGetById.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    this.stmtUpdateStatus.run('active', id);
    const updated = this.stmtGetById.get(id) as Record<string, unknown>;
    return this.rowToDecision(updated);
  }

  // ────────────────────────────────────────────────────────────
  // Querying
  // ────────────────────────────────────────────────────────────

  /**
   * Query decisions with optional text search and filters.
   */
  queryDecisions(query: DecisionQuery): Decision[] {
    const limit = query.limit ?? 50;
    let rows: Record<string, unknown>[];

    // FTS path
    if (query.text && query.text.trim().length > 0) {
      const ftsQuery = this.buildFtsQuery(query.text);
      try {
        rows = this.stmtSearchFts.all(ftsQuery) as Record<string, unknown>[];
      } catch {
        rows = this.fallbackLikeSearch(query.text);
      }
    } else if (query.status) {
      rows = this.stmtByStatus.all(query.status) as Record<string, unknown>[];
    } else {
      rows = this.stmtAll.all() as Record<string, unknown>[];
    }

    let decisions = rows.map(r => this.rowToDecision(r));

    // Apply status filter (if FTS was used, status wasn't filtered yet)
    if (query.status && query.text) {
      decisions = decisions.filter(d => d.status === query.status);
    }

    // Tag filter
    if (query.tags && query.tags.length > 0) {
      const tagSet = new Set(query.tags.map(t => t.toLowerCase()));
      decisions = decisions.filter(d =>
        d.tags.some(t => tagSet.has(t.toLowerCase())),
      );
    }

    // Related file filter
    if (query.relatedFile) {
      const norm = this.normalizePath(query.relatedFile);
      decisions = decisions.filter(d =>
        d.relatedFiles.some(f => this.normalizePath(f) === norm),
      );
    }

    return decisions.slice(0, limit);
  }

  /**
   * Get all active decisions.
   */
  getActiveDecisions(): Decision[] {
    const rows = this.stmtActive.all() as Record<string, unknown>[];
    return rows.map(r => this.rowToDecision(r));
  }

  // ────────────────────────────────────────────────────────────
  // Context Injection Summary
  // ────────────────────────────────────────────────────────────

  /**
   * Generate a compact summary of active decisions suitable for injecting
   * into an agent's context window.
   *
   * Format:
   * ```
   * Active Decisions (3):
   * 1. [DB] Use PostgreSQL over MongoDB — Need ACID for financial data
   * 2. [Auth] JWT + refresh tokens — Stateless auth for microservices
   * 3. [API] REST over GraphQL — Team expertise, simpler caching
   * ```
   */
  generateContextSummary(): string {
    const active = this.getActiveDecisions();
    if (active.length === 0) return 'No active decisions recorded.';

    const lines: string[] = [`Active Decisions (${active.length}):`];

    for (let i = 0; i < active.length; i++) {
      const d = active[i];
      const tagStr = d.tags.length > 0 ? `[${d.tags[0]}] ` : '';
      const rationale = this.truncate(d.rationale, 60);
      lines.push(`${i + 1}. ${tagStr}${d.title} — ${rationale}`);
    }

    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────
  // Conflict Detection
  // ────────────────────────────────────────────────────────────

  /**
   * Detect potential conflicts between a new decision and existing active ones.
   *
   * Uses tag overlap + title/description text similarity to flag decisions
   * in the same domain that may contradict each other.
   */
  private detectConflicts(input: CreateDecisionInput): DecisionConflict[] {
    const active = this.getActiveDecisions();
    const conflicts: DecisionConflict[] = [];

    const inputWords = this.tokenize(`${input.title} ${input.description}`);
    const inputTags = new Set((input.tags ?? []).map(t => t.toLowerCase()));

    for (const existing of active) {
      // Tag overlap
      const existingTags = new Set(existing.tags.map(t => t.toLowerCase()));
      let tagOverlap = 0;
      for (const tag of inputTags) {
        if (existingTags.has(tag)) tagOverlap++;
      }

      // Text similarity
      const existingWords = this.tokenize(`${existing.title} ${existing.description}`);
      const textSim = this.jaccardSimilarity(inputWords, existingWords);

      // Combined similarity: tag overlap is a strong signal
      const tagBonus = inputTags.size > 0
        ? (tagOverlap / Math.max(inputTags.size, existingTags.size)) * 0.4
        : 0;
      const similarity = textSim * 0.6 + tagBonus;

      if (similarity >= 0.3) {
        conflicts.push({
          existingDecision: existing,
          similarity,
          reason: tagOverlap > 0
            ? `Shares tag(s) and similar topic with decision #${existing.id}: "${existing.title}"`
            : `Similar topic to decision #${existing.id}: "${existing.title}"`,
        });
      }
    }

    // Sort by highest similarity first
    conflicts.sort((a, b) => b.similarity - a.similarity);
    return conflicts;
  }

  // ────────────────────────────────────────────────────────────
  // Markdown Export
  // ────────────────────────────────────────────────────────────

  /**
   * Export all decisions as a Markdown document.
   */
  exportAsMarkdown(): string {
    const all = (this.stmtAll.all() as Record<string, unknown>[]).map(r =>
      this.rowToDecision(r),
    );

    const active = all.filter(d => d.status === 'active');
    const superseded = all.filter(d => d.status === 'superseded');
    const reversed = all.filter(d => d.status === 'reversed');

    const lines: string[] = [
      '# Decision Log',
      '',
      `> Generated ${new Date().toISOString()} — ${all.length} total decisions`,
      '',
    ];

    const renderSection = (title: string, decisions: Decision[]): void => {
      if (decisions.length === 0) return;
      lines.push(`## ${title} (${decisions.length})`, '');

      for (const d of decisions) {
        lines.push(`### ${d.id}. ${d.title}`, '');
        lines.push(`**Status:** ${d.status}`);
        lines.push(`**Decided:** ${new Date(d.decidedAt).toISOString()} by ${d.decidedBy}`);
        if (d.tags.length > 0) {
          lines.push(`**Tags:** ${d.tags.join(', ')}`);
        }
        lines.push('');
        lines.push(d.description, '');
        lines.push(`**Rationale:** ${d.rationale}`, '');

        if (d.alternatives.length > 0) {
          lines.push('**Alternatives considered:**');
          for (const alt of d.alternatives) {
            lines.push(`- ${alt}`);
          }
          lines.push('');
        }
        if (d.consequences.length > 0) {
          lines.push('**Consequences:**');
          for (const con of d.consequences) {
            lines.push(`- ${con}`);
          }
          lines.push('');
        }
        if (d.relatedFiles.length > 0) {
          lines.push(`**Related files:** ${d.relatedFiles.join(', ')}`);
          lines.push('');
        }
        if (d.supersededBy !== undefined) {
          lines.push(`**Superseded by:** Decision #${d.supersededBy}`);
          lines.push('');
        }
        lines.push('---', '');
      }
    };

    renderSection('Active Decisions', active);
    renderSection('Superseded Decisions', superseded);
    renderSection('Reversed Decisions', reversed);

    return lines.join('\n');
  }

  // ────────────────────────────────────────────────────────────
  // Capacity Management
  // ────────────────────────────────────────────────────────────

  /**
   * Remove oldest superseded/reversed decisions when over capacity.
   */
  private enforceCapacity(): void {
    const countRow = this.stmtCount.get() as { cnt: number };
    const excess = countRow.cnt - this.maxDecisions;
    if (excess <= 0) return;

    // Remove oldest non-active decisions first
    const toRemove = this.db
      .prepare(
        `SELECT id FROM decisions
         WHERE status != 'active'
         ORDER BY decided_at ASC
         LIMIT ?`,
      )
      .all(excess) as { id: number }[];

    const txn = this.db.transaction(() => {
      for (const { id } of toRemove) {
        this.stmtDelete.run(id);
      }
    });
    txn();
  }

  // ────────────────────────────────────────────────────────────
  // FTS Helpers
  // ────────────────────────────────────────────────────────────

  private buildFtsQuery(text: string): string {
    const words = text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0);

    if (words.length === 0) return '""';
    return words.map(w => `"${w}"`).join(' OR ');
  }

  private fallbackLikeSearch(text: string): Record<string, unknown>[] {
    const pattern = `%${text}%`;
    return this.db
      .prepare(
        `SELECT *, 0 AS rank FROM decisions
         WHERE title LIKE ? OR description LIKE ? OR rationale LIKE ?
         ORDER BY decided_at DESC LIMIT 50`,
      )
      .all(pattern, pattern, pattern) as Record<string, unknown>[];
  }

  // ────────────────────────────────────────────────────────────
  // Text Similarity
  // ────────────────────────────────────────────────────────────

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1),
    );
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  private truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + '...';
  }

  // ────────────────────────────────────────────────────────────
  // Row → Domain Object
  // ────────────────────────────────────────────────────────────

  private rowToDecision(row: Record<string, unknown>): Decision {
    const dec: Decision = {
      id: row.id as number,
      title: row.title as string,
      description: row.description as string,
      rationale: row.rationale as string,
      alternatives: JSON.parse((row.alternatives as string) || '[]'),
      consequences: JSON.parse((row.consequences as string) || '[]'),
      relatedFiles: JSON.parse((row.related_files as string) || '[]'),
      tags: JSON.parse((row.tags as string) || '[]'),
      decidedAt: row.decided_at as number,
      decidedBy: row.decided_by as string,
      status: row.status as Decision['status'],
    };
    if (row.superseded_by != null) {
      dec.supersededBy = row.superseded_by as number;
    }
    return dec;
  }
}
