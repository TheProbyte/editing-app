import type { VideoProject } from './video/project';
// The complete edit model: every slider the app knows about, plus curves and geometry.

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  /** How many units one full screen-width swipe covers (defaults to the whole range). */
  swipe?: number;
  /** Display formatter. */
  fmt?: (v: number) => string;
  /** Draw a hue gradient behind the slider track. */
  hue?: boolean;
}

export const signed = (v: number) => (v > 0 ? '+' : '') + Math.round(v);
export const plain = (v: number) => String(Math.round(v));
const ev = (v: number) => (v > 0 ? '+' : '') + v.toFixed(2);
const deg = (v: number) => Math.round(v) + '°';
const px = (v: number) => v.toFixed(1);
const straighten = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1) + '°';

const p = (id: string, label: string, min = -100, max = 100, def = 0, extra: Partial<ParamDef> = {}): ParamDef => ({
  id, label, min, max, def, fmt: min < 0 ? signed : plain, ...extra,
});

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export const BAND_COLORS: Record<string, string> = {
  red: '#ff3b30', orange: '#ff9500', yellow: '#ffd60a', green: '#34c759',
  aqua: '#32d7d2', blue: '#0a84ff', purple: '#8e5cff', magenta: '#ff2d92',
};
export const GRADE_ZONES = ['shadows', 'mids', 'highs', 'global'] as const;

export const PARAMS: ParamDef[] = [
  // Light
  p('exposure', 'Exposure', -5, 5, 0, { fmt: ev, swipe: 4 }),
  p('contrast', 'Contrast'),
  p('highlights', 'Highlights'),
  p('shadows', 'Shadows'),
  p('whites', 'Whites'),
  p('blacks', 'Blacks'),
  p('brightness', 'Brightness'),
  // Color
  p('temp', 'Temperature'),
  p('tint', 'Tint'),
  p('vibrance', 'Vibrance'),
  p('saturation', 'Saturation'),
  // Detail
  p('sharpen', 'Sharpening', 0, 150),
  p('sharpenRadius', 'Sharpen radius', 0.5, 3, 1, { fmt: px }),
  p('sharpenMask', 'Sharpen masking', 0, 100),
  p('texture', 'Texture'),
  p('clarity', 'Clarity'),
  p('dehaze', 'Dehaze'),
  p('denoise', 'Noise reduction', 0, 100),
  p('colorDenoise', 'Color noise', 0, 100),
  // Black & white
  p('bw', 'Black & White', 0, 100),
  ...HSL_BANDS.map((b) => p(`bw_${b}`, cap(b))),
  p('bw_toneHue', 'Tone hue', 0, 360, 35, { fmt: deg, hue: true }),
  p('bw_toneAmt', 'Tone amount', 0, 100),
  // Grain
  p('grain', 'Amount', 0, 100),
  p('grainSize', 'Size', 0, 100, 30),
  p('grainRough', 'Roughness', 0, 100, 45),
  p('grainColor', 'Color', 0, 100, 0),
  p('grainShadows', 'In shadows', 0, 100, 70),
  p('grainHighlights', 'In highlights', 0, 100, 35),
  // Halation
  p('halation', 'Amount', 0, 100),
  p('halThreshold', 'Threshold', 0, 100, 65),
  p('halRadius', 'Spread', 0, 100, 35),
  p('halHue', 'Hue', 0, 360, 8, { fmt: deg, hue: true }),
  p('halSat', 'Saturation', 0, 100, 85),
  // Glow / bloom
  p('glow', 'Amount', 0, 100),
  p('glowThreshold', 'Threshold', 0, 100, 55),
  p('glowRadius', 'Spread', 0, 100, 50),
  p('glowWarmth', 'Warmth'),
  // Vignette
  p('vignette', 'Amount'),
  p('vigMidpoint', 'Size', 0, 100, 50),
  p('vigRound', 'Roundness'),
  p('vigFeather', 'Feather', 0, 100, 50),
  p('vigHighlights', 'Protect lights', 0, 100, 0),
  p('vigX', 'Centre X', 0, 1, 0.5),
  p('vigY', 'Centre Y', 0, 1, 0.5),
  // Film / lens
  p('fade', 'Fade', 0, 100),
  p('fadeWarmth', 'Fade warmth'),
  p('ca', 'Color fringe', 0, 100),
  p('distortion', 'Distortion'),
  p('diffuse', 'Diffusion', 0, 100),
  // Blur (tilt-shift / radial focus)
  p('blurType', 'Blur type', 0, 2, 0),
  p('blurAmt', 'Blur strength', 0, 100, 60),
  p('blurSize', 'Focus size', 0, 100, 22),
  p('blurFeather', 'Transition', 0, 100, 45),
  p('blurAngle', 'Angle', -90, 90, 0, { fmt: (v) => Math.round(v) + '°' }),
  p('blurX', 'Focus X', 0, 1, 0.5),
  p('blurY', 'Focus Y', 0, 1, 0.55),
  // Double exposure
  p('dxOpacity', 'Opacity', 0, 100, 60),
  p('dxScale', 'Size', 10, 300, 100, { fmt: (v) => Math.round(v) + '%' }),
  p('dxRot', 'Rotate', -180, 180, 0, { fmt: (v) => Math.round(v) + '°' }),
  p('dxBlend', 'Blend', 0, 8, 0),
  p('dxBrush', 'Brush size', 1, 100, 30),
  p('dxHard', 'Hardness', 0, 100, 35),
  p('dxX', 'Position X', 0, 1, 0.5),
  p('dxY', 'Position Y', 0, 1, 0.5),
  // Light leak
  p('lkOpacity', 'Opacity', 0, 100, 80),
  p('lkScale', 'Size', 10, 300, 100, { fmt: (v) => Math.round(v) + '%' }),
  p('lkRot', 'Rotate', -180, 180, 0, { fmt: (v) => Math.round(v) + '°' }),
  p('lkBlend', 'Blend', 0, 8, 2, { fmt: (v) => BLEND_MODES[Math.round(v)] }),
  p('lkBrush', 'Brush size', 1, 100, 30),
  p('lkHard', 'Hardness', 0, 100, 35),
  p('lkX', 'Position X', 0, 1, 0.5),
  p('lkY', 'Position Y', 0, 1, 0.5),
  // Remove (spot healing)
  p('healSize', 'Brush size', 1, 100, 25),
  // Geometry (crop tool)
  p('straighten', 'Straighten', -45, 45, 0, { fmt: straighten, swipe: 30 }),
  // Grading
  ...GRADE_ZONES.flatMap((z) => [
    p(`cg_${z}_hue`, 'Hue', 0, 360, z === 'shadows' ? 210 : z === 'highs' ? 40 : 30, { fmt: deg, hue: true }),
    p(`cg_${z}_sat`, 'Saturation', 0, 100, 0),
    p(`cg_${z}_lum`, 'Luminance'),
  ]),
  p('cg_blend', 'Blending', 0, 100, 50),
  p('cg_balance', 'Balance'),
  // HSL
  ...HSL_BANDS.flatMap((b) => [
    p(`hsl_${b}_h`, 'Hue'),
    p(`hsl_${b}_s`, 'Saturation'),
    p(`hsl_${b}_l`, 'Luminance'),
  ]),
];

