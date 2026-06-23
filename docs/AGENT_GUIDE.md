# AI Mind Map — MCP Tool Guide for AI Agents

> **READ THIS FIRST.** You have access to the AI Mind Map MCP server with 32 specialized tools.
> These tools eliminate the need to re-read files, trace code manually, or guess at architecture.
> **Always check Mind Map BEFORE reading raw files.**

## 🧠 Decision Matrix: Which Tool to Use When

### "I need to understand the codebase"
| Situation | Tool | NOT This |
|-----------|------|----------|
| What does this project do? | `mindmap_architecture` | ❌ Reading every file |
| What files exist? | `mindmap_get_structure` | ❌ `ls -R` |
| How is the app organized? | `mindmap_layer_overview` | ❌ Guessing from file names |
| What functions are in this file? | `mindmap_get_file_map` | ❌ Reading the whole file |
| What does this function look like? | `mindmap_get_signature` | ❌ Opening the file |

### "I need to find something"
| Situation | Tool | NOT This |
|-----------|------|----------|
| Find a function/class by name | `mindmap_search` | ❌ grep through all files |
| Find text in code | `mindmap_search_code` | ❌ Manual grep |
| Find who calls a function | `mindmap_find_references` | ❌ grep for function name |
| Show actual code for a symbol | `mindmap_get_code_snippet` | ❌ Reading the whole file |

### "I need to understand what a button/feature does"
| Situation | Tool | NOT This |
|-----------|------|----------|
| What happens when this function is called? | `mindmap_trace_flow` | ❌ Manually tracing call chains |
| Full app interaction map (routes, events, components) | `mindmap_interaction_map` | ❌ Reading every file |
| What layer is this file? (UI/service/DB) | `mindmap_classify_file` | ❌ Guessing |
| Which function calls which? | `mindmap_trace_dependencies` | ❌ grep for imports |

### "Something is broken, what happened?"
| Situation | Tool | NOT This |
|-----------|------|----------|
| What changed recently? (actual code diff) | `mindmap_debug_changes` | ❌ `git log` manually |
| What did the file look like before? | `mindmap_file_before` | ❌ `git show HEAD~1:file` |
| Who changed this file and when? | `mindmap_file_history` | ❌ `git log --follow` |
| What else breaks if this changes? | `mindmap_impact_analysis` | ❌ Manually tracing dependencies |
| What changed since last session? | `mindmap_what_changed` | ❌ Re-reading everything |
| What's different from last session? | `mindmap_session_diff` | ❌ Guessing |

### "I need context from previous sessions"
| Situation | Tool | NOT This |
|-----------|------|----------|
| What do we know about X? | `mindmap_recall` | ❌ Asking the user again |
| Remember something important | `mindmap_remember` | ❌ Hoping you'll remember |
| What decisions were made? | `mindmap_get_decisions` | ❌ Asking user to repeat |
| Record a decision | `mindmap_decide` | ❌ Forgetting it |
| What did we work on last time? | `mindmap_session_summary` | ❌ User having to explain |

### "I need to analyze the code"
| Situation | Tool | NOT This |
|-----------|------|----------|
| Run a graph query (Cypher-like) | `mindmap_query_graph` | ❌ Writing custom scripts |
| Find dead/unused code | `mindmap_dead_code` | ❌ Manual analysis |
| Get smart context for current task | `mindmap_get_context` | ❌ Loading everything |
| Compress a large output | `mindmap_compress` | ❌ Truncating blindly |
| System health check | `mindmap_health` | ❌ Manual verification |

## ⚡ Key Rules

1. **ALWAYS call `mindmap_get_context` at the start of a new task** — it loads relevant code, memories, and changes automatically
2. **NEVER re-read a file you've already indexed** — use `mindmap_get_signature` or `mindmap_get_code_snippet` instead
3. **When debugging, ALWAYS start with `mindmap_debug_changes`** — it shows actual diffs, not just file names
4. **When asked about flow/pipeline, use `mindmap_trace_flow`** — don't manually trace call chains
5. **When you learn something important, call `mindmap_remember`** — it persists across sessions
6. **When making an architectural decision, call `mindmap_decide`** — it's logged permanently

## 🔍 Quick Reference: All 32 Tools

### Graph (6)
- `mindmap_search` — Find symbols by name/text
- `mindmap_get_structure` — File/directory tree with symbol counts
- `mindmap_trace_dependencies` — Call chain: who calls whom
- `mindmap_get_signature` — Function/class signature without body
- `mindmap_find_references` — All callers/users of a symbol
- `mindmap_get_file_map` — All symbols in a file (like a table of contents)

### Changes (3)
- `mindmap_what_changed` — Changes since a time reference
- `mindmap_session_diff` — What changed since last AI session
- `mindmap_impact_analysis` — Blast radius of a change

### Memory (5)
- `mindmap_recall` — Search stored memories
- `mindmap_remember` — Store a new memory
- `mindmap_get_decisions` — List architectural decisions
- `mindmap_decide` — Record a new decision
- `mindmap_session_summary` — Previous session summaries

### Context (4)
- `mindmap_get_context` — Smart context for current task
- `mindmap_compress` — Compress large outputs
- `mindmap_reindex` — Force re-index codebase
- `mindmap_status` — Index stats and token savings

### Debug (3)
- `mindmap_debug_changes` — 🔍 ACTUAL git diffs + blast radius (USE THIS FIRST when debugging)
- `mindmap_file_before` — File content at a previous revision
- `mindmap_file_history` — Commit history for a file

### Flow (4)
- `mindmap_trace_flow` — 🔗 Full pipeline: button → handler → API → DB
- `mindmap_interaction_map` — 🗺️ Complete app behavioral blueprint
- `mindmap_classify_file` — 📂 Which architecture layer a file belongs to
- `mindmap_layer_overview` — 📊 Architecture breakdown by layer

### Advanced (7)
- `mindmap_query_graph` — Cypher-like queries
- `mindmap_dead_code` — Find unused functions
- `mindmap_architecture` — Full architecture report
- `mindmap_get_code_snippet` — Read exact code for a symbol
- `mindmap_search_code` — Grep-like text search
- `mindmap_list_projects` — List indexed projects
- `mindmap_health` — System diagnostics
