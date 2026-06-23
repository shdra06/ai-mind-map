/**
 * AI Mind Map — Mini Cypher Query Parser & Executor
 *
 * A read-only openCypher subset that compiles Cypher queries into SQL
 * targeting the knowledge graph's `nodes` and `edges` tables in SQLite.
 *
 * Inspired by codebase-memory-mcp's Cypher-like query interface.
 *
 * Supported Cypher syntax:
 *   MATCH (f:Function) RETURN f.name LIMIT 10
 *   MATCH (f:Function)-[:CALLS]->(g:Function) WHERE f.name = 'auth' RETURN f.name, g.name
 *   MATCH (f:Function) WHERE f.filePath CONTAINS 'auth' RETURN f.name, f.signature
 *   MATCH (f:Function) WHERE NOT EXISTS { (f)<-[:CALLS]-() } RETURN f.name
 */

import type Database from 'better-sqlite3';
import type { KnowledgeGraph } from './graph.js';

// ============================================================
// Result Types
// ============================================================

/** The result of executing a Cypher query */
export interface CypherResult {
  /** Column names in the result set */
  columns: string[];
  /** Array of row objects keyed by column name */
  rows: Record<string, unknown>[];
  /** Total number of rows returned */
  count: number;
  /** The SQL query that was generated (for debugging) */
  generatedSql: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

// ============================================================
// Token Types
// ============================================================

enum TokenType {
  // Keywords
  MATCH = 'MATCH',
  WHERE = 'WHERE',
  RETURN = 'RETURN',
  ORDER = 'ORDER',
  BY = 'BY',
  LIMIT = 'LIMIT',
  DISTINCT = 'DISTINCT',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  IN = 'IN',
  CONTAINS = 'CONTAINS',
  STARTS = 'STARTS',
  ENDS = 'ENDS',
  WITH = 'WITH',
  EXISTS = 'EXISTS',
  ASC = 'ASC',
  DESC = 'DESC',
  AS = 'AS',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  NULL = 'NULL',

  // Literals & identifiers
  IDENTIFIER = 'IDENTIFIER',
  STRING = 'STRING',
  NUMBER = 'NUMBER',

  // Symbols
  LPAREN = 'LPAREN',       // (
  RPAREN = 'RPAREN',       // )
  LBRACKET = 'LBRACKET',   // [
  RBRACKET = 'RBRACKET',   // ]
  LBRACE = 'LBRACE',       // {
  RBRACE = 'RBRACE',       // }
  COLON = 'COLON',         // :
  DOT = 'DOT',             // .
  COMMA = 'COMMA',         // ,
  DASH = 'DASH',           // -
  GT = 'GT',               // >
  LT = 'LT',               // <
  EQ = 'EQ',               // =
  NEQ = 'NEQ',             // <>
  GTE = 'GTE',             // >=
  LTE = 'LTE',             // <=
  ARROW_RIGHT = 'ARROW_RIGHT', // ->
  ARROW_LEFT = 'ARROW_LEFT',   // <-
  STAR = 'STAR',           // *

