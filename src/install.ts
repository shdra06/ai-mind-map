/**
 * AI Mind Map — Agent Auto-Detection & Installation
 *
 * Detects installed AI coding agents by probing their known config locations
 * and writes MCP server entries so each agent can discover AI Mind Map.
 *
 * Inspired by codebase-memory-mcp's install command supporting 11+ agents.
 *
 * Supported agents:
 *   1. Claude Code          ~/.claude/
 *   2. Cursor               .cursor/
 *   3. VS Code (Copilot)    VS Code settings dir
 *   4. Windsurf             .windsurf/ or Windsurf config
 *   5. Antigravity (Gemini) .gemini/config/
 *   6. Zed                  Zed config dir
 *   7. Continue.dev         .continue/
 *
 * @module install
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import process from 'node:process';
import type { MindMapConfig } from './types.js';

// ============================================================
// ANSI Color Helpers
// ============================================================

const supportsColor = process.stdout.isTTY !== false;

const c = {
  reset: supportsColor ? '\x1b[0m' : '',
  bold: supportsColor ? '\x1b[1m' : '',
  dim: supportsColor ? '\x1b[2m' : '',
  red: supportsColor ? '\x1b[31m' : '',
  green: supportsColor ? '\x1b[32m' : '',
  yellow: supportsColor ? '\x1b[33m' : '',
  blue: supportsColor ? '\x1b[34m' : '',
  magenta: supportsColor ? '\x1b[35m' : '',
  cyan: supportsColor ? '\x1b[36m' : '',
  gray: supportsColor ? '\x1b[90m' : '',
};

function logFound(name: string, location: string): void {
  console.log(`  ${c.green}[FOUND]${c.reset}      ${c.bold}${name}${c.reset} ${c.dim}at ${location}${c.reset}`);
}

function logNotFound(name: string): void {
  console.log(`  ${c.gray}[NOT FOUND]${c.reset}  ${name}`);
}

function logConfigured(name: string): void {
  console.log(`  ${c.green}[CONFIGURED]${c.reset} ${c.bold}${name}${c.reset} MCP entry added`);
}

function logSkipped(name: string, reason: string): void {
  console.log(`  ${c.yellow}[SKIPPED]${c.reset}    ${name}: ${reason}`);
}

function logRemoved(name: string): void {
  console.log(`  ${c.yellow}[REMOVED]${c.reset}    ${name} MCP entry removed`);
}

function logError(name: string, msg: string): void {
  console.log(`  ${c.red}[ERROR]${c.reset}      ${name}: ${msg}`);
}

function logOk(msg: string): void {
  console.log(`  ${c.green}✔${c.reset} ${msg}`);
}

function logFail(msg: string): void {
  console.log(`  ${c.red}✖${c.reset} ${msg}`);
}

function logWarn(msg: string): void {
  console.log(`  ${c.yellow}⚠${c.reset} ${msg}`);
}

function logInfo(msg: string): void {
  console.log(`  ${c.blue}ℹ${c.reset} ${msg}`);
}

function heading(msg: string): void {
  console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`);
}

function divider(): void {
  console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
}

// ============================================================
// Path Resolution
// ============================================================

const HOME = homedir();
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

/**
 * Resolve the absolute path to the compiled dist/index.js entry point
 * (or cli.js as fallback).
 */
function getServerEntryPath(): string {
  // Try to resolve from this file's location
  const thisDir = path.dirname(
    new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  );

  // Expect: src/install.ts → dist/index.js
  const distIndex = path.resolve(thisDir, '..', 'dist', 'index.js');
  if (existsSync(distIndex)) return distIndex;

  // Fallback: check if we're already in dist
  const distSelf = path.resolve(thisDir, 'index.js');
  if (existsSync(distSelf)) return distSelf;

  // Last resort: use the source path
  return path.resolve(thisDir, '..', 'dist', 'index.js');
}

