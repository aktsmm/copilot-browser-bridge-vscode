import * as vscode from "vscode";
import { BridgeServer } from "./server";

let server: BridgeServer | undefined;
let extensionVersion = "unknown";

export function activate(context: vscode.ExtensionContext) {
  console.log("Copilot Browser Bridge: Extension activated");
  const packageVersion = context.extension.packageJSON?.version;
  extensionVersion =
    typeof packageVersion === "string" && packageVersion.trim().length > 0
      ? packageVersion
      : "unknown";

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotBrowserBridge.startServer",
      async () => {
        await startServer();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotBrowserBridge.stopServer",
      async () => {
        stopServer();
      },
    ),
  );

  // Auto-start if configured
  const config = vscode.workspace.getConfiguration("copilotBrowserBridge");
  if (config.get("autoStart", true)) {
    void startServer();
  }
}

async function startServer(): Promise<void> {
  if (server) {
    vscode.window.showInformationMessage(
      "Copilot Browser Bridge: Server is already running",
    );
    return;
  }

  const config = vscode.workspace.getConfiguration("copilotBrowserBridge");
  const port = config.get("serverPort", 3210);

  server = new BridgeServer(port, extensionVersion);

  try {
    await server.start();
    vscode.window.showInformationMessage(
      `Copilot Browser Bridge: Server started on port ${port}`,
    );
  } catch (error) {
    server = undefined;
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(
      `Copilot Browser Bridge: Failed to start server (${message})`,
    );
  }
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
