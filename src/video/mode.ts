// The video editor. It reuses the photo editor whole: each frame of the timeline is placed
// into a "project frame" texture that the app treats as its photo, so every look and
// adjustment applies to the video. This adds the timeline, playback, the Edit / Canvas /
// Text / Music sections and video export.
import type { GL, Target } from '../gl/glutil';
import type { Pipeline, Source } from '../gl/pipeline';
import type { EditState, ParamDef } from '../params';
import type { Chip, ToolDef } from '../ui/tools';
import { ICONS } from '../ui/icons';
import { tick } from '../ui/haptics';
import { MediaLib, isAudioFile, isVideoFile, type Media } from './media';
import { Player, type Frame } from './player';
import { Compositor, type FrameSource, type GpuFrame, type Placement } from './compose';
import { Timeline, TIMELINE_H, type Sel } from './timeline';
import { exportVideo } from './exporter';
import { AudioEngine } from './audio';
import {
  IMAGE_SECONDS, MIN_CLIP, clipAt, clipLen, fmtTime, frameAspect, frameSize, layout, localAt, newProject, srcAt, subRamp, uid,
  framingAt, GRADIENTS, BG_COLORS, NO_FRAMING, RAMPS, RAMP_CUSTOM, type Framing,
  type VAspect, type VClip, type VText, type VideoProject,
} from './project';
import type { VideoSample } from 'mediabunny';
import { RampEditor } from './rampEditor';
import { effectiveLook, lookKeyAt, lookValues, newLook, sameValues, unscopeState, upsertKey } from './looks';

export interface VideoHost {
  g: GL;
  pipe: Pipeline;
  canvas: HTMLCanvasElement;
  state(): EditState;
  commit(): void;
  requestRender(): void;
  /** render right now (playback: a frame is shown the moment it's due) */
  renderSync(): void;
  /** the render resolution cap changed (see renderCap) */
  syncScale(): void;
  /** the project frame was (re)made: use it as the photo; `resized` = new size */
  frameChanged(src: Source, target: Target, resized: boolean): void;
  toast(msg: string, ms?: number): void;
  busy(msg: string | null): void;
  refreshSection(): void;
  openTool(id: string | null): void;
  toolId(): string | null;
  chip(row: HTMLElement, c: Chip, on: boolean, onClick: () => void): HTMLElement;
  tile(row: HTMLElement, icon: string, label: string, cls: string, onClick: () => void): HTMLElement;
  /** draw the finished edit of `src` onto the screen canvas at w×h */
  renderFull(src: Source, w: number, h: number, st: EditState): void;
  /** the settings in the edit changed underneath the sliders (another clip's look came in) */
  lookChanged(): void;
  save(blob: Blob, name: string): Promise<void>;
}

const PREVIEW_LONG = 1280;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const FONTS: Record<VText['font'], string> = {
  pixel: '"Pixelify Sans", monospace',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
};
const TEXT_COLORS = ['#ffffff', '#ffc83d', '#141414', '#ff5a4a', '#5aa8ff', '#7fe0a0'];
const ROT = { 0: 0, 90: 1, 180: 2, 270: 3 } as const;

const DEFS: Record<string, ParamDef> = {
  'vd.speed': { id: 'vd.speed', label: 'Speed', min: 0.25, max: 4, def: 1, swipe: 3, fmt: (v) => `${+v.toFixed(2)}×` },
  'vd.vol': { id: 'vd.vol', label: 'Volume', min: 0, max: 200, def: 100, fmt: (v) => `${Math.round(v)}%` },
  'vd.tsize': { id: 'vd.tsize', label: 'Size', min: 2, max: 30, def: 8, fmt: (v) => String(Math.round(v)) },
  'vd.mvol': { id: 'vd.mvol', label: 'Volume', min: 0, max: 200, def: 70, fmt: (v) => `${Math.round(v)}%` },
  'vd.min': { id: 'vd.min', label: 'Start at', min: 0, max: 600, def: 0, swipe: 60, fmt: (v) => fmtTime(v) },
  'vd.zoom': { id: 'vd.zoom', label: 'Zoom', min: 25, max: 400, def: 100, swipe: 150, fmt: (v) => `${Math.round(v)}%` },
  'vd.px': { id: 'vd.px', label: 'Position X', min: -100, max: 100, def: 0, fmt: (v) => String(Math.round(v)) },
  'vd.py': { id: 'vd.py', label: 'Position Y', min: -100, max: 100, def: 0, fmt: (v) => String(Math.round(v)) },
  'vd.rot': { id: 'vd.rot', label: 'Rotate', min: -180, max: 180, def: 0, swipe: 90, fmt: (v) => `${Math.round(v)}°` },
  'vd.bgblur': { id: 'vd.bgblur', label: 'Blur', min: 0, max: 100, def: 70, fmt: (v) => String(Math.round(v)) },
};

export class VideoMode {
  lib = new MediaLib();
  audio: AudioEngine;
  player: Player;
  private comp: Compositor;
  private timeline: Timeline;
  private frameT: Target | null = null;
  private exportT: Target | null = null;
  private imgTex = new Map<string, WebGLTexture>();
  /** what's in the frame now, to re-place it when the canvas settings change */
  private last: { src: FrameSource; media: string; clip: string; s: number } | null = null;
  private lastClip() {
    return this.last ? this.project.clips.find((c) => c.id === this.last!.clip) ?? null : null;
  }
  private sel: Sel = null;
  /** the clip's speed-ramp choices are showing (in Edit) */
  private rampOpen = false;
  private rampEd: RampEditor;
  private toolId: string | null = null;
  exporting = false;
  private cancelExport = false;
  readonly tools: ToolDef[];

  constructor(private h: VideoHost) {
    this.comp = new Compositor(h.g);
    this.audio = new AudioEngine(this.lib);
    this.player = new Player(this.lib, () => this.project, this.audio);
    // playback copies each decoded frame to the GPU the moment it arrives
    this.player.upload = (vf) => this.comp.uploadRing(vf, vf.displayWidth, vf.displayHeight);
    this.player.stillMoves = () => this.stillMoves();
    this.player.onFrame = (f) => this.showFrame(f);
    this.player.onTime = () => this.onTime();
    this.rampEd = new RampEditor($('curveWrap').parentElement!, () => this.rampView(), (pts, commit) => {
      const c = this.selClip();
      if (c) this.setRamp(c, { id: 'custom', pts }, commit);
    });
    this.player.onEnd = () => {
      this.syncPlayButton();
      this.rescope();
    };
    this.timeline = new Timeline($('tlTrack'), {
      project: () => this.project,
      time: () => this.player.time,
      scrub: (T) => {
        this.interactive();
        this.player.seek(T, true);
        this.syncPlayButton();
        this.onTime();
      },
      peek: (T) => {
        this.interactive();
        this.player.peek(T, true);
      },
      changed: (commit) => this.changed(commit),
      select: (s) => this.select(s),
      selection: () => this.sel,
    }, this.lib);
    $('tlTrack').style.height = TIMELINE_H + 'px';
    this.lib.onThumbs = () => this.timeline.thumbsChanged();
    const vt = (id: string, label: string, icon: string): ToolDef => ({ id, label, icon, kind: 'video', params: () => this.params(id) });
    this.tools = [vt('vclip', 'Edit', ICONS.clip), vt('vcanvas', 'Canvas', ICONS.canvas), vt('vtext', 'Text', ICONS.text), vt('vmusic', 'Music', ICONS.music)];
    this.bindUI();
  }

  get project(): VideoProject {
    const st = this.h.state();
    st.video ??= newProject();
    return st.video;
  }

