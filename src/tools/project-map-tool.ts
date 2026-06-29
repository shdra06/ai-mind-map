/**
 * AI Mind Map — Project Map Tool (MCP)
 *
 * THE killer tool: One call gives AI a complete mental model of any project.
 * Instead of AI wasting 10-20 tool calls and thousands of tokens to understand
 * a codebase, this returns a structured, token-efficient project map that covers:
 *
 *   - What the project IS (purpose, tech stack, type)
 *   - HOW it's organized (modules, layers, directory structure)
 *   - WHAT talks to what (inter-module dependency graph)
 *   - WHERE the important stuff is (entry points, key abstractions)
 *   - WHO calls whom (top-level call flow)
 *   - WHAT patterns are used (design patterns, conventions)
 *
 * v1.14.0+
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { relative, basename, dirname, extname, join, resolve } from 'node:path';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import type { KnowledgeGraph } from '../knowledge-graph/graph.js';
import type { GraphNode, GraphEdge } from '../types.js';
import type { MindMapConfig } from '../types.js';
import type { ITokenEstimator } from './advanced-tools.js';

// ── Helpers ─────────────────────────────────────────────────

const defaultEstimator: ITokenEstimator = {
  estimate: (s: string) => Math.ceil(s.length / 4),
};

function ok(data: unknown, estimator: ITokenEstimator): string {
  const json = JSON.stringify(data, null, 2);
  const tokens = estimator.estimate(json);
  return JSON.stringify({ success: true, data, tokenCount: tokens });
}

function fail(message: string): string {
  return JSON.stringify({ success: false, error: message });
}

function mcpText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.nuxt',
  'target', 'bin', 'obj', '.vs', '.idea', '.vscode', 'vendor',
  'coverage', '.tox', '.eggs', '.cache', '.gradle',
]);

// ── Module Detection ────────────────────────────────────────

interface ModuleInfo {
  name: string;
  path: string;
  purpose: string;
  fileCount: number;
  publicSymbols: string[];
  dependencies: string[];  // other module names this depends on
  keyFiles: string[];
}

interface ComponentRelation {
  from: string;
  to: string;
  strength: number;  // number of cross-references
  type: 'imports' | 'calls' | 'extends' | 'implements';
}

interface ProjectMapResult {
  projectName: string;
  projectRoot: string;
  projectType: string;
  description: string;
  techStack: {
    languages: { name: string; files: number; percentage: number }[];
    frameworks: string[];
    buildTools: string[];
    runtime: string;
  };
  architecture: {
    pattern: string;  // MVC, layered, microservice, monolith, etc.
    modules: ModuleInfo[];
    relations: ComponentRelation[];
    layers: { name: string; modules: string[]; description: string }[];
  };
  entryPoints: { file: string; type: string; description: string }[];
  keyAbstractions: {
    classes: { name: string; file: string; methods: number; description: string }[];
    interfaces: { name: string; file: string; description: string }[];
    functions: { name: string; file: string; signature: string }[];
  };
  dataFlow: string[];  // human-readable data flow descriptions
  conventions: string[];  // detected coding conventions
  directoryMap: string;  // compact ASCII tree
  quickRef: string;  // AI-optimized quick reference card
}

// ── Framework Detection ─────────────────────────────────────

const FRAMEWORK_MARKERS: { files: string[]; deps: string[]; name: string }[] = [
  { files: ['next.config.js', 'next.config.ts', 'next.config.mjs'], deps: ['next'], name: 'Next.js' },
  { files: ['nuxt.config.ts', 'nuxt.config.js'], deps: ['nuxt'], name: 'Nuxt.js' },
  { files: ['angular.json'], deps: ['@angular/core'], name: 'Angular' },
  { files: ['vite.config.ts', 'vite.config.js'], deps: ['vite'], name: 'Vite' },
  { files: [], deps: ['react', 'react-dom'], name: 'React' },
  { files: [], deps: ['vue'], name: 'Vue.js' },
  { files: [], deps: ['svelte'], name: 'Svelte' },
  { files: [], deps: ['express'], name: 'Express.js' },
  { files: [], deps: ['fastify'], name: 'Fastify' },
  { files: [], deps: ['koa'], name: 'Koa' },
  { files: [], deps: ['nestjs', '@nestjs/core'], name: 'NestJS' },
  { files: [], deps: ['electron'], name: 'Electron' },
  { files: [], deps: ['django'], name: 'Django' },
  { files: [], deps: ['flask'], name: 'Flask' },
  { files: [], deps: ['fastapi'], name: 'FastAPI' },
  { files: ['Gemfile'], deps: ['rails'], name: 'Ruby on Rails' },
  { files: [], deps: ['spring-boot', 'spring-core'], name: 'Spring Boot' },
  { files: [], deps: ['wpf', 'WindowsBase'], name: 'WPF' },
  { files: [], deps: ['Xamarin.Forms'], name: 'Xamarin' },
  { files: [], deps: ['MAUI', 'Microsoft.Maui'], name: '.NET MAUI' },
];

const BUILD_TOOL_MARKERS: { files: string[]; name: string }[] = [
  { files: ['webpack.config.js', 'webpack.config.ts'], name: 'Webpack' },
  { files: ['rollup.config.js', 'rollup.config.ts'], name: 'Rollup' },
  { files: ['esbuild.config.js'], name: 'esbuild' },
  { files: ['tsconfig.json'], name: 'TypeScript' },
  { files: ['babel.config.js', '.babelrc'], name: 'Babel' },
  { files: ['Makefile'], name: 'Make' },
  { files: ['CMakeLists.txt'], name: 'CMake' },
  { files: ['build.gradle', 'build.gradle.kts'], name: 'Gradle' },
  { files: ['pom.xml'], name: 'Maven' },
  { files: ['Cargo.toml'], name: 'Cargo' },
  { files: ['go.mod'], name: 'Go Modules' },
  { files: ['Dockerfile'], name: 'Docker' },
  { files: ['docker-compose.yml', 'docker-compose.yaml'], name: 'Docker Compose' },
];

// ============================================================
// Registration
// ============================================================

export function registerProjectMapTool(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  server.tool(
    'mindmap_project_map',
    'Get a COMPLETE mental model of the entire project in ONE call. ' +
      'Returns the full architecture map: tech stack, modules, inter-module dependencies, ' +
      'entry points, key abstractions, data flow, conventions, and an AI-optimized quick-reference card. ' +
      'USE THIS FIRST before any other tool — it saves thousands of tokens vs reading files individually.',
    {
      projectPath: z.string().optional().describe('Project root path (defaults to configured root)'),
      detail: z.enum(['quick', 'standard', 'deep']).default('standard')
        .describe('Detail level: quick (~500 tokens), standard (~2000 tokens), deep (~5000 tokens)'),
      focus: z.string().optional()
        .describe('Optional focus area (e.g., "api", "auth", "database") to get deeper info on a specific module'),
    },
    async ({ projectPath, detail, focus }) => {
      try {
        const rootPath = projectPath ?? config.projectRoot;
        const stats = graph.getStats();
        const indexedFiles = graph.getIndexedFiles();

        // ── 1. Project Identity ──────────────────────────────
        const projectName = detectProjectName(rootPath);
        const projectType = detectProjectType(rootPath, indexedFiles);
        const description = generateProjectDescription(rootPath, projectType, stats);

        // ── 2. Tech Stack ────────────────────────────────────
        const languages = Object.entries(stats.languageBreakdown)
          .sort(([, a], [, b]) => b - a)
          .map(([name, files]) => ({
            name,
            files,
            percentage: Math.round((files / Math.max(stats.totalFiles, 1)) * 100),
          }));

        const frameworks = detectFrameworks(rootPath);
        const buildTools = detectBuildTools(rootPath);
        const runtime = detectRuntime(rootPath);

        // ── 3. Module Discovery ──────────────────────────────
        const modules = discoverModules(rootPath, indexedFiles, graph, config);
        const relations = discoverRelations(modules, graph, config);

        // ── 4. Architecture Pattern ──────────────────────────
        const archPattern = detectArchPattern(modules, indexedFiles, rootPath);
        const layers = detectLayers(modules, indexedFiles, rootPath);

        // ── 5. Entry Points ──────────────────────────────────
        const entryPoints = detectEntryPoints(indexedFiles, rootPath);

        // ── 6. Key Abstractions ──────────────────────────────
        const keyAbstractions = extractKeyAbstractions(graph, config, detail, focus);

        // ── 7. Data Flow ─────────────────────────────────────
        const dataFlow = inferDataFlow(modules, relations, entryPoints);

        // ── 8. Conventions ───────────────────────────────────
        const conventions = detectConventions(indexedFiles, rootPath, graph);

        // ── 9. Directory Map ─────────────────────────────────
        const maxDepth = detail === 'quick' ? 2 : detail === 'standard' ? 3 : 4;
        const directoryMap = buildDirectoryTree(rootPath, maxDepth);

        // ── 10. Quick Reference Card ─────────────────────────
        const quickRef = buildQuickRef(
          projectName, projectType, languages, frameworks,
          modules, entryPoints, archPattern, stats,
        );

        // ── Build Result ─────────────────────────────────────
        const result: ProjectMapResult = {
          projectName,
          projectRoot: rootPath,
          projectType,
          description,
          techStack: { languages, frameworks, buildTools, runtime },
          architecture: { pattern: archPattern, modules, relations, layers },
          entryPoints,
          keyAbstractions,
          dataFlow,
          conventions,
          directoryMap,
          quickRef,
        };

        // If focus specified, add deep-dive on that area
        if (focus) {
          const focusModule = modules.find(m =>
            m.name.toLowerCase().includes(focus.toLowerCase()) ||
            m.purpose.toLowerCase().includes(focus.toLowerCase())
          );
          if (focusModule) {
            (result as any).focusArea = buildModuleDeepDive(focusModule, graph, config);
          }
        }

        // Trim based on detail level
        if (detail === 'quick') {
          return mcpText(ok({
            quickRef: result.quickRef,
            directoryMap: result.directoryMap,
            modules: result.architecture.modules.map(m => ({
              name: m.name, purpose: m.purpose, fileCount: m.fileCount,
            })),
            entryPoints: result.entryPoints.slice(0, 5),
            tokensSaved: `~${Math.round(stats.totalNodes * 15)} tokens saved`,
          }, estimator));
        }

        if (detail === 'standard') {
          // Standard: everything except deep abstractions
          const standardResult = { ...result };
          standardResult.keyAbstractions = {
            classes: result.keyAbstractions.classes.slice(0, 10),
            interfaces: result.keyAbstractions.interfaces.slice(0, 5),
            functions: result.keyAbstractions.functions.slice(0, 10),
          };
          standardResult.architecture.relations = result.architecture.relations.slice(0, 20);
          return mcpText(ok(standardResult, estimator));
        }

        // Deep: everything
        return mcpText(ok(result, estimator));

      } catch (err: unknown) {
        return mcpText(fail(`Project map failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );
}

// ============================================================
// Helper Functions
// ============================================================

function detectProjectName(rootPath: string): string {
  // Try package.json first
  try {
    const pkg = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf-8'));
    if (pkg.name) return pkg.name;
  } catch { /* ignore */ }

  // Try .csproj
  try {
    const entries = readdirSync(rootPath);
    const csproj = entries.find(e => e.endsWith('.csproj'));
    if (csproj) return csproj.replace('.csproj', '');
  } catch { /* ignore */ }

  // Try Cargo.toml
  try {
    const cargo = readFileSync(join(rootPath, 'Cargo.toml'), 'utf-8');
    const match = cargo.match(/name\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch { /* ignore */ }

  // Try go.mod
  try {
    const gomod = readFileSync(join(rootPath, 'go.mod'), 'utf-8');
    const match = gomod.match(/^module\s+(.+)$/m);
    if (match) return match[1].trim().split('/').pop()!;
  } catch { /* ignore */ }

  return basename(rootPath);
}

function detectProjectType(rootPath: string, indexedFiles: string[]): string {
  const markers: [string[], string][] = [
    [['package.json'], 'node'],
    [['tsconfig.json'], 'typescript'],
    [['*.csproj', '*.sln'], 'dotnet'],
    [['Cargo.toml'], 'rust'],
    [['go.mod'], 'go'],
    [['requirements.txt', 'setup.py', 'pyproject.toml'], 'python'],
    [['build.gradle', 'pom.xml'], 'java'],
    [['Gemfile'], 'ruby'],
    [['Package.swift'], 'swift'],
  ];

  const types: string[] = [];
  for (const [files, type] of markers) {
    for (const f of files) {
      if (f.includes('*')) {
        try {
          const ext = f.replace('*', '');
          if (readdirSync(rootPath).some(e => e.endsWith(ext))) types.push(type);
        } catch { /* ignore */ }
      } else {
        if (existsSync(join(rootPath, f))) types.push(type);
      }
    }
  }

  // Also detect from file extensions
  const extCounts: Record<string, number> = {};
  for (const f of indexedFiles) {
    const ext = extname(f).toLowerCase();
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }

  if (extCounts['.xaml'] && extCounts['.cs']) types.push('wpf');
  if (extCounts['.razor'] || extCounts['.cshtml']) types.push('asp.net');

  return [...new Set(types)].join('+') || 'unknown';
}

function generateProjectDescription(rootPath: string, projectType: string, stats: any): string {
  // Try to read README or description from package.json
  try {
    const pkg = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf-8'));
    if (pkg.description) return pkg.description;
  } catch { /* ignore */ }

  try {
    const readme = readFileSync(join(rootPath, 'README.md'), 'utf-8');
    // Get first paragraph
    const firstPara = readme.split('\n\n')[1]?.trim();
    if (firstPara && firstPara.length < 200) return firstPara;
  } catch { /* ignore */ }

  return `${projectType} project with ${stats.totalFiles} files and ${stats.totalNodes} symbols`;
}

function detectFrameworks(rootPath: string): string[] {
  const found: string[] = [];
  const deps = readDeps(rootPath);

  for (const fw of FRAMEWORK_MARKERS) {
    // Check marker files
    if (fw.files.some(f => existsSync(join(rootPath, f)))) {
      found.push(fw.name);
      continue;
    }
    // Check dependencies
    if (fw.deps.some(d => deps.has(d))) {
      found.push(fw.name);
    }
  }

  return found;
}

function detectBuildTools(rootPath: string): string[] {
  const found: string[] = [];
  for (const bt of BUILD_TOOL_MARKERS) {
    if (bt.files.some(f => existsSync(join(rootPath, f)))) {
      found.push(bt.name);
    }
  }
  return found;
}

function detectRuntime(rootPath: string): string {
  if (existsSync(join(rootPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf-8'));
      if (pkg.engines?.node) return `Node.js ${pkg.engines.node}`;
    } catch { /* ignore */ }
    return 'Node.js';
  }
  if (existsSync(join(rootPath, 'go.mod'))) return 'Go';
  if (existsSync(join(rootPath, 'Cargo.toml'))) return 'Rust';
  try {
    if (readdirSync(rootPath).some(e => e.endsWith('.csproj') || e.endsWith('.sln'))) return '.NET';
  } catch { /* ignore */ }
  if (existsSync(join(rootPath, 'requirements.txt'))) return 'Python';
  return 'unknown';
}

function readDeps(rootPath: string): Set<string> {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf-8'));
    for (const d of Object.keys(pkg.dependencies || {})) deps.add(d);
    for (const d of Object.keys(pkg.devDependencies || {})) deps.add(d);
  } catch { /* ignore */ }
  return deps;
}

// ── Module Discovery ────────────────────────────────────────

function discoverModules(
  rootPath: string,
  indexedFiles: string[],
  graph: KnowledgeGraph,
  config: MindMapConfig,
): ModuleInfo[] {
  // Group files by top-level directory
  const dirGroups = new Map<string, string[]>();

  for (const f of indexedFiles) {
    const rel = relative(rootPath, f).replace(/\\/g, '/');
    const parts = rel.split('/');
    // Use top 2 levels as module boundary
    const moduleDir = parts.length > 1 ? parts[0] : '.';
    if (!dirGroups.has(moduleDir)) dirGroups.set(moduleDir, []);
    dirGroups.get(moduleDir)!.push(f);
  }

  const modules: ModuleInfo[] = [];

  for (const [dirName, files] of dirGroups) {
    if (dirName === '.' && files.length < 3) continue;

    // Get public symbols from this module
    const publicSymbols: string[] = [];
    const allSymbols = new Set<string>();
    for (const f of files.slice(0, 50)) {  // Cap to prevent slowness
      const nodes = graph.getNodesForFile(f);
      for (const n of nodes) {
        allSymbols.add(n.id);
        if (n.isExported || n.visibility === 'public') {
          publicSymbols.push(n.qualifiedName || n.name);
        }
      }
    }

    // Find key files (entry points, index files, etc.)
    const keyFiles = files
      .filter(f => {
        const name = basename(f).toLowerCase();
        return name.startsWith('index') || name.startsWith('main') ||
               name.startsWith('app') || name.startsWith('mod') ||
               name === 'lib.rs' || name === 'init.py' || name === '__init__.py';
      })
      .map(f => relative(rootPath, f).replace(/\\/g, '/'))
      .slice(0, 5);

    const purpose = inferModulePurpose(dirName, files, graph);

    modules.push({
      name: dirName === '.' ? basename(rootPath) : dirName,
      path: dirName,
      purpose,
      fileCount: files.length,
      publicSymbols: publicSymbols.slice(0, 15),
      dependencies: [],  // filled in by discoverRelations
      keyFiles,
    });
  }

  // Sort by file count desc
  return modules.sort((a, b) => b.fileCount - a.fileCount);
}

function inferModulePurpose(dirName: string, files: string[], graph: KnowledgeGraph): string {
  const name = dirName.toLowerCase();

  // Common directory name patterns
  const purposes: Record<string, string> = {
    'src': 'Source code',
    'lib': 'Library/shared code',
    'api': 'API endpoints/routes',
    'routes': 'URL routing',
    'controllers': 'Request handlers (MVC controllers)',
    'models': 'Data models/entities',
    'views': 'UI views/templates',
    'components': 'UI components',
    'pages': 'Page-level components',
    'utils': 'Utility/helper functions',
    'helpers': 'Helper functions',
    'services': 'Business logic services',
    'middleware': 'Middleware/interceptors',
    'hooks': 'React/framework hooks',
    'store': 'State management',
    'stores': 'State management stores',
    'reducers': 'Redux reducers',
    'actions': 'Redux/state actions',
    'types': 'Type definitions',
    'interfaces': 'Interface definitions',
    'config': 'Configuration',
    'constants': 'Constants/enums',
    'tests': 'Test files',
    'test': 'Test files',
    '__tests__': 'Test files',
    'spec': 'Test specifications',
    'styles': 'Stylesheets',
    'css': 'Stylesheets',
    'assets': 'Static assets',
    'public': 'Public static files',
    'static': 'Static files',
    'migrations': 'Database migrations',
    'schemas': 'Data schemas',
    'db': 'Database layer',
    'database': 'Database layer',
    'auth': 'Authentication/authorization',
    'security': 'Security module',
    'i18n': 'Internationalization',
    'locales': 'Localization files',
    'scripts': 'Build/utility scripts',
    'tools': 'Developer tools',
    'plugins': 'Plugin/extension system',
    'core': 'Core business logic',
    'domain': 'Domain model',
    'infra': 'Infrastructure layer',
    'infrastructure': 'Infrastructure layer',
    'common': 'Shared/common code',
    'shared': 'Shared across modules',
    'features': 'Feature modules',
    'modules': 'Application modules',
    'handlers': 'Event/request handlers',
    'workers': 'Background workers',
    'jobs': 'Background jobs',
    'queues': 'Message queues',
    'events': 'Event system',
    'commands': 'CLI commands',
    'cli': 'Command-line interface',
    'docs': 'Documentation',
    'knowledge-graph': 'Knowledge graph/data model',
    'parsers': 'Code/data parsers',
  };

  if (purposes[name]) return purposes[name];

  // Try to infer from file contents
  const exts = new Set(files.map(f => extname(f).toLowerCase()));
  if (exts.has('.test.ts') || exts.has('.spec.ts') || exts.has('.test.js')) return 'Test files';
  if (exts.has('.css') || exts.has('.scss') || exts.has('.less')) return 'Stylesheets';
  if (exts.has('.html') || exts.has('.htm')) return 'HTML templates';

  // Try from symbol types
  let classCount = 0, funcCount = 0, interfaceCount = 0;
  for (const f of files.slice(0, 10)) {
    for (const n of graph.getNodesForFile(f)) {
      if (n.type === 'class') classCount++;
      if (n.type === 'function') funcCount++;
      if (n.type === 'interface') interfaceCount++;
    }
  }

  if (interfaceCount > classCount) return 'Type definitions/interfaces';
  if (classCount > funcCount * 2) return 'Class-based module';

  return `Module (${files.length} files)`;
}

// ── Relations ───────────────────────────────────────────────

function discoverRelations(
  modules: ModuleInfo[],
  graph: KnowledgeGraph,
  config: MindMapConfig,
): ComponentRelation[] {
  const relations: ComponentRelation[] = [];
  const moduleByFile = new Map<string, string>();

  // Map each file to its module
  for (const mod of modules) {
    const rootPath = config.projectRoot;
    const indexedFiles = graph.getIndexedFiles();
    for (const f of indexedFiles) {
      const rel = relative(rootPath, f).replace(/\\/g, '/');
      const parts = rel.split('/');
      const moduleDir = parts.length > 1 ? parts[0] : '.';
      const modName = moduleDir === '.' ? basename(rootPath) : moduleDir;
      moduleByFile.set(f, modName);
    }
  }

  // Count cross-module edges
  const crossRefs = new Map<string, { count: number; types: Set<string> }>();
  const allNodes = graph.getAllNodes();

  // Sample nodes (cap at 500 to prevent slowness)
  const sampledNodes = allNodes.length > 500
    ? allNodes.filter((_, i) => i % Math.ceil(allNodes.length / 500) === 0)
    : allNodes;

  for (const node of sampledNodes) {
    const fromModule = moduleByFile.get(node.filePath);
    if (!fromModule) continue;

    const outEdges = graph.getOutEdges(node.id);
    for (const edge of outEdges) {
      const targetNode = graph.getNode(edge.targetId);
      if (!targetNode) continue;
      const toModule = moduleByFile.get(targetNode.filePath);
      if (!toModule || toModule === fromModule) continue;

      const key = `${fromModule}->${toModule}`;
      if (!crossRefs.has(key)) crossRefs.set(key, { count: 0, types: new Set() });
      const ref = crossRefs.get(key)!;
      ref.count++;
      ref.types.add(edge.type);
    }
  }

  // Convert to relations
  for (const [key, ref] of crossRefs) {
    const [from, to] = key.split('->');
    const type = ref.types.has('calls') ? 'calls'
      : ref.types.has('extends') ? 'extends'
      : ref.types.has('implements') ? 'implements'
      : 'imports';

    relations.push({ from, to, strength: ref.count, type });
  }

  // Update module dependencies
  for (const rel of relations) {
    const mod = modules.find(m => m.name === rel.from);
    if (mod && !mod.dependencies.includes(rel.to)) {
      mod.dependencies.push(rel.to);
    }
  }

  return relations.sort((a, b) => b.strength - a.strength);
}

// ── Architecture Detection ──────────────────────────────────

function detectArchPattern(modules: ModuleInfo[], indexedFiles: string[], rootPath: string): string {
  const moduleNames = new Set(modules.map(m => m.name.toLowerCase()));

  // MVC
  if (moduleNames.has('models') && moduleNames.has('views') && moduleNames.has('controllers'))
    return 'MVC (Model-View-Controller)';

  // MVVM
  if (moduleNames.has('models') && moduleNames.has('views') && moduleNames.has('viewmodels'))
    return 'MVVM (Model-View-ViewModel)';

  // Clean Architecture
  if (moduleNames.has('domain') && moduleNames.has('infrastructure') && moduleNames.has('application'))
    return 'Clean Architecture';

  // Layered
  if (moduleNames.has('api') && moduleNames.has('services') && moduleNames.has('data'))
    return 'Layered Architecture';

  // Feature-based
  if (moduleNames.has('features') || moduleNames.has('modules'))
    return 'Feature-based Architecture';

  // Component-based (frontend)
  if (moduleNames.has('components') && (moduleNames.has('pages') || moduleNames.has('views')))
    return 'Component-based Architecture';

  // Simple (flat)
  if (modules.length <= 2)
    return 'Simple/Flat Architecture';

  // Library
  if (moduleNames.has('lib') && modules.length <= 4)
    return 'Library Architecture';

  return 'Modular Architecture';
}

function detectLayers(modules: ModuleInfo[], indexedFiles: string[], rootPath: string): { name: string; modules: string[]; description: string }[] {
  const layers: { name: string; modules: string[]; description: string }[] = [];
  const moduleNames = modules.map(m => m.name.toLowerCase());

  // Presentation layer
  const presentationModules = modules.filter(m => {
    const n = m.name.toLowerCase();
    return ['views', 'components', 'pages', 'ui', 'templates', 'layouts', 'screens'].includes(n);
  });
  if (presentationModules.length > 0) {
    layers.push({
      name: 'Presentation',
      modules: presentationModules.map(m => m.name),
      description: 'UI components, pages, and templates',
    });
  }

  // Application/Business layer
  const businessModules = modules.filter(m => {
    const n = m.name.toLowerCase();
    return ['services', 'controllers', 'handlers', 'core', 'domain', 'application', 'features'].includes(n);
  });
  if (businessModules.length > 0) {
    layers.push({
      name: 'Business Logic',
      modules: businessModules.map(m => m.name),
      description: 'Core business rules, services, and controllers',
    });
  }

  // Data/Infrastructure layer
  const dataModules = modules.filter(m => {
    const n = m.name.toLowerCase();
    return ['models', 'data', 'db', 'database', 'repositories', 'infra', 'infrastructure', 'migrations'].includes(n);
  });
  if (dataModules.length > 0) {
    layers.push({
      name: 'Data/Infrastructure',
      modules: dataModules.map(m => m.name),
      description: 'Data models, database, and external integrations',
    });
  }

  // Shared/Utils layer
  const sharedModules = modules.filter(m => {
    const n = m.name.toLowerCase();
    return ['utils', 'helpers', 'common', 'shared', 'lib', 'types', 'config', 'constants'].includes(n);
  });
  if (sharedModules.length > 0) {
    layers.push({
      name: 'Shared/Utilities',
      modules: sharedModules.map(m => m.name),
      description: 'Shared utilities, type definitions, and configuration',
    });
  }

  return layers;
}

// ── Entry Points ────────────────────────────────────────────

function detectEntryPoints(indexedFiles: string[], rootPath: string): { file: string; type: string; description: string }[] {
  const entryPoints: { file: string; type: string; description: string }[] = [];
  const seen = new Set<string>();

  const patterns: [RegExp, string, string][] = [
    [/[/\\]index\.(ts|js|tsx|jsx|mjs)$/, 'main', 'Application entry point'],
    [/[/\\]main\.(ts|js|py|go|rs|java)$/, 'main', 'Application main file'],
    [/[/\\]app\.(ts|js|tsx|jsx|py)$/, 'app', 'Application bootstrap'],
    [/[/\\]App\.(tsx|jsx|vue|svelte)$/, 'app', 'Root application component'],
    [/[/\\]server\.(ts|js|py)$/, 'server', 'Server entry point'],
    [/[/\\]Program\.cs$/, 'main', '.NET program entry point'],
    [/[/\\]Startup\.cs$/, 'startup', '.NET startup configuration'],
    [/[/\\]App\.xaml\.cs$/, 'app', 'WPF application entry point'],
    [/[/\\]MainWindow\.xaml\.cs$/, 'ui', 'Main window (WPF)'],
    [/[/\\]manage\.py$/, 'cli', 'Django management script'],
    [/[/\\]wsgi\.py$/, 'server', 'WSGI server entry'],
    [/[/\\]asgi\.py$/, 'server', 'ASGI server entry'],
    [/[/\\]lib\.rs$/, 'lib', 'Rust library crate root'],
    [/[/\\]mod\.rs$/, 'module', 'Rust module root'],
    [/[/\\]cmd[/\\].*\.go$/, 'cli', 'Go CLI command'],
    [/[/\\]routes?\.(ts|js|py)$/i, 'routing', 'Route definitions'],
    [/[/\\]api[/\\].*\.(ts|js|py)$/, 'api', 'API endpoint'],
  ];

  for (const f of indexedFiles) {
    for (const [pattern, type, desc] of patterns) {
      if (pattern.test(f) && !seen.has(f)) {
        seen.add(f);
        entryPoints.push({
          file: relative(rootPath, f).replace(/\\/g, '/'),
          type,
          description: desc,
        });
        break;
      }
    }
  }

  return entryPoints.slice(0, 15);
}

// ── Key Abstractions ────────────────────────────────────────

function extractKeyAbstractions(
  graph: KnowledgeGraph,
  config: MindMapConfig,
  detail: string,
  focus?: string,
): ProjectMapResult['keyAbstractions'] {
  const allNodes = graph.getAllNodes();
  const limit = detail === 'deep' ? 20 : detail === 'standard' ? 10 : 5;

  // Classes: sorted by edge count (most connected = most important)
  const classes = allNodes
    .filter(n => n.type === 'class' && (n.isExported || n.visibility === 'public'))
    .map(n => {
      const methods = allNodes.filter(m =>
        m.type === 'method' && m.filePath === n.filePath &&
        m.startLine >= n.startLine && m.endLine <= n.endLine
      ).length;
      return {
        name: n.qualifiedName || n.name,
        file: relative(config.projectRoot, n.filePath).replace(/\\/g, '/'),
        methods,
        description: n.docComment?.substring(0, 80) || `${n.name} class (${methods} methods)`,
      };
    })
    .sort((a, b) => b.methods - a.methods)
    .slice(0, limit);

  // Interfaces
  const interfaces = allNodes
    .filter(n => n.type === 'interface' && (n.isExported || n.visibility === 'public'))
    .map(n => ({
      name: n.qualifiedName || n.name,
      file: relative(config.projectRoot, n.filePath).replace(/\\/g, '/'),
      description: n.docComment?.substring(0, 80) || `${n.name} interface`,
    }))
    .slice(0, limit);

  // Top functions (exported, not methods)
  const functions = allNodes
    .filter(n => n.type === 'function' && (n.isExported || n.visibility === 'public'))
    .map(n => ({
      name: n.qualifiedName || n.name,
      file: relative(config.projectRoot, n.filePath).replace(/\\/g, '/'),
      signature: n.signature?.substring(0, 120) || n.name,
    }))
    .slice(0, limit);

  return { classes, interfaces, functions };
}

// ── Data Flow ───────────────────────────────────────────────

function inferDataFlow(
  modules: ModuleInfo[],
  relations: ComponentRelation[],
  entryPoints: { file: string; type: string; description: string }[],
): string[] {
  const flows: string[] = [];

  // Find entry -> service -> data flows
  const entryModules = new Set(entryPoints.map(e => {
    const parts = e.file.split('/');
    return parts.length > 1 ? parts[0] : '.';
  }));

  for (const rel of relations.slice(0, 10)) {
    if (entryModules.has(rel.from)) {
      flows.push(`${rel.from} → ${rel.to} (${rel.type}, ${rel.strength} refs)`);
    }
  }

  // Build chain: entry -> business -> data
  if (flows.length === 0 && relations.length > 0) {
    for (const rel of relations.slice(0, 5)) {
      flows.push(`${rel.from} → ${rel.to} (${rel.type})`);
    }
  }

  if (flows.length === 0) {
    flows.push('(Run mindmap_reindex first for data flow analysis)');
  }

  return flows;
}

// ── Conventions ─────────────────────────────────────────────

function detectConventions(indexedFiles: string[], rootPath: string, graph: KnowledgeGraph): string[] {
  const conventions: string[] = [];

  // File naming convention
  const names = indexedFiles.map(f => basename(f));
  const camelCase = names.filter(n => /^[a-z][a-zA-Z]+\.\w+$/.test(n)).length;
  const kebabCase = names.filter(n => /^[a-z]+-[a-z][\w-]*\.\w+$/.test(n)).length;
  const pascalCase = names.filter(n => /^[A-Z][a-zA-Z]+\.\w+$/.test(n)).length;
  const snakeCase = names.filter(n => /^[a-z]+_[a-z][\w_]*\.\w+$/.test(n)).length;

  const max = Math.max(camelCase, kebabCase, pascalCase, snakeCase);
  if (max > names.length * 0.3) {
    if (camelCase === max) conventions.push('File naming: camelCase');
    if (kebabCase === max) conventions.push('File naming: kebab-case');
    if (pascalCase === max) conventions.push('File naming: PascalCase');
    if (snakeCase === max) conventions.push('File naming: snake_case');
  }

  // Module style
  if (existsSync(join(rootPath, 'tsconfig.json'))) conventions.push('TypeScript strict mode');
  if (existsSync(join(rootPath, '.eslintrc.js')) || existsSync(join(rootPath, '.eslintrc.json')) || existsSync(join(rootPath, 'eslint.config.js')))
    conventions.push('ESLint enforced');
  if (existsSync(join(rootPath, '.prettierrc')) || existsSync(join(rootPath, '.prettierrc.json')))
    conventions.push('Prettier formatting');
  if (existsSync(join(rootPath, '.editorconfig')))
    conventions.push('EditorConfig standards');

  // Check for test patterns
  const testFiles = indexedFiles.filter(f => f.includes('.test.') || f.includes('.spec.') || f.includes('__test'));
  if (testFiles.length > 0) {
    const ratio = Math.round((testFiles.length / indexedFiles.length) * 100);
    conventions.push(`Test coverage: ${testFiles.length} test files (${ratio}%)`);
  }

  // Export style
  const nodes = graph.getAllNodes();
  const exportedCount = nodes.filter(n => n.isExported).length;
  if (exportedCount > 0) {
    const exportRatio = Math.round((exportedCount / nodes.length) * 100);
    conventions.push(`Export ratio: ${exportRatio}% of symbols are exported`);
  }

  return conventions;
}

// ── Directory Tree ──────────────────────────────────────────

function buildDirectoryTree(rootPath: string, maxDepth: number): string {
  const lines: string[] = [];
  const rootName = basename(rootPath);
  lines.push(`${rootName}/`);
  buildTreeRecursive(rootPath, '', maxDepth, 0, lines);
  return lines.join('\n');
}

function buildTreeRecursive(dir: string, prefix: string, maxDepth: number, depth: number, lines: string[]): void {
  if (depth >= maxDepth) return;

  let entries: { name: string; isDir: boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map(e => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return;
  }

  // Cap entries to prevent huge trees
  const maxEntries = depth === 0 ? 30 : 15;
  const shown = entries.slice(0, maxEntries);
  const hidden = entries.length - shown.length;

  for (let i = 0; i < shown.length; i++) {
    const entry = shown[i];
    const isLast = i === shown.length - 1 && hidden === 0;
    const connector = isLast ? '└── ' : '├── ';
    const nextPrefix = isLast ? '    ' : '│   ';

    if (entry.isDir) {
      // Count files in this dir
      let fileCount = 0;
      try {
        fileCount = readdirSync(join(dir, entry.name)).filter(e => !e.startsWith('.')).length;
      } catch { /* ignore */ }
      lines.push(`${prefix}${connector}${entry.name}/ (${fileCount})`);
      buildTreeRecursive(join(dir, entry.name), prefix + nextPrefix, maxDepth, depth + 1, lines);
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }

  if (hidden > 0) {
    lines.push(`${prefix}└── ... +${hidden} more`);
  }
}

// ── Quick Reference Card ────────────────────────────────────

function buildQuickRef(
  name: string,
  type: string,
  languages: { name: string; files: number; percentage: number }[],
  frameworks: string[],
  modules: ModuleInfo[],
  entryPoints: { file: string; type: string; description: string }[],
  archPattern: string,
  stats: any,
): string {
  const lines: string[] = [];
  lines.push(`═══ ${name} ═══`);
  lines.push(`Type: ${type} | Architecture: ${archPattern}`);
  lines.push(`Stack: ${languages.map(l => `${l.name}(${l.percentage}%)`).join(', ')}`);
  if (frameworks.length > 0) lines.push(`Frameworks: ${frameworks.join(', ')}`);
  lines.push(`Size: ${stats.totalFiles} files, ${stats.totalNodes} symbols, ${stats.totalEdges} relationships`);
  lines.push('');

  lines.push('Modules:');
  for (const m of modules.slice(0, 10)) {
    const deps = m.dependencies.length > 0 ? ` → ${m.dependencies.slice(0, 3).join(', ')}` : '';
    lines.push(`  ${m.name}/ (${m.fileCount} files) — ${m.purpose}${deps}`);
  }
  lines.push('');

  if (entryPoints.length > 0) {
    lines.push('Entry Points:');
    for (const ep of entryPoints.slice(0, 5)) {
      lines.push(`  ${ep.file} (${ep.type})`);
    }
  }

  return lines.join('\n');
}

// ── Module Deep Dive ────────────────────────────────────────

function buildModuleDeepDive(mod: ModuleInfo, graph: KnowledgeGraph, config: MindMapConfig): any {
  const indexedFiles = graph.getIndexedFiles();
  const moduleFiles = indexedFiles.filter(f => {
    const rel = relative(config.projectRoot, f).replace(/\\/g, '/');
    return rel.startsWith(mod.path + '/') || (mod.path === '.' && !rel.includes('/'));
  });

  const allSymbols: { name: string; type: string; file: string; exported: boolean }[] = [];
  for (const f of moduleFiles.slice(0, 30)) {
    for (const n of graph.getNodesForFile(f)) {
      allSymbols.push({
        name: n.qualifiedName || n.name,
        type: n.type,
        file: relative(config.projectRoot, n.filePath).replace(/\\/g, '/'),
        exported: n.isExported || n.visibility === 'public',
      });
    }
  }

  return {
    module: mod.name,
    files: moduleFiles.map(f => relative(config.projectRoot, f).replace(/\\/g, '/')),
    symbols: allSymbols,
    exportedSymbols: allSymbols.filter(s => s.exported),
    internalSymbols: allSymbols.filter(s => !s.exported).length,
  };
}
