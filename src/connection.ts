// One DevTools client connection and its upstream connection to Chrome: session tracking, Runtime hiding, the tabs
// it uses for focus emulation, background tabs, holds, and routing of input commands to the humanizer. Message bodies
// are never logged.
import { Pressed, TAKEN_OVER, isAction } from "./hold.ts";
import { InputState, type Cdp, type Humanizer } from "./humanize.ts";
import { count } from "./stats.ts";

export interface Socket {
  send(text: string): void;
  close(): void;
}

/** Focus emulation, owned by the focus keeper; a connection only says which targets it uses. */
export interface Focus {
  retain(targetId: string): Promise<void>;
  release(targetId: string): void;
}

/** Ids of the proxy's own commands. agent-browser counts its ids up from 1. */
const FIRST_PROXY_ID = 1_000_000_000;
/** Events that change which session belongs to which target. */
const TARGET_EVENTS = new Set(["Target.attachedToTarget", "Target.detachedFromTarget", "Target.targetDestroyed", "Target.targetCreated"]);

export class CdpError extends Error {
  constructor(readonly error: { code: number; message: string }) {
    super(`CDP error ${error.code}`);
  }
}

class Session {
  /** The client sent Runtime.enable (and not Runtime.disable since). */
  wantsRuntime = false;
  /** Runtime is really enabled on this session, by the proxy. */
  runtimeOn = false;
  /** A page session on which the client sent Page.enable. */
  pageEnabled = false;
  input = new InputState();
  /** What the proxy pressed on this session and has not released. */
  pressed = new Pressed();
  queue: Promise<unknown> = Promise.resolve();
  /** `type` is the target's type ("page", "iframe", "worker", ...) when known. */
  constructor(readonly targetId?: string, readonly type?: string) {}

  /** Not known to be anything but a page. */
  get maybePage() {
    return this.type === undefined || this.type === "page";
  }
}

interface Pending {
  session: string;
  resolve(result: any): void;
  reject(error: Error): void;
}

/** What the connection reports about tabs. */
export interface TabEvents {
  created?(targetId: string): void;
  opened?(targetId: string, openerId: string): void;
  used?(targetId: string): void;
}

export class Connection {
  private nextId = FIRST_PROXY_ID;
  private pending = new Map<number, Pending>();
  private attaching = new Map<number, string>(); // client Target.attachToTarget id -> targetId
  private creating = new Set<number>(); // client Target.createTarget ids
  private sessions = new Map<string, Session>(); // "" is the socket's own session
  private runtimeTargets = new Set<string>(); // targets whose Runtime the control API turned on
  private focusTargets = new Set<string>(); // targets retained with the focus keeper
  private closed = false;

  /**
   * `tabs` hears of every tab the client creates (`created`), of tabs its pages open themselves (`opened`, with the
   * tab that opened them) and of every tab it uses; `held` says whether a person has taken over a tab.
   */
  constructor(
    path: string,
    private client: Socket,
    private upstream: Socket,
    private humanizer: Humanizer,
    private focus: Focus,
    private tabs: TabEvents = {},
    private held: (targetId: string) => boolean = () => false,
  ) {
    const page = /^\/devtools\/page\/([^/?]+)/.exec(path)?.[1];
    this.sessions.set("", new Session(page, page ? "page" : "browser"));
  }

