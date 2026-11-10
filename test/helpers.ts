import type { Cdp, Clock } from "../src/humanize.ts";
import type { Rect } from "../src/motion.ts";

/** Deterministic random numbers (mulberry32). */
export function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock whose sleep advances time instantly. */
export function fakeClock(seed = 1): Clock & { time: number; slept: number[] } {
  const clock = {
    time: 1000,
    slept: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.time += ms;
    },
    random: seeded(seed),
  };
  return clock;
}

export interface Element {
  id: number;
  rect: Rect;
  nodeName?: string;
  attributes?: string[];
}

export interface Sent {
  method: string;
  params: Record<string, any>;
  at: number;
}

/** A fake page: hit tests and box models come from a list of elements (last one on top). */
export function fakePage(
  clock: Clock,
  elements: Element[],
  { width = 1200, height = 800, contentHeight = 3000, wheelScrollsPage = true, panel = undefined as Rect | undefined } = {},
) {
  const sent: Sent[] = [];
  const scroll = { x: 0, y: 0 };
  const quad = (r: Rect) => [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom];
  const cdp: Cdp = {
    async send(method, params = {}) {
      sent.push({ method, params: params as Record<string, any>, at: clock.now() });
      const p = params as Record<string, any>;
      switch (method) {
        case "DOM.getNodeForLocation": {
          if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) throw new Error("Invalid parameters");
          const hit = elements.findLast((e) => p.x >= e.rect.left && p.x <= e.rect.right && p.y >= e.rect.top && p.y <= e.rect.bottom);
          if (!hit) throw new Error("No node found at given location");
          return { backendNodeId: hit.id, frameId: "F" };
        }
        case "DOM.getBoxModel": {
          const e = elements.find((e) => e.id === p.backendNodeId)!;
          return { model: { content: quad(e.rect), border: quad(e.rect) } };
        }
        case "DOM.describeNode": {
          const e = elements.find((e) => `obj-${e.id}` === p.objectId || e.id === p.backendNodeId)!;
          return { node: { backendNodeId: e.id, nodeName: e.nodeName ?? "DIV", attributes: e.attributes ?? [] } };
        }
        case "Page.getLayoutMetrics":
          return {
            cssLayoutViewport: { pageX: scroll.x, pageY: scroll.y, clientWidth: width, clientHeight: height },
            cssContentSize: { x: 0, y: 0, width, height: contentHeight },
          };
        case "Input.dispatchMouseEvent":
          const overPanel = panel && p.x >= panel.left && p.x <= panel.right && p.y >= panel.top && p.y <= panel.bottom;
          if (p.type === "mouseWheel" && wheelScrollsPage && !overPanel) scroll.y = Math.min(Math.max(scroll.y + p.deltaY, 0), contentHeight - height);
          return {};
        default:
          return {};
      }
    },
  };
  return { cdp, sent, scroll };
}

export const ofType = (sent: Sent[], method: string, type?: string) =>
  sent.filter((s) => s.method === method && (type === undefined || s.params.type === type));
