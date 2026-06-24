#!/usr/bin/env node

/**
 * AI Mind Map — CLI Interface
 *
 * Full command-line interface inspired by codebase-memory-mcp's CLI mode.
 * Parses process.argv manually (no external CLI library). Each command
 * initialises only the components it needs — no full MCP server boot for
 * simple queries.
 *
 * Usage:
 *   ai-mind-map <command> [options]
 *
 * @module cli
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import Database from 'better-sqlite3';

import { loadConfig } from './config.js';
import type { MindMapConfig, NodeType, MemoryCategory } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { KnowledgeGraph } from './knowledge-graph/graph.js';
import { Indexer } from './knowledge-graph/indexer.js';
import { PersistentMemory } from './memory/persistent-memory.js';
import { DecisionLog } from './memory/decision-log.js';
import { ChangeLog } from './change-tracker/change-log.js';
import { syncSharedContext } from './memory/shared-sync.js';
import {
  installAgents,
  uninstallAgents,
  runDoctor,
} from './install.js';

// ============================================================
// ANSI Color Helpers
// ============================================================

const supportsColor = process.stdout.isTTY !== false;

/** ANSI escape codes for terminal coloring */
const c = {
  reset: supportsColor ? '\x1b[0m' : '',
  bold: supportsColor ? '\x1b[1m' : '',
  dim: supportsColor ? '\x1b[2m' : '',
  underline: supportsColor ? '\x1b[4m' : '',
  red: supportsColor ? '\x1b[31m' : '',
  green: supportsColor ? '\x1b[32m' : '',
  yellow: supportsColor ? '\x1b[33m' : '',
  blue: supportsColor ? '\x1b[34m' : '',
  magenta: supportsColor ? '\x1b[35m' : '',
  cyan: supportsColor ? '\x1b[36m' : '',
  white: supportsColor ? '\x1b[37m' : '',
  bgRed: supportsColor ? '\x1b[41m' : '',
  bgGreen: supportsColor ? '\x1b[42m' : '',
  bgBlue: supportsColor ? '\x1b[44m' : '',
  gray: supportsColor ? '\x1b[90m' : '',
};

function success(msg: string): void {
  console.log(`${c.green}${c.reset} ${msg}`);
}

function error(msg: string): void {
  console.log(`${c.red}${c.reset} ${msg}`);
}

function info(msg: string): void {
  console.log(`${c.blue}ℹ${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${c.yellow}⚠${c.reset} ${msg}`);
}

function heading(msg: string): void {
  console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`);
}

function divider(): void {
  console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
}

/** Pad a string to a fixed width */
function pad(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

/** Format a number with commas */
function formatNum(n: number): string {
  return n.toLocaleString();
}

/** Format bytes as human-readable */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format epoch timestamp as readable date */
function formatDate(epoch: number | null): string {
  if (!epoch) return 'Never';
  return new Date(epoch).toLocaleString();
}

/** Truncate a string with ellipsis */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

// ============================================================
// Package Version
// ============================================================

function getVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '1.0.0';
  }
}

// ============================================================
// Argument Parser
// ============================================================

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse process.argv into structured command, positional args, and flags.
 * Flags can be `--key value` or `--flag` (boolean).
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script path
  const command = (args[0] && !args[0].startsWith('-')) ? args[0] : '';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = command ? 1 : 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];

      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];

      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, positional, flags };
}

// ============================================================
// Component Initialisation Helpers
// ============================================================

/**
 * Load config for a given project path.
 * Resolves path and ensures DB directory exists.
 */
async function resolveConfig(projectPath?: string): Promise<MindMapConfig> {
  const root = projectPath
    ? path.resolve(projectPath)
    : process.cwd();

  const config = await loadConfig({ projectRoot: root, logLevel: 'error' });

  // Ensure DB directory exists
  const dbDir = path.dirname(config.dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  return config;
}

/** Open the knowledge graph database */
function openGraph(config: MindMapConfig): KnowledgeGraph {
  return new KnowledgeGraph(config.dbPath);
}

/** Open a shared SQLite database for memory/decisions */
function openMemoryDb(config: MindMapConfig): Database.Database {
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

// ============================================================
// Command Implementations
// ============================================================

/** ai-mind-map serve — Start MCP server (default) */
async function cmdServe(): Promise<void> {
  info('Starting AI Mind Map MCP server...');
  // Dynamic import triggers the MCP server startup as a side effect.
  // index.ts self-executes when imported (registers tools + connects transport).
  await import('./index.js');
}

/** ai-mind-map index <project-path> — Index a project */
async function cmdIndex(args: ParsedArgs): Promise<void> {
  const projectPath = args.positional[0] || process.cwd();
  heading('  Indexing Project');
  info(`Project: ${path.resolve(projectPath)}`);
  divider();

  const config = await resolveConfig(projectPath);
  const graph = openGraph(config);

  try {
    const indexer = new Indexer(graph, config);
    const startTime = Date.now();

    const stats = await indexer.fullIndex((progress) => {
      if (progress.phase === 'scanning') {
        process.stdout.write(`\r${c.dim}Scanning files...${c.reset}`);
      } else if (progress.phase === 'parsing') {
        const pct = progress.total > 0
          ? Math.round((progress.current / progress.total) * 100)
          : 0;
        process.stdout.write(
          `\r${c.dim}Parsing: ${progress.current}/${progress.total} (${pct}%)${c.reset}  `,
        );
      } else if (progress.phase === 'storing') {
        process.stdout.write(
          `\r${c.dim}Storing: ${progress.current}/${progress.total}${c.reset}  `,
        );
      } else if (progress.phase === 'complete') {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
      }
    });

    // Clear the progress line
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    heading(' Index Results');
    divider();
    console.log(`  ${pad('Files scanned:', 20)} ${c.bold}${formatNum(stats.filesScanned)}${c.reset}`);
    console.log(`  ${pad('Files parsed:', 20)} ${c.bold}${formatNum(stats.filesParsed)}${c.reset}`);
    console.log(`  ${pad('Files skipped:', 20)} ${formatNum(stats.filesSkipped)}`);
    console.log(`  ${pad('Nodes created:', 20)} ${c.green}${formatNum(stats.nodesCreated)}${c.reset}`);
    console.log(`  ${pad('Edges created:', 20)} ${c.green}${formatNum(stats.edgesCreated)}${c.reset}`);
    console.log(`  ${pad('Parse errors:', 20)} ${stats.parseErrors > 0 ? c.yellow : ''}${formatNum(stats.parseErrors)}${c.reset}`);
    console.log(`  ${pad('Duration:', 20)} ${elapsed}s`);

    if (Object.keys(stats.languages).length > 0) {
      console.log(`  ${pad('Languages:', 20)}`);
      for (const [lang, count] of Object.entries(stats.languages).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${c.cyan}${pad(lang, 16)}${c.reset} ${formatNum(count)} files`);
      }
    }

    divider();
    success(`Indexing complete in ${elapsed}s`);
  } finally {
    graph.close();
  }
}

