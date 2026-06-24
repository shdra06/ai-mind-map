/**
 * AI Mind Map — Shared Type Definitions
 * 
 * Core types used across all components of the Mind Map system.
 * Inspired by codebase-memory-mcp, Aider repo maps, and Mem0 architectures.
 */

// ============================================================
// Knowledge Graph Types
// ============================================================

export type NodeType = 
  | 'file' 
  | 'function' 
  | 'class' 
  | 'method' 
  | 'interface' 
  | 'type_alias'
  | 'enum'
  | 'variable' 
  | 'constant'
  | 'module'
  | 'namespace'
  | 'property'
  | 'constructor'
  | 'decorator'
  | 'route'        // HTTP route (Express, FastAPI, etc.)
  | 'component'    // React/Vue/Angular component
  | 'hook'         // React hook
  | 'test'         // Test function/describe block
  | 'config';      // Configuration entry

export type EdgeType = 
  | 'calls' 
  | 'imports' 
  | 'exports'
  | 'inherits' 
  | 'implements'
  | 'uses'
  | 'decorates'
  | 'overrides'
  | 'contains'     // Parent-child (class → method)
  | 'tests'        // Test → function being tested
  | 'depends_on'   // Package/module dependency
  | 'routes_to';   // HTTP route → handler

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  qualifiedName: string;     // e.g., "MyClass.myMethod"
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;          // Function/method signature (no body)
  docComment: string | null;  // JSDoc/docstring
  hash: string;               // Content hash for change detection
  language: string;
  visibility: 'public' | 'private' | 'protected' | 'internal' | 'unknown';
  isAsync: boolean;
  isStatic: boolean;
  isExported: boolean;
  parameters?: ParameterInfo[];
  returnType?: string;
  updatedAt: number;
}

export interface ParameterInfo {
  name: string;
  type: string | null;
  defaultValue: string | null;
  isOptional: boolean;
  isRest: boolean;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  metadata?: Record<string, string>;
}

// ============================================================
// Change Tracker Types
// ============================================================

export type ChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  filePath: string;
  changeType: ChangeType;
  oldPath?: string;           // For renames
  summary: string;
  symbolsAffected: string[];  // Function/class names that changed
  linesAdded: number;
  linesRemoved: number;
  timestamp: number;
  sessionId: string;
  /** Actual git diff content (patch hunks) for this file — if available. */
  diffContent?: string;
}

export interface ChangeSession {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  totalChanges: number;
  filesModified: string[];
  summary: string;
}

// ============================================================
// Memory Types
// ============================================================

export type MemoryCategory = 
  | 'architecture'    // System design decisions
  | 'convention'      // Coding standards, naming, patterns
  | 'decision'        // Specific tech/design decisions with rationale
  | 'gotcha'          // Known pitfalls, bugs, workarounds
  | 'dependency'      // Important package/version info
  | 'workflow'        // Build/test/deploy commands and processes
  | 'context'         // Business domain knowledge
  | 'preference'      // User preferences for AI behavior
  | 'lesson_learned'  // Past mistakes to avoid
  | 'todo';           // Future work items

export interface Memory {
  id: number;
  category: MemoryCategory;
  content: string;
  importance: number;        // 0.0 to 1.0, decays over time
  tags: string[];
  relatedFiles: string[];
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  sessionId: string;
  source: 'agent' | 'user' | 'auto';  // Who created this memory
}

export interface Decision {
  id: number;
  title: string;
  description: string;
  rationale: string;
  alternatives: string[];    // Other options considered
  consequences: string[];    // Known trade-offs
  relatedFiles: string[];
  tags: string[];
  decidedAt: number;
  decidedBy: string;         // 'user' | 'agent' | session-id
  status: 'active' | 'superseded' | 'reversed';
  supersededBy?: number;     // ID of newer decision
}

export interface SessionSummary {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  tasksCompleted: string[];
  filesModified: string[];
  decisionsMade: string[];
  memoriesCreated: number;
  tokensSaved: number;
  summary: string;
}

// ============================================================
// Context Engine Types
// ============================================================

export type CompressionLevel = 'minimal' | 'moderate' | 'aggressive';

export type ContentType = 
  | 'source_code' 
  | 'build_log' 
  | 'test_output' 
  | 'stack_trace' 
  | 'json_data' 
  | 'markdown' 
  | 'plain_text'
  | 'diff'
  | 'config_file';

