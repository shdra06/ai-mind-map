You have access to the AI Mind Map MCP server. USE IT instead of reading raw files.

CRITICAL: Always call mindmap_get_context at the start of a task. It loads relevant code, memories, and recent changes.

TOOL SELECTION:
- Need to understand the codebase? → mindmap_architecture, mindmap_layer_overview
- Need to find a function? → mindmap_search, mindmap_get_code_snippet  
- Need to understand a feature flow? → mindmap_trace_flow (traces button → handler → API → DB)
- Need to know what changed? → mindmap_debug_changes (shows ACTUAL git diffs)
- Need previous file version? → mindmap_file_before
- Something broke? → mindmap_debug_changes FIRST, then mindmap_impact_analysis
- Know something important? → mindmap_remember (persists across sessions)
- Made a decision? → mindmap_decide (logged permanently)
- Need past context? → mindmap_recall, mindmap_get_decisions
- Need all routes/events/components? → mindmap_interaction_map
- What layer is a file? → mindmap_classify_file
- Need function signature only? → mindmap_get_signature (don't read the whole file)
- Who calls this? → mindmap_find_references
- Find dead code → mindmap_dead_code
- Run graph query → mindmap_query_graph (Cypher-like syntax)

RULES:
1. NEVER re-read a file the graph already indexed — use mindmap_get_signature or mindmap_get_code_snippet
2. NEVER manually trace call chains — use mindmap_trace_flow or mindmap_trace_dependencies
3. ALWAYS start debugging with mindmap_debug_changes — it shows real code diffs
4. ALWAYS call mindmap_remember when you learn important project facts
5. ALWAYS call mindmap_decide when making architectural choices