  // End
  EOF = 'EOF',
}

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

// ============================================================
// AST Node Types
// ============================================================

interface NodePattern {
  variable: string | null;
  label: string | null;
}

type EdgeDirection = 'right' | 'left' | 'both';

interface EdgePattern {
  variable: string | null;
  edgeType: string | null;
  direction: EdgeDirection;
}

interface MatchPattern {
  startNode: NodePattern;
  chain: { edge: EdgePattern; node: NodePattern }[];
}

type ComparisonOp = '=' | '<>' | '>' | '<' | '>=' | '<=' | 'CONTAINS' | 'STARTS WITH' | 'ENDS WITH' | 'IN';

interface ComparisonExpr {
  kind: 'comparison';
  left: PropertyRef;
  op: ComparisonOp;
  right: LiteralValue | LiteralValue[];
}

interface NotExistsExpr {
  kind: 'not_exists';
  /** The variable that should have no matching pattern */
  variable: string;
  /** Edge type to check (e.g. 'CALLS') */
  edgeType: string | null;
  /** Direction: 'incoming' = <-[:TYPE]-(), 'outgoing' = -[:TYPE]->() */
  direction: 'incoming' | 'outgoing';
}

interface LogicalExpr {
  kind: 'and' | 'or';
  left: WhereExpr;
  right: WhereExpr;
}

interface NotExpr {
  kind: 'not';
  operand: WhereExpr;
}

type WhereExpr = ComparisonExpr | NotExistsExpr | LogicalExpr | NotExpr;

interface PropertyRef {
  variable: string;
  property: string;
}

type LiteralValue = string | number | boolean | null;

interface ReturnItem {
  expr: PropertyRef | { kind: 'star'; variable: string };
  alias: string | null;
}

interface OrderByItem {
  expr: PropertyRef;
  direction: 'ASC' | 'DESC';
}

interface CypherAST {
  matchPattern: MatchPattern;
  where: WhereExpr | null;
  returnItems: ReturnItem[];
  distinct: boolean;
  orderBy: OrderByItem[];
  limit: number | null;
}

// ============================================================
// Property name → SQL column name mapping
// ============================================================

/** Map Cypher property names to actual SQLite column names */
const PROPERTY_TO_COLUMN: Record<string, string> = {
  name: 'name',
  type: 'type',
  id: 'id',
  qualifiedName: 'qualifiedName',
  filePath: 'filePath',
  startLine: 'startLine',
  endLine: 'endLine',
  signature: 'signature',
  docComment: 'docComment',
  hash: 'hash',
  language: 'language',
  visibility: 'visibility',
  isAsync: 'isAsync',
  isStatic: 'isStatic',
  isExported: 'isExported',
  parameters: 'parameters',
  returnType: 'returnType',
  updatedAt: 'updatedAt',
};

/** Map Cypher labels (case-insensitive lookup) to node type values in the database */
const LABEL_TO_TYPE: Record<string, string> = {
  file: 'file',
  function: 'function',
  class: 'class',
  method: 'method',
  interface: 'interface',
  type_alias: 'type_alias',
  typealias: 'type_alias',
  enum: 'enum',
  variable: 'variable',
  constant: 'constant',
  module: 'module',
  namespace: 'namespace',
  property: 'property',
  constructor: 'constructor',
  decorator: 'decorator',
  route: 'route',
  component: 'component',
  hook: 'hook',
  test: 'test',
  config: 'config',
};

/** Map Cypher edge type labels (case-insensitive) to edge type values */
const EDGE_LABEL_TO_TYPE: Record<string, string> = {
  calls: 'calls',
  imports: 'imports',
  exports: 'exports',
  inherits: 'inherits',
  implements: 'implements',
  uses: 'uses',
  decorates: 'decorates',
  overrides: 'overrides',
  contains: 'contains',
  tests: 'tests',
  depends_on: 'depends_on',
  dependson: 'depends_on',
  routes_to: 'routes_to',
  routesto: 'routes_to',
};

// ============================================================
// Lexer
// ============================================================

const KEYWORDS = new Set<string>([
  'MATCH', 'WHERE', 'RETURN', 'ORDER', 'BY', 'LIMIT', 'DISTINCT',
  'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'STARTS', 'ENDS', 'WITH',
  'EXISTS', 'ASC', 'DESC', 'AS', 'TRUE', 'FALSE', 'NULL',
  'CREATE', 'MERGE', 'SET', 'DELETE', 'REMOVE', 'DETACH',
]);

/** Forbidden write keywords — we only allow read-only queries */
const WRITE_KEYWORDS = new Set<string>([
  'CREATE', 'MERGE', 'SET', 'DELETE', 'REMOVE', 'DETACH',
]);

/**
 * Tokenize a Cypher query string into a list of tokens.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < input.length) {
    // Skip whitespace
    if (/\s/.test(input[pos])) {
      pos++;
      continue;
    }

    // Skip line comments //
    if (input[pos] === '/' && input[pos + 1] === '/') {
      while (pos < input.length && input[pos] !== '\n') pos++;
      continue;
    }

    const startPos = pos;

    // String literals (single or double quoted)
    if (input[pos] === '\'' || input[pos] === '"') {
      const quote = input[pos];
      pos++;
      let value = '';
      while (pos < input.length && input[pos] !== quote) {
        if (input[pos] === '\\' && pos + 1 < input.length) {
          pos++;
          if (input[pos] === 'n') value += '\n';
          else if (input[pos] === 't') value += '\t';
          else value += input[pos];
        } else {
          value += input[pos];
        }
        pos++;
      }
      if (pos >= input.length) {
        throw new CypherSyntaxError(`Unterminated string literal`, startPos);
      }
      pos++; // consume closing quote
      tokens.push({ type: TokenType.STRING, value, position: startPos });
      continue;
    }

    // Numbers (integers and decimals)
    if (/\d/.test(input[pos]) || (input[pos] === '-' && pos + 1 < input.length && /\d/.test(input[pos + 1]) && (tokens.length === 0 || [TokenType.EQ, TokenType.NEQ, TokenType.GT, TokenType.LT, TokenType.GTE, TokenType.LTE, TokenType.COMMA, TokenType.LPAREN, TokenType.AND, TokenType.OR].includes(tokens[tokens.length - 1].type)))) {
      let numStr = '';
      if (input[pos] === '-') {
        numStr = '-';
        pos++;
      }
      while (pos < input.length && /[\d.]/.test(input[pos])) {
        numStr += input[pos];
        pos++;
      }
      tokens.push({ type: TokenType.NUMBER, value: numStr, position: startPos });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(input[pos])) {
      let ident = '';
      while (pos < input.length && /[a-zA-Z0-9_]/.test(input[pos])) {
        ident += input[pos];
        pos++;
      }
      const upper = ident.toUpperCase();
      if (WRITE_KEYWORDS.has(upper)) {
        throw new CypherSyntaxError(
          `Write operations are not supported. This is a read-only query engine. Found: ${ident}`,
          startPos,
        );
      }
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: upper as TokenType, value: ident, position: startPos });
      } else {
        tokens.push({ type: TokenType.IDENTIFIER, value: ident, position: startPos });
      }
      continue;
    }

    // Multi-character operators
    if (input[pos] === '-' && input[pos + 1] === '>') {
      tokens.push({ type: TokenType.ARROW_RIGHT, value: '->', position: startPos });
      pos += 2;
      continue;
    }
    if (input[pos] === '<' && input[pos + 1] === '-') {
      tokens.push({ type: TokenType.ARROW_LEFT, value: '<-', position: startPos });
      pos += 2;
      continue;
    }
    if (input[pos] === '<' && input[pos + 1] === '>') {
      tokens.push({ type: TokenType.NEQ, value: '<>', position: startPos });
      pos += 2;
      continue;
    }
    if (input[pos] === '>' && input[pos + 1] === '=') {
      tokens.push({ type: TokenType.GTE, value: '>=', position: startPos });
      pos += 2;
      continue;
    }
    if (input[pos] === '<' && input[pos + 1] === '=') {
      tokens.push({ type: TokenType.LTE, value: '<=', position: startPos });
      pos += 2;
      continue;
    }

    // Single-character tokens
    const singleCharMap: Record<string, TokenType> = {
      '(': TokenType.LPAREN,
      ')': TokenType.RPAREN,
      '[': TokenType.LBRACKET,
      ']': TokenType.RBRACKET,
      '{': TokenType.LBRACE,
      '}': TokenType.RBRACE,
      ':': TokenType.COLON,
      '.': TokenType.DOT,
      ',': TokenType.COMMA,
      '-': TokenType.DASH,
      '>': TokenType.GT,
      '<': TokenType.LT,
      '=': TokenType.EQ,
      '*': TokenType.STAR,
    };

    if (singleCharMap[input[pos]]) {
      tokens.push({ type: singleCharMap[input[pos]], value: input[pos], position: startPos });
      pos++;
      continue;
    }

    throw new CypherSyntaxError(`Unexpected character: '${input[pos]}'`, pos);
  }

  tokens.push({ type: TokenType.EOF, value: '', position: pos });
  return tokens;
}

// ============================================================
// Parser
// ============================================================

/**
 * Recursive descent parser that produces a CypherAST from a token stream.
 */
class CypherParser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  /** Peek at the current token without consuming it */
  private peek(): Token {
    return this.tokens[this.pos];
  }

