import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  Hover,
  MarkupKind,
  TextDocumentPositionParams,
  DocumentFormattingParams,
  TextEdit,
  FormattingOptions,
  Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let compilerPath = 'symboli';

// Per-document type declarations: name → type string
const docTypes = new Map<string, Map<string, string>>();
// Per-document definition locations: name → Location
const docDefinitions = new Map<string, Map<string, Location>>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  compilerPath = params.initializationOptions?.compilerPath ?? 'symboli';
  loadBuiltinTypes(compilerPath);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      documentFormattingProvider: true,
    },
  };
});

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(change => validateDocument(change.document));
documents.onDidClose(event => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  docTypes.delete(event.document.uri);
  docDefinitions.delete(event.document.uri);
});

// ── AST node types ────────────────────────────────────────────────

interface ASTNode {
  kind: string;
  line: number;
  col: number;
  [key: string]: unknown;
}

interface VarDeclNode extends ASTNode {
  kind: 'var_decl';
  name: string;
  vartype?: string;
  init?: ASTNode;
}

interface LambdaNode extends ASTNode {
  kind: 'lambda';
  ret_type?: string;
  is_variadic?: number;
  params: Array<{ name: string; type?: string }>;
  body: ASTNode[];
}

interface ProgramNode extends ASTNode {
  kind: 'program';
  body: ASTNode[];
}

interface CallNode extends ASTNode {
  kind: 'call';
  func: ASTNode;
  args: ASTNode[];
}

interface VarRefNode extends ASTNode {
  kind: 'var_ref';
  name: string;
}

interface MemberAccessNode extends ASTNode {
  kind: 'member_access';
  object: ASTNode;
  member: string;
}

// ── Builtin type signatures ───────────────────────────────────────

const DEFAULT_BUILTIN_TYPES: Record<string, string> = {
  console: '{ write: null (...any[]), writeln: null (...any[]), read: string (), readln: string () }',
  system:  '{ quit: null (int), args: string[] () }',
  array:   '{ push: any[] (any[], any), pop: any (any[]), length: int (any[]), get: any (any[], int), set: null (any[], int, any), sort: any[] (any[]), copy: any[] (any[]) }',
  struct:  '{ set: any (any, string, any), get: any (any, string), delete: null (any, string), clear: null (any), get_keys: string[] (any), get_values: any[] (any) }',
  json:    '{ stringify: string (any), parse: any (string) }',
  cast:    '{ to_bool: bool (any), to_string: string (any), to_int: int (any), to_float: float (any) }',
  string:  '{ length: int (string), lowercase: string (string), uppercase: string (string), trim: string (string), split: string[] (string, string), is_bool: bool (string), is_int: bool (string), is_float: bool (string) }',
  type:    '{ of: string (any) }',
  file:    '{ exist: bool (string), create: null (string), delete: null (string), open: int | null (string), close: null (int), move: null (string, string), copy: null (string, string), read: any (string), write: null (int, string), append: null (int, string), read_bytes: int[] (int), write_bytes: null (int, int[]), eof: bool (int), size: int (string), mkdir: null (string) }',
};

let builtinTypes: Record<string, string> = { ...DEFAULT_BUILTIN_TYPES };