/** ai-mind-map search <query> [--type ...] [--limit N] — Search the knowledge graph */
async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) {
    error('Usage: ai-mind-map search <query> [--type func|class|...] [--limit N]');
    process.exit(1);
  }

  const typeFilter = typeof args.flags['type'] === 'string' ? args.flags['type'] : undefined;
  const limit = typeof args.flags['limit'] === 'string' ? parseInt(args.flags['limit'], 10) : 20;

  const config = await resolveConfig();
  const graph = openGraph(config);

  try {
    let results = graph.search(query, limit * 2); // Over-fetch for type filtering

    if (typeFilter) {
      results = results.filter((n) => n.type === typeFilter);
    }

    results = results.slice(0, limit);

    heading(` Search Results for "${query}"`);
    if (typeFilter) info(`Type filter: ${typeFilter}`);
    divider();

    if (results.length === 0) {
      warn('No results found.');
      return;
    }

    for (const node of results) {
      const typeColor = getTypeColor(node.type);
      console.log(
        `  ${typeColor}${pad(node.type, 12)}${c.reset} ` +
        `${c.bold}${node.name}${c.reset}` +
        `${c.dim} (${truncate(node.filePath, 40)}:${node.startLine})${c.reset}`,
      );
      if (node.signature) {
        console.log(`${c.dim}             ${truncate(node.signature, 60)}${c.reset}`);
      }
    }

    divider();
    info(`${results.length} result(s) found`);
  } finally {
    graph.close();
  }
}

/** Color a node type for display */
function getTypeColor(type: string): string {
  switch (type) {
    case 'function': return c.yellow;
    case 'class': return c.magenta;
    case 'method': return c.cyan;
    case 'interface': return c.blue;
    case 'type_alias': return c.blue;
    case 'variable': return c.green;
    case 'constant': return c.green;
    case 'file': return c.gray;
    case 'module': return c.gray;
    case 'component': return c.magenta;
    case 'hook': return c.cyan;
    case 'test': return c.yellow;
    default: return c.white;
  }
}

