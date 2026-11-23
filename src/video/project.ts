import type { Curves, Values } from '../params';

// The video project: an ordered list of clips on one track, text titles, an optional music
// track, voiceover clips and how clips sit in the frame. It lives inside the edit state
// (EditState.video), so undo, redo and the history list cover timeline edits too. The
// colour/look settings of the edit apply to the whole video.
//
// Transitions take time by overlapping: across a transition of d seconds the outgoing clip's
// last d seconds and the incoming clip's first d seconds play together, so the video gets d
// seconds shorter and the incoming clip starts d seconds before the outgoing one ends. Nothing
// is added or held: every frame shown is a real frame of one of the two clips. layout() is the
// one place that works this out; playback, scrubbing, the timeline, titles' anchors, the sound
// mix and export all take their times from it, so they can't disagree.

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
  /** speed ramp: a preset (or 'custom') and its curve */
  ramp?: Ramp;
  /** the clip's own look (instead of the whole video's), see looks.ts */
  look?: ClipLook;
  /** a still made from a video frame (Freeze) */
  frozen?: boolean;
  /** playing backwards: a reversed copy of this part of the original (the original, to go back) */
  reversed?: { src: string; in: number; out: number };
  /** the transition from this clip into the next one */
  tr?: VTrans;
  /** fade in / out (picture from / to black, sound up / down), timeline seconds */
  fin?: number;
  fout?: number;
}

export type TransKind = 'fade' | 'black' | 'white' | 'zoom' | 'whip' | 'burn';
/** the kinds, as [id, name] */
export const TRANSITIONS: [TransKind, string][] = [
  ['fade', 'Crossfade'], ['black', 'Black'], ['white', 'White'], ['zoom', 'Zoom'], ['whip', 'Whip'], ['burn', 'Burn'],
];
/** transition lengths, seconds */
export const TRANS_LEN = { min: 0.2, max: 2, def: 0.5 };
/** clip fades, seconds */
export const FADE_MAX = 5;

/**
 * A transition at the cut after a clip. It belongs to that cut, not to the clip: `to` is the
 * clip that came next when it was made, and once another clip comes next (the clip after it
 * was deleted or moved, or this one was) it no longer applies (see layout) and is dropped.
 */
export interface VTrans {
  kind: TransKind;
  /** the length asked for, seconds (shorter where the clips are too short for it, see transLen) */
  d: number;
  to: string;
}

/** A voiceover clip: a recording placed on the timeline (it plays at its own speed). */
export interface VVoice {
  id: string;
  /** media id of the recording */
  src: string;
  /** timeline seconds it starts at */
  t0: number;
  /** the part of the recording used, seconds */
  in: number;
  out: number;
  /** 0 … 2 */
  vol: number;
  /** the moment of a clip it starts on, like a title's (it moves with its shot) */
  anchor?: { clip: string; s: number };
}

/**
 * The clip pointed at footage running the other way (a reversed copy, or back to the original),
 * where moment s of the old footage is moment X - s of the new one: its part, keyframes, look
 * keyframes and speed ramp are turned round to match, so they stay on the same moments.
 */
export function flipClip(c: VClip, src: string, X: number) {
  const map = (s: number) => X - s;
  const o0 = c.in, o1 = c.out;
  if (c.kf) c.kf = c.kf.map((k) => ({ ...k, s: map(k.s) })).sort((a, b) => a.s - b.s);
  if (c.look?.kf) c.look.kf = c.look.kf.map((k) => ({ ...k, s: map(k.s) })).sort((a, b) => a.s - b.s);
  if (c.ramp) c.ramp = { id: 'custom', pts: c.ramp.pts.map(([u, m]) => [1 - u, m] as [number, number]).reverse() };
  c.src = src;
  c.in = Math.max(0, map(o1));
  c.out = map(o0);
}

/** A clip's own look: its settings, or keyframes of them at source times (eased in between). */
export interface ClipLook {
  v: Values;
  curves: Curves;
  kf?: LookKey[];
}
export interface LookKey {
  /** source seconds */
  s: number;
  v: Values;
}

/**
 * A speed ramp: speed multipliers (on top of the clip's speed) at points through the clip,
 * [position 0…1 through the used part of the source, multiplier], straight lines in between.
 */
