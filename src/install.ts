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
import { fileURLToPath } from 'node:url';
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
 * Resolve how to run the MCP server.
 *
 * Returns either:
 * - { mode: 'npx' }                — use `npx ai-mind-map` (stable, no hardcoded path)
 * - { mode: 'global', path: ... }  — globally installed, use absolute path to dist/index.js
 * - { mode: 'local', path: ... }   — git clone, use absolute path to dist/index.js
 */
function getServerRunConfig(): { mode: 'npx' | 'global' | 'local'; path?: string } {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  // Detect if we're running from npx cache (temporary, unstable path)
  const isNpxCache = thisDir.includes('npm-cache') && thisDir.includes('_npx');

  if (isNpxCache) {
    // npx cache paths are temporary — use `npx` command instead
    return { mode: 'npx' };
  }

  // Check if globally installed (inside a global npm prefix)
  try {
    const globalPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    if (thisDir.startsWith(globalPrefix)) {
      const distIndex = path.resolve(thisDir, '..', 'dist', 'index.js');
      if (existsSync(distIndex)) return { mode: 'global', path: distIndex };
      const distSelf = path.resolve(thisDir, 'index.js');
      if (existsSync(distSelf)) return { mode: 'global', path: distSelf };
    }
  } catch {
    // npm not available, fall through
  }

  // Local clone: use absolute path
  const distIndex = path.resolve(thisDir, '..', 'dist', 'index.js');
  if (existsSync(distIndex)) return { mode: 'local', path: distIndex };

  const distSelf = path.resolve(thisDir, 'index.js');
  if (existsSync(distSelf)) return { mode: 'local', path: distSelf };

  return { mode: 'local', path: path.resolve(thisDir, '..', 'dist', 'index.js') };
}

