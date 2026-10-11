import type { CurvePoint, Curves, Values } from './params';

/** What a look measures in the photo before deciding its settings (display values, 0..1). */
export interface ImgStats {
  p01: number;
  p05: number;
  p50: number;
  p95: number;
  p99: number;
  /** average color (for casts) */
  r: number;
  g: number;
  b: number;
  /** average saturation (HSV) */
  sat: number;
}

export interface Look {
  name: string;
  v: Values;
  curves?: Partial<Curves>;
  /** Adaptive looks read the photo and return real slider values (which you can then edit). */
  auto?: (s: ImgStats) => { v: Values; curves?: Partial<Curves> };
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
/** Exposure (stops) that moves the photo's median brightness to `target`. */
const expTo = (s: ImgStats, target: number, lim = 1.5) => clamp(2.2 * Math.log2(target / Math.max(0.02, s.p50)), -lim, lim);
/** Temperature/tint that cancel the photo's own cast (so the look's color lands the same on any photo). */
function neutral(s: ImgStats) {
  const m = (s.r + s.g + s.b) / 3 || 1;
  return { temp: clamp(((s.b - s.r) / m) * 60, -25, 25), tint: clamp(((s.g - (s.r + s.b) / 2) / m) * 60, -20, 20) };
}

export const LOOKS: Look[] = [
  { name: 'Original', v: {} },
  {
    // MiniDV / early-2000s camcorder: video white clip, crisp edge sharpening, cool shadows,
    // punchy color, chroma noise and a bit of cheap-lens fringing
    name: 'Camcorder',
    v: {},
    auto: (s) => {
      const n = neutral(s);
      // whites can only get so bright: cap them lower when the photo has a lot of highlight
      const white = s.p99 > 0.92 ? 0.86 : 0.9;
      const black = 0.06;
      return {
        v: {
          exposure: expTo(s, 0.5, 1.2),
          temp: n.temp * 0.5 - 12, tint: n.tint * 0.5 - 3,
          contrast: 12 + clamp((0.55 - (s.p95 - s.p05)) * 40, 0, 20),
          highlights: -clamp((s.p95 - 0.7) * 120, 0, 40),
          shadows: 8,
          saturation: clamp(14 + (0.35 - s.sat) * 40, 6, 26), vibrance: 6,
          sharpen: 95, sharpenRadius: 0.6, sharpenMask: 0, texture: 14, clarity: -4,
          denoise: 22,
          cg_shadows_hue: 215, cg_shadows_sat: 30, cg_highs_hue: 190, cg_highs_sat: 6,
          grain: 16, grainSize: 8, grainRough: 85, grainColor: 75, grainShadows: 90, grainHighlights: 20,
          ca: 28, vignette: -10, vigFeather: 70,
        },
        curves: { rgb: [[0, black], [0.25, 0.27], [0.6, 0.64], [1, white]] },
      };
    },
  },
  {
    // color negative film: gentle toe, rolled-off highlights, lifted blacks, warm highs,
    // softened greens, grain and a little halation
    name: 'Film',
    v: {},
    auto: (s) => {
      const n = neutral(s);
      const lift = s.p01 < 0.03 ? 0.07 : 0.04;
      return {
        v: {
          exposure: expTo(s, 0.48, 1.2),
          temp: n.temp * 0.6 + 8, tint: n.tint * 0.6 + 2,
          contrast: -8,
          highlights: -clamp((s.p99 - 0.8) * 160, 5, 45),
          shadows: 12,
          vibrance: -6, saturation: clamp(-8 + (0.25 - s.sat) * 30, -14, 4),
          hsl_green_h: 16, hsl_green_s: -18, hsl_orange_s: 6, hsl_blue_s: -12,
          cg_shadows_hue: 195, cg_shadows_sat: 10, cg_highs_hue: 40, cg_highs_sat: 12,
          grain: 30, grainSize: 34, grainRough: 45, halation: 18, halThreshold: 62, fade: 6,
        },
        curves: { rgb: [[0, lift], [0.25, 0.24], [0.72, 0.76], [1, 0.96]] },
      };
    },
  },
  {
    // cinematic grade: a touch darker, controlled highlights, teal shadows / warm skin,
    // pulled-back saturation, soft vignette and bloom
    name: 'Cinematic',
    v: {},
    auto: (s) => {
      const n = neutral(s);
      return {
        v: {
          exposure: expTo(s, 0.42, 1.3),
          temp: n.temp * 0.7 + 2, tint: n.tint * 0.7,
          contrast: 14,
          highlights: -clamp((s.p99 - 0.75) * 170, 10, 55),
          shadows: 10, blacks: -8,
          saturation: clamp(-10 + (0.3 - s.sat) * 20, -18, 0),
          hsl_orange_s: 10, hsl_orange_l: 6, hsl_blue_h: -14, hsl_green_h: 28, hsl_green_s: -32, hsl_aqua_s: 10,
          cg_shadows_hue: 188, cg_shadows_sat: 32, cg_highs_hue: 34, cg_highs_sat: 22, cg_balance: -10,
          vignette: -22, vigFeather: 65, halation: 12, glow: 6, grain: 12, grainSize: 20,
        },
        curves: { rgb: [[0, 0.04], [0.25, 0.19], [0.75, 0.8], [1, 0.97]] },
      };
    },
  },
  {
    name: 'Gold',
    v: {},
    auto: (s) => ({
      v: {
        exposure: expTo(s, 0.52, 1),
        temp: 22, tint: 6, contrast: 10, highlights: -20, shadows: 10, vibrance: 15, saturation: 4,
        hsl_yellow_h: -10, hsl_yellow_s: 15, hsl_blue_s: -10, hsl_green_h: -10,
        cg_highs_hue: 45, cg_highs_sat: 20, cg_shadows_hue: 25, cg_shadows_sat: 8,
        grain: 25, grainSize: 35, halation: 18, glow: 8, vignette: -18,
      },
    }),
  },
  {
    name: 'Noir',
    v: {},
    auto: (s) => ({
      v: {
        exposure: expTo(s, 0.45, 1),
        bw: 100, contrast: clamp(40 + (0.6 - (s.p95 - s.p05)) * 60, 30, 70), blacks: -30, highlights: -10, clarity: 25,
        bw_red: -15, bw_blue: -35, vignette: -45, vigFeather: 60, grain: 30, grainRough: 60,
      },
    }),
  },
];

/** Measure a rendered photo (RGBA, display-referred). */
export function measure(px: Uint8Array | Uint8ClampedArray): ImgStats {
  const hist = new Uint32Array(256);
  let r = 0, g = 0, b = 0, sat = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const R = px[i], G = px[i + 1], B = px[i + 2];
    hist[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    r += R;
    g += G;
    b += B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    sat += mx ? (mx - mn) / mx : 0;
    n++;
  }
  const pct = (q: number) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= q * n) return i / 255;
    }
    return 1;
  };
  n = Math.max(1, n);
  return { p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), r: r / n / 255, g: g / n / 255, b: b / n / 255, sat: sat / n };
}

export type { CurvePoint };
