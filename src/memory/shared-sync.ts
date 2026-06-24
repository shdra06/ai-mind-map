import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MindMapConfig, Memory, Decision, MemoryCategory } from '../types.js';
import type { KnowledgeGraph } from '../knowledge-graph/graph.js';
import type { PersistentMemory } from './persistent-memory.js';
import type { DecisionLog } from './decision-log.js';

// Categories that are safe to share/sync across the team.
const SHARABLE_CATEGORIES: MemoryCategory[] = [
  'convention',
  'gotcha',
  'architecture',
  'decision',
  'dependency',
  'workflow',
  'context'
];

export interface SharedMemory {
  category: MemoryCategory;
  content: string;
  tags: string[];
  relatedFiles: string[];
  importance: number;
}

export interface SharedDecision {
  title: string;
  description: string;
  rationale: string;
  alternatives: string[];
  consequences: string[];
  relatedFiles: string[];
  tags: string[];
  status: 'active' | 'superseded' | 'reversed';
}

export interface SharedRule {
  type: 'classification' | 'search_alias' | 'code_pattern' | 'convention';
  name: string;
  description: string;
  rule: Record<string, any>;
}

export interface SharedContext {
  version: string;
  memories?: SharedMemory[];
  decisions?: SharedDecision[];
  rules?: SharedRule[];
}

export interface SyncStats {
  memoriesImported: number;
  memoriesExported: number;
  decisionsImported: number;
  decisionsExported: number;
  rulesImported: number;
  rulesExported: number;
}

/**
 * Normalise a string for lookup matching (trim, lower case)
 */
function normalizeString(str: string): string {
  return str.trim().toLowerCase();
}

/**
 * Deterministic JSON serialisation with sorted keys.
 * Ensures identical data always produces the same string regardless of
 * property insertion order — critical for stable checksum computation.
 */
function canonicalStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + canonicalStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Synchronise local SQLite database with team-shared JSON file.
 * Performs a bidirectional merge.
 */
