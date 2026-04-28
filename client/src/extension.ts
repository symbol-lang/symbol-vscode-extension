import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  const serverModule = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'symbol' }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.sym'),
    },
    initializationOptions: {
      compilerPath: workspace
        .getConfiguration('symbol')
        .get<string>('compilerPath', 'symboli'),
    },
  };

  client = new LanguageClient(
    'symbol',
    'Symbol Language Server',
    serverOptions,
    clientOptions
  );

  // Restart server when compilerPath setting changes
  context.subscriptions.push(
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('symbol.compilerPath')) {
        client.stop().then(() => {
          (clientOptions.initializationOptions as Record<string, unknown>).compilerPath =
            workspace
              .getConfiguration('symbol')
              .get<string>('compilerPath', 'symboli');
          client.start();
        });
      }
    })
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
