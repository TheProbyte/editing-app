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
import { Compositor, type FrameSource } from './compose';
import { Timeline, TIMELINE_H, type Sel } from './timeline';
import { exportVideo } from './exporter';
import {
  IMAGE_SECONDS, MIN_CLIP, clipAt, clipLen, fmtTime, frameAspect, frameSize, layout, newProject, uid,
  type VAspect, type VClip, type VText, type VideoProject,
} from './project';
import type { VideoSample } from 'mediabunny';

export interface VideoHost {
  g: GL;
  pipe: Pipeline;
  canvas: HTMLCanvasElement;
  state(): EditState;
  commit(): void;
  requestRender(): void;
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
  renderFull(src: Source, w: number, h: number): void;
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
};

export class VideoMode {
  lib = new MediaLib();
  player: Player;
  private comp: Compositor;
  private timeline: Timeline;
  private frameT: Target | null = null;
  private exportT: Target | null = null;
  private imgTex = new Map<string, WebGLTexture>();
  /** what's in the frame now, to re-place it when the canvas settings change */
  private last: { src: FrameSource; media: string } | null = null;
  private sel: Sel = null;
  exporting = false;
  private cancelExport = false;
  readonly tools: ToolDef[];

  constructor(private h: VideoHost) {
    this.comp = new Compositor(h.g);
    this.player = new Player(this.lib, () => this.project);
    this.player.onFrame = (f) => this.showFrame(f);
    this.player.onTime = () => this.onTime();
    this.player.onEnd = () => this.syncPlayButton();
    this.timeline = new Timeline($('tlTrack'), {
      project: () => this.project,
      time: () => this.player.time,
      scrub: (T) => {
        this.player.seek(T);
        this.syncPlayButton();
        this.onTime();
      },
      peek: (T) => this.player.peek(T),
      changed: (commit) => this.changed(commit),
      select: (s) => this.select(s),
      selection: () => this.sel,
    }, this.lib);
    $('tlTrack').style.height = TIMELINE_H + 'px';
    this.lib.onThumbs = () => this.timeline.draw();
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
        if (m.kind === 'audio') continue;
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
      this.project.music = { src: m.id, name: f.name.replace(/\.[^.]+$/, ''), in: 0, vol: 0.7, fade: true };
      this.h.commit();
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

  /** (Re)make the project frame at the preview size. */
  ensureFrame() {
    const { w, h } = this.dims(PREVIEW_LONG);
    const resized = !this.frameT || this.frameT.w !== w || this.frameT.h !== h;
    if (resized) {
      if (this.frameT) this.h.g.destroy(this.frameT);
      this.frameT = this.h.g.acquire(w, h, false);
      this.comp.place(this.last?.src ?? null, this.frameT, this.project);
    }
    this.h.frameChanged({ tex: this.frameT!.tex, w, h, linear: false }, this.frameT!, resized);
  }

  private srcFor(m: Media, sample: VideoSample | null, outLong: number, quality = true): FrameSource {
    if (m.kind === 'image' && m.bitmap) {
      let t = this.imgTex.get(m.id);
      if (!t) this.imgTex.set(m.id, (t = this.comp.imageTexture(m.bitmap)));
      return { tex: t, w: m.bitmap.width, h: m.bitmap.height, rot: 0, flip: false };
    }
    if (sample) {
      const vf = sample.toVideoFrame();
      this.comp.upload(vf, vf.displayWidth, vf.displayHeight, outLong, quality);
      vf.close();
    }
    const r = this.comp.rawFrame;
    return { tex: r.tex, w: r.w, h: r.h, rot: ROT[(m.video?.rotation ?? 0) as 0 | 90 | 180 | 270] ?? 0, flip: false };
  }

  private showFrame(f: Frame) {
    if (this.exporting) {
      f.sample?.close();
      return;
    }
    if (!this.frameT) this.ensureFrame();
    const src = this.srcFor(f.media, f.sample, PREVIEW_LONG, !this.player.playing);
    f.sample?.close();
    this.last = { src, media: f.media.id };
    this.comp.place(src, this.frameT!, this.project);
    this.h.pipe.invalidate();
    this.h.requestRender();
  }

  /** Canvas settings changed: place the current frame again. */
  private replace() {
    this.ensureFrame();
    if (this.frameT) this.comp.place(this.last?.src ?? null, this.frameT, this.project);
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
      void this.player.play().then(() => this.syncPlayButton());
    }
    this.syncPlayButton();
  }

  private syncPlayButton() {
    $('tlPlay').innerHTML = this.player.playing ? ICONS.pause : ICONS.play;
    $('tlPlay').classList.toggle('on', this.player.playing);
  }

