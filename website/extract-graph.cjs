// extract-graph.cjs — extracts real nodes+edges from ai-mind-map's own SQLite DB
// Run: node extract-graph.cjs
const path = require('path');
const fs   = require('fs');

// Locate the per-project DB (ai-mind-map indexes itself)
const projectHash = Buffer.from('E:\\AI MODLES\\ai-mind-map').toString('hex').slice(0,16);
const candidates = [
  path.join(process.env.APPDATA || '', 'ai-mind-map', 'databases', `${projectHash}.db`),
  path.join(process.env.USERPROFILE || '', '.ai-mind-map', 'databases', `${projectHash}.db`),
  path.join(process.env.LOCALAPPDATA || '', 'ai-mind-map', 'databases', `${projectHash}.db`),
];

// Also search common locations
const homeDbs = [
  path.join(process.env.USERPROFILE || '', '.config', 'ai-mind-map'),
  path.join(process.env.APPDATA || '', 'ai-mind-map'),
  path.join(process.env.LOCALAPPDATA || '', 'ai-mind-map'),
  'E:\\AI MODLES\\ai-mind-map\\.mindmap',
];

let dbPath = null;
for (const c of candidates) {
  if (fs.existsSync(c)) { dbPath = c; break; }
}

if (!dbPath) {
  // Search deeper
  for (const base of homeDbs) {
    if (!fs.existsSync(base)) continue;
    const find = (dir) => {
      try {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (f.endsWith('.db')) return full;
          if (fs.statSync(full).isDirectory()) {
            const r = find(full);
            if (r) return r;
          }
        }
      } catch {}
      return null;
    };
    const found = find(base);
    if (found) { dbPath = found; break; }
  }
}

if (!dbPath) {
  console.error('Could not find SQLite DB. Searched:', [...candidates, ...homeDbs]);
  process.exit(1);
}

console.log('Found DB at:', dbPath);

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = require('E:\\AI MODLES\\ai-mind-map\\node_modules\\better-sqlite3');
}

const db = new Database(dbPath, { readonly: true });

// Pull a rich sample: top 80 nodes by connectivity (skip files), all edges between them
const nodes = db.prepare(`
  SELECT 
    n.id, n.name, n.qualifiedName, n.type, n.filePath,
    n.startLine, n.endLine, n.signature, n.docComment,
    n.language, n.visibility, n.isAsync, n.isStatic, n.isExported,
    COUNT(DISTINCT e1.targetId) + COUNT(DISTINCT e2.sourceId) as degree
  FROM nodes n
  LEFT JOIN edges e1 ON e1.sourceId = n.id
  LEFT JOIN edges e2 ON e2.targetId = n.id
  WHERE n.type NOT IN ('file','config')
    AND n.name NOT LIKE 'anonymous%'
    AND n.name NOT LIKE 'for'
    AND length(n.name) > 1
    AND n.filePath LIKE '%src%'
  GROUP BY n.id
  ORDER BY degree DESC
  LIMIT 120
`).all();

const nodeIds = new Set(nodes.map(n => n.id));

const edges = db.prepare(`
  SELECT sourceId, targetId, type
  FROM edges
  WHERE sourceId IN (${[...nodeIds].map(() => '?').join(',')})
    AND targetId IN (${[...nodeIds].map(() => '?').join(',')})
  LIMIT 300
`).all([...nodeIds, ...nodeIds]);

db.close();

// Clean file paths to relative
const projectRoot = 'E:\\AI MODLES\\ai-mind-map\\';
const cleanNodes = nodes.map(n => ({
  id: n.id,
  name: n.name,
  qualifiedName: n.qualifiedName,
  type: n.type,
  file: n.filePath.replace(projectRoot, '').replace(/\\/g, '/'),
  line: n.startLine,
  endLine: n.endLine,
  signature: n.signature || n.name,
  doc: n.docComment || null,
  language: n.language || 'typescript',
  visibility: n.visibility || 'unknown',
  async: !!n.isAsync,
  static: !!n.isStatic,
  exported: !!n.isExported,
  degree: n.degree
}));

const cleanEdges = edges.map(e => ({
  source: e.sourceId,
  target: e.targetId,
  type: e.type
}));

const output = { nodes: cleanNodes, edges: cleanEdges, meta: {
  project: 'ai-mind-map',
  version: '1.21.2',
  totalNodes: 4977,
  totalEdges: 12146,
  extractedAt: new Date().toISOString(),
  description: 'Real graph data — AI Mind Map indexing itself'
}};

const outPath = 'E:\\AI MODLES\\ai-mind-map\\website\\data\\graph-demo.json';
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`✅ Written ${cleanNodes.length} nodes, ${cleanEdges.length} edges to ${outPath}`);
