/**
 * Axis ticks for a $/gal scale.
 *
 * Pads the observed band (so a flat price still gets a visible range),
 * clamps the floor at $0, then walks clean steps upward — 25¢, 50¢, $1,
 * $2, $5, $10, … — until the padded band, snapped outward to that step,
 * fits in at most four intervals. So the result is always two to five
 * ticks with round labels, whatever the input range.
 */
export function nicePriceTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max < min) [min, max] = [max, min];
  const span = max - min;
  const pad = Math.max(0.1, span * 0.2);
  const lo0 = Math.max(min - pad, 0);
  const hi0 = max + pad;

  const steps: number[] = [0.25, 0.5];
  for (let e = 0; e <= 9; e++) {
    for (const m of [1, 2, 5]) steps.push(m * 10 ** e);
  }

  let chosen = { step: steps[steps.length - 1], lo: lo0, hi: hi0 };
  for (const step of steps) {
    const lo = Math.floor(lo0 / step + 1e-9) * step;
    const hi = Math.ceil(hi0 / step - 1e-9) * step;
    chosen = { step, lo, hi };
    if ((hi - lo) / step <= 4 + 1e-9) break;
  }

  const ticks: number[] = [];
  for (let v = chosen.lo; v <= chosen.hi + 1e-9; v += chosen.step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}
