/**
 * AI Mind Map — Architecture Analysis
 *
 * Analyzes the structural architecture of a codebase by examining the knowledge
 * graph, file system patterns, and dependency manifests. Produces a comprehensive
 * report covering languages, packages, entry points, routes, hotspots, layers,
 * test coverage, dependencies, complexity metrics, and code patterns.
 *
 * Inspired by codebase-memory-mcp's `get_architecture` tool.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { KnowledgeGraph } from './graph.js';

// ============================================================
// Report Types
// ============================================================

/** Language distribution entry */
export interface LanguageInfo {
  language: string;
  fileCount: number;
  percentage: number;
}

/** Detected package/module manifest */
export interface PackageInfo {
  type: string;         // 'npm' | 'pip' | 'go' | 'rust' | 'dotnet' | etc.
  name: string;
  version: string | null;
  manifestPath: string;
}

/** Detected entry point */
export interface EntryPointInfo {
  filePath: string;
  name: string;
  type: 'main' | 'index' | 'cli' | 'server' | 'app' | 'config';
}

/** Detected HTTP route handler */
export interface RouteInfo {
  method: string;       // GET, POST, PUT, DELETE, etc.
  path: string;         // Route pattern (from route node name or signature)
  handler: string;      // Handler function name
  filePath: string;
}

/** Hotspot — highly connected node */
export interface HotspotInfo {
  nodeId: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  nodeType: string;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
}

/** Layer/module grouping */
export interface LayerInfo {
  name: string;
  pattern: string;
  fileCount: number;
  nodeCount: number;
  filePaths: string[];
}

/** Test coverage summary */
export interface TestCoverage {
  testFiles: number;
  sourceFiles: number;
  testRatio: number;      // testFiles / sourceFiles
  testNodeCount: number;   // Number of test/describe/it nodes
}

/** External dependency */
export interface DependencyInfo {
  name: string;
  version: string;
  type: 'production' | 'dev' | 'peer' | 'optional';
  ecosystem: string;     // 'npm' | 'pip' | 'go' | etc.
}

/** Complexity metrics */
export interface ComplexityMetrics {
  averageFunctionsPerFile: number;
  averageParametersPerFunction: number;
  maxFunctionsInFile: { filePath: string; count: number } | null;
  maxParametersInFunction: { name: string; filePath: string; count: number } | null;
  totalFunctions: number;
  totalClasses: number;
  totalInterfaces: number;
}

/** Code pattern analysis */
export interface CodePatterns {
  classHeavy: boolean;
  functionHeavy: boolean;
  asyncPrevalence: number;     // 0.0 to 1.0 — ratio of async functions
  staticMethodRatio: number;   // 0.0 to 1.0
  exportedRatio: number;       // 0.0 to 1.0
  averageVisibility: Record<string, number>;  // visibility → count
}

/** Complete architecture report */
export interface ArchitectureReport {
  /** Timestamp of the analysis */
  analyzedAt: number;
  /** Project root path */
  projectRoot: string;
  /** Language breakdown */
  languages: LanguageInfo[];
  /** Detected packages/manifests */
  packages: PackageInfo[];
  /** Detected entry points */
  entryPoints: EntryPointInfo[];
  /** Detected HTTP routes */
  routes: RouteInfo[];
  /** Top hotspot nodes (highest connectivity) */
  hotspots: HotspotInfo[];
  /** Architectural layers/module groupings */
  layers: LayerInfo[];
  /** Test coverage summary */
  testCoverage: TestCoverage;
  /** External dependencies */
  dependencies: DependencyInfo[];
  /** Complexity metrics */
  complexity: ComplexityMetrics;
  /** Code pattern analysis */
  codePatterns: CodePatterns;
  /** Total node and edge counts */
  graphStats: { totalNodes: number; totalEdges: number; totalFiles: number };
}

// ============================================================
// Well-Known Layer Patterns
// ============================================================

/**
 * Common architectural layer patterns to detect in directory structures.
 * Each entry maps a human-readable layer name to glob-like directory patterns.
 */
