import { BAND_COLORS, GRADE_ZONES, HSL_BANDS } from '../params';

export interface Chip {
  id: string;
  label: string;
  color?: string;
}

export interface ToolDef {
  id: string;
  label: string;
  icon: string;
  kind: 'params' | 'looks' | 'curves' | 'crop' | 'masks';
  subs?: Chip[];
  params: (sub: string) => string[];
  actions?: Chip[];
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  looks: svg('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  color: svg('<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>'),
  detail: svg('<path d="M3 17l5-5 4 4 8-8"/><path d="M14 8h6v6"/>'),
  curves: svg('<path d="M3 21C9 21 9 3 21 3"/><rect x="3" y="3" width="18" height="18" rx="2" opacity=".35"/>'),
  hsl: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v9l7 5"/>'),
  grade: svg('<circle cx="8" cy="9" r="5"/><circle cx="16" cy="9" r="5"/><circle cx="12" cy="16" r="5"/>'),
  bw: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  grain: svg('<circle cx="6" cy="6" r="1.2" fill="currentColor"/><circle cx="12" cy="5" r="1" fill="currentColor"/><circle cx="18" cy="7" r="1.4" fill="currentColor"/><circle cx="8" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="18" r="1" fill="currentColor"/><circle cx="11" cy="18" r="1.3" fill="currentColor"/><circle cx="18" cy="17" r="1.1" fill="currentColor"/>'),
  halation: svg('<circle cx="12" cy="12" r="3.5" fill="currentColor"/><circle cx="12" cy="12" r="6.5" opacity=".55"/><circle cx="12" cy="12" r="9.5" opacity=".25"/>'),
  glow: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>'),
  vignette: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><ellipse cx="12" cy="12" rx="5.5" ry="4.5"/>'),
  film: svg('<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8 3v18M16 3v18M4 7h4M4 11h4M4 15h4M16 7h4M16 11h4M16 15h4"/>'),
  masks: svg('<circle cx="10" cy="10" r="6.5" stroke-dasharray="3 2.4"/><path d="M14 20l6.5-6.5a1.8 1.8 0 0 0-2.5-2.5L11.5 17.5 11 20.5z"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
  eye: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  crop: svg('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
  open: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  compare: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/><path d="M12 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7z" fill="currentColor" opacity=".5"/>'),
  hist: svg('<path d="M3 20h18"/><path d="M5 20v-5M9 20V9M13 20v-8M17 20V6M21 20v-3"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  share: svg('<path d="M12 3v13"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
};

const list = (...ids: string[]) => () => ids;

export const TOOLS: ToolDef[] = [
  { id: 'looks', label: 'Looks', icon: ICONS.looks, kind: 'looks', params: list('lookAmt') },
  {
    id: 'light', label: 'Light', icon: ICONS.light, kind: 'params',
    params: list('exposure', 'contrast', 'brightness', 'highlights', 'shadows', 'whites', 'blacks'),
    actions: [{ id: 'auto', label: '✦ Auto' }],
  },
  {
    id: 'color', label: 'Color', icon: ICONS.color, kind: 'params',
    params: list('temp', 'tint', 'vibrance', 'saturation'),
    actions: [{ id: 'autowb', label: '✦ Auto WB' }],
  },
  { id: 'masks', label: 'Masks', icon: ICONS.masks, kind: 'masks', params: () => [] },
  {
    id: 'detail', label: 'Detail', icon: ICONS.detail, kind: 'params',
    params: list('sharpen', 'sharpenRadius', 'sharpenMask', 'texture', 'clarity', 'dehaze', 'denoise', 'colorDenoise'),
  },
  {
    id: 'curves', label: 'Curves', icon: ICONS.curves, kind: 'curves', params: () => [],
    subs: [
      { id: 'rgb', label: 'RGB', color: '#fff' },
      { id: 'r', label: 'Red', color: '#ff453a' },
      { id: 'g', label: 'Green', color: '#32d74b' },
      { id: 'b', label: 'Blue', color: '#0a84ff' },
    ],
    actions: [
      { id: 'curve:linear', label: 'Reset' },
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
    id: 'grade', label: 'Grading', icon: ICONS.grade, kind: 'params',
    subs: GRADE_ZONES.map((z) => ({
      id: z,
      label: { shadows: 'Shadows', mids: 'Midtones', highs: 'Highlights', global: 'Global' }[z],
      color: { shadows: '#3a3a3c', mids: '#8e8e93', highs: '#f2f2f7', global: 'conic' }[z],
    })),
    params: (z) => [`cg_${z}_hue`, `cg_${z}_sat`, `cg_${z}_lum`, 'cg_blend', 'cg_balance'],
  },
  {
    id: 'bw', label: 'B&W', icon: ICONS.bw, kind: 'params',
    params: list('bw', ...HSL_BANDS.map((b) => `bw_${b}`), 'bw_toneHue', 'bw_toneAmt'),
    actions: [{ id: 'bw:toggle', label: 'B&W on/off' }],
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
  {
    id: 'glow', label: 'Glow', icon: ICONS.glow, kind: 'params',
    params: list('glow', 'glowThreshold', 'glowRadius', 'glowWarmth', 'diffuse'),
  },
  {
    id: 'vignette', label: 'Vignette', icon: ICONS.vignette, kind: 'params',
    params: list('vignette', 'vigMidpoint', 'vigFeather', 'vigRound', 'vigHighlights'),
  },
  {
    id: 'film', label: 'Film & Lens', icon: ICONS.film, kind: 'params',
    params: list('fade', 'fadeWarmth', 'ca', 'distortion'),
  },
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
      { id: 'rot', label: '⟳ Rotate' },
      { id: 'flipH', label: '⇋ Flip' },
      { id: 'flipV', label: '⇵ Flip' },
      { id: 'cropReset', label: 'Reset' },
    ],
  },
];
