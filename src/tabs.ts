// Who owns each tab a client created through the proxy, and for how long it is kept.
//
// On a browser it did not start, agent-browser never closes a tab: `close` only disconnects, and a session that is
// forgotten, crashes or loses its host leaves its tabs for good. So the proxy owns their lifetime. Every tab created
// through it belongs to an owner, the one its client named when it connected, and lives as long as the owner's
// lease. Using any of the owner's tabs renews the lease, the control API renews it for an owner that is waiting, and
// a person holding one of the tabs keeps it alive. When the lease runs out, or the owner's agent-browser session
// ended with `close`, the owner's tabs are closed. The record is a file, so it outlives the proxy; a tab Chrome no
// longer has (it was closed, or Chrome restarted) is dropped from it. Tabs without an owner are never closed.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Binding } from "./sessions.ts";
import { count } from "./stats.ts";

/** How long an owner's tabs are kept after they were last used. */
export const LEASE_MS = 60 * 60_000;
const INTERVAL_MS = 60_000;

export interface TabLeasesOptions {
  /** Where the record is kept; without one it lives in memory only. */
  file?: string;
  /** Ids of the browser's tabs; undefined when Chrome does not answer. */
  tabs(): Promise<string[] | undefined>;
  close(targetId: string): Promise<void>;
  /** agent-browser's session bindings: `close` leaves the binding of the session's tab with `pinned: false`. */
  bindings?(): Promise<Binding[]>;
  /** Whether a person has taken over the tab. */
  held?(targetId: string): boolean;
  ttl?: number;
  now?(): number;
  log?: (line: string) => void;
}

export class TabLeases {
  /** Tab to owner. */
  private owners = new Map<string, string>();
  /** Owner to the time its lease ends. */
  private leases = new Map<string, number>();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private now: () => number;
  private ttl: number;

  constructor(private options: TabLeasesOptions) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttl ?? LEASE_MS;
    if (!options.file) return;
    try {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as { tabs?: Record<string, string>; leases?: Record<string, number> };
      this.owners = new Map(Object.entries(saved.tabs ?? {}));
      this.leases = new Map(Object.entries(saved.leases ?? {}));
    } catch {
      // No record yet, or an unreadable one: nothing is owned.
    }
  }

  /** Checks the leases every minute from now on. */
  start() {
    this.timer ??= setInterval(() => void this.check(), INTERVAL_MS);
    this.timer.unref?.();
  }

  get size() {
    return this.owners.size;
  }

  private tabsOf(owner: string) {
    return [...this.owners].filter(([, o]) => o === owner).map(([tab]) => tab);
  }

  private save() {
    const { file } = this.options;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ tabs: Object.fromEntries(this.owners), leases: Object.fromEntries(this.leases) }));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.options.log?.(`could not write the tab record: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** `owner`'s client created `tab`. */
  add(tab: string, owner: string) {
    this.owners.set(tab, owner);
    this.leases.set(owner, this.now() + this.ttl);
    this.save();
  }

  /** A page opened `tab` itself (a popup, a link in a new tab): it belongs to the owner of the tab that opened it. */
  adopt(tab: string, opener: string) {
    const owner = this.owners.get(opener);
    if (owner && !this.owners.has(tab)) this.add(tab, owner);
  }

  /** A client used `tab`: its owner's tabs are kept for another lease. */
  used(tab: string) {
    const owner = this.owners.get(tab);
    if (owner) this.leases.set(owner, this.now() + this.ttl);
  }

  /** Keeps `owner`'s tabs for another lease; returns how many it has. An owner without tabs has no lease. */
  renew(owner: string): number {
    const tabs = this.tabsOf(owner).length;
    if (tabs) this.leases.set(owner, this.now() + this.ttl);
    return tabs;
  }

  /** Ends `owner`'s lease now; returns how many tabs it had. They are closed at once, unless a person holds one. */
  release(owner: string): number {
    const tabs = this.tabsOf(owner).length;
    if (tabs) {
      this.leases.set(owner, 0);
      void this.check();
    }
    return tabs;
  }

  /** Drops tabs Chrome no longer has and closes the tabs of owners whose lease ended; one check at a time. */
  check(): Promise<void> {
    return (this.running ??= this.sweep().finally(() => (this.running = undefined)));
  }

  private async sweep() {
    if (!this.owners.size) return;
    const [live, bindings] = await Promise.all([this.options.tabs(), this.options.bindings?.() ?? []]);
    // Chrome does not answer: nothing is known about its tabs.
    if (!live) return;
    const open = new Set(live);
    for (const tab of this.owners.keys()) if (!open.has(tab)) this.owners.delete(tab);
    const now = this.now();
    for (const owner of new Set(this.owners.values())) {
      const tabs = this.tabsOf(owner);
      if (tabs.some((tab) => this.options.held?.(tab))) {
        this.leases.set(owner, now + this.ttl);
        continue;
      }
      const named = bindings.filter((binding) => tabs.includes(binding.targetId));
      const closed = named.length > 0 && named.every((binding) => !binding.pinned);
      if (!closed && (this.leases.get(owner) ?? 0) > now) continue;
      const done = await Promise.all(tabs.map((tab) => this.options.close(tab).then(() => true, () => false)));
      tabs.forEach((tab, i) => done[i] && this.owners.delete(tab));
      const n = done.filter(Boolean).length;
      count("tabs.closed", n);
      this.options.log?.(`closed ${n} tab(s): ${closed ? "their session ended with close" : "not used for the length of a lease"}`);
    }
    const owning = new Set(this.owners.values());
    for (const owner of this.leases.keys()) if (!owning.has(owner)) this.leases.delete(owner);
    this.save();
  }
}
