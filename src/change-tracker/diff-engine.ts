/**
 * AI Mind Map — Diff Engine
 *
 * Git-aware diff analysis using simple-git. Provides rich, human-readable
 * change summaries suitable for an LLM session preamble (so the agent knows
 * what happened since it last looked). Falls back to filesystem timestamps
 * when the project is not under git.
 *
 * Inspired by Aider's repo-map diff view and context-mode's session deltas.
 */

import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit, DiffResultTextFile } from 'simple-git';
import type { ChangeType, FileChange } from '../types.js';

// ----------------------------------------------------------------- types --

/** Aggregated summary produced by the diff engine. */
export interface DiffSummary {
  /** Human-readable multi-line summary ready for context injection. */
  text: string;
  /** Individual per-file change records. */
  changes: FileChange[];
  /** Total lines added across all files. */
  totalLinesAdded: number;
  /** Total lines removed across all files. */
  totalLinesRemoved: number;
  /** Number of files affected. */
  filesAffected: number;
  /** Whether git was available. */
  usedGit: boolean;
}

/** Options for querying changes. */
export interface DiffQueryOptions {
  /** Only include files matching these glob patterns. */
  includePatterns?: string[];
  /** Exclude files matching these glob patterns. */
  excludePatterns?: string[];
}

// ---------------------------------------------------------------- engine --

/**
 * Stateless diff engine — every public method takes the information it needs
 * and returns structured results.  The class exists mainly to hold the
 * project-root and lazily-initialised git client.
 */
export class DiffEngine {
  private readonly projectRoot: string;
  private git: SimpleGit | null = null;
  private isGitRepo: boolean | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  // ---------------------------------------------------- public API ------

  /**
   * Get all changes that occurred since a given unix-epoch timestamp.
   *
   * When the project is a git repo the engine queries `git log --since`;
   * otherwise it falls back to filesystem `mtime`.
   *
   * @param sinceTimestamp  Unix-epoch **milliseconds**.
   * @param sessionId      Identifier for the current session.
   */
  async getChangesSinceTimestamp(
    sinceTimestamp: number,
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    if (await this.ensureGit()) {
      return this.gitChangesSinceTimestamp(sinceTimestamp, sessionId, options);
    }
    return this.fsChangesSinceTimestamp(sinceTimestamp, sessionId, options);
  }

  /**
   * Get all uncommitted changes (working tree + staged).
   */
  async getUncommittedChanges(
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    if (await this.ensureGit()) {
      return this.gitUncommittedChanges(sessionId, options);
    }
    // Non-git repo — no concept of "uncommitted", return empty.
    return this.emptyDiffSummary(false);
  }

  /**
   * Get changes between two git refs (commits, branches, tags).
   *
   * Throws if the project is not a git repo.
   */
  async getChangesBetweenRefs(
    fromRef: string,
    toRef: string,
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    if (!(await this.ensureGit())) {
      throw new Error('getChangesBetweenRefs requires a git repository');
    }
    return this.gitChangesBetweenRefs(fromRef, toRef, sessionId, options);
  }

  /**
   * Generate a human-readable summary string from a set of FileChange
   * records.  Useful when the caller assembles changes from the change-log
   * rather than from git directly.
   */
  formatSummary(changes: FileChange[], contextLabel?: string): string {
    return DiffEngine.buildSummaryText(changes, contextLabel);
  }

  /**
   * Detect whether the project root is inside a git repository.
   */
  async isGitRepository(): Promise<boolean> {
    return this.ensureGit();
  }

  // -------------------------------------------------- git: since ts -----

