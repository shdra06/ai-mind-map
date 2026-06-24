/**
 * AI Mind Map — Semantic Search Engine
 *
 * Provides TF-IDF-based semantic search with synonym expansion for
 * concept-level code search. Enables queries like "save user preferences"
 * to find `persistSettings()`.
 *
 * Architecture:
 *   1. Tokenizer: CamelCase/snake_case-aware word splitting
 *   2. Synonym Dictionary: 50 programming concept synonym groups
 *   3. TF-IDF Vectorizer: Term frequency × Inverse document frequency
 *   4. BM25 Scoring: Okapi BM25 ranked semantic search results
 *
 * All data stored in SQLite (same DB as the knowledge graph).
 * Zero additional dependencies required.
 */

import type Database from 'better-sqlite3';

// ============================================================
// Types
// ============================================================

/** A single semantic search result */
export interface SemanticSearchResult {
  nodeId: string;
  score: number;              // BM25 relevance score
  matchedTerms: string[];     // Query terms that contributed to the match
  expandedSynonyms: string[]; // Synonyms that were activated
}

/** Corpus statistics for diagnostics */
export interface SemanticIndexStats {
  totalDocuments: number;
  vocabularySize: number;
  averageDocLength: number;
  lastRebuiltAt: number;
  idfStale: boolean;
}

/** Sparse TF-IDF vector: { term: weight } */
type SparseVector = Record<string, number>;

// BM25 parameters
const BM25_K1 = 1.2;  // Term frequency saturation
const BM25_B = 0.75;  // Document length normalization

// ============================================================
// Programming Synonym Dictionary (50 Groups)
// ============================================================

/**
 * Bidirectional synonym lookup for programming concepts.
 * Each group represents a common programming concept where
 * any term should match the others during search.
 */
