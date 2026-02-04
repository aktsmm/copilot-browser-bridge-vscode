import * as vscode from "vscode";
import { BridgeServer } from "./server";

let server: BridgeServer | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("Copilot Browser Bridge: Extension activated");

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotBrowserBridge.startServer", () => {
      startServer();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotBrowserBridge.stopServer", () => {
      stopServer();
    }),
  );

  // Auto-start if configured
  const config = vscode.workspace.getConfiguration("copilotBrowserBridge");
  if (config.get("autoStart", true)) {
    startServer();
  }
}

function startServer() {
  if (server) {
    vscode.window.showInformationMessage(
      "Copilot Browser Bridge: Server is already running",
    );
    return;
  }

  const config = vscode.workspace.getConfiguration("copilotBrowserBridge");
  const port = config.get("serverPort", 3210);

  server = new BridgeServer(port);
  server.start();

  vscode.window.showInformationMessage(
    `Copilot Browser Bridge: Server started on port ${port}`,
  );
}

function stopServer() {
  if (!server) {
    vscode.window.showInformationMessage(
      "Copilot Browser Bridge: Server is not running",
    );
    return;
  }

  server.stop();
  server = undefined;

  vscode.window.showInformationMessage(
    "Copilot Browser Bridge: Server stopped",
  );
}

export function deactivate() {
  if (server) {
    server.stop();
    server = undefined;
  }
}
