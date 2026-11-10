// Randomness helpers. Each takes the source as an argument so tests can fix it.
export type Rand = () => number;

export const uniform = (rand: Rand, min: number, max: number) => min + (max - min) * rand();

/** Triangular distribution: values cluster around `mode`. */
export function triangular(rand: Rand, min: number, max: number, mode = (min + max) / 2): number {
  if (max <= min) return min;
  const u = rand(), span = max - min;
  return u < (mode - min) / span
    ? min + Math.sqrt(u * span * (mode - min))
    : max - Math.sqrt((1 - u) * span * (max - mode));
}

/** Standard normal value (Box-Muller). */
export function gaussian(rand: Rand): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