  fromClient(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.upstream.send(text);
    }
    if (typeof msg?.id !== "number" || typeof msg.method !== "string") return this.upstream.send(text);
    const key: string = msg.sessionId ?? "";
    const session = this.session(key);
    if (session.targetId) this.tabs.used?.(session.targetId);
    // Actions on a tab a person has taken over wait until they hand it back; reading it goes on.
    const target = msg.method === "Target.closeTarget" ? msg.params?.targetId : session.targetId;
    if (typeof target === "string" && this.held(target) && isAction(msg.method, msg.params)) {
      count("hold.refused");
      return this.reply(msg, undefined, new CdpError(TAKEN_OVER));
    }
    if (msg.method === "Runtime.enable" || msg.method === "Runtime.disable") {
      session.wantsRuntime = msg.method === "Runtime.enable";
      count(`${msg.method}.answered`);
      this.reply(msg, {});
      return this.reconcile(key, session);
    }
    if (msg.method === "Page.enable") return this.enablePage(msg, text, key, session);
    // Agent tabs never change what is on screen: they open in the background and are not brought to the front.
    if (msg.method === "Page.bringToFront") {
      count("Page.bringToFront.answered");
      return this.reply(msg, {});
    }
    const p = msg.params;
    if (msg.method === "Target.createTarget") this.creating.add(msg.id);
    if (msg.method === "Target.createTarget" && typeof p === "object" && p && p.newWindow !== true && p.background === undefined && p.focus !== true) {
      count("target.background");
      return this.upstream.send(JSON.stringify({ ...msg, params: { ...p, background: true } }));
    }
    if (msg.method === "Target.attachToTarget" && typeof msg.params?.targetId === "string") {
      this.attaching.set(msg.id, msg.params.targetId);
    }
    const job = this.humanizer.match(msg.method, msg.params);
    if (!job) return this.upstream.send(text);
    // Input in progress when a hold starts stops at its next step.
    const cdp: Cdp = {
      send: (method, params) => {
        if (session.targetId && this.held(session.targetId)) return Promise.reject(new CdpError(TAKEN_OVER));
        session.pressed.note(method, params);
        return this.command(key, method, params);
      },
    };
    const run = session.queue.then(() => job(cdp, session.input));
    session.queue = run.catch(() => undefined);
    run.then(
      (result) => this.reply(msg, result),
      (error) => {
        if (error instanceof CdpError && error.error === TAKEN_OVER) count("hold.interrupted");
        this.reply(msg, undefined, error);
      },
    );
  }

  private opened(info: { targetId?: unknown; type?: unknown; openerId?: unknown } | undefined) {
    if (info?.type === "page" && typeof info.targetId === "string" && typeof info.openerId === "string") this.tabs.opened?.(info.targetId, info.openerId);
  }

  fromUpstream(text: string) {
    // Most traffic is forwarded without parsing: Chrome writes "id" or "method" first.
    const head = text.slice(0, 80);
    const id = /^\{"id":(\d+)/.exec(head)?.[1];
    if (id !== undefined && !this.pending.has(Number(id)) && !this.attaching.has(Number(id)) && !this.creating.has(Number(id))) return this.client.send(text);
    const method = /^\{"method":"([^"]+)"/.exec(head)?.[1];
    if (method !== undefined && !TARGET_EVENTS.has(method)) return this.client.send(text);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.client.send(text);
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        return msg.error ? pending.reject(new CdpError(msg.error)) : pending.resolve(msg.result ?? {});
      }
      if (this.creating.delete(msg.id)) {
        if (typeof msg.result?.targetId === "string") this.tabs.created?.(msg.result.targetId);
        return this.client.send(text);
      }
      // Chrome sends Target.attachedToTarget, with the target's type, before this response; keep that session.
      const targetId = this.attaching.get(msg.id);
      this.attaching.delete(msg.id);
      const sessionId = msg.result?.sessionId;
      if (targetId && typeof sessionId === "string" && !this.sessions.has(sessionId)) this.sessions.set(sessionId, new Session(targetId));
    } else if (msg.method === "Target.targetCreated") {
      this.opened(msg.params?.targetInfo);
    } else if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = msg.params ?? {};
      this.opened(targetInfo);
      if (typeof sessionId === "string") this.sessions.set(sessionId, new Session(targetInfo?.targetId, targetInfo?.type));
    } else if (msg.method === "Target.detachedFromTarget") {
      this.drop(msg.params?.sessionId);
    } else if (msg.method === "Target.targetDestroyed") {
      for (const [key, s] of this.sessions) if (key && s.targetId === msg.params?.targetId) this.drop(key);
    }
    this.client.send(text);
  }

  /** Turns the Runtime domain on or off for every session of `targetId`; returns how many sessions that target has. */
  setRuntime(targetId: string, on: boolean): number {
    const sessions = [...this.sessions].filter(([, s]) => s.targetId === targetId);
    if (!sessions.length) return 0;
    if (on) this.runtimeTargets.add(targetId);
    else this.runtimeTargets.delete(targetId);
    for (const [key, s] of sessions) this.reconcile(key, s);
    return sessions.length;
  }

  /**
   * A person has taken over `targetId`: releases the buttons and keys the proxy holds pressed there, and starts the
   * input state afresh, since the person moves the pointer.
   */
  takenOver(targetId: string) {
    for (const [key, s] of this.sessions) {
      if (s.targetId !== targetId) continue;
      for (const [method, params] of s.pressed.release()) this.command(key, method, params).catch(() => undefined);
      s.input = new InputState();
    }
  }

  hasTarget(targetId: string) {
    return [...this.sessions.values()].some((s) => s.targetId === targetId);
  }

  /** Whether the control API has Runtime switched on for `targetId` on this connection. */
  runtimeSwitchedOn(targetId: string) {
    return this.runtimeTargets.has(targetId);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("connection closed"));
    this.pending.clear();
    for (const targetId of this.focusTargets) this.focus.release(targetId);
    this.focusTargets.clear();
    this.client.close();
    this.upstream.close();
  }

  private session(key: string): Session {
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = new Session()));
    return s;
  }

  /** Makes the real Runtime state match: on when the client wants it and the target is switched on. */
  private reconcile(key: string, s: Session) {
    const on = s.wantsRuntime && !!s.targetId && this.runtimeTargets.has(s.targetId);
    if (on === s.runtimeOn) return;
    s.runtimeOn = on;
    count(on ? "runtime.on" : "runtime.off");
    this.command(key, on ? "Runtime.enable" : "Runtime.disable").catch(() => undefined);
  }

  /**
   * Page.enable on a page session. The first one on this connection for its target retains the target with the focus
   * keeper, and the client's answer waits until Chrome has enabled Page and the keeper has emulated focus, so the
   * page loads visible and focused. Any other passes through.
   */
  private enablePage(msg: { id: number; params?: Record<string, unknown>; sessionId?: string }, text: string, key: string, s: Session) {
    const targetId = s.maybePage ? s.targetId : undefined;
    if (!targetId || this.closed) return this.upstream.send(text);
    s.pageEnabled = true;
    if (this.focusTargets.has(targetId)) return this.upstream.send(text);
    this.focusTargets.add(targetId);
    const kept = this.focus.retain(targetId);
    this.command(key, "Page.enable", msg.params).then(
      (result) => kept.then(() => this.reply(msg, result)),
      (error) => kept.then(() => this.reply(msg, undefined, error)),
    );
  }

  private drop(key: unknown) {
    if (typeof key !== "string" || !this.sessions.has(key)) return;
    const targetId = this.sessions.get(key)!.targetId;
    this.sessions.delete(key);
    for (const [id, pending] of this.pending) {
      if (pending.session !== key) continue;
      this.pending.delete(id);
      pending.reject(new Error("session detached"));
    }
    if (!targetId) return;
    if (!this.hasTarget(targetId)) this.runtimeTargets.delete(targetId);
    if (this.focusTargets.has(targetId) && !this.sessions.values().some((s) => s.pageEnabled && s.targetId === targetId)) {
      this.focusTargets.delete(targetId);
      this.focus.release(targetId);
    }
  }

  /** Sends a command of the proxy's own; its response is consumed here. */
  private command(key: string, method: string, params?: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { session: key, resolve, reject });
      this.upstream.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(key ? { sessionId: key } : {}) }));
    });
  }

  private reply(msg: { id: number; sessionId?: string }, result?: object, error?: unknown) {
    if (this.closed) return;
    const body = error
      ? { error: error instanceof CdpError ? error.error : { code: -32000, message: `agent-browser-humanize: ${(error as Error).message}` } }
      : { result };
    this.client.send(JSON.stringify({ id: msg.id, ...body, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
  }
}
