// Counters for the log. Only names and counts: never message bodies or typed text.
const counters = new Map<string, number>();

export function count(name: string, n = 1) {
  counters.set(name, (counters.get(name) ?? 0) + n);
}

export const snapshot = (): Record<string, number> => Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b)));
