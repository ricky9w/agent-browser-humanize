// Turns agent-browser's instant CDP input into human-like input on the same session.
// Only Input.* and the recognised agent-browser functions come here; everything else bypasses this module.
import { MAX_TYPED, MOD, TYPING_CPS, TYPING_HOLD, keyEvent, modifierBit, modifierKeys, planTyping, usKey, type Key } from "./keyboard.ts";
import { CLICK_HOLD, aimPoint, center, centralArea, contains, intersect, pickPoint, planPath, planWheel, quadRect, type Point, type Rect } from "./motion.ts";
import { triangular, uniform, type Rand } from "./random.ts";
import { recognize, type Recognized } from "./recognize.ts";
import { count } from "./stats.ts";

/** Sends a command as the proxy on the session the client used; the response never reaches the client. */
export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random: Rand;
}

export interface HumanizerOptions {
  /** Average typing speed, characters per second. */
  cps?: number;
  /** Whether the browser runs on macOS, where select-all is Meta+A, not Control+A. By default the proxy's platform. */
  macOS?: () => Promise<boolean>;
}

/** A follow-up move within this time (ms) or distance (px) of the last one is part of a path the client draws itself. */
const DENSE_MS = 40, DENSE_PX = 8;
/** Single-character insertText calls closer than this (ms) form one burst (agent-browser `type`). */
const BURST_GAP_MS = 1000;
/** Typing continues the previous rhythm when the last key went down less than this long ago (ms). */
const RHYTHM_MS = 1500;
/** How long an explicit key press is held (ms). */
const PRESS_HOLD = [50, 110] as const;
const UNDEFINED_RESULT = { result: { type: "undefined" } };
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "password", "tel", "url", "number"]);

type Params = Record<string, any>;
export type Job = (cdp: Cdp, state: InputState) => Promise<object>;

/** Input state of one session (one target of one client connection). */
export class InputState {
  /** Where the real pointer is. */
  pointer?: Point;
  /** The client's last move target, and the point the proxy moved to instead. */
  client?: Point;
  chosen?: Point;
  movedAt = -Infinity;
  /** The pressed button: when, and how far the proxy shifted the press from the client's point. */
  press?: { at: number; dx: number; dy: number };
  /** Modifiers held through explicit client key events. */
  heldMods = 0;
  /** Keys the client pressed and has not released, by code. */
  keys = new Map<string, { at: number; modifiers: number; auto: number }>();
  /** Last typed character and when its key went down. */
  prevChar?: string;
  typedAt = -Infinity;
  burst = 0;
  burstAt = -Infinity;
}

const same = (a: Point | undefined, b: Point) => !!a && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
const boxRect = (model: { content: number[]; border: number[] }) => {
  const content = quadRect(model.content);
  return content.right > content.left && content.bottom > content.top ? content : quadRect(model.border);
};

function isTextField(node: { nodeName?: string; attributes?: string[] }): boolean {
  const attrs = new Map<string, string>();
  for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2) attrs.set(node.attributes![i]!.toLowerCase(), node.attributes![i + 1]!);
  if (node.nodeName === "TEXTAREA") return true;
  if (node.nodeName === "INPUT") return TEXT_INPUT_TYPES.has((attrs.get("type") ?? "").toLowerCase());
  const editable = attrs.get("contenteditable");
  return editable !== undefined && editable.toLowerCase() !== "false";
}

export class Humanizer {
  private cps: number;
  private macOS: () => Promise<boolean>;

  constructor(private clock: Clock, { cps = TYPING_CPS, macOS = async () => process.platform === "darwin" }: HumanizerOptions = {}) {
    this.cps = cps;
    this.macOS = macOS;
  }