const SYNONYM_GROUPS: string[][] = [
  // 1. Save/Persist
  ['save', 'persist', 'store', 'write', 'commit', 'flush', 'dump', 'serialize'],
  // 2. Read/Load
  ['read', 'load', 'fetch', 'get', 'retrieve', 'pull', 'obtain', 'acquire'],
  // 3. Auth/Login
  ['auth', 'login', 'authenticate', 'signin', 'logon', 'sso', 'credentials'],
  // 4. Permission/Access
  ['authorize', 'permission', 'access', 'acl', 'rbac', 'role', 'privilege', 'grant'],
  // 5. Delete/Remove
  ['delete', 'remove', 'destroy', 'drop', 'erase', 'purge', 'unlink', 'discard'],
  // 6. Create/New
  ['create', 'add', 'insert', 'register', 'init', 'initialize', 'instantiate', 'make', 'build'],
  // 7. Update/Modify
  ['update', 'modify', 'edit', 'patch', 'change', 'alter', 'mutate', 'set'],
  // 8. Search/Find
  ['search', 'find', 'query', 'lookup', 'filter', 'scan', 'match', 'grep', 'locate'],
  // 9. List/Enumerate
  ['list', 'enumerate', 'index', 'catalog', 'browse', 'getall', 'fetchall'],
  // 10. Send/Emit
  ['send', 'emit', 'dispatch', 'broadcast', 'publish', 'push', 'notify', 'fire', 'trigger'],
  // 11. Receive/Listen
  ['receive', 'listen', 'subscribe', 'handle', 'consume', 'observe', 'watch'],
  // 12. Error/Exception
  ['error', 'exception', 'fault', 'failure', 'issue', 'problem', 'crash'],
  // 13. Config/Settings
  ['config', 'configuration', 'settings', 'preferences', 'options', 'params', 'env', 'properties'],
  // 14. Log/Trace
  ['log', 'trace', 'debug', 'print', 'console', 'output', 'record', 'audit'],
  // 15. Cache/Buffer
  ['cache', 'buffer', 'memo', 'memoize', 'preload', 'prefetch', 'pool'],
  // 16. Validate/Check
  ['validate', 'check', 'verify', 'assert', 'ensure', 'sanitize', 'lint'],
  // 17. Parse/Decode
  ['parse', 'decode', 'deserialize', 'unmarshal', 'extract', 'interpret', 'tokenize'],
  // 18. Format/Encode
  ['format', 'encode', 'marshal', 'stringify', 'render', 'transform'],
  // 19. Connect/Open
  ['connect', 'open', 'establish', 'attach', 'bind', 'mount', 'join', 'link'],
  // 20. Disconnect/Close
  ['disconnect', 'close', 'detach', 'unbind', 'unmount', 'shutdown', 'teardown', 'release'],
  // 21. Encrypt/Secure
  ['encrypt', 'secure', 'hash', 'sign', 'cipher', 'protect', 'obfuscate', 'seal'],
  // 22. Decrypt/Unseal
  ['decrypt', 'unseal', 'decipher'],
  // 23. Async/Concurrent
  ['async', 'await', 'promise', 'concurrent', 'parallel', 'thread', 'worker', 'coroutine'],
  // 24. Route/Endpoint
  ['route', 'endpoint', 'path', 'url', 'uri', 'handler', 'controller', 'middleware'],
  // 25. Database/Repository
  ['database', 'db', 'repository', 'repo', 'datastore', 'collection', 'table'],
  // 26. User/Account
  ['user', 'account', 'profile', 'member', 'identity', 'principal', 'subject'],
  // 27. Deploy/Release
  ['deploy', 'release', 'ship', 'rollout', 'launch', 'stage'],
  // 28. Test/Spec
  ['test', 'spec', 'suite', 'describe', 'expect', 'mock', 'stub'],
  // 29. Import/Include
  ['import', 'include', 'require', 'use', 'depend', 'inject'],
  // 30. Export/Expose
  ['export', 'expose', 'provide', 'declare'],
  // 31. Iterate/Loop
  ['iterate', 'loop', 'foreach', 'map', 'each', 'traverse', 'walk', 'cursor'],
  // 32. Sort/Order
  ['sort', 'order', 'rank', 'arrange', 'sequence', 'prioritize', 'compare'],
  // 33. Merge/Combine
  ['merge', 'combine', 'concat', 'union', 'aggregate', 'compose', 'mix'],
  // 34. Split/Divide
  ['split', 'divide', 'separate', 'partition', 'chunk', 'slice', 'segment', 'decompose'],
  // 35. Retry/Backoff
  ['retry', 'backoff', 'reconnect', 'recover', 'failover', 'fallback', 'resilience'],
  // 36. Render/Display
  ['render', 'display', 'show', 'draw', 'paint', 'present', 'visualize'],
  // 37. Hide/Collapse
  ['hide', 'collapse', 'minimize', 'fold', 'conceal', 'toggle'],
  // 38. Queue/Stack
  ['queue', 'stack', 'dequeue', 'enqueue', 'fifo', 'lifo', 'buffer'],
  // 39. Schedule/Timer
  ['schedule', 'timer', 'cron', 'interval', 'timeout', 'delay', 'debounce', 'throttle'],
  // 40. Migrate/Upgrade
  ['migrate', 'upgrade', 'transition', 'convert', 'transform', 'evolve'],
  // 41. Lock/Mutex
  ['lock', 'mutex', 'semaphore', 'synchronize', 'guard', 'critical'],
  // 42. Clone/Copy
  ['clone', 'copy', 'duplicate', 'replicate', 'fork', 'snapshot'],
  // 43. Compress/Zip
  ['compress', 'zip', 'gzip', 'deflate', 'minify', 'compact', 'shrink'],
  // 44. Expand/Decompress
  ['expand', 'decompress', 'unzip', 'inflate', 'extract'],
  // 45. Subscribe/Unsubscribe
  ['subscribe', 'unsubscribe', 'follow', 'unfollow', 'opt'],
  // 46. Paginate/Scroll
  ['paginate', 'pagination', 'scroll', 'infinite', 'cursor', 'offset', 'page'],
  // 47. Upload/Download
  ['upload', 'download', 'transfer', 'stream', 'pipe'],
  // 48. Webhook/Callback
  ['webhook', 'callback', 'hook', 'listener', 'event', 'signal'],
  // 49. Token/JWT/Session
  ['token', 'jwt', 'session', 'cookie', 'bearer', 'oauth', 'refresh'],
  // 50. API/REST/GraphQL
  ['api', 'rest', 'graphql', 'grpc', 'soap', 'rpc', 'endpoint'],
];

