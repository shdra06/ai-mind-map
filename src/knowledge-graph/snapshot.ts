/**
 * AI Mind Map — Project Snapshot & Change Delta
 *
 * THE core token-saving engine. Generates:
 *
 * 1. **Project Snapshot**: Compact project map in ~1500-3000 tokens
 * 2. **Change Delta**: Only what changed since last session
 * 3. **Session Preamble**: Map + delta + memories in one call
 *
 * Design choices informed by industry research:
 * - Aider's PageRank: we rank hotspots by connection count
 * - Repomix's structural stripping: signatures only, no bodies
 * - Cursor's incremental: we cache snapshots, only recompute on changes
 * - Claude Code's compaction: compact JSON, zero formatting waste
 *
 * @module knowledge-graph/snapshot
 */

import { relative, dirname, basename } from 'node:path';
import { KnowledgeGraph } from './graph.js';
import { DiffEngine } from '../change-tracker/diff-engine.js';
import type { GraphNode, MindMapConfig } from '../types.js';

// ============================================================
// Types
// ============================================================

interface SnapshotFile {
  path: string;
  layer: string;
  /** Compact symbols: "fn:create(3), cls:Note{fn:save,fn:delete}, type:Config" */
  symbols: string;
  lines: number;
}

export interface ProjectSnapshot {
  name: string;
  generatedAt: number;
  stats: {
    totalFiles: number;
    totalSymbols: number;
    totalLines: number;
    languages: Record<string, number>;
  };
  fileMap: string;
  layers: string;
  entryPoints: string[];
  hotspots: Array<{ name: string; file: string; connections: number }>;
  tokenCost: { snapshot: number; fullRead: number; saved: number; savingsPercent: number };
}

export interface ChangeDelta {
  since: string;
  summary: string;
  changes: Array<{
    file: string;
    action: 'added' | 'modified' | 'deleted' | 'renamed';
    symbolsChanged: string[];
    linesAdded: number;
    linesRemoved: number;
  }>;
  newSymbols: string[];
  removedSymbols: string[];
  hotFiles: string[];
}

export interface SessionPreamble {
  projectMap: string;
  changeDelta: string;
  memories: string;
  tokenCost: number;
}

// ============================================================
// Snapshot Engine
// ============================================================

export class SnapshotEngine {
  private readonly graph: KnowledgeGraph;
  private readonly diffEngine: DiffEngine;
  private readonly projectRoot: string;
  private readonly projectName: string;

  /** Actual working cache — invalidated when graph stats change */
  private cache: { snapshot: ProjectSnapshot; statsHash: string } | null = null;

  constructor(graph: KnowledgeGraph, config: MindMapConfig) {
    this.graph = graph;
    this.diffEngine = new DiffEngine(config.projectRoot);
    this.projectRoot = config.projectRoot;
    this.projectName = basename(config.projectRoot);
  }

  // ── Project Snapshot ──────────────────────────────────────