/** For backward compat — returns the resolved path or npx command */
function getServerEntryPath(): string {
  const config = getServerRunConfig();
  return config.path ?? 'npx-mode';
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

/** Generate the standard MCP server config object based on install mode */
function mcpServerEntry(serverEntry: string): Record<string, unknown> {
  const runConfig = getServerRunConfig();

  if (runConfig.mode === 'npx') {
    // npx mode: use npx command so config survives cache clears
    return {
      'ai-mind-map': {
        command: 'npx',
        args: ['-y', NPM_PACKAGE_NAME],
        env: {},
      },
    };
  }

  // Global or local install: use absolute path (stable)
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

// ============================================================
// Robustness: Dynamic Config Path Detection
// ============================================================

/** The npm package name — single source of truth to prevent wrong-name bugs */
const NPM_PACKAGE_NAME = 'ai-mind-map';

/**
 * Dynamically find the correct MCP config file for Gemini/Antigravity.
 * Scans candidate files and uses whichever already has mcpServers defined.
 * Falls back to mcp_config.json (Gemini's primary config file).
 */
function findGeminiMcpConfigPath(): string {
  const configDir = path.join(HOME, '.gemini', 'config');
  // Order matters: prefer mcp_config.json (Gemini's primary), then mcp.json
  const candidates = ['mcp_config.json', 'mcp.json'];

  for (const file of candidates) {
    const filePath = path.join(configDir, file);
    const content = readJsonFile(filePath);
    if (content?.mcpServers && typeof content.mcpServers === 'object') {
      return filePath;
    }
  }

  // Default to mcp_config.json (confirmed working with Firebase/SpriteAI)
  return path.join(configDir, 'mcp_config.json');
}

/**
 * Dynamically find the MCP config file for VS Code / Copilot.
 * VS Code may store MCP config in settings.json or a dedicated mcp.json.
 */
function findVSCodeMcpConfigPath(): string {
  const settingsDir = getVSCodeSettingsDir();
  // Check for dedicated mcp.json first, then settings.json
  const candidates = [
    path.join(settingsDir, 'mcp.json'),
    path.join(settingsDir, 'settings.json'),
  ];

  for (const filePath of candidates) {
    const content = readJsonFile(filePath);
    if (content?.['mcp.servers'] && typeof content['mcp.servers'] === 'object') {
      return filePath;
    }
  }

  return path.join(settingsDir, 'settings.json');
}

// ============================================================
// Robustness: Post-Write Verification
// ============================================================

interface VerifyResult {
  ok: boolean;
  error?: string;
  autoFixed?: boolean;
}

/**
 * Verify that a config file was written correctly after install.
 * Checks: file exists, entry exists under correct key, package name is correct.
 */
function verifyConfigEntry(configPath: string, mcpKey: string): VerifyResult {
  // 1. Can we read the file?
  const config = readJsonFile(configPath);
  if (!config) {
    return { ok: false, error: `Config file not readable: ${configPath}` };
  }

  // 2. Does our key exist?
  const servers = config[mcpKey] as Record<string, unknown> | undefined;
  if (!servers || !servers['ai-mind-map']) {
    return { ok: false, error: `Entry 'ai-mind-map' not found under '${mcpKey}' in ${configPath}` };
  }

  // 3. Is the package name correct?
  const entry = servers['ai-mind-map'] as Record<string, unknown>;
  const args = entry.args as string[] | undefined;
  if (args && args.includes('ai-mind-map-server')) {
    return { ok: false, error: `Wrong package name 'ai-mind-map-server' in args (should be '${NPM_PACKAGE_NAME}')` };
  }

  // 4. Is the command valid?
  const command = entry.command as string | undefined;
  if (!command || (command !== 'npx' && command !== 'node')) {
    return { ok: false, error: `Invalid command '${command}' (expected 'npx' or 'node')` };
  }

  return { ok: true };
}

/**
 * Auto-fix common config problems in a config file.
 * Returns true if any fixes were applied.
 */
function autoFixConfig(configPath: string, mcpKey: string): VerifyResult {
  const config = readJsonFile(configPath);
  if (!config) return { ok: false, error: 'Cannot read config file' };

  const servers = config[mcpKey] as Record<string, unknown> | undefined;
  if (!servers || !servers['ai-mind-map']) return { ok: true }; // nothing to fix

  const entry = servers['ai-mind-map'] as Record<string, unknown>;
  let fixed = false;

  // Fix 1: Wrong package name
  const args = entry.args as string[] | undefined;
  if (args) {
    const idx = args.indexOf('ai-mind-map-server');
    if (idx !== -1) {
      args[idx] = NPM_PACKAGE_NAME;
      entry.args = args;
      fixed = true;
    }
  }

  // Fix 2: Add version metadata
  if (!entry._version) {
    entry._version = getPackageVersion();
    entry._installedAt = new Date().toISOString();
    fixed = true;
  }

  if (fixed) {
    servers['ai-mind-map'] = entry;
    config[mcpKey] = servers;
    writeJsonFile(configPath, config);
  }

  return { ok: true, autoFixed: fixed };
}

/** Get the current package version */
function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ============================================================
// Robustness: Server Smoke Test
// ============================================================

/**
 * Spawn the MCP server as a child process and verify it responds correctly.
 * Returns diagnostic info about the server's health.
 */
async function smokeTestServer(): Promise<{
  ok: boolean;
  serverStarts: boolean;
  toolCount: number;
  hasInstructions: boolean;
  error?: string;
}> {
  const result = { ok: false, serverStarts: false, toolCount: 0, hasInstructions: false, error: '' };

  try {
    const runConfig = getServerRunConfig();
    let cmd: string;
    let args: string[];

    if (runConfig.mode === 'npx') {
      cmd = IS_WIN ? 'npx.cmd' : 'npx';
      args = ['-y', NPM_PACKAGE_NAME];
    } else {
      cmd = 'node';
      args = [runConfig.path!];
    }

    // We'll try to spawn the server with a timeout
    const { spawn } = await import('node:child_process');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        result.error = 'Server did not respond within 10 seconds';
        resolve(result);
      }, 10_000);

      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MINDMAP_PROJECT_ROOT: process.cwd() },
      });

      let stdout = '';

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        const line = data.toString();
        // Server logs to stderr via MCP protocol
        if (line.includes('MCP tools registered') || line.includes('tools registered')) {
          result.serverStarts = true;
        }
        if (line.includes('instructions')) {
          result.hasInstructions = true;
        }
      });

      // Send initialize request via stdin (MCP JSON-RPC over stdio)
      const initRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0.0' },
        },
      });

      child.stdin.write(initRequest + '\n');

      // Give it a moment then send tools/list
      setTimeout(() => {
        const toolsRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });
        child.stdin.write(toolsRequest + '\n');
      }, 2000);

      // After 5 seconds, check what we got
      setTimeout(() => {
        clearTimeout(timeout);
        child.kill();

        // Try to parse responses from stdout
        try {
          const lines = stdout.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1 && msg.result) {
                result.serverStarts = true;
                if (msg.result.instructions) {
                  result.hasInstructions = true;
                }
              }
              if (msg.id === 2 && msg.result?.tools) {
                result.toolCount = msg.result.tools.length;
              }
            } catch {
              // skip unparseable lines
            }
          }
        } catch {
          // parsing failed
        }

        result.ok = result.serverStarts;
        resolve(result);
      }, 5000);

      child.on('error', (err) => {
        clearTimeout(timeout);
        result.error = `Failed to start: ${err.message}`;
        resolve(result);
      });
    });
  } catch (err) {
    result.error = `Smoke test error: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
}

// ============================================================
// Robustness: Misconfig Detection & Migration
// ============================================================

/**
 * Check for common misconfigurations and return diagnostics.
 * Called by `doctor` to detect problems.
 */
function detectMisconfigs(): Array<{ agent: string; problem: string; fix: string; fixFn?: () => void }> {
  const issues: Array<{ agent: string; problem: string; fix: string; fixFn?: () => void }> = [];

  // Check 1: Gemini config in wrong file (mcp.json instead of mcp_config.json)
  const geminiWrongFile = path.join(HOME, '.gemini', 'config', 'mcp.json');
  const geminiRightFile = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
  const wrongConfig = readJsonFile(geminiWrongFile);
  if (wrongConfig?.mcpServers) {
    const servers = wrongConfig.mcpServers as Record<string, unknown>;
    if (servers['ai-mind-map']) {
      const rightConfig = readJsonFile(geminiRightFile);
      const rightServers = (rightConfig?.mcpServers as Record<string, unknown>) ?? {};
      if (!rightServers['ai-mind-map']) {
        issues.push({
          agent: 'Antigravity (Gemini)',
          problem: `Config in mcp.json but Gemini reads mcp_config.json`,
          fix: 'Move entry to mcp_config.json',
          fixFn: () => {
            // Copy entry to correct file
            const config = readJsonFile(geminiRightFile) ?? { mcpServers: {} };
            const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
            mcpServers['ai-mind-map'] = servers['ai-mind-map'];
            config.mcpServers = mcpServers;
            writeJsonFile(geminiRightFile, config);
            // Remove from wrong file
            delete servers['ai-mind-map'];
            if (Object.keys(servers).length === 0) delete wrongConfig.mcpServers;
            writeJsonFile(geminiWrongFile, wrongConfig);
          },
        });
      }
    }
  }

  // Check 2: Wrong package name in any config
  const configsToCheck = [
    { agent: 'Claude Code', path: path.join(HOME, '.claude', 'claude_desktop_config.json'), key: 'mcpServers' },
    { agent: 'Cursor', path: path.join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
    { agent: 'Antigravity', path: geminiRightFile, key: 'mcpServers' },
    { agent: 'VS Code', path: path.join(getVSCodeSettingsDir(), 'settings.json'), key: 'mcp.servers' },
  ];

  for (const check of configsToCheck) {
    const content = readJsonFile(check.path);
    if (!content) continue;
    const servers = content[check.key] as Record<string, unknown> | undefined;
    if (!servers?.['ai-mind-map']) continue;
    const entry = servers['ai-mind-map'] as Record<string, unknown>;
    const args = entry.args as string[] | undefined;
    if (args?.includes('ai-mind-map-server')) {
      issues.push({
        agent: check.agent,
        problem: `Wrong package name 'ai-mind-map-server' in args`,
        fix: `Change to '${NPM_PACKAGE_NAME}'`,
        fixFn: () => {
          const idx = args.indexOf('ai-mind-map-server');
          if (idx !== -1) args[idx] = NPM_PACKAGE_NAME;
          entry.args = args;
          servers['ai-mind-map'] = entry;
          content[check.key] = servers;
          writeJsonFile(check.path, content);
        },
      });
    }
  }

  // Check 3: Outdated version metadata
  for (const check of configsToCheck) {
    const content = readJsonFile(check.path);
    if (!content) continue;
    const servers = content[check.key] as Record<string, unknown> | undefined;
    if (!servers?.['ai-mind-map']) continue;
    const entry = servers['ai-mind-map'] as Record<string, unknown>;
    const configVersion = entry._version as string | undefined;
    const currentVersion = getPackageVersion();
    if (configVersion && configVersion !== currentVersion && currentVersion !== '0.0.0') {
      issues.push({
        agent: check.agent,
        problem: `Config version ${configVersion} is outdated (current: ${currentVersion})`,
        fix: 'Update version metadata',
        fixFn: () => {
          entry._version = currentVersion;
          entry._installedAt = new Date().toISOString();
          servers['ai-mind-map'] = entry;
          content[check.key] = servers;
          writeJsonFile(check.path, content);
        },
      });
    }
  }

  return issues;
}

/**
 * Merge an MCP server entry into an existing JSON config.
 * Creates the file if it doesn't exist.
 *
 * @param configPath   - Path to the config file
 * @param mcpKey       - The JSON key under which MCP servers live (e.g., "mcpServers")
 * @param serverEntry  - Path to the server executable (unused in npx mode)
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

  const runConfig = getServerRunConfig();

  if (runConfig.mode === 'npx') {
    servers['ai-mind-map'] = {
      command: 'npx',
      args: ['-y', NPM_PACKAGE_NAME],
      env: {},
    };
  } else {
    servers['ai-mind-map'] = {
      command: 'node',
      args: [serverEntry],
      env: {},
    };
  }

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
        const runConfig = getServerRunConfig();
        mcpServers['ai-mind-map'] = runConfig.mode === 'npx'
          ? { command: 'npx', args: ['-y', NPM_PACKAGE_NAME], env: {} }
          : { command: 'node', args: [serverEntry], env: {} };
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
        const runConfig = getServerRunConfig();
        mcpServers['ai-mind-map'] = runConfig.mode === 'npx'
          ? { command: 'npx', args: ['-y', NPM_PACKAGE_NAME], env: {} }
          : { command: 'node', args: [serverEntry], env: {} };
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
    // Gemini reads MCP servers from mcp_config.json (not mcp.json)
    {
      name: 'Antigravity (Gemini)',
      id: 'antigravity',
      probePaths: [
        path.join(HOME, '.gemini', 'config'),
        path.join(HOME, '.gemini'),
      ],
      configPath: findGeminiMcpConfigPath(),
      generateConfig: () => JSON.stringify({ mcpServers: mcpServerEntry(serverEntry) }, null, 2),
      isConfigured: () => hasMcpConfig(
        findGeminiMcpConfigPath(),
        'mcpServers',
      ),
      removeConfig: () => removeMcpConfig(
        findGeminiMcpConfigPath(),
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
        const runConfig = getServerRunConfig();
        const serverConfig = runConfig.mode === 'npx'
          ? { path: 'npx', args: ['-y', NPM_PACKAGE_NAME], env: {} }
          : { path: 'node', args: [serverEntry], env: {} };
        contextServers['ai-mind-map'] = {
          command: serverConfig,
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
          const runConfig = getServerRunConfig();
          const serverEntryConfig = runConfig.mode === 'npx'
            ? { command: 'npx', args: ['-y', NPM_PACKAGE_NAME], env: {} }
            : { command: 'node', args: [serverEntry], env: {} };

          modelContextProtocolServers.push({
            name: 'ai-mind-map',
            ...serverEntryConfig,
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
  let verifyFailCount = 0;

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
      // Still verify existing config is correct
      const mcpKey = ['claude-code', 'cursor', 'antigravity'].includes(agent.id) ? 'mcpServers' : 'mcp.servers';
      const verifyResult = verifyConfigEntry(agent.configPath, mcpKey);
      if (!verifyResult.ok) {
        console.log(`    ${c.yellow}⚠${c.reset} ${c.dim}Verification issue: ${verifyResult.error}${c.reset}`);
        const fixResult = autoFixConfig(agent.configPath, mcpKey);
        if (fixResult.autoFixed) {
          console.log(`    ${c.green}✔${c.reset} ${c.dim}Auto-fixed!${c.reset}`);
        }
      }
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

      // ── Post-write verification ──
      const mcpKey = ['claude-code', 'cursor', 'antigravity'].includes(agent.id) ? 'mcpServers' : 'mcp.servers';
      const verifyResult = verifyConfigEntry(agent.configPath, mcpKey);
      if (verifyResult.ok) {
        logConfigured(agent.name);
        console.log(`    ${c.green}✔${c.reset} ${c.dim}Verified: config entry is correct${c.reset}`);
      } else {
        logConfigured(agent.name);
        console.log(`    ${c.yellow}⚠${c.reset} ${c.dim}Verify warning: ${verifyResult.error}${c.reset}`);
        // Attempt auto-fix
        const fixResult = autoFixConfig(agent.configPath, mcpKey);
        if (fixResult.autoFixed) {
          console.log(`    ${c.green}✔${c.reset} ${c.dim}Auto-fixed!${c.reset}`);
        } else {
          verifyFailCount++;
        }
      }
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
    if (verifyFailCount > 0) {
      logWarn(`${verifyFailCount} config(s) have verification warnings — run "ai-mind-map doctor --fix" to repair.`);
    }
  }

  // Check for misconfigurations from older versions
  const misconfigs = detectMisconfigs();
  if (misconfigs.length > 0) {
    console.log('');
    heading('⚠️ Misconfigurations Detected');
    divider();
    for (const issue of misconfigs) {
      console.log(`  ${c.yellow}⚠${c.reset} ${c.bold}${issue.agent}${c.reset}: ${issue.problem}`);
      if (issue.fixFn) {
        issue.fixFn();
        console.log(`    ${c.green}✔${c.reset} AUTO-FIXED: ${issue.fix}`);
      } else {
        console.log(`    ${c.dim}Fix: ${issue.fix}${c.reset}`);
      }
    }
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
    path.dirname(fileURLToPath(import.meta.url)),
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

  // 8. Misconfig detection
  const misconfigs = detectMisconfigs();
  if (misconfigs.length > 0) {
    console.log('');
    heading('⚠️ Configuration Issues Found');
    divider();

    const shouldFix = process.argv.includes('--fix');

    for (const issue of misconfigs) {
      results.push({
        name: `Config: ${issue.agent}`,
        status: 'warn',
        message: issue.problem,
      });

      console.log(`  ${c.yellow}⚠${c.reset} ${c.bold}${issue.agent}${c.reset}: ${issue.problem}`);

      if (shouldFix && issue.fixFn) {
        issue.fixFn();
        console.log(`    ${c.green}✔${c.reset} AUTO-FIXED: ${issue.fix}`);
      } else if (issue.fixFn) {
        console.log(`    ${c.dim}Run with --fix to auto-repair: ${issue.fix}${c.reset}`);
      } else {
        console.log(`    ${c.dim}Manual fix required: ${issue.fix}${c.reset}`);
      }
    }
  } else {
    results.push({
      name: 'Config Integrity',
      status: 'ok',
      message: 'No misconfigurations detected',
    });
  }

  // Re-print summary with updated results
  const finalOk = results.filter((r) => r.status === 'ok').length;
  const finalWarn = results.filter((r) => r.status === 'warn').length;
  const finalFail = results.filter((r) => r.status === 'fail').length;

  console.log('');
  divider();

  if (finalFail > 0) {
    logFail(`${finalOk} passed, ${finalWarn} warnings, ${finalFail} failures`);
    logInfo('Fix the failures above before using AI Mind Map.');
  } else if (finalWarn > 0) {
    logWarn(`${finalOk} passed, ${finalWarn} warnings`);
    if (!process.argv.includes('--fix')) {
      logInfo('Run "ai-mind-map doctor --fix" to auto-repair warnings.');
    }
  } else {
    logOk(`All ${finalOk} checks passed!`);
    logInfo('AI Mind Map is ready to use.');
  }

  console.log('');
}

// ============================================================
// Rules File Deployment
// ============================================================

/** The core rules content that teaches AI agents about our tools */
function getToolAwarenessRules(): string {
  return `# AI Mind Map MCP — Code Memory Engine (v1.4.0)

You have the AI Mind Map MCP server connected. It is a persistent code memory system that eliminates redundant file re-reading and context loss between sessions.

## 🚀 Recommended Tool Usage
To get context on a new project or resume a previous task, call \`mindmap_session_resume\`. It returns:
- What the previous AI agent worked on
- What code changed since then (function-level diffs, not just file names)
- Project structure + tech stack
- Hot files (most frequently modified)

This ONE call replaces reading 10+ files (~2000 tokens instead of 50,000+).

## Quick Lookup: "I need to..." → Use this tool

### ⚡ Session Lifecycle (always use these)
- Resume from last session → \`mindmap_session_resume\` ⭐⭐ (THE first call)
- Start tracking a new task → \`mindmap_session_start\`
- End session, save summary → \`mindmap_session_end\`

### 🔍 Find Code (instead of grep/reading files)
- Search by name → \`mindmap_smart_search\` ⭐ (returns full context)
- Search by concept → \`mindmap_semantic_search\` ⭐ ("authentication", "error handling")
- Grep text in code → \`mindmap_search_code\`
- Who calls X? → \`mindmap_trace_dependencies\`
- All usages of symbol → \`mindmap_find_references\`

### 📖 Read Code (without reading full files)
- Everything about a symbol → \`mindmap_explain\` ⭐ (signature + callers + callees + doc in ONE call)
- Read actual source code → \`mindmap_get_code_snippet\`
- Understand file without reading → \`mindmap_file_digest\` ⭐ (saves 3-10K tokens/file)
- All symbols in a file → \`mindmap_get_file_map\`
- Just the signature → \`mindmap_get_signature\` (cheapest read)

### 📊 Understand the Project
- Full project summary → \`mindmap_digest\` ⭐ (<2000 tokens)
- Architecture overview → \`mindmap_architecture\`
- Full project map → \`mindmap_project_map\`
- Layer overview → \`mindmap_layer_overview\`

### 🔄 Change Tracking
- Symbol-level diffs → \`mindmap_changelog\` ⭐ (added/modified/deleted functions)
- Git-aware changes → \`mindmap_git_changes\` (maps diffs to symbols)
- Check if cached code is valid → \`mindmap_verify\` ⭐ (hash check, no re-reading)
- Most changed files → \`mindmap_hotspots\`
- What changed recently? → \`mindmap_what_changed\`
- Changes since last session → \`mindmap_session_diff\`

### 🐛 Debug & Investigate
- Something broke → \`mindmap_debug_changes\` (shows actual git diffs)
- File before changes → \`mindmap_file_before\`
- Blast radius → \`mindmap_impact_analysis\`
- File commit history → \`mindmap_file_history\`

### 🧠 Memory & Decisions (persists across sessions)
- Remember a fact → \`mindmap_remember\`
- Recall past knowledge → \`mindmap_recall\`
- Record a decision → \`mindmap_decide\`
- View decisions → \`mindmap_get_decisions\`
- Session summary → \`mindmap_session_summary\`

### 🔬 Flow & Architecture
- Trace a feature flow → \`mindmap_trace_flow\`
- All routes/events/components → \`mindmap_interaction_map\`
- What layer is this file? → \`mindmap_classify_file\`

### 🧬 Self-Evolving (teach the system new patterns)
- Teach a pattern → \`mindmap_teach\` (persists per-project)
- View learned rules → \`mindmap_get_learned\`
- Remove a rule → \`mindmap_forget\`

### 🛠️ Advanced
- Cypher graph query → \`mindmap_query_graph\`
- Find dead code → \`mindmap_dead_code\`
- Compress logs/output → \`mindmap_compress\`
- Force re-index → \`mindmap_reindex\`
- System health → \`mindmap_health\`

## ⚡ Token-Saving Rules
1. Consider calling \`mindmap_session_resume\` to get context without reading files
2. PREFER \`mindmap_explain\` over reading files — it gives everything in 1 call
3. Use \`mindmap_file_digest\` BEFORE reading a full file — you may not need the full file
4. Use \`mindmap_verify\` to check if cached code is still valid — avoid re-reading
5. Use \`mindmap_changelog\` instead of re-reading files to see what changed
6. Use \`mindmap_smart_search\` over \`mindmap_search\` — it returns full context
7. Use \`mindmap_git_changes\` instead of running \`git diff\` — it maps diffs to symbols
8. Call \`mindmap_session_end\` when done — save context for next session
9. Use \`mindmap_remember\` for learnings, \`mindmap_decide\` for architecture choices
10. If Mind Map returns unexpected results, the index may be stale — run \`mindmap_reindex\`

## When to READ FILES DIRECTLY
- Complex algorithm logic that signatures can't capture
- Reading comments, TODOs, inline docs
- Small config files (faster to just read them)
- Dynamic dispatch, DI, or event-driven code
- When Mind Map returns "not found" but you suspect the code exists (stale index)
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

  // Skip deployment if not explicitly requested and CWD is not a project root (no .git or package.json)
  if (!projectRoot) {
    const hasGit = existsSync(path.join(root, '.git'));
    const hasPkg = existsSync(path.join(root, 'package.json'));
    if (!hasGit && !hasPkg) {
      heading('📋 Deploying AI Agent Rules Files');
      console.log(`  ${c.gray}ℹ${c.reset} Current directory is not a project root (no .git or package.json found).`);
      console.log(`    Skipping automatic rules files deployment to prevent home directory clutter.`);
      console.log(`    To deploy rules, run this command inside your project repository.`);
      return;
    }
  }

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
  console.log(`  ${c.dim}These files teach each AI agent about Mind Map\'s 41 tools${c.reset}`);
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
  console.log(`  ${c.dim}Each AI agent will now know about all 41 Mind Map tools.${c.reset}`);
}
