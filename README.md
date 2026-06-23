<p align="center">
  <h1 align="center">🧠 AI Mind Map</h1>
  <p align="center">
    <strong>MCP Server that reduces AI coding agent token usage by 80-99%</strong>
  </p>
  <p align="center">
    <a href="https://github.com/shdra06/ai-mind-map/actions/workflows/ci.yml"><img src="https://github.com/shdra06/ai-mind-map/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/shdra06/ai-mind-map/releases"><img src="https://img.shields.io/github/v/release/shdra06/ai-mind-map?label=release" alt="Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/shdra06/ai-mind-map" alt="License"></a>
    <a href="https://www.npmjs.com/package/ai-mind-map"><img src="https://img.shields.io/npm/v/ai-mind-map" alt="npm"></a>
  </p>
  <p align="center">
    Stop wasting tokens re-reading your codebase. Give your AI agent a persistent memory.
  </p>
  <p align="center">
    <a href="#-quick-start-windows">Quick Start</a> •
    <a href="#-how-it-works">How It Works</a> •
    <a href="#-41-mcp-tools">All 41 Tools</a> •
    <a href="#-connect-to-your-ai-agent">Connect</a> •
    <a href="#-configuration">Config</a>
  </p>
</p>

---


## ❓ The Problem

Every time an AI coding agent (Claude Code, Cursor, Copilot, Windsurf, Antigravity) processes a request, it **re-reads your entire codebase from scratch**. This wastes massive amounts of tokens:

```
Without AI Mind Map:
  ❌ Agent reads auth.ts        → 5,000 tokens
  ❌ Agent reads auth.ts AGAIN  → 5,000 tokens (same file!)
  ❌ Agent reads auth.ts AGAIN  → 5,000 tokens (still the same file!)
  Total: 15,000 tokens for 3 questions about ONE file

With AI Mind Map:
  ✅ mindmap_get_signature("authenticate")        → 50 tokens
  ✅ mindmap_get_signature("validateToken")        → 40 tokens  
  ✅ mindmap_trace_dependencies("authenticate")    → 100 tokens
  Total: 190 tokens — that's a 99% reduction
```

> **Industry research shows ~42% of all tokens consumed by AI coding agents are avoidable waste** — repeated file reads, re-discovering architecture, re-debating settled decisions.

---

## ✨ What AI Mind Map Does

AI Mind Map is an **MCP (Model Context Protocol) server** that gives your AI agent:

| Feature | What It Does | Token Savings |
|---------|-------------|---------------|
| 🗺️ **Knowledge Graph** | Parses your entire codebase into a queryable graph of functions, classes, and relationships | **99%** |
| 📝 **Change Tracker** | Knows exactly what changed since the AI's last session | **80%** |
| 🧠 **Persistent Memory** | Remembers architecture decisions, conventions, and context across sessions | **90%** |
| 🗜️ **Smart Compression** | Compresses build logs, test output, stack traces intelligently | **50-98%** |
| 📊 **Progressive Loading** | Loads only what's needed — signatures first, full code only when asked | **90%** |
| ⚡ **Real-time Sync** | File watcher keeps the graph updated as you code | Always fresh |

### Inspired By The Best

This project combines proven techniques from:

