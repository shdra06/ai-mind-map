/**
 * AI Mind Map — Codebase Intelligence Chat Engine
 *
 * Natural-language chat panel for the Intelligence Explorer.
 * Initialized AFTER a repo scan completes. Receives parsed codebase data
 * and a reference to the graph API so it can answer questions, highlight
 * paths, and generate exportable summaries.
 *
 * Usage:
 *   window.IntelChat.init(panelEl, data, graphApi);
 *   // data = { nodes, edges, routes, files, functionMetrics,
 *   //          fileMetrics, security, documentation, scores, summary }
 *   // graphApi = window.IntelGraph (highlightPath, focusNode, …)
 */

window.IntelChat = (function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════
     ███  INTERNAL STATE  ███
     ═══════════════════════════════════════════════════════════════ */

  let panel   = null;   // root DOM element
  let data    = null;   // full parsed data bag
  let graph   = null;   // IntelGraph API reference
  let msgsEl  = null;   // scrollable messages container
  let inputEl = null;   // text input
  let history = [];     // { role, content, ts }

  /* ── node-type palette (matches graph.js TYPE_COLORS) ── */
  const TYPE_COLORS = {
    class:       '#00b894', method:    '#6c5ce7', function:  '#00cec9',
    interface:   '#fd79a8', enum:      '#fdcb6e', constructor:'#a29bfe',
    property:    '#74b9ff', hook:      '#ff7675', component: '#55efc4',
    route:       '#e17055', test:      '#636e72', constant:  '#b2bec3',
    type_alias:  '#dfe6e9', namespace: '#81ecec', decorator: '#fab1a0',
    file:        '#8b8ba3', middleware:'#d4901f', database:  '#e84393',
  };
  const DEFAULT_NODE_COLOR = '#8b8ba3';

  /* ── quick-action definitions ── */
  const QUICK_ACTIONS = [
    { emoji: '🛣️', label: 'Routes',          query: 'show all routes' },
    { emoji: '💀', label: 'Dead Code',        query: 'show dead code' },
    { emoji: '🔒', label: 'Security Issues',  query: 'security issues' },
    { emoji: '📐', label: 'Top Complex',      query: 'most complex functions' },
    { emoji: '🔍', label: 'Impact of…',       query: '__prompt_impact__' },
  ];

  /* ═══════════════════════════════════════════════════════════════
     ███  PUBLIC API  ███
     ═══════════════════════════════════════════════════════════════ */

  function init(panelEl, codebaseData, graphApi) {
    panel = panelEl;
    data  = codebaseData || {};
    graph = graphApi || {};

    // Normalise optional arrays / objects
    data.nodes            = data.nodes            || [];
    data.edges            = data.edges            || [];
    data.routes           = data.routes           || [];
    data.files            = data.files            || [];
    data.functionMetrics  = data.functionMetrics  || [];
    data.fileMetrics      = data.fileMetrics      || [];
    data.security         = data.security         || [];
    data.documentation    = data.documentation    || {};
    data.scores           = data.scores           || {};
    data.summary          = data.summary          || '';

    _buildNodeIndex();
    _renderShell();
    _bindEvents();
    _welcome();

    // Initialize AI integration if available
    if (window.IntelAI) {
      window.IntelAI.setContext(data);
      window.IntelAI.renderKeyInput(panel, () => {
        _addMessage('bot', '🧠 **AI Chat activated!** I now use Gemini Flash to understand your codebase deeply. Ask me anything — I\'ll give intelligent, contextual answers about architecture, routes, and code quality.', { html: true });
      });
    }
  }

  function handleQuery(text) {
    if (!text || !text.trim()) return;
    const q = text.trim();
    _addMessage('user', q);
    const lower = q.toLowerCase();

    // ── route queries ──
    if (_matches(lower, ['show me', 'show route', 'trace route', 'route for', 'route '])) {
      return _cmdShowRoute(q, lower);
    }
    if (_matches(lower, ['show all routes', 'list routes', 'compare routes'])) {
      return _cmdListRoutes();
    }

    // ── call / dependency queries ──
    if (_matches(lower, ['what calls', 'who calls', 'callers of', 'callers for'])) {
      return _cmdCallers(q, lower);
    }
    if (_matches(lower, ['what does', 'callees of', 'calls from']) && _matches(lower, ['call'])) {
      return _cmdCallees(q, lower);
    }
    if (_matches(lower, ['how does', 'explain how'])) {
      return _cmdExplainFunction(q, lower);
    }

    // ── dead code / orphan ──
    if (_matches(lower, ['dead code', 'orphan', 'unused', 'unreachable'])) {
      return _cmdDeadCode();
    }

    // ── security ──
    if (_matches(lower, ['security', 'vulnerability', 'vulnerabilities', 'owasp', 'injection'])) {
      return _cmdSecurity();
    }

    // ── complexity ──
    if (_matches(lower, ['complex', 'complicated', 'longest', 'largest'])) {
      return _cmdComplexFunctions();
    }

    // ── impact / blast radius ──
    if (_matches(lower, ['impact', 'break', 'affect', 'blast radius', 'depend'])) {
      return _cmdImpact(q, lower);
    }

    // ── summarize ──
    if (_matches(lower, ['summarize', 'summary of', 'describe', 'overview of'])) {
      return _cmdSummarize(q, lower);
    }

    // ── explain node ──
    if (_matches(lower, ['explain', 'what is', 'tell me about', 'info on', 'details for'])) {
      return _cmdExplainNode(q, lower);
    }

    // ── find / search ──
    if (_matches(lower, ['find', 'search', 'grep', 'locate', 'where is'])) {
      return _cmdFind(q, lower);
    }

    // ── AI-powered fallback OR static suggestions ──
    if (window.IntelAI && window.IntelAI.isReady) {
      _aiQuery(q);
    } else {
      _suggestQueries(q);
    }
  }

  /**
   * Send query to Gemini AI with codebase context
   */
  async function _aiQuery(question) {
    const thinkingId = 'ai-thinking-' + Date.now();
    _addMessage('bot', '<span class="ai-badge">✨ AI</span> Thinking...', { html: true, id: thinkingId });
    
    try {
      const response = await window.IntelAI.chat(question);
      
      // Remove thinking message
      const thinkingEl = document.getElementById(thinkingId);
      if (thinkingEl) thinkingEl.remove();
      
      // Format the response (convert markdown-lite)
      const formatted = response
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '• $1')
        .replace(/^### (.+)$/gm, '<strong>$1</strong>')
        .replace(/^## (.+)$/gm, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
      
      _addMessage('bot', `<span class="ai-badge">✨ AI</span> ${formatted}`, { html: true });
      
      // Try to highlight mentioned nodes on the graph
      _highlightMentionedNodes(response);
      
    } catch (err) {
      const thinkingEl = document.getElementById(thinkingId);
      if (thinkingEl) thinkingEl.remove();
      _addMessage('bot', `⚠️ AI error: ${err.message}. Falling back to local analysis.`);
      _suggestQueries(question);
    }
  }

  /**
   * Find node names mentioned in the AI response and highlight them
   */
  function _highlightMentionedNodes(text) {
    if (!graph || !graph.highlightPath) return;
    const mentioned = [];
    (data.nodes || []).forEach(n => {
      if (n.label && n.label.length > 2 && text.includes(n.label)) {
        mentioned.push(n.id);
      }
    });
    if (mentioned.length > 0 && mentioned.length < 20) {
      graph.highlightPath(mentioned);
    }
  }

  function addMessage(role, content, options) {
    _addMessage(role, content, options);
  }

  function destroy() {
    if (panel) panel.innerHTML = '';
    document.removeEventListener('intel-node-click', _onGraphNodeClick);
    panel = data = graph = msgsEl = inputEl = null;
    history = [];
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  UI RENDERING  ███
     ═══════════════════════════════════════════════════════════════ */

  function _renderShell() {
    panel.classList.add('intel-chat');
    panel.innerHTML = '';

    // ── messages area ──
    msgsEl = _el('div', 'chat-messages');
    panel.appendChild(msgsEl);

    // ── quick actions strip ──
    const actionsEl = _el('div', 'chat-actions');
    QUICK_ACTIONS.forEach(a => {
      const btn = _el('button', 'chat-action-btn');
      btn.innerHTML = `${a.emoji} <span>${a.label}</span>`;
      btn.addEventListener('click', () => {
        if (a.query === '__prompt_impact__') {
          _promptImpact();
        } else {
          handleQuery(a.query);
        }
      });
      actionsEl.appendChild(btn);
    });
    panel.appendChild(actionsEl);

    // ── input area ──
    const inputArea = _el('div', 'chat-input-area');
    inputEl = _el('input', 'chat-input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Ask about this codebase…';
    inputEl.setAttribute('autocomplete', 'off');

    const sendBtn = _el('button', 'chat-send-btn');
    sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    sendBtn.title = 'Send';

    inputArea.appendChild(inputEl);
    inputArea.appendChild(sendBtn);
    panel.appendChild(inputArea);

    // ── inject scoped styles ──
    _injectStyles();
  }

  function _welcome() {
    const nodeCount = data.nodes.length;
    const edgeCount = data.edges.length;
    const fileCount = data.files.length;
    const routeCount = data.routes.length;

    let stats = `Analyzed **${nodeCount}** symbols across **${fileCount}** files with **${edgeCount}** connections`;
    if (routeCount > 0) stats += ` and **${routeCount}** routes`;
    stats += '.';

    _addMessage('bot',
      `🧬 I've analyzed this codebase. ${stats}\n\n` +
      `Ask me anything! Try:\n` +
      `• "Show me the /api/users route"\n` +
      `• "What functions call the database?"\n` +
      `• "Show dead code"\n` +
      `• "Most complex functions"\n` +
      `• "What would break if I change UserController?"`,
    );
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  MESSAGE RENDERING  ███
     ═══════════════════════════════════════════════════════════════ */

  function _addMessage(role, content, options) {
    options = options || {};
    const msg = _el('div', `chat-msg chat-msg--${role}`);
    
    // Allow setting an id for later removal (e.g. thinking indicator)
    if (options.id) msg.id = options.id;

    // ── avatar ──
    const avi = _el('div', 'chat-msg__avatar');
    avi.textContent = role === 'user' ? '👤' : '🧬';
    msg.appendChild(avi);

    // ── body ──
    const body = _el('div', 'chat-msg__body');

    // text content — supports markdown-lite or raw html
    if (content) {
      const textBlock = _el('div', 'chat-msg__text');
      if (options.html) {
        textBlock.innerHTML = content;
      } else {
        textBlock.innerHTML = _renderMarkdownLite(content);
      }
      body.appendChild(textBlock);
    }

    // optional: node badges
    if (options.nodes && options.nodes.length) {
      const badges = _el('div', 'chat-msg__badges');
      options.nodes.forEach(n => badges.appendChild(_makeNodeBadge(n)));
      body.appendChild(badges);
    }

    // optional: path visualization
    if (options.path && options.path.length) {
      body.appendChild(_renderPathViz(options.path));
    }

    // optional: stats table
    if (options.table) {
      body.appendChild(_renderTable(options.table));
    }

    // optional: code snippet
    if (options.code) {
      const pre = _el('pre', 'chat-msg__code');
      const codeEl = _el('code');
      codeEl.textContent = options.code;
      pre.appendChild(codeEl);
      body.appendChild(pre);
    }

    // optional: copyable summary
    if (options.summary) {
      body.appendChild(_renderCopySummary(options.summary));
    }

    // ── action buttons row ──
    if (options.actions && options.actions.length) {
      const actionRow = _el('div', 'chat-msg__action-row');
      options.actions.forEach(a => {
        const btn = _el('button', 'chat-msg__action-btn');
        btn.textContent = a.label;
        btn.addEventListener('click', a.onClick);
        actionRow.appendChild(btn);
      });
      body.appendChild(actionRow);
    }

    msg.appendChild(body);
    msgsEl.appendChild(msg);
    history.push({ role, content, ts: Date.now() });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ── markdown-lite: **bold**, `code`, lists, line breaks ── */
  function _renderMarkdownLite(text) {
    let html = _escapeHtml(text);
    // bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // inline code
    html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    // unordered list items  (• or - at start of line)
    html = html.replace(/^[•\-]\s+(.*)$/gm, '<li>$1</li>');
    // wrap consecutive <li>s in <ul>
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    // tree-branch lines (├ └ │)
    html = html.replace(/^([├└│─\s]+.*)$/gm, '<span class="chat-tree-line">$1</span>');
    // line breaks
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  /* ── clickable node badge ── */
  function _makeNodeBadge(node) {
    const badge = _el('span', 'chat-node-badge');
    const color = TYPE_COLORS[node.type] || DEFAULT_NODE_COLOR;
    badge.style.setProperty('--badge-color', color);
    badge.innerHTML = `<span class="chat-node-badge__dot" style="background:${color}"></span>${_escapeHtml(node.label || node.id)}`;
    badge.title = `${node.type || 'node'} — click to focus`;
    badge.addEventListener('click', () => {
      if (graph && graph.focusNode) graph.focusNode(node.id);
    });
    return badge;
  }

  /* ── ordered path visualization ── */
  function _renderPathViz(pathNodes) {
    const wrap = _el('div', 'chat-msg__path');
    pathNodes.forEach((n, i) => {
      const row = _el('div', 'chat-path-step');
      const connector = i < pathNodes.length - 1 ? '├── ' : '└── ';
      const icon = _typeIcon(n.type);
      row.innerHTML = `<span class="chat-tree-char">${connector}</span>${icon} `;
      const badge = _makeNodeBadge(n);
      row.appendChild(badge);
      if (n.file) {
        const loc = _el('span', 'chat-path-file');
        loc.textContent = ` (${_basename(n.file)}${n.line ? ':' + n.line : ''})`;
        row.appendChild(loc);
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ── table renderer ── */
  function _renderTable(tableData) {
    // tableData = { headers: [str], rows: [[str]] }
    const table = _el('table', 'chat-msg__table');
    if (tableData.headers) {
      const thead = _el('thead');
      const tr = _el('tr');
      tableData.headers.forEach(h => {
        const th = _el('th');
        th.textContent = h;
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    const tbody = _el('tbody');
    (tableData.rows || []).forEach(row => {
      const tr = _el('tr');
      row.forEach(cell => {
        const td = _el('td');
        td.innerHTML = _renderMarkdownLite(String(cell));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* ── copyable summary block ── */
  function _renderCopySummary(summaryText) {
    const wrap = _el('div', 'chat-copy-summary');
    const header = _el('div', 'chat-copy-summary__header');
    header.innerHTML = '📋 <strong>Context for AI Assistant</strong>';
    const copyBtn = _el('button', 'chat-copy-btn');
    copyBtn.textContent = '📋 Copy Summary';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(summaryText).then(() => {
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy Summary'; }, 2000);
      }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = summaryText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copyBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy Summary'; }, 2000);
      });
    });
    header.appendChild(copyBtn);
    wrap.appendChild(header);

    const pre = _el('pre', 'chat-copy-summary__body');
    pre.textContent = summaryText;
    wrap.appendChild(pre);
    return wrap;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  NODE INDEX  ███
     ═══════════════════════════════════════════════════════════════ */

  let _nodeById   = {};  // id → node
  let _nodeByLabel = {}; // lowercase label → [nodes]
  let _inEdges     = {}; // targetId → [edge]
  let _outEdges    = {}; // sourceId → [edge]

  function _buildNodeIndex() {
    _nodeById = {};
    _nodeByLabel = {};
    _inEdges = {};
    _outEdges = {};

    data.nodes.forEach(n => {
      _nodeById[n.id] = n;
      const key = (n.label || '').toLowerCase();
      if (!_nodeByLabel[key]) _nodeByLabel[key] = [];
      _nodeByLabel[key].push(n);
    });
    data.edges.forEach(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      if (!_outEdges[src]) _outEdges[src] = [];
      _outEdges[src].push({ ...e, _src: src, _tgt: tgt });
      if (!_inEdges[tgt]) _inEdges[tgt] = [];
      _inEdges[tgt].push({ ...e, _src: src, _tgt: tgt });
    });
  }

  function _findNode(text) {
    const lower = text.toLowerCase().trim();
    // exact label match
    if (_nodeByLabel[lower]) return _nodeByLabel[lower][0];
    // partial label match
    for (const [key, nodes] of Object.entries(_nodeByLabel)) {
      if (key.includes(lower) || lower.includes(key)) return nodes[0];
    }
    // fuzzy: search in id
    for (const n of data.nodes) {
      if (n.id.toLowerCase().includes(lower)) return n;
    }
    return null;
  }

  function _findNodesBySearch(text) {
    const lower = text.toLowerCase().trim();
    return data.nodes.filter(n =>
      (n.label || '').toLowerCase().includes(lower) ||
      (n.id || '').toLowerCase().includes(lower) ||
      (n.file || '').toLowerCase().includes(lower)
    );
  }

  function _getConnections(nodeId) {
    const callers = (_inEdges[nodeId] || []).map(e => _nodeById[e._src]).filter(Boolean);
    const callees = (_outEdges[nodeId] || []).map(e => _nodeById[e._tgt]).filter(Boolean);
    return { callers, callees };
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  COMMAND HANDLERS  ███
     ═══════════════════════════════════════════════════════════════ */

  /* ── Show a specific route ── */
  function _cmdShowRoute(original, lower) {
    // extract route path — look for /something
    const routeMatch = original.match(/\/[\w\/:.\-{}*+]+/) || original.match(/["']([^"']+)["']/);
    const searchTerm = routeMatch ? (routeMatch[1] || routeMatch[0]) : _extractSubject(lower, ['show me', 'show route', 'trace route', 'route for', 'route']);

    if (!searchTerm) {
      return _cmdListRoutes();
    }

    // look in data.routes first
    const route = data.routes.find(r =>
      (r.path || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.method || '').toLowerCase() + ' ' + (r.path || '').toLowerCase() === searchTerm.toLowerCase()
    );

    if (route) {
      const method = (route.method || 'GET').toUpperCase();
      const pathStr = route.path || searchTerm;
      const middleware = route.middleware || [];
      const handler = route.handler || route.controller || null;
      const functions = route.functions || [];

      let text = `📍 **${method} ${pathStr}**\n\n`;

      // build a path visualization from the route chain
      const pathNodes = [];
      middleware.forEach(mw => {
        const n = _findNode(mw) || { id: mw, label: mw, type: 'middleware' };
        pathNodes.push(n);
      });
      if (handler) {
        const n = _findNode(handler) || { id: handler, label: handler, type: 'function' };
        pathNodes.push(n);
      }
      functions.forEach(fn => {
        const n = _findNode(fn) || { id: fn, label: fn, type: 'function' };
        pathNodes.push(n);
      });

      // stats line
      const mwCount = middleware.length;
      const fnCount = functions.length;
      const fileSet = new Set(pathNodes.map(n => n.file).filter(Boolean));
      text += `${mwCount} middleware → 1 handler → ${fnCount} functions\n`;
      if (fileSet.size > 0) text += `Files affected: ${[...fileSet].map(_basename).join(', ')}`;

      // graph integration
      if (graph && graph.traceRoute) {
        try { graph.traceRoute(pathNodes.map(n => n.id)); } catch (e) { /* silent */ }
      } else if (graph && graph.highlightPath) {
        try { graph.highlightPath(pathNodes.map(n => n.id)); } catch (e) { /* silent */ }
      }

      const summaryText = _buildRouteSummary(method, pathStr, middleware, handler, functions, fileSet);

      _addMessage('bot', text, {
        path: pathNodes,
        actions: [
          { label: '📋 Copy Context for Claude', onClick: () => _copyText(summaryText) },
          { label: '🔍 Trace on Graph', onClick: () => { if (graph && graph.highlightPath) graph.highlightPath(pathNodes.map(n => n.id)); } },
        ],
      });
      return;
    }

    // fallback — search nodes that look like routes
    const routeNodes = data.nodes.filter(n =>
      n.type === 'route' &&
      ((n.label || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
       (n.id || '').toLowerCase().includes(searchTerm.toLowerCase()))
    );

    if (routeNodes.length > 0) {
      _addMessage('bot', `Found **${routeNodes.length}** route node(s) matching "${searchTerm}":`, {
        nodes: routeNodes.slice(0, 10),
      });
      _highlightNodes(routeNodes);
    } else {
      _addMessage('bot', `I couldn't find a route matching **"${_escapeHtml(searchTerm)}"**.\n\nTry \`show all routes\` to see what's available.`);
    }
  }

  /* ── List / compare all routes ── */
  function _cmdListRoutes() {
    if (data.routes.length === 0) {
      // fallback: show route-type nodes
      const routeNodes = data.nodes.filter(n => n.type === 'route');
      if (routeNodes.length === 0) {
        _addMessage('bot', `No routes detected in this codebase. Routes are identified from Express/Fastify/Flask/Django-style patterns.`);
        return;
      }
      _addMessage('bot', `Found **${routeNodes.length}** route nodes:`, { nodes: routeNodes.slice(0, 20) });
      _highlightNodes(routeNodes);
      return;
    }

    const rows = data.routes.map(r => {
      const method = (r.method || 'GET').toUpperCase();
      const path = r.path || '?';
      const handler = r.handler || r.controller || '—';
      const mwCount = (r.middleware || []).length;
      return [method, path, handler, String(mwCount)];
    });

    _addMessage('bot', `🛣️ **${data.routes.length} routes detected:**`, {
      table: {
        headers: ['Method', 'Path', 'Handler', 'MW'],
        rows: rows.slice(0, 30),
      },
    });
  }

  /* ── What calls [function] ── */
  function _cmdCallers(original, lower) {
    const subject = _extractSubject(lower, ['what calls', 'who calls', 'callers of', 'callers for']);
    const node = _findNode(subject);
    if (!node) return _addMessage('bot', `Could not find a symbol matching **"${_escapeHtml(subject)}"**. Try \`find ${subject}\` to search.`);

    const { callers } = _getConnections(node.id);
    if (callers.length === 0) {
      _addMessage('bot', `**${node.label}** has no incoming callers — it may be an entry point or orphan.`, { nodes: [node] });
    } else {
      _addMessage('bot', `**${node.label}** is called by **${callers.length}** symbol(s):`, { nodes: callers.slice(0, 20) });
    }
    _highlightNodes([node, ...callers]);
  }

  /* ── What does [function] call ── */
  function _cmdCallees(original, lower) {
    const subject = _extractSubject(lower, ['what does', 'callees of', 'calls from']);
    const cleaned = subject.replace(/\s*call\s*$/, '').trim();
    const node = _findNode(cleaned);
    if (!node) return _addMessage('bot', `Could not find a symbol matching **"${_escapeHtml(cleaned)}"**. Try \`find ${cleaned}\` to search.`);

    const { callees } = _getConnections(node.id);
    if (callees.length === 0) {
      _addMessage('bot', `**${node.label}** does not call any other tracked symbols — it may be a leaf function.`, { nodes: [node] });
    } else {
      _addMessage('bot', `**${node.label}** calls **${callees.length}** symbol(s):`, { nodes: callees.slice(0, 20) });
    }
    _highlightNodes([node, ...callees]);
  }

  /* ── How does [function] work ── */
  function _cmdExplainFunction(original, lower) {
    const subject = _extractSubject(lower, ['how does', 'explain how']);
    const cleaned = subject.replace(/\s*work\s*$/, '').trim();
    const node = _findNode(cleaned);
    if (!node) return _addMessage('bot', `Could not find **"${_escapeHtml(cleaned)}"**.`);

    const { callers, callees } = _getConnections(node.id);

    let text = `🔬 **${node.label}** (${node.type || 'symbol'})\n\n`;
    if (node.file) text += `📁 File: \`${node.file}\`${node.line ? ' line ' + node.line : ''}\n`;
    text += `📥 Called by: **${callers.length}** symbol(s)\n`;
    text += `📤 Calls: **${callees.length}** symbol(s)\n\n`;

    if (callers.length > 0) {
      text += '**Incoming (callers):**\n';
      callers.slice(0, 8).forEach(c => { text += `• \`${c.label}\` (${c.type})\n`; });
      if (callers.length > 8) text += `• …and ${callers.length - 8} more\n`;
    }
    if (callees.length > 0) {
      text += '\n**Outgoing (calls):**\n';
      callees.slice(0, 8).forEach(c => { text += `• \`${c.label}\` (${c.type})\n`; });
      if (callees.length > 8) text += `• …and ${callees.length - 8} more\n`;
    }

    const summary = _buildNodeSummary(node, callers, callees);

    _addMessage('bot', text, {
      nodes: [node],
      summary,
      actions: [
        { label: '🔍 Focus on Graph', onClick: () => { if (graph && graph.focusNode) graph.focusNode(node.id); } },
      ],
    });
    _highlightNodes([node, ...callers, ...callees]);
  }

  /* ── Dead code / orphan detection ── */
  function _cmdDeadCode() {
    const orphans = data.nodes.filter(n => {
      if (n.type === 'file') return false; // files aren't "dead code"
      const incoming = _inEdges[n.id] || [];
      // A node is an orphan if it has zero incoming edges (nothing references it)
      // except 'defines' edges from its file
      const realIncoming = incoming.filter(e => e.type !== 'defines');
      return realIncoming.length === 0;
    });

    if (orphans.length === 0) {
      _addMessage('bot', `✨ **No dead code detected!** Every symbol has at least one reference. Nice and clean.`);
      return;
    }

    // Group by type
    const byType = {};
    orphans.forEach(n => {
      const t = n.type || 'other';
      if (!byType[t]) byType[t] = [];
      byType[t].push(n);
    });

    let text = `💀 **${orphans.length} potentially dead symbols** (zero incoming references):\n\n`;
    Object.entries(byType).forEach(([type, nodes]) => {
      text += `**${type}** (${nodes.length}):\n`;
      nodes.slice(0, 5).forEach(n => {
        text += `• \`${n.label}\` — ${n.file ? _basename(n.file) : 'unknown file'}\n`;
      });
      if (nodes.length > 5) text += `• …and ${nodes.length - 5} more\n`;
      text += '\n';
    });

    _addMessage('bot', text, {
      nodes: orphans.slice(0, 15),
      actions: [
        { label: '🔍 Highlight All on Graph', onClick: () => _highlightNodes(orphans) },
      ],
    });
    _highlightNodes(orphans);
  }

  /* ── Security issues ── */
  function _cmdSecurity() {
    if (!data.security || data.security.length === 0) {
      _addMessage('bot', `🔒 **No security issues detected** in the scanned patterns.\n\nNote: This is a static pattern scan — it checks for common OWASP patterns like SQL injection, XSS, eval(), hardcoded secrets, etc. It's not a full SAST tool.`);
      return;
    }

    const rows = data.security.slice(0, 20).map(issue => {
      const severity = issue.severity || issue.level || 'medium';
      const icon = severity === 'high' || severity === 'critical' ? '🔴'
                 : severity === 'medium' ? '🟡' : '🟢';
      return [
        `${icon} ${severity.toUpperCase()}`,
        issue.type || issue.rule || '—',
        issue.file ? _basename(issue.file) : '—',
        issue.message || issue.description || '—',
      ];
    });

    _addMessage('bot', `🔒 **${data.security.length} security finding(s):**`, {
      table: {
        headers: ['Severity', 'Type', 'File', 'Detail'],
        rows,
      },
    });
  }

  /* ── Most complex functions ── */
  function _cmdComplexFunctions() {
    // try functionMetrics first
    let metrics = data.functionMetrics;
    if (metrics && metrics.length > 0) {
      const sorted = [...metrics].sort((a, b) =>
        (b.complexity || b.cyclomatic || b.cognitive || 0) -
        (a.complexity || a.cyclomatic || a.cognitive || 0)
      );
      const top = sorted.slice(0, 10);
      const rows = top.map((m, i) => [
        String(i + 1),
        `\`${m.name || m.label || '?'}\``,
        String(m.complexity || m.cyclomatic || m.cognitive || '—'),
        String(m.lines || m.loc || '—'),
        m.file ? _basename(m.file) : '—',
      ]);
      _addMessage('bot', `📐 **Top ${top.length} most complex functions:**`, {
        table: { headers: ['#', 'Function', 'Complexity', 'Lines', 'File'], rows },
      });
      // highlight their nodes
      const ids = top.map(m => m.nodeId || m.id).filter(Boolean);
      const nodes = ids.map(id => _nodeById[id]).filter(Boolean);
      if (nodes.length > 0) _highlightNodes(nodes);
      return;
    }

    // fallback: sort nodes by degree (connectivity = proxy for complexity)
    const fns = data.nodes.filter(n => n.type === 'function' || n.type === 'method');
    const scored = fns.map(n => ({
      node: n,
      score: (_outEdges[n.id] || []).length + (_inEdges[n.id] || []).length,
    })).sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 10);
    const rows = top.map((s, i) => [
      String(i + 1),
      `\`${s.node.label}\``,
      String(s.score) + ' connections',
      s.node.file ? _basename(s.node.file) : '—',
    ]);

    _addMessage('bot', `📐 **Top ${top.length} most-connected functions** (complexity proxy — no metrics data available):`, {
      table: { headers: ['#', 'Function', 'Connectivity', 'File'], rows },
      nodes: top.slice(0, 5).map(s => s.node),
    });
    _highlightNodes(top.map(s => s.node));
  }

  /* ── Impact / blast radius ── */
  function _cmdImpact(original, lower) {
    const subject = _extractSubject(lower, [
      'what would break if i change', 'what would break if i modify',
      'impact of', 'impact of changing', 'blast radius of',
      'what depends on', 'dependents of', 'affect',
    ]);
    if (!subject) {
      _promptImpact();
      return;
    }

    const node = _findNode(subject);
    if (!node) return _addMessage('bot', `Could not find **"${_escapeHtml(subject)}"**. Try \`find ${subject}\`.`);

    // BFS reverse traversal
    const visited = new Set();
    const queue = [node.id];
    const layers = []; // each layer = set of nodes at that BFS depth
    visited.add(node.id);

    while (queue.length > 0 && layers.length < 6) {
      const nextQueue = [];
      const layer = [];
      while (queue.length > 0) {
        const current = queue.shift();
        const incoming = (_inEdges[current] || []);
        incoming.forEach(e => {
          if (!visited.has(e._src)) {
            visited.add(e._src);
            nextQueue.push(e._src);
            const n = _nodeById[e._src];
            if (n) layer.push(n);
          }
        });
      }
      if (layer.length > 0) layers.push(layer);
      queue.push(...nextQueue);
    }

    if (layers.length === 0) {
      _addMessage('bot', `**${node.label}** has no dependents — changing it is low-risk.`, { nodes: [node] });
      return;
    }

    const totalAffected = layers.reduce((s, l) => s + l.length, 0);
    const affectedFiles = new Set();
    layers.forEach(l => l.forEach(n => { if (n.file) affectedFiles.add(n.file); }));

    let text = `💥 **Impact of changing \`${node.label}\`:**\n\n`;
    text += `**${totalAffected}** symbols across **${affectedFiles.size}** files would be affected.\n\n`;

    layers.forEach((layer, depth) => {
      text += `**Depth ${depth + 1}** (${layer.length} symbol${layer.length > 1 ? 's' : ''}):\n`;
      layer.slice(0, 5).forEach(n => {
        text += `• \`${n.label}\` (${n.type}) — ${n.file ? _basename(n.file) : ''}\n`;
      });
      if (layer.length > 5) text += `• …and ${layer.length - 5} more\n`;
      text += '\n';
    });

    if (affectedFiles.size > 0) {
      text += `**Files to review:** ${[...affectedFiles].map(_basename).join(', ')}`;
    }

    const allAffected = layers.flat();
    const summary = _buildImpactSummary(node, layers, affectedFiles);

    _addMessage('bot', text, {
      nodes: allAffected.slice(0, 12),
      summary,
      actions: [
        { label: '🔍 Highlight All', onClick: () => _highlightNodes([node, ...allAffected]) },
      ],
    });

    // try graphApi impact
    if (graph && graph.highlightPath) {
      try { graph.highlightPath([node.id, ...allAffected.map(n => n.id)]); } catch (e) { /* silent */ }
    }
  }

  /* ── Summarize ── */
  function _cmdSummarize(original, lower) {
    const subject = _extractSubject(lower, ['summarize', 'summary of', 'describe', 'overview of']);
    const node = _findNode(subject);
    if (!node) return _addMessage('bot', `Could not find **"${_escapeHtml(subject)}"** to summarize.`);

    const { callers, callees } = _getConnections(node.id);
    const summaryText = _buildNodeSummary(node, callers, callees);

    let text = `📝 **Summary of \`${node.label}\`** (${node.type})\n\n`;
    if (node.file) text += `📁 **File:** \`${node.file}\`${node.line ? ' line ' + node.line : ''}\n`;
    text += `📥 **Incoming:** ${callers.length} callers\n`;
    text += `📤 **Outgoing:** ${callees.length} callees\n`;

    const relatedFiles = new Set();
    [...callers, ...callees].forEach(n => { if (n.file) relatedFiles.add(n.file); });
    if (relatedFiles.size > 0) {
      text += `📂 **Related files:** ${[...relatedFiles].map(_basename).join(', ')}\n`;
    }

    _addMessage('bot', text, {
      nodes: [node],
      summary: summaryText,
      actions: [
        { label: '🔍 Focus on Graph', onClick: () => { if (graph && graph.focusNode) graph.focusNode(node.id); } },
      ],
    });
  }

  /* ── Explain node ── */
  function _cmdExplainNode(original, lower) {
    const subject = _extractSubject(lower, ['explain', 'what is', 'tell me about', 'info on', 'details for']);
    const node = _findNode(subject);
    if (!node) return _addMessage('bot', `Could not find **"${_escapeHtml(subject)}"**.`);

    const { callers, callees } = _getConnections(node.id);

    let text = `ℹ️ **${node.label}**\n\n`;
    text += `• **Type:** ${node.type || 'unknown'}\n`;
    text += `• **ID:** \`${node.id}\`\n`;
    if (node.file) text += `• **File:** \`${node.file}\`\n`;
    if (node.line) text += `• **Line:** ${node.line}\n`;
    if (node.language) text += `• **Language:** ${node.language}\n`;
    text += `• **Incoming edges:** ${callers.length}\n`;
    text += `• **Outgoing edges:** ${callees.length}\n`;

    if (node.code) {
      _addMessage('bot', text, {
        nodes: [node, ...callers.slice(0, 3), ...callees.slice(0, 3)],
        code: node.code,
        actions: [
          { label: '🔍 Focus', onClick: () => { if (graph && graph.focusNode) graph.focusNode(node.id); } },
        ],
      });
    } else {
      _addMessage('bot', text, {
        nodes: [node, ...callers.slice(0, 5), ...callees.slice(0, 5)],
        actions: [
          { label: '🔍 Focus', onClick: () => { if (graph && graph.focusNode) graph.focusNode(node.id); } },
        ],
      });
    }
    _highlightNodes([node]);
  }

  /* ── Find / search ── */
  function _cmdFind(original, lower) {
    const subject = _extractSubject(lower, ['find', 'search', 'search for', 'grep', 'locate', 'where is']);
    if (!subject) {
      _addMessage('bot', `Please tell me what to search for. Example: \`find UserController\``);
      return;
    }

    const matches = _findNodesBySearch(subject);
    if (matches.length === 0) {
      _addMessage('bot', `No symbols found matching **"${_escapeHtml(subject)}"**.`);
      return;
    }

    _addMessage('bot', `🔎 Found **${matches.length}** symbol(s) matching "${_escapeHtml(subject)}":`, {
      nodes: matches.slice(0, 20),
    });
    _highlightNodes(matches);
  }

  /* ── Fallback: suggest queries ── */
  function _suggestQueries(original) {
    // try finding a node that matches any word in the query
    const words = original.split(/\s+/).filter(w => w.length > 2);
    let found = null;
    for (const w of words) {
      found = _findNode(w);
      if (found) break;
    }

    let text = `🤔 I'm not sure how to answer that. Here are some things you can ask:\n\n`;
    text += `• "Show me the /api/users route"\n`;
    text += `• "What calls \`functionName\`?"\n`;
    text += `• "What does \`functionName\` call?"\n`;
    text += `• "How does \`functionName\` work?"\n`;
    text += `• "Show dead code"\n`;
    text += `• "Security issues"\n`;
    text += `• "Most complex functions"\n`;
    text += `• "What would break if I change \`fileName\`?"\n`;
    text += `• "Summarize \`className\`"\n`;
    text += `• "Find \`searchTerm\`"\n`;
    text += `• "Explain \`symbolName\`"`;

    if (found) {
      text += `\n\nI did notice a symbol called **\`${found.label}\`** — did you mean to ask about that?`;
    }

    _addMessage('bot', text, found ? { nodes: [found] } : undefined);
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  SUMMARY BUILDERS  ███
     ═══════════════════════════════════════════════════════════════ */

  function _buildNodeSummary(node, callers, callees) {
    let s = `## ${node.label} (${node.type})\n\n`;
    if (node.file) s += `**File:** ${node.file}${node.line ? ` (line ${node.line})` : ''}\n`;
    s += `**Connections:** ${callers.length} callers, ${callees.length} callees\n\n`;

    if (callers.length > 0) {
      s += `### Callers (incoming)\n`;
      callers.forEach(c => {
        s += `- ${c.label} (${c.type})${c.file ? ' — ' + c.file : ''}\n`;
      });
      s += '\n';
    }
    if (callees.length > 0) {
      s += `### Callees (outgoing)\n`;
      callees.forEach(c => {
        s += `- ${c.label} (${c.type})${c.file ? ' — ' + c.file : ''}\n`;
      });
      s += '\n';
    }
    if (node.code) {
      s += `### Code\n\`\`\`\n${node.code}\n\`\`\`\n`;
    }

    const relatedFiles = new Set();
    [...callers, ...callees].forEach(n => { if (n.file) relatedFiles.add(n.file); });
    if (relatedFiles.size > 0) {
      s += `\n### Related Files\n`;
      [...relatedFiles].forEach(f => { s += `- ${f}\n`; });
    }

    s += `\n---\n_Context generated by AI Mind Map Intelligence Explorer_\n`;
    return s;
  }

  function _buildRouteSummary(method, path, middleware, handler, functions, fileSet) {
    let s = `## Route: ${method} ${path}\n\n`;
    if (middleware.length > 0) {
      s += `### Middleware Chain\n`;
      middleware.forEach((mw, i) => { s += `${i + 1}. ${mw}\n`; });
      s += '\n';
    }
    if (handler) s += `### Handler\n- ${handler}\n\n`;
    if (functions.length > 0) {
      s += `### Functions Called\n`;
      functions.forEach(fn => { s += `- ${fn}\n`; });
      s += '\n';
    }
    if (fileSet && fileSet.size > 0) {
      s += `### Files Affected\n`;
      [...fileSet].forEach(f => { s += `- ${f}\n`; });
    }
    s += `\n---\n_Context generated by AI Mind Map Intelligence Explorer_\n`;
    return s;
  }

  function _buildImpactSummary(node, layers, affectedFiles) {
    let s = `## Impact Analysis: ${node.label} (${node.type})\n\n`;
    if (node.file) s += `**File:** ${node.file}\n`;
    const total = layers.reduce((sum, l) => sum + l.length, 0);
    s += `**Total affected symbols:** ${total}\n`;
    s += `**Total affected files:** ${affectedFiles.size}\n\n`;

    layers.forEach((layer, depth) => {
      s += `### Depth ${depth + 1} (${layer.length} symbols)\n`;
      layer.forEach(n => {
        s += `- ${n.label} (${n.type})${n.file ? ' — ' + n.file : ''}\n`;
      });
      s += '\n';
    });

    if (affectedFiles.size > 0) {
      s += `### Files to Review\n`;
      [...affectedFiles].forEach(f => { s += `- ${f}\n`; });
    }
    s += `\n---\n_Impact analysis generated by AI Mind Map Intelligence Explorer_\n`;
    return s;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  GRAPH INTEGRATION  ███
     ═══════════════════════════════════════════════════════════════ */

  function _highlightNodes(nodes) {
    if (!nodes || nodes.length === 0) return;
    const ids = nodes.map(n => n.id).filter(Boolean);
    if (graph && graph.highlightPath) {
      try { graph.highlightPath(ids); } catch (e) { /* silent */ }
    } else if (graph && graph.focusNode && ids.length === 1) {
      try { graph.focusNode(ids[0]); } catch (e) { /* silent */ }
    }
  }

  function _onGraphNodeClick(event) {
    const detail = event.detail || {};
    const nodeId = detail.nodeId || detail.id;
    if (!nodeId || !_nodeById[nodeId]) return;

    const node = _nodeById[nodeId];
    const { callers, callees } = _getConnections(nodeId);

    let text = `🔗 You clicked **\`${node.label}\`** (${node.type}).\n\n`;
    text += `📥 ${callers.length} caller(s) · 📤 ${callees.length} callee(s)`;
    if (node.file) text += `\n📁 ${_basename(node.file)}`;

    _addMessage('bot', text, {
      nodes: [node],
      actions: [
        { label: '🔬 Explain', onClick: () => handleQuery(`explain ${node.label}`) },
        { label: '💥 Impact', onClick: () => handleQuery(`impact of ${node.label}`) },
        { label: '📝 Summarize', onClick: () => handleQuery(`summarize ${node.label}`) },
      ],
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  EVENT BINDING  ███
     ═══════════════════════════════════════════════════════════════ */

  function _bindEvents() {
    // send on Enter or button click
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _sendInput();
      }
    });
    panel.querySelector('.chat-send-btn').addEventListener('click', _sendInput);

    // listen for graph node clicks
    document.addEventListener('intel-node-click', _onGraphNodeClick);
  }

  function _sendInput() {
    const text = inputEl.value;
    inputEl.value = '';
    handleQuery(text);
    inputEl.focus();
  }

  function _promptImpact() {
    _addMessage('bot', `🔍 Enter the name of a function or file to analyse its impact:`);
    // Temporarily hijack the next send
    const origHandler = handleQuery;
    const oneShot = (text) => {
      // Restore and forward
      handleQuery('what would break if I change ' + text);
    };
    // We'll just use a flag on the input
    const onEnter = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const t = inputEl.value.trim();
        inputEl.value = '';
        inputEl.removeEventListener('keydown', onEnter);
        inputEl.addEventListener('keydown', _defaultEnter);
        if (t) oneShot(t);
      }
    };
    inputEl.removeEventListener('keydown', _defaultEnter);
    inputEl.addEventListener('keydown', onEnter);
    inputEl.focus();
    inputEl.placeholder = 'Type a function or file name…';
    setTimeout(() => { inputEl.placeholder = 'Ask about this codebase…'; }, 15000);
  }

  function _defaultEnter(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _sendInput();
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  HELPERS  ███
     ═══════════════════════════════════════════════════════════════ */

  function _matches(lower, keywords) {
    return keywords.some(k => lower.includes(k));
  }

  function _extractSubject(lower, prefixes) {
    for (const p of prefixes) {
      const idx = lower.indexOf(p);
      if (idx !== -1) {
        let rest = lower.substring(idx + p.length).trim();
        // strip leading "the", "a", "an"
        rest = rest.replace(/^(?:the|a|an)\s+/i, '');
        // strip trailing question mark
        rest = rest.replace(/\?$/, '').trim();
        if (rest) return rest;
      }
    }
    // fallback: return everything after first space
    const parts = lower.split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(' ').replace(/\?$/, '').trim() : '';
  }

  function _typeIcon(type) {
    const icons = {
      function: '🔵', method: '🔵', class: '🟢', file: '📄',
      route: '📍', middleware: '🟡', interface: '🟣',
      component: '🟩', hook: '🔴', constructor: '🟣',
      database: '🔴', test: '⬜', constant: '⚪',
    };
    return icons[type] || '⚫';
  }

  function _basename(filepath) {
    if (!filepath) return '';
    return filepath.split('/').pop();
  }

  function _escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function _el(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function _copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
      _addMessage('bot', '✅ Summary copied to clipboard! Paste it into Claude or ChatGPT for targeted code help.');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      _addMessage('bot', '✅ Summary copied to clipboard!');
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  SCOPED STYLES  ███
     ═══════════════════════════════════════════════════════════════ */

  let _stylesInjected = false;

  function _injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;

    const css = `
/* ── Intel Chat Panel ─────────────────────────────── */
.intel-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-primary, #F7F4F0);
  border-left: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  font-family: 'Geist', system-ui, -apple-system, sans-serif;
  font-size: 14px;
  color: var(--text-primary, #1A1614);
}

/* ── Messages ─────────────────────────────────────── */
.chat-messages {
  flex: 1 1 0%;
  overflow-y: auto;
  padding: 16px;
  scroll-behavior: smooth;
  min-height: 0;
}
.chat-messages::-webkit-scrollbar { width: 5px; }
.chat-messages::-webkit-scrollbar-track { background: transparent; }
.chat-messages::-webkit-scrollbar-thumb { background: var(--border-mid, rgba(26,22,18,0.14)); border-radius: 3px; }

.chat-msg {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  animation: chatFadeIn 0.25s ease;
}
@keyframes chatFadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.chat-msg__avatar {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 16px;
  line-height: 1;
}
.chat-msg--user .chat-msg__avatar {
  background: var(--accent-subtle, rgba(232,97,26,0.08));
}
.chat-msg--bot .chat-msg__avatar {
  background: var(--bg-tertiary, #E4DED6);
}

.chat-msg__body {
  flex: 1;
  min-width: 0;
}

.chat-msg__text {
  line-height: 1.65;
  word-break: break-word;
}
.chat-msg__text strong {
  color: var(--text-primary, #1A1614);
  font-weight: 600;
}
.chat-msg__text ul {
  margin: 6px 0;
  padding-left: 18px;
}
.chat-msg__text li {
  margin-bottom: 3px;
}

.chat-inline-code {
  background: var(--bg-tertiary, #E4DED6);
  color: var(--text-code, #C44D0F);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: 'Geist Mono', monospace;
  font-size: 0.9em;
}

.chat-tree-line {
  display: block;
  font-family: 'Geist Mono', monospace;
  font-size: 0.92em;
  color: var(--text-secondary, #5C5248);
  white-space: pre;
}

/* ── Node Badges ──────────────────────────────────── */
.chat-msg__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.chat-node-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 100px;
  background: var(--bg-secondary, #EDE9E3);
  border: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  font-size: 12px;
  font-family: 'Geist Mono', monospace;
  cursor: pointer;
  transition: all 0.15s ease;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-node-badge:hover {
  background: var(--bg-tertiary, #E4DED6);
  border-color: var(--badge-color, var(--accent-primary, #E8611A));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--badge-color, #E8611A) 20%, transparent);
}
.chat-node-badge__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ── Path Visualization ──────────────────────────── */
.chat-msg__path {
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--bg-secondary, #EDE9E3);
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
}
.chat-path-step {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  font-size: 13px;
}
.chat-tree-char {
  font-family: 'Geist Mono', monospace;
  color: var(--text-muted, #8C8278);
  white-space: pre;
  flex-shrink: 0;
}
.chat-path-file {
  font-size: 11px;
  color: var(--text-muted, #8C8278);
  margin-left: 4px;
}

/* ── Code Snippet ─────────────────────────────────── */
.chat-msg__code {
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--bg-tertiary, #E4DED6);
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  font-family: 'Geist Mono', monospace;
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  max-height: 200px;
  overflow-y: auto;
}
.chat-msg__code code {
  color: var(--text-primary, #1A1614);
}

/* ── Stats Table ──────────────────────────────────── */
.chat-msg__table {
  margin-top: 8px;
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  border: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  border-radius: 8px;
  overflow: hidden;
}
.chat-msg__table th {
  background: var(--bg-tertiary, #E4DED6);
  padding: 6px 10px;
  text-align: left;
  font-weight: 600;
  color: var(--text-primary, #1A1614);
  white-space: nowrap;
}
.chat-msg__table td {
  padding: 5px 10px;
  border-top: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  color: var(--text-secondary, #5C5248);
}
.chat-msg__table tr:hover td {
  background: var(--accent-subtle, rgba(232,97,26,0.04));
}

/* ── Copy Summary Block ──────────────────────────── */
.chat-copy-summary {
  margin-top: 10px;
  border: 1px solid var(--border-mid, rgba(26,22,18,0.14));
  border-radius: 8px;
  overflow: hidden;
}
.chat-copy-summary__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary, #E4DED6);
  font-size: 12px;
}
.chat-copy-btn {
  background: var(--accent-primary, #E8611A);
  color: #fff;
  border: none;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
  font-family: 'Geist', sans-serif;
}
.chat-copy-btn:hover {
  background: var(--accent-hover, #C44D0F);
}
.chat-copy-summary__body {
  padding: 10px 12px;
  background: var(--bg-primary, #F7F4F0);
  font-family: 'Geist Mono', monospace;
  font-size: 11px;
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary, #5C5248);
  line-height: 1.5;
  margin: 0;
}

/* ── Action Buttons ──────────────────────────────── */
.chat-msg__action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.chat-msg__action-btn {
  background: var(--bg-secondary, #EDE9E3);
  border: 1px solid var(--border-mid, rgba(26,22,18,0.14));
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  font-family: 'Geist', sans-serif;
  color: var(--text-primary, #1A1614);
}
.chat-msg__action-btn:hover {
  background: var(--accent-primary, #E8611A);
  color: #fff;
  border-color: var(--accent-primary, #E8611A);
}

/* ── Quick Actions Strip ─────────────────────────── */
.chat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  background: var(--bg-secondary, #EDE9E3);
}
.chat-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  border-radius: 100px;
  background: var(--bg-primary, #F7F4F0);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: 'Geist', sans-serif;
  color: var(--text-secondary, #5C5248);
  white-space: nowrap;
}
.chat-action-btn:hover {
  background: var(--accent-primary, #E8611A);
  color: #fff;
  border-color: var(--accent-primary, #E8611A);
}
.chat-action-btn span {
  font-weight: 500;
}

/* ── Input Area ──────────────────────────────────── */
.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle, rgba(26,22,18,0.08));
  background: var(--bg-primary, #F7F4F0);
}
.chat-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--border-mid, rgba(26,22,18,0.14));
  border-radius: 8px;
  background: var(--bg-input, #fff);
  font-family: 'Geist', sans-serif;
  font-size: 13px;
  color: var(--text-primary, #1A1614);
  outline: none;
  transition: border-color 0.15s;
}
.chat-input::placeholder {
  color: var(--text-muted, #8C8278);
}
.chat-input:focus {
  border-color: var(--accent-primary, #E8611A);
  box-shadow: 0 0 0 3px var(--accent-subtle, rgba(232,97,26,0.08));
}
.chat-send-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: var(--accent-primary, #E8611A);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}
.chat-send-btn:hover {
  background: var(--accent-hover, #C44D0F);
}
.chat-send-btn svg {
  pointer-events: none;
}
`;

    const style = document.createElement('style');
    style.setAttribute('data-intel-chat', '');
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  EXPOSE PUBLIC API  ███
     ═══════════════════════════════════════════════════════════════ */

  return { init, handleQuery, addMessage, destroy };

})();
