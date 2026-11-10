import { describe, expect, test } from "bun:test";
import { aimPoint, centralArea, pickPoint, planPath, planWheel, quadRect } from "../src/motion.ts";
import { seeded } from "./helpers.ts";

describe("pointer path", () => {
  test("integer steps every 8-16 ms ending exactly at the target, 100-700 ms long", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rand = seeded(seed);
      const from = { x: Math.round(rand() * 1000), y: Math.round(rand() * 700) }, to = { x: Math.round(rand() * 1000), y: Math.round(rand() * 700) };
      const path = planPath(from, to, rand);
      const last = path.at(-1)!;
      expect(last).toMatchObject(to);
      if (Math.hypot(to.x - from.x, to.y - from.y) < 2) continue;
      expect(last.at).toBeGreaterThanOrEqual(100);
      expect(last.at).toBeLessThanOrEqual(700);
      expect(path[0]!.at).toBeGreaterThanOrEqual(8);
      for (let i = 1; i < path.length; i++) {
        expect(Number.isInteger(path[i]!.x) && Number.isInteger(path[i]!.y)).toBe(true);
        expect(path[i]!.at - path[i - 1]!.at).toBeGreaterThanOrEqual(8);
        expect(path[i]).not.toMatchObject({ x: path[i - 1]!.x, y: path[i - 1]!.y });
      }
    }
  });

  test("longer moves take longer and stay near the straight line", () => {
    const duration = (d: number) => planPath({ x: 0, y: 0 }, { x: d, y: 0 }, seeded(3)).at(-1)!.at;
    expect(duration(800)).toBeGreaterThan(duration(60));
    for (const p of planPath({ x: 0, y: 0 }, { x: 600, y: 0 }, seeded(4))) expect(Math.abs(p.y)).toBeLessThanOrEqual(55);
  });

  test("new randomness each time", () => {
    const a = planPath({ x: 10, y: 10 }, { x: 500, y: 300 }, seeded(1)), b = planPath({ x: 10, y: 10 }, { x: 500, y: 300 }, seeded(2));
    expect(a).not.toEqual(b);
  });
});

describe("aiming", () => {
  const button = quadRect([32, 86.9, 88.3, 86.9, 88.3, 102.4, 32, 102.4]);

  test("integer points in the central area, not the exact centre", () => {
    const area = centralArea(button);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      const p = aimPoint(button, { x: 60.15, y: 94.65 }, seeded(seed))!;
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
      expect(p.x >= area.left && p.x <= area.right && p.y >= area.top && p.y <= area.bottom).toBe(true);
      seen.add(`${p.x},${p.y}`);
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  test("large elements: within 40 px of where the client aimed", () => {
    const big = { left: 0, top: 0, right: 1200, bottom: 800 };
    for (let seed = 1; seed <= 50; seed++) {
      const p = aimPoint(big, { x: 600, y: 400 }, seeded(seed))!;
      expect(Math.abs(p.x - 600)).toBeLessThanOrEqual(40);
      expect(Math.abs(p.y - 400)).toBeLessThanOrEqual(40);
    }
    expect(aimPoint(big, { x: 10, y: 10 }, seeded(1))).toBeUndefined();
  });

  test("no point when the area holds no integer", () => {
    expect(pickPoint({ left: 3.2, top: 1, right: 3.8, bottom: 2 }, seeded(1))).toBeUndefined();
  });
});

describe("wheel", () => {
  test("small deltas stay one event", () => {
    expect(planWheel(0, 100, seeded(1))).toEqual([{ dx: 0, dy: 100, wait: 0 }]);
  });

  test("large deltas split into 80-120 px steps with 30-90 ms gaps, same total", () => {
    for (let seed = 1; seed <= 30; seed++) for (const [dx, dy] of [[0, 300], [0, -650], [400, 120], [0, 1000], [0, 161]] as const) {
      const steps = planWheel(dx, dy, seeded(seed * 1000 + dy));
      expect(steps.reduce((a, s) => a + s.dy, 0)).toBe(dy);
      expect(steps.reduce((a, s) => a + s.dx, 0)).toBe(dx);
      expect(steps[0]!.wait).toBe(0);
      for (const s of steps.slice(1)) expect(s.wait >= 30 && s.wait <= 90).toBe(true);
      for (const s of steps) expect(Math.max(Math.abs(s.dx), Math.abs(s.dy))).toBeLessThanOrEqual(121);
      for (const s of steps) expect(Math.max(Math.abs(s.dx), Math.abs(s.dy))).toBeGreaterThanOrEqual(79);
    }
  });
});
