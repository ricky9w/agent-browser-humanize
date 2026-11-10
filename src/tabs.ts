// Closes the tabs of agent-browser sessions that ended with `close`. On a browser it did not start, agent-browser's
// `close` only disconnects and leaves every tab the session opened. The proxy records the tabs each client connection
// creates; once the connection is gone, its tabs are closed if the session's binding says it was closed
// (`pinned: false`, which only `close` writes) and no binding of a session still pinned names one of them. A session
// that merely went away (idle shutdown, a crash) keeps `pinned: true`, and its tabs stay for it to come back to.
import type { Binding } from "./sessions.ts";
import { count } from "./stats.ts";

/** `close` writes the binding after it disconnects, so the check waits this long after a connection closes. */
const DELAY_MS = 3000;
/** Tabs of sessions closed while no connection of theirs was open are found by a periodic check. */
const INTERVAL_MS = 5 * 60_000;

export interface SessionTabsOptions {
  /** Every session's binding. */
  bindings(): Promise<Binding[]>;
  /** Ids of the browser's tabs; undefined when Chrome does not answer. */
  tabs(): Promise<string[] | undefined>;
  close(targetId: string): Promise<void>;
  delay?: number;
  interval?: number;
  log?: (line: string) => void;
}

/** The tabs one client connection created. */
export interface Created {
  add(targetId: string): void;
  /** The connection closed. */
  end(): void;
}

interface Group {
  tabs: Set<string>;
  open: boolean;
}

export class SessionTabs {
  private groups = new Set<Group>();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private options: SessionTabsOptions) {}

  /** A client connection opened; records the tabs it creates. */
  open(): Created {
    const group: Group = { tabs: new Set(), open: true };
    this.groups.add(group);
    return {
      add: (targetId) => void group.tabs.add(targetId),
      end: () => {
        group.open = false;
        if (!group.tabs.size) this.groups.delete(group);
        // Also when this connection created no tab: it may be a session that came back to its tab and closed.
        if (![...this.groups].some((g) => !g.open)) return;
        setTimeout(() => void this.check(), this.options.delay ?? DELAY_MS);
        this.timer ??= setInterval(() => void this.check(), this.options.interval ?? INTERVAL_MS);
        this.timer.unref?.();
      },
    };
  }

  /** Closes the tabs of ended sessions; one check at a time. */
  check(): Promise<void> {
    return (this.running ??= this.sweep().finally(() => (this.running = undefined)));
  }

  private async sweep() {
    const ended = [...this.groups].filter((group) => !group.open);
    if (!ended.length) return this.stop();
    const [live, bindings] = await Promise.all([this.options.tabs(), this.options.bindings()]);
    if (!live) return;
    const tabs = new Set(live);
    for (const group of ended) {
      for (const id of group.tabs) if (!tabs.has(id)) group.tabs.delete(id);
      const named = bindings.filter((b) => group.tabs.has(b.targetId));
      // No binding: not a pinned agent-browser session; a pinned one: the session may still come back.
      if (group.tabs.size && (!named.length || named.some((b) => b.pinned))) continue;
      this.groups.delete(group);
      if (!group.tabs.size) continue;
      const closing = [...group.tabs].map((id) => this.options.close(id).then(() => 1, () => 0));
      const closed = (await Promise.all(closing)).reduce<number>((n, c) => n + c, 0);
      count("tabs.closed", closed);
      this.options.log?.(`closed ${closed} tab(s) of an agent-browser session that ended with close`);
    }
    if (![...this.groups].some((group) => !group.open)) this.stop();
  }

  private stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
