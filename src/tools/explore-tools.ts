/**
 * AI Mind Map -- Deep Explore MCP Tool
 *
 * The "one-call complete project understanding" tool. Returns everything
 * an AI agent needs to understand a project in a single response:
 *
 *   - Full recursive directory tree
 *   - All source file contents (actual code)
 *   - All parsed symbols with relationships
 *   - Architecture analysis
 *   - Project metadata and dependencies
 *
 * Replaces 15-30 manual list_dir + view_file + grep_search calls.
 */

import { z } from 'zod';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig } from '../types.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import { ArchitectureAnalyzer } from '../knowledge-graph/architecture.js';
import { Indexer } from '../knowledge-graph/indexer.js';
import { isSupportedFile, detectLanguage } from '../knowledge-graph/parser.js';

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

function okWithSavings(
  data: unknown,
  tokensSaved: number,
  estimator: ITokenEstimator,
): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved };
}

function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

// ============================================================
// Directory Tree Builder
// ============================================================

/** Maximum source files to include before truncating */
const MAX_SOURCE_FILES = 2500;

/** Maximum tree entries before truncating */
const MAX_TREE_ENTRIES = 10000;

/** Indexing timeout in ms (60 seconds max) */
const INDEX_TIMEOUT_MS = 60_000;

/** Directories to always skip when scanning */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.next', '.nuxt',
  'dist', 'build', '.cache', '.tox', '.mypy_cache', '.pytest_cache',
  'venv', '.venv', 'env', '.env', 'coverage', '.nyc_output',
  '.idea', '.vscode', '.vs', 'vendor', 'target', 'bin', 'obj',
  '.gradle', '.dart_tool', '.pub-cache', 'Pods',
  '.gemini', '.cursor', 'antigravity',
  // Output / generated / model directories
  'output', 'out', 'outputs', '.output',
  'models', 'model', 'checkpoints', 'weights',
  'logs', 'tmp', 'temp', '.tmp',
  // Bundled third-party applications
  'LibreSprite', 'blobs',
  // Python runtime / package directories
  'site-packages', 'lib', 'Lib', 'Scripts', 'Include',
  'standalone-env', 'python_embeded', 'python_embedded',
  // Electron / desktop app runtime
  'node_modules', 'electron', '.launcher',
  // Cache directories
  'ComfyUI-Cache', 'ComfyUI-Shared',
]);

/** Directory name patterns that indicate runtime/install dirs (not source) */
const RUNTIME_DIR_PATTERNS = [
  /^python[0-9._-]*/i,
  /^site-packages$/i,
  /^standalone[-_]?env$/i,
  /^[._]?cache$/i,
  /Installs?$/i,
];

/** Binary/large file extensions to skip contents for */
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

/** Config/metadata files to always include content for */
const CONFIG_FILES = new Set([
  'package.json', 'tsconfig.json', 'tsconfig.build.json',
  'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'webpack.config.ts',
  'next.config.js', 'next.config.ts', 'next.config.mjs',
  '.eslintrc.json', '.eslintrc.js', '.prettierrc',
  'Cargo.toml', 'go.mod', 'go.sum', 'requirements.txt', 'requirements_ai.txt',
  'setup.py', 'setup.cfg', 'pyproject.toml', 'Pipfile',
  'Gemfile', 'Rakefile', 'build.gradle', 'pom.xml',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.env.example', '.env.sample',
  'Makefile', 'CMakeLists.txt',
  'agent_manifest.json', 'mcp_config.json',
  '.gitignore', '.dockerignore',
]);

/** README-like files to always include */
const README_FILES = new Set([
  'README.md', 'readme.md', 'README.txt', 'README',
  'CHANGELOG.md', 'CHANGES.md', 'HISTORY.md',
  'CONTRIBUTING.md', 'LICENSE', 'LICENSE.md',
]);

interface TreeEntry {
  path: string;         // Relative path
  name: string;
  isDir: boolean;
  sizeBytes: number;
  children?: TreeEntry[];
}

interface FileEntry {
  path: string;         // Relative path
  sizeBytes: number;
  language: string | null;
  content: string | null;     // null for binary/skipped files
  symbols: {
    name: string;
    type: string;
    signature: string;
    startLine: number;
    endLine: number;
    isExported: boolean;
    docComment?: string;
  }[];
}

/** Shared state for file counting across recursive calls */
interface ScanState {
  fileCount: number;
  treeCount: number;
  truncated: boolean;
}

/**
 * Recursively build the directory tree and collect source files.
 * Respects MAX_SOURCE_FILES and MAX_TREE_ENTRIES caps.
 */
