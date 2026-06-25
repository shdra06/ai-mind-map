/**
 * AI Mind Map — Filesystem MCP Tools
 *
 * Lightweight filesystem utilities that work WITHOUT triggering graph indexing.
 * These tools provide raw file and directory access, complementing the
 * knowledge-graph-powered tools with fast, no-dependency operations.
 *
 * Tools:
 *   - mindmap_list_dir       — Directory listing (no indexing)
 *   - mindmap_read_lines     — Read specific line ranges with optional graph context
 *   - mindmap_project_summary — One-call project overview before indexing
 */

import { z } from 'zod';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  Dirent,
} from 'node:fs';
import { resolve, relative, extname, basename, join, sep } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig, GraphNode } from '../types.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';

// ============================================================
// Token Estimation Interface
// ============================================================

export interface ITokenEstimator {
  estimate(text: string): number;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

// ============================================================
// Helpers
// ============================================================

function mcpText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

function ok(data: unknown, estimator: ITokenEstimator): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved: 0 };
}

function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

// ============================================================
// Constants
// ============================================================

/** Directories to always skip during project summary scan */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.tox', '.mypy_cache', '.pytest_cache',
  'venv', '.venv', 'env', '.env', 'coverage', '.nyc_output',
  '.idea', '.vscode', '.vs', 'vendor', 'target', 'bin', 'obj',
  '.gradle', '.dart_tool', '.pub-cache', 'Pods',
  '.gemini', '.cursor', 'antigravity',
  'output', 'out', 'outputs', '.output',
  'models', 'model', 'checkpoints', 'weights',
  'logs', 'tmp', 'temp', '.tmp',
  'LibreSprite', 'blobs',
  'site-packages', 'lib', 'Lib', 'Scripts', 'Include',
  'standalone-env', 'python_embeded', 'python_embedded',
  'electron', '.launcher',
]);

/** Binary/large file extensions to skip for summary */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.class', '.o', '.obj',
  '.sqlite', '.db', '.sqlite3',
  '.safetensors', '.onnx', '.pt', '.pth', '.h5',
  '.lock', '.ase', '.aseprite', '.gpl', '.pcx',
]);

/** Project type detection from marker files */
const PROJECT_MARKERS: Record<string, string> = {
  'package.json': 'Node.js/TypeScript',
  'tsconfig.json': 'TypeScript',
  'requirements.txt': 'Python',
  'setup.py': 'Python',
  'pyproject.toml': 'Python',
  'Pipfile': 'Python',
  'Cargo.toml': 'Rust',
  'go.mod': 'Go',
  'build.gradle': 'Java/Kotlin',
  'pom.xml': 'Java',
  'Gemfile': 'Ruby',
  'composer.json': 'PHP',
  'CMakeLists.txt': 'C/C++',
  'Makefile': 'C/C++',
};

/** .csproj and .sln detected separately via extension */
const DOTNET_EXTENSIONS = new Set(['.csproj', '.sln', '.fsproj', '.vbproj']);

/** Common entry point filenames */
const ENTRY_POINTS = new Set([
  'index.ts', 'index.js', 'index.tsx', 'index.jsx',
  'main.ts', 'main.js', 'main.py', 'main.go', 'main.rs',
  'app.ts', 'app.js', 'app.py',
  'App.tsx', 'App.jsx', 'App.vue', 'App.svelte',
  'App.xaml.cs', 'Program.cs',
  'server.ts', 'server.js',
  'cli.ts', 'cli.js', 'cli.py',
  'manage.py', 'wsgi.py', 'asgi.py',
  'mod.rs', 'lib.rs',
]);

/** Max lines per read request */
const MAX_LINES_PER_REQUEST = 500;

/** Default lines if endLine is omitted */
const DEFAULT_LINE_WINDOW = 200;

/** Max entries when walking for project summary */
const MAX_WALK_ENTRIES = 10_000;

/** Max depth for compact directory tree */
const MAX_TREE_DEPTH = 3;

/** Max entries in compact directory tree */
const MAX_TREE_DISPLAY_ENTRIES = 50;

// ============================================================
// Internal Utilities
// ============================================================

