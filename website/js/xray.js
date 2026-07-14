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
    issues: [], scores: {}, grade: '?',
    advanced: null // Advanced analysis results
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

  /* ───────────────────────── SMART SUMMARIES ───────────────────────── */

  function generateFunctionSummary(name, ctx) {
    const patterns = [
      { regex: /^(get|fetch|load|read|find|query|search|list|retrieve)/i, desc: 'Retrieves/reads data' },
      { regex: /^(set|update|modify|change|edit|patch)/i, desc: 'Updates/modifies data' },
      { regex: /^(create|add|insert|new|register|save|store|write)/i, desc: 'Creates/adds new data' },
      { regex: /^(delete|remove|destroy|drop|clear|purge)/i, desc: 'Deletes/removes data' },
      { regex: /^(validate|check|verify|assert|ensure|test|is|has|can)/i, desc: 'Validates or checks a condition' },
      { regex: /^(parse|transform|convert|format|serialize|map|reduce)/i, desc: 'Transforms/converts data' },
      { regex: /^(send|emit|dispatch|publish|broadcast|notify|trigger)/i, desc: 'Sends data or triggers an event' },
      { regex: /^(handle|on|process|receive|listen)/i, desc: 'Handles an incoming event or request' },
      { regex: /^(init|setup|configure|bootstrap|mount|connect)/i, desc: 'Initializes or sets up a component' },
      { regex: /^(render|display|show|draw|paint|print)/i, desc: 'Renders or displays output' },
      { regex: /^(auth|login|logout|signup|signin)/i, desc: 'Handles authentication' },
      { regex: /^(log|debug|trace|warn|error)/i, desc: 'Logs information for debugging' },
      { regex: /^(run|execute|start|begin|launch)/i, desc: 'Starts or executes a process' },
      { regex: /^(stop|end|close|shutdown|terminate|disconnect)/i, desc: 'Stops or terminates a process' },
      { regex: /^(build|compile|generate|make)/i, desc: 'Builds or generates output' },
      // ── New patterns ──
      { regex: /^(sort|order|rank|arrange)/i, desc: 'Sorts or orders data' },
      { regex: /^(filter|exclude|reject|omit)/i, desc: 'Filters data by criteria' },
      { regex: /^(merge|combine|concat|join|zip)/i, desc: 'Merges or combines data' },
      { regex: /^(sync|replicate|mirror)/i, desc: 'Synchronizes data between sources' },
      { regex: /^(cache|memoize|remember)/i, desc: 'Caches data for faster access' },
      { regex: /^(encrypt|decrypt|hash|sign|verify)/i, desc: 'Handles encryption or hashing' },
      { regex: /^(compress|decompress|zip|unzip|gzip)/i, desc: 'Compresses or decompresses data' },
      { regex: /^(upload|download|transfer)/i, desc: 'Transfers files or data' },
      { regex: /^(stream|pipe|buffer)/i, desc: 'Streams data through a pipeline' },
      { regex: /^(poll|watch|observe|monitor)/i, desc: 'Monitors or polls for changes' },
      { regex: /^(retry|backoff|recover|fallback)/i, desc: 'Retries or recovers from failure' },
      { regex: /^(debounce|throttle|delay|defer)/i, desc: 'Rate-limits or defers execution' },
      { regex: /^(schedule|cron|queue|enqueue)/i, desc: 'Schedules or queues work' },
      { regex: /^(middleware|intercept|guard|protect)/i, desc: 'Intercepts or guards request flow' },
      { regex: /^(migrate|seed|rollback)/i, desc: 'Manages database migrations' },
      { regex: /^(subscribe|unsubscribe|bind|unbind)/i, desc: 'Manages event subscriptions' },
      { regex: /^(navigate|redirect|route|forward)/i, desc: 'Handles navigation or routing' },
      { regex: /^(normalize|sanitize|escape|clean)/i, desc: 'Sanitizes or normalizes input' },
      { regex: /^(aggregate|summarize|collect|accumulate)/i, desc: 'Aggregates or summarizes data' },
      { regex: /^(clone|copy|duplicate|replicate)/i, desc: 'Creates a copy of data' },
      { regex: /^(compare|diff|match|equals)/i, desc: 'Compares data for differences' },
      { regex: /^(count|total|sum|avg|min|max|mean)/i, desc: 'Calculates a numeric aggregate' },
      { regex: /^(wrap|unwrap|box|unbox)/i, desc: 'Wraps or unwraps a value' },
      { regex: /^(resolve|reject|await|then)/i, desc: 'Handles async promise resolution' },
      { regex: /^(use[A-Z])/i, desc: 'React hook' },
    ];
    const readable = name.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase();
    // Context-aware prefix
    const prefix = ctx && ctx.isRoute ? 'Route handler — ' : ctx && ctx.isMiddleware ? 'Middleware — ' : '';
    for (const p of patterns) {
      if (p.regex.test(name)) return `${prefix}${p.desc} — ${readable}`;
    }
    return `${prefix}Executes the ${readable} operation`;
  }

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
        const n = { id, label: f.name, type: 'function', file: file.path, line: f.line, code: f.code, risk: 0, summary: generateFunctionSummary(f.name) };
        state.nodes.push(n); state.nodeMap.set(id, n);
        state.edges.push({ source: fid, target: id, type: 'defines' });
      });

      file.parsed.classes.forEach(c => {
        const id = fid + ':cls:' + c.name;
        if (state.nodeMap.has(id)) return;
        const n = { id, label: c.name, type: 'class', file: file.path, line: c.line, code: c.code, risk: 0, summary: `Class ${c.name} — defines a data structure or component` };
        state.nodes.push(n); state.nodeMap.set(id, n);
        state.edges.push({ source: fid, target: id, type: 'defines' });
      });

      file.parsed.imports.forEach(imp => {
        const resolved = resolveImport(imp.module, file.path);
        if (resolved) state.edges.push({ source: fid, target: resolved, type: 'imports' });
      });
    });

    // Cross-file calls (skip short/common names to avoid false positives)
    const SKIP_NAMES = new Set(['get','set','run','use','log','map','key','add','put','pop','push','then','next','send','end','call','all','has','new','del','apply','bind','test','exec','ok','go','do','fn','cb','err','res','req','app','db','id','on','off','emit','once','pipe','read','open','close','write','find','sort','join','trim','split','match','type','name','data','list','item','node','self','this','init','main','load','save','show','hide','move','size','stop','play','reset','click','focus','blur','submit','render','update','delete','create','remove','destroy','handle','process','validate','check','parse','format','build','start','configure','connect','disconnect','subscribe','unsubscribe','toString','valueOf','constructor']);
    const fnMap = new Map();
    state.nodes.filter(n => n.type === 'function').forEach(n => {
      if (n.label.length >= 4 && !SKIP_NAMES.has(n.label)) fnMap.set(n.label, n.id);
    });
    state.files.forEach(file => {
      const fid = 'f:' + file.path;
      fnMap.forEach((fnId, fnName) => {
        if (fnId.startsWith(fid + ':')) return;
        if (new RegExp('\\b' + fnName + '\\s*\\(').test(file.content || ''))
          state.edges.push({ source: fid, target: fnId, type: 'calls' });
      });
    });

    // Deduplicate edges
    const edgeKeys = new Set();
    state.edges = state.edges.filter(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      const key = `${s}→${t}:${e.type}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
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

  /* --- God Function Detection (high fan-out = actual complexity) --- */
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
      // Only flag on high fan-OUT (outgoing calls) — high fan-in just means popular, not complex
      // A simple getter called 20 times is NOT a God Function
      const fanOut = outgoing.length;
      const totalConns = outgoing.length + incoming.length;
      if (fanOut >= 8 || totalConns >= 12) {
        state.issues.push({
          severity: totalConns >= 18 ? 'critical' : 'warning',
          type: 'God Function',
          icon: '👹',
          message: `${fn.label}() has ${totalConns} connections (${incoming.length} in, ${outgoing.length} out)`,
          files: [fn.file],
          impact: 'High fan-out makes this function a change bottleneck — consider breaking it into focused helpers'
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

    // Scores — Advanced 12-category breakdown
    const scoresEl = $('xray-scores');
    const scoreItems = state.advanced ? [
      { label: 'Cyclomatic', val: state.scores.cyclomaticComplexity, icon: '🔀', tip: 'McCabe complexity per function' },
      { label: 'Cognitive', val: state.scores.cognitiveComplexity, icon: '🧠', tip: 'SonarSource readability metric' },
      { label: 'Maintain.', val: state.scores.maintainability, icon: '🔧', tip: 'Function size, params, nesting' },
      { label: 'Security', val: state.scores.security, icon: '🔒', tip: 'OWASP pattern detection' },
      { label: 'Modularity', val: state.scores.modularity, icon: '📦', tip: 'File size & function count' },
      { label: 'Coupling', val: state.scores.coupling, icon: '🔗', tip: 'Fan-in/fan-out balance' },
      { label: 'SOLID', val: state.scores.solidCompliance, icon: '⚡', tip: 'SRP & ISP compliance' },
      { label: 'Docs', val: state.scores.documentation, icon: '📝', tip: 'JSDoc coverage & README' },
    ] : [
      { label: 'Architecture', val: state.scores.architecture, icon: '🏗️' },
      { label: 'Complexity', val: state.scores.complexity, icon: '🧩' },
      { label: 'Coupling', val: state.scores.coupling, icon: '🔗' },
      { label: 'Modularity', val: state.scores.modularity, icon: '📦' },
    ];
    scoresEl.innerHTML = scoreItems.map(s => `
      <div class="score-row" ${s.tip ? `title="${s.tip}"` : ''}>
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

    // Issues — group by type for compact display
    const issuesEl = $('xray-issues');
    const sorted = [...state.issues].sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2 };
      return (sev[a.severity] || 3) - (sev[b.severity] || 3);
    });

    // Group issues by type
    const grouped = {};
    sorted.forEach(issue => {
      if (!grouped[issue.type]) {
        grouped[issue.type] = { icon: issue.icon, severity: issue.severity, impact: issue.impact, items: [] };
      }
      // Keep highest severity
      if (issue.severity === 'critical') grouped[issue.type].severity = 'critical';
      const fnName = issue.message.match(/^(\w+)[\(\s—]/)?.[1] || issue.message.split(' — ')[0];
      grouped[issue.type].items.push(fnName);
    });

    const groupKeys = Object.keys(grouped);
    issuesEl.innerHTML = groupKeys.map(type => {
      const g = grouped[type];
      const names = g.items.slice(0, 6).join(', ') + (g.items.length > 6 ? ` +${g.items.length - 6} more` : '');
      return `
        <div class="xray-issue xray-issue--${g.severity}">
          <span class="issue-icon">${g.icon}</span>
          <div class="issue-content">
            <div class="issue-type">${type} <span style="opacity:.6;font-size:0.7rem">(${g.items.length})</span></div>
            <div class="issue-msg" style="font-size:0.72rem">${names}</div>
            <div class="issue-impact">${g.impact}</div>
          </div>
          <span class="issue-severity severity-${g.severity}">${g.severity}</span>
        </div>`;
    }).join('');

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

  /* --- D3 Interactive Risk Heatmap --- */
  let _hmTooltip = null;
  let _hmHighlightActive = false;

  function renderHeatmap() {
    const container = $('xray-graph');
    if (!container) return;
    container.innerHTML = '';

    const width = container.offsetWidth || 500;
    const height = container.offsetHeight || 350;

    // Only show file + function + class nodes
    const visNodes = state.nodes.filter(n => n.type === 'file' || n.type === 'function' || n.type === 'class');
    const visIds = new Set(visNodes.map(n => n.id));
    const visEdges = state.edges.filter(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      return visIds.has(s) && visIds.has(t);
    });

    // Pre-compute connection counts for sizing
    const connCounts = {};
    visEdges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      connCounts[s] = (connCounts[s] || 0) + 1;
      connCounts[t] = (connCounts[t] || 0) + 1;
    });
    visNodes.forEach(n => { n._conns = connCounts[n.id] || 0; });

    if (typeof d3 === 'undefined') {
      container.innerHTML = '<p style="text-align:center;color:#6B6560;padding:2rem">D3.js not loaded</p>';
      return;
    }

    const svg = d3.select(container).append('svg')
      .attr('width', '100%').attr('height', '100%')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .style('cursor', 'grab');

    // Defs for arrows and glow
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'hm-arrow')
      .attr('viewBox', '0 0 10 10').attr('refX', 20).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,0 L10,5 L0,10 Z').attr('fill', 'rgba(49,120,198,0.5)');

    const glow = defs.append('filter').attr('id', 'hm-glow');
    glow.append('feGaussianBlur').attr('stdDeviation', 3).attr('result', 'blur');
    glow.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter()
      .append('feMergeNode').attr('in', d => d);

    const g = svg.append('g');
    const zoom = d3.zoom().scaleExtent([0.15, 5])
      .on('zoom', e => g.attr('transform', e.transform))
      .on('start', () => svg.style('cursor', 'grabbing'))
      .on('end', () => svg.style('cursor', 'grab'));
    svg.call(zoom);

    // Build adjacency for highlight
    const adjOut = {}, adjIn = {};
    visEdges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      (adjOut[s] = adjOut[s] || []).push(t);
      (adjIn[t] = adjIn[t] || []).push(s);
    });

    // Edge styles
    const edgeStroke = d => {
      if (d.type === 'imports') return 'rgba(149,165,166,0.35)';
      if (d.type === 'calls')   return 'rgba(49,120,198,0.35)';
      return 'rgba(44,37,32,0.12)';
    };
    const edgeDash = d => {
      if (d.type === 'imports') return '4,3';
      if (d.type === 'defines') return '2,2';
      return null;
    };

    // Links
    const link = g.append('g').attr('class', 'hm-links')
      .selectAll('line').data(visEdges).enter().append('line')
      .attr('stroke', edgeStroke)
      .attr('stroke-dasharray', edgeDash)
      .attr('stroke-width', d => d.type === 'calls' ? 1.2 : 0.8)
      .attr('marker-end', d => d.type === 'calls' ? 'url(#hm-arrow)' : null);

    // Node radius based on connections
    function nodeRadius(d) {
      const base = d.type === 'file' ? 7 : d.type === 'class' ? 6 : 4;
      return base + Math.min(d._conns * 0.8, 10);
    }

    // Shape path for each node type
    function nodeShape(d) {
      const r = nodeRadius(d);
      if (d.type === 'file') {
        // Rounded square
        const s = r * 0.85;
        return `M${-s},${-s} L${s},${-s} L${s},${s} L${-s},${s} Z`;
      } else if (d.type === 'class') {
        // Diamond
        return `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`;
      }
      // Circle (function) — use polygon approximation
      const pts = [];
      for (let i = 0; i < 16; i++) {
        const a = (2 * Math.PI * i) / 16;
        pts.push(`${Math.cos(a) * r},${Math.sin(a) * r}`);
      }
      return `M${pts.join(' L')} Z`;
    }

    // Nodes
    const nodeGroup = g.append('g').attr('class', 'hm-nodes');
    const nodeEls = nodeGroup.selectAll('g').data(visNodes).enter().append('g')
      .attr('class', 'hm-node')
      .style('cursor', 'pointer');

    nodeEls.append('path')
      .attr('d', nodeShape)
      .attr('fill', d => riskColor(d.risk))
      .attr('stroke', d => d.risk >= 2 ? '#fff' : riskColor(d.risk))
      .attr('stroke-width', d => d.risk >= 2 ? 2 : 1)
      .attr('opacity', 0.9)
      .attr('filter', d => d.risk >= 3 ? 'url(#hm-glow)' : null);

    // Pulsing for critical
    nodeEls.filter(d => d.risk >= 3).select('path').attr('class', 'pulse-node');

    // Labels — show for risk >= 1 or high connections
    const labelData = visNodes.filter(n => n.risk >= 2 || n._conns >= 4);
    const labels = g.append('g').attr('class', 'hm-labels')
      .selectAll('text').data(labelData).enter().append('text')
      .text(d => {
        const name = d.label || '';
        return name.length > 16 ? name.substring(0, 14) + '…' : name;
      })
      .attr('font-size', '7.5px')
      .attr('fill', '#2C2520')
      .attr('font-family', "'Geist Mono', 'JetBrains Mono', monospace")
      .attr('text-anchor', 'start')
      .attr('pointer-events', 'none')
      .attr('opacity', 0.85)
      .attr('dx', d => nodeRadius(d) + 4)
      .attr('dy', 3);

    // ─── Drag ───
    const drag = d3.drag()
      .on('start', (ev, d) => {
        if (!ev.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
        svg.style('cursor', 'grabbing');
      })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => {
        if (!ev.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
        svg.style('cursor', 'grab');
      });
    nodeEls.call(drag);

    // ─── Tooltip ───
    if (!_hmTooltip) {
      _hmTooltip = document.createElement('div');
      _hmTooltip.className = 'hm-tooltip';
      document.body.appendChild(_hmTooltip);
    }
    const typeIcons = { file: '📄', function: 'ƒ', class: '◆' };

    nodeEls
      .on('mouseover', (ev, d) => {
        const icon = typeIcons[d.type] || '●';
        const riskLabel = d.risk >= 3 ? '🔴 Critical' : d.risk >= 2 ? '🟠 Warning' : d.risk >= 1 ? '🟡 Low' : '🟢 Healthy';
        const fileName = (d.file || '').split('/').pop();
        const inCount = (adjIn[d.id] || []).length;
        const outCount = (adjOut[d.id] || []).length;
        _hmTooltip.innerHTML =
          `<strong>${icon} ${d.label}</strong>` +
          (d.summary ? `\n<span style="color:#E8611A;font-style:italic;font-size:11px">${d.summary}</span>` : '') +
          `\n<span style="opacity:.6;font-size:10px">${d.type} · ${fileName} · ${riskLabel}</span>` +
          `\n<span style="opacity:.6;font-size:10px">${inCount}↙ in · ${outCount}↗ out · ${d._conns} total</span>`;
        _hmTooltip.style.opacity = '1';
        _hmTooltip.style.left = (ev.pageX + 14) + 'px';
        _hmTooltip.style.top = (ev.pageY + 14) + 'px';

        // Soft highlight on hover (if no click-focus active)
        if (!_hmHighlightActive) {
          d3.select(ev.currentTarget).select('path')
            .attr('filter', 'url(#hm-glow)');
        }
      })
      .on('mousemove', (ev) => {
        if (!_hmTooltip) return;
        let x = ev.pageX + 14, y = ev.pageY + 14;
        const r = _hmTooltip.getBoundingClientRect();
        if (x + r.width > window.innerWidth) x = ev.pageX - r.width - 14;
        if (y + r.height > window.innerHeight) y = ev.pageY - r.height - 14;
        _hmTooltip.style.left = x + 'px';
        _hmTooltip.style.top = y + 'px';
      })
      .on('mouseout', (ev, d) => {
        _hmTooltip.style.opacity = '0';
        if (!_hmHighlightActive) {
          d3.select(ev.currentTarget).select('path')
            .attr('filter', d.risk >= 3 ? 'url(#hm-glow)' : null);
        }
      });

    // ─── Click to highlight connections ───
    nodeEls.on('click', (ev, d) => {
      ev.stopPropagation();
      _hmHighlightActive = true;

      const connected = new Set([d.id]);
      (adjOut[d.id] || []).forEach(id => connected.add(id));
      (adjIn[d.id] || []).forEach(id => connected.add(id));

      nodeEls.transition().duration(300)
        .attr('opacity', n => connected.has(n.id) ? 1 : 0.1);
      nodeEls.select('path')
        .attr('filter', n => n.id === d.id ? 'url(#hm-glow)' : null);
      labels.transition().duration(300)
        .attr('opacity', n => connected.has(n.id) ? 1 : 0.05);
      link.transition().duration(300)
        .attr('opacity', e => {
          const s = typeof e.source === 'string' ? e.source : e.source.id;
          const t = typeof e.target === 'string' ? e.target : e.target.id;
          return (s === d.id || t === d.id) ? 1 : 0.04;
        })
        .attr('stroke-width', e => {
          const s = typeof e.source === 'string' ? e.source : e.source.id;
          const t = typeof e.target === 'string' ? e.target : e.target.id;
          return (s === d.id || t === d.id) ? 2.5 : 0.8;
        });
    });

    // Click background to clear
    svg.on('click', () => {
      if (!_hmHighlightActive) return;
      _hmHighlightActive = false;
      nodeEls.transition().duration(300).attr('opacity', 1);
      nodeEls.select('path').attr('filter', d => d.risk >= 3 ? 'url(#hm-glow)' : null);
      labels.transition().duration(300).attr('opacity', 0.85);
      link.transition().duration(300)
        .attr('opacity', 1).attr('stroke-width', d => d.type === 'calls' ? 1.2 : 0.8);
    });

    // ─── Simulation ───
    const nc = visNodes.length;
    const chargeStr = nc > 80 ? -180 : nc > 40 ? -120 : -80;
    const linkDist = nc > 80 ? 70 : nc > 40 ? 55 : 40;

    const sim = d3.forceSimulation(visNodes)
      .force('link', d3.forceLink(visEdges).id(d => d.id).distance(linkDist).strength(0.4))
      .force('charge', d3.forceManyBody().strength(chargeStr).distanceMax(400))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 6).strength(0.7))
      .on('tick', () => {
        link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        nodeEls.attr('transform', d => `translate(${d.x},${d.y})`);
        labels.attr('x', d => d.x).attr('y', d => d.y);
      });

    // Auto-zoom to fit after settling
    sim.on('end', () => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      visNodes.forEach(n => {
        if (n.x != null) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); }
        if (n.y != null) { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
      });
      const pad = 40;
      const gw = (maxX - minX) + pad * 2;
      const gh = (maxY - minY) + pad * 2;
      if (gw <= 0 || gh <= 0) return;
      const scale = Math.min(width / gw, height / gh, 1.5) * 0.85;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const tx = width / 2 - cx * scale;
      const ty = height / 2 - cy * scale;
      svg.transition().duration(800)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
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

      progress(80, 'Running architectural analysis...');
      runAnalysis();

      progress(85, 'Running advanced metrics (ISO 25010, McCabe, Halstead)...');
      if (window.AdvancedXRay) {
        state.advanced = window.AdvancedXRay.runAdvancedAnalysis(state.files, state.nodes, state.edges);
        // Override scores with advanced scores
        state.scores = state.advanced.scores;
        state.grade = state.advanced.scores.grade;
      }

      progress(92, 'Rendering health report...');
      renderResults();

      progress(97, 'Building deep analysis...');
      renderDeepAnalysis();

      // === CODEBASE INTELLIGENCE EXPLORER ===
      progress(98, '🧬 Building Codebase Intelligence...');
      initIntelExplorer();

      progress(100, `✅ X-Ray complete — ${state.files.length} files, ${state.issues.length + (state.advanced ? state.advanced.security.length : 0)} findings, Grade: ${state.grade}`);

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

  /* ═══════════════════════════════════════════════════════════════
     ███  DEEP ANALYSIS  ███
     ═══════════════════════════════════════════════════════════════ */

  function renderDeepAnalysis() {
    const deepEl = $('xray-deep');
    if (!deepEl) return;
    deepEl.style.display = 'block';

    renderLanguages();
    renderTopFunctions();
    renderDependencies();
    renderFileSizes();
    renderRefactorings();
    
    // Advanced analysis renderers
    if (state.advanced) {
      renderComplexityDist();
      renderSecurityFindings();
      renderDocHealth();
      renderTechDebt();
      renderStandards();
    }
  }

  /* --- Language Distribution (inline with stats) --- */
  function renderLanguages() {
    const el = $('xray-langs');
    const wrapper = $('xray-lang-inline');
    if (!el) return;

    const langCounts = {};
    state.files.forEach(f => {
      const lang = f.language || 'other';
      langCounts[lang] = (langCounts[lang] || 0) + 1;
    });

    const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
    const total = state.files.length;
    const langColors = { typescript: '#3178C6', javascript: '#F7DF1E', python: '#3776AB', go: '#00ADD8', ruby: '#CC342D', rust: '#DEA584', java: '#B07219', csharp: '#68217A', php: '#777BB4', swift: '#F05138', kotlin: '#A97BFF', scala: '#DC322F', html: '#E34C26', css: '#563D7C', shell: '#89E051', markdown: '#083FA1', json: '#292929', yaml: '#CB171E', other: '#6B6560' };

    el.innerHTML = sorted.slice(0, 6).map(([lang, count]) => {
      const pct = Math.round((count / total) * 100);
      const color = langColors[lang] || langColors.other;
      return `<div class="lang-row-inline">
        <span class="lang-dot" style="background:${color}"></span>
        <span class="lang-name-inline">${lang}</span>
        <div class="lang-bar-track-inline"><div class="lang-bar-fill-inline" style="width:${pct}%;background:${color}"></div></div>
        <span class="lang-pct-inline">${pct}%</span>
        <span class="lang-count-inline">${count} files</span>
      </div>`;
    }).join('');

    if (wrapper) wrapper.style.display = 'block';
  }

  /* --- Top Connected Functions --- */
  function renderTopFunctions() {
    const el = $('xray-top-fns');
    if (!el) return;

    const fnConnections = [];
    state.nodes.filter(n => n.type === 'function').forEach(fn => {
      const conns = state.edges.filter(e => {
        const s = typeof e.source === 'string' ? e.source : e.source.id;
        const t = typeof e.target === 'string' ? e.target : e.target.id;
        return s === fn.id || t === fn.id;
      }).length;
      fnConnections.push({ name: fn.label, file: fn.file, conns, risk: fn.risk });
    });

    fnConnections.sort((a, b) => b.conns - a.conns);

    el.innerHTML = `<table class="fn-table">
      <thead><tr><th>#</th><th>Function</th><th>File</th><th>Connections</th></tr></thead>
      <tbody>${fnConnections.slice(0, 10).map((f, i) => `
        <tr class="${f.risk >= 2 ? 'fn-row--risky' : ''}">
          <td class="fn-rank">${i + 1}</td>
          <td class="fn-name">${escapeHtml(f.name)}()</td>
          <td class="fn-file">${f.file.split('/').pop()}</td>
          <td class="fn-conns"><span class="conn-badge ${f.conns >= 6 ? 'conn-high' : ''}">${f.conns}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  }

  /* --- Dependency Analysis --- */
  function renderDependencies() {
    const el = $('xray-deps');
    if (!el) return;

    const external = new Map();
    const internalCount = { total: 0 };
    const mostImported = new Map(); // file → count of files that import it

    state.files.forEach(f => {
      f.parsed.imports.forEach(imp => {
        const mod = imp.module || '';
        if (mod.startsWith('./') || mod.startsWith('../') || mod.startsWith('/')) {
          internalCount.total++;
        } else if (mod && !mod.startsWith('#')) {
          const pkg = mod.split('/')[0].startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
          external.set(pkg, (external.get(pkg) || 0) + 1);
        }
      });
    });

    // Find most-imported internal files
    state.edges.filter(e => e.type === 'imports').forEach(e => {
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      if (tgt.startsWith('f:')) {
        const file = tgt.replace('f:', '');
        mostImported.set(file, (mostImported.get(file) || 0) + 1);
      }
    });

    const sortedExt = [...external.entries()].sort((a, b) => b[1] - a[1]);
    const sortedInternal = [...mostImported.entries()].sort((a, b) => b[1] - a[1]);

    el.innerHTML = `
      <div class="dep-section">
        <div class="dep-label">External Packages</div>
        <div class="dep-tags">${sortedExt.length === 0 ? '<span class="dep-none">None detected</span>' :
          sortedExt.slice(0, 12).map(([pkg, count]) => `<span class="dep-tag">${escapeHtml(pkg)} <span class="dep-tag-count">×${count}</span></span>`).join('')}
        </div>
      </div>
      <div class="dep-section">
        <div class="dep-label">Internal Imports</div>
        <div class="dep-stat">${internalCount.total} cross-file imports</div>
      </div>
      <div class="dep-section">
        <div class="dep-label">Most Imported Files</div>
        ${sortedInternal.slice(0, 5).map(([file, count]) => `
          <div class="dep-hot-file">
            <span class="dep-hot-name">${file.split('/').pop()}</span>
            <span class="dep-hot-count">${count} files depend on this</span>
          </div>
        `).join('') || '<span class="dep-none">No internal imports detected</span>'}
      </div>
    `;
  }

  /* --- File Size Distribution --- */
  function renderFileSizes() {
    const el = $('xray-sizes');
    if (!el) return;

    const buckets = [
      { label: '< 50 lines', min: 0, max: 50, count: 0, color: '#00b894' },
      { label: '50–150 lines', min: 50, max: 150, count: 0, color: '#fdcb6e' },
      { label: '150–300 lines', min: 150, max: 300, count: 0, color: '#e17055' },
      { label: '300+ lines', min: 300, max: Infinity, count: 0, color: '#d63031' },
    ];

    state.files.forEach(f => {
      const lines = (f.content || '').split('\n').length;
      for (const b of buckets) { if (lines >= b.min && lines < b.max) { b.count++; break; } }
    });

    const maxCount = Math.max(...buckets.map(b => b.count), 1);

    el.innerHTML = buckets.map(b => {
      const pct = Math.round((b.count / maxCount) * 100);
      const warn = b.min >= 300 && b.count > 0;
      return `<div class="size-row">
        <span class="size-label">${b.label}</span>
        <div class="size-bar-track"><div class="size-bar-fill" style="width:${pct}%;background:${b.color}"></div></div>
        <span class="size-count ${warn ? 'size-warn' : ''}">${b.count} files${warn ? ' ⚠️' : ''}</span>
      </div>`;
    }).join('');
  }

  /* --- Refactoring Recommendations --- */
  function renderRefactorings() {
    const el = $('xray-refactors');
    if (!el) return;

    const recs = [];

    // Based on issues — group into single compact entries
    const godFunctions = state.issues.filter(i => i.type === 'God Function');
    if (godFunctions.length > 0) {
      const names = godFunctions.map(i => i.message.match(/^(\w+)\(/)?.[1] || '?').join(', ');
      recs.push({
        priority: 'high',
        icon: '🔴',
        title: `Split ${godFunctions.length} God Function${godFunctions.length > 1 ? 's' : ''}`,
        detail: `${names} — have too many connections. Break into focused helpers with single responsibilities.`,
        file: godFunctions[0].files[0]
      });
    }

    const circular = state.issues.filter(i => i.type === 'Circular Dependency');
    if (circular.length > 0) {
      recs.push({
        priority: 'high',
        icon: '🔴',
        title: `Break ${circular.length} circular dependency cycle${circular.length > 1 ? 's' : ''}`,
        detail: `Extract shared types into separate files. Consider dependency injection or event-driven patterns.`,
        file: circular[0].files[0]
      });
    }

    const largeFiles = state.issues.filter(i => i.type === 'Large File');
    if (largeFiles.length > 0) {
      const names = largeFiles.map(i => i.files[0]?.split('/').pop()).join(', ');
      recs.push({
        priority: 'medium',
        icon: '🟡',
        title: `Decompose ${largeFiles.length} large file${largeFiles.length > 1 ? 's' : ''}`,
        detail: `${names} — group related functions into feature-specific modules. Aim for files under 200 lines.`,
        file: largeFiles[0].files[0]
      });
    }

    const orphans = state.issues.filter(i => i.type === 'Orphan File');
    if (orphans.length > 0) {
      recs.push({
        priority: 'low',
        icon: '🟢',
        title: `Review ${orphans.length} orphan file${orphans.length > 1 ? 's' : ''}`,
        detail: `These files aren't imported by anything. Either entry points (fine), dead code (delete), or missing integration.`,
        file: orphans[0].files[0]
      });
    }

    if (state.scores.coupling < 50) {
      recs.push({
        priority: 'medium',
        icon: '🟡',
        title: 'Reduce overall coupling',
        detail: `Coupling score is ${state.scores.coupling}/100. Introduce interfaces/abstractions between modules.`,
      });
    }

    if (recs.length === 0) {
      recs.push({ priority: 'low', icon: '✨', title: 'Codebase looks healthy!', detail: 'No critical refactoring needed. Keep writing clean code.' });
    }

    el.innerHTML = recs.map(r => `
      <div class="refactor-item refactor--${r.priority}">
        <span class="refactor-icon">${r.icon}</span>
        <div class="refactor-content">
          <div class="refactor-title">${r.title}</div>
          <div class="refactor-detail">${r.detail}</div>
          ${r.file ? `<div class="refactor-file">📄 ${r.file.split('/').pop()}</div>` : ''}
        </div>
        <span class="refactor-priority priority-${r.priority}">${r.priority}</span>
      </div>
    `).join('');
  }

  /* === ADVANCED RENDERING === */

  /* --- Complexity Distribution (McCabe + Cognitive) --- */
  function renderComplexityDist() {
    const el = $('xray-complexity');
    if (!el || !state.advanced) return;
    
    const fm = state.advanced.functionMetrics;
    const ccBuckets = [
      { label: '1–10 (Simple)', min: 1, max: 10, count: 0, color: '#00b894' },
      { label: '11–20 (Moderate)', min: 11, max: 20, count: 0, color: '#fdcb6e' },
      { label: '21–50 (High)', min: 21, max: 50, count: 0, color: '#e17055' },
      { label: '50+ (Critical)', min: 51, max: Infinity, count: 0, color: '#d63031' }
    ];
    fm.forEach(f => { for (const b of ccBuckets) { if (f.cyclomaticComplexity >= b.min && f.cyclomaticComplexity <= b.max) { b.count++; break; } } });
    const maxB = Math.max(...ccBuckets.map(b => b.count), 1);
    
    const s = state.advanced.summary;
    el.innerHTML = `
      <div class="metric-summary">
        <div class="metric-stat"><span class="metric-val">${s.avgCyclomaticComplexity}</span><span class="metric-lbl">Avg McCabe CC</span></div>
        <div class="metric-stat"><span class="metric-val">${s.avgCognitiveComplexity}</span><span class="metric-lbl">Avg Cognitive</span></div>
        <div class="metric-stat"><span class="metric-val">${s.criticalFunctions}</span><span class="metric-lbl">Critical Fns</span></div>
        <div class="metric-stat"><span class="metric-val">${s.avgLinesPerFunction}</span><span class="metric-lbl">Avg Lines/Fn</span></div>
      </div>
      <div class="metric-label">Cyclomatic Complexity Distribution</div>
      ${ccBuckets.map(b => `<div class="size-row">
        <span class="size-label">${b.label}</span>
        <div class="size-bar-track"><div class="size-bar-fill" style="width:${Math.round((b.count/maxB)*100)}%;background:${b.color}"></div></div>
        <span class="size-count">${b.count}</span>
      </div>`).join('')}
    `;
  }

  /* --- Security Findings (OWASP) --- */
  function renderSecurityFindings() {
    const el = $('xray-security');
    if (!el || !state.advanced) return;
    
    const findings = state.advanced.security;
    if (findings.length === 0) {
      el.innerHTML = '<div class="security-clean">✅ No security issues detected. OWASP patterns clean.</div>';
      return;
    }
    
    const critCount = findings.filter(f => f.severity === 'critical').length;
    const warnCount = findings.filter(f => f.severity === 'warning').length;
    const infoCount = findings.filter(f => f.severity === 'info').length;
    
    el.innerHTML = `
      <div class="metric-summary">
        <div class="metric-stat"><span class="metric-val" style="color:#d63031">${critCount}</span><span class="metric-lbl">Critical</span></div>
        <div class="metric-stat"><span class="metric-val" style="color:#e17055">${warnCount}</span><span class="metric-lbl">Warning</span></div>
        <div class="metric-stat"><span class="metric-val" style="color:#6B6560">${infoCount}</span><span class="metric-lbl">Info</span></div>
      </div>
      ${findings.slice(0, 8).map(f => `
        <div class="sec-finding sec-finding--${f.severity}">
          <span class="sec-sev severity-${f.severity}">${f.severity}</span>
          <div class="sec-content">
            <span class="sec-cat">${f.category}</span>
            <span class="sec-file">${f.file.split('/').pop()} (×${f.count})</span>
          </div>
        </div>
      `).join('')}
      <div class="sec-impact">${findings[0].impact}</div>
    `;
  }

  /* --- Documentation Health --- */
  function renderDocHealth() {
    const el = $('xray-dochealth');
    if (!el || !state.advanced) return;
    
    const doc = state.advanced.documentation;
    const checks = [
      { name: 'README.md', ok: doc.hasReadme },
      { name: 'LICENSE', ok: doc.hasLicense },
      { name: 'CONTRIBUTING.md', ok: doc.hasContributing },
      { name: 'CHANGELOG.md', ok: doc.hasChangelog }
    ];
    
    el.innerHTML = `
      <div class="metric-summary">
        <div class="metric-stat"><span class="metric-val">${doc.score}/100</span><span class="metric-lbl">Doc Score</span></div>
        <div class="metric-stat"><span class="metric-val">${doc.docCoverage}%</span><span class="metric-lbl">JSDoc Coverage</span></div>
        <div class="metric-stat"><span class="metric-val">${doc.avgCommentDensity}%</span><span class="metric-lbl">Comment Density</span></div>
      </div>
      <div class="doc-coverage-bar">
        <div class="doc-bar-label">JSDoc Coverage: ${doc.documentedFunctions}/${doc.totalFunctions} functions</div>
        <div class="size-bar-track"><div class="size-bar-fill" style="width:${doc.docCoverage}%;background:${doc.docCoverage > 50 ? '#00b894' : doc.docCoverage > 20 ? '#fdcb6e' : '#d63031'}"></div></div>
      </div>
      <div class="doc-checks">
        ${checks.map(c => `<span class="doc-check ${c.ok ? 'doc-check--pass' : 'doc-check--fail'}">${c.ok ? '✅' : '❌'} ${c.name}</span>`).join('')}
      </div>
    `;
  }

  /* --- Technical Debt (Halstead + SQALE) --- */
  function renderTechDebt() {
    const el = $('xray-techdebt');
    if (!el || !state.advanced) return;
    
    const h = state.advanced.halstead;
    const s = state.advanced.scores;
    const debtGrade = s.techDebtRatio <= 5 ? 'A' : s.techDebtRatio <= 10 ? 'B' : s.techDebtRatio <= 20 ? 'C' : s.techDebtRatio <= 50 ? 'D' : 'E';
    
    el.innerHTML = `
      <div class="metric-summary">
        <div class="metric-stat"><span class="metric-val">${s.techDebtRatio}%</span><span class="metric-lbl">Debt Ratio (${debtGrade})</span></div>
        <div class="metric-stat"><span class="metric-val">${h.bugs}</span><span class="metric-lbl">Predicted Bugs</span></div>
        <div class="metric-stat"><span class="metric-val">${h.time}m</span><span class="metric-lbl">Dev Effort (min)</span></div>
      </div>
      <div class="halstead-grid">
        <div class="halstead-item"><span class="halstead-label">Volume</span><span class="halstead-val">${h.volume.toLocaleString()}</span></div>
        <div class="halstead-item"><span class="halstead-label">Difficulty</span><span class="halstead-val">${h.difficulty.toLocaleString()}</span></div>
        <div class="halstead-item"><span class="halstead-label">Effort</span><span class="halstead-val">${h.effort.toLocaleString()}</span></div>
        <div class="halstead-item"><span class="halstead-label">Bugs (V/3000)</span><span class="halstead-val">${h.bugs}</span></div>
      </div>
      <div class="debt-scale">
        <span class="debt-grade debt-${debtGrade.toLowerCase()}">${debtGrade}</span>
        <span class="debt-explain">${debtGrade === 'A' ? 'Excellent — debt under 5%' : debtGrade === 'B' ? 'Good — manageable debt' : debtGrade === 'C' ? 'Moderate — needs attention' : 'High — significant refactoring needed'}</span>
      </div>
    `;
  }

  /* --- Standards Compliance --- */
  function renderStandards() {
    const el = $('xray-standards');
    if (!el || !state.advanced) return;
    
    const s = state.advanced.scores;
    const sm = state.advanced.summary;
    
    const standards = [
      { name: 'ISO 25010 Maintainability', score: s.maintainability, desc: 'Modularity, analyzability, modifiability, testability', icon: '📐' },
      { name: 'ISO 25010 Reliability', score: Math.max(0, 100 - sm.criticalFunctions * 10), desc: 'Maturity, fault tolerance based on critical function count', icon: '🛡️' },
      { name: 'ISO 25010 Security', score: s.security, desc: 'OWASP pattern detection, hardcoded secrets, injection risks', icon: '🔒' },
      { name: 'CISQ Maintainability', score: Math.round((s.cyclomaticComplexity + s.cognitiveComplexity + s.maintainability) / 3), desc: 'Automated source code quality per ISO/IEC 5055', icon: '⚙️' },
      { name: 'Clean Code (R.C. Martin)', score: s.solidCompliance, desc: 'SRP + ISP compliance, function size, parameter count', icon: '✨' },
      { name: 'McCabe Testability', score: s.cyclomaticComplexity, desc: 'Cyclomatic complexity thresholds (NIST: max 10/function)', icon: '🧪' },
      { name: 'SonarQube SQALE', score: Math.max(0, 100 - s.techDebtRatio * 2), desc: 'Technical debt ratio method (A ≤5%, B ≤10%, C ≤20%)', icon: '📊' },
      { name: 'DRY Compliance', score: s.duplication, desc: 'Code duplication under 3% (SonarQube gate)', icon: '🔄' }
    ];
    
    el.innerHTML = standards.map(std => `
      <div class="standard-item">
        <div class="standard-header">
          <span class="standard-icon">${std.icon}</span>
          <span class="standard-name">${std.name}</span>
          <span class="standard-score" style="color:${scoreColor(std.score)}">${std.score}/100</span>
        </div>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${std.score}%;background:${scoreColor(std.score)}"></div></div>
        <div class="standard-desc">${std.desc}</div>
      </div>
    `).join('');
  }

  /* --- Download Report as Markdown --- */
  /* ═══════════════════════════════════════════════════════════════
     ███  CODEBASE INTELLIGENCE EXPLORER  ███
     ═══════════════════════════════════════════════════════════════ */

  function initIntelExplorer() {
    const explorerEl = $('intel-explorer');
    if (!explorerEl || !window.CodebaseIntel) return;
    
    try {
      // Build enriched graph with route/API/DB detection
      const intelData = window.CodebaseIntel.buildIntelGraph(state.files, state.nodes, state.edges);
      
      // Show the explorer
      explorerEl.style.display = 'block';
      
      // Render stats bar
      const statsEl = $('intel-stats');
      if (statsEl) {
        statsEl.innerHTML = `
          <div class="intel-stat">📁 <span class="intel-stat-val">${intelData.stats.totalNodes}</span> nodes</div>
          <div class="intel-stat">🔗 <span class="intel-stat-val">${intelData.stats.totalEdges}</span> edges</div>
          <div class="intel-stat">🛣️ <span class="intel-stat-val">${intelData.stats.routes}</span> routes</div>
          <div class="intel-stat">🔌 <span class="intel-stat-val">${intelData.stats.apiCalls}</span> API calls</div>
          <div class="intel-stat">💾 <span class="intel-stat-val">${intelData.stats.dbQueries}</span> DB queries</div>
        `;
      }
      
      // Initialize D3 graph
      const graphContainer = $('intel-graph');
      if (graphContainer && window.IntelGraph) {
        window.IntelGraph.init(graphContainer, intelData);
      }
      
      // Initialize Chat
      const chatContainer = $('intel-chat');
      if (chatContainer && window.IntelChat) {
        const advancedData = state.advanced || {};
        window.IntelChat.init(chatContainer, {
          ...intelData,
          functionMetrics: advancedData.functionMetrics || [],
          fileMetrics: advancedData.fileMetrics || [],
          security: advancedData.security || [],
          documentation: advancedData.documentation || {},
          scores: advancedData.scores || state.scores,
          summary: advancedData.summary || {}
        }, window.IntelGraph);
      }
      
      // Wire filter buttons
      document.querySelectorAll('.filter-btn[data-type]').forEach(btn => {
        btn.addEventListener('click', () => {
          btn.classList.toggle('active');
          const activeTypes = Array.from(document.querySelectorAll('.filter-btn.active[data-type]'))
            .map(b => b.dataset.type);
          if (window.IntelGraph && window.IntelGraph.filterByType) {
            window.IntelGraph.filterByType(activeTypes);
          }
        });
      });
      
      // Wire search
      const searchInput = $('intel-search');
      if (searchInput) {
        let searchTimeout;
        searchInput.addEventListener('input', () => {
          clearTimeout(searchTimeout);
          searchTimeout = setTimeout(() => {
            const query = searchInput.value.trim().toLowerCase();
            if (!query) {
              if (window.IntelGraph) window.IntelGraph.clearHighlight();
              return;
            }
            const matches = intelData.nodes
              .filter(n => n.label.toLowerCase().includes(query) || (n.file || '').toLowerCase().includes(query))
              .map(n => n.id);
            if (matches.length > 0 && window.IntelGraph) {
              window.IntelGraph.highlightPath(matches);
              if (matches.length === 1) window.IntelGraph.focusNode(matches[0]);
            }
          }, 250);
        });
      }
      
      // Listen for node selection from graph
      document.addEventListener('intel-node-select', (e) => {
        if (window.IntelChat && e.detail) {
          window.IntelChat.handleQuery(`explain ${e.detail.label}`);
        }
      });
      
    } catch (err) {
      console.warn('Intel Explorer init failed:', err);
    }
  }

  /* ───────────────────────── WIKI EXPORT ───────────────────────── */

  function generateWiki() {
    const date = new Date().toISOString().split('T')[0];
    const fns = state.nodes.filter(n => n.type === 'function');
    const classes = state.nodes.filter(n => n.type === 'class');
    const routes = state.nodes.filter(n => n.type === 'route');
    const dbOps = state.nodes.filter(n => n.type === 'db-query');
    const apiCalls = state.nodes.filter(n => n.type === 'api-call');
    const middleware = state.nodes.filter(n => n.type === 'middleware');
    const files = state.nodes.filter(n => n.type === 'file');

    // Lang distribution
    const langCounts = {};
    state.files.forEach(f => { langCounts[f.language] = (langCounts[f.language] || 0) + 1; });
    const langLines = Object.entries(langCounts).sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `| ${lang} | ${count} | ${Math.round((count / state.files.length) * 100)}% |`);

    // Entry points
    const entryPatterns = /^(index|main|app|server|__init__|mod)\.(ts|js|tsx|jsx|py|go|rs)$/i;
    const entryFiles = state.files.filter(f => entryPatterns.test(f.path.split('/').pop()));

    // Build route table
    const routeRows = routes.map(r => {
      const callees = state.edges.filter(e => {
        const s = typeof e.source === 'string' ? e.source : e.source.id;
        return s === r.id;
      }).map(e => {
        const tid = typeof e.target === 'string' ? e.target : e.target.id;
        return state.nodeMap.get(tid);
      }).filter(Boolean);
      const handlers = callees.filter(c => c.type === 'function').map(c => c.label).join(', ');
      const dbCalls = callees.filter(c => c.type === 'db-query').map(c => c.label).join(', ');
      const mw = callees.filter(c => c.type === 'middleware').map(c => c.label).join(', ');
      return `| \`${r.label}\` | ${r.file ? r.file.split('/').pop() : ''} | ${handlers || '—'} | ${mw || '—'} | ${dbCalls || '—'} |`;
    });

    // Build function table (top 30 by connections)
    const fnConns = fns.map(fn => {
      const inEdges = state.edges.filter(e => (typeof e.target === 'string' ? e.target : e.target.id) === fn.id).length;
      const outEdges = state.edges.filter(e => (typeof e.source === 'string' ? e.source : e.source.id) === fn.id).length;
      return { ...fn, inEdges, outEdges, total: inEdges + outEdges };
    }).sort((a, b) => b.total - a.total);

    const fnRows = fnConns.slice(0, 40).map(fn =>
      `| \`${fn.label}\` | ${fn.file ? fn.file.split('/').pop() : ''} | ${fn.summary || generateFunctionSummary(fn.label)} | ${fn.inEdges}↙ ${fn.outEdges}↗ |`
    );

    // DB operations grouped
    const dbGroups = {};
    dbOps.forEach(op => {
      const key = op.file ? op.file.split('/').pop() : 'unknown';
      (dbGroups[key] = dbGroups[key] || []).push(op.label);
    });
    const dbRows = Object.entries(dbGroups).map(([file, ops]) =>
      `| ${file} | ${ops.join(', ')} |`
    );

    // Scores table
    const scoreKeys = Object.keys(state.scores).filter(k => k !== 'grade' && k !== 'overall');
    const scoreRows = scoreKeys.map(k => `| ${k} | ${state.scores[k]}/100 |`);

    const lines = [
      `# 📖 ${state.owner}/${state.repo} — Codebase Wiki`,
      ``,
      `> Auto-generated on ${date} by [AI Mind Map X-Ray](https://ai-mind-map-website.vercel.app)`,
      ``,
      `## 📊 Overview`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Grade | **${state.grade}** |`,
      `| Files | ${state.files.length} |`,
      `| Functions | ${fns.length} |`,
      `| Classes | ${classes.length} |`,
      `| Routes | ${routes.length} |`,
      `| DB Operations | ${dbOps.length} |`,
      `| API Calls | ${apiCalls.length} |`,
      `| Middleware | ${middleware.length} |`,
      `| Issues | ${state.issues.length} |`,
      ``,
      `## 🔢 Scores`,
      ``,
      `| Metric | Score |`,
      `|--------|-------|`,
      ...scoreRows,
      `| **Overall** | **${state.scores.overall}/100** |`,
      ``,
      `## 🌐 Languages`,
      ``,
      `| Language | Files | % |`,
      `|----------|-------|---|`,
      ...langLines,
    ];

    // Entry points
    if (entryFiles.length > 0) {
      lines.push(``, `## ⚡ Entry Points`, ``);
      entryFiles.forEach(f => lines.push(`- \`${f.path}\``));
    }

    // Routes
    if (routeRows.length > 0) {
      lines.push(
        ``, `## 🔹 Route Map`, ``,
        `| Route | File | Handlers | Middleware | DB Calls |`,
        `|-------|------|----------|------------|----------|`,
        ...routeRows,
      );
    }

    // Functions
    if (fnRows.length > 0) {
      lines.push(
        ``, `## ƒ Function Dictionary (top ${Math.min(fnConns.length, 40)})`, ``,
        `| Function | File | Summary | Connections |`,
        `|----------|------|---------|-------------|`,
        ...fnRows,
      );
    }

    // DB Operations
    if (dbRows.length > 0) {
      lines.push(
        ``, `## 🗄 Database Operations`, ``,
        `| File | Operations |`,
        `|------|------------|`,
        ...dbRows,
      );
    }

    // API Calls
    if (apiCalls.length > 0) {
      lines.push(``, `## 🌐 External API Calls`, ``);
      apiCalls.forEach(a => lines.push(`- \`${a.label}\` — ${a.file ? a.file.split('/').pop() : ''}`));
    }

    // Issues
    if (state.issues.length > 0) {
      lines.push(
        ``, `## ⚠️ Issues`, ``,
        `| Severity | Type | Details |`,
        `|----------|------|---------|`,
        ...state.issues.map(i => `| ${i.severity} | ${i.type} | ${i.message} |`),
      );
    }

    // File dependency map (top 15 most-imported files)
    const importCounts = {};
    state.edges.filter(e => e.type === 'imports').forEach(e => {
      const tid = typeof e.target === 'string' ? e.target : e.target.id;
      importCounts[tid] = (importCounts[tid] || 0) + 1;
    });
    const topImported = Object.entries(importCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([id, count]) => {
        const node = state.nodeMap.get(id);
        return node ? `| \`${node.label}\` | ${count} | ${node.file || ''} |` : null;
      })
      .filter(Boolean);
    if (topImported.length > 0) {
      lines.push(
        ``, `## 📦 Most-Imported Modules`, ``,
        `| Module | Imported By | File |`,
        `|--------|-------------|------|`,
        ...topImported,
      );
    }

    lines.push('', '---', `*Generated by [AI Mind Map Codebase X-Ray](https://ai-mind-map-website.vercel.app/repo/${state.owner}/${state.repo})*`);
    return lines.join('\n');
  }

  function downloadReport() {
    const md = generateWiki();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wiki-${state.owner}-${state.repo}-${new Date().toISOString().split('T')[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyWiki() {
    const md = generateWiki();
    navigator.clipboard.writeText(md).then(() => {
      const btn = $('xray-copy-wiki');
      if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = '📋 Copy Wiki'; }, 2000); }
    });
  }

  /* ───────────────────────── PR IMPACT VIEW ───────────────────────── */

  function parsePrUrl(url) {
    const m = url.trim().match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], pr: parseInt(m[3]) } : null;
  }

  async function fetchPrFiles(owner, repo, pr) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/files`);
    if (!r.ok) throw new Error(`Cannot fetch PR #${pr}. Is it public?`);
    return r.json();
  }

  async function startPrImpact() {
    const url = urlInput.value;
    const prInfo = parsePrUrl(url);
    if (!prInfo) {
      // Check if URL has ?pr= param
      const params = new URLSearchParams(window.location.search);
      const prNum = params.get('pr');
      if (!prNum) { alert('Enter a GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)'); return; }
    }

    const info = prInfo || { owner: state.owner, repo: state.repo, pr: parseInt(new URLSearchParams(window.location.search).get('pr')) };

    // If we haven't scanned yet, do the full scan first
    if (!state.files.length) {
      urlInput.value = `https://github.com/${info.owner}/${info.repo}`;
      await startXray();
    }

    progress(95, `🔀 Fetching PR #${info.pr} diff...`);
    try {
      const prFiles = await fetchPrFiles(info.owner, info.repo, info.pr);
      const changedPaths = new Set(prFiles.map(f => f.filename));

      // Find affected nodes
      const affectedNodeIds = new Set();
      state.nodes.forEach(n => {
        if (n.file && changedPaths.has(n.file)) affectedNodeIds.add(n.id);
      });

      // Also find downstream affected (nodes called by affected nodes)
      const downstream = new Set();
      state.edges.forEach(e => {
        const s = typeof e.source === 'string' ? e.source : e.source.id;
        const t = typeof e.target === 'string' ? e.target : e.target.id;
        if (affectedNodeIds.has(s)) downstream.add(t);
        if (affectedNodeIds.has(t)) downstream.add(s);
      });

      // Count affected by type
      const affectedNodes = state.nodes.filter(n => affectedNodeIds.has(n.id));
      const affectedRoutes = affectedNodes.filter(n => n.type === 'route');
      const affectedFns = affectedNodes.filter(n => n.type === 'function');
      const affectedDb = affectedNodes.filter(n => n.type === 'db-query');

      const summary = [
        `🔀 **PR #${info.pr} Impact Analysis**`,
        `Files changed: ${prFiles.length}`,
        `Nodes directly affected: ${affectedNodeIds.size}`,
        `Downstream ripple: ${downstream.size} more nodes`,
        affectedRoutes.length ? `Routes affected: ${affectedRoutes.map(r => r.label).join(', ')}` : '',
        affectedFns.length ? `Functions modified: ${affectedFns.length}` : '',
        affectedDb.length ? `DB operations touched: ${affectedDb.map(d => d.label).join(', ')}` : '',
      ].filter(Boolean).join('\n');

      // Show summary in progress
      progress(100, `✅ PR #${info.pr}: ${prFiles.length} files → ${affectedNodeIds.size} nodes affected, ${downstream.size} downstream`);

      // Mark affected nodes with special risk for heatmap
      state.nodes.forEach(n => {
        if (affectedNodeIds.has(n.id)) n.risk = Math.max(n.risk || 0, 3);
        else if (downstream.has(n.id)) n.risk = Math.max(n.risk || 0, 2);
      });

      // Re-render heatmap to show impact
      renderHeatmap();

      // Add PR summary to Intel chat if available
      if (window.IntelChat) {
        window.IntelChat.handleQuery(`summarize`);
      }

    } catch (err) {
      progress(100, `❌ PR fetch failed: ${err.message}`);
    }
  }

  /* ───────────────────────── EVENTS ───────────────────────── */
  xrayBtn.addEventListener('click', () => {
    // Auto-detect if it's a PR URL
    if (parsePrUrl(urlInput.value)) {
      startPrImpact();
    } else {
      startXray();
    }
  });
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      if (parsePrUrl(urlInput.value)) startPrImpact();
      else startXray();
    }
  });

  const dlBtn = $('xray-download');
  if (dlBtn) dlBtn.addEventListener('click', downloadReport);

  const copyBtn = $('xray-copy-wiki');
  if (copyBtn) copyBtn.addEventListener('click', copyWiki);

  const prBtn = $('xray-pr-btn');
  if (prBtn) prBtn.addEventListener('click', startPrImpact);

  /* ───────────────────────── URL AUTO-LOAD ───────────────────────── */
  (function autoLoad() {
    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get('repo');
    if (repoParam) {
      // /repo/owner/name → ?repo=owner/name
      urlInput.value = `https://github.com/${repoParam}`;
      // Scroll to xray section
      const xraySection = document.getElementById('xray');
      if (xraySection) xraySection.scrollIntoView({ behavior: 'smooth' });
      // Auto-start with a short delay for page to settle
      setTimeout(() => {
        const prParam = params.get('pr');
        if (prParam) {
          startPrImpact();
        } else {
          startXray();
        }
      }, 500);
    }
  })();

})();
