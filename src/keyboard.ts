// US keyboard layout and typing plans. Pure: timing and randomness only, no I/O.
import { gaussian, triangular, uniform, type Rand } from "./random.ts";

/** Average typing speed in characters per second (a professional typist). AGENT_BROWSER_HUMANIZE_CPS overrides it. */
export const TYPING_CPS = 9;
/** Longest text that is typed key by key; longer text is inserted in one go. */
export const MAX_TYPED = 120;
/** How long a typed key is held (ms), unless it rolls over into the next key. */
export const TYPING_HOLD = [40, 90] as const;
/** Shortest gap between releasing one key and pressing the next (ms). */
const RELEASE_GAP = 10;
/** Shortest key-down to key-down interval (ms). */
const MIN_INTERVAL = 55;
const ROLLOVER_CHANCE = 0.12;
/** Mean of the pause factors below over ordinary English text, so the average speed stays at the target. */
const EXPECTED_FACTOR = 1.08;

export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

export interface Key {
  key: string;
  code: string;
  keyCode: number;
  /** Needs Shift on a US keyboard. */
  shift?: boolean;
  /** Text the key produces. */
  text?: string;
  location?: number;
}

const layout = new Map<string, Key>();
const add = (k: Key) => layout.set(k.key, k);
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i), upper = lower.toUpperCase();
  add({ key: lower, code: `Key${upper}`, keyCode: 65 + i, text: lower });
  add({ key: upper, code: `Key${upper}`, keyCode: 65 + i, text: upper, shift: true });
}
const shiftedDigits = ")!@#$%^&*(";
for (let d = 0; d < 10; d++) {
  add({ key: String(d), code: `Digit${d}`, keyCode: 48 + d, text: String(d) });
  add({ key: shiftedDigits[d]!, code: `Digit${d}`, keyCode: 48 + d, text: shiftedDigits[d], shift: true });
}
for (const [plain, shifted, code, keyCode] of [
  ["`", "~", "Backquote", 192], ["-", "_", "Minus", 189], ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219], ["]", "}", "BracketRight", 221], ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186], ["'", '"', "Quote", 222], [",", "<", "Comma", 188],
  [".", ">", "Period", 190], ["/", "?", "Slash", 191],
] as const) {
  add({ key: plain, code, keyCode, text: plain });
  add({ key: shifted, code, keyCode, text: shifted, shift: true });
}
add({ key: " ", code: "Space", keyCode: 32, text: " " });
add({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
for (const [key, keyCode] of [
  ["Tab", 9], ["Escape", 27], ["Backspace", 8], ["Delete", 46], ["Insert", 45], ["Home", 36], ["End", 35],
  ["PageUp", 33], ["PageDown", 34], ["ArrowLeft", 37], ["ArrowUp", 38], ["ArrowRight", 39], ["ArrowDown", 40], ["CapsLock", 20],
] as const) add({ key, code: key, keyCode });
for (let f = 1; f <= 12; f++) add({ key: `F${f}`, code: `F${f}`, keyCode: 111 + f });
for (const [key, keyCode] of [["Shift", 16], ["Control", 17], ["Alt", 18], ["Meta", 91]] as const) {
  add({ key, code: `${key}Left`, keyCode, location: 1 });
}

/** A key of the US layout by its `key` value ("a", "@", "Enter", "Shift"). */
export const usKey = (key: string): Key | undefined => layout.get(key);

const MODIFIERS: [string, number][] = [["Control", MOD.Control], ["Alt", MOD.Alt], ["Shift", MOD.Shift], ["Meta", MOD.Meta]];
/** The modifier bit of a modifier key name, or 0. */
export const modifierBit = (key: string) => MODIFIERS.find(([name]) => name === key)?.[1] ?? 0;
/** Modifier keys in a bit field, in pressing order. */
export const modifierKeys = (bits: number) => MODIFIERS.filter(([, bit]) => bits & bit);

export type KeyEvent = Record<string, unknown>;

/** Input.dispatchKeyEvent parameters for a key. Keys without text (or under Control/Meta) go down as rawKeyDown. */
export function keyEvent(type: "down" | "up", k: Key, modifiers = 0, commands?: string[]): KeyEvent {
  const event: KeyEvent = { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers };
  if (k.location) event.location = k.location;
  if (type === "down") {
    const text = modifiers & (MOD.Control | MOD.Meta) ? undefined : k.text;
    event.type = text ? "keyDown" : "rawKeyDown";
    if (text) Object.assign(event, { text, unmodifiedText: text });
    if (commands) event.commands = commands;
  }
  return event;
}

export type TypingStep = { at: number } & ({ key: KeyEvent } | { insertText: string });

/** One keystroke, or a run of characters that has no key on a US keyboard. */
interface Unit {
  key?: Key;
  text: string;
}

function units(text: string): Unit[] {
  const out: Unit[] = [];
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const key = ch === "\n" ? layout.get("Enter") : ch === "\t" ? layout.get("Tab") : ch.length === 1 ? layout.get(ch) : undefined;
    const last = out.at(-1);
    if (key) out.push({ key, text: ch });
    else if (last && !last.key) last.text += ch;
    else out.push({ text: ch });
  }
  return out;
}

/** Pause factor before typing `unit` after the character `before`: longer after spaces, punctuation and line breaks. */
function pauseFactor(unit: Unit, before: string): number {
  let factor = { " ": 1.3, "\n": 2, "\t": 1.6, "\b": 2.2 }[before] ?? (".,;:!?".includes(before) ? 1.8 : 1);
  if (unit.key?.shift && !layout.get(before)?.shift) factor += 0.15;
  if (unit.text === before) factor *= 0.85;
  return factor;
}

/** A typist's rollover: the key is released only after the next one went down. */
const canRoll = (u?: Unit) => !!u?.key?.text && !u.key.shift && u.key.key !== "Enter";

/**
 * Plans typing `text` key by key. Times (ms) are relative to the key-down of `prev`, the character typed just
 * before; without `prev` the first event is at 0. Characters needing Shift get real Shift presses around them
 * (one press for a run of them); characters without a US key are inserted as text.
 */
export function planTyping(text: string, rand: Rand, cps = TYPING_CPS, prev?: string): TypingStep[] {
  const list = units(text);
  const mean = 1000 / cps / EXPECTED_FACTOR;
  const intervals = list.map((unit, i) => {
    const before = i ? list[i - 1]!.text.at(-1)! : prev;
    if (before === undefined) return 0;
    const noise = Math.exp(0.25 * gaussian(rand) - 0.03125); // lognormal with mean 1
    return Math.max(MIN_INTERVAL, mean * pauseFactor(unit, before) * noise);
  });
  const shiftKey = layout.get("Shift")!;
  const steps: TypingStep[] = [];
  let lastDown = 0, lastUp = prev === undefined ? -Infinity : 0, shift = false, rolledIn = false;
  list.forEach((unit, i) => {
    const key = unit.key;
    let down = lastDown + intervals[i]!;
    if (shift && !key?.shift) {
      const up = lastUp + uniform(rand, 10, 30);
      steps.push({ at: up, key: keyEvent("up", shiftKey, 0) });
      shift = false;
      lastUp = up;
      down = Math.max(down, up + uniform(rand, 15, 35));
    } else if (!shift && key?.shift) {
      const lead = uniform(rand, 25, 55);
      down = Math.max(down, lastUp + 8 + lead, lead);
      steps.push({ at: down - lead, key: keyEvent("down", shiftKey, MOD.Shift) });
      shift = true;
    } else if (!rolledIn) {
      down = Math.max(down, lastUp + RELEASE_GAP);
    }
    if (!key) {
      steps.push({ at: down, insertText: unit.text });
      lastDown = lastUp = down;
      rolledIn = false;
      return;
    }
    const modifiers = shift ? MOD.Shift : 0;
    steps.push({ at: down, key: keyEvent("down", key, modifiers) });
    const next = list[i + 1];
    const roll = !rolledIn && canRoll(unit) && canRoll(next) && next!.text !== unit.text && rand() < ROLLOVER_CHANCE;
    let hold = triangular(rand, TYPING_HOLD[0], TYPING_HOLD[1], 60);
    if (roll) hold = intervals[i + 1]! + uniform(rand, 8, 30);
    else if (next) hold = Math.min(hold, Math.max(TYPING_HOLD[0], intervals[i + 1]! - RELEASE_GAP));
    steps.push({ at: down + hold, key: keyEvent("up", key, modifiers) });
    lastDown = down;
    lastUp = Math.max(lastUp, down + hold);
    rolledIn = roll;
  });
  if (shift) steps.push({ at: lastUp + uniform(rand, 10, 30), key: keyEvent("up", shiftKey, 0) });
  return steps.sort((a, b) => a.at - b.at);
}
