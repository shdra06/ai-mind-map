/**
 * AI Mind Map — Codebase Indexer (Full & Incremental)
 *
 * Scans a project's source files, parses each with the tree-sitter/regex parser,
 * and stores extracted structural information in the knowledge graph.
 *
 * Supports full re-indexing and incremental updates (only re-parse changed files).
 * Respects .gitignore patterns and custom ignore lists.
 *
 * Inspired by CocoIndex's incremental approach and Cursor's Merkle tree.
 */

import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { relative, join } from 'node:path';
import { glob } from 'glob';
import ignore from 'ignore';
import type { MindMapConfig } from '../types.js';
import { KnowledgeGraph } from './graph.js';
import {
  parseFile,
  parseFiles,
  isSupportedFile,
  detectLanguage,
  getSupportedExtensions,
  generateContentHash,
} from './parser.js';
import type { ParseResult } from './parser.js';
import type { ChangelogEngine } from './changelog.js';

/** Maximum file size to index (1MB). Files larger than this are skipped to prevent OOM. */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/** Memory pressure threshold — pause indexing if heap usage exceeds this fraction. */
const MEMORY_PRESSURE_THRESHOLD = 0.85;

// ============================================================
// Types
// ============================================================

/** Progress callback for indexing operations */
export type IndexProgressCallback = (progress: IndexProgress) => void;

/** Indexing progress information */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'cleanup' | 'complete';
  current: number;
  total: number;
  currentFile?: string;
  message: string;
}

/** Statistics from an indexing run */
export interface IndexStats {
  filesScanned: number;
  filesParsed: number;
  filesSkipped: number;
  filesDeleted: number;
  nodesCreated: number;
  edgesCreated: number;
  parseErrors: number;
  durationMs: number;
  languages: Record<string, number>;
}

// ============================================================
// Indexer Class
// ============================================================

/**
 * Codebase indexer that scans, parses, and indexes source files
 * into the knowledge graph.
 */
export class Indexer {
  private graph: KnowledgeGraph;
  private config: MindMapConfig;
  private ig: ReturnType<typeof ignore>;
  private changelog: ChangelogEngine | null = null;

  /**
   * Per-project-root ignore patterns.
   * When multiple projects are indexed, each keeps its own .gitignore rules.
   */
  private projectIgnores = new Map<string, ReturnType<typeof ignore>>();
  /** Track all project roots we've indexed */
  private knownProjectRoots: string[] = [];

  constructor(graph: KnowledgeGraph, config: MindMapConfig) {
    this.graph = graph;
    this.config = config;
    this.ig = ignore();

    // Load .gitignore patterns
    this.loadIgnorePatterns();
    // Store as the first known project
    this.projectIgnores.set(this.config.projectRoot, this.ig);
    this.knownProjectRoots.push(this.config.projectRoot);
  }

  /** Attach a changelog engine for node-level change tracking */
  setChangelog(changelog: ChangelogEngine): void {
    this.changelog = changelog;
  }

  /**
   * Re-target the indexer to a different project directory.
   * Reloads .gitignore patterns and updates config.projectRoot.
   * The graph is NOT cleared — nodes from multiple projects can coexist.
   * Previous project's ignore patterns are preserved for file watcher events.
   */
  setProjectRoot(newRoot: string): void {
    this.config.projectRoot = newRoot;
    // Reset and reload ignore patterns for the new root
    this.ig = ignore();
    this.loadIgnorePatterns();
    // Store the new project's ignore patterns
    this.projectIgnores.set(newRoot, this.ig);
    if (!this.knownProjectRoots.includes(newRoot)) {
      this.knownProjectRoots.push(newRoot);
    }
  }

  /** Get the list of all indexed project roots */
  getKnownProjectRoots(): string[] {
    return [...this.knownProjectRoots];
  }

