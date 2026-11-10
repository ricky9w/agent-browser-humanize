import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { AgentBrowserMonitor } from "../src/agent-browser-check.ts";
import { FocusKeeper } from "../src/focus.ts";
import { Humanizer } from "../src/humanize.ts";
import { startProxy } from "../src/server.ts";
import type { Binding } from "../src/sessions.ts";
import { SessionTabs } from "../src/tabs.ts";
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
const targets = ["T1", "T2", "T3"];
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
const sessionTabs = new SessionTabs({
  bindings: async () => bindings,
  tabs: async () => targets,
  close: async (id) => void tabsClosed.push(id),
  delay: 1,
});
const { server, connections, runtimeTabs } = startProxy({ port: 0, upstream, humanizer: new Humanizer(fakeClock()), agentBrowser, keeper, sessionTabs });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  server.stop(true);
  chrome.stop(true);
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};

async function connect(path = "/devtools/browser/abc") {
  const messages: any[] = [];
  const before = sockets.length;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
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

  test("tabs a client created are closed after its session ended with close", async () => {
    const { messages, send, emit, close } = await connect();
    send({ id: 7, method: "Target.createTarget", params: { url: "about:blank" } });
    await until(() => received.length === 1);
    emit({ id: 7, result: { targetId: "T3" } });
    await until(() => messages.length === 1);
    expect(messages[0]).toEqual({ id: 7, result: { targetId: "T3" } });
    bindings.push({ targetId: "T3", pinned: false });
    await close();
    await until(() => tabsClosed.includes("T3"));
    bindings.length = 0;
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
