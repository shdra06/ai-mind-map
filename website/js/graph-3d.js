;(function () {
  'use strict';

  /* ───────────────────────── colour palettes ───────────────────────── */

  const TYPE_COLORS = {
    route:      '#00b894',
    function:   '#3178C6',
    class:      '#6c5ce7',
    middleware:  '#fdcb6e',
    file:       '#95a5a6',
    'api-call': '#e17055',
    'db-query': '#d63031',
  };

  const TYPE_ICONS = {
    route:      '🛣️',
    function:   'ƒ',
    class:      '◆',
    middleware:  '⚙️',
    file:       '📄',
    'api-call': '🌐',
    'db-query': '🗄️',
  };

  const BASE_SIZES = {
    function: 3,
    file:     5,
    class:    4,
  };
  const DEFAULT_BASE_SIZE = 3;

  /**
   * Map a numeric risk score to the same palette used in xray.js.
   * @param {number} risk
   * @returns {string} hex colour
   */
  function riskColor(risk) {
    if (risk >= 3) return '#d63031';
    if (risk >= 2) return '#e17055';
    if (risk >= 1) return '#fdcb6e';
    return '#00b894';
  }

  /* ───────────────── risk-level human-readable label ───────────────── */

  function riskLabel(risk) {
    if (risk >= 3) return '🔴 critical';
    if (risk >= 2) return '🟠 high';
    if (risk >= 1) return '🟡 medium';
    return '🟢 low';
  }

  /* ────────────────────── edge colour / width ──────────────────────── */

  function edgeColor(edge) {
    const t = (edge && edge.type) || '';
    if (t === 'calls')   return 'rgba(49,120,198,0.4)';
    if (t === 'imports') return 'rgba(149,165,166,0.3)';
    return 'rgba(44,37,32,0.15)';
  }

  function edgeWidth(edge) {
    return (edge && edge.type === 'calls') ? 1.5 : 0.6;
  }

  /* ───────────────────── node size by connections ──────────────────── */

  function nodeSize(node) {
    const base  = BASE_SIZES[node.type] || DEFAULT_BASE_SIZE;
    const conns = Number(node._conns) || 0;
    return base + Math.min(conns * 0.5, 6);
  }

  /* ─────────────────────── performance cap ─────────────────────────── */

  const MAX_NODES = 300;

  /**
   * If there are more than MAX_NODES nodes, keep:
   *   • every node with risk >= 2  (always)
   *   • the top N remaining nodes sorted by _conns descending
   * Then prune edges that reference removed nodes.
   */
  function capData(data) {
    if (!data || !data.nodes) return { nodes: [], edges: [] };

    const nodes = data.nodes;
    const edges = data.edges || [];

    if (nodes.length <= MAX_NODES) {
      return { nodes: nodes.slice(), edges: edges.slice() };
    }

    // Partition into must-keep (high risk) and the rest
    const highRisk = [];
    const rest     = [];

    for (const n of nodes) {
      if ((n.risk || 0) >= 2) {
        highRisk.push(n);
      } else {
        rest.push(n);
      }
    }

    // Sort the rest by _conns descending
    rest.sort(function (a, b) {
      return (b._conns || 0) - (a._conns || 0);
    });

    const remaining = Math.max(0, MAX_NODES - highRisk.length);
    const kept      = highRisk.concat(rest.slice(0, remaining));
    const keptIds   = new Set(kept.map(function (n) { return n.id; }));

    const filteredEdges = edges.filter(function (e) {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      return keptIds.has(src) && keptIds.has(tgt);
    });

    return { nodes: kept, edges: filteredEdges };
  }

  /* ──────────────────── glow sphere for high-risk ──────────────────── */

  /**
   * Build a THREE.js group containing:
   *   1. a solid-colour inner sphere
   *   2. a semi-transparent, over-sized outer sphere (glow)
   *
   * Only called for nodes with risk >= 2 via nodeThreeObject.
   */
  function makeGlowSphere(node) {
    /* global THREE -- provided by 3d-force-graph's bundled three.js */
    var THREE = window.THREE;
    if (!THREE) return undefined; // fallback to default rendering

    var radius = nodeSize(node);
    var color  = riskColor(node.risk);

    var group = new THREE.Group();

    // Inner solid sphere
    var innerGeo = new THREE.SphereGeometry(radius, 16, 12);
    var innerMat = new THREE.MeshLambertMaterial({ color: color });
    var innerMesh = new THREE.Mesh(innerGeo, innerMat);
    group.add(innerMesh);

    // Outer glow sphere
    var outerGeo = new THREE.SphereGeometry(radius * 1.8, 16, 12);
    var outerMat = new THREE.MeshBasicMaterial({
      color:       color,
      transparent: true,
      opacity:     0.18,
      depthWrite:  false,
    });
    var outerMesh = new THREE.Mesh(outerGeo, outerMat);
    group.add(outerMesh);

    return group;
  }

  /* ──────────────────────── tooltip text ────────────────────────────── */

  function tooltipText(node) {
    var icon  = TYPE_ICONS[node.type] || '•';
    var label = node.label || node.id || '?';
    var type  = node.type  || 'unknown';
    var file  = node.file  || '';
    var risk  = riskLabel(node.risk || 0);

    return icon + ' ' + label + '\n' + type + ' · ' + file + '\n' + risk;
  }

  /* ─────────────────────── state variables ──────────────────────────── */

  var _graph     = null;
  var _container = null;
  var _animFrame  = null;

  /* ════════════════════════ PUBLIC: init ════════════════════════════ */

  function init(container, data) {
    // Guard: library check
    if (typeof ForceGraph3D === 'undefined') {
      console.warn('[Graph3D] ForceGraph3D is not loaded. Skipping initialisation.');
      return;
    }

    // Guard: container
    if (!container) {
      console.warn('[Graph3D] No container element provided.');
      return;
    }

    // Clean up any existing instance
    if (_graph) {
      destroy();
    }

    _container = container;

    // Normalise & cap the data
    var safe = capData(data);
    var nodes = safe.nodes;
    var edges = safe.edges;

    // Ensure every node has required defaults
    for (var i = 0; i < nodes.length; i++) {
      var n     = nodes[i];
      n.id      = n.id    != null ? n.id    : ('node_' + i);
      n.label   = n.label || String(n.id);
      n.type    = n.type  || 'function';
      n.file    = n.file  || '';
      n.risk    = Number(n.risk) || 0;
      n._conns  = Number(n._conns) || 0;
      n.summary = n.summary || '';
    }

    // Build a quick adjacency set for click-highlight
    var adjacency = buildAdjacency(nodes, edges);

    // ─── create graph instance ───
    _graph = ForceGraph3D()(container)
      .graphData({ nodes: nodes, links: edges })
      .backgroundColor('#1a1714')
      .nodeId('id')
      .linkSource('source')
      .linkTarget('target')
      .warmupTicks(0)
      .cooldownTicks(100)
      .d3AlphaDecay(0.04)
      // ── node visuals ──
      .nodeVal(function (n) { return nodeSize(n); })
      .nodeColor(function (n) {
        return TYPE_COLORS[n.type] || '#95a5a6';
      })
      .nodeOpacity(1)
      .nodeThreeObject(function (n) {
        if ((n.risk || 0) >= 2) return makeGlowSphere(n);
        return undefined; // use default sphere
      })
      .nodeThreeObjectExtend(false)
      // ── edge visuals ──
      .linkColor(edgeColor)
      .linkWidth(edgeWidth)
      .linkOpacity(1)
      // ── tooltip ──
      .nodeLabel(tooltipText)
      // ── click: focus / dim ──
      .onNodeClick(function (node) {
        highlightNode(node, adjacency);
      })
      .onBackgroundClick(function () {
        resetHighlight();
      });

    // DAG mode off by default — expose a setter
    _graph.dagMode(null);
  }

  /* ────────────── adjacency helper for click-highlight ──────────────── */

  function buildAdjacency(nodes, edges) {
    var map = {};
    for (var i = 0; i < nodes.length; i++) {
      map[nodes[i].id] = new Set();
    }
    for (var j = 0; j < edges.length; j++) {
      var src = typeof edges[j].source === 'object' ? edges[j].source.id : edges[j].source;
      var tgt = typeof edges[j].target === 'object' ? edges[j].target.id : edges[j].target;
      if (map[src]) map[src].add(tgt);
      if (map[tgt]) map[tgt].add(src);
    }
    return map;
  }

  /* ──────────────── click-to-focus / dim behaviour ──────────────────── */

  var _focusedNodeId = null;

  function highlightNode(node, adjacency) {
    if (!_graph || !node) return;
    _focusedNodeId = node.id;

    var connectedIds = adjacency[node.id] || new Set();

    _graph
      .nodeOpacity(function (n) {
        if (n.id === node.id) return 1;
        if (connectedIds.has(n.id)) return 1;
        return 0.1;
      })
      .linkOpacity(function (link) {
        var src = typeof link.source === 'object' ? link.source.id : link.source;
        var tgt = typeof link.target === 'object' ? link.target.id : link.target;
        if (src === node.id || tgt === node.id) return 1;
        return 0.05;
      });
  }

  function resetHighlight() {
    if (!_graph) return;
    _focusedNodeId = null;
    _graph
      .nodeOpacity(1)
      .linkOpacity(1);
  }

  /* ════════════════════════ PUBLIC: destroy ═════════════════════════ */

  function destroy() {
    if (_graph) {
      // 3d-force-graph exposes a renderer & scene via internal API
      try {
        var renderer = _graph.renderer && _graph.renderer();
        if (renderer) {
          renderer.dispose();
          // Remove the canvas from DOM if still attached
          if (renderer.domElement && renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
          }
        }
      } catch (_) { /* swallow */ }

      try {
        var scene = _graph.scene && _graph.scene();
        if (scene) {
          // Traverse and dispose geometries / materials
          scene.traverse(function (obj) {
            if (obj.geometry)  obj.geometry.dispose();
            if (obj.material) {
              if (Array.isArray(obj.material)) {
                obj.material.forEach(function (m) { m.dispose(); });
              } else {
                obj.material.dispose();
              }
            }
          });
        }
      } catch (_) { /* swallow */ }

      // The library's own cleanup
      if (typeof _graph._destructor === 'function') {
        try { _graph._destructor(); } catch (_) { /* swallow */ }
      }

      _graph = null;
    }

    // Cancel any pending animation frame
    if (_animFrame) {
      cancelAnimationFrame(_animFrame);
      _animFrame = null;
    }

    // Clear container contents
    if (_container) {
      _container.innerHTML = '';
      _container = null;
    }

    _focusedNodeId = null;
  }

  /* ════════════════════════ expose API ══════════════════════════════ */

  window.Graph3D = {
    init:    init,
    destroy: destroy,

    /**
     * Toggle directed-acyclic-graph layout mode.
     * @param {'td'|'bu'|'lr'|'rl'|'radialout'|'radialin'|null} mode
     */
    setDagMode: function (mode) {
      if (_graph) _graph.dagMode(mode || null);
    },

    /** Return the underlying ForceGraph3D instance (for advanced use). */
    getInstance: function () {
      return _graph;
    },
  };
})();