  /** The job that replaces a client command, or undefined when the command passes through untouched. */
  match(method: string, params: Params = {}): Job | undefined {
    switch (method) {
      case "Input.dispatchMouseEvent":
        return (cdp, s) => this.mouse(cdp, s, params);
      case "Input.dispatchKeyEvent":
        return (cdp, s) => this.key(cdp, s, params);
      case "Input.insertText":
        return (cdp, s) => this.insertText(cdp, s, params);
    }
    const js = recognize(method, params);
    if (!js) return undefined;
    return async (cdp, s) => ((await this.js(cdp, s, js).catch(() => false)) ? UNDEFINED_RESULT : cdp.send(method, params));
  }

  // --- pointer -------------------------------------------------------------------------------------------------

  private async mouse(cdp: Cdp, s: InputState, p: Params): Promise<object> {
    const send = (q: Params) => cdp.send("Input.dispatchMouseEvent", q);
    const point = { x: Number(p.x), y: Number(p.y) };
    switch (p.type) {
      case "mouseMoved": {
        if (s.press || p.buttons) {
          const at = this.mapped(s, point);
          s.pointer = at;
          return send({ ...p, ...at });
        }
        if (this.stillAt(s, point)) {
          count("pointer.stay");
          return {};
        }
        const distance = s.client ? Math.hypot(point.x - s.client.x, point.y - s.client.y) : Infinity;
        if (this.clock.now() - s.movedAt < DENSE_MS || (distance > 0 && distance <= DENSE_PX)) {
          const result = await send(p);
          s.pointer = s.client = s.chosen = point;
          s.movedAt = this.clock.now();
          count("pointer.path.passed");
          return result;
        }
        await this.moveTo(cdp, s, point, p.modifiers);
        return {};
      }
      case "mousePressed": {
        const at = this.stillAt(s, point) ?? (await this.moveTo(cdp, s, point, p.modifiers));
        const force = p.force ?? 0.5;
        for (let n = 1; n < (p.clickCount ?? 1); n++) {
          await send({ ...p, ...at, clickCount: n, force });
          await this.clock.sleep(this.clickHold());
          await send({ ...p, ...at, type: "mouseReleased", clickCount: n, buttons: 0, force: 0 });
          await this.clock.sleep(uniform(this.clock.random, 80, 140));
        }
        const pressedAt = this.clock.now();
        const result = await send({ ...p, ...at, force });
        s.press = { at: pressedAt, dx: at.x - point.x, dy: at.y - point.y };
        count("pointer.press");
        return result;
      }
      case "mouseReleased": {
        const at = this.mapped(s, point);
        if (s.press) await this.sleepUntil(s.press.at + this.clickHold());
        s.press = undefined;
        return send({ ...p, ...at, force: 0 });
      }
      case "mouseWheel": {
        const at = this.stillAt(s, point) ?? (await this.moveTo(cdp, s, point, p.modifiers));
        await this.wheel(cdp, at, Number(p.deltaX ?? 0), Number(p.deltaY ?? 0), p.modifiers);
        return {};
      }
      default:
        return send(p);
    }
  }

  /** Where the proxy put the pointer for this client point, if the pointer is still there. */
  private stillAt(s: InputState, point: Point): Point | undefined {
    return same(s.client, point) && s.chosen && same(s.pointer, s.chosen) ? s.chosen : undefined;
  }

  /** The client's point in real coordinates: shifted like the press while a button is held, else via the last move. */
  private mapped(s: InputState, point: Point): Point {
    if (s.press) return { x: point.x + s.press.dx, y: point.y + s.press.dy };
    return same(s.client, point) ? s.chosen! : point;
  }

  /** Moves along a human path to a point in the element under `target`; returns where the pointer ended up. */
  private async moveTo(cdp: Cdp, s: InputState, target: Point, modifiers?: number): Promise<Point> {
    const chosen = await this.aim(cdp, target);
    await this.path(cdp, s, chosen, modifiers);
    s.client = target;
    s.chosen = chosen;
    s.movedAt = this.clock.now();
    count("pointer.move.humanized");
    return chosen;
  }

