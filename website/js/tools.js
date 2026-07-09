/* ============================================
   MCP Tool Explorer — Interactive Tools Page
   AI Mind Map Website
   ============================================ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────
  let allTools = [];
  let filteredTools = [];
  let activeCategory = 'All';
  let expandedCards = new Set();

  // ── Category Colors ────────────────────────
  const CATEGORY_COLORS = {
    Session:          '#6c5ce7',
    Search:           '#00cec9',
    Read:             '#00b894',
    Project:          '#fdcb6e',
    'Change Tracking':'#e17055',
    Memory:           '#fd79a8',
    Analysis:         '#a29bfe',
    Flow:             '#74b9ff',
    Debug:            '#ff7675',
    'Self-Evolving':  '#55efc4',
    Compression:      '#fab1a0'
  };

  // ── Initialize ─────────────────────────────
  async function init() {
    try {
      const res = await fetch('data/tools.json');
      allTools = await res.json();
      filteredTools = [...allTools];
    } catch (e) {
      console.error('Failed to load tools data:', e);
      document.getElementById('tools-grid').innerHTML =
        '<p style="color:#fd79a8;text-align:center;padding:40px;">Failed to load tools data.</p>';
      return;
    }

    renderCategoryTabs();
    renderTools();
    updateCount();
    animateCounter();
    bindControls();
  }

  // ── Render Category Tabs ───────────────────
  function renderCategoryTabs() {
    const container = document.getElementById('category-tabs');
    if (!container) return;

    // Collect categories in order
    const categories = ['All'];
    allTools.forEach(t => {
      if (!categories.includes(t.category)) categories.push(t.category);
    });

    container.innerHTML = categories.map(cat => {
      const count = cat === 'All' ? allTools.length : allTools.filter(t => t.category === cat).length;
      const color = CATEGORY_COLORS[cat] || '#6c5ce7';
      return `
        <button class="cat-tab ${cat === 'All' ? 'active' : ''}" data-category="${cat}">
          ${cat}
          <span class="cat-count" style="background:${cat === 'All' ? 'rgba(108,92,231,0.2)' : hexToRgba(color, 0.15)};color:${cat === 'All' ? '#6c5ce7' : color}">${count}</span>
        </button>
      `;
    }).join('');
  }

  // ── Render Tool Cards ──────────────────────
  function renderTools() {
    const grid = document.getElementById('tools-grid');
    if (!grid) return;

    if (filteredTools.length === 0) {
      grid.innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <h3>No tools found</h3>
          <p>Try adjusting your search or category filter</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = filteredTools.map((tool, i) => {
      const color = CATEGORY_COLORS[tool.category] || '#6c5ce7';
      const isExpanded = expandedCards.has(tool.name);
      const delay = Math.min(i * 40, 400);

      return `
        <div class="tool-card glass-card ${isExpanded ? 'expanded' : ''}" data-tool="${tool.name}" style="animation-delay:${delay}ms">
          <div class="tool-card-header" onclick="window.__toggleTool('${tool.name}')">
            <div class="tool-card-title">
              <span class="tool-icon">${tool.icon}</span>
              <code class="tool-name">${tool.name}</code>
              ${tool.recommended ? '<span class="star-badge" title="Recommended">⭐</span>' : ''}
            </div>
            <div class="tool-card-badges">
              <span class="badge" style="background:${hexToRgba(color, 0.12)};color:${color}">${tool.category}</span>
              ${tool.tokenSavings && tool.tokenSavings !== 'N/A' ? `<span class="badge badge-green">${tool.tokenSavings}</span>` : ''}
            </div>
          </div>
          <p class="tool-description">${tool.description}</p>
          <div class="tool-card-actions">
            <button class="btn-copy-name" onclick="event.stopPropagation();window.__copyToolName('${tool.name}', this)" title="Copy tool name">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              Copy
            </button>
            <button class="btn-expand" onclick="event.stopPropagation();window.__toggleTool('${tool.name}')">
              <span class="expand-icon">${isExpanded ? '▲' : '▼'}</span>
              ${isExpanded ? 'Collapse' : 'Details'}
            </button>
          </div>
          <div class="tool-card-details" style="${isExpanded ? 'max-height:800px;opacity:1' : ''}">
            ${renderToolDetails(tool)}
          </div>
        </div>
      `;
    }).join('');
  }

  // ── Render Expanded Details ────────────────
  function renderToolDetails(tool) {
    let html = '';

    // Parameters table
    if (tool.params && tool.params.length > 0) {
      html += `
        <div class="detail-block">
          <h4>Parameters</h4>
          <table class="params-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Required</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              ${tool.params.map(p => `
                <tr>
                  <td><code>${p.name}</code></td>
                  <td><span class="type-badge">${p.type}</span></td>
                  <td>${p.required ? '<span class="required-dot">●</span> Yes' : '<span class="optional-dot">○</span> No'}</td>
                  <td>${p.description}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else {
      html += `<div class="detail-block"><h4>Parameters</h4><p class="no-params">No parameters required</p></div>`;
    }

    // Example
    if (tool.example) {
      html += `
        <div class="detail-block">
          <h4>Example Usage</h4>
          <div class="example-code">
            <button class="btn-copy-example" onclick="window.__copyExample(this)" title="Copy example">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <pre><code>${escapeHtml(tool.example)}</code></pre>
          </div>
        </div>
      `;
    }

    // Related tools
    const related = findRelatedTools(tool);
    if (related.length > 0) {
      html += `
        <div class="detail-block">
          <h4>Related Tools</h4>
          <div class="related-tools">
            ${related.map(r => `<a href="#" class="related-link" onclick="window.__scrollToTool('${r.name}');return false;">${r.icon} ${r.name}</a>`).join('')}
          </div>
        </div>
      `;
    }

    return html;
  }

  // ── Find Related Tools ─────────────────────
  function findRelatedTools(tool) {
    return allTools
      .filter(t => t.name !== tool.name && t.category === tool.category)
      .slice(0, 4);
  }

  // ── Search ─────────────────────────────────
  function handleSearch(query) {
    const q = query.toLowerCase().trim();

    if (!q) {
      filteredTools = activeCategory === 'All'
        ? [...allTools]
        : allTools.filter(t => t.category === activeCategory);
    } else {
      let pool = activeCategory === 'All' ? allTools : allTools.filter(t => t.category === activeCategory);
      filteredTools = pool.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    }

    renderTools();
    updateCount();
  }

  // ── Category Filter ────────────────────────
  function setCategory(category) {
    activeCategory = category;

    // Update tab UI
    document.querySelectorAll('.cat-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.category === category);
    });

    // Apply filter
    const searchInput = document.getElementById('tools-search');
    const q = searchInput ? searchInput.value : '';
    handleSearch(q);
  }

  // ── Toggle Expand ──────────────────────────
  function toggleTool(name) {
    if (expandedCards.has(name)) {
      expandedCards.delete(name);
    } else {
      expandedCards.add(name);
    }

    const card = document.querySelector(`.tool-card[data-tool="${name}"]`);
    if (!card) return;

    const details = card.querySelector('.tool-card-details');
    const expandBtn = card.querySelector('.expand-icon');
    const expandText = card.querySelector('.btn-expand');

    if (expandedCards.has(name)) {
      card.classList.add('expanded');
      details.style.maxHeight = details.scrollHeight + 'px';
      details.style.opacity = '1';
      if (expandBtn) expandBtn.textContent = '▲';
      if (expandText) expandText.innerHTML = '<span class="expand-icon">▲</span> Collapse';
    } else {
      card.classList.remove('expanded');
      details.style.maxHeight = '0';
      details.style.opacity = '0';
      if (expandBtn) expandBtn.textContent = '▼';
      if (expandText) expandText.innerHTML = '<span class="expand-icon">▼</span> Details';
    }
  }

  // ── Copy Tool Name ─────────────────────────
  async function copyToolName(name, btn) {
    try {
      await navigator.clipboard.writeText(name);
      const original = btn.innerHTML;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00b894" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('copied');
      }, 1500);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  }

  // ── Copy Example ───────────────────────────
  async function copyExample(btn) {
    const code = btn.closest('.example-code').querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(code);
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#00b894" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
      }, 1500);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  }

  // ── Scroll to Tool ─────────────────────────
  function scrollToTool(name) {
    // Make sure tool is visible first
    if (activeCategory !== 'All') {
      const tool = allTools.find(t => t.name === name);
      if (tool && tool.category !== activeCategory) {
        setCategory('All');
        // Need re-render before scrolling
        setTimeout(() => doScroll(name), 100);
        return;
      }
    }
    doScroll(name);
  }

  function doScroll(name) {
    const card = document.querySelector(`.tool-card[data-tool="${name}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlight-pulse');
      setTimeout(() => card.classList.remove('highlight-pulse'), 1500);
      // Expand it
      if (!expandedCards.has(name)) toggleTool(name);
    }
  }

  // ── Update Count ───────────────────────────
  function updateCount() {
    const el = document.getElementById('results-count');
    if (el) {
      el.textContent = `Showing ${filteredTools.length} of ${allTools.length} tools`;
    }
  }

  // ── Animated Counter ───────────────────────
  function animateCounter() {
    const counter = document.getElementById('tool-counter');
    if (!counter) return;
    const target = allTools.length;
    let current = 0;
    const duration = 1200;
    const step = duration / target;

    function tick() {
      current++;
      counter.textContent = current;
      if (current < target) {
        setTimeout(tick, step);
      }
    }
    tick();
  }

  // ── Keyboard Navigation ────────────────────
  function handleKeyNav(e) {
    const cards = document.querySelectorAll('.tool-card');
    if (cards.length === 0) return;

    const focused = document.querySelector('.tool-card.kb-focus');
    let idx = -1;
    if (focused) {
      cards.forEach((c, i) => { if (c === focused) idx = i; });
    }

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      if (focused) focused.classList.remove('kb-focus');
      idx = Math.min(idx + 1, cards.length - 1);
      cards[idx].classList.add('kb-focus');
      cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      if (focused) focused.classList.remove('kb-focus');
      idx = Math.max(idx - 1, 0);
      cards[idx].classList.add('kb-focus');
      cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (e.key === 'Enter' && focused) {
      const name = focused.dataset.tool;
      if (name) toggleTool(name);
    }
  }

  // ── Helpers ────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ── Bind Controls ──────────────────────────
  function bindControls() {
    // Search with debounce
    const searchInput = document.getElementById('tools-search');
    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => handleSearch(e.target.value), 200);
      });
    }

    // Category tabs
    document.getElementById('category-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.cat-tab');
      if (tab) setCategory(tab.dataset.category);
    });

    // Keyboard nav (only when not in search)
    document.addEventListener('keydown', (e) => {
      if (document.activeElement === searchInput) return;
      handleKeyNav(e);
    });
  }

  // ── Expose globals ─────────────────────────
  window.__toggleTool = toggleTool;
  window.__copyToolName = copyToolName;
  window.__copyExample = copyExample;
  window.__scrollToTool = scrollToTool;

  // ── Boot ───────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Nav toggle
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.querySelector('.nav-toggle');
    const links = document.querySelector('.nav-links');
    if (toggle && links) {
      toggle.addEventListener('click', () => links.classList.toggle('open'));
    }
  });
})();
