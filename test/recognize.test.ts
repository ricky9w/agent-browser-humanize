import { describe, expect, test } from "bun:test";
import { recognize } from "../src/recognize.ts";

// Verbatim from agent-browser 0.41.2 cli/src/native/interaction.rs, with the indentation each call site uses.
const fillClear = `function() {
                    this.select && this.select();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                }`;
const typeClear = `function() {
                        this.select && this.select();
                        this.value = '';
                        this.dispatchEvent(new Event('input', { bubbles: true }));
                    }`;
const clearCommand = `function() {
                    this.focus();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                    this.dispatchEvent(new Event('change', { bubbles: true }));
                }`;
const call = (functionDeclaration: string, extra: object = {}) => ({ functionDeclaration, objectId: "o1", returnByValue: true, awaitPromise: false, ...extra });

describe("agent-browser 0.41.2 functions", () => {
  test("focus (fill, type, focus)", () => {
    expect(recognize("Runtime.callFunctionOn", call("function() { this.focus(); }"))).toEqual({ kind: "focus", objectId: "o1" });
  });

  test("clear (fill and type --clear)", () => {
    expect(recognize("Runtime.callFunctionOn", call(fillClear))).toEqual({ kind: "clear", objectId: "o1" });
    expect(recognize("Runtime.callFunctionOn", call(typeClear))).toEqual({ kind: "clear", objectId: "o1" });
  });

  test("scroll: element and window", () => {
    const args = { arguments: [{ value: 0 }, { value: 300 }] };
    expect(recognize("Runtime.callFunctionOn", call("function(dx, dy) { this.scrollBy(dx, dy); }", args))).toEqual({ kind: "scroll", dx: 0, dy: 300, objectId: "o1" });
    expect(recognize("Runtime.evaluate", { expression: "window.scrollBy(0, 300)", returnByValue: true })).toEqual({ kind: "scroll", dx: 0, dy: 300 });
    expect(recognize("Runtime.evaluate", { expression: "window.scrollBy(-12.5, 0)" })).toEqual({ kind: "scroll", dx: -12.5, dy: 0 });
  });

  test("anything else passes through", () => {
    expect(recognize("Runtime.callFunctionOn", call(clearCommand))).toBeUndefined();
    expect(recognize("Runtime.callFunctionOn", call("function() { this.focus(); return 1; }"))).toBeUndefined();
    expect(recognize("Runtime.callFunctionOn", call("function() { this.focus(); }", { arguments: [{ value: 1 }] }))).toBeUndefined();
    expect(recognize("Runtime.callFunctionOn", { functionDeclaration: "function() { this.focus(); }" })).toBeUndefined();
    expect(recognize("Runtime.callFunctionOn", call("function(dx, dy) { this.scrollBy(dx, dy); }"))).toBeUndefined();
    expect(recognize("Runtime.evaluate", { expression: "window.scrollBy(0, 300); 1" })).toBeUndefined();
    expect(recognize("Runtime.evaluate", { expression: "window.scrollBy(NaN, inf)" })).toBeUndefined();
    expect(recognize("Runtime.evaluate", { expression: "document.title" })).toBeUndefined();
  });
});
