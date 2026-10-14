// Looks per clip. Normally the edit's settings (state.v / state.curves) are the look of the whole
// video. A clip can have its own look instead, and its own look can change over time with
// keyframes (eased between them, like the framing keyframes).
//
// The sliders always edit state.v, so whichever look is being edited lives there: when the
// playhead is on a clip with its own look, that look is swapped into state.v / state.curves
// (project.scope = the clip, project.base = the whole-video look meanwhile). History always stores
// the plain form (see canonical), so undo, redo and their labels don't see the swapping.
import type { Curves, EditState, Values } from '../params';
import type { ClipLook, LookKey, VClip, VideoProject } from './project';

/** settings that switch between choices: they jump at a keyframe instead of easing */
const STEPPED = new Set(['blurType', 'grainMotion', 'dxBlend', 'lkBlend']);
/** settings that aren't part of the look (brushes, positions of things being placed) */
const NOT_LOOK = /^((dx|lk)(Brush|Hard)|healSize)$/;

const ease = (f: number) => (f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** The look's settings at source time s (eased between keyframes, held before / after). */
export function lookValues(look: ClipLook, s: number): Values {
  const K = look.kf;
  if (!K?.length) return look.v;
  if (s <= K[0].s) return K[0].v;
  const last = K[K.length - 1];
  if (s >= last.s) return last.v;
  let i = 0;
  while (i < K.length - 2 && K[i + 1].s < s) i++;
  const a = K[i], b = K[i + 1];
  const f = ease((s - a.s) / Math.max(1e-6, b.s - a.s));
  const out: Values = {};
  for (const k in a.v) {
    const x = a.v[k], y = b.v[k] ?? x;
    out[k] = STEPPED.has(k) || x === y ? x : x + (y - x) * f;
  }
  return out;
}

/** Do two sets of settings differ (in what makes the look)? */
export function sameValues(a: Values, b: Values) {
  for (const k in a) if (!NOT_LOOK.test(k) && Math.abs(a[k] - (b[k] ?? a[k])) > 1e-6) return false;
  return true;
}

/** The keyframe at source time s (within half a frame), or -1. */
export function lookKeyAt(look: ClipLook | undefined, s: number) {
  return look?.kf?.findIndex((k) => Math.abs(k.s - s) < 1 / 60) ?? -1;
}

/** Put the look in force at source time s into a keyframe there (adding one if needed). */
export function upsertKey(look: ClipLook, s: number, v: Values) {
  look.kf ??= [];
  const i = lookKeyAt(look, s);
  const k: LookKey = { s, v: clone(v) };
  if (i >= 0) look.kf[i] = k;
  else {
    look.kf.push(k);
    look.kf.sort((a, b) => a.s - b.s);
  }
}

/** state.v / curves hold the scoped clip's look: put it back in the clip, and the base back in state. */
export function unscopeState(st: EditState) {
  const p = st.video;
  if (!p?.scope) return;
  const c = p.clips.find((x) => x.id === p.scope);
  if (c?.look && !c.look.kf?.length) c.look.v = st.v;
  if (c?.look) c.look.curves = st.curves;
  if (p.base) {
    st.v = p.base.v;
    st.curves = p.base.curves;
  }
  delete p.scope;
  delete p.base;
}

/** The plain form of the state (no clip swapped in): what history stores. */
export function canonical(st: EditState): EditState {
  const c = clone(st);
  unscopeState(c);
  return c;
}

/** The settings (v, curves) a frame of `clip` at source time s is drawn with. */
export function effectiveLook(st: EditState, clip: VClip | null, s: number, live: boolean): { v: Values; curves: Curves } {
  const p = st.video as VideoProject | undefined;
  if (!p || !clip) return { v: st.v, curves: st.curves };
  const look = clip.look;
  if (p.scope && clip.id === p.scope && look) {
    // the clip being edited: its live settings, unless it's animated and this isn't the frame
    // being edited (playback, export)
    return { v: look.kf?.length && !live ? lookValues(look, s) : st.v, curves: st.curves };
  }
  if (look) return { v: lookValues(look, s), curves: look.curves };
  return p.scope && p.base ? p.base : { v: st.v, curves: st.curves };
}

/** A clip's own look, starting from the look it has now. */
export function newLook(v: Values, curves: Curves): ClipLook {
  return { v: clone(v), curves: clone(curves) };
}