function loadBuiltinTypes(compiler: string): void {
  try {
    const result = spawnSync(compiler, ['--dump-builtins'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const parsed = JSON.parse(result.stdout) as Record<string, string>;
      if (parsed && typeof parsed === 'object') {
        builtinTypes = parsed;
        return;
      }
    }
  } catch { /* fall through to defaults */ }
  builtinTypes = { ...DEFAULT_BUILTIN_TYPES };
}

// ── AST traversal ─────────────────────────────────────────────────

// Returns the return type portion of a function type string.
// "null (string, bool)" → "null"
// "int (string[])"      → "int"
function extractReturnType(funcType: string): string | null {
  const idx = funcType.lastIndexOf(' (');
  if (idx === -1) return null;
  return funcType.slice(0, idx);
}

// Looks up method return type inside a struct type string.
// structType = "{ open: any (string), close: null (int), ... }"
// extractMemberReturnType(structType, "open") → "any"
function extractMemberReturnType(structType: string, member: string): string | null {
  const re = new RegExp(`\\b${member}:\\s*(.*?)(?=,\\s*\\w+:|\\s*\\})`);
  const m = structType.match(re);
  if (!m) return null;
  return extractReturnType(m[1].trim());
}

// Extracts the full type string (signature) of a member from a struct type string.
// extractMemberType("{ write: null (...any[]), readln: string () }", "write") → "null (...any[])"
function extractMemberType(structType: string, member: string): string | null {
  const re = new RegExp(`\\b${member}:\\s*(.*?)(?=,\\s*\\w+:|\\s*\\})`);
  const m = structType.match(re);
  if (!m) return null;
  return m[1].trim();
}

// Returns the direct callee name if the call is a simple var_ref call.
function calleeNameOf(node: ASTNode): string | null {
  if (node.kind !== 'call') return null;
  const func = (node as CallNode).func;
  if (func?.kind === 'var_ref') return (func as VarRefNode).name;
  return null;
}

// First pass: collect all explicitly typed var_decls and lambda params.
function collectExplicitTypes(node: ASTNode | null | undefined, types: Map<string, string>): void {
  if (!node) return;

  if (node.kind === 'var_decl') {
    const vd = node as VarDeclNode;
    if (vd.vartype) types.set(vd.name, vd.vartype);
    collectExplicitTypes(vd.init, types);
    return;
  }

  if (node.kind === 'lambda') {
    const lm = node as LambdaNode;
    for (const p of lm.params) {
      const name = p.name.startsWith('...') ? p.name.slice(3) : p.name;
      if (p.type) types.set(name, p.type);
    }
    for (const stmt of lm.body) collectExplicitTypes(stmt, types);
    return;
  }

  if (node.kind === 'program') {
    for (const stmt of (node as ProgramNode).body) collectExplicitTypes(stmt, types);
    return;
  }

  for (const key of ['body', 'then', 'else', 'init', 'cond', 'update', 'expr', 'func', 'left', 'right', 'operand', 'object', 'value', 'true_branch', 'false_branch']) {
    const child = node[key];
    if (!child) continue;
    if (Array.isArray(child)) {
      for (const c of child) collectExplicitTypes(c as ASTNode, types);
    } else {
      collectExplicitTypes(child as ASTNode, types);
    }
  }
  if (Array.isArray(node['args'])) {
    for (const a of node['args'] as ASTNode[]) collectExplicitTypes(a, types);
  }
}

// Second pass: for var_decls with no explicit type whose init is a call,
// resolve the type from the callee's known return type.
function resolveCallTypes(node: ASTNode | null | undefined, types: Map<string, string>): void {
  if (!node) return;

  if (node.kind === 'var_decl') {
    const vd = node as VarDeclNode;
    if (!vd.vartype && vd.init) {
      if (vd.init.kind === 'var_ref') {
        const refType = types.get((vd.init as VarRefNode).name);
        if (refType) types.set(vd.name, refType);
      } else {
        const callee = calleeNameOf(vd.init);
        if (callee) {
          const funcType = types.get(callee);
          if (funcType) {
            const ret = extractReturnType(funcType);
            if (ret) types.set(vd.name, ret);
          }
        } else if (vd.init.kind === 'call') {
          const callNode = vd.init as CallNode;
          if (callNode.func?.kind === 'member_access') {
            const ma = callNode.func as MemberAccessNode;
            if (ma.object?.kind === 'var_ref') {
              const objType = types.get((ma.object as VarRefNode).name);
              if (objType) {
                const ret = extractMemberReturnType(objType, ma.member);
                if (ret) types.set(vd.name, ret);
              }
            }
          }
        }
      }
    }
    resolveCallTypes(vd.init, types);
    return;
  }

  if (node.kind === 'lambda') {
    for (const stmt of (node as LambdaNode).body) resolveCallTypes(stmt, types);
    return;
  }

  if (node.kind === 'program') {
    for (const stmt of (node as ProgramNode).body) resolveCallTypes(stmt, types);
    return;
  }

  for (const key of ['body', 'then', 'else', 'init', 'cond', 'update', 'expr', 'left', 'right', 'operand', 'value', 'true_branch', 'false_branch']) {
    const child = node[key];
    if (!child) continue;
    if (Array.isArray(child)) {
      for (const c of child) resolveCallTypes(c as ASTNode, types);
    } else {
      resolveCallTypes(child as ASTNode, types);
    }
  }
}

// ── Return type inference ─────────────────────────────────────────

// Infer the type of a simple expression node.
function inferExprType(node: ASTNode, types: Map<string, string>): string | null {
  switch (node.kind) {
    case 'var_ref':
      return types.get((node as VarRefNode).name) ?? null;
    case 'literal': {
      const val = node['value'];
      if (val === null) return 'null';
      if (typeof val === 'boolean') return 'bool';
      if (typeof val === 'number') return Number.isInteger(val as number) ? 'int' : 'float';
      if (typeof val === 'string') return 'string';
      return null;
    }
    case 'call': {
      const callee = calleeNameOf(node);
      if (callee) {
        const ft = types.get(callee);
        if (ft) return extractReturnType(ft);
      }
      const callNode = node as CallNode;
      if (callNode.func?.kind === 'member_access') {
        const ma = callNode.func as MemberAccessNode;
        if (ma.object?.kind === 'var_ref') {
          const objType = types.get((ma.object as VarRefNode).name);
          if (objType) return extractMemberReturnType(objType, ma.member);
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// Walk a body (array of statements) and collect all possible return types.
function gatherReturnTypes(body: ASTNode[], types: Map<string, string>, result: Set<string>): void {
  for (const stmt of body) {
    if (stmt.kind === 'return') {
      const expr = stmt['expr'] as ASTNode | undefined;
      result.add(expr ? (inferExprType(expr, types) ?? 'null') : 'null');
      continue;
    }
    // Recurse into nested control-flow blocks.
    for (const key of ['then', 'else', 'body', 'true_branch', 'false_branch']) {
      const child = stmt[key] as ASTNode | undefined;
      if (!child) continue;
      if (child.kind === 'return') {
        // Single-line if/else without braces: then/else is directly a return node.
        const expr = child['expr'] as ASTNode | undefined;
        result.add(expr ? (inferExprType(expr, types) ?? 'null') : 'null');
      } else if (child.kind === 'program' && Array.isArray(child['body'])) {
        gatherReturnTypes(child['body'] as ASTNode[], types, result);
      } else if (Array.isArray(child)) {
        gatherReturnTypes(child as unknown as ASTNode[], types, result);
      }
    }
  }
}

// Infer the return type string for a lambda with no declared ret_type.
function inferLambdaReturnType(lm: LambdaNode, types: Map<string, string>): string {
  const retTypes = new Set<string>();
  gatherReturnTypes(lm.body, types, retTypes);
  if (retTypes.size === 0) return 'null';
  return [...retTypes].join(' | ');
}

// Third pass: for var_decls whose init is a lambda with no declared ret_type,
// replace the placeholder "null (...)" vartype with the inferred return type.
function inferReturnTypes(node: ASTNode | null | undefined, types: Map<string, string>): void {
  if (!node) return;

  if (node.kind === 'var_decl') {
    const vd = node as VarDeclNode;
    if (vd.init?.kind === 'lambda') {
      const lm = vd.init as LambdaNode;
      if (!lm.ret_type) {
        const ret = inferLambdaReturnType(lm, types);
        const params = lm.params.map((p, i) => {
          const isLast = i === lm.params.length - 1;
          const prefix = lm.is_variadic && isLast ? '...' : '';
          return prefix + (p.type ?? 'any');
        }).join(', ');
        types.set(vd.name, `${ret} (${params})`);
      }
    }
    return;
  }

  if (node.kind === 'program') {
    for (const stmt of (node as ProgramNode).body) inferReturnTypes(stmt, types);
    return;
  }
}

function collectDefinitions(node: ASTNode | null | undefined, uri: string, defs: Map<string, Location>): void {
  if (!node) return;

  if (node.kind === 'var_decl') {
    const vd = node as VarDeclNode;
    defs.set(vd.name, {
      uri,
      range: {
        start: { line: vd.line - 1, character: vd.col - 1 },
        end: { line: vd.line - 1, character: vd.col - 1 + vd.name.length },
      },
    });
    collectDefinitions(vd.init, uri, defs);
    return;
  }

  if (node.kind === 'program') {
    for (const stmt of (node as ProgramNode).body) collectDefinitions(stmt, uri, defs);
    return;
  }

  if (node.kind === 'lambda') {
    for (const stmt of (node as LambdaNode).body) collectDefinitions(stmt, uri, defs);
    return;
  }

  for (const key of ['body', 'then', 'else', 'init', 'true_branch', 'false_branch']) {
    const child = node[key];
    if (!child) continue;
    if (Array.isArray(child)) {
      for (const c of child) collectDefinitions(c as ASTNode, uri, defs);
    } else {
      collectDefinitions(child as ASTNode, uri, defs);
    }
  }
}

function collectTypes(ast: ASTNode, importedBuiltins?: Set<string>): Map<string, string> {
  const builtins = importedBuiltins
    ? Object.fromEntries(Object.entries(builtinTypes).filter(([k]) => importedBuiltins.has(k)))
    : builtinTypes;
  const types = new Map<string, string>(Object.entries(builtins));
  collectExplicitTypes(ast, types);  // pass 1: explicit types + params
  inferReturnTypes(ast, types);      // pass 2: infer lambda return types
  resolveCallTypes(ast, types);      // pass 3: resolve call result types
  return types;
}

// Strip // and /* */ comments (nested block comments supported).
// Replaces comment characters with spaces so line/col positions are preserved.
// String literals are passed through unchanged to avoid false matches inside them.
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    // Line comment
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < len && source[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    // Block comment with nesting
    if (source[i] === '/' && source[i + 1] === '*') {
      out.push(' ', ' '); i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          out.push(' ', ' '); i += 2; depth++;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          out.push(' ', ' '); i += 2; depth--;
        } else {
          out.push(source[i] === '\n' ? '\n' : ' '); i++;
        }
      }
      continue;
    }
    // String literal — pass through as-is
    if (source[i] === '"' || source[i] === "'") {
      const q = source[i];
      out.push(source[i++]);
      while (i < len && source[i] !== q) {
        if (source[i] === '\\') out.push(source[i++]);
        out.push(source[i++]);
      }
      if (i < len) out.push(source[i++]);
      continue;
    }
    out.push(source[i++]);
  }
  return out.join('');
}

interface FileImport {
  names: string[];
  resolvedPath: string;
}

// Parse `import { a, b } from "./path.sym"` statements and resolve file paths.
function parseFileImports(stripped: string, docPath: string): FileImport[] {
  const imports: FileImport[] = [];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    const fromPath = m[2];
    if (fromPath === 'symbol') continue;
    const names = m[1].split(',').map(n => n.trim()).filter(Boolean);
    const dir = path.dirname(docPath);
    let resolved = path.resolve(dir, fromPath);
    if (!resolved.endsWith('.sym') && !fs.existsSync(resolved)) {
      resolved += '.sym';
    }
    if (fs.existsSync(resolved)) {
      imports.push({ names, resolvedPath: resolved });
    }
  }
  return imports;
}

// Run --ast on a .sym file and return its collected types and definition locations.
function loadFromFile(filePath: string): { types: Map<string, string>; defs: Map<string, Location> } {
  const result = spawnSync(compilerPath, ['--ast', filePath], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) return { types: new Map(), defs: new Map() };
  try {
    const ast = JSON.parse(result.stdout) as ASTNode;
    const fileUri = pathToFileURL(filePath).href;
    const defs = new Map<string, Location>();
    collectDefinitions(ast, fileUri, defs);
    return { types: collectTypes(ast), defs };
  } catch {
    return { types: new Map(), defs: new Map() };
  }
}

// Parse `import { a, b } from "symbol"` statements and return imported names.
function parseSymbolImports(stripped: string): Set<string> {
  const imported = new Set<string>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    for (const name of m[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed) imported.add(trimmed);
    }
  }
  return imported;
}

// Replace string literal content with spaces, but preserve ${...} interpolation bodies
// so that builtin usage inside interpolations is still checked.
function maskStringLiterals(line: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      out.push(' '); i++;
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\') {
          out.push(' ', ' '); i += 2;
        } else if (q === '"' && line[i] === '$' && line[i + 1] === '{') {
          out.push(' ', ' '); i += 2;
          let depth = 1;
          while (i < line.length && depth > 0) {
            if (line[i] === '{') depth++;
            else if (line[i] === '}') { depth--; if (depth === 0) break; }
            out.push(line[i]); i++;
          }
          if (i < line.length) { out.push(' '); i++; }
        } else {
          out.push(' '); i++;
        }
      }
      if (i < line.length) { out.push(' '); i++; }
    } else {
      out.push(ch); i++;
    }
  }
  return out.join('');
}

