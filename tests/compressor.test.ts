/**
 * Tests for the content-aware compressor.
 *
 * Validates that different content types are correctly auto-detected,
 * that all three compression levels work, and that compression actually
 * reduces the token count.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  compress,
  detectContentType,
} from '../src/context/compressor.js';
import type { CompressionResult } from '../src/context/compressor.js';

// ── Fixtures ─────────────────────────────────────────────────

const SOURCE_CODE = `
import { Router } from 'express';

/**
 * Handle user authentication.
 * Validates credentials and issues JWT tokens.
 */
export async function authenticateUser(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const user = await findUserByEmail(email);
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const token = jwt.sign({ userId: user.id }, SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name } });
}

export function validateEmail(email: string): boolean {
  return /^[^@]+@[^@]+\\.[^@]+$/.test(email);
}
`;

const BUILD_LOG = `
[10:30:15] Starting compilation...
[10:30:16] warning: unused variable 'x' in src/utils.ts:42
[10:30:16] warning: missing return type in src/api.ts:15
[10:30:17] error: TS2345: Argument of type 'string' is not assignable to parameter of type 'number'
[10:30:17] error: TS7006: Parameter 'req' implicitly has an 'any' type.
[10:30:18] info: Processing 142 files...
[10:30:19] info: Processing 142 files... done
[10:30:20] BUILD FAILED
2 errors, 2 warnings
`;

const STACK_TRACE = `
Error: Connection refused
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)
    at Socket._finishInit (node:net:320:8)
    at Object.connect (node:net:375:10)
    at /app/src/database/pool.ts:42:15
    at /app/src/services/user-service.ts:18:22
    at /app/node_modules/express/lib/router/layer.js:95:5
    at /app/node_modules/express/lib/router/route.js:144:13
    at /app/node_modules/express/lib/router/index.js:284:7