  /**
   * Find the project root that a file belongs to.
   * Matches by longest prefix (most specific root wins).
   */
  private findProjectRootForFile(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    let bestMatch: string | null = null;
    let bestLength = 0;
    for (const root of this.knownProjectRoots) {
      const normalizedRoot = root.replace(/\\/g, '/');
      if (normalized.startsWith(normalizedRoot) && normalizedRoot.length > bestLength) {
        bestMatch = root;
        bestLength = normalizedRoot.length;
      }
    }
    return bestMatch;
  }

  /**
   * Get the correct ignore instance for a file path.
   * Falls back to the current project's ignore if no match found.
   */
  private getIgnoreForFile(filePath: string): ReturnType<typeof ignore> {
    const projectRoot = this.findProjectRootForFile(filePath);
    if (projectRoot) {
      return this.projectIgnores.get(projectRoot) ?? this.ig;
    }
    return this.ig;
  }

  /** Load ignore patterns from .gitignore and config */
  private loadIgnorePatterns(): void {
    // Add config-specified ignore patterns
    if (this.config.ignore.length > 0) {
      this.ig.add(this.config.ignore);
    }

    // Try to read .gitignore
    try {
      const gitignorePath = join(this.config.projectRoot, '.gitignore');
      const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
      this.ig.add(gitignoreContent);
    } catch {
      // No .gitignore file, continue
    }

    // Try nested .gitignore files
    try {
      const nestedIgnores = [
        join(this.config.projectRoot, 'src', '.gitignore'),
        join(this.config.projectRoot, 'packages', '.gitignore'),
      ];
      for (const p of nestedIgnores) {
        try {
          const content = readFileSync(p, 'utf-8');
          this.ig.add(content);
        } catch {
          // Skip non-existent files
        }
      }
    } catch {
      // Skip
    }
  }

