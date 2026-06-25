/**
 * AI Mind Map — Worker Thread for Parallel File Parsing
 *
 * Each worker creates its own tree-sitter Parser instance in a separate
 * V8 isolate, enabling true CPU-level parallelism for AST parsing.
 *
 * Module-level caches (treeSitterParser, loadedGrammars) are automatically
 * isolated per worker, so there are no thread-safety concerns.
 */

import { parentPort } from 'node:worker_threads';
import { parseFile } from './parser.js';
import type { ParseResult } from './parser.js';

if (parentPort) {
  parentPort.on('message', async (msg: { files: string[] }) => {
    const results: ParseResult[] = [];
    for (const filePath of msg.files) {
      try {
        const result = await parseFile(filePath);
        results.push(result);
      } catch (err) {
        // Return a safe error result rather than crashing the worker
        results.push({
          filePath,
          language: 'unknown',
          nodes: [],
          edges: [],
          parseErrors: [
            `Worker parse error: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
      }
    }
    parentPort!.postMessage(results);
  });
}
