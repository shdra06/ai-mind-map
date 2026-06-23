/**
 * AI Mind Map — Project Snapshot & Change Delta
 *
 * THE core token-saving engine. This module generates:
 *
 * 1. **Project Snapshot**: A compressed, single-string representation of the
 *    ENTIRE project that fits in ~1500-3000 tokens instead of 50,000+.
 *    Contains: file tree, key symbols per file, architecture layers,
 *    dependency graph summary, and entry points.
 *
 * 2. **Change Delta**: Only what changed since the AI last looked.
 *    Instead of re-reading the whole project, the AI gets a compact
 *    "here's what's different since last time" summary.
 *
 * 3. **Session Preamble**: A ready-to-inject context block that gives the
 *    AI everything it needs to start working on any task.
 *
 * Token savings: ~90% reduction in context needed for codebase understanding.
 *
 * @module knowledge-graph/snapshot
 */

import { relative, extname, dirname, basename } from 'node:path';
import { KnowledgeGraph } from './graph.js';
import { DiffEngine } from '../change-tracker/diff-engine.js';
import type { GraphNode, MindMapConfig } from '../types.js';

// ============================================================
// Types
// ============================================================

/** Compressed file entry in the snapshot */
interface SnapshotFile {
  /** Relative path */
  path: string;
  /** Architecture layer */
  layer: string;
  /** Exported symbols (compact: "fn:name, cls:Name, type:Name") */
  symbols: string;
  /** Lines of code */
  lines: number;
}

/** The full project snapshot */
export interface ProjectSnapshot {
  /** Project name */
  name: string;
  /** When this snapshot was generated */
  generatedAt: number;
  /** Quick stats */
  stats: {
    totalFiles: number;
    totalSymbols: number;
    totalLines: number;
    languages: Record<string, number>;
  };
  /** Compact file tree with symbols (the core map) */
  fileMap: string;
  /** Architecture layer breakdown */
  layers: string;
  /** Key entry points (routes, exports, main files) */
  entryPoints: string[];
  /** Dependency summary (most connected symbols) */
  hotspots: Array<{ name: string; file: string; connections: number }>;
  /** Token cost of this snapshot vs reading all files */
  tokenCost: { snapshot: number; fullRead: number; saved: number; savingsPercent: number };
}

/** Change delta — what happened since a timestamp */
export interface ChangeDelta {
  /** What time period this covers */
  since: string;
  /** Compact summary of changes */
  summary: string;
  /** Files changed with what symbols were affected */
  changes: Array<{
    file: string;
    action: 'added' | 'modified' | 'deleted' | 'renamed';
    symbolsChanged: string[];
    linesAdded: number;
    linesRemoved: number;
  }>;
  /** New symbols that were added */
  newSymbols: string[];
  /** Symbols that were removed */
  removedSymbols: string[];
  /** Files that need attention (high change volume) */
  hotFiles: string[];
}

/** Session preamble — everything the AI needs to start */
export interface SessionPreamble {
  /** The compact project map */
  projectMap: string;
  /** What changed since last session */
  changeDelta: string;
  /** Relevant memories */
  memories: string;
  /** Total token cost */
  tokenCost: number;
}

// ============================================================
// Snapshot Generator
// ============================================================

export class SnapshotEngine {
  private readonly graph: KnowledgeGraph;
  private readonly diffEngine: DiffEngine;
  private readonly projectRoot: string;
  private readonly projectName: string;

  /** Cache the last snapshot to detect changes */
  private lastSnapshotTime: number = 0;
  private cachedSnapshot: ProjectSnapshot | null = null;

  constructor(graph: KnowledgeGraph, config: MindMapConfig) {
    this.graph = graph;
    this.diffEngine = new DiffEngine(config.projectRoot);
    this.projectRoot = config.projectRoot;
    this.projectName = basename(config.projectRoot);
  }

  // ── Project Snapshot ──────────────────────────────────────

