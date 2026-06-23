# Contributing to AI Mind Map

Thank you for your interest in contributing to AI Mind Map! This guide will help you get started.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Architecture Overview](#architecture-overview)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something great.

## Development Setup

### Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Git** — [git-scm.com](https://git-scm.com)
- **A code editor** — VS Code recommended

### Getting Started

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/ai-mind-map.git
cd ai-mind-map

# 2. Install dependencies
npm install --legacy-peer-deps

# 3. Build the project
npm run build

# 4. Start in watch mode (auto-recompile on save)
npm run dev

# 5. Test the server locally
node dist/index.js --project-root . --log-level debug
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode — recompile on save |
| `npm run typecheck` | Type-check without emitting files |
| `npm run start` | Run the built server |
| `npm run inspect` | Run with Node.js debugger attached |

## Code Style

### TypeScript Standards

- **Strict mode** — `tsconfig.json` enforces strict type checking
- **ES2022 target** with **Node16 module resolution**
- **ESM only** — the project uses `"type": "module"` in `package.json`

### Rules

1. **Import extensions** — Always use `.js` extensions in imports:
   ```typescript
   import { KnowledgeGraph } from './knowledge-graph.js';
   import type { GraphNode } from './types.js';
   ```

2. **Type-only imports** — Use `import type` for type-only imports:
   ```typescript
   import type { MindMapConfig } from './types.js';
   ```

3. **Named exports** — Prefer named exports over default exports:
   ```typescript
   // ✅ Good
   export class KnowledgeGraph { ... }
   
   // ❌ Avoid
   export default class KnowledgeGraph { ... }
   ```

4. **JSDoc comments** — Add comprehensive JSDoc to all public APIs:
   ```typescript
   /**
    * Search the knowledge graph for nodes matching a query.
    * Uses BM25 ranking when FTS5 is available, falls back to LIKE.
    * @param query - Search term (function name, class name, or description)
    * @param limit - Maximum results to return (default: 20)
    * @returns Ranked array of matching graph nodes
    */
   export function searchGraph(query: string, limit?: number): GraphNode[] {
   ```

5. **Error handling** — Use try/catch with descriptive error messages:
   ```typescript
   try {
     await indexFile(filePath);
   } catch (error) {
     logger.error(`Failed to index ${filePath}: ${error}`);
   }
   ```

6. **Async/await** — Always use async/await over raw Promises.

7. **Function size** — Keep functions focused and under 50 lines where possible.

## Architecture Overview

```
src/
├── index.ts              # Entry point — MCP server setup & tool registration
├── types.ts              # Shared type definitions (read this first!)
├── knowledge-graph.ts    # Tree-sitter AST parsing, SQLite graph, PageRank
├── change-tracker.ts     # File watcher (chokidar), git diff, change detection
├── memory.ts             # Persistent memory with importance decay (Mem0-style)
├── context-engine.ts     # Smart context assembly, token budget management
├── compressor.ts         # Content-aware compression (9 content types)
├── file-watcher.ts       # Real-time file system monitoring
└── utils.ts              # Shared utilities, logging, helpers
```

### Key Design Principles

- **Token efficiency first** — Every feature is designed to minimize token usage
- **Progressive disclosure** — Signatures → summaries → full code, on demand
- **Graceful degradation** — Tree-sitter fails? Fall back to regex. No git? Skip diffs.
- **SQLite everywhere** — Single-file database, no external services required
- **MCP standard** — Full compliance with the Model Context Protocol

## Making Changes

### Branch Naming

- `feature/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add Python decorator extraction to AST parser
fix: handle circular dependencies in trace_dependencies
docs: update README with Windsurf configuration
refactor: extract BM25 scoring into separate module
```

## Pull Request Process

1. **Fork & branch** — Create a feature branch from `main`
2. **Make changes** — Follow the code style guidelines above
3. **Test locally** — Run `npm run build` and verify the server starts
4. **Type check** — Run `npx tsc --noEmit` with zero errors
5. **Write a clear PR description** — Explain what changed and why
6. **Link issues** — Reference any related issues (e.g., "Fixes #42")
7. **Wait for review** — A maintainer will review and provide feedback

### PR Checklist

- [ ] Code compiles without errors (`npm run build`)
- [ ] Type checking passes (`npx tsc --noEmit`)
- [ ] Changes are documented (JSDoc, README if needed)
- [ ] No unnecessary files are committed (check `.gitignore`)
- [ ] Commit messages are descriptive

## Reporting Issues

### Bug Reports

Use the [bug report template](https://github.com/shdra06/ai-mind-map/issues/new?template=bug_report.md) and include:

- Steps to reproduce
- Expected vs actual behavior
- Node.js version, OS, AI agent being used
- Relevant error messages or logs

### Feature Requests

Use the [feature request template](https://github.com/shdra06/ai-mind-map/issues/new?template=feature_request.md) and include:

- Problem you're trying to solve
- Proposed solution
- Any alternatives you've considered

---

## Questions?

- **GitHub Issues** — For bugs and feature requests
- **GitHub Discussions** — For questions and general discussion

Thank you for helping make AI Mind Map better! 🧠
