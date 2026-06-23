/**
 * AI Mind Map — Flow & Interaction Map MCP Tools
 *
 * Tools that let the AI agent understand the BEHAVIORAL flow of the app:
 *   "What happens when user clicks Save?"
 *   "What's the pipeline from button to database?"
 *   "Show me all routes and what they connect to"
 *   "Which layer does this file belong to?"
 *
 * This is the feature that makes the AI NOT waste tokens figuring out
 * the logic flow — we pre-map it for the agent.
 */

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, MindMapConfig } from '../types.js';

import { KnowledgeGraph } from '../knowledge-graph/graph.js';
import { FlowAnalyzer } from '../knowledge-graph/flow-analyzer.js';
import type { FlowLayer } from '../knowledge-graph/flow-analyzer.js';

// ============================================================
// Shared helpers
// ============================================================

interface ITokenEstimator {
  estimate(text: string): number;
}

const defaultEstimator: ITokenEstimator = {
  estimate: (text) => Math.ceil(text.length / 4),
};

function mcpText(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

function ok(data: unknown, estimator: ITokenEstimator, saved = 0): ToolResult {
  const serialised = JSON.stringify(data);
  const tokens = estimator.estimate(serialised);
  return { success: true, data, tokenCount: tokens, tokensSaved: saved };
}

function fail(message: string): ToolResult {
  return { success: false, data: null, tokenCount: 0, tokensSaved: 0, message };
}

// ============================================================
// Registration
// ============================================================

/**
 * Register all flow/interaction map tools on the MCP server.
 */
export function registerFlowTools(
  server: McpServer,
  graph: KnowledgeGraph,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {
  const analyzer = new FlowAnalyzer(graph, config.projectRoot);

  // ── mindmap_trace_flow ────────────────────────────────────
  server.tool(
    'mindmap_trace_flow',
    `🔗 Trace the FULL PIPELINE from a function/button/event to its final effect.
Example: "What happens when createNote() is called?" → shows the complete chain:
  createNote() → validateInput() → notesService.save() → db.insert() → emitEvent()
Each step shows: which layer (UI/controller/service/DB), which file, which function.
The AI doesn't need to read any code to understand the flow.`,
    {
      symbol: z
        .string()
        .describe(
          'Function/method/component name to trace (e.g. "handleSaveClick", "createNote", "POST /api/notes")',
        ),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe('Max call-chain depth to follow (default 10)'),
    },
    async ({ symbol, maxDepth }) => {
      try {
        const flow = analyzer.traceFlow(symbol, maxDepth);

        if (flow.steps.length === 0) {
          return mcpText(fail(`Could not trace flow for "${symbol}" — symbol not found or has no call chain.`));
        }

        // Build a visual pipeline string
        const pipeline = flow.steps
          .map((s, i) => {
            const indent = '  '.repeat(Math.min(i, 5));
            const arrow = i === 0 ? '🟢' : '  →';
            const layerIcon = getLayerIcon(s.layer);
            return `${indent}${arrow} ${layerIcon} [${s.layer}] ${s.symbolName}() — ${s.filePath}:${s.line}`;
          })
          .join('\n');

        return mcpText(ok({
          flow: {
            name: flow.name,
            trigger: flow.trigger,
            stepsCount: flow.steps.length,
            riskLevel: flow.riskLevel,
            sideEffects: flow.sideEffects,
            filesInvolved: flow.filesInvolved,
          },
          pipeline,
          steps: flow.steps,
          tip: `This flow touches ${flow.filesInvolved.length} files and has ${flow.sideEffects.length} side effects. Risk level: ${flow.riskLevel}.`,
        }, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`trace_flow failed: ${msg}`));
      }
    },
  );

  // ── mindmap_interaction_map ───────────────────────────────
  server.tool(
    'mindmap_interaction_map',
    `🗺️ Get the FULL INTERACTION MAP of the application.
Shows: all routes → handlers → services → DB calls, all UI events → handlers,
all components with their actions, state, and data sources.
Also classifies every file by layer (UI, controller, service, repository, DB, etc.)
This is the app's behavioral blueprint — the AI reads this ONCE and understands the whole app.`,
    {},
    async () => {
      try {
        const map = analyzer.buildInteractionMap();

        // Build a compact summary
        const summary = {
          totalRoutes: map.routes.length,
          totalEventHandlers: map.eventHandlers.length,
          totalComponents: map.components.length,
          layerBreakdown: Object.entries(map.layerSummary)
            .filter(([, count]) => count > 0)
            .sort(([, a], [, b]) => b - a)
            .map(([layer, count]) => `${getLayerIcon(layer as FlowLayer)} ${layer}: ${count} symbols`),
        };

        // Compact route list
        const routeSummary = map.routes.slice(0, 15).map((r) => ({
          name: r.name,
          trigger: r.trigger,
          steps: r.steps.length,
          risk: r.riskLevel,
          pipeline: r.steps
            .map((s) => `${getLayerIcon(s.layer)}${s.symbolName}`)
            .join(' → '),
          sideEffects: r.sideEffects,
        }));

        // Compact component list
        const componentSummary = map.components.slice(0, 15).map((c) => ({
          name: c.name,
          file: c.filePath,
          actions: c.actions.map((a) => a.trigger).join(', ') || 'none',
          state: c.state.join(', ') || 'none',
          children: c.children.join(', ') || 'none',
          dataSources: c.dataSources.join(', ') || 'none',
        }));

        return mcpText(ok({
          summary,
          routes: routeSummary,
          eventHandlers: map.eventHandlers.slice(0, 15).map((e) => ({
            name: e.name,
            trigger: e.trigger,
            pipeline: e.steps
              .map((s) => `${getLayerIcon(s.layer)}${s.symbolName}`)
              .join(' → '),
            risk: e.riskLevel,
          })),
          components: componentSummary,
          fileClassification: map.filesByLayer,
          tip: 'Use mindmap_trace_flow to drill into any specific flow. Use mindmap_classify_file to understand where a file fits.',
        }, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`interaction_map failed: ${msg}`));
      }
    },
  );

  // ── mindmap_classify_file ─────────────────────────────────
  server.tool(
    'mindmap_classify_file',
    `📂 Classify a file by its architectural layer.
Returns: whether the file is a UI component, controller, service, repository, 
database layer, middleware, validator, utility, etc.
Helps the AI understand WHERE a file fits in the architecture without reading it.`,
    {
      filePath: z
        .string()
        .describe('File path to classify (relative or absolute)'),
    },
    async ({ filePath }) => {
      try {
        const fullPath = filePath.startsWith('/') || filePath.includes(':')
          ? filePath
          : `${config.projectRoot}/${filePath}`;

        const layer = analyzer.classifyFile(fullPath);

        return mcpText(ok({
          filePath,
          layer,
          icon: getLayerIcon(layer),
          description: getLayerDescription(layer),
          typical_contents: getLayerTypicalContents(layer),
        }, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`classify_file failed: ${msg}`));
      }
    },
  );

  // ── mindmap_layer_overview ────────────────────────────────
  server.tool(
    'mindmap_layer_overview',
    `📊 Show how the app is organized by architectural layers.
Returns: count of files and symbols per layer (UI, controller, service, DB, etc.)
with the key files and functions in each layer. 
One-shot understanding of the app's structure.`,
    {},
    async () => {
      try {
        const overview = analyzer.getLayerOverview();

        if (overview.length === 0) {
          return mcpText(fail('No indexed files found — run mindmap_reindex first.'));
        }

        // Build visual layer diagram
        const diagram = overview
          .map((l) => {
            const icon = getLayerIcon(l.layer);
            const bar = '█'.repeat(Math.min(Math.ceil(l.symbolCount / 5), 20));
            return `${icon} ${l.layer.padEnd(15)} │ ${String(l.fileCount).padStart(3)} files │ ${String(l.symbolCount).padStart(4)} symbols │ ${bar}`;
          })
          .join('\n');

        return mcpText(ok({
          diagram,
          layers: overview,
          tip: 'Use mindmap_trace_flow to see how these layers connect. Use mindmap_interaction_map for the full behavioral blueprint.',
        }, estimator));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpText(fail(`layer_overview failed: ${msg}`));
      }
    },
  );
}

// ============================================================
// UI Helpers
// ============================================================

function getLayerIcon(layer: FlowLayer | string): string {
  const icons: Record<string, string> = {
    ui_event: '🖱️',
    ui_component: '🧩',
    event_handler: '⚡',
    state_update: '🔄',
    api_call: '🌐',
    route: '🛣️',
    controller: '🎮',
    service: '⚙️',
    repository: '📦',
    database: '🗄️',
    middleware: '🔗',
    validator: '✅',
    util: '🔧',
    unknown: '❓',
  };
  return icons[layer] ?? '❓';
}

function getLayerDescription(layer: FlowLayer): string {
  const descriptions: Record<string, string> = {
    ui_event: 'User interaction trigger (click, submit, change)',
    ui_component: 'UI component that renders visual elements',
    event_handler: 'Function that handles UI events',
    state_update: 'State management (React state, Redux, Vuex)',
    api_call: 'HTTP/API request to external service',
    route: 'HTTP route/endpoint definition',
    controller: 'Request handler that orchestrates business logic',
    service: 'Business logic and domain rules',
    repository: 'Data access layer (ORM, query builders)',
    database: 'Direct database operations',
    middleware: 'Request/response pipeline middleware',
    validator: 'Input validation and sanitization',
    util: 'Shared utility functions and helpers',
    unknown: 'Could not determine the architectural layer',
  };
  return descriptions[layer] ?? 'Unknown layer';
}

function getLayerTypicalContents(layer: FlowLayer): string {
  const contents: Record<string, string> = {
    ui_event: 'onClick handlers, form submissions, keyboard shortcuts',
    ui_component: 'React components, Vue templates, Angular components',
    event_handler: 'handleClick, handleSubmit, onChange callbacks',
    state_update: 'useState, useReducer, Redux actions, Vuex mutations',
    api_call: 'fetch(), axios calls, GraphQL queries',
    route: 'app.get(), router.post(), @Get() decorators',
    controller: 'Request parsing, response formatting, error handling',
    service: 'Business rules, calculations, orchestration',
    repository: 'Database queries, ORM calls, data transformation',
    database: 'Raw SQL, MongoDB operations, Redis commands',
    middleware: 'Auth checks, logging, rate limiting, CORS',
    validator: 'Schema validation, input sanitization, type checking',
    util: 'String helpers, date formatting, crypto, file I/O',
    unknown: 'File purpose could not be determined automatically',
  };
  return contents[layer] ?? 'Unknown';
}