function scanDirectory(
  rootPath: string,
  currentPath: string,
  maxFileSizeKB: number,
  maxDepth: number = 25,
  depth: number = 0,
  state: ScanState = { fileCount: 0, treeCount: 0, truncated: false },
): { tree: TreeEntry[]; files: FileEntry[]; state: ScanState } {
  const tree: TreeEntry[] = [];
  const files: FileEntry[] = [];

  if (depth > maxDepth || state.truncated) return { tree, files, state };

  let entries: string[];
  try {
    entries = readdirSync(currentPath);
  } catch {
    return { tree, files, state };
  }

  // Sort: directories first, then files, alphabetically
  const sorted = entries.sort((a, b) => {
    const aPath = join(currentPath, a);
    const bPath = join(currentPath, b);
    let aIsDir = false;
    let bIsDir = false;
    try { aIsDir = statSync(aPath).isDirectory(); } catch { /* skip */ }
    try { bIsDir = statSync(bPath).isDirectory(); } catch { /* skip */ }
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });

  for (const entry of sorted) {
    const fullPath = join(currentPath, entry);
    const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');

    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      // Skip directories matching runtime patterns
      if (RUNTIME_DIR_PATTERNS.some(p => p.test(entry))) continue;

      // Check if we've hit the tree cap
      if (state.treeCount >= MAX_TREE_ENTRIES) {
        state.truncated = true;
        break;
      }

      const treeEntry: TreeEntry = {
        path: relPath,
        name: entry,
        isDir: true,
        sizeBytes: 0,
      };

      const sub = scanDirectory(rootPath, fullPath, maxFileSizeKB, maxDepth, depth + 1, state);
      treeEntry.children = sub.tree;
      tree.push(treeEntry);
      state.treeCount++;
      files.push(...sub.files);
    } else {
      const ext = extname(entry).toLowerCase();
      const isBinary = BINARY_EXTENSIONS.has(ext);
      const isConfig = CONFIG_FILES.has(entry);
      const isReadme = README_FILES.has(entry);
      const isSource = isSupportedFile(entry);
      const shouldReadContent = !isBinary && st.size <= maxFileSizeKB * 1024;

      tree.push({
        path: relPath,
        name: entry,
        isDir: false,
        sizeBytes: st.size,
      });

      // Include content for source files, configs, and readmes
      if (shouldReadContent && (isSource || isConfig || isReadme)) {
        // Check file cap
        if (state.fileCount >= MAX_SOURCE_FILES) {
          state.truncated = true;
          break;
        }

        let content: string | null = null;
        try {
          content = readFileSync(fullPath, 'utf-8');
        } catch {
          content = null;
        }

        files.push({
          path: relPath,
          sizeBytes: st.size,
          language: detectLanguage(entry) || (isConfig ? 'config' : null),
          content,
          symbols: [], // Will be populated from graph
        });
        state.fileCount++;
      } else if (isSource && isBinary) {
        // Binary source files (unlikely but handle)
        files.push({
          path: relPath,
          sizeBytes: st.size,
          language: detectLanguage(entry),
          content: null,
          symbols: [],
        });
        state.fileCount++;
      }
    }
  }

  return { tree, files, state };
}

/**
 * Render a directory tree as a visual string (like the `tree` command).
 */