/**
 * Resolve a potentially relative path against the project root.
 * Returns null if the resolved path is outside the project root (security).
 */
function resolvePath(inputPath: string, projectRoot: string): string | null {
  const resolved = resolve(projectRoot, inputPath);
  // Security: prevent directory traversal outside project
  const normalizedResolved = resolved.replace(/\\/g, '/');
  const normalizedRoot = projectRoot.replace(/\\/g, '/');
  if (!normalizedResolved.startsWith(normalizedRoot)) {
    return null;
  }
  return resolved;
}

/**
 * Parse a .gitignore file into a set of directory/file names to ignore.
 * Only handles simple patterns (no globs with ** or negation).
 */
function parseGitignoreSimple(gitignorePath: string): Set<string> {
  const names = new Set<string>();
  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      // Strip trailing slashes and leading slashes
      const clean = line.replace(/^\/+/, '').replace(/\/+$/, '');
      // Only handle simple name patterns (no wildcards)
      if (clean && !clean.includes('*') && !clean.includes('?') && !clean.includes('[')) {
        names.add(clean);
      }
    }
  } catch {
    // .gitignore doesn't exist or can't be read — that's fine
  }
  return names;
}

// ============================================================
// Tool 1: mindmap_list_dir internals
// ============================================================

interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  sizeBytes?: number;
  childCount?: number;
}

function listDirectory(dirPath: string, includeHidden: boolean): {
  path: string;
  entries: DirEntry[];
  totalFiles: number;
  totalDirs: number;
} {
  const rawEntries = readdirSync(dirPath, { withFileTypes: true });
  const entries: DirEntry[] = [];
  let totalFiles = 0;
  let totalDirs = 0;

  for (const entry of rawEntries) {
    // Skip hidden entries unless requested
    if (!includeHidden && entry.name.startsWith('.')) continue;

    const fullPath = join(dirPath, entry.name);
    try {
      const stat = statSync(fullPath);
      if (entry.isDirectory()) {
        // Count immediate children (non-recursive)
        let childCount = 0;
        try {
          childCount = readdirSync(fullPath).length;
        } catch {
          childCount = 0;
        }
        entries.push({
          name: entry.name,
          type: 'dir',
          childCount,
        });
        totalDirs++;
      } else if (entry.isFile()) {
        entries.push({
          name: entry.name,
          type: 'file',
          sizeBytes: stat.size,
        });
        totalFiles++;
      }
    } catch {
      // Permission denied or broken symlink — skip
    }
  }

  // Sort: directories first, then files, alphabetically within each group
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: dirPath, entries, totalFiles, totalDirs };
}

// ============================================================
// Tool 2: mindmap_read_lines internals
// ============================================================

interface ContainingSymbol {
  name: string;
  type: string;
  signature: string;
  startLine: number;
  endLine: number;
}

function readLines(
  filePath: string,
  startLine: number,
  endLine: number | undefined,
  includeContext: boolean,
  graph: KnowledgeGraph | null,
): {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
  containingSymbol?: ContainingSymbol;
} {
  const content = readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // Normalise line range (1-indexed)
  const effectiveStart = Math.max(1, startLine);
  let effectiveEnd: number;

  if (endLine !== undefined) {
    effectiveEnd = Math.min(endLine, totalLines);
  } else {
    effectiveEnd = Math.min(effectiveStart + DEFAULT_LINE_WINDOW - 1, totalLines);
  }

  // Cap at MAX_LINES_PER_REQUEST
  if (effectiveEnd - effectiveStart + 1 > MAX_LINES_PER_REQUEST) {
    effectiveEnd = effectiveStart + MAX_LINES_PER_REQUEST - 1;
  }

  const lines = allLines.slice(effectiveStart - 1, effectiveEnd);

  // Graph context: find containing symbol
  let containingSymbol: ContainingSymbol | undefined;
  if (includeContext && graph) {
    try {
      const nodes = graph.getFileStructure(filePath);
      if (nodes && nodes.length > 0) {
        // Find the most specific (smallest range) symbol containing the start line
        let bestMatch: GraphNode | null = null;
        let bestRange = Infinity;
        for (const node of nodes) {
          if (
            node.type !== 'file' &&
            node.startLine <= effectiveStart &&
            node.endLine >= effectiveStart
          ) {
            const range = node.endLine - node.startLine;
            if (range < bestRange) {
              bestRange = range;
              bestMatch = node;
            }
          }
        }
        if (bestMatch) {
          containingSymbol = {
            name: bestMatch.name,
            type: bestMatch.type,
            signature: bestMatch.signature,
            startLine: bestMatch.startLine,
            endLine: bestMatch.endLine,
          };
        }
      }
    } catch {
      // Graph not indexed yet or file not in graph — that's fine
    }
  }

  return {
    filePath,
    startLine: effectiveStart,
    endLine: effectiveEnd,
    totalLines,
    lines,
    ...(containingSymbol ? { containingSymbol } : {}),
  };
}

