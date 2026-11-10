// Recognises agent-browser 0.41.2's own page JS by its exact source (cli/src/native/interaction.rs).
// Only whitespace is normalised, because the same function appears with different indentation.
// Anything else, including these functions from a different agent-browser version, passes through.
// RECOGNIZERS lists what the self-check (agent-browser-check.ts) looks for in the installed agent-browser binary.

/** `fill`, `type <sel>` and `focus` focus the element with this function. */
export const FOCUS_SOURCE = "function() { this.focus(); }";
/** `fill` and `type --clear` empty the field with this function. */
export const CLEAR_SOURCE = `function() {
                    this.select && this.select();
                    this.value = '';
                    this.dispatchEvent(new Event('input', { bubbles: true }));
                }`;
/** `scroll --selector` scrolls an element with this function and the arguments (dx, dy). */
export const SCROLL_ELEMENT_SOURCE = "function(dx, dy) { this.scrollBy(dx, dy); }";
/** `scroll` without a selector evaluates `window.scrollBy(dx, dy)`, numbers formatted by Rust. */
const WINDOW_SCROLL = /^window\.scrollBy\((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)$/;

/**
 * Per recognizer: the text the agent-browser binary embeds verbatim, and what runs agent-browser's own page script
 * again when it is missing.
 */
export const RECOGNIZERS = {
  focus: { signature: FOCUS_SOURCE, fallback: "focusing fields (fill, type, focus)" },
  clear: { signature: CLEAR_SOURCE, fallback: "clearing fields (fill, type --clear)" },
  scrollElement: { signature: SCROLL_ELEMENT_SOURCE, fallback: "scroll --selector" },
  // Rust builds it with format!("window.scrollBy({}, {})", ..), so only this prefix is stored contiguously.
  scrollWindow: { signature: "window.scrollBy(", fallback: "scroll" },
} as const;
export type RecognizerName = keyof typeof RECOGNIZERS;

export type Recognized =
  | { kind: "focus"; objectId: string }
  | { kind: "clear"; objectId: string }
  | { kind: "scroll"; dx: number; dy: number; objectId?: string };

export const normalize = (source: string) => source.replace(/\s+/g, " ").trim();
const FOCUS = normalize(FOCUS_SOURCE), CLEAR = normalize(CLEAR_SOURCE), SCROLL_ELEMENT = normalize(SCROLL_ELEMENT_SOURCE);

export function recognize(method: string, params: Record<string, any> | undefined): Recognized | undefined {
  if (!params) return undefined;
  if (method === "Runtime.evaluate") {
    const m = typeof params.expression === "string" ? WINDOW_SCROLL.exec(params.expression) : null;
    return m ? { kind: "scroll", dx: Number(m[1]), dy: Number(m[2]) } : undefined;
  }
  if (method !== "Runtime.callFunctionOn" || typeof params.functionDeclaration !== "string" || typeof params.objectId !== "string") {
    return undefined;
  }
  const source = normalize(params.functionDeclaration), args: any[] = params.arguments ?? [];
  if (source === FOCUS && !args.length) return { kind: "focus", objectId: params.objectId };
  if (source === CLEAR && !args.length) return { kind: "clear", objectId: params.objectId };
  if (source === SCROLL_ELEMENT && args.length === 2 && typeof args[0]?.value === "number" && typeof args[1]?.value === "number") {
    return { kind: "scroll", dx: args[0].value, dy: args[1].value, objectId: params.objectId };
  }
  return undefined;
}
