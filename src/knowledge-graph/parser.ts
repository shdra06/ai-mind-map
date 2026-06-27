/**
 * AI Mind Map — Tree-sitter AST Parser with Regex Fallback
 *
 * Extracts structural information (functions, classes, methods, interfaces,
 * types, enums, constants, exports, imports) from source code files.
 *
 * Inspired by codebase-memory-mcp (158 languages) and Aider's repo map.
 * Uses tree-sitter grammars for accurate parsing with a regex-based fallback
 * when native bindings are unavailable or parsing fails.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname, basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  GraphNode,
  GraphEdge,
  NodeType,
  EdgeType,
  ParameterInfo,
} from '../types.js';

// ============================================================
// Language Registry
// ============================================================

/** Maps file extensions to language identifiers */
const EXTENSION_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.dart': 'dart',
  '.scala': 'scala',
  '.sc': 'scala',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.xaml': 'xaml',
  '.sql': 'sql',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  // ── New languages (v1.6.0) ──
  '.lua': 'lua',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.edn': 'clojure',
  '.r': 'r',
  '.R': 'r',
  '.jl': 'julia',
  '.pl': 'perl',
  '.pm': 'perl',
  '.m': 'objc',
  '.mm': 'objc',
  '.zig': 'zig',
  '.nim': 'nim',
  '.nimble': 'nim',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'html',
  '.svelte': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.sass': 'css',
};

/** Maps language identifiers to tree-sitter grammar package names */
const GRAMMAR_MAP: Record<string, string> = {
  javascript: 'tree-sitter-javascript',
  typescript: 'tree-sitter-typescript',
  python: 'tree-sitter-python',
  java: 'tree-sitter-java',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  csharp: 'tree-sitter-c-sharp',
  ruby: 'tree-sitter-ruby',
  php: 'tree-sitter-php',
  bash: 'tree-sitter-bash',
  kotlin: '@tree-sitter-grammars/tree-sitter-kotlin',
  swift: 'tree-sitter-swift',
  dart: 'tree-sitter-dart',
  // Languages without tree-sitter grammars fall back to regex parsing
  // lua, haskell, elixir, clojure, r, julia, perl, objc, zig, nim,
  // scala, yaml, toml, xml, xaml, sql, protobuf, graphql, html, css
  // are all handled by the regex parser below
};

// ============================================================
// Parse Result
// ============================================================

/** Result of parsing a single file */
export interface ParseResult {
  filePath: string;
  language: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  parseErrors: string[];
  sourceContent?: string;  // cached file content for FTS5 (avoids re-reading)
}

// ============================================================
// Helpers
// ============================================================

/** Generate a unique deterministic ID for a node */
export function generateNodeId(filePath: string, name: string, type: string, startLine: number = 0): string {
  const hash = createHash('sha256')
    .update(`${filePath}::${name}::${type}::${startLine}`)
    .digest('hex');
  return hash.substring(0, 16);
}

/** Generate a content hash for change detection */
export function generateContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/** Detect language from file extension */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

/** Get all supported file extensions */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}



/** Strip leading comment markers from doc comment lines */
function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/m, '')
    .replace(/\*\/$/m, '')
    .replace(/^[ \t]*\*[ \t]?/gm, '')
    .replace(/^[ \t]*\/\/\/? ?/gm, '')
    .replace(/^[ \t]*#[ \t]?/gm, '')
    .trim();
}

// ============================================================
// Tree-sitter Parser (primary)
// ============================================================

/** Cached tree-sitter Parser instance and loaded grammars */
let treeSitterParser: any = null;
const loadedGrammars: Map<string, any> = new Map();
let treeSitterAvailable: boolean | null = null;
const failedGrammars: Set<string> = new Set();

/** Attempt to load the tree-sitter module and a language grammar */
async function getTreeSitterParser(language: string): Promise<{ parser: any; grammar: any } | null> {
  // If the core tree-sitter module is unavailable, skip entirely
  if (treeSitterAvailable === false) {
    return null;
  }

  // If this specific grammar already failed, skip it (don't retry)
  if (failedGrammars.has(language)) {
    return null;
  }

  try {
    // Load the core tree-sitter module (once)
    if (!treeSitterParser) {
      try {
        const TreeSitter = (await import('tree-sitter')).default;
        treeSitterParser = new TreeSitter();
        treeSitterAvailable = true;
      } catch {
        treeSitterAvailable = false;
        return null;
      }
    }

    // Load the language grammar
    if (!loadedGrammars.has(language)) {
      // TSX uses the same grammar package as TypeScript
      const lookupLang = language === 'tsx' ? 'typescript' : language;
      const grammarPkg = GRAMMAR_MAP[lookupLang];
      if (!grammarPkg) return null;

      try {
        let grammarModule = await import(grammarPkg);
        let grammar = grammarModule.default ?? grammarModule;

        // TypeScript grammar package exports { typescript, tsx }
        if (language === 'tsx' && grammar.tsx) {
          grammar = grammar.tsx;
        } else if (language === 'tsx' && grammar.typescript) {
          // Fallback: use typescript grammar if tsx is not available
          grammar = grammar.typescript;
        } else if (language === 'typescript' && grammar.typescript) {
          grammar = grammar.typescript;
        }

        loadedGrammars.set(language, grammar);
      } catch {
        // Mark only THIS grammar as failed, not all of tree-sitter
        failedGrammars.add(language);
        return null;
      }
    }

    return { parser: treeSitterParser, grammar: loadedGrammars.get(language)! };
  } catch {
    // Unexpected error — don't disable everything, just return null
    return null;
  }
}