// Report uses of symbol builtins that weren't imported.
function checkUnimportedBuiltins(
  stripped: string,
  imported: Set<string>,
  document: TextDocument
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stripped.split('\n');

  for (const name of Object.keys(builtinTypes)) {
    if (imported.has(name)) continue;

    const usageRe = new RegExp(`\\b${name}\\b`, 'g');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineText = lines[lineIdx];
      const lineNoStrings = maskStringLiterals(lineText);
      let match: RegExpExecArray | null;
      usageRe.lastIndex = 0;
      while ((match = usageRe.exec(lineNoStrings)) !== null) {
        const col = match.index;
        const charAfter = lineNoStrings[col + name.length];
        if (charAfter !== '.' && charAfter !== '(') continue;
        diagnostics.push(
          buildDiag(lineIdx, col, `'${name}' is not imported from "symbol"`, document)
        );
      }
    }
  }

  return diagnostics;
}

// ── Circular import detection ─────────────────────────────────────

function hasTransitiveImport(fromFile: string, targetCanonical: string, visited: Set<string>): boolean {
  let canonical: string;
  try { canonical = fs.realpathSync(fromFile); } catch { return false; }

  if (canonical === targetCanonical) return true;
  if (visited.has(canonical)) return false;
  visited.add(canonical);

  let content: string;
  try { content = fs.readFileSync(fromFile, 'utf-8'); } catch { return false; }

  const stripped = stripComments(content);
  const importRe = /import\s*\{[^}]+\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    const dep = m[1];
    if (dep === 'symbol') continue;
    const resolved = path.resolve(path.dirname(fromFile), dep);
    if (hasTransitiveImport(resolved, targetCanonical, visited)) return true;
  }
  return false;
}

