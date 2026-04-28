"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = require("path");
const vscode_1 = require("vscode");
const node_1 = require("vscode-languageclient/node");
let client;
function activate(context) {
    const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: node_1.TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] },
        },
    };
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'symbol' }],
        synchronize: {
            fileEvents: vscode_1.workspace.createFileSystemWatcher('**/*.sym'),
        },
        initializationOptions: {
            compilerPath: vscode_1.workspace
                .getConfiguration('symbol')
                .get('compilerPath', 'symboli'),
        },
    };
    client = new node_1.LanguageClient('symbol', 'Symbol Language Server', serverOptions, clientOptions);
    // Restart server when compilerPath setting changes
    context.subscriptions.push(vscode_1.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('symbol.compilerPath')) {
            client.stop().then(() => {
                clientOptions.initializationOptions.compilerPath =
                    vscode_1.workspace
                        .getConfiguration('symbol')
                        .get('compilerPath', 'symboli');
                client.start();
            });
        }
    }));
    client.start();
}
function deactivate() {
    return client?.stop();
}
//# sourceMappingURL=extension.js.map