export interface Ramp {
  id: string;
  pts: [number, number][];
}

export const RAMP_MIN = 0.1;
export const RAMP_MAX = 10;
/** the presets, as [name, curve] (named like the usual ones in phone editors) */
export const RAMPS: [string, string, [number, number][]][] = [
  ['montage', 'Montage', [[0, 1], [0.2, 1], [0.3, 3], [0.48, 3], [0.58, 0.5], [0.78, 0.5], [0.88, 2], [1, 2]]],
  ['hero', 'Hero', [[0, 1.5], [0.32, 1.5], [0.42, 0.3], [0.62, 0.3], [0.72, 1.5], [1, 1.5]]],
  ['bullet', 'Bullet', [[0, 3], [0.33, 3], [0.43, 0.2], [0.6, 0.2], [0.7, 3], [1, 3]]],
  ['flashin', 'Flash in', [[0, 4], [0.3, 4], [0.45, 1], [1, 1]]],
  ['flashout', 'Flash out', [[0, 1], [0.55, 1], [0.7, 4], [1, 4]]],
  ['jump', 'Jump cut', [[0, 1], [0.28, 1], [0.33, 6], [0.67, 6], [0.72, 1], [1, 1]]],
];
/** the points a custom ramp starts with (evenly spaced, all 1×) */
export const RAMP_CUSTOM: [number, number][] = [[0, 1], [0.2, 1], [0.4, 1], [0.6, 1], [0.8, 1], [1, 1]];

/** ∫ du / m(u) over [u0, u1] where m goes linearly from m0 to m1 */
const segInv = (u0: number, u1: number, m0: number, m1: number) =>
  Math.abs(m1 - m0) < 1e-9 ? (u1 - u0) / m0 : ((u1 - u0) * Math.log(m1 / m0)) / (m1 - m0);

const rampPts = (c: VClip) => (c.ramp?.pts?.length ?? 0) >= 2 ? c.ramp!.pts : null;

/** Speed multiplier of the ramp at position u (0…1). */
function rampAt(P: [number, number][], u: number) {
  if (u <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) {
    if (u <= P[i][0]) {
      const [u0, m0] = P[i - 1], [u1, m1] = P[i];
      return m0 + ((m1 - m0) * (u - u0)) / Math.max(1e-9, u1 - u0);
    }
  }
  return P[P.length - 1][1];
}

/** The clip's speed at source time s (with the ramp). */
export function speedAt(c: VClip, s: number) {
  const P = rampPts(c);
  if (!P) return c.speed;
  return c.speed * rampAt(P, (s - c.in) / Math.max(1e-9, c.out - c.in));
}

/** Timeline seconds from the clip's start to source time s. */
export function localAt(c: VClip, s: number) {
  const P = rampPts(c);
  const L = c.out - c.in;
  if (!P) return (s - c.in) / c.speed;
  const u = Math.min(1, Math.max(0, (s - c.in) / Math.max(1e-9, L)));
  let acc = 0;
  for (let i = 1; i < P.length; i++) {
    const [u0, m0] = P[i - 1], [u1, m1] = P[i];
    if (u <= u0) break;
    const ue = Math.min(u, u1);
    acc += segInv(u0, ue, m0, m0 + ((m1 - m0) * (ue - u0)) / Math.max(1e-9, u1 - u0));
    if (u <= u1) break;
  }
  return (acc * L) / c.speed;
}

/** Source time at `local` timeline seconds into the clip (the inverse of localAt). */
export function srcAt(c: VClip, local: number) {
  const P = rampPts(c);
  const L = c.out - c.in;
  if (!P) return c.in + local * c.speed;
  // in units of the ramp's integral
  let left = Math.max(0, (local * c.speed) / Math.max(1e-9, L));
  for (let i = 1; i < P.length; i++) {
    const [u0, m0] = P[i - 1], [u1, m1] = P[i];
    const seg = segInv(u0, u1, m0, m1);
    if (left <= seg || i === P.length - 1) {
      if (left > seg) return c.out;
      const a = (m1 - m0) / Math.max(1e-9, u1 - u0);
      // m(u) = m0 + a (u - u0); ∫ du/m = ln(m(u)/m0) / a
      const u = Math.abs(a) < 1e-9 ? u0 + left * m0 : u0 + (m0 * Math.exp(a * left) - m0) / a;
      return c.in + Math.min(1, Math.max(0, u)) * L;
    }
    left -= seg;
  }
  return c.out;
}