function detectCircularImports(docPath: string, stripped: string, document: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  let docCanonical: string;
  try { docCanonical = fs.realpathSync(docPath); } catch { return []; }

  const importRe = /import\s*\{[^}]+\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;

  while ((m = importRe.exec(stripped)) !== null) {
    const fromPath = m[1];
    if (fromPath === 'symbol') continue;

    const dir = path.dirname(docPath);
    let resolved = path.resolve(dir, fromPath);
    if (!resolved.endsWith('.sym') && !fs.existsSync(resolved)) resolved += '.sym';
    if (!fs.existsSync(resolved)) continue;

    if (hasTransitiveImport(resolved, docCanonical, new Set([docCanonical]))) {
      const lineIdx = stripped.slice(0, m.index).split('\n').length - 1;
      diagnostics.push(buildDiag(lineIdx, 0, `Circular import: '${fromPath}'`, document));
    }
  }

  return diagnostics;
}

// ── Missing return check ──────────────────────────────────────────

// Recursively check whether a body contains any return statement.
function hasReturn(body: ASTNode[]): boolean {
  for (const stmt of body) {
    if (stmt.kind === 'return') return true;
    for (const key of ['then_branch', 'else_branch', 'body', 'true_branch', 'false_branch']) {
      const child = stmt[key] as ASTNode | undefined;
      if (!child) continue;
      if (child.kind === 'return') return true;
      if (child.kind === 'program' && Array.isArray(child['body'])) {
        if (hasReturn(child['body'] as ASTNode[])) return true;
      } else if (Array.isArray(child)) {
        if (hasReturn(child as unknown as ASTNode[])) return true;
      }
    }
  }
  return false;
}