  /**
   * Generate a compact snapshot of the entire project.
   * This is the #1 token saver — replaces reading all files.
   */
  generateSnapshot(): ProjectSnapshot {
    const overview = this.graph.getProjectOverview();
    const stats = this.graph.getStats();
    const allNodeIds = this.graph.getAllNodeIds();

    // Build compact file map
    const fileEntries: SnapshotFile[] = [];
    let totalLines = 0;

    for (const [filePath, symbols] of overview) {
      const relPath = relative(this.projectRoot, filePath);
      const layer = this.inferLayer(relPath);

      // Compact symbol representation
      const compactSymbols = symbols
        .filter(s => s.type !== 'file')
        .map(s => this.compactSymbol(s))
        .join(', ');

      // Estimate lines from the last symbol's end line
      const maxLine = symbols.reduce((max, s) => Math.max(max, s.endLine || 0), 0);
      totalLines += maxLine;

      fileEntries.push({
        path: relPath,
        layer,
        symbols: compactSymbols,
        lines: maxLine,
      });
    }

    // Generate the file map string (the core output)
    const fileMap = this.buildFileMap(fileEntries);

    // Generate layer breakdown
    const layers = this.buildLayerSummary(fileEntries);

    // Find entry points
    const entryPoints = this.findEntryPoints(fileEntries, overview);

    // Find hotspots (most-connected symbols)
    const hotspots = this.findHotspots(allNodeIds);

    // Calculate token costs
    const snapshotText = fileMap + layers;
    const snapshotTokens = Math.ceil(snapshotText.length / 4);
    const estimatedFullRead = totalLines * 2; // ~2 tokens per line of code
    const saved = estimatedFullRead - snapshotTokens;

    const snapshot: ProjectSnapshot = {
      name: this.projectName,
      generatedAt: Date.now(),
      stats: {
        totalFiles: stats.totalFiles,
        totalSymbols: stats.totalNodes - stats.totalFiles,
        totalLines,
        languages: stats.languageBreakdown,
      },
      fileMap,
      layers,
      entryPoints,
      hotspots,
      tokenCost: {
        snapshot: snapshotTokens,
        fullRead: estimatedFullRead,
        saved: Math.max(0, saved),
        savingsPercent: estimatedFullRead > 0
          ? Math.round((saved / estimatedFullRead) * 100)
          : 0,
      },
    };

    this.cachedSnapshot = snapshot;
    this.lastSnapshotTime = Date.now();
    return snapshot;
  }

  // ── Change Delta ──────────────────────────────────────────

  /**
   * Generate a change delta since a timestamp.
   * This is what the AI reads at session start instead of re-reading everything.
   */
  async generateChangeDelta(
    sinceTimestamp: number,
    sinceLabel: string = 'last session',
  ): Promise<ChangeDelta> {
    const diffSummary = await this.diffEngine.getChangesSinceTimestamp(
      sinceTimestamp,
      'delta-session',
    );

    // Build compact change list
    const changes = diffSummary.changes.map(c => {
      const relPath = relative(this.projectRoot, c.filePath);

      // Get symbols in the changed file
      const fileNodes = this.graph.getFileStructure(c.filePath);
      const symbolNames = fileNodes
        .filter(n => n.type !== 'file')
        .map(n => n.name);

      return {
        file: relPath,
        action: c.changeType as 'added' | 'modified' | 'deleted' | 'renamed',
        symbolsChanged: symbolNames,
        linesAdded: c.linesAdded,
        linesRemoved: c.linesRemoved,
      };
    });

    // Detect new/removed symbols (compare with cached snapshot if available)
    const newSymbols: string[] = [];
    const removedSymbols: string[] = [];
    // For now, list symbols in newly created files
    for (const c of changes) {
      if (c.action === 'added') {
        newSymbols.push(...c.symbolsChanged.map(s => `${s} (${c.file})`));
      } else if (c.action === 'deleted') {
        removedSymbols.push(...c.symbolsChanged.map(s => `${s} (${c.file})`));
      }
    }

    // Find hot files (most changed)
    const hotFiles = changes
      .filter(c => c.linesAdded + c.linesRemoved > 20)
      .sort((a, b) => (b.linesAdded + b.linesRemoved) - (a.linesAdded + a.linesRemoved))
      .map(c => `${c.file} (+${c.linesAdded}/-${c.linesRemoved})`)
      .slice(0, 5);

    // Build compact summary
    const summaryParts: string[] = [];
    if (changes.length === 0) {
      summaryParts.push('No changes detected.');
    } else {
      const added = changes.filter(c => c.action === 'added').length;
      const modified = changes.filter(c => c.action === 'modified').length;
      const deleted = changes.filter(c => c.action === 'deleted').length;
      const totalAdded = changes.reduce((s, c) => s + c.linesAdded, 0);
      const totalRemoved = changes.reduce((s, c) => s + c.linesRemoved, 0);

      if (added > 0) summaryParts.push(`${added} new file(s)`);
      if (modified > 0) summaryParts.push(`${modified} modified`);
      if (deleted > 0) summaryParts.push(`${deleted} deleted`);
      summaryParts.push(`(+${totalAdded}/-${totalRemoved} lines)`);
    }

    return {
      since: sinceLabel,
      summary: summaryParts.join(', '),
      changes,
      newSymbols,
      removedSymbols,
      hotFiles,
    };
  }