/** Extract nodes from a tree-sitter AST */
function extractFromTreeSitter(
  tree: any,
  source: string,
  filePath: string,
  language: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sourceLines = source.split('\n');
  const now = Date.now();

  /** Get text for a node */
  function nodeText(node: any): string {
    return node?.text ?? '';
  }

  /** Find the doc comment preceding a node */
  function findDocComment(node: any): string | null {
    let prev = node.previousNamedSibling;
    if (!prev) {
      // Check parent's previous sibling for doc comments on methods inside classes
      const parent = node.parent;
      if (parent) {
        // Scan unnamed children before our node
        for (let i = 0; i < parent.namedChildCount; i++) {
          const child = parent.namedChild(i);
          if (child?.id === node.id) break;
          prev = child;
        }
      }
    }

    if (prev && prev.type === 'comment') {
      const text = nodeText(prev);
      if (text.startsWith('/**') || text.startsWith('///') || text.startsWith('# ')) {
        return cleanDocComment(text);
      }
    }

    // Check previousSibling (unnamed node traversal) up to 2 nodes back
    // to catch doc comments separated by empty lines
    if (!prev || prev.type !== 'comment') {
      let sibling = node.previousSibling;
      for (let i = 0; i < 2 && sibling; i++) {
        if (sibling.type === 'comment') {
          const text = nodeText(sibling);
          if (text.startsWith('/**') || text.startsWith('///') || text.startsWith('# ')) {
            return cleanDocComment(text);
          }
          break;
        }
        sibling = sibling.previousSibling;
      }
    }

    // Python: look for expression_statement containing a string immediately after function/class def
    if (language === 'python' && node.namedChildCount > 0) {
      const body = node.childForFieldName('body');
      if (body && body.namedChildCount > 0) {
        const first = body.namedChild(0);
        if (first?.type === 'expression_statement') {
          const strNode = first.namedChild(0);
          if (strNode && (strNode.type === 'string' || strNode.type === 'concatenated_string')) {
            return cleanDocComment(nodeText(strNode).replace(/^['"`]{1,3}|['"`]{1,3}$/g, ''));
          }
        }
      }
    }

    return null;
  }

  /** Determine visibility from modifiers or naming conventions */
  function getVisibility(node: any): GraphNode['visibility'] {
    // Check for explicit modifiers
    const modifiers = collectModifiers(node);
    if (modifiers.includes('public')) return 'public';
    if (modifiers.includes('private')) return 'private';
    if (modifiers.includes('protected')) return 'protected';
    if (modifiers.includes('internal')) return 'internal';

    // Python naming convention
    if (language === 'python') {
      const name = node.childForFieldName('name');
      if (name) {
        const nameText = nodeText(name);
        if (nameText.startsWith('__') && !nameText.endsWith('__')) return 'private';
        if (nameText.startsWith('_')) return 'protected';
      }
    }

    return 'unknown';
  }

  /** Collect modifier keywords from a node */
  function collectModifiers(node: any): string[] {
    const mods: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      const t = child.type;
      if (
        t === 'public' || t === 'private' || t === 'protected' || t === 'internal' ||
        t === 'static' || t === 'async' || t === 'abstract' || t === 'readonly' ||
        t === 'export' || t === 'default' ||
        t === 'accessibility_modifier' || t === 'modifiers'
      ) {
        if (t === 'accessibility_modifier' || t === 'modifiers') {
          mods.push(nodeText(child).trim());
        } else {
          mods.push(t);
        }
      }
    }
    // Also check for export statement wrapping
    if (node.parent?.type === 'export_statement' || node.parent?.type === 'export_declaration') {
      mods.push('export');
    }
    return mods;
  }

  /** Check if a node is exported */
  function isExported(node: any): boolean {
    const mods = collectModifiers(node);
    if (mods.includes('export')) return true;
    if (node.parent?.type === 'export_statement' || node.parent?.type === 'export_declaration') return true;
    // Go: exported if name starts with uppercase
    if (language === 'go') {
      const name = node.childForFieldName('name');
      if (name) {
        const n = nodeText(name);
        return n.length > 0 && n[0] === n[0].toUpperCase() && n[0] !== n[0].toLowerCase();
      }
    }
    return false;
  }

  /** Extract function parameters */
  function extractParameters(paramsNode: any): ParameterInfo[] {
    if (!paramsNode) return [];
    const params: ParameterInfo[] = [];

    for (let i = 0; i < paramsNode.namedChildCount; i++) {
      const param = paramsNode.namedChild(i);
      if (!param) continue;

      const pType = param.type;
      // Skip commas, parentheses
      if (pType === ',' || pType === '(' || pType === ')') continue;

      let name = '';
      let type: string | null = null;
      let defaultValue: string | null = null;
      let isOptional = false;
      let isRest = false;

      // Try field-based extraction
      const nameNode = param.childForFieldName('name') ?? param.childForFieldName('pattern');
      if (nameNode) {
        name = nodeText(nameNode);
      } else if (param.type === 'identifier') {
        name = nodeText(param);
      } else if (param.type === 'rest_pattern' || param.type === 'spread_element' || param.type === 'rest_parameter') {
        isRest = true;
        const inner = param.namedChild(0);
        name = inner ? nodeText(inner) : nodeText(param).replace(/^\.\.\./, '');
      } else {
        name = nodeText(param).split(':')[0]?.split('=')[0]?.replace(/^\.\.\./, '').trim() ?? '';
      }

      // Type annotation
      const typeNode = param.childForFieldName('type');
      if (typeNode) {
        type = nodeText(typeNode);
      }

      // Default value
      const valueNode = param.childForFieldName('value') ?? param.childForFieldName('default_value');
      if (valueNode) {
        defaultValue = nodeText(valueNode);
        isOptional = true;
      }

      // Optional marker (TypeScript '?')
      for (let j = 0; j < param.childCount; j++) {
        const ch = param.child(j);
        if (ch && nodeText(ch) === '?') {
          isOptional = true;
          break;
        }
      }

      // Prefix '...' detection
      if (name.startsWith('...')) {
        isRest = true;
        name = name.substring(3);
      }
      if (pType === 'rest_parameter' || pType === 'rest_pattern') {
        isRest = true;
      }

      if (name) {
        params.push({ name, type, defaultValue, isOptional, isRest });
      }
    }

    return params;
  }

  /** Build a compact signature string from a node */
  function buildSignature(node: any, name: string, nodeType: NodeType): string {
    const mods = collectModifiers(node);
    const parts: string[] = [];

    // Prefix modifiers
    const filteredMods = mods.filter(m => ['export', 'async', 'static', 'abstract', 'public', 'private', 'protected'].includes(m));
    if (filteredMods.length > 0) {
      parts.push(filteredMods.join(' '));
    }

    // Keyword
    switch (nodeType) {
      case 'function': parts.push('function'); break;
      case 'class': parts.push('class'); break;
      case 'method': parts.push(''); break; // no keyword for methods
      case 'interface': parts.push('interface'); break;
      case 'type_alias': parts.push('type'); break;
      case 'enum': parts.push('enum'); break;
      case 'constant': parts.push('const'); break;
      case 'variable': parts.push('let'); break;
    }

    parts.push(name);

    // Type parameters (generics)
    const typeParams = node.childForFieldName('type_parameters');
    if (typeParams) {
      parts[parts.length - 1] += nodeText(typeParams);
    }

    // Parameters
    const paramsNode = node.childForFieldName('parameters');
    if (paramsNode) {
      parts[parts.length - 1] += nodeText(paramsNode);
    }

    // Return type
    const returnType = node.childForFieldName('return_type') ?? node.childForFieldName('result');
    if (returnType) {
      parts.push(':');
      parts.push(nodeText(returnType));
    }

    // Superclass / implements
    const superclass = node.childForFieldName('superclass');
    if (superclass) {
      parts.push('extends');
      parts.push(nodeText(superclass));
    }

    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  /** Create a GraphNode from a tree-sitter node */
  function makeNode(
    tsNode: any,
    name: string,
    nType: NodeType,
    parentId?: string,
  ): GraphNode {
    const mods = collectModifiers(tsNode);
    const signature = buildSignature(tsNode, name, nType);
    const paramsNode = tsNode.childForFieldName('parameters');
    const returnTypeNode = tsNode.childForFieldName('return_type') ?? tsNode.childForFieldName('result');
    const startLine = tsNode.startPosition.row + 1;
    const endLine = tsNode.endPosition.row + 1;
    const sliceText = sourceLines.slice(startLine - 1, endLine).join('\n');

    const gNode: GraphNode = {
      id: generateNodeId(filePath, parentId ? `${parentId}::${name}` : name, nType, startLine),
      type: nType,
      name,
      qualifiedName: parentId ? `${parentId}.${name}` : name,
      filePath,
      startLine,
      endLine,
      signature,
      docComment: findDocComment(tsNode),
      hash: generateContentHash(sliceText),
      language,
      visibility: getVisibility(tsNode),
      isAsync: mods.includes('async'),
      isStatic: mods.includes('static'),
      isExported: isExported(tsNode),
      parameters: paramsNode ? extractParameters(paramsNode) : undefined,
      returnType: returnTypeNode ? nodeText(returnTypeNode).replace(/^:\s*/, '') : undefined,
      updatedAt: now,
    };

    return gNode;
  }

  /** Recursively walk the AST and extract nodes */
  function walk(tsNode: any, parentClassName?: string): void {
    if (!tsNode) return;

    const t = tsNode.type;
    const nameNode = tsNode.childForFieldName('name');
    const nameStr = nameNode ? nodeText(nameNode) : '';

    // --- Functions ---
    if (
      t === 'function_declaration' || t === 'function_definition' ||
      t === 'arrow_function' || t === 'function_item' /* Rust */
    ) {
      const funcName = nameStr || (tsNode.parent?.type === 'variable_declarator'
        ? nodeText(tsNode.parent.childForFieldName('name'))
        : `anonymous_${tsNode.startPosition.row}`);

      const gNode = makeNode(tsNode, funcName, 'function');
      nodes.push(gNode);
    }

    // --- Classes ---
    else if (
      t === 'class_declaration' || t === 'class_definition' ||
      t === 'class' || t === 'struct_item' /* Rust */ ||
      t === 'struct_specifier' || t === 'class_specifier'
    ) {
      const className = nameStr || `AnonymousClass_${tsNode.startPosition.row}`;
      const gNode = makeNode(tsNode, className, 'class');
      nodes.push(gNode);

      // Process class body for methods/properties
      const body = tsNode.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const member = body.namedChild(i);
          if (!member) continue;
          walkClassMember(member, className, gNode.id);
        }
      }
      return; // Don't recurse children again
    }

    // --- Interfaces (TypeScript, Java, Go, C#) ---
    else if (
      t === 'interface_declaration' || t === 'interface_definition'
    ) {
      const gNode = makeNode(tsNode, nameStr, 'interface');
      nodes.push(gNode);

      // Process interface body
      const body = tsNode.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const member = body.namedChild(i);
          if (!member) continue;
          walkInterfaceMember(member, nameStr, gNode.id);
        }
      }
      return;
    }

    // --- Type aliases ---
    else if (t === 'type_alias_declaration' || t === 'type_alias') {
      const gNode = makeNode(tsNode, nameStr, 'type_alias');
      nodes.push(gNode);
    }

    // --- Enums ---
    else if (t === 'enum_declaration' || t === 'enum_definition' || t === 'enum_item') {
      const gNode = makeNode(tsNode, nameStr, 'enum');
      nodes.push(gNode);
    }

    // --- Variable declarations (constants) ---
    else if (t === 'lexical_declaration' || t === 'variable_declaration') {
      for (let i = 0; i < tsNode.namedChildCount; i++) {
        const declarator = tsNode.namedChild(i);
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const declName = declarator.childForFieldName('name');
        if (!declName) continue;
        const varName = nodeText(declName);

        // Check if it's const
        const isConst = nodeText(tsNode).trimStart().startsWith('const');
        const nodeType: NodeType = isConst ? 'constant' : 'variable';

        // Check if the value is a function (arrow function or function expression)
        const valueNode = declarator.childForFieldName('value');
        if (valueNode && (
          valueNode.type === 'arrow_function' ||
          valueNode.type === 'function' ||
          valueNode.type === 'function_expression'
        )) {
          const gNode = makeNode(valueNode, varName, 'function');
          // Override signature to include const keyword
          gNode.signature = `${isExported(tsNode) ? 'export ' : ''}const ${varName}${nodeText(valueNode).split('=>')[0]?.includes('(') ? nodeText(valueNode).split('=>')[0]?.trim().replace(/^[^(]*/, '') : '()'}`;
          const paramsNode = valueNode.childForFieldName('parameters');
          if (paramsNode) {
            gNode.parameters = extractParameters(paramsNode);
          }
          gNode.isExported = isExported(tsNode);
          nodes.push(gNode);
        } else {
          const gNode = makeNode(tsNode, varName, nodeType);
          gNode.isExported = isExported(tsNode);
          // Build a cleaner signature for variables
          const typeAnn = declarator.childForFieldName('type');
          gNode.signature = `${isExported(tsNode) ? 'export ' : ''}${isConst ? 'const' : 'let'} ${varName}${typeAnn ? ': ' + nodeText(typeAnn) : ''}`;
          if (typeAnn) gNode.returnType = nodeText(typeAnn);
          nodes.push(gNode);
        }
      }
    }

    // --- Import statements ---
    else if (t === 'import_statement' || t === 'import_declaration') {
      const sourceNode = tsNode.childForFieldName('source');
      if (sourceNode) {
        const importSource = nodeText(sourceNode).replace(/['"`]/g, '');
        // Create edge from file to imported module
        const fileNodeId = generateNodeId(filePath, basename(filePath), 'file');
        edges.push({
          sourceId: fileNodeId,
          targetId: importSource, // Will be resolved later
          type: 'imports',
          metadata: { raw: nodeText(tsNode).trim() },
        });
      }
    }

    // --- Export statements ---
    else if (t === 'export_statement' || t === 'export_declaration') {
      // Process the declaration inside the export
      for (let i = 0; i < tsNode.namedChildCount; i++) {
        const child = tsNode.namedChild(i);
        if (child) walk(child, parentClassName);
      }
      return;
    }

    // --- Python-specific: decorated definitions ---
    else if (t === 'decorated_definition') {
      // Process the definition inside
      const definition = tsNode.childForFieldName('definition');
      if (definition) walk(definition, parentClassName);
      return;
    }

    // --- Go specific: function_declaration, method_declaration ---
    else if (t === 'method_declaration') {
      const methodName = nameStr;
      const receiver = tsNode.childForFieldName('receiver');
      const receiverType = receiver ? nodeText(receiver).replace(/[()]/g, '').split(/\s+/).pop()?.replace(/^\*/, '') ?? '' : '';
      if (methodName) {
        const gNode = makeNode(tsNode, methodName, 'method', receiverType || undefined);
        nodes.push(gNode);
        if (receiverType) {
          const parentId = generateNodeId(filePath, receiverType, 'class');
          edges.push({ sourceId: parentId, targetId: gNode.id, type: 'contains' });
        }
      }
    }

    // --- Rust: impl blocks ---
    else if (t === 'impl_item') {
      const implType = tsNode.childForFieldName('type');
      const implName = implType ? nodeText(implType) : '';
      const body = tsNode.childForFieldName('body');
      if (body && implName) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const member = body.namedChild(i);
          if (!member) continue;
          if (member.type === 'function_item') {
            const mn = member.childForFieldName('name');
            if (mn) {
              const gNode = makeNode(member, nodeText(mn), 'method', implName);
              nodes.push(gNode);
              const parentId = generateNodeId(filePath, implName, 'class');
              edges.push({ sourceId: parentId, targetId: gNode.id, type: 'contains' });
            }
          }
        }
      }
      return;
    }

    // Recurse into children
    for (let i = 0; i < tsNode.namedChildCount; i++) {
      walk(tsNode.namedChild(i), parentClassName);
    }
  }

  /** Walk class members */
  function walkClassMember(member: any, className: string, classId: string): void {
    const mType = member.type;
    const memberNameNode = member.childForFieldName('name');
    const memberName = memberNameNode ? nodeText(memberNameNode) : '';

    if (
      mType === 'method_definition' || mType === 'method_declaration' ||
      mType === 'function_definition' || mType === 'function_declaration' ||
      mType === 'function_item'
    ) {
      if (memberName) {
        const nType: NodeType = memberName === 'constructor' || memberName === '__init__' ? 'constructor' : 'method';
        const gNode = makeNode(member, memberName, nType, className);
        nodes.push(gNode);
        edges.push({ sourceId: classId, targetId: gNode.id, type: 'contains' });
      }
    } else if (
      mType === 'public_field_definition' || mType === 'field_definition' ||
      mType === 'property_declaration' || mType === 'field_declaration'
    ) {
      if (memberName) {
        const gNode = makeNode(member, memberName, 'property', className);
        nodes.push(gNode);
        edges.push({ sourceId: classId, targetId: gNode.id, type: 'contains' });
      }
    } else {
      // Recurse in case of decorated methods, etc.
      if (mType === 'decorated_definition') {
        const def = member.childForFieldName('definition');
        if (def) walkClassMember(def, className, classId);
      }
    }
  }

  /** Walk interface members */
  function walkInterfaceMember(member: any, ifaceName: string, ifaceId: string): void {
    const memberNameNode = member.childForFieldName('name');
    const memberName = memberNameNode ? nodeText(memberNameNode) : '';
    if (memberName) {
      // Interface methods are treated as method signatures
      const nType: NodeType = member.childForFieldName('parameters') ? 'method' : 'property';
      const gNode = makeNode(member, memberName, nType, ifaceName);
      nodes.push(gNode);
      edges.push({ sourceId: ifaceId, targetId: gNode.id, type: 'contains' });
    }
  }

  // Create the file node itself
  const fileNode: GraphNode = {
    id: generateNodeId(filePath, basename(filePath), 'file'),
    type: 'file',
    name: basename(filePath),
    qualifiedName: filePath,
    filePath,
    startLine: 1,
    endLine: sourceLines.length,
    signature: filePath,
    docComment: null,
    hash: generateContentHash(source),
    language,
    visibility: 'public',
    isAsync: false,
    isStatic: false,
    isExported: false,
    updatedAt: now,
  };
  nodes.push(fileNode);

  // Walk the AST
  walk(tree.rootNode);

  // Create 'contains' edges from file to all top-level symbols
  for (const node of nodes) {
    if (node.type !== 'file' && node.qualifiedName === node.name) {
      edges.push({ sourceId: fileNode.id, targetId: node.id, type: 'contains' });
    }
  }

  // ── Call Detection: find method invocations within function/method bodies ──
  // Build a set of all function/method node names in this file
  const functionNodes = nodes.filter(n => 
    ['function', 'method', 'constructor'].includes(n.type) && n.startLine && n.endLine
  );
  const functionNames = new Map<string, typeof nodes[0]>();
  for (const fn of functionNodes) {
    functionNames.set(fn.name, fn);
  }

  // For each function, scan its body for calls to other known functions
  if (functionNames.size > 0 && sourceLines.length > 0) {
    // Build regex pattern from all function names (escape special chars)
    const nameList = [...functionNames.keys()].filter(n => n.length >= 2 && /^\w+$/.test(n));
    if (nameList.length > 0) {
      const callPattern = new RegExp(
        `\\b(${nameList.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`,
        'g'
      );

      for (const caller of functionNodes) {
        if (!caller.startLine || !caller.endLine) continue;
        // Get the body text of this function
        const bodyStart = caller.startLine; // skip the declaration line
        const bodyEnd = Math.min(caller.endLine, sourceLines.length);
        if (bodyStart >= bodyEnd) continue;
        
        const bodyText = sourceLines.slice(bodyStart, bodyEnd).join('\n');
        
        let match: RegExpExecArray | null;
        const calledNames = new Set<string>();
        callPattern.lastIndex = 0;
        while ((match = callPattern.exec(bodyText)) !== null) {
          const calledName = match[1];
          // Don't create self-referential edges (recursion is ok but skip if same node)
          if (calledName !== caller.name && !calledNames.has(calledName)) {
            calledNames.add(calledName);
            const callee = functionNames.get(calledName);
            if (callee) {
              edges.push({
                sourceId: caller.id,
                targetId: callee.id,
                type: 'calls' as EdgeType,
              });
            }
          }
        }
      }
    }
  }

  return { nodes, edges };
}

