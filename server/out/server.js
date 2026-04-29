"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const child_process_1 = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let compilerPath = 'symboli';
// Per-document type declarations: name → type string
const docTypes = new Map();
connection.onInitialize((params) => {
    compilerPath = params.initializationOptions?.compilerPath ?? 'symboli';
    return {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Incremental,
            hoverProvider: true,
        },
    };
});
documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(change => validateDocument(change.document));
documents.onDidClose(event => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    docTypes.delete(event.document.uri);
});
// ── Builtin type signatures ───────────────────────────────────────
const BUILTIN_TYPES = {
    console: '{ write: null (), writeln: null (), read: string (), readln: string () }',
    system: '{ quit: null (int), args: string[] () }',
    array: '{ push: any[] (any[], any), pop: any (any[]), length: int (any[]), get: any (any[], int), set: null (any[], int, any), sort: any[] (any[]), copy: any[] (any[]) }',
    struct: '{ set: any (any, string, any), get: any (any, string), delete: null (any, string), clear: null (any), get_keys: string[] (any), get_values: any[] (any) }',
    json: '{ stringify: string (any), parse: any (string) }',
    cast: '{ to_bool: bool (any), to_string: string (any), to_int: int (any), to_float: float (any) }',
    string: '{ length: int (string), lowercase: string (string), uppercase: string (string), trim: string (string), split: string[] (string, string), is_bool: bool (string), is_int: bool (string), is_float: bool (string) }',
    type: '{ of: string (any) }',
};
// ── AST traversal ─────────────────────────────────────────────────
// Returns the return type portion of a function type string.
// "null (string, bool)" → "null"
// "int (string[])"      → "int"
function extractReturnType(funcType) {
    const idx = funcType.lastIndexOf(' (');
    if (idx === -1)
        return null;
    return funcType.slice(0, idx);
}
// Returns the direct callee name if the call is a simple var_ref call.
function calleeNameOf(node) {
    if (node.kind !== 'call')
        return null;
    const func = node.func;
    if (func?.kind === 'var_ref')
        return func.name;
    return null;
}
// First pass: collect all explicitly typed var_decls and lambda params.
function collectExplicitTypes(node, types) {
    if (!node)
        return;
    if (node.kind === 'var_decl') {
        const vd = node;
        if (vd.vartype)
            types.set(vd.name, vd.vartype);
        collectExplicitTypes(vd.init, types);
        return;
    }
    if (node.kind === 'lambda') {
        const lm = node;
        for (const p of lm.params) {
            if (p.type)
                types.set(p.name, p.type);
        }
        for (const stmt of lm.body)
            collectExplicitTypes(stmt, types);
        return;
    }
    if (node.kind === 'program') {
        for (const stmt of node.body)
            collectExplicitTypes(stmt, types);
        return;
    }
    for (const key of ['body', 'then', 'else', 'init', 'cond', 'update', 'expr', 'func', 'left', 'right', 'operand', 'object', 'value', 'true_branch', 'false_branch']) {
        const child = node[key];
        if (!child)
            continue;
        if (Array.isArray(child)) {
            for (const c of child)
                collectExplicitTypes(c, types);
        }
        else {
            collectExplicitTypes(child, types);
        }
    }
    if (Array.isArray(node['args'])) {
        for (const a of node['args'])
            collectExplicitTypes(a, types);
    }
}
// Second pass: for var_decls with no explicit type whose init is a call,
// resolve the type from the callee's known return type.
function resolveCallTypes(node, types) {
    if (!node)
        return;
    if (node.kind === 'var_decl') {
        const vd = node;
        if (!vd.vartype && vd.init) {
            const callee = calleeNameOf(vd.init);
            if (callee) {
                const funcType = types.get(callee);
                if (funcType) {
                    const ret = extractReturnType(funcType);
                    if (ret)
                        types.set(vd.name, ret);
                }
            }
        }
        resolveCallTypes(vd.init, types);
        return;
    }
    if (node.kind === 'lambda') {
        for (const stmt of node.body)
            resolveCallTypes(stmt, types);
        return;
    }
    if (node.kind === 'program') {
        for (const stmt of node.body)
            resolveCallTypes(stmt, types);
        return;
    }
    for (const key of ['body', 'then', 'else', 'init', 'cond', 'update', 'expr', 'left', 'right', 'operand', 'value', 'true_branch', 'false_branch']) {
        const child = node[key];
        if (!child)
            continue;
        if (Array.isArray(child)) {
            for (const c of child)
                resolveCallTypes(c, types);
        }
        else {
            resolveCallTypes(child, types);
        }
    }
}
// ── Return type inference ─────────────────────────────────────────
// Infer the type of a simple expression node.
function inferExprType(node, types) {
    switch (node.kind) {
        case 'var_ref':
            return types.get(node.name) ?? null;
        case 'literal': {
            const val = node['value'];
            if (val === null)
                return 'null';
            if (typeof val === 'boolean')
                return 'bool';
            if (typeof val === 'number')
                return Number.isInteger(val) ? 'int' : 'float';
            if (typeof val === 'string')
                return 'string';
            return null;
        }
        case 'call': {
            const callee = calleeNameOf(node);
            if (callee) {
                const ft = types.get(callee);
                if (ft)
                    return extractReturnType(ft);
            }
            return null;
        }
        default:
            return null;
    }
}
// Walk a body (array of statements) and collect all possible return types.
function gatherReturnTypes(body, types, result) {
    for (const stmt of body) {
        if (stmt.kind === 'return') {
            const expr = stmt['expr'];
            result.add(expr ? (inferExprType(expr, types) ?? 'null') : 'null');
            continue;
        }
        // Recurse into nested control-flow blocks.
        for (const key of ['then', 'else', 'body', 'true_branch', 'false_branch']) {
            const child = stmt[key];
            if (!child)
                continue;
            if (child.kind === 'return') {
                // Single-line if/else without braces: then/else is directly a return node.
                const expr = child['expr'];
                result.add(expr ? (inferExprType(expr, types) ?? 'null') : 'null');
            }
            else if (child.kind === 'program' && Array.isArray(child['body'])) {
                gatherReturnTypes(child['body'], types, result);
            }
            else if (Array.isArray(child)) {
                gatherReturnTypes(child, types, result);
            }
        }
    }
}
// Infer the return type string for a lambda with no declared ret_type.
function inferLambdaReturnType(lm, types) {
    const retTypes = new Set();
    gatherReturnTypes(lm.body, types, retTypes);
    if (retTypes.size === 0)
        return 'null';
    return [...retTypes].join(' | ');
}
// Third pass: for var_decls whose init is a lambda with no declared ret_type,
// replace the placeholder "null (...)" vartype with the inferred return type.
function inferReturnTypes(node, types) {
    if (!node)
        return;
    if (node.kind === 'var_decl') {
        const vd = node;
        if (vd.init?.kind === 'lambda') {
            const lm = vd.init;
            if (!lm.ret_type) {
                const ret = inferLambdaReturnType(lm, types);
                const params = lm.params.map(p => p.type ?? 'any').join(', ');
                types.set(vd.name, `${ret} (${params})`);
            }
        }
        return;
    }
    if (node.kind === 'program') {
        for (const stmt of node.body)
            inferReturnTypes(stmt, types);
        return;
    }
}
function collectTypes(ast) {
    const types = new Map(Object.entries(BUILTIN_TYPES));
    collectExplicitTypes(ast, types); // pass 1: explicit types + params
    inferReturnTypes(ast, types); // pass 2: infer lambda return types
    resolveCallTypes(ast, types); // pass 3: resolve call result types
    return types;
}
// ── Document validation + AST extraction ──────────────────────────
function validateDocument(document) {
    const hash = crypto
        .createHash('md5')
        .update(document.uri)
        .digest('hex')
        .slice(0, 8);
    const tmpFile = path.join(os.tmpdir(), `symbol_${hash}.sym`);
    try {
        fs.writeFileSync(tmpFile, document.getText(), 'utf-8');
        // First pass: --ast to get types and catch parse errors
        const astResult = (0, child_process_1.spawnSync)(compilerPath, ['--ast', tmpFile], {
            encoding: 'utf-8',
            timeout: 5000,
        });
        const diagnostics = [];
        if (astResult.status === 0 && astResult.stdout) {
            try {
                const ast = JSON.parse(astResult.stdout);
                docTypes.set(document.uri, collectTypes(ast));
            }
            catch {
                // AST parse failed — keep existing types
            }
        }
        else {
            const stderr = astResult.stderr ?? '';
            diagnostics.push(...parseErrors(stderr, document));
        }
        // If no parse errors, run normally to get runtime errors
        if (diagnostics.length === 0) {
            const runResult = (0, child_process_1.spawnSync)(compilerPath, [tmpFile], {
                encoding: 'utf-8',
                timeout: 5000,
            });
            if (runResult.status !== 0) {
                const stderr = runResult.stderr ?? '';
                diagnostics.push(...parseErrors(stderr, document));
            }
        }
        connection.sendDiagnostics({ uri: document.uri, diagnostics });
    }
    catch {
        connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    }
    finally {
        try {
            fs.unlinkSync(tmpFile);
        }
        catch { /* ignore */ }
    }
}
// ── Hover ─────────────────────────────────────────────────────────
connection.onHover((params) => {
    const types = docTypes.get(params.textDocument.uri);
    if (!types)
        return null;
    const document = documents.get(params.textDocument.uri);
    if (!document)
        return null;
    const word = getWordAtPosition(document, params.position);
    if (!word)
        return null;
    const typeStr = types.get(word);
    if (!typeStr)
        return null;
    return {
        contents: {
            kind: node_1.MarkupKind.Markdown,
            value: `\`\`\`symbol\n${word}: ${typeStr}\n\`\`\``,
        },
    };
});
function getWordAtPosition(document, position) {
    const lineText = document.getText({
        start: { line: position.line, character: 0 },
        end: { line: position.line, character: Number.MAX_SAFE_INTEGER },
    });
    const col = position.character;
    let start = col;
    let end = col;
    while (start > 0 && isIdentChar(lineText[start - 1]))
        start--;
    while (end < lineText.length && isIdentChar(lineText[end]))
        end++;
    if (start === end)
        return null;
    return lineText.slice(start, end);
}
function isIdentChar(ch) {
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
function parseErrors(stderr, document) {
    const diagnostics = [];
    const syntaxRe = /^Syntax error at line (\d+), column (\d+): (.+)$/;
    const fileRe = /^.+:(\d+):(\d+): (.+)$/;
    for (const raw of stderr.split('\n')) {
        const line = raw.trim();
        if (!line)
            continue;
        if (line.startsWith('Call stack') ||
            line.startsWith('at ') ||
            line.startsWith('Failed to parse') ||
            line.startsWith('Cannot read')) {
            continue;
        }
        let m = line.match(syntaxRe);
        if (m) {
            diagnostics.push(buildDiag(parseInt(m[1]) - 1, parseInt(m[2]) - 1, m[3], document));
            continue;
        }
        m = line.match(fileRe);
        if (m) {
            diagnostics.push(buildDiag(parseInt(m[1]) - 1, parseInt(m[2]) - 1, m[3], document));
        }
    }
    return diagnostics;
}
function buildDiag(lineIdx, colIdx, message, document) {
    const line = Math.max(0, lineIdx);
    const col = Math.max(0, colIdx);
    const lineText = document.getText({
        start: { line, character: 0 },
        end: { line, character: Number.MAX_SAFE_INTEGER },
    });
    const endChar = lineText.trimEnd().length || col + 1;
    return {
        severity: node_1.DiagnosticSeverity.Error,
        range: {
            start: { line, character: col },
            end: { line, character: endChar },
        },
        message,
        source: 'symbol',
    };
}
documents.listen(connection);
connection.listen();
//# sourceMappingURL=server.js.map