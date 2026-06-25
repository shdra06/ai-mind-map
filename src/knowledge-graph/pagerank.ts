/**
 * AI Mind Map — PageRank-based Relevance Ranking
 *
 * Implements standard and personalized PageRank to rank code symbols
 * by structural importance. Directly inspired by Aider's Personalized
 * PageRank approach for generating compact repo maps within a token budget.
 *
 * Key features:
 * - Standard PageRank with configurable damping factor
 * - Personalized PageRank biased toward conversation-relevant nodes
 * - Token-budget-aware repo map generation
 * - Caching with graph-change invalidation
 */

import type { GraphNode, GraphEdge, EdgeType } from '../types.js';
import { KnowledgeGraph } from './graph.js';

// ============================================================
// Types
// ============================================================

/** PageRank configuration */
export interface PageRankConfig {
  /** Damping factor (probability of following a link vs random jump). Default: 0.85 */
  dampingFactor: number;
  /** Maximum iterations before convergence. Default: 100 */
  maxIterations: number;
  /** Convergence threshold (stop when max change < epsilon). Default: 1e-6 */
  epsilon: number;
}

/** Ranked node with its PageRank score */
export interface RankedNode {
  node: GraphNode;
  score: number;
  /** Estimated token cost of this node's signature */
  tokenCost: number;
}

/** Cached PageRank result */
interface PageRankCache {
  /** Node ID → PageRank score */
  scores: Map<string, number>;
  /** Hash of the graph state when scores were computed */
  graphHash: string;
  /** Timestamp of computation */
  computedAt: number;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: PageRankConfig = {
  dampingFactor: 0.85,
  maxIterations: 100,
  epsilon: 1e-6,
};

/**
 * Weights for different edge types when building the adjacency matrix.
 * Higher weight = stronger connection = more rank transferred.
 */
const EDGE_WEIGHTS: Record<EdgeType, number> = {
  calls: 1.0,
  imports: 0.8,
  exports: 0.6,
  inherits: 1.2,
  implements: 1.1,
  uses: 0.7,
  decorates: 0.5,
  overrides: 1.0,
  contains: 0.9,
  tests: 0.6,
  depends_on: 0.8,
  routes_to: 0.7,
};

// ============================================================
// PageRank Engine
// ============================================================

/**
 * PageRank-based relevance ranking engine for the knowledge graph.
 *
 * Computes structural importance of each node based on the link structure
 * of the codebase graph. Supports personalized PageRank to bias rankings
 * toward nodes relevant to the current conversation or query.
 */
export class PageRankEngine {
  private graph: KnowledgeGraph;
  private config: PageRankConfig;
  private cache: PageRankCache | null = null;

