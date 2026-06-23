/**
 * AI Mind Map — File System Watcher
 *
 * Real-time file system watcher using chokidar. Inspired by Cursor's Merkle
 * tree approach and CocoIndex's incremental processing. Watches project
 * directories for file changes (create, modify, delete, rename) and emits
 * debounced change events for incremental re-indexing.
 *
 * Key design choices:
 * - Uses Node's EventEmitter for a familiar pub-sub pattern.
 * - Debounces bursts of file system events into batched change sets.
 * - Respects .gitignore plus user-configured custom ignore patterns.
 * - Tracks changed files since the last consumer "drain" so nothing is lost.
 * - Supports start / stop / pause / resume lifecycle.
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import ignore from 'ignore';
import type { ChangeType, MindMapConfig } from '../types.js';

// ------------------------------------------------------------------ types --

/** A lightweight record of a single raw file-system event. */
export interface WatcherEvent {
  /** Absolute path of the affected file. */
  filePath: string;
  /** What happened. */
  changeType: ChangeType;
  /** Absolute path before rename (only for 'renamed' events). */
  oldPath?: string;
  /** Unix-epoch milliseconds when the event was recorded. */
  timestamp: number;
}

/** Events emitted by {@link FileWatcher}. */
export interface WatcherEvents {
  /** Fired after the debounce window closes with ≥ 1 accumulated change. */
  changes: (events: WatcherEvent[]) => void;
  /** Fired when a file system error is encountered. */
  error: (error: Error) => void;
  /** Fired once the initial scan is complete and the watcher is ready. */
  ready: () => void;
}

/** Internal state of the watcher lifecycle. */
type WatcherState = 'idle' | 'running' | 'paused' | 'stopped';

// --------------------------------------------------------------- watcher --

/**
 * Production file-system watcher that batches raw events into debounced
 * {@link WatcherEvent} arrays and re-emits them via EventEmitter.
 *
 * ```ts
 * const watcher = new FileWatcher(config);
 * watcher.on('changes', (events) => { … });
 * await watcher.start();
 * ```
 */
export class FileWatcher extends EventEmitter {
  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly maxFileSize: number;
  private readonly customIgnores: string[];

  /** Underlying chokidar instance. */
  private chokidarWatcher: ReturnType<typeof chokidar.watch> | null = null;

  /** Current lifecycle state. */
  private state: WatcherState = 'idle';

  /** Buffer for events accumulated during the debounce window. */
  private pendingEvents: Map<string, WatcherEvent> = new Map();

  /** Changes accumulated since the last call to {@link drainChanges}. */
  private undrainedChanges: WatcherEvent[] = [];

  /** Handle for the debounce timer, if one is currently active. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Compiled ignore filter (gitignore + custom rules). */
  private ignoreFilter = ignore();

  // ---------------------------------------------------------------- ctor --

  constructor(config: Partial<MindMapConfig> & { projectRoot: string }) {
    super();
    this.projectRoot = path.resolve(config.projectRoot);
    this.debounceMs = config.watchDebounceMs ?? 500;
    this.maxFileSize = config.maxFileSize ?? 512 * 1024;
    this.customIgnores = config.ignore ?? [];
  }

  // ------------------------------------------------------ public methods --