  generateSnapshot(): ProjectSnapshot {
    // Use cache if graph hasn't changed
    const stats = this.graph.getStats();
    const statsHash = `${stats.totalNodes}:${stats.totalEdges}`;
    if (this.cache && this.cache.statsHash === statsHash) {
      return this.cache.snapshot;
    }

    const overview = this.graph.getProjectOverview();

    // Build compact file map with NESTED class members visible
    const fileEntries: SnapshotFile[] = [];
    let totalLines = 0;

    for (const [filePath, symbols] of overview) {
      const relPath = relative(this.projectRoot, filePath);
      const layer = this.inferLayer(relPath);

      // Group symbols: top-level separately, nest class members inside class
      const compactSymbols = this.buildCompactSymbolList(symbols);

      // Actual line count from file node or max endLine
      const maxLine = Math.max(
        ...symbols.map(s => s.endLine || 0),
        1,
      );
      totalLines += maxLine;

      if (compactSymbols) {
        fileEntries.push({ path: relPath, layer, symbols: compactSymbols, lines: maxLine });
      }
    }

    const fileMap = this.buildFileMap(fileEntries);
    const layers = this.buildLayerSummary(fileEntries);
    const entryPoints = this.findEntryPoints(overview);

    // Hotspots: use ALL edges via single SQL query instead of sampling
    const hotspots = this.findHotspotsEfficient();

    const snapshotText = fileMap + layers;
    const snapshotTokens = Math.ceil(snapshotText.length / 4);
    const estimatedFullRead = Math.max(totalLines * 2, 1);
    const saved = Math.max(0, estimatedFullRead - snapshotTokens);

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
        saved,
        savingsPercent: estimatedFullRead > 0 ? Math.round((saved / estimatedFullRead) * 100) : 0,
      },
    };

    // Actually cache it
    this.cache = { snapshot, statsHash };
    return snapshot;
  }

  // ── Change Delta ──────────────────────────────────────────

  async generateChangeDelta(
    sinceTimestamp: number,
    sinceLabel: string = 'last session',
  ): Promise<ChangeDelta> {
    const diffSummary = await this.diffEngine.getChangesSinceTimestamp(
      sinceTimestamp,
      'delta-session',
    );

    // For symbol-level change detection, compare current symbols against
    // what git shows was in the file before. This is the key improvement
    // over just listing ALL symbols in a changed file.
    const changes = await Promise.all(diffSummary.changes.map(async c => {
      const relPath = relative(this.projectRoot, c.filePath);

      let symbolsChanged: string[] = [];

      if (c.changeType === 'modified') {
        // Get CURRENT symbols in the file
        const currentNodes = this.graph.getFileStructure(c.filePath);
        const currentSymbols = new Set(
          currentNodes.filter(n => n.type !== 'file').map(n => n.name),
        );

        // Get symbols that WERE in the file before (from git)
        try {
          const oldContent = await this.diffEngine.getFileAtRevision(relPath, 'HEAD~1');
          if (oldContent.found) {
            const oldSymbolNames = this.extractSymbolNamesFromSource(oldContent.content);
            // Changed = added OR removed symbols
            const added = [...currentSymbols].filter(s => !oldSymbolNames.has(s));
            const removed = [...oldSymbolNames].filter(s => !currentSymbols.has(s));
            symbolsChanged = [
              ...added.map(s => `+${s}`),
              ...removed.map(s => `-${s}`),
            ];
            // If no symbols added/removed but file changed, mark as "modified body"
            if (symbolsChanged.length === 0 && (c.linesAdded > 0 || c.linesRemoved > 0)) {
              // Use line-range heuristic: which symbols span the changed lines?
              symbolsChanged = this.inferAffectedSymbols(currentNodes, c.linesAdded + c.linesRemoved);
            }
          }
        } catch {
          // Fall back to listing key symbols (top 5 only, not ALL)
          symbolsChanged = currentNodes
            .filter(n => n.type === 'function' || n.type === 'method' || n.type === 'class')
            .slice(0, 5)
            .map(n => n.name);
        }
      } else if (c.changeType === 'created') {
        const currentNodes = this.graph.getFileStructure(c.filePath);
        symbolsChanged = currentNodes
          .filter(n => n.type !== 'file')
          .map(n => `+${n.name}`);
      }

      return {
        file: relPath,
        action: c.changeType as 'added' | 'modified' | 'deleted' | 'renamed',
        symbolsChanged,
        linesAdded: c.linesAdded,
        linesRemoved: c.linesRemoved,
      };
    }));

    // Detect new/removed symbols across all changes
    const newSymbols = changes
      .flatMap(c => c.symbolsChanged.filter(s => s.startsWith('+')).map(s => `${s.slice(1)} (${c.file})`));
    const removedSymbols = changes
      .flatMap(c => c.symbolsChanged.filter(s => s.startsWith('-')).map(s => `${s.slice(1)} (${c.file})`));

    // Hot files
    const hotFiles = changes
      .filter(c => c.linesAdded + c.linesRemoved > 20)
      .sort((a, b) => (b.linesAdded + b.linesRemoved) - (a.linesAdded + a.linesRemoved))
      .map(c => `${c.file} (+${c.linesAdded}/-${c.linesRemoved})`)
      .slice(0, 5);

    // Compact summary
    const summaryParts: string[] = [];
    if (changes.length === 0) {
      summaryParts.push('No changes.');
    } else {
      const added = changes.filter(c => c.action === 'added').length;
      const modified = changes.filter(c => c.action === 'modified').length;
      const deleted = changes.filter(c => c.action === 'deleted').length;
      const totalAdded = changes.reduce((s, c) => s + c.linesAdded, 0);
      const totalRemoved = changes.reduce((s, c) => s + c.linesRemoved, 0);
      if (added > 0) summaryParts.push(`${added} new`);
      if (modified > 0) summaryParts.push(`${modified} modified`);
      if (deleted > 0) summaryParts.push(`${deleted} deleted`);
      summaryParts.push(`+${totalAdded}/-${totalRemoved}`);
    }

    return { since: sinceLabel, summary: summaryParts.join(', '), changes, newSymbols, removedSymbols, hotFiles };
  }

  // ── Session Preamble ──────────────────────────────────────

  async generatePreamble(
    lastSessionTimestamp?: number,
    memories?: string[],
  ): Promise<SessionPreamble> {
    const snapshot = this.generateSnapshot();
    const projectMap = this.formatProjectMap(snapshot);

    const since = lastSessionTimestamp ?? Date.now() - 4 * 60 * 60 * 1000;
    const delta = await this.generateChangeDelta(since);
    const changeDelta = this.formatChangeDelta(delta);

    const memoryText = memories && memories.length > 0
      ? `\nMEMORIES:\n${memories.map(m => `- ${m}`).join('\n')}`
      : '';

    const fullText = projectMap + '\n' + changeDelta + memoryText;

    return {
      projectMap,
      changeDelta,
      memories: memoryText,
      tokenCost: Math.ceil(fullText.length / 4),
    };
  }

  // ── File Map (zero-waste formatting) ──────────────────────

  private buildFileMap(entries: SnapshotFile[]): string {
    // Group by directory
    const dirGroups = new Map<string, SnapshotFile[]>();
    for (const entry of entries) {
      const dir = dirname(entry.path) || '.';
      if (!dirGroups.has(dir)) dirGroups.set(dir, []);
      dirGroups.get(dir)!.push(entry);
    }

    // Zero-waste format: no emojis, no bars, pure data
    const lines: string[] = [
      `[${this.projectName}] ${entries.length} files, ${entries.reduce((s, e) => s + e.lines, 0)} lines`,
    ];

    for (const dir of [...dirGroups.keys()].sort()) {
      const files = dirGroups.get(dir)!;
      lines.push(`${dir}/`);
      for (const file of files) {
        const name = basename(file.path);
        const tag = file.layer !== 'unknown' ? `[${file.layer}] ` : '';
        lines.push(file.symbols
          ? `  ${tag}${name}: ${file.symbols}`
          : `  ${tag}${name}`);
      }
    }

    return lines.join('\n');
  }

  private buildLayerSummary(entries: SnapshotFile[]): string {
    const layers = new Map<string, number>();
    for (const entry of entries) {
      layers.set(entry.layer, (layers.get(entry.layer) ?? 0) + 1);
    }
    if (layers.size <= 1) return '';

    return '\nLAYERS: ' + [...layers.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([l, c]) => `${l}(${c})`)
      .join(' ');
  }

  private findEntryPoints(overview: Map<string, GraphNode[]>): string[] {
    const entryPoints: string[] = [];
    for (const [filePath, symbols] of overview) {
      const relPath = relative(this.projectRoot, filePath);
      const name = basename(relPath);
      if (/^(index|main|app|server)\.(ts|js|py|go|rs)$/i.test(name)) {
        entryPoints.push(relPath);
      }
      for (const sym of symbols) {
        if (sym.type === 'route') {
          entryPoints.push(`${sym.name} -> ${relPath}`);
        }
      }
    }
    return entryPoints.slice(0, 15);
  }

  /**
   * Find hotspots using ALL edges via a single aggregation query
   * instead of sampling 200 random nodes with 600+ individual queries.
   */
  private findHotspotsEfficient(): Array<{ name: string; file: string; connections: number }> {
    const allEdges = this.graph.getAllEdges();

    // Count connections per node
    const counts = new Map<string, number>();
    for (const edge of allEdges) {
      counts.set(edge.sourceId, (counts.get(edge.sourceId) ?? 0) + 1);
      counts.set(edge.targetId, (counts.get(edge.targetId) ?? 0) + 1);
    }

    // Get top 10 most connected
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const results: Array<{ name: string; file: string; connections: number }> = [];
    for (const [nodeId, connections] of sorted) {
      const node = this.graph.getNode(nodeId);
      if (node && node.type !== 'file') {
        results.push({
          name: node.name,
          file: relative(this.projectRoot, node.filePath),
          connections,
        });
      }
    }

    return results;
  }

  // ── Compact Symbol Formatting ─────────────────────────────

  /**
   * Build a compact symbol list that shows class members nested inside
   * their parent class. Format: "cls:Note{fn:save,fn:delete}, fn:helper"
   *
   * This fixes the issue where `cls:MyClass` hid all 20 methods inside it.
   */
  private buildCompactSymbolList(symbols: GraphNode[]): string {
    // Separate top-level vs nested
    const topLevel: GraphNode[] = [];
    const nested = new Map<string, GraphNode[]>(); // parentName → children

    for (const s of symbols) {
      if (s.type === 'file') continue;

      const isNested = s.qualifiedName !== s.name && s.qualifiedName.includes('.');
      if (isNested) {
        const parentName = s.qualifiedName.split('.')[0]!;
        if (!nested.has(parentName)) nested.set(parentName, []);
        nested.get(parentName)!.push(s);
      } else {
        topLevel.push(s);
      }
    }

    const parts: string[] = [];
    for (const s of topLevel) {
      const prefix = this.typePrefix(s.type);
      const children = nested.get(s.name);

      if (children && children.length > 0) {
        // Show class with its members: cls:Note{fn:save,fn:delete,fn:update}
        const memberStr = children
          .slice(0, 8) // Cap at 8 members to save tokens
          .map(c => `${this.typePrefix(c.type)}:${c.name}`)
          .join(',');
        const overflow = children.length > 8 ? `,+${children.length - 8}` : '';
        parts.push(`${prefix}:${s.name}{${memberStr}${overflow}}`);
      } else if (s.type === 'function' || s.type === 'method') {
        parts.push(`${prefix}:${s.name}(${s.parameters?.length ?? 0})`);
      } else {
        parts.push(`${prefix}:${s.name}`);
      }
    }

    return parts.join(', ');
  }

  private typePrefix(type: string): string {
    const map: Record<string, string> = {
      function: 'fn', method: 'fn', class: 'cls', interface: 'ifc',
      type_alias: 'type', enum: 'enum', variable: 'var', constant: 'const',
      component: 'comp', hook: 'hook', route: 'route', test: 'test', constructor: 'ctor',
    };
    return map[type] ?? type;
  }

  // ── Formatting (zero-waste) ───────────────────────────────

  private formatProjectMap(snapshot: ProjectSnapshot): string {
    const parts: string[] = [snapshot.fileMap, snapshot.layers];

    if (snapshot.entryPoints.length > 0) {
      parts.push('\nENTRY: ' + snapshot.entryPoints.join(', '));
    }

    if (snapshot.hotspots.length > 0) {
      parts.push('\nHOTSPOTS: ' +
        snapshot.hotspots.map(h => `${h.name}(${h.connections})`).join(', '));
    }

    return parts.join('\n');
  }

  private formatChangeDelta(delta: ChangeDelta): string {
    if (delta.changes.length === 0) {
      return `\nCHANGES(${delta.since}): none`;
    }

    const parts: string[] = [`\nCHANGES(${delta.since}): ${delta.summary}`];
    for (const c of delta.changes.slice(0, 15)) {
      const tag = { added: '+', modified: '~', deleted: '-', renamed: '>' }[c.action] ?? '?';
      const syms = c.symbolsChanged.length > 0
        ? ` [${c.symbolsChanged.slice(0, 5).join(',')}]`
        : '';
      parts.push(` ${tag} ${c.file} +${c.linesAdded}/-${c.linesRemoved}${syms}`);
    }
    if (delta.changes.length > 15) parts.push(` ...+${delta.changes.length - 15} more`);
    return parts.join('\n');
  }

  // ── Symbol extraction from raw source ─────────────────────

  /**
   * Quick regex extraction of symbol names from source code.
   * Used to compare old vs new file versions for symbol-level change detection.
   * Not as accurate as tree-sitter but fast enough for change delta.
   */
  private extractSymbolNamesFromSource(source: string): Set<string> {
    const names = new Set<string>();
    const patterns = [
      /(?:function|async function)\s+(\w+)/g,
      /(?:const|let|var)\s+(\w+)\s*=/g,
      /class\s+(\w+)/g,
      /interface\s+(\w+)/g,
      /type\s+(\w+)\s*=/g,
      /enum\s+(\w+)/g,
      /(\w+)\s*\([^)]*\)\s*{/g,  // method definitions
      /def\s+(\w+)/g,             // Python
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(source)) !== null) {
        if (m[1] && m[1].length > 1 && !/^(if|for|while|switch|catch|return)$/.test(m[1])) {
          names.add(m[1]);
        }
      }
    }
    return names;
  }

  /**
   * When symbols didn't change but lines did, pick the most likely
   * affected symbols based on which ones are largest (most likely
   * to have internal edits).
   */
  private inferAffectedSymbols(nodes: GraphNode[], changedLines: number): string[] {
    return nodes
      .filter(n => n.type === 'function' || n.type === 'method')
      .filter(n => (n.endLine ?? 0) - (n.startLine ?? 0) > 3) // Skip trivial one-liners
      .sort((a, b) => ((b.endLine ?? 0) - (b.startLine ?? 0)) - ((a.endLine ?? 0) - (a.startLine ?? 0)))
      .slice(0, 3)
      .map(n => `~${n.name}`);
  }

  // ── Layer classification ──────────────────────────────────

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
}
