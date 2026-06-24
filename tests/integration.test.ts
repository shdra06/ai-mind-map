/**
 * Integration tests — full pipeline.
 *
 * Exercises the end-to-end flow:
 *   parse fixture files → store in knowledge graph → query back.
 *
 * Uses an in-memory SQLite database and the actual fixture files.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { KnowledgeGraph } from '../src/knowledge-graph/graph.js';
import { parseFile } from '../src/knowledge-graph/parser.js';

const FIXTURES_DIR = resolve(import.meta.dirname!, 'fixtures');

describe('Integration: parse → store → query', () => {
  let graph: KnowledgeGraph;

  before(async () => {
    graph = new KnowledgeGraph(':memory:');

    // Parse all fixture files and store results in the graph
    const files = ['sample.ts', 'sample.py', 'sample.js'];

    for (const file of files) {
      const filePath = resolve(FIXTURES_DIR, file);
      const result = await parseFile(filePath);

      if (result.nodes.length > 0) {
        graph.upsertNodes(result.nodes);
      }
      if (result.edges.length > 0) {
        graph.upsertEdges(result.edges);
      }
    }
  });

  after(() => {
    graph.close();
  });

  it('indexes multiple files with nodes', () => {
    const stats = graph.getStats();
    assert.ok(stats.totalNodes >= 5, `Expected ≥5 total nodes, got ${stats.totalNodes}`);
    assert.ok(stats.totalFiles >= 3, `Expected ≥3 file nodes, got ${stats.totalFiles}`);
  });

  it('creates edges between nodes', () => {
    const stats = graph.getStats();
    assert.ok(stats.totalEdges >= 3, `Expected ≥3 edges, got ${stats.totalEdges}`);
    assert.ok(stats.edgesByType['contains'] >= 1, 'Should have "contains" edges');
  });

  it('has language breakdown', () => {
    const stats = graph.getStats();
    assert.ok(Object.keys(stats.languageBreakdown).length >= 2, 'Should have ≥2 languages');
    assert.ok(stats.languageBreakdown['typescript'] >= 1, 'Should have TypeScript files');
    assert.ok(stats.languageBreakdown['python'] >= 1, 'Should have Python files');
  });

  it('searches across all indexed files', () => {
    const results = graph.search('greet');
    assert.ok(results.length >= 1, 'Should find "greet" across files');
  });

  it('retrieves file structure for indexed file', () => {
    // Find the actual filePath used (absolute path)
    const indexedFiles = graph.getIndexedFiles();
    const tsFile = indexedFiles.find(f => f.endsWith('sample.ts'));
    assert.ok(tsFile, 'sample.ts should be indexed');

    const structure = graph.getFileStructure(tsFile!);
    assert.ok(structure.length >= 2, `Expected ≥2 nodes in sample.ts, got ${structure.length}`);
  });

  it('project overview includes all fixture files', () => {
    const { overview } = graph.getProjectOverview();
    assert.ok(overview.size >= 3, `Expected >=3 files in overview, got ${overview.size}`);
  });

  it('file signatures produce compact output', () => {
    const indexedFiles = graph.getIndexedFiles();
    const tsFile = indexedFiles.find(f => f.endsWith('sample.ts'));
    assert.ok(tsFile);

    const signatures = graph.getFileSignatures(tsFile!);
    assert.ok(signatures.length > 0, 'Signatures should be non-empty');
    assert.ok(signatures.includes(tsFile!), 'Should include file path');
  });

  it('can replace file data atomically', async () => {
    const indexedFiles = graph.getIndexedFiles();
    const tsFile = indexedFiles.find(f => f.endsWith('sample.ts'));
    assert.ok(tsFile);

    // Re-parse and replace
    const result = await parseFile(tsFile!);
    const nodesBefore = graph.getFileStructure(tsFile!).length;

    graph.replaceFileData(tsFile!, result.nodes, result.edges);

    const nodesAfter = graph.getFileStructure(tsFile!).length;
    assert.strictEqual(nodesAfter, nodesBefore, 'Node count should be same after replace');
  });

  it('getAllNodeIds returns all nodes', () => {
    const ids = graph.getAllNodeIds();
    const stats = graph.getStats();
    assert.strictEqual(ids.length, stats.totalNodes);
  });

  it('getAllEdges returns all edges', () => {
    const edges = graph.getAllEdges();
    const stats = graph.getStats();
    assert.strictEqual(edges.length, stats.totalEdges);
  });
});