// ============================================================
// Tool 3: mindmap_project_summary internals
// ============================================================

interface WalkState {
  totalFiles: number;
  totalDirs: number;
  languages: Record<string, number>;
  entryPoints: string[];
  entriesWalked: number;
  truncated: boolean;
}

/**
 * Walk directory tree recursively, respecting skip-dirs and entry cap.
 */
function walkDirectory(
  rootPath: string,
  currentPath: string,
  gitignoreNames: Set<string>,
  state: WalkState,
  depth: number = 0,
): void {
  if (state.entriesWalked >= MAX_WALK_ENTRIES) {
    state.truncated = true;
    return;
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(currentPath, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return; // Can't read directory
  }

  for (const entry of entries) {
    if (state.entriesWalked >= MAX_WALK_ENTRIES) {
      state.truncated = true;
      return;
    }

    // Skip hidden entries
    if (entry.name.startsWith('.')) continue;

    state.entriesWalked++;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      // Skip known dirs and gitignore-listed dirs
      if (SKIP_DIRS.has(entry.name) || gitignoreNames.has(entry.name)) continue;
      state.totalDirs++;
      walkDirectory(rootPath, fullPath, gitignoreNames, state, depth + 1);
    } else if (entry.isFile()) {
      state.totalFiles++;
      const ext = extname(entry.name).toLowerCase();

      // Count by extension (skip binary)
      if (ext && !BINARY_EXTENSIONS.has(ext)) {
        state.languages[ext] = (state.languages[ext] || 0) + 1;
      } else if (!ext) {
        // Extensionless files
        state.languages['(no ext)'] = (state.languages['(no ext)'] || 0) + 1;
      }

      // Detect entry points
      if (ENTRY_POINTS.has(entry.name)) {
        const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');
        state.entryPoints.push(relPath);
      }
    }
  }
}

/**
 * Build a compact directory tree string (max depth, max entries).
 */
function buildCompactTree(
  rootPath: string,
  currentPath: string,
  gitignoreNames: Set<string>,
  prefix: string = '',
  depth: number = 0,
  counter: { count: number } = { count: 0 },
): string {
  if (depth > MAX_TREE_DEPTH || counter.count >= MAX_TREE_DISPLAY_ENTRIES) return '';

  let entries: Dirent[];
  try {
    entries = readdirSync(currentPath, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return '';
  }

  // Separate dirs and files, skip hidden and ignored
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !gitignoreNames.has(entry.name)) {
        dirs.push(entry.name);
      }
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  let result = '';
  const allItems = [...dirs.map(d => ({ name: d, isDir: true })), ...files.map(f => ({ name: f, isDir: false }))];

  for (let i = 0; i < allItems.length; i++) {
    if (counter.count >= MAX_TREE_DISPLAY_ENTRIES) {
      result += `${prefix}... (truncated)\n`;
      break;
    }

    const item = allItems[i];
    const isLast = i === allItems.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    counter.count++;
    result += `${prefix}${connector}${item.name}${item.isDir ? '/' : ''}\n`;

    if (item.isDir) {
      result += buildCompactTree(
        rootPath,
        join(currentPath, item.name),
        gitignoreNames,
        prefix + childPrefix,
        depth + 1,
        counter,
      );
    }
  }

  return result;
}

/**
 * Detect project type from marker files in the root.
 */