  constructor(graph: KnowledgeGraph, config: Partial<PageRankConfig> = {}) {
    this.graph = graph;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================
  // Graph Hash (for cache invalidation)
  // ============================================================

  /**
   * Compute a hash of the current graph state for cache invalidation.
   * Uses node/edge counts + a sample of recent update timestamps.
   */
  private computeGraphHash(): string {
    const stats = this.graph.getStats();
    return `${stats.totalNodes}:${stats.totalEdges}`;
  }

  /**
   * Check if the cached PageRank scores are still valid.
   */
  private isCacheValid(): boolean {
    if (!this.cache) return false;
    const currentHash = this.computeGraphHash();
    return this.cache.graphHash === currentHash;
  }

  /**
   * Invalidate the PageRank cache (call when graph changes).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  // ============================================================
  // Adjacency Matrix Construction
  // ============================================================

  /**
   * Build a weighted adjacency list from graph edges.
   *
   * @returns Adjacency list: nodeId → [(targetId, weight)]
   */
  private buildAdjacencyList(
    nodeIds: string[],
    edges: GraphEdge[],
  ): {
    outLinks: Map<string, { target: string; weight: number }[]>;
    inLinks: Map<string, { source: string; weight: number }[]>;
  } {
    const nodeSet = new Set(nodeIds);
    const outLinks = new Map<string, { target: string; weight: number }[]>();
    const inLinks = new Map<string, { source: string; weight: number }[]>();

    // Initialize empty adjacency lists
    for (const id of nodeIds) {
      outLinks.set(id, []);
      inLinks.set(id, []);
    }

    // Populate from edges
    for (const edge of edges) {
      if (!nodeSet.has(edge.sourceId) || !nodeSet.has(edge.targetId)) continue;
      if (edge.sourceId === edge.targetId) continue; // Skip self-loops

      const weight = EDGE_WEIGHTS[edge.type] ?? 0.5;

      outLinks.get(edge.sourceId)!.push({ target: edge.targetId, weight });
      inLinks.get(edge.targetId)!.push({ source: edge.sourceId, weight });
    }

    return { outLinks, inLinks };
  }

  // ============================================================
  // Standard PageRank
  // ============================================================

  /**
   * Compute standard PageRank for all nodes in the graph.
   *
   * Uses the power iteration method with weighted edges.
   *
   * @returns Map of node ID → PageRank score
   */
  computePageRank(): Map<string, number> {
    // Check cache first
    if (this.isCacheValid() && this.cache) {
      return new Map(this.cache.scores);
    }

    const nodeIds = this.graph.getAllNodeIds();
    if (nodeIds.length === 0) return new Map();

    const edges = this.graph.getAllEdges();
    const { outLinks, inLinks } = this.buildAdjacencyList(nodeIds, edges);

    const n = nodeIds.length;
    const d = this.config.dampingFactor;
    const uniformProb = 1 / n;

    // Initialize scores uniformly
    let scores = new Map<string, number>();
    for (const id of nodeIds) {
      scores.set(id, uniformProb);
    }

    // Power iteration
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      const newScores = new Map<string, number>();
      let maxDelta = 0;

      // Handle dangling nodes (nodes with no outgoing edges)
      let danglingSum = 0;
      for (const id of nodeIds) {
        if (outLinks.get(id)!.length === 0) {
          danglingSum += scores.get(id)!;
        }
      }

      for (const id of nodeIds) {
        // Sum of weighted incoming rank
        let incomingRank = 0;
        const incomingEdges = inLinks.get(id)!;

        for (const { source, weight } of incomingEdges) {
          const sourceScore = scores.get(source)!;
          const sourceOutLinks = outLinks.get(source)!;

          // Total outgoing weight from source
          const totalOutWeight = sourceOutLinks.reduce((sum, l) => sum + l.weight, 0);
          if (totalOutWeight > 0) {
            incomingRank += (sourceScore * weight) / totalOutWeight;
          }
        }

        // PageRank formula with dangling node handling
        const newScore = (1 - d) / n + d * (incomingRank + danglingSum / n);
        newScores.set(id, newScore);

        const delta = Math.abs(newScore - (scores.get(id) ?? 0));
        if (delta > maxDelta) maxDelta = delta;
      }

      scores = newScores;

      // Check convergence
      if (maxDelta < this.config.epsilon) break;
    }

    // Normalize scores to sum to 1
    const total = Array.from(scores.values()).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const [id, score] of scores) {
        scores.set(id, score / total);
      }
    }

    // Cache the results
    this.cache = {
      scores: new Map(scores),
      graphHash: this.computeGraphHash(),
      computedAt: Date.now(),
    };