// ============================================================
// Regex Fallback Parser
// ============================================================

interface RegexPattern {
  pattern: RegExp;
  type: NodeType;
  nameGroup: number;
  signatureGroup?: number;
}

/** Language-specific regex patterns for fallback parsing */
const REGEX_PATTERNS: Record<string, RegexPattern[]> = {
  javascript: [
    { pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*function/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s+(?:async\s+)?(\w+)\s*(\([^)]*\))\s*\{/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
  ],
  typescript: [
    { pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)(?:<[^>]*>)?\s*(\([^)]*\))(?:\s*:\s*[\w<>\[\]|&\s]+)?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[\w<>,\s]+)?(?:\s+implements\s+[\w<>,\s]+)?\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[\w<>,\s]+)?\s*\{/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?enum\s+(\w+)\s*\{/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>\[\]|&\s]{1,200})?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*(?::\s*[\w<>\[\]|&\s]{1,200})?\s*=>/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s+(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*(\([^)]*\))/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
  ],
  python: [
    { pattern: /^(?:async\s+)?def\s+(\w+)\s*(\([^)]*\))(?:\s*->\s*[\w\[\],\s|]+)?:/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^class\s+(\w+)(?:\([^)]*\))?\s*:/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s+(?:async\s+)?def\s+(\w+)\s*\((?:self|cls)[^)]*\)(?:\s*->\s*[\w\[\],\s|]+)?:/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s+@(?:staticmethod|classmethod)\s*\n\s+def\s+(\w+)\s*(\([^)]*\))/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
  ],
  java: [
    { pattern: /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected)\s+(?:static\s+)?interface\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?[\w<>\[\],\s]+\s+(\w+)\s*(\([^)]*\))/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected)\s+(?:static\s+)?enum\s+(\w+)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
  ],
  go: [
    { pattern: /^func\s+(\w+)\s*(\([^)]*\))(?:\s*(?:\([^)]*\)|[\w*]+))?\s*\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^func\s+\([^)]+\)\s+(\w+)\s*(\([^)]*\))(?:\s*(?:\([^)]*\)|[\w*]+))?\s*\{/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^type\s+(\w+)\s+struct\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^type\s+(\w+)\s+interface\s*\{/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
  ],
  rust: [
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*(\([^)]*\))(?:\s*->\s*[\w<>&\[\]]+)?\s*(?:where[^{]*)?\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\(&?(?:mut\s+)?self[^)]*\)/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
  ],
  c: [
    { pattern: /^(?:static\s+)?(?:inline\s+)?(?:extern\s+)?(?:const\s+)?[\w*\s]+\s+(\w+)\s*(\([^)]*\))\s*\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:typedef\s+)?struct\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:typedef\s+)?enum\s+(\w+)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
  ],
  cpp: [
    { pattern: /^(?:(?:virtual|static|inline|explicit|extern|const|constexpr)\s+)*[\w:<>*&\s]+\s+(\w+)\s*(\([^)]*\))(?:\s*(?:const|override|final|noexcept))*\s*\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:template\s*<[^>]*>\s*)?class\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:template\s*<[^>]*>\s*)?struct\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^namespace\s+(\w+)\s*\{/gm, type: 'namespace', nameGroup: 1, signatureGroup: 0 },
  ],
  csharp: [
    { pattern: /(?:public|private|protected|internal)\s+(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)\s+(?:static\s+)?interface\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)\s+(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:async\s+)?[\w<>\[\],?\s]+\s+(\w+)\s*(\([^)]*\))/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)\s+(?:static\s+)?enum\s+(\w+)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^namespace\s+([\w.]+)/gm, type: 'namespace', nameGroup: 1, signatureGroup: 0 },
  ],
  ruby: [
    { pattern: /^\s*def\s+(?:self\.)?(\w+[?!]?)(?:\(([^)]*)\))?/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*class\s+(\w+)(?:\s*<\s*\w+)?/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*module\s+(\w+)/gm, type: 'module', nameGroup: 1, signatureGroup: 0 },
  ],
  php: [
    { pattern: /(?:public|private|protected)?\s*(?:static\s+)?function\s+(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /interface\s+(\w+)(?:\s+extends\s+[\w,\s]+)?/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /trait\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
  ],
  bash: [
    { pattern: /^(?:function\s+)?(\w+)\s*\(\)\s*\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(\w+)\s*=\s*/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  kotlin: [
    { pattern: /(?:public|private|protected|internal)?\s*(?:data\s+|sealed\s+|abstract\s+|open\s+|inner\s+)?class\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)?\s*(?:fun)\s+(?:<[^>]*>\s+)?(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)?\s*interface\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)?\s*(?:enum\s+class|enum)\s+(\w+)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)?\s*object\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)?\s*(?:val|var)\s+(\w+)\s*(?::\s*[\w<>\[\]?,\s]+)?\s*(?:=|$)/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|protected|internal)?\s*typealias\s+(\w+)/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^package\s+([\w.]+)/gm, type: 'namespace', nameGroup: 1, signatureGroup: 0 },
  ],
  swift: [
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*(?:final\s+)?class\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*struct\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*(?:static\s+|class\s+)?func\s+(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*protocol\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*enum\s+(\w+)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*extension\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:public|private|fileprivate|internal|open)?\s*typealias\s+(\w+)/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
  ],
  dart: [
    { pattern: /(?:abstract\s+)?class\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[\w<>,\s]+)?(?:\s+(?:with|implements)\s+[\w<>,\s]+)?\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:Future<[^>]*>|void|int|double|bool|String|dynamic|[\w<>]+)\s+(\w+)\s*(\([^)]*\))\s*(?:async\s*)?\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /enum\s+(\w+)\s*\{/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /mixin\s+(\w+)(?:\s+on\s+[\w<>,\s]+)?\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /extension\s+(\w+)\s+on\s+[\w<>,\s]+\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /typedef\s+(\w+)/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
  ],
  scala: [
    { pattern: /(?:sealed\s+|abstract\s+|final\s+)?(?:case\s+)?class\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:private\s*(?:\[\w+\])?\s*|protected\s*(?:\[\w+\])?\s*)?def\s+(\w+)(?:\[.*?\])?\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /trait\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /object\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:val|var)\s+(\w+)\s*(?::\s*[\w\[\]<>,\s]+)?\s*=/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /type\s+(\w+)/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^package\s+([\w.]+)/gm, type: 'namespace', nameGroup: 1, signatureGroup: 0 },
  ],
  yaml: [
    { pattern: /^(\w[\w-]*)\s*:/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  toml: [
    { pattern: /^\[([\w.-]+)\]/gm, type: 'namespace', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(\w[\w-]*)\s*=/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  xml: [
    { pattern: /<(\w+:[\w.]+|\w+\.\w+)[^>]*(?:x:Class|x:Name)\s*=\s*"([^"]+)"/gm, type: 'class', nameGroup: 2, signatureGroup: 0 },
    { pattern: /<(Window|Page|UserControl|ResourceDictionary|Application)[\s>]/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
  ],
  xaml: [
    { pattern: /x:Class\s*=\s*"([^"]+)"/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /x:Name\s*=\s*"([^"]+)"/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /x:Key\s*=\s*"([^"]+)"/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:Click|Command|Loaded|Closing|TextChanged|SelectionChanged)\s*=\s*"([^"]+)"/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /<Style[^>]*TargetType\s*=\s*"\{?x:Type\s+([\w:]+)\}?"/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
  ],
  sql: [
    { pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\.)?`?(\w+)`?/gim, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:`?\w+`?\.)?`?(\w+)`?\s*(\([^)]*\))/gim, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:`?\w+`?\.)?`?(\w+)`?/gim, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gim, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gim, type: 'function', nameGroup: 1, signatureGroup: 0 },
  ],
  protobuf: [
    { pattern: /message\s+(\w+)\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /service\s+(\w+)\s*\{/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /rpc\s+(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /enum\s+(\w+)\s*\{/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
  ],
  graphql: [
    { pattern: /type\s+(\w+)(?:\s+implements\s+[\w&\s]+)?\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /input\s+(\w+)\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /interface\s+(\w+)\s*\{/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /enum\s+(\w+)\s*\{/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /scalar\s+(\w+)/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:query|mutation|subscription)\s+(\w+)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
  ],
  // ── New languages (v1.6.0) ─────────────────────────────────
  lua: [
    { pattern: /^(?:local\s+)?function\s+(?:[\w.:]+[.:])?(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:local\s+)?(\w+)\s*=\s*function\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(\w+)\s*=\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^local\s+(\w+)\s*=\s*require\s*[("]/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  haskell: [
    { pattern: /^(\w+)\s*::\s*(.+)$/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^data\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^newtype\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^type\s+(\w+)/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^class\s+(?:\([^)]*\)\s*=>)?\s*(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^instance\s+(?:\([^)]*\)\s*=>)?\s*(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^module\s+([\w.]+)/gm, type: 'module', nameGroup: 1, signatureGroup: 0 },
  ],
  elixir: [
    { pattern: /^\s*def\s+(\w+)\s*(\([^)]*\))?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*defp\s+(\w+)\s*(\([^)]*\))?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*defmodule\s+([\w.]+)/gm, type: 'module', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*defmacro\s+(\w+)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },

    { pattern: /^\s*defprotocol\s+([\w.]+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*defimpl\s+([\w.]+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*@callback\s+(\w+)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
  ],
  clojure: [
    { pattern: /\(defn-?\s+(\w[\w-]*)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(defmacro\s+(\w[\w-]*)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(defmulti\s+(\w[\w-]*)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(defprotocol\s+(\w[\w-]*)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(defrecord\s+(\w[\w-]*)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(deftype\s+(\w[\w-]*)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(def\s+(\w[\w-]*)/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /\(ns\s+([\w.-]+)/gm, type: 'namespace', nameGroup: 1, signatureGroup: 0 },
  ],
  r: [
    { pattern: /^(\w+)\s*<-\s*function\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(\w+)\s*=\s*function\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /setClass\s*\(\s*"(\w+)"/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /setGeneric\s*\(\s*"(\w+)"/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /setMethod\s*\(\s*"(\w+)"/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
  ],
  julia: [
    { pattern: /^(?:export\s+)?function\s+(?:[\w.]+\.)?([\w!]+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:abstract\s+type|struct|mutable\s+struct)\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^module\s+(\w+)/gm, type: 'module', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^macro\s+(\w+)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^const\s+(\w+)\s*=/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  perl: [
    { pattern: /^sub\s+(\w+)\s*(?:\([^)]*\))?\s*\{/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^package\s+([\w:]+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*has\s+'?(\w+)'/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^use\s+(?:constant\s+)?(\w+)/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  objc: [
    { pattern: /^[-+]\s*\([^)]+\)\s*(\w+)/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^@interface\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^@implementation\s+(\w+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^@protocol\s+(\w+)/gm, type: 'interface', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^@property\s*\([^)]*\)\s*[\w*\s]+(\w+);/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^typedef\s+(?:NS_ENUM|NS_OPTIONS)\s*\([^,]+,\s*(\w+)\)/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
  ],
  zig: [
    { pattern: /^(?:pub\s+)?fn\s+(\w+)\s*(\([^)]*\))/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub\s+)?const\s+(\w+)\s*=\s*struct\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub\s+)?const\s+(\w+)\s*=\s*enum\s*\{/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub\s+)?const\s+(\w+)\s*=\s*union\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^(?:pub\s+)?const\s+(\w+)\s*=/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^test\s+"([^"]+)"/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
  ],
  nim: [
    { pattern: /^proc\s+(\w+)\*?\s*(\([^)]*\))?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^func\s+(\w+)\*?\s*(\([^)]*\))?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^method\s+(\w+)\*?\s*(\([^)]*\))?/gm, type: 'method', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^type\s+(\w+)\*?\s*=\s*(?:ref\s+)?object/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^type\s+(\w+)\*?\s*=\s*enum/gm, type: 'enum', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^type\s+(\w+)\*?\s*=/gm, type: 'type_alias', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^template\s+(\w+)\*?\s*(\([^)]*\))?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^macro\s+(\w+)\*?\s*(\([^)]*\))?/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
  ],
  html: [
    { pattern: /\bid=["']([^"']+)["']/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /<(script|style|template|component|slot)\b[^>]*>/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /(?:v-bind|v-on|@|:)(\w[\w-]*)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /data-(\w[\w-]*)/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /class=["']([^"']+)["']/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
  ],
  css: [
    { pattern: /^\s*(\.[\w-]+)\s*\{/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*(#[\w-]+)\s*\{/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*@keyframes\s+([\w-]+)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*@mixin\s+([\w-]+)/gm, type: 'function', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*--([a-zA-Z][\w-]*)\s*:/gm, type: 'variable', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*@media\s+([^{]+)/gm, type: 'class', nameGroup: 1, signatureGroup: 0 },
    { pattern: /^\s*@font-face\b/gm, type: 'class', nameGroup: 0, signatureGroup: 0 },
  ],
};

/** Detect doc comment above a line index */
function findRegexDocComment(lines: string[], lineIndex: number): string | null {
  // Look backwards for comment blocks
  let commentLines: string[] = [];
  for (let i = lineIndex - 1; i >= 0 && i >= lineIndex - 30; i--) {
    const line = lines[i].trim();
    if (line === '') {
      if (commentLines.length > 0) break;
      continue;
    }
    if (
      line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/') ||
      line.startsWith('//') || line.startsWith('///') ||
      line.startsWith('#') || line.startsWith('"""') || line.startsWith("'''")
    ) {
      commentLines.unshift(lines[i]);
    } else {
      break;
    }
  }

  if (commentLines.length === 0) return null;
  return cleanDocComment(commentLines.join('\n'));
}

/** Regex-based fallback parser */
function parseWithRegex(
  source: string,
  filePath: string,
  language: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const lines = source.split('\n');
  const now = Date.now();

  // Create file node
  const fileNode: GraphNode = {
    id: generateNodeId(filePath, basename(filePath), 'file'),
    type: 'file',
    name: basename(filePath),
    qualifiedName: filePath,
    filePath,
    startLine: 1,
    endLine: lines.length,
    signature: filePath,
    docComment: null,
    hash: generateContentHash(source),
    language,
    visibility: 'public',
    isAsync: false,
    isStatic: false,
    isExported: false,
    updatedAt: now,
  };
  nodes.push(fileNode);

  // TSX uses TypeScript patterns for regex fallback
  const patterns = REGEX_PATTERNS[language] ?? (language === 'tsx' ? REGEX_PATTERNS['typescript'] : null) ?? REGEX_PATTERNS['javascript'] ?? [];

  // Track matched names to avoid duplicates
  const seen = new Set<string>();

  for (const { pattern, type, nameGroup } of patterns) {
    // Reset regex lastIndex
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(source)) !== null) {
      const name = match[nameGroup];
      if (!name) continue;

      // Calculate line number from match index
      const startLine = source.substring(0, match.index).split('\n').length;
      const matchText = match[0];
      const endLine = startLine + matchText.split('\n').length - 1;

      const key = `${name}::${type}::${startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Detect modifiers from signature
      const sig = matchText.trim();
      const isAsync = /\basync\b/.test(sig);
      const isStatic = /\bstatic\b/.test(sig);
      const isExportedMatch = /\bexport\b/.test(sig);
      const isPublic = /\bpublic\b/.test(sig);
      const isPrivate = /\bprivate\b/.test(sig);
      const isProtected = /\bprotected\b/.test(sig);

      let visibility: GraphNode['visibility'] = 'unknown';
      if (isPublic) visibility = 'public';
      else if (isPrivate) visibility = 'private';
      else if (isProtected) visibility = 'protected';
      // Python convention
      if (language === 'python' && name.startsWith('__') && !name.endsWith('__')) visibility = 'private';
      else if (language === 'python' && name.startsWith('_')) visibility = 'protected';
      // Go convention
      if (language === 'go' && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) visibility = 'public';

      // Build a clean signature without body
      const cleanSig = sig.replace(/\{[\s\S]*$/, '').replace(/:\s*$/, '').trim();

      const gNode: GraphNode = {
        id: generateNodeId(filePath, name, type, startLine),
        type,
        name,
        qualifiedName: name,
        filePath,
        startLine,
        endLine,
        signature: cleanSig,
        docComment: findRegexDocComment(lines, startLine - 1),
        hash: generateContentHash(matchText),
        language,
        visibility,
        isAsync,
        isStatic,
        isExported: isExportedMatch,
        updatedAt: now,
      };

      nodes.push(gNode);
      edges.push({ sourceId: fileNode.id, targetId: gNode.id, type: 'contains' });
    }
  }

  // Extract import edges
  const importPatterns: Record<string, RegExp> = {
    javascript: /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/gm,
    typescript: /(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/gm,
    python: /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm,
    java: /import\s+(?:static\s+)?([\w.]+);/gm,
    go: /import\s+(?:\(\s*(?:"([^"]+)"[\s]*)+\)|"([^"]+)")/gm,
    rust: /use\s+([\w:]+)/gm,
    csharp: /using\s+(?:static\s+)?([\w.]+);/gm,
    ruby: /require(?:_relative)?\s+['"]([^'"]+)['"]/gm,
    php: /(?:use\s+([\w\\]+)|require(?:_once)?\s+['"]([^'"]+)['"]|include(?:_once)?\s+['"]([^'"]+)['"])/gm,
    c: /#include\s+[<"]([^>"]+)[>"]/gm,
    cpp: /#include\s+[<"]([^>"]+)[>"]/gm,
    bash: /(?:source|\.)\s+['"]?([^'";\s]+)['"]?/gm,
    kotlin: /import\s+([\w.]+)/gm,
    swift: /import\s+(\w+)/gm,
    dart: /import\s+['"]([^'"]+)['"]/gm,
    scala: /import\s+([\w.{}]+)/gm,
    sql: /-- no imports/gm,
  };

  const importRegex = importPatterns[language];
  if (importRegex) {
    const regex = new RegExp(importRegex.source, importRegex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const importSource = match[1] ?? match[2] ?? match[3] ?? '';
      if (importSource) {
        edges.push({
          sourceId: fileNode.id,
          targetId: importSource,
          type: 'imports',
          metadata: { raw: match[0].trim() },
        });
      }
    }
  }

  // ── Call Detection for regex-parsed files ──
  const regexFunctionNodes = nodes.filter(n => 
    ['function', 'method', 'constructor'].includes(n.type) && n.startLine && n.endLine
  );
  const regexFunctionNames = new Map<string, typeof nodes[0]>();
  for (const fn of regexFunctionNodes) {
    regexFunctionNames.set(fn.name, fn);
  }

  if (regexFunctionNames.size > 0) {
    const nameList = [...regexFunctionNames.keys()].filter(n => n.length >= 2 && /^\w+$/.test(n));
    if (nameList.length > 0) {
      const callPattern = new RegExp(
        `\\b(${nameList.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`,
        'g'
      );
      const contentLines = source.split('\n');
      for (const caller of regexFunctionNodes) {
        if (!caller.startLine || !caller.endLine) continue;
        const bodyText = contentLines.slice(caller.startLine, Math.min(caller.endLine, contentLines.length)).join('\n');
        let match: RegExpExecArray | null;
        const calledNames = new Set<string>();
        callPattern.lastIndex = 0;
        while ((match = callPattern.exec(bodyText)) !== null) {
          const calledName = match[1];
          if (calledName !== caller.name && !calledNames.has(calledName)) {
            calledNames.add(calledName);
            const callee = regexFunctionNames.get(calledName);
            if (callee) {
              edges.push({
                sourceId: caller.id,
                targetId: callee.id,
                type: 'calls' as EdgeType,
              });
            }
          }
        }
      }
    }
  }

  return { nodes, edges };
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse a source code file and extract its structural information.
 *
 * Attempts tree-sitter parsing first, falls back to regex if unavailable.
 *
 * @param filePath - Absolute path to the source file
 * @param source - Optional pre-read source code (reads from disk if not provided)
 * @returns ParseResult with extracted nodes, edges, and any parse errors
 */
export async function parseFile(filePath: string, source?: string): Promise<ParseResult> {
  const language = detectLanguage(filePath);
  if (!language) {
    return {
      filePath,
      language: 'unknown',
      nodes: [],
      edges: [],
      parseErrors: [`Unsupported file extension: ${extname(filePath)}`],
    };
  }

  let content: string;
  try {
    content = source ?? await readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      filePath,
      language,
      nodes: [],
      edges: [],
      parseErrors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!content.trim()) {
    return {
      filePath,
      language,
      nodes: [],
      edges: [],
      parseErrors: [],
    };
  }

  const parseErrors: string[] = [];
  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];

  // Try tree-sitter first
  const ts = await getTreeSitterParser(language);
  if (ts) {
    try {
      ts.parser.setLanguage(ts.grammar);
      const tree = ts.parser.parse(content);

      if (tree.rootNode.hasError) {
        parseErrors.push('Tree-sitter reported parse errors; results may be incomplete');
      }

      const result = extractFromTreeSitter(tree, content, filePath, language);
      nodes = result.nodes;
      edges = result.edges;
    } catch (err) {
      parseErrors.push(`Tree-sitter parsing failed: ${err instanceof Error ? err.message : String(err)}, using regex fallback`);
      const result = parseWithRegex(content, filePath, language);
      nodes = result.nodes;
      edges = result.edges;
    }
  } else {
    // Use regex fallback
    const result = parseWithRegex(content, filePath, language);
    nodes = result.nodes;
    edges = result.edges;
  }

  return { filePath, language, nodes, edges, parseErrors, sourceContent: content };
}

/**
 * Parse multiple files in parallel using worker_threads.
 *
 * Uses Node.js Worker threads for true CPU-level parallelism of tree-sitter
 * parsing. Each worker gets its own V8 isolate with independent Parser
 * instances and grammar caches.
 *
 * Falls back to single-threaded batch processing if:
 * - File count is <= 4 (worker overhead not worthwhile)
 * - The compiled worker script is missing
 * - All workers fail at runtime
 *
 * @param files - Array of file paths to parse
 * @param concurrency - Max concurrent parses for single-threaded fallback (default 8)
 * @param onProgress - Optional progress callback (current, total)
 * @returns Array of ParseResults in the same order as the input files
 */
export async function parseFiles(
  files: string[],
  concurrency: number = 8,
  onProgress?: (current: number, total: number) => void,
): Promise<ParseResult[]> {
  const total = files.length;

  if (total === 0) return [];

  // For small file counts, skip worker overhead
  if (total <= 4) {
    return parseFilesSingleThreaded(files, concurrency, onProgress);
  }

  // Resolve the compiled worker script path
  const workerPath = resolveWorkerPath();
  if (!workerPath) {
    // Worker script not found — fall back to single-threaded
    return parseFilesSingleThreaded(files, concurrency, onProgress);
  }

  // Determine worker count: min(cpu cores, 4, ceil(files / 2))
  const numCpus = cpus().length;
  const workerCount = Math.min(numCpus, 8, Math.ceil(total / 2));

  // Distribute files round-robin across workers
  const chunks: string[][] = Array.from({ length: workerCount }, () => []);
  for (let i = 0; i < total; i++) {
    chunks[i % workerCount].push(files[i]);
  }

  // Launch workers and collect results
  let completed = 0;
  const workerPromises = chunks.map((chunk) => {
    return new Promise<ParseResult[]>((resolve, reject) => {
      const worker = new Worker(workerPath);

      worker.on('message', (results: ParseResult[]) => {
        completed += results.length;
        onProgress?.(Math.min(completed, total), total);
        worker.terminate();
        resolve(results);
      });

      worker.on('error', (err) => {
        worker.terminate();
        console.error(
          `[ai-mind-map] Worker failed, falling back to main thread: ${err.message}`,
        );
        // Graceful degradation: parse this chunk on the main thread
        parseFilesSingleThreaded(chunk, concurrency).then(
          (results) => {
            completed += results.length;
            onProgress?.(Math.min(completed, total), total);
            resolve(results);
          },
          reject,
        );
      });

      worker.on('exit', (code) => {
        if (code !== 0 && code !== 1) {
          console.error(`[ai-mind-map] Worker exited with code ${code}`);
        }
      });

      // Send the file chunk to the worker
      worker.postMessage({ files: chunk });
    });
  });

  try {
    const allResults = await Promise.all(workerPromises);

    // Re-assemble results in original file order
    const resultMap = new Map<string, ParseResult>();
    for (const workerResults of allResults) {
      for (const result of workerResults) {
        resultMap.set(result.filePath, result);
      }
    }
    return files.map((f) => resultMap.get(f)!).filter(Boolean);
  } catch (err) {
    // Complete fallback: parse everything on the main thread
    console.error(
      `[ai-mind-map] All workers failed, using single-threaded fallback: ${err}`,
    );
    return parseFilesSingleThreaded(files, concurrency, onProgress);
  }
}

/**
 * Resolve the path to the compiled parse-worker.js script.
 * Returns null if the worker script cannot be found.
 */
function resolveWorkerPath(): string | null {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const workerJs = join(thisDir, 'parse-worker.js');
    if (existsSync(workerJs)) return workerJs;

    // Also check dist/ relative paths (in case of alternative layouts)
    const distWorker = join(thisDir, '..', 'knowledge-graph', 'parse-worker.js');
    if (existsSync(distWorker)) return distWorker;

    return null;
  } catch {
    return null;
  }
}

/**
 * Single-threaded batch fallback for parseFiles.
 * Used when worker count is too low to justify threads, or as a fallback.
 */
async function parseFilesSingleThreaded(
  files: string[],
  concurrency: number = 8,
  onProgress?: (current: number, total: number) => void,
): Promise<ParseResult[]> {
  const results: ParseResult[] = [];
  const total = files.length;

  for (let i = 0; i < total; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((f) => parseFile(f)),
    );
    results.push(...batchResults);
    onProgress?.(Math.min(i + concurrency, total), total);
  }

  return results;
}

/**
 * Check if a file extension is supported for parsing.
 */
export function isSupportedFile(filePath: string): boolean {
  return detectLanguage(filePath) !== null;
}

/**
 * Get the list of supported languages.
 */
export function getSupportedLanguages(): string[] {
  return [...new Set(Object.values(EXTENSION_MAP))];
}

/** Report the status of each language parser (tree-sitter vs regex fallback) */
export function getParserStatus(): {
  treeSitterAvailable: boolean;
  languages: Array<{
    language: string;
    extensions: string[];
    hasTreeSitter: boolean;
    treeSitterStatus: 'loaded' | 'failed' | 'not_available' | 'no_grammar';
    hasFallback: boolean;
  }>;
} {
  const languages = getSupportedLanguages();
  return {
    treeSitterAvailable: treeSitterAvailable === true,
    languages: languages.map(lang => {
      const hasGrammar = lang in GRAMMAR_MAP;
      const extensions = Object.entries(EXTENSION_MAP)
        .filter(([_, l]) => l === lang)
        .map(([ext]) => ext);

      let treeSitterStatus: 'loaded' | 'failed' | 'not_available' | 'no_grammar';
      if (!hasGrammar) {
        treeSitterStatus = 'no_grammar';
      } else if (treeSitterAvailable === false) {
        treeSitterStatus = 'not_available';
      } else if (failedGrammars.has(lang)) {
        treeSitterStatus = 'failed';
      } else if (loadedGrammars.has(lang)) {
        treeSitterStatus = 'loaded';
      } else {
        treeSitterStatus = 'not_available';
      }

      return {
        language: lang,
        extensions,
        hasTreeSitter: hasGrammar && loadedGrammars.has(lang),
        treeSitterStatus,
        hasFallback: lang in REGEX_PATTERNS,
      };
    }),
  };
}
