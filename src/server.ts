// HTTP and WebSocket front of the proxy: discovery endpoints, the control API, and one Connection per client socket.
import type { AgentBrowserMonitor } from "./agent-browser-check.ts";
import { Connection, type Socket } from "./connection.ts";
import { FocusKeeper } from "./focus.ts";
import { Holds, TARGET_ID } from "./hold.ts";
import type { Humanizer } from "./humanize.ts";
import { readBindings } from "./sessions.ts";
import { snapshot } from "./stats.ts";
import { SessionTabs, type Created } from "./tabs.ts";

export interface ProxyOptions {
  /** Port to listen on (127.0.0.1); 0 picks a free one. */
  port: number;
  /** Chrome's DevTools endpoint, host:port. */
  upstream: string;
  humanizer: Humanizer;
  /** The agent-browser self-check, re-run in the background when a client connects. */
  agentBrowser?: AgentBrowserMonitor;
  /** The owner of focus emulation; one on `upstream` by default. */
  keeper?: FocusKeeper;
  /** Closes the tabs of sessions that ended with `close`; one on `upstream` and agent-browser's files by default. */
  sessionTabs?: SessionTabs;
  /** The tabs a person has taken over. */
  holds?: Holds;
  log?: (line: string) => void;
}

const MAX_MESSAGE = 512 * 1024 * 1024;
/** agent-browser session names: letters, digits, `_` and `-`, at most 128 characters. */
export const SESSION_NAME = /^[\p{L}\p{N}_-]{1,128}$/u;

/** Upstream WebSocket that queues messages until it is open. */
function openUpstream(url: string, onMessage: (text: string) => void, onClose: () => void): Socket {
  const ws = new WebSocket(url);
  let queue: string[] | undefined = [];
  ws.onopen = () => {
    for (const text of queue!) ws.send(text);
    queue = undefined;
  };
  ws.onmessage = (event) => onMessage(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString());
  ws.onclose = onClose;
  return {
    send: (text) => (queue ? queue.push(text) : ws.readyState === WebSocket.OPEN && ws.send(text)),
    close: () => ws.close(),
  };
}

/** Default, shortest and longest hold, in seconds. */
const HOLD_TTL = { default: 15, min: 1, max: 60 };

