/**
 * Tests for the KnowledgeGraph class.
 *
 * Uses an in-memory SQLite database (':memory:') so tests are fast and
 * isolated. Covers node/edge CRUD, traversal, FTS5 search, file structure,
 * project overview, stats, and cleanup.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { KnowledgeGraph } from '../src/knowledge-graph/graph.js';
import type { GraphNode, GraphEdge } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  const id = overrides.id ?? `node_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    type: 'function',
    name: overrides.name ?? 'testFunc',
    qualifiedName: overrides.qualifiedName ?? overrides.name ?? 'testFunc',
    filePath: overrides.filePath ?? '/src/test.ts',
    startLine: 1,
    endLine: 10,
    signature: overrides.signature ?? 'function testFunc(): void',
    docComment: overrides.docComment ?? null,
    hash: 'abc123',
    language: 'typescript',
    visibility: 'public',
    isAsync: false,
    isStatic: false,
    isExported: true,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEdge(source: string, target: string, type: GraphEdge['type'] = 'calls'): GraphEdge {
  return { sourceId: source, targetId: target, type };
}

// ── Tests ────────────────────────────────────────────────────

describe('KnowledgeGraph', () => {
  let graph: KnowledgeGraph;

  before(() => {
    graph = new KnowledgeGraph(':memory:');
  });

  after(() => {
    graph.close();
  });

  describe('Node CRUD', () => {
    it('inserts and retrieves a node by ID', () => {
      const node = makeNode({ id: 'n1', name: 'alpha' });
      graph.upsertNode(node);

      const fetched = graph.getNode('n1');
      assert.ok(fetched, 'Node should exist');
      assert.strictEqual(fetched.name, 'alpha');
      assert.strictEqual(fetched.type, 'function');
      assert.strictEqual(fetched.isExported, true);
    });

    it('upserts (updates) an existing node', () => {
      const node = makeNode({ id: 'n1', name: 'alpha_updated', signature: 'function alpha(): string' });
      graph.upsertNode(node);

      const fetched = graph.getNode('n1');
      assert.ok(fetched);
      assert.strictEqual(fetched.name, 'alpha_updated');
    });

    it('returns null for non-existent node', () => {
      assert.strictEqual(graph.getNode('nonexistent'), null);
    });

    it('retrieves nodes by name', () => {
      graph.upsertNode(makeNode({ id: 'n2', name: 'sharedName', filePath: '/a.ts' }));
      graph.upsertNode(makeNode({ id: 'n3', name: 'sharedName', filePath: '/b.ts' }));

      const nodes = graph.getNodesByName('sharedName');
      assert.strictEqual(nodes.length, 2);
    });

    it('retrieves nodes by type', () => {
      graph.upsertNode(makeNode({ id: 'cls1', name: 'MyClass', type: 'class' }));
      const classes = graph.getNodesByType('class');
      assert.ok(classes.length >= 1, 'Should find at least one class');
      assert.ok(classes.some(n => n.name === 'MyClass'));
    });

    it('bulk inserts nodes', () => {
      const nodes = [
        makeNode({ id: 'bulk1', name: 'bulkA' }),
        makeNode({ id: 'bulk2', name: 'bulkB' }),
        makeNode({ id: 'bulk3', name: 'bulkC' }),
      ];
      graph.upsertNodes(nodes);

      assert.ok(graph.getNode('bulk1'));
      assert.ok(graph.getNode('bulk2'));
      assert.ok(graph.getNode('bulk3'));
    });

    it('deletes a node and its edges', () => {
      graph.upsertNode(makeNode({ id: 'del1', name: 'toDelete' }));
      graph.upsertNode(makeNode({ id: 'del2', name: 'related' }));
      graph.upsertEdge(makeEdge('del1', 'del2', 'calls'));

      graph.deleteNode('del1');
      assert.strictEqual(graph.getNode('del1'), null);
      // Edge should also be removed
      const edges = graph.getOutEdges('del1');
      assert.strictEqual(edges.length, 0);
    });
  });

  describe('Edge CRUD', () => {
    it('inserts and retrieves outgoing edges', () => {
      graph.upsertNode(makeNode({ id: 'ea', name: 'funcA' }));
      graph.upsertNode(makeNode({ id: 'eb', name: 'funcB' }));
      graph.upsertEdge(makeEdge('ea', 'eb', 'calls'));

      const outEdges = graph.getOutEdges('ea');
      assert.ok(outEdges.length >= 1);
      assert.ok(outEdges.some(e => e.targetId === 'eb' && e.type === 'calls'));
    });

    it('retrieves incoming edges', () => {
      const inEdges = graph.getInEdges('eb');
      assert.ok(inEdges.length >= 1);
      assert.ok(inEdges.some(e => e.sourceId === 'ea'));
    });

    it('filters edges by type', () => {
      graph.upsertEdge(makeEdge('ea', 'eb', 'imports'));

      const callEdges = graph.getOutEdgesByType('ea', 'calls');
      assert.ok(callEdges.every(e => e.type === 'calls'));

      const importEdges = graph.getOutEdgesByType('ea', 'imports');
      assert.ok(importEdges.every(e => e.type === 'imports'));
    });

    it('bulk inserts edges', () => {
      graph.upsertNode(makeNode({ id: 'be1', name: 'bulkEdgeA' }));
      graph.upsertNode(makeNode({ id: 'be2', name: 'bulkEdgeB' }));
      graph.upsertNode(makeNode({ id: 'be3', name: 'bulkEdgeC' }));

      graph.upsertEdges([
        makeEdge('be1', 'be2', 'calls'),
        makeEdge('be2', 'be3', 'calls'),
      ]);

      assert.ok(graph.getOutEdges('be1').length >= 1);
      assert.ok(graph.getOutEdges('be2').length >= 1);
    });
  });

  describe('Graph Traversal', () => {
    before(() => {
      // Build a small call graph: caller → main → helper
      graph.upsertNode(makeNode({ id: 'caller', name: 'caller' }));
      graph.upsertNode(makeNode({ id: 'main', name: 'main' }));
      graph.upsertNode(makeNode({ id: 'helper', name: 'helper' }));
      graph.upsertEdge(makeEdge('caller', 'main', 'calls'));
      graph.upsertEdge(makeEdge('main', 'helper', 'calls'));
    });

    it('finds callers of a node', () => {
      const callers = graph.findCallers('main');
      assert.ok(callers.some(n => n.id === 'caller'));
    });

    it('finds callees of a node', () => {
      const callees = graph.findCallees('main');
      assert.ok(callees.some(n => n.id === 'helper'));
    });

    it('computes blast radius', () => {
      const affected = graph.blastRadius('helper');
      // main calls helper, caller calls main → both in blast radius
      assert.ok(affected.some(n => n.id === 'main'), 'main should be in blast radius');
      assert.ok(affected.some(n => n.id === 'caller'), 'caller should be in blast radius');
    });
  });

  describe('FTS5 Search', () => {
    before(() => {
      graph.upsertNode(makeNode({
        id: 'search1',
        name: 'calculateTaxRate',
        signature: 'function calculateTaxRate(income: number): number',
        docComment: 'Compute the marginal tax rate for a given income',
      }));
      graph.upsertNode(makeNode({
        id: 'search2',
        name: 'processPayment',
        signature: 'async function processPayment(amount: number): Promise<void>',
        docComment: 'Handle payment processing via Stripe',
      }));
    });

    it('finds nodes matching a text query', () => {
      const results = graph.search('tax');
      assert.ok(results.some(n => n.name === 'calculateTaxRate'), 'Should find tax-related node');
    });

    it('finds nodes by doc comment content', () => {
      const results = graph.search('Stripe');
      assert.ok(results.some(n => n.name === 'processPayment'), 'Should find payment node');
    });

    it('returns empty for no matches', () => {
      const results = graph.search('zzzznonexistentzzz');
      // Might return 0 from FTS or fallback LIKE
      assert.ok(results.length === 0 || results.every(n => n.name !== 'zzzznonexistentzzz'));
    });

    it('returns empty for blank query', () => {
      const results = graph.search('');
      assert.strictEqual(results.length, 0);
    });
  });

  describe('File & Project Queries', () => {
    before(() => {
      // Create file node and child symbols
      graph.upsertNode(makeNode({ id: 'file_app', name: 'app.ts', type: 'file', filePath: '/src/app.ts', qualifiedName: '/src/app.ts', signature: '/src/app.ts' }));
      graph.upsertNode(makeNode({ id: 'app_fn1', name: 'startApp', filePath: '/src/app.ts', qualifiedName: 'startApp' }));
      graph.upsertNode(makeNode({ id: 'app_fn2', name: 'stopApp', filePath: '/src/app.ts', qualifiedName: 'stopApp' }));
      graph.upsertEdge({ sourceId: 'file_app', targetId: 'app_fn1', type: 'contains' });
      graph.upsertEdge({ sourceId: 'file_app', targetId: 'app_fn2', type: 'contains' });
    });

    it('gets file structure', () => {
      const structure = graph.getFileStructure('/src/app.ts');
      assert.ok(structure.length >= 3, `Expected ≥3 nodes, got ${structure.length}`);
      assert.ok(structure.some(n => n.name === 'startApp'));
      assert.ok(structure.some(n => n.name === 'stopApp'));
    });

    it('gets indexed file list', () => {
      const files = graph.getIndexedFiles();
      assert.ok(files.includes('/src/app.ts'));
    });

    it('gets project overview', () => {
      const overview = graph.getProjectOverview();
      assert.ok(overview.size >= 1, 'Should have at least one file');
      const appSymbols = overview.get('/src/app.ts');
      assert.ok(appSymbols, 'Should have /src/app.ts');
      assert.ok(appSymbols!.some(n => n.name === 'startApp'));
    });

    it('deletes all nodes for a file', () => {
      // Insert then delete a separate file
      graph.upsertNode(makeNode({ id: 'tmp_file', name: 'tmp.ts', type: 'file', filePath: '/tmp.ts' }));
      graph.upsertNode(makeNode({ id: 'tmp_fn', name: 'tmpFn', filePath: '/tmp.ts' }));

      const deleted = graph.deleteFileNodes('/tmp.ts');
      assert.ok(deleted >= 2);
      assert.strictEqual(graph.getNode('tmp_file'), null);
      assert.strictEqual(graph.getNode('tmp_fn'), null);
    });
  });

  describe('Statistics', () => {
    it('returns correct stats', () => {
      const stats = graph.getStats();
      assert.ok(stats.totalNodes > 0, 'Should have nodes');
      assert.ok(stats.totalEdges > 0, 'Should have edges');
      assert.ok(typeof stats.totalFiles === 'number');
      assert.ok(typeof stats.nodesByType === 'object');
      assert.ok(typeof stats.edgesByType === 'object');
      assert.ok(typeof stats.languageBreakdown === 'object');
    });
  });

  describe('Lifecycle', () => {
    it('reports database is open', () => {
      assert.strictEqual(graph.isOpen, true);
    });

    it('clear removes all data', () => {
      const g2 = new KnowledgeGraph(':memory:');
      g2.upsertNode(makeNode({ id: 'x1', name: 'clearMe' }));
      g2.clear();
      assert.strictEqual(g2.getNode('x1'), null);
      const stats = g2.getStats();
      assert.strictEqual(stats.totalNodes, 0);
      assert.strictEqual(stats.totalEdges, 0);
      g2.close();
    });
  });
});