// Walk the AST and report var_decls whose lambda body has no return
// despite a non-null return type in the annotation.
function checkMissingReturns(node: ASTNode, document: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  function walk(n: ASTNode | null | undefined): void {
    if (!n) return;
    if (n.kind === 'var_decl') {
      const vd = n as VarDeclNode;
      if (vd.init?.kind === 'lambda' && vd.vartype) {
        const lm = vd.init as LambdaNode;
        // ret_type from the explicit annotation on the lambda itself,
        // OR extracted from the vartype annotation (e.g. "int | float (int, int)")
        const retType = lm.ret_type ?? extractReturnType(vd.vartype);
        if (retType && retType !== 'null' && !hasReturn(lm.body)) {
          diagnostics.push(buildDiag(
            lm.line - 1,
            lm.col - 1,
            `missing return statement in function with return type '${retType}'`,
            document
          ));
        }
      }
      walk(vd.init);
      return;
    }
    if (n.kind === 'program') {
      for (const stmt of (n as ProgramNode).body) walk(stmt);
      return;
    }
    if (n.kind === 'lambda') {
      for (const stmt of (n as LambdaNode).body) walk(stmt);
      return;
    }
    for (const key of ['body', 'then_branch', 'else_branch', 'init', 'cond', 'update', 'expr', 'left', 'right', 'operand', 'value', 'true_branch', 'false_branch']) {
      const child = n[key];
      if (!child) continue;
      if (Array.isArray(child)) {
        for (const c of child) walk(c as ASTNode);
      } else {
        walk(child as ASTNode);
      }
    }
  }

  walk(node);
  return diagnostics;
}

