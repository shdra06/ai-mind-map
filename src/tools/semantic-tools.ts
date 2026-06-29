/**
 * AI Mind Map — Semantic Search MCP Tools
 *
 * Registers the `mindmap_semantic_search` tool that provides
 * concept-level search using TF-IDF cosine similarity with
 * synonym expansion. Searches like "save user preferences"
 * find `persistSettings()`.
 */

import { z } from 'zod';
import { relative } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig, GraphNode } from '../types.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import { SemanticSearchEngine } from '../knowledge-graph/semantic-search.js';

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
// Registration
// ============================================================

/**
 * Register semantic search tools on the MCP server.
 */
export function registerSemanticTools(
  server: McpServer,
  graph: KnowledgeGraph,
  semanticEngine: SemanticSearchEngine,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  // ── mindmap_semantic_search ─────────────────────────────────
  server.tool(
    'mindmap_semantic_search',
    'Concept-level semantic search that finds code by MEANING, not just name. ' +
      'Search "save user preferences" to find persistSettings(). ' +
      'Search "authentication" to find login(), signin(), verifyCredentials(). ' +
      'Uses TF-IDF + synonym expansion for intelligent matching. ' +
      'Returns similarity scores and which synonyms were activated.',
    {
      query: z.string().describe(
        'Natural language query describing what you\'re looking for. ' +
        'Examples: "save user data", "handle authentication", "validate input"'
      ),
      limit: z.number().int().min(1).max(50).default(10).describe(
        'Maximum number of results (default 10)'
      ),
      threshold: z.number().min(0).max(1).default(0.01).describe(
        'Minimum similarity score 0-1 (default 0.01). Raise for more precise results.'
      ),
      useSynonyms: z.boolean().default(true).describe(
        'Whether to expand query with programming synonyms (default true). ' +
        'Set false for exact-term matching only.'
      ),
    },
    async ({ query, limit, threshold, useSynonyms }) => {
      try {
        const searchResults = semanticEngine.search(query, limit, threshold, useSynonyms);

        if (searchResults.length === 0) {
          return mcpText(ok({
            query,
            results: [],
            totalResults: 0,
            synonymsExpanded: [],
            message: 'No semantic matches found. Try a broader query or different terms.',
          }, estimator));
        }

        // Enrich results with graph node data
        const enrichedResults = [];
        for (const sr of searchResults) {
          const node = graph.getNode(sr.nodeId);
          if (!node) continue;

          const relPath = relative(config.projectRoot, node.filePath);
          enrichedResults.push({
            name: node.name,
            qualifiedName: node.qualifiedName,
            type: node.type,
            file: relPath,
            line: node.startLine,
            endLine: node.endLine,
            signature: node.signature,
            visibility: node.visibility,
            isExported: node.isExported,
            docComment: node.docComment,
            // Semantic search metadata
            semanticScore: Math.round(sr.score * 1000) / 1000,
            matchedTerms: sr.matchedTerms,
          });
        }

        // Collect activated synonyms from the first result (same for all)
        const synonymsExpanded = searchResults.length > 0
          ? searchResults[0].expandedSynonyms
          : [];

        const response = {
          query,
          results: enrichedResults,
          totalResults: enrichedResults.length,
          synonymsExpanded: synonymsExpanded.length > 0 ? synonymsExpanded : undefined,
          searchMode: 'semantic',
        };

        return mcpText(ok(response, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`semantic_search failed: ${msg}`));
      }
    },
  );

  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  // ── mindmap_semantic_stats ──────────────────────────────────
  server.tool(
    'mindmap_semantic_stats',
    'Get statistics about the semantic search index: vocabulary size, ' +
      'document count, and available synonym groups.',
    {},
    async () => {
      try {
        const stats = semanticEngine.getStats();
        const synonymGroups = semanticEngine.getSynonymGroups();

        const response = {
          index: stats,
          synonymGroups: synonymGroups.length,
          synonymExamples: synonymGroups.slice(0, 5).map(group =>
            `${group[0]} ↔ ${group.slice(1, 4).join(', ')}...`
          ),
        };

        return mcpText(ok(response, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`semantic_stats failed: ${msg}`));
      }
    },
  );
  } */

  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  // ── mindmap_synonyms ────────────────────────────────────────
  server.tool(
    'mindmap_synonyms',
    'Look up programming synonyms for a term. Useful to understand ' +
      'what the semantic search will expand to.',
    {
      term: z.string().describe('Term to look up synonyms for (e.g., "save", "auth", "delete")'),
    },
    async ({ term }) => {
      try {
        const synonyms = semanticEngine.getSynonyms(term);
        return mcpText(ok({
          term,
          synonyms: synonyms.length > 0 ? synonyms : null,
          message: synonyms.length > 0
            ? `Found ${synonyms.length} synonyms for "${term}"`
            : `No synonyms found for "${term}". This term will be matched literally.`,
        }, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`synonyms lookup failed: ${msg}`));
      }
    },
  );
  } */
}
