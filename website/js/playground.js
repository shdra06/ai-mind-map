/**
 * AI Mind Map — Live Playground
 * 
 * Indexes any public GitHub repo in real-time:
 * 1. Fetches file tree via GitHub API
 * 2. Downloads each file via raw.githubusercontent.com
 * 3. Parses functions, classes, imports with regex
 * 4. Builds a D3 force-directed knowledge graph
 * 5. Provides a chat interface to query the indexed graph
 */

(function () {
  'use strict';

  /* ───────────────────────── STATE ───────────────────────── */
  const state = {
    owner: '',
    repo: '',
    branch: 'main',
    files: [],           // { path, content, language }
    nodes: [],           // { id, label, type, file, line, code }
    edges: [],           // { source, target, type }
    nodeMap: new Map(),   // id → node
    indexing: false,
    indexed: false
  };

  /* ───────────────────────── DOM REFS ───────────────────────── */
  const $ = id => document.getElementById(id);
  const urlInput    = $('repo-url-input');
  const indexBtn    = $('index-btn');
  const progressSec = $('progress-section');
  const progressBar = $('progress-bar');
  const progressTxt = $('progress-text');
  const statsBar    = $('stats-bar');
  const fileTree    = $('file-tree');
  const graphEl     = $('graph-container');
  const nodeDetail  = $('node-detail');
  const chatMessages= $('chat-messages');
  const chatInput   = $('chat-input');
  const chatSend    = $('chat-send');

  /* ───────────────────────── CONSTANTS ───────────────────────── */
  const CODE_EXTENSIONS = new Set([
    'js','jsx','ts','tsx','py','java','go','rb','rs','c','cpp','h','hpp',
    'cs','php','swift','kt','scala','vue','svelte','lua','sh','bash','zsh',
    'yaml','yml','json','toml','xml','html','css','scss','less','sql','md'
  ]);
  const MAX_FILES = 120;
  const MAX_FILE_SIZE = 100000; // 100KB per file

  const NODE_COLORS = {
    file:     '#E8611A',
    function: '#00b894',
    class:    '#6c5ce7',
    method:   '#a29bfe',
    import:   '#fdcb6e',
    export:   '#e17055',
    variable: '#74b9ff',
    module:   '#fd79a8'
  };

  /* ───────────────────────── GITHUB API ───────────────────────── */

  function parseGitHubUrl(url) {
    const match = url.trim().match(/github\.com\/([^\/]+)\/([^\/\s#?]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
  }

  async function fetchRepoTree(owner, repo) {
    // Try main, then master
    for (const branch of ['main', 'master']) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
        );
        if (res.ok) {
          state.branch = branch;
          const data = await res.json();
          return data.tree || [];
        }
      } catch (e) { /* try next */ }
    }
    throw new Error('Could not fetch repository. Make sure it is a public repo.');
  }

  async function fetchFileContent(owner, repo, branch, path) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > MAX_FILE_SIZE ? text.substring(0, MAX_FILE_SIZE) : text;
  }

  function getLanguage(path) {
    const ext = path.split('.').pop().toLowerCase();
    const langMap = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', java: 'java', go: 'go', rb: 'ruby', rs: 'rust',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
      vue: 'javascript', svelte: 'javascript', lua: 'lua'
    };
    return langMap[ext] || ext;
  }

  /* ───────────────────────── PARSER ───────────────────────── */

  function parseFile(path, content, language) {
    const results = { functions: [], classes: [], imports: [], exports: [], variables: [] };

    switch (language) {
      case 'javascript':
      case 'typescript':
        parseJavaScript(content, results);
        break;
      case 'python':
        parsePython(content, results);
        break;
      case 'java':
      case 'kotlin':
      case 'csharp':
        parseJavaLike(content, results);
        break;
      case 'go':
        parseGo(content, results);
        break;
      case 'ruby':
        parseRuby(content, results);
        break;
      case 'rust':
        parseRust(content, results);
        break;
      default:
        parseGeneric(content, results);
    }
    return results;
  }

  function parseJavaScript(content, results) {
    const lines = content.split('\n');

    lines.forEach((line, i) => {
      const trimmed = line.trim();

      // Function declarations: function name(
      let m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      // Arrow / const functions: const name = (...) => or const name = function
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      // Class declarations
      m = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      // Method definitions inside classes
      m = trimmed.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
      if (m && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while' && m[1] !== 'switch' && m[1] !== 'catch') {
        results.functions.push({ name: m[1], line: i + 1, code: trimmed, isMethod: true });
        return;
      }

      // ES6 imports
      m = trimmed.match(/^import\s+(?:(?:\{[^}]*\}|[\w*]+)\s+from\s+)?['"]([^'"]+)['"]/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); return; }

      // CommonJS require
      m = trimmed.match(/(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); return; }

      // Exports
      m = trimmed.match(/^export\s+(?:default\s+)?(?:const|let|var|function|class)\s+(\w+)/);
      if (m) { results.exports.push({ name: m[1], line: i + 1 }); }
    });
  }

  function parsePython(content, results) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();

      let m = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      m = trimmed.match(/^class\s+(\w+)/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      m = trimmed.match(/^(?:from\s+([\w.]+)\s+)?import\s+([\w.,\s*]+)/);
      if (m) { results.imports.push({ module: m[1] || m[2].trim(), line: i + 1, code: trimmed }); return; }
    });
  }

  function parseJavaLike(content, results) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();

      let m = trimmed.match(/^(?:public|private|protected|static|final|abstract|\s)*(?:[\w<>\[\]]+)\s+(\w+)\s*\([^)]*\)\s*(?:\{|throws)/);
      if (m && m[1] !== 'if' && m[1] !== 'for' && m[1] !== 'while') {
        results.functions.push({ name: m[1], line: i + 1, code: trimmed });
        return;
      }

      m = trimmed.match(/^(?:public|private|protected|abstract|static|\s)*class\s+(\w+)/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      m = trimmed.match(/^import\s+([\w.]+)/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); }
    });
  }

  function parseGo(content, results) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();

      let m = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      m = trimmed.match(/^type\s+(\w+)\s+struct/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }

      m = trimmed.match(/^import\s+(?:\(\s*)?["']([^"']+)["']/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); }
    });
  }

  function parseRuby(content, results) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      let m = trimmed.match(/^def\s+(\w+)/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }
      m = trimmed.match(/^class\s+(\w+)/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }
      m = trimmed.match(/^require\s+['"]([^'"]+)['"]/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); }
    });
  }

  function parseRust(content, results) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      let m = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }
      m = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }
      m = trimmed.match(/^use\s+([\w:]+)/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); }
    });
  }

  function parseGeneric(content, results) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      let m = trimmed.match(/^(?:(?:pub|public|private|protected|static|async|export)\s+)*(?:function|def|fn|func)\s+(\w+)/);
      if (m) { results.functions.push({ name: m[1], line: i + 1, code: trimmed }); return; }
      m = trimmed.match(/^(?:(?:pub|public|private|protected|abstract|static|export)\s+)*(?:class|struct|interface|enum|type)\s+(\w+)/);
      if (m) { results.classes.push({ name: m[1], line: i + 1, code: trimmed }); return; }
      m = trimmed.match(/^(?:import|require|use|from|include)\s+['"]?([^'";\s]+)/);
      if (m) { results.imports.push({ module: m[1], line: i + 1, code: trimmed }); }
    });
  }

  /* ───────────────────────── GRAPH BUILDER ───────────────────────── */

  function buildGraph() {
    state.nodes = [];
    state.edges = [];
    state.nodeMap.clear();

    const dirNodes = new Map();

    state.files.forEach(file => {
      const fileId = 'file:' + file.path;

      // Create directory nodes
      const parts = file.path.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        const dirId = 'dir:' + dirPath;
        if (!dirNodes.has(dirId)) {
          const dirNode = { id: dirId, label: parts[i], type: 'module', file: dirPath };
          dirNodes.set(dirId, dirNode);
          state.nodes.push(dirNode);
          state.nodeMap.set(dirId, dirNode);

          // Link to parent dir
          if (i > 0) {
            const parentId = 'dir:' + parts.slice(0, i).join('/');
            state.edges.push({ source: parentId, target: dirId, type: 'contains' });
          }
        }
      }

      // File node
      const fileNode = {
        id: fileId, label: parts[parts.length - 1], type: 'file',
        file: file.path, language: file.language,
        functions: file.parsed.functions.length,
        classes: file.parsed.classes.length,
        imports: file.parsed.imports.length
      };
      state.nodes.push(fileNode);
      state.nodeMap.set(fileId, fileNode);

      // Link file to parent directory
      if (parts.length > 1) {
        const parentDir = 'dir:' + parts.slice(0, -1).join('/');
        state.edges.push({ source: parentDir, target: fileId, type: 'contains' });
      }

      // Function nodes
      file.parsed.functions.forEach(fn => {
        const fnId = fileId + ':fn:' + fn.name;
        if (state.nodeMap.has(fnId)) return;
        const fnNode = { id: fnId, label: fn.name, type: 'function', file: file.path, line: fn.line, code: fn.code };
        state.nodes.push(fnNode);
        state.nodeMap.set(fnId, fnNode);
        state.edges.push({ source: fileId, target: fnId, type: 'defines' });
      });

      // Class nodes
      file.parsed.classes.forEach(cls => {
        const clsId = fileId + ':cls:' + cls.name;
        if (state.nodeMap.has(clsId)) return;
        const clsNode = { id: clsId, label: cls.name, type: 'class', file: file.path, line: cls.line, code: cls.code };
        state.nodes.push(clsNode);
        state.nodeMap.set(clsId, clsNode);
        state.edges.push({ source: fileId, target: clsId, type: 'defines' });
      });

      // Import edges — resolve to file nodes if possible
      file.parsed.imports.forEach(imp => {
        const resolved = resolveImport(imp.module, file.path);
        if (resolved) {
          state.edges.push({ source: fileId, target: resolved, type: 'imports' });
        }
      });
    });

    // Cross-file function call detection
    const allFunctions = new Map();
    state.nodes.filter(n => n.type === 'function').forEach(fn => {
      allFunctions.set(fn.label, fn.id);
    });

    state.files.forEach(file => {
      const fileId = 'file:' + file.path;
      if (!file.content) return;

      allFunctions.forEach((fnId, fnName) => {
        if (fnId.startsWith(fileId + ':')) return; // skip same-file
        // Check if this file's content references the function name
        const callPattern = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
        if (callPattern.test(file.content)) {
          state.edges.push({ source: fileId, target: fnId, type: 'calls' });
        }
      });
    });
  }

  function resolveImport(module, currentFile) {
    // Resolve relative imports
    if (module.startsWith('./') || module.startsWith('../')) {
      const dir = currentFile.split('/').slice(0, -1).join('/');
      let resolved = module;
      if (module.startsWith('./')) resolved = dir + module.substring(1);
      else if (module.startsWith('../')) {
        const parts = dir.split('/');
        parts.pop();
        resolved = parts.join('/') + module.substring(2);
      }
      // Try with common extensions
      for (const ext of ['', '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '/index.ts', '/index.js']) {
        const candidate = 'file:' + resolved.replace(/^\//, '') + ext;
        if (state.nodeMap.has(candidate)) return candidate;
      }
    }
    return null;
  }

  /* ───────────────────────── INDEXING PIPELINE ───────────────────────── */

  async function startIndexing() {
    const parsed = parseGitHubUrl(urlInput.value);
    if (!parsed) {
      showError('Invalid GitHub URL. Use format: https://github.com/owner/repo');
      return;
    }

    state.owner = parsed.owner;
    state.repo = parsed.repo;
    state.indexing = true;
    state.indexed = false;
    state.files = [];
    state.nodes = [];
    state.edges = [];
    state.nodeMap.clear();

    indexBtn.disabled = true;
    indexBtn.textContent = '⏳ Indexing...';
    progressSec.style.display = 'block';
    statsBar.style.display = 'flex';
    fileTree.innerHTML = '';
    graphEl.querySelector('.empty-state')?.remove();
    clearGraph();

    try {
      // Step 1: Fetch file tree
      updateProgress(5, `Fetching file tree from ${parsed.owner}/${parsed.repo}...`);
      const tree = await fetchRepoTree(parsed.owner, parsed.repo);

      const codeFiles = tree.filter(item => {
        if (item.type !== 'blob') return false;
        const ext = item.path.split('.').pop().toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) return false;
        if (item.path.includes('node_modules/')) return false;
        if (item.path.includes('vendor/')) return false;
        if (item.path.includes('.min.')) return false;
        if (item.path.includes('dist/') || item.path.includes('build/')) return false;
        if (item.path.includes('__pycache__/')) return false;
        if (item.path.includes('.lock')) return false;
        if (item.size && item.size > MAX_FILE_SIZE) return false;
        return true;
      }).slice(0, MAX_FILES);

      updateProgress(10, `Found ${codeFiles.length} code files. Downloading & parsing...`);

      // Step 2: Fetch + parse each file with batched requests
      const batchSize = 8;
      for (let i = 0; i < codeFiles.length; i += batchSize) {
        const batch = codeFiles.slice(i, i + batchSize);
        const promises = batch.map(async (item) => {
          const content = await fetchFileContent(parsed.owner, parsed.repo, state.branch, item.path);
          if (!content) return null;
          const language = getLanguage(item.path);
          const parsedFile = parseFile(item.path, content, language);
          return { path: item.path, content, language, parsed: parsedFile };
        });

        const results = await Promise.all(promises);
        results.forEach(file => {
          if (!file) return;
          state.files.push(file);
          addFileToTree(file.path);
        });

        const pct = 10 + Math.round(((i + batch.length) / codeFiles.length) * 70);
        const totalFns = state.files.reduce((s, f) => s + f.parsed.functions.length, 0);
        const totalCls = state.files.reduce((s, f) => s + f.parsed.classes.length, 0);
        updateProgress(pct, `Parsed ${state.files.length}/${codeFiles.length} files — ${totalFns} functions, ${totalCls} classes found`);
        updateStats();
      }

      // Step 3: Build graph
      updateProgress(85, 'Building knowledge graph...');
      buildGraph();
      updateStats();

      // Step 4: Render
      updateProgress(95, 'Rendering graph...');
      await renderGraph();

      updateProgress(100, `✅ Indexed ${state.files.length} files — ${state.nodes.length} nodes, ${state.edges.length} connections`);
      state.indexing = false;
      state.indexed = true;

      // Enable chat
      chatInput.disabled = false;
      chatSend.disabled = false;
      chatInput.placeholder = `Ask about ${parsed.owner}/${parsed.repo}...`;
      addBotMessage(`🎉 Indexed **${parsed.owner}/${parsed.repo}** — ${state.files.length} files, ${state.nodes.filter(n => n.type === 'function').length} functions, ${state.nodes.filter(n => n.type === 'class').length} classes, ${state.edges.length} connections. Ask me anything!`);

    } catch (err) {
      updateProgress(0, `❌ Error: ${err.message}`);
      showError(err.message);
    } finally {
      indexBtn.disabled = false;
      indexBtn.textContent = '🧠 Index Repository';
      state.indexing = false;
    }
  }

  /* ───────────────────────── UI HELPERS ───────────────────────── */

  function updateProgress(pct, text) {
    progressBar.style.width = pct + '%';
    progressTxt.textContent = text;
  }

  function updateStats() {
    const fns = state.files.reduce((s, f) => s + f.parsed.functions.length, 0);
    const cls = state.files.reduce((s, f) => s + f.parsed.classes.length, 0);
    const imp = state.files.reduce((s, f) => s + f.parsed.imports.length, 0);
    $('stat-files').textContent = state.files.length;
    $('stat-functions').textContent = fns;
    $('stat-classes').textContent = cls;
    $('stat-imports').textContent = imp;
    $('stat-edges').textContent = state.edges.length;
  }

  function showError(msg) {
    addBotMessage('❌ ' + msg);
  }

  function addFileToTree(path) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1];
    const depth = parts.length - 1;

    const el = document.createElement('div');
    el.className = 'file-item';
    el.style.paddingLeft = (0.6 + depth * 1) + 'rem';
    el.dataset.path = path;

    const icon = getFileIcon(fileName);
    el.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${fileName}</span>`;
    el.addEventListener('click', () => selectFile(path));
    fileTree.appendChild(el);
  }

  function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
      js: '🟨', jsx: '⚛️', ts: '🔷', tsx: '⚛️', py: '🐍', java: '☕',
      go: '🐹', rb: '💎', rs: '🦀', c: '🔧', cpp: '🔧', cs: '🟣',
      php: '🐘', swift: '🧡', kt: '🟪', html: '🌐', css: '🎨',
      json: '📋', yaml: '📋', yml: '📋', md: '📝', sql: '🗄️'
    };
    return icons[ext] || '📄';
  }

  function selectFile(path) {
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('file-item--active'));
    const el = document.querySelector(`.file-item[data-path="${path}"]`);
    if (el) el.classList.add('file-item--active');

    const file = state.files.find(f => f.path === path);
    if (!file) return;

    // Show file detail
    const fns = file.parsed.functions.map(f => f.name);
    const cls = file.parsed.classes.map(c => c.name);
    const imps = file.parsed.imports.map(i => i.module);

    nodeDetail.innerHTML = `
      <div class="detail-title">${path}</div>
      <span class="detail-type detail-type--file">${file.language}</span>
      <div class="detail-section">
        <h4>📊 Stats</h4>
        <div class="detail-code">${file.parsed.functions.length} functions\n${file.parsed.classes.length} classes\n${file.parsed.imports.length} imports\n${file.content.split('\n').length} lines</div>
      </div>
      ${fns.length ? `<div class="detail-section"><h4>⚡ Functions (${fns.length})</h4><ul class="detail-list">${fns.map(f => `<li>▸ ${f}()</li>`).join('')}</ul></div>` : ''}
      ${cls.length ? `<div class="detail-section"><h4>🏗️ Classes (${cls.length})</h4><ul class="detail-list">${cls.map(c => `<li>▸ ${c}</li>`).join('')}</ul></div>` : ''}
      ${imps.length ? `<div class="detail-section"><h4>📦 Imports (${imps.length})</h4><ul class="detail-list">${imps.map(i => `<li>▸ ${i}</li>`).join('')}</ul></div>` : ''}
    `;

    // Highlight file node in graph
    highlightNode('file:' + path);
  }

  /* ───────────────────────── D3 GRAPH ───────────────────────── */

  let simulation, svg, g, linkGroup, nodeGroup, zoom;

  function clearGraph() {
    if (svg) { svg.remove(); svg = null; }
    simulation = null;
  }

  function renderGraph() {
    return new Promise(resolve => {
      clearGraph();

      const rect = graphEl.getBoundingClientRect();
      const width = rect.width || 800;
      const height = rect.height || 500;

      svg = d3.select(graphEl)
        .append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox', `0 0 ${width} ${height}`);

      g = svg.append('g');

      zoom = d3.zoom()
        .scaleExtent([0.1, 5])
        .on('zoom', e => g.attr('transform', e.transform));
      svg.call(zoom);

      // Edges
      linkGroup = g.append('g').attr('class', 'links');
      const links = linkGroup.selectAll('line')
        .data(state.edges)
        .enter().append('line')
        .attr('stroke', d => d.type === 'imports' ? '#e17055' : d.type === 'calls' ? '#6c5ce7' : 'rgba(44,37,32,0.12)')
        .attr('stroke-width', d => d.type === 'calls' ? 1.5 : 0.8)
        .attr('stroke-dasharray', d => d.type === 'imports' ? '4,3' : 'none')
        .attr('opacity', 0.6);

      // Nodes
      nodeGroup = g.append('g').attr('class', 'nodes');
      const nodeSel = nodeGroup.selectAll('g')
        .data(state.nodes)
        .enter().append('g')
        .attr('class', 'node')
        .style('cursor', 'pointer')
        .on('click', (e, d) => showNodeDetail(d))
        .call(d3.drag()
          .on('start', dragStart)
          .on('drag', dragging)
          .on('end', dragEnd));

      nodeSel.append('circle')
        .attr('r', d => {
          if (d.type === 'module') return 8;
          if (d.type === 'file') return 6;
          if (d.type === 'class') return 7;
          return 4;
        })
        .attr('fill', d => NODE_COLORS[d.type] || '#999')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .attr('opacity', 0)
        .transition()
        .duration(600)
        .attr('opacity', 1);

      nodeSel.append('text')
        .text(d => d.label.length > 18 ? d.label.substring(0, 16) + '…' : d.label)
        .attr('dx', 10)
        .attr('dy', 3)
        .attr('font-size', d => d.type === 'file' ? '9px' : '8px')
        .attr('fill', '#6B6560')
        .attr('font-family', "'JetBrains Mono', monospace")
        .attr('opacity', 0)
        .transition()
        .delay(300)
        .duration(400)
        .attr('opacity', 0.8);

      // Simulation
      simulation = d3.forceSimulation(state.nodes)
        .force('link', d3.forceLink(state.edges).id(d => d.id).distance(d => {
          if (d.type === 'contains') return 30;
          if (d.type === 'defines') return 20;
          return 60;
        }))
        .force('charge', d3.forceManyBody().strength(d => {
          if (d.type === 'module') return -200;
          if (d.type === 'file') return -80;
          return -30;
        }))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide(12))
        .on('tick', () => {
          links
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
          nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
        });

      // Resolve after stabilization
      simulation.on('end', resolve);
      setTimeout(resolve, 3000); // fallback

      // Zoom controls
      $('zoom-in')?.addEventListener('click', () => svg.transition().call(zoom.scaleBy, 1.5));
      $('zoom-out')?.addEventListener('click', () => svg.transition().call(zoom.scaleBy, 0.67));
      $('zoom-reset')?.addEventListener('click', () => svg.transition().call(zoom.transform, d3.zoomIdentity));
    });
  }

  function dragStart(e, d) {
    if (!e.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragging(e, d) { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d) {
    if (!e.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }

  function highlightNode(nodeId) {
    if (!nodeGroup) return;
    nodeGroup.selectAll('circle')
      .attr('stroke', d => d.id === nodeId ? '#E8611A' : '#fff')
      .attr('stroke-width', d => d.id === nodeId ? 3 : 1.5);
  }

  function showNodeDetail(d) {
    highlightNode(d.id);

    const incoming = state.edges.filter(e => (e.target.id || e.target) === d.id);
    const outgoing = state.edges.filter(e => (e.source.id || e.source) === d.id);

    nodeDetail.innerHTML = `
      <div class="detail-title">${d.label}</div>
      <span class="detail-type detail-type--${d.type}">${d.type}</span>
      ${d.file ? `<div class="detail-section"><h4>📁 File</h4><div class="detail-code">${d.file}${d.line ? ':' + d.line : ''}</div></div>` : ''}
      ${d.code ? `<div class="detail-section"><h4>💻 Code</h4><div class="detail-code">${escapeHtml(d.code)}</div></div>` : ''}
      ${incoming.length ? `<div class="detail-section"><h4>⬅️ Referenced by (${incoming.length})</h4><ul class="detail-list">${incoming.slice(0, 15).map(e => `<li>▸ ${(e.source.label || e.source)} <em>(${e.type})</em></li>`).join('')}</ul></div>` : ''}
      ${outgoing.length ? `<div class="detail-section"><h4>➡️ References (${outgoing.length})</h4><ul class="detail-list">${outgoing.slice(0, 15).map(e => `<li>▸ ${(e.target.label || e.target)} <em>(${e.type})</em></li>`).join('')}</ul></div>` : ''}
    `;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /* ───────────────────────── CHAT ENGINE ───────────────────────── */

  function handleChat() {
    const query = chatInput.value.trim();
    if (!query || !state.indexed) return;

    addUserMessage(query);
    chatInput.value = '';

    const response = processQuery(query);
    setTimeout(() => addBotMessage(response), 300 + Math.random() * 500);
  }

  function processQuery(query) {
    const q = query.toLowerCase();

    // Stats questions
    if (q.match(/how many|count|total|stats|overview|summary/)) {
      const fns = state.nodes.filter(n => n.type === 'function').length;
      const cls = state.nodes.filter(n => n.type === 'class').length;
      const files = state.files.length;
      const langs = [...new Set(state.files.map(f => f.language))];
      return `📊 **${state.owner}/${state.repo}** overview:\n` +
        `- **${files}** files indexed\n` +
        `- **${fns}** functions\n` +
        `- **${cls}** classes\n` +
        `- **${state.edges.length}** connections\n` +
        `- Languages: ${langs.join(', ')}`;
    }

    // "What does X do" / "find X" / "where is X"
    const symbolMatch = q.match(/(?:what does|find|where is|show|explain|describe)\s+['"]?(\w+)['"]?/i);
    if (symbolMatch) {
      return findSymbol(symbolMatch[1]);
    }

    // "Who calls X" / "what calls X" / "callers of X"
    const callerMatch = q.match(/(?:who|what)\s+(?:calls|uses|references|imports)\s+['"]?(\w+)['"]?/i);
    if (callerMatch) {
      return findCallers(callerMatch[1]);
    }

    // "What functions are in file X"
    const fileMatch = q.match(/(?:functions?|classes?|what'?s?\s+in)\s+(?:in\s+)?['"]?([^\s'"?]+)['"]?/i);
    if (fileMatch) {
      return describeFile(fileMatch[1]);
    }

    // "Largest files" / "most complex"
    if (q.match(/largest|biggest|most complex|hotspot|most function/)) {
      return findLargestFiles();
    }

    // "What languages" / "tech stack"
    if (q.match(/language|tech stack|framework|built with/)) {
      return describeStack();
    }

    // "Architecture" / "structure" / "how is it organized"
    if (q.match(/architect|structure|organiz|layout|director/)) {
      return describeArchitecture();
    }

    // "Imports" / "dependencies"
    if (q.match(/import|depend|external|package/)) {
      return describeDependencies();
    }

    // Fuzzy search — try to find any matching symbol
    const words = q.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const matches = state.nodes.filter(n =>
        n.label.toLowerCase().includes(word) && (n.type === 'function' || n.type === 'class')
      );
      if (matches.length > 0) {
        return `Found **${matches.length}** symbols matching "${word}":\n` +
          matches.slice(0, 12).map(m => `- **${m.label}** (${m.type}) in \`${m.file}\`${m.line ? ':' + m.line : ''}`).join('\n');
      }
    }

    return `I couldn't find a specific answer. Try:\n- "How many functions?"\n- "What does handleAuth do?"\n- "Who calls fetchData?"\n- "What's in src/index.ts?"\n- "Show me the architecture"\n- "Largest files"`;
  }

  function findSymbol(name) {
    const matches = state.nodes.filter(n =>
      n.label.toLowerCase() === name.toLowerCase() ||
      n.label.toLowerCase().includes(name.toLowerCase())
    ).filter(n => n.type !== 'module');

    if (matches.length === 0) return `No symbol found matching "${name}".`;

    return matches.slice(0, 8).map(m => {
      const refs = state.edges.filter(e => (e.target.id || e.target) === m.id);
      const deps = state.edges.filter(e => (e.source.id || e.source) === m.id);
      let detail = `**${m.label}** — ${m.type} in \`${m.file || '?'}\`${m.line ? ':' + m.line : ''}`;
      if (m.code) detail += `\n  \`${m.code.substring(0, 80)}\``;
      if (refs.length) detail += `\n  ← Referenced by ${refs.length} nodes`;
      if (deps.length) detail += `\n  → References ${deps.length} nodes`;
      return detail;
    }).join('\n\n');
  }

  function findCallers(name) {
    const targets = state.nodes.filter(n => n.label.toLowerCase() === name.toLowerCase());
    if (targets.length === 0) return `No symbol "${name}" found.`;

    const callers = [];
    targets.forEach(target => {
      state.edges.filter(e => (e.target.id || e.target) === target.id && (e.type === 'calls' || e.type === 'imports'))
        .forEach(e => {
          const src = state.nodeMap.get(e.source.id || e.source);
          if (src) callers.push(src);
        });
    });

    if (callers.length === 0) return `No callers found for "${name}".`;
    return `**${name}** is called/used by ${callers.length} node(s):\n` +
      callers.slice(0, 10).map(c => `- **${c.label}** (${c.type}) in \`${c.file || '?'}\``).join('\n');
  }

  function describeFile(filename) {
    const file = state.files.find(f =>
      f.path.toLowerCase().includes(filename.toLowerCase())
    );
    if (!file) return `File "${filename}" not found.`;

    const fns = file.parsed.functions.map(f => f.name);
    const cls = file.parsed.classes.map(c => c.name);
    return `📄 **${file.path}** (${file.language}, ${file.content.split('\n').length} lines)\n` +
      (fns.length ? `\n**Functions (${fns.length}):** ${fns.join(', ')}` : '\nNo functions.') +
      (cls.length ? `\n**Classes (${cls.length}):** ${cls.join(', ')}` : '');
  }

  function findLargestFiles() {
    const sorted = [...state.files]
      .map(f => ({ path: f.path, fns: f.parsed.functions.length, cls: f.parsed.classes.length, lines: f.content.split('\n').length }))
      .sort((a, b) => (b.fns + b.cls) - (a.fns + a.cls));

    return `🔥 **Top files by complexity:**\n` +
      sorted.slice(0, 8).map((f, i) =>
        `${i + 1}. **${f.path}** — ${f.fns} functions, ${f.cls} classes, ${f.lines} lines`
      ).join('\n');
  }

  function describeStack() {
    const langs = {};
    state.files.forEach(f => { langs[f.language] = (langs[f.language] || 0) + 1; });
    const sorted = Object.entries(langs).sort((a, b) => b[1] - a[1]);
    return `🔧 **Tech stack:**\n` +
      sorted.map(([lang, count]) => `- **${lang}**: ${count} files`).join('\n');
  }

  function describeArchitecture() {
    const dirs = {};
    state.files.forEach(f => {
      const parts = f.path.split('/');
      const topDir = parts.length > 1 ? parts[0] : '(root)';
      if (!dirs[topDir]) dirs[topDir] = { files: 0, fns: 0, cls: 0 };
      dirs[topDir].files++;
      dirs[topDir].fns += f.parsed.functions.length;
      dirs[topDir].cls += f.parsed.classes.length;
    });

    return `🏗️ **Project architecture:**\n` +
      Object.entries(dirs)
        .sort((a, b) => b[1].files - a[1].files)
        .slice(0, 10)
        .map(([dir, stats]) =>
          `- **${dir}/** — ${stats.files} files, ${stats.fns} functions, ${stats.cls} classes`
        ).join('\n');
  }

  function describeDependencies() {
    const externals = {};
    state.files.forEach(f => {
      f.parsed.imports.forEach(imp => {
        if (!imp.module.startsWith('.') && !imp.module.startsWith('/')) {
          const pkg = imp.module.split('/')[0];
          externals[pkg] = (externals[pkg] || 0) + 1;
        }
      });
    });

    const sorted = Object.entries(externals).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return 'No external dependencies detected.';

    return `📦 **External dependencies (${sorted.length}):**\n` +
      sorted.slice(0, 15).map(([pkg, count]) => `- **${pkg}** — used in ${count} files`).join('\n');
  }

  /* ───────────────────────── CHAT UI ───────────────────────── */

  function addUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-message chat-message--user';
    div.innerHTML = `<span class="chat-avatar">👤</span><div class="chat-bubble">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addBotMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-message chat-message--bot';
    // Simple markdown: **bold**, `code`, \n → <br>
    const formatted = escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
    div.innerHTML = `<span class="chat-avatar">🧠</span><div class="chat-bubble">${formatted}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  /* ───────────────────────── EVENT BINDINGS ───────────────────────── */

  indexBtn.addEventListener('click', startIndexing);

  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') startIndexing();
  });

  chatSend.addEventListener('click', handleChat);

  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleChat();
  });

  // Pre-fill with the ai-mind-map repo as a demo
  urlInput.value = 'https://github.com/shdra06/ai-mind-map';

})();