  private async gitChangesSinceTimestamp(
    sinceTimestamp: number,
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    const git = this.git!;

    // ISO date for git --since
    const sinceISO = new Date(sinceTimestamp).toISOString();
    const timeDelta = humanTimeDelta(sinceTimestamp);

    try {
      // Get the list of commits since the timestamp
      const log = await git.log({ '--since': sinceISO });

      if (log.total === 0) {
        // No commits since then — check for uncommitted changes
        return this.gitUncommittedChanges(sessionId, options);
      }

      // Diff between the oldest commit's parent and HEAD
      const oldestHash = log.all[log.all.length - 1]?.hash;
      if (!oldestHash) {
        return this.emptyDiffSummary(true);
      }

      const diffResult = await git.diffSummary([`${oldestHash}~1`, 'HEAD']).catch(
        // If oldestHash has no parent (initial commit), diff against empty tree
        () => git.diffSummary([
          '4b825dc642cb6eb9a060e54bf899d8b2b04e3660', // git empty-tree hash
          'HEAD',
        ]),
      );

      // Also include uncommitted changes
      const uncommitted = await this.getRawUncommitted();

      const allFiles = this.mergeDiffFiles(diffResult.files as DiffResultTextFile[], uncommitted);
      let changes = this.diffFilesToFileChanges(allFiles, sessionId);
      changes = this.applyFilters(changes, options);

      return {
        text: DiffEngine.buildSummaryText(changes, `Since last session (${timeDelta} ago)`),
        changes,
        totalLinesAdded: sumField(changes, 'linesAdded'),
        totalLinesRemoved: sumField(changes, 'linesRemoved'),
        filesAffected: changes.length,
        usedGit: true,
      };
    } catch (err) {
      // Graceful degradation — fall back to FS timestamps
      return this.fsChangesSinceTimestamp(sinceTimestamp, sessionId, options);
    }
  }

  // -------------------------------------------------- git: uncommitted ---

  private async gitUncommittedChanges(
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    const files = await this.getRawUncommitted();
    let changes = this.diffFilesToFileChanges(files, sessionId);
    changes = this.applyFilters(changes, options);

    return {
      text: DiffEngine.buildSummaryText(changes, 'Uncommitted changes'),
      changes,
      totalLinesAdded: sumField(changes, 'linesAdded'),
      totalLinesRemoved: sumField(changes, 'linesRemoved'),
      filesAffected: changes.length,
      usedGit: true,
    };
  }

  /** Retrieve raw uncommitted diff files (staged + unstaged). */
  private async getRawUncommitted(): Promise<DiffResultTextFile[]> {
    const git = this.git!;

    try {
      const [staged, unstaged] = await Promise.all([
        git.diffSummary(['--cached']),
        git.diffSummary(),
      ]);
      return this.mergeDiffFiles(
        staged.files as DiffResultTextFile[],
        unstaged.files as DiffResultTextFile[],
      );
    } catch {
      return [];
    }
  }

  // -------------------------------------------------- git: between refs --

  private async gitChangesBetweenRefs(
    fromRef: string,
    toRef: string,
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    const git = this.git!;
    const diffResult = await git.diffSummary([fromRef, toRef]);
    let changes = this.diffFilesToFileChanges(
      diffResult.files as DiffResultTextFile[],
      sessionId,
    );
    changes = this.applyFilters(changes, options);

    const label = `Changes between ${fromRef} → ${toRef}`;
    return {
      text: DiffEngine.buildSummaryText(changes, label),
      changes,
      totalLinesAdded: sumField(changes, 'linesAdded'),
      totalLinesRemoved: sumField(changes, 'linesRemoved'),
      filesAffected: changes.length,
      usedGit: true,
    };
  }

  // --------------------------------------------- filesystem fallback -----

  /**
   * Walk the project tree and report every file whose `mtime` is newer than
   * `sinceTimestamp`.  This is the fallback for non-git projects.
   */
  private async fsChangesSinceTimestamp(
    sinceTimestamp: number,
    sessionId: string,
    options?: DiffQueryOptions,
  ): Promise<DiffSummary> {
    const modifiedFiles = await this.walkForModified(this.projectRoot, sinceTimestamp);
    const now = Date.now();

    let changes: FileChange[] = modifiedFiles.map((fp) => ({
      filePath: path.relative(this.projectRoot, fp),
      changeType: 'modified' as ChangeType,
      summary: 'File modified (detected via filesystem timestamp)',
      symbolsAffected: [],
      linesAdded: 0,
      linesRemoved: 0,
      timestamp: now,
      sessionId,
    }));

    changes = this.applyFilters(changes, options);
    const timeDelta = humanTimeDelta(sinceTimestamp);

    return {
      text: DiffEngine.buildSummaryText(changes, `Since last session (${timeDelta} ago)`),
      changes,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      filesAffected: changes.length,
      usedGit: false,
    };
  }

