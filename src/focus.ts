// The focus keeper: the proxy's own DevTools connection to Chrome, the only session that turns focus emulation on.
// Chrome keeps one focus flag per page and clears it whenever any session that turned it on detaches, so client
// sessions never emulate. The keeper attaches to a tab while at least one client connection has Page enabled on it,
// and detaches when the last one is gone. Message bodies are never logged.
import { count } from "./stats.ts";

/** How long the keeper waits for Chrome: discovery, the WebSocket handshake, each command. */
const TIMEOUT_MS = 5000;
/** Pause before emulating the tabs still in use again after the keeper's connection dropped (Chrome may be quitting). */
const REBUILD_DELAY_MS = 1000;

export interface FocusKeeperOptions {
  timeout?: number;
  rebuildDelay?: number;
  log?: (line: string) => void;
}

interface Target {
  /** Client connections with Page enabled on a page session of the target. */
  refs: number;
  /** The keeper's session on the target while it emulates focus there. */
  sessionId?: string;
  /** Attach and detach run one after another, each for the state wanted when it starts. */
  queue: Promise<void>;
}

/** The keeper's browser-level CDP connection. A command timeout closes it: Chrome is not answering. */
class Browser {
  private nextId = 1;
  private pending = new Map<number, { resolve(result: any): void; reject(error: Error): void }>();
  private closed = false;

  constructor(private ws: WebSocket, private timeout: number, onDetached: (sessionId: string) => void, private onClose: () => void) {
    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending[msg.error ? "reject" : "resolve"](msg.error ? new Error(`CDP error ${msg.error.code}`) : msg.result);
      } else if (msg.method === "Target.detachedFromTarget" && typeof msg.params?.sessionId === "string") {
        onDetached(msg.params.sessionId);
      }
    };
    ws.onclose = () => this.close();
  }

  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error("keeper connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.timeout);
      const settle = <T>(f: (value: T) => void) => (value: T) => (clearTimeout(timer), f(value));
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("keeper connection closed"));
    this.pending.clear();
    this.ws.close();
    this.onClose();
  }
}

export class FocusKeeper {
  private targets = new Map<string, Target>();
  private browser?: Browser;
  private connecting?: Promise<Browser>;
  private timeout: number;
  private rebuildDelay: number;
  private log: (line: string) => void;

  constructor(private upstream: string, { timeout = TIMEOUT_MS, rebuildDelay = REBUILD_DELAY_MS, log = () => {} }: FocusKeeperOptions = {}) {
    this.timeout = timeout;
    this.rebuildDelay = rebuildDelay;
    this.log = log;
  }

  /** A client connection starts using the target. Resolves, never rejects, once the keeper has caught up with it. */
  retain(targetId: string): Promise<void> {
    let t = this.targets.get(targetId);
    if (!t) this.targets.set(targetId, (t = { refs: 0, queue: Promise.resolve() }));
    t.refs++;
    return this.reconcile(targetId, t);
  }

  /** A client connection stops using the target. */
  release(targetId: string) {
    const t = this.targets.get(targetId);
    if (!t?.refs) return;
    t.refs--;
    void this.reconcile(targetId, t);
  }

  /** Targets in use by a client connection, and those the keeper emulates focus on. */
  status() {
    const ts = [...this.targets.values()];
    return { inUse: ts.filter((t) => t.refs > 0).length, emulated: ts.filter((t) => t.sessionId).length };
  }

  private reconcile(targetId: string, t: Target): Promise<void> {
    const run: Promise<void> = t.queue.then(() => this.apply(targetId, t)).then(() => {
      if (t.queue === run && !t.refs && !t.sessionId) this.targets.delete(targetId);
    });
    return (t.queue = run);
  }

  private async apply(targetId: string, t: Target) {
    const wanted = t.refs > 0;
    if (wanted === !!t.sessionId) return;
    if (!wanted) {
      count("focus.keeper.detach");
      return this.detach(t);
    }
    let step = "connect";
    try {
      const browser = await this.connect();
      step = "Target.attachToTarget";
      const { sessionId } = await browser.send(step, { targetId, flatten: true });
      t.sessionId = sessionId;
      step = "Emulation.setFocusEmulationEnabled";
      await browser.send(step, { enabled: true }, sessionId);
      count("focus.keeper.attach");
    } catch (error) {
      count("focus.keeper.failed");
      this.log(`focus keeper: ${step} failed (${(error as Error).message})`);
      await this.detach(t);
    }
  }

  /** Ends the keeper's session on the target, and with it the focus emulation there. */
  private async detach(t: Target) {
    const sessionId = t.sessionId;
    t.sessionId = undefined;
    if (sessionId) await this.browser?.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  private connect(): Promise<Browser> {
    if (this.browser) return Promise.resolve(this.browser);
    return (this.connecting ??= this.open().finally(() => (this.connecting = undefined)));
  }

  private async open(): Promise<Browser> {
    const res = await fetch(`http://${this.upstream}/json/version`, { signal: AbortSignal.timeout(this.timeout) });
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(`ws://${this.upstream}${new URL(webSocketDebuggerUrl).pathname}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (ws.close(), reject(new Error("keeper connection timed out"))), this.timeout);
      ws.onclose = () => (clearTimeout(timer), reject(new Error("keeper connection closed")));
      ws.onopen = () => {
        clearTimeout(timer);
        const browser: Browser = new Browser(ws, this.timeout, (sessionId) => this.detached(sessionId), () => this.dropped(browser));
        this.log("focus keeper connected");
        resolve((this.browser = browser));
      };
    });
  }

  /** The keeper's session ended without the keeper asking, for example because the tab closed. */
  private detached(sessionId: string) {
    for (const t of this.targets.values()) {
      if (t.sessionId !== sessionId) continue;
      t.sessionId = undefined;
      count("focus.keeper.ended");
    }
  }

  /** Chrome dropped every session of the connection. The tabs still in use are emulated again on a new one. */
  private dropped(browser: Browser) {
    if (this.browser !== browser) return;
    this.browser = undefined;
    let lost = 0;
    for (const t of this.targets.values()) if (t.sessionId) (t.sessionId = undefined), lost++;
    if (lost) count("focus.keeper.ended", lost);
    this.log(`focus keeper disconnected, ${lost} tab(s) no longer emulated`);
    setTimeout(() => {
      for (const [targetId, t] of this.targets) if (t.refs > 0 && !t.sessionId) void this.reconcile(targetId, t);
    }, this.rebuildDelay);
  }
}