// ── Document validation + AST extraction ──────────────────────────

function validateDocument(document: TextDocument): void {
  const hash = crypto
    .createHash('md5')
    .update(document.uri)
    .digest('hex')
    .slice(0, 8);
  const tmpFile = path.join(os.tmpdir(), `symbol_${hash}.sym`);

  try {
    fs.writeFileSync(tmpFile, document.getText(), 'utf-8');

    // First pass: --ast to get types and catch parse errors
    const astResult = spawnSync(compilerPath, ['--ast', tmpFile], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const diagnostics: Diagnostic[] = [];

    if (astResult.status === 0 && astResult.stdout) {
      try {
        const ast = JSON.parse(astResult.stdout) as ASTNode;
        const stripped = stripComments(document.getText());
        const importedBuiltins = parseSymbolImports(stripped);
        docTypes.set(document.uri, collectTypes(ast, importedBuiltins));

        const types = docTypes.get(document.uri)!;
        const defs = new Map<string, Location>();
        collectDefinitions(ast, document.uri, defs);

        const docPath = fileURLToPath(document.uri);
        for (const fi of parseFileImports(stripped, docPath)) {
          const { types: importedTypes, defs: importedDefs } = loadFromFile(fi.resolvedPath);
          for (const name of fi.names) {
            const t = importedTypes.get(name);
            if (t) types.set(name, t);
            const loc = importedDefs.get(name);
            if (loc) defs.set(name, loc);
          }
        }

        docDefinitions.set(document.uri, defs);

        diagnostics.push(...checkUnimportedBuiltins(stripped, importedBuiltins, document));
        diagnostics.push(...checkMissingReturns(ast, document));
        diagnostics.push(...detectCircularImports(docPath, stripped, document));
      } catch {
        // AST parse failed — keep existing types
      }
    } else {
      const stderr = astResult.stderr ?? '';
      diagnostics.push(...parseErrors(stderr, document));
    }

    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  } catch {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch { /* ignore */ }
  }
}

// ── Hover ─────────────────────────────────────────────────────────

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const types = docTypes.get(params.textDocument.uri);
  if (!types) return null;

  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const word = getWordAtPosition(document, params.position);
  if (!word) return null;

  const typeStr = types.get(word);
  if (typeStr) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`symbol\n${word}: ${typeStr}\n\`\`\``,
      },
    };
  }

  // Hover over a builtin member: e.g. `write` in `console.write(...)`
  const memberInfo = getMemberAccessAtPosition(document, params.position);
  if (memberInfo) {
    const objType = types.get(memberInfo.object);
    if (objType) {
      const memberType = extractMemberType(objType, memberInfo.member);
      if (memberType) {
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: `\`\`\`symbol\n${memberInfo.object}.${memberInfo.member}: ${memberType}\n\`\`\``,
          },
        };
      }
    }
  }

  return null;
});

// ── Go to Definition ──────────────────────────────────────────────

connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
  const defs = docDefinitions.get(params.textDocument.uri);
  if (!defs) return null;

  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const word = getWordAtPosition(document, params.position);
  if (!word) return null;

  return defs.get(word) ?? null;
});

function getWordAtPosition(document: TextDocument, position: { line: number; character: number }): string | null {
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_SAFE_INTEGER },
  });

  const col = position.character;
  let start = col;
  let end = col;

  while (start > 0 && isIdentChar(lineText[start - 1])) start--;
  while (end < lineText.length && isIdentChar(lineText[end])) end++;

  if (start === end) return null;
  return lineText.slice(start, end);
}

