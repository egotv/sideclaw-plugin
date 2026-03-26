/**
 * startAccount() — the long-lived task for the sideclaw channel.
 *
 * The gateway ChannelManager calls this and auto-restarts it with backoff
 * if it exits (WS close, abort, error).
 *
 * Flow:
 *   1. Open loopback WS to the gateway's own local port
 *   2. Buffer the connect.challenge from the gateway
 *   3. Dial sideclaw WS server
 *   4. Send pre-handshake frame (delivers gateway token)
 *   5. Forward the buffered challenge to sideclaw
 *   6. Manually relay the handshake (connect RPC → hello-ok)
 *   7. Switch to generic bidirectional frame relay
 *
 * The buffered handshake is critical: the gateway has a short timeout for
 * unauthenticated connections. By buffering the challenge before connecting
 * to sideclaw, we ensure the handshake completes before the timeout.
 */

import { resolveGatewayToken, resolveGatewayUrl } from "./config.js";
import { handleWorkspaceRead } from "./workspace.js";
import type { RpcRequest, RpcResponse, WorkspaceReadParams } from "./types.js";

/** Schemes permitted for the sideclaw WebSocket URL. */
const ALLOWED_WS_SCHEMES = new Set(["ws:", "wss:"]);

/** Loopback addresses where plaintext ws:// is acceptable. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validate and parse a WebSocket URL.
 * Rejects non-ws(s) schemes to prevent SSRF against HTTP/internal services.
 */
export function validateWsUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`sideclaw: invalid ${label} URL: ${raw}`);
  }

  if (!ALLOWED_WS_SCHEMES.has(url.protocol)) {
    throw new Error(
      `sideclaw: ${label} URL must use ws:// or wss:// (got ${url.protocol})`,
    );
  }

  return url;
}

/**
 * Warn if a token is about to be sent over a plaintext connection
 * to a non-loopback host.
 */
export function checkPlaintextToken(url: URL, logger?: any): void {
  if (url.protocol === "wss:") return; // encrypted — fine
  if (LOOPBACK_HOSTS.has(url.hostname)) return; // local dev — acceptable

  logger?.warn?.(
    `sideclaw: sending token over plaintext ws:// to ${url.hostname} — ` +
    `use wss:// in production to protect credentials`,
  );
}

/**
 * Connect to a WS server with an abort signal.
 * Returns a WebSocket in OPEN state or throws.
 */
function connectWithAbort(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted before connect"));
      return;
    }

    const ws = new WebSocket(url);

    const onAbort = () => {
      ws.close();
      reject(new Error("aborted during connect"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(ws);
    }, { once: true });

    ws.addEventListener("error", (ev) => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`WebSocket connect error: ${ev}`));
    }, { once: true });
  });
}

/**
 * Wait for the next message from a WebSocket.
 * Rejects on close, error, abort, or timeout.
 */