    return scores;
  }

  // ============================================================
  // Personalized PageRank
  // ============================================================

  /**
   * Compute Personalized PageRank biased toward specific seed nodes.
   *
   * This is the key algorithm inspired by Aider's approach:
   * instead of uniform random jumps, jumps are biased toward nodes
   * mentioned in the current conversation or query.
   *
   * @param seedNodeIds - Node IDs to bias toward (e.g., nodes matching a query)
   * @param seedWeight - How much to bias toward seeds (0-1, default 0.5)
   * @returns Map of node ID → personalized PageRank score
   */
  computePersonalizedPageRank(
    seedNodeIds: string[],
    seedWeight: number = 0.5,
  ): Map<string, number> {
    const nodeIds = this.graph.getAllNodeIds();
    if (nodeIds.length === 0) return new Map();

    const edges = this.graph.getAllEdges();
    const { outLinks, inLinks } = this.buildAdjacencyList(nodeIds, edges);

    const n = nodeIds.length;
    const d = this.config.dampingFactor;

    // Build personalization vector
    const seedSet = new Set(seedNodeIds.filter(id => nodeIds.includes(id)));
    const personalization = new Map<string, number>();

    if (seedSet.size > 0) {
      const seedProb = seedWeight / seedSet.size;
      const nonSeedProb = (1 - seedWeight) / Math.max(n - seedSet.size, 1);

      for (const id of nodeIds) {
        personalization.set(id, seedSet.has(id) ? seedProb : nonSeedProb);
      }
    } else {
      // No valid seeds — fall back to uniform
      const uniformProb = 1 / n;
      for (const id of nodeIds) {
        personalization.set(id, uniformProb);
      }
    }

    // Initialize scores from personalization vector
    let scores = new Map(personalization);

    // Power iteration with personalization
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      const newScores = new Map<string, number>();
      let maxDelta = 0;

      // Handle dangling nodes
      let danglingSum = 0;
      for (const id of nodeIds) {
        if (outLinks.get(id)!.length === 0) {
          danglingSum += scores.get(id)!;
        }
      }

      for (const id of nodeIds) {
        let incomingRank = 0;
        const incomingEdges = inLinks.get(id)!;

        for (const { source, weight } of incomingEdges) {
          const sourceScore = scores.get(source)!;
          const sourceOutLinks = outLinks.get(source)!;
          const totalOutWeight = sourceOutLinks.reduce((sum, l) => sum + l.weight, 0);
          if (totalOutWeight > 0) {
            incomingRank += (sourceScore * weight) / totalOutWeight;
          }
        }

        // Personalized PageRank: random jumps go to personalization vector instead of uniform
        const pv = personalization.get(id)!;
        const danglingContrib = danglingSum * pv;
        const newScore = (1 - d) * pv + d * (incomingRank + danglingContrib);
        newScores.set(id, newScore);

        const delta = Math.abs(newScore - (scores.get(id) ?? 0));
        if (delta > maxDelta) maxDelta = delta;
      }

      scores = newScores;
      if (maxDelta < this.config.epsilon) break;
    }

    // Normalize
    const total = Array.from(scores.values()).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const [id, score] of scores) {
        scores.set(id, score / total);
      }
    }

    return scores;
  }

  // ============================================================
  // Ranking & Token Budget
  // ============================================================

  /**
   * Estimate the token cost of a node's signature representation.
   * Rough estimate: ~4 characters per token.
   */
  private estimateNodeTokenCost(node: GraphNode): number {
    let text = node.signature;
    if (node.docComment) {
      // Include first line of doc comment
      const firstLine = node.docComment.split('\n')[0];
      text += `\n/** ${firstLine} */`;
    }
    return Math.ceil(text.length / 4);
  }

  /**
   * Get the top-N most important nodes ranked by PageRank.
   *
   * @param limit - Maximum number of nodes to return
   * @param excludeTypes - Node types to exclude (e.g., ['file'] to skip file nodes)
   * @returns Ranked nodes with scores and token costs
   */
  getTopNodes(
    limit: number = 50,
    excludeTypes: string[] = ['file'],
  ): RankedNode[] {
    const scores = this.computePageRank();
    return this.rankNodes(scores, limit, excludeTypes);
  }

  /**
   * Get the most relevant nodes for a set of seed nodes (personalized).
   *
   * @param seedNodeIds - Seed node IDs to bias toward
   * @param limit - Maximum number of nodes
   * @param seedWeight - Bias weight (0-1)
   * @param excludeTypes - Node types to exclude
   */
  getRelevantNodes(
    seedNodeIds: string[],
    limit: number = 50,
    seedWeight: number = 0.5,
    excludeTypes: string[] = ['file'],
  ): RankedNode[] {
    const scores = this.computePersonalizedPageRank(seedNodeIds, seedWeight);
    return this.rankNodes(scores, limit, excludeTypes);
  }

  /**
   * Rank nodes by their scores, applying filters.
   */
  private rankNodes(
    scores: Map<string, number>,
    limit: number,
    excludeTypes: string[],
  ): RankedNode[] {
    const excludeSet = new Set(excludeTypes);

    // Sort by score descending
    const sortedIds = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const ranked: RankedNode[] = [];

    // Fetch nodes in batches for efficiency
    const batchSize = Math.min(limit * 3, sortedIds.length); // Fetch extra to account for filtering
    const candidateIds = sortedIds.slice(0, batchSize);
    const nodes = this.graph.getNodesByIds(candidateIds);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    for (const id of sortedIds) {
      if (ranked.length >= limit) break;

      const node = nodeMap.get(id);
      if (!node) continue;
      if (excludeSet.has(node.type)) continue;

      ranked.push({
        node,
        score: scores.get(id)!,
        tokenCost: this.estimateNodeTokenCost(node),
      });
    }

    return ranked;
  }

  /**
   * Get nodes that fit within a token budget, ranked by importance.
   *
   * Greedily fills the budget with the highest-ranked nodes first.
   *
   * @param tokenBudget - Maximum tokens to use
   * @param seedNodeIds - Optional seed nodes for personalized ranking
   * @param excludeTypes - Node types to exclude
   * @returns Ranked nodes fitting within budget
   */
  getNodesWithinBudget(
    tokenBudget: number,
    seedNodeIds?: string[],
    excludeTypes: string[] = ['file'],
  ): RankedNode[] {
    const scores = seedNodeIds && seedNodeIds.length > 0
      ? this.computePersonalizedPageRank(seedNodeIds)
      : this.computePageRank();

    const excludeSet = new Set(excludeTypes);

    // Sort by score descending
    const sortedIds = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const allNodes = this.graph.getNodesByIds(sortedIds.slice(0, sortedIds.length));
    const nodeMap = new Map(allNodes.map(n => [n.id, n]));

    const result: RankedNode[] = [];
    let usedTokens = 0;

    for (const id of sortedIds) {
      const node = nodeMap.get(id);
      if (!node) continue;
      if (excludeSet.has(node.type)) continue;

      const cost = this.estimateNodeTokenCost(node);
      if (usedTokens + cost > tokenBudget) {
        // Try to fit a few more smaller nodes
        if (cost > tokenBudget * 0.1) continue;
        if (usedTokens + cost > tokenBudget) break;
      }

      result.push({
        node,
        score: scores.get(id)!,
        tokenCost: cost,
      });
      usedTokens += cost;
    }

    return result;
  }

  // ============================================================
  // Repo Map Generation
  // ============================================================

  /**
   * Generate a compact repository map string within a token budget.
   *
   * Produces an Aider-style repo map that shows the most important
   * symbols' signatures, organized by file. This is the primary
   * output for token-efficient context.
   *
   * @param tokenBudget - Maximum tokens for the repo map
   * @param seedNodeIds - Optional seed nodes for personalized ranking
   * @returns Compact repo map string
   */
  generateRepoMap(
    tokenBudget: number,
    seedNodeIds?: string[],
  ): string {
    const rankedNodes = this.getNodesWithinBudget(tokenBudget, seedNodeIds);

    if (rankedNodes.length === 0) {
      return '// Empty repo map — no nodes indexed yet';
    }

    // Group nodes by file
    const fileGroups = new Map<string, RankedNode[]>();
    for (const rn of rankedNodes) {
      const group = fileGroups.get(rn.node.filePath) ?? [];
      group.push(rn);
      fileGroups.set(rn.node.filePath, group);
    }

    // Sort files by max score of their nodes
    const sortedFiles = Array.from(fileGroups.entries())
      .sort((a, b) => {
        const maxA = Math.max(...a[1].map(rn => rn.score));
        const maxB = Math.max(...b[1].map(rn => rn.score));
        return maxB - maxA;
      });

    // Build the repo map string
    const lines: string[] = [];
    let currentTokens = 0;

    for (const [filePath, nodes] of sortedFiles) {
      // File header
      const header = `\n// ${filePath}`;
      const headerCost = Math.ceil(header.length / 4);

      if (currentTokens + headerCost > tokenBudget) break;

      lines.push(header);
      currentTokens += headerCost;

      // Sort nodes within file by line number
      nodes.sort((a, b) => a.node.startLine - b.node.startLine);

      for (const { node } of nodes) {
        // Build the entry
        let entry = '';

        // Add a brief doc comment if available
        if (node.docComment) {
          const firstLine = node.docComment.split('\n')[0].trim();
          if (firstLine.length <= 80) {
            entry += `  /** ${firstLine} */\n`;
          }
        }

        // Indent methods/properties (nested under class)
        const indent = node.qualifiedName.includes('.') ? '  ' : '';
        entry += `${indent}${node.signature}`;

        const entryCost = Math.ceil(entry.length / 4);

        if (currentTokens + entryCost > tokenBudget) continue;

        lines.push(entry);
        currentTokens += entryCost;
      }
    }

    return lines.join('\n').trim();
  }

  /**
   * Get a simple map of file paths → their top symbols.
   * Useful for a table-of-contents view of the project.
   *
   * @param maxSymbolsPerFile - Max symbols to show per file (default 10)
   * @returns Map of file path → symbol signatures
   */
  getProjectTOC(maxSymbolsPerFile: number = 10): Map<string, string[]> {
    const scores = this.computePageRank();
    const nodeIds = Array.from(scores.keys());
    const allNodes = this.graph.getNodesByIds(nodeIds);

    // Group by file
    const fileNodes = new Map<string, { node: GraphNode; score: number }[]>();
    for (const node of allNodes) {
      if (node.type === 'file') continue;

      const score = scores.get(node.id) ?? 0;
      const group = fileNodes.get(node.filePath) ?? [];
      group.push({ node, score });
      fileNodes.set(node.filePath, group);
    }

    // Build TOC
    const toc = new Map<string, string[]>();
    for (const [filePath, nodes] of fileNodes) {
      // Sort by score, take top N
      nodes.sort((a, b) => b.score - a.score);
      const topNodes = nodes.slice(0, maxSymbolsPerFile);
      toc.set(filePath, topNodes.map(n => n.node.signature));
    }

    return toc;
  }
}
