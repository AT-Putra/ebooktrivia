/** A round maximum for the y axis of a chart: 5, 10, 25, 50, 100, 250, ... never below the data. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2.5, 5, 10]) if (v <= step * pow) return step * pow;
  return 10 * pow;
}
