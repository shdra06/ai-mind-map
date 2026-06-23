# AI Mind Map MCP — Tool Awareness

You have the AI Mind Map MCP server connected with 32 tools. Use them INSTEAD of reading raw files.

## Quick Lookup: "I need to..." → Use this tool

- Understand the project → `mindmap_architecture`
- Find a function → `mindmap_search`, `mindmap_get_code_snippet`
- Trace what a button/feature does → `mindmap_trace_flow`
- See all routes/events/components → `mindmap_interaction_map`
- Know what layer a file is → `mindmap_classify_file`
- Debug a crash → `mindmap_debug_changes` (shows ACTUAL diffs)
- See previous file version → `mindmap_file_before`
- Know what changed recently → `mindmap_what_changed`
- Get blast radius of a change → `mindmap_impact_analysis`
- Remember something → `mindmap_remember`
- Recall past knowledge → `mindmap_recall`
- Record a decision → `mindmap_decide`
- Start a new task → `mindmap_get_context` (ALWAYS call first)
- Get function signature → `mindmap_get_signature` (DON'T open the file)
- Find who calls a function → `mindmap_find_references`
- Find dead code → `mindmap_dead_code`
- Run graph query → `mindmap_query_graph`

## Rules
1. ALWAYS call `mindmap_get_context` at the start of every task
2. NEVER read a file when `mindmap_get_signature` or `mindmap_get_code_snippet` suffices
3. NEVER trace call chains manually — use `mindmap_trace_flow`
4. ALWAYS start debugging with `mindmap_debug_changes`
5. ALWAYS `mindmap_remember` important learnings
