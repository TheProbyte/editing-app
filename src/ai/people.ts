// Following the people in a video, for the Person tool: each frame (a small copy of it) goes
// through the same people segmenter the photo masks use, and its mask is eased into the last one,
// so it doesn't flicker; a cut or a jump starts afresh. Playback can't afford every frame on a
// phone, so it asks a few times a second and the picture uses the latest mask; export asks for
// every frame.
import type { ImageSegmenter } from '@mediapipe/tasks-vision';
import { peopleSegmenter } from './segment';

/** the categories that make up a person (hair, body skin, face skin, clothes, accessories) */
const PERSON = [1, 2, 3, 4, 5];
/** the long side of the copy the segmenter is given */
export const PEOPLE_SIZE = 256;

export class PeopleTracker {
  private seg: Promise<ImageSegmenter> | null = null;
  private last: { t: number; clip: string; data: Float32Array; w: number; h: number } | null = null;
  private canvas = document.createElement('canvas');

  /** Load the model (downloaded once, kept on the device). */
  ready(progress: (f: number) => void = () => {}, signal?: AbortSignal) {
    this.seg ??= peopleSegmenter(progress, signal).catch((e) => {
      this.seg = null;
      throw e;
    });
    return this.seg;
  }

  /** Forget the last mask (a new video, or the effect switched off). */
  reset() {
    this.last = null;
  }

  dispose() {
    void this.seg?.then((s) => s.close(), () => {});
    this.seg = null;
    this.last = null;
  }

  /**
   * The person mask of a frame (RGBA pixels, top row first) at video time `t` of clip `clip`:
   * 0..255 per pixel, at the frame's shape with the long side PEOPLE_SIZE.
   */
  async mask(px: Uint8ClampedArray | Uint8Array, w: number, h: number, t: number, clip: string) {
    const seg = await this.ready();
    const c = this.canvas;
    c.width = w;
    c.height = h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4), w, h), 0, 0);
    const r = seg.segment(c);
    let m: Float32Array, mw: number, mh: number;
    try {
      const ms = r.confidenceMasks ?? [];
      if (!ms.length) return null;
      mw = ms[0].width;
      mh = ms[0].height;
      m = new Float32Array(mw * mh);
      for (const k of PERSON) {
        const a = ms[k]?.getAsFloat32Array();
        if (a) for (let i = 0; i < m.length; i++) m[i] += a[i];
      }
    } finally {
      r.close();
    }
    // eased into the last mask when it's the next moment of the same shot (less flicker at the
    // edges); a cut or a jump starts afresh
    const L = this.last;
    if (L && L.clip === clip && L.w === mw && L.h === mh && Math.abs(t - L.t) < 0.25) {
      for (let i = 0; i < m.length; i++) m[i] = m[i] * 0.65 + L.data[i] * 0.35;
    }
    this.last = { t, clip, data: m, w: mw, h: mh };
    const out = new Uint8Array(mw * mh);
    for (let i = 0; i < m.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(m[i] * 255)));
    return { data: out, w: mw, h: mh };
  }
}
