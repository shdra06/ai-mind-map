/**
 * AI Mind Map — Configuration Loader
 *
 * Loads and validates configuration from multiple sources:
 * 1. DEFAULT_CONFIG baseline from types.ts
 * 2. .mindmap.json from the project root (if present)
 * 3. CLI arguments (--project-root, --db-path, --log-level)
 *
 * Relative paths are resolved against the project root.
 * If no project root is specified the loader auto-detects the
 * nearest Git repository root.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { simpleGit } from 'simple-git';

import type { MindMapConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

// ============================================================
// Zod validation schema (mirrors MindMapConfig)
// ============================================================

const TokenBudgetSchema = z.object({
  graphResults: z.number().int().positive(),
  changeSummary: z.number().int().positive(),
  memoryRetrieval: z.number().int().positive(),
  fileContent: z.number().int().positive(),
  totalContext: z.number().int().positive(),
});

const MemoryConfigSchema = z.object({
  maxMemories: z.number().int().positive(),
  decayRate: z.number().min(0).max(1),
  importanceThreshold: z.number().min(0).max(1),
  maxDecisions: z.number().int().positive(),
});

const CompressionLevelSchema = z.enum(['minimal', 'moderate', 'aggressive']);

const MindMapConfigSchema = z.object({
  projectRoot: z.string().min(1),
  languages: z.array(z.string()),
  ignore: z.array(z.string()),
  tokenBudgets: TokenBudgetSchema,
  memory: MemoryConfigSchema,
  compression: CompressionLevelSchema,
  dbPath: z.string().min(1),
  watchEnabled: z.boolean(),
  watchDebounceMs: z.number().int().min(50),
  maxFileSize: z.number().int().positive(),
  pageRankEnabled: z.boolean(),
  memoryOnly: z.boolean(),
  sharedContextFile: z.string().min(1),
  autoSyncSharedContext: z.boolean(),
});

/** Partial schema used when reading .mindmap.json (all fields optional) */
const PartialConfigSchema = MindMapConfigSchema.partial();

// ============================================================
// CLI argument parsing
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface CliArgs {
  projectRoot?: string;
  dbPath?: string;
  logLevel: LogLevel;
}

/**
 * Parse CLI arguments from `process.argv`.
 *
 * Recognised flags:
 *   --project-root <path>
 *   --db-path      <path>
 *   --log-level    debug|info|warn|error  (default: info)
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const args: CliArgs = { logLevel: 'info' };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case '--project-root':
        if (!next) throw new Error('--project-root requires a value');
        args.projectRoot = next;
        i++;
        break;
      case '--db-path':
        if (!next) throw new Error('--db-path requires a value');
        args.dbPath = next;
        i++;
        break;
      case '--log-level':
        if (!next) throw new Error('--log-level requires a value');
        if (!['debug', 'info', 'warn', 'error'].includes(next)) {
          throw new Error(`Invalid log level: ${next}`);
        }
        args.logLevel = next as LogLevel;
        i++;
        break;
      default:
        // Silently ignore unrecognised flags for forward-compat
        break;
    }
  }

  return args;
}

// ============================================================
// Git root detection
// ============================================================

/**
 * Auto-detect the project root by walking up to the nearest `.git` directory.
 * Falls back to `process.cwd()` when Git is unavailable.
 */
async function detectProjectRoot(startDir: string): Promise<string> {
  try {
    const git = simpleGit(startDir);
    const topLevel = await git.revparse(['--show-toplevel']);
    return path.resolve(topLevel.trim());
  } catch {
    // Not a Git repo — fall back to cwd
    return path.resolve(startDir);
  }
}

// ============================================================
// File-based config reader
// ============================================================

/**
 * Try to read and parse a `.mindmap.json` configuration file.
 * Returns `null` when the file does not exist.
 * Throws when the file exists but contains invalid JSON or schema violations.
 */
function readConfigFile(projectRoot: string): Partial<MindMapConfig> | null {
  const configPath = path.join(projectRoot, '.mindmap.json');

  if (!existsSync(configPath)) {
    return null;
  }

  const raw = readFileSync(configPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }

  const result = PartialConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration in ${configPath}:\n${issues}`);
  }

  return result.data;
}

// ============================================================
// Path resolution helpers
// ============================================================

/** Resolve a potentially-relative path against `base`. */
function resolvePath(base: string, p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
}

// ============================================================
// Deep merge utility
// ============================================================

/**
 * Deep-merge `source` into `target`. Primitive values in `source` overwrite
 * those in `target`; arrays are replaced (not concatenated); nested objects
 * are merged recursively.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const out = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal !== undefined &&
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== undefined &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      out[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (srcVal !== undefined) {
      out[key] = srcVal as T[keyof T];
    }
  }

  return out;
}

// ============================================================
// Public API
// ============================================================

/**
 * Load, merge, and validate the final Mind Map configuration.
 *
 * Priority (highest → lowest):
 *   1. CLI arguments
 *   2. `.mindmap.json` from project root
 *   3. `DEFAULT_CONFIG`
 */
export async function loadConfig(cliArgs?: CliArgs): Promise<MindMapConfig> {
  const args = cliArgs ?? parseCliArgs();

  // 1. Determine project root
  const rawRoot = args.projectRoot ?? process.cwd();
  const projectRoot = await detectProjectRoot(rawRoot);

  // 2. Read .mindmap.json (if it exists)
  const fileConfig = readConfigFile(projectRoot);

  // 3. Build merged config: defaults ← file ← CLI
  let merged: MindMapConfig = { ...DEFAULT_CONFIG };

  if (fileConfig) {
    // M33: Warn when .mindmap.json specifies a different projectRoot
    if (fileConfig.projectRoot && fileConfig.projectRoot !== projectRoot) {
      process.stderr.write(
        `[WARN] .mindmap.json specifies projectRoot="${fileConfig.projectRoot}" but resolved root is "${projectRoot}". ` +
        `The resolved root will be used. Remove projectRoot from .mindmap.json to suppress this warning.\n`
      );
    }
    merged = deepMerge(
      merged as unknown as Record<string, unknown>,
      fileConfig as unknown as Partial<Record<string, unknown>>,
    ) as unknown as MindMapConfig;
  }

  // Apply CLI overrides
  merged.projectRoot = projectRoot;
  if (args.dbPath) {
    merged.dbPath = args.dbPath;
  }

  // 4. Resolve relative paths
  merged.projectRoot = path.resolve(projectRoot);
  merged.dbPath = resolvePath(merged.projectRoot, merged.dbPath);

  // Ensure the parent directory for the DB path is valid
  const dbDir = path.dirname(merged.dbPath);
  if (existsSync(dbDir) && !statSync(dbDir).isDirectory()) {
    throw new Error(`DB path parent is not a directory: ${dbDir}`);
  }

  // 5. Final schema validation
  const validationResult = MindMapConfigSchema.safeParse(merged);
  if (!validationResult.success) {
    const issues = validationResult.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  return validationResult.data as MindMapConfig;
}