/** The part [u0, u1] of a ramp, stretched to 0…1 (splitting a clip keeps each half's speeds). */
export function subRamp(r: Ramp, u0: number, u1: number): Ramp {
  const P = r.pts;
  const pts: [number, number][] = [[0, rampAt(P, u0)]];
  for (const [u, m] of P) if (u > u0 + 1e-6 && u < u1 - 1e-6) pts.push([(u - u0) / (u1 - u0), m]);
  pts.push([1, rampAt(P, u1)]);
  return { id: 'custom', pts };
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

/** The cine frame rates (the look's cineRate setting: Normal, 18, 12, 8 fps): 0 = the footage's own. */
export const CINE_FPS = [0, 18, 12, 8];
export const cineFps = (v: number | undefined) => CINE_FPS[Math.round(v ?? 0)] ?? 0;

/**
 * Where in a clip its picture comes from, `local` timeline seconds into it: held to the cine
 * rate, counted from the clip's own start (so every cut stays where it is and is sharp). The
 * sound isn't held, and an export's frame rate stays its own (it repeats frames).
 */
export const heldLocal = (local: number, fps: number) => (fps > 0 ? Math.floor(local * fps + 1e-6) / fps : local);

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
  /**
   * The moment of a clip the title starts on (clip id, source seconds): trimming, deleting or
   * moving earlier clips, or a speed change, moves the title with its shot.
   */
  anchor?: { clip: string; s: number };
  /** made by Auto captions (making them again replaces these, not titles typed in) */
  auto?: boolean;
}

/** Where a title starting at timeline time t0 is anchored (the clip under it, and its moment). */
export function anchorAt(p: VideoProject, t0: number): VText['anchor'] {
  const at = clipAt(p, t0);
  if (!at) return undefined;
  const c = p.clips[at.i];
  return { clip: c.id, s: c.kind === 'image' ? Math.max(0, t0 - at.start) : at.src };
}

/** Put titles and voiceover clips back on their shots after the timeline changed (keeping their length). */
export function followAnchors(p: VideoProject, skip?: string) {
  const { starts } = layout(p);
  const at = (a: { clip: string; s: number }) => {
    const i = p.clips.findIndex((c) => c.id === a.clip);
    if (i < 0) return null; // its clip is gone: it stays where it was
    const c = p.clips[i];
    const local = c.kind === 'image' ? Math.min(a.s, clipLen(c)) : localAt(c, Math.min(c.out, Math.max(c.in, a.s)));
    return Math.max(0, starts[i] + local);
  };
  for (const t of p.texts) {
    if (!t.anchor || t.id === skip) continue;
    const t0 = at(t.anchor);
    if (t0 === null) continue;
    const len = t.t1 - t.t0;
    t.t0 = t0;
    t.t1 = t.t0 + len;
  }
  for (const v of p.voice ?? []) {
    if (!v.anchor || v.id === skip) continue;
    const t0 = at(v.anchor);
    if (t0 !== null) v.t0 = t0;
  }
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
  /** voiceover clips (none in projects from before voiceovers) */
  voice?: VVoice[];
  /** the music dips while a voiceover clip plays (on unless turned off) */
  duck?: boolean;
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
  /** the clip whose own look is in the edit's settings right now, and the whole-video look meanwhile */
  scope?: string;
  base?: { v: Values; curves: Curves };
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
export const clipLen = (c: VClip) => localAt(c, c.out);

/**
 * How long a transition really is between clips of these lengths: what was asked for, but at
 * most half of either clip, so the transitions at a clip's two ends never overlap each other.
 */
export const transLen = (d: number, lenA: number, lenB: number) => Math.max(0, Math.min(d, lenA / 2, lenB / 2));

/** The transition between clip i - 1 and clip i (if it still applies there). */
export function transInto(p: VideoProject, i: number): VTrans | null {
  const tr = i > 0 ? p.clips[i - 1].tr : undefined;
  return tr && tr.to === p.clips[i]?.id ? tr : null;
}

export interface Layout {
  /** start of every clip */
  starts: number[];
  /** how long clip i overlaps the clip before it (its transition in), 0 for a plain cut */
  ov: number[];
  total: number;
}

/**
 * Start time of every clip, the transitions' overlaps, and the total length. Where a clip has a
 * transition in, it starts that much before the clip before it ends (see the top of the file).
 */
export function layout(p: VideoProject): Layout {
  const starts: number[] = [], ov: number[] = [];
  let t = 0, prev = 0;
  for (let i = 0; i < p.clips.length; i++) {
    const len = clipLen(p.clips[i]);
    const tr = transInto(p, i);
    const o = tr ? transLen(tr.d, prev, len) : 0;
    t -= o;
    starts.push(t);
    ov.push(o);
    t += len;
    prev = len;
  }
  return { starts, ov, total: t };
}

/**
 * Where the picture changes from clip i - 1 to clip i: the cut, or the middle of the transition
 * there. Each clip is "the" clip from its cut to the next (selecting, trimming, splitting and
 * the timeline drawing go by this), although around a transition both play.
 */
export const cutTime = (L: Layout, i: number) => (i <= 0 ? 0 : i >= L.starts.length ? L.total : L.starts[i] + L.ov[i] / 2);

export function totalLength(p: VideoProject) {
  return layout(p).total;
}

/** The clip playing at timeline time T (in a transition, the one it's nearer), and the source time within it. */
export function clipAt(p: VideoProject, T: number, L = layout(p)): { i: number; start: number; src: number } | null {
  const { starts, total } = L;
  if (!p.clips.length) return null;
  T = Math.max(0, Math.min(total - 1e-6, T));
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    if (T < cutTime(L, i + 1) || i === p.clips.length - 1) {
      return { i, start: starts[i], src: Math.min(c.out - 1e-4, srcAt(c, Math.max(0, T - starts[i]))) };
    }
  }
  return null;
}