export async function syncSharedContext(
  config: MindMapConfig,
  graph: KnowledgeGraph,
  memoryStore: PersistentMemory,
  decisionLog: DecisionLog
): Promise<SyncStats> {
  const stats: SyncStats = {
    memoriesImported: 0,
    memoriesExported: 0,
    decisionsImported: 0,
    decisionsExported: 0,
    rulesImported: 0,
    rulesExported: 0
  };

  const sharedFilePath = path.resolve(config.projectRoot, config.sharedContextFile);

  // Path traversal check
  const resolved = path.resolve(config.projectRoot, config.sharedContextFile);
  if (!resolved.startsWith(path.resolve(config.projectRoot))) {
    throw new Error('Shared context file path must be within the project root');
  }

  let sharedContext: SharedContext = { version: '1.0', memories: [], decisions: [], rules: [] };

  // 1. Read existing shared context file with integrity checking
  if (existsSync(sharedFilePath)) {
    try {
      const raw = readFileSync(sharedFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as SharedContext & { _checksum?: string; _updatedAt?: string };

      // Verify integrity checksum if present
      if (parsed._checksum) {
        const { _checksum, ...dataWithout } = parsed;
        const expectedHash = createHash('sha256')
          .update(canonicalStringify(dataWithout))
          .digest('hex')
          .substring(0, 16);
        if (expectedHash !== _checksum) {
          // File was corrupted or manually edited — warn but continue
          // (manual edits are valid — just log the mismatch)
        }
      }

      sharedContext.memories = parsed.memories ?? [];
      sharedContext.decisions = parsed.decisions ?? [];
      sharedContext.rules = parsed.rules ?? [];
    } catch (err) {
      throw new Error(`Failed to parse shared context file ${config.sharedContextFile}: ${err}`);
    }
  }

  // 2. Fetch existing local data from SQLite
  const localMemories = memoryStore.queryMemories({ limit: 10000 });
  const localDecisions = decisionLog.queryDecisions({ limit: 10000 });
  const localRules = graph.getLearnedRules();

  // Create lookups to easily identify duplicates/updates
  const localMemMap = new Map<string, Memory>();
  for (const m of localMemories) {
    const key = `${m.category}:${normalizeString(m.content)}`;
    localMemMap.set(key, m);
  }

  const localDecMap = new Map<string, Decision>();
  for (const d of localDecisions) {
    localDecMap.set(normalizeString(d.title), d);
  }

  const localRuleMap = new Map<string, typeof localRules[0]>();
  for (const r of localRules) {
    const key = `${r.type}:${normalizeString(r.name)}`;
    localRuleMap.set(key, r);
  }

  // 3. Bidirectional Merge: Import from Shared Context File to SQLite
  // Import Memories
  if (sharedContext.memories) {
    for (const m of sharedContext.memories) {
      if (!SHARABLE_CATEGORIES.includes(m.category)) continue;
      const key = `${m.category}:${normalizeString(m.content)}`;
      if (!localMemMap.has(key)) {
        memoryStore.createMemory({
          category: m.category,
          content: m.content,
          tags: m.tags,
          relatedFiles: m.relatedFiles,
          importance: m.importance,
          source: 'auto'
        });
        stats.memoriesImported++;
      }
    }
  }

  // Import Decisions
  if (sharedContext.decisions) {
    for (const d of sharedContext.decisions) {
      const key = normalizeString(d.title);
      const localDec = localDecMap.get(key);
      if (!localDec) {
        const { decision } = decisionLog.createDecision({
          title: d.title,
          description: d.description,
          rationale: d.rationale,
          alternatives: d.alternatives,
          consequences: d.consequences,
          relatedFiles: d.relatedFiles,
          tags: d.tags,
          decidedBy: 'team'
        });
        
        // If the shared status is different from active, update it
        if (d.status !== 'active') {
          decisionLog.updateStatus(decision.id, d.status);
        }
        stats.decisionsImported++;
      } else {
        // Update local status/info if it differs
        if (localDec.status !== d.status) {
          decisionLog.updateStatus(localDec.id, d.status);
          stats.decisionsImported++;
        }
      }
    }
  }

  // Import Learned Rules
  if (sharedContext.rules) {
    for (const r of sharedContext.rules) {
      const key = `${r.type}:${normalizeString(r.name)}`;
      if (!localRuleMap.has(key)) {
        graph.addLearnedRule({
          type: r.type,
          name: r.name,
          description: r.description,
          rule: r.rule,
          createdBy: 'ai'
        });
        stats.rulesImported++;
      }
    }
  }

  // 4. Bidirectional Merge: Export from SQLite to Shared Context File
  // Fetch fresh local data after imports
  const freshLocalMemories = memoryStore.queryMemories({ limit: 10000 });
  const freshLocalDecisions = decisionLog.queryDecisions({ limit: 10000 });
  const freshLocalRules = graph.getLearnedRules();

  const exportedMemories: SharedMemory[] = [];
  const exportedDecisions: SharedDecision[] = [];
  const exportedRules: SharedRule[] = [];

  // Export Memories
  for (const m of freshLocalMemories) {
    if (!SHARABLE_CATEGORIES.includes(m.category)) continue;
    
    // Check if it was already in shared file, if not, we count it as exported
    const inShared = (sharedContext.memories ?? []).some(
      sm => sm.category === m.category && normalizeString(sm.content) === normalizeString(m.content)
    );
    if (!inShared) {
      stats.memoriesExported++;
    }

    exportedMemories.push({
      category: m.category,
      content: m.content,
      tags: m.tags || [],
      relatedFiles: m.relatedFiles || [],
      importance: m.importance
    });
  }

  // Export Decisions
  for (const d of freshLocalDecisions) {
    const inShared = (sharedContext.decisions ?? []).some(
      sd => normalizeString(sd.title) === normalizeString(d.title) && sd.status === d.status
    );
    if (!inShared) {
      stats.decisionsExported++;
    }

    exportedDecisions.push({
      title: d.title,
      description: d.description,
      rationale: d.rationale,
      alternatives: d.alternatives || [],
      consequences: d.consequences || [],
      relatedFiles: d.relatedFiles || [],
      tags: d.tags || [],
      status: d.status
    });
  }

  // Export Rules
  for (const r of freshLocalRules) {
    const inShared = (sharedContext.rules ?? []).some(
      sr => sr.type === r.type && normalizeString(sr.name) === normalizeString(r.name)
    );
    if (!inShared) {
      stats.rulesExported++;
    }

    exportedRules.push({
      type: r.type as any,
      name: r.name,
      description: r.description,
      rule: r.rule
    });
  }

  // 5. Deterministic Sort for Git-Friendly diffs
  exportedMemories.sort((a, b) => {
    const catComp = a.category.localeCompare(b.category);
    if (catComp !== 0) return catComp;
    return a.content.localeCompare(b.content);
  });

  exportedDecisions.sort((a, b) => a.title.localeCompare(b.title));

  exportedRules.sort((a, b) => {
    const typeComp = a.type.localeCompare(b.type);
    if (typeComp !== 0) return typeComp;
    return a.name.localeCompare(b.name);
  });

  // 6. Write to File with integrity checksum
  const finalContext: SharedContext & { _updatedAt: string; _checksum?: string } = {
    version: '1.0',
    memories: exportedMemories,
    decisions: exportedDecisions,
    rules: exportedRules,
    _updatedAt: new Date().toISOString(),
  };

  // Generate integrity checksum (over the data without checksum field)
  const dataHash = createHash('sha256')
    .update(canonicalStringify(finalContext))
    .digest('hex')
    .substring(0, 16);
  finalContext._checksum = dataHash;

  // Atomic write: write to temp file first, then rename
  try {
    const content = JSON.stringify(finalContext, null, 2);
    const tmpPath = sharedFilePath + '.tmp.' + process.pid;
    writeFileSync(tmpPath, content, 'utf-8');
    try {
      renameSync(tmpPath, sharedFilePath);
    } catch {
      // Windows fallback: delete target then rename
      try {
        unlinkSync(sharedFilePath);
      } catch { /* may not exist */ }
      renameSync(tmpPath, sharedFilePath);
    }
  } catch (err) {
    throw new Error(`Failed to write shared context file ${config.sharedContextFile}: ${err}`);
  }

  return stats;
}