function detectProjectType(projectPath: string): string[] {
  const types: string[] = [];

  // Check marker files
  for (const [file, type] of Object.entries(PROJECT_MARKERS)) {
    if (existsSync(join(projectPath, file))) {
      if (!types.includes(type)) types.push(type);
    }
  }

  // Check for .csproj/.sln files
  try {
    const rootEntries = readdirSync(projectPath);
    for (const entry of rootEntries) {
      const ext = extname(entry).toLowerCase();
      if (DOTNET_EXTENSIONS.has(ext) && !types.includes('C#/.NET')) {
        types.push('C#/.NET');
        break;
      }
    }
  } catch {
    // Can't read directory
  }

  return types.length > 0 ? types : ['Unknown'];
}

/**
 * Read key config file summaries.
 */
function readConfigSummary(projectPath: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // package.json
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      summary['package.json'] = {
        name: pkg.name ?? null,
        version: pkg.version ?? null,
        scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
        dependencyCount: pkg.dependencies ? Object.keys(pkg.dependencies).length : 0,
        devDependencyCount: pkg.devDependencies ? Object.keys(pkg.devDependencies).length : 0,
      };
    } catch {
      summary['package.json'] = { error: 'Failed to parse' };
    }
  }

  // .gitignore rules
  const gitignorePath = join(projectPath, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const lines = readFileSync(gitignorePath, 'utf-8')
        .split('\n')
        .filter(l => l.trim() && !l.trim().startsWith('#'));
      summary['.gitignore'] = { ruleCount: lines.length, rules: lines.slice(0, 20) };
    } catch {
      // skip
    }
  }

  // Cargo.toml
  const cargoPath = join(projectPath, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, 'utf-8');
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      const versionMatch = content.match(/^version\s*=\s*"([^"]+)"/m);
      summary['Cargo.toml'] = {
        name: nameMatch?.[1] ?? null,
        version: versionMatch?.[1] ?? null,
      };
    } catch {
      // skip
    }
  }

  // pyproject.toml
  const pyprojectPath = join(projectPath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      const versionMatch = content.match(/^version\s*=\s*"([^"]+)"/m);
      summary['pyproject.toml'] = {
        name: nameMatch?.[1] ?? null,
        version: versionMatch?.[1] ?? null,
      };
    } catch {
      // skip
    }
  }

  // go.mod
  const goModPath = join(projectPath, 'go.mod');
  if (existsSync(goModPath)) {
    try {
      const content = readFileSync(goModPath, 'utf-8');
      const moduleMatch = content.match(/^module\s+(\S+)/m);
      const goMatch = content.match(/^go\s+(\S+)/m);
      summary['go.mod'] = {
        module: moduleMatch?.[1] ?? null,
        goVersion: goMatch?.[1] ?? null,
      };
    } catch {
      // skip
    }
  }

  return summary;
}

/**
 * Estimate indexing time based on file count.
 */
function estimateIndexTime(totalFiles: number): string {
  if (totalFiles < 50) return '<5 seconds';
  if (totalFiles < 200) return '5-15 seconds';
  if (totalFiles < 500) return '15-30 seconds';
  if (totalFiles < 1000) return '30-60 seconds';
  if (totalFiles < 5000) return '1-3 minutes';
  return '3+ minutes';
}

// ============================================================
// Registration
// ============================================================

/**
 * Register Filesystem tools — lightweight file/directory operations
 * that work without triggering graph indexing.
 */
