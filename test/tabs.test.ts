import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBindings, type Binding } from "../src/sessions.ts";
import { SessionTabs } from "../src/tabs.ts";

/** A browser with `tabs` open and agent-browser bindings in `bindings`; records the tabs closed. */
function setup(tabs: string[], bindings: Binding[]) {
  const closed: string[] = [];
  const state = { tabs: tabs as string[] | undefined, bindings, held: new Set<string>() };
  const sessionTabs = new SessionTabs({
    bindings: async () => state.bindings,
    tabs: async () => state.tabs,
    close: async (id) => {
      closed.push(id);
      state.tabs = state.tabs?.filter((t) => t !== id);
    },
    held: (id) => state.held.has(id),
    delay: 1,
    interval: 60_000,
  });
  return { sessionTabs, closed, state };
}

describe("SessionTabs", () => {
  test("closes the tabs a connection created once its session ended with close", async () => {
    const { sessionTabs, closed } = setup(["T0", "T1", "T2"], [{ targetId: "T2", pinned: false }]);
    const created = sessionTabs.open();
    created.add("T1"); // the session's first tab, left when it switched to a new one
    created.add("T2"); // the tab its binding names
    created.end();
    await Bun.sleep(20);
    expect(closed.sort()).toEqual(["T1", "T2"]);
  });

  test("leaves the tabs while the connection is open", async () => {
    const { sessionTabs, closed } = setup(["T1"], [{ targetId: "T1", pinned: false }]);
    sessionTabs.open().add("T1");
    await sessionTabs.check();
    expect(closed).toEqual([]);
  });

  test("keeps the tabs of a session that is still pinned, and closes them once it ends with close", async () => {
    const { sessionTabs, closed, state } = setup(["T1"], [{ targetId: "T1", pinned: true }]);
    const created = sessionTabs.open();
    created.add("T1");
    created.end(); // an idle shutdown or a crash: the binding stays pinned
    await Bun.sleep(20);
    expect(closed).toEqual([]);
    state.bindings = [{ targetId: "T1", pinned: false }]; // a later daemon of the session ran close
    await sessionTabs.check();
    expect(closed).toEqual(["T1"]);
  });

  test("a session that came back to its tab and closed is noticed when its new connection ends", async () => {
    const { sessionTabs, closed, state } = setup(["T1"], [{ targetId: "T1", pinned: true }]);
    const first = sessionTabs.open();
    first.add("T1");
    first.end(); // idle shutdown
    await Bun.sleep(20);
    const second = sessionTabs.open(); // the session again, on the same tab: it creates none
    state.bindings = [{ targetId: "T1", pinned: false }];
    second.end();
    await Bun.sleep(20);
    expect(closed).toEqual(["T1"]);
  });

  test("keeps tabs no binding names: they belong to unpinned sessions or other tools", async () => {
    const { sessionTabs, closed } = setup(["T1"], []);
    const created = sessionTabs.open();
    created.add("T1");
    created.end();
    await Bun.sleep(20);
    expect(closed).toEqual([]);
  });

  test("keeps every tab of a group when one of them is pinned by a session", async () => {
    const { sessionTabs, closed } = setup(["T1", "T2"], [{ targetId: "T1", pinned: false }, { targetId: "T2", pinned: true }]);
    const created = sessionTabs.open();
    created.add("T1");
    created.add("T2");
    created.end();
    await Bun.sleep(20);
    expect(closed).toEqual([]);
  });

  test("keeps every tab of a group while a person holds one of them, and closes them at a check after the hold", async () => {
    const { sessionTabs, closed, state } = setup(["T1", "T2"], [{ targetId: "T2", pinned: false }]);
    state.held.add("T2");
    const created = sessionTabs.open();
    created.add("T1");
    created.add("T2");
    created.end();
    await Bun.sleep(20);
    expect(closed).toEqual([]);
    state.held.clear();
    await sessionTabs.check();
    expect(closed.sort()).toEqual(["T1", "T2"]);
  });

  test("does nothing while Chrome does not answer, and forgets tabs that are gone", async () => {
    const { sessionTabs, closed, state } = setup(["T1"], [{ targetId: "T1", pinned: false }, { targetId: "T2", pinned: false }]);
    const created = sessionTabs.open();
    created.add("T1");
    created.add("T2");
    state.tabs = undefined;
    created.end();
    await Bun.sleep(20);
    expect(closed).toEqual([]);
    state.tabs = ["T1"];
    await sessionTabs.check();
    expect(closed).toEqual(["T1"]);
  });

  test("a close that fails is not retried", async () => {
    let attempts = 0;
    const sessionTabs = new SessionTabs({
      bindings: async () => [{ targetId: "T1", pinned: false }],
      tabs: async () => ["T1"],
      close: async () => {
        attempts++;
        throw new Error("gone");
      },
      delay: 1,
    });
    const created = sessionTabs.open();
    created.add("T1");
    created.end();
    await Bun.sleep(20);
    await sessionTabs.check();
    expect(attempts).toBe(1);
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