  // ── Session Preamble ──────────────────────────────────────

  /**
   * Generate the complete session preamble — everything the AI needs
   * at the start of a conversation, in minimum tokens.
   */
  async generatePreamble(
    lastSessionTimestamp?: number,
    memories?: string[],
  ): Promise<SessionPreamble> {
    // 1. Project map
    const snapshot = this.generateSnapshot();
    const projectMap = this.formatProjectMap(snapshot);

    // 2. Change delta (since last session, default 4h ago)
    const since = lastSessionTimestamp ?? Date.now() - 4 * 60 * 60 * 1000;
    const delta = await this.generateChangeDelta(since);
    const changeDelta = this.formatChangeDelta(delta);

    // 3. Memories
    const memoryText = memories && memories.length > 0
      ? `\n📝 MEMORIES:\n${memories.map(m => `  • ${m}`).join('\n')}`
      : '';

    const fullText = projectMap + '\n' + changeDelta + memoryText;
    const tokenCost = Math.ceil(fullText.length / 4);

    return {
      projectMap,
      changeDelta,
      memories: memoryText,
      tokenCost,
    };
  }

  // ── Private: File Map Builder ─────────────────────────────

  private buildFileMap(entries: SnapshotFile[]): string {
    // Group by directory
    const dirGroups = new Map<string, SnapshotFile[]>();
    for (const entry of entries) {
      const dir = dirname(entry.path) || '.';
      if (!dirGroups.has(dir)) dirGroups.set(dir, []);
      dirGroups.get(dir)!.push(entry);
    }

    const lines: string[] = [`📁 PROJECT MAP: ${this.projectName}`];
    lines.push(`   ${entries.length} files, ${entries.reduce((s, e) => s + e.lines, 0)} lines\n`);

    // Sort directories for consistent output
    const sortedDirs = [...dirGroups.keys()].sort();

    for (const dir of sortedDirs) {
      const files = dirGroups.get(dir)!;
      lines.push(`📂 ${dir}/`);

      for (const file of files) {
        const name = basename(file.path);
        const layerTag = file.layer !== 'unknown' ? ` [${file.layer}]` : '';

        if (file.symbols) {
          lines.push(`  📄 ${name}${layerTag}: ${file.symbols}`);
        } else {
          lines.push(`  📄 ${name}${layerTag}`);
        }
      }
      lines.push(''); // blank line between dirs
    }

    return lines.join('\n');
  }

  private buildLayerSummary(entries: SnapshotFile[]): string {
    const layers = new Map<string, number>();
    for (const entry of entries) {
      layers.set(entry.layer, (layers.get(entry.layer) ?? 0) + 1);
    }

    if (layers.size <= 1) return '';

    const lines: string[] = ['\n🏗️ ARCHITECTURE LAYERS:'];
    const sorted = [...layers.entries()].sort((a, b) => b[1] - a[1]);
    for (const [layer, count] of sorted) {
      const bar = '█'.repeat(Math.min(count, 15));
      lines.push(`  ${layer.padEnd(14)} ${String(count).padStart(3)} files ${bar}`);
    }

    return lines.join('\n');
  }

  private findEntryPoints(
    entries: SnapshotFile[],
    overview: Map<string, GraphNode[]>,
  ): string[] {
    const entryPoints: string[] = [];

    for (const [filePath, symbols] of overview) {
      const relPath = relative(this.projectRoot, filePath);
      const name = basename(relPath);

      // Main/index files
      if (/^(index|main|app|server)\.(ts|js|py|go|rs)$/i.test(name)) {
        entryPoints.push(`📌 ${relPath} (entry point)`);
      }

      // Route definitions
      for (const sym of symbols) {
        if (sym.type === 'route') {
          entryPoints.push(`🛣️ ${sym.name} → ${relPath}`);
        }
      }
    }

    return entryPoints.slice(0, 20);
  }