  /** Recursively find files modified after `sinceMs` (epoch ms). */
  private async walkForModified(dir: string, sinceMs: number): Promise<string[]> {
    const results: string[] = [];

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      // Skip common non-source directories.
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;

      const full = path.join(dir, entry);
      try {
        const st = await stat(full);
        if (st.isDirectory()) {
          const sub = await this.walkForModified(full, sinceMs);
          results.push(...sub);
        } else if (st.isFile() && st.mtimeMs > sinceMs) {
          results.push(full);
        }
      } catch {
        // Inaccessible — skip.
      }
    }

    return results;
  }

  // --------------------------------------------------------- conversion --

  /**
   * Convert simple-git `DiffResultTextFile` records into our domain
   * `FileChange` objects.
   */
  private diffFilesToFileChanges(
    files: DiffResultTextFile[],
    sessionId: string,
  ): FileChange[] {
    const now = Date.now();

    return files.map((f) => {
      const changeType = this.inferChangeType(f);
      const renamed = isRename(f.file);

      const change: FileChange = {
        filePath: renamed ? renamed.newPath : f.file,
        changeType,
        summary: this.buildFileSummary(f, changeType),
        symbolsAffected: [],        // Populated later by AST comparison
        linesAdded: f.insertions,
        linesRemoved: f.deletions,
        timestamp: now,
        sessionId,
      };

      if (renamed) {
        change.oldPath = renamed.oldPath;
      }

      return change;
    });
  }

  /** Infer the {@link ChangeType} from a git diff file record. */
  private inferChangeType(f: DiffResultTextFile): ChangeType {
    // simple-git marks binary/rename files; we infer from insertions/deletions
    const file = f.file;
    if (isRename(file)) return 'renamed';
    if (f.deletions > 0 && f.insertions === 0 && this.looksDeleted(f)) return 'deleted';
    if (f.insertions > 0 && f.deletions === 0) return 'created';
    return 'modified';
  }

  /** Heuristic: a file is "deleted" when it has only deletions and the
   *  file no longer exists on disk. */
  private looksDeleted(f: DiffResultTextFile): boolean {
    // We can't easily check disk here without async, so rely on git's info.
    // When the file is present in `--name-status` as "D" simple-git already
    // marks it, but the type we receive doesn't expose that.  We fall back
    // to treating it as "modified" and let the change-log correct later.
    return false;
  }

  /** Build a one-line human-readable summary for a single file change. */
  private buildFileSummary(f: DiffResultTextFile, changeType: ChangeType): string {
    const parts: string[] = [];

    switch (changeType) {
      case 'created':
        parts.push(`Created (+${f.insertions} lines)`);
        break;
      case 'deleted':
        parts.push('[DELETED]');
        break;
      case 'renamed': {
        const r = isRename(f.file);
        parts.push(
          `Renamed from ${r?.oldPath ?? '?'} (+${f.insertions}, -${f.deletions} lines)`,
        );
        break;
      }
      case 'modified':
        parts.push(`Modified (+${f.insertions}, -${f.deletions} lines)`);
        break;
    }

    return parts.join('; ');
  }

  // --------------------------------------------------- merge / filter ---

  /**
   * Merge two arrays of diff files, deduplicating by file path (later entry
   * wins so that staged + unstaged don't double-count).
   */
  private mergeDiffFiles(
    a: DiffResultTextFile[],
    b: DiffResultTextFile[],
  ): DiffResultTextFile[] {
    const map = new Map<string, DiffResultTextFile>();
    for (const f of a) map.set(f.file, f);
    for (const f of b) {
      const existing = map.get(f.file);
      if (existing) {
        // Sum insertions/deletions when both staged and unstaged touch the same file.
        map.set(f.file, {
          ...existing,
          insertions: existing.insertions + f.insertions,
          deletions: existing.deletions + f.deletions,
        });
      } else {
        map.set(f.file, f);
      }
    }
    return Array.from(map.values());
  }

  /** Apply include/exclude glob filters to a list of changes. */
  private applyFilters(
    changes: FileChange[],
    options?: DiffQueryOptions,
  ): FileChange[] {
    if (!options) return changes;
    let result = changes;

    if (options.includePatterns?.length) {
      const patterns = options.includePatterns;
      result = result.filter((c) =>
        patterns.some((p) => matchGlob(c.filePath, p)),
      );
    }

    if (options.excludePatterns?.length) {
      const patterns = options.excludePatterns;
      result = result.filter(
        (c) => !patterns.some((p) => matchGlob(c.filePath, p)),
      );
    }

    return result;
  }

  // ---------------------------------------------------------- git init ---

  /**
   * Lazily initialise the git client and probe whether the directory is a
   * git repo.  Returns `true` when git is available.
   */
  private async ensureGit(): Promise<boolean> {
    if (this.isGitRepo !== null) return this.isGitRepo;

    this.git = simpleGit(this.projectRoot);
    try {
      const isRepo = await this.git.checkIsRepo();
      this.isGitRepo = isRepo;
      return isRepo;
    } catch {
      this.isGitRepo = false;
      return false;
    }
  }

  // ------------------------------------------------------ static helpers --

  /** Build the multi-line summary text. */
  static buildSummaryText(
    changes: FileChange[],
    contextLabel?: string,
  ): string {
    if (changes.length === 0) {
      return contextLabel
        ? `${contextLabel}:\n  No changes detected.`
        : 'No changes detected.';
    }

    const header = contextLabel ? `${contextLabel}:` : 'Changes:';
    const lines = changes.map((c) => {
      const prefix = `  - ${c.filePath}:`;
      return `${prefix} ${c.summary}`;
    });

    return [header, ...lines].join('\n');
  }

  /** Convenience for an empty summary. */
  private emptyDiffSummary(usedGit: boolean): DiffSummary {
    return {
      text: 'No changes detected.',
      changes: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      filesAffected: 0,
      usedGit,
    };
  }
}

