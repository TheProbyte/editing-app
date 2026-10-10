import type { CurvePoint, Curves, Values } from './params';

export interface Look {
  name: string;
  v: Values;
  curves?: Partial<Curves>;
}

const fadeCurve: CurvePoint[] = [[0, 0.07], [0.25, 0.25], [0.75, 0.78], [1, 0.96]];
const sCurve: CurvePoint[] = [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]];
const softS: CurvePoint[] = [[0, 0.03], [0.25, 0.22], [0.72, 0.77], [1, 0.98]];

export const LOOKS: Look[] = [
  { name: 'Original', v: {} },
  {
    name: 'Portra',
    v: {
      temp: 8, tint: 2, contrast: -12, highlights: -25, shadows: 15, vibrance: -8, saturation: -6,
      hsl_orange_s: 8, hsl_orange_l: 6, hsl_green_h: 18, hsl_green_s: -25, hsl_blue_s: -18,
      cg_shadows_hue: 200, cg_shadows_sat: 10, cg_highs_hue: 40, cg_highs_sat: 12,
      grain: 22, grainSize: 30, grainRough: 35, halation: 10, fade: 8,
    },
    curves: { rgb: softS },
  },
  {
    name: 'Gold',
    v: {
      temp: 22, tint: 6, contrast: 10, highlights: -20, shadows: 10, vibrance: 15, saturation: 4,
      hsl_yellow_h: -10, hsl_yellow_s: 15, hsl_blue_s: -10, hsl_green_h: -10,
      cg_highs_hue: 45, cg_highs_sat: 20, cg_shadows_hue: 25, cg_shadows_sat: 8,
      grain: 25, grainSize: 35, halation: 18, glow: 8, vignette: -18,
    },
  },
  {
    name: 'Cine 800T',
    v: {
      temp: -28, tint: 4, contrast: 14, highlights: -15, shadows: 12, saturation: 8,
      hsl_red_s: 15, hsl_orange_h: -6, cg_shadows_hue: 195, cg_shadows_sat: 22, cg_highs_hue: 25, cg_highs_sat: 14,
      halation: 65, halThreshold: 55, halRadius: 40, halHue: 4, glow: 12,
      grain: 30, grainSize: 40, grainRough: 50, vignette: -12,
    },
    curves: { rgb: softS },
  },
  {
    name: 'Chrome',
    v: {
      contrast: 22, highlights: -20, shadows: -6, saturation: -22, vibrance: -10, clarity: 12,
      hsl_blue_h: -8, hsl_blue_s: -10, hsl_green_s: -30, hsl_red_s: 10,
      cg_shadows_hue: 210, cg_shadows_sat: 10, grain: 14, grainSize: 20,
    },
  },
  {
    name: 'Velvia',
    v: {
      contrast: 28, vibrance: 35, saturation: 15, highlights: -15, blacks: -10,
      hsl_green_s: 20, hsl_blue_s: 18, hsl_blue_l: -12, hsl_red_s: 12, clarity: 10, dehaze: 8,
    },
    curves: { rgb: sCurve },
  },
  {
    name: 'Ektar',
    v: {
      temp: 6, contrast: 18, vibrance: 22, saturation: 10, hsl_red_s: 18, hsl_orange_s: 12, hsl_blue_s: 15, hsl_blue_h: -6,
      highlights: -10, grain: 12, grainSize: 18,
    },
  },
  {
    name: 'Matte',
    v: { contrast: -18, fade: 35, fadeWarmth: 20, saturation: -15, highlights: -20, grain: 18, cg_shadows_hue: 30, cg_shadows_sat: 8 },
    curves: { rgb: fadeCurve },
  },
  {
    name: 'Teal & Orange',
    v: {
      contrast: 12, vibrance: 12, hsl_orange_s: 15, hsl_yellow_h: -15, hsl_green_h: 35, hsl_green_s: -20,
      hsl_aqua_h: 10, hsl_blue_h: -20, hsl_blue_s: 10,
      cg_shadows_hue: 190, cg_shadows_sat: 30, cg_highs_hue: 35, cg_highs_sat: 25, cg_balance: 10,
    },
  },
  {
    name: 'Moody',
    v: {
      exposure: -0.25, contrast: 20, highlights: -40, shadows: -10, blacks: -15, saturation: -25, vibrance: -10,
      hsl_green_l: -25, hsl_blue_l: -20, hsl_orange_l: 5, clarity: 15,
      cg_shadows_hue: 215, cg_shadows_sat: 18, vignette: -30, grain: 20,
    },
  },
  {
    name: 'Airy',
    v: {
      exposure: 0.35, contrast: -15, highlights: -30, shadows: 35, whites: 10, blacks: 20, vibrance: 10, saturation: -10,
      temp: 4, hsl_orange_l: 10, cg_highs_hue: 40, cg_highs_sat: 6, diffuse: 12,
    },
  },
  {
    name: 'Vintage',
    v: {
      temp: 18, tint: -6, contrast: -10, saturation: -30, fade: 25, fadeWarmth: 45,
      cg_shadows_hue: 170, cg_shadows_sat: 18, cg_highs_hue: 50, cg_highs_sat: 25,
      grain: 45, grainSize: 50, grainRough: 60, vignette: -35, vigFeather: 70, halation: 15, ca: 20,
    },
    curves: { rgb: fadeCurve, b: [[0, 0.08], [1, 0.9]] },
  },
  {
    name: 'Mist',
    v: { contrast: -10, diffuse: 45, glow: 25, glowThreshold: 45, highlights: -10, saturation: -8, fade: 10, temp: 5 },
  },
  {
    name: 'Tri-X',
    v: {
      bw: 100, contrast: 35, clarity: 15, bw_red: 10, bw_orange: 15, bw_yellow: 10, bw_blue: -20,
      blacks: -10, grain: 55, grainSize: 45, grainRough: 75, grainShadows: 85, grainHighlights: 45,
    },
    curves: { rgb: sCurve },
  },
  {
    name: 'HP5 Soft',
    v: {
      bw: 100, contrast: 5, highlights: -25, shadows: 20, bw_orange: 10, bw_blue: -10,
      grain: 35, grainSize: 35, grainRough: 40, fade: 10,
    },
  },
  {
    name: 'Noir',
    v: {
      bw: 100, contrast: 55, blacks: -30, highlights: -10, clarity: 25, bw_red: -15, bw_blue: -35,
      vignette: -45, vigFeather: 60, grain: 30, grainRough: 60,
    },
  },
  {
    name: 'Selenium',
    v: { bw: 100, contrast: 18, bw_toneHue: 285, bw_toneAmt: 45, grain: 20 },
  },
  {
    name: 'Sepia',
    v: { bw: 100, contrast: 10, bw_toneHue: 35, bw_toneAmt: 70, fade: 15, fadeWarmth: 50, grain: 30, vignette: -25 },
  },
];
