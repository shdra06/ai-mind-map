/* ===========================================================================
 * ast-worker.js — Web Worker for tree-sitter AST parsing
 *
 * Loaded via:  new Worker('js/ast-worker.js')
 *
 * Messages accepted:
 *   {type:'init'}
 *   {type:'parse',   file:{path, content, language}}
 *   {type:'batch',   files:[{path, content, language}, …]}
 *   {type:'build-symbol-table', allSymbols:[{path, symbols}, …]}
 *
 * Messages posted back:
 *   {type:'ready'}
 *   {type:'parsed',       path, symbols}
 *   {type:'batch-done',   results:[{path, symbols}]}
 *   {type:'symbol-table', definitions, edges}
 *   {type:'error',        message}
 * =========================================================================== */

/* global importScripts, TreeSitter */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var TS_CDN      = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.24.7/tree-sitter.js';
var TS_WASM_URL = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.24.7/tree-sitter.wasm';

var GRAMMAR_URLS = {
  javascript: 'https://cdn.jsdelivr.net/npm/tree-sitter-javascript@0.23.1/tree-sitter-javascript.wasm',
  jsx:        'https://cdn.jsdelivr.net/npm/tree-sitter-javascript@0.23.1/tree-sitter-javascript.wasm',
  typescript: 'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-typescript.wasm',
  tsx:        'https://cdn.jsdelivr.net/npm/tree-sitter-typescript@0.23.2/tree-sitter-typescript.wasm',
  python:     'https://cdn.jsdelivr.net/npm/tree-sitter-python@0.23.6/tree-sitter-python.wasm'
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var parser       = null;   // TreeSitter.Parser instance
var languageCache = {};    // language-key → TreeSitter.Language
var isReady      = false;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Load the tree-sitter runtime and initialise the WASM backend.
 */
function init() {
  try {
    importScripts(TS_CDN);

    return TreeSitter.init({
      locateFile: function () { return TS_WASM_URL; }
    }).then(function () {
      parser  = new TreeSitter();
      isReady = true;
      postMessage({ type: 'ready' });
    });
  } catch (err) {
    postMessage({ type: 'error', message: 'Failed to initialise tree-sitter: ' + err.message });
  }
}

// ---------------------------------------------------------------------------
// Grammar loading (lazy, cached)
// ---------------------------------------------------------------------------

/**
 * Resolve a language key to a normalised key used for grammar caching.
 * javascript/jsx share one grammar; typescript/tsx share another.
 */
function normaliseLanguageKey(lang) {
  lang = (lang || '').toLowerCase().trim();
  if (lang === 'jsx') return 'javascript';
  if (lang === 'tsx') return 'typescript';
  return lang;
}

/**
 * Load (or return cached) tree-sitter Language for the given key.
 * Returns a Promise<Language|null>.
 */
function loadLanguage(langRaw) {
  var key = normaliseLanguageKey(langRaw);
  var url = GRAMMAR_URLS[key];

  if (!url) {
    postMessage({ type: 'error', message: 'Unsupported language: ' + langRaw });
    return Promise.resolve(null);
  }

  if (languageCache[key]) {
    return Promise.resolve(languageCache[key]);
  }

  return TreeSitter.Language.load(url)
    .then(function (lang) {
      languageCache[key] = lang;
      return lang;
    })
    .catch(function (err) {
      postMessage({ type: 'error', message: 'Failed to load grammar for ' + key + ': ' + err.message });
      return null;
    });
}

// ---------------------------------------------------------------------------
// AST Walking — helpers
// ---------------------------------------------------------------------------

/**
 * Collect the text of immediate named children of a given field, or
 * return the node's own text when it is a leaf.
 */
function nodeText(node) {
  return node ? node.text : '';
}

/**
 * Check whether a node is wrapped in an export_statement (JS/TS).
 */
function isExported(node) {
  var p = node.parent;
  while (p) {
    if (p.type === 'export_statement') return true;
    // In Python there are no export statements — always false
    if (p.type === 'program' || p.type === 'module') break;
    p = p.parent;
  }
  return false;
}

/**
 * Extract parameter names from a formal_parameters / parameters node.
 */
function extractParams(paramsNode) {
  if (!paramsNode) return [];
  var params = [];
  for (var i = 0; i < paramsNode.namedChildCount; i++) {
    var child = paramsNode.namedChild(i);
    // JS/TS: identifier, assignment_pattern (default), rest_pattern, etc.
    // Python: identifier, default_parameter, typed_parameter, etc.
    switch (child.type) {
      case 'identifier':
        params.push(child.text);
        break;
      case 'required_parameter':
      case 'optional_parameter':
      case 'typed_parameter':
      case 'default_parameter':
      case 'assignment_pattern':
      case 'rest_pattern':
      case 'rest_element': {
        // First identifier child is the param name
        var id = child.descendantsOfType ? child.descendantsOfType('identifier')[0] : null;
        if (!id) {
          // fallback: walk children
          for (var j = 0; j < child.namedChildCount; j++) {
            if (child.namedChild(j).type === 'identifier') {
              id = child.namedChild(j);
              break;
            }
          }
        }
        if (id) params.push(id.text);
        break;
      }
      default:
        // Best-effort: take the text
        if (child.text && child.text.length < 60) params.push(child.text);
        break;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// AST Walking — JavaScript / TypeScript
// ---------------------------------------------------------------------------

function walkJS(rootNode, filePath) {
  var functions = [];
  var classes   = [];
  var imports   = [];
  var exports   = [];
  var calls     = [];

  function walk(node) {
    if (!node) return;

    switch (node.type) {

      // ---- function_declaration ----
      case 'function_declaration':
      case 'generator_function_declaration': {
        var nameNode   = node.childForFieldName('name');
        var paramsNode = node.childForFieldName('parameters');
        functions.push({
          name:     nodeText(nameNode),
          line:     node.startPosition.row + 1,
          params:   extractParams(paramsNode),
          exported: isExported(node)
        });
        break;
      }

      // ---- arrow_function assigned to variable ----
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (var d = 0; d < node.namedChildCount; d++) {
          var declarator = node.namedChild(d);
          if (declarator.type === 'variable_declarator') {
            var val = declarator.childForFieldName('value');
            if (val && (val.type === 'arrow_function' || val.type === 'function' || val.type === 'function_expression')) {
              var vName   = declarator.childForFieldName('name');
              var vParams = val.childForFieldName('parameters');
              functions.push({
                name:     nodeText(vName),
                line:     declarator.startPosition.row + 1,
                params:   extractParams(vParams),
                exported: isExported(node)
              });
            }
          }
        }
        // Continue walking children for nested calls, etc.
        for (var dc = 0; dc < node.namedChildCount; dc++) walk(node.namedChild(dc));
        return; // already walked children
      }

      // ---- class_declaration ----
      case 'class_declaration': {
        var cName    = node.childForFieldName('name');
        var cBody    = node.childForFieldName('body');
        var methods  = [];

        if (cBody) {
          for (var m = 0; m < cBody.namedChildCount; m++) {
            var member = cBody.namedChild(m);
            if (member.type === 'method_definition' || member.type === 'public_field_definition') {
              var mName   = member.childForFieldName('name');
              var mParams = member.childForFieldName('parameters');
              methods.push({
                name:   nodeText(mName),
                line:   member.startPosition.row + 1,
                params: extractParams(mParams)
              });
            }
          }
        }

        classes.push({
          name:     nodeText(cName),
          line:     node.startPosition.row + 1,
          methods:  methods,
          exported: isExported(node)
        });
        break;
      }

      // ---- import_statement ----
      case 'import_statement': {
        var source  = node.childForFieldName('source');
        var modName = source ? source.text.replace(/['"]/g, '') : '';
        var names   = [];

        // import { a, b } from '...'
        // import X from '...'
        for (var ic = 0; ic < node.namedChildCount; ic++) {
          var impChild = node.namedChild(ic);
          if (impChild.type === 'import_clause') {
            for (var icc = 0; icc < impChild.namedChildCount; icc++) {
              var clause = impChild.namedChild(icc);
              if (clause.type === 'identifier') {
                names.push(clause.text);
              } else if (clause.type === 'named_imports') {
                for (var ni = 0; ni < clause.namedChildCount; ni++) {
                  var spec = clause.namedChild(ni);
                  if (spec.type === 'import_specifier') {
                    var specName = spec.childForFieldName('name') || spec.childForFieldName('alias');
                    if (specName) names.push(specName.text);
                  }
                }
              } else if (clause.type === 'namespace_import') {
                var nsName = clause.childForFieldName('name');
                if (nsName) names.push('* as ' + nsName.text);
              }
            }
          }
        }

        imports.push({ module: modName, names: names, line: node.startPosition.row + 1 });
        break;
      }

      // ---- export_statement ----
      case 'export_statement': {
        var expNames = [];
        for (var ec = 0; ec < node.namedChildCount; ec++) {
          var expChild = node.namedChild(ec);
          if (expChild.type === 'export_clause') {
            for (var es = 0; es < expChild.namedChildCount; es++) {
              var expSpec = expChild.namedChild(es);
              if (expSpec.type === 'export_specifier') {
                var eName = expSpec.childForFieldName('name');
                if (eName) expNames.push(eName.text);
              }
            }
          } else if (expChild.type === 'function_declaration' || expChild.type === 'class_declaration') {
            var edName = expChild.childForFieldName('name');
            if (edName) expNames.push(edName.text);
          } else if (expChild.type === 'lexical_declaration' || expChild.type === 'variable_declaration') {
            for (var evd = 0; evd < expChild.namedChildCount; evd++) {
              var evDecl = expChild.namedChild(evd);
              if (evDecl.type === 'variable_declarator') {
                var evName = evDecl.childForFieldName('name');
                if (evName) expNames.push(evName.text);
              }
            }
          }
        }
        if (expNames.length > 0) {
          exports.push({ names: expNames, line: node.startPosition.row + 1 });
        }
        // Don't break — we still want to walk into exported declarations
        for (var ew = 0; ew < node.namedChildCount; ew++) walk(node.namedChild(ew));
        return;
      }

      // ---- call_expression ----
      case 'call_expression': {
        var callee   = node.childForFieldName('function');
        var callName = '';

        if (callee) {
          if (callee.type === 'identifier') {
            callName = callee.text;
          } else if (callee.type === 'member_expression') {
            // e.g. obj.method or this.method
            callName = callee.text;
          } else {
            callName = callee.text;
          }
        }

        if (callName) {
          calls.push({ name: callName, line: node.startPosition.row + 1, file: filePath });
        }
        break;
      }
    }

    // Default: recurse into children
    for (var ci = 0; ci < node.namedChildCount; ci++) {
      walk(node.namedChild(ci));
    }
  }

  walk(rootNode);

  return { functions: functions, classes: classes, imports: imports, exports: exports, calls: calls };
}

// ---------------------------------------------------------------------------
// AST Walking — Python
// ---------------------------------------------------------------------------

function walkPython(rootNode, filePath) {
  var functions = [];
  var classes   = [];
  var imports   = [];
  var exports   = [];
  var calls     = [];

  function walk(node, parentClass) {
    if (!node) return;

    switch (node.type) {

      // ---- function_definition ----
      case 'function_definition': {
        var nameNode   = node.childForFieldName('name');
        var paramsNode = node.childForFieldName('parameters');
        var fnName     = nodeText(nameNode);
        var params     = extractParams(paramsNode);

        // Filter out 'self' and 'cls' from params
        params = params.filter(function (p) { return p !== 'self' && p !== 'cls'; });

        if (parentClass) {
          // This is a method — it will be captured as part of the class
        } else {
          functions.push({
            name:     fnName,
            line:     node.startPosition.row + 1,
            params:   params,
            exported: true   // Python: everything at module level is implicitly exported
          });
        }
        // Walk the body for nested calls
        var body = node.childForFieldName('body');
        if (body) {
          for (var bi = 0; bi < body.namedChildCount; bi++) {
            walk(body.namedChild(bi), null);
          }
        }
        return;
      }

      // ---- class_definition ----
      case 'class_definition': {
        var cName   = node.childForFieldName('name');
        var cBody   = node.childForFieldName('body');
        var methods = [];

        if (cBody) {
          for (var cm = 0; cm < cBody.namedChildCount; cm++) {
            var member = cBody.namedChild(cm);
            if (member.type === 'function_definition') {
              var mNameNode   = member.childForFieldName('name');
              var mParamsNode = member.childForFieldName('parameters');
              var mParams     = extractParams(mParamsNode);
              mParams = mParams.filter(function (p) { return p !== 'self' && p !== 'cls'; });
              methods.push({
                name:   nodeText(mNameNode),
                line:   member.startPosition.row + 1,
                params: mParams
              });
            }
          }
          // Walk class body for calls
          for (var cb = 0; cb < cBody.namedChildCount; cb++) {
            walk(cBody.namedChild(cb), nodeText(cName));
          }
        }

        classes.push({
          name:     nodeText(cName),
          line:     node.startPosition.row + 1,
          methods:  methods,
          exported: true
        });
        return;
      }

      // ---- import_statement ----
      case 'import_statement': {
        var names = [];
        for (var ii = 0; ii < node.namedChildCount; ii++) {
          var child = node.namedChild(ii);
          if (child.type === 'dotted_name') {
            names.push(child.text);
          } else if (child.type === 'aliased_import') {
            var impName = child.childForFieldName('name');
            if (impName) names.push(impName.text);
          }
        }
        imports.push({
          module: names.join('.'),
          names:  names,
          line:   node.startPosition.row + 1
        });
        break;
      }

      // ---- import_from_statement ----
      case 'import_from_statement': {
        var modNode  = node.childForFieldName('module_name');
        var modName  = modNode ? modNode.text : '';
        var impNames = [];
        for (var ifi = 0; ifi < node.namedChildCount; ifi++) {
          var ifChild = node.namedChild(ifi);
          if (ifChild.type === 'dotted_name' && ifChild !== modNode) {
            impNames.push(ifChild.text);
          } else if (ifChild.type === 'aliased_import') {
            var aName = ifChild.childForFieldName('name');
            if (aName) impNames.push(aName.text);
          } else if (ifChild.type === 'identifier' && ifChild !== modNode) {
            impNames.push(ifChild.text);
          }
        }
        imports.push({
          module: modName,
          names:  impNames,
          line:   node.startPosition.row + 1
        });
        break;
      }

      // ---- call ----
      case 'call': {
        var callee   = node.childForFieldName('function');
        var callName = callee ? callee.text : '';
        if (callName) {
          calls.push({ name: callName, line: node.startPosition.row + 1, file: filePath });
        }
        break;
      }
    }

    // Default: recurse into children
    for (var ci = 0; ci < node.namedChildCount; ci++) {
      walk(node.namedChild(ci), parentClass || null);
    }
  }

  walk(rootNode, null);

  return { functions: functions, classes: classes, imports: imports, exports: exports, calls: calls };
}

// ---------------------------------------------------------------------------
// Parse a single file
// ---------------------------------------------------------------------------

/**
 * Parse a single file and return extracted symbols.
 * @param {{path:string, content:string, language:string}} file
 * @returns {Promise<{path:string, symbols:object}>}
 */
function parseFile(file) {
  var emptySymbols = { functions: [], classes: [], imports: [], exports: [], calls: [] };

  return loadLanguage(file.language).then(function (lang) {
    if (!lang) {
      return { path: file.path, symbols: emptySymbols };
    }

    try {
      parser.setLanguage(lang);
      var tree     = parser.parse(file.content);
      var rootNode = tree.rootNode;
      var key      = normaliseLanguageKey(file.language);
      var symbols;

      if (key === 'python') {
        symbols = walkPython(rootNode, file.path);
      } else {
        symbols = walkJS(rootNode, file.path);
      }

      tree.delete();
      return { path: file.path, symbols: symbols };
    } catch (err) {
      postMessage({ type: 'error', message: 'Parse error for ' + file.path + ': ' + err.message });
      return { path: file.path, symbols: emptySymbols };
    }
  });
}

// ---------------------------------------------------------------------------
// Symbol table builder
// ---------------------------------------------------------------------------

/**
 * Build a cross-file symbol table from all parsed symbols.
 *
 * @param {Array<{path:string, symbols:object}>} allSymbols
 * @returns {{definitions: object, edges: Array}}
 */
function buildSymbolTable(allSymbols) {
  // definitions: name → { file, type, line }
  var definitions = {};
  // edges: [ { source, target, type } ]
  var edges = [];

  // 1. Collect all exported definitions
  allSymbols.forEach(function (entry) {
    var filePath = entry.path;
    var syms     = entry.symbols;

    // Functions
    (syms.functions || []).forEach(function (fn) {
      if (fn.exported) {
        var key = filePath + ':' + fn.name;
        definitions[key] = { file: filePath, name: fn.name, type: 'function', line: fn.line };
      }
    });

    // Classes
    (syms.classes || []).forEach(function (cls) {
      if (cls.exported) {
        var key = filePath + ':' + cls.name;
        definitions[key] = { file: filePath, name: cls.name, type: 'class', line: cls.line };

        // Also register methods
        (cls.methods || []).forEach(function (method) {
          var mKey = filePath + ':' + cls.name + '.' + method.name;
          definitions[mKey] = { file: filePath, name: cls.name + '.' + method.name, type: 'method', line: method.line };
        });
      }
    });
  });

  // 2. Build import resolution map:  (importingFile, localName) → (sourceFile, exportedName)
  var importMap = {}; // "file|name" → { sourceFile, exportedName }

  allSymbols.forEach(function (entry) {
    var filePath = entry.path;
    var syms     = entry.symbols;

    (syms.imports || []).forEach(function (imp) {
      var modulePath = resolveModulePath(filePath, imp.module);

      (imp.names || []).forEach(function (name) {
        // Handle "* as X" — skip for precise resolution
        if (name.indexOf('* as') === 0) return;

        var mapKey = filePath + '|' + name;

        // Find the definition in the target module
        var defKey = modulePath + ':' + name;
        if (definitions[defKey]) {
          importMap[mapKey] = { sourceFile: modulePath, exportedName: name };
        } else {
          // Try with common extensions
          var extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '/index.js', '/index.ts'];
          for (var ei = 0; ei < extensions.length; ei++) {
            var tryKey = modulePath + extensions[ei] + ':' + name;
            if (definitions[tryKey]) {
              importMap[mapKey] = { sourceFile: modulePath + extensions[ei], exportedName: name };
              break;
            }
          }
        }
      });
    });
  });

  // 3. Build call edges
  allSymbols.forEach(function (entry) {
    var filePath = entry.path;
    var syms     = entry.symbols;

    // Determine which function / class scope a call might belong to
    var localFunctions = {};
    (syms.functions || []).forEach(function (fn) {
      localFunctions[fn.name] = filePath + ':' + fn.name;
    });
    (syms.classes || []).forEach(function (cls) {
      localFunctions[cls.name] = filePath + ':' + cls.name;
      (cls.methods || []).forEach(function (method) {
        localFunctions[cls.name + '.' + method.name] = filePath + ':' + cls.name + '.' + method.name;
      });
    });

    (syms.calls || []).forEach(function (call) {
      var callName   = call.name;
      var sourceName = filePath + ':' + findEnclosingFunction(syms, call.line);
      var targetKey;

      // Check if call resolves via imports
      var importLookup = filePath + '|' + callName;
      if (importMap[importLookup]) {
        var resolved = importMap[importLookup];
        targetKey = resolved.sourceFile + ':' + resolved.exportedName;
      } else if (localFunctions[callName]) {
        // Local call
        targetKey = localFunctions[callName];
      } else {
        // Unresolved — could be a built-in or external
        targetKey = '(external):' + callName;
      }

      edges.push({
        source: sourceName,
        target: targetKey,
        type:   'calls'
      });
    });
  });

  return { definitions: definitions, edges: edges };
}

/**
 * Resolve a relative module path against the importing file's directory.
 * Only handles relative imports (./  ../).  Absolute imports are returned as-is.
 */
function resolveModulePath(importerPath, modulePath) {
  if (!modulePath) return modulePath;

  // Absolute or package import — return as-is
  if (modulePath.charAt(0) !== '.') return modulePath;

  // Split importer to get directory
  var parts   = importerPath.replace(/\\/g, '/').split('/');
  parts.pop(); // remove filename
  var modParts = modulePath.replace(/\\/g, '/').split('/');

  for (var i = 0; i < modParts.length; i++) {
    if (modParts[i] === '..') {
      parts.pop();
    } else if (modParts[i] !== '.') {
      parts.push(modParts[i]);
    }
  }

  return parts.join('/');
}

/**
 * Find the name of the function/method that encloses a given line number.
 * Returns '(module)' if none found.
 */
function findEnclosingFunction(symbols, line) {
  var best     = null;
  var bestLine = -1;

  (symbols.functions || []).forEach(function (fn) {
    if (fn.line <= line && fn.line > bestLine) {
      best     = fn.name;
      bestLine = fn.line;
    }
  });

  (symbols.classes || []).forEach(function (cls) {
    (cls.methods || []).forEach(function (method) {
      if (method.line <= line && method.line > bestLine) {
        best     = cls.name + '.' + method.name;
        bestLine = method.line;
      }
    });
  });

  return best || '(module)';
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {

    // ---- Initialise tree-sitter ----
    case 'init':
      init();
      break;

    // ---- Parse a single file ----
    case 'parse':
      if (!isReady) {
        postMessage({ type: 'error', message: 'Worker not initialised. Send {type:"init"} first.' });
        return;
      }
      parseFile(msg.file).then(function (result) {
        postMessage({ type: 'parsed', path: result.path, symbols: result.symbols });
      }).catch(function (err) {
        postMessage({ type: 'error', message: 'Unexpected error parsing ' + (msg.file && msg.file.path) + ': ' + err.message });
      });
      break;

    // ---- Batch parse ----
    case 'batch':
      if (!isReady) {
        postMessage({ type: 'error', message: 'Worker not initialised. Send {type:"init"} first.' });
        return;
      }
      var files   = msg.files || [];
      var results = [];
      var chain   = Promise.resolve();

      files.forEach(function (file) {
        chain = chain.then(function () {
          return parseFile(file).then(function (result) {
            results.push(result);
          });
        });
      });

      chain.then(function () {
        postMessage({ type: 'batch-done', results: results });
      }).catch(function (err) {
        postMessage({ type: 'error', message: 'Batch processing error: ' + err.message });
      });
      break;

    // ---- Build cross-file symbol table ----
    case 'build-symbol-table':
      try {
        var table = buildSymbolTable(msg.allSymbols || []);
        postMessage({ type: 'symbol-table', definitions: table.definitions, edges: table.edges });
      } catch (err) {
        postMessage({ type: 'error', message: 'Symbol table error: ' + err.message });
      }
      break;

    default:
      postMessage({ type: 'error', message: 'Unknown message type: ' + msg.type });
      break;
  }
};
