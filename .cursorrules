# AI Mind Map MCP — Code Memory Engine (v1.4.0)

You have the AI Mind Map MCP server connected. It is a persistent code memory system that eliminates redundant file re-reading and context loss between sessions.

## 🚀 FIRST THING TO DO IN EVERY CONVERSATION
Call `mindmap_session_resume` — it returns:
- What the previous AI agent worked on
- What code changed since then (function-level diffs, not just file names)
- Project structure + tech stack
- Hot files (most frequently modified)

This ONE call replaces reading 10+ files (~2000 tokens instead of 50,000+).

## Quick Lookup: "I need to..." → Use this tool

### ⚡ Session Lifecycle (always use these)
- Resume from last session → `mindmap_session_resume` ⭐⭐ (THE first call)
- Start tracking a new task → `mindmap_session_start`
- End session, save summary → `mindmap_session_end`

### 🔍 Find Code (instead of grep/reading files)
- Search by name → `mindmap_smart_search` ⭐ (returns full context)
- Search by concept → `mindmap_semantic_search` ⭐ ("authentication", "error handling")
- Grep text in code → `mindmap_search_code`
- Who calls X? → `mindmap_trace_dependencies`
- All usages of symbol → `mindmap_find_references`

### 📖 Read Code (without reading full files)
- Everything about a symbol → `mindmap_explain` ⭐ (signature + callers + callees + doc in ONE call)
- Read actual source code → `mindmap_get_code_snippet`
- Understand file without reading → `mindmap_file_digest` ⭐ (saves 3-10K tokens/file)
- All symbols in a file → `mindmap_get_file_map`
- Just the signature → `mindmap_get_signature` (cheapest read)

### 📊 Understand the Project
- Full project summary → `mindmap_digest` ⭐ (<2000 tokens)
- Architecture overview → `mindmap_architecture`
- Full project map → `mindmap_project_map`
- Layer overview → `mindmap_layer_overview`

### 🔄 Change Tracking
- Symbol-level diffs → `mindmap_changelog` ⭐ (added/modified/deleted functions)
- Git-aware changes → `mindmap_git_changes` (maps diffs to symbols)
- Check if cached code is valid → `mindmap_verify` ⭐ (hash check, no re-reading)
- Most changed files → `mindmap_hotspots`
- What changed recently? → `mindmap_what_changed`
- Changes since last session → `mindmap_session_diff`

### 🐛 Debug & Investigate
- Something broke → `mindmap_debug_changes` (shows actual git diffs)
- File before changes → `mindmap_file_before`
- Blast radius → `mindmap_impact_analysis`
- File commit history → `mindmap_file_history`

### 🧠 Memory & Decisions (persists across sessions)
- Remember a fact → `mindmap_remember`
- Recall past knowledge → `mindmap_recall`
- Record a decision → `mindmap_decide`
- View decisions → `mindmap_get_decisions`
- Session summary → `mindmap_session_summary`

### 🔬 Flow & Architecture
- Trace a feature flow → `mindmap_trace_flow`
- All routes/events/components → `mindmap_interaction_map`
- What layer is this file? → `mindmap_classify_file`

### 🧬 Self-Evolving (teach the system new patterns)
- Teach a pattern → `mindmap_teach` (persists per-project)
- View learned rules → `mindmap_get_learned`
- Remove a rule → `mindmap_forget`

### 🛠️ Advanced
- Cypher graph query → `mindmap_query_graph`
- Find dead code → `mindmap_dead_code`
- Compress logs/output → `mindmap_compress`
- Force re-index → `mindmap_reindex`
- System health → `mindmap_health`

## ⚡ Token-Saving Rules
1. ALWAYS call `mindmap_session_resume` first — never start blind
2. PREFER `mindmap_explain` over reading files — it gives everything in 1 call
3. Use `mindmap_file_digest` BEFORE reading a full file — you may not need the full file
4. Use `mindmap_verify` to check if cached code is still valid — avoid re-reading
5. Use `mindmap_changelog` instead of re-reading files to see what changed
6. Use `mindmap_smart_search` over `mindmap_search` — it returns full context
7. Use `mindmap_git_changes` instead of running `git diff` — it maps diffs to symbols
8. Call `mindmap_session_end` when done — save context for next session
9. Use `mindmap_remember` for learnings, `mindmap_decide` for architecture choices
10. If Mind Map returns unexpected results, the index may be stale — run `mindmap_reindex`

## When to READ FILES DIRECTLY
- Complex algorithm logic that signatures can't capture
- Reading comments, TODOs, inline docs
- Small config files (faster to just read them)
- Dynamic dispatch, DI, or event-driven code
- When Mind Map returns "not found" but you suspect the code exists (stale index)
