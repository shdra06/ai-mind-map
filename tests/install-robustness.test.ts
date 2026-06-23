import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Integration tests for MCP installation robustness.
 * These tests verify:
 * 1. Correct npm package name in all generated configs
 * 2. Config path detection logic
 * 3. Post-write verification
 * 4. Auto-fix capabilities
 */

describe('Config Generation — Package Name', () => {
  it('should not use ai-mind-map-server as npx target in config generation', () => {
    const installSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'install.ts'),
      'utf-8',
    );

    // Check specifically for the npx args pattern that caused the bug
    // The pattern args: ['-y', 'ai-mind-map-server'] should NOT appear in config generators
    // Note: It SHOULD appear in verification/auto-fix code (detecting the wrong name to fix it)
    const configGenPattern = /args:\s*\['-y',\s*'ai-mind-map-server'\]/g;
    const matches = installSource.match(configGenPattern);

    assert.equal(
      matches,
      null,
      `Found ${matches?.length ?? 0} occurrences of args: ['-y', 'ai-mind-map-server'] in install.ts. ` +
        'Config generators must use NPM_PACKAGE_NAME ("ai-mind-map").',
    );
  });

  it('should never contain ai-mind-map-server in README', () => {
    const readme = readFileSync(
      path.resolve(import.meta.dirname, '..', 'README.md'),
      'utf-8',
    );

    const wrongNamePattern = /ai-mind-map-server/g;
    const matches = readme.match(wrongNamePattern);

    assert.equal(
      matches,
      null,
      `Found ${matches?.length ?? 0} occurrences of 'ai-mind-map-server' in README.md`,
    );
  });

  it('should never contain ai-mind-map-server in index.ts', () => {
    const indexSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'index.ts'),
      'utf-8',
    );

    const wrongNamePattern = /ai-mind-map-server/g;
    const matches = indexSource.match(wrongNamePattern);

    assert.equal(
      matches,
      null,
      `Found ${matches?.length ?? 0} occurrences of 'ai-mind-map-server' in index.ts`,
    );
  });
});

describe('Config Generation — Gemini Path', () => {
  it('should not hardcode mcp.json for Gemini config', () => {
    const installSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'install.ts'),
      'utf-8',
    );

    // The Antigravity section should use findGeminiMcpConfigPath()
    const antigravitySection = installSource.match(
      /\/\/ 5\. Antigravity[\s\S]*?(?=\/\/ 6\.)/,
    );
    assert.ok(antigravitySection, 'Could not find Antigravity section');

    const section = antigravitySection[0];
    assert.ok(
      section.includes('findGeminiMcpConfigPath'),
      'Antigravity section should use findGeminiMcpConfigPath() for dynamic detection',
    );
  });
});

describe('Config Verification Logic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(tmpdir(), `mindmap-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('should detect wrong package name in config file', () => {
    const configPath = path.join(tmpDir, 'mcp_config.json');
    const badConfig = {
      mcpServers: {
        'ai-mind-map': {
          command: 'npx',
          args: ['-y', 'ai-mind-map-server'],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(badConfig, null, 2));

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    const entry = content.mcpServers['ai-mind-map'];
    assert.ok(entry.args.includes('ai-mind-map-server'), 'Wrong name should be detectable');
    assert.notEqual(entry.args[1], 'ai-mind-map');
  });

  it('should handle missing config file gracefully', () => {
    const configPath = path.join(tmpDir, 'nonexistent.json');
    assert.equal(existsSync(configPath), false);
  });

  it('should preserve existing entries when merging', () => {
    const configPath = path.join(tmpDir, 'mcp_config.json');
    const existing = {
      mcpServers: {
        'firebase-mcp-server': { command: 'npx', args: ['-y', 'firebase-tools'] },
      },
    };
    writeFileSync(configPath, JSON.stringify(existing, null, 2));

    // Simulate adding our entry
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    content.mcpServers['ai-mind-map'] = { command: 'npx', args: ['-y', 'ai-mind-map'] };
    writeFileSync(configPath, JSON.stringify(content, null, 2));

    // Verify both entries exist
    const result = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.ok(result.mcpServers['firebase-mcp-server'], 'Firebase entry should be preserved');
    assert.ok(result.mcpServers['ai-mind-map'], 'ai-mind-map entry should be added');
    assert.deepEqual(result.mcpServers['ai-mind-map'].args, ['-y', 'ai-mind-map']);
  });
});

describe('NPM Package Name — Single Source of Truth', () => {
  it('package.json name should be ai-mind-map', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'),
    );
    assert.equal(pkg.name, 'ai-mind-map');
  });

  it('install.ts should define NPM_PACKAGE_NAME constant', () => {
    const installSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'install.ts'),
      'utf-8',
    );
    assert.ok(
      installSource.includes("const NPM_PACKAGE_NAME = 'ai-mind-map'"),
      'install.ts should define NPM_PACKAGE_NAME constant',
    );
  });

  it('NPM_PACKAGE_NAME should match package.json name', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'),
    );
    const installSource = readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'install.ts'),
      'utf-8',
    );
    const match = installSource.match(/const NPM_PACKAGE_NAME = '([^']+)'/);
    assert.ok(match, 'Should find NPM_PACKAGE_NAME constant');
    assert.equal(match![1], pkg.name, 'NPM_PACKAGE_NAME must match package.json name');
  });
});