function renderTree(entries: TreeEntry[], prefix: string = ''): string {
  const lines: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    if (entry.isDir) {
      const childCount = entry.children?.length || 0;
      lines.push(`${prefix}${connector}${entry.name}/  (${childCount} items)`);
      if (entry.children && entry.children.length > 0) {
        lines.push(renderTree(entry.children, childPrefix));
      }
    } else {
      const sizeStr = formatSize(entry.sizeBytes);
      lines.push(`${prefix}${connector}${entry.name}  (${sizeStr})`);
    }
  }

  return lines.join('\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extract project metadata from config files.
 */
function extractProjectMetadata(rootPath: string, files: FileEntry[]): {
  name: string;
  description: string;
  techStack: string[];
  framework: string | null;
  dependencies: { name: string; version: string; dev: boolean }[];
  entryPoints: { path: string; type: string }[];
} {
  const metadata = {
    name: basename(rootPath),
    description: '',
    techStack: [] as string[],
    framework: null as string | null,
    dependencies: [] as { name: string; version: string; dev: boolean }[],
    entryPoints: [] as { path: string; type: string }[],
  };

  // Try package.json
  const pkgFile = files.find(f => f.path === 'package.json');
  if (pkgFile?.content) {
    try {
      const pkg = JSON.parse(pkgFile.content);
      metadata.name = pkg.name || metadata.name;
      metadata.description = pkg.description || '';

      // Dependencies
      for (const [name, version] of Object.entries(pkg.dependencies || {})) {
        metadata.dependencies.push({ name, version: String(version), dev: false });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
        metadata.dependencies.push({ name, version: String(version), dev: true });
      }

      // Detect framework
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.next) metadata.framework = 'Next.js';
      else if (allDeps.nuxt) metadata.framework = 'Nuxt';
      else if (allDeps.react) metadata.framework = 'React';
      else if (allDeps.vue) metadata.framework = 'Vue';
      else if (allDeps['@angular/core']) metadata.framework = 'Angular';
      else if (allDeps.svelte) metadata.framework = 'Svelte';
      else if (allDeps.express) metadata.framework = 'Express';
      else if (allDeps.fastify) metadata.framework = 'Fastify';
      else if (allDeps.hono) metadata.framework = 'Hono';

      metadata.techStack.push('Node.js');
      if (allDeps.typescript) metadata.techStack.push('TypeScript');

      // Entry points from scripts
      if (pkg.main) metadata.entryPoints.push({ path: pkg.main, type: 'main' });
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
        for (const [, binPath] of Object.entries(bins)) {
          metadata.entryPoints.push({ path: String(binPath), type: 'cli' });
        }
      }
    } catch { /* invalid JSON, skip */ }
  }

  // Try requirements.txt (Python)
  const reqFile = files.find(f => f.path === 'requirements.txt' || f.path === 'requirements_ai.txt');
  if (reqFile?.content) {
    metadata.techStack.push('Python');
    for (const line of reqFile.content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:[><=!~]+(.*))?$/);
      if (match) {
        metadata.dependencies.push({ name: match[1], version: match[2] || '*', dev: false });
      }
    }
  }

  // Try pyproject.toml
  const pyprojectFile = files.find(f => f.path === 'pyproject.toml');
  if (pyprojectFile?.content) {
    if (!metadata.techStack.includes('Python')) metadata.techStack.push('Python');
  }

  // Try setup.py
  const setupFile = files.find(f => f.path === 'setup.py' || f.path === 'setup_ai.py');
  if (setupFile?.content) {
    if (!metadata.techStack.includes('Python')) metadata.techStack.push('Python');
  }

  // Try Cargo.toml (Rust)
  const cargoFile = files.find(f => f.path === 'Cargo.toml');
  if (cargoFile?.content) {
    metadata.techStack.push('Rust');
  }

  // Try go.mod (Go)
  const goModFile = files.find(f => f.path === 'go.mod');
  if (goModFile?.content) {
    metadata.techStack.push('Go');
  }

  // README for description
  const readmeFile = files.find(f =>
    f.path.toLowerCase() === 'readme.md' || f.path.toLowerCase() === 'readme.txt'
  );
  if (readmeFile?.content && !metadata.description) {
    // Extract first non-heading paragraph
    const lines = readmeFile.content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('!') && trimmed.length > 20) {
        metadata.description = trimmed.slice(0, 300);
        break;
      }
    }
  }

  // Detect entry points from common patterns
  const entryPatterns = [
    { pattern: 'src/index.ts', type: 'main' },
    { pattern: 'src/index.js', type: 'main' },
    { pattern: 'src/main.ts', type: 'main' },
    { pattern: 'src/main.py', type: 'main' },
    { pattern: 'src/app.ts', type: 'app' },
    { pattern: 'src/app.py', type: 'app' },
    { pattern: 'app.py', type: 'app' },
    { pattern: 'main.py', type: 'main' },
    { pattern: '__main__.py', type: 'cli' },
    { pattern: 'manage.py', type: 'cli' },
    { pattern: 'server.ts', type: 'server' },
    { pattern: 'server.js', type: 'server' },
  ];
  for (const ep of entryPatterns) {
    if (files.some(f => f.path === ep.pattern || f.path.endsWith('/' + ep.pattern))) {
      const match = files.find(f => f.path === ep.pattern || f.path.endsWith('/' + ep.pattern));
      if (match && !metadata.entryPoints.some(e => e.path === match.path)) {
        metadata.entryPoints.push({ path: match.path, type: ep.type });
      }
    }
  }

  return metadata;
}

// ============================================================
// Registration
// ============================================================

/**
 * Register the Deep Explore tool — one-call complete project understanding.
 */