/** A transition going on at some moment: from clip a to clip b (= a + 1), `f` of the way through it (0…1). */
export interface Mix {
  a: number;
  b: number;
  f: number;
  kind: TransKind;
  /** where it starts and how long it is (timeline seconds) */
  t0: number;
  d: number;
}

/** The transition playing at timeline time T, if any. */
export function mixAt(p: VideoProject, T: number, L = layout(p)): Mix | null {
  for (let i = 1; i < p.clips.length; i++) {
    const d = L.ov[i];
    if (d <= 0 || T < L.starts[i] || T >= L.starts[i] + d) continue;
    return { a: i - 1, b: i, f: Math.min(1, Math.max(0, (T - L.starts[i]) / d)), kind: p.clips[i - 1].tr!.kind, t0: L.starts[i], d };
  }
  return null;
}

/** Drop transitions that no longer apply (their next clip moved or went), so they can't come back by surprise. */
export function cleanTransitions(p: VideoProject) {
  p.clips.forEach((c, i) => {
    if (c.tr && c.tr.to !== p.clips[i + 1]?.id) delete c.tr;
  });
}

/**
 * How far a clip's own fades let it through, `local` timeline seconds into it: 0 (black and
 * silent) … 1. Each fade is at most half the clip.
 */
export function fadeAt(c: VClip, local: number) {
  if (!c.fin && !c.fout) return 1;
  const len = clipLen(c);
  const fi = Math.min(c.fin ?? 0, len / 2), fo = Math.min(c.fout ?? 0, len / 2);
  let k = 1;
  if (fi > 0) k = Math.min(k, local / fi);
  if (fo > 0) k = Math.min(k, (len - local) / fo);
  return Math.max(0, Math.min(1, k));
}

/** Length of a voiceover clip on the timeline. */
export const voiceLen = (v: VVoice) => Math.max(0, v.out - v.in);

/**
 * Where the voiceover is speaking: the voice clips' spans (within the video), with gaps
 * shorter than `join` seconds closed, in order.
 */
export function voiceSpans(p: VideoProject, total: number, join = 0.6): [number, number][] {
  const spans = (p.voice ?? []).filter((v) => v.vol > 0 && voiceLen(v) > 0)
    .map((v) => [Math.max(0, v.t0), Math.min(total, v.t0 + voiceLen(v))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + join) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
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