const LAYER_PATTERNS: { name: string; patterns: RegExp[] }[] = [
  { name: 'Controllers', patterns: [/[/\\]controllers?[/\\]/i, /[/\\]handlers?[/\\]/i, /[/\\]api[/\\]/i] },
  { name: 'Services', patterns: [/[/\\]services?[/\\]/i, /[/\\]providers?[/\\]/i] },
  { name: 'Models', patterns: [/[/\\]models?[/\\]/i, /[/\\]entities[/\\]/i, /[/\\]schemas?[/\\]/i] },
  { name: 'Repositories', patterns: [/[/\\]repositories[/\\]/i, /[/\\]repos?[/\\]/i, /[/\\]dao[/\\]/i, /[/\\]data[/\\]/i] },
  { name: 'Middleware', patterns: [/[/\\]middleware[/\\]/i, /[/\\]middlewares[/\\]/i] },
  { name: 'Routes', patterns: [/[/\\]routes?[/\\]/i, /[/\\]routing[/\\]/i] },
  { name: 'Utils', patterns: [/[/\\]utils?[/\\]/i, /[/\\]helpers?[/\\]/i, /[/\\]lib[/\\]/i, /[/\\]common[/\\]/i, /[/\\]shared[/\\]/i] },
  { name: 'Config', patterns: [/[/\\]config[/\\]/i, /[/\\]configuration[/\\]/i, /[/\\]settings[/\\]/i] },
  { name: 'Components', patterns: [/[/\\]components?[/\\]/i, /[/\\]widgets?[/\\]/i] },
  { name: 'Views', patterns: [/[/\\]views?[/\\]/i, /[/\\]pages?[/\\]/i, /[/\\]screens?[/\\]/i, /[/\\]templates?[/\\]/i] },
  { name: 'Hooks', patterns: [/[/\\]hooks?[/\\]/i] },
  { name: 'Store', patterns: [/[/\\]store[/\\]/i, /[/\\]stores?[/\\]/i, /[/\\]state[/\\]/i, /[/\\]redux[/\\]/i, /[/\\]vuex[/\\]/i] },
  { name: 'Types', patterns: [/[/\\]types?[/\\]/i, /[/\\]interfaces[/\\]/i, /[/\\]typings[/\\]/i] },
  { name: 'Tests', patterns: [/[/\\]tests?[/\\]/i, /[/\\]__tests__[/\\]/i, /[/\\]spec[/\\]/i] },
  { name: 'Migrations', patterns: [/[/\\]migrations?[/\\]/i, /[/\\]seeds?[/\\]/i] },
  { name: 'Assets', patterns: [/[/\\]assets?[/\\]/i, /[/\\]static[/\\]/i, /[/\\]public[/\\]/i] },
];

/**
 * Package manifest file names and their ecosystems.
 */
const MANIFEST_FILES: { filename: string; ecosystem: string }[] = [
  { filename: 'package.json', ecosystem: 'npm' },
  { filename: 'requirements.txt', ecosystem: 'pip' },
  { filename: 'pyproject.toml', ecosystem: 'pip' },
  { filename: 'setup.py', ecosystem: 'pip' },
  { filename: 'Pipfile', ecosystem: 'pip' },
  { filename: 'go.mod', ecosystem: 'go' },
  { filename: 'Cargo.toml', ecosystem: 'rust' },
  { filename: 'Gemfile', ecosystem: 'ruby' },
  { filename: 'pom.xml', ecosystem: 'maven' },
  { filename: 'build.gradle', ecosystem: 'gradle' },
  { filename: 'build.gradle.kts', ecosystem: 'gradle' },
  { filename: 'composer.json', ecosystem: 'php' },
  { filename: 'pubspec.yaml', ecosystem: 'dart' },
  { filename: 'mix.exs', ecosystem: 'elixir' },
  { filename: 'Package.swift', ecosystem: 'swift' },
  { filename: '*.csproj', ecosystem: 'dotnet' },
  { filename: '*.sln', ecosystem: 'dotnet' },
];

/**
 * Test file patterns for identifying test files.
 */
const TEST_FILE_PATTERNS = [
  /\.test\.[^.]+$/i,
  /\.spec\.[^.]+$/i,
  /[/\\]__tests__[/\\]/i,
  /[/\\]test[/\\]/i,
  /[/\\]tests[/\\]/i,
  /_test\.[^.]+$/i,
  /Test\.[^.]+$/i,
];

/**
 * Patterns for entry-point file detection.
 */
const ENTRY_POINT_PATTERNS: { pattern: RegExp; type: EntryPointInfo['type'] }[] = [
  { pattern: /[/\\]index\.[^/\\]+$/i, type: 'index' },
  { pattern: /[/\\]main\.[^/\\]+$/i, type: 'main' },
  { pattern: /[/\\]app\.[^/\\]+$/i, type: 'app' },
  { pattern: /[/\\]server\.[^/\\]+$/i, type: 'server' },
  { pattern: /[/\\]cli\.[^/\\]+$/i, type: 'cli' },
  { pattern: /[/\\]bin[/\\][^/\\]+$/i, type: 'cli' },
];

