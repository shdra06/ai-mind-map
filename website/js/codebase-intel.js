/**
 * AI Mind Map — Codebase Intelligence Engine
 * 
 * Enhanced parser that detects:
 * - HTTP routes (Express, Fastify, Koa, Flask, FastAPI)
 * - Middleware chains
 * - External API calls (fetch, axios)
 * - Database operations
 * - Creates enriched graph data for visualization
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════
     ███  ROUTE DETECTION  ███
     ═══════════════════════════════════════════════════════════════ */

  const ROUTE_PATTERNS = [
    // Express/Koa: app.get('/path', handler) or router.post('/path', ...middlewares, handler)
    { regex: /(?:app|router|server)\.(get|post|put|delete|patch|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'express' },
    // Fastify: fastify.get('/path', handler)
    { regex: /fastify\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'fastify' },
    // Flask: @app.route('/path', methods=['GET'])
    { regex: /@(?:app|blueprint|bp)\.route\s*\(\s*['"`]([^'"`]+)['"`](?:.*?methods\s*=\s*\[([^\]]+)\])?/gi, type: 'flask' },
    // FastAPI: @app.get('/path')
    { regex: /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'fastapi' },
    // Next.js API routes (filename-based)
    { regex: /export\s+(?:default\s+)?(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\s*\(/gi, type: 'nextjs' },
  ];

  const MIDDLEWARE_PATTERNS = [
    // Express middleware: app.use(auth), app.use('/path', cors)
    /(?:app|router)\.(use)\s*\(\s*(?:['"`]([^'"`]*)['"`]\s*,\s*)?(\w+)/gi,
  ];

  const API_CALL_PATTERNS = [
    // fetch() calls
    { regex: /fetch\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'fetch' },
    { regex: /fetch\s*\(\s*`([^`]+)`/gi, type: 'fetch-template' },
    // axios calls
    { regex: /axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'axios' },
    // http/https calls
    { regex: /https?\.(?:get|request)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'http' },
  ];

  const DB_PATTERNS = [
    // MongoDB/Mongoose
    { regex: /\.(find|findOne|findById|findOneAndUpdate|aggregate|insertMany|create|save|deleteOne|deleteMany|updateOne|updateMany|countDocuments)\s*\(/gi, type: 'mongodb' },
    // SQL (generic)
    { regex: /\.(query|execute|raw)\s*\(\s*['"`]\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP)/gi, type: 'sql' },
    // Prisma
    { regex: /prisma\.(\w+)\.(findUnique|findMany|create|update|delete|upsert|count)\s*\(/gi, type: 'prisma' },
    // Sequelize
    { regex: /(\w+)\.(findAll|findOne|findByPk|create|update|destroy|bulkCreate)\s*\(/gi, type: 'sequelize' },
  ];

  /* ═══════════════════════════════════════════════════════════════
     ███  ENHANCED PARSER  ███
     ═══════════════════════════════════════════════════════════════ */

  function detectRoutes(files) {
    const routes = [];
    
    files.forEach(file => {
      const content = file.content || '';
      
      ROUTE_PATTERNS.forEach(pattern => {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          let method, path;
          if (pattern.type === 'flask') {
            path = m[1]; method = m[2] ? m[2].replace(/['"]/g, '').trim() : 'GET';
          } else if (pattern.type === 'nextjs') {
            method = m[1]; path = file.path.replace(/.*\/api/, '/api').replace(/\.\w+$/, '');
          } else {
            method = m[1].toUpperCase(); path = m[2];
          }
          
          // Find handler function name (next identifier after the route pattern)
          const afterMatch = content.substring(m.index + m[0].length, m.index + m[0].length + 200);
          const handlerMatch = afterMatch.match(/(?:,\s*)?(\w+)(?:\s*\)|,)/);
          const handlerName = handlerMatch ? handlerMatch[1] : null;
          
          // Find line number
          const line = content.substring(0, m.index).split('\n').length;
          
          routes.push({
            method: method.toUpperCase(),
            path,
            handler: handlerName,
            file: file.path,
            line,
            framework: pattern.type,
            id: `route:${method}:${path}`
          });
        }
      });
    });
    
    return routes;
  }

  function detectMiddleware(files) {
    const middlewares = [];
    
    files.forEach(file => {
      const content = file.content || '';
      MIDDLEWARE_PATTERNS.forEach(pattern => {
        const re = new RegExp(pattern.source, pattern.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          middlewares.push({
            name: m[3] || 'anonymous',
            path: m[2] || '/',
            file: file.path,
            line: content.substring(0, m.index).split('\n').length,
            id: `mw:${file.path}:${m[3] || 'anon'}`
          });
        }
      });
    });
    
    return middlewares;
  }

  function detectAPICalls(files) {
    const apiCalls = [];
    
    files.forEach(file => {
      const content = file.content || '';
      API_CALL_PATTERNS.forEach(pattern => {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          const url = pattern.type === 'axios' ? m[2] : m[1];
          apiCalls.push({
            url: url,
            method: pattern.type === 'axios' ? m[1].toUpperCase() : 'GET',
            file: file.path,
            line: content.substring(0, m.index).split('\n').length,
            type: pattern.type,
            id: `api:${file.path}:${m.index}`
          });
        }
      });
    });
    
    return apiCalls;
  }

  function detectDBQueries(files) {
    const queries = [];
    
    files.forEach(file => {
      const content = file.content || '';
      DB_PATTERNS.forEach(pattern => {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          queries.push({
            operation: m[1] || m[2],
            file: file.path,
            line: content.substring(0, m.index).split('\n').length,
            type: pattern.type,
            id: `db:${file.path}:${m.index}`
          });
        }
      });
    });
    
    return queries;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  ENRICHED GRAPH BUILDER  ███
     ═══════════════════════════════════════════════════════════════ */

  function buildIntelGraph(files, existingNodes, existingEdges) {
    const routes = detectRoutes(files);
    const middlewares = detectMiddleware(files);
    const apiCalls = detectAPICalls(files);
    const dbQueries = detectDBQueries(files);
    
    // Start with existing nodes/edges (shallow copy nodes/edges to prevent D3 object reference mutation leakage)
    const nodes = existingNodes.map(n => {
      const copy = { ...n };
      delete copy.index;
      delete copy.vx;
      delete copy.vy;
      if (copy.x !== undefined && !isFinite(copy.x)) delete copy.x;
      if (copy.y !== undefined && !isFinite(copy.y)) delete copy.y;
      return copy;
    });
    const edges = existingEdges.map(e => ({
      ...e,
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target
    }));
    const nodeIds = new Set(nodes.map(n => n.id));
    
    // Add route nodes
    routes.forEach(route => {
      if (!nodeIds.has(route.id)) {
        nodes.push({
          id: route.id,
          label: `${route.method} ${route.path}`,
          type: 'route',
          file: route.file,
          line: route.line,
          risk: 0,
          connections: 0,
          method: route.method,
          path: route.path,
          framework: route.framework
        });
        nodeIds.add(route.id);
      }
      
      // Connect route to handler function
      if (route.handler) {
        const handlerNode = nodes.find(n => n.label === route.handler && n.file === route.file);
        if (handlerNode) {
          edges.push({ source: route.id, target: handlerNode.id, type: 'calls', label: 'handles' });
        }
      }
    });
    
    // Add middleware nodes
    middlewares.forEach(mw => {
      if (!nodeIds.has(mw.id)) {
        nodes.push({
          id: mw.id,
          label: mw.name,
          type: 'middleware',
          file: mw.file,
          line: mw.line,
          risk: 0,
          connections: 0
        });
        nodeIds.add(mw.id);
      }
    });
    
    // Add API call nodes (limited to first 20)
    apiCalls.slice(0, 20).forEach(api => {
      if (!nodeIds.has(api.id)) {
        nodes.push({
          id: api.id,
          label: `${api.method} ${api.url.substring(0, 40)}`,
          type: 'api-call',
          file: api.file,
          line: api.line,
          risk: 0,
          connections: 0,
          url: api.url
        });
        nodeIds.add(api.id);
        
        // Connect to the function that contains this API call
        const parentFn = nodes.find(n => n.type === 'function' && n.file === api.file && Math.abs((n.line || 0) - api.line) < 30);
        if (parentFn) {
          edges.push({ source: parentFn.id, target: api.id, type: 'api-request', label: 'calls API' });
        }
      }
    });
    
    // Add DB query nodes (limited to first 20)
    dbQueries.slice(0, 20).forEach(db => {
      if (!nodeIds.has(db.id)) {
        nodes.push({
          id: db.id,
          label: `DB.${db.operation}()`,
          type: 'db-query',
          file: db.file,
          line: db.line,
          risk: 0,
          connections: 0,
          operation: db.operation
        });
        nodeIds.add(db.id);
        
        // Connect to the function that contains this DB query
        const parentFn = nodes.find(n => n.type === 'function' && n.file === db.file && Math.abs((n.line || 0) - db.line) < 30);
        if (parentFn) {
          edges.push({ source: parentFn.id, target: db.id, type: 'db-query', label: 'queries DB' });
        }
      }
    });
    
    // Update connection counts
    const connCount = {};
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      connCount[s] = (connCount[s] || 0) + 1;
      connCount[t] = (connCount[t] || 0) + 1;
    });
    nodes.forEach(n => { n.connections = connCount[n.id] || 0; });
    
    return {
      nodes,
      edges,
      routes,
      middlewares,
      apiCalls: apiCalls.slice(0, 20),
      dbQueries: dbQueries.slice(0, 20),
      files,
      stats: {
        routes: routes.length,
        middlewares: middlewares.length,
        apiCalls: apiCalls.length,
        dbQueries: dbQueries.length,
        totalNodes: nodes.length,
        totalEdges: edges.length
      }
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  FLOW TRACER  ███
     ═══════════════════════════════════════════════════════════════ */

  function traceFlow(startNodeId, edges, nodes, maxDepth = 10) {
    const visited = new Set();
    const path = [];
    const queue = [{ id: startNodeId, depth: 0 }];
    
    // Build adjacency list (outgoing edges only)
    const adj = {};
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      if (!adj[s]) adj[s] = [];
      adj[s].push({ target: t, type: e.type, label: e.label });
    });
    
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);
      
      const node = nodes.find(n => n.id === id);
      if (node) path.push({ node, depth });
      
      const neighbors = adj[id] || [];
      neighbors.forEach(n => {
        if (!visited.has(n.target)) {
          queue.push({ id: n.target, depth: depth + 1 });
        }
      });
    }
    
    return path;
  }

  function traceReverse(nodeId, edges, nodes, maxDepth = 10) {
    const visited = new Set();
    const dependents = [];
    const queue = [{ id: nodeId, depth: 0 }];
    
    // Build reverse adjacency list
    const radj = {};
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      if (!radj[t]) radj[t] = [];
      radj[t].push({ source: s, type: e.type });
    });
    
    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);
      
      const node = nodes.find(n => n.id === id);
      if (node && depth > 0) dependents.push({ node, depth });
      
      const deps = radj[id] || [];
      deps.forEach(d => {
        if (!visited.has(d.source)) {
          queue.push({ id: d.source, depth: depth + 1 });
        }
      });
    }
    
    return dependents;
  }

  // Export
  window.CodebaseIntel = {
    buildIntelGraph,
    detectRoutes,
    detectMiddleware,
    detectAPICalls,
    detectDBQueries,
    traceFlow,
    traceReverse
  };

})();
