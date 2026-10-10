import type { CurvePoint, Curves } from './params';

/** Monotone cubic (Fritsch–Carlson) interpolation through sorted points. */
export function makeSpline(points: CurvePoint[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

export const LUT_SIZE = 1024;

/** Packs the master + per-channel curves into one RGBA float LUT (master applied first). */
export function buildCurveLut(c: Curves): Float32Array {
  const master = makeSpline(c.rgb);
  const ch = [makeSpline(c.r), makeSpline(c.g), makeSpline(c.b)];
  const out = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    const m = clamp01(master(x));
    for (let k = 0; k < 3; k++) out[i * 4 + k] = clamp01(ch[k](m));
    out[i * 4 + 3] = 1;
  }
  return out;
}

export function isIdentity(c: Curves) {
  const lin = (pts: CurvePoint[]) => pts.every(([x, y]) => Math.abs(x - y) < 1e-4);
  return lin(c.rgb) && lin(c.r) && lin(c.g) && lin(c.b);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