// ============================================================ utilities ==

/** Parse git's rename notation `{old => new}` or `old => new` into paths. */
function isRename(file: string): { oldPath: string; newPath: string } | null {
  // Pattern: "path/{old => new}/rest" or "old => new"
  const braceMatch = file.match(/^(.*)\{(.+?) => (.+?)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, oldPart, newPart, suffix] = braceMatch;
    return {
      oldPath: `${prefix}${oldPart}${suffix}`.replace(/\/\//g, '/'),
      newPath: `${prefix}${newPart}${suffix}`.replace(/\/\//g, '/'),
    };
  }

  const arrowMatch = file.match(/^(.+?) => (.+?)$/);
  if (arrowMatch) {
    return { oldPath: arrowMatch[1]!, newPath: arrowMatch[2]! };
  }

  return null;
}

/** Trivial glob match — supports `*` and `**` segments. */
function matchGlob(filepath: string, pattern: string): boolean {
  // Normalise separators
  const fp = filepath.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  const regexStr = p
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '⚬⚬')       // placeholder
    .replace(/\*/g, '[^/]*')
    .replace(/⚬⚬/g, '.*');

  return new RegExp(`^${regexStr}$`).test(fp) ||
    new RegExp(`(^|/)${regexStr}($|/)`).test(fp);
}

/** Sum a numeric field across an array. */
function sumField(arr: FileChange[], field: 'linesAdded' | 'linesRemoved'): number {
  return arr.reduce((acc, c) => acc + c[field], 0);
}

/** Convert a past timestamp into a human-friendly delta like "2h". */
function humanTimeDelta(pastMs: number): string {
  const delta = Date.now() - pastMs;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
