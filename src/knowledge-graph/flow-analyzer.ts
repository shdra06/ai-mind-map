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

/**
 * ── Multi-Signal Layer Classification Engine ──────────────────
 *
 * Instead of first-match-wins, we score every file across ALL layers
 * using multiple independent signals, then pick the highest score.
 *
 * Signals (weighted):
 *   1. Content patterns   (weight: 3) — regex on file body
 *   2. Path patterns      (weight: 2) — regex on file path/name
 *   3. Directory patterns  (weight: 2) — known folder names
 *   4. Import/Inheritance (weight: 4) — what the file imports or extends
 *   5. Symbol name hints  (weight: 1) — names of functions/classes in file
 */

interface LayerSignal {
  layer: FlowLayer;
  patterns: RegExp[];
  weight: number;
  source: 'content' | 'path' | 'directory' | 'import' | 'symbol_name';
}

/** All classification signals, organized by source */
const CLASSIFICATION_SIGNALS: LayerSignal[] = [
  // ────── CONTENT PATTERNS (weight: 3) ──────
  // Route definitions
  { source: 'content', weight: 3, layer: 'route', patterns: [
    /\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`]/, /router\.(get|post|put|delete|patch)/,
    /app\.(get|post|put|delete|patch)/, /@(Get|Post|Put|Delete|Patch|All)\s*\(/,
    /@app\.(route|get|post|put|delete)\s*\(/, /@(api_view|action)\s*\(/,
  ]},
  // UI events
  { source: 'content', weight: 3, layer: 'ui_event', patterns: [
    /on(Click|Change|Submit|Press|Focus|Blur|Drag|Drop|Key|Mouse|Touch|Scroll)/,
    /addEventListener\s*\(\s*['"`]/, /\$\.(on|click|submit|change|keydown|keyup)\s*\(/,
    /@click|@submit|@change|v-on:/, /\(click\)|\(submit\)|\(change\)/,
    /on:click|on:submit|on:change/,
    /_Click\b|_Loaded\b|_Closing\b|_Closed\b|_KeyDown\b|_KeyUp\b|_MouseDown\b|_MouseUp\b|_SelectionChanged\b|_TextChanged\b|_Checked\b|_Unchecked\b|_DragEnter\b|_Drop\b|_PreviewKeyDown\b|_GotFocus\b|_LostFocus\b|_SizeChanged\b|_Toggled\b/,
    /RoutedEventHandler|EventHandler|\+=.*EventHandler/,
  ]},
  // State management
  { source: 'content', weight: 3, layer: 'state_update', patterns: [
    /setState\s*\(/, /useState|useReducer|useContext/, /dispatch\s*\(/,
    /store\.(commit|dispatch|state)\s*\(/, /\$store\.(commit|dispatch)/,
    /writable\s*\(|derived\s*\(/, /signal\s*\(|computed\s*\(/,
    /atom\s*\(|selector\s*\(/, /createSlice|createAsyncThunk/,
    /INotifyPropertyChanged|OnPropertyChanged|RaisePropertyChanged/,
    /DependencyProperty\.Register|SetValue\(|GetValue\(/,
    /ObservableCollection|BindingList/,
  ]},
  // API/HTTP calls
  { source: 'content', weight: 3, layer: 'api_call', patterns: [
    /fetch\s*\(\s*['"`]/, /axios\.(get|post|put|delete|patch|request)\s*\(/,
    /\$http\.(get|post|put|delete)/, /HttpClient/,
    /useSWR|useQuery|useMutation/, /api\.(get|post|put|delete|patch)\s*\(/,
    /request\s*\(\s*['"`](GET|POST|PUT|DELETE)/,
    /WebClient|HttpWebRequest|RestClient|HttpRequestMessage/,
    /\.GetAsync\(|\.PostAsync\(|\.PutAsync\(|\.DeleteAsync\(/,
  ]},
  // Database
  { source: 'content', weight: 3, layer: 'database', patterns: [
    /\.(find|findOne|findMany|create|update|delete|upsert|aggregate)\s*\(/,
    /\.(select|insert|update|delete|where|from)\s*\(/, /db\.(query|execute|prepare|run|all|get)\s*\(/,
    /Model\.(find|create|update|destroy)/, /getRepository|createQueryBuilder/,
    /SELECT\s|INSERT\s|UPDATE\s|DELETE\s/, /collection\.(find|insert|update|delete)/,
    /SqlConnection|SqlCommand|DbContext|DbSet|ExecuteNonQuery|ExecuteReader|ExecuteScalar/,
    /SQLiteConnection|SQLiteCommand|DatabaseHelper/,
  ]},
  // Middleware
  { source: 'content', weight: 3, layer: 'middleware', patterns: [
    /app\.use\s*\(/, /router\.use\s*\(/, /@UseGuards|@UseInterceptors|@UsePipes/,
    /middleware\s*=\s*\[/,
  ]},
  // Validation
  { source: 'content', weight: 3, layer: 'validator', patterns: [
    /validate|sanitize|schema\.parse|Joi\.|yup\.|z\.object/,
    /IsNotEmpty|IsEmail|IsString|MinLength/, /body\(\s*['"`]|param\(\s*['"`]|query\(\s*['"`]/,
    /DataAnnotations|Required|StringLength|RegularExpression|Range\[/,
    /FluentValidation|AbstractValidator|RuleFor/,
  ]},
  // UI components
  { source: 'content', weight: 3, layer: 'ui_component', patterns: [
    /function\s+\w+\s*\([^)]*\)\s*{[^}]*return\s*\(?</,
    /export\s+default\s+\{[^}]*template\s*:/, /@Component\s*\(\s*{/,
    /React\.createElement|jsx|tsx/,
    /UserControl|Window|Page|ContentControl|ItemsControl|DependencyObject/,
    /partial class.*:.*Window|partial class.*:.*UserControl|partial class.*:.*Page/,
    /InitializeComponent\(\)/,
  ]},

  // ────── PATH PATTERNS (weight: 2) ──────
  { source: 'path', weight: 2, layer: 'ui_component', patterns: [/Window/i, /Control/i, /View(?!Model)/i, /Style/i, /Theme/i, /^App\./i, /\.xaml$/i] },
  { source: 'path', weight: 2, layer: 'controller', patterns: [/ViewModel/i, /EventHandler/i, /Interaction/i, /WndProc/i] },
  { source: 'path', weight: 2, layer: 'service', patterns: [/Manager/i, /Service/i, /Engine/i, /Provider/i, /Helper/i, /Tool/i, /Crypto/i, /Clock/i, /Secrets?/i, /Daemon/i, /Scheduler/i, /Discovery/i, /Auth/i] },
  { source: 'path', weight: 2, layer: 'database', patterns: [/Database/i, /Storage/i, /Cache/i, /Persist/i] },
  { source: 'path', weight: 2, layer: 'validator', patterns: [/Validator/i, /Converter/i] },
  { source: 'path', weight: 2, layer: 'util', patterns: [/Matcher/i, /Comparer/i, /Sorter/i, /Logger/i, /Profiler/i, /Tracker/i, /Queue/i, /Diagnostic/i, /Telemetry/i, /NativeMethods/i] },
  { source: 'path', weight: 2, layer: 'route', patterns: [/route/i, /endpoint/i] },
  { source: 'path', weight: 2, layer: 'middleware', patterns: [/middleware/i, /guard/i, /interceptor/i, /filter/i] },
  { source: 'path', weight: 2, layer: 'repository', patterns: [/repo(?:sitory)?/i, /dao/i, /data.?access/i, /dal/i] },

  // ────── DIRECTORY PATTERNS (weight: 2) ──────
  { source: 'directory', weight: 2, layer: 'controller', patterns: [/^controllers?\//i, /^handlers?\//i, /^viewmodels?\//i, /^ViewModels\//] },
  { source: 'directory', weight: 2, layer: 'service', patterns: [/^services?\//i, /^classes\//i, /^business\//i, /^logic\//i, /^managers?\//i] },
  { source: 'directory', weight: 2, layer: 'repository', patterns: [/^repositor(y|ies)\//i, /^data\//i, /^dal\//i, /^dao\//i, /^persistence\//i] },
  { source: 'directory', weight: 2, layer: 'ui_component', patterns: [/^components?\//i, /^views?\//i, /^pages?\//i, /^screens?\//i, /^widgets?\//i, /^windows?\//i, /^controls?\//i, /^styles?\//i, /^layouts?\//i, /^Windows\//] },
  { source: 'directory', weight: 2, layer: 'middleware', patterns: [/^middlewares?\//i, /^guards?\//i, /^interceptors?\//i, /^pipes?\//i] },
  { source: 'directory', weight: 2, layer: 'validator', patterns: [/^validators?\//i, /^schemas?\//i, /^dtos?\//i] },
  { source: 'directory', weight: 2, layer: 'util', patterns: [/^utils?\//i, /^helpers?\//i, /^lib\//i, /^common\//i, /^shared\//i, /^tools?\//i, /^Utils\//] },
  { source: 'directory', weight: 2, layer: 'route', patterns: [/^routes?\//i, /^api\//i, /^endpoints?\//i] },
  { source: 'directory', weight: 2, layer: 'database', patterns: [/^migrations?\//i, /^models?\//i, /^entities?\//i, /^seeds?\//i] },
  { source: 'directory', weight: 2, layer: 'ui_event', patterns: [/^events?\//i, /^listeners?\//i] },

  // ────── IMPORT / INHERITANCE PATTERNS (weight: 4 — strongest signal) ──────
  { source: 'import', weight: 4, layer: 'ui_component', patterns: [
    /:\s*Window\b|:\s*UserControl\b|:\s*Page\b|:\s*ContentPage\b/, // C#/WPF/MAUI inheritance
    /extends\s+(Component|React\.Component|PureComponent)\b/,       // React class components
    /extends\s+(StatelessWidget|StatefulWidget|State)\b/,           // Flutter/Dart
    /import\s+.*SwiftUI|import\s+.*UIKit/,                          // Swift UI frameworks
    /import\s+.*\b(react|vue|svelte|angular)\b/i,                   // JS UI frameworks
    /@Composable\b/,                                                 // Jetpack Compose (Kotlin)
  ]},
  { source: 'import', weight: 4, layer: 'controller', patterns: [
    /:\s*ViewModel\b|:\s*ObservableObject\b/,                       // C# MVVM
    /extends\s+ChangeNotifier\b/,                                    // Flutter
    /@Controller\b|@RestController\b/,                               // Spring/NestJS
    /class\s+\w+Controller\b/,                                       // *Controller naming convention
  ]},
  { source: 'import', weight: 4, layer: 'service', patterns: [
    /@Injectable\b|@Service\b/,                                      // NestJS/Spring/Angular
    /class\s+\w+(Service|Manager|Engine|Provider)\b/,                // Service naming convention
  ]},
  { source: 'import', weight: 4, layer: 'database', patterns: [
    /:\s*DbContext\b|:\s*DbSet\b/,                                  // Entity Framework
    /import\s+.*prisma|import\s+.*typeorm|import\s+.*sequelize/i,   // JS ORMs
    /@Entity\b|@Table\b|@Column\b/,                                  // ORM decorators
    /import\s+.*mongoose/i,                                          // MongoDB
    /import\s+.*sqlite|import\s+.*pg\b|import\s+.*mysql/i,          // DB drivers
  ]},
  { source: 'import', weight: 4, layer: 'api_call', patterns: [
    /import\s+.*HttpClient|using\s+.*System\.Net\.Http/,             // C# / Angular HttpClient
    /import\s+.*axios|import\s+.*node-fetch|import\s+.*got\b/i,     // JS HTTP libraries
    /import\s+.*requests\b|from\s+requests\s+import/,               // Python requests
    /import\s+.*retrofit|import\s+.*okhttp/i,                        // Android HTTP
  ]},
  { source: 'import', weight: 4, layer: 'state_update', patterns: [
    /:\s*INotifyPropertyChanged\b/,                                  // C# WPF/MVVM
    /import\s+.*redux|import\s+.*zustand|import\s+.*mobx/i,         // JS state libs
    /import\s+.*@ngrx|import\s+.*vuex|import\s+.*pinia/i,           // Framework stores
    /import\s+.*bloc\b|import\s+.*riverpod/i,                       // Flutter state
  ]},
  { source: 'import', weight: 4, layer: 'validator', patterns: [
    /import\s+.*class-validator|import\s+.*joi\b|import\s+.*yup\b|import\s+.*zod\b/i,
    /using\s+.*FluentValidation|using\s+.*DataAnnotations/,
  ]},

  // ────── SYMBOL NAME PATTERNS (weight: 1 — weakest signal) ──────
  { source: 'symbol_name', weight: 1, layer: 'event_handler', patterns: [/^(handle|on)[A-Z]/, /_Click$|_Loaded$|_Changed$|_KeyDown$/] },
  { source: 'symbol_name', weight: 1, layer: 'state_update', patterns: [/^use[A-Z]/, /^set[A-Z].*State$/] },
  { source: 'symbol_name', weight: 1, layer: 'api_call', patterns: [/^fetch[A-Z]|^(get|post|put|delete)[A-Z].*Api$|Async$/] },
  { source: 'symbol_name', weight: 1, layer: 'validator', patterns: [/^validate|^sanitize|^check[A-Z]|^is[A-Z].*Valid$/] },
  { source: 'symbol_name', weight: 1, layer: 'util', patterns: [/^(format|parse|convert|transform|serialize|deserialize|encode|decode)[A-Z]/] },
  { source: 'symbol_name', weight: 1, layer: 'database', patterns: [/^(save|load|persist|query|find|fetch|insert|update|delete)(?:All|By|One|Many)?$/] },
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
   * Classify a single file by its layer using weighted multi-signal scoring.
   */
  classifyFile(filePath: string): FlowLayer {
    const result = this.scoreFile(filePath);
    return result.layer;
  }

  /**
   * Full classification with confidence details.
   * Returns the winning layer, confidence score, all signal hits, and runner-up layers.
   */
  getFileClassification(filePath: string): {
    layer: FlowLayer;
    confidence: number;
    signals: Array<{ source: string; layer: FlowLayer; weight: number }>;
    runnerUp?: FlowLayer;
  } {
    return this.scoreFile(filePath);
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
        files: [...data.files].slice(0, 20),
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

    // BFS through the call graph + partial class methods + inline calls
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

      // 1. Follow explicit call edges
      const callees = this.graph.findCallees(node.id);
      for (const callee of callees) {
        if (!visited.has(callee.id)) {
          queue.push({ node: callee, depth: depth + 1 });
        }
      }

      // 2. Follow 'uses' and 'depends_on' edges too
      const outEdges = this.graph.getOutEdges(node.id);
      for (const edge of outEdges) {
        if (edge.type !== 'calls' && !visited.has(edge.targetId)) {
          const target = this.graph.getNode(edge.targetId);
          if (target && target.type !== 'file') {
            queue.push({ node: target, depth: depth + 1 });
          }
        }
      }

      // 3. C# partial class discovery: find sibling methods called in the body
      if (callees.length === 0 && depth < maxDepth) {
        const inlineCalls = this.discoverInlineCalls(node, visited);
        for (const callee of inlineCalls) {
          queue.push({ node: callee, depth: depth + 1 });
        }
      }
    }

    const riskLevel = this.assessRisk(steps, sideEffects);
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

  /**
   * When the graph has no explicit 'calls' edges (common in C# partial classes),
   * read the method body and search for method names that exist in the same class
   * across any partial class file.
   *
   * E.g., NotesToggle_Click() calls OpenNotesPanel() which is in a different
   * partial class file — the static parser may not have created an edge.
   */
  private discoverInlineCalls(node: GraphNode, visited: Set<string>): GraphNode[] {
    const discovered: GraphNode[] = [];

    try {
      const content = readFileSync(node.filePath, 'utf-8');
      const lines = content.split('\n');
      const startIdx = Math.max(0, (node.startLine || 1) - 1);
      const endIdx = Math.min(lines.length, (node.endLine || node.startLine || 1));
      const body = lines.slice(startIdx, endIdx).join('\n');

      // Find the class this method belongs to
      const className = node.qualifiedName.includes('.')
        ? node.qualifiedName.split('.')[0]!
        : null;

      if (!className) return discovered;

      // Get ALL methods in the same class across all partial class files
      const classMethods = this.graph.search(className, 100)
        .filter(n =>
          n.qualifiedName.startsWith(className + '.') &&
          (n.type === 'function' || n.type === 'method') &&
          !visited.has(n.id) &&
          n.id !== node.id,
        );

      // Check which of those method names appear in our method body
      for (const method of classMethods) {
        // Match method name followed by ( — indicates a call
        const callPattern = new RegExp(`\\b${this.escapeRegex(method.name)}\\s*\\(`, 'g');
        if (callPattern.test(body)) {
          discovered.push(method);
        }
      }
    } catch {
      // File unreadable, skip
    }

    return discovered.slice(0, 10); // Cap to prevent explosion
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const handlerPattern = /^(handle|on)[A-Z]|_Click$|_Loaded$|_Closing$|_Closed$|_Changed$|_SelectionChanged$|_KeyDown$|_KeyUp$|_MouseDown$|_MouseUp$|_DragEnter$|_Drop$|_Checked$|_Unchecked$|_GotFocus$|_LostFocus$|_TextChanged$/;

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

  // ── Private: Multi-Signal Scoring Engine ────────────────────

  /** Score a file across ALL layers and return the best match */
  private scoreFile(filePath: string): {
    layer: FlowLayer;
    confidence: number;
    signals: Array<{ source: string; layer: FlowLayer; weight: number }>;
    runnerUp?: FlowLayer;
  } {
    const scores = new Map<FlowLayer, number>();
    const signals: Array<{ source: string; layer: FlowLayer; weight: number }> = [];
    const relPath = relative(this.projectRoot, filePath);
    const fileName = basename(filePath);

    // Read file content once (cached for all content/import checks)
    let content: string | null = null;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      // Can't read, rely on path-only signals
    }

    // Get symbol names for this file from the graph
    const fileNodes = this.graph.getFileStructure(filePath);
    const symbolNames = fileNodes
      .filter(n => n.type === 'function' || n.type === 'method' || n.type === 'class')
      .map(n => n.name);

    for (const signal of CLASSIFICATION_SIGNALS) {
      let matched = false;

      switch (signal.source) {
        case 'content':
          if (content) {
            matched = signal.patterns.some(p => p.test(content!));
          }
          break;

        case 'path':
          matched = signal.patterns.some(p => p.test(fileName) || p.test(relPath));
          break;

        case 'directory':
          matched = signal.patterns.some(p => p.test(relPath));
          break;

        case 'import':
          if (content) {
            matched = signal.patterns.some(p => p.test(content!));
          }
          break;

        case 'symbol_name':
          matched = symbolNames.some(name =>
            signal.patterns.some(p => p.test(name)),
          );
          break;
      }

      if (matched) {
        const current = scores.get(signal.layer) ?? 0;
        scores.set(signal.layer, current + signal.weight);
        signals.push({ source: signal.source, layer: signal.layer, weight: signal.weight });
      }
    }

    // ── Score against AI-learned classification rules ──────────
    try {
      const learnedRules = this.graph.getLearnedClassificationRules();
      for (const rule of learnedRules) {
        if (rule.patterns.length === 0) continue;

        let matched = false;
        const compiledPatterns = rule.patterns.map(p => {
          try { return new RegExp(p, 'im'); } catch { return null; }
        }).filter(Boolean) as RegExp[];

        const targetLayer = rule.layer as FlowLayer;

        switch (rule.source) {
          case 'content':
          case 'import':
            if (content) {
              matched = compiledPatterns.some(p => p.test(content!));
            }
            break;
          case 'path':
            matched = compiledPatterns.some(p => p.test(fileName) || p.test(relPath));
            break;
          case 'directory':
            matched = compiledPatterns.some(p => p.test(relPath));
            break;
          case 'symbol_name':
            matched = symbolNames.some(name =>
              compiledPatterns.some(p => p.test(name)),
            );
            break;
          default:
            // Try all: path + content
            matched = compiledPatterns.some(p => p.test(fileName) || p.test(relPath));
            if (!matched && content) {
              matched = compiledPatterns.some(p => p.test(content!));
            }
            break;
        }

        if (matched) {
          const w = rule.weight ?? 2;
          const current = scores.get(targetLayer) ?? 0;
          scores.set(targetLayer, current + w);
          signals.push({ source: `learned:${rule.name}`, layer: targetLayer, weight: w });
          // Touch the rule to track usage
          try { this.graph.touchLearnedRule(rule.id); } catch {}
        }
      }
    } catch {
      // Learned rules table might not exist yet (first run before migration)
    }

    // Find the winner
    if (scores.size === 0) {
      return { layer: 'unknown', confidence: 0, signals };
    }

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [winnerLayer, winnerScore] = sorted[0]!;
    const totalScore = sorted.reduce((sum, [, s]) => sum + s, 0);
    const confidence = Math.round((winnerScore / totalScore) * 100);
    const runnerUp = sorted.length > 1 ? sorted[1]![0] : undefined;

    return { layer: winnerLayer, confidence, signals, runnerUp };
  }

  /** File classification cache to avoid re-reading files */
  private fileClassCache = new Map<string, FlowLayer>();

  private classifyFilesByLayer(allNodes: GraphNode[]): Record<string, FlowLayer> {
    const result: Record<string, FlowLayer> = {};
    const files = new Set(allNodes.map((n) => n.filePath));
    this.fileClassCache.clear();

    for (const filePath of files) {
      const relPath = relative(this.projectRoot, filePath);
      if (result[relPath]) continue;

      const scored = this.scoreFile(filePath);
      result[relPath] = scored.layer;
      this.fileClassCache.set(filePath, scored.layer);
    }

    return result;
  }

  private classifySymbol(node: GraphNode, relPath: string): FlowLayer {
    // Check node type first (explicit types override scoring)
    if (node.type === 'route') return 'route';
    if (node.type === 'component') return 'ui_component';
    if (node.type === 'hook') return 'state_update';

    // Check symbol name signals
    for (const signal of CLASSIFICATION_SIGNALS) {
      if (signal.source === 'symbol_name') {
        if (signal.patterns.some(p => p.test(node.name))) {
          return signal.layer;
        }
      }
    }

    // Check by signature content
    const sig = (node.signature || '').toLowerCase();
    if (/\b(req\s*,\s*res|request\s*,\s*response|ctx)\b/.test(sig)) return 'controller';
    if (/\bdb\b|\bprisma\b|\bmodel\b|\brepository\b/i.test(sig)) return 'repository';

    // Fall back to file-level classification (cached)
    const cached = this.fileClassCache.get(node.filePath);
    if (cached) return cached;

    // Score the file if not cached
    const scored = this.scoreFile(node.filePath);
    this.fileClassCache.set(node.filePath, scored.layer);
    return scored.layer;
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
