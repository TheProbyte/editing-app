import { BAND_COLORS, GRADE_ZONES, HSL_BANDS } from '../params';
import { ICONS } from './icons';

export { ICONS };

export interface Chip {
  id: string;
  label: string;
  color?: string;
  icon?: string;
}

export interface ToolDef {
  id: string;
  label: string;
  icon: string;
  kind: 'params' | 'looks' | 'curves' | 'crop' | 'masks' | 'blur';
  subs?: Chip[];
  params: (sub: string) => string[];
  /** quick presets / one-tap actions shown in the section */
  actions?: Chip[];
}

const list = (...ids: string[]) => () => ids;

export const TOOLS: ToolDef[] = [
  { id: 'looks', label: 'Looks', icon: ICONS.looks, kind: 'looks', params: list('lookAmt') },
  {
    id: 'light', label: 'Light', icon: ICONS.light, kind: 'params',
    params: list('exposure', 'contrast', 'brightness', 'highlights', 'shadows', 'whites', 'blacks'),
  },
  { id: 'color', label: 'Color', icon: ICONS.color, kind: 'params', params: list('temp', 'tint', 'vibrance', 'saturation') },
  { id: 'masks', label: 'Masks', icon: ICONS.masks, kind: 'masks', params: () => [] },
  {
    id: 'detail', label: 'Detail', icon: ICONS.detail, kind: 'params',
    params: list('sharpen', 'sharpenRadius', 'sharpenMask', 'texture', 'clarity', 'dehaze', 'denoise', 'colorDenoise'),
  },
  {
    id: 'curves', label: 'Curves', icon: ICONS.curves, kind: 'curves', params: () => [],
    subs: [
      { id: 'rgb', label: 'RGB', color: '#f2efe8' },
      { id: 'r', label: 'Red', color: '#ff4d3d' },
      { id: 'g', label: 'Green', color: '#3bd16f' },
      { id: 'b', label: 'Blue', color: '#3d8bff' },
    ],
    actions: [
      { id: 'curve:linear', label: 'Linear' },
      { id: 'curve:s', label: 'S-curve' },
      { id: 'curve:strong', label: 'Punch' },
      { id: 'curve:fade', label: 'Fade' },
      { id: 'curve:film', label: 'Film' },
    ],
  },
  {
    id: 'hsl', label: 'HSL', icon: ICONS.hsl, kind: 'params',
    subs: HSL_BANDS.map((b) => ({ id: b, label: b[0].toUpperCase() + b.slice(1), color: BAND_COLORS[b] })),
    params: (b) => [`hsl_${b}_h`, `hsl_${b}_s`, `hsl_${b}_l`],
  },
  {
    id: 'grade', label: 'Grade', icon: ICONS.grade, kind: 'params',
    subs: GRADE_ZONES.map((z) => ({
      id: z,
      label: { shadows: 'Shadows', mids: 'Mids', highs: 'Highs', global: 'All' }[z],
    })),
    params: (z) => [`cg_${z}_hue`, `cg_${z}_sat`, `cg_${z}_lum`, 'cg_blend', 'cg_balance'],
  },
  { id: 'bw', label: 'B&W', icon: ICONS.bw, kind: 'params', params: list('bw', ...HSL_BANDS.map((b) => `bw_${b}`), 'bw_toneHue', 'bw_toneAmt') },
  {
    id: 'blur', label: 'Blur', icon: ICONS.blur, kind: 'blur',
    subs: [
      { id: '0', label: 'Off', icon: ICONS.off },
      { id: '1', label: 'Tilt-shift', icon: ICONS.tilt },
      { id: '2', label: 'Radial', icon: ICONS.radialBlur },
    ],
    params: (t) => (t === '1' ? ['blurAmt', 'blurSize', 'blurFeather', 'blurAngle'] : t === '2' ? ['blurAmt', 'blurSize', 'blurFeather'] : []),
  },
  {
    id: 'grain', label: 'Grain', icon: ICONS.grain, kind: 'params',
    params: list('grain', 'grainSize', 'grainRough', 'grainColor', 'grainShadows', 'grainHighlights'),
    actions: [
      { id: 'grain:fine', label: 'Fine 100' },
      { id: 'grain:400', label: '35mm 400' },
      { id: 'grain:3200', label: 'Push 3200' },
      { id: 'grain:s8', label: 'Super 8' },
      { id: 'grain:color', label: 'Color neg' },
    ],
  },
  {
    id: 'halation', label: 'Halation', icon: ICONS.halation, kind: 'params',
    params: list('halation', 'halThreshold', 'halRadius', 'halHue', 'halSat'),
    actions: [
      { id: 'hal:subtle', label: 'Subtle' },
      { id: 'hal:cine', label: 'CineStill' },
      { id: 'hal:dream', label: 'Dreamy' },
    ],
  },
  { id: 'glow', label: 'Glow', icon: ICONS.glow, kind: 'params', params: list('glow', 'glowThreshold', 'glowRadius', 'glowWarmth', 'diffuse') },
  { id: 'vignette', label: 'Vignette', icon: ICONS.vignette, kind: 'params', params: list('vignette', 'vigMidpoint', 'vigFeather', 'vigRound', 'vigHighlights') },
  { id: 'film', label: 'Film', icon: ICONS.film, kind: 'params', params: list('fade', 'fadeWarmth', 'ca', 'distortion') },
  {
    id: 'crop', label: 'Crop', icon: ICONS.crop, kind: 'crop',
    params: list('straighten'),
    subs: [
      { id: 'free', label: 'Free' },
      { id: 'orig', label: 'Original' },
      { id: '1:1', label: '1:1' },
      { id: '4:5', label: '4:5' },
      { id: '5:4', label: '5:4' },
      { id: '3:2', label: '3:2' },
      { id: '2:3', label: '2:3' },
      { id: '16:9', label: '16:9' },
      { id: '9:16', label: '9:16' },
      { id: '1.85', label: '1.85' },
      { id: '2.39', label: '2.39' },
    ],
    actions: [
      { id: 'rot', label: 'Rotate', icon: ICONS.rotate },
      { id: 'flipH', label: 'Flip', icon: ICONS.flipH },
      { id: 'flipV', label: 'Flip', icon: ICONS.flipV },
    ],
  },
];
