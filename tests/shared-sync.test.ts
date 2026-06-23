import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { KnowledgeGraph } from '../src/knowledge-graph/graph.js';
import { PersistentMemory } from '../src/memory/persistent-memory.js';
import { DecisionLog } from '../src/memory/decision-log.js';
import { syncSharedContext } from '../src/memory/shared-sync.js';
import type { MindMapConfig } from '../src/types.js';

describe('SharedContextSync', () => {
  let db: InstanceType<typeof Database>;
  let graph: KnowledgeGraph;
  let memoryStore: PersistentMemory;
  let decisionLog: DecisionLog;

  const tempSharedFile = 'temp-shared-context.json';
  const projectRoot = process.cwd();
  const tempSharedPath = path.resolve(projectRoot, tempSharedFile);

  const mockConfig: MindMapConfig = {
    projectRoot,
    languages: [],
    ignore: [],
    tokenBudgets: {
      graphResults: 1000,
      changeSummary: 1000,
      memoryRetrieval: 1000,
      fileContent: 1000,
      totalContext: 5000,
    },
    memory: {
      maxMemories: 100,
      decayRate: 0.95,
      importanceThreshold: 0.1,
      maxDecisions: 100,
    },
    compression: 'moderate',
    dbPath: ':memory:', // not directly used as graph manages its own connection, but CLI/config expects it
    watchEnabled: false,
    watchDebounceMs: 100,
    maxFileSize: 100000,
    pageRankEnabled: false,
    memoryOnly: false,
    sharedContextFile: tempSharedFile,
    autoSyncSharedContext: false,
  };

  before(() => {
    // Setup in-memory databases
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    
    // For test isolation, we'll initialize graph with in-memory DB too
    graph = new KnowledgeGraph(':memory:');
    
    memoryStore = new PersistentMemory(db, {
      decayRate: 0.95,
      maxMemories: 100,
      importanceThreshold: 0.1,
    });
    
    decisionLog = new DecisionLog(db, {
      maxDecisions: 100,
    });

    // Cleanup any leftovers
    if (existsSync(tempSharedPath)) {
      unlinkSync(tempSharedPath);
    }
  });

  after(() => {
    db.close();
    graph.close();
    if (existsSync(tempSharedPath)) {
      unlinkSync(tempSharedPath);
    }
  });

  it('runs sync when shared file does not exist, creating it', async () => {
    // Add local memory of a sharable category
    memoryStore.createMemory({
      category: 'convention',
      content: 'Always write tests for new features.',
      tags: ['testing'],
      relatedFiles: ['test.ts'],
      importance: 0.9,
    });

    // Add local memory of a non-sharable category
    memoryStore.createMemory({
      category: 'todo',
      content: 'Refactor this old class.',
      tags: ['refactor'],
      importance: 0.3,
    });

    // Add local decision
    decisionLog.createDecision({
      title: 'Use TypeScript',
      description: 'Migrate the codebase to TypeScript.',
      rationale: 'Better type safety and tooling.',
      alternatives: ['JavaScript', 'Flow'],
      consequences: ['Requires compilation step'],
      tags: ['language'],
    });

    // Add local rule
    graph.addLearnedRule({
      type: 'search_alias',
      name: 'db_alias',
      description: 'Search alias for database terms',
      rule: { term: 'database', aliases: ['db', 'sqlite', 'postgres'] },
    });

    // Sync
    const stats = await syncSharedContext(mockConfig, graph, memoryStore, decisionLog);

    // Verify stats
    assert.strictEqual(stats.memoriesImported, 0);
    assert.ok(stats.memoriesExported > 0, 'Should export memory');
    assert.strictEqual(stats.decisionsImported, 0);
    assert.ok(stats.decisionsExported > 0, 'Should export decision');
    assert.strictEqual(stats.rulesImported, 0);
    assert.ok(stats.rulesExported > 0, 'Should export rule');

    // Verify file exists
    assert.ok(existsSync(tempSharedPath), 'Shared JSON file should be created');

    // Read and verify file contents
    const raw = readFileSync(tempSharedPath, 'utf-8');
    const parsed = JSON.parse(raw);
    
    assert.strictEqual(parsed.version, '1.0');
    
    // Should export the sharable category 'convention', but NOT 'todo'
    assert.strictEqual(parsed.memories.length, 1, 'Only sharable categories should be exported');
    assert.strictEqual(parsed.memories[0].category, 'convention');
    assert.strictEqual(parsed.memories[0].content, 'Always write tests for new features.');

    assert.strictEqual(parsed.decisions.length, 1);
    assert.strictEqual(parsed.decisions[0].title, 'Use TypeScript');

    assert.strictEqual(parsed.rules.length, 1);
    assert.strictEqual(parsed.rules[0].name, 'db_alias');
  });

  it('imports new items from shared file on next sync', async () => {
    // Manually edit the shared file to add a new memory, decision, and rule
    const sharedData = {
      version: '1.0',
      memories: [
        {
          category: 'convention',
          content: 'Always write tests for new features.',
          tags: ['testing'],
          relatedFiles: ['test.ts'],
          importance: 0.9,
        },
        {
          category: 'gotcha',
          content: 'Keep connection pool size below 10.',
          tags: ['performance', 'db'],
          relatedFiles: ['db.ts'],
          importance: 0.85,
        },
      ],
      decisions: [
        {
          title: 'Use TypeScript',
          description: 'Migrate the codebase to TypeScript.',
          rationale: 'Better type safety and tooling.',
          alternatives: ['JavaScript', 'Flow'],
          consequences: ['Requires compilation step'],
          tags: ['language'],
          status: 'active',
        },
        {
          title: 'Use SQLite',
          description: 'Use SQLite for local caching.',
          rationale: 'Lightweight and serverless.',
          alternatives: ['LevelDB', 'JSON files'],
          consequences: ['No concurrent writes support'],
          tags: ['database'],
          status: 'active',
        },
      ],
      rules: [
        {
          type: 'search_alias',
          name: 'db_alias',
          description: 'Search alias for database terms',
          rule: { term: 'database', aliases: ['db', 'sqlite', 'postgres'] },
        },
        {
          type: 'convention',
          name: 'test_convention',
          description: 'Test prefix convention',
          rule: { prefix: 'test_' },
        },
      ],
    };

    writeFileSync(tempSharedPath, JSON.stringify(sharedData, null, 2), 'utf-8');

    // Run sync again
    const stats = await syncSharedContext(mockConfig, graph, memoryStore, decisionLog);

    // Verify stats: 1 new memory, 1 new decision, 1 new rule imported
    assert.strictEqual(stats.memoriesImported, 1);
    assert.strictEqual(stats.decisionsImported, 1);
    assert.strictEqual(stats.rulesImported, 1);

    // Verify local SQLite has the imported items
    const memories = memoryStore.queryMemories({ limit: 10 }).filter(m => m.category === 'gotcha');
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0].content, 'Keep connection pool size below 10.');

    const decisions = decisionLog.queryDecisions({ limit: 10 }).filter(d => d.title === 'Use SQLite');
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].rationale, 'Lightweight and serverless.');

    const rules = graph.getLearnedRules().filter(r => r.name === 'test_convention');
    assert.strictEqual(rules.length, 1);
    assert.strictEqual((rules[0].rule as any).prefix, 'test_');
  });

  it('does not duplicate items or re-import if already present', async () => {
    // Run sync again without changes
    const stats = await syncSharedContext(mockConfig, graph, memoryStore, decisionLog);

    assert.strictEqual(stats.memoriesImported, 0);
    assert.strictEqual(stats.decisionsImported, 0);
    assert.strictEqual(stats.rulesImported, 0);
    assert.strictEqual(stats.memoriesExported, 0);
    assert.strictEqual(stats.decisionsExported, 0);
    assert.strictEqual(stats.rulesExported, 0);
  });
});
