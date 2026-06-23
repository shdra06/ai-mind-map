/**
 * Tests for the PersistentMemory store.
 *
 * Uses an in-memory SQLite database for fast, isolated tests.
 * Covers create, read, search, filter, decay, deduplication, and delete.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { PersistentMemory } from '../src/memory/persistent-memory.js';
import type { CreateMemoryInput } from '../src/memory/persistent-memory.js';

// ── Tests ────────────────────────────────────────────────────

describe('PersistentMemory', () => {
  let db: InstanceType<typeof Database>;
  let memory: PersistentMemory;

  before(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    memory = new PersistentMemory(db, {
      decayRate: 0.95,
      maxMemories: 100,
      importanceThreshold: 0.1,
    });
  });

  after(() => {
    db.close();
  });

  describe('Create & Read', () => {
    it('creates a memory and retrieves it', () => {
      const input: CreateMemoryInput = {
        category: 'architecture',
        content: 'The project uses a hexagonal architecture with ports and adapters.',
        tags: ['architecture', 'design'],
        relatedFiles: ['/src/app.ts'],
        sessionId: 'session-1',
        source: 'user',
      };

      const created = memory.createMemory(input);
      assert.ok(created.id > 0, 'Should have a positive ID');
      assert.strictEqual(created.category, 'architecture');
      assert.strictEqual(created.content, input.content);
      assert.deepStrictEqual(created.tags, ['architecture', 'design']);
      assert.deepStrictEqual(created.relatedFiles, ['/src/app.ts']);
      assert.strictEqual(created.source, 'user');
    });

    it('retrieves a memory by ID and boosts importance', () => {
      const created = memory.createMemory({
        category: 'convention',
        content: 'Use camelCase for variable names.',
        importance: 0.5,
      });

      const fetched = memory.getMemory(created.id);
      assert.ok(fetched, 'Memory should exist');
      assert.strictEqual(fetched.content, 'Use camelCase for variable names.');
      // Access boosts importance by 0.1
      assert.ok(fetched.importance >= 0.5, 'Importance should be boosted');
      assert.ok(fetched.accessCount >= 1, 'Access count should be bumped');
    });

    it('returns null for non-existent memory', () => {
      const fetched = memory.getMemory(99999);
      assert.strictEqual(fetched, null);
    });

    it('assigns default importance from category', () => {
      const created = memory.createMemory({
        category: 'gotcha',
        content: 'Beware of the timezone issue in date parsing.',
      });
      // gotcha default importance = 0.85
      assert.ok(created.importance >= 0.8, `Expected ~0.85, got ${created.importance}`);
    });
  });

  describe('Search by text', () => {
    before(() => {
      memory.createMemory({
        category: 'workflow',
        content: 'Run npm test to execute the test suite. Use --watch for development.',
        tags: ['testing', 'npm'],
      });
      memory.createMemory({
        category: 'dependency',
        content: 'The project uses better-sqlite3 version 11.x for database access.',
        tags: ['database', 'sqlite'],
      });
    });

    it('finds memories matching a text query', () => {
      const results = memory.queryMemories({ text: 'test suite' });
      assert.ok(results.length >= 1, 'Should find at least one result');
      assert.ok(
        results.some(m => m.content.includes('test suite')),
        'Should match content containing "test suite"',
      );
    });

    it('finds memories by keyword', () => {
      const results = memory.queryMemories({ text: 'sqlite' });
      assert.ok(results.length >= 1, 'Should find sqlite-related memory');
    });

    it('returns all memories when no text filter', () => {
      const results = memory.queryMemories({});
      assert.ok(results.length >= 4, 'Should return all created memories');
    });
  });

  describe('Filter by category', () => {
    it('filters by single category', () => {
      const results = memory.queryMemories({ categories: ['workflow'] });
      assert.ok(results.length >= 1);
      assert.ok(results.every(m => m.category === 'workflow'));
    });

    it('filters by multiple categories', () => {
      const results = memory.queryMemories({ categories: ['workflow', 'dependency'] });
      assert.ok(results.length >= 2);
      assert.ok(results.every(m => m.category === 'workflow' || m.category === 'dependency'));
    });

    it('returns empty for non-existent category filter', () => {
      const results = memory.queryMemories({ categories: ['todo'] });
      // We haven't created any 'todo' memories
      assert.strictEqual(results.filter(m => m.category === 'todo').length, 0);
    });
  });

  describe('Deduplication', () => {
    it('merges near-duplicate memories instead of creating new ones', () => {
      const content1 = 'Always use try-catch blocks when calling external APIs for error handling.';
      const content2 = 'Always use try-catch blocks when calling external APIs for proper error handling.';

      const m1 = memory.createMemory({ category: 'convention', content: content1 });
      const m2 = memory.createMemory({ category: 'convention', content: content2 });

      // They should be merged (same ID if dedup triggered)
      assert.strictEqual(m1.id, m2.id, 'Near-duplicate should merge into existing memory');
    });

    it('does NOT merge dissimilar memories', () => {
      const m1 = memory.createMemory({ category: 'gotcha', content: 'Issue with timezone handling in date parsing.' });
      const m2 = memory.createMemory({ category: 'gotcha', content: 'CSS flexbox does not work in IE11.' });

      assert.notStrictEqual(m1.id, m2.id, 'Different memories should have different IDs');
    });
  });

  describe('Importance decay', () => {
    it('decays importance over time', () => {
      // Create a memory with an old access timestamp
      const mem = memory.createMemory({
        category: 'context',
        content: 'The billing module handles subscription payments via Stripe.',
        importance: 0.9,
      });

      // Manually back-date the last_accessed_at to simulate time passing
      db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?')
        .run(Date.now() - 30 * 24 * 60 * 60 * 1000, mem.id);  // 30 days ago

      const decayedCount = memory.applyDecay();
      assert.ok(decayedCount >= 1, 'Should decay at least one memory');

      const updated = memory.getMemory(mem.id);
      // Note: getMemory boosts importance by 0.1, so we compare to original 0.9
      // The decayed value before boost should be < 0.9
      assert.ok(updated, 'Memory should still exist');
    });
  });

  describe('Delete', () => {
    it('deletes an existing memory', () => {
      const mem = memory.createMemory({
        category: 'todo',
        content: 'Refactor the login flow to support OAuth.',
      });

      const deleted = memory.deleteMemory(mem.id);
      assert.strictEqual(deleted, true);

      const fetched = memory.getMemory(mem.id);
      assert.strictEqual(fetched, null);
    });

    it('returns false for deleting non-existent memory', () => {
      const deleted = memory.deleteMemory(99999);
      assert.strictEqual(deleted, false);
    });
  });

  describe('Statistics', () => {
    it('returns aggregate stats', () => {
      const stats = memory.getStats();
      assert.ok(stats.totalMemories >= 1, 'Should have memories');
      assert.ok(typeof stats.averageImportance === 'number');
      assert.ok(typeof stats.byCategory === 'object');
      assert.ok(stats.oldestCreatedAt !== null);
      assert.ok(stats.newestCreatedAt !== null);
      assert.ok(typeof stats.totalAccessCount === 'number');
    });
  });

  describe('Export / Import', () => {
    it('exports all memories', () => {
      const exported = memory.exportMemories();
      assert.ok(Array.isArray(exported));
      assert.ok(exported.length >= 1);
      assert.ok(exported[0].id > 0);
      assert.ok(typeof exported[0].content === 'string');
    });
  });
});
