import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export function isSafeRelativePath(inputPath: unknown): inputPath is string {
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

export function isWithinWorkspace(
  workspaceUri: vscode.Uri,
  targetUri: vscode.Uri,
): boolean {
  const workspacePath = normalizeForComparison(
    resolveExistingAncestorPath(path.resolve(workspaceUri.fsPath)),
  );

  const targetPath = normalizeForComparison(
    resolveExistingAncestorPath(path.resolve(targetUri.fsPath)),
  );

  return (
    targetPath === workspacePath ||
    targetPath.startsWith(`${workspacePath}${path.sep}`)
  );
}

function normalizeForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveExistingAncestorPath(filePath: string): string {
  let currentPath = path.resolve(filePath);

  while (true) {
    if (fs.existsSync(currentPath)) {
      try {
        return fs.realpathSync.native(currentPath);
      } catch {
        return currentPath;
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }

    currentPath = parentPath;
  }
}

export function toWorkspaceFileUri(
  workspaceUri: vscode.Uri,
  relativePath: string,
): vscode.Uri | null {
  if (!isSafeRelativePath(relativePath)) {
    return null;
  }

  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileUri = vscode.Uri.joinPath(workspaceUri, ...segments);

  return isWithinWorkspace(workspaceUri, fileUri) ? fileUri : null;
}