  private lastTextKey = '';
  private onTime() {
    const T = this.player.time;
    const total = layout(this.project).total;
    $('tlTime').innerHTML = `<b>${fmtTime(T)}</b> / ${fmtTime(total)}`;
    this.timeline.draw();
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

  private changed(commit: boolean) {
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
    if (this.sel?.kind === 'clip' && !p.clips.some((c) => c.id === this.sel!.id)) this.sel = null;
    if (this.sel?.kind === 'text' && !p.texts.some((t) => t.id === this.sel!.id)) this.sel = null;
    if (this.sel?.kind === 'music' && !p.music) this.sel = null;
    this.ensureFrame();
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
    const p = this.project;
    const T = this.player.time;
    const at = clipAt(p, T);
    if (!at) return;
    const c = p.clips[at.i];
    const local = T - at.start;
    if (local < MIN_CLIP || clipLen(c) - local < MIN_CLIP) return this.h.toast('Move the playhead into the clip to split it');
    const cut = c.in + local * c.speed;
    const b: VClip = { ...c, id: uid(), in: cut };
    c.out = cut;
    p.clips.splice(at.i + 1, 0, b);
    this.sel = { kind: 'clip', id: b.id };
    tick(true);
    this.changed(true);
  }

  private clipAction(what: 'delete' | 'copy' | 'mute') {
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
      const d = { ...c, id: uid() };
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

  /** Dragging a title on the video (Text section). Returns true if it took the touch. */
  private tdrag: { id: string; x0: number; y0: number; fx: number; fy: number; d0?: number; s0?: number } | null = null;
  stageDown(e: PointerEvent, frameRect: DOMRect) {
    if (this.h.toolId() !== 'vtext') return false;
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
  stageMove(e: PointerEvent, frameRect: DOMRect) {
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
  stageUp() {
    if (!this.tdrag) return;
    this.tdrag = null;
    this.h.commit();
  }

  // -----------------------------------------------------------------------------------
  // sections

  private params(id: string): string[] {
    if (id === 'vclip') return this.selClip() ? ['vd.speed', 'vd.vol'] : [];
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
      const srcT = c.in + (T - start) * c.speed;
      c.speed = Math.round(v * 20) / 20;
      if (inside) this.player.seek(start + (srcT - c.in) / c.speed);
      this.changed(false);
    } else if (id === 'vd.vol' && c) c.vol = v / 100;
    else if (id === 'vd.tsize' && t) {
      t.size = v;
      this.h.requestRender();
    } else if (id === 'vd.mvol' && mu) mu.vol = v / 100;
    else if (id === 'vd.min' && mu) mu.in = v;
    this.timeline.draw();
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
    const sep = () => row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
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
    } else if (t.id === 'vcanvas') {
      this.h.tile(row, ICONS.canvas, 'Fit', p.fit === 'fit' ? 'on' : '', () => this.setFit('fit'));
      this.h.tile(row, ICONS.crop, 'Fill', p.fit === 'fill' ? 'on' : '', () => this.setFit('fill'));
      if (p.fit === 'fit') {
        sep();
        for (const [b, label] of [['blur', 'Blur'], ['black', 'Black'], ['white', 'White']] as const) {
          this.h.chip(row, { id: b, label }, p.bg === b, () => {
            p.bg = b;
            this.replace();
            this.h.commit();
            this.h.refreshSection();
          });
        }
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

  private setFit(f: 'fit' | 'fill') {
    this.project.fit = f;
    this.replace();
    this.h.commit();
    this.h.refreshSection();
  }

  isModified(id: string) {
    const p = this.project;
    if (id === 'vcanvas') return p.aspect !== 'auto' || p.fit !== 'fit' || p.bg !== 'blur';
    if (id === 'vtext') return p.texts.length > 0;
    if (id === 'vmusic') return !!p.music;
    if (id === 'vclip') return p.clips.some((c) => c.speed !== 1 || (!!this.lib.get(c.src)?.audio && c.vol !== 1));
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
    this.ex.res = L >= 2000 ? 1920 : L >= 1200 ? 1280 : 720;
    if (this.ex.res === 1920 && L >= 3000) this.ex.res = 1920; // 4K is a choice, not the default
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
        lib: this.lib, project: st.video!, canvas, w, h, fps: this.ex.fps, quality: this.ex.q,
        drawFrame: (clip, m, sample, T) => {
          const src = this.srcFor(m, sample, Math.max(w, h));
          this.comp.place(src, out, this.project);
          this.h.renderFull({ tex: out.tex, w, h, linear: false }, w, h);
          const vis = this.visibleTexts(T);
          this.comp.setText(vis.length ? JSON.stringify([vis, w, h]) : '', w, h, vis.length ? this.paintTexts(vis) : null);
          this.comp.drawText(w, h);
          void clip;
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
