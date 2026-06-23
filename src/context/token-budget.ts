/**
 * AI Mind Map — Token Budget Manager
 *
 * Explicit token budget management inspired by Aider's `--map-tokens`
 * approach.  Provides per-component budgets, enforcement, smart
 * truncation at logical boundaries, dynamic reallocation, and
 * formatted budget reports.
 */

import type { TokenBudget } from '../types.js';
import {
  estimateTokens,
  truncateToTokenBudget,
} from '../utils/token-counter.js';
import { Logger } from '../utils/logger.js';

const logger = new Logger({ prefix: 'TokenBudget' });

// ── Types ────────────────────────────────────────────────────

/** Label for a budget component (matches the keys of {@link TokenBudget}). */
export type BudgetComponent =
  | 'graphResults'
  | 'changeSummary'
  | 'memoryRetrieval'
  | 'fileContent';

/** Snapshot of a single component's budget state. */
export interface ComponentBudgetState {
  component: BudgetComponent;
  label: string;
  used: number;
  budget: number;
  remaining: number;
}

/** Full budget report across all components. */
export interface BudgetReport {
  components: ComponentBudgetState[];
  totalUsed: number;
  totalBudget: number;
  totalRemaining: number;
  /** Estimated savings vs reading entire files naively. */
  savingsPercent: number;
}

/** Human-readable labels for each budget component. */
const COMPONENT_LABELS: Record<BudgetComponent, string> = {
  graphResults: 'Graph Results',
  changeSummary: 'Change Summary',
  memoryRetrieval: 'Memory Retrieval',
  fileContent: 'File Content',
};

/** All component keys in display order. */
const ALL_COMPONENTS: BudgetComponent[] = [
  'graphResults',
  'changeSummary',
  'memoryRetrieval',
  'fileContent',
];

// ── Budget Manager Class ─────────────────────────────────────

/**
 * Manages token budgets across all context components.
 *
 * Usage:
 * ```ts
 * const mgr = new TokenBudgetManager(config.tokenBudgets);
 * const text = mgr.enforceComponentBudget('graphResults', longText);
 * mgr.recordUsage('graphResults', text);
 * const report = mgr.generateReport();
 * ```
 */
export class TokenBudgetManager {
  /** Per-component budgets (immutable originals). */
  private readonly baseBudgets: Readonly<TokenBudget>;
  /** Current effective budgets (may be reallocated). */
  private readonly effectiveBudgets: TokenBudget;
  /** Running token counts per component. */
  private readonly usage: Record<BudgetComponent, number>;
  /** Total budget across all components. */
  private readonly totalBudget: number;
  /** Estimated naive cost (for savings calculation). */
  private naiveCost = 0;

  constructor(budgets: TokenBudget) {
    this.baseBudgets = { ...budgets };
    this.effectiveBudgets = { ...budgets };
    this.totalBudget = budgets.totalContext;
    this.usage = {
      graphResults: 0,
      changeSummary: 0,
      memoryRetrieval: 0,
      fileContent: 0,
    };
  }

  // ── Query ──────────────────────────────────────────────

  /** Get the current effective budget for a component. */
  getBudget(component: BudgetComponent): number {
    return this.effectiveBudgets[component];
  }

  /** Get current token usage for a component. */
  getUsage(component: BudgetComponent): number {
    return this.usage[component];
  }

  /** Get remaining tokens for a component. */
  getRemaining(component: BudgetComponent): number {
    return Math.max(0, this.effectiveBudgets[component] - this.usage[component]);
  }

  /** Get total tokens used across all components. */
  getTotalUsed(): number {
    let sum = 0;
    for (const c of ALL_COMPONENTS) {
      sum += this.usage[c];
    }
    return sum;
  }

  /** Get total tokens remaining across all components. */
  getTotalRemaining(): number {
    return Math.max(0, this.totalBudget - this.getTotalUsed());
  }

