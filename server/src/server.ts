import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let compilerPath = 'symboli';

connection.onInitialize((params: InitializeParams): InitializeResult => {
  compilerPath = params.initializationOptions?.compilerPath ?? 'symboli';
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  };
});

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(change => validateDocument(change.document));
documents.onDidClose(event =>
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
);

function validateDocument(document: TextDocument): void {
  const hash = crypto
    .createHash('md5')
    .update(document.uri)
    .digest('hex')
    .slice(0, 8);
  const tmpFile = path.join(os.tmpdir(), `symbol_${hash}.sym`);

  try {
    fs.writeFileSync(tmpFile, document.getText(), 'utf-8');

    // First pass: use --ast to parse and get AST (catches parse errors)
    const astResult = spawnSync(compilerPath, ['--ast', tmpFile], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const diagnostics: Diagnostic[] = [];

    // If AST parsing failed, report stderr errors
    if (astResult.status !== 0) {
      const stderr = astResult.stderr ?? '';
      diagnostics.push(...parseErrors(stderr, tmpFile, document));
    }

    // If no parse errors, run normally to get runtime errors
    if (diagnostics.length === 0) {
      const runResult = spawnSync(compilerPath, [tmpFile], {
        encoding: 'utf-8',
        timeout: 5000,
      });

      if (runResult.status !== 0) {
        const stderr = runResult.stderr ?? '';
        diagnostics.push(...parseErrors(stderr, tmpFile, document));
      }
    }

    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  } catch {
    // Compiler binary not found — silently clear diagnostics
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch { /* ignore */ }
  }
}

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
  tmpFile: string,
  document: TextDocument
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Regex for "Syntax error at line L, column C: message"
  const syntaxRe = /^Syntax error at line (\d+), column (\d+): (.+)$/;

  // Regex for "<file>:L:C: message" — match any path prefix
  const fileRe = /^.+:(\d+):(\d+): (.+)$/;

  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // Skip informational / call-stack lines
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

  // Highlight from the error column to the end of the token / line
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

documents.listen(connection);
connection.listen();
