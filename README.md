# Symbol Language Support for VS Code

Syntax highlighting and real-time error diagnostics for the Symbol programming language.

## Features

- **Syntax highlighting** — color-coded Symbol code
- **Real-time diagnostics** — errors appear as you type
- **LSP support** — extensible language server protocol

## Setup

1. Make sure `symboli` compiler is accessible:
   ```bash
   # Add to PATH or configure in settings
   export PATH="/path/to/symboli/bin:$PATH"
   ```

2. Configure the compiler path in VS Code settings:
   ```json
   {
     "symbol.compilerPath": "/path/to/symboli"
   }
   ```

## Development

Build the extension:
```bash
npm install
npm run compile
```

Debug by pressing **F5** in VS Code to launch the Extension Development Host.

## How It Works

The LSP server validates `.sym` files by:

1. Running `symboli --ast <file>` to catch parse errors
2. Running `symboli <file>` to catch type and runtime errors
3. Converting error output to VS Code diagnostics

Errors are displayed as red squiggles on the problematic line.