/** Get the VS Code settings directory based on platform */
function getVSCodeSettingsDir(): string {
  if (IS_WIN) {
    return path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User');
  } else if (IS_MAC) {
    return path.join(HOME, 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(HOME, '.config', 'Code', 'User');
}

/** Get the Zed settings directory based on platform */
function getZedSettingsDir(): string {
  if (IS_MAC) {
    return path.join(HOME, 'Library', 'Application Support', 'Zed');
  }
  return path.join(HOME, '.config', 'zed');
}

/** Get the Windsurf settings directory based on platform */
function getWindsurfSettingsDir(): string {
  if (IS_WIN) {
    return path.join(
      process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'),
      'Windsurf',
      'User',
    );
  } else if (IS_MAC) {
    return path.join(HOME, 'Library', 'Application Support', 'Windsurf', 'User');
  }
  return path.join(HOME, '.config', 'Windsurf', 'User');
}

// ============================================================
// Agent Definition Types
// ============================================================

interface AgentDefinition {
  /** Display name */
  name: string;
  /** Unique identifier */
  id: string;
  /** Probe paths (any existing = detected) */
  probePaths: string[];
  /** Config file to write/update */
  configPath: string;
  /** Function to generate the MCP config content */
  generateConfig: (serverEntry: string) => string;
  /** Function to detect if already configured */
  isConfigured: () => boolean;
  /** Function to remove the configuration */
  removeConfig: () => boolean;
}

// ============================================================
// MCP Config Snippet Generators
// ============================================================

/** Generate the standard MCP server config object */
function mcpServerEntry(serverEntry: string): Record<string, unknown> {
  return {
    'ai-mind-map': {
      command: 'node',
      args: [serverEntry],
      env: {},
    },
  };
}

/** Read a JSON file safely, returning null on failure */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a JSON object to a file, creating parent dirs if needed */
function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Merge an MCP server entry into an existing JSON config.
 * Creates the file if it doesn't exist.
 *
 * @param configPath   - Path to the config file
 * @param mcpKey       - The JSON key under which MCP servers live (e.g., "mcpServers")
 * @param serverEntry  - Path to the server executable
 * @returns true if changes were made
 */
function mergeMcpConfig(
  configPath: string,
  mcpKey: string,
  serverEntry: string,
): boolean {
  const existing = readJsonFile(configPath) ?? {};
  const servers = (existing[mcpKey] as Record<string, unknown>) ?? {};

  // Already configured?
  if (servers['ai-mind-map']) {
    return false;
  }

  servers['ai-mind-map'] = {
    command: 'node',
    args: [serverEntry],
    env: {},
  };

  existing[mcpKey] = servers;
  writeJsonFile(configPath, existing);
  return true;
}

/**
 * Remove the ai-mind-map entry from a JSON config file.
 *
 * @param configPath - Path to the config file
 * @param mcpKey     - The JSON key under which MCP servers live
 * @returns true if the entry was found and removed
 */
function removeMcpConfig(configPath: string, mcpKey: string): boolean {
  const existing = readJsonFile(configPath);
  if (!existing) return false;

  const servers = existing[mcpKey] as Record<string, unknown> | undefined;
  if (!servers || !servers['ai-mind-map']) return false;

  delete servers['ai-mind-map'];

  // If the mcpServers object is empty, remove the key entirely
  if (Object.keys(servers).length === 0) {
    delete existing[mcpKey];
  } else {
    existing[mcpKey] = servers;
  }

  writeJsonFile(configPath, existing);
  return true;
}

/** Check if ai-mind-map is already configured in a JSON file under a given key */
function hasMcpConfig(configPath: string, mcpKey: string): boolean {
  const existing = readJsonFile(configPath);
  if (!existing) return false;
  const servers = existing[mcpKey] as Record<string, unknown> | undefined;
  return !!servers?.['ai-mind-map'];
}

// ============================================================
// Agent Definitions
// ============================================================

function getAgentDefinitions(serverEntry: string): AgentDefinition[] {
  return [
    // 1. Claude Code
    {
      name: 'Claude Code',
      id: 'claude-code',
      probePaths: [
        path.join(HOME, '.claude'),
      ],
      configPath: path.join(HOME, '.claude', 'claude_desktop_config.json'),
      generateConfig: () => JSON.stringify({ mcpServers: mcpServerEntry(serverEntry) }, null, 2),
      isConfigured: () => hasMcpConfig(
        path.join(HOME, '.claude', 'claude_desktop_config.json'),
        'mcpServers',
      ),
      removeConfig: () => removeMcpConfig(
        path.join(HOME, '.claude', 'claude_desktop_config.json'),
        'mcpServers',
      ),
    },

    // 2. Cursor
    {
      name: 'Cursor',
      id: 'cursor',
      probePaths: [
        path.join(HOME, '.cursor'),
        path.join(process.cwd(), '.cursor'),
      ],
      configPath: path.join(HOME, '.cursor', 'mcp.json'),
      generateConfig: () => JSON.stringify({ mcpServers: mcpServerEntry(serverEntry) }, null, 2),
      isConfigured: () => hasMcpConfig(
        path.join(HOME, '.cursor', 'mcp.json'),
        'mcpServers',
      ),
      removeConfig: () => removeMcpConfig(
        path.join(HOME, '.cursor', 'mcp.json'),
        'mcpServers',
      ),
    },

    // 3. VS Code
    {
      name: 'VS Code',
      id: 'vscode',
      probePaths: [
        getVSCodeSettingsDir(),
        path.join(getVSCodeSettingsDir(), 'settings.json'),
      ],
      configPath: path.join(getVSCodeSettingsDir(), 'settings.json'),
      generateConfig: () => {
        const existing = readJsonFile(path.join(getVSCodeSettingsDir(), 'settings.json')) ?? {};
        const mcpServers = (existing['mcp.servers'] as Record<string, unknown>) ?? {};
        mcpServers['ai-mind-map'] = {
          command: 'node',
          args: [serverEntry],
          env: {},
        };
        existing['mcp.servers'] = mcpServers;
        return JSON.stringify(existing, null, 2);
      },
      isConfigured: () => hasMcpConfig(
        path.join(getVSCodeSettingsDir(), 'settings.json'),
        'mcp.servers',
      ),
      removeConfig: () => removeMcpConfig(
        path.join(getVSCodeSettingsDir(), 'settings.json'),
        'mcp.servers',
      ),
    },

    // 4. Windsurf
    {
      name: 'Windsurf',
      id: 'windsurf',
      probePaths: [
        getWindsurfSettingsDir(),
        path.join(HOME, '.windsurf'),
      ],
      configPath: path.join(getWindsurfSettingsDir(), 'settings.json'),
      generateConfig: () => {
        const existing = readJsonFile(path.join(getWindsurfSettingsDir(), 'settings.json')) ?? {};
        const mcpServers = (existing['mcp.servers'] as Record<string, unknown>) ?? {};
        mcpServers['ai-mind-map'] = {
          command: 'node',
          args: [serverEntry],
          env: {},
        };
        existing['mcp.servers'] = mcpServers;
        return JSON.stringify(existing, null, 2);
      },
      isConfigured: () => hasMcpConfig(
        path.join(getWindsurfSettingsDir(), 'settings.json'),
        'mcp.servers',
      ),
      removeConfig: () => removeMcpConfig(
        path.join(getWindsurfSettingsDir(), 'settings.json'),
        'mcp.servers',
      ),
    },

    // 5. Antigravity (Gemini)
    {
      name: 'Antigravity (Gemini)',
      id: 'antigravity',
      probePaths: [
        path.join(HOME, '.gemini', 'config'),
        path.join(HOME, '.gemini'),
      ],
      configPath: path.join(HOME, '.gemini', 'config', 'mcp.json'),
      generateConfig: () => JSON.stringify({ mcpServers: mcpServerEntry(serverEntry) }, null, 2),
      isConfigured: () => hasMcpConfig(
        path.join(HOME, '.gemini', 'config', 'mcp.json'),
        'mcpServers',
      ),
      removeConfig: () => removeMcpConfig(
        path.join(HOME, '.gemini', 'config', 'mcp.json'),
        'mcpServers',
      ),
    },

    // 6. Zed
    {
      name: 'Zed',
      id: 'zed',
      probePaths: [
        getZedSettingsDir(),
      ],
      configPath: path.join(getZedSettingsDir(), 'settings.json'),
      generateConfig: () => {
        const existing = readJsonFile(path.join(getZedSettingsDir(), 'settings.json')) ?? {};
        const contextServers = (existing['context_servers'] as Record<string, unknown>) ?? {};
        contextServers['ai-mind-map'] = {
          command: {
            path: 'node',
            args: [serverEntry],
            env: {},
          },
          settings: {},
        };
        existing['context_servers'] = contextServers;
        return JSON.stringify(existing, null, 2);
      },
      isConfigured: () => {
        const existing = readJsonFile(path.join(getZedSettingsDir(), 'settings.json'));
        if (!existing) return false;
        const ctx = existing['context_servers'] as Record<string, unknown> | undefined;
        return !!ctx?.['ai-mind-map'];
      },
      removeConfig: () => {
        const configPath = path.join(getZedSettingsDir(), 'settings.json');
        const existing = readJsonFile(configPath);
        if (!existing) return false;
        const ctx = existing['context_servers'] as Record<string, unknown> | undefined;
        if (!ctx?.['ai-mind-map']) return false;
        delete ctx['ai-mind-map'];
        if (Object.keys(ctx).length === 0) {
          delete existing['context_servers'];
        }
        writeJsonFile(configPath, existing);
        return true;
      },
    },

    // 7. Continue.dev
    {
      name: 'Continue.dev',
      id: 'continue',
      probePaths: [
        path.join(HOME, '.continue'),
      ],
      configPath: path.join(HOME, '.continue', 'config.json'),
      generateConfig: () => {
        const existing = readJsonFile(path.join(HOME, '.continue', 'config.json')) ?? {};
        const experimental = (existing['experimental'] as Record<string, unknown>) ?? {};
        const modelContextProtocolServers = (experimental['modelContextProtocolServers'] as Array<Record<string, unknown>>) ?? [];

        // Check if already present
        const exists = modelContextProtocolServers.some(
          (s: Record<string, unknown>) => s['name'] === 'ai-mind-map',
        );
        if (!exists) {
          modelContextProtocolServers.push({
            name: 'ai-mind-map',
            command: 'node',
            args: [serverEntry],
            env: {},
          });
        }

        experimental['modelContextProtocolServers'] = modelContextProtocolServers;
        existing['experimental'] = experimental;
        return JSON.stringify(existing, null, 2);
      },
      isConfigured: () => {
        const existing = readJsonFile(path.join(HOME, '.continue', 'config.json'));
        if (!existing) return false;
        const exp = existing['experimental'] as Record<string, unknown> | undefined;
        if (!exp) return false;
        const servers = exp['modelContextProtocolServers'] as Array<Record<string, unknown>> | undefined;
        if (!servers) return false;
        return servers.some((s) => s['name'] === 'ai-mind-map');
      },
      removeConfig: () => {
        const configPath = path.join(HOME, '.continue', 'config.json');
        const existing = readJsonFile(configPath);
        if (!existing) return false;
        const exp = existing['experimental'] as Record<string, unknown> | undefined;
        if (!exp) return false;
        const servers = exp['modelContextProtocolServers'] as Array<Record<string, unknown>> | undefined;
        if (!servers) return false;
        const filtered = servers.filter((s) => s['name'] !== 'ai-mind-map');
        if (filtered.length === servers.length) return false; // nothing removed
        exp['modelContextProtocolServers'] = filtered;
        writeJsonFile(configPath, existing);
        return true;
      },
    },
  ];
}

// ============================================================
// Public API: installAgents
// ============================================================

/**
 * Auto-detect installed AI coding agents and configure their MCP settings
 * to include the AI Mind Map server.
 *
 * Checks 7 agents and writes JSON config for each one found.
 */
export async function installAgents(): Promise<void> {
  heading('🔌 AI Mind Map — Agent Installation');
  divider();

  const serverEntry = getServerEntryPath();
  logInfo(`Server entry: ${serverEntry}`);
  console.log('');

  const agents = getAgentDefinitions(serverEntry);
  let foundCount = 0;
  let configuredCount = 0;

  for (const agent of agents) {
    const detected = agent.probePaths.some((p) => existsSync(p));

    if (!detected) {
      logNotFound(agent.name);
      continue;
    }

    foundCount++;
    const probedPath = agent.probePaths.find((p) => existsSync(p)) ?? agent.probePaths[0];
    logFound(agent.name, probedPath);

    // Check if already configured
    if (agent.isConfigured()) {
      logSkipped(agent.name, 'already configured');
      continue;
    }

    // Write the configuration
    try {
      // Use the specific merge strategy for each agent
      const configDir = path.dirname(agent.configPath);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      // For agents that use mcpServers key directly
      if (['claude-code', 'cursor', 'antigravity'].includes(agent.id)) {
        mergeMcpConfig(agent.configPath, 'mcpServers', serverEntry);
      } else if (['vscode', 'windsurf'].includes(agent.id)) {
        mergeMcpConfig(agent.configPath, 'mcp.servers', serverEntry);
      } else {
        // For Zed and Continue.dev, generate full config and write
        const configContent = agent.generateConfig(serverEntry);
        writeFileSync(agent.configPath, configContent + '\n', 'utf-8');
      }

      logConfigured(agent.name);
      configuredCount++;
    } catch (err) {
      logError(agent.name, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('');
  divider();

  if (foundCount === 0) {
    logWarn('No AI coding agents detected on this system.');
    logInfo('Install an agent first, then re-run "ai-mind-map install".');
  } else {
    logOk(`${foundCount} agent(s) detected, ${configuredCount} newly configured.`);
  }

  // Deploy rules files so agents know about our capabilities
  console.log('');
  deployRulesFiles();

  console.log('');
}

// ============================================================
// Public API: uninstallAgents
// ============================================================

/**
 * Remove AI Mind Map MCP configurations from all detected agents.
 */
export async function uninstallAgents(): Promise<void> {
  heading('🔌 AI Mind Map — Agent Uninstall');
  divider();

  const serverEntry = getServerEntryPath();
  const agents = getAgentDefinitions(serverEntry);
  let removedCount = 0;

  for (const agent of agents) {
    if (!agent.isConfigured()) {
      continue;
    }

    try {
      const removed = agent.removeConfig();
      if (removed) {
        logRemoved(agent.name);
        removedCount++;
      }
    } catch (err) {
      logError(agent.name, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('');
  divider();

  if (removedCount === 0) {
    logInfo('No AI Mind Map configurations found to remove.');
  } else {
    logOk(`Removed AI Mind Map from ${removedCount} agent(s).`);
  }

  console.log('');
}

// ============================================================
// Public API: listAgents
// ============================================================

/** Status of a single detected agent */
export interface AgentStatus {
  name: string;
  id: string;
  detected: boolean;
  configured: boolean;
  configPath: string;
}

/**
 * List all supported agents and their detection/configuration status.
 */
export function listAgents(): AgentStatus[] {
  const serverEntry = getServerEntryPath();
  const agents = getAgentDefinitions(serverEntry);

  return agents.map((agent) => {
    const detected = agent.probePaths.some((p) => existsSync(p));
    let configured = false;
    try {
      configured = agent.isConfigured();
    } catch {
      // ignore
    }

    return {
      name: agent.name,
      id: agent.id,
      detected,
      configured,
      configPath: agent.configPath,
    };
  });
}

// ============================================================
// Public API: runDoctor
// ============================================================

/** Individual diagnostic check result */
interface DiagnosticResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

/**
 * Run a comprehensive diagnostics check covering:
 * - Node.js version
 * - npm version
 * - TypeScript compilation status
 * - SQLite working
 * - Project indexed status
 * - Memory database accessible
 * - Detected & configured agents
 */
export async function runDoctor(): Promise<void> {
  heading('🩺 AI Mind Map — Diagnostics');
  divider();

  const results: DiagnosticResult[] = [];

  // 1. Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (nodeMajor >= 18) {
    results.push({
      name: 'Node.js',
      status: 'ok',
      message: `${nodeVersion} (>= 18 required)`,
    });
  } else {
    results.push({
      name: 'Node.js',
      status: 'fail',
      message: `${nodeVersion} — Node.js >= 18.0.0 is required`,
    });
  }

  // 2. npm version
  try {
    const npmVersion = execSync('npm --version', { encoding: 'utf-8' }).trim();
    results.push({
      name: 'npm',
      status: 'ok',
      message: `v${npmVersion}`,
    });
  } catch {
    results.push({
      name: 'npm',
      status: 'warn',
      message: 'npm not found in PATH',
    });
  }

  // 3. TypeScript compilation
  const distDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
    '..',
    'dist',
  );
  if (existsSync(path.join(distDir, 'index.js'))) {
    results.push({
      name: 'TypeScript Build',
      status: 'ok',
      message: `dist/index.js exists at ${distDir}`,
    });
  } else {
    results.push({
      name: 'TypeScript Build',
      status: 'warn',
      message: 'dist/index.js not found — run "npm run build" first',
    });
  }

  // 4. SQLite working
  try {
    const Database = (await import('better-sqlite3')).default;
    const testDb = new Database(':memory:');
    testDb.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    testDb.exec('INSERT INTO test (id) VALUES (1)');
    const row = testDb.prepare('SELECT id FROM test').get() as { id: number };
    testDb.close();

    if (row?.id === 1) {
      results.push({
        name: 'SQLite (better-sqlite3)',
        status: 'ok',
        message: 'In-memory test passed',
      });
    } else {
      results.push({
        name: 'SQLite (better-sqlite3)',
        status: 'fail',
        message: 'Query returned unexpected result',
      });
    }
  } catch (err) {
    results.push({
      name: 'SQLite (better-sqlite3)',
      status: 'fail',
      message: `Import/test failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. Project indexed?
  const defaultDbPath = path.resolve(process.cwd(), '.mindmap', 'mindmap.db');
  if (existsSync(defaultDbPath)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(defaultDbPath, { readonly: true });
      const nodeCount = (db.prepare('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number }).cnt;
      db.close();
      results.push({
        name: 'Project Indexed',
        status: nodeCount > 0 ? 'ok' : 'warn',
        message: nodeCount > 0
          ? `${nodeCount.toLocaleString()} nodes in ${defaultDbPath}`
          : `Database exists but is empty — run "ai-mind-map index"`,
      });
    } catch {
      results.push({
        name: 'Project Indexed',
        status: 'warn',
        message: `Database exists at ${defaultDbPath} but could not be read`,
      });
    }
  } else {
    results.push({
      name: 'Project Indexed',
      status: 'warn',
      message: 'No .mindmap/mindmap.db found — run "ai-mind-map index <path>"',
    });
  }

  // 6. Memory database accessible?
  if (existsSync(defaultDbPath)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(defaultDbPath, { readonly: true });
      let memCount = 0;
      try {
        memCount = (db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }).cnt;
      } catch {
        // memories table might not exist yet
      }
      db.close();
      results.push({
        name: 'Memory Store',
        status: 'ok',
        message: `${memCount} memories stored`,
      });
    } catch {
      results.push({
        name: 'Memory Store',
        status: 'warn',
        message: 'Could not read memory database',
      });
    }
  } else {
    results.push({
      name: 'Memory Store',
      status: 'warn',
      message: 'Database not found (will be created on first use)',
    });
  }

  // 7. Agent detection
  const agentStatuses = listAgents();
  const detectedAgents = agentStatuses.filter((a) => a.detected);
  const configuredAgents = agentStatuses.filter((a) => a.configured);

  if (detectedAgents.length > 0) {
    results.push({
      name: 'AI Agents Detected',
      status: 'ok',
      message: `${detectedAgents.length} agent(s): ${detectedAgents.map((a) => a.name).join(', ')}`,
    });
  } else {
    results.push({
      name: 'AI Agents Detected',
      status: 'warn',
      message: 'No supported AI coding agents detected',
    });
  }

  if (configuredAgents.length > 0) {
    results.push({
      name: 'AI Agents Configured',
      status: 'ok',
      message: `${configuredAgents.length} agent(s): ${configuredAgents.map((a) => a.name).join(', ')}`,
    });
  } else if (detectedAgents.length > 0) {
    results.push({
      name: 'AI Agents Configured',
      status: 'warn',
      message: 'No agents configured — run "ai-mind-map install"',
    });
  }

  // Print results
  console.log('');
  const maxNameLen = Math.max(...results.map((r) => r.name.length));

  for (const result of results) {
    const paddedName = result.name.padEnd(maxNameLen + 2);

    if (result.status === 'ok') {
      logOk(`${paddedName} ${result.message}`);
    } else if (result.status === 'warn') {
      logWarn(`${paddedName} ${result.message}`);
    } else {
      logFail(`${paddedName} ${result.message}`);
    }
  }

  // Summary
  const okCount = results.filter((r) => r.status === 'ok').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;
  const failCount = results.filter((r) => r.status === 'fail').length;

  console.log('');
  divider();

  if (failCount > 0) {
    logFail(`${okCount} passed, ${warnCount} warnings, ${failCount} failures`);
    logInfo('Fix the failures above before using AI Mind Map.');
  } else if (warnCount > 0) {
    logWarn(`${okCount} passed, ${warnCount} warnings`);
    logInfo('AI Mind Map should work, but address warnings for best experience.');
  } else {
    logOk(`All ${okCount} checks passed!`);
    logInfo('AI Mind Map is ready to use.');
  }

  // Agent detail table
  if (agentStatuses.some((a) => a.detected)) {
    console.log('');
    heading('Agent Details');
    divider();

    for (const agent of agentStatuses) {
      const statusIcon = !agent.detected
        ? `${c.gray}○${c.reset}`
        : agent.configured
          ? `${c.green}●${c.reset}`
          : `${c.yellow}◐${c.reset}`;

      const statusText = !agent.detected
        ? `${c.gray}not found${c.reset}`
        : agent.configured
          ? `${c.green}configured${c.reset}`
          : `${c.yellow}detected, not configured${c.reset}`;

      console.log(
        `  ${statusIcon} ${c.bold}${agent.name.padEnd(22)}${c.reset} ${statusText}`,
      );
      if (agent.detected && agent.configured) {
        console.log(`    ${c.dim}${agent.configPath}${c.reset}`);
      }
    }
  }

  console.log('');
}

// ============================================================
// Rules File Deployment
// ============================================================

/** The core rules content that teaches AI agents about our tools */
function getToolAwarenessRules(): string {
  return `# AI Mind Map MCP — Tool Awareness

You have the AI Mind Map MCP server connected with 32 tools. Use them INSTEAD of reading raw files.

## Quick Lookup: "I need to..." → Use this tool

- Understand the project → \`mindmap_architecture\`
- Find a function → \`mindmap_search\`, \`mindmap_get_code_snippet\`
- Trace what a button/feature does → \`mindmap_trace_flow\`
- See all routes/events/components → \`mindmap_interaction_map\`
- Know what layer a file is → \`mindmap_classify_file\`
- Debug a crash → \`mindmap_debug_changes\` (shows ACTUAL diffs)
- See previous file version → \`mindmap_file_before\`
- Know what changed recently → \`mindmap_what_changed\`
- Get blast radius of a change → \`mindmap_impact_analysis\`
- Remember something → \`mindmap_remember\`
- Recall past knowledge → \`mindmap_recall\`
- Record a decision → \`mindmap_decide\`
- Start a new task → \`mindmap_get_context\` (ALWAYS call first)
- Get function signature → \`mindmap_get_signature\` (DON'T open the file)
- Find who calls a function → \`mindmap_find_references\`
- Find dead code → \`mindmap_dead_code\`
- Run graph query → \`mindmap_query_graph\`

## Rules
1. ALWAYS call \`mindmap_get_context\` at the start of every task
2. NEVER read a file when \`mindmap_get_signature\` or \`mindmap_get_code_snippet\` suffices
3. NEVER trace call chains manually — use \`mindmap_trace_flow\`
4. ALWAYS start debugging with \`mindmap_debug_changes\`
5. ALWAYS \`mindmap_remember\` important learnings
`;
}

/**
 * Deploy rules files into the user's project so AI agents automatically
 * know about Mind Map's capabilities.
 *
 * Creates:
 *   - CLAUDE.md (for Claude Code)
 *   - .cursorrules (for Cursor)
 *   - .agents/AGENTS.md (for Antigravity/Gemini)
 *   - .github/copilot-instructions.md (for GitHub Copilot)
 *   - .windsurfrules (for Windsurf)
 */
export function deployRulesFiles(projectRoot?: string): void {
  const root = projectRoot ?? process.cwd();
  const rules = getToolAwarenessRules();

  const deployments: Array<{
    name: string;
    filePath: string;
    content: string;
    agent: string;
  }> = [
    {
      name: 'CLAUDE.md',
      filePath: path.join(root, 'CLAUDE.md'),
      content: rules,
      agent: 'Claude Code',
    },
    {
      name: '.cursorrules',
      filePath: path.join(root, '.cursorrules'),
      content: rules,
      agent: 'Cursor',
    },
    {
      name: '.agents/AGENTS.md',
      filePath: path.join(root, '.agents', 'AGENTS.md'),
      content: rules,
      agent: 'Antigravity / Gemini',
    },
    {
      name: '.github/copilot-instructions.md',
      filePath: path.join(root, '.github', 'copilot-instructions.md'),
      content: rules,
      agent: 'GitHub Copilot',
    },
    {
      name: '.windsurfrules',
      filePath: path.join(root, '.windsurfrules'),
      content: rules,
      agent: 'Windsurf',
    },
  ];

  heading('📋 Deploying AI Agent Rules Files');
  console.log(`  ${c.dim}These files teach each AI agent about Mind Map\'s 32 tools${c.reset}`);
  console.log('');

  let deployed = 0;
  let skipped = 0;

  for (const dep of deployments) {
    // Skip if file already exists with our content
    if (existsSync(dep.filePath)) {
      try {
        const existing = readFileSync(dep.filePath, 'utf-8');
        if (existing.includes('AI Mind Map MCP')) {
          console.log(`  ${c.yellow}⊘${c.reset} ${dep.name} ${c.dim}(already has Mind Map rules)${c.reset}`);
          skipped++;
          continue;
        }
        // File exists but doesn't have our rules — append
        const separator = '\n\n---\n\n';
        writeFileSync(dep.filePath, existing + separator + dep.content, 'utf-8');
        console.log(`  ${c.green}✓${c.reset} ${dep.name} ${c.dim}(appended Mind Map rules)${c.reset} — for ${dep.agent}`);
        deployed++;
      } catch {
        console.log(`  ${c.red}✗${c.reset} ${dep.name} ${c.dim}(failed to read/write)${c.reset}`);
      }
    } else {
      // Create new file
      try {
        const dir = path.dirname(dep.filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(dep.filePath, dep.content, 'utf-8');
        console.log(`  ${c.green}✓${c.reset} ${dep.name} ${c.dim}(created)${c.reset} — for ${dep.agent}`);
        deployed++;
      } catch {
        console.log(`  ${c.red}✗${c.reset} ${dep.name} ${c.dim}(failed to create)${c.reset}`);
      }
    }
  }

  console.log('');
  logOk(`${deployed} rules file(s) deployed, ${skipped} already up-to-date.`);
  console.log(`  ${c.dim}Each AI agent will now know about all 32 Mind Map tools.${c.reset}`);
}