/**
 * Build bidirectional synonym lookup from synonym groups.
 * Each term maps to its full synonym set (excluding itself).
 */
function buildSynonymMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const lowerTerm = term.toLowerCase();
      const synonyms = group
        .filter(t => t.toLowerCase() !== lowerTerm)
        .map(t => t.toLowerCase());
      const existing = map.get(lowerTerm) ?? [];
      // Merge with any existing synonyms (a term may appear in multiple groups)
      const merged = [...new Set([...existing, ...synonyms])];
      map.set(lowerTerm, merged);
    }
  }
  return map;
}

const SYNONYM_MAP = buildSynonymMap();

// ============================================================
// Tokenizer
// ============================================================

/**
 * Tokenize text into normalized terms.
 *
 * Handles:
 *   - CamelCase splitting: "handleUserAuth" → ["handle", "user", "auth"]
 *   - snake_case splitting: "handle_user_auth" → ["handle", "user", "auth"]
 *   - kebab-case splitting: "handle-user-auth" → ["handle", "user", "auth"]
 *   - Path splitting: "src/utils/auth.ts" → ["src", "utils", "auth", "ts"]
 *   - Lowercasing
 *   - Short token filtering (< 2 chars removed)
 */
export function tokenize(text: string): string[] {
  if (!text) return [];

  // Split CamelCase and PascalCase
  const withSpaces = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // HTMLParser → HTML Parser
    .replace(/(\d+)/g, ' $1 ')                    // handler404 → handler 404
    .replace(/[_\-.\/\\:@#$%^&*(){}[\]<>,;=+!?'"~`|]/g, ' ');  // symbols → spaces

  // Split on whitespace, lowercase, filter short tokens
  return withSpaces
    .split(/\s+/)
    .map(t => t.toLowerCase().trim())
    .filter(t => t.length >= 2);
}

/**
 * Expand query terms with synonyms.
 *
 * @returns Object with expanded terms and which synonyms were activated
 */
export function expandWithSynonyms(terms: string[]): {
  expanded: string[];
  activatedSynonyms: string[];
} {
  const expanded = new Set(terms);
  const activatedSynonyms: string[] = [];

  for (const term of terms) {
    const synonyms = SYNONYM_MAP.get(term.toLowerCase());
    if (synonyms) {
      for (const syn of synonyms) {
        if (!expanded.has(syn)) {
          expanded.add(syn);
          activatedSynonyms.push(syn);
        }
      }
    }
  }

  return {
    expanded: [...expanded],
    activatedSynonyms,
  };
}

// ============================================================
// TF-IDF Engine
// ============================================================

/**
 * Compute term frequency for a token list.
 * TF(t, d) = count(t in d) / |d|
 */
function computeTF(tokens: string[]): SparseVector {
  if (tokens.length === 0) return {};
  const tf: SparseVector = {};
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  // Normalize by document length
  const len = tokens.length;
  for (const term in tf) {
    tf[term] /= len;
  }
  return tf;
}

/**
 * Compute raw term frequency counts (no normalization).
 * BM25 needs raw integer counts, not normalized TF.
 */
function computeRawTF(tokens: string[]): SparseVector {
  if (tokens.length === 0) return {};
  const tf: SparseVector = {};
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  return tf;
}

/**
 * Compute the L2 magnitude of a sparse vector.
 */
function magnitude(vec: SparseVector): number {
  let sumSq = 0;
  for (const key in vec) {
    sumSq += vec[key] * vec[key];
  }
  return Math.sqrt(sumSq);
}

/**
 * Compute cosine similarity between two sparse vectors.
 */
function cosineSimilarity(vecA: SparseVector, vecB: SparseVector, magB: number): number {
  const magA = magnitude(vecA);
  if (magA === 0 || magB === 0) return 0;

  let dot = 0;
  // Iterate over the smaller vector for efficiency
  const [smaller, larger] = Object.keys(vecA).length <= Object.keys(vecB).length
    ? [vecA, vecB]
    : [vecB, vecA];

  for (const key in smaller) {
    if (key in larger) {
      dot += smaller[key] * larger[key];
    }
  }

  return dot / (magA * magB);
}

// ============================================================
// Semantic Search Engine
// ============================================================

/** Schema for semantic search tables */
const SEMANTIC_SCHEMA = `
-- TF-IDF vectors for each indexed node
CREATE TABLE IF NOT EXISTS tfidf_vectors (
  node_id TEXT PRIMARY KEY,
  terms TEXT NOT NULL,
  magnitude REAL NOT NULL,
  doc_length INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Inverse document frequency stats
CREATE TABLE IF NOT EXISTS corpus_stats (
  term TEXT PRIMARY KEY,
  doc_frequency INTEGER NOT NULL
);

-- Metadata for the semantic index
CREATE TABLE IF NOT EXISTS search_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_tfidf_updated ON tfidf_vectors(updated_at);
`;

/**
 * SemanticSearchEngine — TF-IDF cosine similarity search with synonym expansion.
 *
 * Usage:
 *   const engine = new SemanticSearchEngine(db);
 *   engine.indexNode(nodeId, "handleUserAuth", "Handles user authentication...");
 *   const results = engine.search("login verification", 10);
 */
export class SemanticSearchEngine {
  private db: InstanceType<typeof Database>;
  private idfCache: Map<string, number> = new Map();
  private totalDocs: number = 0;
  private idfStale: boolean = true;

  // Prepared statements (lazy-initialized)
  private stmtUpsertVector: any = null;
  private stmtDeleteVector: any = null;
  private stmtUpsertCorpusStat: any = null;
  private stmtGetVector: any = null;
  private stmtGetAllVectors: any = null;
  private stmtGetCorpusStats: any = null;
  private stmtSetMetadata: any = null;
  private stmtGetMetadata: any = null;
  private stmtCountVectors: any = null;
  private stmtCountTerms: any = null;
  private stmtDeleteCorpusStats: any = null;

  constructor(db: InstanceType<typeof Database>) {
    this.db = db;
    this.initSchema();
    this.prepareStatements();
    this.loadCorpusStats();
  }

  /** Initialize semantic search tables */
  private initSchema(): void {
    this.db.exec(SEMANTIC_SCHEMA);
    // Migration: add doc_length column if missing (existing DBs)
    try {
      this.db.exec('ALTER TABLE tfidf_vectors ADD COLUMN doc_length INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — expected
    }
  }

  /** Prepare reusable SQL statements */
  private prepareStatements(): void {
    this.stmtUpsertVector = this.db.prepare(`
      INSERT OR REPLACE INTO tfidf_vectors (node_id, terms, magnitude, doc_length, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtDeleteVector = this.db.prepare(`
      DELETE FROM tfidf_vectors WHERE node_id = ?
    `);

    this.stmtUpsertCorpusStat = this.db.prepare(`
      INSERT OR REPLACE INTO corpus_stats (term, doc_frequency)
      VALUES (?, ?)
    `);

    this.stmtGetVector = this.db.prepare(`
      SELECT terms, magnitude, doc_length FROM tfidf_vectors WHERE node_id = ?
    `);

    this.stmtGetAllVectors = this.db.prepare(`
      SELECT node_id, terms, magnitude, doc_length FROM tfidf_vectors
    `);

    this.stmtGetCorpusStats = this.db.prepare(`
      SELECT term, doc_frequency FROM corpus_stats
    `);

    this.stmtSetMetadata = this.db.prepare(`
      INSERT OR REPLACE INTO search_metadata (key, value) VALUES (?, ?)
    `);

    this.stmtGetMetadata = this.db.prepare(`
      SELECT value FROM search_metadata WHERE key = ?
    `);

    this.stmtCountVectors = this.db.prepare(`
      SELECT COUNT(*) as count FROM tfidf_vectors
    `);

    this.stmtCountTerms = this.db.prepare(`
      SELECT COUNT(*) as count FROM corpus_stats
    `);

    this.stmtDeleteCorpusStats = this.db.prepare(`
      DELETE FROM corpus_stats
    `);
  }

  /** Load corpus statistics from SQLite */
  private loadCorpusStats(): void {
    const rows = this.stmtGetCorpusStats.all() as Array<{ term: string; doc_frequency: number }>;
    this.idfCache.clear();
    for (const row of rows) {
      this.idfCache.set(row.term, row.doc_frequency);
    }
    this.totalDocs = (this.stmtCountVectors.get() as { count: number })?.count ?? 0;

    const lastRebuilt = this.stmtGetMetadata.get('last_idf_rebuild') as { value: string } | undefined;
    this.idfStale = !lastRebuilt;
  }

  // ── Indexing ────────────────────────────────────────────────

  /**
   * Build a composite text for a node from its components.
   * Weights different fields by repeating important ones.
   */
  private buildNodeText(
    name: string,
    qualifiedName: string,
    signature: string,
    docComment: string | null,
    filePath: string,
  ): string {
    // Weight by repetition: name is most important (3x), then qualifiedName (2x),
    // then signature and docComment (1x each)
    const parts = [
      name, name, name,                        // 3× weight
      qualifiedName, qualifiedName,             // 2× weight
      signature,                                // 1× weight
      docComment ?? '',                         // 1× weight
      filePath.replace(/[/\\]/g, ' '),          // 1× weight (path words)
    ];
    return parts.join(' ');
  }

  /**
   * Index a single node for semantic search.
   *
   * Computes TF vector and stores it. IDF is lazily recalculated
   * when search is invoked after indexing changes.
   */
  indexNode(
    nodeId: string,
    name: string,
    qualifiedName: string,
    signature: string,
    docComment: string | null,
    filePath: string,
  ): void {
    const text = this.buildNodeText(name, qualifiedName, signature, docComment, filePath);
    const tokens = tokenize(text);

    if (tokens.length === 0) {
      // Nothing to index (e.g., empty signature)
      this.stmtDeleteVector.run(nodeId);
      return;
    }

    const tf = computeRawTF(tokens);
    const mag = magnitude(tf);

    // Store raw TF vector as JSON (IDF will be applied at search time)
    this.stmtUpsertVector.run(
      nodeId,
      JSON.stringify(tf),
      mag,
      tokens.length,
      Date.now(),
    );

    this.idfStale = true;
  }

  /**
   * Batch-index multiple nodes in a single transaction.
   */
  indexNodes(
    nodes: Array<{
      id: string;
      name: string;
      qualifiedName: string;
      signature: string;
      docComment: string | null;
      filePath: string;
    }>,
  ): void {
    const indexInTransaction = this.db.transaction(() => {
      for (const node of nodes) {
        this.indexNode(
          node.id,
          node.name,
          node.qualifiedName,
          node.signature,
          node.docComment,
          node.filePath,
        );
      }
    });
    indexInTransaction();
    this.idfStale = true;
  }

  /**
   * Remove a node from the semantic index.
   */
  removeNode(nodeId: string): void {
    this.stmtDeleteVector.run(nodeId);
    this.idfStale = true;
  }

  /**
   * Remove all nodes for a file path from the semantic index.
   */
  removeFileNodes(filePath: string): void {
    this.db.prepare(`
      DELETE FROM tfidf_vectors
      WHERE node_id IN (SELECT id FROM nodes WHERE filePath = ?)
    `).run(filePath);
    this.idfStale = true;
  }

  // ── IDF Computation ─────────────────────────────────────────

  /**
   * Rebuild the IDF (Inverse Document Frequency) index.
   * Called lazily before search if the index is stale.
   *
   * IDF(t) = log(N / (1 + df(t))) + 1
   * where N = total documents, df(t) = documents containing term t
   */
  rebuildIDF(): void {
    // Count total documents
    this.totalDocs = (this.stmtCountVectors.get() as { count: number })?.count ?? 0;
    if (this.totalDocs === 0) {
      this.idfStale = false;
      return;
    }

    // Aggregate document frequencies from all TF vectors
    const termDf = new Map<string, number>();
    const rows = this.stmtGetAllVectors.all() as Array<{ node_id: string; terms: string }>;

    for (const row of rows) {
      try {
        const tf: SparseVector = JSON.parse(row.terms);
        for (const term of Object.keys(tf)) {
          termDf.set(term, (termDf.get(term) ?? 0) + 1);
        }
      } catch {
        // Skip malformed vectors
      }
    }

    // Persist to SQLite
    const updateCorpus = this.db.transaction(() => {
      this.stmtDeleteCorpusStats.run();
      for (const [term, df] of termDf) {
        this.stmtUpsertCorpusStat.run(term, df);
      }
    });
    updateCorpus();

    // Update in-memory cache
    this.idfCache = termDf;
    this.idfStale = false;

    // Record rebuild timestamp
    this.stmtSetMetadata.run('last_idf_rebuild', String(Date.now()));
  }

  /**
   * Get the IDF weight for a term.
   */
  private getIDF(term: string): number {
    const df = this.idfCache.get(term) ?? 0;
    return Math.log(this.totalDocs / (1 + df)) + 1;
  }

  /**
   * Apply IDF weights to a TF vector to produce a TF-IDF vector.
   */
  private applyIDF(tf: SparseVector): SparseVector {
    const tfidf: SparseVector = {};
    for (const term in tf) {
      tfidf[term] = tf[term] * this.getIDF(term);
    }
    return tfidf;
  }

  // ── Search ──────────────────────────────────────────────────

  /**
   * Perform semantic search using BM25 (Okapi BM25) scoring.
   *
   * @param query - Natural language query (e.g., "save user preferences")
   * @param limit - Maximum results to return
   * @param threshold - Minimum similarity score (0–1, default 0.01)
   * @param useSynonyms - Whether to expand query with synonyms (default true)
   * @returns Ranked search results with similarity scores
   */
  search(
    query: string,
    limit: number = 10,
    threshold: number = 0.01,
    useSynonyms: boolean = true,
  ): SemanticSearchResult[] {
    // Ensure IDF is up to date
    if (this.idfStale) {
      this.rebuildIDF();
    }

    if (this.totalDocs === 0) return [];

    // Tokenize and expand query
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    let searchTerms: string[];
    let activatedSynonyms: string[] = [];

    if (useSynonyms) {
      const expanded = expandWithSynonyms(queryTokens);
      searchTerms = expanded.expanded;
      activatedSynonyms = expanded.activatedSynonyms;
    } else {
      searchTerms = queryTokens;
    }

    // Calculate average document length for BM25
    let avgDocLength = 0;
    const allVectors = this.stmtGetAllVectors.all() as Array<{
      node_id: string;
      terms: string;
      magnitude: number;
      doc_length: number;
    }>;

    // Pre-compute avg doc length from stored doc_length
    let totalDocLength = 0;
    for (const row of allVectors) {
      totalDocLength += row.doc_length || 0;
    }
    avgDocLength = allVectors.length > 0 ? totalDocLength / allVectors.length : 1;

    const results: SemanticSearchResult[] = [];

    for (const row of allVectors) {
      try {
        const docTF: SparseVector = JSON.parse(row.terms);
        const docLength = row.doc_length || Object.keys(docTF).length;

        const { score, matchedTerms } = this.computeBM25Score(
          searchTerms, docTF, docLength, avgDocLength
        );

        if (score >= threshold) {
          results.push({
            nodeId: row.node_id,
            score,
            matchedTerms,
            expandedSynonyms: activatedSynonyms,
          });
        }
      } catch {
        // Skip malformed vectors
      }
    }

    // Sort by score descending and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Compute BM25 score between a query and a document.
   */
  private computeBM25Score(
    queryTerms: string[],
    docTF: SparseVector,
    docLength: number,
    avgDocLength: number,
  ): { score: number; matchedTerms: string[] } {
    let score = 0;
    const matchedTerms: string[] = [];

    for (const term of queryTerms) {
      const tf = docTF[term] ?? 0;
      if (tf === 0) continue;

      matchedTerms.push(term);
      const idf = this.getIDF(term);
      const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * docLength / avgDocLength));
      score += idf * tfNorm;
    }

    return { score, matchedTerms };
  }

  /**
   * Build an FTS5-compatible query string with synonym expansion.
   * Used to enhance the existing keyword search with synonym awareness.
   *
   * Example: "save user data" → '("save" OR "persist" OR "store" OR "write") AND "user" AND "data"'
   */
  buildSynonymExpandedFtsQuery(query: string): string {
    const tokens = tokenize(query);
    if (tokens.length === 0) return '""';

    const parts: string[] = [];
    for (const token of tokens) {
      const synonyms = SYNONYM_MAP.get(token.toLowerCase());
      if (synonyms && synonyms.length > 0) {
        // Build OR group for this term + its synonyms
        const allTerms = [token, ...synonyms.slice(0, 5)]; // Limit to 5 synonyms to avoid query explosion
        const orGroup = allTerms.map(t => `"${t}"`).join(' OR ');
        parts.push(`(${orGroup})`);
      } else {
        parts.push(`"${token}"`);
      }
    }

    return parts.join(' AND ');
  }

  // ── Diagnostics ─────────────────────────────────────────────

  /**
   * Get statistics about the semantic index.
   */
  getStats(): SemanticIndexStats {
    const totalDocs = (this.stmtCountVectors.get() as { count: number })?.count ?? 0;
    const vocabSize = (this.stmtCountTerms.get() as { count: number })?.count ?? 0;
    const lastRebuilt = this.stmtGetMetadata.get('last_idf_rebuild') as { value: string } | undefined;

    // Calculate average doc length
    let avgDocLen = 0;
    if (totalDocs > 0) {
      const allVecs = this.stmtGetAllVectors.all() as Array<{ terms: string }>;
      let totalTerms = 0;
      for (const row of allVecs) {
        try {
          totalTerms += Object.keys(JSON.parse(row.terms)).length;
        } catch { /* skip */ }
      }
      avgDocLen = totalTerms / totalDocs;
    }

    return {
      totalDocuments: totalDocs,
      vocabularySize: vocabSize,
      averageDocLength: Math.round(avgDocLen * 10) / 10,
      lastRebuiltAt: lastRebuilt ? parseInt(lastRebuilt.value, 10) : 0,
      idfStale: this.idfStale,
    };
  }

  /**
   * Get the synonym dictionary for diagnostics or external use.
   */
  getSynonymGroups(): string[][] {
    return SYNONYM_GROUPS;
  }

  /**
   * Look up synonyms for a specific term.
   */
  getSynonyms(term: string): string[] {
    return SYNONYM_MAP.get(term.toLowerCase()) ?? [];
  }

  /**
   * Clear the entire semantic index.
   */
  clear(): void {
    this.db.exec('DELETE FROM tfidf_vectors');
    this.db.exec('DELETE FROM corpus_stats');
    this.db.exec('DELETE FROM search_metadata');
    this.idfCache.clear();
    this.totalDocs = 0;
    this.idfStale = true;
  }
}
