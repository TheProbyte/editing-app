// The video editor. It reuses the photo editor whole: each frame of the timeline is placed
// into a "project frame" texture that the app treats as its photo, so every look and
// adjustment applies to the video. This adds the timeline, playback, the Edit / Transition /
// Canvas / Text / Music / Voice sections and video export.
//
// Across a transition both clips' frames are placed and joined into the project frame (each
// with its own framing; the look eases from one clip's to the other's). What has to end up
// truly black or white whatever the look does, fades and dips and a film burn's flash, is laid
// over the finished picture afterwards (afterRender, and the same in export).
import type { GL, Target } from '../gl/glutil';
import type { Pipeline, Source } from '../gl/pipeline';
import type { EditState, ParamDef } from '../params';
import type { Chip, ToolDef } from '../ui/tools';
import { ICONS } from '../ui/icons';
import { tick } from '../ui/haptics';
import { MediaLib, STILL_LONG, isAudioFile, isVideoFile, type Media } from './media';
import { Player, type Frame } from './player';
import { Compositor, type FrameSource, type GpuFrame, type Overlay, type Placement } from './compose';
import { Timeline, timelineHeight, type Sel } from './timeline';
import { exportVideo, type OtherFrame } from './exporter';
import { AudioEngine, type SpeechSeg } from './audio';
import {
  IMAGE_SECONDS, MIN_CLIP, clipAt, clipLen, fmtTime, frameAspect, frameSize, layout, localAt, newProject, speedAt, srcAt, subRamp, uid,
  framingAt, GRADIENTS, BG_COLORS, NO_FRAMING, RAMPS, RAMP_CUSTOM, anchorAt, followAnchors, flipClip, type Framing,
  type VAspect, type VClip, type VText, type VideoProject,
  TRANSITIONS, TRANS_LEN, FADE_MAX, cleanTransitions, cineFps, heldLocal, cutTime, fadeAt, mixAt, transInto, type TransKind, type VVoice,
} from './project';
import type { VideoSample } from 'mediabunny';
import { RampEditor } from './rampEditor';
import { REVERSE_MAX } from './reverse';
import { effectiveLook, lookKeyAt, lookValues, newLook, sameValues, unscopeState, upsertKey } from './looks';
import { VoiceRecorder, assemble, speechSpan, wavFile } from './voice';
import { Captioner, CAPTIONS_MB, splitCaptions, type Caption } from '../ai/captions';
import { PeopleTracker, PEOPLE_SIZE } from '../ai/people';
import { defaultState } from '../params';

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
  /** the picture is changing every frame (playing, exporting): the bars over it drop their blur */
  setLive(on: boolean): void;
  save(blob: Blob, name: string): Promise<void>;
  /** ask before going ahead (the confirm sheet) */
  confirm(title: string, text: string, yes: () => void, o?: { yes?: string; no?: string; onNo?: () => void }): void;
  /** a job the busy screen's Cancel (or Back) stops: call done() when it ends */
  cancellable(): { signal: AbortSignal; done(): void };
  /** speech to text, for auto captions */
  captions: Captioner;
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
  'vd.trd': { id: 'vd.trd', label: 'Duration', min: TRANS_LEN.min, max: TRANS_LEN.max, def: TRANS_LEN.def, fmt: (v) => `${v.toFixed(1)} s` },
  'vd.fin': { id: 'vd.fin', label: 'Fade in', min: 0, max: FADE_MAX, def: 0, fmt: (v) => `${v.toFixed(1)} s` },
  'vd.fout': { id: 'vd.fout', label: 'Fade out', min: 0, max: FADE_MAX, def: 0, fmt: (v) => `${v.toFixed(1)} s` },
  'vd.vvol': { id: 'vd.vvol', label: 'Volume', min: 0, max: 200, def: 100, fmt: (v) => `${Math.round(v)}%` },
};