  /**
   * Scan the project directory for indexable source files.
   *
   * Respects .gitignore and custom ignore patterns.
   * Skips binary files and files exceeding maxFileSize.
   */
  async scanFiles(): Promise<string[]> {
    const extensions = getSupportedExtensions();

    // Build glob patterns from supported extensions
    const patterns = extensions.map(ext => `**/*${ext}`);

    // Find all matching files
    const allFiles: string[] = [];
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.config.projectRoot,
        absolute: true,
        nodir: true,
        dot: false,
        ignore: this.config.ignore.map(p => {
          // Convert simple names to glob patterns
          if (!p.includes('/') && !p.includes('*')) {
            return `**/${p}/**`;
          }
          return p;
        }),
      });
      allFiles.push(...matches);
    }

    // De-duplicate
    const uniqueFiles = [...new Set(allFiles)];

    // Filter through ignore patterns and size checks
    const validFiles: string[] = [];
    for (const absPath of uniqueFiles) {
      const relPath = relative(this.config.projectRoot, absPath).replace(/\\/g, '/');

      // Check ignore patterns
      if (this.ig.ignores(relPath)) continue;

      // Check file size
      try {
        const fileStat = await stat(absPath);
        if (fileStat.size > this.config.maxFileSize) continue;
        if (fileStat.size === 0) continue;
      } catch {
        continue;
      }

      // Check if it's a supported source file
      if (!isSupportedFile(absPath)) continue;

      validFiles.push(absPath);
    }

    return validFiles.sort();
  }

  /**
   * Perform a full index of the entire codebase.
   *
   * Scans all files, parses each, and stores results in the graph.
   * Clears existing data before indexing.
   *
   * @param onProgress - Optional progress callback
   * @returns Indexing statistics
   */
  async fullIndex(onProgress?: IndexProgressCallback): Promise<IndexStats> {
    const startTime = Date.now();
    const stats: IndexStats = {
      filesScanned: 0,
      filesParsed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      parseErrors: 0,
      durationMs: 0,
      languages: {},
    };

    // Phase 1: Scanning
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
      message: 'Scanning project for source files...',
    });

    const files = await this.scanFiles();
    stats.filesScanned = files.length;

    if (files.length === 0) {
      onProgress?.({
        phase: 'complete',
        current: 0,
        total: 0,
        message: 'No source files found to index.',
      });
      stats.durationMs = Date.now() - startTime;
      return stats;
    }

    // Clear only nodes belonging to THIS project (preserve other projects)
    this.graph.clearProject(this.config.projectRoot);

    // Phase 2: Parsing
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total: files.length,
      message: `Parsing ${files.length} files...`,
    });

    const parseResults = await parseFiles(files, 16, (current, total) => {
      onProgress?.({
        phase: 'parsing',
        current,
        total,
        currentFile: files[Math.min(current, files.length - 1)],
        message: `Parsed ${current}/${total} files`,
      });
    });

    // Phase 3: Storing
    onProgress?.({
      phase: 'storing',
      current: 0,
      total: parseResults.length,
      message: 'Storing parsed data in knowledge graph...',
    });

    for (let i = 0; i < parseResults.length; i++) {
      const result = parseResults[i];

      // If any single file fails, log and continue
      try {
        if (result.nodes.length === 0 && result.parseErrors.length > 0) {
          stats.filesSkipped++;
          stats.parseErrors += result.parseErrors.length;
          continue;
        }

        stats.filesParsed++;
        stats.nodesCreated += result.nodes.length;
        stats.edgesCreated += result.edges.length;

        // Track language distribution
        if (result.language !== 'unknown') {
          stats.languages[result.language] = (stats.languages[result.language] ?? 0) + 1;
        }

        if (result.parseErrors.length > 0) {
          stats.parseErrors += result.parseErrors.length;
        }

        // Store in graph
        this.graph.replaceFileData(result.filePath, result.nodes, result.edges);

        if (i % 50 === 0) {
          onProgress?.({
            phase: 'storing',
            current: i + 1,
            total: parseResults.length,
            currentFile: result.filePath,
            message: `Stored ${i + 1}/${parseResults.length} files`,
          });
        }

        // Memory pressure check every 100 files
        if (i % 100 === 0 && i > 0) {
          const mem = process.memoryUsage();
          if (mem.heapUsed / mem.heapTotal > MEMORY_PRESSURE_THRESHOLD) {
            process.stderr.write(
              `⚠️ Memory pressure during fullIndex at file ${i}/${parseResults.length}. Stopping early.\n`
            );
            break;
          }
        }
      } catch {
        stats.parseErrors++;
      }
    }

    // Phase 4: Complete
    stats.durationMs = Date.now() - startTime;

    onProgress?.({
      phase: 'complete',
      current: stats.filesParsed,
      total: stats.filesScanned,
      message: `Indexing complete: ${stats.filesParsed} files, ${stats.nodesCreated} nodes, ${stats.edgesCreated} edges in ${stats.durationMs}ms`,
    });

    return stats;
  }

  /**
   * Perform an incremental index — only re-parse files that have changed.
   *
   * Detects changes by comparing content hashes stored in the graph
   * against current file contents.
   *
   * @param onProgress - Optional progress callback
   * @returns Indexing statistics
   */
  async incrementalIndex(onProgress?: IndexProgressCallback): Promise<IndexStats> {
    const startTime = Date.now();
    const stats: IndexStats = {
      filesScanned: 0,
      filesParsed: 0,
      filesSkipped: 0,
      filesDeleted: 0,
      nodesCreated: 0,
      edgesCreated: 0,
      parseErrors: 0,
      durationMs: 0,
      languages: {},
    };

    // Phase 1: Scanning
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
      message: 'Scanning for changes...',
    });

    const currentFiles = await this.scanFiles();
    stats.filesScanned = currentFiles.length;

    const indexedFiles = new Set(this.graph.getIndexedFiles());
    const currentFileSet = new Set(currentFiles);

    // Find files to add/update and files to delete
    const filesToParse: string[] = [];
    const filesToDelete: string[] = [];

    // ── mtime-first staleness detection (10x faster) ──────────
    // First check mtime+size via stat() (~0.1ms/file). Only hash
    // files whose metadata changed (~3ms/file). This avoids
    // reading every file on every incremental index.
    for (const filePath of currentFiles) {
      const existingHash = this.graph.getFileHash(filePath);

      if (!existingHash) {
        // New file — always parse
        filesToParse.push(filePath);
        continue;
      }

      // Fast path: check mtime+size from file_index table
      const fileEntry = this.graph.getFileIndexEntry(filePath);
      try {
        const fileStat = await stat(filePath);

        if (fileEntry) {
          // If mtime AND size match, file is unchanged (fast path — 99% of cases)
          if (fileStat.mtimeMs === fileEntry.mtime_ms && fileStat.size === fileEntry.size_bytes) {
            stats.filesSkipped++;
            continue;
          }
        }

        // Slow path: metadata changed, verify with content hash
        const content = await readFile(filePath, 'utf-8');
        const currentHash = generateContentHash(content);
        if (currentHash !== existingHash) {
          filesToParse.push(filePath);
        } else {
          // Content unchanged despite metadata change — update file_index
          this.graph.upsertFileIndex(filePath, fileStat.mtimeMs, fileStat.size, currentHash);
          stats.filesSkipped++;
        }
      } catch {
        stats.filesSkipped++;
      }
    }

    // Check for deleted files
    for (const indexedFile of indexedFiles) {
      if (!currentFileSet.has(indexedFile)) {
        filesToDelete.push(indexedFile);
      }
    }

    // Phase 2: Handle deletions
    if (filesToDelete.length > 0) {
      onProgress?.({
        phase: 'cleanup',
        current: 0,
        total: filesToDelete.length,
        message: `Removing ${filesToDelete.length} deleted files...`,
      });

      for (const filePath of filesToDelete) {
        this.graph.deleteFileNodes(filePath);
        this.graph.removeFileIndex(filePath);
        stats.filesDeleted++;
      }
    }

    // Phase 3: Parse changed files
    if (filesToParse.length > 0) {
      onProgress?.({
        phase: 'parsing',
        current: 0,
        total: filesToParse.length,
        message: `Parsing ${filesToParse.length} changed files...`,
      });

      // ── Memory-aware indexing ─────────────────────────────
      // Check memory pressure before parsing. If approaching
      // 80% heap usage, stop and report partial results.
      const memInfo = process.memoryUsage();
      if (memInfo.heapUsed / memInfo.heapTotal > MEMORY_PRESSURE_THRESHOLD) {
        console.error(
          `[ai-mind-map] Memory pressure: ${(memInfo.heapUsed / 1024 / 1024).toFixed(0)}MB / ` +
          `${(memInfo.heapTotal / 1024 / 1024).toFixed(0)}MB. ` +
          `Skipping ${filesToParse.length} files to prevent OOM.`
        );
        stats.filesSkipped += filesToParse.length;
      } else {
        const parseResults = await parseFiles(filesToParse, 8, (current, total) => {
          onProgress?.({
            phase: 'parsing',
            current,
            total,
            currentFile: filesToParse[Math.min(current, filesToParse.length - 1)],
            message: `Parsed ${current}/${total} changed files`,
          });
        });

        // Phase 4: Store results
        onProgress?.({
          phase: 'storing',
          current: 0,
          total: parseResults.length,
          message: 'Updating knowledge graph...',
        });

        for (let i = 0; i < parseResults.length; i++) {
          // Check memory between files
          if (i > 0 && i % 100 === 0) {
            const mem = process.memoryUsage();
            if (mem.heapUsed / mem.heapTotal > MEMORY_PRESSURE_THRESHOLD) {
              console.error(
                `[ai-mind-map] Memory pressure at file ${i}/${parseResults.length}. ` +
                `Stopping early to prevent OOM.`
              );
              stats.filesSkipped += parseResults.length - i;
              break;
            }
          }

          const result = parseResults[i];

          if (result.nodes.length === 0 && result.parseErrors.length > 0) {
            stats.parseErrors += result.parseErrors.length;
            continue;
          }

          stats.filesParsed++;
          stats.nodesCreated += result.nodes.length;
          stats.edgesCreated += result.edges.length;

          if (result.language !== 'unknown') {
            stats.languages[result.language] = (stats.languages[result.language] ?? 0) + 1;
          }

          if (result.parseErrors.length > 0) {
            stats.parseErrors += result.parseErrors.length;
          }

          // Record changes before replacing (changelog diffing)
          if (this.changelog) {
            try {
              const oldNodes = this.graph.getNodesForFile(result.filePath);
              this.changelog.recordChanges(result.filePath, oldNodes, result.nodes);
            } catch {
              // Changelog recording is non-critical
            }
          }

          // Replace file data atomically
          this.graph.replaceFileData(result.filePath, result.nodes, result.edges);

          // Update file_index for future mtime-first detection
          try {
            const fileStat = await stat(result.filePath);
            const fileHash = result.nodes.find(n => n.type === 'file')?.hash ?? '';
            this.graph.upsertFileIndex(result.filePath, fileStat.mtimeMs, fileStat.size, fileHash);
          } catch {
            // File may have been deleted between parse and store
          }
        }
      }
    }

    // Phase 5: Complete
    stats.durationMs = Date.now() - startTime;

    const changeCount = filesToParse.length + filesToDelete.length;
    onProgress?.({
      phase: 'complete',
      current: changeCount,
      total: stats.filesScanned,
      message: changeCount > 0
        ? `Incremental index: ${stats.filesParsed} updated, ${stats.filesDeleted} deleted in ${stats.durationMs}ms`
        : `No changes detected (${stats.filesScanned} files checked in ${stats.durationMs}ms)`,
    });

    return stats;
  }

  /**
   * Index a single file (e.g., when file watcher detects a change).
   *
   * @param filePath - Absolute path to the changed file
   * @returns Parse result, or null if file was skipped
   */
  async indexFile(filePath: string): Promise<ParseResult | null> {
    // Determine which project this file belongs to (multi-project support)
    const fileProjectRoot = this.findProjectRootForFile(filePath) ?? this.config.projectRoot;
    const fileIgnore = this.getIgnoreForFile(filePath);

    // Check if file should be ignored using the correct project's rules
    const relPath = relative(fileProjectRoot, filePath).replace(/\\/g, '/');
    if (fileIgnore.ignores(relPath)) return null;
    if (!isSupportedFile(filePath)) return null;

    // Skip files that are too large (prevent OOM)
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size > MAX_FILE_SIZE_BYTES) {
      return null;
    }

    try {
      if (fileStat.size > this.config.maxFileSize) return null;
      if (fileStat.size === 0) return null;
    } catch {
      // File may have been deleted
      this.graph.deleteFileNodes(filePath);
      return null;
    }

    const result = await parseFile(filePath);

    if (result.nodes.length > 0) {
      // Record changes before replacing (changelog diffing)
      if (this.changelog) {
        try {
          const oldNodes = this.graph.getNodesForFile(filePath);
          this.changelog.recordChanges(filePath, oldNodes, result.nodes);
        } catch {
          // Changelog recording is non-critical
        }
      }

      this.graph.replaceFileData(filePath, result.nodes, result.edges);
    }

    return result;
  }

  /**
   * Remove a file from the index (e.g., when file watcher detects deletion).
   *
   * @param filePath - Absolute path to the deleted file
   * @returns Number of nodes removed
   */
  removeFile(filePath: string): number {
    this.graph.removeFileIndex(filePath);
    return this.graph.deleteFileNodes(filePath);
  }

  /**
   * Get a stale report: files changed since last index, detected via mtime comparison.
   * This is a fast O(n) stat() scan — much cheaper than full content hashing.
   */
  async getStaleReport(): Promise<{
    staleFiles: string[];
    newFiles: string[];
    deletedFiles: string[];
    totalTracked: number;
    lastIndexedAt: number;
  }> {
    const currentFiles = await this.scanFiles();
    const currentSet = new Set(currentFiles);
    const staleFiles: string[] = [];
    const newFiles: string[] = [];
    const deletedFiles: string[] = [];
    let lastIndexedAt = 0;

    // Check current files against file_index
    for (const filePath of currentFiles) {
      const entry = this.graph.getFileIndexEntry(filePath);
      if (!entry) {
        newFiles.push(filePath);
        continue;
      }
      if (entry.indexed_at > lastIndexedAt) {
        lastIndexedAt = entry.indexed_at;
      }
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs !== entry.mtime_ms || fileStat.size !== entry.size_bytes) {
          staleFiles.push(filePath);
        }
      } catch {
        staleFiles.push(filePath); // Can't stat → probably changed or deleted
      }
    }

    // Check for deleted files still in file_index
    const allEntries = this.graph.getAllFileIndexEntries();
    for (const entry of allEntries) {
      if (!currentSet.has(entry.file_path)) {
        deletedFiles.push(entry.file_path);
      }
    }

    return {
      staleFiles,
      newFiles,
      deletedFiles,
      totalTracked: this.graph.getFileIndexCount(),
      lastIndexedAt,
    };
  }

  /**
   * Auto-detect the languages used in the project based on file extension distribution.
   *
   * @returns Sorted array of language names (most common first)
   */
  async detectProjectLanguages(): Promise<string[]> {
    const files = await this.scanFiles();
    const langCounts: Record<string, number> = {};

    for (const file of files) {
      const lang = detectLanguage(file);
      if (lang) {
        langCounts[lang] = (langCounts[lang] ?? 0) + 1;
      }
    }

    return Object.entries(langCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([lang]) => lang);
  }

  /**
   * Get the current indexing status — how many files are indexed vs how many exist.
   */
  async getIndexStatus(): Promise<{
    indexedFiles: number;
    totalFiles: number;
    staleness: number;
    needsReindex: boolean;
  }> {
    const currentFiles = await this.scanFiles();
    const indexedFiles = this.graph.getIndexedFiles();
    const indexedSet = new Set(indexedFiles);

    let staleCount = 0;
    for (const filePath of currentFiles) {
      if (!indexedSet.has(filePath)) {
        staleCount++;
      }
    }

    // Check for deleted files still in index
    const currentSet = new Set(currentFiles);
    for (const indexedFile of indexedFiles) {
      if (!currentSet.has(indexedFile)) {
        staleCount++;
      }
    }

    const staleness = currentFiles.length > 0 ? staleCount / currentFiles.length : 0;

    return {
      indexedFiles: indexedFiles.length,
      totalFiles: currentFiles.length,
      staleness,
      needsReindex: staleness > 0.1, // More than 10% stale
    };
  }

  /** Validate the index against the filesystem. Returns files that are stale, missing, or orphaned. */
  async validateIndex(): Promise<{
    staleFiles: string[];    // files changed since last index
    missingFiles: string[];  // indexed but deleted from disk
    unindexedFiles: string[]; // on disk but not in index
    healthy: boolean;
  }> {
    const indexedFiles = this.graph.getIndexedFiles();
    const diskFiles = await this.scanFiles();
    const diskSet = new Set(diskFiles);
    const indexSet = new Set(indexedFiles);

    const missingFiles: string[] = [];
    const staleFiles: string[] = [];
    const unindexedFiles: string[] = [];

    // Check indexed files against disk
    for (const f of indexedFiles) {
      if (!diskSet.has(f)) {
        missingFiles.push(f);
      } else {
        // Check if file changed
        try {
          const content = readFileSync(f, 'utf-8');
          const currentHash = (await import('./parser.js')).generateContentHash(content);
          const indexedHash = this.graph.getFileHash(f);
          if (indexedHash && currentHash !== indexedHash) {
            staleFiles.push(f);
          }
        } catch {
          staleFiles.push(f);
        }
      }
    }

    // Check for unindexed files
    for (const f of diskFiles) {
      if (!indexSet.has(f)) {
        unindexedFiles.push(f);
      }
    }

    return {
      staleFiles,
      missingFiles,
      unindexedFiles,
      healthy: staleFiles.length === 0 && missingFiles.length === 0 && unindexedFiles.length === 0,
    };
  }
}