function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

export const PARAM_MAP: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((d) => [d.id, d]));

export type Values = Record<string, number>;
export type CurvePoint = [number, number];
export interface Curves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}
export interface Geometry {
  /** Crop rectangle, normalized to the rotated (quarter-turned) frame. */
  crop: { x: number; y: number; w: number; h: number };
  /** Number of 90° clockwise turns. */
  quarter: number;
  flipH: boolean;
  flipV: boolean;
}

export type MaskType = 'radial' | 'linear' | 'brush' | 'luma' | 'color' | 'subject';

export interface Stroke {
  /** radius in frame heights */
  r: number;
  hard: number;
  flow: number;
  erase: boolean;
  /** x,y pairs in frame-normalized coordinates */
  pts: number[];
}

/**
 * A local adjustment. Geometry is stored in frame-normalized coordinates (0..1 across the
 * rotated, uncropped frame) so masks stay put when you re-crop. Radii are in frame heights.
 */
export interface Mask {
  id: number;
  type: MaskType;
  name: string;
  invert: boolean;
  /** mask shape + settings (see MASK_SETTINGS) */
  g: Values;
  /** adjustments inside the mask (see MASK_ADJ) */
  a: Values;
  strokes: Stroke[];
  /** AI selection ('subject' masks): include/exclude strokes for the subject model, or a people part */
  ai?: { strokes: { neg: boolean; pts: number[] }[]; part?: number };
}

/** A healed spot: frame coords, radius in frame heights, source offset and a color correction. */
export interface Spot {
  x: number;
  y: number;
  r: number;
  ox: number;
  oy: number;
  /** linear RGB added to the copied patch so it matches its new surroundings */
  c: [number, number, number];
  /** a painted area: the brush path (frame coords); x, y is then its centre */
  pts?: number[];
}

/** Max circles the GPU gets for all Remove patches together. */
export const MAX_SPOT_CIRCLES = 96;

/**
 * The circles that make up a Remove patch: one for a tap, or a row along the painted path
 * (frame coords; distances measured in frame heights, so x is scaled by the aspect).
 */