  /** A random integer point in the central area of the element at `target`, still hitting that element; else `target` rounded. */
  private async aim(cdp: Cdp, target: Point): Promise<Point> {
    const fallback = { x: Math.round(target.x), y: Math.round(target.y) };
    const hit = await this.hitTest(cdp, fallback);
    const rect = hit === undefined ? undefined : await this.elementRect(cdp, hit);
    if (!rect) return fallback;
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = aimPoint(rect, target, this.clock.random);
      if (!p) break;
      if ((await this.hitTest(cdp, p)) === hit) return p;
    }
    return fallback;
  }

  /** A point in the central area of an element that hits the element itself, or undefined. */
  private async aimAtElement(cdp: Cdp, backendNodeId: number): Promise<Point | undefined> {
    const rect = await this.elementRect(cdp, backendNodeId);
    if (!rect) return undefined;
    const c = center(rect);
    for (const p of [aimPoint(rect, c, this.clock.random), aimPoint(rect, c, this.clock.random), { x: Math.round(c.x), y: Math.round(c.y) }]) {
      if (p && (await this.hitTest(cdp, p)) === backendNodeId) return p;
    }
    return undefined;
  }

  private async hitTest(cdp: Cdp, p: Point): Promise<number | undefined> {
    return (await cdp.send("DOM.getNodeForLocation", { x: p.x, y: p.y }).catch(() => undefined))?.backendNodeId;
  }

  private async elementRect(cdp: Cdp, backendNodeId: number, border = false): Promise<Rect | undefined> {
    const box = await cdp.send("DOM.getBoxModel", { backendNodeId }).catch(() => undefined);
    return box && (border ? quadRect(box.model.border) : boxRect(box.model));
  }

  /** Viewport size, scroll offset and content size in CSS pixels (CDP only, no page script). */
  private async layout(cdp: Cdp) {
    const metrics = await cdp.send("Page.getLayoutMetrics").catch(() => undefined);
    const [v, c] = [metrics?.cssLayoutViewport, metrics?.cssContentSize];
    return v && c ? { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, contentWidth: c.width, contentHeight: c.height } : undefined;
  }

  private async viewport(cdp: Cdp): Promise<Rect | undefined> {
    const l = await this.layout(cdp);
    return l && { left: 0, top: 0, right: l.width, bottom: l.height };
  }

  private async path(cdp: Cdp, s: InputState, to: Point, modifiers?: number) {
    const from = s.pointer ?? (await this.startPoint(cdp, to));
    const start = this.clock.now();
    for (const step of planPath(from, to, this.clock.random)) {
      await this.sleepUntil(start + step.at);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: step.x, y: step.y, ...(modifiers ? { modifiers } : {}) });
      s.pointer = { x: step.x, y: step.y };
    }
  }

  /** Where an unknown pointer starts: somewhere in the viewport, preferably not right next to the target. */
  private async startPoint(cdp: Cdp, to: Point): Promise<Point> {
    const vp = (await this.viewport(cdp)) ?? { left: 0, top: 0, right: to.x * 2 + 1, bottom: to.y * 2 + 1 };
    let p = to;
    for (let i = 0; i < 8; i++) {
      p = { x: Math.round(uniform(this.clock.random, vp.left, vp.right - 1)), y: Math.round(uniform(this.clock.random, vp.top, vp.bottom - 1)) };
      if (Math.hypot(p.x - to.x, p.y - to.y) >= 150) break;
    }
    return p;
  }

  private async click(cdp: Cdp, at: Point) {
    const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1, force: 0.5 });
    await this.clock.sleep(this.clickHold());
    await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0, force: 0 });
  }

  private async wheel(cdp: Cdp, at: Point, dx: number, dy: number, modifiers?: number) {
    for (const step of planWheel(dx, dy, this.clock.random)) {
      await this.clock.sleep(step.wait);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: step.dx, deltaY: step.dy, ...(modifiers ? { modifiers } : {}) });
    }
  }

  // --- keyboard ------------------------------------------------------------------------------------------------

  private async key(cdp: Cdp, s: InputState, p: Params): Promise<object> {
    const send = (q: Params) => cdp.send("Input.dispatchKeyEvent", q);
    const k = typeof p.key === "string" ? usKey(p.key) : undefined;
    const event: Params = { ...p };
    if (k) {
      event.code ||= k.code;
      event.windowsVirtualKeyCode ||= k.keyCode;
      if (k.location && event.location === undefined) event.location = k.location;
    }
    const id = String(event.code || event.key);
    const down = p.type === "keyDown" || p.type === "rawKeyDown";
    const bit = k ? modifierBit(k.key) : 0;
    if (bit) {
      // An explicit modifier key: the event carries its own bit while it is down, as on a real keyboard.
      if (down) s.heldMods |= bit;
      else if (p.type === "keyUp") s.heldMods &= ~bit;
      event.modifiers = s.heldMods | (Number(p.modifiers ?? 0) & ~bit);
    }
    if (down) {
      const modifiers = Number(event.modifiers ?? 0) | s.heldMods | (k?.shift ? MOD.Shift : 0);
      const auto = bit ? 0 : modifiers & ~s.heldMods;
      await this.pressModifiers(cdp, auto, s.heldMods);
      event.modifiers = modifiers;
      s.keys.set(id, { at: this.clock.now(), modifiers, auto });
      count("key.press");
      return send(event);
    }
    if (p.type === "keyUp") {
      const held = s.keys.get(id);
      s.keys.delete(id);
      if (held) {
        await this.sleepUntil(held.at + uniform(this.clock.random, PRESS_HOLD[0], PRESS_HOLD[1]));
        if (!bit) event.modifiers = held.modifiers;
      }
      const result = await send(event);
      if (held?.auto) await this.releaseModifiers(cdp, held.auto, s.heldMods);
      return result;
    }
    return send(event);
  }

  private async pressModifiers(cdp: Cdp, bits: number, held: number) {
    let mods = held;
    for (const [name, bit] of modifierKeys(bits)) {
      mods |= bit;
      await cdp.send("Input.dispatchKeyEvent", keyEvent("down", usKey(name)!, mods));
      await this.clock.sleep(uniform(this.clock.random, 30, 70));
    }
  }

  private async releaseModifiers(cdp: Cdp, bits: number, held: number) {
    let mods = held | bits;
    for (const [name, bit] of modifierKeys(bits).reverse()) {
      await this.clock.sleep(uniform(this.clock.random, 15, 40));
      mods &= ~bit;
      await cdp.send("Input.dispatchKeyEvent", keyEvent("up", usKey(name)!, mods));
    }
  }

  private async insertText(cdp: Cdp, s: InputState, p: Params): Promise<object> {
    const text = String(p.text ?? "");
    const length = [...text].length;
    const now = this.clock.now();
    s.burst = length === 1 ? (now - s.burstAt < BURST_GAP_MS ? s.burst + 1 : 1) : 0;
    try {
      if (!length || length > MAX_TYPED || s.burst > MAX_TYPED) {
        count("text.inserted");
        return await cdp.send("Input.insertText", p);
      }
      const rhythm = s.prevChar !== undefined && now - s.typedAt < RHYTHM_MS;
      const base = rhythm ? s.typedAt : now;
      for (const step of planTyping(text, this.clock.random, this.cps, rhythm ? s.prevChar : undefined)) {
        await this.sleepUntil(base + step.at);
        if ("insertText" in step) {
          await cdp.send("Input.insertText", { text: step.insertText });
          s.typedAt = base + step.at;
        } else {
          await cdp.send("Input.dispatchKeyEvent", step.key);
          if (step.key.type !== "keyUp" && step.key.key !== "Shift") s.typedAt = base + step.at;
        }
      }
      s.prevChar = [...text].at(-1);
      count("text.typed.chars", length);
      return {};
    } finally {
      s.burstAt = this.clock.now();
    }
  }

  /** Presses and releases a key; returns when it went down. */
  private async tap(cdp: Cdp, k: Key, modifiers = 0, commands?: string[]): Promise<number> {
    const at = this.clock.now();
    await cdp.send("Input.dispatchKeyEvent", keyEvent("down", k, modifiers, commands));
    await this.clock.sleep(triangular(this.clock.random, TYPING_HOLD[0], TYPING_HOLD[1], 60));
    await cdp.send("Input.dispatchKeyEvent", keyEvent("up", k, modifiers));
    return at;
  }

  // --- recognised agent-browser functions ----------------------------------------------------------------------

  /** Runs the human replacement; false when it does not apply and the original call should run instead. */
  private js(cdp: Cdp, s: InputState, js: Recognized): Promise<boolean> {
    switch (js.kind) {
      case "focus":
        return this.focusByClick(cdp, s, js.objectId);
      case "clear":
        return this.clearField(cdp, s);
      case "scroll":
        return js.objectId ? this.scrollElement(cdp, s, js.objectId, js.dx, js.dy) : this.scrollWindow(cdp, s, js.dx, js.dy);
    }
  }

  /** Focuses a text field the way a person does: by clicking into it. */
  private async focusByClick(cdp: Cdp, s: InputState, objectId: string): Promise<boolean> {
    const { node } = await cdp.send("DOM.describeNode", { objectId });
    if (!isTextField(node)) return false;
    const backendNodeId = node.backendNodeId;
    let at = await this.aimAtElement(cdp, backendNodeId);
    if (!at) {
      await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      at = await this.aimAtElement(cdp, backendNodeId);
    }
    if (!at) return false;
    await this.path(cdp, s, at);
    s.client = s.chosen = at;
    s.movedAt = this.clock.now();
    await this.click(cdp, at);
    // The click normally focused it; this keeps the original call's effect when it did not (a no-op otherwise).
    await cdp.send("DOM.focus", { backendNodeId }).catch(() => undefined);
    count("fill.focus.click");
    return true;
  }

  /**
   * Empties the focused field with select-all and Backspace. On macOS select-all is Meta+A, and Chrome gets the
   * editing command for a shortcut from the OS there, which CDP key events bypass, so `selectAll` goes with the key.
   * Elsewhere it is Control+A, which Chrome maps to select-all itself.
   */
  private async clearField(cdp: Cdp, s: InputState): Promise<boolean> {
    const r = this.clock.random, mac = await this.macOS();
    const modifier = usKey(mac ? "Meta" : "Control")!, bit = mac ? MOD.Meta : MOD.Control;
    await this.clock.sleep(uniform(r, 150, 300));
    await cdp.send("Input.dispatchKeyEvent", keyEvent("down", modifier, bit));
    await this.clock.sleep(uniform(r, 40, 80));
    await this.tap(cdp, usKey("a")!, bit, mac ? ["selectAll"] : undefined);
    await this.clock.sleep(uniform(r, 20, 50));
    await cdp.send("Input.dispatchKeyEvent", keyEvent("up", modifier, 0));
    await this.clock.sleep(uniform(r, 90, 200));
    s.typedAt = await this.tap(cdp, usKey("Backspace")!);
    s.prevChar = "\b";
    count("fill.clear");
    return true;
  }

  private async scrollWindow(cdp: Cdp, s: InputState, dx: number, dy: number): Promise<boolean> {
    const start = await this.layout(cdp);
    if (!start) return false;
    const view: Rect = { left: 0, top: 0, right: start.width, bottom: start.height };
    let at = await this.pointInto(cdp, s, view);
    if (!at) return false;
    // Where the page can be after a wheel delta, given its edges.
    const clamp = (x: number, y: number) => ({
      x: Math.min(Math.max(x, 0), Math.max(start.contentWidth - start.width, 0)),
      y: Math.min(Math.max(y, 0), Math.max(start.contentHeight - start.height, 0)),
    });
    const off = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const target = clamp(start.x + dx, start.y + dy);
    // The wheel scrolls whatever is under the pointer, and scrolling can bring a scrollable panel under it. When a
    // step did not move the page, move the pointer onto the page itself once and wheel the rest from there.
    let expected: Point = start, steps = planWheel(dx, dy, this.clock.random), moved = false, relocated = false;
    while (steps.length) {
      const step = steps.shift()!;
      await this.clock.sleep(step.wait);
      if (moved) {
        const now = await this.layout(cdp);
        if (!now) break;
        if (off(now, expected) > 2) {
          const elsewhere: Point | undefined = relocated ? undefined : await this.pagePoint(cdp, view, at);
          if (!elsewhere) break;
          relocated = true;
          await this.path(cdp, s, elsewhere);
          at = elsewhere;
          expected = now;
          steps = planWheel(target.x - now.x, target.y - now.y, this.clock.random);
          continue;
        }
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: step.dx, deltaY: step.dy });
      expected = clamp(expected.x + step.dx, expected.y + step.dy);
      moved = true;
    }
    await this.settle();
    // Whatever the wheel did not scroll, window.scrollBy does, as the original call would have.
    const end = (await this.layout(cdp)) ?? start;
    if (off(end, target) >= 1) {
      count("scroll.window.rest");
      await cdp.send("Runtime.evaluate", { expression: `window.scrollBy(${target.x - end.x}, ${target.y - end.y})`, returnByValue: true });
    }
    count(relocated ? "scroll.window.relocated" : "scroll.window");
    return true;
  }

  /** A point in the viewport over the page itself (html or body), away from what is under `from`. */
  private async pagePoint(cdp: Cdp, view: Rect, from: Point): Promise<Point | undefined> {
    const busy = await this.hitTest(cdp, from);
    for (let i = 0; i < 8; i++) {
      const r = this.clock.random;
      const p = { x: Math.round(uniform(r, view.left + 8, view.right - 8)), y: Math.round(uniform(r, view.top + 8, view.bottom - 8)) };
      const hit = await this.hitTest(cdp, p);
      if (hit === undefined || hit === busy) continue;
      const { node } = await cdp.send("DOM.describeNode", { backendNodeId: hit }).catch(() => ({ node: undefined }));
      if (node?.nodeName === "BODY" || node?.nodeName === "HTML") return p;
    }
    return undefined;
  }

  private async scrollElement(cdp: Cdp, s: InputState, objectId: string, dx: number, dy: number): Promise<boolean> {
    const { node } = await cdp.send("DOM.describeNode", { objectId });
    const [rect, vp] = [await this.elementRect(cdp, node.backendNodeId, true), await this.viewport(cdp)];
    const visible = rect && vp && intersect(rect, { left: vp.left + 2, top: vp.top + 2, right: vp.right - 2, bottom: vp.bottom - 2 });
    const at = visible && (await this.pointInto(cdp, s, visible));
    if (!at) return false;
    await this.wheel(cdp, at, dx, dy);
    await this.settle();
    count("scroll.element");
    return true;
  }

  /** Moves the pointer into `area` unless it is already there; returns where it is. */
  private async pointInto(cdp: Cdp, s: InputState, area: Rect): Promise<Point | undefined> {
    if (s.pointer && contains(area, s.pointer)) return s.pointer;
    const to = pickPoint(centralArea(area, Infinity), this.clock.random);
    if (to) await this.path(cdp, s, to);
    return to;
  }

  /** Wheel scrolling may animate; scrollBy had finished when it returned. */
  private settle = () => this.clock.sleep(uniform(this.clock.random, 150, 250));

  // --- timing --------------------------------------------------------------------------------------------------

  private clickHold = () => triangular(this.clock.random, CLICK_HOLD[0], CLICK_HOLD[1], 95);

  private async sleepUntil(time: number) {
    const wait = time - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait);
  }
}