  private bindUI() {
    $('tlPlay').innerHTML = ICONS.play;
    $('tlAdd').innerHTML = ICONS.plus;
    $('tlPlay').onclick = () => {
      tick();
      this.togglePlay();
    };
    $('tlAdd').onclick = () => {
      tick();
      this.pickMedia();
    };
    // keep the dock's swipe-up (all tools) from firing on the timeline
    $('timeline').addEventListener('pointerdown', (e) => e.stopPropagation());
    $<HTMLInputElement>('fileAdd').onchange = () => {
      const files = [...($<HTMLInputElement>('fileAdd').files ?? [])];
      if (files.length) void this.addFiles(files);
    };
    $<HTMLInputElement>('fileAudio').onchange = () => {
      const f = $<HTMLInputElement>('fileAudio').files?.[0];
      if (f) void this.setMusic(f);
    };
    this.bindTextSheet();
    this.bindExportSheet();
    // going to the background pauses playback
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.player.playing) this.togglePlay();
    }, { signal: this.life.signal });
    $('busyCancel').onclick = () => {
      this.cancelExport = true;
      $('busyCancel').hidden = true;
    };
  }
  private life = new AbortController();

  // -----------------------------------------------------------------------------------
  // media

  pickMedia() {
    const i = $<HTMLInputElement>('fileAdd');
    i.value = '';
    i.click();
  }

  /** Add files as clips (after the selected clip, else at the end). */
  async addFiles(files: File[]) {
    const p = this.project;
    const first = !p.clips.length;
    let at = this.sel?.kind === 'clip' ? p.clips.findIndex((c) => c.id === this.sel!.id) + 1 : p.clips.length;
    if (at <= 0) at = p.clips.length;
    const added: VClip[] = [];
    for (let k = 0; k < files.length; k++) {
      const f = files[k];
      if (isAudioFile(f) && !isVideoFile(f)) {
        await this.setMusic(f);
        continue;
      }
      this.h.busy(files.length > 1 ? `Opening ${k + 1} of ${files.length}` : 'Opening');
      try {
        const m = await this.lib.add(f);
        this.audio.warm(m);
        if (m.kind === 'audio') continue;
        if (m.kind === 'video') setTimeout(() => void this.player.buildKeys(m), 1200);
        const c: VClip = { id: uid(), src: m.id, kind: m.kind === 'image' ? 'image' : 'video', in: 0, out: m.kind === 'image' ? IMAGE_SECONDS : m.duration, speed: 1, vol: m.audio ? 1 : 0 };
        added.push(c);
      } catch (e) {
        console.error(e);
        this.h.toast((e as Error).message || `Couldn’t open ${f.name}`, 4000);
      }
    }
    this.h.busy(null);
    if (!added.length) return;
    p.clips.splice(at, 0, ...added);
    this.h.commit();
    this.remix();
    this.ensureFrame();
    if (first) this.timeline.fitAll();
    const T = layout(p).starts[at] + 0.001;
    this.player.seek(T);
    this.onTime();
    this.h.refreshSection();
    this.updateTitle();
    if (!first) this.h.toast(added.length > 1 ? `Added ${added.length} clips` : 'Clip added', 1400);
  }

  private async setMusic(f: File) {
    this.h.busy('Opening music');
    try {
      const m = await this.lib.add(f);
      if (!m.audio) throw new Error('No sound in that file');
      this.audio.warm(m);
      this.project.music = { src: m.id, name: f.name.replace(/\.[^.]+$/, ''), in: 0, vol: 0.7, fade: true };
      this.h.commit();
      this.remix();
      this.select({ kind: 'music', id: 'music' });
      this.timeline.draw();
    } catch (e) {
      this.h.toast((e as Error).message || 'Couldn’t open that song', 4000);
    } finally {
      this.h.busy(null);
    }
  }

  // -----------------------------------------------------------------------------------
  // the project frame

  private firstAspect() {
    const c = this.project.clips[0];
    const m = c && this.lib.get(c.src);
    return m && m.w && m.h ? m.w / m.h : 16 / 9;
  }

  /** The frame size for a long side. */
  dims(long: number) {
    return frameSize(frameAspect(this.project, this.firstAspect()), long);
  }

  /**
   * The preview frame's long side: the footage's own size, up to 1280. 480p / 720p clips
   * aren't blown up first (that would be 2× the pixels to push through every frame).
   */
  private previewLong() {
    let L = 0;
    for (const c of this.project.clips) {
      const m = this.lib.get(c.src);
      if (m && m.kind === 'video') L = Math.max(L, m.w, m.h);
    }
    if (!L) L = PREVIEW_LONG; // only stills
    return Math.max(480, Math.min(PREVIEW_LONG, Math.round(L / 2) * 2));
  }

  // ---- placing a frame: the background, and the clip's framing at that moment

  private gradTex(i: number, w: number, h: number) {
    const [a, b, ang] = GRADIENTS[i % GRADIENTS.length];
    const W = 256, H = Math.max(16, Math.round((256 * h) / w));
    return this.comp.canvasTexture(`grad${i}:${W}x${H}`, () => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const x = c.getContext('2d')!;
      const r = (ang * Math.PI) / 180, L = Math.hypot(W, H) / 2;
      const g = x.createLinearGradient(W / 2 - Math.sin(r) * L, H / 2 + Math.cos(r) * L, W / 2 + Math.sin(r) * L, H / 2 - Math.cos(r) * L);
      g.addColorStop(0, b);
      g.addColorStop(1, a);
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
      return c;
    });
  }

  private imageGpu(m: Media): GpuFrame | null {
    if (!m.bitmap) return null;
    let t = this.imgTex.get(m.id);
    if (!t) this.imgTex.set(m.id, (t = this.comp.imageTexture(m.bitmap)));
    return { tex: t, w: m.bitmap.width, h: m.bitmap.height };
  }

  /** How a frame of `clip` (at source time s) sits in a w×h project frame. */
  private placement(clip: VClip | null, s: number, w: number, h: number): Placement {
    const p = this.project;
    const hex = (c: string): [number, number, number] => {
      const n = parseInt(c.replace('#', ''), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    let tf = clip ? framingAt(clip, s) : undefined;
    const lv = clip ? effectiveLook(this.h.state(), clip, s, !this.player.playing && !this.exporting).v : this.h.state().v;
    if (clip && (lv.filmWeave ?? 0) > 0) {
      const wv = this.weave(this.startOf(clip) + localAt(clip, s), lv);
      tf = { ...(tf ?? NO_FRAMING), x: (tf?.x ?? 0) + wv.x, y: (tf?.y ?? 0) + wv.y };
    }
    const kind = p.bg ?? 'blur';
    let bg: Placement['bg'];
    if (kind === 'black' || kind === 'white' || kind === 'color') {
      bg = { kind: 'color', color: hex(kind === 'black' ? '#000000' : kind === 'white' ? '#ffffff' : p.bgColor ?? '#000000'), blur: 0, dim: 1 };
    } else if (kind === 'gradient') {
      bg = { kind: 'tex', color: [0, 0, 0], tex: this.gradTex(p.bgGrad ?? 0, w, h), blur: 0, dim: 1 };
    } else if (kind === 'image') {
      const m = p.bgImg ? this.lib.get(p.bgImg) : null;
      const tex = m ? this.imageGpu(m) : null;
      bg = tex ? { kind: 'tex', color: [0, 0, 0], tex, blur: (p.bgBlur ?? 0) / 100, dim: 1 } : { kind: 'color', color: [0, 0, 0], blur: 0, dim: 1 };
    } else bg = { kind: 'blur', color: [0, 0, 0], blur: (p.bgBlur ?? 70) / 100, dim: 0.72 };
    return { fit: p.fit, bg, tf };
  }

  /** Timeline start of a clip. */
  private startOf(clip: VClip) {
    const p = this.project;
    return layout(p).starts[p.clips.indexOf(clip)] ?? 0;
  }

  /** Source time of `clip` at timeline time T. */
  private srcTime(clip: VClip, T: number) {
    return Math.min(clip.out, Math.max(clip.in, srcAt(clip, T - this.startOf(clip))));
  }

  /** (Re)make the project frame at the preview size. */
  ensureFrame() {
    const { w, h } = this.dims(this.previewLong());
    const resized = !this.frameT || this.frameT.w !== w || this.frameT.h !== h;
    if (resized) {
      if (this.frameT) this.h.g.destroy(this.frameT);
      this.frameT = this.h.g.acquire(w, h, false);
      this.comp.place(this.last?.src ?? null, this.frameT, this.placement(this.lastClip(), this.last?.s ?? 0, w, h));
    }
    this.h.frameChanged({ tex: this.frameT!.tex, w, h, linear: false }, this.frameT!, resized);
  }

  private srcFor(m: Media, sample: VideoSample | null, outLong: number, quality = true, bitmap?: ImageBitmap, pre?: GpuFrame, upright = false): FrameSource {
    if (m.kind === 'image' && m.bitmap) {
      const g = this.imageGpu(m)!;
      return { tex: g.tex, w: g.w, h: g.h, rot: 0, flip: false };
    }
    const rot = upright ? 0 : ROT[(m.video?.rotation ?? 0) as 0 | 90 | 180 | 270] ?? 0;
    if (pre) return { tex: pre.tex, w: pre.w, h: pre.h, rot, flip: false, mip: false };
    if (bitmap) this.comp.upload(bitmap, bitmap.width, bitmap.height, outLong, false);
    else if (sample) {
      const vf = sample.toVideoFrame();
      this.comp.upload(vf, vf.displayWidth, vf.displayHeight, outLong, quality);
      vf.close();
    }
    const r = this.comp.rawFrame;
    return { tex: r.tex, w: r.w, h: r.h, rot, flip: false };
  }

  private showFrame(f: Frame) {
    if (this.exporting) {
      f.sample?.close();
      return;
    }
    if (!this.frameT) this.ensureFrame();
    const src = this.srcFor(f.media, f.sample, this.previewLong(), !this.player.playing, f.bitmap, f.pre, f.upright);
    const s = f.sample?.timestamp ?? f.ts ?? (f.t !== undefined ? this.srcTime(f.clip, f.t) : f.clip.in);
    f.sample?.close();
    this.last = { src, media: f.media.id, clip: f.clip.id, s };
    this.comp.place(src, this.frameT!, this.placement(f.clip, s, this.frameT!.w, this.frameT!.h));
    this.h.pipe.invalidate();
    if (this.player.playing) this.h.renderSync();
    else {
      this.rescope();
      this.h.requestRender();
    }
  }

  // ---- dynamic resolution: while playing or scrubbing, the preview renders as sharp as the
  // phone keeps up with; if frames start arriving late it steps down a little, and climbs
  // back when there's room. Paused, it's always full quality.

  private dyn = 1;
  private busyUntil = 0;
  private capTimer = 0;
  private lastCap = 1;
  private dynCheck = { t: 0, drops: 0, shown: 0, calm: 0 };
  private static LEVELS = [1, 0.85, 0.7, 0.55]; // the app's render-scale steps

  /** The longest side the preview may render at, as a fraction of the project frame. */
  renderCap() {
    return this.player.playing || performance.now() < this.busyUntil ? this.dyn : 1;
  }

  /** A scrub / trim is going on: render at the moving-picture quality for a moment. */
  private interactive() {
    this.busyUntil = performance.now() + 350;
    clearTimeout(this.capTimer);
    this.capTimer = window.setTimeout(() => this.updateCap(), 380);
    this.updateCap();
  }

  private updateCap() {
    const c = this.renderCap();
    if (c !== this.lastCap) {
      this.lastCap = c;
      this.h.syncScale();
    }
  }

  private tuneResolution() {
    const now = performance.now(), d = this.dynCheck, P = this.player;
    if (now - d.t < 1000) return;
    const drops = P.drops - d.drops, shown = P.shown - d.shown;
    d.t = now;
    d.drops = P.drops;
    d.shown = P.shown;
    if (drops + shown < 8) return;
    const L = VideoMode.LEVELS;
    const i = L.indexOf(this.dyn);
    if (drops / (drops + shown) > 0.06 && i < L.length - 1) {
      this.dyn = L[i + 1];
      d.calm = 0;
    } else if (drops === 0 && ++d.calm >= 3 && i > 0) {
      this.dyn = L[i - 1];
      d.calm = 0;
    }
    this.updateCap();
  }

  /** Settings that move the picture itself changed (e.g. gate weave): place the frame again. */
  refreshFrame() {
    this.replace();
  }

  /** Canvas settings changed: place the current frame again. */
  private replace() {
    this.ensureFrame();
    if (this.frameT) this.comp.place(this.last?.src ?? null, this.frameT, this.placement(this.lastClip(), this.last?.s ?? 0, this.frameT.w, this.frameT.h));
    this.h.pipe.invalidate();
    this.h.requestRender();
  }

  // ---- text titles, laid over the finished picture

  private visibleTexts(T: number) {
    return this.project.texts.filter((t) => T >= t.t0 && T < t.t1);
  }

  private paintTexts(texts: VText[]) {
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      for (const t of texts) {
        const px = Math.max(6, t.size / 100 * h);
        ctx.font = `700 ${px}px ${FONTS[t.font]}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lines = t.text.split('\n');
        const lh = px * 1.18;
        const x = t.x * w, y0 = t.y * h - ((lines.length - 1) * lh) / 2;
        if (t.box) {
          const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + px * 0.9;
          const bh = lines.length * lh + px * 0.4;
          ctx.fillStyle = t.color === '#141414' ? 'rgba(255,255,255,0.85)' : 'rgba(10,10,10,0.6)';
          ctx.fillRect(Math.round(x - bw / 2), Math.round(t.y * h - bh / 2), Math.round(bw), Math.round(bh));
        } else {
          ctx.shadowColor = 'rgba(0,0,0,0.45)';
          ctx.shadowBlur = px * 0.18;
          ctx.shadowOffsetY = px * 0.04;
        }
        ctx.fillStyle = t.color;
        lines.forEach((l, k) => ctx.fillText(l, x, y0 + k * lh));
        ctx.shadowColor = 'transparent';
      }
    };
  }

  private textLayer(T: number, w: number, h: number) {
    const vis = this.visibleTexts(T);
    if (!vis.length) return this.comp.setText('', w, h, null);
    this.comp.setText(JSON.stringify([vis, w, h]), w, h, this.paintTexts(vis));
  }

  // ---- film: grain that moves, flicker and gate weave, all keyed to the film frame at T, so
  // the preview and the export match frame for frame

  private hash(i: number, k: number) {
    let x = (i * 374761393 + k * 668265263) | 0;
    x = (x ^ (x >>> 13)) * 1274126177;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  /** The film frame number at timeline time T (grain changes on each one). */
  private filmRate(v = this.h.state().v) {
    return [0, 12, 24, this.sourceFps()][Math.round(v.grainMotion ?? 2)] ?? 24;
  }

  /**
   * Grain seed, dust seed and flicker for the frame at T (handed to the pipeline before it
   * renders). Grain moves at the Motion rate (or not at all on Still); dust and flicker always
   * move, at that rate or 24 fps.
   */
  film(T: number, v = this.h.state().v) {
    const rate = this.filmRate(v);
    const i = rate ? Math.floor(T * rate + 1e-6) : 0;
    const j = Math.floor(T * (rate || 24) + 1e-6);
    const fl = (v.filmFlicker ?? 0) / 100;
    return { seed: (1337 + i * 7919) % 1000003, dust: (7331 + j * 104729) % 1000003, flicker: fl ? fl * 0.09 * (this.hash(j, 1) * 2 - 1) : 0 };
  }

  /** Gate weave: a small drift of the picture that moves on film frames. */
  private weave(T: number, v = this.h.state().v) {
    const a = (v.filmWeave ?? 0) / 100;
    if (!a) return { x: 0, y: 0 };
    const i = Math.floor(T * 24);
    // smooth-ish random walk: two slow waves plus a little per-frame jitter
    const x = Math.sin(i * 0.21) * 0.6 + Math.sin(i * 0.067 + 1.3) * 0.4 + (this.hash(i, 7) - 0.5) * 0.5;
    const y = Math.sin(i * 0.17 + 2.1) * 0.6 + Math.sin(i * 0.051) * 0.4 + (this.hash(i, 9) - 0.5) * 0.8;
    return { x: x * a * 0.004, y: y * a * 0.007 };
  }

  /** Moving grain and dust are noise the encoder has to keep: give it the bits for that. */
  private grainBoost() {
    const v = this.h.state().v;
    const moving = (v.grainMotion ?? 2) > 0 ? v.grain / 100 : 0;
    return 1 + Math.min(1.5, moving * 1.5 + ((v.filmDust ?? 0) / 100) * 0.2);
  }

  /** Does a still need re-rendering while it plays (moving grain etc.)? */
  stillMoves() {
    const v = this.h.state().v;
    return (v.grain > 0 && (v.grainMotion ?? 2) > 0) || (v.filmFlicker ?? 0) > 0 || (v.filmWeave ?? 0) > 0 || (v.filmDust ?? 0) > 0;
  }

  /** Copy any frame texture to the screen canvas (export with no adjustments). */
  blitTex(tex: WebGLTexture, w: number, h: number) {
    this.comp.blit(tex, w, h);
  }

  /** No adjustments at all: the frame goes to the screen as it is (one copy, no pipeline). */
  blitFrame(w: number, h: number) {
    if (this.frameT) this.comp.blit(this.frameT.tex, w, h);
  }

  /** Called by the app around its render of the preview. */
  afterRender(w: number, h: number) {
    this.textLayer(this.player.time, w, h);
    this.comp.drawText(w, h);
  }

  // -----------------------------------------------------------------------------------
  // playback

  togglePlay() {
    if (this.player.playing) {
      this.player.pause();
      this.player.seek(this.player.time);
    } else {
      if (!this.project.clips.length) return this.pickMedia();
      this.dynCheck = { t: performance.now(), drops: 0, shown: 0, calm: 0 };
      void this.player.play().then(() => {
        this.syncPlayButton();
        this.updateCap();
      });
    }
    this.syncPlayButton();
  }

  private syncPlayButton() {
    $('tlPlay').innerHTML = this.player.playing ? ICONS.pause : ICONS.play;
    $('tlPlay').classList.toggle('on', this.player.playing);
  }

  private lastTextKey = '';
  private lastLabel = '';
  private onTime() {
    const T = this.player.time;
    const total = layout(this.project).total;
    // the label changes ten times a second at most: only touch the DOM then
    const label = `<b>${fmtTime(T)}</b> / ${fmtTime(total)}`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      $('tlTime').innerHTML = label;
    }
    if (this.rampEd.shown) this.rampEd.draw();
    if (this.player.playing) {
      // in the playback loop: paint with this frame, not one refresh later
      this.timeline.paintNow();
      this.tuneResolution();
    } else {
      this.timeline.draw();
      this.updateCap();
    }
    // titles appearing or going away need a render even on a still frame
    const key = this.visibleTexts(T).map((t) => t.id).join();
    if (key !== this.lastTextKey) {
      this.lastTextKey = key;
      this.h.requestRender();
    }
  }


  seek(T: number) {
    this.player.seek(T);
    this.onTime();
    this.syncPlayButton();
  }

  // -----------------------------------------------------------------------------------
  // selection and edits

  private select(s: Sel) {
    this.sel = s;
    this.timeline.draw();
    const tool = this.h.toolId();
    if (s?.kind === 'clip') this.h.openTool('vclip');
    else if (s?.kind === 'text') this.h.openTool('vtext');
    else if (s?.kind === 'music') this.h.openTool('vmusic');
    else if (tool === 'vclip') this.h.refreshSection();
    else this.h.refreshSection();
  }

  private selClip() {
    return this.sel?.kind === 'clip' ? this.project.clips.find((c) => c.id === this.sel!.id) ?? null : null;
  }
  private selText() {
    return this.sel?.kind === 'text' ? this.project.texts.find((t) => t.id === this.sel!.id) ?? null : null;
  }

  /** Rebuild the soundtrack in the background a moment after the last edit. */
  private remixTimer = 0;
  private remix() {
    clearTimeout(this.remixTimer);
    this.remixTimer = window.setTimeout(() => void this.audio.mix(this.project), 250);
  }

  private changed(commit: boolean) {
    this.remix();
    this.rescope();
    // clips are shorter / longer: text past the end comes back in
    const total = layout(this.project).total;
    for (const t of this.project.texts) {
      if (t.t1 > total) t.t1 = Math.max(t.t0 + 0.3, total);
      if (t.t0 >= total) {
        t.t0 = Math.max(0, total - 1);
        t.t1 = total;
      }
    }
    this.h.requestRender();
    this.updateTitle();
    this.onTime();
    if (commit) {
      this.h.commit();
      this.h.refreshSection();
    }
  }

  /** After undo / redo / history: the timeline and frame follow the restored state. */
  onRestore() {
    const p = this.project;
    this.kfAnchor = null;
    this.rescope();
    this.remix();
    if (this.sel?.kind === 'clip' && !p.clips.some((c) => c.id === this.sel!.id)) this.sel = null;
    if (this.sel?.kind === 'text' && !p.texts.some((t) => t.id === this.sel!.id)) this.sel = null;
    if (this.sel?.kind === 'music' && !p.music) this.sel = null;
    this.ensureFrame();
    this.replace(); // background / framing from the restored state, straight away
    this.player.seek(Math.min(this.player.time, layout(p).total));
    this.updateTitle();
    this.onTime();
  }

  updateTitle() {
    const p = this.project;
    const n = p.clips.length;
    this.info = `${n} clip${n === 1 ? '' : 's'} · ${fmtTime(layout(p).total, false)}`;
    if (!this.h.toolId()) $('title').textContent = this.info;
  }
  info = '';

  private split() {
    this.unscope();
    const p = this.project;
    const T = this.player.time;
    const at = clipAt(p, T);
    if (!at) return;
    const c = p.clips[at.i];
    const local = T - at.start;
    if (local < MIN_CLIP || clipLen(c) - local < MIN_CLIP) return this.h.toast('Move the playhead into the clip to split it');
    const cut = srcAt(c, local);
    const b: VClip = { ...c, id: uid(), in: cut, look: c.look && JSON.parse(JSON.stringify(c.look)) };
    if (c.ramp) {
      // each half keeps its part of the ramp
      const u = (cut - c.in) / (c.out - c.in);
      b.ramp = subRamp(c.ramp, u, 1);
      c.ramp = subRamp(c.ramp, 0, u);
    }
    c.out = cut;
    p.clips.splice(at.i + 1, 0, b);
    this.sel = { kind: 'clip', id: b.id };
    tick(true);
    this.changed(true);
  }

  private clipAction(what: 'delete' | 'copy' | 'mute') {
    this.unscope();
    const p = this.project;
    const c = this.selClip();
    if (!c) return;
    const i = p.clips.indexOf(c);
    if (what === 'delete') {
      p.clips.splice(i, 1);
      this.sel = p.clips[i] ? { kind: 'clip', id: p.clips[i].id } : p.clips[i - 1] ? { kind: 'clip', id: p.clips[i - 1].id } : null;
      if (!p.clips.length) this.last = null;
      this.ensureFrame();
      this.player.seek(Math.min(this.player.time, layout(p).total));
    } else if (what === 'copy') {
      const d = { ...c, id: uid(), look: c.look && JSON.parse(JSON.stringify(c.look)) };
      p.clips.splice(i + 1, 0, d);
      this.sel = { kind: 'clip', id: d.id };
    } else {
      c.vol = c.vol > 0 ? 0 : 1;
    }
    tick(true);
    this.changed(true);
  }

  // ---- text

  private textEditing: VText | null = null;
  private bindTextSheet() {
    const sheet = $('textSheet');
    const input = $<HTMLTextAreaElement>('textInput');
    const close = () => {
      sheet.classList.remove('on');
      input.blur();
    };
    $('textDone').onclick = () => {
      const v = input.value.trim();
      close();
      if (!v) return;
      const p = this.project;
      if (this.textEditing) {
        this.textEditing.text = v;
      } else {
        const T = this.player.time;
        const total = Math.max(0.5, layout(p).total);
        const t0 = Math.min(T, Math.max(0, total - 0.5));
        const t: VText = { id: uid(), text: v, t0, t1: Math.min(total, t0 + 3), x: 0.5, y: 0.5, size: 8, color: '#ffffff', font: 'pixel', box: false };
        p.texts.push(t);
        this.sel = { kind: 'text', id: t.id };
      }
      tick();
      this.changed(true);
      this.h.toast('Drag it on the video · its bar in the timeline sets when it shows', 2600);
    };
    $('textCancel').onclick = close;
    sheet.onclick = (e) => {
      if (e.target === sheet) close();
    };
  }

  private editText(t: VText | null) {
    this.textEditing = t;
    const input = $<HTMLTextAreaElement>('textInput');
    input.value = t?.text ?? '';
    $('textSheet').classList.add('on');
    setTimeout(() => input.focus(), 60);
  }

  /**
   * Touches on the video. Text section: drag a title. Edit section (on the selected clip):
   * one finger moves the clip, two pinch to zoom and twist to rotate it; a tap still plays.
   * Returns true when it takes the touch.
   */
  private tdrag: { id: string; x0: number; y0: number; fx: number; fy: number } | null = null;
  private cdrag: { id: string; x0: number; y0: number; f0: Framing; moved: boolean; pinch?: { d0: number; a0: number; mx: number; my: number } } | null = null;
  stageDown(e: PointerEvent, frameRect: DOMRect) {
    const tool = this.h.toolId();
    if (tool === 'vclip') {
      const c = this.selClip();
      if (!c || !this.onClip(c)) return false;
      this.cdrag = { id: c.id, x0: e.clientX, y0: e.clientY, f0: { ...framingAt(c, this.sNow(c)) }, moved: false };
      return true;
    }
    if (tool !== 'vtext') return false;
    const T = this.player.time;
    const u = (e.clientX - frameRect.left) / frameRect.width, v = (e.clientY - frameRect.top) / frameRect.height;
    // the nearest visible title under the finger (generous hit area)
    let best: VText | null = null, bd = 0.12;
    for (const t of this.visibleTexts(T)) {
      const d = Math.hypot(u - t.x, (v - t.y) * (frameRect.height / frameRect.width));
      if (d < bd + t.size / 200) {
        bd = d;
        best = t;
      }
    }
    if (!best) return false;
    this.sel = { kind: 'text', id: best.id };
    this.tdrag = { id: best.id, x0: e.clientX, y0: e.clientY, fx: best.x, fy: best.y };
    this.h.refreshSection();
    this.timeline.draw();
    tick();
    return true;
  }

  /** A second finger: pinch / twist the selected clip (Edit section). */
  stagePinchStart(a: { x: number; y: number }, b: { x: number; y: number }) {
    if (this.h.toolId() !== 'vclip') return false;
    const c = this.selClip();
    if (!c || !this.onClip(c)) return false;
    this.cdrag = {
      id: c.id, x0: 0, y0: 0, f0: { ...framingAt(c, this.sNow(c)) }, moved: true,
      pinch: { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 },
    };
    return true;
  }
  stagePinch(a: { x: number; y: number }, b: { x: number; y: number }, frameRect: DOMRect) {
    const d = this.cdrag, P = d?.pinch;
    const c = d && this.project.clips.find((x) => x.id === d.id);
    if (!d || !P || !c) return;
    let r = d.f0.r + ((Math.atan2(b.y - a.y, b.x - a.x) - P.a0) * 180) / Math.PI;
    r = ((r + 540) % 360) - 180;
    for (const snap of [0, 90, -90, 180, -180]) if (Math.abs(r - snap) < 3) r = snap;
    const z = Math.max(0.25, Math.min(4, (d.f0.z * Math.hypot(a.x - b.x, a.y - b.y)) / P.d0));
    const x = d.f0.x + ((a.x + b.x) / 2 - P.mx) / frameRect.width;
    const y = d.f0.y + ((a.y + b.y) / 2 - P.my) / frameRect.height;
    this.setFraming(c, { z: Math.abs(z - 1) < 0.02 ? 1 : z, x, y, r });
  }

  stageMove(e: PointerEvent, frameRect: DOMRect) {
    const cd = this.cdrag;
    if (cd && !cd.pinch) {
      const c = this.project.clips.find((x) => x.id === cd.id);
      if (!c) return;
      if (!cd.moved && Math.hypot(e.clientX - cd.x0, e.clientY - cd.y0) < 8) return;
      cd.moved = true;
      let x = cd.f0.x + (e.clientX - cd.x0) / frameRect.width, y = cd.f0.y + (e.clientY - cd.y0) / frameRect.height;
      if (Math.abs(x) < 0.012) x = 0;
      if (Math.abs(y) < 0.012) y = 0;
      this.setFraming(c, { x, y });
      return;
    }
    const d = this.tdrag;
    const t = d && this.project.texts.find((x) => x.id === d.id);
    if (!d || !t) return;
    t.x = Math.max(0, Math.min(1, d.fx + (e.clientX - d.x0) / frameRect.width));
    t.y = Math.max(0, Math.min(1, d.fy + (e.clientY - d.y0) / frameRect.height));
    // snap to the centre lines
    if (Math.abs(t.x - 0.5) < 0.015) t.x = 0.5;
    if (Math.abs(t.y - 0.5) < 0.015) t.y = 0.5;
    this.h.requestRender();
  }

  /** A touch handed over to pinch-zooming the view: drop any drag without side effects. */
  stageCancel() {
    this.cdrag = null;
    this.tdrag = null;
  }

  stageUp() {
    const cd = this.cdrag;
    if (cd) {
      this.cdrag = null;
      if (cd.moved) {
        this.changed(true);
        this.h.refreshSection();
      } else this.togglePlay();
      return;
    }
    if (!this.tdrag) return;
    this.tdrag = null;
    this.h.commit();
  }


  // ---- framing and keyframes

  /** Source time of the playhead within clip c (its nearest end if the playhead is elsewhere). */
  private sNow(c: VClip) {
    return this.srcTime(c, this.player.time);
  }

  /** Is the playhead on clip c? */
  private onClip(c: VClip) {
    const st = this.startOf(c), T = this.player.time;
    return T >= st - 1e-3 && T <= st + clipLen(c) + 1e-3;
  }

  /** Change the framing at the playhead: into a keyframe there if the clip has keyframes. */
  private setFraming(c: VClip, patch: Partial<Framing>) {
    if (c.kf?.length) {
      const s = this.sNow(c);
      let k = c.kf.find((x) => Math.abs(x.s - s) < 1 / 60);
      if (!k) {
        k = { ...framingAt(c, s), s };
        c.kf.push(k);
        c.kf.sort((a, b) => a.s - b.s);
      }
      Object.assign(k, patch);
    } else c.tf = { ...(c.tf ?? NO_FRAMING), ...patch };
    this.replace();
  }

  /** A keyframe at the playhead? */
  private keyHere(c: VClip) {
    const s = this.sNow(c);
    return c.kf?.findIndex((x) => Math.abs(x.s - s) < 1 / 60) ?? -1;
  }

  private toggleKey(c: VClip) {
    if (!this.onClip(c)) return this.h.toast('Move the playhead onto the clip first');
    const s = this.sNow(c);
    const i = this.keyHere(c);
    if (i >= 0) {
      const f = framingAt(c, s);
      c.kf!.splice(i, 1);
      if (!c.kf!.length) {
        delete c.kf;
        c.tf = { z: f.z, x: f.x, y: f.y, r: f.r };
      }
    } else {
      c.kf ??= [];
      c.kf.push({ ...framingAt(c, s), s });
      c.kf.sort((a, b) => a.s - b.s);
      if (c.kf.length === 1) this.h.toast('Keyframe added · move the playhead and change the framing for the next one', 2800);
    }
    tick(true);
    this.changed(true);
    this.replace();
  }

  /** A slow push in across the clip (photos especially). */
  private kenBurns(c: VClip) {
    const r = () => (Math.random() - 0.5) * 0.06;
    c.kf = [{ s: c.in, z: 1, x: 0, y: 0, r: 0 }, { s: c.out, z: 1.22, x: r(), y: r(), r: 0 }];
    delete c.tf;
    tick(true);
    this.changed(true);
    this.replace();
  }

  // ---- looks per clip (see looks.ts)

  /** when the clip in the edit is animated: where (clip, source time) its settings were loaded from */
  private kfAnchor: { clip: string; s: number; v: string } | null = null;

  /** The clip under the playhead. */
  playClip(): VClip | null {
    const at = clipAt(this.project, this.player.time);
    return at ? this.project.clips[at.i] : null;
  }

  /** Settings edited on an animated clip go into a keyframe at the moment they were edited at. */
  private flushKey() {
    const p = this.project, a = this.kfAnchor;
    const c = p.scope ? p.clips.find((x) => x.id === p.scope) : null;
    if (!a || !c?.look?.kf?.length || a.clip !== c.id) return;
    const st = this.h.state();
    const json = JSON.stringify(st.v);
    if (json === a.v) return;
    if (!sameValues(st.v, lookValues(c.look, a.s))) upsertKey(c.look, a.s, st.v);
    a.v = json;
  }

  /** Before each history step. */
  beforeCommit() {
    this.flushKey();
  }

  /** The look being edited goes back where it belongs (before clips are copied, deleted…). */
  private unscope() {
    this.flushKey();
    unscopeState(this.h.state());
    this.kfAnchor = null;
  }

  /**
   * The sliders edit the look in force at the playhead: the clip's own, if it has one (swapped
   * into the edit's settings), else the whole video's. Animated, they show the values there.
   */
  rescope() {
    if (this.player.playing || this.exporting) return;
    const st = this.h.state(), p = this.project;
    const c = this.playClip();
    const want = c?.look ? c.id : undefined;
    const before = p.scope;
    if (p.scope && p.scope !== want) this.unscope();
    if (c?.look && p.scope !== want) {
      p.base = { v: st.v, curves: st.curves };
      st.v = JSON.parse(JSON.stringify(c.look.kf?.length ? lookValues(c.look, this.sNow(c)) : c.look.v));
      st.curves = JSON.parse(JSON.stringify(c.look.curves));
      p.scope = want;
      this.kfAnchor = null;
    }
    let reloaded = false;
    if (c?.look?.kf?.length) {
      const s = this.sNow(c);
      const a = this.kfAnchor;
      if (!a || a.clip !== c.id || Math.abs(a.s - s) > 1e-4) {
        this.flushKey();
        if (a?.clip === c.id) st.v = JSON.parse(JSON.stringify(lookValues(c.look, s)));
        this.kfAnchor = { clip: c.id, s, v: JSON.stringify(st.v) };
        reloaded = !!a;
      }
    } else this.kfAnchor = null;
    if (before !== p.scope || reloaded) this.h.lookChanged();
  }

  /** The edit as a frame of `clip` at source time s is drawn (its clip's look, animated). */
  lookState(st: EditState, clip: VClip | null = this.lastClip(), s = this.last?.s ?? 0, live = !this.player.playing): EditState {
    if (!st.video) return st;
    const L = effectiveLook(st, clip, s, live);
    return L.v === st.v && L.curves === st.curves ? st : { ...st, v: L.v, curves: L.curves };
  }

  /** The look switch at the front of an adjustment section: whole video / this clip, keyframe. */
  scopeChips(row: HTMLElement) {
    const c = this.playClip();
    if (!c) return;
    const own = !!c.look;
    this.h.chip(row, { id: 'all', label: 'All clips' }, !own, () => {
      if (!c.look) return;
      this.unscope();
      delete c.look;
      this.h.toast('This clip follows the whole video’s look again', 2200);
      this.lookEdited();
    });
    this.h.chip(row, { id: 'clip', label: 'This clip' }, own, () => {
      if (c.look) return;
      this.giveLook(c);
      this.h.toast('Changes now apply to this clip only', 2200);
      this.lookEdited();
    });
    const k = lookKeyAt(c.look, this.sNow(c)) >= 0;
    const b = this.h.chip(row, { id: 'key', label: '◆ Key' }, k, () => this.toggleLookKey(c));
    b.classList.add('keychip');
    row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
  }

  /** Clip c gets its own look, starting from the one it shows now. */
  private giveLook(c: VClip) {
    const st = this.h.state();
    this.unscope();
    c.look = newLook(st.v, st.curves);
    this.rescope();
  }

  private toggleLookKey(c: VClip) {
    if (!this.onClip(c)) return this.h.toast('Move the playhead onto the clip first');
    if (!c.look) this.giveLook(c);
    const look = c.look!;
    const s = this.sNow(c);
    const i = lookKeyAt(look, s);
    const st = this.h.state();
    if (i >= 0) {
      look.kf!.splice(i, 1);
      if (!look.kf!.length) {
        delete look.kf;
        look.v = JSON.parse(JSON.stringify(st.v));
      }
    } else {
      upsertKey(look, s, st.v);
      if (look.kf!.length === 1) this.h.toast('Look keyframe added · move the playhead and change the look for the next one', 3000);
    }
    this.kfAnchor = look.kf?.length ? { clip: c.id, s, v: JSON.stringify(st.v) } : null;
    tick(true);
    this.lookEdited();
  }

  private lookEdited() {
    this.timeline.draw();
    this.h.requestRender();
    this.h.commit();
    this.h.refreshSection();
  }

  /** Give the clip a speed ramp (null: none), keeping the playhead on the same moment of it. */
  private setRamp(c: VClip, r: VClip['ramp'] | null, commit: boolean) {
    const p = this.project;
    const start = layout(p).starts[p.clips.indexOf(c)];
    const T = this.player.time;
    const inside = this.onClip(c);
    const srcT = srcAt(c, T - start);
    if (r) c.ramp = r;
    else delete c.ramp;
    if (inside) this.player.seek(start + localAt(c, srcT));
    if (commit) tick();
    this.timeline.draw();
    this.changed(commit);
    this.syncRampEd();
  }

  private rampView() {
    const c = this.selClip();
    if (!c?.ramp) return null;
    const s = this.sNow(c);
    return { pts: c.ramp.pts, at: this.onClip(c) ? (s - c.in) / Math.max(1e-6, c.out - c.in) : null, base: c.speed };
  }

  /** The ramp curve shows while its choices do, for a clip that has one. */
  private syncRampEd() {
    const c = this.selClip();
    const on = this.toolId === 'vclip' && this.rampOpen && c?.kind === 'video' && !!c.ramp;
    this.rampEd.show(on);
  }

  /** The app's open section changed (null: none). */
  toolShown(id: string | null) {
    if (id !== 'vclip') this.rampOpen = false;
    this.toolId = id;
    this.syncRampEd();
  }

  private resetFraming(c: VClip) {
    delete c.kf;
    delete c.tf;
    tick(true);
    this.changed(true);
    this.replace();
  }

  // -----------------------------------------------------------------------------------
  // sections

  private params(id: string): string[] {
    if (id === 'vclip') {
      const c = this.selClip();
      if (!c) return [];
      const fr = ['vd.zoom', 'vd.px', 'vd.py', 'vd.rot'];
      return c.kind === 'image' ? fr : [...(this.lib.get(c.src)?.audio ? ['vd.speed', 'vd.vol'] : ['vd.speed']), ...fr];
    }
    if (id === 'vcanvas') return this.project.bg === 'blur' || this.project.bg === 'image' ? ['vd.bgblur'] : [];
    if (id === 'vtext') return this.selText() ? ['vd.tsize'] : [];
    if (id === 'vmusic') return this.project.music ? ['vd.mvol', 'vd.min'] : [];
    return [];
  }

  def(id: string): ParamDef {
    if (id === 'vd.min') {
      const m = this.project.music && this.lib.get(this.project.music.src);
      return { ...DEFS[id], max: Math.max(1, (m?.duration ?? 60) - 1) };
    }
    return DEFS[id];
  }

  get(id: string) {
    const c = this.selClip(), t = this.selText(), mu = this.project.music;
    switch (id) {
      case 'vd.speed': return c?.speed ?? 1;
      case 'vd.vol': return (c?.vol ?? 1) * 100;
      case 'vd.tsize': return t?.size ?? 8;
      case 'vd.mvol': return (mu?.vol ?? 0.7) * 100;
      case 'vd.min': return mu?.in ?? 0;
      case 'vd.bgblur': return this.project.bgBlur ?? (this.project.bg === 'image' ? 0 : 70);
    }
    if (c && /^vd\.(zoom|px|py|rot)$/.test(id)) {
      const f = framingAt(c, this.sNow(c));
      return id === 'vd.zoom' ? f.z * 100 : id === 'vd.px' ? f.x * 100 : id === 'vd.py' ? f.y * 100 : f.r;
    }
    return 0;
  }

  set(id: string, v: number) {
    const c = this.selClip(), t = this.selText(), mu = this.project.music;
    if (id === 'vd.speed' && c) {
      // keep the playhead on the same moment of this clip
      const p = this.project;
      const i = p.clips.indexOf(c);
      const start = layout(p).starts[i];
      const T = this.player.time;
      const inside = T >= start && T <= start + clipLen(c);
      const srcT = srcAt(c, T - start);
      c.speed = Math.round(v * 20) / 20;
      if (inside) this.player.seek(start + localAt(c, srcT));
      this.changed(false);
    } else if (id === 'vd.vol' && c) c.vol = v / 100;
    else if (id === 'vd.tsize' && t) {
      t.size = v;
      this.h.requestRender();
    } else if (id === 'vd.mvol' && mu) mu.vol = v / 100;
    else if (id === 'vd.min' && mu) mu.in = v;
    else if (id === 'vd.bgblur') {
      this.project.bgBlur = v;
      this.replace();
    } else if (c && /^vd\.(zoom|px|py|rot)$/.test(id)) {
      this.setFraming(c, id === 'vd.zoom' ? { z: v / 100 } : id === 'vd.px' ? { x: v / 100 } : id === 'vd.py' ? { y: v / 100 } : { r: v });
    }
    this.timeline.draw();
    this.remix();
  }

  buildSubs(t: ToolDef, row: HTMLElement) {
    const p = this.project;
    if (t.id === 'vcanvas') {
      const opts: [VAspect, string][] = [['auto', 'Original'], ['9:16', '9:16'], ['4:5', '4:5'], ['1:1', '1:1'], ['16:9', '16:9']];
      for (const [a, label] of opts) {
        this.h.chip(row, { id: a, label }, p.aspect === a, () => {
          p.aspect = a;
          this.replace();
          this.h.commit();
          this.h.refreshSection();
        });
      }
    } else if (t.id === 'vtext') {
      const tx = this.selText();
      if (!tx) return;
      for (const [f, label] of [['pixel', 'Pixel'], ['sans', 'Sans'], ['serif', 'Serif']] as const) {
        this.h.chip(row, { id: f, label }, tx.font === f, () => {
          tx.font = f;
          this.changed(true);
        });
      }
      for (const col of TEXT_COLORS) {
        const b = document.createElement('button');
        b.className = 'dotchip' + (tx.color === col ? ' on' : '');
        b.setAttribute('aria-label', 'Colour');
        b.innerHTML = `<i style="background:${col}"></i>`;
        b.onclick = () => {
          tick();
          tx.color = col;
          this.changed(true);
        };
        row.appendChild(b);
      }
    }
  }

  buildActs(t: ToolDef, row: HTMLElement) {
    const p = this.project;
    this.syncRampEd();
    const sep = () => row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
    if (t.id === 'vclip' && this.rampOpen && this.selClip()?.kind === 'video') {
      // speed ramp: the presets, and the curve above the timeline to shape it
      const c = this.selClip()!;
      this.h.tile(row, ICONS.check, 'Done', '', () => {
        this.rampOpen = false;
        this.h.refreshSection();
      });
      sep();
      this.h.chip(row, { id: 'none', label: 'None' }, !c.ramp, () => this.setRamp(c, null, true));
      for (const [id, label, pts] of RAMPS) {
        this.h.chip(row, { id, label }, c.ramp?.id === id, () => this.setRamp(c, { id, pts: pts.map((q) => [q[0], q[1]] as [number, number]) }, true));
      }
      this.h.chip(row, { id: 'custom', label: 'Custom' }, c.ramp?.id === 'custom', () => {
        if (c.ramp?.id !== 'custom') this.setRamp(c, { id: 'custom', pts: (c.ramp?.pts ?? RAMP_CUSTOM).map((q) => [q[0], q[1]] as [number, number]) }, true);
        this.h.toast('Drag the points up to speed up, down to slow down', 2600);
      });
      this.syncRampEd();
      return;
    }
    if (t.id === 'vclip') {
      const c = this.selClip();
      this.h.tile(row, ICONS.plus, 'Add', '', () => this.pickMedia());
      if (!c) return;
      sep();
      this.h.tile(row, ICONS.split, 'Split', '', () => this.split());
      this.h.tile(row, ICONS.duplicate, 'Copy', '', () => this.clipAction('copy'));
      const m = this.lib.get(c.src);
      if (m?.audio) this.h.tile(row, c.vol > 0 ? ICONS.sound : ICONS.mute, c.vol > 0 ? 'Mute' : 'Unmute', c.vol > 0 ? '' : 'hot', () => this.clipAction('mute'));
      this.h.tile(row, ICONS.trash, 'Delete', 'danger', () => this.clipAction('delete'));
      sep();
      if (c.kind === 'video') this.h.tile(row, ICONS.ramp, 'Ramp', c.ramp ? 'hot' : '', () => {
        this.rampOpen = true;
        this.h.refreshSection();
      });
      this.h.tile(row, ICONS.key, 'Keyframe', this.keyHere(c) >= 0 ? 'hot' : '', () => this.toggleKey(c));
      this.h.tile(row, ICONS.kenburns, 'Ken Burns', '', () => this.kenBurns(c));
      if (c.kf?.length || c.tf) this.h.tile(row, ICONS.reset, 'Reset', '', () => this.resetFraming(c));
    } else if (t.id === 'vcanvas') {
      this.h.tile(row, ICONS.canvas, 'Fit', p.fit === 'fit' ? 'on' : '', () => this.setFit('fit'));
      this.h.tile(row, ICONS.crop, 'Fill', p.fit === 'fill' ? 'on' : '', () => this.setFit('fill'));
      sep();
      const kind = p.bg === 'black' || p.bg === 'white' ? 'color' : p.bg;
      const setBg = (patch: Partial<VideoProject>) => {
        Object.assign(p, patch);
        this.replace();
        this.h.commit();
        this.h.refreshSection();
      };
      for (const [b, label] of [['blur', 'Blur'], ['color', 'Color'], ['gradient', 'Gradient'], ['image', 'Photo']] as const) {
        this.h.chip(row, { id: b, label }, kind === b, () => {
          if (b === 'image' && !p.bgImg) return this.pickBgImage();
          setBg({ bg: b, bgColor: p.bgColor ?? (p.bg === 'white' ? '#ffffff' : '#000000') });
        });
      }
      const dot = (bg: string, on: boolean, onClick: () => void) => {
        const b = document.createElement('button');
        b.className = 'dotchip' + (on ? ' on' : '');
        b.innerHTML = `<i style="background:${bg}"></i>`;
        b.onclick = () => {
          tick();
          onClick();
        };
        row.appendChild(b);
      };
      if (kind === 'color') {
        sep();
        for (const c of BG_COLORS) dot(c, (p.bgColor ?? '#000000') === c, () => setBg({ bg: 'color', bgColor: c }));
      } else if (kind === 'gradient') {
        sep();
        GRADIENTS.forEach(([a, b2, ang], i) => dot(`linear-gradient(${ang}deg, ${b2}, ${a})`, (p.bgGrad ?? 0) === i, () => setBg({ bg: 'gradient', bgGrad: i })));
      } else if (kind === 'image') {
        sep();
        this.h.tile(row, ICONS.image, 'Change', '', () => this.pickBgImage());
      }
    } else if (t.id === 'vtext') {
      const tx = this.selText();
      this.h.tile(row, ICONS.plus, 'Add', tx ? '' : 'hot', () => this.editText(null));
      if (!tx) return;
      sep();
      this.h.tile(row, ICONS.text, 'Edit', '', () => this.editText(tx));
      this.h.tile(row, ICONS.box, 'Box', tx.box ? 'hot' : '', () => {
        tx.box = !tx.box;
        this.changed(true);
      });
      this.h.tile(row, ICONS.trash, 'Delete', 'danger', () => {
        p.texts.splice(p.texts.indexOf(tx), 1);
        this.sel = null;
        tick(true);
        this.changed(true);
      });
    } else if (t.id === 'vmusic') {
      this.h.tile(row, ICONS.music, p.music ? 'Replace' : 'Choose', p.music ? '' : 'hot', () => {
        const i = $<HTMLInputElement>('fileAudio');
        i.value = '';
        i.click();
      });
      if (!p.music) return;
      sep();
      const mu = p.music;
      this.h.tile(row, ICONS.fade, 'Fade', mu.fade ? 'hot' : '', () => {
        mu.fade = !mu.fade;
        this.changed(true);
      });
      this.h.tile(row, ICONS.trash, 'Remove', 'danger', () => {
        p.music = null;
        this.sel = null;
        tick(true);
        this.changed(true);
      });
    }
  }

  /** Section opened: some need a nudge (nothing selected yet). */
  onOpenTool(id: string) {
    const p = this.project;
    if (id === 'vclip' && !this.selClip() && p.clips.length) {
      const at = clipAt(p, this.player.time);
      if (at) {
        this.sel = { kind: 'clip', id: p.clips[at.i].id };
        this.timeline.draw();
      }
    }
    if (id === 'vtext' && !p.texts.length) setTimeout(() => this.editText(null), 160);
    if (id === 'vmusic' && !p.music) {
      const i = $<HTMLInputElement>('fileAudio');
      i.value = '';
      setTimeout(() => i.click(), 160);
    }
  }

  private pickBgImage() {
    const i = $<HTMLInputElement>('fileBg');
    i.value = '';
    i.onchange = async () => {
      const f = i.files?.[0];
      if (!f) return;
      try {
        const m = await this.lib.add(f);
        if (m.kind !== 'image') throw new Error('Pick a photo for the background');
        const p = this.project;
        p.bg = 'image';
        p.bgImg = m.id;
        p.bgBlur ??= 0;
        this.replace();
        this.h.commit();
        this.h.refreshSection();
      } catch (e) {
        this.h.toast((e as Error).message, 3000);
      }
    };
    i.click();
  }

  private setFit(f: 'fit' | 'fill') {
    this.project.fit = f;
    this.replace();
    this.h.commit();
    this.h.refreshSection();
  }

  isModified(id: string) {
    const p = this.project;
    if (id === 'vcanvas') return p.aspect !== 'auto' || p.fit !== 'fit' || p.bg !== 'blur' || (p.bgBlur ?? 70) !== 70;
    if (id === 'vtext') return p.texts.length > 0;
    if (id === 'vmusic') return !!p.music;
    if (id === 'vclip') return p.clips.some((c) => c.speed !== 1 || !!c.ramp || !!c.kf?.length || !!c.tf || (!!this.lib.get(c.src)?.audio && c.vol !== 1));
    return false;
  }

  // -----------------------------------------------------------------------------------
  // export

  private ex = { res: 1080, fps: 30, q: 'high' as 'high' | 'max' };

  private sourceLong() {
    let L = 0;
    for (const c of this.project.clips) {
      const m = this.lib.get(c.src);
      if (m) L = Math.max(L, m.w, m.h);
    }
    return L || 1920;
  }
  private sourceFps() {
    let f = 0;
    for (const c of this.project.clips) {
      const m = this.lib.get(c.src);
      if (m?.kind === 'video') f = Math.max(f, m.fps);
    }
    return f > 45 ? 60 : f > 26 ? 30 : f ? 24 : 30;
  }

  openExport() {
    if (!this.project.clips.length) return this.h.toast('Add a clip first');
    this.player.pause();
    this.syncPlayButton();
    const L = this.sourceLong();
    // the footage's own size, up to 1080p (1440p / 4K are there to pick)
    this.ex.res = L >= 1800 ? 1920 : L >= 1200 ? 1280 : 720;
    this.ex.fps = this.sourceFps();
    this.buildExport();
    $('vexSheet').classList.add('on');
  }

  private buildExport() {
    const L = this.sourceLong();
    const seg = (id: string, opts: [string, string, boolean][], cur: string, set: (v: string) => void) => {
      const box = $(id);
      box.innerHTML = '';
      for (const [v, label, ok] of opts) {
        if (!ok) continue;
        const b = document.createElement('button');
        b.innerHTML = label;
        b.classList.toggle('on', v === cur);
        b.onclick = () => {
          tick();
          set(v);
          this.buildExport();
        };
        box.appendChild(b);
      }
    };
    const dimLabel = (long: number) => {
      const d = this.dims(long);
      return `<small>${d.w}×${d.h}</small>`;
    };
    seg('vxRes', [
      ['1280', '720p' + dimLabel(1280), true],
      ['1920', '1080p' + dimLabel(1920), L >= 1200],
      ['2560', '1440p' + dimLabel(2560), L >= 2000],
      ['3840', '4K' + dimLabel(3840), L >= 2500],
    ], String(this.ex.res), (v) => (this.ex.res = +v));
    seg('vxFps', [['24', '24', true], ['30', '30', true], ['60', '60', true]], String(this.ex.fps), (v) => (this.ex.fps = +v));
    seg('vxQ', [['high', 'High', true], ['max', 'Max', true]], this.ex.q, (v) => (this.ex.q = v as 'high' | 'max'));
    const d = this.dims(this.ex.res);
    const total = layout(this.project).total;
    const mbps = Math.min(80e6, d.w * d.h * this.ex.fps * (this.ex.q === 'max' ? 0.3 : 0.16)) / 1e6;
    const mb = (mbps * total) / 8 + (0.192 * total) / 8;
    $('vxHint').textContent = `${fmtTime(total, false)} · about ${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB · MP4`;
  }

  private bindExportSheet() {
    const sheet = $('vexSheet');
    $('vxCancel').onclick = () => sheet.classList.remove('on');
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
    $('vxGo').onclick = () => {
      sheet.classList.remove('on');
      void this.doExport();
    };
  }

  private async doExport() {
    const { w, h } = this.dims(this.ex.res);
    const st = this.h.state();
    this.exporting = true;
    this.cancelExport = false;
    this.player.pause();
    const canvas = this.h.canvas;
    const keep = { w: canvas.width, h: canvas.height };
    this.h.busy('Exporting 0%');
    $('busyCancel').hidden = false;
    let ok = false;
    try {
      canvas.width = w;
      canvas.height = h;
      this.exportT = this.h.g.acquire(w, h, false);
      const out = this.exportT;
      const blob = await exportVideo({
        lib: this.lib, audio: this.audio, project: st.video!, canvas, w, h, fps: this.ex.fps, quality: this.ex.q, boost: this.grainBoost(),
        drawFrame: (clip, m, sample, T) => {
          const look = this.lookState(this.h.state(), clip, sample?.timestamp ?? this.srcTime(clip, T), false);
          this.h.pipe.filmFrame = this.film(T, look.v);
          const src = this.srcFor(m, sample, Math.max(w, h));
          this.comp.place(src, out, this.placement(clip, sample?.timestamp ?? this.srcTime(clip, T), w, h));
          this.h.renderFull({ tex: out.tex, w, h, linear: false }, w, h, look);
          const vis = this.visibleTexts(T);
          this.comp.setText(vis.length ? JSON.stringify([vis, w, h]) : '', w, h, vis.length ? this.paintTexts(vis) : null);
          this.comp.drawText(w, h);
        },
        progress: (f, stage) => this.h.busy(stage === 'Exporting' ? `Exporting ${Math.round(f * 100)}%` : stage),
        cancelled: () => this.cancelExport,
      });
      ok = true;
      this.h.busy('Saving');
      const name = `lumen-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.mp4`;
      await this.h.save(blob, name);
    } catch (e) {
      if ((e as Error).name === 'AbortError') this.h.toast('Export cancelled');
      else {
        console.error(e);
        this.h.toast('Export failed: ' + ((e as Error).message || 'unknown error'), 5000);
      }
    } finally {
      this.exporting = false;
      $('busyCancel').hidden = true;
      if (this.exportT) this.h.g.destroy(this.exportT);
      this.exportT = null;
      this.h.g.trim(2048 * 2048);
      canvas.width = keep.w;
      canvas.height = keep.h;
      this.h.busy(null);
      this.h.pipe.invalidate();
      // the raw frame now holds the export's last frame: show the playhead's frame again
      this.player.seek(this.player.time);
      this.h.requestRender();
      void ok;
    }
  }

  // -----------------------------------------------------------------------------------

  /** Release everything (leaving video mode). */
  dispose() {
    this.life.abort();
    this.rampEd.el.remove();
    this.player.dispose();
    this.comp.dispose();
    const gl = this.h.g.gl;
    for (const t of this.imgTex.values()) gl.deleteTexture(t);
    this.imgTex.clear();
    if (this.frameT) this.h.g.destroy(this.frameT);
    this.frameT = null;
    for (const m of this.lib.items.values()) {
      m.bitmap?.close();
      m.input?.dispose?.();
    }
    this.lib.items.clear();
    $('tlTrack').innerHTML = '';
  }
}
