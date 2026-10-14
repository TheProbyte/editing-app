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
}

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
  bg: 'black' | 'blur' | 'white';
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
