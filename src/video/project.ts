// The video project: an ordered list of clips on one track, text titles, an optional music
// track and how clips sit in the frame. It lives inside the edit state (EditState.video), so
// undo, redo and the history list cover timeline edits too. The colour/look settings of the
// edit apply to the whole video.

export interface VClip {
  id: string;
  /** media id (see MediaLib) */
  src: string;
  kind: 'video' | 'image';
  /** the part of the source used, in source seconds */
  in: number;
  out: number;
  /** 0.25 … 4 */
  speed: number;
  /** 0 … 2 (1 = as recorded) */
  vol: number;
  /** framing in the project frame (when there are no keyframes) */
  tf?: Framing;
  /** framing keyframes, at source times (so they stay on the same moment when trimmed) */
  kf?: Keyframe[];
}

/** zoom (1 = as fitted), offset in fractions of the frame, rotation in degrees */
export interface Framing {
  z: number;
  x: number;
  y: number;
  r: number;
}
export interface Keyframe extends Framing {
  /** source seconds */
  s: number;
}
export const NO_FRAMING: Framing = { z: 1, x: 0, y: 0, r: 0 };

const easeInOut = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2);

/** The clip's framing at source time s: eased between keyframes, held before / after them. */
export function framingAt(c: VClip, s: number): Framing {
  const K = c.kf;
  if (!K?.length) return c.tf ?? NO_FRAMING;
  const pick = (k: Keyframe): Framing => ({ z: k.z, x: k.x, y: k.y, r: k.r });
  if (s <= K[0].s) return pick(K[0]);
  const last = K[K.length - 1];
  if (s >= last.s) return pick(last);
  let i = 0;
  while (i < K.length - 2 && K[i + 1].s < s) i++;
  const a = K[i], b = K[i + 1];
  const f = easeInOut((s - a.s) / Math.max(1e-6, b.s - a.s));
  // zoom eases in log space, so zooming in and out feel the same speed
  return {
    z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * f),
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    r: a.r + (b.r - a.r) * f,
  };
}

/** Background gradients: [top colour, bottom colour, angle in degrees]. */
export const GRADIENTS: [string, string, number][] = [
  ['#ffc83d', '#ff5a4a', 160], ['#1d2b64', '#f8cdda', 180], ['#0f2027', '#2c5364', 135], ['#ff9a8b', '#ff6a88', 200],
  ['#43cea2', '#185a9d', 150], ['#141414', '#3a3a36', 180], ['#e0c3fc', '#8ec5fc', 135], ['#f7971e', '#ffd200', 90],
];
export const BG_COLORS = ['#000000', '#ffffff', '#141414', '#f2efe8', '#ffc83d', '#ff5a4a', '#5aa8ff', '#7fe0a0', '#c38bff', '#ff9ec7'];

export interface VText {
  id: string;
  text: string;
  /** timeline seconds */
  t0: number;
  t1: number;
  /** centre, as a fraction of the frame */
  x: number;
  y: number;
  /** text height as a fraction of the frame height */
  size: number;
  color: string;
  font: 'pixel' | 'sans' | 'serif';
  box: boolean;
}

export interface VMusic {
  src: string;
  name: string;
  /** where in the song the video starts, seconds */
  in: number;
  vol: number;
  fade: boolean;
}

export type VAspect = 'auto' | '9:16' | '4:5' | '1:1' | '16:9';

export interface VideoProject {
  clips: VClip[];
  texts: VText[];
  music: VMusic | null;
  aspect: VAspect;
  fit: 'fit' | 'fill';
  /** what shows around the picture ('black' / 'white' are from before colours) */
  bg: 'blur' | 'color' | 'gradient' | 'image' | 'black' | 'white';
  bgColor?: string;
  bgGrad?: number;
  /** media id of the photo used as background */
  bgImg?: string | null;
  /** softness of a blurred / photo background, 0 … 100 */
  bgBlur?: number;
}

export const isVideoFile = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(f.name);
export const isAudioFile = (f: File) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(f.name);

export const SPEEDS = { min: 0.25, max: 4 };
export const IMAGE_SECONDS = 3;
/** shortest a clip can be trimmed to, timeline seconds */
export const MIN_CLIP = 0.2;

export function newProject(): VideoProject {
  return { clips: [], texts: [], music: null, aspect: 'auto', fit: 'fit', bg: 'blur' };
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Length of a clip on the timeline. */
export const clipLen = (c: VClip) => (c.out - c.in) / c.speed;

/** Start time of every clip, plus the total length. */
export function layout(p: VideoProject) {
  const starts: number[] = [];
  let t = 0;
  for (const c of p.clips) {
    starts.push(t);
    t += clipLen(c);
  }
  return { starts, total: t };
}

export function totalLength(p: VideoProject) {
  return layout(p).total;
}

/** The clip playing at timeline time T, and the source time within it. */
export function clipAt(p: VideoProject, T: number): { i: number; start: number; src: number } | null {
  const { starts, total } = layout(p);
  if (!p.clips.length) return null;
  T = Math.max(0, Math.min(total - 1e-6, T));
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    const end = starts[i] + clipLen(c);
    if (T < end || i === p.clips.length - 1) {
      return { i, start: starts[i], src: Math.min(c.out - 1e-4, c.in + (T - starts[i]) * c.speed) };
    }
  }
  return null;
}

/** Frame size of the project (preview or export), from the aspect setting and the first clip. */
export function frameAspect(p: VideoProject, firstAspect: number) {
  switch (p.aspect) {
    case '9:16': return 9 / 16;
    case '4:5': return 4 / 5;
    case '1:1': return 1;
    case '16:9': return 16 / 9;
    default: return firstAspect || 16 / 9;
  }
}

/** Even pixel sizes with the long side `long` (encoders want even sizes). */
export function frameSize(aspect: number, long: number) {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  return aspect >= 1 ? { w: even(long), h: even(long / aspect) } : { w: even(long * aspect), h: even(long) };
}

export function fmtTime(t: number, tenths = true) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${m}:${ss}`;
}
