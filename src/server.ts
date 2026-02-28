import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { LLMRouter, ChatRequest } from "./llm-router";

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const DEFAULT_ALLOWED_EXTENSION_ORIGINS = [
  "chrome-extension://nggfpdadfepkbpjfnpcihagbnnfpeian",
] as const;

export class BridgeServer {
  private server: http.Server | null = null;
  private port: number;
  private llmRouter: LLMRouter;

  constructor(port: number) {
    this.port = port;
    this.llmRouter = new LLMRouter();
  }

  start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      const requestOrigin = this.getRequestOrigin(req);
      if (requestOrigin && !this.isAllowedOrigin(requestOrigin)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden origin" }));
        return;
      }

      if (requestOrigin) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
        res.setHeader("Vary", "Origin");
      }

      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Copilot-Bridge-Client",
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url || "/", `http://localhost:${this.port}`);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request URL" }));
        return;
      }

      const isHealthCheck = url.pathname === "/health" && req.method === "GET";

      if (!isHealthCheck && !requestOrigin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Origin header is required" }));
        return;
      }

      if (!isHealthCheck && !this.hasTrustedClientHeader(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized client" }));
        return;
      }

      try {
        if (isHealthCheck) {
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
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      } catch (error) {
        console.error("Server error:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });

    return new Promise((resolve, reject) => {
      const activeServer = this.server;
      if (!activeServer) {
        reject(new Error("Server initialization failed"));
        return;
      }

      const onListening = () => {
        activeServer.off("error", onStartupError);
        console.log(
          `Copilot Browser Bridge: Server listening on http://127.0.0.1:${this.port}`,
        );
        resolve();
      };

      const onStartupError = (error: NodeJS.ErrnoException) => {
        activeServer.off("listening", onListening);
        this.server = null;

        if (error.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} is already in use`));
          return;
        }

        reject(error);
      };

      activeServer.once("listening", onListening);
      activeServer.once("error", onStartupError);
      activeServer.listen(this.port, "127.0.0.1");
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("Copilot Browser Bridge: Server stopped");
    }
  }

  private getRequestOrigin(req: http.IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    return typeof origin === "string" ? origin : undefined;
  }

  private isAllowedOrigin(origin: string): boolean {
    const configuredOrigins = vscode.workspace
      .getConfiguration("copilotBrowserBridge")
      .get<string[]>("allowedExtensionOrigins", []);

    const normalizedConfiguredOrigins = configuredOrigins
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => /^chrome-extension:\/\/[a-p]{32}$/.test(value));

    const allowedOrigins = new Set<string>([
      ...DEFAULT_ALLOWED_EXTENSION_ORIGINS,
      ...normalizedConfiguredOrigins,
    ]);

    return allowedOrigins.has(origin);
  }

  private hasTrustedClientHeader(req: http.IncomingMessage): boolean {
    const headerValue = req.headers["x-copilot-bridge-client"];
    const clientValue = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;
    return clientValue === "chrome-extension";
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
    const requestBody = await this.readJsonBody<unknown>(req, res);
    if (requestBody === null) {
      return;
    }

    const validation = this.validateChatRequest(requestBody);
    if (!validation.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const request = validation.value;

    // Debug: Log screenshot info
    console.log(`[Server] handleChat called`);
    console.log(`[Server] Provider: ${request.settings?.provider}`);
    console.log(`[Server] Screenshot present: ${!!request.screenshot}`);
    if (request.screenshot) {
      console.log(`[Server] Screenshot length: ${request.screenshot.length}`);
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
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      const maxBodyBytes = 5 * 1024 * 1024;

      req.on("data", (chunk: Buffer | string) => {
        const chunkBuffer =
          typeof chunk === "string" ? Buffer.from(chunk) : chunk;

        receivedBytes += chunkBuffer.byteLength;
        if (receivedBytes > maxBodyBytes) {
          reject(new Error("REQUEST_TOO_LARGE"));
          req.destroy();
          return;
        }

        chunks.push(chunkBuffer);
      });
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", reject);
    });
  }

  private async readJsonBody<T>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<T | null> {
    let body = "";
    try {
      body = await this.readBody(req);
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return null;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read request body" }));
      return null;
    }

    if (!body.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body is required" }));
      return null;
    }

    try {
      return JSON.parse(body) as T;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return null;
    }
  }

  private validateChatRequest(request: unknown): ValidationResult<ChatRequest> {
    if (!request || typeof request !== "object") {
      return { ok: false, error: "Invalid chat request body" };
    }

    const body = request as Record<string, unknown>;
    const settings = body.settings as Record<string, unknown> | undefined;

    if (!settings || typeof settings !== "object") {
      return { ok: false, error: "Invalid chat settings" };
    }

    const provider = settings.provider;
    const allowedProviders = ["copilot", "copilot-agent", "lm-studio"];
    if (typeof provider !== "string" || !allowedProviders.includes(provider)) {
      return { ok: false, error: "Invalid provider" };
    }

    if (provider === "copilot" || provider === "copilot-agent") {
      const copilotSettings = settings.copilot as Record<string, unknown>;
      if (
        !copilotSettings ||
        typeof copilotSettings !== "object" ||
        typeof copilotSettings.model !== "string" ||
        copilotSettings.model.trim().length === 0
      ) {
        return { ok: false, error: "Invalid copilot settings" };
      }
    }

    if (provider === "lm-studio") {
      const lmStudioSettings = settings.lmStudio as Record<string, unknown>;
      if (
        !lmStudioSettings ||
        typeof lmStudioSettings !== "object" ||
        typeof lmStudioSettings.endpoint !== "string" ||
        typeof lmStudioSettings.model !== "string"
      ) {
        return { ok: false, error: "Invalid lmStudio settings" };
      }

      if (lmStudioSettings.endpoint.trim().length === 0) {
        return { ok: false, error: "Invalid lmStudio endpoint" };
      }
    }

    if (typeof body.pageContent !== "string") {
      return { ok: false, error: "Invalid pageContent" };
    }

    if (!Array.isArray(body.messages)) {
      return { ok: false, error: "Invalid messages" };
    }

    const roleSet = new Set(["user", "assistant", "system"]);
    for (const message of body.messages) {
      if (!message || typeof message !== "object") {
        return { ok: false, error: "Invalid message item" };
      }

      const role = (message as Record<string, unknown>).role;
      const content = (message as Record<string, unknown>).content;
      if (typeof role !== "string" || !roleSet.has(role)) {
        return { ok: false, error: "Invalid message role" };
      }
      if (typeof content !== "string") {
        return { ok: false, error: "Invalid message content" };
      }
    }

    if (body.screenshot !== undefined && typeof body.screenshot !== "string") {
      return { ok: false, error: "Invalid screenshot" };
    }

    if (
      body.operationMode !== undefined &&
      body.operationMode !== "text" &&
      body.operationMode !== "hybrid" &&
      body.operationMode !== "screenshot"
    ) {
      return { ok: false, error: "Invalid operationMode" };
    }

    return { ok: true, value: request as ChatRequest };
  }

  private validateFileOperationRequest(request: unknown): ValidationResult<{
    action: "create" | "read" | "append" | "delete";
    path: string;
    content?: string;
  }> {
    if (!request || typeof request !== "object") {
      return { ok: false, error: "Invalid file operation body" };
    }

    const body = request as Record<string, unknown>;
    const action = body.action;
    if (
      action !== "create" &&
      action !== "read" &&
      action !== "append" &&
      action !== "delete"
    ) {
      return { ok: false, error: "Invalid action" };
    }

    if (typeof body.path !== "string") {
      return { ok: false, error: "Invalid file path" };
    }

    if (body.content !== undefined && typeof body.content !== "string") {
      return { ok: false, error: "Invalid file content" };
    }

    return {
      ok: true,
      value: {
        action,
        path: body.path,
        content: body.content as string | undefined,
      },
    };
  }

  private validatePlaywrightRequest(request: unknown): ValidationResult<{
    action: string;
    params: Record<string, unknown>;
  }> {
    if (!request || typeof request !== "object") {
      return { ok: false, error: "Invalid playwright request body" };
    }

    const body = request as Record<string, unknown>;
    const action =
      typeof body.action === "string" ? body.action.trim() : undefined;
    if (!action) {
      return { ok: false, error: "Invalid playwright action" };
    }

    const params = body.params;
    if (
      params !== undefined &&
      (params === null || typeof params !== "object" || Array.isArray(params))
    ) {
      return { ok: false, error: "Invalid playwright params" };
    }

    return {
      ok: true,
      value: {
        action,
        params: (params ?? {}) as Record<string, unknown>,
      },
    };
  }

  private isSafeRelativePath(inputPath: unknown): boolean {
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      return false;
    }

    const normalized = inputPath.replace(/\\/g, "/").trim();
    if (
      normalized.startsWith("/") ||
      normalized.includes("://") ||
      normalized.includes(":")
    ) {
      return false;
    }

    if (normalized.endsWith("/")) {
      return false;
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => segment.length === 0)) {
      return false;
    }

    return !segments.some((segment) => segment === ".." || segment === ".");
  }

  private isWithinWorkspace(
    workspaceUri: vscode.Uri,
    targetUri: vscode.Uri,
  ): boolean {
    const workspacePath = path.resolve(workspaceUri.fsPath).toLowerCase();
    const targetPath = path.resolve(targetUri.fsPath).toLowerCase();
    return (
      targetPath === workspacePath ||
      targetPath.startsWith(`${workspacePath}${path.sep.toLowerCase()}`)
    );
  }

  private getParentDirectoryUri(
    workspaceUri: vscode.Uri,
    relativePath: string,
  ): vscode.Uri {
    const normalized = relativePath.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    const parentSegments = segments.slice(0, -1);

    return parentSegments.length > 0
      ? vscode.Uri.joinPath(workspaceUri, ...parentSegments)
      : workspaceUri;
  }

  private async statSafe(
    targetUri: vscode.Uri,
  ): Promise<vscode.FileStat | null> {
    try {
      return await vscode.workspace.fs.stat(targetUri);
    } catch {
      return null;
    }
  }

  private isRegularFile(fileType: vscode.FileType): boolean {
    return (fileType & vscode.FileType.File) === vscode.FileType.File;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleFileOperation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const requestBody = await this.readJsonBody<unknown>(req, res);

    if (requestBody === null) {
      return;
    }

    const validation = this.validateFileOperationRequest(requestBody);
    if (!validation.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    const { action, path: filePath, content } = validation.value;

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No workspace folder open" }));
        return;
      }

      const workspaceUri = workspaceFolders[0].uri;
      if (!this.isSafeRelativePath(filePath)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid file path" }));
        return;
      }

      const pathSegments = filePath.replace(/\\/g, "/").split("/");
      const fileUri = vscode.Uri.joinPath(workspaceUri, ...pathSegments);

      if (!this.isWithinWorkspace(workspaceUri, fileUri)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Path escapes workspace" }));
        return;
      }

      switch (action) {
        case "create": {
          const existing = await this.statSafe(fileUri);
          if (existing && !this.isRegularFile(existing.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Target path is not a file" }));
            break;
          }

          const parentDirectoryUri = this.getParentDirectoryUri(
            workspaceUri,
            filePath,
          );
          await vscode.workspace.fs.createDirectory(parentDirectoryUri);
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(
            fileUri,
            encoder.encode(content || ""),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, message: `Created ${filePath}` }),
          );
          break;
        }
        case "read": {
          const stat = await this.statSafe(fileUri);
          if (!stat) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "File not found" }));
            break;
          }

          if (!this.isRegularFile(stat.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Target path is not a file" }));
            break;
          }

          const data = await vscode.workspace.fs.readFile(fileUri);
          const decoder = new TextDecoder();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, content: decoder.decode(data) }),
          );
          break;
        }
        case "append": {
          const existing = await this.statSafe(fileUri);
          if (existing && !this.isRegularFile(existing.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Target path is not a file" }));
            break;
          }

          let existingContent = "";
          if (existing) {
            const data = await vscode.workspace.fs.readFile(fileUri);
            existingContent = new TextDecoder().decode(data);
          }
          const parentDirectoryUri = this.getParentDirectoryUri(
            workspaceUri,
            filePath,
          );
          await vscode.workspace.fs.createDirectory(parentDirectoryUri);
          const encoder = new TextEncoder();
          await vscode.workspace.fs.writeFile(
            fileUri,
            encoder.encode(existingContent + (content || "")),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              message: `Appended to ${filePath}`,
            }),
          );
          break;
        }
        case "delete": {
          const stat = await this.statSafe(fileUri);
          if (!stat) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "File not found" }));
            break;
          }

          if (!this.isRegularFile(stat.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Target path is not a file" }));
            break;
          }

          await vscode.workspace.fs.delete(fileUri, {
            recursive: false,
            useTrash: false,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ success: true, message: `Deleted ${filePath}` }),
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
    const available = await this.isPlaywrightMcpAvailable();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available, version: "1.0.0" }));
  }

  private async isPlaywrightMcpAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        "http://127.0.0.1:3001/call",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool: "browser_tabs",
            arguments: { action: "list" },
          }),
        },
        1500,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async handlePlaywrightAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const requestBody = await this.readJsonBody<unknown>(req, res);

    if (requestBody === null) {
      return;
    }

    const validation = this.validatePlaywrightRequest(requestBody);
    if (!validation.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: validation.error }));
      return;
    }

    const { action, params } = validation.value;

    try {
      // Execute Playwright action via VS Code command
      // This delegates to the MCP tools available in the environment
      const result = await this.executePlaywrightMcpAction(action, params);

      const statusCode = result.success ? 200 : (result.statusCode ?? 502);
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: result.success,
          message: result.message,
          error: result.error,
          data: result.data,
        }),
      );
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
    statusCode?: number;
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
      return {
        success: false,
        statusCode: 400,
        error: `Unknown Playwright action: ${action}`,
      };
    }

    try {
      // Call Playwright MCP server directly via HTTP
      // Default Playwright MCP runs on port 3001
      const mcpResponse = await this.fetchWithTimeout(
        "http://127.0.0.1:3001/call",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool: mcpTool.replace("mcp_playwright_", ""),
            arguments: params,
          }),
        },
        10000,
      );

      if (!mcpResponse.ok) {
        const errorText = await mcpResponse.text();
        console.error(`MCP call failed: ${mcpResponse.status} ${errorText}`);
        return {
          success: false,
          statusCode: 502,
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
      const isTimeout = error instanceof Error && error.name === "AbortError";
      return {
        success: false,
        statusCode: isTimeout ? 504 : 503,
        error: `Failed to execute ${action}: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }
}
