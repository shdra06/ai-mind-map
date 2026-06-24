/**
 * Tests for the code parser module.
 *
 * Tests parseFile, detectLanguage, generateNodeId, generateContentHash
 * against the fixture files in tests/fixtures/.
 * Parser may use tree-sitter or regex fallback depending on availability.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseFile,
  detectLanguage,
  generateNodeId,
  generateContentHash,
  isSupportedFile,
  getSupportedExtensions,
  getSupportedLanguages,
} from '../src/knowledge-graph/parser.js';

const FIXTURES_DIR = resolve(import.meta.dirname!, 'fixtures');

// ── Helpers ──────────────────────────────────────────────────

function fixturePath(name: string): string {
  return resolve(FIXTURES_DIR, name);
}

// ── Tests ────────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    assert.strictEqual(detectLanguage('foo.ts'), 'typescript');
    assert.strictEqual(detectLanguage('bar.tsx'), 'tsx');
  });

  it('detects JavaScript', () => {
    assert.strictEqual(detectLanguage('foo.js'), 'javascript');
    assert.strictEqual(detectLanguage('bar.jsx'), 'javascript');
    assert.strictEqual(detectLanguage('baz.mjs'), 'javascript');
  });

  it('detects Python', () => {
    assert.strictEqual(detectLanguage('script.py'), 'python');
  });

  it('returns null for unsupported extensions', () => {
    assert.strictEqual(detectLanguage('readme.md'), null);
    assert.strictEqual(detectLanguage('data.csv'), null);
    assert.strictEqual(detectLanguage('image.png'), null);
  });
});

describe('generateNodeId', () => {
  it('produces a deterministic ID', () => {
    const id1 = generateNodeId('/src/app.ts', 'myFunc', 'function');
    const id2 = generateNodeId('/src/app.ts', 'myFunc', 'function');
    assert.strictEqual(id1, id2);
  });

  it('produces different IDs for different inputs', () => {
    const id1 = generateNodeId('/src/a.ts', 'fn', 'function');
    const id2 = generateNodeId('/src/b.ts', 'fn', 'function');
    assert.notStrictEqual(id1, id2);
  });

  it('returns a 16-character hex string', () => {
    const id = generateNodeId('/file.ts', 'name', 'function');
    assert.strictEqual(id.length, 16);
    assert.ok(/^[0-9a-f]{16}$/.test(id), `Expected hex, got ${id}`);
  });
});

describe('generateContentHash', () => {
  it('produces consistent hashes', () => {
    const h1 = generateContentHash('hello world');
    const h2 = generateContentHash('hello world');
    assert.strictEqual(h1, h2);
  });

  it('produces different hashes for different content', () => {
    const h1 = generateContentHash('hello');
    const h2 = generateContentHash('world');
    assert.notStrictEqual(h1, h2);
  });
});

describe('isSupportedFile', () => {
  it('returns true for supported extensions', () => {
    assert.strictEqual(isSupportedFile('app.ts'), true);
    assert.strictEqual(isSupportedFile('lib.py'), true);
    assert.strictEqual(isSupportedFile('main.go'), true);
  });

  it('returns false for unsupported extensions', () => {
    assert.strictEqual(isSupportedFile('readme.md'), false);
    assert.strictEqual(isSupportedFile('image.bmp'), false);
  });
});

describe('getSupportedExtensions / getSupportedLanguages', () => {
  it('returns non-empty arrays', () => {
    assert.ok(getSupportedExtensions().length > 0);
    assert.ok(getSupportedLanguages().length > 0);
  });

  it('includes .ts and .py extensions', () => {
    const exts = getSupportedExtensions();
    assert.ok(exts.includes('.ts'));
    assert.ok(exts.includes('.py'));
  });
});

describe('parseFile — TypeScript fixture', () => {
  it('extracts functions, classes, interfaces, types, enums', async () => {
    const result = await parseFile(fixturePath('sample.ts'));

    assert.strictEqual(result.language, 'typescript');
    assert.ok(result.nodes.length >= 5, `Expected ≥5 nodes, got ${result.nodes.length}`);

    const names = result.nodes.map(n => n.name);

    // File node
    assert.ok(names.includes('sample.ts'), 'Should have file node');

    // Functions
    assert.ok(names.includes('greet'), 'Should extract greet function');
    assert.ok(names.includes('fetchData'), 'Should extract fetchData function');

    // Class
    assert.ok(names.includes('UserRepository'), 'Should extract UserRepository class');

    // Interface
    assert.ok(names.includes('User'), 'Should extract User interface');
  });

  it('detects async functions', async () => {
    const result = await parseFile(fixturePath('sample.ts'));
    const fetchData = result.nodes.find(n => n.name === 'fetchData');
    // fetchData may be detected as async by tree-sitter or regex
    if (fetchData) {
      assert.strictEqual(fetchData.isAsync, true, 'fetchData should be async');
    }
  });

  it('detects exported symbols', async () => {
    const result = await parseFile(fixturePath('sample.ts'));
    const greet = result.nodes.find(n => n.name === 'greet');
    if (greet) {
      assert.strictEqual(greet.isExported, true, 'greet should be exported');
    }
  });

  it('creates edges', async () => {
    const result = await parseFile(fixturePath('sample.ts'));
    assert.ok(result.edges.length >= 1, `Expected ≥1 edges, got ${result.edges.length}`);
    // Should have 'contains' and 'imports' edges
    assert.ok(result.edges.some(e => e.type === 'contains'), 'Should have contains edges');
  });
});

describe('parseFile — Python fixture', () => {
  it('extracts functions and classes', async () => {
    const result = await parseFile(fixturePath('sample.py'));

    assert.strictEqual(result.language, 'python');
    assert.ok(result.nodes.length >= 3, `Expected ≥3 nodes, got ${result.nodes.length}`);

    const names = result.nodes.map(n => n.name);
    assert.ok(names.includes('greet'), 'Should extract greet function');
    assert.ok(names.includes('UserRepository'), 'Should extract UserRepository class');
  });
});

describe('parseFile — JavaScript fixture', () => {
  it('extracts functions and classes', async () => {
    const result = await parseFile(fixturePath('sample.js'));

    assert.strictEqual(result.language, 'javascript');
    assert.ok(result.nodes.length >= 3, `Expected ≥3 nodes, got ${result.nodes.length}`);

    const names = result.nodes.map(n => n.name);
    assert.ok(names.includes('greet'), 'Should extract greet function');
    assert.ok(names.includes('TaskRunner'), 'Should extract TaskRunner class');
  });
});

describe('parseFile — edge cases', () => {
  it('handles empty content', async () => {
    const result = await parseFile(fixturePath('sample.ts'), '');
    assert.strictEqual(result.nodes.length, 0);
    assert.strictEqual(result.edges.length, 0);
    assert.strictEqual(result.parseErrors.length, 0);
  });

  it('handles whitespace-only content', async () => {
    const result = await parseFile(fixturePath('sample.ts'), '   \n\n  \t  ');
    assert.strictEqual(result.nodes.length, 0);
  });

  it('returns error for unsupported file type', async () => {
    const result = await parseFile('/fake/path/file.xyz');
    assert.strictEqual(result.language, 'unknown');
    assert.strictEqual(result.nodes.length, 0);
    assert.ok(result.parseErrors.length >= 1, 'Should have parse errors');
  });

  it('returns error for non-existent file', async () => {
    const result = await parseFile('/does/not/exist.ts');
    assert.strictEqual(result.nodes.length, 0);
    assert.ok(result.parseErrors.length >= 1, 'Should report file read error');
  });

  it('handles source provided directly (bypasses file read)', async () => {
    const source = 'export function hello(): void { console.log("hi"); }';
    const result = await parseFile('virtual.ts', source);
    assert.strictEqual(result.language, 'typescript');
    assert.ok(result.nodes.length >= 1);
    const names = result.nodes.map(n => n.name);
    assert.ok(names.includes('hello'), 'Should extract hello function');
  });
});