function waitForMessage(
  ws: WebSocket,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };

    const onMessage = (ev: MessageEvent) => {
      cleanup();
      resolve(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed while waiting for message"));
    };
    const onError = (ev: Event) => {
      cleanup();
      reject(new Error(`WebSocket error: ${ev}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    ws.addEventListener("message", onMessage, { once: true });
    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Result from fetching agent info from the gateway. */
type AgentInfo = {
  agents: any[];
  defaultWorkspace: string | undefined;
};

/**
 * Fetch agent info from the gateway via `agents.list` + `config.get` RPC.
 *
 * Returns the agents array and the default workspace (from `agents.defaults.workspace`).
 * Both are used by `resolveWorkspace`: agent-specific workspace takes priority,
 * default workspace is the fallback.
 */
function fetchAgentInfo(gatewayWs: WebSocket, logger?: any): Promise<AgentInfo> {
  return new Promise<AgentInfo>((resolve) => {
    const agentsReqId = `ws-agents-${Date.now()}`;
    const configReqId = `ws-config-${Date.now()}`;
    let agentsList: any[] | null = null;
    let defaultWorkspace: string | undefined = undefined;
    let replies = 0;

    const tryFinish = () => {
      replies++;
      if (replies < 2) return;
      clearTimeout(timer);
      gatewayWs.removeEventListener("message", onReply);
      resolve({ agents: agentsList ?? [], defaultWorkspace });
    };

    const timer = setTimeout(() => {
      gatewayWs.removeEventListener("message", onReply);
      logger?.warn?.("workspace.read: gateway RPC timed out fetching agents/config");
      resolve({ agents: agentsList ?? [], defaultWorkspace });
    }, 5_000);

    const onReply = (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      try {
        const frame = JSON.parse(raw);
        if (frame.type !== "res") return;

        if (frame.id === agentsReqId) {
          agentsList = frame.result?.agents ?? frame.payload?.agents ?? [];
          if (!Array.isArray(agentsList)) agentsList = [];
          logger?.info?.(`workspace.read: agents.list returned ${agentsList.length} agents`);
          tryFinish();
        } else if (frame.id === configReqId) {
          const cfg = frame.result ?? frame.payload ?? {};
          defaultWorkspace = cfg?.agents?.defaults?.workspace?.trim() || undefined;
          logger?.info?.(`workspace.read: config.get defaultWorkspace=${defaultWorkspace ?? "(none)"}`);
          tryFinish();
        }
      } catch { /* ignore parse errors on other messages */ }
    };

    gatewayWs.addEventListener("message", onReply);

    // Fire both RPCs in parallel
    logger?.info?.(`workspace.read: fetching agents (${agentsReqId}) and config (${configReqId}) from gateway`);
    gatewayWs.send(JSON.stringify({
      type: "req", id: agentsReqId, method: "agents.list", params: {},
    }));
    gatewayWs.send(JSON.stringify({
      type: "req", id: configReqId, method: "config.get", params: {},
    }));
  });
}

/**
 * Relay frames bidirectionally between two WebSockets.
 *
 * Messages from `a` (sideclaw/bot-runner) heading to `b` (gateway) are
 * checked for `workspace.read` RPC requests. Matching requests are handled
 * locally; everything else is forwarded verbatim.
 *
 * The relay lazily fetches the agent list from the gateway on the first
 * `workspace.read` request and caches it for subsequent calls.
 *
 * @param logger - Optional logger for workspace read operations
 */
function relayFrames(
  a: WebSocket,
  b: WebSocket,
  signal: AbortSignal,
  logger?: any,
): Promise<void> {
  let cachedInfo: AgentInfo | null = null;

  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      a.removeEventListener("message", aToB);
      b.removeEventListener("message", bToA);
      a.removeEventListener("close", onClose);
      b.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      try { a.close(); } catch { /* already closed */ }
      try { b.close(); } catch { /* already closed */ }
      resolve();
    };

    const aToB = (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);

      // Fast string check — only parse if the message might be a workspace.read request
      if (raw.includes('"workspace.read"')) {
        try {
          const frame = JSON.parse(raw) as RpcRequest;
          if (frame.type === "req" && frame.method === "workspace.read") {
            // Fetch agent info from gateway (cached after first call), then handle locally
            const infoPromise = cachedInfo !== null
              ? Promise.resolve(cachedInfo)
              : fetchAgentInfo(b, logger).then((info) => { cachedInfo = info; return info; });

            infoPromise
              .then((info) => handleWorkspaceRead(info.agents, frame.params as WorkspaceReadParams, logger, info.defaultWorkspace))
              .then((result) => {
                const resp: RpcResponse = result.ok
                  ? { type: "res", id: frame.id, ok: true, payload: result.payload }
                  : { type: "res", id: frame.id, ok: false, error: { message: result.error } };
                try { a.send(JSON.stringify(resp)); } catch { done(); }
              })
              .catch((err) => {
                const resp: RpcResponse = {
                  type: "res", id: frame.id, ok: false,
                  error: { message: String(err) },
                };
                try { a.send(JSON.stringify(resp)); } catch { done(); }
              });
            return; // Don't forward to gateway
          }
        } catch {
          // JSON parse failed — fall through to normal relay
        }
      }

      try { b.send(ev.data); } catch { done(); }
    };

    const bToA = (ev: MessageEvent) => {
      try { a.send(ev.data); } catch { done(); }
    };
    const onClose = () => done();
    const onAbort = () => done();

    a.addEventListener("message", aToB);
    b.addEventListener("message", bToA);
    a.addEventListener("close", onClose, { once: true });
    b.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Long-lived task: buffer challenge, dial sideclaw, relay handshake, then relay frames.
 */
export async function startAccount(ctx: any): Promise<void> {
  const { sideClawUrl } = ctx.account;
  const gatewayToken = resolveGatewayToken(ctx.cfg);
  const pairingToken = ctx.account.pairingToken;
  if (!pairingToken) {
    throw new Error(
      "sideclaw: pairingToken is required — generate one from Settings > Gateway in the SideClaw web app",
    );
  }
  const identityToken = pairingToken;
  const gatewayUrl = resolveGatewayUrl(ctx.cfg);

  // Validate URLs before connecting
  const sideClawParsed = validateWsUrl(sideClawUrl, "sideClawUrl");
  validateWsUrl(gatewayUrl, "gatewayUrl");

  // Warn if sending token over plaintext to a remote host
  checkPlaintextToken(sideClawParsed, ctx.logger);

  // 1. Connect to gateway FIRST — it sends connect.challenge immediately
  const gatewayWs = await connectWithAbort(gatewayUrl, ctx.abortSignal);

  // 2. Buffer the connect.challenge
  const challengeRaw = await waitForMessage(gatewayWs, ctx.abortSignal);

  // 3. Dial sideclaw
  const sideClawWs = await connectWithAbort(sideClawUrl, ctx.abortSignal);
  ctx.setStatus({ connected: false, lastError: undefined });

  // 4. Send pre-handshake — delivers identity token (pairing or gateway) for routing,
  //    plus the gateway token so sideclaw can sign the handshake correctly.
  sideClawWs.send(
    JSON.stringify({
      type: "pre-handshake",
      version: 1,
      token: identityToken,
      gatewayToken,
    }),
  );

  // 5. Forward the buffered challenge to sideclaw
  sideClawWs.send(challengeRaw);

  // 6. Relay the handshake manually:
  //    sideclaw sends connect RPC → forward to gateway
  const connectRaw = await waitForMessage(sideClawWs, ctx.abortSignal);
  gatewayWs.send(connectRaw);

  //    gateway sends hello-ok → forward to sideclaw
  const helloRaw = await waitForMessage(gatewayWs, ctx.abortSignal);
  sideClawWs.send(helloRaw);

  ctx.setStatus({ connected: true });
  ctx.logger?.info?.("sideclaw: handshake complete, ready");

  // 7. Switch to generic bidirectional frame relay
  //    All GatewaySession RPC calls flow through from here.
  await relayFrames(sideClawWs, gatewayWs, ctx.abortSignal, ctx.logger);
}
