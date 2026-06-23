/**
 * AI Mind Map — Knowledge Graph Module
 *
 * Barrel export for all knowledge graph components:
 * - Parser: Tree-sitter AST parsing with regex fallback
 * - Graph: SQLite-backed knowledge graph with FTS5
 * - Indexer: Full and incremental codebase indexing
 * - PageRank: Relevance ranking for token-efficient context
 */

export {
  parseFile,
  parseFiles,
  isSupportedFile,
  detectLanguage,
  getSupportedExtensions,
  getSupportedLanguages,
  generateNodeId,
  generateContentHash,
} from './parser.js';

export type { ParseResult } from './parser.js';

export { KnowledgeGraph } from './graph.js';

export { Indexer } from './indexer.js';

export type {
  IndexProgress,
  IndexProgressCallback,
  IndexStats,
} from './indexer.js';

export { PageRankEngine } from './pagerank.js';

export type {
  PageRankConfig,
  RankedNode,
} from './pagerank.js';