export interface TokenBudget {
  graphResults: number;      // Max tokens for knowledge graph query results
  changeSummary: number;     // Max tokens for change summaries
  memoryRetrieval: number;   // Max tokens for memory retrieval
  fileContent: number;       // Max tokens per file content request
  totalContext: number;      // Max total context tokens per request
}

export interface ContextTier {
  tier: 1 | 2 | 3;
  label: string;
  description: string;
  tokenBudget: number;
  alwaysLoaded: boolean;
}

export interface ContextPackage {
  tier1: string;             // Always-loaded context (project summary, rules)
  tier2: string;             // Searchable context (graph results, memories)
  tier3: string;             // On-demand details (full file contents)
  totalTokens: number;
  tokensSaved: number;       // Estimated tokens saved vs naive approach
  breakdown: {
    component: string;
    tokens: number;
    budget: number;
  }[];
}

// ============================================================
// Configuration Types
// ============================================================

export interface MindMapConfig {
  /** Root directory of the project to index */
  projectRoot: string;
  
  /** Languages to parse (auto-detected if not specified) */
  languages: string[];
  
  /** Glob patterns to ignore (in addition to .gitignore) */
  ignore: string[];
  
  /** Token budgets per component */
  tokenBudgets: TokenBudget;
  
  /** Memory configuration */
  memory: {
    maxMemories: number;
    decayRate: number;           // Multiplier per day (0.95 = 5% daily decay)
    importanceThreshold: number; // Below this = eligible for pruning
    maxDecisions: number;
  };
  
  /** Compression level for context engine */
  compression: CompressionLevel;
  
  /** Database file path */
  dbPath: string;
  
  /** Enable file watcher for real-time updates */
  watchEnabled: boolean;
  
  /** File watcher debounce delay in ms */
  watchDebounceMs: number;
  
  /** Maximum file size to index (bytes) */
  maxFileSize: number;
  
  /** Enable PageRank relevance ranking */
  pageRankEnabled: boolean;
  
  /** Disable parsing/indexing and run only memory/context services */
  memoryOnly: boolean;

  /** File path for team-shared Git-trackable context (relative to projectRoot) */
  sharedContextFile: string;

  /** Auto-sync sharedContextFile on startup */
  autoSyncSharedContext: boolean;
}

export const DEFAULT_CONFIG: MindMapConfig = {
  projectRoot: process.cwd(),
  languages: [],  // Auto-detect
  ignore: [
    'node_modules', '.git', '.mindmap', 'dist', 'build', 'out', '.next',
    '__pycache__', '.pytest_cache', 'venv', '.venv', 'env',
    'target', 'bin/Debug', 'bin/Release', 'obj',
    '.idea', '.vscode', '.vs',
    'coverage', '.nyc_output',
    '*.min.js', '*.min.css', '*.map',
    '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.ico',
    '*.woff', '*.woff2', '*.ttf', '*.eot',
    '*.pdf', '*.zip', '*.tar', '*.gz',
    '*.exe', '*.dll', '*.so', '*.dylib',
    '*.pyc', '*.pyo', '*.class',
    '.env', '.env.local', '.env.production',
  ],
  tokenBudgets: {
    graphResults: 4000,
    changeSummary: 2000,
    memoryRetrieval: 3000,
    fileContent: 6000,
    totalContext: 20000,
  },
  memory: {
    maxMemories: 1000,
    decayRate: 0.95,
    importanceThreshold: 0.1,
    maxDecisions: 500,
  },
  compression: 'moderate',
  dbPath: '.mindmap/mindmap.db',
  watchEnabled: true,
  watchDebounceMs: 500,
  maxFileSize: 1024 * 1024,  // 1MB (doubled from 512KB)
  pageRankEnabled: true,
  memoryOnly: false,
  sharedContextFile: '.mindmap-shared.json',
  autoSyncSharedContext: true,
};

// ============================================================
// Stats / Monitoring Types
// ============================================================

export interface MindMapStats {
  projectRoot: string;
  indexedFiles: number;
  totalNodes: number;
  totalEdges: number;
  totalMemories: number;
  totalDecisions: number;
  totalChangesTracked: number;
  lastIndexedAt: number | null;
  lastChangeAt: number | null;
  dbSizeBytes: number;
  languageBreakdown: Record<string, number>;
  tokensSavedEstimate: number;
}

// ============================================================
// MCP Tool Result Types
// ============================================================

export interface ToolResult {
  success: boolean;
  data: unknown;
  tokenCount: number;
  tokensSaved: number;       // Estimated vs naive approach
  message?: string;
}