  private findHotspots(allNodeIds: string[]): Array<{ name: string; file: string; connections: number }> {
    const connectionCounts: Array<{ name: string; file: string; connections: number }> = [];

    // Sample nodes (checking ALL nodes could be slow for large projects)
    const sampleSize = Math.min(allNodeIds.length, 200);
    const sampled = allNodeIds.slice(0, sampleSize);

    for (const id of sampled) {
      const node = this.graph.getNode(id);
      if (!node || node.type === 'file') continue;

      const inEdges = this.graph.getInEdges(id);
      const outEdges = this.graph.getOutEdges(id);
      const total = inEdges.length + outEdges.length;

      if (total >= 3) {
        connectionCounts.push({
          name: node.name,
          file: relative(this.projectRoot, node.filePath),
          connections: total,
        });
      }
    }

    return connectionCounts
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 10);
  }

  // ── Private: Formatting ───────────────────────────────────

  private formatProjectMap(snapshot: ProjectSnapshot): string {
    const parts: string[] = [];

    parts.push(snapshot.fileMap);
    parts.push(snapshot.layers);

    if (snapshot.entryPoints.length > 0) {
      parts.push('\n🎯 ENTRY POINTS:');
      parts.push(snapshot.entryPoints.map(e => `  ${e}`).join('\n'));
    }

    if (snapshot.hotspots.length > 0) {
      parts.push('\n🔥 HOTSPOTS (most-connected symbols):');
      parts.push(
        snapshot.hotspots
          .map(h => `  ${h.name} (${h.file}) — ${h.connections} connections`)
          .join('\n'),
      );
    }

    parts.push(`\n💰 TOKEN SAVINGS: This map costs ~${snapshot.tokenCost.snapshot} tokens vs ~${snapshot.tokenCost.fullRead} for full read (${snapshot.tokenCost.savingsPercent}% saved)`);

    return parts.join('\n');
  }

  private formatChangeDelta(delta: ChangeDelta): string {
    if (delta.changes.length === 0) {
      return `\n🔄 CHANGES SINCE ${delta.since.toUpperCase()}: None`;
    }

    const parts: string[] = [];
    parts.push(`\n🔄 CHANGES SINCE ${delta.since.toUpperCase()}: ${delta.summary}`);

    for (const change of delta.changes.slice(0, 15)) {
      const icon = { added: '🟢', modified: '🟡', deleted: '🔴', renamed: '🔵' }[change.action] ?? '⚪';
      const symbols = change.symbolsChanged.length > 0
        ? ` — affects: ${change.symbolsChanged.slice(0, 5).join(', ')}${change.symbolsChanged.length > 5 ? '...' : ''}`
        : '';
      parts.push(`  ${icon} ${change.file} (+${change.linesAdded}/-${change.linesRemoved})${symbols}`);
    }

    if (delta.changes.length > 15) {
      parts.push(`  ... and ${delta.changes.length - 15} more files`);
    }

    if (delta.hotFiles.length > 0) {
      parts.push(`\n  ⚠️ Most changed: ${delta.hotFiles.join(', ')}`);
    }

    return parts.join('\n');
  }

  // ── Private: Classification ───────────────────────────────

  private inferLayer(relPath: string): string {
    const lower = relPath.toLowerCase();
    if (/component|view|page|screen|widget|ui/i.test(lower)) return 'ui';
    if (/route|router|endpoint/i.test(lower)) return 'route';
    if (/controller|handler/i.test(lower)) return 'controller';
    if (/service|business|logic|use.?case/i.test(lower)) return 'service';
    if (/repo|repository|dao|data.?access|store/i.test(lower)) return 'data';
    if (/model|entity|schema|dto/i.test(lower)) return 'model';
    if (/middleware|guard|interceptor|filter/i.test(lower)) return 'middleware';
    if (/test|spec|__test__|\.test\.|\.spec\./i.test(lower)) return 'test';
    if (/util|helper|lib|common|shared/i.test(lower)) return 'util';
    if (/config|env|setting/i.test(lower)) return 'config';
    if (/tool|mcp|plugin/i.test(lower)) return 'tool';
    if (/types?\.ts$|interface|types?\//i.test(lower)) return 'types';
    return 'unknown';
  }

  private compactSymbol(node: GraphNode): string {
    const prefixes: Record<string, string> = {
      function: 'fn',
      method: 'fn',
      class: 'cls',
      interface: 'ifc',
      type_alias: 'type',
      enum: 'enum',
      variable: 'var',
      constant: 'const',
      component: 'comp',
      hook: 'hook',
      route: 'route',
      test: 'test',
      constructor: 'ctor',
    };

    const prefix = prefixes[node.type] ?? node.type;

    // For functions, include parameter count
    if (node.type === 'function' || node.type === 'method') {
      const paramCount = node.parameters?.length ?? 0;
      return `${prefix}:${node.name}(${paramCount})`;
    }

    return `${prefix}:${node.name}`;
  }
}