// If the cursor is on a member in `object.member`, returns { object, member }.
function getMemberAccessAtPosition(
  document: TextDocument,
  position: { line: number; character: number }
): { object: string; member: string } | null {
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_SAFE_INTEGER },
  });

  const col = position.character;
  let start = col;
  let end = col;

  while (start > 0 && isIdentChar(lineText[start - 1])) start--;
  while (end < lineText.length && isIdentChar(lineText[end])) end++;

  if (start === end || start === 0 || lineText[start - 1] !== '.') return null;

  const member = lineText.slice(start, end);
  const dotPos = start - 1;
  let objEnd = dotPos;
  let objStart = objEnd;
  while (objStart > 0 && isIdentChar(lineText[objStart - 1])) objStart--;

  if (objStart === objEnd) return null;
  const object = lineText.slice(objStart, objEnd);
  return { object, member };
}

function isIdentChar(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch);
}

// ── Error parsing ─────────────────────────────────────────────────

// symboli emits errors in two formats:
//
//   Syntax error at line L, column C: <message>
//   Failed to parse source <file>
//
//   <file>:L:C: <message>           ← Type error / Runtime error
//   Call stack (most recent call first):
//     at <name> (<file>:L:C)
//
// Both use 1-indexed lines and columns.
function parseErrors(
  stderr: string,
  document: TextDocument
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const syntaxRe = /^Syntax error at line (\d+), column (\d+): (.+)$/;
  const fileRe = /^.+:(\d+):(\d+): (.+)$/;

  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (
      line.startsWith('Call stack') ||
      line.startsWith('at ') ||
      line.startsWith('Failed to parse') ||
      line.startsWith('Cannot read')
    ) {
      continue;
    }

    let m = line.match(syntaxRe);
    if (m) {
      diagnostics.push(
        buildDiag(parseInt(m[1]) - 1, parseInt(m[2]) - 1, m[3], document)
      );
      continue;
    }

    m = line.match(fileRe);
    if (m) {
      diagnostics.push(
        buildDiag(parseInt(m[1]) - 1, parseInt(m[2]) - 1, m[3], document)
      );
    }
  }

  return diagnostics;
}

function buildDiag(
  lineIdx: number,
  colIdx: number,
  message: string,
  document: TextDocument
): Diagnostic {
  const line = Math.max(0, lineIdx);
  const col = Math.max(0, colIdx);

  const lineText = document.getText({
    start: { line, character: 0 },
    end: { line, character: Number.MAX_SAFE_INTEGER },
  });
  const endChar = lineText.trimEnd().length || col + 1;

  return {
    severity: DiagnosticSeverity.Error,
    range: {
      start: { line, character: col },
      end: { line, character: endChar },
    },
    message,
    source: 'symbol',
  };
}

// ── Document formatting ───────────────────────────────────────────

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const text = document.getText();
  const formatted = formatSymbol(text, params.options);
  if (formatted === text) return [];
  return [{
    range: {
      start: { line: 0, character: 0 },
      end: document.positionAt(text.length),
    },
    newText: formatted,
  }];
});

function formatSymbol(source: string, options: FormattingOptions): string {
  const indentUnit = options.insertSpaces !== false
    ? ' '.repeat(options.tabSize ?? 4)
    : '\t';

  const lines = source.split('\n');
  const output: string[] = [];
  let depth = 0;
  let pendingIndent = 0;
  let prevBlank = false;
  let inBlockComment = false;
  let inMultilineString = false;
  let mlStrChar = '';

  for (const rawLine of lines) {
    if (inMultilineString) {
      output.push(rawLine);
      const st = fmtScanStringState(rawLine, true, mlStrChar);
      if (!st.inStr) { inMultilineString = false; mlStrChar = ''; }
      continue;
    }

    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (!prevBlank && output.length > 0) output.push('');
      prevBlank = true;
      continue;
    }
    prevBlank = false;

    if (inBlockComment) {
      const lead = trimmed.startsWith('*') ? ' ' : '';
      output.push(indentUnit.repeat(depth) + lead + trimmed);
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }

    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlockComment = true;
    }

    const leadingCloses = fmtCountLeadingClosingBraces(trimmed);
    depth = Math.max(0, depth - leadingCloses);

    // A `}` cancels the pending indent from a braceless control flow
    const effectiveDepth = leadingCloses > 0 ? depth : depth + pendingIndent;
    pendingIndent = 0;

    output.push(indentUnit.repeat(effectiveDepth) + fmtLine(trimmed));

    const { opens, closes } = fmtCountBraces(trimmed);
    depth = Math.max(0, depth + opens - (closes - leadingCloses));

    const strState = fmtScanStringState(trimmed, false, '');
    if (strState.inStr) {
      inMultilineString = true;
      mlStrChar = strState.strChar;
    } else if (fmtIsBracelessControlFlow(trimmed)) {
      pendingIndent = 1;
    }
  }

  while (output.length > 0 && output[output.length - 1] === '') output.pop();

  return output.join('\n') + (source.endsWith('\n') ? '\n' : '');
}

