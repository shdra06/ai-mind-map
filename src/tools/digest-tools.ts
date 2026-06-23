/**
 * AI Mind Map — Digest & Verification Tools (MCP)
 *
 * Tools for compressed codebase summaries and content verification:
 *   - mindmap_digest       — Compressed project summary (<2000 tokens)
 *   - mindmap_file_digest  — Compressed file summary without reading full file
 *   - mindmap_verify       — Hash-based content verification
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { KnowledgeGraph } from '../knowledge-graph/graph.js';
import type { ChangelogEngine } from '../knowledge-graph/changelog.js';
import type { MindMapConfig } from '../types.js';
import type { ITokenEstimator } from './advanced-tools.js';

// ── Helpers ─────────────────────────────────────────────────

const defaultEstimator: ITokenEstimator = {
  estimate: (s: string) => Math.ceil(s.length / 4),
};

function ok(data: unknown, estimator: ITokenEstimator): string {
  const json = JSON.stringify(data, null, 2);
  const tokens = estimator.estimate(json);
  return JSON.stringify({ success: true, data, tokenCount: tokens });
}

function fail(message: string): string {
  return JSON.stringify({ success: false, error: message });
}

function mcpText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// ============================================================
// Registration
// ============================================================

export function registerDigestTools(
  server: McpServer,
  graph: KnowledgeGraph,
  changelog: ChangelogEngine,
  config: MindMapConfig,
  estimator: ITokenEstimator = defaultEstimator,
): void {

  // ── mindmap_digest ─────────────────────────────────────────
  server.tool(
    'mindmap_digest',
    'Get a compressed codebase summary in under 2000 tokens. ' +
      'Includes: file tree, tech stack, architecture layers, key symbols, ' +
      'and recent changes. USE THIS instead of reading multiple files to ' +
      'understand a project.',
    {
      includeChanges: z.boolean().optional().describe('Include recent changes in digest (default: true)'),
      maxTokens: z.number().optional().describe('Max tokens for digest (default: 2000)'),
    },
    async (args) => {
      try {
        const maxTokens = args.maxTokens || 2000;
        const includeChanges = args.includeChanges !== false;

        // Check cache first
        const cacheKey = `digest_${maxTokens}_${includeChanges}`;
        const cached = changelog.getCachedDigest(cacheKey);
        if (cached) {
          return mcpText(cached);
        }

        const stats = graph.getStats();
        const overview = graph.getProjectOverview();

        // Build file tree summary
        const filesByDir = new Map<string, string[]>();
        const indexedFiles = graph.getIndexedFiles();
        for (const f of indexedFiles) {
          const rel = relative(config.projectRoot, f).replace(/\\/g, '/');
          const dir = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : '.';
          if (!filesByDir.has(dir)) filesByDir.set(dir, []);
          filesByDir.get(dir)!.push(basename(rel));
        }

        // Sort dirs by file count
        const sortedDirs = Array.from(filesByDir.entries())
          .sort(([, a], [, b]) => b.length - a.length);

        // Build directory tree (compact)
        const dirTree = sortedDirs.slice(0, 15).map(([dir, files]) => {
          if (files.length <= 3) {
            return `  ${dir}/ — ${files.join(', ')}`;
          }
          return `  ${dir}/ — ${files.length} files (${files.slice(0, 3).join(', ')}...)`;
        });

        // Key symbols by type (top by PageRank or alphabetical)
        const symbolsByType: Record<string, { name: string; file: string; sig: string }[]> = {};
        for (const [typeName, nodes] of overview) {
          if (typeName === 'file') continue;
          const top = nodes
            .filter(n => n.isExported || n.visibility === 'public')
            .slice(0, 10)
            .map(n => ({
              name: n.qualifiedName || n.name,
              file: relative(config.projectRoot, n.filePath).replace(/\\/g, '/'),
              sig: n.signature ? n.signature.substring(0, 80) : '',
            }));
          if (top.length > 0) {
            symbolsByType[typeName] = top;
          }
        }

        // Tech stack detection
        const languages = Object.entries(stats.languageBreakdown)
          .sort(([, a], [, b]) => b - a)
          .map(([lang, count]) => `${lang} (${count} files)`);

        // Build the digest
        const lines: string[] = [];
        lines.push(`# Project Digest: ${basename(config.projectRoot)}`);
        lines.push(`Stack: ${languages.join(', ')}`);
        lines.push(`Total: ${stats.totalFiles} files, ${stats.totalNodes} symbols, ${stats.totalEdges} relationships`);
        lines.push('');
        lines.push('## Structure');
        lines.push(...dirTree);
        lines.push('');

        // Key exported symbols
        lines.push('## Key Symbols');
        for (const [type, symbols] of Object.entries(symbolsByType)) {
          const symbolList = symbols.map(s =>
            s.sig ? `  ${s.name}: ${s.sig}` : `  ${s.name} (${s.file})`
          );
          if (symbolList.length > 0) {
            lines.push(`### ${type}s (${symbols.length})`);
            lines.push(...symbolList.slice(0, 8));
          }
        }

        // Recent changes
        if (includeChanges) {
          const changes = changelog.getChangesSince(Date.now() - 24 * 3600_000);
          if (changes.totalChanges > 0) {
            lines.push('');
            lines.push(`## Recent Changes (${changes.sinceLabel})`);
            for (const f of changes.files.slice(0, 5)) {
              const relPath = relative(config.projectRoot, f.filePath).replace(/\\/g, '/');
              const parts: string[] = [];
              if (f.added.length > 0) parts.push(`+${f.added.length} added`);
              if (f.modified.length > 0) parts.push(`~${f.modified.length} modified`);
              if (f.deleted.length > 0) parts.push(`-${f.deleted.length} deleted`);
              lines.push(`  ${relPath}: ${parts.join(', ')}`);
            }
          }
        }

        // Hotspots
        const hotspots = changelog.getHotspots(3);
        if (hotspots.length > 0) {
          lines.push('');
          lines.push('## Hot Files (most frequently changed)');
          for (const h of hotspots) {
            const rel = relative(config.projectRoot, h.filePath).replace(/\\/g, '/');
            lines.push(`  ${rel}: ${h.changeCount} changes`);
          }
        }

        let digest = lines.join('\n');

        // Trim to token budget
        const tokens = estimator.estimate(digest);
        if (tokens > maxTokens) {
          // Truncate by removing sections from the bottom
          while (estimator.estimate(digest) > maxTokens && digest.includes('\n')) {
            const lastNewline = digest.lastIndexOf('\n');
            digest = digest.substring(0, lastNewline);
          }
          digest += '\n\n[Truncated to fit token budget]';
        }

        const result = ok({
          digest,
          tokenCount: estimator.estimate(digest),
          tokensSaved: `~${Math.round(stats.totalNodes * 15)} tokens saved vs reading all files`,
        }, estimator);

        // Cache for 5 minutes
        changelog.setCachedDigest(cacheKey, result, 300_000);

        return mcpText(result);
      } catch (err: unknown) {
        return mcpText(fail(`Failed to generate digest: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  // ── mindmap_file_digest ────────────────────────────────────
  server.tool(
    'mindmap_file_digest',
    'Get a compressed summary of a single file WITHOUT reading the full file. ' +
      'Returns: exports, key functions with signatures, dependencies, and recent changes. ' +
      'Use this to understand a file before deciding whether to read it fully.',
    {
      file: z.string().describe('File path (relative to project root or absolute)'),
    },
    async (args) => {
      try {
        // Resolve file path
        let filePath = args.file;
        if (!filePath.includes(':') && !filePath.startsWith('/')) {
          filePath = `${config.projectRoot}/${filePath}`;
        }
        filePath = filePath.replace(/\//g, '\\');

        // Get all nodes for this file
        const fileNodes = graph.getFileStructure(filePath);
        if (fileNodes.length === 0) {
          // Try relative path match
          const allFiles = graph.getIndexedFiles();
          const match = allFiles.find(f =>
            relative(config.projectRoot, f).replace(/\\/g, '/') === args.file.replace(/\\/g, '/')
          );
          if (match) {
            const nodes = graph.getFileStructure(match);
            if (nodes.length > 0) {
              return buildFileDigest(match, nodes, args.file);
            }
          }
          return mcpText(fail(`File not found in index: ${args.file}`));
        }

        return buildFileDigest(filePath, fileNodes, args.file);
      } catch (err: unknown) {
        return mcpText(fail(`Failed to get file digest: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );

  function buildFileDigest(filePath: string, fileNodes: any[], displayPath: string) {
    const relPath = relative(config.projectRoot, filePath).replace(/\\/g, '/');

    // Categorize symbols
    const exports = fileNodes.filter((n: any) => n.isExported && n.type !== 'file');
    const functions = fileNodes.filter((n: any) => ['function', 'method'].includes(n.type));
    const classes = fileNodes.filter((n: any) => n.type === 'class');
    const interfaces = fileNodes.filter((n: any) => n.type === 'interface');
    const types = fileNodes.filter((n: any) => n.type === 'type_alias');

    // Get file changes
    const changes = changelog.getFileChanges(filePath, 10);

    const result: Record<string, unknown> = {
      file: relPath,
      language: fileNodes[0]?.language || 'unknown',
      totalSymbols: fileNodes.filter((n: any) => n.type !== 'file').length,
      lineRange: {
        start: Math.min(...fileNodes.map((n: any) => n.startLine || 0)),
        end: Math.max(...fileNodes.map((n: any) => n.endLine || 0)),
      },
    };

    if (exports.length > 0) {
      result.exports = exports.map((n: any) => ({
        name: n.name,
        type: n.type,
        signature: n.signature ? n.signature.substring(0, 120) : undefined,
        lines: `${n.startLine}-${n.endLine}`,
      }));
    }

    if (classes.length > 0) {
      result.classes = classes.map((c: any) => ({
        name: c.name,
        exported: c.isExported,
        methods: functions
          .filter((f: any) => f.qualifiedName?.startsWith(c.name + '.'))
          .map((f: any) => f.name),
      }));
    }

    if (functions.length > 0 && !result.exports) {
      result.functions = functions.slice(0, 15).map((f: any) => ({
        name: f.qualifiedName || f.name,
        signature: f.signature ? f.signature.substring(0, 100) : undefined,
        async: f.isAsync || undefined,
        lines: `${f.startLine}-${f.endLine}`,
      }));
    }

    if (changes.length > 0) {
      result.recentChanges = changes.slice(0, 5).map(c => ({
        when: new Date(c.timestamp).toISOString(),
        type: c.changeType,
        symbol: c.symbolName,
        detail: c.changeType === 'modified' && c.oldSignature !== c.newSignature
          ? `${c.oldSignature} → ${c.newSignature}`
          : undefined,
      }));
    }

    result.tokensSaved = `~${Math.round(
      (result as any).lineRange?.end * 4 || 5000
    )} tokens saved vs reading full file`;

    return mcpText(ok(result, estimator));
  }

  // ── mindmap_verify ─────────────────────────────────────────
  server.tool(
    'mindmap_verify',
    'Verify that a file or symbol still matches what you expect. ' +
      'Returns the current content hash and signature without re-reading the file. ' +
      'Use this to check if your cached knowledge of code is still valid.',
    {
      file: z.string().describe('File path to verify'),
      symbol: z.string().optional().describe('Specific symbol name to verify (e.g., "handleLogin")'),
    },
    async (args) => {
      try {
        let filePath = args.file;
        if (!filePath.includes(':') && !filePath.startsWith('/')) {
          filePath = `${config.projectRoot}/${filePath}`;
        }
        filePath = filePath.replace(/\//g, '\\');

        // Get current file hash from disk
        let diskHash: string | null = null;
        let diskMtime: number | null = null;
        let diskSize: number | null = null;
        try {
          const content = await readFile(filePath, 'utf-8');
          diskHash = createHash('sha256').update(content).digest('hex').substring(0, 16);
          const fileStat = await stat(filePath);
          diskMtime = fileStat.mtimeMs;
          diskSize = fileStat.size;
        } catch {
          return mcpText(fail(`Cannot read file: ${args.file}`));
        }

        // Get indexed hash
        const indexEntry = graph.getFileIndexEntry(filePath);
        const indexedHash = indexEntry?.content_hash || null;

        const isStale = indexedHash !== null && indexedHash !== diskHash;

        if (args.symbol) {
          // Verify specific symbol
          const nodes = graph.getNodesByName(args.symbol);
          const match = nodes.find(n =>
            n.filePath === filePath || n.filePath.replace(/\\/g, '/') === filePath.replace(/\\/g, '/')
          );

          if (!match) {
            return mcpText(ok({
              file: args.file,
              symbol: args.symbol,
              status: 'not_found',
              message: `Symbol "${args.symbol}" not found in ${args.file}. It may have been renamed or deleted.`,
              fileIsStale: isStale,
            }, estimator));
          }

          return mcpText(ok({
            file: args.file,
            symbol: args.symbol,
            status: isStale ? 'stale' : 'valid',
            currentSignature: match.signature,
            lines: `${match.startLine}-${match.endLine}`,
            hash: match.hash,
            type: match.type,
            fileIsStale: isStale,
            message: isStale
              ? 'File has been modified since last index. Symbol data may be outdated.'
              : 'Symbol data is up-to-date.',
          }, estimator));
        }

        // Verify entire file
        return mcpText(ok({
          file: args.file,
          status: isStale ? 'stale' : 'valid',
          diskHash,
          indexedHash,
          diskSize,
          lastIndexed: indexEntry?.indexed_at
            ? new Date(indexEntry.indexed_at).toISOString()
            : null,
          lastModified: diskMtime ? new Date(diskMtime).toISOString() : null,
          message: isStale
            ? 'File has changed since last index. Run mindmap_reindex or wait for auto-update.'
            : 'File is up-to-date in the index.',
        }, estimator));
      } catch (err: unknown) {
        return mcpText(fail(`Verification failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  );
}