  /** Consume and return the current token */
  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  /** Expect a specific token type; throw if not matched */
  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new CypherSyntaxError(
        `Expected ${type} but found ${token.type} ('${token.value}')`,
        token.position,
      );
    }
    return this.advance();
  }

  /** Check if current token is of a given type (case-insensitive for keywords) */
  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  /** If current token matches, consume it and return true */
  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  /** Main parse entry point */
  parse(): CypherAST {
    this.expect(TokenType.MATCH);
    const matchPattern = this.parseMatchPattern();

    let where: WhereExpr | null = null;
    if (this.check(TokenType.WHERE)) {
      this.advance();
      where = this.parseWhereExpr();
    }

    this.expect(TokenType.RETURN);

    let distinct = false;
    if (this.check(TokenType.DISTINCT)) {
      this.advance();
      distinct = true;
    }

    const returnItems = this.parseReturnItems();

    const orderBy: OrderByItem[] = [];
    if (this.check(TokenType.ORDER)) {
      this.advance();
      this.expect(TokenType.BY);
      orderBy.push(...this.parseOrderByItems());
    }

    let limit: number | null = null;
    if (this.check(TokenType.LIMIT)) {
      this.advance();
      const numToken = this.expect(TokenType.NUMBER);
      limit = parseInt(numToken.value, 10);
      if (isNaN(limit) || limit < 0) {
        throw new CypherSyntaxError(`Invalid LIMIT value: ${numToken.value}`, numToken.position);
      }
    }

    if (!this.check(TokenType.EOF)) {
      const token = this.peek();
      throw new CypherSyntaxError(
        `Unexpected token after query end: ${token.type} ('${token.value}')`,
        token.position,
      );
    }

    return { matchPattern, where, returnItems, distinct, orderBy, limit };
  }

  // ---- MATCH pattern parsing ----

  private parseMatchPattern(): MatchPattern {
    const startNode = this.parseNodePattern();
    const chain: { edge: EdgePattern; node: NodePattern }[] = [];

    while (this.isEdgeStart()) {
      const edge = this.parseEdgePattern();
      const node = this.parseNodePattern();
      chain.push({ edge, node });
    }

    return { startNode, chain };
  }

  private isEdgeStart(): boolean {
    return this.check(TokenType.DASH) || this.check(TokenType.ARROW_LEFT);
  }

  private parseNodePattern(): NodePattern {
    this.expect(TokenType.LPAREN);
    let variable: string | null = null;
    let label: string | null = null;

    if (this.check(TokenType.IDENTIFIER)) {
      variable = this.advance().value;
    }

    if (this.check(TokenType.COLON)) {
      this.advance();
      const labelToken = this.expect(TokenType.IDENTIFIER);
      label = labelToken.value;
    }

    this.expect(TokenType.RPAREN);
    return { variable, label };
  }

  private parseEdgePattern(): EdgePattern {
    let direction: EdgeDirection = 'both';
    let variable: string | null = null;
    let edgeType: string | null = null;

    if (this.match(TokenType.ARROW_LEFT)) {
      // <-[...]- or <-
      direction = 'left';
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        ({ variable, edgeType } = this.parseEdgeBody());
        this.expect(TokenType.RBRACKET);
      }
      this.expect(TokenType.DASH);
    } else {
      // - or -[...]-> or -[...]-
      this.expect(TokenType.DASH);
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        ({ variable, edgeType } = this.parseEdgeBody());
        this.expect(TokenType.RBRACKET);
      }
      if (this.match(TokenType.ARROW_RIGHT)) {
        direction = 'right';
      } else if (this.check(TokenType.DASH)) {
        this.advance();
        direction = 'both';
      }
    }

    return { variable, edgeType, direction };
  }

  private parseEdgeBody(): { variable: string | null; edgeType: string | null } {
    let variable: string | null = null;
    let edgeType: string | null = null;

    // Optional variable
    if (this.check(TokenType.IDENTIFIER) && !this.isColonAhead()) {
      variable = this.advance().value;
    }

    // Optional :TYPE
    if (this.check(TokenType.COLON)) {
      this.advance();
      const typeToken = this.expect(TokenType.IDENTIFIER);
      edgeType = typeToken.value;
    }

    return { variable, edgeType };
  }

  /** Look ahead to see if a colon follows the current token (for edge body parsing) */
  private isColonAhead(): boolean {
    return this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1].type === TokenType.COLON;
  }

  // ---- WHERE clause parsing ----

  private parseWhereExpr(): WhereExpr {
    return this.parseOrExpr();
  }

  private parseOrExpr(): WhereExpr {
    let left = this.parseAndExpr();
    while (this.check(TokenType.OR)) {
      this.advance();
      const right = this.parseAndExpr();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAndExpr(): WhereExpr {
    let left = this.parsePrimaryExpr();
    while (this.check(TokenType.AND)) {
      this.advance();
      const right = this.parsePrimaryExpr();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parsePrimaryExpr(): WhereExpr {
    // NOT
    if (this.check(TokenType.NOT)) {
      this.advance();
      // NOT EXISTS { (f)<-[:CALLS]-() }
      if (this.check(TokenType.EXISTS)) {
        return this.parseNotExistsExpr();
      }
      const operand = this.parsePrimaryExpr();
      return { kind: 'not', operand };
    }

    // Parenthesized expression
    if (this.check(TokenType.LPAREN) && this.isSubExprParen()) {
      this.advance();
      const expr = this.parseWhereExpr();
      this.expect(TokenType.RPAREN);
      return expr;
    }

    // Property comparison: f.name = 'value'
    return this.parseComparison();
  }

  /**
   * Distinguish between a parenthesized sub-expression and a node pattern.
   * If the token after `(` is an identifier followed by `.`, it's a comparison.
   * Otherwise it's likely a sub-expression if followed by NOT or another `(`.
   */
  private isSubExprParen(): boolean {
    if (this.pos + 1 >= this.tokens.length) return false;
    const next = this.tokens[this.pos + 1];
    // If we see NOT or another (, it's a sub-expression
    if (next.type === TokenType.NOT || next.type === TokenType.LPAREN) return true;
    // If we see identifier.identifier, it's a comparison in parens
    if (next.type === TokenType.IDENTIFIER && this.pos + 2 < this.tokens.length &&
        this.tokens[this.pos + 2].type === TokenType.DOT) return true;
    return false;
  }

  private parseNotExistsExpr(): NotExistsExpr {
    this.expect(TokenType.EXISTS);
    this.expect(TokenType.LBRACE);

    // Parse the pattern: (variable)<-[:TYPE]-() or (variable)-[:TYPE]->()
    this.expect(TokenType.LPAREN);
    const varToken = this.expect(TokenType.IDENTIFIER);
    const variable = varToken.value;
    this.expect(TokenType.RPAREN);

    let direction: 'incoming' | 'outgoing' = 'incoming';
    let edgeType: string | null = null;

    if (this.check(TokenType.ARROW_LEFT)) {
      // <-[:TYPE]-()
      this.advance();
      direction = 'incoming';
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        if (this.check(TokenType.COLON)) {
          this.advance();
          edgeType = this.expect(TokenType.IDENTIFIER).value;
        }
        this.expect(TokenType.RBRACKET);
      }
      this.expect(TokenType.DASH);
    } else if (this.check(TokenType.DASH)) {
      // -[:TYPE]->()
      this.advance();
      direction = 'outgoing';
      if (this.check(TokenType.LBRACKET)) {
        this.advance();
        if (this.check(TokenType.COLON)) {
          this.advance();
          edgeType = this.expect(TokenType.IDENTIFIER).value;
        }
        this.expect(TokenType.RBRACKET);
      }
      this.expect(TokenType.ARROW_RIGHT);
    }

    this.expect(TokenType.LPAREN);
    this.expect(TokenType.RPAREN);
    this.expect(TokenType.RBRACE);

    return { kind: 'not_exists', variable, edgeType, direction };
  }

  private parseComparison(): ComparisonExpr {
    const left = this.parsePropertyRef();

    const opToken = this.peek();
    let op: ComparisonOp;

    switch (opToken.type) {
      case TokenType.EQ:
        this.advance(); op = '='; break;
      case TokenType.NEQ:
        this.advance(); op = '<>'; break;
      case TokenType.GT:
        this.advance(); op = '>'; break;
      case TokenType.LT:
        this.advance(); op = '<'; break;
      case TokenType.GTE:
        this.advance(); op = '>='; break;
      case TokenType.LTE:
        this.advance(); op = '<='; break;
      case TokenType.CONTAINS:
        this.advance(); op = 'CONTAINS'; break;
      case TokenType.STARTS:
        this.advance();
        this.expect(TokenType.WITH);
        op = 'STARTS WITH';
        break;
      case TokenType.ENDS:
        this.advance();
        this.expect(TokenType.WITH);
        op = 'ENDS WITH';
        break;
      case TokenType.IN:
        this.advance(); op = 'IN'; break;
      default:
        throw new CypherSyntaxError(
          `Expected comparison operator but found ${opToken.type} ('${opToken.value}')`,
          opToken.position,
        );
    }

    if (op === 'IN') {
      const right = this.parseLiteralList();
      return { kind: 'comparison', left, op, right };
    }

    const right = this.parseLiteral();
    return { kind: 'comparison', left, op, right };
  }

  private parsePropertyRef(): PropertyRef {
    const variableToken = this.expect(TokenType.IDENTIFIER);
    this.expect(TokenType.DOT);
    const propertyToken = this.expect(TokenType.IDENTIFIER);
    return { variable: variableToken.value, property: propertyToken.value };
  }

  private parseLiteral(): LiteralValue {
    const token = this.peek();
    switch (token.type) {
      case TokenType.STRING:
        this.advance();
        return token.value;
      case TokenType.NUMBER:
        this.advance();
        return token.value.includes('.') ? parseFloat(token.value) : parseInt(token.value, 10);
      case TokenType.TRUE:
        this.advance();
        return true;
      case TokenType.FALSE:
        this.advance();
        return false;
      case TokenType.NULL:
        this.advance();
        return null;
      default:
        throw new CypherSyntaxError(
          `Expected literal value but found ${token.type} ('${token.value}')`,
          token.position,
        );
    }
  }

  private parseLiteralList(): LiteralValue[] {
    this.expect(TokenType.LBRACKET);
    const values: LiteralValue[] = [];

    if (!this.check(TokenType.RBRACKET)) {
      values.push(this.parseLiteral());
      while (this.match(TokenType.COMMA)) {
        values.push(this.parseLiteral());
      }
    }

    this.expect(TokenType.RBRACKET);
    return values;
  }

  // ---- RETURN clause parsing ----

  private parseReturnItems(): ReturnItem[] {
    const items: ReturnItem[] = [];
    items.push(this.parseReturnItem());

    while (this.match(TokenType.COMMA)) {
      items.push(this.parseReturnItem());
    }

    return items;
  }

  private parseReturnItem(): ReturnItem {
    // Check for variable.* (return all properties)
    if (this.check(TokenType.IDENTIFIER) && this.pos + 1 < this.tokens.length &&
        this.tokens[this.pos + 1].type === TokenType.DOT &&
        this.pos + 2 < this.tokens.length &&
        this.tokens[this.pos + 2].type === TokenType.STAR) {
      const variable = this.advance().value;
      this.advance(); // .
      this.advance(); // *
      let alias: string | null = null;
      if (this.check(TokenType.AS)) {
        this.advance();
        alias = this.expect(TokenType.IDENTIFIER).value;
      }
      return { expr: { kind: 'star', variable }, alias };
    }

    // variable.property
    const ref = this.parsePropertyRef();
    let alias: string | null = null;
    if (this.check(TokenType.AS)) {
      this.advance();
      alias = this.expect(TokenType.IDENTIFIER).value;
    }
    return { expr: ref, alias };
  }

  // ---- ORDER BY clause parsing ----

  private parseOrderByItems(): OrderByItem[] {
    const items: OrderByItem[] = [];
    items.push(this.parseOrderByItem());

    while (this.match(TokenType.COMMA)) {
      items.push(this.parseOrderByItem());
    }

    return items;
  }

  private parseOrderByItem(): OrderByItem {
    const expr = this.parsePropertyRef();
    let direction: 'ASC' | 'DESC' = 'ASC';

    if (this.check(TokenType.ASC)) {
      this.advance();
      direction = 'ASC';
    } else if (this.check(TokenType.DESC)) {
      this.advance();
      direction = 'DESC';
    }

    return { expr, direction };
  }
}

// ============================================================
// SQL Code Generator / Executor
// ============================================================

/**
 * Mini Cypher query engine that compiles Cypher queries into SQL
 * and executes them against the knowledge graph's SQLite database.
 *
 * This is a read-only engine — no CREATE, MERGE, SET, or DELETE.
 *
 * @example
 * ```ts
 * const engine = new CypherEngine(db);
 * const result = engine.execute("MATCH (f:Function) RETURN f.name LIMIT 10");
 * console.log(result.rows);
 * ```
 */
export class CypherEngine {
  private db: Database.Database;

  /**
   * Create a new CypherEngine.
   *
   * @param graph - A KnowledgeGraph instance (the DB is extracted via graph.getDb())
   */
  constructor(graph: KnowledgeGraph) {
    this.db = graph.getDb();
  }

  /**
   * Execute a Cypher query and return the results.
   *
   * @param query - A Cypher query string (read-only subset)
   * @param projectFilter - Optional project path to scope results by filePath
   * @returns The query result with columns, rows, and metadata
   * @throws {CypherSyntaxError} If the query has a syntax error
   * @throws {CypherExecutionError} If the query fails during execution
   */
  execute(query: string, projectFilter?: string): CypherResult {
    const startTime = performance.now();

    try {
      // 1. Tokenize
      const tokens = tokenize(query.trim());

      // 2. Parse into AST
      const parser = new CypherParser(tokens);
      const ast = parser.parse();

      // 2b. If a project filter is given, inject a filePath CONTAINS condition
      if (projectFilter) {
        this.injectProjectFilter(ast, projectFilter);
      }

      // 3. Compile AST to SQL
      const { sql, params, columns } = this.compileToSql(ast);

      // 4. Execute SQL
      const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

      const executionTimeMs = Math.round((performance.now() - startTime) * 100) / 100;

      return {
        columns,
        rows,
        count: rows.length,
        generatedSql: sql,
        executionTimeMs,
      };
    } catch (error) {
      if (error instanceof CypherSyntaxError || error instanceof CypherExecutionError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CypherExecutionError(`Query execution failed: ${message}`, query);
    }
  }

  /**
   * Inject a filePath filter into the AST's WHERE clause to scope results to a project path.
   */
  private injectProjectFilter(ast: CypherAST, projectPath: string): void {
    // Find the first node variable in the MATCH pattern
    const variable = ast.matchPattern.startNode.variable;
    if (!variable) return;

    const filterExpr: ComparisonExpr = {
      kind: 'comparison',
      left: { variable, property: 'filePath' },
      op: 'STARTS WITH',
      right: projectPath,
    };

    if (ast.where) {
      ast.where = { kind: 'and', left: ast.where, right: filterExpr };
    } else {
      ast.where = filterExpr;
    }
  }

  /**
   * Compile a CypherAST into a SQL query string, bound parameters, and column list.
   */
  private compileToSql(ast: CypherAST): { sql: string; params: unknown[]; columns: string[] } {
    const params: unknown[] = [];
    const { matchPattern, where, returnItems, distinct, orderBy, limit } = ast;

    // Build a map from variable names to their SQL table aliases and node labels
    const variableMap = new Map<string, { alias: string; label: string | null }>();
    let tableIndex = 0;
    let edgeIndex = 0;

    const fromClauses: string[] = [];
    const joinConditions: string[] = [];

    // Process start node
    const startAlias = `n${tableIndex++}`;
    if (matchPattern.startNode.variable) {
      variableMap.set(matchPattern.startNode.variable, {
        alias: startAlias,
        label: matchPattern.startNode.label,
      });
    }
    fromClauses.push(`nodes AS ${startAlias}`);

    if (matchPattern.startNode.label) {
      const nodeType = this.resolveNodeLabel(matchPattern.startNode.label);
      joinConditions.push(`${startAlias}.type = ?`);
      params.push(nodeType);
    }

    // Process chain (edge→node pairs)
    for (const { edge, node } of matchPattern.chain) {
      const edgeAlias = `e${edgeIndex++}`;
      const nodeAlias = `n${tableIndex++}`;

      fromClauses.push(`edges AS ${edgeAlias}`);
      fromClauses.push(`nodes AS ${nodeAlias}`);

      if (node.variable) {
        variableMap.set(node.variable, { alias: nodeAlias, label: node.label });
      }
      if (edge.variable) {
        variableMap.set(edge.variable, { alias: edgeAlias, label: null });
      }

      // Wire up the edge based on direction
      const prevAlias = `n${tableIndex - 2}`;
      switch (edge.direction) {
        case 'right':
          // (prev)-[edge]->(node): prev.id = edge.sourceId, edge.targetId = node.id
          joinConditions.push(`${edgeAlias}.sourceId = ${prevAlias}.id`);
          joinConditions.push(`${edgeAlias}.targetId = ${nodeAlias}.id`);
          break;
        case 'left':
          // (prev)<-[edge]-(node): prev.id = edge.targetId, edge.sourceId = node.id
          joinConditions.push(`${edgeAlias}.targetId = ${prevAlias}.id`);
          joinConditions.push(`${edgeAlias}.sourceId = ${nodeAlias}.id`);
          break;
        case 'both':
          // Undirected: either direction
          joinConditions.push(
            `((${edgeAlias}.sourceId = ${prevAlias}.id AND ${edgeAlias}.targetId = ${nodeAlias}.id) OR ` +
            `(${edgeAlias}.targetId = ${prevAlias}.id AND ${edgeAlias}.sourceId = ${nodeAlias}.id))`,
          );
          break;
      }

      // Filter by edge type
      if (edge.edgeType) {
        const resolvedType = this.resolveEdgeType(edge.edgeType);
        joinConditions.push(`${edgeAlias}.type = ?`);
        params.push(resolvedType);
      }

      // Filter by node label
      if (node.label) {
        const nodeType = this.resolveNodeLabel(node.label);
        joinConditions.push(`${nodeAlias}.type = ?`);
        params.push(nodeType);
      }
    }

    // Compile WHERE clause
    if (where) {
      const whereSql = this.compileWhereExpr(where, variableMap, params);
      joinConditions.push(whereSql);
    }

    // Compile SELECT (RETURN) clause
    const selectItems: string[] = [];
    const columns: string[] = [];

    for (const item of returnItems) {
      if ('kind' in item.expr && item.expr.kind === 'star') {
        // variable.* — return all columns with prefixed names
        const info = variableMap.get(item.expr.variable);
        if (!info) {
          throw new CypherExecutionError(
            `Unknown variable '${item.expr.variable}' in RETURN clause`,
            '',
          );
        }
        for (const [propName, colName] of Object.entries(PROPERTY_TO_COLUMN)) {
          const alias = `${item.expr.variable}_${propName}`;
          selectItems.push(`${info.alias}.${colName} AS ${alias}`);
          columns.push(alias);
        }
      } else {
        const ref = item.expr as PropertyRef;
        const colExpr = this.resolvePropertyRef(ref, variableMap);
        const alias = item.alias ?? `${ref.variable}_${ref.property}`;
        selectItems.push(`${colExpr} AS ${alias}`);
        columns.push(alias);
      }
    }

    // Build the final query
    let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${selectItems.join(', ')}\nFROM ${fromClauses.join(', ')}`;

    if (joinConditions.length > 0) {
      sql += `\nWHERE ${joinConditions.join('\n  AND ')}`;
    }

    // ORDER BY
    if (orderBy.length > 0) {
      const orderClauses = orderBy.map(item => {
        const colExpr = this.resolvePropertyRef(item.expr, variableMap);
        return `${colExpr} ${item.direction}`;
      });
      sql += `\nORDER BY ${orderClauses.join(', ')}`;
    }

    // LIMIT
    if (limit !== null) {
      sql += `\nLIMIT ?`;
      params.push(limit);
    }

    return { sql, params, columns };
  }

  /**
   * Compile a WHERE expression into a SQL fragment, appending bound params.
   */
  private compileWhereExpr(
    expr: WhereExpr,
    variableMap: Map<string, { alias: string; label: string | null }>,
    params: unknown[],
  ): string {
    switch (expr.kind) {
      case 'comparison':
        return this.compileComparison(expr, variableMap, params);
      case 'not_exists':
        return this.compileNotExists(expr, variableMap, params);
      case 'and':
        return `(${this.compileWhereExpr(expr.left, variableMap, params)} AND ${this.compileWhereExpr(expr.right, variableMap, params)})`;
      case 'or':
        return `(${this.compileWhereExpr(expr.left, variableMap, params)} OR ${this.compileWhereExpr(expr.right, variableMap, params)})`;
      case 'not':
        return `NOT (${this.compileWhereExpr(expr.operand, variableMap, params)})`;
    }
  }

  /**
   * Compile a comparison expression into SQL.
   */
  private compileComparison(
    expr: ComparisonExpr,
    variableMap: Map<string, { alias: string; label: string | null }>,
    params: unknown[],
  ): string {
    const leftCol = this.resolvePropertyRef(expr.left, variableMap);

    switch (expr.op) {
      case '=':
      case '<>':
      case '>':
      case '<':
      case '>=':
      case '<=':
        params.push(this.toLiteralSqlValue(expr.right as LiteralValue));
        return `${leftCol} ${expr.op} ?`;
      case 'CONTAINS':
        params.push(`%${expr.right as string}%`);
        return `${leftCol} LIKE ?`;
      case 'STARTS WITH':
        params.push(`${expr.right as string}%`);
        return `${leftCol} LIKE ?`;
      case 'ENDS WITH':
        params.push(`%${expr.right as string}`);
        return `${leftCol} LIKE ?`;
      case 'IN': {
        const list = expr.right as LiteralValue[];
        const placeholders = list.map(() => '?').join(', ');
        for (const v of list) {
          params.push(this.toLiteralSqlValue(v));
        }
        return `${leftCol} IN (${placeholders})`;
      }
    }
  }

  /**
   * Compile a NOT EXISTS pattern into a SQL NOT EXISTS subquery.
   */
  private compileNotExists(
    expr: NotExistsExpr,
    variableMap: Map<string, { alias: string; label: string | null }>,
    _params: unknown[],
  ): string {
    const info = variableMap.get(expr.variable);
    if (!info) {
      throw new CypherExecutionError(
        `Unknown variable '${expr.variable}' in NOT EXISTS pattern`,
        '',
      );
    }

    let subquery: string;
    const edgeTypeFilter = expr.edgeType
      ? (() => {
          const resolved = this.resolveEdgeType(expr.edgeType);
          _params.push(resolved);
          return ` AND _e.type = ?`;
        })()
      : '';

    if (expr.direction === 'incoming') {
      // No incoming edges to this node: NOT EXISTS (SELECT 1 FROM edges WHERE targetId = node.id)
      subquery = `NOT EXISTS (SELECT 1 FROM edges _e WHERE _e.targetId = ${info.alias}.id${edgeTypeFilter})`;
    } else {
      // No outgoing edges from this node
      subquery = `NOT EXISTS (SELECT 1 FROM edges _e WHERE _e.sourceId = ${info.alias}.id${edgeTypeFilter})`;
    }

    return subquery;
  }

  /**
   * Resolve a property reference to a SQL column expression.
   */
  private resolvePropertyRef(
    ref: PropertyRef,
    variableMap: Map<string, { alias: string; label: string | null }>,
  ): string {
    const info = variableMap.get(ref.variable);
    if (!info) {
      throw new CypherExecutionError(
        `Unknown variable '${ref.variable}'. Available variables: ${[...variableMap.keys()].join(', ')}`,
        '',
      );
    }

    const column = PROPERTY_TO_COLUMN[ref.property];
    if (!column) {
      throw new CypherExecutionError(
        `Unknown property '${ref.property}'. Available properties: ${Object.keys(PROPERTY_TO_COLUMN).join(', ')}`,
        '',
      );
    }

    return `${info.alias}.${column}`;
  }

  /**
   * Resolve a Cypher node label to the internal node type string.
   */
  private resolveNodeLabel(label: string): string {
    const resolved = LABEL_TO_TYPE[label.toLowerCase()];
    if (!resolved) {
      throw new CypherExecutionError(
        `Unknown node label ':${label}'. Available labels: ${Object.keys(LABEL_TO_TYPE).join(', ')}`,
        '',
      );
    }
    return resolved;
  }

  /**
   * Resolve a Cypher edge type label to the internal edge type string.
   */
  private resolveEdgeType(edgeType: string): string {
    const resolved = EDGE_LABEL_TO_TYPE[edgeType.toLowerCase()];
    if (!resolved) {
      throw new CypherExecutionError(
        `Unknown edge type '[:${edgeType}]'. Available types: ${Object.keys(EDGE_LABEL_TO_TYPE).join(', ')}`,
        '',
      );
    }
    return resolved;
  }

  /**
   * Convert a Cypher literal to a SQL-safe value.
   */
  private toLiteralSqlValue(value: LiteralValue): unknown {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  }
}

// ============================================================
// Error Classes
// ============================================================

/**
 * Syntax error in a Cypher query string.
 */
export class CypherSyntaxError extends Error {
  /** Character position where the error occurred */
  readonly position: number;

  constructor(message: string, position: number) {
    super(`Cypher syntax error at position ${position}: ${message}`);
    this.name = 'CypherSyntaxError';
    this.position = position;
  }
}

/**
 * Runtime error during Cypher query execution.
 */
export class CypherExecutionError extends Error {
  /** The original Cypher query that caused the error */
  readonly query: string;

  constructor(message: string, query: string) {
    super(`Cypher execution error: ${message}`);
    this.name = 'CypherExecutionError';
    this.query = query;
  }
}