export function spotCircles(sp: Spot, aspect: number, maxN = 48): [number, number][] {
  const P = sp.pts;
  if (!P || P.length < 4) return [[sp.x, sp.y]];
  let len = 0;
  for (let i = 2; i < P.length; i += 2) len += Math.hypot((P[i] - P[i - 2]) * aspect, P[i + 1] - P[i - 1]);
  const step = Math.max(sp.r * 0.45, len / Math.max(1, maxN - 1));
  const out: [number, number][] = [[P[0], P[1]]];
  let carry = 0;
  for (let i = 2; i < P.length; i += 2) {
    const ax = P[i - 2], ay = P[i - 1], bx = P[i], by = P[i + 1];
    const seg = Math.hypot((bx - ax) * aspect, by - ay);
    let t = step - carry;
    while (t <= seg && out.length < maxN) {
      const k = t / seg;
      out.push([ax + (bx - ax) * k, ay + (by - ay) * k]);
      t += step;
    }
    carry = seg - (t - step);
  }
  const lx = P[P.length - 2], ly = P[P.length - 1];
  const last = out[out.length - 1];
  if (Math.hypot((lx - last[0]) * aspect, ly - last[1]) > sp.r * 0.2 && out.length < maxN) out.push([lx, ly]);
  return out;
}

export const MAX_SPOTS = 32;

/** A placed layer (double exposure photo or light leak). Its mask = person (optional) + brush, optionally inverted. */
export interface Layer {
  id: string;
  aspect: number;
  strokes: Stroke[];
  /** flip the mask: shown where it was hidden and the other way round */
  invert?: boolean;
  /** start the mask from the person in the photo (AI) */
  person?: boolean;
}

export interface EditState {
  v: Values;
  curves: Curves;
  geo: Geometry;
  masks: Mask[];
  spots: Spot[];
  /** double exposure: the second photo (stored on the device by id) and its hide/show brush */
  overlay?: Layer | null;
  /** light leak: a built-in leak (by id), placed like the double-exposure photo */
  leak?: Layer | null;
  /** content-aware fills: areas painted over, rebuilt from the rest of the photo */
  fills?: { pts: number[]; r: number }[];
  /** set when editing a video: the timeline (the settings above apply to every frame) */
  video?: VideoProject;
}

export const BLEND_MODES = ['Normal', 'Lighten', 'Screen', 'Multiply', 'Darken', 'Overlay', 'Soft light', 'Add', 'Difference'];

export const LINEAR: CurvePoint[] = [[0, 0], [1, 1]];

export function defaultValues(): Values {
  const v: Values = {};
  for (const d of PARAMS) v[d.id] = d.def;
  return v;
}

export function defaultState(): EditState {
  return {
    v: defaultValues(),
    curves: { rgb: [...LINEAR], r: [...LINEAR], g: [...LINEAR], b: [...LINEAR] },
    geo: { crop: { x: 0, y: 0, w: 1, h: 1 }, quarter: 0, flipH: false, flipV: false },
    masks: [],
    spots: [],
    overlay: null,
    leak: null,
    fills: [],
  };
}

export function cloneState(s: EditState): EditState {
  return JSON.parse(JSON.stringify(s));
}

export function clampParam(id: string, v: number) {
  const d = PARAM_MAP[id];
  return Math.min(d.max, Math.max(d.min, v));
}

// ---------------------------------------------------------------------------------------
// Masks

export const MAX_MASKS = 8;

/** Adjustments available inside a mask. */
export const MASK_ADJ: ParamDef[] = [
  p('exposure', 'Exposure', -3, 3, 0, { fmt: ev, swipe: 3 }),
  p('contrast', 'Contrast'),
  p('highlights', 'Highlights'),
  p('shadows', 'Shadows'),
  p('temp', 'Temperature'),
  p('tint', 'Tint'),
  p('saturation', 'Saturation'),
  p('clarity', 'Clarity'),
  p('dehaze', 'Dehaze'),
];

/** Mask shape settings, by type. */
export const MASK_SETTINGS: Record<string, ParamDef> = Object.fromEntries([
  p('amount', 'Mask strength', 0, 100, 100),
  p('feather', 'Feather', 0, 100, 60),
  p('smart', 'Color match', 0, 100, 0),
  p('lo', 'Range from', 0, 100, 65),
  p('hi', 'Range to', 0, 100, 100),
  p('soft', 'Smoothness', 0, 100, 25),
  p('hue', 'Hue', 0, 360, 210, { fmt: deg, hue: true }),
  p('range', 'Hue range', 5, 90, 30),
  p('size', 'Brush size', 1, 100, 25),
  p('hard', 'Hardness', 0, 100, 25),
  p('flow', 'Flow', 1, 100, 70),
].map((d) => [d.id, d]));

export const MASK_TYPE_SETTINGS: Record<MaskType, string[]> = {
  radial: ['feather', 'smart', 'amount'],
  linear: ['amount'],
  brush: ['size', 'hard', 'flow', 'amount'],
  luma: ['lo', 'hi', 'soft', 'amount'],
  color: ['hue', 'range', 'amount'],
  subject: ['size', 'hard', 'flow', 'amount'],
};

export const MASK_LABEL: Record<MaskType, string> = {
  radial: 'Radial', linear: 'Gradient', brush: 'Brush', luma: 'Light range', color: 'Color range', subject: 'Subject',
};
