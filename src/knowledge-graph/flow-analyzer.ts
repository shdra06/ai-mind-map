/**
 * AI Mind Map — Flow Analyzer & Interaction Map
 *
 * Maps the BEHAVIORAL flow of an application:
 *   Button click → event handler → API call → DB write → UI update
 *
 * This goes beyond structural analysis (what calls what) to map the
 * full user-interaction pipeline:
 *   - UI events → handlers → side effects
 *   - API routes → controllers → services → data layer
 *   - State changes → re-renders → UI updates
 *   - Event emitters → listeners → cascading effects
 *
 * The AI agent can ask "what happens when the user clicks Save?"
 * and get the full pipeline without reading any code.
 */

import { readFileSync } from 'node:fs';
import { relative, basename, extname } from 'node:path';
import type {
  GraphNode,
  GraphEdge,
  NodeType,
  EdgeType,
} from '../types.js';
import { KnowledgeGraph } from './graph.js';

// ============================================================
// Flow Types
// ============================================================

/** A single step in a user-interaction pipeline */
export interface FlowStep {
  /** Position in the pipeline (0 = trigger) */
  order: number;
  /** What happens at this step */
  action: string;
  /** The layer this belongs to */
  layer: FlowLayer;
  /** File where this step lives */
  filePath: string;
  /** Function/method name */
  symbolName: string;
  /** The function signature */
  signature: string;
  /** Line number in source */
  line: number;
  /** What this step produces (output) */
  produces?: string;
  /** Node ID in the knowledge graph */
  nodeId?: string;
}

/** Application layers (for classifying each step) */
export type FlowLayer =
  | 'ui_event'       // Button click, form submit, etc.
  | 'ui_component'   // React/Vue component
  | 'event_handler'  // onClick, onChange, event listener
  | 'state_update'   // setState, dispatch, store.commit
  | 'api_call'       // fetch, axios, HTTP request
  | 'route'          // Express/FastAPI route definition
  | 'controller'     // Route handler / controller
  | 'service'        // Business logic layer
  | 'repository'     // Data access layer
  | 'database'       // Direct DB query
  | 'middleware'      // Express/Koa middleware
  | 'validator'       // Input validation
  | 'util'           // Utility function
  | 'unknown';

/** A complete interaction flow from trigger to final effect */
export interface InteractionFlow {
  /** Human-readable name: "Save Note", "Delete User", "Login" */
  name: string;
  /** The trigger (button, route, event) */
  trigger: string;
  /** Full pipeline of steps */
  steps: FlowStep[];
  /** Which files are touched in this flow */
  filesInvolved: string[];
  /** Risk level if this flow breaks */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** What data/state this flow modifies */
  sideEffects: string[];
}

/** A component's interaction map */
export interface ComponentMap {
  /** Component name */
  name: string;
  /** File path */
  filePath: string;
  /** Props/inputs this component accepts */
  inputs: Array<{ name: string; type: string }>;
  /** Events/actions this component can trigger */
  actions: Array<{
    trigger: string;      // "onClick", "onSubmit", etc.
    handler: string;      // function name
    flow: InteractionFlow;
  }>;
  /** State this component manages */
  state: string[];
  /** Child components it renders */
  children: string[];
  /** Data sources (API calls, store reads) */
  dataSources: string[];
}

/** Full application interaction map */
export interface AppInteractionMap {
  /** All detected routes with their full pipelines */
  routes: InteractionFlow[];
  /** All detected UI event handlers with pipelines */
  eventHandlers: InteractionFlow[];
  /** Component-level interaction maps */
  components: ComponentMap[];
  /** Layer summary: how many symbols per layer */
  layerSummary: Record<FlowLayer, number>;
  /** Files grouped by layer */
  filesByLayer: Record<string, FlowLayer>;
}

// ============================================================
// Pattern Detectors
// ============================================================

