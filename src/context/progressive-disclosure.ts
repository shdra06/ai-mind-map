/**
 * AI Mind Map — Progressive Disclosure Engine
 *
 * Three-tier context loading system inspired by context-mem's multi-layer
 * retrieval and the Hot / Warm / Cold caching pattern.
 *
 * Tier 1 (Always Loaded, ≤ 500 tokens):
 *   Project identity, directory skeleton, conventions, active task.
 *
 * Tier 2 (Searchable, ≤ 2 000 tokens):
 *   Knowledge-graph query results, recent changes, relevant memories,
 *   active decisions.
 *
 * Tier 3 (On-Demand, variable budget):
 *   Full (compressed) file contents, detailed test output, historical
 *   diffs, full decision rationale.
 *
 * Each tier enforces its own token budget. The engine assembles a
 * {@link ContextPackage} with per-component breakdowns and savings
 * estimates.
 */

import type {
  ContextPackage,
  ContextTier,
  TokenBudget,
  Memory,
  Decision,
  FileChange,
  GraphNode,
} from '../types.js';
import {
  TokenBudgetManager,
} from './token-budget.js';
import { compress } from './compressor.js';
import { estimateTokens, truncateToTokenBudget } from '../utils/token-counter.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger({ prefix: 'Progressive' });

// ── Tier Definitions ─────────────────────────────────────────

/** Default token budget for each tier. */
const TIER1_BUDGET = 500;
const TIER2_BUDGET = 2000;

/** Static tier metadata. */
export const TIERS: ContextTier[] = [
  {
    tier: 1,
    label: 'Always Loaded',
    description: 'Project identity, directory overview, conventions, current task',
    tokenBudget: TIER1_BUDGET,
    alwaysLoaded: true,
  },
  {
    tier: 2,
    label: 'Searchable',
    description: 'Graph results, recent changes, relevant memories, decisions',
    tokenBudget: TIER2_BUDGET,
    alwaysLoaded: false,
  },
  {
    tier: 3,
    label: 'On-Demand',
    description: 'Full file contents, detailed outputs, historical diffs',
    tokenBudget: 0, // Dynamic — determined by remaining total budget
    alwaysLoaded: false,
  },
];

// ── Input types ──────────────────────────────────────────────

/** Minimal project info required for Tier 1. */
export interface ProjectInfo {
  name: string;
  description: string;
  techStack: string[];
  /** Top-level directory tree (depth 2, with file counts). */
  directoryTree: string;
  /** Active conventions / critical rules. */
  conventions: string[];
  /** Current task description (if any). */
  currentTask?: string;
}

/** Data available for Tier 2 assembly. */
export interface Tier2Data {
  /** Knowledge-graph nodes matching a query. */
  graphNodes?: GraphNode[];
  /** Recent file changes. */
  recentChanges?: FileChange[];
  /** Relevant memories (pre-scored, sorted by relevance). */
  memories?: Memory[];
  /** Active decisions. */
  decisions?: Decision[];
}

/** Data available for Tier 3 on-demand loading. */
export interface Tier3Data {
  /** Full file contents (path → content). */
  fileContents?: Map<string, string>;
  /** Detailed test output. */
  testOutput?: string;
  /** Historical change diffs. */
  changeDiffs?: string[];
  /** Full decision details. */
  fullDecisions?: Decision[];
}

// ── Progressive Disclosure Engine ────────────────────────────

/**
 * Build a complete {@link ContextPackage} by assembling the three tiers
 * of progressive context.
 *
 * @param projectInfo - Static project metadata (Tier 1).
 * @param tier2Data   - Searchable context items (Tier 2).
 * @param tier3Data   - On-demand detail items (Tier 3).
 * @param budgets     - Token budget configuration.
 * @param query       - Optional query string for relevance hints.
 * @returns A fully-assembled context package.
 */