/** ai-mind-map trace <symbol> [--direction both|callers|callees] [--depth N] */
async function cmdTrace(args: ParsedArgs): Promise<void> {
  const symbolName = args.positional[0];
  if (!symbolName) {
    error('Usage: ai-mind-map trace <symbol-name> [--direction both|callers|callees] [--depth N]');
    process.exit(1);
  }

  const direction = (typeof args.flags['direction'] === 'string' ? args.flags['direction'] : 'both') as
    'both' | 'callers' | 'callees';
  const depth = typeof args.flags['depth'] === 'string' ? parseInt(args.flags['depth'], 10) : 3;

  const config = await resolveConfig();
  const graph = openGraph(config);

  try {
    // Find the symbol node(s)
    const nodes = graph.getNodesByName(symbolName);
    if (nodes.length === 0) {
      warn(`Symbol "${symbolName}" not found in the knowledge graph.`);
      info('Try running "ai-mind-map index" first, or search with "ai-mind-map search".');
      return;
    }

    heading(` Trace: ${symbolName}`);
    info(`Direction: ${direction} | Depth: ${depth}`);
    divider();

    for (const node of nodes) {
      console.log(
        `\n  ${c.bold}${node.qualifiedName}${c.reset} ` +
        `${c.dim}(${node.type} in ${truncate(node.filePath, 40)}:${node.startLine})${c.reset}`,
      );

      if (direction === 'callers' || direction === 'both') {
        const callers = graph.findCallers(node.id);
        console.log(`\n  ${c.cyan}↑ Callers${c.reset} (${callers.length}):`);
        if (callers.length === 0) {
          console.log(`    ${c.dim}(none)${c.reset}`);
        } else {
          for (const caller of callers.slice(0, depth * 5)) {
            console.log(
              `    ${c.green}←${c.reset} ${caller.qualifiedName} ` +
              `${c.dim}(${caller.type}, ${truncate(caller.filePath, 30)}:${caller.startLine})${c.reset}`,
            );
          }
          if (callers.length > depth * 5) {
            console.log(`    ${c.dim}… and ${callers.length - depth * 5} more${c.reset}`);
          }
        }
      }

      if (direction === 'callees' || direction === 'both') {
        const callees = graph.findCallees(node.id);
        console.log(`\n  ${c.cyan}↓ Callees${c.reset} (${callees.length}):`);
        if (callees.length === 0) {
          console.log(`    ${c.dim}(none)${c.reset}`);
        } else {
          for (const callee of callees.slice(0, depth * 5)) {
            console.log(
              `    ${c.green}→${c.reset} ${callee.qualifiedName} ` +
              `${c.dim}(${callee.type}, ${truncate(callee.filePath, 30)}:${callee.startLine})${c.reset}`,
            );
          }
          if (callees.length > depth * 5) {
            console.log(`    ${c.dim}… and ${callees.length - depth * 5} more${c.reset}`);
          }
        }
      }

      // Blast radius
      const blast = graph.blastRadius(node.id, depth);
      if (blast.length > 0) {
        console.log(`\n  ${c.red} Blast Radius${c.reset} (${blast.length} affected nodes):`);
        for (const affected of blast.slice(0, 10)) {
          console.log(
            `    ${c.yellow}⚡${c.reset} ${affected.qualifiedName} ` +
            `${c.dim}(${affected.type})${c.reset}`,
          );
        }
        if (blast.length > 10) {
          console.log(`    ${c.dim}… and ${blast.length - 10} more${c.reset}`);
        }
      }
    }

    divider();
  } finally {
    graph.close();
  }
}

/** ai-mind-map structure [<project-path>] — Show project structure */
async function cmdStructure(args: ParsedArgs): Promise<void> {
  const projectPath = args.positional[0];

  const config = await resolveConfig(projectPath);
  const graph = openGraph(config);

  try {
    const overview = graph.getProjectOverview();

    heading('  Project Structure');
    info(`Project: ${config.projectRoot}`);
    divider();

    if (overview.size === 0) {
      warn('No indexed files found. Run "ai-mind-map index" first.');
      return;
    }

    for (const [filePath, symbols] of overview) {
      const relPath = path.relative(config.projectRoot, filePath);
      console.log(`\n  ${c.bold}${relPath}${c.reset}`);

      if (symbols.length === 0) {
        console.log(`    ${c.dim}(no exported symbols)${c.reset}`);
      } else {
        for (const sym of symbols) {
          const typeColor = getTypeColor(sym.type);
          const asyncMark = sym.isAsync ? `${c.yellow}async ${c.reset}` : '';
          const exportMark = sym.isExported ? `${c.green}↗${c.reset} ` : '  ';
          console.log(
            `    ${exportMark}${typeColor}${pad(sym.type, 10)}${c.reset} ` +
            `${asyncMark}${c.bold}${sym.name}${c.reset}` +
            (sym.signature ? ` ${c.dim}${truncate(sym.signature, 45)}${c.reset}` : ''),
          );
        }
      }
    }

    divider();
    info(`${overview.size} file(s) indexed`);
  } finally {
    graph.close();
  }
}

