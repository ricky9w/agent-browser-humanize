import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBindings, type Binding } from "../src/sessions.ts";
import { TabLeases } from "../src/tabs.ts";

/** A browser with `tabs` open and agent-browser bindings in `bindings`, on a clock of its own; records the tabs closed. */
function setup(tabs: string[], bindings: Binding[] = [], file?: string) {
  const closed: string[] = [];
  const state = {
    tabs: tabs as string[] | undefined,
    bindings,
    held: new Set<string>(),
    now: 0,
    /** Chrome's list of tabs for one test's own timing; otherwise `tabs`. */
    list: undefined as (() => Promise<string[] | undefined>) | undefined,
    close: async (id: string) => {
      closed.push(id);
      state.tabs = state.tabs?.filter((t) => t !== id);
    },
  };
  const open = () =>
    new TabLeases({
      file,
      bindings: async () => state.bindings,
      tabs: async () => (state.list ? state.list() : state.tabs),
      close: (id) => state.close(id),
      held: (id) => state.held.has(id),
      ttl: 1000,
      now: () => state.now,
    });
  return { leases: open(), open, closed, state };
}

describe("TabLeases", () => {
  test("closes an owner's tabs when its lease runs out, and no one else's", async () => {
    const { leases, closed, state } = setup(["T0", "T1", "T2", "T3"]);
    leases.add("T1", "a");
    leases.add("T2", "a");
    state.now = 600;
    leases.add("T3", "b");
    state.now = 999;
    await leases.check();
    expect(closed).toEqual([]);
    state.now = 1000;
    await leases.check();
    expect(closed.sort()).toEqual(["T1", "T2"]);
    expect(leases.size).toBe(1);
  });

  test("using any of an owner's tabs keeps all of them", async () => {
    const { leases, closed, state } = setup(["T1", "T2"]);
    leases.add("T1", "a");
    leases.add("T2", "a");
    state.now = 900;
    leases.used("T2");
    leases.used("T9"); // not an owned tab
    state.now = 1800;
    await leases.check();
    expect(closed).toEqual([]);
    state.now = 1900;
    await leases.check();
    expect(closed.sort()).toEqual(["T1", "T2"]);
  });

  test("a renewed lease keeps the tabs; an owner without tabs has none", async () => {
    const { leases, closed, state } = setup(["T1"]);
    leases.add("T1", "a");
    state.now = 900;
    expect(leases.renew("a")).toBe(1);
    expect(leases.renew("nobody")).toBe(0);
    state.now = 1800;
    await leases.check();
    expect(closed).toEqual([]);
  });

  test("a released owner's tabs are closed at once", async () => {
    const { leases, closed } = setup(["T1", "T2"]);
    leases.add("T1", "a");
    leases.add("T2", "b");
    expect(leases.release("a")).toBe(1);
    await leases.check();
    expect(closed).toEqual(["T1"]);
    expect(leases.release("a")).toBe(0);
  });

  test("a lease that ends while a check is running is not lost in it", async () => {
    const { leases, closed, state } = setup(["T1", "T2"]);
    leases.add("T2", "b");
    leases.add("T1", "a");
    // The check is past b, closing a's tab, when b's lease ends.
    let closing!: () => void;
    const reached = new Promise<void>((resolve) => (closing = resolve));
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const close = state.close;
    state.close = async (id) => {
      closing();
      await held;
      return close(id);
    };
    state.bindings = [{ session: "s", targetId: "T1", pinned: false } as Binding];
    const check = leases.check();
    await reached;
    state.close = close;
    expect(leases.release("b")).toBe(1);
    finish();
    await check;
    expect(closed).toEqual(["T1", "T2"]);
  });

  test("a tab opened while a check waits for Chrome's list is not forgotten", async () => {
    const { leases, closed, state } = setup(["T1"]);
    leases.add("T1", "a");
    // Chrome's answer was made before T2 existed.
    let asked!: () => void;
    const waiting = new Promise<void>((resolve) => (asked = resolve));
    let answer!: (tabs: string[]) => void;
    state.list = () => (asked(), new Promise((resolve) => (answer = resolve)));
    const check = leases.check();
    await waiting;
    leases.add("T2", "b");
    state.list = undefined;
    state.tabs = ["T1", "T2"];
    answer(["T1"]);
    await check;
    expect(leases.release("b")).toBe(1);
    await leases.check();
    expect(closed).toEqual(["T2"]);
  });

  test("a tab a page opened belongs to the owner of the tab that opened it", async () => {
    const { leases, closed, state } = setup(["T1", "T2", "T3"]);
    leases.add("T1", "a");
    leases.adopt("T2", "T1");
    leases.adopt("T3", "T0"); // opened by a tab no one owns
    state.now = 1000;
    await leases.check();
    expect(closed.sort()).toEqual(["T1", "T2"]);
  });

  test("the tabs of a session that ended with close are closed before the lease runs out", async () => {
    const { leases, closed, state } = setup(["T1", "T2"], [{ targetId: "T2", pinned: true }]);
    leases.add("T1", "a"); // the session's first tab, left when it switched to a new one
    leases.add("T2", "a"); // the tab its binding names
    await leases.check();
    expect(closed).toEqual([]);
    state.bindings = [{ targetId: "T2", pinned: false }];
    await leases.check();
    expect(closed.sort()).toEqual(["T1", "T2"]);
  });

  test("a person holding a tab keeps its owner's tabs, for a lease after they let go", async () => {
    const { leases, closed, state } = setup(["T1", "T2"], [{ targetId: "T1", pinned: false }]);
    leases.add("T1", "a");
    leases.add("T2", "a");
    state.held.add("T2");
    state.now = 5000;
    await leases.check();
    expect(closed).toEqual([]);
    state.held.clear();
    state.bindings = [];
    await leases.check();
    expect(closed).toEqual([]);
    state.now = 6000;
    await leases.check();
    expect(closed.sort()).toEqual(["T1", "T2"]);
  });

  test("does nothing while Chrome does not answer, and forgets tabs Chrome no longer has", async () => {
    const { leases, closed, state } = setup(["T1", "T2"]);
    leases.add("T1", "a");
    leases.add("T2", "a");
    state.tabs = undefined;
    state.now = 1000;
    await leases.check();
    expect(closed).toEqual([]);
    expect(leases.size).toBe(2);
    state.tabs = ["T9"]; // Chrome started again
    await leases.check();
    expect(closed).toEqual([]);
    expect(leases.size).toBe(0);
  });

  test("a tab that could not be closed is tried again", async () => {
    let attempts = 0;
    const leases = new TabLeases({
      tabs: async () => ["T1"],
      close: async () => {
        attempts++;
        throw new Error("busy");
      },
      ttl: 1000,
      now: () => 5000,
    });
    leases.add("T1", "a");
    leases.release("a");
    await leases.check();
    await leases.check();
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test("the record outlives the proxy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abh-tabs-"));
    try {
      const first = setup(["T1", "T2"], [], join(dir, "state", "tabs.json"));
      first.leases.add("T1", "a");
      first.leases.add("T2", "b");
      first.state.now = 500;
      first.leases.used("T2");
      await first.leases.check();
      // A new proxy on the same file and the same browser.
      const next = first.open();
      expect(next.size).toBe(2);
      first.state.now = 1200;
      await next.check();
      expect(first.closed).toEqual(["T1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readBindings", () => {
  test("reads the bindings of every namespace and skips files that are not bindings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abh-bindings-"));
    try {
      await mkdir(join(dir, "namespaces", "proj", "run"), { recursive: true });
      await writeFile(join(dir, "a.target"), JSON.stringify({ targetId: "T1", url: "https://example.com/", pinned: true }));
      await writeFile(join(dir, "b.target"), JSON.stringify({ targetId: "T2", url: "about:blank", pinned: false }));
      await writeFile(join(dir, "broken.target"), "{");
      await writeFile(join(dir, "c.sock"), "");
      await writeFile(join(dir, "namespaces", "proj", "run", "a.target"), JSON.stringify({ targetId: "T3", pinned: true }));
      const bindings = await readBindings({ AGENT_BROWSER_SOCKET_DIR: dir });
      expect(bindings.sort((a, b) => a.targetId.localeCompare(b.targetId))).toEqual([
        { targetId: "T1", pinned: true },
        { targetId: "T2", pinned: false },
        { targetId: "T3", pinned: true },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no session directory means no bindings", async () => {
    expect(await readBindings({ AGENT_BROWSER_SOCKET_DIR: "/nonexistent/agent-browser" })).toEqual([]);
  });
});