| Source | Technique | Their Result |
|--------|-----------|-------------|
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Knowledge Graph + SQLite | 99% reduction (120x fewer tokens) |
| [Aider](https://github.com/Aider-AI/aider) | PageRank-based Repo Map | 90%+ reduction |
| [Mem0](https://github.com/mem0ai/mem0) | Persistent Memory with Decay | 3-4x cost reduction |
| [context-mode](https://github.com/mksglu/context-mode) | Context Sandboxing + BM25 | 98% context reduction |
| [context-mem](https://github.com/context-mem/context-mem) | Progressive Disclosure | 90%+ savings |

---

## 🚀 Quick Start

### Method 1: npx (Fastest — Zero Install)

```bash
# Run directly without installing anything
npx ai-mind-map install

# That's it. It auto-detects Claude, Cursor, VS Code, Windsurf, Antigravity, Zed, Continue.dev
```

### Method 2: Global Install

```bash
npm install -g ai-mind-map

# Auto-detect and configure all your AI agents
ai-mind-map install

# Check everything is working
ai-mind-map doctor
```

### Method 3: Clone (For Development)

```bash
git clone https://github.com/shdra06/ai-mind-map.git
cd ai-mind-map
npm install --legacy-peer-deps
npm run build
node dist/cli.js install
```

### What `install` Does

1. ✅ Scans your system for AI coding agents (Claude, Cursor, VS Code, Windsurf, Antigravity, Zed, Continue.dev)
2. ✅ Writes MCP config to each agent's config file  
3. ✅ Deploys rules files so agents know about our 41 tools
4. ✅ Runs diagnostics to verify everything works

### Verify It Works

```bash
ai-mind-map doctor
```

Output:
```
🩺 AI Mind Map — Diagnostics
────────────────────────────────────────────────────────
  ✔ Node.js           v24.x (>= 18 required)
  ✔ SQLite             In-memory test passed
  ✔ TypeScript Build   dist/index.js exists
  ✔ Agents             3 detected, 3 configured
```

---

## 🔌 Connect To Your AI Agent

### Claude Code

Add to your Claude Code MCP settings file (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ai-mind-map": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\ai-mind-map\\dist\\index.js",
        "--project-root",
        "C:\\Users\\YOUR_USERNAME\\your-project"
      ]
    }
  }
}
```

> **💡 Tip:** Replace `YOUR_USERNAME` with your Windows username, and point `--project-root` to the project you want indexed.

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "ai-mind-map": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\ai-mind-map\\dist\\index.js",
        "--project-root",
        "."
      ]
    }
  }
}
```

### Windsurf / Codeium

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "ai-mind-map": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\ai-mind-map\\dist\\index.js",
        "--project-root",
        "C:\\path\\to\\project"
      ],
      "transportType": "stdio"
    }
  }
}
```

### VS Code (Copilot / Continue.dev)

For any VS Code extension that supports MCP, add to your settings:

```json
{
  "mcp.servers": {
    "ai-mind-map": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\ai-mind-map\\dist\\index.js",
        "--project-root",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### Antigravity (Gemini)

Add to your Antigravity MCP config:

```json
{
  "mcpServers": {
    "ai-mind-map": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\ai-mind-map\\dist\\index.js",
        "--project-root",
        "C:\\path\\to\\project"
      ]
    }
  }
}
```

### Any MCP-Compatible Agent

AI Mind Map works with **any tool that supports the Model Context Protocol**. Just configure:
- **Command:** `node`
- **Args:** `["path/to/ai-mind-map/dist/index.js", "--project-root", "path/to/your/project"]`
- **Transport:** `stdio`

---

## 🔧 41 MCP Tools

Once connected, your AI agent gets these powerful tools:

### 🗺️ Knowledge Graph (6)

| Tool | What It Does |
|------|-------------|
| `mindmap_search` | Search codebase by function/class name or free text |
| `mindmap_get_structure` | Project architecture overview in ~100 tokens |
| `mindmap_trace_dependencies` | Trace call chains — who calls what |
| `mindmap_get_signature` | Function signature without reading the file |
| `mindmap_find_references` | Find everywhere a symbol is used |
| `mindmap_get_file_map` | All symbols in a file with line ranges |

### 📝 Change Tracking (3)

| Tool | What It Does |
|------|-------------|
| `mindmap_what_changed` | Summary of recent code changes |
| `mindmap_session_diff` | What changed since last AI session |
| `mindmap_impact_analysis` | Blast radius of a change |

### 🧠 Memory (5)

| Tool | What It Does |
|------|-------------|
| `mindmap_recall` | Retrieve relevant memories |
| `mindmap_remember` | Store a fact or convention |
| `mindmap_get_decisions` | Past architectural decisions |
| `mindmap_decide` | Record a new decision |
| `mindmap_session_summary` | Previous session summaries |

### 🗜️ Context (4)

| Tool | What It Does |
|------|-------------|
| `mindmap_get_context` | Smart context for current task |
| `mindmap_compress` | Compress logs, traces, output |
| `mindmap_reindex` | Force full re-index |
| `mindmap_status` | Index stats and token savings |

### 🔬 Advanced Analysis (7)

| Tool | What It Does |
|------|-------------|
| `mindmap_query_graph` | Cypher-like graph queries |
| `mindmap_dead_code` | Detect unused functions |
| `mindmap_architecture` | Full architecture overview |
| `mindmap_get_code_snippet` | Read source by symbol name |
| `mindmap_search_code` | Grep-like text search |
| `mindmap_list_projects` | List indexed projects |
| `mindmap_health` | System diagnostics |

### 🔍 Debug (3)

| Tool | What It Does |
|------|-------------|
| `mindmap_debug_changes` | Detailed change analysis |
| `mindmap_file_before` | File content before changes |
| `mindmap_file_history` | Full file change history |

### 🏗️ Flow Analysis (4)

| Tool | What It Does |
|------|-------------|
| `mindmap_trace_flow` | Trace behavioral flows through layers |
| `mindmap_interaction_map` | Full interaction map of the codebase |
| `mindmap_classify_file` | Classify a file's architectural layer |
| `mindmap_layer_overview` | Layer distribution overview |

### 📸 Snapshot (3)

| Tool | What It Does |
|------|-------------|
| `mindmap_project_map` | Compact project map for context |
| `mindmap_change_delta` | What changed since last snapshot |
| `mindmap_session_start` | Start a new tracking session |

### ⭐ Smart Tools (3) — **99% Token Savings**

| Tool | What It Does |
|------|-------------|
| `mindmap_explain` | **Everything about a symbol in 1 call** — signature, callers, callees, layer, blast radius, git history |
| `mindmap_git_changes` | **Git-aware symbol-level diffs** — which functions changed, who's impacted |
| `mindmap_smart_search` | **Rich search** — returns full context so AI never reads files |

### 🧬 Self-Evolving (3)

| Tool | What It Does |
|------|-------------|
| `mindmap_teach` | **AI teaches new patterns** — classification rules, search aliases, conventions that persist per-project |
| `mindmap_get_learned` | View all rules the system has learned |
| `mindmap_forget` | Remove a learned rule |

---

## 💻 CLI Mode

Every MCP tool is also available from the command line. No agent required:

```bash
# Index a project
ai-mind-map index /path/to/project

# Search the graph
ai-mind-map search "authenticate" --type function

# Trace call chains
ai-mind-map trace "processOrder" --direction both --depth 3

# Show project structure
ai-mind-map structure

# Recall memories
ai-mind-map recall "authentication"

# Store a convention
ai-mind-map remember "We use camelCase for all function names" --category convention

# Show what changed
ai-mind-map changes --since last_session

# Auto-configure all AI agents
ai-mind-map install

# Diagnostics
ai-mind-map doctor

# Show config
ai-mind-map config list
```

---

## ⚙️ Configuration

### Project-Level Config (Optional)

Create a `.mindmap.json` file in your project root to customize behavior:

```json
{
  "languages": ["typescript", "python", "javascript"],
  "ignore": ["node_modules", "dist", "*.test.*", "coverage"],
  "tokenBudgets": {
    "graphResults": 2000,
    "changeSummary": 1000,
    "memoryRetrieval": 1500,
    "fileContent": 3000,
    "totalContext": 10000
  },
  "memory": {
    "maxMemories": 500,
    "decayRate": 0.95,
    "importanceThreshold": 0.1,
    "maxDecisions": 200
  },
  "compression": "moderate",
  "watchEnabled": true
}
```

### CLI Options

```
node dist/index.js [options]

Options:
  --project-root <path>   Root of the project to index (default: auto-detect from git)
  --db-path <path>        SQLite database location (default: .mindmap/mindmap.db)
  --log-level <level>     debug | info | warn | error (default: info)
```

---

## 🌐 Language Support

Tree-sitter AST parsing with automatic regex fallback:

| Language | AST Parsing | Regex Fallback | Extracts |
|----------|:-----------:|:--------------:|----------|
| JavaScript | ✅ | ✅ | Functions, classes, imports, exports |
| TypeScript | ✅ | ✅ | + Interfaces, types, enums, decorators |
| Python | ✅ | ✅ | Functions, classes, decorators, docstrings |
| Java | ✅ | ✅ | Classes, methods, interfaces, annotations |
| Go | ✅ | ✅ | Functions, structs, interfaces, methods |
| Rust | ✅ | ✅ | Functions, structs, traits, impls, enums |
| C/C++ | ✅ | ✅ | Functions, classes, structs, macros |
| C# | ✅ | ✅ | Classes, methods, interfaces, properties |
| Ruby | ✅ | ✅ | Classes, modules, methods, blocks |
| PHP | ✅ | ✅ | Classes, functions, traits, namespaces |
| Bash | ✅ | ✅ | Functions, variables, aliases |
| CSS/HTML | ✅ | ✅ | Selectors, classes, IDs |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│              AI Mind Map MCP Server                  │
│                                                       │
│  ┌─────────────────┐  ┌────────────────┐  ┌────────┐ │
│  │ Knowledge Graph  │  │ Change Tracker │  │ Memory │ │
│  │ ─────────────── │  │ ────────────── │  │ ────── │ │
│  │ Tree-sitter AST │  │ Chokidar Watch │  │  Mem0  │ │
│  │ SQLite + FTS5   │  │ Git Diff       │  │  Style │ │
│  │ PageRank        │  │ BM25 Search    │  │ Decay  │ │
│  └────────┬────────┘  └───────┬────────┘  └───┬────┘ │
│           │                   │                │      │
│  ┌────────┴───────────────────┴────────────────┴────┐ │
│  │              Context Engine                       │ │
│  │  Content-Aware Compression (9 types)              │ │
│  │  Progressive Disclosure (3 tiers)                 │ │
│  │  Token Budget Manager                             │ │
│  └──────────────────────┬────────────────────────────┘ │
│                         │                               │
│                  41 MCP Tools                           │
└─────────────────────────┼───────────────────────────────┘
                          │ stdio
                ┌─────────┴──────────┐
                │   Your AI Agent    │
                │  Claude / Cursor / │
                │ Copilot / Windsurf │
                └────────────────────┘
```

### How the Memory System Works

AI Mind Map uses a **three-tier memory architecture** (inspired by cognitive science):

| Layer | What | Token Cost | Lifespan |
|-------|------|-----------|----------|
| **Working Memory** | Current task context | Full price | This conversation |
| **Episodic Memory** | Session summaries, recent decisions | On-demand retrieval | Days to weeks |
| **Semantic Memory** | Codebase graph, architecture, conventions | Queried, never dumped | Permanent (with decay) |

Memories have **importance scores** that:
- 📈 **Increase** when accessed (+0.1 per access, capped at 1.0)
- 📉 **Decay** over time (configurable, default 5% per day)
- 🗑️ **Get pruned** when importance drops below threshold

This means frequently-useful memories stick around, while stale ones naturally fade.

---

## 📊 Expected Token Savings

| Scenario | Without Mind Map | With Mind Map | Savings |
|----------|:----------------:|:-------------:|:-------:|
| Find a function signature | ~5,000 tokens | ~50 tokens | **99%** |
| Understand project structure | ~50,000 tokens | ~500 tokens | **99%** |
| Resume after session break | ~20,000 tokens | ~2,000 tokens | **90%** |
| Trace dependency chain | ~30,000 tokens | ~200 tokens | **99%** |
| Check what changed | ~10,000 tokens | ~500 tokens | **95%** |
| Compress build log | ~8,000 tokens | ~400 tokens | **95%** |

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Run the build: `npm run build`
5. Commit: `git commit -m "Add amazing feature"`
6. Push: `git push origin feature/amazing-feature`
7. Open a Pull Request

### Development

```powershell
# Watch mode (auto-recompile on changes)
npm run dev

# Type check without building
npx tsc --noEmit

# Run the server locally
node dist/index.js --project-root . --log-level debug
```

---

## 📄 License

MIT — use it however you want. See [LICENSE](LICENSE).

---

## 🙏 Acknowledgments

Built on the shoulders of giants:

- [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) — Knowledge graph architecture (99% token reduction)
- [Aider](https://github.com/Aider-AI/aider) — Repository map with PageRank ranking
- [Mem0](https://github.com/mem0ai/mem0) — Persistent memory with importance decay
- [context-mode](https://github.com/mksglu/context-mode) — Context sandboxing with BM25
- [context-mem](https://github.com/context-mem/context-mem) — Progressive disclosure patterns
- [CocoIndex](https://github.com/cocoindex-io/cocoindex-code) — Incremental AST indexing
- [Repomix](https://github.com/yamadashy/repomix) — Codebase compression techniques
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) — Multi-language AST parsing
- [MCP Protocol](https://modelcontextprotocol.io) — The standard that makes this possible

---

<p align="center">
  <strong>⭐ Star this repo if it saves you tokens!</strong>
</p>