/** ai-mind-map status [<project-path>] — Show index stats */
async function cmdStatus(args: ParsedArgs): Promise<void> {
  const projectPath = args.positional[0];

  const config = await resolveConfig(projectPath);

  heading(' AI Mind Map Status');
  info(`Project: ${config.projectRoot}`);
  info(`Database: ${config.dbPath}`);
  divider();

  if (!existsSync(config.dbPath)) {
    warn('Database not found. Run "ai-mind-map index" first.');
    return;
  }

  const graph = openGraph(config);
  const memDb = openMemoryDb(config);

  try {
    // Graph stats
    const graphStats = graph.getStats();
    console.log(`\n  ${c.bold}Knowledge Graph${c.reset}`);
    console.log(`    ${pad('Files:', 18)} ${c.bold}${formatNum(graphStats.totalFiles)}${c.reset}`);
    console.log(`    ${pad('Nodes:', 18)} ${c.bold}${formatNum(graphStats.totalNodes)}${c.reset}`);
    console.log(`    ${pad('Edges:', 18)} ${c.bold}${formatNum(graphStats.totalEdges)}${c.reset}`);

    if (Object.keys(graphStats.nodesByType).length > 0) {
      console.log(`    ${pad('By type:', 18)}`);
      for (const [type, count] of Object.entries(graphStats.nodesByType).sort((a, b) => b[1] - a[1])) {
        const typeColor = getTypeColor(type);
        console.log(`      ${typeColor}${pad(type, 14)}${c.reset} ${formatNum(count)}`);
      }
    }

    if (Object.keys(graphStats.languageBreakdown).length > 0) {
      console.log(`    ${pad('Languages:', 18)}`);
      for (const [lang, count] of Object.entries(graphStats.languageBreakdown).sort((a, b) => b[1] - a[1])) {
        console.log(`      ${c.cyan}${pad(lang, 14)}${c.reset} ${formatNum(count)} files`);
      }
    }

    // Memory stats
    try {
      const memory = new PersistentMemory(memDb, config.memory);
      const memStats = memory.getStats();
      console.log(`\n  ${c.bold}Memories${c.reset}`);
      console.log(`    ${pad('Total:', 18)} ${formatNum(memStats.totalMemories)}`);
      console.log(`    ${pad('Avg importance:', 18)} ${memStats.averageImportance.toFixed(2)}`);
      console.log(`    ${pad('Total accesses:', 18)} ${formatNum(memStats.totalAccessCount)}`);
      if (Object.keys(memStats.byCategory).length > 0) {
        console.log(`    ${pad('By category:', 18)}`);
        for (const [cat, cnt] of Object.entries(memStats.byCategory).sort((a, b) => b[1] - a[1])) {
          console.log(`      ${c.magenta}${pad(cat, 16)}${c.reset} ${formatNum(cnt)}`);
        }
      }
    } catch {
      console.log(`\n  ${c.bold}Memories${c.reset} ${c.dim}(not initialised)${c.reset}`);
    }

    // Decision stats
    try {
      const decisions = new DecisionLog(memDb, config.memory);
      const active = decisions.getActiveDecisions();
      const all = decisions.queryDecisions({});
      console.log(`\n  ${c.bold}Decisions${c.reset}`);
      console.log(`    ${pad('Total:', 18)} ${formatNum(all.length)}`);
      console.log(`    ${pad('Active:', 18)} ${c.green}${formatNum(active.length)}${c.reset}`);
    } catch {
      console.log(`\n  ${c.bold}Decisions${c.reset} ${c.dim}(not initialised)${c.reset}`);
    }

    // DB file size
    try {
      const dbStat = statSync(config.dbPath);
      console.log(`\n  ${c.bold}Storage${c.reset}`);
      console.log(`    ${pad('DB size:', 18)} ${formatBytes(dbStat.size)}`);
    } catch {
      // skip
    }

    divider();
  } finally {
    graph.close();
    memDb.close();
  }
}

/** ai-mind-map recall <query> — Search memories */
async function cmdRecall(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) {
    error('Usage: ai-mind-map recall <query>');
    process.exit(1);
  }

  const limit = typeof args.flags['limit'] === 'string' ? parseInt(args.flags['limit'], 10) : 10;

  const config = await resolveConfig();
  const db = openMemoryDb(config);

  try {
    const memory = new PersistentMemory(db, config.memory);
    const results = memory.queryMemories({ text: query, limit });

    heading(` Memory Recall: "${query}"`);
    divider();

    if (results.length === 0) {
      warn('No memories found matching your query.');
      return;
    }

    for (const mem of results) {
      const catColor = getCategoryColor(mem.category);
      console.log(
        `\n  ${c.bold}#${mem.id}${c.reset} ` +
        `${catColor}[${mem.category}]${c.reset} ` +
        `${c.dim}importance: ${mem.importance.toFixed(2)} | ` +
        `accessed: ${mem.accessCount}x${c.reset}`,
      );
      console.log(`  ${truncate(mem.content, 120)}`);
      if (mem.tags.length > 0) {
        console.log(`  ${c.dim}Tags: ${mem.tags.join(', ')}${c.reset}`);
      }
      if (mem.relatedFiles.length > 0) {
        console.log(`  ${c.dim}Files: ${mem.relatedFiles.map((f) => truncate(f, 30)).join(', ')}${c.reset}`);
      }
    }

    divider();
    info(`${results.length} memor${results.length === 1 ? 'y' : 'ies'} found`);
  } finally {
    db.close();
  }
}

