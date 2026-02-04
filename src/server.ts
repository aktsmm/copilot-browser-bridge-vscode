import * as http from "http";
import * as vscode from "vscode";
import { LLMRouter, ChatRequest } from "./llm-router";

export class BridgeServer {
  private server: http.Server | null = null;
  private port: number;
  private llmRouter: LLMRouter;

  constructor(port: number) {
    this.port = port;
    this.llmRouter = new LLMRouter();
  }

  start(): void {
    this.server = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://localhost:${this.port}`);

      try {
        if (url.pathname === "/health" && req.method === "GET") {
          await this.handleHealth(res);
        } else if (url.pathname === "/chat" && req.method === "POST") {
          await this.handleChat(req, res);
        } else if (url.pathname === "/models" && req.method === "GET") {
          await this.handleModels(res);
        } else if (url.pathname === "/file" && req.method === "POST") {
          await this.handleFileOperation(req, res);
        } else if (url.pathname === "/playwright" && req.method === "POST") {
          await this.handlePlaywrightAction(req, res);
        } else if (
          url.pathname === "/playwright/status" &&
          req.method === "GET"
        ) {
          await this.handlePlaywrightStatus(res);
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found" }));
        }
      } catch (error) {
        console.error("Server error:", error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });

    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(
        `Copilot Browser Bridge: Server listening on http://127.0.0.1:${this.port}`,
      );
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("Copilot Browser Bridge: Server stopped");
    }
  }

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
  }

  private async handleModels(res: http.ServerResponse): Promise<void> {
    const models = await this.llmRouter.getAvailableModels();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(models));
  }

  private async handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const request: ChatRequest = JSON.parse(body);

    // Debug: Log screenshot info
    console.log(`[Server] handleChat called`);
    console.log(`[Server] Provider: ${request.settings?.provider}`);
    console.log(`[Server] Screenshot present: ${!!request.screenshot}`);
    if (request.screenshot) {
      console.log(`[Server] Screenshot length: ${request.screenshot.length}`);
      console.log(
        `[Server] Screenshot first 50 chars: ${request.screenshot.substring(0, 50)}`,
      );
    }

    // Set streaming headers
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    try {
      const stream = await this.llmRouter.chat(request);

      for await (const chunk of stream) {
        res.write(chunk);
      }

      res.end();
    } catch (error) {
      console.error("Chat error:", error);
      res.write(
        `\n\nエラー: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      res.end();
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private async handleFileOperation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const { action, path, content } = JSON.parse(body) as {
      action: "create" | "read" | "append" | "delete";
      path: string;
      content?: string;
    };

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No workspace folder open" }));
        return;
      }

      const workspaceUri = workspaceFolders[0].uri;
      const fileUri = vscode.Uri.joinPath(workspaceUri, path);

      switch (action) {
        case "create": {
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(
            fileUri,
            encoder.encode(content || ""),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, message: `Created ${path}` }),
          );
          break;
        }
        case "read": {
          const data = await vscode.workspace.fs.readFile(fileUri);
          const decoder = new TextDecoder();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, content: decoder.decode(data) }),
          );
          break;
        }
        case "append": {
          let existingContent = "";
          try {
            const data = await vscode.workspace.fs.readFile(fileUri);
            existingContent = new TextDecoder().decode(data);
          } catch {
            // File doesn't exist, will create new
          }
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(
            fileUri,
            encoder.encode(existingContent + (content || "")),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, message: `Appended to ${path}` }),
          );
          break;
        }
        case "delete": {
          await vscode.workspace.fs.delete(fileUri);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, message: `Deleted ${path}` }),
          );
          break;
        }
        default:
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
      }
    } catch (error) {
      console.error("File operation error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  }

  // ============================================
  // PLAYWRIGHT MCP INTEGRATION
  // ============================================

  private async handlePlaywrightStatus(
    res: http.ServerResponse,
  ): Promise<void> {
    // Check if Playwright MCP tools are available
    // This is a simple check - in production you'd verify MCP connection
    const available = true; // Assume available if server is running with MCP
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available, version: "1.0.0" }));
  }

  private async handlePlaywrightAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const { action, params } = JSON.parse(body) as {
      action: string;
      params: Record<string, unknown>;
    };

    try {
      // Execute Playwright action via VS Code command
      // This delegates to the MCP tools available in the environment
      const result = await this.executePlaywrightMcpAction(action, params);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("Playwright action error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  }

  private async executePlaywrightMcpAction(
    action: string,
    params: Record<string, unknown>,
  ): Promise<{
    success: boolean;
    message?: string;
    error?: string;
    data?: unknown;
  }> {
    // Map action names to MCP tool names
    const mcpToolMap: Record<string, string> = {
      browser_click: "mcp_playwright_browser_click",
      browser_type: "mcp_playwright_browser_type",
      browser_navigate: "mcp_playwright_browser_navigate",
      browser_navigate_back: "mcp_playwright_browser_navigate_back",
      browser_snapshot: "mcp_playwright_browser_snapshot",
      browser_drag: "mcp_playwright_browser_drag",
      browser_hover: "mcp_playwright_browser_hover",
      browser_select_option: "mcp_playwright_browser_select_option",
      browser_fill_form: "mcp_playwright_browser_fill_form",
      browser_evaluate: "mcp_playwright_browser_evaluate",
      browser_wait_for: "mcp_playwright_browser_wait_for",
      browser_press_key: "mcp_playwright_browser_press_key",
      browser_tabs: "mcp_playwright_browser_tabs",
      browser_take_screenshot: "mcp_playwright_browser_take_screenshot",
      browser_close: "mcp_playwright_browser_close",
    };

    const mcpTool = mcpToolMap[action];
    if (!mcpTool) {
      return { success: false, error: `Unknown Playwright action: ${action}` };
    }

    try {
      // Call Playwright MCP server directly via HTTP
      // Default Playwright MCP runs on port 3001
      const mcpResponse = await fetch("http://127.0.0.1:3001/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: mcpTool.replace("mcp_playwright_", ""),
          arguments: params,
        }),
      });

      if (!mcpResponse.ok) {
        const errorText = await mcpResponse.text();
        console.error(`MCP call failed: ${mcpResponse.status} ${errorText}`);
        return {
          success: false,
          error: `MCP error: ${mcpResponse.status} - ${errorText}`,
        };
      }

      const result = await mcpResponse.json();
      return {
        success: true,
        message: `Executed ${action}`,
        data: result,
      };
    } catch (error) {
      console.error(`MCP tool execution failed for ${action}:`, error);

      // Return a graceful error
      return {
        success: false,
        error: `Failed to execute ${action}: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }
}
