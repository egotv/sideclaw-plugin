// src/workspace.ts

import path from "node:path";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { WorkspaceReadParams, FileEntry } from "./types.js";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "vendor",
]);

/**
 * Depth-first directory traversal. Skips symlinks and excluded dirs.
 * Returns sorted workspace-relative file paths.
 */
export async function collectFiles(root: string, recursive: boolean): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results.sort((a, b) =>
    toWorkspaceRelative(a, root).localeCompare(toWorkspaceRelative(b, root)),
  );
}

/** Read a single file as UTF-8, return {name, content} with workspace-relative name. */
export async function readFileEntry(
  filePath: string,
  workspaceRoot: string,
): Promise<FileEntry> {
  const content = await fs.readFile(filePath, "utf8");
  return {
    name: toWorkspaceRelative(filePath, workspaceRoot),
    content,
  };
}

/** Check that a candidate path does not escape the root (path traversal prevention). */
export function isSubPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Validate that the workspace directory exists. */
export async function ensureWorkspaceExists(workspaceRoot: string): Promise<void> {
  try {
    const stats = await fs.stat(workspaceRoot);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory`);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`Workspace directory does not exist`);
    }
    throw error;
  }
}

/** Convert absolute path to workspace-relative with forward slashes. */
function toWorkspaceRelative(filePath: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, filePath);
  const normalized = relative === "" ? path.basename(filePath) : relative;
  return normalized.split(path.sep).join("/");
}

/**
 * Resolve workspace root from gateway agent config using sessionKey.
 * No fallback to default workspace — fails explicitly if agent not found.
 */
export function resolveWorkspace(cfg: any, sessionKey: string): string {
  const key = sessionKey.trim();
  if (!key) {
    throw new Error("sessionKey is required for workspace resolution");
  }

  // Parse agentId from "agent:<agentId>:<rest>"
  const parts = key.split(":").filter(Boolean);
  const agentId =
    parts[0]?.toLowerCase() === "agent" && parts[1]
      ? parts[1].toLowerCase()
      : null;
  if (!agentId) {
    throw new Error(`Cannot parse agent ID from sessionKey: ${key}`);
  }

  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const agentEntry = agents.find(
    (a: any) => typeof a?.id === "string" && a.id.toLowerCase() === agentId,
  );

  if (!agentEntry) {
    throw new Error(`Agent '${agentId}' not found in gateway config`);
  }

  const workspace = (agentEntry as any)?.workspace?.trim();
  if (!workspace) {
    throw new Error(`No workspace configured for agent '${agentId}'`);
  }

  const expanded = workspace.startsWith("~")
    ? workspace.replace("~", process.env.HOME ?? "")
    : workspace;
  return path.resolve(expanded);
}

/**
 * Top-level handler for workspace.read RPC.
 * Returns {ok, payload} or {ok: false, error} — never throws.
 */
export async function handleWorkspaceRead(
  cfg: any,
  params: WorkspaceReadParams,
  logger?: { warn?: (...args: any[]) => void; info?: (...args: any[]) => void },
): Promise<{ ok: true; payload: FileEntry[] } | { ok: false; error: string }> {
  try {
    if (!params.sessionKey) {
      return { ok: false, error: "sessionKey is required for workspace.read" };
    }

    const workspaceRoot = resolveWorkspace(cfg, params.sessionKey);
    await ensureWorkspaceExists(workspaceRoot);

    const recursive = params.recursive !== false;
    const requestedPath = params.path?.trim();

    logger?.info?.(
      `workspace.read: path=${requestedPath ?? "."} recursive=${recursive} agent-session=${params.sessionKey}`,
    );

    let targetPaths: string[];

    if (requestedPath) {
      const dirPath = path.resolve(workspaceRoot, requestedPath.replace(/\\/g, "/"));
      if (!isSubPath(dirPath, workspaceRoot)) {
        return { ok: false, error: `Path '${requestedPath}' is outside the workspace` };
      }
      let stats;
      try {
        stats = await fs.stat(dirPath);
      } catch {
        return { ok: true, payload: [] };
      }
      if (stats.isDirectory()) {
        targetPaths = await collectFiles(dirPath, recursive);
      } else if (stats.isFile()) {
        targetPaths = [dirPath];
      } else {
        return { ok: true, payload: [] };
      }
    } else {
      targetPaths = await collectFiles(workspaceRoot, recursive);
    }

    if (targetPaths.length === 0) {
      return { ok: true, payload: [] };
    }

    const entries: FileEntry[] = [];
    for (const filePath of targetPaths) {
      try {
        entries.push(await readFileEntry(filePath, workspaceRoot));
      } catch (err) {
        logger?.warn?.(`workspace.read: skipping ${path.relative(workspaceRoot, filePath)}: ${err}`);
      }
    }

    return { ok: true, payload: entries };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
