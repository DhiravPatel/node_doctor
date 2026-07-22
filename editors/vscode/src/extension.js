/**
 * The node.doctor VS Code client.
 *
 * Deliberately thin: all analysis lives in the language server (`node-doctor
 * lsp`), so the editor integration cannot drift from the CLI's verdict. The only
 * real work here is *finding* the binary, which is resolved in three tiers so the
 * extension works in a fresh clone with no configuration.
 */

const { existsSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;

/**
 * Resolve the server command: explicit setting → the workspace's local install →
 * npx. The local install is preferred over npx so a project's pinned version is
 * what runs, matching what its CI will run.
 */
function resolveServer(folder) {
  const configured = vscode.workspace.getConfiguration("nodeDoctor").get("serverPath");
  if (configured) return { command: configured, args: ["lsp"] };

  if (folder) {
    const local = join(folder.uri.fsPath, "node_modules", ".bin", "node-doctor");
    if (existsSync(local)) return { command: local, args: ["lsp"] };
  }
  return { command: "npx", args: ["--yes", "node-doctor@latest", "lsp"] };
}

function start(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const { command, args } = resolveServer(folder);

  const serverOptions = {
    run: { command, args, transport: TransportKind.stdio },
    debug: { command, args, transport: TransportKind.stdio },
  };

  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "javascriptreact" },
      { scheme: "file", language: "typescriptreact" },
    ],
    // The server reads the manifest itself; watching it lets capability changes
    // (adding Express, bumping a major) take effect without a restart.
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/{package.json,node-doctor.config.*}"),
    },
    outputChannelName: "node.doctor",
  };

  client = new LanguageClient("nodeDoctor", "node.doctor", serverOptions, clientOptions);
  context.subscriptions.push(client);
  return client.start();
}

function activate(context) {
  if (!vscode.workspace.getConfiguration("nodeDoctor").get("enable")) return;

  context.subscriptions.push(
    vscode.commands.registerCommand("nodeDoctor.restart", async () => {
      if (client) await client.stop();
      await start(context);
      vscode.window.showInformationMessage("node.doctor: language server restarted.");
    }),
    vscode.commands.registerCommand("nodeDoctor.scanProject", () => {
      // The whole-project scan (cross-file + secrets) is a CLI concern — the
      // server only does file-scope analysis, so send the user to a terminal.
      const terminal = vscode.window.createTerminal("node.doctor");
      terminal.show();
      terminal.sendText("npx node-doctor@latest .");
    }),
  );

  return start(context);
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