export function buildContextPackage(
  projectInfo: ProjectInfo,
  tier2Data: Tier2Data,
  tier3Data: Tier3Data,
  budgets: TokenBudget,
  query?: string,
): ContextPackage {
  const budgetMgr = new TokenBudgetManager(budgets);
  const breakdown: { component: string; tokens: number; budget: number }[] = [];

  // ── Tier 1: Always loaded ─────────────────────────────
  const tier1 = buildTier1(projectInfo, TIER1_BUDGET);
  const tier1Tokens = estimateTokens(tier1);
  breakdown.push({ component: 'Project Overview', tokens: tier1Tokens, budget: TIER1_BUDGET });

  // ── Tier 2: Searchable ────────────────────────────────
  const tier2 = buildTier2(tier2Data, budgetMgr, query);
  const tier2Tokens = estimateTokens(tier2);
  // Track breakdown from budget manager
  const bgReport = budgetMgr.generateReport();
  for (const c of bgReport.components) {
    if (c.used > 0) {
      breakdown.push({ component: c.label, tokens: c.used, budget: c.budget });
    }
  }

  // ── Tier 3: On-demand ─────────────────────────────────
  const tier3Budget = Math.max(
    0,
    budgets.totalContext - tier1Tokens - tier2Tokens,
  );
  const tier3 = buildTier3(tier3Data, tier3Budget, budgetMgr);
  const tier3Tokens = estimateTokens(tier3);
  if (tier3Tokens > 0) {
    breakdown.push({ component: 'On-Demand Details', tokens: tier3Tokens, budget: tier3Budget });
  }

  const totalTokens = tier1Tokens + tier2Tokens + tier3Tokens;

  // Estimate naive cost: sum of all raw content.
  const naiveCost = estimateNaiveCost(projectInfo, tier2Data, tier3Data);
  const tokensSaved = Math.max(0, naiveCost - totalTokens);

  logger.info(
    `Context assembled: ${totalTokens} tokens (saved ~${tokensSaved} vs naive)`,
  );

  return {
    tier1,
    tier2,
    tier3,
    totalTokens,
    tokensSaved,
    breakdown,
  };
}

// ── Tier 1 Builder ───────────────────────────────────────────

/**
 * Build Tier 1 context: always-loaded project overview.
 * Strictly budget-capped.
 */
function buildTier1(info: ProjectInfo, budget: number): string {
  const sections: string[] = [];

  // Project identity
  sections.push(`# ${info.name}`);
  if (info.description) {
    sections.push(info.description);
  }

  // Tech stack
  if (info.techStack.length > 0) {
    sections.push(`Tech: ${info.techStack.join(', ')}`);
  }

  // Directory overview
  if (info.directoryTree) {
    sections.push('');
    sections.push('## Structure');
    sections.push(info.directoryTree);
  }

  // Conventions
  if (info.conventions.length > 0) {
    sections.push('');
    sections.push('## Conventions');
    for (const conv of info.conventions) {
      sections.push(`- ${conv}`);
    }
  }

  // Current task
  if (info.currentTask) {
    sections.push('');
    sections.push(`## Current Task`);
    sections.push(info.currentTask);
  }

  const assembled = sections.join('\n');
  return truncateToTokenBudget(assembled, budget, '\n... [tier-1 truncated]');
}

// ── Tier 2 Builder ───────────────────────────────────────────

/**
 * Build Tier 2 context: searchable results based on query relevance.
 * Uses the budget manager for per-component limits.
 */
function buildTier2(
  data: Tier2Data,
  budgetMgr: TokenBudgetManager,
  query?: string,
): string {
  const sections: string[] = [];

  // ── Graph results ──────────────────────────────────
  if (data.graphNodes && data.graphNodes.length > 0) {
    const graphSection = formatGraphNodes(data.graphNodes);
    const enforced = budgetMgr.enforceComponentBudget('graphResults', graphSection);
    budgetMgr.recordUsage('graphResults', enforced);
    if (enforced.length > 0) {
      sections.push('## Relevant Symbols');
      sections.push(enforced);
    }
  }

  // ── Recent changes ─────────────────────────────────
  if (data.recentChanges && data.recentChanges.length > 0) {
    const changeSection = formatChanges(data.recentChanges);
    const enforced = budgetMgr.enforceComponentBudget('changeSummary', changeSection);
    budgetMgr.recordUsage('changeSummary', enforced);
    if (enforced.length > 0) {
      sections.push('## Recent Changes');
      sections.push(enforced);
    }
  }

  // ── Relevant memories ──────────────────────────────
  if (data.memories && data.memories.length > 0) {
    const memSection = formatMemories(data.memories);
    const enforced = budgetMgr.enforceComponentBudget('memoryRetrieval', memSection);
    budgetMgr.recordUsage('memoryRetrieval', enforced);
    if (enforced.length > 0) {
      sections.push('## Relevant Memories');
      sections.push(enforced);
    }
  }

  // ── Active decisions ───────────────────────────────
  if (data.decisions && data.decisions.length > 0) {
    const decSection = formatDecisionSummaries(data.decisions);
    // Decisions share the memoryRetrieval budget (they're lightweight).
    const remaining = budgetMgr.getRemaining('memoryRetrieval');
    const enforced =
      remaining > 0
        ? truncateToTokenBudget(decSection, remaining)
        : '';
    if (enforced.length > 0) {
      budgetMgr.recordUsage('memoryRetrieval', enforced);
      sections.push('## Active Decisions');
      sections.push(enforced);
    }
  }

  return sections.join('\n');
}

