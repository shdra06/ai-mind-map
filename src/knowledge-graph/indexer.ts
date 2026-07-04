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

import { readFileSync, statSync, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { relative, join, resolve } from 'node:path';
import v8 from 'node:v8';
import { glob } from 'glob';
import ignore from 'ignore';
import type { MindMapConfig, GraphNode, GraphEdge } from '../types.js';
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

/** Maximum file size to index (2MB). Files larger than this are skipped to prevent OOM. */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

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

  // Async lock for indexing operations
  private _indexLock: Promise<void> = Promise.resolve();
  private _lockRelease: (() => void) | null = null;

  private async acquireIndexLock(): Promise<() => void> {
    const previous = this._indexLock;
    let release!: () => void;
    this._indexLock = new Promise<void>(resolve => { release = resolve; });
    this._lockRelease = release;
    await previous;
    return () => {
      this._lockRelease = null;
      release();
    };
  }

  get isIndexing(): boolean {
    return this._lockRelease !== null;
  }

  // Optional watcher reference to pause/resume during full reindex
  private watcher: { pause(): void; resume(): void } | null = null;

  setWatcher(watcher: { pause(): void; resume(): void }): void {
    this.watcher = watcher;
  }

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
   * Change the active project root at runtime.
   * Reloads .gitignore patterns and updates config.projectRoot.
   * 
   * IMPORTANT: Does NOT clear the graph. The database stores filePath per node,
   * so data from different projects coexists safely. fullIndex() uses
   * clearProject() to clean only the current project's stale data before
   * re-parsing. Previously indexed projects are PRESERVED — switching back
   * to them is instant if no files changed (mtime staleness check).
   */
  setProjectRoot(newRoot: string): void {
    // Security fix (C-3): validate the new project root
    const resolvedRoot = resolve(newRoot);
    if (!existsSync(resolvedRoot)) {
      throw new Error(`[indexer] Invalid project root: path does not exist: ${resolvedRoot}`);
    }
    const st = statSync(resolvedRoot);
    if (!st.isDirectory()) {
      throw new Error(`[indexer] Invalid project root: not a directory: ${resolvedRoot}`);
    }
    // Block sensitive system directories
    const normalized = resolvedRoot.replace(/\\/g, '/').toLowerCase();
    const BLOCKED = [
      'c:/windows', 'c:/program files', 'c:/program files (x86)',
      'c:/programdata', 'c:/recovery',
      '/etc', '/var', '/usr', '/sbin', '/bin', '/boot', '/root', '/proc', '/sys',
    ];
    if (BLOCKED.some(b => normalized.startsWith(b))) {
      throw new Error(`[indexer] Cannot index system directory: ${resolvedRoot}`);
    }

    const oldRoot = this.config.projectRoot;
    this.config.projectRoot = resolvedRoot;

    if (oldRoot !== resolvedRoot) {
      process.stderr.write(
        `[indexer] Project switched: ${oldRoot} -> ${resolvedRoot}. Previous index data preserved in DB.\n`
      );
    }

    // Reset and reload ignore patterns for the new root
    this.ig = ignore();
    this.loadIgnorePatterns();
    // Store the new project's ignore patterns
    this.projectIgnores.set(resolvedRoot, this.ig);
    if (!this.knownProjectRoots.includes(resolvedRoot)) {
      this.knownProjectRoots.push(resolvedRoot);
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
        join(this.config.projectRoot, 'lib', '.gitignore'),
        join(this.config.projectRoot, 'app', '.gitignore'),
        join(this.config.projectRoot, 'test', '.gitignore'),
        join(this.config.projectRoot, 'tests', '.gitignore'),
        join(this.config.projectRoot, 'cmd', '.gitignore'),
        join(this.config.projectRoot, 'internal', '.gitignore'),
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
   * Build cross-file call edges.
   * 
   * After all files are indexed, scans function bodies for references to
   * symbols defined in OTHER files and creates 'calls' edges for them.
   * This is what makes flow tracing work across file boundaries.
   */
  buildCrossReferences(): { edgesCreated: number } {
    const startTime = Date.now();
    let edgesCreated = 0;

    // Phase 1: Build global symbol registry from the graph
    //   Map<symbolName, Set<nodeId>> — all callable symbols
    const symbolRegistry = new Map<string, Set<string>>();
    const allNodes = this.graph.getAllNodes();
    const callableTypes = new Set(['function', 'method', 'constructor', 'class', 'interface']);
    
    for (const node of allNodes) {
      if (!callableTypes.has(node.type)) continue;
      const existing = symbolRegistry.get(node.name);
      if (existing) {
        existing.add(node.id);
      } else {
        symbolRegistry.set(node.name, new Set([node.id]));
      }
    }

    // Phase 2: For each function/method, read its body and look for cross-file calls
    const existingEdges = new Set<string>();
    // Pre-load all existing call edges to avoid duplicates
    for (const node of allNodes) {
      if (!callableTypes.has(node.type)) continue;
      const outEdges = this.graph.getOutEdges(node.id);
      for (const edge of outEdges) {
        if (edge.type === 'calls') {
          existingEdges.add(`${edge.sourceId}:${edge.targetId}`);
        }
      }
    }

    // Build regex from all function names (batched for performance)
    const symbolNames = [...symbolRegistry.keys()].filter(name => 
      name.length >= 3 && /^\w+$/.test(name) // Skip very short names and non-identifiers
    );
    
    if (symbolNames.length === 0) return { edgesCreated: 0 };
    
    // Process nodes in batches to avoid reading too many files
    const functionsToAnalyze = allNodes.filter(n => 
      (n.type === 'function' || n.type === 'method') && n.endLine > n.startLine
    );

    // Build a pattern that matches function call syntax: name(
    // Process in smaller chunks to avoid regex size limits
    const CHUNK_SIZE = 500;
    const newEdges: Array<{ sourceId: string; targetId: string; type: 'calls'; metadata?: Record<string, string> }> = [];

    for (let chunkStart = 0; chunkStart < symbolNames.length; chunkStart += CHUNK_SIZE) {
      const chunk = symbolNames.slice(chunkStart, chunkStart + CHUNK_SIZE);
      const pattern = new RegExp(`\\b(${chunk.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`, 'g');

      for (const sourceNode of functionsToAnalyze) {
        try {
          const content = readFileSync(sourceNode.filePath, 'utf-8');
          const lines = content.split('\n');
          const body = lines.slice(sourceNode.startLine - 1, sourceNode.endLine).join('\n');
          
          let match: RegExpExecArray | null;
          pattern.lastIndex = 0;
          while ((match = pattern.exec(body)) !== null) {
            const calledName = match[1];
            const targetIds = symbolRegistry.get(calledName);
            if (!targetIds) continue;

            for (const targetId of targetIds) {
              // Skip self-calls and same-file calls (already have intra-file edges)
              const targetNode = this.graph.getNode(targetId);
              if (!targetNode) continue;
              if (targetNode.filePath === sourceNode.filePath) continue; // Already handled by parser
              if (targetId === sourceNode.id) continue; // Self-call

              const edgeKey = `${sourceNode.id}:${targetId}`;
              if (existingEdges.has(edgeKey)) continue;
              existingEdges.add(edgeKey);

              newEdges.push({
                sourceId: sourceNode.id,
                targetId,
                type: 'calls',
                metadata: { crossFile: 'true' },
              });
              edgesCreated++;
            }
          }
        } catch {
          // File might have been deleted or be unreadable
        }
      }
    }

    // Store cross-file edges in graph
    if (newEdges.length > 0) {
      this.graph.batchInsertEdges(newEdges);
    }

    process.stderr.write(`[ai-mind-map] Cross-file refs: ${edgesCreated} edges in ${Date.now() - startTime}ms (${functionsToAnalyze.length} functions analyzed)\n`);
    return { edgesCreated };
  }

  /**
   * Resolve unresolved edge targets (like inheritance/implementation edges
   * where targetId is a name, not a node ID).
   */
  resolveSymbolicEdges(): { resolved: number } {
    let resolved = 0;
    const allEdges = this.graph.getAllEdges();
    
    for (const edge of allEdges) {
      // Check if targetId looks like a symbol name (not a hash)
      if (edge.targetId.length <= 20 && /^[A-Z]/.test(edge.targetId)) {
        // Try to find the target node by name
        const candidates = this.graph.search(edge.targetId, 5);
        const target = candidates.find(n => 
          n.name === edge.targetId && 
          (n.type === 'class' || n.type === 'interface')
        );
        if (target) {
          // Update edge to point to resolved node ID
          this.graph.updateEdgeTarget(edge.sourceId, edge.targetId, edge.type, target.id);
          resolved++;
        }
      }
    }
    
    if (resolved > 0) {
      process.stderr.write(`[ai-mind-map] Resolved ${resolved} symbolic edges\n`);
    }
    return { resolved };
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
        dot: true,  // Allow dotfiles like .env, .eslintrc, .gitignore
        // Skip common heavy directories at glob level for performance.
        // Fine-grained ignore filtering is handled by ig.ignores() below.
        ignore: [
          '**/node_modules/**', '**/.git/**', '**/.svn/**', '**/.hg/**',
          // Python
          '**/__pycache__/**', '**/site-packages/**', '**/venv/**',
          '**/.venv/**', '**/env/**',
          '**/standalone-env/**', '**/python_embeded/**', '**/python_embedded/**',
          '**/.tox/**', '**/.mypy_cache/**', '**/.pytest_cache/**',
          // Build output
          '**/dist/**', '**/build/**', '**/out/**', '**/output/**',
          '**/.next/**', '**/.nuxt/**', '**/.cache/**',
          '**/coverage/**', '**/.nyc_output/**',
          // IDE
          '**/.idea/**', '**/.vscode/**', '**/.vs/**',
          // Other runtimes
          '**/vendor/**', '**/target/**', '**/bin/**', '**/obj/**',
          '**/.gradle/**', '**/.dart_tool/**', '**/.pub-cache/**',
          '**/Pods/**', '**/.gemini/**', '**/.cursor/**',
          // Models / weights (AI projects)
          '**/models/**', '**/checkpoints/**', '**/weights/**',
          // Logs / temp
          '**/logs/**', '**/tmp/**', '**/temp/**',
          // Electron / desktop app runtimes
          '**/.launcher/**', '**/electron/**',
        ],
      });
      allFiles.push(...matches);
    }

    // ── Extensionless files (Dockerfile, Makefile, etc.) ──
    const extensionlessFiles = ['Dockerfile', 'Makefile', 'Jenkinsfile', 'Vagrantfile', 'Procfile'];
    for (const name of extensionlessFiles) {
      try {
        const matches = await glob(`**/${name}`, {
          cwd: this.config.projectRoot,
          absolute: true,
          nodir: true,
          dot: false,
          ignore: [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
            '**/vendor/**', '**/target/**',
          ],
        });
        allFiles.push(...matches);
      } catch { /* ignore glob errors */ }
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
    const release = await this.acquireIndexLock();
    try {
    // Pause watcher to prevent races during full reindex
    this.watcher?.pause();

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

    // -- Incremental path: if we have existing index data AND graph has nodes, only reparse changed files --
    const existingCount = this.graph.getFileIndexCount();
    const nodeCount = this.graph.getStats().totalNodes;
    if (existingCount > 0 && nodeCount > 0) {
      const staleFiles: string[] = [];
      const currentFileSet = new Set(files);

      for (const file of files) {
        const cached = this.graph.getFileIndexEntry(file);
        if (cached) {
          try {
            const fileStat = statSync(file);
            if (Math.abs(cached.mtime_ms - fileStat.mtimeMs) < 1 && cached.size_bytes === fileStat.size) {
              continue; // Unchanged - skip
            }
          } catch {
            // File stat failed, reparse it
          }
        }
        staleFiles.push(file);
      }

      // Remove deleted files from graph
      const indexedFiles = this.graph.getIndexedFiles();
      let filesDeleted = 0;
      for (const indexed of indexedFiles) {
        if (!currentFileSet.has(indexed)) {
          this.graph.deleteFileNodes(indexed);
          this.graph.removeFileIndex(indexed);
          filesDeleted++;
        }
      }

      if (staleFiles.length === 0) {
        stats.filesDeleted = filesDeleted;
        stats.durationMs = Date.now() - startTime;
        onProgress?.({
          phase: 'complete',
          current: 0,
          total: files.length,
          message: `No files changed since last index. ${filesDeleted} deleted.`,
        });
        return stats;
      }

      // Parse only stale files
      onProgress?.({
        phase: 'parsing',
        current: 0,
        total: staleFiles.length,
        message: `Incremental: parsing ${staleFiles.length} changed files...`,
      });
      const parseResults = await parseFiles(staleFiles, 16);

      // Use batchReplaceFileData WITHOUT skipDelete (files have existing data)
      const batchItems: Array<{filePath: string, nodes: GraphNode[], edges: GraphEdge[], mtimeMs?: number, sizeBytes?: number, contentHash?: string}> = [];
      let nodesCreated = 0, edgesCreated = 0, parseErrors = 0;
      const languages: Record<string, number> = {};

      for (const result of parseResults) {
        if (result.nodes.length === 0 && result.parseErrors.length > 0) {
          parseErrors += result.parseErrors.length;
          continue;
        }
        nodesCreated += result.nodes.length;
        edgesCreated += result.edges.length;
        if (result.language !== 'unknown') {
          languages[result.language] = (languages[result.language] ?? 0) + 1;
        }
        if (result.parseErrors.length > 0) parseErrors += result.parseErrors.length;

        let mtimeMs: number | undefined;
        let sizeBytes: number | undefined;
        let contentHash: string | undefined;
        try {
          const fileStat = statSync(result.filePath);
          mtimeMs = fileStat.mtimeMs;
          sizeBytes = fileStat.size;
          contentHash = result.nodes.find(n => n.type === 'file')?.hash ?? '';
        } catch {
          // File may have been deleted between parse and store
        }

        batchItems.push({ filePath: result.filePath, nodes: result.nodes, edges: result.edges, mtimeMs, sizeBytes, contentHash });
      }

      if (batchItems.length > 0) {
        this.graph.batchReplaceFileData(batchItems, false); // NOT skipDelete - files have existing data
      }

      // Index changed file contents for FTS5 search
      try {
        const contentItems: Array<{ filePath: string; content: string }> = [];
        for (const result of parseResults) {
          if (result.sourceContent) {
            const content = result.sourceContent;
            contentItems.push({ 
              filePath: result.filePath, 
              content: content.length > 102400 ? content.substring(0, 102400) : content 
            });
          }
        }
        if (contentItems.length > 0) {
          this.graph.batchIndexContents(contentItems, false); // NOT skipDelete for incremental
        }
      } catch { /* Non-fatal */ }

      // Free cached source content to reduce memory pressure
      for (const result of parseResults) {
        result.sourceContent = undefined;
      }

      stats.filesScanned = files.length;
      stats.filesParsed = batchItems.length;
      stats.filesSkipped = files.length - staleFiles.length;
      stats.filesDeleted = filesDeleted;
      stats.nodesCreated = nodesCreated;
      stats.edgesCreated = edgesCreated;
      stats.parseErrors = parseErrors;
      stats.durationMs = Date.now() - startTime;
      stats.languages = languages;

      onProgress?.({
        phase: 'complete',
        current: batchItems.length,
        total: files.length,
        message: `Incremental: ${staleFiles.length} changed files reparsed, ${files.length - staleFiles.length} skipped in ${stats.durationMs}ms`,
      });

      return stats;
    }

    // ── Full reindex path (no existing data) ──

    // Clear only nodes belonging to THIS project (preserve other projects)
    this.graph.clearProject(this.config.projectRoot);

    // Enter bulk mode: drop indexes/triggers for maximum insert speed
    this.graph.enterBulkMode();
    // Collect content items for FTS indexing (populated inside try, used after finally)
    let contentItems: Array<{ filePath: string; content: string }> = [];
    try {

    // Phase 2: Parsing
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total: files.length,
      message: `Parsing ${files.length} files...`,
    });

    const parseStart = Date.now();
    const parseResults = await parseFiles(files, 16, (current, total) => {
      onProgress?.({
        phase: 'parsing',
        current,
        total,
        currentFile: files[Math.min(current, files.length - 1)],
        message: `Parsed ${current}/${total} files`,
      });
    });
    process.stderr.write(`[ai-mind-map] Parse phase: ${Date.now() - parseStart}ms (${files.length} files)\n`);

    // Memory pressure check before entering the store phase
    {
      const heapStats = v8.getHeapStatistics();
      if (heapStats.used_heap_size / heapStats.heap_size_limit > MEMORY_PRESSURE_THRESHOLD) {
        process.stderr.write(
          `Memory pressure before store phase. Stopping early.\n`
        );
        stats.durationMs = Date.now() - startTime;
        return stats;
      }
    }

    // Phase 3: Collect all valid results, then store in ONE transaction
    const batchItems: Array<{filePath: string, nodes: GraphNode[], edges: GraphEdge[], mtimeMs?: number, sizeBytes?: number, contentHash?: string}> = [];

    for (const result of parseResults) {
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

      // Get file stat synchronously (file is hot in OS cache from parsing)
      let mtimeMs: number | undefined;
      let sizeBytes: number | undefined;
      let contentHash: string | undefined;
      try {
        const fileStat = statSync(result.filePath);
        mtimeMs = fileStat.mtimeMs;
        sizeBytes = fileStat.size;
        contentHash = result.nodes.find(n => n.type === 'file')?.hash ?? '';
      } catch {
        // File may have been deleted between parse and store
      }

      batchItems.push({ filePath: result.filePath, nodes: result.nodes, edges: result.edges, mtimeMs, sizeBytes, contentHash });
    }

    // Store ALL files in ONE transaction (plain INSERT — no conflict checks needed after clearProject)
    onProgress?.({
      phase: 'storing',
      current: 0,
      total: batchItems.length,
      message: `Storing ${batchItems.length} files in database...`,
    });
    const storeStart = Date.now();
    this.graph.batchInsertFileData(batchItems);
    process.stderr.write(`[ai-mind-map] Store phase: ${Date.now() - storeStart}ms (${batchItems.length} files, ${stats.nodesCreated} nodes, ${stats.edgesCreated} edges)\n`);

    // Free cached source content to reduce memory pressure
    // (but keep sourceContent references for FTS indexing below — copy references first)
    contentItems = [];
    for (const result of parseResults) {
      if (result.sourceContent) {
        const content = result.sourceContent;
        contentItems.push({ 
          filePath: result.filePath, 
          content: content.length > 51200 ? content.substring(0, 51200) : content 
        });
      }
    }

    // Free cached source content to reduce memory pressure
    for (const result of parseResults) {
      result.sourceContent = undefined;
    }

    } finally {
      // Exit bulk mode: rebuild indexes/FTS triggers regardless of success/failure
      const rebuildStart = Date.now();
      this.graph.exitBulkMode();
      process.stderr.write(`[ai-mind-map] Index rebuild: ${Date.now() - rebuildStart}ms\n`);
    }

    // Content FTS happens AFTER bulk mode exit (separate transactions)
    // FTS5 has its own inverted index — doesn't benefit from dropped regular indexes
    const ftsStart = Date.now();
    try {
      // Batch in chunks of 50 to limit transaction size
      for (let i = 0; i < contentItems.length; i += 50) {
        const chunk = contentItems.slice(i, i + 50);
        this.graph.batchIndexContents(chunk, true);
      }
    } catch (err) {
      // Non-fatal: content FTS is an optimization, not critical
      console.error(`[ai-mind-map] Content FTS indexing failed: ${err}`);
    }
    process.stderr.write(`[ai-mind-map] Content FTS: ${Date.now() - ftsStart}ms (${contentItems.length} files)\n`);

    // Skip cleanOrphanedEdges after full reindex — no orphans possible when we just rebuilt everything
    // try {
    //   this.graph.cleanOrphanedEdges();
    // } catch {
    //   // Non-critical cleanup
    // }

    // Phase 4: Cross-file reference analysis
    onProgress?.({
      phase: 'storing',
      current: stats.filesParsed,
      total: stats.filesScanned,
      message: 'Building cross-file references...',
    });
    
    // Resolve symbolic edges (inherits/implements where targetId is a class name)
    const { resolved } = this.resolveSymbolicEdges();
    
    // Build cross-file call edges
    const { edgesCreated: crossFileEdges } = this.buildCrossReferences();
    stats.edgesCreated += crossFileEdges;

    // Phase 5: Complete
    stats.durationMs = Date.now() - startTime;

    onProgress?.({
      phase: 'complete',
      current: stats.filesParsed,
      total: stats.filesScanned,
      message: `Indexing complete: ${stats.filesParsed} files, ${stats.nodesCreated} nodes, ${stats.edgesCreated} edges (${crossFileEdges} cross-file, ${resolved} resolved) in ${stats.durationMs}ms`,
    });

    return stats;
    } finally {
      this.watcher?.resume();
      release();
    }
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
    const release = await this.acquireIndexLock();
    try {
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
    } finally {
      release();
    }
  }

  /**
   * Index a single file (e.g., when file watcher detects a change).
   *
   * @param filePath - Absolute path to the changed file
   * @returns Parse result, or null if file was skipped
   */
  async indexFile(filePath: string): Promise<ParseResult | null> {
    const release = await this.acquireIndexLock();
    try {
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

    if (fileStat.size > this.config.maxFileSize) return null;
    if (fileStat.size === 0) return null;

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
    } finally {
      release();
    }
  }

  /**
   * Remove a file from the index (e.g., when file watcher detects deletion).
   *
   * @param filePath - Absolute path to the deleted file
   * @returns Number of nodes removed
   */
  async removeFile(filePath: string): Promise<number> {
    const release = await this.acquireIndexLock();
    try {
      this.graph.removeFileIndex(filePath);
      return this.graph.deleteFileNodes(filePath);
    } finally {
      release();
    }
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
          const content = await readFile(f, 'utf-8');
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
