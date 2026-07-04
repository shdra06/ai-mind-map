/**
 * AI Mind Map — Memory MCP Tools
 *
 * Registers all memory-related tools on the MCP server.
 * Covers both episodic memories and architectural decisions.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Memory,
  MemoryCategory,
  Decision,
  SessionSummary,
  ToolResult,
} from '../types.js';

// ============================================================
// Subsystem interfaces
// ============================================================

/**
 * Minimal interface expected of the Memory Store subsystem.
 */
export interface IMemoryStore {
  /** Retrieve memories matching a query, ranked by importance. */
  recall(query: string, category?: MemoryCategory, limit?: number): Memory[];

  /** Store a new memory. Returns the created memory. */
  remember(params: {
    content: string;
    category: MemoryCategory;
    tags: string[];
    relatedFiles: string[];
    importance?: number;
    sessionId: string;
    source: 'agent' | 'user' | 'auto';
  }): Memory;

  /** Retrieve architectural decisions. */
  getDecisions(params: {
    status?: 'active' | 'all';
    query?: string;
  }): Decision[];

  /** Record a new decision. Returns the created decision. */
  decide(params: {
    title: string;
    description: string;
    rationale: string;
    alternatives: string[];
    consequences: string[];
    relatedFiles: string[];
    tags: string[];
    decidedBy: string;
  }): Decision;

  /** Get summaries of previous AI sessions, most recent first. */
  getSessionSummaries(count: number): SessionSummary[];
}

/**
 * Provides the current session ID for tagging new memories.
 */
export interface ISessionProvider {
  currentSessionId(): string;
}

export interface ITokenEstimator {
  estimate(text: string): number;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

// ============================================================
// Memory category enum for Zod
// ============================================================

const MEMORY_CATEGORIES: [MemoryCategory, ...MemoryCategory[]] = [
  'architecture',
  'convention',
  'decision',
  'gotcha',
  'dependency',
  'workflow',
  'context',
  'preference',
  'lesson_learned',
  'todo',
];

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
 * Register all Memory tools on the given MCP server.
 *
 * @param server    The MCP server instance.
 * @param store     Concrete memory-store implementation.
 * @param session   Provides the current session ID.
 * @param estimator Optional token estimator.
 */
export function registerMemoryTools(
  server: McpServer,
  store: IMemoryStore,
  session: ISessionProvider,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  // ── mindmap_recall ──────────────────────────────────────────
  server.tool(
    'mindmap_recall',
    'Retrieve relevant memories ranked by importance.',
    {
      query: z.string().describe('Describe what you need to recall'),
      category: z
        .enum(MEMORY_CATEGORIES)
        .optional()
        .describe('Optional category filter'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Max memories to return'),
    },
    async ({ query, category, limit }) => {
      try {
        const memories = store.recall(query, category, limit);
        return mcpText(ok(memories, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Recall failed: ${msg}`));
      }
    },
  );

  // ── mindmap_remember ────────────────────────────────────────
  server.tool(
    'mindmap_remember',
    'Store a fact or convention for future sessions.',
    {
      content: z.string().min(1).describe('The fact or insight to remember'),
      category: z.enum(MEMORY_CATEGORIES).describe('Memory category'),
      tags: z.array(z.string()).describe('Tags for retrieval'),
      relatedFiles: z
        .array(z.string())
        .describe('File paths this memory relates to'),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Importance score 0-1 (default: auto-calculated)'),
    },
    async ({ content, category, tags, relatedFiles, importance }) => {
      try {
        const memory = store.remember({
          content,
          category,
          tags,
          relatedFiles,
          importance,
          sessionId: session.currentSessionId(),
          source: 'agent',
        });
        return mcpText(
          ok(
            {
              id: memory.id,
              message: 'Memory stored successfully',
              category: memory.category,
              importance: memory.importance,
            },
            estimator,
          ),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Remember failed: ${msg}`));
      }
    },
  );

  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  server.tool(
    'mindmap_get_decisions',
    'Retrieve architectural and technical decisions. Useful for understanding why things were built a certain way.',
    {
      status: z
        .enum(['active', 'all'])
        .optional()
        .default('active')
        .describe("Filter by status: 'active' (default) or 'all'"),
      query: z
        .string()
        .optional()
        .describe('Optional search query to filter decisions'),
    },
    async ({ status, query }) => {
      try {
        const decisions = store.getDecisions({ status, query });
        return mcpText(ok(decisions, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Get decisions failed: ${msg}`));
      }
    },
  );
  } */

  // ── mindmap_decide ──────────────────────────────────────────
  server.tool(
    'mindmap_decide',
    'Record an architectural decision with rationale and alternatives.',
    {
      title: z.string().min(1).describe('Short title for the decision'),
      description: z.string().min(1).describe('Detailed description'),
      rationale: z.string().min(1).describe('Why this option was chosen'),
      alternatives: z
        .array(z.string())
        .describe('Other options that were considered'),
      consequences: z
        .array(z.string())
        .describe('Known trade-offs or downstream effects'),
      relatedFiles: z
        .array(z.string())
        .describe('Files affected by this decision'),
      tags: z.array(z.string()).describe('Tags for retrieval'),
    },
    async ({
      title,
      description,
      rationale,
      alternatives,
      consequences,
      relatedFiles,
      tags,
    }) => {
      try {
        const decision = store.decide({
          title,
          description,
          rationale,
          alternatives,
          consequences,
          relatedFiles,
          tags,
          decidedBy: session.currentSessionId(),
        });
        return mcpText(
          ok(
            {
              id: decision.id,
              message: 'Decision recorded successfully',
              title: decision.title,
              status: decision.status,
            },
            estimator,
          ),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Decide failed: ${msg}`));
      }
    },
  );

  // CONSOLIDATED: Functionality available via other tools
  /* if (false) {
  server.tool(
    'mindmap_session_summary',
    'Get summaries of previous AI sessions — what was done, what changed, and what was decided.',
    {
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe('Number of recent sessions to return'),
    },
    async ({ count }) => {
      try {
        const summaries = store.getSessionSummaries(count);
        return mcpText(ok(summaries, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`Session summary failed: ${msg}`));
      }
    },
  );
  } */
}
