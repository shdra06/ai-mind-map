/**
 * AI Mind Map — Codebase X-Ray Engine
 * 
 * Instant health report for any GitHub repo:
 * 1. Fetches + parses code (same pipeline as playground)
 * 2. Runs architectural analysis:
 *    - Circular dependency detection
 *    - God function detection (high fan-out)
 *    - Orphan file detection (zero incoming imports)
 *    - Deep nesting detection
 *    - Coupling & complexity scoring
 * 3. Calculates A-F health grade
 * 4. Renders risk heatmap on D3 graph
 * 5. Displays issues list + shareable report card
 */

(function () {
  'use strict';

  /* ───────────────────────── STATE ───────────────────────── */
  const state = {
    owner: '', repo: '', branch: 'main',
    files: [], nodes: [], edges: [], nodeMap: new Map(),
    issues: [], scores: {}, grade: '?'
  };

  /* ───────────────────────── DOM ───────────────────────── */
  const $ = id => document.getElementById(id);
  const urlInput    = $('xray-url');
  const xrayBtn     = $('xray-btn');
  const progressDiv = $('xray-progress');
  const progressBar = $('xray-progress-bar');
  const progressTxt = $('xray-progress-text');
  const resultsDiv  = $('xray-results');

  if (!urlInput || !xrayBtn) return; // not on homepage

  /* ───────────────────────── CONSTANTS ───────────────────────── */
  const CODE_EXT = new Set(['js','jsx','ts','tsx','py','java','go','rb','rs','c','cpp','h','hpp','cs','php','swift','kt','scala','vue','svelte','lua']);
  const MAX_FILES = 100;
  const MAX_SIZE = 80000;

  /* ───────────────────────── GITHUB API ───────────────────────── */

  function parseUrl(url) {
    const m = url.trim().match(/github\.com\/([^\/]+)\/([^\/\s#?]+)/);
    return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
  }

  async function fetchTree(owner, repo) {
    for (const branch of ['main', 'master', 'develop']) {
      try {
        const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
        if (r.ok) { state.branch = branch; return (await r.json()).tree || []; }
      } catch (e) { /* next */ }
    }
    throw new Error('Cannot access repo. Is it public?');
  }

  async function fetchFile(owner, repo, branch, path) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
      if (!r.ok) return null;
      const t = await r.text();
      return t.length > MAX_SIZE ? t.substring(0, MAX_SIZE) : t;
    } catch { return null; }
  }

  function getLang(path) {
    const ext = path.split('.').pop().toLowerCase();
    const m = { js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',java:'java',go:'go',rb:'ruby',rs:'rust',c:'c',cpp:'cpp',h:'c',hpp:'cpp',cs:'csharp',php:'php',swift:'swift',kt:'kotlin',scala:'scala',vue:'javascript',svelte:'javascript' };
    return m[ext] || ext;
  }

  /* ───────────────────────── PARSER ───────────────────────── */

  function parse(content, lang) {
    const res = { functions: [], classes: [], imports: [], exports: [] };
    const lines = content.split('\n');

    lines.forEach((line, i) => {
      const t = line.trim();
      let m;

      // Functions
      m = t.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/) ||
          t.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/) ||
          t.match(/^(?:async\s+)?def\s+(\w+)\s*\(/) ||
          t.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/) ||
          t.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/) ||
          t.match(/^def\s+(\w+)/);
      if (m && !['if','for','while','switch','catch'].includes(m[1])) {
        res.functions.push({ name: m[1], line: i + 1, code: t });
        return;
      }

      // Methods (JS/TS)
      if (lang === 'javascript' || lang === 'typescript') {
        m = t.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        if (m && !['if','for','while','switch','catch','constructor'].includes(m[1])) {
          res.functions.push({ name: m[1], line: i + 1, code: t, isMethod: true });
          return;
        }
      }

      // Classes / Structs
      m = t.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/) ||
          t.match(/^(?:pub\s+)?struct\s+(\w+)/) ||
          t.match(/^type\s+(\w+)\s+struct/);
      if (m) { res.classes.push({ name: m[1], line: i + 1, code: t }); return; }

      // Imports
      m = t.match(/^import\s+(?:(?:\{[^}]*\}|[\w*]+)\s+from\s+)?['"]([^'"]+)['"]/) ||
          t.match(/(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/) ||
          t.match(/^(?:from\s+([\w.]+)\s+)?import\s+([\w.,\s*]+)/) ||
          t.match(/^use\s+([\w:]+)/) ||
          t.match(/^import\s+([\w.]+)/);
      if (m) { res.imports.push({ module: m[1] || m[2], line: i + 1, code: t }); return; }

      // Exports
      m = t.match(/^export\s+(?:default\s+)?(?:const|let|var|function|class)\s+(\w+)/);
      if (m) res.exports.push({ name: m[1], line: i + 1 });
    });

    return res;
  }

  /* ───────────────────────── GRAPH BUILDER ───────────────────────── */

  function buildGraph() {
    state.nodes = []; state.edges = []; state.nodeMap.clear();

    state.files.forEach(file => {
      const fid = 'f:' + file.path;
      const fn = { id: fid, label: file.path.split('/').pop(), type: 'file', file: file.path, language: file.language, risk: 0 };
      state.nodes.push(fn); state.nodeMap.set(fid, fn);

      file.parsed.functions.forEach(f => {
        const id = fid + ':fn:' + f.name;
        if (state.nodeMap.has(id)) return;
        const n = { id, label: f.name, type: 'function', file: file.path, line: f.line, code: f.code, risk: 0 };
        state.nodes.push(n); state.nodeMap.set(id, n);
        state.edges.push({ source: fid, target: id, type: 'defines' });
      });

      file.parsed.classes.forEach(c => {
        const id = fid + ':cls:' + c.name;
        if (state.nodeMap.has(id)) return;
        const n = { id, label: c.name, type: 'class', file: file.path, line: c.line, code: c.code, risk: 0 };
        state.nodes.push(n); state.nodeMap.set(id, n);
        state.edges.push({ source: fid, target: id, type: 'defines' });
      });

      file.parsed.imports.forEach(imp => {
        const resolved = resolveImport(imp.module, file.path);
        if (resolved) state.edges.push({ source: fid, target: resolved, type: 'imports' });
      });
    });

    // Cross-file calls
    const fnMap = new Map();
    state.nodes.filter(n => n.type === 'function').forEach(n => fnMap.set(n.label, n.id));
    state.files.forEach(file => {
      const fid = 'f:' + file.path;
      fnMap.forEach((fnId, fnName) => {
        if (fnId.startsWith(fid + ':')) return;
        if (new RegExp('\\b' + fnName + '\\s*\\(').test(file.content || ''))
          state.edges.push({ source: fid, target: fnId, type: 'calls' });
      });
    });
  }

  function resolveImport(mod, cur) {
    if (!mod.startsWith('./') && !mod.startsWith('../')) return null;
    const dir = cur.split('/').slice(0, -1).join('/');
    let resolved = mod.startsWith('./') ? dir + mod.substring(1) : (() => { const p = dir.split('/'); p.pop(); return p.join('/') + mod.substring(2); })();
    for (const ext of ['', '.ts', '.js', '.tsx', '.jsx', '.py', '/index.ts', '/index.js']) {
      const c = 'f:' + resolved.replace(/^\//, '') + ext;
      if (state.nodeMap.has(c)) return c;
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  X-RAY ANALYSIS ENGINE  ███
     ═══════════════════════════════════════════════════════════════ */

  function runAnalysis() {
    state.issues = [];
    state.scores = {};

    detectCircularDeps();
    detectGodFunctions();
    detectOrphanFiles();
    detectDeepNesting();
    detectLargeFiles();
    detectMissingExports();
    calculateScores();
    assignRiskToNodes();
  }

  /* --- Circular Dependency Detection --- */
  function detectCircularDeps() {
    // Build adjacency from import edges
    const adj = new Map();
    state.edges.filter(e => e.type === 'imports').forEach(e => {
      const src = typeof e.source === 'string' ? e.source : e.source.id;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      if (!adj.has(src)) adj.set(src, []);
      adj.get(src).push(tgt);
    });

    const visited = new Set(), stack = new Set(), cycles = [];
    function dfs(node, path) {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        if (cycleStart >= 0) cycles.push(path.slice(cycleStart).map(n => n.replace('f:', '')));
        return;
      }
      if (visited.has(node)) return;
      visited.add(node); stack.add(node); path.push(node);
      (adj.get(node) || []).forEach(n => dfs(n, [...path]));
      stack.delete(node);
    }
    adj.forEach((_, node) => dfs(node, []));

    const unique = [];
    const seen = new Set();
    cycles.forEach(c => {
      const key = [...c].sort().join('|');
      if (!seen.has(key)) { seen.add(key); unique.push(c); }
    });

    unique.slice(0, 5).forEach(cycle => {
      state.issues.push({
        severity: 'critical',
        type: 'Circular Dependency',
        icon: '🔄',
        message: `${cycle.map(f => f.split('/').pop()).join(' → ')} → ${cycle[0].split('/').pop()}`,
        files: cycle,
        impact: 'Makes code harder to refactor, causes initialization order bugs, increases coupling'
      });
    });
  }

  /* --- God Function Detection (high fan-out) --- */
  function detectGodFunctions() {
    state.nodes.filter(n => n.type === 'function').forEach(fn => {
      const outgoing = state.edges.filter(e => {
        const src = typeof e.source === 'string' ? e.source : e.source.id;
        return src === fn.id;
      });
      const incoming = state.edges.filter(e => {
        const tgt = typeof e.target === 'string' ? e.target : e.target.id;
        return tgt === fn.id;
      });
      const connections = outgoing.length + incoming.length;
      if (connections >= 6) {
        state.issues.push({
          severity: connections >= 10 ? 'critical' : 'warning',
          type: 'God Function',
          icon: '👹',
          message: `${fn.label}() has ${connections} connections (${incoming.length} in, ${outgoing.length} out)`,
          files: [fn.file],
          impact: 'High coupling makes this function a change bottleneck — modifications here ripple across the codebase'
        });
      }
    });
  }

  /* --- Orphan File Detection --- */
  function detectOrphanFiles() {
    const fileNodes = state.nodes.filter(n => n.type === 'file');
    fileNodes.forEach(fn => {
      const incoming = state.edges.filter(e => {
        const tgt = typeof e.target === 'string' ? e.target : e.target.id;
        return tgt === fn.id && e.type === 'imports';
      });
      const outgoing = state.edges.filter(e => {
        const src = typeof e.source === 'string' ? e.source : e.source.id;
        return src === fn.id && e.type === 'imports';
      });
      const definesAnything = state.edges.filter(e => {
        const src = typeof e.source === 'string' ? e.source : e.source.id;
        return src === fn.id && e.type === 'defines';
      });

      if (incoming.length === 0 && definesAnything.length > 0 && outgoing.length === 0) {
        state.issues.push({
          severity: 'info',
          type: 'Orphan File',
          icon: '👻',
          message: `${fn.file.split('/').pop()} — no files import it and it imports nothing`,
          files: [fn.file],
          impact: 'Possible dead code or missing integration point'
        });
      }
    });
  }

  /* --- Deep Nesting Detection --- */
  function detectDeepNesting() {
    const depths = {};
    state.files.forEach(f => {
      const d = f.path.split('/').length;
      if (d >= 5) {
        const dir = f.path.split('/').slice(0, -1).join('/');
        depths[dir] = (depths[dir] || 0) + 1;
      }
    });
    Object.entries(depths).forEach(([dir, count]) => {
      if (dir.split('/').length >= 5) {
        state.issues.push({
          severity: 'warning',
          type: 'Deep Nesting',
          icon: '📁',
          message: `${dir}/ — ${dir.split('/').length} levels deep (${count} files)`,
          files: [dir],
          impact: 'Deep directory nesting increases cognitive load and navigation difficulty'
        });
      }
    });
  }

  /* --- Large File Detection --- */
  function detectLargeFiles() {
    state.files.forEach(f => {
      const lines = (f.content || '').split('\n').length;
      const fns = f.parsed.functions.length;
      if (lines > 300 || fns > 15) {
        state.issues.push({
          severity: lines > 500 || fns > 25 ? 'critical' : 'warning',
          type: 'Large File',
          icon: '📏',
          message: `${f.path.split('/').pop()} — ${lines} lines, ${fns} functions`,
          files: [f.path],
          impact: 'Large files are harder to maintain, test, and review'
        });
      }
    });
  }

  /* --- Missing Exports --- */
  function detectMissingExports() {
    state.files.forEach(f => {
      if (f.language !== 'javascript' && f.language !== 'typescript') return;
      if (f.parsed.functions.length > 0 && f.parsed.exports.length === 0 && f.parsed.imports.length > 0) {
        state.issues.push({
          severity: 'info',
          type: 'No Exports',
          icon: '📤',
          message: `${f.path.split('/').pop()} has ${f.parsed.functions.length} functions but no exports`,
          files: [f.path],
          impact: 'File defines functions but doesn\'t export them — may be an entry point or dead code'
        });
      }
    });
  }

  /* --- Calculate Scores --- */
  function calculateScores() {
    const totalFiles = state.files.length;
    const totalFns = state.nodes.filter(n => n.type === 'function').length;
    const totalEdges = state.edges.length;

    const critical = state.issues.filter(i => i.severity === 'critical').length;
    const warnings = state.issues.filter(i => i.severity === 'warning').length;
    const infos = state.issues.filter(i => i.severity === 'info').length;

    // Architecture score (circular deps hurt the most)
    const circularCount = state.issues.filter(i => i.type === 'Circular Dependency').length;
    const archScore = Math.max(0, 100 - circularCount * 25 - warnings * 5);

    // Complexity score (god functions + large files)
    const godCount = state.issues.filter(i => i.type === 'God Function').length;
    const largeCount = state.issues.filter(i => i.type === 'Large File').length;
    const complexScore = Math.max(0, 100 - godCount * 15 - largeCount * 10);

    // Coupling score (ratio of edges to nodes — lower is better)
    const couplingRatio = totalFns > 0 ? totalEdges / totalFns : 0;
    const couplingScore = Math.max(0, Math.min(100, 100 - (couplingRatio - 1) * 20));

    // Modularity score (orphans + missing exports)
    const orphanCount = state.issues.filter(i => i.type === 'Orphan File').length;
    const modScore = Math.max(0, 100 - orphanCount * 10 - infos * 5);

    // Overall
    const overall = Math.round(archScore * 0.35 + complexScore * 0.25 + couplingScore * 0.2 + modScore * 0.2);

    state.scores = {
      architecture: Math.round(archScore),
      complexity: Math.round(complexScore),
      coupling: Math.round(couplingScore),
      modularity: Math.round(modScore),
      overall
    };

    // Grade
    if (overall >= 90) state.grade = 'A';
    else if (overall >= 80) state.grade = 'A-';
    else if (overall >= 70) state.grade = 'B+';
    else if (overall >= 60) state.grade = 'B';
    else if (overall >= 50) state.grade = 'C+';
    else if (overall >= 40) state.grade = 'C';
    else if (overall >= 30) state.grade = 'D';
    else state.grade = 'F';
  }

  /* --- Assign Risk to Nodes for Heatmap --- */
  function assignRiskToNodes() {
    // Files in circular deps = critical risk
    const circularFiles = new Set();
    state.issues.filter(i => i.type === 'Circular Dependency').forEach(i => i.files.forEach(f => circularFiles.add(f)));

    // God function files = high risk
    const godFiles = new Set();
    state.issues.filter(i => i.type === 'God Function').forEach(i => i.files.forEach(f => godFiles.add(f)));

    // Large files = medium risk
    const largeFiles = new Set();
    state.issues.filter(i => i.type === 'Large File').forEach(i => i.files.forEach(f => largeFiles.add(f)));

    state.nodes.forEach(n => {
      if (circularFiles.has(n.file) || circularFiles.has(n.file?.replace(/^f:/, ''))) n.risk = 3;
      else if (godFiles.has(n.file)) n.risk = Math.max(n.risk, 2);
      else if (largeFiles.has(n.file)) n.risk = Math.max(n.risk, 1);

      // God functions themselves
      if (n.type === 'function') {
        const conns = state.edges.filter(e => {
          const s = typeof e.source === 'string' ? e.source : e.source.id;
          const t = typeof e.target === 'string' ? e.target : e.target.id;
          return s === n.id || t === n.id;
        }).length;
        if (conns >= 10) n.risk = 3;
        else if (conns >= 6) n.risk = Math.max(n.risk, 2);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  RENDERING  ███
     ═══════════════════════════════════════════════════════════════ */

  function renderResults() {
    resultsDiv.style.display = 'block';

    // Grade
    const gradeEl = $('xray-grade');
    gradeEl.textContent = state.grade;
    gradeEl.className = 'xray-grade-letter grade-' + state.grade.replace(/[+-]/g, '').toLowerCase();

    // Scores
    const scoresEl = $('xray-scores');
    scoresEl.innerHTML = [
      { label: 'Architecture', val: state.scores.architecture, icon: '🏗️' },
      { label: 'Complexity', val: state.scores.complexity, icon: '🧩' },
      { label: 'Coupling', val: state.scores.coupling, icon: '🔗' },
      { label: 'Modularity', val: state.scores.modularity, icon: '📦' },
    ].map(s => `
      <div class="score-row">
        <span class="score-icon">${s.icon}</span>
        <span class="score-label">${s.label}</span>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${s.val}%;background:${scoreColor(s.val)}"></div></div>
        <span class="score-value">${s.val}</span>
      </div>
    `).join('');

    // Stats
    $('xray-stat-files').textContent = state.files.length;
    $('xray-stat-fns').textContent = state.nodes.filter(n => n.type === 'function').length;
    $('xray-stat-classes').textContent = state.nodes.filter(n => n.type === 'class').length;
    $('xray-stat-deps').textContent = state.edges.filter(e => e.type === 'imports').length;
    $('xray-stat-issues').textContent = state.issues.length;
    $('xray-issue-count').textContent = state.issues.length;

    // Issues
    const issuesEl = $('xray-issues');
    const sorted = [...state.issues].sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2 };
      return (sev[a.severity] || 3) - (sev[b.severity] || 3);
    });

    issuesEl.innerHTML = sorted.slice(0, 12).map(issue => `
      <div class="xray-issue xray-issue--${issue.severity}">
        <span class="issue-icon">${issue.icon}</span>
        <div class="issue-content">
          <div class="issue-type">${issue.type}</div>
          <div class="issue-msg">${escapeHtml(issue.message)}</div>
          <div class="issue-impact">${issue.impact}</div>
        </div>
        <span class="issue-severity severity-${issue.severity}">${issue.severity}</span>
      </div>
    `).join('');

    if (state.issues.length === 0) {
      issuesEl.innerHTML = '<div class="xray-clean">✨ No issues found — this codebase is clean!</div>';
    }

    // Heatmap graph
    renderHeatmap();
  }

  function scoreColor(val) {
    if (val >= 80) return '#00b894';
    if (val >= 60) return '#fdcb6e';
    if (val >= 40) return '#e17055';
    return '#d63031';
  }

  function riskColor(risk) {
    if (risk >= 3) return '#d63031';
    if (risk >= 2) return '#e17055';
    if (risk >= 1) return '#fdcb6e';
    return '#00b894';
  }

  /* --- D3 Heatmap Graph --- */
  function renderHeatmap() {
    const container = $('xray-graph');
    if (!container) return;
    container.innerHTML = '';

    const width = container.offsetWidth || 500;
    const height = container.offsetHeight || 350;

    // Only show file + function nodes for readability
    const visNodes = state.nodes.filter(n => n.type === 'file' || n.type === 'function' || n.type === 'class');
    const visIds = new Set(visNodes.map(n => n.id));
    const visEdges = state.edges.filter(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      return visIds.has(s) && visIds.has(t);
    });

    if (typeof d3 === 'undefined') {
      container.innerHTML = '<p style="text-align:center;color:#6B6560;padding:2rem">D3.js not loaded</p>';
      return;
    }

    const svg = d3.select(container).append('svg')
      .attr('width', '100%').attr('height', '100%')
      .attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => g.attr('transform', e.transform)));

    // Links
    const link = g.append('g').selectAll('line').data(visEdges).enter().append('line')
      .attr('stroke', d => d.type === 'imports' ? 'rgba(225,112,85,0.3)' : d.type === 'calls' ? 'rgba(108,92,231,0.3)' : 'rgba(44,37,32,0.08)')
      .attr('stroke-width', 0.8);

    // Nodes
    const node = g.append('g').selectAll('circle').data(visNodes).enter().append('circle')
      .attr('r', d => d.type === 'file' ? 7 : d.type === 'class' ? 6 : 4)
      .attr('fill', d => riskColor(d.risk))
      .attr('stroke', d => d.risk >= 2 ? riskColor(d.risk) : '#fff')
      .attr('stroke-width', d => d.risk >= 2 ? 2 : 1)
      .attr('opacity', 0.9)
      .style('cursor', 'pointer');

    // Pulsing animation for critical nodes
    node.filter(d => d.risk >= 3)
      .attr('class', 'pulse-node');

    // Labels for high-risk nodes only
    const labels = g.append('g').selectAll('text')
      .data(visNodes.filter(n => n.risk >= 2))
      .enter().append('text')
      .text(d => d.label.length > 14 ? d.label.substring(0, 12) + '…' : d.label)
      .attr('font-size', '8px')
      .attr('fill', '#2C2520')
      .attr('font-family', "'JetBrains Mono', monospace")
      .attr('dx', 10).attr('dy', 3);

    // Simulation
    const sim = d3.forceSimulation(visNodes)
      .force('link', d3.forceLink(visEdges).id(d => d.id).distance(35))
      .force('charge', d3.forceManyBody().strength(-40))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(10))
      .on('tick', () => {
        link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('cx', d => d.x).attr('cy', d => d.y);
        labels.attr('x', d => d.x).attr('y', d => d.y);
      });
  }

  function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

  /* ───────────────────────── PIPELINE ───────────────────────── */

  async function startXray() {
    const parsed = parseUrl(urlInput.value);
    if (!parsed) { alert('Invalid GitHub URL'); return; }

    state.owner = parsed.owner; state.repo = parsed.repo;
    state.files = []; state.nodes = []; state.edges = []; state.nodeMap.clear();
    state.issues = []; state.scores = {}; state.grade = '?';

    xrayBtn.disabled = true;
    xrayBtn.textContent = '⏳ Scanning...';
    progressDiv.style.display = 'block';
    resultsDiv.style.display = 'none';

    try {
      progress(5, `Connecting to ${parsed.owner}/${parsed.repo}...`);
      const tree = await fetchTree(parsed.owner, parsed.repo);

      const codeFiles = tree.filter(item => {
        if (item.type !== 'blob') return false;
        const ext = item.path.split('.').pop().toLowerCase();
        if (!CODE_EXT.has(ext)) return false;
        if (/(node_modules|vendor|dist|build|__pycache__|\.min\.|\.lock)/.test(item.path)) return false;
        if (item.size && item.size > MAX_SIZE) return false;
        return true;
      }).slice(0, MAX_FILES);

      progress(10, `Found ${codeFiles.length} code files. Scanning...`);

      // Fetch + parse in batches
      const batchSize = 10;
      for (let i = 0; i < codeFiles.length; i += batchSize) {
        const batch = codeFiles.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async item => {
          const content = await fetchFile(parsed.owner, parsed.repo, state.branch, item.path);
          if (!content) return null;
          const language = getLang(item.path);
          return { path: item.path, content, language, parsed: parse(content, language) };
        }));
        results.forEach(f => { if (f) state.files.push(f); });
        const pct = 10 + Math.round(((i + batch.length) / codeFiles.length) * 60);
        const fns = state.files.reduce((s, f) => s + f.parsed.functions.length, 0);
        progress(pct, `Scanned ${state.files.length}/${codeFiles.length} files — ${fns} functions found`);
      }

      progress(75, 'Building knowledge graph...');
      buildGraph();

      progress(85, 'Running architectural analysis...');
      runAnalysis();

      progress(95, 'Rendering health report...');
      renderResults();

      progress(100, `✅ X-Ray complete — ${state.files.length} files, ${state.issues.length} issues found, Grade: ${state.grade}`);

    } catch (err) {
      progress(0, '❌ ' + err.message);
    } finally {
      xrayBtn.disabled = false;
      xrayBtn.textContent = '🔬 X-Ray This Repo';
    }
  }

  function progress(pct, text) {
    progressBar.style.width = pct + '%';
    progressTxt.textContent = text;
  }

  /* ───────────────────────── EVENTS ───────────────────────── */
  xrayBtn.addEventListener('click', startXray);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') startXray(); });

})();