export function registerExploreTools(
  server: McpServer,
  graph: KnowledgeGraph,
  indexer: Indexer,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  server.tool(
    'mindmap_deep_explore',
    'Complete project exploration in one call. Returns full directory tree, all source file contents, parsed symbols, architecture analysis, and project metadata. Replaces 15-30 manual list_dir + view_file calls. Use this FIRST when exploring any project.',
    {
      projectPath: z.string().describe('Absolute path to the project root directory'),
      maxFileSizeKB: z.number().optional().default(200).describe('Max file size in KB to include contents for (default: 200)'),
      includeContents: z.boolean().optional().default(true).describe('Whether to include actual file contents (default: true)'),
      includeArchitecture: z.boolean().optional().default(true).describe('Whether to include architecture analysis (default: true)'),
    },
    async (args) => {
      const startTime = Date.now();
      let projectPath = args.projectPath.replace(/\\/g, '/').replace(/\/$/, '');

      // Validate path
      if (!existsSync(projectPath)) {
        return mcpText(fail(`Project path not found: ${projectPath}`));
      }

      try {
        const st = statSync(projectPath);
        if (!st.isDirectory()) {
          return mcpText(fail(`Path is not a directory: ${projectPath}`));
        }
      } catch {
        return mcpText(fail(`Cannot access path: ${projectPath}`));
      }

      // Smart source root detection: if the given path looks like a wrapper
      // (no source files at top level), try to find the actual source root
      const sourceMarkers = [
        'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml',
        'go.mod', 'pom.xml', 'build.gradle', 'CMakeLists.txt',
        'src', 'lib', 'app',
      ];
      const hasSourceMarker = sourceMarkers.some(m => existsSync(join(projectPath, m)));

      if (!hasSourceMarker) {
        // No source markers at top level -- search up to 3 levels deep
        const findSourceRoot = (dir: string, depth: number): string | null => {
          if (depth > 3) return null;
          try {
            const entries = readdirSync(dir);
            for (const entry of entries) {
              if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
              const full = join(dir, entry);
              try {
                if (!statSync(full).isDirectory()) continue;
              } catch { continue; }
              // Check if this subdir has source markers
              if (sourceMarkers.some(m => existsSync(join(full, m)))) {
                return full.replace(/\\/g, '/');
              }
              // Recurse deeper
              const found = findSourceRoot(full, depth + 1);
              if (found) return found;
            }
          } catch { /* skip */ }
          return null;
        };
        const detectedRoot = findSourceRoot(projectPath, 0);
        if (detectedRoot) {
          process.stderr.write(
            `[deep_explore] Auto-detected source root: ${detectedRoot} (given: ${projectPath})\n`
          );
          projectPath = detectedRoot;
        }
      }

      // Ensure the project is indexed
      const currentRoot = config.projectRoot;
      const needsReindex = currentRoot !== projectPath;
      if (needsReindex) {
        // Use indexer.setProjectRoot which clears the graph to prevent
        // cross-project pollution (e.g., Comfy-Desktop nodes in FlyShelf results)
        indexer.setProjectRoot(projectPath);
      }

      // Check if indexed, auto-index if needed (with timeout)
      const stats = graph.getStats();
      if (stats.totalNodes === 0 || needsReindex) {
        try {
          // Race indexing against a timeout to prevent hanging on huge projects
          await Promise.race([
            indexer.fullIndex(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Indexing timed out')), INDEX_TIMEOUT_MS)
            ),
          ]);
        } catch (e) {
          // Non-fatal — we can still explore without graph data
          process.stderr.write(`[deep_explore] Indexing warning: ${e}\n`);
        }
      }

      // 1. Scan directory tree and collect files (with caps)
      const scanResult = scanDirectory(
        projectPath,
        projectPath,
        args.maxFileSizeKB ?? 200,
      );
      const { tree, files } = scanResult;
      const wasTruncated = scanResult.state.truncated;

      // Strip contents if not requested
      if (!args.includeContents) {
        for (const file of files) {
          file.content = null;
        }
      }

      // 2. Populate symbols from graph
      const { overview } = graph.getProjectOverview();
      for (const file of files) {
        const absPath = join(projectPath, file.path).replace(/\\/g, '/');
        // Try both forward-slash and backslash variants
        const nodes = overview.get(absPath) || overview.get(absPath.replace(/\//g, '\\')) || [];

        file.symbols = nodes.map(n => ({
          name: n.name,
          type: n.type,
          signature: n.signature || '',
          startLine: n.startLine || 0,
          endLine: n.endLine || 0,
          isExported: n.isExported || false,
          docComment: n.docComment || undefined,
        }));
      }

      // Also check with relative paths
      for (const [filePath, nodes] of overview) {
        const rel = relative(projectPath, filePath).replace(/\\/g, '/');
        const file = files.find(f => f.path === rel);
        if (file && file.symbols.length === 0 && nodes.length > 0) {
          file.symbols = nodes.map(n => ({
            name: n.name,
            type: n.type,
            signature: n.signature || '',
            startLine: n.startLine || 0,
            endLine: n.endLine || 0,
            isExported: n.isExported || false,
            docComment: n.docComment || undefined,
          }));
        }
      }

      // 3. Build directory tree string
      const directoryTree = renderTree(tree);

      // 4. Extract project metadata
      const project = extractProjectMetadata(projectPath, files);

      // 5. Architecture analysis
      let architecture: {
        layers: { name: string; fileCount: number; files: string[] }[];
        patterns: string[];
        languageBreakdown: Record<string, number>;
        complexity: {
          totalFunctions: number;
          totalClasses: number;
          totalInterfaces: number;
          averageFunctionsPerFile: number;
        };
      } | null = null;

      if (args.includeArchitecture) {
        try {
          const analyzer = new ArchitectureAnalyzer(graph);
          const report = analyzer.analyze(projectPath);

          const normalizedRoot = projectPath.replace(/\\/g, '/');

          architecture = {
            layers: report.layers.map(l => {
              // Filter to only files within this project
              const projectFiles = l.filePaths.filter(f =>
                f.replace(/\\/g, '/').startsWith(normalizedRoot)
              );
              return {
                name: l.name,
                fileCount: projectFiles.length,
                files: projectFiles.slice(0, 50).map(f =>
                  relative(projectPath, f).replace(/\\/g, '/')
                ),
              };
            }).filter(l => l.fileCount > 0), // Remove empty layers
            patterns: [],
            languageBreakdown: {},
            complexity: {
              totalFunctions: report.complexity.totalFunctions,
              totalClasses: report.complexity.totalClasses,
              totalInterfaces: report.complexity.totalInterfaces,
              averageFunctionsPerFile: report.complexity.averageFunctionsPerFile,
            },
          };

          // Extract patterns from codePatterns
          if (report.codePatterns.classHeavy) architecture.patterns.push('Class-heavy (OOP)');
          if (report.codePatterns.functionHeavy) architecture.patterns.push('Function-heavy (FP)');
          if (report.codePatterns.asyncPrevalence > 0.3) architecture.patterns.push('Heavily async');
          if (report.codePatterns.exportedRatio > 0.6) architecture.patterns.push('Modular (high export ratio)');

          // Language breakdown
          for (const lang of report.languages) {
            architecture.languageBreakdown[lang.language] = lang.fileCount;
          }
        } catch (e) {
          process.stderr.write(`[deep_explore] Architecture analysis warning: ${e}\n`);
        }
      }

      // 6. Graph edges (dependency map)
      const allEdges = graph.getAllEdges();
      const edgesData = allEdges.slice(0, 5000).map(e => ({
        source: e.sourceId,
        target: e.targetId,
        type: e.type,
      }));

      // 7. Compute stats
      const graphStats = graph.getStats();
      let totalLines = 0;
      let totalSourceBytes = 0;
      for (const file of files) {
        if (file.content) {
          totalLines += file.content.split('\n').length;
          totalSourceBytes += file.sizeBytes;
        }
      }

      const durationMs = Date.now() - startTime;

      // Estimate tokens saved vs individual file reads
      // Each list_dir call = ~100 tokens overhead, each view_file = ~100 tokens overhead
      // With deep_explore, we save all that overhead
      const estimatedManualCalls = files.length + Math.ceil(files.length / 5); // file reads + dir listings
      const overheadPerCall = 100; // Average tokens for tool call/response framing
      const tokensSaved = estimatedManualCalls * overheadPerCall;

      const result = {
        project,
        directoryTree,
        files: files.map(f => ({
          path: f.path,
          sizeBytes: f.sizeBytes,
          language: f.language,
          content: f.content,
          symbols: f.symbols,
        })),
        architecture,
        graph: {
          totalNodes: graphStats.totalNodes,
          totalEdges: graphStats.totalEdges,
          edges: edgesData,
        },
        stats: {
          totalFiles: files.length,
          totalLines,
          totalSourceBytes,
          indexDurationMs: durationMs,
          languageBreakdown: graphStats.languageBreakdown,
          truncated: wasTruncated,
          maxSourceFiles: MAX_SOURCE_FILES,
          maxTreeEntries: MAX_TREE_ENTRIES,
        },
      };

      return mcpText(okWithSavings(result, tokensSaved, estimator));
    },
  );
}