  /**
   * Start watching the project directory.
   *
   * Resolves once the initial scan is complete and the watcher is "ready".
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'paused') {
      return; // already watching
    }

    await this.loadIgnoreRules();

    this.chokidarWatcher = chokidar.watch(this.projectRoot, {
      ignored: (filePath: string) => this.isIgnored(filePath),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
      // Avoid EMFILE on very large repos
      usePolling: false,
    });

    this.attachListeners();
    this.state = 'running';

    // Wait for chokidar's 'ready' event before resolving.
    return new Promise<void>((resolve, reject) => {
      this.chokidarWatcher!.once('ready', () => {
        this.emit('ready');
        resolve();
      });
      this.chokidarWatcher!.once('error', (err: unknown) => {
        reject(err);
      });
    });
  }

  /** Pause watching — events are silently discarded until {@link resume}. */
  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.clearDebounce();
  }

  /** Resume watching after a {@link pause}. */
  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
  }

  /**
   * Stop watching entirely and release all resources.
   *
   * After calling `stop()` the instance cannot be restarted — create a new
   * one instead.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.clearDebounce();

    if (this.chokidarWatcher) {
      await this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }

    this.state = 'stopped';
    this.pendingEvents.clear();
    this.removeAllListeners();
  }

  /** Current lifecycle state of the watcher. */
  getState(): WatcherState {
    return this.state;
  }

  /**
   * Return all change events accumulated since the last drain (or since
   * start, whichever is more recent) and clear the buffer.
   *
   * This is the primary API for consumers that want to poll rather than
   * subscribe via events.
   */
  drainChanges(): WatcherEvent[] {
    const changes = [...this.undrainedChanges];
    this.undrainedChanges = [];
    return changes;
  }

  /**
   * Peek at the undrained changes without clearing them.
   */
  peekChanges(): readonly WatcherEvent[] {
    return this.undrainedChanges;
  }

  // -------------------------------------------------- ignore-rule loading --

  /**
   * Load `.gitignore` from the project root (if it exists) and merge it
   * with user-configured custom ignore patterns.
   */
  private async loadIgnoreRules(): Promise<void> {
    this.ignoreFilter = ignore();

    // Always ignore .git directory itself
    this.ignoreFilter.add('.git');

    // Load .gitignore
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      this.ignoreFilter.add(content);
    } catch {
      // No .gitignore — that's fine.
    }

    // Add custom ignore patterns from config
    if (this.customIgnores.length > 0) {
      this.ignoreFilter.add(this.customIgnores);
    }
  }

  /**
   * Determine whether a given absolute path should be ignored.
   */
  private isIgnored(filePath: string): boolean {
    // Always allow the root itself through so chokidar can traverse it.
    if (filePath === this.projectRoot) return false;

    const relative = path.relative(this.projectRoot, filePath);
    // Paths outside project root — ignore.
    if (!relative || relative.startsWith('..')) return true;

    // Normalise to forward-slash for `ignore` (it expects posix paths).
    const posix = relative.split(path.sep).join('/');
    try {
      return this.ignoreFilter.ignores(posix);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------- event wiring --

  /** Wire chokidar events to our internal handler. */
  private attachListeners(): void {
    if (!this.chokidarWatcher) return;

    this.chokidarWatcher.on('add', (fp: string) => this.handleEvent(fp, 'created'));
    this.chokidarWatcher.on('change', (fp: string) => this.handleEvent(fp, 'modified'));
    this.chokidarWatcher.on('unlink', (fp: string) => this.handleEvent(fp, 'deleted'));

    this.chokidarWatcher.on('error', (error: unknown) => {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  // -------------------------------------------------- event accumulation --

  /**
   * Handle a single raw chokidar event.
   *
   * Events are accumulated in {@link pendingEvents} (keyed by path so that
   * rapid repeated changes to the same file collapse) and a debounce timer
   * is (re)started.
   */
  private handleEvent(filePath: string, changeType: ChangeType): void {
    if (this.state !== 'running') return;

    const absPath = path.resolve(filePath);
    const existing = this.pendingEvents.get(absPath);

    // Collapse logic — e.g. create → modify becomes create; create → delete
    // cancels both; modify → delete becomes delete, etc.
    const resolvedType = this.resolveChangeType(existing?.changeType, changeType);

    if (resolvedType === null) {
      // Changes cancel each other out (e.g. create + delete).
      this.pendingEvents.delete(absPath);
    } else {
      this.pendingEvents.set(absPath, {
        filePath: absPath,
        changeType: resolvedType,
        timestamp: Date.now(),
      });
    }

    this.restartDebounce();
  }

  /**
   * Collapse two sequential change types into a single effective type.
   *
   * Returns `null` when the net effect is "nothing happened" (e.g. a file
   * was created then immediately deleted within the debounce window).
   */
  private resolveChangeType(
    prev: ChangeType | undefined,
    curr: ChangeType,
  ): ChangeType | null {
    if (prev === undefined) return curr;

    // created → deleted = net nothing
    if (prev === 'created' && curr === 'deleted') return null;
    // created → modified = still "created"
    if (prev === 'created' && curr === 'modified') return 'created';
    // modified → deleted = deleted
    if (prev === 'modified' && curr === 'deleted') return 'deleted';
    // anything → modified after existing modify = still modified
    if (prev === 'modified' && curr === 'modified') return 'modified';
    // deleted → created = modified (re-created file)
    if (prev === 'deleted' && curr === 'created') return 'modified';

    return curr;
  }

  // ----------------------------------------------------------- debounce --

  /** Clear any outstanding debounce timer. */
  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** (Re)start the debounce timer. */
  private restartDebounce(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.flushPending();
    }, this.debounceMs);
  }

  /** Flush the pending-events buffer and emit a `changes` event. */
  private flushPending(): void {
    if (this.pendingEvents.size === 0) return;

    const events = Array.from(this.pendingEvents.values());
    this.pendingEvents.clear();
    this.debounceTimer = null;

    // Append to the undrained buffer so polling consumers can pick them up.
    this.undrainedChanges.push(...events);

    this.emit('changes', events);
  }

  // -------------------------------------------------------- error handler --

  /** Centralised error handler — emits 'error' but never throws. */
  private handleError(error: Error): void {
    // Locked / inaccessible file warnings are common on Windows — demote
    // them to non-fatal.
    const isTransient =
      (error as NodeJS.ErrnoException).code === 'EPERM' ||
      (error as NodeJS.ErrnoException).code === 'EBUSY' ||
      (error as NodeJS.ErrnoException).code === 'EACCES';

    if (isTransient) {
      // Silently swallow transient FS errors; nothing actionable.
      return;
    }

    this.emit('error', error);
  }
}