/** Color a memory category for display */
function getCategoryColor(cat: string): string {
  switch (cat) {
    case 'architecture': return c.magenta;
    case 'convention': return c.cyan;
    case 'decision': return c.blue;
    case 'gotcha': return c.red;
    case 'dependency': return c.yellow;
    case 'workflow': return c.green;
    case 'context': return c.white;
    case 'preference': return c.gray;
    case 'lesson_learned': return c.yellow;
    case 'todo': return c.cyan;
    default: return c.white;
  }
}

/** ai-mind-map remember <content> --category <cat> — Store a memory */
async function cmdRemember(args: ParsedArgs): Promise<void> {
  const content = args.positional.join(' ');
  if (!content) {
    error('Usage: ai-mind-map remember <content> --category <category>');
    process.exit(1);
  }

  const category = (typeof args.flags['category'] === 'string'
    ? args.flags['category']
    : 'convention') as MemoryCategory;

  const validCategories: MemoryCategory[] = [
    'architecture', 'convention', 'decision', 'gotcha', 'dependency',
    'workflow', 'context', 'preference', 'lesson_learned', 'todo',
  ];

  if (!validCategories.includes(category)) {
    error(`Invalid category: "${category}". Valid: ${validCategories.join(', ')}`);
    process.exit(1);
  }

  const tagsRaw = typeof args.flags['tags'] === 'string' ? args.flags['tags'] : '';
  const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()) : [];

  const config = await resolveConfig();
  const db = openMemoryDb(config);

  try {
    const memory = new PersistentMemory(db, config.memory);
    const created = memory.createMemory({
      category,
      content,
      tags,
      source: 'user',
    });

    heading(' Memory Stored');
    divider();
    console.log(`  ${pad('ID:', 14)} ${c.bold}#${created.id}${c.reset}`);
    console.log(`  ${pad('Category:', 14)} ${getCategoryColor(created.category)}${created.category}${c.reset}`);
    console.log(`  ${pad('Importance:', 14)} ${created.importance.toFixed(2)}`);
    console.log(`  ${pad('Content:', 14)} ${truncate(created.content, 80)}`);
    if (created.tags.length > 0) {
      console.log(`  ${pad('Tags:', 14)} ${created.tags.join(', ')}`);
    }
    divider();
    success('Memory saved successfully');
  } finally {
    db.close();
  }
}

/** ai-mind-map decisions [--status active] — List decisions */
async function cmdDecisions(args: ParsedArgs): Promise<void> {
  const statusFilter = typeof args.flags['status'] === 'string'
    ? args.flags['status'] as 'active' | 'superseded' | 'reversed'
    : undefined;

  const config = await resolveConfig();
  const db = openMemoryDb(config);

  try {
    const decisionLog = new DecisionLog(db, config.memory);
    const decisions = decisionLog.queryDecisions({
      status: statusFilter,
      limit: 50,
    });

    heading(' Decision Log');
    if (statusFilter) info(`Filter: status = ${statusFilter}`);
    divider();

    if (decisions.length === 0) {
      warn('No decisions found.');
      return;
    }

    for (const d of decisions) {
      const statusColor = d.status === 'active' ? c.green
        : d.status === 'superseded' ? c.yellow
        : c.red;

      console.log(
        `\n  ${c.bold}#${d.id}${c.reset} ${statusColor}[${d.status}]${c.reset} ${c.bold}${d.title}${c.reset}`,
      );
      console.log(`  ${c.dim}${truncate(d.description, 100)}${c.reset}`);
      console.log(
        `  ${c.dim}Rationale: ${truncate(d.rationale, 80)}${c.reset}`,
      );
      console.log(
        `  ${c.dim}Decided: ${formatDate(d.decidedAt)} by ${d.decidedBy}${c.reset}`,
      );
      if (d.tags.length > 0) {
        console.log(`  ${c.dim}Tags: ${d.tags.join(', ')}${c.reset}`);
      }
      if (d.alternatives.length > 0) {
        console.log(`  ${c.dim}Alternatives: ${d.alternatives.join('; ')}${c.reset}`);
      }
    }

    divider();
    info(`${decisions.length} decision(s) total`);
  } finally {
    db.close();
  }
}