/** The tabs of sessions that ended with `close`, read from agent-browser's files and closed through Chrome's endpoint. */
function chromeSessionTabs(upstream: string, holds: Holds, log: (line: string) => void) {
  const timeout = () => AbortSignal.timeout(2000);
  return new SessionTabs({
    bindings: () => readBindings(),
    tabs: async () => {
      const res = await fetch(`http://${upstream}/json/list`, { signal: timeout() }).catch(() => undefined);
      return res?.ok ? ((await res.json()) as { id: string; type: string }[]).filter((t) => t.type === "page").map((t) => t.id) : undefined;
    },
    close: async (id) => {
      const res = await fetch(`http://${upstream}/json/close/${encodeURIComponent(id)}`, { method: "PUT", signal: timeout() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    held: (id) => holds.has(id),
    log,
  });
}

export function startProxy({
  port,
  upstream,
  humanizer,
  agentBrowser,
  log = () => {},
  keeper = new FocusKeeper(upstream, { log }),
  holds = new Holds(),
  sessionTabs = chromeSessionTabs(upstream, holds, log),
}: ProxyOptions) {
  const connections = new Set<Connection>();
  /**
   * Per agent-browser session (`namespace/session`, or the name alone without a namespace), the targets turned on
   * through the control API, so `off` reaches tabs it left.
   */
  const runtimeTabs = new Map<string, Set<string>>();
  const json = (body: object, status = 200) => Response.json(body, { status });
  /** Turns Runtime on or off for every session of a target; returns how many sessions it has. */
  const turn = (targetId: string, on: boolean) => [...connections].reduce((n, c) => n + c.setRuntime(targetId, on), 0);

  async function upstreamTargets(): Promise<string[] | undefined> {
    const res = await fetch(`http://${upstream}/json/list`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    return res?.ok ? ((await res.json()) as { id: string }[]).map((t) => t.id) : undefined;
  }

  /** Forgets recorded targets that no connection knows anymore. */
  function pruneRuntimeTabs() {
    for (const [name, ids] of runtimeTabs) {
      for (const id of ids) if (![...connections].some((c) => c.hasTarget(id))) ids.delete(id);
      if (!ids.size) runtimeTabs.delete(name);
    }
  }

  async function setRuntime(req: Request): Promise<Response> {
    const body: { targetId?: unknown; enabled?: unknown; session?: unknown; namespace?: unknown } = (await req.json().catch(() => undefined)) ?? {};
    const { targetId, enabled, session, namespace } = body;
    const name = (value: unknown) => value === undefined || (typeof value === "string" && SESSION_NAME.test(value));
    if (typeof targetId !== "string" || typeof enabled !== "boolean" || !name(session) || !name(namespace)) {
      return json({ error: "expected {targetId: string, enabled: boolean, session?: agent-browser session name, namespace?: agent-browser namespace}" }, 400);
    }
    // Sessions of different agent-browser namespaces may share a name.
    const key = typeof session === "string" ? (namespace ? `${namespace}/${session}` : session) : undefined;
    pruneRuntimeTabs();
    if (!enabled) {
      // Also every tab the session turned on before: it may have switched tabs since.
      const ids = new Set([targetId, ...((key && runtimeTabs.get(key)) || [])]);
      if (key) runtimeTabs.delete(key);
      let tabs = 0, sessions = 0;
      for (const id of ids) {
        if ([...connections].some((c) => c.runtimeSwitchedOn(id))) tabs++;
        sessions += turn(id, false);
      }
      log(`runtime off: ${tabs} tab(s), ${sessions} session(s)`);
      return json({ targetId, enabled, tabs, sessions });
    }
    const sessions = turn(targetId, true);
    if (!sessions) {
      const targets = await upstreamTargets();
      if (!targets) return json({ error: "Chrome is not reachable" }, 502);
      if (!targets.includes(targetId)) return json({ error: "the tab is gone" }, 404);
      return json({ error: "no agent-browser connection is attached to the tab" }, 409);
    }
    if (key) runtimeTabs.set(key, (runtimeTabs.get(key) ?? new Set()).add(targetId));
    log(`runtime on: ${sessions} session(s)`);
    return json({ targetId, enabled, sessions });
  }

  /** PUT holds a tab, or renews its hold, for `ttl` seconds; DELETE releases it. */
  function hold(req: Request, url: URL, targetId: string): Response {
    if (!TARGET_ID.test(targetId)) return json({ error: "expected a Chrome target id (32 hexadecimal digits, upper case)" }, 400);
    if (req.method === "DELETE") {
      if (holds.release(targetId)) log(`hold released (${holds.size} held)`);
      return json({ ok: true, targetId });
    }
    const ttl = url.searchParams.get("ttl") ?? String(HOLD_TTL.default);
    if (!/^\d+$/.test(ttl) || Number(ttl) < HOLD_TTL.min || Number(ttl) > HOLD_TTL.max) {
      return json({ error: `ttl must be whole seconds from ${HOLD_TTL.min} to ${HOLD_TTL.max}` }, 400);
    }
    if (holds.set(targetId, Number(ttl) * 1000)) {
      for (const c of connections) c.takenOver(targetId);
      log(`hold set (${holds.size} held)`);
    }
    return json({ ok: true, targetId, expiresIn: Number(ttl) });
  }

  const server = Bun.serve<{ path: string; conn?: Connection; created?: Created }>({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const self = `127.0.0.1:${server.port}`;
      // Like Chrome: no web page may use the debugging endpoint (Origin), and no DNS rebinding (Host).
      if (req.headers.has("origin") || ![self, `localhost:${server.port}`].includes(req.headers.get("host") ?? "")) {
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname.startsWith("/devtools/")) {
        return server.upgrade(req, { data: { path: url.pathname + url.search } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/json" || url.pathname.startsWith("/json/")) {
        const res = await fetch(`http://${upstream}${url.pathname}${url.search}`, { method: req.method }).catch(() => undefined);
        if (!res) return new Response("Chrome is not reachable", { status: 502 });
        const upstreamPort = upstream.split(":").pop();
        const body = (await res.text()).replaceAll(upstream, self).replaceAll(`localhost:${upstreamPort}`, self);
        return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
      }
      if (url.pathname === "/__humanize/health") {
        const [targets, ab] = await Promise.all([upstreamTargets(), agentBrowser?.status()]);
        return json({ ok: true, upstream: targets !== undefined, connections: connections.size, focus: keeper.status(), holds: holds.size, agentBrowser: ab, stats: snapshot() });
      }
      if (url.pathname === "/__humanize/runtime" && req.method === "POST") return setRuntime(req);
      const held = /^\/__humanize\/hold\/([^/]+)$/.exec(url.pathname)?.[1];
      if (held !== undefined && (req.method === "PUT" || req.method === "DELETE")) return hold(req, url, held);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE,
      backpressureLimit: MAX_MESSAGE,
      idleTimeout: 0,
      perMessageDeflate: false,
      open(ws) {
        const client: Socket = { send: (text) => void ws.send(text), close: () => ws.close() };
        let conn: Connection | undefined;
        const up = openUpstream(`ws://${upstream}${ws.data.path}`, (text) => conn?.fromUpstream(text), () => conn?.close());
        const created = (ws.data.created = sessionTabs.open());
        conn = ws.data.conn = new Connection(ws.data.path, client, up, humanizer, keeper, created.add, (id) => holds.has(id));
        connections.add(conn);
        log(`client connected (${connections.size} open)`);
        void agentBrowser?.refresh();
      },
      message(ws, data) {
        ws.data.conn?.fromClient(typeof data === "string" ? data : data.toString());
      },
      close(ws) {
        const conn = ws.data.conn;
        if (!conn || !connections.delete(conn)) return;
        conn.close();
        ws.data.created?.end();
        log(`client disconnected (${connections.size} open)`);
      },
    },
  });
  return { server, connections, runtimeTabs, holds };
}
