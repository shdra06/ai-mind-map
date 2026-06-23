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

import { readFileSync } from 'node:fs';
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

/** Maximum file size to index (default 512KB). Files larger than this are skipped to prevent OOM. */
const MAX_FILE_SIZE_BYTES = 512 * 1024;

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

  constructor(graph: KnowledgeGraph, config: MindMapConfig) {
    this.graph = graph;
    this.config = config;
    this.ig = ignore();

    // Load .gitignore patterns
    this.loadIgnorePatterns();
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

    // Clear existing graph data
    this.graph.clear();

    // Phase 2: Parsing
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total: files.length,
      message: `Parsing ${files.length} files...`,
    });

    const parseResults = await parseFiles(files, 8, (current, total) => {
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

    // Check for new or modified files
    for (const filePath of currentFiles) {
      const existingHash = this.graph.getFileHash(filePath);

      if (!existingHash) {
        // New file
        filesToParse.push(filePath);
        continue;
      }

      // Check if content has changed
      try {
        const content = await readFile(filePath, 'utf-8');
        const currentHash = generateContentHash(content);
        if (currentHash !== existingHash) {
          filesToParse.push(filePath);
        } else {
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
        const deleted = this.graph.deleteFileNodes(filePath);
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

        // Replace file data atomically
        this.graph.replaceFileData(result.filePath, result.nodes, result.edges);
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
    // Check if file should be ignored
    const relPath = relative(this.config.projectRoot, filePath).replace(/\\/g, '/');
    if (this.ig.ignores(relPath)) return null;
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
    return this.graph.deleteFileNodes(filePath);
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