// ============================================================
// ArchitectureAnalyzer Class
// ============================================================

/**
 * Analyzes the architectural structure of a codebase by combining
 * knowledge graph queries with file system inspection.
 *
 * @example
 * ```ts
 * const analyzer = new ArchitectureAnalyzer(graph, '/path/to/project');
 * const report = analyzer.analyze();
 * console.log(report.languages);
 * console.log(report.hotspots);
 * ```
 */
export class ArchitectureAnalyzer {
  private graph: KnowledgeGraph;

  /**
   * Create a new ArchitectureAnalyzer.
   *
   * @param graph - A KnowledgeGraph instance to query
   */
  constructor(graph: KnowledgeGraph) {
    this.graph = graph;
  }

  /**
   * Run a full architecture analysis and return the report.
   *
   * @param projectRoot - Absolute path to the project root directory
   */
  analyze(projectRoot: string): ArchitectureReport {
    const stats = this.graph.getStats();
    const indexedFiles = this.graph.getIndexedFiles();

    return {
      analyzedAt: Date.now(),
      projectRoot,
      languages: this.analyzeLanguages(stats),
      packages: this.detectPackages(projectRoot),
      entryPoints: this.detectEntryPoints(indexedFiles),
      routes: this.detectRoutes(),
      hotspots: this.findHotspots(),
      layers: this.detectLayers(indexedFiles),
      testCoverage: this.analyzeTestCoverage(indexedFiles, stats),
      dependencies: this.parseDependencies(projectRoot),
      complexity: this.analyzeComplexity(stats, indexedFiles),
      codePatterns: this.analyzeCodePatterns(stats),
      graphStats: {
        totalNodes: stats.totalNodes,
        totalEdges: stats.totalEdges,
        totalFiles: stats.totalFiles,
      },
    };
  }

  // ============================================================
  // Analysis Methods
  // ============================================================

  /**
   * Analyze language distribution from the graph stats.
   */
  private analyzeLanguages(
    stats: ReturnType<KnowledgeGraph['getStats']>,
  ): LanguageInfo[] {
    const total = Object.values(stats.languageBreakdown).reduce((a, b) => a + b, 0);
    if (total === 0) return [];

    return Object.entries(stats.languageBreakdown)
      .map(([language, fileCount]) => ({
        language,
        fileCount,
        percentage: Math.round((fileCount / total) * 10000) / 100,
      }))
      .sort((a, b) => b.fileCount - a.fileCount);
  }

  /**
   * Detect package manifests in the project root.
   */
  private detectPackages(projectRoot: string): PackageInfo[] {
    const packages: PackageInfo[] = [];

    for (const manifest of MANIFEST_FILES) {
      // Handle glob-like patterns (*.csproj)
      if (manifest.filename.includes('*')) {
        try {
          const ext = manifest.filename.replace('*', '');
          const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(ext)) {
              packages.push({
                type: manifest.ecosystem,
                name: entry.name.replace(ext, ''),
                version: null,
                manifestPath: path.join(projectRoot, entry.name),
              });
            }
          }
        } catch {
          // Directory not readable
        }
        continue;
      }

      const manifestPath = path.join(projectRoot, manifest.filename);
      if (!this.fileExists(manifestPath)) continue;

