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
    // Hono (edge framework): app.get('/path', handler)
    { regex: /(?:app|hono)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'hono' },
    // NestJS decorators: @Get('/path'), @Post('/path')
    { regex: /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'nestjs' },
    // Django REST: @api_view(['GET', 'POST'])
    { regex: /@api_view\s*\(\s*\[([^\]]+)\]/gi, type: 'django-rest' },
    // Spring Boot: @GetMapping("/path"), @PostMapping, @RequestMapping
    { regex: /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]/gi, type: 'spring' },
    // Gin (Go): r.GET("/path", handler)
    { regex: /(?:r|router|g|engine)\.(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: 'gin' },
    // Ruby on Rails: get '/path', to: 'controller#action'
    { regex: /(?:^|\s)(get|post|put|patch|delete)\s+['"`]([^'"`]+)['"`]\s*,\s*to:/gim, type: 'rails' },
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
    // Redis
    { regex: /(?:redis|client)\.(get|set|hset|hget|hgetall|del|lpush|rpush|lrange|sadd|smembers|zadd|zrange|expire|incr|decr|publish|subscribe)\s*\(/gi, type: 'redis' },
    // Firebase Firestore
    { regex: /(?:db|firestore)\s*\.\s*collection\s*\(\s*['"`]([^'"`]+)['"`]\)/gi, type: 'firebase' },
    // TypeORM
    { regex: /(?:repository|manager)\.(find|findOne|findOneBy|save|remove|delete|update|createQueryBuilder|count)\s*\(/gi, type: 'typeorm' },
    // Drizzle ORM
    { regex: /(?:db)\.(select|insert|update|delete)\s*\(\s*\)/gi, type: 'drizzle' },
  ];

  /* ═══════════════════════════════════════════════════════════════
     ███  SMART SUMMARIES — Human-readable descriptions  ███
     ═══════════════════════════════════════════════════════════════ */

  const CALL_SUMMARIES = {
    // ─── MongoDB / Mongoose ───
    'find':              'Queries the database to find all documents matching a filter',
    'findOne':           'Finds a single document matching the query criteria',
    'findById':          'Looks up one document by its unique ID',
    'findOneAndUpdate':  'Finds a document and updates it in one atomic operation',
    'aggregate':         'Runs an aggregation pipeline (group, filter, transform data)',
    'insertMany':        'Inserts multiple documents into the collection at once',
    'create':            'Creates and saves a new document to the database',
    'save':              'Persists the current document (insert or update) to the database',
    'deleteOne':         'Removes the first document matching the filter',
    'deleteMany':        'Removes all documents matching the filter',
    'updateOne':         'Updates the first document matching the filter',
    'updateMany':        'Updates all documents matching the filter',
    'countDocuments':    'Counts how many documents match the query',
    // ─── Prisma ───
    'findUnique':        'Finds exactly one record by a unique field (ID, email, etc.)',
    'findMany':          'Fetches multiple records matching the filter criteria',
    'upsert':            'Creates the record if it doesn\'t exist, updates it if it does',
    'count':             'Returns the count of records matching the filter',
    // ─── Sequelize ───
    'findAll':           'Retrieves all records matching the query conditions',
    'findByPk':          'Finds a single record by its primary key',
    'bulkCreate':        'Inserts multiple records in a single batch operation',
    'destroy':           'Deletes records matching the condition from the database',
    // ─── SQL ───
    'SELECT':            'Reads data from the database tables',
    'INSERT':            'Adds new rows of data into a table',
    'UPDATE':            'Modifies existing data in a table',
    'DELETE':            'Removes rows from a table',
    'CREATE':            'Creates a new database table or object',
    'DROP':              'Permanently deletes a table or database object',
    // ─── HTTP / API ───
    'GET':               'Fetches data from an external API endpoint',
    'POST':              'Sends data to create a new resource at the API',
    'PUT':               'Sends data to fully replace a resource at the API',
    'PATCH':             'Sends data to partially update a resource at the API',
    // ─── Express Middleware ───
    'cors':              'Enables Cross-Origin Resource Sharing for the server',
    'helmet':            'Adds security HTTP headers to protect against attacks',
    'morgan':            'Logs HTTP requests for debugging and monitoring',
    'bodyParser':        'Parses incoming request bodies (JSON, form data)',
    'cookieParser':      'Parses cookies from incoming HTTP requests',
    'session':           'Manages user sessions with server-side storage',
    'passport':          'Handles user authentication (login, OAuth, JWT)',
    'multer':            'Handles file uploads from multipart form data',
    'compression':       'Compresses HTTP responses to reduce bandwidth',
    'rateLimit':         'Limits how many requests a client can make per time window',
    'express':           'Core web framework — handles HTTP request/response cycle',
    'json':              'Parses JSON request bodies from incoming HTTP requests',
    'urlencoded':        'Parses URL-encoded form data from HTTP requests',
    'static':            'Serves static files (CSS, JS, images) from a directory',
    'errorHandler':      'Catches and processes errors in the request pipeline',
    'auth':              'Authenticates users and protects routes from unauthorized access',
    'logger':            'Records server activity for debugging and auditing',
    'validator':         'Validates request data (params, body, query) against rules',
    // ─── Redis ───
    'set':               'Stores a value in Redis cache with a key',
    'hset':              'Sets a field in a Redis hash',
    'hget':              'Gets a field value from a Redis hash',
    'hgetall':           'Gets all fields and values from a Redis hash',
    'del':               'Deletes a key from Redis',
    'lpush':             'Pushes a value to the left of a Redis list',
    'rpush':             'Pushes a value to the right of a Redis list',
    'lrange':            'Gets a range of elements from a Redis list',
    'sadd':              'Adds a member to a Redis set',
    'smembers':          'Gets all members of a Redis set',
    'zadd':              'Adds a member to a Redis sorted set with a score',
    'zrange':            'Gets members in a range from a Redis sorted set',
    'expire':            'Sets a time-to-live (TTL) on a Redis key',
    'incr':              'Atomically increments a Redis integer value by 1',
    'subscribe':         'Subscribes to a Redis pub/sub channel for messages',
    'publish':           'Publishes a message to a Redis pub/sub channel',
    // ─── Firebase ───
    'doc':               'References a specific document in a Firestore collection',
    'where':             'Adds a filter condition to a Firestore query',
    'orderBy':           'Sorts Firestore query results by a field',
    'limit':             'Limits the number of results from a Firestore query',
    'onSnapshot':        'Listens for real-time updates to a Firestore query',
    // ─── TypeORM ───
    'findOneBy':         'Finds a single entity matching the given criteria',
    'createQueryBuilder': 'Creates a SQL query builder for complex queries',
    'remove':            'Removes an entity from the database',
  };

  /**
   * Generates a human-readable summary from a function name using pattern matching.
   * e.g. "getUserProfile" → "Retrieves/reads data — get user profile"
   */
  function generateFunctionSummary(name) {
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
      { regex: /^(log|debug|trace|warn|error|info)/i, desc: 'Logs information for debugging' },
      { regex: /^(cache|memo|buffer|queue)/i, desc: 'Manages caching or buffering' },
      { regex: /^(encrypt|decrypt|hash|sign|token)/i, desc: 'Handles encryption or tokens' },
      { regex: /^(upload|download|stream|pipe)/i, desc: 'Handles file transfer' },
      { regex: /^(sort|filter|group|aggregate|count|sum)/i, desc: 'Performs data aggregation/filtering' },
      { regex: /^(schedule|cron|timer|interval|delay)/i, desc: 'Schedules or delays an operation' },
      { regex: /^(middleware|use|pipe|chain)/i, desc: 'Processes data in a pipeline' },
      { regex: /^(run|execute|start|begin|launch|spawn)/i, desc: 'Starts or executes a process' },
      { regex: /^(stop|end|close|shutdown|terminate|kill)/i, desc: 'Stops or terminates a process' },
      { regex: /^(build|compile|generate|make|produce)/i, desc: 'Builds or generates output' },
      { regex: /^(reset|restore|revert|undo|rollback)/i, desc: 'Resets or restores to previous state' },
    ];
    const readable = name.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase();
    for (const p of patterns) {
      if (p.regex.test(name)) return p.desc + ' — ' + readable;
    }
    return 'Executes the ' + readable + ' operation';
  }

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
    const seen = new Map(); // key → count for dedup
    
    files.forEach(file => {
      const content = file.content || '';
      API_CALL_PATTERNS.forEach(pattern => {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          const url = pattern.type === 'axios' ? m[2] : m[1];
          const method = pattern.type === 'axios' ? m[1].toUpperCase() : 'GET';
          const key = `api:${file.path}:${method}:${url}`;
          const line = content.substring(0, m.index).split('\n').length;
          if (seen.has(key)) {
            seen.get(key).count++;
          } else {
            const entry = {
              url,
              method,
              file: file.path,
              line,
              type: pattern.type,
              id: key,
              count: 1
            };
            seen.set(key, entry);
            apiCalls.push(entry);
          }
        }
      });
    });
    
    return apiCalls;
  }

  function detectDBQueries(files) {
    const queries = [];
    const seen = new Map(); // key → count for dedup
    
    files.forEach(file => {
      const content = file.content || '';
      DB_PATTERNS.forEach(pattern => {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m;
        while ((m = re.exec(content)) !== null) {
          const operation = m[1] || m[2];
          const key = `db:${file.path}:${operation}`;
          const line = content.substring(0, m.index).split('\n').length;
          if (seen.has(key)) {
            seen.get(key).count++;
          } else {
            const entry = {
              operation,
              file: file.path,
              line,
              type: pattern.type,
              id: key,
              count: 1
            };
            seen.set(key, entry);
            queries.push(entry);
          }
        }
      });
    });
    
    return queries;
  }

  /* ═══════════════════════════════════════════════════════════════
     ███  ENRICHED GRAPH BUILDER  ███
     ═══════════════════════════════════════════════════════════════ */

  let _lastResult = null;

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
      // Enrich with summary if missing
      if (!copy.summary && copy.type === 'function') {
        copy.summary = generateFunctionSummary(copy.label || copy.id);
      }
      if (!copy.summary && copy.type === 'class') {
        copy.summary = `Class ${copy.label} — defines a data structure or component`;
      }
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
          framework: route.framework,
          summary: `Handles ${route.method} requests to ${route.path} (${route.framework})`
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
          connections: 0,
          summary: CALL_SUMMARIES[mw.name] || `Middleware that processes requests before they reach the handler`
        });
        nodeIds.add(mw.id);
      }
    });
    
    // Add API call nodes (limited to first 20)
    apiCalls.slice(0, 20).forEach(api => {
      if (!nodeIds.has(api.id)) {
        nodes.push({
          id: api.id,
          label: api.count > 1 ? `${api.method} ${api.url.substring(0, 30)} ×${api.count}` : `${api.method} ${api.url.substring(0, 40)}`,
          type: 'api-call',
          file: api.file,
          line: api.line,
          risk: 0,
          connections: 0,
          url: api.url,
          count: api.count,
          summary: (CALL_SUMMARIES[api.method] || `Makes an HTTP ${api.method} request`) + ` to ${api.url.substring(0, 50)}` + (api.count > 1 ? ` (called ${api.count}×)` : '')
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
          label: db.count > 1 ? `DB.${db.operation}() ×${db.count}` : `DB.${db.operation}()`,
          type: 'db-query',
          file: db.file,
          line: db.line,
          risk: 0,
          connections: 0,
          operation: db.operation,
          count: db.count,
          summary: (CALL_SUMMARIES[db.operation] || `Performs a ${db.operation} operation on the database`) + (db.count > 1 ? ` (called ${db.count}×)` : '')
        });
        nodeIds.add(db.id);
        
        // Connect to the function that contains this DB query
        const parentFn = nodes.find(n => n.type === 'function' && n.file === db.file && Math.abs((n.line || 0) - db.line) < 30);
        if (parentFn) {
          edges.push({ source: parentFn.id, target: db.id, type: 'db-query', label: 'queries DB' });
        }
      }
    });
    
    // Deduplicate edges
    const edgeKeys = new Set();
    const uniqueEdges = edges.filter(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      const key = `${s}→${t}:${e.type}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    });
    
    // Update connection counts
    const connCount = {};
    uniqueEdges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : e.source.id;
      const t = typeof e.target === 'string' ? e.target : e.target.id;
      connCount[s] = (connCount[s] || 0) + 1;
      connCount[t] = (connCount[t] || 0) + 1;
    });
    nodes.forEach(n => { n.connections = connCount[n.id] || 0; });
    
    _lastResult = {
      nodes,
      edges: uniqueEdges,
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
        totalEdges: uniqueEdges.length
      }
    };
    return _lastResult;
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
    getLastResult: () => _lastResult,
    detectRoutes,
    detectMiddleware,
    detectAPICalls,
    detectDBQueries,
    traceFlow,
    traceReverse,
    generateFunctionSummary,
    CALL_SUMMARIES
  };

})();
