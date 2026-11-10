import { describe, expect, test } from "bun:test";
import { Humanizer, InputState } from "../src/humanize.ts";
import { MOD } from "../src/keyboard.ts";
import { fakeClock, fakePage, ofType, type Element } from "./helpers.ts";

const button: Element = { id: 7, rect: { left: 32, top: 86.9, right: 88.3, bottom: 102.4 }, nodeName: "BUTTON" };
const input: Element = { id: 9, rect: { left: 80, top: 130, right: 260, bottom: 152 }, nodeName: "INPUT", attributes: ["id", "name", "type", "text"] };
const body: Element = { id: 1, rect: { left: 0, top: 0, right: 1200, bottom: 3000 }, nodeName: "BODY" };

function setup(seed = 1, options: Parameters<typeof fakePage>[2] = {}, macOS = false) {
  const clock = fakeClock(seed);
  const page = fakePage(clock, [body, button, input], options);
  const humanizer = new Humanizer(clock, { macOS: async () => macOS });
  const state = new InputState();
  const run = (method: string, params: Record<string, any>) => humanizer.match(method, params)!(page.cdp, state);
  return { clock, page, humanizer, state, run, sent: page.sent };
}

describe("pointer", () => {
  test("click: human path to a random integer point, 0.5 pressure, 60-140 ms hold", async () => {
    const { run, sent, clock } = setup();
    const center = { x: 60.15, y: 94.65 };
    expect(await run("Input.dispatchMouseEvent", { type: "mouseMoved", ...center })).toEqual({});
    const moves = ofType(sent, "Input.dispatchMouseEvent", "mouseMoved");
    expect(moves.length).toBeGreaterThan(5);
    const end = moves.at(-1)!.params;
    expect(Number.isInteger(end.x) && Number.isInteger(end.y)).toBe(true);
    expect(end.x >= 46 && end.x <= 74 && end.y >= 90 && end.y <= 99).toBe(true);
    await run("Input.dispatchMouseEvent", { type: "mousePressed", ...center, button: "left", buttons: 1, clickCount: 1 });
    const pressAt = clock.time;
    await run("Input.dispatchMouseEvent", { type: "mouseReleased", ...center, button: "left", buttons: 0, clickCount: 1 });
    const [press] = ofType(sent, "Input.dispatchMouseEvent", "mousePressed"), [release] = ofType(sent, "Input.dispatchMouseEvent", "mouseReleased");
    expect(press!.params).toMatchObject({ x: end.x, y: end.y, force: 0.5, clickCount: 1 });
    expect(release!.params).toMatchObject({ x: end.x, y: end.y, force: 0 });
    expect(release!.at - pressAt).toBeGreaterThanOrEqual(60);
    expect(release!.at - pressAt).toBeLessThanOrEqual(140);
  });

  test("a covered point falls back to the client's point, rounded", async () => {
    const { run, sent } = setup();
    await run("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2000.4, y: 5.6 });
    expect(ofType(sent, "Input.dispatchMouseEvent", "mouseMoved").at(-1)!.params).toMatchObject({ x: 2000, y: 6 });
  });

  test("double click becomes two clicks", async () => {
    const { run, sent } = setup();
    const p = { x: 60.15, y: 94.65, button: "left" };
    await run("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await run("Input.dispatchMouseEvent", { ...p, type: "mousePressed", buttons: 1, clickCount: 2 });
    await run("Input.dispatchMouseEvent", { ...p, type: "mouseReleased", buttons: 0, clickCount: 2 });
    const clicks = sent.filter((s) => s.params.type === "mousePressed" || s.params.type === "mouseReleased");
    expect(clicks.map((s) => `${s.params.type}:${s.params.clickCount}`)).toEqual(["mousePressed:1", "mouseReleased:1", "mousePressed:2", "mouseReleased:2"]);
    const gap = clicks[2]!.at - clicks[1]!.at;
    expect(gap >= 80 && gap <= 140).toBe(true);
  });

  test("moves that already form a path pass through; a repeated target does not move again", async () => {
    const { run, sent, clock } = setup();
    await run("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500.5, y: 500.5 });
    const humanized = sent.length;
    for (let i = 1; i <= 5; i++) {
      clock.time += 16;
      await run("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500.5 + i * 3, y: 500.5 });
    }
    const passed = sent.slice(humanized).filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(passed.map((s) => s.params.x)).toEqual([503.5, 506.5, 509.5, 512.5, 515.5]);
    clock.time += 500;
    const before = sent.length;
    await run("Input.dispatchMouseEvent", { type: "mouseMoved", x: 515.5, y: 500.5 });
    expect(sent.length).toBe(before);
  });

  test("wheel deltas over 120 px are split", async () => {
    const { run, sent } = setup();
    await run("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: 500 });
    const wheels = ofType(sent, "Input.dispatchMouseEvent", "mouseWheel");
    expect(wheels.length).toBeGreaterThanOrEqual(4);
    expect(wheels.reduce((a, s) => a + s.params.deltaY, 0)).toBe(500);
  });
});

describe("keyboard", () => {
  test("short text is typed key by key with Shift for symbols", async () => {
    const { run, sent, clock } = setup();
    const start = clock.time;
    expect(await run("Input.insertText", { text: "Hi @you!" })).toEqual({});
    const keys = ofType(sent, "Input.dispatchKeyEvent");
    expect(ofType(sent, "Input.insertText")).toHaveLength(0);
    expect(keys.filter((k) => k.params.key === "Shift").map((k) => k.params.type)).toEqual(["rawKeyDown", "keyUp", "rawKeyDown", "keyUp", "rawKeyDown", "keyUp"]);
    expect(keys.find((k) => k.params.key === "@")!.params).toMatchObject({ code: "Digit2", windowsVirtualKeyCode: 50, modifiers: MOD.Shift });
    const seconds = (clock.time - start) / 1000;
    expect(8 / seconds).toBeGreaterThan(5);
    expect(8 / seconds).toBeLessThan(14);
  });

  test("text over 120 characters is inserted unchanged", async () => {
    const { run, sent } = setup();
    const text = "x".repeat(121);
    await run("Input.insertText", { text });
    expect(sent).toEqual([expect.objectContaining({ method: "Input.insertText", params: { text } })]);
  });

  test("burst guard: single characters after the 120th are inserted without delay", async () => {
    const { run, sent, clock } = setup();
    for (let i = 0; i < 130; i++) await run("Input.insertText", { text: "a" });
    expect(ofType(sent, "Input.dispatchKeyEvent", "keyDown")).toHaveLength(120);
    expect(ofType(sent, "Input.insertText")).toHaveLength(10);
    const tail = clock.time;
    await run("Input.insertText", { text: "b" });
    expect(clock.time).toBe(tail);
  });

  test("press of a shifted symbol: code filled, real Shift around it, held 50-110 ms", async () => {
    const { run, sent } = setup();
    await run("Input.dispatchKeyEvent", { type: "keyDown", key: "@", code: "", text: "@", unmodifiedText: "@", windowsVirtualKeyCode: 0 });
    await run("Input.dispatchKeyEvent", { type: "keyUp", key: "@", code: "", windowsVirtualKeyCode: 0 });
    expect(sent.map((s) => `${s.params.type}:${s.params.key}`)).toEqual(["rawKeyDown:Shift", "keyDown:@", "keyUp:@", "keyUp:Shift"]);
    expect(sent[1]!.params).toMatchObject({ code: "Digit2", windowsVirtualKeyCode: 50, modifiers: MOD.Shift, text: "@" });
    expect(sent[0]!.params).toMatchObject({ code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1 });
    const hold = sent[2]!.at - sent[1]!.at;
    expect(hold >= 50 && hold <= 110).toBe(true);
  });

  test("explicit modifier keys get their code, key code and location", async () => {
    const { run, sent } = setup();
    await run("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift" });
    await run("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await run("Input.dispatchKeyEvent", { type: "keyUp", key: "a" });
    await run("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
    expect(sent[0]!.params).toMatchObject({ code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1, modifiers: MOD.Shift });
    expect(sent[1]!.params.modifiers).toBe(MOD.Shift);
    expect(sent.at(-1)!.params).toMatchObject({ code: "ShiftLeft", modifiers: 0 });
    expect(sent).toHaveLength(4);
  });
});

describe("agent-browser functions", () => {
  const focus = { functionDeclaration: "function() { this.focus(); }", objectId: "obj-9", returnByValue: true };

  test("fill focus becomes a click into the field", async () => {
    const { run, sent } = setup();
    expect(await run("Runtime.callFunctionOn", focus)).toEqual({ result: { type: "undefined" } });
    const press = ofType(sent, "Input.dispatchMouseEvent", "mousePressed")[0]!.params;
    expect(press.x >= 80 && press.x <= 260 && press.y >= 130 && press.y <= 152).toBe(true);
    expect(sent.at(-1)).toMatchObject({ method: "DOM.focus", params: { backendNodeId: 9 } });
    expect(sent.some((s) => s.method === "Runtime.callFunctionOn")).toBe(false);
  });

  test("focus on something that is not a text field runs the original call", async () => {
    const { run, sent } = setup();
    await run("Runtime.callFunctionOn", { ...focus, objectId: "obj-7" });
    expect(sent.at(-1)).toMatchObject({ method: "Runtime.callFunctionOn", params: { objectId: "obj-7" } });
    expect(ofType(sent, "Input.dispatchMouseEvent")).toHaveLength(0);
  });

  const clear = `function() {
                    this.select && this.select();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                }`;

  test("fill clear on a Chrome on macOS becomes Meta+A with the selectAll command, and Backspace", async () => {
    const { run, sent } = setup(1, {}, true);
    expect(await run("Runtime.callFunctionOn", { functionDeclaration: clear, objectId: "obj-9" })).toEqual({ result: { type: "undefined" } });
    expect(sent.map((s) => `${s.params.type}:${s.params.key}`)).toEqual(["rawKeyDown:Meta", "rawKeyDown:a", "keyUp:a", "keyUp:Meta", "rawKeyDown:Backspace", "keyUp:Backspace"]);
    expect(sent[0]!.params).toMatchObject({ code: "MetaLeft", windowsVirtualKeyCode: 91, location: 1, modifiers: MOD.Meta });
    expect(sent[1]!.params).toMatchObject({ code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"], modifiers: MOD.Meta });
    expect(sent[1]!.params.text).toBeUndefined();
    expect(sent[3]!.params.modifiers).toBe(0);
  });

  test("fill clear on a Chrome elsewhere becomes Control+A without commands, and Backspace", async () => {
    const { run, sent } = setup(1, {}, false);
    expect(await run("Runtime.callFunctionOn", { functionDeclaration: clear, objectId: "obj-9" })).toEqual({ result: { type: "undefined" } });
    expect(sent.map((s) => `${s.params.type}:${s.params.key}`)).toEqual(["rawKeyDown:Control", "rawKeyDown:a", "keyUp:a", "keyUp:Control", "rawKeyDown:Backspace", "keyUp:Backspace"]);
    expect(sent[0]!.params).toMatchObject({ code: "ControlLeft", windowsVirtualKeyCode: 17, location: 1, modifiers: MOD.Control });
    expect(sent[1]!.params).toMatchObject({ code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MOD.Control });
    expect(sent[1]!.params.commands).toBeUndefined();
    expect(sent[1]!.params.text).toBeUndefined();
    expect(sent[3]!.params.modifiers).toBe(0);
  });

  test("window scroll becomes a pointer move and wheel steps", async () => {
    const { run, sent } = setup();
    expect(await run("Runtime.evaluate", { expression: "window.scrollBy(0, 300)", returnByValue: true })).toEqual({ result: { type: "undefined" } });
    const wheels = ofType(sent, "Input.dispatchMouseEvent", "mouseWheel");
    expect(wheels.reduce((a, s) => a + s.params.deltaY, 0)).toBe(300);
    expect(ofType(sent, "Input.dispatchMouseEvent", "mouseMoved").length).toBeGreaterThan(0);
    expect(sent.some((s) => s.method === "Runtime.evaluate")).toBe(false);
  });

  test("window scroll moves off a panel that took the wheel and goes on", async () => {
    const panel = { left: 400, top: 300, right: 700, bottom: 500 };
    const clock = fakeClock(3);
    const page = fakePage(clock, [body, { id: 20, rect: panel }], { panel });
    const state = new InputState();
    state.pointer = { x: 500, y: 400 };
    await new Humanizer(clock).match("Runtime.evaluate", { expression: "window.scrollBy(0, 500)" })!(page.cdp, state);
    expect(page.scroll.y).toBe(500);
    expect(page.sent.some((s) => s.method === "Runtime.evaluate")).toBe(false);
    const wheels = ofType(page.sent, "Input.dispatchMouseEvent", "mouseWheel");
    expect(wheels[0]!.params).toMatchObject({ x: 500, y: 400 });
    expect(wheels.slice(1).every((w) => w.params.x < 400 || w.params.x > 700 || w.params.y < 300 || w.params.y > 500)).toBe(true);
  });

  test("window scroll runs the original call when the wheel did not move the page", async () => {
    const { run, sent } = setup(1, { wheelScrollsPage: false });
    await run("Runtime.evaluate", { expression: "window.scrollBy(0, 300)", returnByValue: true });
    expect(sent.at(-1)).toMatchObject({ method: "Runtime.evaluate", params: { expression: "window.scrollBy(0, 300)" } });
  });

  test("unrecognised commands are not handled", () => {
    const { humanizer } = setup();
    expect(humanizer.match("Runtime.evaluate", { expression: "document.title" })).toBeUndefined();
    expect(humanizer.match("Page.navigate", { url: "about:blank" })).toBeUndefined();
  });
});