/** Patterns that identify each layer */
const LAYER_PATTERNS: Array<{ layer: FlowLayer; patterns: RegExp[] }> = [
  {
    layer: 'route',
    patterns: [
      /\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`]/,          // Express
      /router\.(get|post|put|delete|patch)/,                          // Express Router
      /app\.(get|post|put|delete|patch)/,                             // Express app
      /@(Get|Post|Put|Delete|Patch|All)\s*\(/,                        // NestJS decorators
      /@app\.(route|get|post|put|delete)\s*\(/,                       // Flask/FastAPI
      /@(api_view|action)\s*\(/,                                      // Django DRF
    ],
  },
  {
    layer: 'ui_event',
    patterns: [
      /on(Click|Change|Submit|Press|Focus|Blur|Drag|Drop|Key|Mouse|Touch|Scroll)/,
      /addEventListener\s*\(\s*['"`]/,
      /\$\.(on|click|submit|change|keydown|keyup)\s*\(/,              // jQuery
      /@click|@submit|@change|v-on:/,                                  // Vue
      /\(click\)|\(submit\)|\(change\)/,                               // Angular
      /on:click|on:submit|on:change/,                                  // Svelte
    ],
  },
  {
    layer: 'state_update',
    patterns: [
      /setState\s*\(/,                                                 // React class
      /useState|useReducer|useContext/,                                 // React hooks
      /dispatch\s*\(/,                                                  // Redux
      /store\.(commit|dispatch|state)\s*\(/,                           // Vuex
      /\$store\.(commit|dispatch)/,                                    // Vuex in components
      /writable\s*\(|derived\s*\(/,                                    // Svelte stores
      /signal\s*\(|computed\s*\(/,                                     // Angular signals / Solid
      /atom\s*\(|selector\s*\(/,                                       // Recoil/Jotai
      /createSlice|createAsyncThunk/,                                  // Redux Toolkit
    ],
  },
  {
    layer: 'api_call',
    patterns: [
      /fetch\s*\(\s*['"`]/,                                            // fetch API
      /axios\.(get|post|put|delete|patch|request)\s*\(/,               // Axios
      /\$http\.(get|post|put|delete)/,                                 // Angular $http
      /HttpClient/,                                                     // Angular HttpClient
      /useSWR|useQuery|useMutation/,                                   // React Query/SWR
      /api\.(get|post|put|delete|patch)\s*\(/,                         // custom API client
      /request\s*\(\s*['"`](GET|POST|PUT|DELETE)/,                     // generic HTTP
    ],
  },
  {
    layer: 'database',
    patterns: [
      /\.(find|findOne|findMany|create|update|delete|upsert|aggregate)\s*\(/,  // Prisma/Mongoose
      /\.(select|insert|update|delete|where|from)\s*\(/,               // Query builders
      /db\.(query|execute|prepare|run|all|get)\s*\(/,                  // SQLite/raw DB
      /Model\.(find|create|update|destroy)/,                           // Sequelize
      /getRepository|createQueryBuilder/,                              // TypeORM
      /SELECT\s|INSERT\s|UPDATE\s|DELETE\s/,                           // Raw SQL
      /collection\.(find|insert|update|delete)/,                       // MongoDB
    ],
  },
  {
    layer: 'middleware',
    patterns: [
      /app\.use\s*\(/,                                                 // Express middleware
      /router\.use\s*\(/,                                              // Express Router middleware
      /@UseGuards|@UseInterceptors|@UsePipes/,                         // NestJS
      /middleware\s*=\s*\[/,                                           // Django
    ],
  },
  {
    layer: 'validator',
    patterns: [
      /validate|sanitize|schema\.parse|Joi\.|yup\.|z\.object/,        // Validation
      /IsNotEmpty|IsEmail|IsString|MinLength/,                         // class-validator
      /body\(\s*['"`]|param\(\s*['"`]|query\(\s*['"`]/,               // express-validator
    ],
  },
  {
    layer: 'ui_component',
    patterns: [
      /function\s+\w+\s*\([^)]*\)\s*{[^}]*return\s*\(?</,            // React functional component
      /export\s+default\s+\{[^}]*template\s*:/,                       // Vue SFC
      /@Component\s*\(\s*{/,                                           // Angular component
      /React\.createElement|jsx|tsx/,                                   // React
    ],
  },
];

/** Patterns that identify "service" vs "controller" vs "repository" by file path */
const PATH_LAYER_PATTERNS: Array<{ layer: FlowLayer; patterns: RegExp[] }> = [
  { layer: 'controller', patterns: [/controller/i, /handler/i, /endpoint/i, /route/i] },
  { layer: 'service', patterns: [/service/i, /business/i, /logic/i, /use.?case/i, /manager/i] },
  { layer: 'repository', patterns: [/repo/i, /repository/i, /dao/i, /data.?access/i, /store/i, /dal/i] },
  { layer: 'middleware', patterns: [/middleware/i, /guard/i, /interceptor/i, /filter/i] },
  { layer: 'validator', patterns: [/valid/i, /schema/i, /dto/i] },
  { layer: 'ui_component', patterns: [/component/i, /view/i, /page/i, /screen/i, /widget/i] },
  { layer: 'util', patterns: [/util/i, /helper/i, /lib/i, /common/i, /shared/i] },
];

// ============================================================
// Flow Analyzer
// ============================================================

export class FlowAnalyzer {
  private readonly graph: KnowledgeGraph;
  private readonly projectRoot: string;

  constructor(graph: KnowledgeGraph, projectRoot: string) {
    this.graph = graph;
    this.projectRoot = projectRoot;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Build the complete interaction map for the application.
   */
  buildInteractionMap(): AppInteractionMap {
    const allNodes = this.getAllNodes();

    // Classify every file and symbol by layer
    const fileLayerMap = this.classifyFilesByLayer(allNodes);
    const layerSummary = this.buildLayerSummary(allNodes, fileLayerMap);

    // Detect all route definitions
    const routes = this.detectRoutes(allNodes, fileLayerMap);

    // Detect all event handlers in UI components
    const eventHandlers = this.detectEventHandlers(allNodes, fileLayerMap);

    // Build component maps
    const components = this.buildComponentMaps(allNodes, fileLayerMap);

    return {
      routes,
      eventHandlers,
      components,
      layerSummary,
      filesByLayer: fileLayerMap,
    };
  }

  /**
   * Trace a complete flow starting from a specific symbol.
   * "What happens when createNote() is called?"
   */
  traceFlow(startSymbol: string, maxDepth: number = 10): InteractionFlow {
    // Find the starting node
    const startNodes = this.graph.getNodesByName(startSymbol);
    if (startNodes.length === 0) {
      // Try search
      const searchResults = this.graph.search(startSymbol, 5);
      if (searchResults.length === 0) {
        return this.emptyFlow(`Symbol "${startSymbol}" not found`);
      }
      return this.traceFromNode(searchResults[0]!, maxDepth);
    }

    return this.traceFromNode(startNodes[0]!, maxDepth);
  }

  /**
   * Trace a flow starting from a route.
   * "What happens when someone hits POST /api/notes?"
   */
  traceRoute(routePattern: string): InteractionFlow {
    const allNodes = this.getAllNodes();
    const routeNode = allNodes.find(
      (n) => n.type === 'route' && n.name.includes(routePattern),
    );

    if (!routeNode) {
      // Search for the route pattern in signatures
      const searchResults = this.graph.search(routePattern, 10);
      const routeResult = searchResults.find(
        (n) => n.type === 'route' || n.type === 'function',
      );
      if (!routeResult) {
        return this.emptyFlow(`Route "${routePattern}" not found`);
      }
      return this.traceFromNode(routeResult, 10);
    }

    return this.traceFromNode(routeNode, 10);
  }

  /**
   * Classify a single file by its layer in the architecture.
   */
  classifyFile(filePath: string): FlowLayer {
    // First try content-based detection
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const { layer, patterns } of LAYER_PATTERNS) {
        for (const pattern of patterns) {
          if (pattern.test(content)) {
            return layer;
          }
        }
      }
    } catch {
      // File might not exist, fall through to path-based
    }

    // Then try path-based detection
    const relPath = relative(this.projectRoot, filePath);
    for (const { layer, patterns } of PATH_LAYER_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(relPath)) {
          return layer;
        }
      }
    }

    return 'unknown';
  }

  /**
   * Get a summary of how the app is structured by layers.
   */
  getLayerOverview(): Array<{
    layer: FlowLayer;
    fileCount: number;
    symbolCount: number;
    files: string[];
    keySymbols: string[];
  }> {
    const allNodes = this.getAllNodes();
    const fileLayerMap = this.classifyFilesByLayer(allNodes);

    // Group by layer
    const layerGroups = new Map<
      FlowLayer,
      { files: Set<string>; symbols: string[] }
    >();

    for (const node of allNodes) {
      const relPath = relative(this.projectRoot, node.filePath);
      const layer = fileLayerMap[relPath] ?? 'unknown';

      if (!layerGroups.has(layer)) {
        layerGroups.set(layer, { files: new Set(), symbols: [] });
      }
      const group = layerGroups.get(layer)!;
      group.files.add(relPath);
      if (node.type === 'function' || node.type === 'method' || node.type === 'class') {
        group.symbols.push(node.name);
      }
    }

    return Array.from(layerGroups.entries())
      .map(([layer, data]) => ({
        layer,
        fileCount: data.files.size,
        symbolCount: data.symbols.length,
        files: [...data.files].slice(0, 10),
        keySymbols: data.symbols.slice(0, 15),
      }))
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  // ── Private: Tracing ────────────────────────────────────────

  private traceFromNode(startNode: GraphNode, maxDepth: number): InteractionFlow {
    const steps: FlowStep[] = [];
    const visited = new Set<string>();
    const filesInvolved = new Set<string>();
    const sideEffects: string[] = [];

    // BFS through the call graph
    const queue: Array<{ node: GraphNode; depth: number }> = [
      { node: startNode, depth: 0 },
    ];

    while (queue.length > 0 && steps.length < 50) {
      const item = queue.shift()!;
      const { node, depth } = item;

      if (depth > maxDepth || visited.has(node.id)) continue;
      visited.add(node.id);

      const relPath = relative(this.projectRoot, node.filePath);
      const layer = this.classifySymbol(node, relPath);
      filesInvolved.add(relPath);

      // Detect side effects
      if (layer === 'database') {
        sideEffects.push(`DB: ${node.name} (${relPath})`);
      } else if (layer === 'state_update') {
        sideEffects.push(`State: ${node.name} (${relPath})`);
      } else if (layer === 'api_call') {
        sideEffects.push(`API: ${node.name} (${relPath})`);
      }

      steps.push({
        order: steps.length,
        action: this.describeAction(node, layer),
        layer,
        filePath: relPath,
        symbolName: node.name,
        signature: node.signature || `${node.name}()`,
        line: node.startLine,
        nodeId: node.id,
        produces: this.inferProduces(node, layer),
      });

      // Follow the call chain
      const callees = this.graph.findCallees(node.id);
      for (const callee of callees) {
        if (!visited.has(callee.id)) {
          queue.push({ node: callee, depth: depth + 1 });
        }
      }
    }

    // Determine risk level based on what the flow touches
    const riskLevel = this.assessRisk(steps, sideEffects);

    // Generate a meaningful name
    const name = this.generateFlowName(startNode, steps);

    return {
      name,
      trigger: `${startNode.name} (${relative(this.projectRoot, startNode.filePath)}:${startNode.startLine})`,
      steps,
      filesInvolved: [...filesInvolved],
      riskLevel,
      sideEffects,
    };
  }

  // ── Private: Detection ──────────────────────────────────────

  private detectRoutes(
    allNodes: GraphNode[],
    fileLayerMap: Record<string, FlowLayer>,
  ): InteractionFlow[] {
    const flows: InteractionFlow[] = [];

    // Find nodes that look like route handlers
    const routeNodes = allNodes.filter(
      (n) =>
        n.type === 'route' ||
        n.type === 'function' &&
          fileLayerMap[relative(this.projectRoot, n.filePath)] === 'route',
    );

    // Also find by signature patterns
    const httpPatterns = /\b(get|post|put|delete|patch)\b/i;
    const handlerNodes = allNodes.filter(
      (n) =>
        (n.type === 'function' || n.type === 'method') &&
        httpPatterns.test(n.name) &&
        !routeNodes.includes(n),
    );

    for (const node of [...routeNodes, ...handlerNodes].slice(0, 30)) {
      flows.push(this.traceFromNode(node, 8));
    }

    return flows;
  }

  private detectEventHandlers(
    allNodes: GraphNode[],
    _fileLayerMap: Record<string, FlowLayer>,
  ): InteractionFlow[] {
    const flows: InteractionFlow[] = [];
    const handlerPattern = /^(handle|on)[A-Z]/;

    const handlers = allNodes.filter(
      (n) =>
        (n.type === 'function' || n.type === 'method') &&
        handlerPattern.test(n.name),
    );

    for (const handler of handlers.slice(0, 30)) {
      flows.push(this.traceFromNode(handler, 8));
    }

    return flows;
  }

  private buildComponentMaps(
    allNodes: GraphNode[],
    fileLayerMap: Record<string, FlowLayer>,
  ): ComponentMap[] {
    const components: ComponentMap[] = [];

    const componentNodes = allNodes.filter(
      (n) =>
        n.type === 'component' ||
        n.type === 'class' &&
          fileLayerMap[relative(this.projectRoot, n.filePath)] === 'ui_component',
    );

    for (const comp of componentNodes.slice(0, 20)) {
      const relPath = relative(this.projectRoot, comp.filePath);

      // Find handlers in same file
      const sameFileNodes = allNodes.filter(
        (n) => n.filePath === comp.filePath,
      );
      const handlers = sameFileNodes.filter(
        (n) => /^(handle|on)[A-Z]/.test(n.name),
      );

      // Determine inputs from parameters
      const inputs = (comp.parameters ?? []).map((p) => ({
        name: p.name,
        type: p.type ?? 'unknown',
      }));

      // Build action flows for each handler
      const actions = handlers.map((h) => ({
        trigger: h.name.replace(/^handle/, 'on').replace(/^on/, 'on'),
        handler: h.name,
        flow: this.traceFromNode(h, 6),
      }));

      // Detect state
      const state: string[] = [];
      const statePattern = /useState|useReducer|this\.state/;
      try {
        const content = readFileSync(comp.filePath, 'utf-8');
        const stateMatches = content.match(
          /(?:const\s+\[(\w+),\s*set\w+\]|this\.state\.(\w+))/g,
        );
        if (stateMatches) {
          for (const m of stateMatches) {
            const varMatch = m.match(
              /const\s+\[(\w+)|this\.state\.(\w+)/,
            );
            if (varMatch) {
              state.push(varMatch[1] ?? varMatch[2] ?? m);
            }
          }
        }
      } catch {
        // Can't read file
      }

      // Find child components (calls to other components)
      const children: string[] = [];
      const callees = this.graph.findCallees(comp.id);
      for (const callee of callees) {
        if (
          callee.type === 'component' ||
          /^[A-Z]/.test(callee.name)
        ) {
          children.push(callee.name);
        }
      }

      // Find data sources
      const dataSources: string[] = [];
      for (const node of sameFileNodes) {
        const sig = node.signature || '';
        if (/fetch|axios|useQuery|useSWR|api\./i.test(sig) || /fetch|axios|useQuery|useSWR|api\./i.test(node.name)) {
          dataSources.push(node.name);
        }
      }

      components.push({
        name: comp.name,
        filePath: relPath,
        inputs,
        actions,
        state,
        children,
        dataSources,
      });
    }

    return components;
  }

  // ── Private: Classification ─────────────────────────────────

  private classifyFilesByLayer(allNodes: GraphNode[]): Record<string, FlowLayer> {
    const result: Record<string, FlowLayer> = {};
    const files = new Set(allNodes.map((n) => n.filePath));

    for (const filePath of files) {
      const relPath = relative(this.projectRoot, filePath);
      if (result[relPath]) continue;

      // Try path-based first (faster)
      let layer: FlowLayer = 'unknown';
      for (const { layer: l, patterns } of PATH_LAYER_PATTERNS) {
        if (patterns.some((p) => p.test(relPath))) {
          layer = l;
          break;
        }
      }

      // If still unknown, try content-based
      if (layer === 'unknown') {
        try {
          const content = readFileSync(filePath, 'utf-8');
          for (const { layer: l, patterns } of LAYER_PATTERNS) {
            if (patterns.some((p) => p.test(content))) {
              layer = l;
              break;
            }
          }
        } catch {
          // Can't read, keep unknown
        }
      }

      result[relPath] = layer;
    }

    return result;
  }

  private classifySymbol(node: GraphNode, relPath: string): FlowLayer {
    // Check node type first
    if (node.type === 'route') return 'route';
    if (node.type === 'component') return 'ui_component';
    if (node.type === 'hook') return 'state_update';

    // Check by name patterns
    if (/^(handle|on)[A-Z]/.test(node.name)) return 'event_handler';
    if (/^(use[A-Z])/.test(node.name)) return 'state_update';

    // Check by signature content
    const sig = (node.signature || '').toLowerCase();
    if (/\b(req\s*,\s*res|request\s*,\s*response|ctx)\b/.test(sig)) return 'controller';
    if (/\bdb\b|\bprisma\b|\bmodel\b|\brepository\b/i.test(sig)) return 'repository';

    // Check path-based
    for (const { layer, patterns } of PATH_LAYER_PATTERNS) {
      if (patterns.some((p) => p.test(relPath))) return layer;
    }

    return 'unknown';
  }

  private buildLayerSummary(
    allNodes: GraphNode[],
    fileLayerMap: Record<string, FlowLayer>,
  ): Record<FlowLayer, number> {
    const summary: Record<string, number> = {};

    for (const node of allNodes) {
      const relPath = relative(this.projectRoot, node.filePath);
      const layer = fileLayerMap[relPath] ?? 'unknown';
      summary[layer] = (summary[layer] ?? 0) + 1;
    }

    return summary as Record<FlowLayer, number>;
  }

  // ── Private: Helpers ────────────────────────────────────────

  private describeAction(node: GraphNode, layer: FlowLayer): string {
    const verb = {
      ui_event: 'triggers',
      ui_component: 'renders',
      event_handler: 'handles event via',
      state_update: 'updates state in',
      api_call: 'calls API via',
      route: 'routes to',
      controller: 'handles request in',
      service: 'processes in',
      repository: 'accesses data via',
      database: 'queries database in',
      middleware: 'passes through',
      validator: 'validates in',
      util: 'uses helper',
      unknown: 'executes',
    }[layer] ?? 'executes';

    return `${verb} ${node.name}()`;
  }

  private inferProduces(node: GraphNode, layer: FlowLayer): string | undefined {
    if (node.returnType && node.returnType !== 'void') {
      return node.returnType;
    }
    if (layer === 'database') return 'DB result';
    if (layer === 'api_call') return 'API response';
    if (layer === 'state_update') return 'Updated state';
    if (layer === 'ui_component') return 'JSX/HTML';
    if (layer === 'validator') return 'Validated data';
    return undefined;
  }

  private assessRisk(
    steps: FlowStep[],
    sideEffects: string[],
  ): 'low' | 'medium' | 'high' | 'critical' {
    const hasDatabaseWrite = sideEffects.some((e) => e.startsWith('DB:'));
    const hasApiCall = sideEffects.some((e) => e.startsWith('API:'));
    const fileCount = new Set(steps.map((s) => s.filePath)).size;

    if (hasDatabaseWrite && fileCount > 5) return 'critical';
    if (hasDatabaseWrite) return 'high';
    if (hasApiCall && fileCount > 3) return 'high';
    if (hasApiCall || fileCount > 3) return 'medium';
    return 'low';
  }

  private generateFlowName(startNode: GraphNode, steps: FlowStep[]): string {
    // Try to generate a meaningful name like "Save Note" or "Delete User"
    const name = startNode.name
      .replace(/^handle/, '')
      .replace(/^on/, '')
      .replace(/([A-Z])/g, ' $1')
      .trim();

    const hasDb = steps.some((s) => s.layer === 'database');
    const hasApi = steps.some((s) => s.layer === 'api_call');

    if (hasDb) return `${name} (→ DB)`;
    if (hasApi) return `${name} (→ API)`;
    return name;
  }

  private emptyFlow(reason: string): InteractionFlow {
    return {
      name: reason,
      trigger: 'unknown',
      steps: [],
      filesInvolved: [],
      riskLevel: 'low',
      sideEffects: [],
    };
  }

  private getAllNodes(): GraphNode[] {
    const ids = this.graph.getAllNodeIds();
    return ids
      .map((id) => this.graph.getNode(id))
      .filter((n): n is GraphNode => n !== null);
  }
}
