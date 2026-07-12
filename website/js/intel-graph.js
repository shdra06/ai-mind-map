/**
 * intel-graph.js — Advanced D3.js Force-Directed Graph for Codebase Exploration
 * 
 * Loaded AFTER codebase-intel.js. Receives data via:
 *   window.IntelGraph.init(containerEl, data)
 *
 * Data shape: { nodes: [...], edges: [...], routes: [...], files: [...] }
 *
 * Depends on D3 v7 loaded globally as `d3`.
 */
;(function () {
  'use strict';

  /* ───────────────────────── constants ───────────────────────── */

  const COLORS = {
    route:      '#00b894',
    function:   '#3178C6',
    class:      '#6c5ce7',
    middleware:  '#fdcb6e',
    file:       '#95a5a6',
    'api-call': '#e17055',
    'db-query': '#d63031',
  };

  const RADII = {
    route:      14,
    function:   8,
    class:      10,
    middleware:  10,
    file:       6,
    'api-call': 9,
    'db-query': 9,
  };

  const EDGE_STYLES = {
    imports:       { stroke: '#95a5a6', dash: '5,4',  width: 1.2, arrow: false, animated: false },
    calls:         { stroke: '#3178C6', dash: null,    width: 1.4, arrow: true,  animated: false },
    middleware:    { stroke: '#fdcb6e', dash: '6,3',   width: 1.4, arrow: true,  animated: false },
    'api-request': { stroke: '#e17055', dash: null,    width: 2.4, arrow: false, animated: true  },
    'db-query':    { stroke: '#d63031', dash: null,    width: 1.4, arrow: true,  animated: false },
  };

  const HIGHLIGHT_DURATION = 10000; // ms before auto-clear

  /* ──────────────────── internal state ──────────────────── */

  let _svg, _g, _simulation, _container;
  let _nodeEls, _linkEls, _labelEls;
  let _nodes = [], _edges = [], _routes = [], _files = [];
  let _nodeMap = {};            // id → node
  let _adjOut  = {};            // id → [edge]
  let _adjIn   = {};            // id → [edge]
  let _highlightTimer = null;
  let _resizeObserver = null;
  let _width, _height;
  let _zoom;
  let _defs;
  let _tooltip;
  let _destroyed = false;

  /* ──────────────────── CSS injected once ──────────────────── */

  function injectStyles() {
    if (document.getElementById('intel-graph-styles')) return;
    const style = document.createElement('style');
    style.id = 'intel-graph-styles';
    style.textContent = `
      /* risk-2 pulsing glow */
      @keyframes igRiskPulse {
        0%, 100% { filter: drop-shadow(0 0 4px #d63031); }
        50%      { filter: drop-shadow(0 0 12px #ff4757); }
      }
      .ig-risk-glow { animation: igRiskPulse 1.6s ease-in-out infinite; }

      /* focus pulsing ring */
      @keyframes igFocusRing {
        0%   { r: 0;  opacity: .9; }
        100% { r: 32; opacity: 0;  }
      }
      .ig-focus-ring circle {
        fill: none; stroke: var(--accent-primary, #E8611A); stroke-width: 2;
        animation: igFocusRing 1.4s ease-out infinite;
      }

      /* animated dots on api-request edges */
      @keyframes igDotFlow {
        to { stroke-dashoffset: -24; }
      }
      .ig-edge-animated {
        stroke-dasharray: 4 8;
        animation: igDotFlow .8s linear infinite;
      }

      /* highlighted edge animated dash */
      @keyframes igHighlightDash {
        to { stroke-dashoffset: -20; }
      }
      .ig-edge-highlight {
        stroke: #E8611A !important;
        stroke-width: 3 !important;
        stroke-dasharray: 8 4;
        animation: igHighlightDash .6s linear infinite;
      }

      /* tooltip */
      .ig-tooltip {
        position: absolute; pointer-events: none; z-index: 9999;
        background: var(--bg-secondary, #EDE9E3); color: var(--text-primary, #2C2520);
        border: 1px solid var(--accent-primary, #E8611A);
        border-radius: 8px; padding: 10px 14px; font-size: 12px; line-height: 1.5;
        box-shadow: 0 6px 20px rgba(0,0,0,.18);
        opacity: 0; transition: opacity .15s;
        max-width: 360px; white-space: pre-line;
      }
      .ig-tooltip.visible { opacity: 1; }

      .ig-node { cursor: pointer; transition: opacity .3s; }
      .ig-edge { transition: opacity .3s, stroke .3s, stroke-width .3s; }
      .ig-label { pointer-events: none; user-select: none; }
    `;
    document.head.appendChild(style);
  }

  /* ──────────────────── shape path generators ──────────────────── */

  /** Return an SVG path `d` string centered at (0,0) for each node type. */
  function shapePath(type, r) {
    switch (type) {
      case 'route':      return polygon(5, r, -Math.PI / 2);           // pentagon
      case 'function':   return circle(r);
      case 'class':      return diamond(r);
      case 'middleware':  return polygon(6, r, 0);                     // hexagon
      case 'file':       return square(r);
      case 'api-call':   return polygon(3, r, -Math.PI / 2);          // triangle
      case 'db-query':   return cylinderPath(r);
      default:           return circle(r);
    }
  }

  function polygon(sides, r, startAngle) {
    const pts = [];
    for (let i = 0; i < sides; i++) {
      const a = startAngle + (2 * Math.PI * i) / sides;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return 'M' + pts.map(p => p.join(',')).join('L') + 'Z';
  }

  function circle(r) {
    // approximate circle with 4-arc path
    return `M0,${-r}A${r},${r},0,1,1,0,${r}A${r},${r},0,1,1,0,${-r}Z`;
  }

  function diamond(r) {
    return `M0,${-r}L${r},0L0,${r}L${-r},0Z`;
  }

  function square(r) {
    return `M${-r},${-r}L${r},${-r}L${r},${r}L${-r},${r}Z`;
  }

  function cylinderPath(r) {
    const h = r * 1.3;
    const ry = r * 0.35;
    return `M${-r},${-h + ry}
            A${r},${ry},0,0,1,${r},${-h + ry}
            L${r},${h - ry}
            A${r},${ry},0,0,1,${-r},${h - ry}Z
            M${-r},${-h + ry}
            A${r},${ry},0,0,0,${r},${-h + ry}`;
  }

  /* ──────────────────── adjacency helpers ──────────────────── */

  function buildAdjacency() {
    _nodeMap = {}; _adjOut = {}; _adjIn = {};
    _nodes.forEach(n => { _nodeMap[n.id] = n; _adjOut[n.id] = []; _adjIn[n.id] = []; });
    _edges.forEach(e => {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      if (_adjOut[sid]) _adjOut[sid].push(e);
      if (_adjIn[tid])  _adjIn[tid].push(e);
    });
  }

  /* ──────────────────── tooltip ──────────────────── */

  function ensureTooltip() {
    if (_tooltip) return;
    _tooltip = document.createElement('div');
    _tooltip.className = 'ig-tooltip';
    document.body.appendChild(_tooltip);
  }

  function showTooltip(ev, d) {
    ensureTooltip();
    const conns = (_adjOut[d.id] || []).length + (_adjIn[d.id] || []).length;
    
    // Type icons for instant recognition
    const typeIcons = {
      'route': '🔹', 'function': 'ƒ', 'class': '◆', 'middleware': '⬡',
      'file': '📄', 'api-call': '🌐', 'db-query': '🗄'
    };
    const icon = typeIcons[d.type] || '●';
    
    // Build flow chain for routes (trace what they call)
    let flowChain = '';
    if (d.type === 'route' || d.type === 'function') {
      const visited = new Set();
      const chain = [];
      const queue = [...(_adjOut[d.id] || [])];
      visited.add(d.id);
      let depth = 0;
      while (queue.length > 0 && chain.length < 6 && depth < 20) {
        const edge = queue.shift();
        depth++;
        const tid = typeof edge.target === 'object' ? edge.target.id : edge.target;
        if (visited.has(tid)) continue;
        visited.add(tid);
        const targetNode = _nodeMap[tid];
        if (!targetNode) continue;
        if (targetNode.type === 'file') continue; // skip file nodes in chain
        const chainIcon = typeIcons[targetNode.type] || '→';
        chain.push(`${chainIcon} ${targetNode.label}`);
        // Continue tracing outward
        (_adjOut[tid] || []).forEach(e => {
          if (!visited.has(typeof e.target === 'object' ? e.target.id : e.target)) {
            queue.push(e);
          }
        });
      }
      if (chain.length > 0) {
        flowChain = `\n<span style="color:#00b894;display:block;margin:4px 0 2px;border-top:1px solid rgba(0,0,0,.1);padding-top:4px">📍 Flow:</span><span style="opacity:.85;font-size:11px">${chain.join(' → ')}</span>`;
      }
    }
    
    // Compact file display
    const fileName = d.file ? d.file.split('/').pop() : '—';
    
    _tooltip.innerHTML =
      `<strong>${icon} ${d.label}</strong>` +
      (d.summary ? `\n<span style="color:#E8611A;font-style:italic;display:block;margin:2px 0 3px;line-height:1.35">${d.summary}</span>` : '\n') +
      `<span style="opacity:.6;font-size:10px">${d.type}${d.count > 1 ? ' · ' + d.count + '× calls' : ''} · ${fileName}${d.line != null ? ':' + d.line : ''} · ${conns} connections</span>` +
      (d.risk === 2 ? '\n<span style="color:#d63031">⚠ High risk</span>' : '') +
      flowChain;
    _tooltip.classList.add('visible');
    positionTooltip(ev);
  }

  function positionTooltip(ev) {
    if (!_tooltip) return;
    const pad = 14;
    let x = ev.pageX + pad;
    let y = ev.pageY + pad;
    const rect = _tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = ev.pageX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = ev.pageY - rect.height - pad;
    _tooltip.style.left = x + 'px';
    _tooltip.style.top  = y + 'px';
  }

  function hideTooltip() {
    if (_tooltip) _tooltip.classList.remove('visible');
  }

  /* ──────────────────── SVG defs (arrows) ──────────────────── */

  function createDefs() {
    _defs = _svg.append('defs');

    // arrow markers per edge type — only used on highlighted paths
    Object.entries(EDGE_STYLES).forEach(([type, s]) => {
      if (!s.arrow) return;
      _defs.append('marker')
        .attr('id', `arrow-${type}`)
        .attr('viewBox', '0 -3 6 6')
        .attr('refX', 16)
        .attr('refY', 0)
        .attr('markerWidth', 4)
        .attr('markerHeight', 4)
        .attr('orient', 'auto')
        .append('path')
          .attr('d', 'M0,-3L6,0L0,3Z')
          .attr('fill', s.stroke)
          .attr('opacity', 0.7);
    });

    // highlight arrow
    _defs.append('marker')
      .attr('id', 'arrow-highlight')
      .attr('viewBox', '0 -3 6 6')
      .attr('refX', 16)
      .attr('refY', 0)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
        .attr('d', 'M0,-3L6,0L0,3Z')
        .attr('fill', '#E8611A');

    // glow filter for highlighted nodes
    const glowFilter = _defs.append('filter')
      .attr('id', 'ig-glow')
      .attr('x', '-50%').attr('y', '-50%')
      .attr('width', '200%').attr('height', '200%');
    glowFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '3').attr('result', 'blur');
    glowFilter.append('feMerge')
      .selectAll('feMergeNode')
      .data(['blur', 'SourceGraphic'])
      .enter()
      .append('feMergeNode')
        .attr('in', d => d);
  }

  /* ──────────────────── main init ──────────────────── */

  const MAX_NODES = 150;  // cap for readability

  /**
   * Intelligently select the most important nodes when there are too many.
   * Priority: routes > classes > high-connection functions > middleware > rest
   */
  function selectImportantNodes(nodes, edges, maxCount) {
    if (nodes.length <= maxCount) return { nodes, edges };

    // Count connections per node
    const connCount = {};
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      connCount[s] = (connCount[s] || 0) + 1;
      connCount[t] = (connCount[t] || 0) + 1;
    });

    // Score each node by importance
    const scored = nodes.map(n => {
      let score = connCount[n.id] || 0;
      // Boost by type
      if (n.type === 'route')      score += 100;
      if (n.type === 'class')      score += 50;
      if (n.type === 'middleware')  score += 40;
      if (n.type === 'api-call')   score += 30;
      if (n.type === 'db-query')   score += 30;
      if (n.risk === 2)            score += 20;
      return { ...n, _score: score };
    });

    // Sort by score descending, keep top N
    scored.sort((a, b) => b._score - a._score);
    const kept = scored.slice(0, maxCount);
    const keptIds = new Set(kept.map(n => n.id));

    // Filter edges to only include those connecting kept nodes
    const filteredEdges = edges.filter(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      return keptIds.has(s) && keptIds.has(t);
    });

    return { nodes: kept, edges: filteredEdges };
  }

  function cleanGraphData(nodes, edges) {
    const cleanNodes = nodes.map(n => {
      const copy = Object.assign({}, n);
      delete copy.index;
      delete copy.vx;
      delete copy.vy;
      if (copy.x !== undefined && !isFinite(copy.x)) delete copy.x;
      if (copy.y !== undefined && !isFinite(copy.y)) delete copy.y;
      return copy;
    });

    const cleanEdges = edges.map(e => {
      const copy = Object.assign({}, e);
      if (typeof copy.source === 'object' && copy.source !== null) {
        copy.source = copy.source.id;
      }
      if (typeof copy.target === 'object' && copy.target !== null) {
        copy.target = copy.target.id;
      }
      return copy;
    });

    return { nodes: cleanNodes, edges: cleanEdges };
  }

  function init(containerEl, data) {
    if (_svg) destroy(); // cleanup previous
    _destroyed = false;

    injectStyles();
    _container = containerEl;

    // Clean graph data to prevent sharing mutated D3 references from previous runs
    const clean = cleanGraphData(data.nodes || [], data.edges || []);
    const selected = selectImportantNodes(clean.nodes, clean.edges, MAX_NODES);

    _nodes  = selected.nodes;
    _edges  = selected.edges;
    _routes = data.routes  || [];
    _files  = data.files   || [];

    buildAdjacency();

    // measure container
    const rect = _container.getBoundingClientRect();
    _width  = rect.width  || 900;
    _height = rect.height || 600;

    // create SVG
    _svg = d3.select(_container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', `0 0 ${_width} ${_height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('display', 'block')
      .style('background', 'transparent');

    createDefs();

    _g = _svg.append('g').attr('class', 'ig-world');

    // zoom
    _zoom = d3.zoom()
      .scaleExtent([0.1, 6])
      .on('zoom', (ev) => _g.attr('transform', ev.transform));
    _svg.call(_zoom);

    // click background → clear highlight
    _svg.on('click', (ev) => {
      if (ev.target === _svg.node()) clearHighlight();
    });

    // ── draw edges ──
    _linkEls = _g.append('g').attr('class', 'ig-edges')
      .selectAll('line')
      .data(_edges, d => `${sourceId(d)}->${targetId(d)}`)
      .enter()
      .append('line')
        .attr('class', d => {
          let cls = 'ig-edge';
          if (d.type === 'api-request') cls += ' ig-edge-animated';
          return cls;
        })
        .attr('stroke', d => (EDGE_STYLES[d.type] || EDGE_STYLES.calls).stroke)
        .attr('stroke-width', d => (EDGE_STYLES[d.type] || EDGE_STYLES.calls).width)
        .attr('stroke-opacity', 0.25)
        .attr('stroke-dasharray', d => (EDGE_STYLES[d.type] || EDGE_STYLES.calls).dash);

    // ── draw nodes ──
    const nodeGroup = _g.append('g').attr('class', 'ig-nodes');

    _nodeEls = nodeGroup
      .selectAll('g')
      .data(_nodes, d => d.id)
      .enter()
      .append('g')
        .attr('class', d => {
          let cls = 'ig-node';
          if (d.risk === 2) cls += ' ig-risk-glow';
          return cls;
        })
        .call(dragBehavior());

    // shape path
    _nodeEls.append('path')
      .attr('d', d => shapePath(d.type, RADII[d.type] || 8))
      .attr('fill', d => COLORS[d.type] || '#95a5a6')
      .attr('stroke', d => d3.color(COLORS[d.type] || '#95a5a6').darker(0.6))
      .attr('stroke-width', d => d.type === 'route' ? 2.5 : 1.5)
      .attr('opacity', 0.92);

    // labels — bigger, bolder for routes/classes
    _labelEls = _nodeEls.append('text')
      .attr('class', 'ig-label')
      .attr('text-anchor', 'middle')
      .attr('dy', d => (RADII[d.type] || 8) + 14)
      .attr('font-size', d => {
        if (d.type === 'route') return '11px';
        if (d.type === 'class') return '10.5px';
        return '9.5px';
      })
      .attr('font-weight', d => (d.type === 'route' || d.type === 'class') ? '600' : '400')
      .attr('fill', 'var(--text-primary, #2C2520)')
      .attr('font-family', "'Geist Mono', monospace")
      .text(d => truncateLabel(d.label, 22));

    // events
    _nodeEls
      .on('mouseover', function (ev, d) {
        d3.select(this).select('path').attr('filter', 'url(#ig-glow)');
        showTooltip(ev, d);
      })
      .on('mousemove', (ev) => positionTooltip(ev))
      .on('mouseout', function () {
        d3.select(this).select('path').attr('filter', null);
        hideTooltip();
      })
      .on('click', (ev, d) => {
        ev.stopPropagation();
        _container.dispatchEvent(new CustomEvent('intel-node-select', { detail: d, bubbles: true }));
      })
      .on('dblclick', (ev, d) => {
        ev.stopPropagation();
        traceRoute(d.id);
      });

    // ── simulation — tuned for readability ──
    const nodeCount = _nodes.length;
    const chargeStrength = nodeCount > 100 ? -800 : nodeCount > 50 ? -600 : -400;
    const linkDist = nodeCount > 100 ? 160 : nodeCount > 50 ? 130 : 100;

    _simulation = d3.forceSimulation(_nodes)
      .force('link', d3.forceLink(_edges).id(d => d.id).distance(linkDist).strength(0.3))
      .force('charge', d3.forceManyBody().strength(chargeStrength).distanceMax(600))
      .force('center', d3.forceCenter(_width / 2, _height / 2))
      .force('collide', d3.forceCollide().radius(d => (RADII[d.type] || 8) + 20).strength(0.8))
      .force('x', d3.forceX(_width / 2).strength(0.03))
      .force('y', d3.forceY(_height / 2).strength(0.03))
      .alphaDecay(0.02)
      .on('tick', ticked);

    // After simulation settles, auto-zoom to fit all nodes
    _simulation.on('end', () => {
      autoZoomToFit();
    });

    // Also auto-fit after a short delay in case simulation is still running
    setTimeout(autoZoomToFit, 3000);

    // resize observer
    _resizeObserver = new ResizeObserver(entries => {
      if (_destroyed) return;
      const cr = entries[0].contentRect;
      _width  = cr.width  || 900;
      _height = cr.height || 600;
      _svg.attr('viewBox', `0 0 ${_width} ${_height}`);
      _simulation.force('center', d3.forceCenter(_width / 2, _height / 2));
      _simulation.alpha(0.15).restart();
    });
    _resizeObserver.observe(_container);
  }

  /** Auto-zoom so all nodes are visible with padding */
  function autoZoomToFit() {
    if (_destroyed || !_nodes.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    _nodes.forEach(n => {
      if (n.x != null) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); }
      if (n.y != null) { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    });
    const pad = 60;
    const gw = (maxX - minX) + pad * 2;
    const gh = (maxY - minY) + pad * 2;
    if (gw <= 0 || gh <= 0) return;
    const scale = Math.min(_width / gw, _height / gh, 1.5) * 0.9;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tx = _width / 2 - cx * scale;
    const ty = _height / 2 - cy * scale;
    _svg.transition().duration(800)
      .call(_zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  /* ──────────────────── tick ──────────────────── */

  function ticked() {
    _linkEls
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    _nodeEls.attr('transform', d => `translate(${d.x},${d.y})`);
  }

  /* ──────────────────── drag ──────────────────── */

  function dragBehavior() {
    return d3.drag()
      .on('start', (ev, d) => {
        if (!ev.active) _simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (ev, d) => {
        d.fx = ev.x; d.fy = ev.y;
      })
      .on('end', (ev, d) => {
        if (!ev.active) _simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }

  /* ──────────────────── helpers ──────────────────── */

  function sourceId(e) { return typeof e.source === 'object' ? e.source.id : e.source; }
  function targetId(e) { return typeof e.target === 'object' ? e.target.id : e.target; }

  function truncateLabel(text, max) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  /* ──────────────────── highlight path ──────────────────── */

  function highlightPath(nodeIds) {
    if (!_svg || _destroyed) return;
    clearHighlightTimer();

    const idSet = new Set(nodeIds);

    // build set of edges on the path
    const edgeSet = new Set();
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const a = nodeIds[i], b = nodeIds[i + 1];
      _edges.forEach(e => {
        const sid = sourceId(e), tid = targetId(e);
        if ((sid === a && tid === b) || (sid === b && tid === a)) {
          edgeSet.add(e);
        }
      });
    }
    // also include any edges entirely within the id set
    _edges.forEach(e => {
      const sid = sourceId(e), tid = targetId(e);
      if (idSet.has(sid) && idSet.has(tid)) edgeSet.add(e);
    });

    // dim nodes
    _nodeEls.transition().duration(400)
      .attr('opacity', d => idSet.has(d.id) ? 1 : 0.1);

    // enlarge highlighted nodes
    _nodeEls.select('path')
      .transition().duration(400)
      .attr('d', d => {
        const r = RADII[d.type] || 8;
        return shapePath(d.type, idSet.has(d.id) ? r * 1.4 : r);
      })
      .attr('filter', d => idSet.has(d.id) ? 'url(#ig-glow)' : null);

    // dim labels
    _nodeEls.select('text')
      .transition().duration(400)
      .attr('opacity', d => idSet.has(d.id) ? 1 : 0.08);

    // edges
    _linkEls
      .classed('ig-edge-highlight', d => edgeSet.has(d))
      .transition().duration(400)
      .attr('opacity', d => edgeSet.has(d) ? 1 : 0.06)
      .attr('marker-end', d => edgeSet.has(d) ? 'url(#arrow-highlight)' : (() => {
        const s = EDGE_STYLES[d.type] || EDGE_STYLES.calls;
        return s.arrow ? `url(#arrow-${d.type})` : null;
      })());

    // auto-clear
    _highlightTimer = setTimeout(clearHighlight, HIGHLIGHT_DURATION);
  }

  function clearHighlight() {
    if (!_svg || _destroyed) return;
    clearHighlightTimer();

    _nodeEls.transition().duration(350).attr('opacity', 1);
    _nodeEls.select('path')
      .transition().duration(350)
      .attr('d', d => shapePath(d.type, RADII[d.type] || 8))
      .attr('filter', null);
    _nodeEls.select('text')
      .transition().duration(350)
      .attr('opacity', 1);

    _linkEls
      .classed('ig-edge-highlight', false)
      .transition().duration(350)
      .attr('opacity', 1)
      .attr('stroke', d => (EDGE_STYLES[d.type] || EDGE_STYLES.calls).stroke)
      .attr('stroke-width', d => (EDGE_STYLES[d.type] || EDGE_STYLES.calls).width)
      .attr('marker-end', d => {
        const s = EDGE_STYLES[d.type] || EDGE_STYLES.calls;
        return s.arrow ? `url(#arrow-${d.type})` : null;
      });

    // remove any focus rings
    _g.selectAll('.ig-focus-ring').remove();
  }

  function clearHighlightTimer() {
    if (_highlightTimer) { clearTimeout(_highlightTimer); _highlightTimer = null; }
  }

  /* ──────────────────── focus node ──────────────────── */

  function focusNode(nodeId) {
    if (!_svg || _destroyed) return;
    const node = _nodeMap[nodeId];
    if (!node) return;

    // wait for simulation to have positions
    const x = node.x || _width / 2;
    const y = node.y || _height / 2;

    // zoom to node
    const scale = 1.8;
    const tx = _width / 2 - x * scale;
    const ty = _height / 2 - y * scale;
    _svg.transition().duration(700)
      .call(_zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

    // pulsing ring
    _g.selectAll('.ig-focus-ring').remove();
    const ring = _g.append('g')
      .attr('class', 'ig-focus-ring')
      .attr('transform', `translate(${x},${y})`);

    for (let i = 0; i < 3; i++) {
      ring.append('circle')
        .attr('r', 0)
        .style('fill', 'none')
        .style('stroke', 'var(--accent-primary, #E8611A)')
        .style('stroke-width', 2)
        .style('opacity', 0.85)
        .transition()
          .delay(i * 450)
          .duration(1400)
          .ease(d3.easeQuadOut)
          .attr('r', 36)
          .style('opacity', 0)
          .remove();
    }

    // highlight connections
    const connected = new Set([nodeId]);
    (_adjOut[nodeId] || []).forEach(e => connected.add(targetId(e)));
    (_adjIn[nodeId]  || []).forEach(e => connected.add(sourceId(e)));
    highlightPath([...connected]);
  }

  /* ──────────────────── filter by type ──────────────────── */

  function filterByType(types) {
    if (!_svg || _destroyed) return;
    const typeSet = new Set(types);

    _nodeEls
      .transition().duration(300)
      .attr('opacity', d => typeSet.has(d.type) ? 1 : 0)
      .style('pointer-events', d => typeSet.has(d.type) ? 'all' : 'none');

    _nodeEls.select('text')
      .transition().duration(300)
      .attr('opacity', d => typeSet.has(d.type) ? 1 : 0);

    _linkEls
      .transition().duration(300)
      .attr('opacity', d => {
        const sid = sourceId(d), tid = targetId(d);
        const sn = _nodeMap[sid], tn = _nodeMap[tid];
        return (sn && typeSet.has(sn.type) && tn && typeSet.has(tn.type)) ? 1 : 0;
      });

    // reheat
    _simulation.alpha(0.35).restart();
  }

  /* ──────────────────── BFS route trace ──────────────────── */

  function traceRoute(routeNodeId) {
    if (!_svg || _destroyed) return [];

    const visited = new Set();
    const result  = [];     // [{ node, depth }]
    const queue   = [{ id: routeNodeId, depth: 0 }];

    while (queue.length) {
      const { id, depth } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      const node = _nodeMap[id];
      if (node) result.push({ node, depth });

      // follow 'calls' and 'middleware' edges outward
      (_adjOut[id] || []).forEach(e => {
        if (e.type === 'calls' || e.type === 'middleware') {
          const tid = targetId(e);
          if (!visited.has(tid)) queue.push({ id: tid, depth: depth + 1 });
        }
      });
    }

    // highlight the path (ordered by discovery)
    highlightPath(result.map(r => r.node.id));

    return result;
  }

  /* ──────────────────── get connections ──────────────────── */

  function getConnections(nodeId) {
    const callers = (_adjIn[nodeId]  || [])
      .filter(e => e.type === 'calls')
      .map(e => _nodeMap[sourceId(e)])
      .filter(Boolean);

    const callees = (_adjOut[nodeId] || [])
      .filter(e => e.type === 'calls')
      .map(e => _nodeMap[targetId(e)])
      .filter(Boolean);

    const imports = (_adjOut[nodeId] || [])
      .filter(e => e.type === 'imports')
      .map(e => _nodeMap[targetId(e)])
      .filter(Boolean);

    return { callers, callees, imports };
  }

  /* ──────────────────── get all nodes ──────────────────── */

  function getAllNodes() {
    return _nodes.slice();
  }

  /* ──────────────────── destroy ──────────────────── */

  function destroy() {
    _destroyed = true;
    clearHighlightTimer();
    if (_simulation)      { _simulation.stop(); _simulation = null; }
    if (_resizeObserver)   { _resizeObserver.disconnect(); _resizeObserver = null; }
    if (_svg)              { _svg.remove(); _svg = null; }
    if (_tooltip)          { _tooltip.remove(); _tooltip = null; }
    _g = _nodeEls = _linkEls = _labelEls = null;
    _nodes = []; _edges = []; _routes = []; _files = [];
    _nodeMap = {}; _adjOut = {}; _adjIn = {};
  }

  /* ──────────────────── public API ──────────────────── */

  window.IntelGraph = {
    init,
    highlightPath,
    focusNode,
    filterByType,
    traceRoute,
    getConnections,
    clearHighlight,
    getAllNodes,
    destroy,
  };

})();