`;

const JSON_DATA = JSON.stringify({
  users: [
    { id: 1, name: 'Alice', email: 'alice@example.com', roles: ['admin'] },
    { id: 2, name: 'Bob', email: 'bob@example.com', roles: ['user'] },
    { id: 3, name: 'Charlie', email: 'charlie@example.com', roles: ['user', 'editor'] },
    { id: 4, name: 'Diana', email: 'diana@example.com', roles: ['user'] },
    { id: 5, name: 'Eve', email: 'eve@example.com', roles: ['admin', 'user'] },
  ],
  pagination: { page: 1, total: 100, perPage: 5 },
  metadata: { generatedAt: '2024-01-01T00:00:00Z', version: '2.0' },
}, null, 2);

// ── Tests ────────────────────────────────────────────────────

describe('detectContentType', () => {
  it('detects source code', () => {
    assert.strictEqual(detectContentType(SOURCE_CODE), 'source_code');
  });

  it('detects build logs', () => {
    assert.strictEqual(detectContentType(BUILD_LOG), 'build_log');
  });

  it('detects stack traces', () => {
    assert.strictEqual(detectContentType(STACK_TRACE), 'stack_trace');
  });

  it('detects JSON data', () => {
    assert.strictEqual(detectContentType(JSON_DATA), 'json_data');
  });

  it('detects diffs', () => {
    const diff = 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n+added line\n existing';
    assert.strictEqual(detectContentType(diff), 'diff');
  });

  it('detects markdown', () => {
    const md = '# Title\n\nSome text\n\n## Subtitle\n\n- item 1\n- item 2';
    assert.strictEqual(detectContentType(md), 'markdown');
  });

  it('returns plain_text for empty input', () => {
    assert.strictEqual(detectContentType(''), 'plain_text');
    assert.strictEqual(detectContentType('  \n  '), 'plain_text');
  });

  it('returns plain_text for unrecognized content', () => {
    assert.strictEqual(detectContentType('just some random words here'), 'plain_text');
  });
});

describe('compress — source code', () => {
  it('compresses with moderate level', () => {
    const result = compress(SOURCE_CODE, 'moderate', 'source_code');
    assert.ok(result.compressedTokens < result.originalTokens, 'Should reduce tokens');
    assert.ok(result.ratio > 0, `Expected positive ratio, got ${result.ratio}`);
    assert.ok(result.compressed.includes('authenticateUser'), 'Should keep function name');
  });

  it('compresses aggressively (signatures only)', () => {
    const moderate = compress(SOURCE_CODE, 'moderate', 'source_code');
    const aggressive = compress(SOURCE_CODE, 'aggressive', 'source_code');
    assert.ok(
      aggressive.compressedTokens <= moderate.compressedTokens,
      'Aggressive should be ≤ moderate in tokens',
    );
  });

  it('minimal level does light cleanup', () => {
    const result = compress(SOURCE_CODE, 'minimal', 'source_code');
    // Minimal just trims whitespace — still large
    assert.ok(result.compressedTokens <= result.originalTokens);
    assert.ok(result.compressed.length > 0);
  });
});

describe('compress — build log', () => {
  it('keeps errors and warnings', () => {
    const result = compress(BUILD_LOG, 'moderate', 'build_log');
    assert.ok(result.compressed.includes('error'), 'Should keep errors');
    assert.ok(result.compressed.includes('warning'), 'Should keep warnings at moderate');
  });

  it('aggressive mode keeps only errors', () => {
    const result = compress(BUILD_LOG, 'aggressive', 'build_log');
    assert.ok(result.compressed.includes('error'), 'Should keep errors');
    assert.ok(!result.compressed.includes('warning'), 'Should drop warnings in aggressive');
  });
});

describe('compress — stack trace', () => {
  it('filters out framework frames', () => {
    const result = compress(STACK_TRACE, 'moderate', 'stack_trace');
    // User code frames should be kept
    assert.ok(result.compressed.includes('pool.ts'), 'Should keep user frame pool.ts');
    assert.ok(result.compressed.includes('user-service.ts'), 'Should keep user frame user-service.ts');
    // Framework frames should be collapsed
    assert.ok(result.compressed.includes('framework frames'), 'Should summarize framework frames');
  });
});

describe('compress — JSON', () => {
  it('compresses JSON showing schema', () => {
    const result = compress(JSON_DATA, 'aggressive', 'json_data');
    assert.ok(result.compressedTokens < result.originalTokens, 'Should reduce tokens');
    // Should hint at structure
    assert.ok(result.compressed.includes('users'), 'Should keep top-level keys');
  });

  it('moderate level shows more detail', () => {
    const moderate = compress(JSON_DATA, 'moderate', 'json_data');
    const aggressive = compress(JSON_DATA, 'aggressive', 'json_data');
    assert.ok(moderate.compressedTokens >= aggressive.compressedTokens);
  });
});

describe('compress — ratio is correct', () => {
  it('ratio is between 0 and 1 for non-trivial input', () => {
    const result = compress(SOURCE_CODE, 'aggressive', 'source_code');
    assert.ok(result.ratio >= 0, `Ratio should be ≥0, got ${result.ratio}`);
    assert.ok(result.ratio <= 1, `Ratio should be ≤1, got ${result.ratio}`);
  });

  it('ratio is 0 for empty input', () => {
    const result = compress('', 'moderate');
    assert.strictEqual(result.ratio, 0);
  });
});

describe('compress — auto-detection', () => {
  it('auto-detects content type when not specified', () => {
    const result = compress(SOURCE_CODE, 'moderate');
    assert.strictEqual(result.contentType, 'source_code');
  });

  it('auto-detects build log', () => {
    const result = compress(BUILD_LOG, 'moderate');
    assert.strictEqual(result.contentType, 'build_log');
  });

  it('reports the compression level used', () => {
    const result = compress(SOURCE_CODE, 'aggressive');
    assert.strictEqual(result.level, 'aggressive');
  });
});