/** ai-mind-map changes [--since last_session|<ms>] — Show what changed */
async function cmdChanges(args: ParsedArgs): Promise<void> {
  const sinceRaw = typeof args.flags['since'] === 'string' ? args.flags['since'] : undefined;
  const limit = typeof args.flags['limit'] === 'string' ? parseInt(args.flags['limit'], 10) : 30;

  const config = await resolveConfig();

  heading(' Change History');
  divider();

  if (!existsSync(config.dbPath)) {
    warn('Database not found. Run "ai-mind-map index" first.');
    return;
  }

  try {
    const changeLog = new ChangeLog({ dbPath: config.dbPath });

    let since: number | undefined;
    if (sinceRaw === 'last_session') {
      const latestSession = changeLog.getLatestSession();
      if (latestSession) {
        since = latestSession.startedAt;
        info(`Since last session: ${formatDate(since)}`);
      }
    } else if (sinceRaw && !isNaN(Number(sinceRaw))) {
      since = Number(sinceRaw);
    }

    const changes = changeLog.queryChanges({ since, limit });

    if (changes.length === 0) {
      warn('No changes recorded.');
      changeLog.close();
      return;
    }

    for (const change of changes) {
      const typeIcon = change.changeType === 'created' ? `${c.green}+`
        : change.changeType === 'modified' ? `${c.yellow}~`
        : change.changeType === 'deleted' ? `${c.red}-`
        : `${c.blue}→`;

      console.log(
        `  ${typeIcon}${c.reset} ${c.bold}${truncate(change.filePath, 50)}${c.reset} ` +
        `${c.dim}${formatDate(change.timestamp)}${c.reset}`,
      );

      if (change.summary) {
        console.log(`    ${c.dim}${truncate(change.summary, 80)}${c.reset}`);
      }

      if (change.symbolsAffected.length > 0) {
        console.log(`    ${c.dim}Symbols: ${change.symbolsAffected.join(', ')}${c.reset}`);
      }

      if (change.linesAdded > 0 || change.linesRemoved > 0) {
        console.log(
          `    ${c.green}+${change.linesAdded}${c.reset} ` +
          `${c.red}-${change.linesRemoved}${c.reset}`,
        );
      }
    }

    // Summary stats
    const stats = changeLog.getStats();
    divider();
    console.log(
      `  Total: ${formatNum(stats.totalChanges)} changes across ` +
      `${formatNum(stats.totalSessions)} sessions`,
    );
    console.log(
      `  All-time: ${c.green}+${formatNum(stats.linesAddedAllTime)}${c.reset} / ` +
      `${c.red}-${formatNum(stats.linesRemovedAllTime)}${c.reset} lines`,
    );

    changeLog.close();
  } catch (err) {
    error(`Failed to read change log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** ai-mind-map config list | set <key> <value> | reset <key> */
async function cmdConfig(args: ParsedArgs): Promise<void> {
  const subCommand = args.positional[0] || 'list';

  if (subCommand === 'list') {
    const config = await resolveConfig();
    heading('⚙  Configuration');
    divider();
    printConfigRecursive(config as unknown as Record<string, unknown>, '');
    divider();
    return;
  }

  if (subCommand === 'set') {
    const key = args.positional[1];
    const value = args.positional[2];
    if (!key || !value) {
      error('Usage: ai-mind-map config set <key> <value>');
      process.exit(1);
    }

    info(`Setting ${key} = ${value}`);
    info('Note: Runtime config changes are not persisted. Edit .mindmap.json instead.');
    warn(`To persist: add {"${key}": ${JSON.stringify(value)}} to .mindmap.json`);
    return;
  }

  if (subCommand === 'reset') {
    const key = args.positional[1];
    if (!key) {
      error('Usage: ai-mind-map config reset <key>');
      process.exit(1);
    }
    const defaultVal = getNestedValue(DEFAULT_CONFIG as unknown as Record<string, unknown>, key);
    info(`Default value for "${key}": ${JSON.stringify(defaultVal)}`);
    info('Remove the key from .mindmap.json to reset to default.');
    return;
  }

  error(`Unknown config subcommand: ${subCommand}. Use: list, set, reset`);
  process.exit(1);
}

/** Recursively print config key-value pairs */
function printConfigRecursive(obj: Record<string, unknown>, prefix: string): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      printConfigRecursive(value as Record<string, unknown>, fullKey);
    } else {
      const displayValue = Array.isArray(value) && value.length > 5
        ? `[${value.slice(0, 5).join(', ')}, … +${value.length - 5}]`
        : JSON.stringify(value);
      console.log(`  ${c.cyan}${pad(fullKey, 30)}${c.reset} ${displayValue}`);
    }
  }
}

/** Get a nested value from an object using dot notation */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** ai-mind-map sync — Sync local memories/decisions/rules with team-shared file */
async function cmdSync(args: ParsedArgs): Promise<void> {
  heading(' Team Shared Context Synchronization');
  divider();

  const config = await loadConfig({
    projectRoot: args.flags['project-root'] as string,
    dbPath: args.flags['db-path'] as string,
    logLevel: 'info',
  });

  // Ensure database directory exists
  const dbDir = path.dirname(config.dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const graph = new KnowledgeGraph(config.dbPath);
  const memoryStore = new PersistentMemory(db, {
    decayRate: config.memory.decayRate,
    maxMemories: config.memory.maxMemories,
    importanceThreshold: config.memory.importanceThreshold,
  });
  const decisionLog = new DecisionLog(db, {
    maxDecisions: config.memory.maxDecisions,
  });

  try {
    info(`Target shared context file: ${c.bold}${config.sharedContextFile}${c.reset}`);
    info(`Synchronising…`);
    
    const syncStats = await syncSharedContext(config, graph, memoryStore, decisionLog);

    success('Synchronization complete!');
    console.log(`\nImported:`);
    console.log(`  Memories:  ${c.green}${syncStats.memoriesImported}${c.reset}`);
    console.log(`  Decisions: ${c.green}${syncStats.decisionsImported}${c.reset}`);
    console.log(`  Rules:     ${c.green}${syncStats.rulesImported}${c.reset}`);
    
    console.log(`Exported:`);
    console.log(`  Memories:  ${c.cyan}${syncStats.memoriesExported}${c.reset}`);
    console.log(`  Decisions: ${c.cyan}${syncStats.decisionsExported}${c.reset}`);
    console.log(`  Rules:     ${c.cyan}${syncStats.rulesExported}${c.reset}`);
    console.log();
  } finally {
    graph.close();
    db.close();
  }
}

/** ai-mind-map update — Check for updates */
async function cmdUpdate(): Promise<void> {
  heading(' AI Mind Map — Update');
  divider();

  const currentVersion = getVersion();
  info(`Current version: ${c.bold}v${currentVersion}${c.reset}`);

  // 1. Check npm for latest version
  info('Checking npm registry for latest version...');
  let latestVersion = '';
  try {
    latestVersion = execSync('npm view ai-mind-map version', {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
  } catch {
    warn('Could not check npm registry. Are you connected to the internet?');
    info('To update manually, run:');
    console.log(`\n  ${c.bold}npm install -g ai-mind-map@latest${c.reset}\n`);
    return;
  }

  info(`Latest version:  ${c.bold}v${latestVersion}${c.reset}`);

  // 2. Compare versions
  if (currentVersion === latestVersion) {
    console.log('');
    console.log(`  ${c.green}${c.reset} You are already on the latest version!`);
    console.log('');
    divider();
    return;
  }

  // Parse semver for display
  const [curMajor, curMinor, curPatch] = currentVersion.split('.').map(Number);
  const [latMajor, latMinor, latPatch] = latestVersion.split('.').map(Number);

  const isBreaking = latMajor > curMajor;
  const isFeature = latMinor > curMinor;
  const isPatch = latPatch > curPatch;

  const updateType = isBreaking
    ? `${c.red}MAJOR (breaking changes)${c.reset}`
    : isFeature
      ? `${c.yellow}MINOR (new features)${c.reset}`
      : `${c.green}PATCH (bug fixes)${c.reset}`;

  console.log('');
  console.log(`  ${c.cyan}Update available:${c.reset} v${currentVersion} → ${c.bold}v${latestVersion}${c.reset} (${updateType})`);
  console.log('');

  // 3. Check how we were installed
  const isGlobal = process.argv[1]?.includes('node_modules');
  const isNpx = process.argv[1]?.includes('_npx') || process.argv[1]?.includes('npm-cache');

  if (isNpx) {
    // npx always uses latest on next run
    console.log(`  ${c.green}${c.reset} You're using npx — next run will automatically use v${latestVersion}`);
    info('To force a cache refresh now:');
    console.log(`\n  ${c.bold}npx -y ai-mind-map@latest install${c.reset}\n`);
  } else {
    // Global or local install — need manual update
    info('Updating...');
    try {
      const updateCmd = isGlobal
        ? 'npm install -g ai-mind-map@latest'
        : 'npm install ai-mind-map@latest';

      console.log(`  ${c.dim}$ ${updateCmd}${c.reset}`);
      execSync(updateCmd, { stdio: 'inherit', timeout: 60_000 });
      console.log('');
      console.log(`  ${c.green}${c.reset} Updated to v${latestVersion}!`);
    } catch (err) {
      warn('Auto-update failed. Update manually:');
      console.log(`\n  ${c.bold}npm install -g ai-mind-map@latest${c.reset}\n`);
      return;
    }
  }

  // 4. Re-install agent configs to update rules files
  console.log('');
  info('Updating agent configurations...');
  try {
    await installAgents();
  } catch {
    warn('Could not auto-update agent configs. Run "ai-mind-map install" manually.');
  }

  // 5. Run quick verification
  console.log('');
  info('Running verification...');
  try {
    await runDoctor();
  } catch {
    warn('Doctor check encountered issues. Run "ai-mind-map doctor --fix" for details.');
  }

  console.log('');
  divider();
  console.log(`  ${c.green}${c.reset} ${c.bold}Update complete!${c.reset} Restart your AI agent to use the new version.`);
  console.log('');
}

/** ai-mind-map --help — Show help text */
function showHelp(): void {
  const version = getVersion();
  console.log(`
${c.bold}${c.cyan}AI Mind Map${c.reset} ${c.dim}v${version}${c.reset}
${c.dim}MCP server that reduces AI coding agent token usage by 80-99%.${c.reset}

${c.bold}USAGE${c.reset}
  ${c.cyan}ai-mind-map${c.reset} <command> [options]

${c.bold}COMMANDS${c.reset}
  ${c.cyan}serve${c.reset}                          Start MCP server (default)
  ${c.cyan}index${c.reset} <project-path>            Index a project's codebase
  ${c.cyan}search${c.reset} <query>                  Search the knowledge graph
    ${c.dim}--type <type>                  Filter: func, class, method, etc.${c.reset}
    ${c.dim}--limit <N>                    Max results (default: 20)${c.reset}
  ${c.cyan}trace${c.reset} <symbol-name>             Trace symbol dependencies
    ${c.dim}--direction <dir>              both, callers, or callees (default: both)${c.reset}
    ${c.dim}--depth <N>                    Traversal depth (default: 3)${c.reset}
  ${c.cyan}structure${c.reset} [<project-path>]      Show project structure overview
  ${c.cyan}status${c.reset} [<project-path>]         Show index and memory stats
  ${c.cyan}recall${c.reset} <query>                  Search stored memories
  ${c.cyan}remember${c.reset} <content>              Store a new memory
    ${c.dim}--category <cat>               Category (default: convention)${c.reset}
    ${c.dim}--tags <tag1,tag2>             Comma-separated tags${c.reset}
  ${c.cyan}decisions${c.reset}                       List architectural decisions
    ${c.dim}--status <status>              Filter: active, superseded, reversed${c.reset}
  ${c.cyan}changes${c.reset}                         Show change history
    ${c.dim}--since <last_session|epoch>   Filter changes since timestamp${c.reset}
    ${c.dim}--limit <N>                    Max results (default: 30)${c.reset}
  ${c.cyan}sync${c.reset}                            Sync memories, decisions, and rules with shared file

${c.bold}AGENT MANAGEMENT${c.reset}
  ${c.cyan}install${c.reset}                         Auto-detect and configure AI agents
  ${c.cyan}uninstall${c.reset}                       Remove agent configurations
  ${c.cyan}update${c.reset}                          Check for updates + auto-update
  ${c.cyan}doctor${c.reset}                          Run diagnostics check
  ${c.cyan}doctor --fix${c.reset}                    Auto-repair broken configurations

${c.bold}CONFIGURATION${c.reset}
  ${c.cyan}config list${c.reset}                     Show current configuration
  ${c.cyan}config set${c.reset} <key> <value>        Set a config value
  ${c.cyan}config reset${c.reset} <key>              Reset a key to default

${c.bold}OTHER${c.reset}
  ${c.dim}--help, -h${c.reset}                       Show this help message
  ${c.dim}--version, -v${c.reset}                    Show version

${c.bold}EXAMPLES${c.reset}
  ${c.dim}# Index current directory${c.reset}
  ${c.cyan}ai-mind-map index .${c.reset}

  ${c.dim}# Search for a function${c.reset}
  ${c.cyan}ai-mind-map search "handleAuth" --type function${c.reset}

  ${c.dim}# Trace who calls a function${c.reset}
  ${c.cyan}ai-mind-map trace parseConfig --direction callers${c.reset}

  ${c.dim}# Store a convention${c.reset}
  ${c.cyan}ai-mind-map remember "Always use snake_case for DB columns" --category convention${c.reset}

  ${c.dim}# Install MCP config for all detected agents${c.reset}
  ${c.cyan}ai-mind-map install${c.reset}

  ${c.dim}# Run diagnostics${c.reset}
  ${c.cyan}ai-mind-map doctor${c.reset}
`);
}

// ============================================================
// Main Router
// ============================================================

/**
 * Main CLI entry point. Parses arguments and dispatches to the
 * appropriate command handler.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  // Version flag
  if (args.flags['version'] || args.flags['v']) {
    console.log(getVersion());
    return;
  }

  // Help flag
  if (args.flags['help'] || args.flags['h'] || args.command === 'help') {
    showHelp();
    return;
  }

  try {
    switch (args.command) {
      case '':
      case 'serve':
        await cmdServe();
        break;

      case 'index':
        await cmdIndex(args);
        break;

      case 'search':
        await cmdSearch(args);
        break;

      case 'trace':
        await cmdTrace(args);
        break;

      case 'structure':
        await cmdStructure(args);
        break;

      case 'status':
        await cmdStatus(args);
        break;

      case 'recall':
        await cmdRecall(args);
        break;

      case 'remember':
        await cmdRemember(args);
        break;

      case 'decisions':
        await cmdDecisions(args);
        break;

      case 'changes':
        await cmdChanges(args);
        break;

      case 'sync':
        await cmdSync(args);
        break;

      case 'install':
        await installAgents();
        break;

      case 'uninstall':
        await uninstallAgents();
        break;

      case 'update':
        await cmdUpdate();
        break;

      case 'config':
        await cmdConfig(args);
        break;

      case 'doctor':
        await runDoctor();
        break;

      default:
        error(`Unknown command: "${args.command}"`);
        info('Run "ai-mind-map --help" to see available commands.');
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Command failed: ${message}`);
    if (err instanceof Error && err.stack && process.env.DEBUG) {
      console.log(`${c.dim}${err.stack}${c.reset}`);
    }
    process.exit(1);
  }
}

// ============================================================
// Auto-run when executed directly
// ============================================================

// Detect if this file is being run as the main entry point
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'));

if (isMainModule) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