// ── Tier 3 Builder ───────────────────────────────────────────

/**
 * Build Tier 3 context: on-demand detailed content.
 * Budget is whatever remains after Tier 1 + Tier 2.
 */
function buildTier3(
  data: Tier3Data,
  budget: number,
  budgetMgr: TokenBudgetManager,
): string {
  if (budget <= 0) {
    return '';
  }

  const sections: string[] = [];
  let remaining = budget;

  // ── File contents (compressed) ─────────────────────
  if (data.fileContents && data.fileContents.size > 0) {
    for (const [filePath, content] of data.fileContents) {
      if (remaining <= 50) break;

      const compressed = compress(content, 'moderate');
      const fileSection = `### ${filePath}\n\`\`\`\n${compressed.compressed}\n\`\`\``;
      const enforced = budgetMgr.enforceComponentBudget('fileContent', fileSection);
      const tokens = estimateTokens(enforced);

      if (tokens <= remaining) {
        budgetMgr.recordUsage('fileContent', tokens);
        budgetMgr.recordNaiveCost(estimateTokens(content));
        sections.push(enforced);
        remaining -= tokens;
      }
    }
  }

  // ── Test output ────────────────────────────────────
  if (data.testOutput && remaining > 50) {
    const compressed = compress(data.testOutput, 'moderate', 'test_output');
    const enforced = truncateToTokenBudget(
      `### Test Output\n${compressed.compressed}`,
      remaining,
    );
    const tokens = estimateTokens(enforced);
    budgetMgr.recordNaiveCost(estimateTokens(data.testOutput));
    sections.push(enforced);
    remaining -= tokens;
  }

  // ── Change diffs ───────────────────────────────────
  if (data.changeDiffs && data.changeDiffs.length > 0 && remaining > 50) {
    for (const diff of data.changeDiffs) {
      if (remaining <= 50) break;
      const compressed = compress(diff, 'moderate', 'diff');
      const enforced = truncateToTokenBudget(compressed.compressed, remaining);
      const tokens = estimateTokens(enforced);
      budgetMgr.recordNaiveCost(estimateTokens(diff));
      sections.push(`### Diff\n\`\`\`diff\n${enforced}\n\`\`\``);
      remaining -= tokens;
    }
  }

  // ── Full decision details ──────────────────────────
  if (data.fullDecisions && data.fullDecisions.length > 0 && remaining > 50) {
    const decDetails = formatFullDecisions(data.fullDecisions);
    const enforced = truncateToTokenBudget(decDetails, remaining);
    sections.push(enforced);
  }

  return sections.join('\n\n');
}

// ================================================================
// Formatters
// ================================================================

/** Format graph nodes as a compact symbol listing. */
function formatGraphNodes(nodes: GraphNode[]): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const vis = node.visibility !== 'unknown' ? `${node.visibility} ` : '';
    const asyncTag = node.isAsync ? 'async ' : '';
    const staticTag = node.isStatic ? 'static ' : '';
    const prefix = `${vis}${staticTag}${asyncTag}`;

    let entry: string;
    switch (node.type) {
      case 'function':
      case 'method':
      case 'constructor':
      case 'hook':
        entry = `${prefix}${node.signature}`;
        break;
      case 'class':
      case 'interface':
      case 'type_alias':
      case 'enum':
        entry = `${node.type} ${node.name}`;
        break;
      case 'variable':
      case 'constant':
        entry = `${node.type} ${node.name}${node.returnType ? ': ' + node.returnType : ''}`;
        break;
      default:
        entry = `${node.type} ${node.qualifiedName}`;
    }

    const location = `${node.filePath}:${node.startLine}`;
    lines.push(`- \`${entry.trim()}\` — ${location}`);

    // Include doc comment summary if available.
    if (node.docComment) {
      const firstLine = node.docComment.split('\n')[0].replace(/^\/\*\*\s*|\*\/$/g, '').trim();
      if (firstLine) {
        lines.push(`  ${firstLine}`);
      }
    }
  }

  return lines.join('\n');
}

