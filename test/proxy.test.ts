import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { AgentBrowserMonitor } from "../src/agent-browser-check.ts";
import { FocusKeeper } from "../src/focus.ts";
import { Holds, TAKEN_OVER } from "../src/hold.ts";
import { Humanizer } from "../src/humanize.ts";
import { CLEAR_SOURCE, FOCUS_SOURCE, SCROLL_ELEMENT_SOURCE } from "../src/recognize.ts";
import { startProxy } from "../src/server.ts";
import type { Binding } from "../src/sessions.ts";
import { TabLeases } from "../src/tabs.ts";
import { fakeClock } from "./helpers.ts";

// A fake Chrome: discovery endpoints plus WebSockets that record what they receive. Only the focus keeper connects to
// the browser endpoint that /json/version names; test clients connect to another path, so the two are told apart.
const KEEPER_PATH = "/devtools/browser/main";
type Ws = ServerWebSocket<{ path: string }>;
const received: any[] = [];
const sockets: Ws[] = [];
const keeperReceived: any[] = [];
const keeperSockets: Ws[] = [];
let closed = 0;
/** A tab with a target id in Chrome's format, for holds. */
const TAB = "0123456789ABCDEF0123456789ABCDEF";
const targets = ["T1", "T2", "T3", TAB];
/** The keeper's session ids, by target. */
const keeperSessions = new Map<string, string>();
/** Chrome's answer to a keeper command; undefined leaves it to the test. */
type Answer = { result?: object; error?: object } | undefined;
const answerKeeper = (m: any): Answer => {
  if (m.method !== "Target.attachToTarget") return { result: {} };
  const sessionId = `K${keeperSessions.size + 1}`;
  keeperSessions.set(sessionId, m.params.targetId);
  return { result: { sessionId } };
};
let keeperAnswer = answerKeeper;
const chrome: Bun.Server<{ path: string }> = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, server): Response | undefined {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/devtools/")) return server.upgrade(req, { data: { path: url.pathname } }) ? undefined : new Response("no", { status: 400 });
    if (url.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}${KEEPER_PATH}` });
    if (url.pathname === "/json/list") return Response.json(targets.map((id) => ({ id, webSocketDebuggerUrl: `ws://localhost:${server.port}/devtools/page/${id}` })));
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open: (ws) => void (ws.data.path === KEEPER_PATH ? keeperSockets : sockets).push(ws),
    message(ws, data) {
      const msg = JSON.parse(String(data));
      if (ws.data.path !== KEEPER_PATH) return void received.push(msg);
      keeperReceived.push(msg);
      const answer = keeperAnswer(msg);
      if (answer) ws.send(JSON.stringify({ id: msg.id, ...answer, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    },
    close: (ws) => void (ws.data.path !== KEEPER_PATH && closed++),
  },
});
const upstream = `127.0.0.1:${chrome.port}`;
const agentBrowser = new AgentBrowserMonitor(() => {}, { AGENT_BROWSER_HUMANIZE_AGENT_BROWSER: "/nonexistent/agent-browser" });
const keeper = new FocusKeeper(upstream, { rebuildDelay: 50, timeout: 2000 });
/** agent-browser's bindings as the proxy reads them, and the tabs it closed. */
const bindings: Binding[] = [];
const tabsClosed: string[] = [];
/** Holds expire on this clock. */
let now = 0;
const holds = new Holds(() => now);
const tabs = new TabLeases({
  bindings: async () => bindings,
  tabs: async () => targets,
  close: async (id) => void tabsClosed.push(id),
  held: (id) => holds.has(id),
});
const { server, connections, runtimeTabs } = startProxy({ port: 0, upstream, humanizer: new Humanizer(fakeClock()), agentBrowser, keeper, tabs, holds });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  chrome.stop(true);
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};

async function connect(path = "/devtools/browser/abc", owner?: string) {
  const messages: any[] = [];
  const before = sockets.length;
  // Bun's WebSocket takes headers, as agent-browser sends them with `--cdp-headers`.
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, (owner ? { headers: { "x-humanize-owner": owner } } : undefined) as any);
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((resolve) => (ws.onopen = resolve));
  await until(() => sockets.length > before);
  const chromeSide = sockets.at(-1)!;
  const send = (msg: object) => ws.send(JSON.stringify(msg));
  const emit = (msg: object) => chromeSide.send(JSON.stringify(msg));
  const conn = [...connections].at(-1)!;
  /** Closes the client and waits until the proxy has dropped its connection. */
  const close = async () => {
    ws.close();
    await until(() => !connections.has(conn));
  };
  return { ws, messages, send, emit, close };
}

