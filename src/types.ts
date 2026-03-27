// src/types.ts

/** Inbound RPC request from the bot-runner side. */
export type RpcRequest = {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** Outbound RPC response sent back to the bot-runner side. */
export type RpcResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
};

/** Parameters for workspace.read RPC. */
export type WorkspaceReadParams = {
  path?: string;
  recursive?: boolean;
  sessionKey?: string;
};

/** Single file entry returned by workspace.read. */
export type FileEntry = {
  name: string;
  content: string;
};
