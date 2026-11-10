// Pointer geometry and timing. Pure: randomness is injected.
import { gaussian, triangular, uniform, type Rand } from "./random.ts";

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface PathStep extends Point {
  at: number;
}
export interface WheelStep {
  dx: number;
  dy: number;
  /** Pause before this step (ms). */
  wait: number;
}

/** How long a click holds the button (ms). */
export const CLICK_HOLD = [60, 140] as const;
/** Farthest a chosen point may be from where the client aimed (px). */
const AIM_RADIUS = 40;

/** Bounding rectangle of a DOM.getBoxModel quad. */
export function quadRect(quad: number[]): Rect {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!], ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export const center = (r: Rect): Point => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
export const contains = (r: Rect, p: Point) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

export function intersect(a: Rect, b: Rect): Rect | undefined {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.left <= r.right && r.top <= r.bottom ? r : undefined;
}

/** The middle half of a box in each direction, at most `maxHalf` px from its centre. */
export function centralArea(r: Rect, maxHalf = AIM_RADIUS): Rect {
  const c = center(r);
  const hx = Math.min((r.right - r.left) / 4, maxHalf), hy = Math.min((r.bottom - r.top) / 4, maxHalf);
  return { left: c.x - hx, top: c.y - hy, right: c.x + hx, bottom: c.y + hy };
}

/** A random integer point in `area`, clustered towards its middle; undefined when the area holds no integer point. */
export function pickPoint(area: Rect, rand: Rand): Point | undefined {
  const [x0, x1, y0, y1] = [Math.ceil(area.left), Math.floor(area.right), Math.ceil(area.top), Math.floor(area.bottom)];
  if (x0 > x1 || y0 > y1) return undefined;
  return { x: Math.round(triangular(rand, x0, x1)), y: Math.round(triangular(rand, y0, y1)) };
}

/** Where a person would point when aiming at `aim` inside `box`: a random integer point in the box's central area, near the aim. */
export function aimPoint(box: Rect, aim: Point, rand: Rand): Point | undefined {
  const near = { left: aim.x - AIM_RADIUS, top: aim.y - AIM_RADIUS, right: aim.x + AIM_RADIUS, bottom: aim.y + AIM_RADIUS };
  const area = intersect(centralArea(box), near);
  return area && pickPoint(area, rand);
}

/**
 * A human-like pointer path from `from` to `to`: the duration grows with distance (100-700 ms), a step every
 * 8-16 ms, minimum-jerk easing, a slight curve and small jitter. Integer points; the last one is exactly `to`.
 */
export function planPath(from: Point, to: Point, rand: Rand): PathStep[] {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy);
  if (distance < 2) return [{ ...to, at: 0 }];
  // The last step comes at the first tick past `duration`, so the path lasts at most 684 + 16 ms.
  const duration = Math.min(684, Math.max(100, (100 + distance * 0.55) * uniform(rand, 0.85, 1.15)));
  const bend = uniform(rand, -1, 1) * Math.min(distance * 0.12, 50);
  const nx = -dy / distance, ny = dx / distance;
  const steps: PathStep[] = [];
  const same = (a: Point | undefined, b: Point) => a?.x === b.x && a.y === b.y;
  let t = uniform(rand, 8, 16);
  for (; t < duration; t += uniform(rand, 8, 16)) {
    const s = t / duration;
    const eased = s * s * s * (10 - 15 * s + 6 * s * s);
    const curve = 4 * s * (1 - s) * bend, jitter = 0.6 * (1 - s);
    const p = {
      x: Math.round(from.x + dx * eased + nx * curve + gaussian(rand) * jitter),
      y: Math.round(from.y + dy * eased + ny * curve + gaussian(rand) * jitter),
      at: t,
    };
    if (!same(steps.at(-1), p) && !same(to, p)) steps.push(p);
  }
  steps.push({ ...to, at: t });
  return steps;
}

/** Splits a wheel delta larger than 120 px into 80-120 px steps with 30-90 ms between them. */
export function planWheel(dx: number, dy: number, rand: Rand): WheelStep[] {
  const total = Math.max(Math.abs(dx), Math.abs(dy));
  if (total <= 120) return [{ dx, dy, wait: 0 }];
  // A step count whose average step is 80-120 px, then jitter that keeps each step in that range.
  const fewest = Math.ceil(total / 120), most = Math.max(fewest, Math.floor(total / 80));
  const n = fewest + Math.floor(rand() * (most - fewest + 1)), mean = total / n;
  const spread = Math.max(0, Math.min(mean - 80, 120 - mean, 15)) / 2;
  const jitter = Array.from({ length: n }, () => uniform(rand, -spread, spread));
  const centre = jitter.reduce((a, b) => a + b, 0) / n;
  const steps: WheelStep[] = [];
  let share = 0, sx = 0, sy = 0;
  jitter.forEach((j, i) => {
    share += (mean + j - centre) / total;
    const last = i === n - 1;
    const x = last ? dx - sx : Math.round(dx * share) - sx, y = last ? dy - sy : Math.round(dy * share) - sy;
    sx += x;
    sy += y;
    steps.push({ dx: x, dy: y, wait: i ? uniform(rand, 30, 90) : 0 });
  });
  return steps;
}
