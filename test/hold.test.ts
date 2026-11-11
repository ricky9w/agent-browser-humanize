import { describe, expect, test } from "bun:test";
import { Holds, Pressed, isAction } from "../src/hold.ts";
import { CLEAR_SOURCE, FOCUS_SOURCE, SCROLL_ELEMENT_SOURCE } from "../src/recognize.ts";
import { snapshot } from "../src/stats.ts";

const stat = (name: string) => snapshot()[name] ?? 0;

describe("Holds", () => {
  test("set, renew, expire and release", () => {
    let now = 0;
    const holds = new Holds(() => now);
    const [set, renewed, expired, released] = ["hold.set", "hold.renewed", "hold.expired", "hold.released"].map(stat);
    expect(holds.set("A", 5000)).toBe(true);
    now = 4000;
    expect(holds.set("A", 5000)).toBe(false); // renewed: now held until 9000
    now = 8999;
    expect(holds.has("A")).toBe(true);
    expect(holds.size).toBe(1);
    now = 9000;
    expect(holds.size).toBe(0);
    expect(holds.has("A")).toBe(false);
    expect(holds.set("A", 1000)).toBe(true);
    expect(holds.release("A")).toBe(true);
    expect(holds.release("A")).toBe(false);
    expect([stat("hold.set") - set, stat("hold.renewed") - renewed, stat("hold.expired") - expired, stat("hold.released") - released]).toEqual([2, 1, 1, 1]);
  });
});

describe("isAction", () => {
  test("input, navigation, closing and recognized agent-browser functions are actions; reads are not", () => {
    for (const method of ["Input.dispatchMouseEvent", "Input.insertText", "Input.dispatchTouchEvent", "Input.synthesizeTapGesture", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Page.close", "Target.closeTarget"]) {
      expect(isAction(method, {})).toBe(true);
    }
    for (const functionDeclaration of [FOCUS_SOURCE, CLEAR_SOURCE]) expect(isAction("Runtime.callFunctionOn", { functionDeclaration, objectId: "o" })).toBe(true);
    expect(isAction("Runtime.callFunctionOn", { functionDeclaration: SCROLL_ELEMENT_SOURCE, objectId: "o", arguments: [{ value: 0 }, { value: 50 }] })).toBe(true);
    expect(isAction("Runtime.evaluate", { expression: "window.scrollBy(0, 300)" })).toBe(true);
    for (const [method, params] of [
      ["Runtime.evaluate", { expression: "document.title" }],
      ["Runtime.callFunctionOn", { functionDeclaration: "function() { return this.innerText || ''; }", objectId: "o" }],
      ["Page.captureScreenshot", {}],
      ["DOM.getDocument", {}],
      ["Accessibility.getFullAXTree", {}],
      ["Page.enable", undefined],
    ] as const) {
      expect(isAction(method, params)).toBe(false);
    }
  });
});

describe("Pressed", () => {
  test("releases the keys still down, last pressed first, and the buttons still pressed", () => {
    const pressed = new Pressed();
    pressed.note("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1, modifiers: 8 });
    pressed.note("Input.dispatchKeyEvent", { type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A", modifiers: 8 });
    pressed.note("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    pressed.note("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66 });
    pressed.note("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1 });
    pressed.note("Input.dispatchMouseEvent", { type: "mouseMoved", x: 30, y: 40, buttons: 1 });
    expect(pressed.release()).toEqual([
      ["Input.dispatchKeyEvent", { type: "keyUp", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, location: undefined, modifiers: 0 }],
      ["Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 30, y: 40, button: "left", buttons: 0, clickCount: 1 }],
    ]);
    expect(pressed.release()).toEqual([]);
  });

  test("nothing to release after a complete click", () => {
    const pressed = new Pressed();
    pressed.note("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left" });
    pressed.note("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left" });
    expect(pressed.release()).toEqual([]);
  });
});