  /** Check whether the total budget has been exceeded. */
  isOverBudget(): boolean {
    return this.getTotalUsed() > this.totalBudget;
  }

  // ── Recording ──────────────────────────────────────────

  /**
   * Record that `tokenCount` tokens were consumed by `component`.
   *
   * @param component  - The budget component.
   * @param text       - The text whose tokens to count (or supply a number).
   */
  recordUsage(component: BudgetComponent, text: string | number): void {
    const tokens = typeof text === 'number' ? text : estimateTokens(text);
    this.usage[component] += tokens;
    logger.debug(`${COMPONENT_LABELS[component]}: +${tokens} tokens (total: ${this.usage[component]})`);
  }

  /**
   * Record the "naive" cost — the estimated tokens if entire files were
   * sent without compression.  Used for savings calculation.
   */
  recordNaiveCost(tokens: number): void {
    this.naiveCost += tokens;
  }

  /** Reset all usage counters (e.g., for a new request). */
  resetUsage(): void {
    for (const c of ALL_COMPONENTS) {
      this.usage[c] = 0;
    }
    this.naiveCost = 0;
    // Restore effective budgets to base values.
    Object.assign(this.effectiveBudgets, this.baseBudgets);
    logger.debug('Budget usage reset');
  }

  // ── Enforcement ────────────────────────────────────────

  /**
   * Enforce the budget for a component by truncating content if necessary.
   *
   * @param component - The budget component.
   * @param text      - The input text.
   * @returns The (possibly truncated) text that fits within the budget.
   */
  enforceComponentBudget(component: BudgetComponent, text: string): string {
    const budget = this.getRemaining(component);

    if (budget <= 0) {
      logger.warn(`${COMPONENT_LABELS[component]}: budget exhausted, returning empty`);
      return `[${COMPONENT_LABELS[component]}: budget exhausted]`;
    }

    const tokens = estimateTokens(text);
    if (tokens <= budget) {
      return text;
    }

    logger.debug(
      `${COMPONENT_LABELS[component]}: truncating ${tokens} → ${budget} tokens`,
    );

    return truncateToTokenBudget(text, budget);
  }

  /**
   * Enforce the total context budget on a final assembled context string.
   *
   * @param text - The assembled context.
   * @returns The (possibly truncated) text.
   */
  enforceTotalBudget(text: string): string {
    const remaining = this.getTotalRemaining();
    const tokens = estimateTokens(text);

    if (tokens <= remaining) {
      return text;
    }

    logger.debug(`Total budget: truncating ${tokens} → ${remaining} tokens`);
    return truncateToTokenBudget(text, remaining);
  }

  // ── Dynamic Reallocation ───────────────────────────────

  /**
   * Reallocate unused budget from components that used less than their
   * allocation to components that need more.
   *
   * Call this after all components have submitted their initial content
   * but before final assembly.
   */
  reallocate(): void {
    // Calculate how much each component has left.
    let surplus = 0;
    const needMore: BudgetComponent[] = [];

    for (const c of ALL_COMPONENTS) {
      const remaining = this.effectiveBudgets[c] - this.usage[c];
      if (remaining > 50) {
        // This component has surplus — make it available.
        surplus += remaining;
        // Shrink its effective budget to what it actually used + 10% buffer.
        this.effectiveBudgets[c] = Math.ceil(this.usage[c] * 1.1);
        surplus -= this.effectiveBudgets[c] - this.usage[c]; // Subtract the buffer
      } else if (remaining < 0) {
        needMore.push(c);
      }
    }

    // Recalculate surplus after adjustments.
    surplus = 0;
    for (const c of ALL_COMPONENTS) {
      const remaining = this.effectiveBudgets[c] - this.usage[c];
      if (remaining > 0) {
        surplus += remaining;
      }
    }

    if (surplus <= 0 || needMore.length === 0) {
      return;
    }

    // Distribute surplus evenly among components that need more.
    const perComponent = Math.floor(surplus / needMore.length);
    for (const c of needMore) {
      this.effectiveBudgets[c] += perComponent;
      logger.debug(
        `Reallocated +${perComponent} tokens to ${COMPONENT_LABELS[c]}`,
      );
    }
  }

