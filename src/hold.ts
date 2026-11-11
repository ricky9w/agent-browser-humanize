// Holds: a person has taken over a tab through another DevTools connection, and the agent's actions on it pause.
// A hold expires unless renewed, so a crashed host never locks the agent out for good. Reading the tab goes on.
import { recognize } from "./recognize.ts";
import { count } from "./stats.ts";

/** Chrome's target ids. */
export const TARGET_ID = /^[0-9A-F]{32}$/;
/** The CDP error a client gets for an action on a held tab. */
export const TAKEN_OVER = { code: -32000, message: "The user has taken over this tab. Wait until they hand it back." };

const ACTIONS = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Page.close", "Target.closeTarget"]);

/** Whether a client command acts on a tab: input, navigation, closing, or a recognized agent-browser function. */
export const isAction = (method: string, params: Record<string, any> | undefined) =>
  method.startsWith("Input.") || ACTIONS.has(method) || recognize(method, params) !== undefined;

export class Holds {
  private until = new Map<string, number>();

  constructor(private now: () => number = () => performance.now()) {}

  /** Holds a tab for `ms`, or renews its hold; true when the hold is new. */
  set(targetId: string, ms: number): boolean {
    const fresh = !this.has(targetId);
    this.until.set(targetId, this.now() + ms);
    count(fresh ? "hold.set" : "hold.renewed");
    return fresh;
  }

  /** Ends a hold; false when there was none. */
  release(targetId: string): boolean {
    if (!this.has(targetId)) return false;
    this.until.delete(targetId);
    count("hold.released");
    return true;
  }

  /** Whether the tab is held. An expired hold is forgotten here. */
  has(targetId: string): boolean {
    const until = this.until.get(targetId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(targetId);
    count("hold.expired");
    return false;
  }

  /** The number of tabs held. */
  get size(): number {
    for (const id of [...this.until.keys()]) this.has(id);
    return this.until.size;
  }
}

type Command = [method: string, params: Record<string, unknown>];

/** The mouse buttons and keys the proxy pressed on a session and has not released yet, so a hold can release them. */
export class Pressed {
  private buttons = new Set<string>();
  private keys = new Map<string, Record<string, unknown>>();
  private at = { x: 0, y: 0 };

  note(method: string, p: Record<string, any> = {}) {
    if (method === "Input.dispatchMouseEvent") {
      this.at = { x: Number(p.x), y: Number(p.y) };
      if (p.type === "mousePressed") this.buttons.add(p.button ?? "left");
      if (p.type === "mouseReleased") this.buttons.delete(p.button ?? "left");
    } else if (method === "Input.dispatchKeyEvent") {
      const id = String(p.code || p.key);
      if (p.type === "keyDown" || p.type === "rawKeyDown") {
        const { key, code, windowsVirtualKeyCode, location } = p;
        this.keys.set(id, { key, code, windowsVirtualKeyCode, location });
      } else if (p.type === "keyUp") this.keys.delete(id);
    }
  }

  /** The events that release everything pressed, last pressed first; forgets it all. */
  release(): Command[] {
    const events: Command[] = [
      ...[...this.keys.values()].reverse().map((k): Command => ["Input.dispatchKeyEvent", { type: "keyUp", ...k, modifiers: 0 }]),
      ...[...this.buttons].map((button): Command => ["Input.dispatchMouseEvent", { type: "mouseReleased", ...this.at, button, buttons: 0, clickCount: 1 }]),
    ];
    this.keys.clear();
    this.buttons.clear();
    return events;
  }
}