/** Format file changes as a compact summary. */
function formatChanges(changes: FileChange[]): string {
  const lines: string[] = [];

  for (const change of changes) {
    const delta =
      change.linesAdded || change.linesRemoved
        ? ` (+${change.linesAdded}/-${change.linesRemoved})`
        : '';
    const symbols =
      change.symbolsAffected.length > 0
        ? ` [${change.symbolsAffected.join(', ')}]`
        : '';
    lines.push(`- ${changeIcon(change.changeType)} \`${change.filePath}\`${delta}${symbols}`);
    if (change.summary) {
      lines.push(`  ${change.summary}`);
    }
  }

  return lines.join('\n');
}

function changeIcon(type: string): string {
  switch (type) {
    case 'created':
      return '✚';
    case 'modified':
      return '✎';
    case 'deleted':
      return '✖';
    case 'renamed':
      return '➜';
    default:
      return '•';
  }
}

/** Format memories as a bullet list. */
function formatMemories(memories: Memory[]): string {
  const lines: string[] = [];

  for (const mem of memories) {
    const tag = mem.category.toUpperCase();
    const importance = Math.round(mem.importance * 100);
    lines.push(`- [${tag}] (${importance}%) ${mem.content}`);
    if (mem.relatedFiles.length > 0) {
      lines.push(`  Files: ${mem.relatedFiles.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/** Format decisions as one-line summaries (for Tier 2). */
function formatDecisionSummaries(decisions: Decision[]): string {
  return decisions
    .map((d) => `- **${d.title}** (${d.status}): ${d.description}`)
    .join('\n');
}

/** Format full decision details (for Tier 3). */
function formatFullDecisions(decisions: Decision[]): string {
  const parts: string[] = ['### Decision Details'];

  for (const d of decisions) {
    parts.push(`#### ${d.title} [${d.status}]`);
    parts.push(d.description);
    parts.push(`**Rationale:** ${d.rationale}`);

    if (d.alternatives.length > 0) {
      parts.push(`**Alternatives considered:** ${d.alternatives.join('; ')}`);
    }
    if (d.consequences.length > 0) {
      parts.push(`**Trade-offs:** ${d.consequences.join('; ')}`);
    }
    if (d.relatedFiles.length > 0) {
      parts.push(`**Files:** ${d.relatedFiles.join(', ')}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ── Naive Cost Estimation ────────────────────────────────────

/**
 * Estimate the token cost of sending everything without compression
 * or progressive loading.  Used for savings calculation.
 */
function estimateNaiveCost(
  projectInfo: ProjectInfo,
  tier2Data: Tier2Data,
  tier3Data: Tier3Data,
): number {
  let cost = 0;

  // Tier 1 would be roughly the same.
  cost += estimateTokens(projectInfo.directoryTree || '');
  cost += estimateTokens(projectInfo.description || '');

  // Tier 2: graph nodes with full signatures & doc comments.
  if (tier2Data.graphNodes) {
    for (const node of tier2Data.graphNodes) {
      cost += estimateTokens(node.signature);
      cost += estimateTokens(node.docComment || '');
    }
  }

  // Tier 2: full change records.
  if (tier2Data.recentChanges) {
    for (const change of tier2Data.recentChanges) {
      cost += estimateTokens(change.summary);
      cost += estimateTokens(change.filePath);
    }
  }

  // Tier 2: full memory text.
  if (tier2Data.memories) {
    for (const mem of tier2Data.memories) {
      cost += estimateTokens(mem.content);
    }
  }

  // Tier 3: full uncompressed files.
  if (tier3Data.fileContents) {
    for (const [, content] of tier3Data.fileContents) {
      cost += estimateTokens(content);
    }
  }

  // Tier 3: full test output.
  if (tier3Data.testOutput) {
    cost += estimateTokens(tier3Data.testOutput);
  }

  // Tier 3: full diffs.
  if (tier3Data.changeDiffs) {
    for (const diff of tier3Data.changeDiffs) {
      cost += estimateTokens(diff);
    }
  }

  return cost;
}
