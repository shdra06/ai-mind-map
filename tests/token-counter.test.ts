/**
 * Tests for the token counter utility.
 *
 * Validates the heuristic token estimator, multi-string counting,
 * smart truncation, and budget-checking functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  estimateTokens,
  estimateTokensMany,
  truncateToTokenBudget,
  fitsWithinBudget,
} from '../src/utils/token-counter.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    assert.strictEqual(estimateTokens(''), 0);
  });

  it('returns 0 for null/undefined coerced to empty', () => {
    // The function guards with `if (!text)`, so falsy values → 0
    assert.strictEqual(estimateTokens(null as unknown as string), 0);
    assert.strictEqual(estimateTokens(undefined as unknown as string), 0);
  });

  it('returns 1 for very short strings (≤4 chars)', () => {
    assert.strictEqual(estimateTokens('hi'), 1);
    assert.strictEqual(estimateTokens('ok'), 1);
    assert.strictEqual(estimateTokens('abcd'), 1);
  });

  it('counts simple English words', () => {
    const tokens = estimateTokens('hello world foo bar');
    // 4 words × 1.3 ≈ 5-6
    assert.ok(tokens >= 4, `Expected ≥4, got ${tokens}`);
    assert.ok(tokens <= 10, `Expected ≤10, got ${tokens}`);
  });

  it('handles Unicode characters', () => {
    const tokens = estimateTokens('你好世界 こんにちは мир');
    assert.ok(tokens >= 1, `Expected ≥1, got ${tokens}`);
    // Unicode chars add extra cost
    assert.ok(tokens > estimateTokens('hello world foo'), 'Unicode should cost more tokens');
  });

  it('handles code with special characters', () => {
    const code = 'function foo(a: string, b: number): boolean { return a.length > b; }';
    const tokens = estimateTokens(code);
    // Code has many punctuation → higher count
    assert.ok(tokens >= 10, `Expected ≥10 for code, got ${tokens}`);
    assert.ok(tokens <= 50, `Expected ≤50 for code, got ${tokens}`);
  });

  it('handles very long strings', () => {
    const longText = 'word '.repeat(10000);
    const tokens = estimateTokens(longText);
    assert.ok(tokens >= 5000, `Expected ≥5000 for 10K words, got ${tokens}`);
    assert.ok(tokens <= 20000, `Expected ≤20000 for 10K words, got ${tokens}`);
  });

  it('handles strings with only whitespace', () => {
    // All whitespace, no regex matches → 0
    const tokens = estimateTokens('     \t\t\n\n  ');
    assert.strictEqual(tokens, 0);
  });
});

describe('estimateTokensMany', () => {
  it('sums token counts across multiple strings', () => {
    const total = estimateTokensMany(['hello world', 'foo bar baz']);
    const individual = estimateTokens('hello world') + estimateTokens('foo bar baz');
    assert.strictEqual(total, individual);
  });

  it('returns 0 for empty array', () => {
    assert.strictEqual(estimateTokensMany([]), 0);
  });
});

describe('truncateToTokenBudget', () => {
  it('returns the original text if within budget', () => {
    const text = 'hello world';
    const result = truncateToTokenBudget(text, 100);
    assert.strictEqual(result, text);
  });

  it('truncates text exceeding budget', () => {
    const text = 'word '.repeat(1000);
    const result = truncateToTokenBudget(text, 10);
    assert.ok(result.includes('[truncated]'), 'Should include truncation marker');
    assert.ok(
      estimateTokens(result) <= 15,
      `Truncated text should be close to budget, got ${estimateTokens(result)} tokens`,
    );
  });

  it('returns suffix only for zero budget', () => {
    const result = truncateToTokenBudget('hello world', 0);
    assert.strictEqual(result, '\n... [truncated]');
  });

  it('tries to cut at logical boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph that is much longer and goes on and on.';
    const result = truncateToTokenBudget(text, 15);
    // Should prefer cutting at paragraph boundary
    assert.ok(result.includes('[truncated]'));
  });

  it('supports custom suffix', () => {
    const text = 'word '.repeat(500);
    const result = truncateToTokenBudget(text, 10, ' [...]');
    assert.ok(result.includes('[...]'));
  });
});

describe('fitsWithinBudget', () => {
  it('returns true for text within budget', () => {
    assert.strictEqual(fitsWithinBudget('hello', 100), true);
  });

  it('returns false for text exceeding budget', () => {
    const longText = 'word '.repeat(10000);
    assert.strictEqual(fitsWithinBudget(longText, 5), false);
  });
});