function fmtScanStringState(line: string, startInStr: boolean, startChar: string): { inStr: boolean; strChar: string } {
  let inStr = startInStr;
  let strChar = startChar;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
    } else {
      if (ch === '"' || ch === "'") { inStr = true; strChar = ch; }
      else if (ch === '/' && line[i + 1] === '/') break;
    }
  }
  return { inStr, strChar };
}

function fmtIsBracelessControlFlow(line: string): boolean {
  if (line.endsWith('{') || line.endsWith('}')) return false;
  if (/^else\s*$/.test(line)) return true;
  if (/^(case\s|default\s*:)/.test(line) && line.endsWith(':')) return true;
  if (!/^(if|else\s+if|for|while)\s*\(/.test(line)) return false;

  // Find matching closing paren of the condition
  let depth = 0;
  let inStr = false, strChar = '';
  for (let i = line.indexOf('('); i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === strChar) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true; strChar = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (--depth === 0) {
        // If there's a body after the condition paren, it's already on this line
        return line.slice(i + 1).trim().length === 0;
      }
    }
  }
  return false;
}

function fmtCountLeadingClosingBraces(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === '}') count++;
    else break;
  }
  return count;
}

function fmtCountBraces(line: string): { opens: number; closes: number } {
  let opens = 0, closes = 0;
  let inStr = false, strChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strChar = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '{') opens++;
    else if (ch === '}') closes++;
  }
  return { opens, closes };
}

function fmtLine(line: string): string {
  if (
    line.startsWith('//') ||
    line.startsWith('*') ||
    line.startsWith('/*') ||
    line === '*/'
  ) return line;

  // Separate trailing inline comment
  let comment = '';
  const ci = fmtFindCommentStart(line);
  if (ci !== -1) {
    comment = '  ' + line.slice(ci);
    line = line.slice(0, ci).trimEnd();
  }

  const { masked, literals } = fmtMaskStrings(line);
  let s = masked;

  // Normalize import/export brace spacing: {a,b} → { a, b }
  if (/^(import|export)\b/.test(s)) {
    s = s.replace(/\{([^}]*)\}/g, (_, inner) => {
      const items = inner.split(',').map((x: string) => x.trim()).filter(Boolean);
      return '{ ' + items.join(', ') + ' }';
    });
  }

  // Normalize comma spacing: remove extra spaces around comma, then ensure one space after
  s = s.replace(/\s*,\s*/g, ', ');
  // Remove spurious trailing space before closing bracket/paren
  s = s.replace(/,\s*([)\]])/g, ', $1');

  line = fmtRestoreStrings(s, literals);
  return line + comment;
}

function fmtFindCommentStart(line: string): number {
  let inStr = false, strChar = '';
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strChar = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

function fmtMaskStrings(line: string): { masked: string; literals: string[] } {
  const literals: string[] = [];
  let result = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      let str = q;
      i++;
      while (i < line.length && line[i] !== q) {
        if (line[i] === '\\') str += line[i++];
        str += line[i++];
      }
      if (i < line.length) str += line[i++];
      result += `\x00${literals.length}\x00`;
      literals.push(str);
    } else {
      result += ch;
      i++;
    }
  }
  return { masked: result, literals };
}

function fmtRestoreStrings(s: string, literals: string[]): string {
  return s.replace(/\x00(\d+)\x00/g, (_, i) => literals[+i]);
}

documents.listen(connection);
connection.listen();