const post = (body: object) => fetch(`${base}/__humanize/runtime`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runtime = (targetId: string, enabled: boolean, session?: string) => post({ targetId, enabled, session });
const runtimeJson = async (targetId: string, enabled: boolean, session?: string) => (await runtime(targetId, enabled, session)).json();
/** The Runtime commands the proxy sent to Chrome, as "method session". */
const runtimeSent = () => received.filter((m) => m.method?.startsWith("Runtime.")).map((m) => `${m.method} ${m.sessionId}`);

const attached = (sessionId: string, targetId: string, type: string) => ({
  method: "Target.attachedToTarget",
  params: { sessionId, targetInfo: { targetId, type }, waitingForDebugger: false },
});
const health = async (): Promise<any> => (await fetch(`${base}/__humanize/health`)).json();
const stat = async (name: string): Promise<number> => (await health()).stats[name] ?? 0;
/** What the keeper asked Chrome, in order, with its sessions shown as their targets: "attach T1", "emulate T1", "detach T1". */
const keeperDid = () =>
  keeperReceived.map((m) =>
    m.method === "Target.attachToTarget" ? `attach ${m.params.targetId}`
    : m.method === "Emulation.setFocusEmulationEnabled" ? `emulate ${keeperSessions.get(m.sessionId)}${m.params.enabled ? "" : " off"}`
    : m.method === "Target.detachFromTarget" ? `detach ${keeperSessions.get(m.params.sessionId)}`
    : m.method,
  );

/** A client attached to T1 (S1) and T2 (S2) that wants Runtime on both. */
async function twoTabs() {
  const client = await connect();
  client.emit({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" }, waitingForDebugger: false } });
  client.emit({ method: "Target.attachedToTarget", params: { sessionId: "S2", targetInfo: { targetId: "T2", type: "page" }, waitingForDebugger: false } });
  client.send({ id: 1, method: "Runtime.enable", sessionId: "S1" });
  client.send({ id: 2, method: "Runtime.enable", sessionId: "S2" });
  await until(() => client.messages.length === 4);
  return client;
}

beforeEach(() => {
  received.length = 0;
  sockets.length = 0;
  keeperReceived.length = 0;
  keeperAnswer = answerKeeper;
});

describe("HTTP", () => {
  test("discovery endpoints point WebSocket URLs at the proxy", async () => {
    expect(((await (await fetch(`${base}/json/version`)).json()) as any).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${server.port}${KEEPER_PATH}`);
    const list = (await (await fetch(`${base}/json/list`)).json()) as any[];
    expect(list[0].webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${server.port}/devtools/page/T1`);
  });

  test("health reports Chrome, connections, focus emulation and the agent-browser self-check", async () => {
    expect(await health()).toMatchObject({
      ok: true,
      upstream: true,
      connections: 0,
      focus: { inUse: 0, emulated: 0 },
      holds: 0,
      agentBrowser: { error: "agent-browser not found at /nonexistent/agent-browser" },
    });
  });

  test("requests from web pages or other host names are refused", async () => {
    expect((await fetch(`${base}/json/version`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${base}/json/version`, { headers: { host: "evil.example:80" } })).status).toBe(403);
  });
});

describe("WebSocket", () => {
  test("Runtime.enable is answered locally; other commands and events pass through", async () => {
    const { ws, messages, send, emit } = await connect();
    send({ id: 1, method: "Runtime.enable", sessionId: "S1" });
    send({ id: 2, method: "Page.navigate", params: { url: "about:blank" }, sessionId: "S1" });
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ id: 2, method: "Page.navigate", params: { url: "about:blank" }, sessionId: "S1" });
    expect(messages[0]).toEqual({ id: 1, result: {}, sessionId: "S1" });
    emit({ id: 2, result: { frameId: "F" }, sessionId: "S1" });
    emit({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" });
    await until(() => messages.length === 3);
    expect(messages.slice(1)).toEqual([{ id: 2, result: { frameId: "F" }, sessionId: "S1" }, { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" }]);
    ws.close();
  });

  test("Runtime on/off reaches only the sessions of that target, and its responses stay in the proxy", async () => {
    const { ws, messages, send, emit } = await connect();
    emit({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" }, waitingForDebugger: false } });
    emit({ method: "Target.attachedToTarget", params: { sessionId: "S2", targetInfo: { targetId: "T2", type: "page" }, waitingForDebugger: false } });
    send({ id: 1, method: "Runtime.enable", sessionId: "S1" });
    send({ id: 2, method: "Runtime.enable", sessionId: "S2" });
    await until(() => messages.length === 4);

    const on = await runtime("T1", true);
    expect(await on.json()).toEqual({ targetId: "T1", enabled: true, sessions: 1 });
    await until(() => received.length === 1);
    const enable = received[0];
    expect(enable).toMatchObject({ method: "Runtime.enable", sessionId: "S1" });
    expect(enable.id).toBeGreaterThanOrEqual(1_000_000_000);
    emit({ id: enable.id, result: {}, sessionId: "S1" });
    emit({ method: "Runtime.consoleAPICalled", params: { type: "log", args: [] }, sessionId: "S1" });
    await until(() => messages.length === 5);
    expect(messages[4].method).toBe("Runtime.consoleAPICalled");

    expect((await runtime("T1", false)).status).toBe(200);
    await until(() => received.length === 2);
    expect(received[1]).toMatchObject({ method: "Runtime.disable", sessionId: "S1" });
    ws.close();
  });

  test("sessions from Target.attachToTarget responses are tracked; detach forgets them", async () => {
    const { ws, messages, send, emit } = await connect();
    send({ id: 5, method: "Target.attachToTarget", params: { targetId: "T3", flatten: true } });
    await until(() => received.length === 1);
    emit({ id: 5, result: { sessionId: "S3" } });
    send({ id: 6, method: "Runtime.enable", sessionId: "S3" });
    await until(() => messages.length === 2);
    expect(((await (await runtime("T3", true)).json()) as any).sessions).toBe(1);
    await until(() => received.at(-1)?.method === "Runtime.enable");
    emit({ method: "Target.detachedFromTarget", params: { sessionId: "S3", targetId: "T3" } });
    await until(() => messages.length === 3);
    expect((await runtime("T3", true)).status).toBe(409);
    ws.close();
  });

  test("off turns Runtime off on every tab the session turned on, after a tab switch too", async () => {
    const { close } = await twoTabs();
    expect(await runtimeJson("T1", true, "abh-a")).toEqual({ targetId: "T1", enabled: true, sessions: 1 });
    // The session switches to T2: its pinned tab, and so the next targetId, is now T2.
    expect(await runtimeJson("T2", true, "abh-a")).toEqual({ targetId: "T2", enabled: true, sessions: 1 });
    await until(() => runtimeSent().length === 2);
    expect(await runtimeJson("T2", false, "abh-a")).toEqual({ targetId: "T2", enabled: false, tabs: 2, sessions: 2 });
    await until(() => runtimeSent().length === 4);
    expect(runtimeSent().slice(2).sort()).toEqual(["Runtime.disable S1", "Runtime.disable S2"]);
    expect(runtimeTabs.has("abh-a")).toBe(false);
    expect(await runtimeJson("T2", false, "abh-a")).toEqual({ targetId: "T2", enabled: false, tabs: 0, sessions: 1 });
    await close();
  });

  test("sessions of different namespaces with the same name are recorded apart", async () => {
    const { close } = await twoTabs();
    expect((await post({ targetId: "T1", enabled: true, session: "abh-n", namespace: "proj-a" })).status).toBe(200);
    expect((await post({ targetId: "T2", enabled: true, session: "abh-n", namespace: "proj-b" })).status).toBe(200);
    expect([...runtimeTabs.keys()].sort()).toEqual(["proj-a/abh-n", "proj-b/abh-n"]);
    await until(() => runtimeSent().length === 2);
    // proj-a's session has switched to T3: off reaches its recorded T1, not proj-b's T2.
    expect(await (await post({ targetId: "T3", enabled: false, session: "abh-n", namespace: "proj-a" })).json()).toEqual({ targetId: "T3", enabled: false, tabs: 1, sessions: 1 });
    await until(() => runtimeSent().length === 3);
    expect(runtimeSent()).toEqual(["Runtime.enable S1", "Runtime.enable S2", "Runtime.disable S1"]);
    expect([...runtimeTabs.keys()]).toEqual(["proj-b/abh-n"]);
    expect((await post({ targetId: "T2", enabled: false, session: "abh-n", namespace: "proj-b" })).status).toBe(200);
    expect(runtimeTabs.size).toBe(0);
    await close();
  });

  test("without a session, off reaches only the given tab", async () => {
    const { close } = await twoTabs();
    expect((await runtime("T1", true)).status).toBe(200);
    expect((await runtime("T2", true)).status).toBe(200);
    expect(await runtimeJson("T2", false)).toEqual({ targetId: "T2", enabled: false, tabs: 1, sessions: 1 });
    await until(() => runtimeSent().length === 3);
    await Bun.sleep(20);
    expect(runtimeSent()).toEqual(["Runtime.enable S1", "Runtime.enable S2", "Runtime.disable S2"]);
    expect(runtimeTabs.size).toBe(0);
    await close();
  });

  test("off never fails for a gone tab, a recorded tab that is gone, or a tab no client is attached to", async () => {
    const { close, emit } = await twoTabs();
    expect(await runtimeJson("GONE", false)).toEqual({ targetId: "GONE", enabled: false, tabs: 0, sessions: 0 });
    expect(await runtimeJson("GONE", false, "abh-b")).toEqual({ targetId: "GONE", enabled: false, tabs: 0, sessions: 0 });
    expect(await runtimeJson("T3", false, "abh-b")).toEqual({ targetId: "T3", enabled: false, tabs: 0, sessions: 0 });
    expect((await runtime("T1", true, "abh-b")).status).toBe(200);
    expect((await runtime("T2", true, "abh-b")).status).toBe(200);
    emit({ method: "Target.targetDestroyed", params: { targetId: "T1" } });
    await until(() => !connections.values().some((c) => c.hasTarget("T1")));
    expect(await runtimeJson("GONE", false, "abh-b")).toEqual({ targetId: "GONE", enabled: false, tabs: 1, sessions: 1 });
    await close();
  });

  test("recorded tabs are forgotten once no connection knows them", async () => {
    const { close } = await twoTabs();
    expect((await runtime("T1", true, "abh-c")).status).toBe(200);
    expect([...runtimeTabs.get("abh-c")!]).toEqual(["T1"]);
    await close();
    expect((await runtime("GONE", true, "abh-d")).status).toBe(404);
    expect(runtimeTabs.has("abh-c")).toBe(false);
  });

  test("control API errors: gone tab, bad request", async () => {
    expect((await runtime("GONE", true)).status).toBe(404);
    expect((await runtime("GONE", true, "abh-x")).status).toBe(404);
    expect((await fetch(`${base}/__humanize/runtime`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await fetch(`${base}/__humanize/runtime`, { method: "POST", body: "null" })).status).toBe(400);
    for (const session of ["", "../x", "a b", "x".repeat(129), 5, null]) {
      expect((await post({ targetId: "T1", enabled: false, session })).status).toBe(400);
    }
    expect((await post({ targetId: "T1", enabled: false, session: "x".repeat(128) })).status).toBe(200);
    for (const namespace of ["", "a/b", "../x", 5]) {
      expect((await post({ targetId: "T1", enabled: false, session: "abh-x", namespace })).status).toBe(400);
    }
  });

  test("Target.createTarget opens tabs in the background unless the client asks for a window, background or focus", async () => {
    const { send, close } = await connect();
    const asked = [
      { url: "about:blank" },
      { url: "https://example.com/", browserContextId: "C1", newWindow: false },
      { url: "about:blank", newWindow: true },
      { url: "about:blank", background: false },
      { url: "about:blank", background: true },
      { url: "about:blank", focus: true },
      { url: "about:blank", focus: false },
    ];
    asked.forEach((params, i) => send({ id: i + 1, method: "Target.createTarget", params }));
    await until(() => received.length === asked.length);
    expect(received.map((m) => m.params)).toEqual([
      { url: "about:blank", background: true },
      { url: "https://example.com/", browserContextId: "C1", newWindow: false, background: true },
      { url: "about:blank", newWindow: true },
      { url: "about:blank", background: false },
      { url: "about:blank", background: true },
      { url: "about:blank", focus: true },
      { url: "about:blank", focus: false, background: true },
    ]);
    expect(received.map((m) => m.id)).toEqual(asked.map((_, i) => i + 1));
    await close();
  });

  test("tabs a client created, and tabs its pages open, belong to the owner it named; the control API ends or renews its lease", async () => {
    const { messages, send, emit, close } = await connect("/devtools/browser/abc", "pa-one");
    send({ id: 7, method: "Target.createTarget", params: { url: "about:blank" } });
    await until(() => received.length === 1);
    emit({ id: 7, result: { targetId: "T3" } });
    emit({ method: "Target.targetCreated", params: { targetInfo: { targetId: "T4", type: "page", openerId: "T3" } } });
    emit({ method: "Target.targetCreated", params: { targetInfo: { targetId: "T5", type: "page", openerId: "T1" } } });
    await until(() => messages.length === 3);
    expect(messages[0]).toEqual({ id: 7, result: { targetId: "T3" } });
    await close();
    targets.push("T3", "T4", "T5");
    const lease = (method: string, owner: string) => fetch(`${base}/__humanize/lease/${owner}`, { method }).then((res) => res.json() as Promise<any>);
    expect(await lease("PUT", "pa-one")).toEqual({ ok: true, owner: "pa-one", tabs: 2, expiresIn: 3600 });
    expect(await lease("PUT", "pa-other")).toMatchObject({ tabs: 0 });
    expect((await fetch(`${base}/__humanize/lease/a%20b`, { method: "PUT" })).status).toBe(400);
    await tabs.check();
    expect(tabsClosed).toEqual([]);
    expect(await lease("DELETE", "pa-one")).toMatchObject({ tabs: 2 });
    await until(() => tabsClosed.length === 2);
    expect(tabsClosed.sort()).toEqual(["T3", "T4"]);
    targets.splice(-3);
    tabsClosed.length = 0;
  });

  test("an owner's name must be a session name", async () => {
    const res = await fetch(`${base}/devtools/browser/abc`, { headers: { upgrade: "websocket", connection: "Upgrade", "x-humanize-owner": "a b", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
    expect(res.status).toBe(400);
  });

  test("Page.bringToFront is answered locally; Target.activateTarget passes through", async () => {
    const { messages, send, emit, close } = await connect();
    emit(attached("S1", "T1", "page"));
    send({ id: 1, method: "Page.bringToFront", sessionId: "S1" });
    send({ id: 2, method: "Target.activateTarget", params: { targetId: "T1" } });
    await until(() => messages.length === 2 && received.length === 1);
    expect(messages[1]).toEqual({ id: 1, result: {}, sessionId: "S1" });
    expect(received).toEqual([{ id: 2, method: "Target.activateTarget", params: { targetId: "T1" } }]);
    await close();
  });

  test("closing the client closes the upstream connection", async () => {
    const before = closed;
    const { ws } = await connect();
    ws.close();
    await until(() => closed === before + 1);
  });
});

describe("focus keeper", () => {
  type Client = Awaited<ReturnType<typeof connect>>;
  /** Chrome announces a page session to the client, as it does before the client can use it. */
  async function announce(c: Client, sessionId: string, targetId: string) {
    const n = c.messages.length;
    c.emit(attached(sessionId, targetId, "page"));
    await until(() => c.messages.length > n);
  }
  /** The client enables Page on a session and Chrome answers it; resolves with the client's answer. */
  async function enablePage(c: Client, id: number, sessionId?: string) {
    const sent = received.length, answers = c.messages.length;
    c.send({ id, method: "Page.enable", ...(sessionId ? { sessionId } : {}) });
    await until(() => received.length > sent);
    c.emit({ id: received.at(-1).id, result: {}, ...(sessionId ? { sessionId } : {}) });
    await until(() => c.messages.length > answers);
    return c.messages.at(-1);
  }

  test("the keeper emulates the tabs; client sessions never get the emulation command", async () => {
    const c = await connect();
    await announce(c, "S1", "T1");
    await announce(c, "S2", "T2");
    c.send({ id: 1, method: "Page.enable", sessionId: "S1" });
    c.send({ id: 2, method: "Page.enable", sessionId: "S2" });
    await until(() => received.length === 2 && keeperReceived.length === 4);
    // The first Page.enable for a tab is sent as one of the proxy's own commands, so the proxy can hold the answer.
    expect(received.map((m) => `${m.method} ${m.sessionId} ${m.id >= 1_000_000_000}`)).toEqual(["Page.enable S1 true", "Page.enable S2 true"]);
    expect(keeperDid().toSorted()).toEqual(["attach T1", "attach T2", "emulate T1", "emulate T2"]);
    expect(keeperReceived.find((m) => m.params?.targetId === "T1").params).toEqual({ targetId: "T1", flatten: true });
    for (const m of received) c.emit({ id: m.id, result: {}, sessionId: m.sessionId });
    await until(() => c.messages.length === 4);
    // Enabling Page again (a tab switch back) passes through byte for byte; the keeper does nothing more.
    expect(await enablePage(c, 3, "S1")).toEqual({ id: 3, result: {}, sessionId: "S1" });
    expect(received[2]).toEqual({ id: 3, method: "Page.enable", sessionId: "S1" });
    await Bun.sleep(20);
    expect(received.every((m) => m.method === "Page.enable")).toBe(true);
    expect(keeperReceived).toHaveLength(4);
    // The client gets exactly one answer per command, and none for the proxy's own.
    expect(c.messages.slice(2)).toEqual([1, 2, 3].map((id) => ({ id, result: {}, sessionId: id === 2 ? "S2" : "S1" })));
    expect((await health()).focus).toEqual({ inUse: 2, emulated: 2 });
    await c.close();
    await until(() => keeperReceived.length === 6);
    expect(keeperDid().slice(4).toSorted()).toEqual(["detach T1", "detach T2"]);
    expect((await health()).focus).toEqual({ inUse: 0, emulated: 0 });
  });

  test("one keeper session per tab, whatever the number of connections using it, until the last one is gone", async () => {
    const before = await stat("focus.keeper.attach");
    const a = await connect(), b = await connect();
    await announce(a, "A1", "T1");
    await announce(b, "B1", "T1");
    await announce(b, "B2", "T1");
    expect(await enablePage(a, 1, "A1")).toEqual({ id: 1, result: {}, sessionId: "A1" });
    expect(await enablePage(b, 1, "B1")).toEqual({ id: 1, result: {}, sessionId: "B1" });
    expect(await enablePage(b, 2, "B2")).toEqual({ id: 2, result: {}, sessionId: "B2" });
    expect(keeperDid()).toEqual(["attach T1", "emulate T1"]);
    // A closes, and one of B's two sessions detaches: B still uses the tab.
    await a.close();
    b.emit({ method: "Target.detachedFromTarget", params: { sessionId: "B1", targetId: "T1" } });
    await Bun.sleep(30);
    expect(keeperDid()).toEqual(["attach T1", "emulate T1"]);
    expect(keeper.status()).toEqual({ inUse: 1, emulated: 1 });
    // B's last session on it detaches.
    b.emit({ method: "Target.detachedFromTarget", params: { sessionId: "B2", targetId: "T1" } });
    await until(() => keeperReceived.length === 3);
    expect(keeperDid()[2]).toBe("detach T1");
    // The tab is destroyed; the last connection using a tab closes.
    await announce(b, "B3", "T2");
    await announce(b, "B4", "T3");
    await enablePage(b, 3, "B3");
    await enablePage(b, 4, "B4");
    b.emit({ method: "Target.targetDestroyed", params: { targetId: "T3" } });
    await until(() => keeperReceived.length === 8);
    expect(keeperDid().slice(3)).toEqual(["attach T2", "emulate T2", "attach T3", "emulate T3", "detach T3"]);
    await b.close();
    await until(() => keeperReceived.length === 9);
    expect(keeperDid()[8]).toBe("detach T2");
    expect(await stat("focus.keeper.attach")).toBe(before + 3);
  });

  test("the client's Page.enable is answered once Chrome and the keeper are done, also when the keeper fails", async () => {
    keeperAnswer = () => undefined; // Chrome answers the keeper only when the test says so
    const c = await connect();
    await announce(c, "S1", "T1");
    c.send({ id: 7, method: "Page.enable", params: { enableFileChooserOpenedEvent: true }, sessionId: "S1" });
    await until(() => received.length === 1 && keeperReceived.length === 1);
    expect(received[0]).toMatchObject({ method: "Page.enable", params: { enableFileChooserOpenedEvent: true }, sessionId: "S1" });
    c.emit({ id: received[0].id, result: {}, sessionId: "S1" });
    await Bun.sleep(30);
    expect(c.messages).toHaveLength(1); // only the attachedToTarget event
    const chromeSide = keeperSockets.at(-1)!;
    keeperSessions.set("KW", "T1");
    chromeSide.send(JSON.stringify({ id: keeperReceived[0].id, result: { sessionId: "KW" } }));
    await until(() => keeperReceived.length === 2);
    expect(keeperDid()).toEqual(["attach T1", "emulate T1"]);
    await Bun.sleep(30);
    expect(c.messages).toHaveLength(1);
    chromeSide.send(JSON.stringify({ id: keeperReceived[1].id, result: {}, sessionId: "KW" }));
    await until(() => c.messages.length === 2);
    expect(c.messages[1]).toEqual({ id: 7, result: {}, sessionId: "S1" });

    // The keeper cannot attach, or cannot emulate: counted, and the client gets Chrome's answer all the same.
    const failed = await stat("focus.keeper.failed");
    const fail = (method: string) => (keeperAnswer = (m) => (m.method === method ? { error: { code: -32000, message: "nope" } } : answerKeeper(m)));
    fail("Target.attachToTarget");
    await announce(c, "S2", "T2");
    expect(await enablePage(c, 8, "S2")).toEqual({ id: 8, result: {}, sessionId: "S2" });
    fail("Emulation.setFocusEmulationEnabled");
    await announce(c, "S3", "T3");
    expect(await enablePage(c, 9, "S3")).toEqual({ id: 9, result: {}, sessionId: "S3" });
    // Chrome's error for Page.enable itself reaches the client.
    keeperAnswer = answerKeeper;
    await announce(c, "S4", "T4");
    c.send({ id: 10, method: "Page.enable", sessionId: "S4" });
    await until(() => received.length === 4);
    c.emit({ id: received[3].id, error: { code: -32001, message: "Session with given id not found." }, sessionId: "S4" });
    await until(() => c.messages.length === 8);
    expect(c.messages[7]).toEqual({ id: 10, error: { code: -32001, message: "Session with given id not found." }, sessionId: "S4" });
    await Bun.sleep(20);
    expect(c.messages.filter((m) => m.id !== undefined).map((m) => m.id)).toEqual([7, 8, 9, 10]);
    // The keeper session whose emulation failed is detached again.
    expect(keeperDid().slice(2)).toEqual(["attach T2", "attach T3", "emulate T3", "detach T3", "attach T4", "emulate T4"]);
    expect(await stat("focus.keeper.failed")).toBe(failed + 2);
    expect(keeper.status()).toEqual({ inUse: 4, emulated: 2 });
    await c.close();
    await until(() => keeperReceived.length === 10);
    expect(keeperDid().slice(8).toSorted()).toEqual(["detach T1", "detach T4"]);
  });

  test("enable and disable for a tab run in order: on, off, on ends on; off last ends off", async () => {
    keeperAnswer = () => undefined;
    const a = await connect();
    await announce(a, "A1", "T2");
    a.send({ id: 1, method: "Page.enable", sessionId: "A1" });
    await until(() => keeperReceived.length === 1);
    await a.close();
    const b = await connect();
    await announce(b, "B1", "T2");
    b.send({ id: 1, method: "Page.enable", sessionId: "B1" });
    await until(() => received.length === 2);
    b.emit({ id: received[1].id, result: {}, sessionId: "B1" });
    keeperAnswer = answerKeeper;
    keeperSessions.set("KO", "T2");
    keeperSockets.at(-1)!.send(JSON.stringify({ id: keeperReceived[0].id, result: { sessionId: "KO" } }));
    await until(() => b.messages.length === 2);
    expect(b.messages[1]).toEqual({ id: 1, result: {}, sessionId: "B1" });
    await Bun.sleep(20);
    expect(keeperDid()).toEqual(["attach T2", "emulate T2"]);
    expect(keeper.status()).toEqual({ inUse: 1, emulated: 1 });
    await b.close();
    await until(() => keeperReceived.length === 3);
    expect(keeperDid()[2]).toBe("detach T2");
  });

  test("no keeper for iframes, workers and other non-page targets; their Page.enable passes through", async () => {
    const { messages, send, emit, close } = await connect();
    const types = ["iframe", "worker", "service_worker", "shared_worker", "browser_ui", "tab"];
    types.forEach((type, i) => emit(attached(`N${i}`, `NT${i}`, type)));
    await until(() => messages.length === types.length);
    types.forEach((_, i) => send({ id: i + 1, method: "Page.enable", sessionId: `N${i}` }));
    // Page.enable on the browser socket's own session.
    send({ id: 99, method: "Page.enable" });
    await until(() => received.length === types.length + 1);
    expect(received.map((m) => m.id)).toEqual([...types.map((_, i) => i + 1), 99]);
    for (const m of received) emit({ id: m.id, result: {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
    await until(() => messages.length === types.length * 2 + 1);
    await Bun.sleep(20);
    expect(keeperReceived).toHaveLength(0);
    await close();
  });

  test("client-attached sessions keep the type of Chrome's attachedToTarget event; without one they count as pages", async () => {
    const c = await connect();
    c.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "W1", flatten: true } });
    c.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "T3", flatten: true } });
    await until(() => received.length === 2);
    c.emit(attached("SW", "W1", "worker"));
    c.emit({ id: 1, result: { sessionId: "SW" } });
    c.emit({ id: 2, result: { sessionId: "S3" } });
    await until(() => c.messages.length === 3);
    await enablePage(c, 3, "SW");
    await enablePage(c, 4, "S3");
    await Bun.sleep(20);
    expect(keeperDid()).toEqual(["attach T3", "emulate T3"]);
    await c.close();
    await until(() => keeperReceived.length === 3);
  });

  test("a page socket's own session counts", async () => {
    const c = await connect("/devtools/page/T1");
    expect(await enablePage(c, 1)).toEqual({ id: 1, result: {} });
    expect(received[0].sessionId).toBeUndefined();
    expect(keeperDid()).toEqual(["attach T1", "emulate T1"]);
    await c.close();
    await until(() => keeperReceived.length === 3);
    expect(keeperDid()[2]).toBe("detach T1");
  });

  test("the keeper's state is cleared when its connection drops, and the tabs still in use are emulated again", async () => {
    const ended = await stat("focus.keeper.ended");
    const c = await connect();
    await announce(c, "S1", "T1");
    await enablePage(c, 1, "S1");
    expect(keeperDid()).toEqual(["attach T1", "emulate T1"]);
    const connected = keeperSockets.length;
    keeperSockets.at(-1)!.close();
    await until(() => keeper.status().emulated === 0);
    expect(keeper.status()).toEqual({ inUse: 1, emulated: 0 });
    expect(await stat("focus.keeper.ended")).toBe(ended + 1);
    await until(() => keeperSockets.length === connected + 1 && keeperReceived.length === 4);
    expect(keeperDid()).toEqual(["attach T1", "emulate T1", "attach T1", "emulate T1"]);
    expect(keeper.status()).toEqual({ inUse: 1, emulated: 1 });
    const session = keeperReceived[3].sessionId;
    expect(session).not.toBe(keeperReceived[1].sessionId);
    await c.close();
    await until(() => keeperReceived.length === 5);
    expect(keeperReceived[4]).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: session } });
  });

  test("a keeper session that Chrome ends (the tab closed) is forgotten", async () => {
    const ended = await stat("focus.keeper.ended");
    const c = await connect();
    await announce(c, "S1", "T2");
    await enablePage(c, 1, "S1");
    const session = keeperReceived[1].sessionId;
    keeperSockets.at(-1)!.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: session, targetId: "T2" } }));
    await until(() => keeper.status().emulated === 0);
    await c.close();
    await Bun.sleep(20);
    expect(keeperDid()).toEqual(["attach T2", "emulate T2"]);
    expect(keeper.status()).toEqual({ inUse: 0, emulated: 0 });
    expect(await stat("focus.keeper.ended")).toBe(ended + 1);
  });
});

describe("holds", () => {
  const holdUrl = (id: string, ttl?: string) => `${base}/__humanize/hold/${id}${ttl === undefined ? "" : `?ttl=${ttl}`}`;
  const hold = (id = TAB, ttl?: string) => fetch(holdUrl(id, ttl), { method: "PUT" });
  const unhold = (id = TAB) => fetch(holdUrl(id), { method: "DELETE" });
  const refusal = (id: number, sessionId?: string) => ({ id, error: TAKEN_OVER, ...(sessionId ? { sessionId } : {}) });
  /** A client with page sessions S1 on the held-to-be tab and S2 on T2. */
  async function client() {
    const c = await connect();
    c.emit(attached("S1", TAB, "page"));
    c.emit(attached("S2", "T2", "page"));
    await until(() => c.messages.length === 2);
    return c;
  }
  /** The proxy's own commands answered so far: each gets one answer. */
  const answered = new Set<number>();
  /** Answers the proxy's own commands with {} until `done`; leaves the ones that arrive after it unanswered. */
  async function answerUntil(c: Awaited<ReturnType<typeof connect>>, done: () => boolean) {
    for (let i = 0; i < 500 && !done(); i++) {
      for (const m of received) {
        if (m.id < 1_000_000_000 || answered.has(m.id)) continue;
        answered.add(m.id);
        c.emit({ id: m.id, result: {}, sessionId: m.sessionId });
      }
      await Bun.sleep(2);
    }
    expect(done()).toBe(true);
  }

  beforeEach(() => {
    holds.release(TAB);
    answered.clear();
  });

  test("set, renew, expire and release; health counts the tabs held", async () => {
    const before = await health();
    const res = await hold();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, targetId: TAB, expiresIn: 15 });
    expect((await health()).holds).toBe(1);
    expect(await (await hold(TAB, "5")).json()).toEqual({ ok: true, targetId: TAB, expiresIn: 5 });
    now += 4999;
    expect((await health()).holds).toBe(1);
    now += 1;
    expect((await health()).holds).toBe(0);
    expect((await hold()).status).toBe(200);
    expect(await (await unhold()).json()).toEqual({ ok: true, targetId: TAB });
    expect((await unhold()).status).toBe(200);
    const after = await health();
    expect(after.holds).toBe(0);
    const delta = (name: string) => (after.stats[name] ?? 0) - (before.stats[name] ?? 0);
    expect(["hold.set", "hold.renewed", "hold.expired", "hold.released"].map(delta)).toEqual([2, 1, 1, 1]);
  });

  test("bad target ids and ttls are refused", async () => {
    for (const id of ["T1", TAB.toLowerCase(), TAB.slice(1), `${TAB}0`, "%41"]) expect((await hold(id)).status).toBe(400);
    expect((await unhold("T1")).status).toBe(400);
    for (const ttl of ["0", "61", "1.5", "-1", "", "abc"]) expect((await hold(TAB, ttl)).status).toBe(400);
    expect((await hold(TAB, "1")).status).toBe(200);
    expect((await hold(TAB, "60")).status).toBe(200);
    expect((await fetch(holdUrl(TAB))).status).toBe(404);
    expect((await health()).holds).toBe(1);
  });

  test("actions on a held tab are refused; reads, other tabs and released tabs pass through", async () => {
    const c = await client();
    const refused0 = await stat("hold.refused");
    expect((await hold()).status).toBe(200);
    const actions = [
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 10, y: 10 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a" } },
      { method: "Input.insertText", params: { text: "secret" } },
      { method: "Input.dispatchTouchEvent", params: { type: "touchStart", touchPoints: [] } },
      { method: "Input.dispatchDragEvent", params: { type: "dragEnter", x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } } },
      { method: "Input.synthesizeScrollGesture", params: { x: 1, y: 1 } },
      { method: "Page.navigate", params: { url: "https://example.com/" } },
      { method: "Page.reload" },
      { method: "Page.navigateToHistoryEntry", params: { entryId: 1 } },
      { method: "Page.close" },
      { method: "Runtime.callFunctionOn", params: { functionDeclaration: FOCUS_SOURCE, objectId: "o1" } },
      { method: "Runtime.callFunctionOn", params: { functionDeclaration: CLEAR_SOURCE, objectId: "o1" } },
      { method: "Runtime.callFunctionOn", params: { functionDeclaration: SCROLL_ELEMENT_SOURCE, objectId: "o1", arguments: [{ value: 0 }, { value: 200 }] } },
      { method: "Runtime.evaluate", params: { expression: "window.scrollBy(0, 300)" } },
      { method: "Target.closeTarget", params: { targetId: TAB } },
    ];
    actions.forEach((m, i) => c.send({ id: i + 1, ...m, sessionId: "S1" }));
    // Target.closeTarget naming the held tab, on the browser session.
    c.send({ id: 50, method: "Target.closeTarget", params: { targetId: TAB } });
    await until(() => c.messages.length === 2 + actions.length + 1);
    expect(c.messages.slice(2)).toEqual([...actions.map((_, i) => refusal(i + 1, "S1")), refusal(50)]);
    expect(await stat("hold.refused")).toBe(refused0 + actions.length + 1);

    const reads = [
      { id: 60, method: "DOM.getDocument", params: { depth: -1 }, sessionId: "S1" },
      { id: 61, method: "Accessibility.getFullAXTree", sessionId: "S1" },
      { id: 62, method: "Page.captureScreenshot", params: { format: "png" }, sessionId: "S1" },
      { id: 63, method: "Runtime.evaluate", params: { expression: "document.title" }, sessionId: "S1" },
      { id: 64, method: "Runtime.callFunctionOn", params: { functionDeclaration: "function() { return this.innerText || ''; }", objectId: "o1" }, sessionId: "S1" },
      { id: 65, method: "Input.dispatchTouchEvent", params: { type: "touchStart", touchPoints: [] }, sessionId: "S2" },
      { id: 66, method: "Target.closeTarget", params: { targetId: "T2" } },
    ];
    for (const m of reads) c.send(m);
    await until(() => received.length === reads.length);
    expect(received).toEqual(reads);

    expect((await unhold()).status).toBe(200);
    c.send({ id: 70, method: "Page.navigate", params: { url: "https://example.com/" }, sessionId: "S1" });
    await until(() => received.length === reads.length + 1);
    expect(received.at(-1)).toEqual({ id: 70, method: "Page.navigate", params: { url: "https://example.com/" }, sessionId: "S1" });
    await c.close();
  });

  test("typing in progress stops when the hold starts, and the keys it holds down are released", async () => {
    const c = await client();
    const interrupted = await stat("hold.interrupted");
    c.send({ id: 1, method: "Input.insertText", params: { text: "Ab" }, sessionId: "S1" });
    const down = (key: string) => received.find((m) => m.method === "Input.dispatchKeyEvent" && m.params.type.endsWith("eyDown") && m.params.key === key);
    await answerUntil(c, () => !!down("A"));
    expect(down("Shift")).toBeDefined();
    const sent = received.length;
    expect((await hold()).status).toBe(200);
    await until(() => received.length === sent + 2);
    expect(received.slice(sent).map((m) => `${m.params.type} ${m.params.key} ${m.sessionId}`)).toEqual(["keyUp A S1", "keyUp Shift S1"]);
    // Chrome answers the key that was on its way; the sequence sends nothing more and the client gets the refusal.
    c.emit({ id: down("A").id, result: {}, sessionId: "S1" });
    await until(() => c.messages.length === 3);
    expect(c.messages[2]).toEqual(refusal(1, "S1"));
    await Bun.sleep(20);
    expect(received).toHaveLength(sent + 2);
    expect(await stat("hold.interrupted")).toBe(interrupted + 1);
    await c.close();
  });

  test("a pointer path stops at its next step; a button pressed before the hold is released", async () => {
    const c = await client();
    // A press: the pointer travels there along a path, and the button goes down.
    c.send({ id: 1, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 100, y: 100, button: "left", buttons: 1, clickCount: 1 }, sessionId: "S1" });
    await answerUntil(c, () => c.messages.length === 3);
    expect(c.messages[2]).toEqual({ id: 1, result: {}, sessionId: "S1" });
    const press = received.find((m) => m.params?.type === "mousePressed")!;
    const sent = received.length;
    expect((await hold()).status).toBe(200);
    await until(() => received.length === sent + 1);
    expect(received[sent]).toMatchObject({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: press.params.x, y: press.params.y, button: "left", buttons: 0 }, sessionId: "S1" });
    c.send({ id: 2, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 100, y: 100, button: "left", buttons: 0, clickCount: 1 }, sessionId: "S1" });
    await until(() => c.messages.length === 4);
    expect(c.messages[3]).toEqual(refusal(2, "S1"));
    expect((await unhold()).status).toBe(200);

    // A move on its way when the hold starts.
    c.send({ id: 3, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 400, y: 300 }, sessionId: "S1" });
    const moves = () => received.slice(sent + 1).filter((m) => m.params?.type === "mouseMoved");
    await answerUntil(c, () => moves().length === 3);
    const before = received.length;
    expect((await hold()).status).toBe(200);
    c.emit({ id: received.at(-1).id, result: {}, sessionId: "S1" });
    await until(() => c.messages.length === 5);
    expect(c.messages[4]).toEqual(refusal(3, "S1"));
    await Bun.sleep(20);
    expect(received).toHaveLength(before);
    await c.close();
  });

  test("a released owner's tabs stay while a person holds one of them", async () => {
    const { messages, send, emit, close } = await connect("/devtools/browser/abc", "pa-held");
    send({ id: 7, method: "Target.createTarget", params: { url: "about:blank" } });
    await until(() => received.length === 1);
    emit({ id: 7, result: { targetId: TAB } });
    await until(() => messages.length === 1);
    targets.push(TAB);
    expect((await hold()).status).toBe(200);
    await close();
    await fetch(`${base}/__humanize/lease/pa-held`, { method: "DELETE" });
    await tabs.check();
    expect(tabsClosed).not.toContain(TAB);
    expect((await unhold()).status).toBe(200);
    await fetch(`${base}/__humanize/lease/pa-held`, { method: "DELETE" });
    await until(() => tabsClosed.includes(TAB));
    targets.pop();
  });
});