  // ── Reporting ──────────────────────────────────────────

  /**
   * Generate a structured budget report.
   */
  generateReport(): BudgetReport {
    const totalUsed = this.getTotalUsed();
    const components: ComponentBudgetState[] = ALL_COMPONENTS.map((c) => ({
      component: c,
      label: COMPONENT_LABELS[c],
      used: this.usage[c],
      budget: this.effectiveBudgets[c],
      remaining: Math.max(0, this.effectiveBudgets[c] - this.usage[c]),
    }));

    const savingsPercent =
      this.naiveCost > 0
        ? Math.round((1 - totalUsed / this.naiveCost) * 100)
        : 0;

    return {
      components,
      totalUsed,
      totalBudget: this.totalBudget,
      totalRemaining: Math.max(0, this.totalBudget - totalUsed),
      savingsPercent,
    };
  }

  /**
   * Generate a formatted text table of the budget report.
   *
   * Example output:
   * ```
   * Token Budget Report:
   * ┌──────────────────┬───────┬──────────┬────────────┐
   * │ Component        │ Used  │ Budget   │ Remaining  │
   * ├──────────────────┼───────┼──────────┼────────────┤
   * │ Graph Results    │ 1,200 │ 2,000    │ 800        │
   * │ Change Summary   │   450 │ 1,000    │ 550        │
   * ...
   * ```
   */
  formatReport(): string {
    const report = this.generateReport();
    return formatBudgetTable(report);
  }
}

// ── Formatting Helpers ───────────────────────────────────────

/**
 * Format a number with thousands separators.
 * e.g. 12345 → "12,345"
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Right-pad or right-align a string within a fixed width.
 */
function padRight(str: string, width: number): string {
  return str.padEnd(width);
}

function padLeft(str: string, width: number): string {
  return str.padStart(width);
}

/**
 * Build the formatted budget table string.
 */
function formatBudgetTable(report: BudgetReport): string {
  const colW = { name: 18, used: 7, budget: 10, remaining: 12 };
  const totalW = colW.name + colW.used + colW.budget + colW.remaining + 13; // + borders

  const border = (left: string, mid: string, right: string, fill: string) =>
    `${left}${fill.repeat(colW.name + 2)}${mid}${fill.repeat(colW.used + 2)}${mid}${fill.repeat(colW.budget + 2)}${mid}${fill.repeat(colW.remaining + 2)}${right}`;

  const row = (name: string, used: string, budget: string, remaining: string) =>
    `│ ${padRight(name, colW.name)} │ ${padLeft(used, colW.used)} │ ${padLeft(budget, colW.budget)} │ ${padLeft(remaining, colW.remaining)} │`;

  const lines: string[] = [
    'Token Budget Report:',
    border('┌', '┬', '┐', '─'),
    row('Component', 'Used', 'Budget', 'Remaining'),
    border('├', '┼', '┤', '─'),
  ];

  for (const c of report.components) {
    lines.push(
      row(
        c.label,
        formatNumber(c.used),
        formatNumber(c.budget),
        formatNumber(c.remaining),
      ),
    );
  }

  lines.push(border('├', '┼', '┤', '─'));
  lines.push(
    row(
      'TOTAL',
      formatNumber(report.totalUsed),
      formatNumber(report.totalBudget),
      formatNumber(report.totalRemaining),
    ),
  );
  lines.push(border('└', '┴', '┘', '─'));

  if (report.savingsPercent > 0) {
    lines.push(`Estimated savings: ${report.savingsPercent}% vs naive file reading`);
  }

  return lines.join('\n');
}
