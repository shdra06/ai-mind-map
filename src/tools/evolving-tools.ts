/**
 * AI Mind Map — Self-Evolving MCP Tools
 *
 * These tools let the AI TEACH the system new patterns that persist
 * per-project in SQLite. The system evolves over time on each user's
 * machine as the AI learns project-specific conventions.
 *
 * Tools:
 *   - mindmap_teach     — AI teaches a new rule (classification, search alias, convention)
 *   - mindmap_get_learned — View all learned rules
 *   - mindmap_forget    — Remove a learned rule
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig } from '../types.js';
import { KnowledgeGraph } from '../knowledge-graph/graph.js';

// ============================================================
// Helpers
// ============================================================

export interface ITokenEstimator {
  estimate(text: string): number;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

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
 * Register self-evolving tools — AI can teach the system new patterns.
 */
export function registerEvolvingTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  // ── mindmap_teach ────────────────────────────────────────────
  server.tool(
    'mindmap_teach',
    'Teach the AI Mind Map a new rule that persists on this machine. ' +
      'The rule is saved in the project database and automatically applied ' +
      'in future sessions. Use this when:\n' +
      '- A file/pattern is misclassified → teach a classification rule\n' +
      '- You keep searching for synonyms → teach a search alias\n' +
      '- You notice a project convention → teach a convention\n' +
      '- You spot a code pattern → teach a code pattern\n\n' +
      'Examples:\n' +
      '  Classification: { type: "classification", name: "bloc_files", layer: "state_update", ' +
        'source: "path", patterns: ["\\\\.bloc\\\\.dart$"], weight: 3 }\n' +
      '  Search alias: { type: "search_alias", name: "auth_aliases", term: "auth", ' +
        'aliases: ["login", "authentication", "session", "jwt"] }\n' +
      '  Convention: { type: "convention", name: "api_naming", description: "All API methods end with Async" }',
    {
      type: z.enum(['classification', 'search_alias', 'code_pattern', 'convention'])
        .describe('Type of rule to teach'),
      name: z.string().min(1).max(100)
        .describe('Unique name for this rule (e.g., "flutter_bloc_pattern", "auth_search_alias")'),
      description: z.string().min(1)
        .describe('Human-readable description of what this rule does'),
      // Classification-specific
      layer: z.string().optional()
        .describe('For classification rules: target layer (e.g., "service", "ui_component", "database")'),
      source: z.enum(['content', 'path', 'directory', 'import', 'symbol_name']).optional()
        .describe('For classification rules: what to match against'),
      patterns: z.array(z.string()).optional()
        .describe('Regex patterns to match (as strings). Example: ["Manager\\\\.cs$", "Service\\\\.cs$"]'),
      weight: z.number().int().min(1).max(5).optional()
        .describe('For classification rules: signal weight 1-5 (default 3)'),
      // Search alias-specific
      term: z.string().optional()
        .describe('For search_alias: the search term to create aliases for'),
      aliases: z.array(z.string()).optional()
        .describe('For search_alias: alternative terms to also search for'),
      // Code pattern / convention
      details: z.record(z.unknown()).optional()
        .describe('Any additional structured data for the rule'),
    },
    async ({ type, name, description, layer, source, patterns, weight, term, aliases, details }) => {
      try {
        // Validate patterns are valid regex
        if (patterns) {
          for (const p of patterns) {
            try {
              new RegExp(p);
            } catch (e) {
              return mcpText(fail(`Invalid regex pattern "${p}": ${e}`));
            }
          }
        }

        // Build the rule JSON based on type
        let ruleData: Record<string, unknown> = {};

        switch (type) {
          case 'classification':
            if (!layer) return mcpText(fail('Classification rules require "layer" (e.g., "service", "database")'));
            if (!patterns || patterns.length === 0) return mcpText(fail('Classification rules require at least one "patterns" regex'));
            ruleData = {
              layer,
              source: source ?? 'path',
              patterns,
              weight: weight ?? 3,
            };
            break;

          case 'search_alias':
            if (!term) return mcpText(fail('Search alias rules require "term" (the term to create aliases for)'));
            if (!aliases || aliases.length === 0) return mcpText(fail('Search alias rules require at least one "aliases" entry'));
            ruleData = { term, aliases };
            break;

          case 'code_pattern':
          case 'convention':
            ruleData = {
              ...(patterns ? { patterns } : {}),
              ...(layer ? { layer } : {}),
              ...(details ?? {}),
            };
            break;
        }

        const result = graph.addLearnedRule({
          type,
          name,
          description,
          rule: ruleData,
          createdBy: 'ai',
        });

        const response = {
          ...result,
          name,
          type,
          description,
          rule: ruleData,
          message: result.created
            ? `✅ New ${type} rule "${name}" has been learned and will persist across sessions.`
            : `🔄 Updated existing ${type} rule "${name}" with new definition.`,
          hint: type === 'classification'
            ? 'This rule will be automatically used by the classification engine to score files.'
            : type === 'search_alias'
              ? 'When someone searches for "' + term + '", the system will also search for: ' + (aliases?.join(', ') ?? '')
              : 'This rule is stored as project knowledge and can be recalled with mindmap_get_learned.',
        };

        return mcpText(ok(response, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`teach failed: ${msg}`));
      }
    },
  );

  // ── mindmap_get_learned ──────────────────────────────────────
  server.tool(
    'mindmap_get_learned',
    'View all rules the AI has taught this project. Shows classification rules, ' +
      'search aliases, code patterns, and conventions — sorted by usage count. ' +
      'Use this at the start of a session to see what the system has already learned.',
    {
      type: z.enum(['classification', 'search_alias', 'code_pattern', 'convention', 'all'])
        .default('all')
        .describe('Filter by rule type, or "all" for everything'),
    },
    async ({ type }) => {
      try {
        const rules = type === 'all'
          ? graph.getLearnedRules()
          : graph.getLearnedRules(type);

        // Group by type for display
        const grouped: Record<string, typeof rules> = {};
        for (const rule of rules) {
          if (!grouped[rule.type]) grouped[rule.type] = [];
          grouped[rule.type].push(rule);
        }

        const result = {
          totalRules: rules.length,
          rulesByType: grouped,
          rules,
          summary: rules.length > 0
            ? `This project has ${rules.length} learned rule(s): ` +
              Object.entries(grouped).map(([t, r]) => `${r.length} ${t}`).join(', ')
            : 'No rules learned yet. Use mindmap_teach to add project-specific knowledge.',
        };

        return mcpText(ok(result, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`get_learned failed: ${msg}`));
      }
    },
  );

  // ── mindmap_forget ───────────────────────────────────────────
  server.tool(
    'mindmap_forget',
    'Remove a learned rule by its name or ID. Use mindmap_get_learned first ' +
      'to see all rules and their IDs.',
    {
      nameOrId: z.string()
        .describe('Name or ID of the rule to remove'),
    },
    async ({ nameOrId }) => {
      try {
        const deleted = graph.deleteLearnedRule(nameOrId);
        if (deleted) {
          return mcpText(ok({
            deleted: true,
            nameOrId,
            message: `✅ Rule "${nameOrId}" has been forgotten.`,
          }, estimator));
        } else {
          return mcpText(fail(`Rule not found: "${nameOrId}". Use mindmap_get_learned to see all rules.`));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`forget failed: ${msg}`));
      }
    },
  );
}