/** How much of the incoming clip's look (and fades) show, f of the way through a transition. */
function mixWeight(kind: TransKind, f: number) {
  const ss = (a: number, b: number) => {
    const x = Math.min(1, Math.max(0, (f - a) / (b - a)));
    return x * x * (3 - 2 * x);
  };
  if (kind === 'black' || kind === 'white') return f < 0.5 ? 0 : 1;
  if (kind === 'zoom') return ss(0.42, 0.58);
  if (kind === 'burn') return ss(0.4, 0.6);
  return f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VideoMode {
  lib = new MediaLib();
  audio: AudioEngine;
  player: Player;
  private comp: Compositor;
  private timeline: Timeline;
  private frameT: Target | null = null;
  private exportT: Target | null = null;
  private imgTex = new Map<string, WebGLTexture>();
  /**
   * what's in the frame now, to re-place it when the canvas settings change: the clip's frame,
   * the timeline time it's for, and across a transition the other clip's frame too
   */
  private last: { src: FrameSource; media: string; clip: string; s: number; T?: number; solo?: boolean; other?: { src: FrameSource; clip: string; s: number } } | null = null;
  private lastClip() {
    return this.last ? this.project.clips.find((c) => c.id === this.last!.clip) ?? null : null;
  }
  private sel: Sel = null;
  /** the clip's speed-ramp choices are showing (in Edit) */
  private rampOpen = false;
  /** the clip's fades are showing (in Edit), and which one the slider sets first */
  private fadeOpen = false;
  private fadeEnd: 'in' | 'out' = 'in';
  /** a voiceover being recorded (counting in, then recording) */
  private rec: { r: VoiceRecorder; startT: number; ctxStart: number; delay: number; phase: 'count' | 'rec'; n: number } | null = null;
  /** a transition's preview plays until this timeline time (0: no preview) */
  private previewUntil = 0;
  private rampEd: RampEditor;
  private toolId: string | null = null;
  exporting = false;
  private cancelExport = false;
  readonly tools: ToolDef[];

  constructor(private h: VideoHost) {
    this.comp = new Compositor(h.g);
    this.audio = new AudioEngine(this.lib);
    this.audio.onPeaks = () => this.timeline?.thumbsChanged();
    this.player = new Player(this.lib, () => this.project, this.audio);
    // playback copies each decoded frame to the GPU the moment it arrives
    this.player.upload = (vf, ring) => this.comp.uploadRing(vf, vf.displayWidth, vf.displayHeight, ring);
    this.player.stillMoves = () => this.stillMoves();
    this.player.cine = (c) => this.cineOf(c);
    this.player.onFrame = (f) => this.showFrame(f);
    this.player.onTime = () => this.onTime();
    this.rampEd = new RampEditor($('curveWrap').parentElement!, () => this.rampView(), (pts, commit) => {
      const c = this.selClip();
      if (c) this.setRamp(c, { id: 'custom', pts }, commit);
    });
    this.player.onEnd = () => {
      this.previewUntil = 0;
      if (this.rec) void this.stopVoice();
      this.syncPlayButton();
      this.rescope();
    };
    this.timeline = new Timeline($('tlTrack'), {
      peaks: (id) => {
        const m = this.lib.get(id);
        return m ? this.audio.peaks(m) : null;
      },
      project: () => this.project,
      time: () => this.player.time,
      scrub: (T) => {
        this.interactive();
        this.people?.reset();
        this.player.seek(T, true);
        this.syncPlayButton();
        this.onTime();
      },
      peek: (T, clip) => {
        this.interactive();
        this.player.peek(T, true, clip);
      },
      setTime: (T) => {
        this.player.setTime(T);
        this.onTime();
      },
      changed: (commit) => this.changed(commit),
      select: (s) => this.select(s),
      selection: () => this.sel,
      recording: () => (this.rec?.phase === 'rec' ? { t0: this.rec.startT, t1: Math.max(this.rec.startT, this.player.time) } : null),
      beats: () => this.timelineBeats(),
    }, this.lib);
    this.syncTrackHeight();
    this.lib.onThumbs = () => this.timeline.thumbsChanged();
    const vt = (id: string, label: string, icon: string): ToolDef => ({ id, label, icon, kind: 'video', params: () => this.params(id) });
    this.tools = [
      vt('vclip', 'Edit', ICONS.clip), vt('vtrans', 'Transition', ICONS.transition), vt('vcanvas', 'Canvas', ICONS.canvas),
      vt('vtext', 'Text', ICONS.text), vt('vmusic', 'Music', ICONS.music), vt('vvoice', 'Voice', ICONS.mic),
    ];
    this.bindUI();
  }

  get project(): VideoProject {
    const st = this.h.state();
    // (closed: the app's state is a photo's now, which must not grow a timeline)
    if (this.dead) return st.video ?? newProject();
    st.video ??= newProject();
    return st.video;
  }

  private bindUI() {
    $('tlPlay').innerHTML = ICONS.play;
    $('tlAdd').innerHTML = ICONS.plus;
    $('tlPlay').onclick = () => {
      tick();
      // (recording: the play button is the stop button)
      if (this.rec) return void this.stopVoice();
      this.togglePlay();
    };
    // one frame back / forward (hold to keep going)
    for (const [id, dir, icon] of [['tlPrev', -1, ICONS.stepBack], ['tlNext', 1, ICONS.stepFwd]] as const) {
      const b = $(id);
      b.innerHTML = icon;
      let rep = 0;
      const stop = () => clearTimeout(rep);
      b.onpointerdown = (e) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        let n = 0;
        const go = () => {
          if (this.dead) return;
          this.stepFrame(dir);
          rep = window.setTimeout(go, n++ ? 70 : 380);
        };
        go();
      };
      b.onpointerup = b.onpointercancel = b.onlostpointercapture = stop;
    }
    $('tlAdd').onclick = () => {
      tick();
      this.pickMedia();
    };
    // keep the dock's swipe-up (all tools) from firing on the timeline
    $('timeline').addEventListener('pointerdown', (e) => e.stopPropagation(), { signal: this.life.signal });
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
        if (this.dead) return;
        this.audio.warm(m);
        if (m.kind === 'audio') continue;
        if (m.kind === 'video') setTimeout(() => !this.dead && void this.player.buildKeys(m), 1200);
        const c: VClip = { id: uid(), src: m.id, kind: m.kind === 'image' ? 'image' : 'video', in: 0, out: m.kind === 'image' ? IMAGE_SECONDS : m.duration, speed: 1, vol: m.audio ? 1 : 0 };
        added.push(c);
      } catch (e) {
        console.error(e);
        this.h.toast((e as Error).message || `Couldn’t open ${f.name}`, 4000);
      }
    }
    if (this.dead) return;
    this.h.busy(null);
    if (!added.length) return;
    p.clips.splice(at, 0, ...added);
    // (a transition where they went in no longer has its clips)
    cleanTransitions(p);
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

  /** Can any of these files become a clip? (null: yes; else the reason for the first that can't) */
  static async probe(files: File[]): Promise<string | null> {
    let why: string | null = null;
    for (const f of files) {
      const r = await MediaLib.probe(f);
      if (!r) return null;
      why ??= r;
    }
    return why ?? 'Nothing to open';
  }

  /** Reopen a saved project's files (the edit itself is restored by the app). */
  async restoreMedia(files: { id: string; file: File }[]) {
    let missing = 0;
    for (let k = 0; k < files.length; k++) {
      this.h.busy(`Opening ${k + 1} of ${files.length}`);
      try {
        const m = await this.lib.add(files[k].file, files[k].id);
        if (this.dead) return;
        this.audio.warm(m);
        if (m.kind === 'video') setTimeout(() => !this.dead && void this.player.buildKeys(m), 1200);
      } catch (e) {
        console.error(e);
        missing++;
      }
    }
    if (this.dead) return;
    if (missing) this.h.toast(missing > 1 ? `${missing} files of this project couldn’t be opened` : 'One file of this project couldn’t be opened', 4000);
    this.h.busy(null);
  }

  /** Every file the project uses, with its id (for saving it as a recent project). */
  mediaFiles() {
    const p = this.project;
    const ids = new Set([...p.clips.map((c) => c.src), p.music?.src, p.bgImg, ...(p.voice ?? []).map((v) => v.src)].filter(Boolean) as string[]);
    return [...ids].map((id) => this.lib.get(id)).filter((m) => m?.file).map((m) => ({ id: m!.id, file: m!.file as File }));
  }

  /** After a saved project is put back: frame, timeline, sound. */
  afterRestore() {
    this.onRestore();
    this.timeline.fitAll();
    this.player.seek(0);
    this.updateTitle();
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
    const big = this.exportStill;
    if (this.exporting && big?.id === m.id) return { tex: big.tex, w: big.w, h: big.h };
    let t = this.imgTex.get(m.id);
    if (t) this.imgTex.delete(m.id); // (put back below: most recently used last)
    else {
      t = this.comp.imageTexture(m.bitmap);
      // a few stills' textures at a time: a long slideshow doesn't fill the GPU's memory
      while (this.imgTex.size >= 4) {
        const [old, tex] = this.imgTex.entries().next().value as [string, WebGLTexture];
        this.h.g.gl.deleteTexture(tex);
        this.imgTex.delete(old);
      }
    }
    this.imgTex.set(m.id, t);
    return { tex: t, w: m.bitmap.width, h: m.bitmap.height };
  }
  /** a still read at full size for the export (one at a time) */
  private exportStill: { id: string; tex: WebGLTexture; w: number; h: number } | null = null;
  private dropExportStill() {
    if (this.exportStill) this.h.g.gl.deleteTexture(this.exportStill.tex);
    this.exportStill = null;
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
  /** The cine frame rate clip's picture is held to (its look's, or the whole video's), 0: none. */
  private cineOf(clip: VClip) {
    const st = this.h.state();
    const v = (st.v.cineRate ?? 0) === 0 && !clip.look && !st.video?.scope ? st.v : effectiveLook(st, clip, clip.in, false).v;
    return cineFps(v.cineRate);
  }

  /** Source time of the picture of `clip` at timeline time T (held to its cine rate). */
  private picTime(clip: VClip, T: number) {
    return Math.min(clip.out, Math.max(clip.in, srcAt(clip, heldLocal(T - this.startOf(clip), this.cineOf(clip)))));
  }

  /** The cine rate changed: the frame showing (and a playback under way) follow it. */
  cineChanged() {
    if (this.player.playing) {
      this.player.pause();
      void this.playNow();
    } else this.player.seek(this.player.time);
  }

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
      this.placeLast(this.frameT);
    }
    this.h.frameChanged({ tex: this.frameT!.tex, w, h, linear: false }, this.frameT!, resized);
  }

  /** A frame ready to place (slot 1: the other clip of a transition, uploaded beside the first). */
  private srcFor(m: Media, sample: VideoSample | null, outLong: number, quality = true, bitmap?: ImageBitmap, pre?: GpuFrame, upright = false, slot: 0 | 1 = 0): FrameSource {
    if (m.kind === 'image' && m.bitmap) {
      const g = this.imageGpu(m)!;
      return { tex: g.tex, w: g.w, h: g.h, rot: 0, flip: false };
    }
    const rot = upright ? 0 : ROT[(m.video?.rotation ?? 0) as 0 | 90 | 180 | 270] ?? 0;
    if (pre) return { tex: pre.tex, w: pre.w, h: pre.h, rot, flip: false, mip: false };
    if (bitmap) this.comp.upload(bitmap, bitmap.width, bitmap.height, outLong, false, slot);
    else if (sample) {
      const vf = sample.toVideoFrame();
      this.comp.upload(vf, vf.displayWidth, vf.displayHeight, outLong, quality, slot);
      vf.close();
    }
    const r = this.comp.rawOf(slot);
    return { tex: r.tex, w: r.w, h: r.h, rot, flip: false };
  }

  /** The transition the last frame was for, with its two clips' frames in order (null: none). */
  private lastMix() {
    const L = this.last, p = this.project;
    if (!L?.other || L.T === undefined) return null;
    const mix = mixAt(p, L.T);
    if (!mix) return null;
    const A = p.clips[mix.a], B = p.clips[mix.b];
    const fa = A.id === L.clip ? L : L.other.clip === A.id ? L.other : null;
    const fb = B.id === L.clip ? L : L.other.clip === B.id ? L.other : null;
    return fa && fb ? { mix, A, B, fa, fb } : null;
  }

  /** Place the last frame (both clips' across a transition) into `dst`. */
  private placeLast(dst: Target) {
    this.placeVer++;
    const m = this.lastMix();
    if (m) {
      this.comp.placeMix(m.fa.src, m.fb.src, dst, this.placement(m.A, m.fa.s, dst.w, dst.h), this.placement(m.B, m.fb.s, dst.w, dst.h), m.mix.kind, m.mix.f);
      return;
    }
    this.comp.place(this.last?.src ?? null, dst, this.placement(this.lastClip(), this.last?.s ?? 0, dst.w, dst.h));
  }

  /** frames put on screen (for the performance readout) */
  framesShown = 0;

  private showFrame(f: Frame) {
    if (this.exporting || this.dead) {
      f.sample?.close();
      return;
    }
    this.framesShown++;
    if (!this.frameT) this.ensureFrame();
    // (frames shown while a finger moves skip the extra smoothing a big source gets; the exact
    // frame that follows has it)
    const quality = !this.player.playing && !f.fast;
    const src = this.srcFor(f.media, f.sample, this.previewLong(), quality, f.bitmap, f.pre, f.upright);
    const s = f.sample?.timestamp ?? f.ts ?? (f.t !== undefined ? this.picTime(f.clip, f.t) : f.clip.in);
    f.sample?.close();
    this.last = { src, media: f.media.id, clip: f.clip.id, s, T: f.t, solo: f.solo };
    const o = f.other;
    if (o) {
      const so = o.sample?.timestamp ?? o.ts ?? (f.t !== undefined ? this.picTime(o.clip, f.t) : o.clip.in);
      this.last.other = { src: this.srcFor(o.media, o.sample, this.previewLong(), quality, o.bitmap, o.pre, o.upright, 1), clip: o.clip.id, s: so };
      o.sample?.close();
    }
    this.placeLast(this.frameT!);
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
    if (this.frameT) this.placeLast(this.frameT);
    this.h.pipe.invalidate();
    this.h.requestRender();
  }

  // ---- over the finished picture: clip fades, dips to black / white, a film burn

  /** What goes over the picture at timeline time T (null: nothing). */
  overlayAt(T: number): Overlay | null {
    const p = this.project;
    if (!p.clips.length) return null;
    const L = layout(p);
    const mix = mixAt(p, T, L);
    const fadeOf = (i: number) => fadeAt(p.clips[i], T - L.starts[i]);
    let vis = 1, black = 0, white = 0, burn: number | null = null, seed = 0;
    if (mix) {
      // (each clip's own fade, in proportion to how much of it shows)
      const w = mixWeight(mix.kind, mix.f);
      vis = fadeOf(mix.a) * (1 - w) + fadeOf(mix.b) * w;
      // a dip is all colour through the middle, where the picture switches clips
      const x = Math.min(1, (1 - Math.abs(2 * mix.f - 1)) / 0.85);
      const dip = x * x * (3 - 2 * x);
      if (mix.kind === 'black') black = dip;
      else if (mix.kind === 'white') white = dip;
      else if (mix.kind === 'burn') {
        burn = mix.f;
        seed = (mix.b * 7.31) % 10;
      }
    } else {
      const at = clipAt(p, T, L);
      if (at) vis = fadeOf(at.i);
    }
    black = 1 - (1 - black) * vis;
    if (black < 1e-3 && white < 1e-3 && burn === null) return null;
    return { black, white, burn, seed };
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
    const T = this.player.time;
    // (paused, it's for the moment of the frame showing, which is not the playhead's while an
    // edge is being trimmed: then just the clip, as it is)
    const L = this.last;
    const ov = this.player.playing ? this.overlayAt(T) : L?.solo ? null : this.overlayAt(L?.T ?? T);
    if (ov) this.comp.overlay(w, h, ov);
    this.textLayer(T, w, h);
    this.comp.drawText(w, h);
    this.personTick();
  }

  // ---- Person: the look's person / background settings (pplExp, pplSat, pplBgExp, pplBgSat)
  // need a mask of the people in the frame (see ai/people.ts). Paused, the frame showing gets
  // one (a newer frame meanwhile: the result is dropped and asked for again); playing, one is
  // asked for a few times a second, never two at once, and the picture uses the latest.

  private people: PeopleTracker | null = null;
  private ppl = { state: 'off' as 'off' | 'loading' | 'ready' | 'failed', on: false, busy: false, at: 0, cost: 0, shown: -1 };
  /** counts frames placed in the project frame (what a mask is for) */
  private placeVer = 0;

  /** Do these settings use the person mask? */
  private personOn(v: EditState['v']) {
    return !!(v.pplExp || v.pplSat || v.pplBgExp || v.pplBgSat);
  }

  /** After each preview render: keep a mask for the frame on screen while the effect is on. */
  private personTick() {
    const P = this.ppl;
    if (!this.personOn(this.lookState(this.h.state()).v)) {
      if (P.on) {
        P.on = false;
        P.shown = -1;
        this.h.pipe.setPerson(null);
        this.people?.reset();
      }
      // (switched on again after a failed load: it tries again)
      if (P.state === 'failed') P.state = 'off';
      return;
    }
    P.on = true;
    if (P.state === 'off') return void this.loadPeople();
    if (P.state !== 'ready' || P.busy || !this.frameT || !this.last || P.shown === this.placeVer) return;
    // playing: a few times a second, and less often where a mask takes long (it holds up the page)
    if (this.player.playing && performance.now() - P.at < Math.max(200, P.cost * 3)) return;
    P.busy = true;
    P.at = performance.now();
    // (after this frame is on the screen)
    setTimeout(() => void this.requestMask(), 0);
  }

  /** Load the people model (downloaded once): the effect starts once it's there. */
  private pplLoad: Promise<boolean> | null = null;
  private loadPeople() {
    return (this.pplLoad ??= this.loadPeopleNow().finally(() => (this.pplLoad = null)));
  }
  private async loadPeopleNow() {
    const P = this.ppl;
    P.state = 'loading';
    this.people ??= new PeopleTracker();
    const job = this.h.cancellable();
    this.h.busy('Loading the people model');
    try {
      await this.people.ready((f) => this.h.busy(`Downloading the people model ${Math.round(f * 100)}%`), job.signal);
      if (this.dead) return false;
      P.state = 'ready';
      this.h.requestRender();
    } catch (e) {
      P.state = 'failed';
      if ((e as Error).name === 'AbortError') this.h.toast('Person needs the people model · move a Person slider to try again', 3200);
      else {
        console.error(e);
        this.h.toast('Person couldn’t load the people model: ' + ((e as Error).message || e), 4500);
      }
    } finally {
      job.done();
      this.h.busy(null);
    }
    return P.state === 'ready';
  }

  /** A small copy (long side PEOPLE_SIZE) of a frame, top row first, for the people model. */
  private smallFrame(t: Target) {
    const k = PEOPLE_SIZE / Math.max(t.w, t.h);
    const w = Math.max(8, Math.round(t.w * k)), h = Math.max(8, Math.round(t.h * k));
    const r = this.h.pipe.geometryRegion({ tex: t.tex, w: t.w, h: t.h, linear: false }, defaultState(), w, h, { x: 0, y: 0, w, h });
    return { px: r.px, w: r.w, h: r.h };
  }

  /** Which shot a frame is of, for the tracker (it eases masks within one shot): a transition's two clips count as one. */
  private shotKey() {
    const L = this.last!;
    return L.other ? `${L.clip}|${L.other.clip}` : L.clip;
  }

  private async requestMask() {
    const P = this.ppl, ver = this.placeVer;
    try {
      if (this.dead || this.exporting || !P.on || !this.frameT || !this.last || !this.people) return;
      const fr = this.smallFrame(this.frameT);
      const t0 = performance.now();
      const m = await this.people.mask(fr.px, fr.w, fr.h, this.last.T ?? this.player.time, this.shotKey());
      P.cost = performance.now() - t0;
      if (this.dead || this.exporting || !P.on) return;
      // paused on another frame meanwhile: this one's out of date (the next render asks again)
      if (!this.player.playing && ver !== this.placeVer) return;
      this.h.pipe.setPerson(m);
      P.shown = ver;
      this.h.pipe.invalidate();
      if (!this.player.playing) this.h.requestRender();
    } catch (e) {
      console.warn('person mask', e);
    } finally {
      P.busy = false;
      if (!this.player.playing && P.on && P.shown !== this.placeVer) this.h.requestRender();
    }
  }

  /** Does any look in the project use the person settings (the whole video's, or a clip's own)? */
  private personAnywhere() {
    const st = this.h.state(), p = this.project;
    const looks = [p.scope && p.base ? p.base.v : st.v, ...(p.scope ? [st.v] : [])];
    for (const c of p.clips) if (c.look) looks.push(c.look.v, ...(c.look.kf ?? []).map((k) => k.v));
    return looks.some((v) => this.personOn(v));
  }

  // -----------------------------------------------------------------------------------
  // playback

  /** Move the playhead one frame of the clip under it (as it plays: its own frame rate and speed). */
  stepFrame(dir: number) {
    const p = this.project;
    if (!p.clips.length) return;
    if (this.player.playing) this.togglePlay();
    const T = this.player.time, total = layout(p).total;
    const c = this.playClip();
    const m = c && this.lib.get(c.src);
    const fps = m?.kind === 'video' ? m.fps || 30 : this.ex.fps || 30;
    // one source frame, as long as it lasts on the timeline at the speed there
    // (held to a cine rate: one held picture)
    const cf = c ? this.cineOf(c) : 0;
    const dt = cf ? 1 / cf : c && m?.kind === 'video' ? 1 / fps / Math.max(0.05, speedAt(c, this.sNow(c))) : 1 / fps;
    const to = Math.max(0, Math.min(total - 1e-3, T + dir * dt));
    if (to === T) return;
    tick();
    this.player.seek(to);
    this.syncPlayButton();
    this.onTime();
  }

  togglePlay() {
    // (pausing while recording a voiceover ends the recording)
    if (this.rec) return void this.stopVoice();
    this.previewUntil = 0;
    if (this.player.playing) {
      this.player.pause();
      this.player.seek(this.player.time);
    } else {
      if (!this.project.clips.length) return this.pickMedia();
      void this.playNow();
    }
    this.syncPlayButton();
  }

  /** Start playing from the playhead. */
  private playNow() {
    // (a flick still coasting would seek, and stop it again)
    this.timeline.stopCoast();
    // while it plays every clip is drawn with its own look; a slider moved meanwhile
    // changes the whole video's look, not the clip that happened to be under the playhead
    if (this.project.scope) {
      this.unscope();
      this.h.lookChanged();
    }
    this.dynCheck = { t: performance.now(), drops: 0, shown: 0, calm: 0 };
    const pl = this.player.play().then(() => {
      this.syncPlayButton();
      this.updateCap();
    });
    this.syncPlayButton();
    return pl;
  }

  private syncPlayButton() {
    this.h.setLive(this.player.playing || this.exporting);
    const rec = !!this.rec;
    $('tlPlay').innerHTML = rec ? ICONS.stop : this.player.playing ? ICONS.pause : ICONS.play;
    $('tlPlay').classList.toggle('on', this.player.playing && !rec);
    $('tlPlay').classList.toggle('rec', rec);
  }

  private lastTextKey = '';
  private lastLabel = '';
  private onTime() {
    if (this.dead) return;
    const T = this.player.time;
    const total = layout(this.project).total;
    // the label changes ten times a second at most: only touch the DOM then
    const label = `<b>${fmtTime(T)}</b> / ${fmtTime(total)}`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      $('tlTime').innerHTML = label;
    }
    if (this.rampEd.shown) this.rampEd.draw();
    // a transition's preview stops just after it
    if (this.previewUntil && this.player.playing && T >= this.previewUntil) {
      this.previewUntil = 0;
      this.player.pause();
      this.player.seek(this.player.time);
      this.syncPlayButton();
    }
    if (this.rec) this.syncRecBadge();
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
    // (a jump: the person is found afresh)
    this.people?.reset();
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
    else if (s?.kind === 'voice') this.h.openTool('vvoice');
    else if (s?.kind === 'cut') {
      // the playhead on the cut, to see what happens there
      const i = this.selCut();
      if (i > 0) this.seek(cutTime(layout(this.project), i));
      this.h.openTool('vtrans');
    }
    else if (tool === 'vclip') this.h.refreshSection();
    else this.h.refreshSection();
  }

  private selClip() {
    return this.sel?.kind === 'clip' ? this.project.clips.find((c) => c.id === this.sel!.id) ?? null : null;
  }
  private selText() {
    return this.sel?.kind === 'text' ? this.project.texts.find((t) => t.id === this.sel!.id) ?? null : null;
  }
  private selVoice() {
    return this.sel?.kind === 'voice' ? this.project.voice?.find((v) => v.id === this.sel!.id) ?? null : null;
  }
  /** The selected cut, as the index of the clip after it (-1: none). */
  private selCut() {
    if (this.sel?.kind !== 'cut') return -1;
    const p = this.project, i = p.clips.findIndex((c) => c.id === this.sel!.id) + 1;
    return i > 0 && i < p.clips.length ? i : -1;
  }

  /** Rebuild the soundtrack in the background a moment after the last edit. */
  private remixTimer = 0;
  private remix() {
    if (this.dead) return;
    clearTimeout(this.remixTimer);
    this.remixTimer = window.setTimeout(() => {
      if (this.dead) return;
      const p = this.project;
      this.audio.keepOnly(new Set([...p.clips.map((c) => c.src), ...(p.music ? [p.music.src] : []), ...(p.voice ?? []).map((v) => v.src)]));
      void this.audio.mix(p);
      // (the music's beats, if the song or the part of it used changed)
      this.songBeats();
    }, 250);
  }

  private changed(commit: boolean) {
    // (an edit while recording ends the recording first)
    if (this.rec) void this.stopVoice();
    // a transition goes with its cut: where other clips meet now, it's gone
    cleanTransitions(this.project);
    // titles and voiceover clips stay on the shots they were put on
    followAnchors(this.project, this.timeline.draggingText());
    this.syncTrackHeight();
    if (this.player.playing) {
      // the timeline changed under a running playback (its frames and sound were planned
      // for the old one): stop where it is
      const T = this.player.time;
      this.player.pause();
      this.syncPlayButton();
      this.player.seek(Math.min(T, layout(this.project).total));
    }
    this.remix();
    this.rescope();
    // another clip came first: with the Original canvas, the frame takes its shape
    const d = this.dims(this.previewLong());
    if (this.frameT && (this.frameT.w !== d.w || this.frameT.h !== d.h)) {
      this.ensureFrame();
      this.replace();
    }
    // clips are shorter / longer: text past the end comes back in (once the change is
    // final: mid-drag the length passes through values it won't keep)
    const total = layout(this.project).total;
    if (commit && total > 0) {
      for (const t of this.project.texts) {
        if (t.t1 > total) t.t1 = Math.max(t.t0 + 0.3, total);
        if (t.t0 >= total) {
          t.t0 = Math.max(0, total - 1);
          t.t1 = total;
        }
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
    if (this.sel?.kind === 'voice' && !this.selVoice()) this.sel = null;
    if (this.sel?.kind === 'cut' && this.selCut() < 0) this.sel = null;
    this.syncTrackHeight();
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
    if (mixAt(p, T)) return this.h.toast('Move the playhead out of the transition to split there');
    if (local < MIN_CLIP || clipLen(c) - local < MIN_CLIP) return this.h.toast('Move the playhead into the clip to split it');
    const b = this.cutAt(at.i, local);
    this.sel = { kind: 'clip', id: b.id };
    tick(true);
    this.changed(true);
  }

  /** Cut clip i in two, `local` timeline seconds into it; the new right half comes back. */
  private cutAt(i: number, local: number) {
    const p = this.project, c = p.clips[i];
    const cut = srcAt(c, local);
    // (its own copy of everything: the two would otherwise share their keyframes)
    const b: VClip = { ...(JSON.parse(JSON.stringify(c)) as VClip), id: uid(), in: cut };
    if (c.ramp) {
      // each half keeps its part of the ramp
      const u = (cut - c.in) / (c.out - c.in);
      b.ramp = subRamp(c.ramp, u, 1);
      c.ramp = subRamp(c.ramp, 0, u);
    }
    // the transition out and the fade out go with the right half, the fade in stays on the left
    delete c.tr;
    delete c.fout;
    delete b.fin;
    c.out = cut;
    p.clips.splice(i + 1, 0, b);
    return b;
  }

  /**
   * Reverse: the clip plays backwards (a reversed copy of its part of the footage is made once);
   * again: forwards from the original. The playhead stays on the same moment.
   */
  private async reverseClip(c: VClip) {
    const m = this.lib.get(c.src);
    if (!m?.video) return;
    this.unscope();
    const p = this.project;
    const here = this.onClip(c) ? this.sNow(c) : null;
    const back = (s: number) => this.player.seek(this.startOf(c) + localAt(c, s));
    if (c.reversed) {
      // back to the original footage
      // (moment s of the copy is moment r.out - s of the original; a trim made meanwhile is kept)
      const r = c.reversed;
      delete c.reversed;
      flipClip(c, r.src, r.out);
      tick(true);
      this.changed(true);
      if (here !== null) back(r.out - here);
      return;
    }
    if (c.out - c.in > REVERSE_MAX) return this.h.toast(`Clips up to ${REVERSE_MAX / 60} minutes can be reversed · split it first`, 3200);
    this.cancelExport = false;
    this.h.busy('Reversing 0%');
    $('busyCancel').hidden = false;
    try {
      const { reverseFootage } = await import('./reverse');
      const file = await reverseFootage(m, this.lib, c.in, c.out, (f) => this.h.busy(`Reversing ${Math.round(f * 100)}%`), () => this.cancelExport || this.dead);
      const rm = await this.lib.add(file);
      if (this.dead || !p.clips.includes(c)) return;
      if (rm.kind === 'video') setTimeout(() => !this.dead && void this.player.buildKeys(rm), 1200);
      this.audio.warm(rm);
      const old = { src: c.src, in: c.in, out: c.out };
      // (the copy starts at the clip's end: moment s of the original is old.out - s of the copy)
      flipClip(c, rm.id, old.out);
      c.out = Math.min(c.out, rm.duration);
      c.reversed = old;
      tick(true);
      this.changed(true);
      if (here !== null) back(old.out - here);
      this.h.toast('Plays backwards · tap Reverse again to undo it', 2400);
    } catch (e) {
      if ((e as Error).name === 'AbortError') this.h.toast('Reverse cancelled');
      else {
        console.error(e);
        this.h.toast('Couldn’t reverse it: ' + ((e as Error).message || e), 4000);
      }
    } finally {
      $('busyCancel').hidden = true;
      this.h.busy(null);
    }
  }

  /**
   * Freeze frame: the picture at the playhead held still for a moment (a photo clip made from
   * it, with the clip's framing and look), cutting the clip there if the playhead is inside it.
   */
  private async freezeFrame(c: VClip) {
    if (!this.onClip(c)) return this.h.toast('Move the playhead onto the clip first');
    const m = this.lib.get(c.src);
    if (!m?.video) return;
    this.unscope();
    const s = this.sNow(c);
    this.h.busy('Freezing the frame');
    try {
      const { CanvasSink } = await import('mediabunny');
      // the frame as it's seen (turned upright), at the footage's own size
      const long = Math.min(3840, Math.max(m.w, m.h));
      const k = long / Math.max(m.w, m.h);
      const sink = new CanvasSink(m.video, { width: Math.round(m.w * k), height: Math.round(m.h * k), fit: 'fill' });
      const w = await sink.getCanvas(Math.max(c.in, Math.min(c.out - 1e-3, s)));
      if (!w || this.dead) throw new Error('No frame there');
      const cv = w.canvas as HTMLCanvasElement | OffscreenCanvas;
      const blob = 'convertToBlob' in cv ? await cv.convertToBlob({ type: 'image/jpeg', quality: 0.95 }) : await new Promise<Blob | null>((r) => (cv as HTMLCanvasElement).toBlob(r, 'image/jpeg', 0.95));
      if (!blob) throw new Error('No frame there');
      const base = m.name.replace(/\.[^.]+$/, '');
      const file = new File([blob], `${base} frame ${fmtTime(s).replace(':', '.')}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      const fm = await this.lib.add(file);
      if (this.dead) return;
      const p = this.project, i = p.clips.indexOf(c);
      if (i < 0) return;
      const local = this.player.time - this.startOf(c);
      // inside the clip: cut it and hold the frame between the halves; at an end: before / after it
      let at = i + 1;
      if (local >= MIN_CLIP && clipLen(c) - local >= MIN_CLIP) this.cutAt(i, local);
      else if (local < MIN_CLIP) at = i;
      const still: VClip = {
        id: uid(), src: fm.id, kind: 'image', in: 0, out: 2, speed: 1, vol: 0, frozen: true,
        tf: { ...framingAt(c, s) },
        ...(c.look ? { look: JSON.parse(JSON.stringify(c.look)) } : {}),
      };
      // (an animated look holds where it was at that moment)
      if (still.look?.kf?.length) {
        still.look.v = lookValues(still.look, s);
        delete still.look.kf;
      }
      p.clips.splice(at, 0, still);
      this.sel = { kind: 'clip', id: still.id };
      tick(true);
      this.changed(true);
      this.player.seek(this.startOf(still) + 0.001);
      this.h.toast('Frame held for 2 s · drag its right edge to change how long', 2600);
    } catch (e) {
      console.error(e);
      this.h.toast('Couldn’t freeze that frame: ' + ((e as Error).message || e), 3500);
    } finally {
      this.h.busy(null);
    }
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
      if (!p.clips.length) this.replace(); // nothing left: the picture goes too
      this.player.seek(Math.min(this.player.time, layout(p).total));
    } else if (what === 'copy') {
      const d: VClip = { ...(JSON.parse(JSON.stringify(c)) as VClip), id: uid() };
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
        const t: VText = { id: uid(), text: v, t0, t1: Math.min(total, t0 + 3), x: 0.5, y: 0.5, size: 8, color: '#ffffff', font: 'pixel', box: false, anchor: anchorAt(p, t0) };
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

  private scopeClip: string | undefined;

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
    // (also when the playhead moves onto another clip: the look switch shows that clip's choice)
    const moved = c?.id !== this.scopeClip;
    this.scopeClip = c?.id;
    if (before !== p.scope || reloaded || moved) this.h.lookChanged();
  }

  /**
   * The edit as a frame of `clip` at source time s is drawn (its clip's look, animated). Across
   * a transition (`mix`: the other clip, and how much of it shows), eased from one clip's look to
   * the other's. Without a clip: the frame on screen.
   */
  lookState(st: EditState, clip?: VClip | null, s?: number, live = !this.player.playing, mix?: { clip: VClip; s: number; w: number }): EditState {
    if (!st.video) return st;
    if (clip === undefined) {
      const m = this.lastMix();
      if (m) {
        clip = m.A;
        s = m.fa.s;
        mix = { clip: m.B, s: m.fb.s, w: mixWeight(m.mix.kind, m.mix.f) };
      } else {
        clip = this.lastClip();
        s = this.last?.s ?? 0;
      }
    }
    const L = effectiveLook(st, clip, s ?? 0, live);
    let v = L.v, curves = L.curves;
    if (mix && mix.w > 0) {
      const M = effectiveLook(st, mix.clip, mix.s, live);
      if (M.v !== v || M.curves !== curves) {
        // (eased like look keyframes; settings that switch, switch half way)
        v = lookValues({ v, curves, kf: [{ s: 0, v }, { s: 1, v: M.v }] }, mix.w);
        if (mix.w >= 0.5) curves = M.curves;
      }
    }
    return v === st.v && curves === st.curves ? st : { ...st, v, curves };
  }

  /** The look switch at the front of an adjustment section: whole video / this clip, keyframe. */
  scopeChips(row: HTMLElement, sep: boolean) {
    const c = this.playClip();
    if (!c) return;
    const own = !!c.look;
    // (the clip is looked up again at the tap: the playhead may have moved on since the row was built)
    this.h.chip(row, { id: 'all', label: 'All clips' }, !own, () => {
      const c = this.playClip();
      if (!c?.look) return;
      this.unscope();
      delete c.look;
      this.h.toast('This clip follows the whole video’s look again', 2200);
      this.lookEdited();
    });
    this.h.chip(row, { id: 'clip', label: 'This clip' }, own, () => {
      const c = this.playClip();
      if (!c || c.look) return;
      this.giveLook(c);
      this.h.toast('Changes now apply to this clip only', 2200);
      this.lookEdited();
    });
    const k = lookKeyAt(c.look, this.sNow(c)) >= 0;
    const b = this.h.chip(row, { id: 'key', label: '◆ Key' }, k, () => {
      const c = this.playClip();
      if (c) this.toggleLookKey(c);
    });
    b.classList.add('keychip');
    if (sep) row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
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
    if (id !== 'vclip') this.rampOpen = this.fadeOpen = false;
    if (id !== 'vmusic') this.beatOpen = false;
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
      if (this.fadeOpen) return this.fadeEnd === 'out' ? ['vd.fout', 'vd.fin'] : ['vd.fin', 'vd.fout'];
      const fr = ['vd.zoom', 'vd.px', 'vd.py', 'vd.rot'];
      return c.kind === 'image' ? fr : [...(this.lib.get(c.src)?.audio ? ['vd.speed', 'vd.vol'] : ['vd.speed']), ...fr];
    }
    if (id === 'vcanvas') return this.project.bg === 'blur' || this.project.bg === 'image' ? ['vd.bgblur'] : [];
    if (id === 'vtext') return this.selText() ? ['vd.tsize'] : [];
    if (id === 'vmusic') return this.project.music ? ['vd.mvol', 'vd.min'] : [];
    if (id === 'vtrans') {
      const i = this.selCut();
      return i > 0 && transInto(this.project, i) ? ['vd.trd'] : [];
    }
    if (id === 'vvoice') return this.selVoice() ? ['vd.vvol'] : [];
    return [];
  }

  def(id: string): ParamDef {
    if (id === 'vd.min') {
      const m = this.project.music && this.lib.get(this.project.music.src);
      return { ...DEFS[id], max: Math.max(1, (m?.duration ?? 60) - 1) };
    }
    if (id === 'vd.fin' || id === 'vd.fout') {
      // at most half the clip
      const c = this.selClip();
      return { ...DEFS[id], max: c ? Math.max(0.1, Math.min(FADE_MAX, Math.floor(clipLen(c) * 5) / 10)) : FADE_MAX };
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
      case 'vd.fin': return c?.fin ?? 0;
      case 'vd.fout': return c?.fout ?? 0;
      case 'vd.vvol': return (this.selVoice()?.vol ?? 1) * 100;
      case 'vd.trd': {
        const i = this.selCut();
        return (i > 0 && transInto(this.project, i)?.d) || TRANS_LEN.def;
      }
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
    else if ((id === 'vd.fin' || id === 'vd.fout') && c) {
      const x = Math.round(v * 10) / 10;
      if (id === 'vd.fin') c.fin = x || undefined;
      else c.fout = x || undefined;
      if (!c.fin) delete c.fin;
      if (!c.fout) delete c.fout;
      this.h.requestRender();
    } else if (id === 'vd.vvol') {
      const vc = this.selVoice();
      if (vc) vc.vol = v / 100;
    } else if (id === 'vd.trd') {
      const i = this.selCut(), tr = i > 0 ? transInto(this.project, i) : null;
      if (tr) {
        tr.d = Math.round(v * 10) / 10;
        this.changed(false);
        // the playhead on the middle of it, to see it
        this.player.seek(cutTime(layout(this.project), i));
      }
    } else if (id === 'vd.tsize' && t) {
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
    if (t.id === 'vtrans') {
      const i = this.selCut();
      if (i < 0) return;
      const tr = transInto(p, i);
      this.h.chip(row, { id: 'none', label: 'None' }, !tr, () => this.setTrans(i, null));
      for (const [k, label] of TRANSITIONS) this.h.chip(row, { id: k, label }, tr?.kind === k, () => this.setTrans(i, k));
      return;
    }
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
    if (t.id === 'vclip' && this.fadeOpen && this.selClip()) {
      // fades: quick choices, the sliders set the lengths
      const c = this.selClip()!;
      this.h.tile(row, ICONS.check, 'Done', '', () => {
        this.fadeOpen = false;
        this.h.refreshSection();
      });
      sep();
      const set = (fin: number, fout: number) => {
        // (the slider goes to the end just chosen)
        if (!fin !== !fout) this.fadeEnd = fout ? 'out' : 'in';
        const half = clipLen(c) / 2;
        if (fin) c.fin = Math.min(fin, half);
        else delete c.fin;
        if (fout) c.fout = Math.min(fout, half);
        else delete c.fout;
        tick();
        this.changed(true);
      };
      const d = (x: number | undefined) => x || 0.5;
      this.h.chip(row, { id: 'none', label: 'None' }, !c.fin && !c.fout, () => set(0, 0));
      this.h.chip(row, { id: 'in', label: 'In' }, !!c.fin && !c.fout, () => set(d(c.fin), 0));
      this.h.chip(row, { id: 'out', label: 'Out' }, !c.fin && !!c.fout, () => set(0, d(c.fout)));
      this.h.chip(row, { id: 'both', label: 'Both' }, !!c.fin && !!c.fout, () => set(d(c.fin), d(c.fout)));
      return;
    }
    if (t.id === 'vtrans') return this.transActs(row, sep);
    if (t.id === 'vvoice') return this.voiceActs(row, sep);
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
      if (c.kind === 'video') this.h.tile(row, ICONS.freeze, 'Freeze', '', () => void this.freezeFrame(c));
      if (c.kind === 'video') this.h.tile(row, ICONS.reverse, 'Reverse', c.reversed ? 'hot' : '', () => void this.reverseClip(c));
      if (c.kind === 'video') this.h.tile(row, ICONS.ramp, 'Ramp', c.ramp ? 'hot' : '', () => {
        this.rampOpen = true;
        this.fadeOpen = false;
        this.h.refreshSection();
      });
      this.h.tile(row, ICONS.fade, 'Fade', c.fin || c.fout ? 'hot' : '', () => {
        this.fadeOpen = true;
        this.fadeEnd = c.fout && !c.fin ? 'out' : 'in';
        this.rampOpen = false;
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
      this.h.tile(row, ICONS.captions, 'Captions', p.texts.some((x) => x.auto) ? 'hot' : '', () => void this.autoCaptions());
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
    } else if (t.id === 'vmusic' && this.beatOpen && p.music) {
      // cut to the beat: every 1, 2 or 4 beats
      this.h.tile(row, ICONS.check, 'Done', '', () => {
        this.beatOpen = false;
        this.h.refreshSection();
      });
      sep();
      for (const n of [1, 2, 4] as const) {
        this.h.chip(row, { id: 'b' + n, label: n === 1 ? 'Every beat' : `Every ${n}` }, this.beatEvery === n, () => void this.cutToBeat(n));
      }
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
      if (p.clips.length > 1) this.h.tile(row, ICONS.beat, 'Cut to beat', '', () => {
        this.beatOpen = true;
        this.beatEvery = 0;
        this.beatBase = null;
        this.songBeats();
        this.h.refreshSection();
      });
      this.h.tile(row, ICONS.trash, 'Remove', 'danger', () => {
        p.music = null;
        this.sel = null;
        tick(true);
        this.changed(true);
      });
    }
  }

  // ---- the music's beats (see beats.ts): found for the part of the song the video uses (and a
  // good margin either side, so moving its start a little doesn't mean finding them again), off
  // the main thread, and kept per song

  private beatCache = new Map<string, { lo: number; hi: number; t: number[]; s: number[]; bpm: number }>();
  private beatJob: { id: string; lo: number; hi: number; p: Promise<void> } | null = null;
  /** Cut to beat's choices are showing (Music), the one picked, and the clips before it was first picked */
  private beatOpen = false;
  private beatEvery: 0 | 1 | 2 | 4 = 0;
  private beatBase: { clips: string; after: string } | null = null;

  /** The song's beats (song times) for the music as placed now; starts finding them when they're not known yet. */
  private songBeats() {
    const p = this.project, mu = p.music, m = mu && this.lib.get(mu.src);
    if (!mu || !m?.audio) return null;
    const total = layout(p).total;
    const a = Math.max(0, mu.in - 0.5), b = Math.min(m.duration, mu.in + total + 0.5);
    const c = this.beatCache.get(m.id);
    if (c && c.lo <= a + 1e-3 && c.hi >= b - 1e-3) return c;
    if (!this.beatJob || this.beatJob.id !== m.id || this.beatJob.lo > a || this.beatJob.hi < b) {
      const lo = Math.max(0, a - 20), hi = Math.min(m.duration, b + 60, lo + 15 * 60);
      const job = { id: m.id, lo, hi, p: this.findBeats(m, lo, hi) };
      this.beatJob = job;
      void job.p.finally(() => {
        if (this.beatJob === job) this.beatJob = null;
      });
    }
    // (meanwhile the song's beats found earlier, for another part of it, are still its beats)
    return c ?? null;
  }

  private async findBeats(m: Media, lo: number, hi: number) {
    try {
      const snd = await this.audio.monoRange(m, lo, hi);
      if (!snd || this.dead) return;
      const wk = new Worker(new URL('./beatsWorker.ts', import.meta.url), { type: 'module' });
      const r = await new Promise<{ bpm: number; times: number[]; strength: number[] }>((res, rej) => {
        wk.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data.beats));
        wk.onerror = (e) => rej(new Error(e.message || 'beat finder failed'));
        wk.postMessage({ x: snd.x, sr: snd.sr }, [snd.x.buffer]);
      }).finally(() => wk.terminate());
      if (this.dead) return;
      this.beatCache.set(m.id, { lo, hi, t: r.times.map((t) => lo + t), s: r.strength, bpm: r.bpm });
      this.tlBeats = null;
      this.timeline.draw();
    } catch (e) {
      console.warn('beats', e);
    }
  }

  /** The beats on the timeline (where the music plays), worked out once per change. */
  private tlBeats: { key: string; v: { t: number[]; s: number[] } } | null = null;
  private timelineBeats() {
    const p = this.project, mu = p.music;
    const c = mu && this.beatCache.get(mu.src);
    if (!mu || !c) return null;
    const total = layout(p).total;
    const key = `${mu.src}:${mu.in}:${total}:${c.t.length}:${c.lo}`;
    if (this.tlBeats?.key !== key) {
      const t: number[] = [], st: number[] = [];
      c.t.forEach((x, k) => {
        const T = x - mu.in;
        if (T >= -1e-6 && T <= total + 1e-6) {
          t.push(T);
          st.push(c.s[k]);
        }
      });
      this.tlBeats = { key, v: { t, s: st } };
    }
    return this.tlBeats.v;
  }

  /**
   * Cut to the beat: each cut in turn (from the first) moves to the nearest chosen beat after the
   * one before, by trimming the end of the clip before it (or letting more of it play, never
   * past the end of its footage). Every n-th beat, counted from whichever beat of the bar is the
   * strongest. Picking again starts from the clips as they were before the first pick.
   */
  private async cutToBeat(n: 1 | 2 | 4) {
    const p = this.project;
    if (!p.music || p.clips.length < 2) return;
    if (!this.songBeats()) {
      this.h.busy('Finding the beats');
      try {
        while (this.beatJob && !this.dead) await this.beatJob.p;
      } finally {
        this.h.busy(null);
      }
    }
    const all = this.timelineBeats();
    if (this.dead) return;
    if (!all || all.t.length < 2) return this.h.toast('No beat found in this song', 2400);
    this.unscope();
    // picked again (nothing else done since): from the clips as they were
    const now = JSON.stringify(p.clips);
    if (this.beatBase && this.beatBase.after === now) p.clips = JSON.parse(this.beatBase.clips);
    else this.beatBase = { clips: now, after: '' };
    let phase = 0, best = -1;
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let i = k; i < all.s.length; i += n) sum += all.s[i];
      if (sum > best) [best, phase] = [sum, k];
    }
    const grid = all.t.filter((_, i) => i % n === phase);
    let prev = 0, moved = 0;
    for (let i = 1; i < p.clips.length; i++) {
      const c = cutTime(layout(p), i);
      const cands = grid.filter((b) => b > prev + MIN_CLIP).sort((x, y) => Math.abs(x - c) - Math.abs(y - c)).slice(0, 6);
      let done = false;
      for (const b of cands) {
        if (this.fitCut(i, b)) {
          done = true;
          break;
        }
      }
      prev = cutTime(layout(p), i);
      if (done) moved++;
    }
    this.beatEvery = n;
    tick(true);
    this.changed(true);
    this.beatBase.after = JSON.stringify(p.clips);
    const bpm = this.beatCache.get(p.music.src)?.bpm;
    this.h.toast(`${moved} of ${p.clips.length - 1} cuts on the beat${bpm ? ` · ${Math.round(bpm)} BPM` : ''}`, 2200);
  }

  /** Make cut i land on timeline time b by changing where the clip before it ends (false: it can't). */
  private fitCut(i: number, b: number) {
    const p = this.project, a = p.clips[i - 1], m = this.lib.get(a.src);
    if (!m) return false;
    const out0 = a.out;
    const lo = a.in + MIN_CLIP * a.speed, hi = m.kind === 'image' ? 600 : m.duration;
    // (a transition's overlap and a ramp make the cut move a little less, or more, than the
    // clip's end: a few steps settle it)
    for (let k = 0; k < 8; k++) {
      const err = b - cutTime(layout(p), i);
      if (Math.abs(err) < 1e-3) return true;
      a.out = Math.max(lo, Math.min(hi, a.out + err * speedAt(a, a.out)));
    }
    if (Math.abs(b - cutTime(layout(p), i)) < 1 / 120) return true;
    a.out = out0;
    return false;
  }

  // ---- auto captions

  /** Captions from what's said in the clips (and the voiceover), as titles; asks before the model's one-time download. */
  private async autoCaptions() {
    const p = this.project;
    const speech = p.clips.some((c) => c.vol > 0 && this.lib.get(c.src)?.audio) || !!p.voice?.some((v) => v.vol > 0);
    if (!speech) return this.h.toast('No sound in the clips to make captions from', 2600);
    if (this.player.playing) this.togglePlay();
    if (await Captioner.ready()) return void this.makeCaptions();
    this.h.confirm('Auto captions', `Captions need a one-time ${CAPTIONS_MB} MB download. It stays on this phone for next time.`, () => void this.makeCaptions(), { yes: 'Download' });
  }

  private async makeCaptions() {
    const job = this.h.cancellable();
    this.h.busy('Getting the sound ready');
    try {
      const sp = await this.audio.speech(this.project);
      if (!sp || this.dead) return;
      if (job.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      const list = await this.h.captions.transcribe(sp.pcm, (s) => this.h.busy(s), job.signal);
      if (this.dead) return;
      // each caption back from the sound given to its moment on the timeline (through its
      // clip's speed and place, or its voiceover clip's)
      const p = this.project, L = layout(p);
      const at = (x: number, seg: SpeechSeg) => {
        const f = seg.src + Math.min(seg.len, Math.max(0, x - seg.at));
        if (seg.voice) {
          const v = p.voice?.find((y) => y.id === seg.voice);
          return v ? v.t0 + (f - v.in) : null;
        }
        const i = p.clips.findIndex((c) => c.id === seg.clip);
        return i < 0 ? null : L.starts[i] + localAt(p.clips[i], Math.min(p.clips[i].out, Math.max(p.clips[i].in, f)));
      };
      const placed: Caption[] = [];
      for (const c of splitCaptions(list, 40)) {
        // (the piece the caption starts in; one running on past its end stops there)
        const seg = sp.segs.filter((g) => g.at <= c.start + 0.25).pop();
        if (!seg) continue;
        const a = at(c.start, seg), b = at(Math.min(c.end, seg.at + seg.len), seg);
        if (a !== null && b !== null && b > a) placed.push({ start: a, end: b, text: c.text });
      }
      placed.sort((x, y) => x.start - y.start);
      const n = this.placeCaptions(placed);
      this.h.toast(n ? `${n} captions · tap one to change it` : 'No speech found', 2600);
    } catch (e) {
      if ((e as Error).name === 'AbortError') this.h.toast('Captions cancelled');
      else {
        console.error(e);
        this.h.toast('Couldn’t make captions: ' + ((e as Error).message || e), 4500);
      }
    } finally {
      job.done();
      this.h.busy(null);
    }
  }

  /**
   * Captions (timeline times, in order, split to a readable length) as titles in a caption style, each anchored to its shot like any
   * title; earlier auto captions are replaced, typed titles kept. Each starts no earlier than the
   * one before ends (phrases can overlap a little) and stays up at least 0.7 s.
   */
  placeCaptions(list: Caption[]) {
    this.unscope();
    const p = this.project;
    const total = layout(p).total;
    p.texts = p.texts.filter((t) => !t.auto);
    // sized for a phone: a little smaller on tall frames, where the height is greater
    const { w, h } = this.dims(1000);
    const size = h > w * 1.2 ? 3.6 : h > w * 0.9 ? 4.6 : 6;
    // two short lines rather than one long one
    const wrap = (s: string) => {
      if (s.length <= 24) return s;
      const mid = s.length / 2;
      let at = -1;
      for (let i = 0; i < s.length; i++) if (s[i] === ' ' && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i;
      return at > 0 ? s.slice(0, at) + '\n' + s.slice(at + 1) : s;
    };
    let prevEnd = 0, n = 0;
    for (const c of list) {
      const text = c.text.trim();
      if (!text) continue;
      const t0 = Math.max(c.start, prevEnd);
      const t1 = Math.min(total, Math.max(c.end, t0 + 0.7));
      if (t1 - t0 < 0.3) continue;
      prevEnd = t1;
      p.texts.push({
        id: uid(), text: wrap(text), t0, t1, x: 0.5, y: h > w ? 0.8 : 0.86, size, color: '#ffffff', font: 'sans', box: true,
        anchor: anchorAt(p, t0), auto: true,
      });
      n++;
    }
    this.sel = null;
    tick(true);
    this.changed(true);
    return n;
  }

  // ---- transitions

  /** The cut nearest the playhead (as the index of the clip after it; -1: there's only one clip). */
  private nearestCut() {
    const p = this.project, L = layout(p), T = this.player.time;
    let best = -1;
    for (let i = 1; i < p.clips.length; i++) if (best < 0 || Math.abs(cutTime(L, i) - T) < Math.abs(cutTime(L, best) - T)) best = i;
    return best;
  }

  /** Give the cut before clip i a transition (null: a plain cut), keeping its length, and show it. */
  private setTrans(i: number, kind: TransKind | null) {
    const p = this.project, a = p.clips[i - 1], b = p.clips[i];
    if (!a || !b) return;
    this.unscope();
    if (!kind) delete a.tr;
    else a.tr = { kind, d: a.tr?.to === b.id ? a.tr.d : this.lastTransLen, to: b.id };
    tick();
    this.changed(true);
    if (kind) this.previewTrans(i);
    else this.player.seek(cutTime(layout(p), i));
  }
  /** the length the transitions here already have (a new one starts with it, so they match) */
  private get lastTransLen() {
    for (const c of this.project.clips) if (c.tr) return c.tr.d;
    return TRANS_LEN.def;
  }

  /** Play the transition before clip i once, from a little before it to a little after. */
  private previewTrans(i: number) {
    const L = layout(this.project);
    const a = Math.max(0, L.starts[i] - 0.6), b = Math.min(L.total, L.starts[i] + L.ov[i] + 0.6);
    this.player.seek(a);
    this.onTime();
    void this.playNow().then(() => {
      if (this.player.playing) this.previewUntil = b;
    });
  }

  private transActs(row: HTMLElement, sep: () => void) {
    const p = this.project;
    const i = this.selCut();
    if (p.clips.length < 2) return this.h.tile(row, ICONS.plus, 'Add clip', 'hot', () => this.pickMedia());
    const go = (to: number) => {
      if (to < 1 || to >= p.clips.length) return;
      this.sel = { kind: 'cut', id: p.clips[to - 1].id };
      this.player.seek(cutTime(layout(p), to));
      this.onTime();
      this.h.refreshSection();
    };
    this.h.tile(row, ICONS.stepBack, 'Previous', i > 1 ? '' : 'off', () => go(i - 1));
    this.h.tile(row, ICONS.stepFwd, 'Next', i > 0 && i < p.clips.length - 1 ? '' : 'off', () => go(i + 1));
    if (i < 0) return;
    const tr = transInto(p, i);
    if (!tr) return;
    sep();
    this.h.tile(row, ICONS.play, 'Preview', '', () => this.previewTrans(i));
    this.h.tile(row, ICONS.duplicate, 'All cuts', '', () => {
      this.unscope();
      let n = 0;
      for (let k = 1; k < p.clips.length; k++) {
        p.clips[k - 1].tr = { kind: tr.kind, d: tr.d, to: p.clips[k].id };
        n++;
      }
      tick(true);
      this.changed(true);
      this.h.toast(`${TRANSITIONS.find((x) => x[0] === tr.kind)?.[1]} on all ${n} cuts`, 1800);
    });
    this.h.tile(row, ICONS.trash, 'Remove', 'danger', () => this.setTrans(i, null));
  }

  // ---- voiceover

  /** The voiceover lane shows once there's a voiceover (or one being recorded). */
  private syncTrackHeight() {
    const h = timelineHeight(!!this.project.voice?.length || !!this.rec) + 'px';
    const el = $('tlTrack');
    if (el.style.height !== h) {
      el.style.height = h;
      this.timeline?.draw();
    }
  }

  private voiceActs(row: HTMLElement, sep: () => void) {
    const p = this.project;
    if (this.rec) {
      this.h.tile(row, ICONS.stop, this.rec.phase === 'count' ? 'Cancel' : 'Stop', 'rec on', () => void this.stopVoice());
      return;
    }
    this.h.tile(row, ICONS.record, 'Record', 'rec', () => void this.startVoice());
    if (p.voice?.length && p.music) this.h.tile(row, ICONS.music, 'Duck music', p.duck !== false ? 'hot' : '', () => {
      p.duck = p.duck === false ? undefined : false;
      if (p.duck === undefined) delete p.duck;
      this.h.toast(p.duck === false ? 'The music stays at its level under the voice' : 'The music dips while the voice speaks', 2000);
      this.changed(true);
    });
    const v = this.selVoice();
    if (!v) return;
    sep();
    this.h.tile(row, v.vol > 0 ? ICONS.sound : ICONS.mute, v.vol > 0 ? 'Mute' : 'Unmute', v.vol > 0 ? '' : 'hot', () => {
      v.vol = v.vol > 0 ? 0 : 1;
      tick(true);
      this.changed(true);
    });
    this.h.tile(row, ICONS.trash, 'Delete', 'danger', () => {
      p.voice = p.voice!.filter((x) => x !== v);
      if (!p.voice.length) delete p.voice;
      this.sel = null;
      tick(true);
      this.changed(true);
    });
  }

  /** The record indicator next to the time: the count-in, then how long it's been recording. */
  private lastRecLabel = '';
  private syncRecBadge() {
    const el = $('tlRec');
    const r = this.rec;
    const label = !r ? '' : r.phase === 'count' ? `<i></i>${r.n}` : `<i></i>REC ${fmtTime(Math.max(0, this.player.time - r.startT))}`;
    if (label === this.lastRecLabel) return;
    this.lastRecLabel = label;
    el.hidden = !r;
    el.classList.toggle('count', r?.phase === 'count');
    el.innerHTML = label;
  }

  /** Record a voiceover: a count-in, then the video plays from the playhead while the microphone records. */
  private async startVoice() {
    if (this.rec || this.exporting || this.dead) return;
    const p = this.project;
    if (!p.clips.length) return this.h.toast('Add a clip first');
    if (!VoiceRecorder.supported()) return this.h.toast('Recording isn’t possible in this browser', 3000);
    if (this.player.playing) this.togglePlay();
    const total = layout(p).total;
    if (this.player.time >= total - 0.3) this.player.seek(0);
    const ctx = await this.player.audioCtx();
    const r = new VoiceRecorder(ctx);
    const rec = { r, startT: this.player.time, ctxStart: 0, delay: 0, phase: 'count' as 'count' | 'rec', n: 3 };
    this.rec = rec;
    this.syncTrackHeight();
    this.syncPlayButton();
    this.syncRecBadge();
    this.h.refreshSection();
    try {
      await r.open();
    } catch (e) {
      console.warn('microphone', e);
      r.release();
      if (this.rec === rec) this.rec = null;
      this.afterRec();
      const denied = (e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError';
      this.h.toast(denied ? 'Lumen needs the microphone to record a voiceover · allow it in the settings' : 'Couldn’t open the microphone', 4000);
      return;
    }
    // a count-in (the microphone is already listening, so the first word isn't clipped)
    for (let n = 3; n >= 1; n--) {
      if (this.rec !== rec) return r.release();
      rec.n = n;
      this.syncRecBadge();
      tick(n === 1);
      await sleep(700);
    }
    if (this.rec !== rec || this.dead) return r.release();
    rec.phase = 'rec';
    r.reset();
    this.h.refreshSection();
    await this.playNow();
    const ck = this.player.clock();
    if (this.rec !== rec) return;
    if (!ck) {
      // (playback didn't start)
      this.rec = null;
      r.release();
      this.afterRec();
      return;
    }
    rec.startT = ck.startT;
    rec.ctxStart = ck.ctxStart;
    // what the microphone hears now was said a little earlier, while the picture shown then was
    // a little behind the sound being made (the output's delay): both are taken off
    rec.delay = this.player.outputDelay() + r.inputDelay();
    this.syncRecBadge();
  }

  /** Stop recording (or the count-in): the recording becomes a voiceover clip where it was spoken. */
  private async stopVoice() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    const endT = this.player.time;
    // the output's delay, measured again now it has settled
    if (rec.phase === 'rec' && this.player.playing) rec.delay = this.player.outputDelay() + rec.r.inputDelay();
    if (this.player.playing) {
      this.player.pause();
      this.player.seek(this.player.time);
    }
    if (rec.phase === 'count') {
      rec.r.release();
      this.afterRec();
      return;
    }
    const data = await rec.r.close();
    this.afterRec();
    if (this.dead) return;
    const len = endT - rec.startT;
    const sr = data.sr;
    const x = assemble(data, rec.startT, len, (f) => rec.startT + f / sr - rec.ctxStart - rec.delay);
    const span = len >= 0.3 ? speechSpan(x, sr) : null;
    if (!span) return this.h.toast(len < 0.3 ? 'Too short to keep' : 'Nothing came through the microphone', 3000);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    try {
      const m = await this.lib.add(wavFile(x, sr, `Voice ${stamp}.wav`));
      if (this.dead) return;
      this.audio.warm(m);
      const p = this.project;
      const v: VVoice = { id: uid(), src: m.id, t0: rec.startT + span[0], in: span[0], out: Math.min(span[1], m.duration || span[1]), vol: 1 };
      v.anchor = anchorAt(p, v.t0);
      (p.voice ??= []).push(v);
      this.sel = { kind: 'voice', id: v.id };
      tick(true);
      this.changed(true);
      this.h.toast('Voiceover added · drag it in the timeline to move it', 2400);
    } catch (e) {
      console.error(e);
      this.h.toast('Couldn’t keep the recording: ' + ((e as Error).message || e), 4000);
    }
  }

  private afterRec() {
    this.lastRecLabel = '-';
    this.syncRecBadge();
    this.syncPlayButton();
    this.syncTrackHeight();
    this.timeline.draw();
    if (!this.dead) this.h.refreshSection();
  }

  /** Section opened: some need a nudge (nothing selected yet). */
  onOpenTool(id: string) {
    const p = this.project;
    if (id === 'vtrans' && this.selCut() < 0) {
      const i = this.nearestCut();
      if (i > 0) {
        this.sel = { kind: 'cut', id: p.clips[i - 1].id };
        this.player.seek(cutTime(layout(p), i));
        this.onTime();
      } else this.h.toast('Add another clip to put a transition between them', 2400);
    }
    if (id === 'vvoice' && !p.voice?.length && !this.rec) this.h.toast('Tap Record: the video plays from the playhead while you speak', 2800);
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
    if (id === 'vtrans') return p.clips.some((_, i) => !!transInto(p, i));
    if (id === 'vvoice') return !!p.voice?.length;
    if (id === 'vclip') return p.clips.some((c) => c.speed !== 1 || !!c.ramp || !!c.kf?.length || !!c.tf || !!c.fin || !!c.fout || (!!this.lib.get(c.src)?.audio && c.vol !== 1));
    return false;
  }

  // -----------------------------------------------------------------------------------
  // export

  private ex = { res: 1080, fps: 30, q: 'high' as 'high' | 'max' };
  /** the export choices made last time, per kind of footage (so they don't have to be made again) */
  private exKey() {
    return `lumen.vex.${this.sourceLong()}.${this.sourceFps()}`;
  }

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
    this.ex.res = L >= 1800 ? 1920 : 1280;
    this.ex.fps = this.sourceFps();
    try {
      const s = JSON.parse(localStorage.getItem(this.exKey()) ?? 'null') as typeof this.ex | null;
      if (s && [1280, 1920, 2560, 3840].includes(s.res) && [24, 30, 60].includes(s.fps)) this.ex = { res: s.res, fps: s.fps, q: s.q === 'max' ? 'max' : 'high' };
    } catch {
      /* no saved choice */
    }
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
    const mbps = Math.min(80e6, d.w * d.h * this.ex.fps * (this.ex.q === 'max' ? 0.3 : 0.16) * this.grainBoost()) / 1e6;
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
    // Person in the look: a mask for every frame, so the model has to be there first
    const usePpl = this.personAnywhere();
    if (usePpl && this.ppl.state !== 'ready' && !(await this.loadPeople())) return this.h.toast('The export needs the people model for Person', 3500);
    if (usePpl) this.people!.reset();
    /** what the last mask was for (a picture held by the cine rate keeps its mask) */
    let maskKey = '';
    const { w, h } = this.dims(this.ex.res);
    const st = this.h.state();
    this.exporting = true;
    this.cancelExport = false;
    this.player.pause();
    this.syncPlayButton();
    try {
      localStorage.setItem(this.exKey(), JSON.stringify(this.ex));
    } catch {
      /* private mode */
    }
    this.h.setLive(true);
    // the export gets the memory and the decoders scrubbing was holding, and the screen
    // stays on until it's done
    this.player.freeScrub();
    let wake: { release(): Promise<void> } | null = null;
    try {
      wake = (await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
    } catch {
      /* not allowed here: carry on */
    }
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
        cine: (c) => this.cineOf(c),
        prepare: async (_clip, m) => {
          // a still bigger than the one kept for the preview: read it at the export's size
          this.dropExportStill();
          const long = Math.max(w, h);
          if (m.kind !== 'image' || !m.bitmap || (m.srcLong ?? 0) <= STILL_LONG || long <= STILL_LONG * 0.9) return;
          const bmp = await this.lib.fullStill(m, Math.min(4096, long * 1.25));
          if (!bmp) return;
          this.exportStill = { id: m.id, tex: this.comp.imageTexture(bmp), w: bmp.width, h: bmp.height };
          bmp.close();
        },
        drawFrame: async (clip, m, sample, T, other?: OtherFrame) => {
          // (looks and framing follow the output frame's own moment, not the source frame's:
          // in slow motion one source frame covers several output frames)
          const s = this.picTime(clip, T);
          const long = Math.max(w, h);
          const src = this.srcFor(m, sample, long);
          const P = st.video!;
          const mix = other ? mixAt(P, T) : null;
          let look: EditState;
          let key = `${clip.id}:${s}`, shot = clip.id;
          if (mix && other) {
            // across a transition: both clips, joined
            const so = this.picTime(other.clip, T);
            const srcO = this.srcFor(other.media, other.sample, long, true, undefined, undefined, false, 1);
            const first = P.clips[mix.a] === clip;
            const [A, sa, fa, B, sb, fb] = first ? [clip, s, src, other.clip, so, srcO] : [other.clip, so, srcO, clip, s, src];
            this.comp.placeMix(fa, fb, out, this.placement(A, sa, w, h), this.placement(B, sb, w, h), mix.kind, mix.f);
            look = this.lookState(this.h.state(), A, sa, false, { clip: B, s: sb, w: mixWeight(mix.kind, mix.f) });
            // (a transition: the people of the mixed frame)
            shot = `${A.id}|${B.id}`;
            key = `${shot}:${sa}:${sb}:${mix.f}`;
          } else {
            look = this.lookState(this.h.state(), clip, s, false);
            this.comp.place(src, out, this.placement(clip, s, w, h));
          }
          // the people in this very frame, before it's drawn
          if (usePpl && this.personOn(look.v) && key !== maskKey) {
            maskKey = key;
            const fr = this.smallFrame(out);
            this.h.pipe.setPerson(await this.people!.mask(fr.px, fr.w, fr.h, T, shot));
          }
          // (t: what moves smoothly with the video's time, like a drifting light leak)
          this.h.pipe.filmFrame = { ...this.film(T, look.v), t: T };
          this.h.renderFull({ tex: out.tex, w, h, linear: false }, w, h, look);
          const ov = this.overlayAt(T);
          if (ov) this.comp.overlay(w, h, ov);
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
      this.h.setLive(false);
      this.dropExportStill();
      void wake?.release().catch(() => {});
      $('busyCancel').hidden = true;
      if (this.exportT) this.h.g.destroy(this.exportT);
      this.exportT = null;
      this.h.g.trim(2048 * 2048);
      canvas.width = keep.w;
      canvas.height = keep.h;
      this.h.busy(null);
      // the person mask is the export's last frame's: the preview asks for its own again
      if (usePpl) {
        this.h.pipe.setPerson(null);
        this.ppl.shown = -1;
        this.people?.reset();
      }
      this.h.pipe.invalidate();
      // the raw frame now holds the export's last frame: show the playhead's frame again
      this.player.seek(this.player.time);
      this.h.requestRender();
      void ok;
    }
  }

  // -----------------------------------------------------------------------------------

  /** Release everything (leaving video mode). */
  /** closed: work still in flight (files being read) must not touch the screen any more */
  private dead = false;

  dispose() {
    this.dead = true;
    this.h.pipe.setPerson(null);
    this.people?.dispose();
    this.people = null;
    this.rec?.r.release();
    this.rec = null;
    this.life.abort();
    clearTimeout(this.remixTimer);
    clearTimeout(this.capTimer);
    this.timeline.dispose();
    this.dropExportStill();
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
    this.audio.dispose();
    this.last = null;
    $('tlTrack').innerHTML = '';
    $('tlRec').hidden = true;
    $('tlPlay').classList.remove('rec');
    // handlers on elements that outlive the editor would keep all of it (and its sound) in memory
    for (const id of ['tlPrev', 'tlNext']) {
      const b = $(id);
      b.onpointerdown = b.onpointerup = b.onpointercancel = b.onlostpointercapture = null;
    }
    for (const id of ['tlPlay', 'tlAdd', 'busyCancel', 'textDone', 'textCancel', 'textSheet', 'vxCancel', 'vxGo', 'vexSheet']) $(id).onclick = null;
    for (const id of ['fileAdd', 'fileAudio', 'fileBg']) {
      const el = document.getElementById(id);
      if (el) el.onchange = null;
    }
  }
}