      try {
        if (manifest.filename === 'package.json') {
          const content = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          packages.push({
            type: 'npm',
            name: content.name ?? path.basename(projectRoot),
            version: content.version ?? null,
            manifestPath,
          });
        } else if (manifest.filename === 'go.mod') {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const moduleMatch = content.match(/^module\s+(.+)$/m);
          packages.push({
            type: 'go',
            name: moduleMatch?.[1]?.trim() ?? path.basename(projectRoot),
            version: null,
            manifestPath,
          });
        } else if (manifest.filename === 'Cargo.toml') {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
          const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
          packages.push({
            type: 'rust',
            name: nameMatch?.[1] ?? path.basename(projectRoot),
            version: versionMatch?.[1] ?? null,
            manifestPath,
          });
        } else if (manifest.filename === 'pyproject.toml') {
          const content = fs.readFileSync(manifestPath, 'utf-8');
          const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
          const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
          packages.push({
            type: 'pip',
            name: nameMatch?.[1] ?? path.basename(projectRoot),
            version: versionMatch?.[1] ?? null,
            manifestPath,
          });
        } else {
          // Generic manifest — just record its existence
          packages.push({
            type: manifest.ecosystem,
            name: path.basename(projectRoot),
            version: null,
            manifestPath,
          });
        }
      } catch {
        // Failed to parse manifest — record it anyway
        packages.push({
          type: manifest.ecosystem,
          name: path.basename(projectRoot),
          version: null,
          manifestPath,
        });
      }
    }

    return packages;
  }

  /**
   * Detect entry point files among the indexed files.
   */
  private detectEntryPoints(indexedFiles: string[]): EntryPointInfo[] {
    const entryPoints: EntryPointInfo[] = [];
    const seen = new Set<string>();

    for (const filePath of indexedFiles) {
      for (const ep of ENTRY_POINT_PATTERNS) {
        if (ep.pattern.test(filePath) && !seen.has(filePath)) {
          seen.add(filePath);
          entryPoints.push({
            filePath,
            name: path.basename(filePath),
            type: ep.type,
          });
        }
      }
    }

    return entryPoints;
  }

  /**
   * Detect HTTP route handlers by looking for 'route' type nodes in the graph.
   */
  private detectRoutes(): RouteInfo[] {
    const routeNodes = this.graph.getNodesByType('route');
    const routes: RouteInfo[] = [];

    for (const node of routeNodes) {
      const routeInfo = this.parseRouteSignature(node.name, node.signature);
      routes.push({
        method: routeInfo.method,
        path: routeInfo.path,
        handler: node.qualifiedName,
        filePath: node.filePath,
      });
    }

    // Also scan for route-like patterns in function signatures
    const functions = this.graph.getNodesByType('function');
    for (const fn of functions) {
      if (this.isRouteHandler(fn.signature, fn.name)) {
        const routeInfo = this.parseRouteSignature(fn.name, fn.signature);
        routes.push({
          method: routeInfo.method,
          path: routeInfo.path,
          handler: fn.qualifiedName,
          filePath: fn.filePath,
        });
      }
    }

    return routes;
  }

  /**
   * Parse a route handler's name/signature to extract method and path.
   */
  private parseRouteSignature(
    name: string,
    signature: string,
  ): { method: string; path: string } {
    // Express-style: app.get('/path', handler) or router.post('/path', ...)
    const expressMatch = signature.match(
      /\.(get|post|put|delete|patch|options|head|all)\s*\(\s*['"]([^'"]+)['"]/i,
    );
    if (expressMatch) {
      return { method: expressMatch[1].toUpperCase(), path: expressMatch[2] };
    }

    // Decorator-style: @Get('/path') or @Route('GET', '/path')
    const decoratorMatch = signature.match(
      /@(Get|Post|Put|Delete|Patch|Options|Head)\s*\(\s*['"]([^'"]*)['"]/i,
    );
    if (decoratorMatch) {
      return { method: decoratorMatch[1].toUpperCase(), path: decoratorMatch[2] || '/' };
    }

    // Flask-style: @app.route('/path', methods=['GET'])
    const flaskMatch = signature.match(
      /route\s*\(\s*['"]([^'"]+)['"]/i,
    );
    if (flaskMatch) {
      return { method: 'GET', path: flaskMatch[1] };
    }

    // Fallback: use the name and guess
    const httpMethods = ['get', 'post', 'put', 'delete', 'patch'];
    for (const method of httpMethods) {
      if (name.toLowerCase().startsWith(method)) {
        return { method: method.toUpperCase(), path: `/${name}` };
      }
    }

    return { method: 'UNKNOWN', path: name };
  }

  /**
   * Heuristic: does this function signature look like a route handler?
   */
  private isRouteHandler(signature: string, name: string): boolean {
    const patterns = [
      /\.(get|post|put|delete|patch)\s*\(/i,
      /@(Get|Post|Put|Delete|Patch|Route)\s*\(/i,
      /route\s*\(\s*['"]/i,
      /\b(req|request)\s*,\s*(res|response)\b/i,
    ];
    return patterns.some(p => p.test(signature) || p.test(name));
  }

  /**
   * Find the top 10 most-connected nodes (highest total degree).
   */
  private findHotspots(limit: number = 10): HotspotInfo[] {
    const allEdges = this.graph.getAllEdges();

    // Count in-degree and out-degree for each node
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();

    for (const edge of allEdges) {
      outDegree.set(edge.sourceId, (outDegree.get(edge.sourceId) ?? 0) + 1);
      inDegree.set(edge.targetId, (inDegree.get(edge.targetId) ?? 0) + 1);
    }

    // Combine all node IDs
    const allIds = new Set(
      Array.from(inDegree.keys()).concat(Array.from(outDegree.keys())),
    );

    // Build degree entries
    const entries: { id: string; inDeg: number; outDeg: number; total: number }[] = [];
    allIds.forEach(id => {
      const inDeg = inDegree.get(id) ?? 0;
      const outDeg = outDegree.get(id) ?? 0;
      entries.push({ id, inDeg, outDeg, total: inDeg + outDeg });
    });

    // Sort by total degree descending, take top N
    entries.sort((a, b) => b.total - a.total);
    const topEntries = entries.slice(0, limit);

    // Fetch node details
    const nodeIds = topEntries.map(e => e.id);
    const nodes = this.graph.getNodesByIds(nodeIds);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const hotspots: HotspotInfo[] = [];
    for (const entry of topEntries) {
      const node = nodeMap.get(entry.id);
      if (!node) continue;
      hotspots.push({
        nodeId: entry.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        filePath: node.filePath,
        nodeType: node.type,
        inDegree: entry.inDeg,
        outDegree: entry.outDeg,
        totalDegree: entry.total,
      });
    }

    return hotspots;
  }

  /**
   * Detect architectural layers by matching file paths to known patterns.
   */
  private detectLayers(indexedFiles: string[]): LayerInfo[] {
    const layers: LayerInfo[] = [];

    for (const layerDef of LAYER_PATTERNS) {
      const matchingFiles = indexedFiles.filter(fp =>
        layerDef.patterns.some(p => p.test(fp)),
      );

      if (matchingFiles.length === 0) continue;

      // Count nodes in matching files
      let nodeCount = 0;
      for (const fp of matchingFiles) {
        const nodes = this.graph.getFileStructure(fp);
        nodeCount += nodes.filter(n => n.type !== 'file').length;
      }

      layers.push({
        name: layerDef.name,
        pattern: layerDef.patterns.map(p => p.source).join(' | '),
        fileCount: matchingFiles.length,
        nodeCount,
        filePaths: matchingFiles.slice(0, 20), // Cap to prevent huge lists
      });
    }

    return layers.sort((a, b) => b.fileCount - a.fileCount);
  }

  /**
   * Analyze test coverage by comparing test files to source files.
   */
  private analyzeTestCoverage(
    indexedFiles: string[],
    stats: ReturnType<KnowledgeGraph['getStats']>,
  ): TestCoverage {
    const testFiles = indexedFiles.filter(fp =>
      TEST_FILE_PATTERNS.some(p => p.test(fp)),
    );
    const sourceFiles = indexedFiles.filter(fp =>
      !TEST_FILE_PATTERNS.some(p => p.test(fp)),
    );

    const testNodeCount = (stats.nodesByType['test'] ?? 0);

    return {
      testFiles: testFiles.length,
      sourceFiles: sourceFiles.length,
      testRatio: sourceFiles.length > 0
        ? Math.round((testFiles.length / sourceFiles.length) * 100) / 100
        : 0,
      testNodeCount,
    };
  }

  /**
   * Parse external dependencies from package manifests.
   */
  private parseDependencies(projectRoot: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];

    // Try npm (package.json)
    const packageJsonPath = path.join(projectRoot, 'package.json');
    if (this.fileExists(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        this.extractNpmDeps(pkg.dependencies, 'production', deps);
        this.extractNpmDeps(pkg.devDependencies, 'dev', deps);
        this.extractNpmDeps(pkg.peerDependencies, 'peer', deps);
        this.extractNpmDeps(pkg.optionalDependencies, 'optional', deps);
      } catch {
        // Malformed package.json
      }
    }

    // Try pip (requirements.txt)
    const requirementsPath = path.join(projectRoot, 'requirements.txt');
    if (this.fileExists(requirementsPath)) {
      try {
        const content = fs.readFileSync(requirementsPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
          const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([><=!~]+\s*[\d.]+)?/);
          if (match) {
            deps.push({
              name: match[1],
              version: match[2]?.trim() ?? '*',
              type: 'production',
              ecosystem: 'pip',
            });
          }
        }
      } catch {
        // Malformed requirements.txt
      }
    }

    return deps;
  }

  /**
   * Extract npm dependencies from a dependency map.
   */
  private extractNpmDeps(
    depMap: Record<string, string> | undefined,
    type: DependencyInfo['type'],
    deps: DependencyInfo[],
  ): void {
    if (!depMap) return;
    for (const [name, version] of Object.entries(depMap)) {
      deps.push({ name, version, type, ecosystem: 'npm' });
    }
  }

  /**
   * Analyze complexity metrics from the knowledge graph.
   */
  private analyzeComplexity(
    stats: ReturnType<KnowledgeGraph['getStats']>,
    indexedFiles: string[],
  ): ComplexityMetrics {
    const totalFunctions = (stats.nodesByType['function'] ?? 0) + (stats.nodesByType['method'] ?? 0);
    const totalClasses = stats.nodesByType['class'] ?? 0;
    const totalInterfaces = stats.nodesByType['interface'] ?? 0;
    const totalFiles = stats.totalFiles;

    const averageFunctionsPerFile = totalFiles > 0
      ? Math.round((totalFunctions / totalFiles) * 100) / 100
      : 0;

    // Find max functions in a single file
    let maxFunctionsInFile: { filePath: string; count: number } | null = null;
    for (const fp of indexedFiles) {
      const nodes = this.graph.getFileStructure(fp);
      const fnCount = nodes.filter(n => n.type === 'function' || n.type === 'method').length;
      if (fnCount > 0 && (!maxFunctionsInFile || fnCount > maxFunctionsInFile.count)) {
        maxFunctionsInFile = { filePath: fp, count: fnCount };
      }
    }

    // Compute average parameters per function using all function/method nodes
    const allFunctions = [
      ...this.graph.getNodesByType('function'),
      ...this.graph.getNodesByType('method'),
    ];

    let totalParams = 0;
    let maxParams: { name: string; filePath: string; count: number } | null = null;

    for (const fn of allFunctions) {
      const paramCount = fn.parameters?.length ?? 0;
      totalParams += paramCount;
      if (!maxParams || paramCount > maxParams.count) {
        maxParams = { name: fn.qualifiedName, filePath: fn.filePath, count: paramCount };
      }
    }

    const averageParametersPerFunction = allFunctions.length > 0
      ? Math.round((totalParams / allFunctions.length) * 100) / 100
      : 0;

    return {
      averageFunctionsPerFile,
      averageParametersPerFunction,
      maxFunctionsInFile,
      maxParametersInFunction: maxParams,
      totalFunctions,
      totalClasses,
      totalInterfaces,
    };
  }

  /**
   * Analyze code patterns: class-heavy vs function-heavy, async prevalence, etc.
   */
  private analyzeCodePatterns(
    stats: ReturnType<KnowledgeGraph['getStats']>,
  ): CodePatterns {
    const totalFunctions = (stats.nodesByType['function'] ?? 0);
    const totalMethods = (stats.nodesByType['method'] ?? 0);
    const totalClasses = (stats.nodesByType['class'] ?? 0);
    const totalCallable = totalFunctions + totalMethods;

    const classHeavy = totalClasses > 0 && totalMethods > totalFunctions;
    const functionHeavy = totalFunctions > totalMethods;

    // Async prevalence: count async functions/methods
    const allCallable = [
      ...this.graph.getNodesByType('function'),
      ...this.graph.getNodesByType('method'),
    ];

    let asyncCount = 0;
    let staticCount = 0;
    let exportedCount = 0;
    const visibilityCounts: Record<string, number> = {};

    for (const node of allCallable) {
      if (node.isAsync) asyncCount++;
      if (node.isStatic) staticCount++;
      if (node.isExported) exportedCount++;
      visibilityCounts[node.visibility] = (visibilityCounts[node.visibility] ?? 0) + 1;
    }

    return {
      classHeavy,
      functionHeavy,
      asyncPrevalence: totalCallable > 0
        ? Math.round((asyncCount / totalCallable) * 100) / 100
        : 0,
      staticMethodRatio: totalCallable > 0
        ? Math.round((staticCount / totalCallable) * 100) / 100
        : 0,
      exportedRatio: totalCallable > 0
        ? Math.round((exportedCount / totalCallable) * 100) / 100
        : 0,
      averageVisibility: visibilityCounts,
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Check if a file exists (sync, swallows errors).
   */
  private fileExists(filePath: string): boolean {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }
}
