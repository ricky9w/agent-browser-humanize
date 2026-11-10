import { describe, expect, test } from "bun:test";
import { MOD, TYPING_CPS, TYPING_HOLD, keyEvent, modifierBit, planTyping, usKey, type TypingStep } from "../src/keyboard.ts";
import { seeded } from "./helpers.ts";

const keys = (steps: TypingStep[]) => steps.flatMap((s) => ("key" in s ? [{ ...s.key, at: s.at }] : [])) as Record<string, any>[];
const sentence = "The quick brown fox jumps over the lazy dog, then naps. Meet me at 5:30 by the old oak tree near the river bank today ok";

describe("US layout", () => {
  test("letters, digits and shifted symbols", () => {
    expect(usKey("a")).toMatchObject({ code: "KeyA", keyCode: 65, text: "a" });
    expect(usKey("A")).toMatchObject({ code: "KeyA", keyCode: 65, shift: true });
    expect(usKey("7")).toMatchObject({ code: "Digit7", keyCode: 55 });
    expect(usKey("@")).toMatchObject({ code: "Digit2", keyCode: 50, shift: true });
    expect(usKey("!")).toMatchObject({ code: "Digit1", keyCode: 49, shift: true });
    expect(usKey("?")).toMatchObject({ code: "Slash", keyCode: 191, shift: true });
    expect(usKey("'")).toMatchObject({ code: "Quote", keyCode: 222 });
    expect(usKey(" ")).toMatchObject({ code: "Space", keyCode: 32, text: " " });
    expect(usKey("é")).toBeUndefined();
  });

  test("named and modifier keys", () => {
    expect(usKey("Enter")).toMatchObject({ code: "Enter", keyCode: 13, text: "\r" });
    expect(usKey("Tab")?.text).toBeUndefined();
    expect(usKey("Shift")).toMatchObject({ code: "ShiftLeft", keyCode: 16, location: 1 });
    expect(usKey("Meta")).toMatchObject({ code: "MetaLeft", keyCode: 91, location: 1 });
    expect(modifierBit("Shift")).toBe(MOD.Shift);
    expect(modifierBit("a")).toBe(0);
  });

  test("key events: text only without Control/Meta", () => {
    expect(keyEvent("down", usKey("a")!)).toMatchObject({ type: "keyDown", text: "a", unmodifiedText: "a", code: "KeyA" });
    const selectAll = keyEvent("down", usKey("a")!, MOD.Meta, ["selectAll"]);
    expect(selectAll).toMatchObject({ type: "rawKeyDown", modifiers: MOD.Meta, commands: ["selectAll"] });
    expect(selectAll.text).toBeUndefined();
    expect(keyEvent("up", usKey("a")!).type).toBe("keyUp");
  });
});

describe("typing plan", () => {
  test("each character is a key down and up with code and key code", () => {
    const events = keys(planTyping("ab1", seeded(1)));
    expect(events.map((e) => `${e.type}:${e.key}`)).toEqual(expect.arrayContaining(["keyDown:a", "keyUp:a", "keyDown:b", "keyUp:b", "keyDown:1", "keyUp:1"]));
    expect(events.every((e) => e.code && e.windowsVirtualKeyCode)).toBe(true);
  });

  test("Shift is pressed around characters that need it, once per run", () => {
    const events = keys(planTyping("aAB@b", seeded(2)));
    const order = events.map((e) => `${e.type === "keyUp" ? "-" : "+"}${e.key}`);
    expect(order.filter((o) => o.endsWith("Shift"))).toEqual(["+Shift", "-Shift"]);
    const [down, up] = [order.indexOf("+Shift"), order.indexOf("-Shift")];
    expect(down).toBeLessThan(order.indexOf("+A"));
    expect(up).toBeGreaterThan(order.indexOf("-@"));
    expect(up).toBeLessThan(order.indexOf("+b"));
    const shift = events.find((e) => e.key === "Shift")!;
    expect(shift).toMatchObject({ code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1, modifiers: MOD.Shift, type: "rawKeyDown" });
    expect(events.filter((e) => ["A", "B", "@"].includes(e.key as string)).every((e) => e.modifiers === MOD.Shift)).toBe(true);
    expect(events.find((e) => e.key === "@" && e.type === "keyDown")).toMatchObject({ code: "Digit2", windowsVirtualKeyCode: 50, text: "@" });
  });

  test("line breaks and tabs are keys; text without a US key is inserted", () => {
    const steps = planTyping("a\nb\tcafé 中文!", seeded(3));
    const events = keys(steps);
    expect(events.find((e) => e.key === "Enter" && e.type === "keyDown")).toMatchObject({ text: "\r", windowsVirtualKeyCode: 13 });
    expect(events.find((e) => e.key === "Tab" && e.type !== "keyUp")).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 9 });
    expect(steps.flatMap((s) => ("insertText" in s ? [s.insertText] : []))).toEqual(["é", "中文"]);
  });

  test("timing: holds 40-90 ms, no early key-downs, speed around the target", () => {
    const speeds: number[] = [];
    let rollovers = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const events = keys(planTyping(sentence, seeded(seed)));
      const downs = events.filter((e) => e.type !== "keyUp" && e.key !== "Shift");
      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (e.type === "keyUp" || e.key === "Shift") continue;
        const up = events.find((u, j) => j > i && u.type === "keyUp" && u.key === e.key)!;
        const hold = up.at - e.at;
        const next = downs.find((d) => d.at > e.at);
        const rolled = next && up.at > next.at;
        if (rolled) {
          rollovers++;
          expect(next.at - e.at).toBeGreaterThanOrEqual(55);
          expect(/[A-Z]/.test(e.key as string)).toBe(false);
        } else {
          expect(hold).toBeGreaterThanOrEqual(TYPING_HOLD[0] - 1e-9);
          expect(hold).toBeLessThanOrEqual(TYPING_HOLD[1]);
          if (next) expect(next.at - up.at).toBeGreaterThanOrEqual(10 - 1e-9);
        }
      }
      speeds.push((downs.length - 1) / ((downs.at(-1)!.at - downs[0]!.at) / 1000));
    }
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    expect(mean).toBeGreaterThanOrEqual(8);
    expect(mean).toBeLessThanOrEqual(10);
    expect(Math.abs(mean - TYPING_CPS)).toBeLessThan(0.8);
    expect(rollovers).toBeGreaterThan(20);
  });

  test("speed follows the cps setting", () => {
    const span = (cps: number) => keys(planTyping(sentence, seeded(7), cps)).at(-1)!.at;
    expect(span(5)).toBeGreaterThan(span(9) * 1.5);
  });

  test("continues the rhythm after a previous character", () => {
    const first = keys(planTyping("x", seeded(4), TYPING_CPS, "a"))[0]!;
    expect(first.at).toBeGreaterThanOrEqual(55);
    expect(keys(planTyping("x", seeded(4)))[0]!.at).toBe(0);
  });

  test("a different random source gives a different rhythm", () => {
    const times = (seed: number) => keys(planTyping("hello world", seeded(seed))).map((e) => Math.round(e.at));
    expect(times(1)).not.toEqual(times(2));
  });
});