export function registerFilesystemTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  // ── mindmap_list_dir ──────────────────────────────────────────
  server.tool(
    'mindmap_list_dir',
    'List directory contents without triggering indexing. Returns files and directories with sizes and child counts. ' +
      'Directories are sorted first, then files, alphabetically.',
    {
      path: z.string().describe('Absolute or relative path to directory'),
      includeHidden: z.boolean().default(false).describe('Include hidden files/dirs (starting with .)'),
    },
    async ({ path: inputPath, includeHidden }) => {
      try {
        const resolved = resolvePath(inputPath, config.projectRoot);
        if (!resolved) {
          return mcpText(fail(`Path "${inputPath}" resolves outside the project root`));
        }
        if (!existsSync(resolved)) {
          return mcpText(fail(`Directory not found: ${resolved}`));
        }
        const stat = statSync(resolved);
        if (!stat.isDirectory()) {
          return mcpText(fail(`Not a directory: ${resolved}`));
        }

        const result = listDirectory(resolved, includeHidden);
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Failed to list directory: ${msg}`));
      }
    },
  );

  // ── mindmap_read_lines ────────────────────────────────────────
  server.tool(
    'mindmap_read_lines',
    'Read specific lines from a file (1-indexed, inclusive). Optionally includes the containing symbol ' +
      '(function/class) from the knowledge graph if indexed. Capped at 500 lines per request.',
    {
      filePath: z.string().describe('Absolute or relative path to file'),
      startLine: z.number().int().min(1).default(1).describe('First line to read (1-indexed)'),
      endLine: z.number().int().min(1).optional().describe('Last line to read (1-indexed, inclusive). Omit to read 200 lines from startLine'),
      includeContext: z.boolean().default(true).describe('Include the containing symbol name from the graph if indexed'),
    },
    async ({ filePath: inputPath, startLine, endLine, includeContext }) => {
      try {
        const resolved = resolvePath(inputPath, config.projectRoot);
        if (!resolved) {
          return mcpText(fail(`Path "${inputPath}" resolves outside the project root`));
        }
        if (!existsSync(resolved)) {
          return mcpText(fail(`File not found: ${resolved}`));
        }
        const stat = statSync(resolved);
        if (!stat.isFile()) {
          return mcpText(fail(`Not a file: ${resolved}`));
        }

        const result = readLines(
          resolved,
          startLine,
          endLine,
          includeContext,
          graph,
        );
        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Failed to read file: ${msg}`));
      }
    },
  );

  // ── mindmap_project_summary ───────────────────────────────────
  server.tool(
    'mindmap_project_summary',
    'Get a complete project overview in a single call — WITHOUT indexing. ' +
      'Detects project type, counts files by language, builds a compact directory tree, ' +
      'finds entry points, and reads key config files. Works instantly on any project.',
    {
      projectPath: z.string().describe('Absolute path to the project root'),
    },
    async ({ projectPath }) => {
      try {
        if (!existsSync(projectPath)) {
          return mcpText(fail(`Project path not found: ${projectPath}`));
        }
        const stat = statSync(projectPath);
        if (!stat.isDirectory()) {
          return mcpText(fail(`Not a directory: ${projectPath}`));
        }

        // Parse .gitignore for extra skip rules
        const gitignoreNames = parseGitignoreSimple(join(projectPath, '.gitignore'));

        // Walk the directory tree
        const state: WalkState = {
          totalFiles: 0,
          totalDirs: 0,
          languages: {},
          entryPoints: [],
          entriesWalked: 0,
          truncated: false,
        };
        walkDirectory(projectPath, projectPath, gitignoreNames, state);

        // Sort languages by count (descending)
        const sortedLanguages: Record<string, number> = {};
        const langEntries = Object.entries(state.languages).sort((a, b) => b[1] - a[1]);
        for (const [ext, count] of langEntries) {
          sortedLanguages[ext] = count;
        }

        // Detect project type
        const projectTypes = detectProjectType(projectPath);

        // Derive project name
        let projectName = basename(projectPath);
        const pkgPath = join(projectPath, 'package.json');
        if (existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            if (pkg.name) projectName = pkg.name;
          } catch {
            // use directory name
          }
        }

        // Build compact directory tree
        const directoryTree = buildCompactTree(projectPath, projectPath, gitignoreNames);

        // Read config summaries
        const configSummary = readConfigSummary(projectPath);

        const result = {
          projectPath,
          projectName,
          projectType: projectTypes,
          totalFiles: state.totalFiles,
          totalDirs: state.totalDirs,
          languages: sortedLanguages,
          directoryTree: directoryTree || '(empty)',
          entryPoints: state.entryPoints,
          configSummary,
          estimatedIndexTime: estimateIndexTime(state.totalFiles),
          ...(state.truncated ? { truncated: true, note: `Scan capped at ${MAX_WALK_ENTRIES} entries` } : {}),
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Failed to generate project summary: ${msg}`));
      }
    },
  );
}
