import { GL, Target } from '../gl/glutil';
import { Pipeline, Source, frameSize, outputSize, wbMul } from '../gl/pipeline';
import { BrushAtlas } from '../gl/brushAtlas';
import {
  EditState, PARAM_MAP, ParamDef, clampParam, CurvePoint, Curves, cloneState, defaultState, defaultValues, LINEAR, plain,
  Mask, MaskType, MASK_ADJ, MASK_SETTINGS, MASK_TYPE_SETTINGS, MASK_LABEL, MAX_MASKS, Stroke, Spot, MAX_SPOTS, spotCircles,
} from '../params';
import { makeSpline } from '../curves';
import { LOOKS, Look, ImgStats, measure } from '../presets';
import { loadFile } from '../io/loader';
import { framed, renderExport, saveOrShare } from '../io/export';
import { encodeJpegBand } from '../io/jpegEncoder';
import { encodePngBand } from '../io/pngEncoder';
import { loadBlob, loadSession, saveBlob, saveFile, saveState } from '../io/session';
import { TOOLS, ToolDef, Chip } from './tools';
import { ICONS } from './icons';
import { CurveEditor } from './curveEditor';
import { CropOverlay, fitAspect } from './cropOverlay';
import { MaskOverlay } from './maskOverlay';
import { BlurOverlay, VignetteOverlay } from './blurOverlay';
import { HealOverlay } from './healOverlay';
import { LayerOverlay } from './layerOverlay';
import { LEAKS, LEAK_W, LEAK_H, leakCanvas } from '../leaks';
import { Loupe } from './loupe';
import { drawHistogram } from './histogram';
import { tick } from './haptics';
import { Camera } from './camera';
import { isNative, Native, fileFromPath } from '../native';
import { Segmenter, PEOPLE_PARTS, refineMask } from '../ai/segment';
import { NeuralFill, LAMA_MB, type NeuralKind } from '../ai/neural';
// the video editor (and Mediabunny) load only when a video is opened
import type { VideoMode, VideoHost } from '../video/mode';
import { isVideoFile, newProject } from '../video/project';

/** photo tools that don't apply to video */
const VIDEO_HIDDEN = new Set(['heal', 'masks', 'double']);

interface Img {
  full: Source;
  preview: Source;
  thumb: Source;
  previewT: Target;
  thumbT: Target;
  name: string;
  info: string;
}

const MASK_ADJ_MAP: Record<string, ParamDef> = Object.fromEntries(MASK_ADJ.map((d) => [d.id, d]));
const LOOK_AMT: ParamDef = { id: 'lookAmt', label: 'Strength', min: 0, max: 100, def: 100, fmt: plain };
const ASPECTS: Record<string, number | null> = {
  free: null, orig: -1, '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '3:2': 3 / 2, '2:3': 2 / 3,
  '16:9': 16 / 9, '9:16': 9 / 16, '1.85': 1.85, '2.39': 2.39,
};
const MASK_KINDS: { kind: string; label: string; desc: string; icon: string; ai?: boolean }[] = [
  { kind: 'subject', label: 'Subject', desc: 'Tap or paint over it', icon: ICONS.mSubject, ai: true },
  { kind: 'people', label: 'People', desc: 'Face, skin, hair, clothes', icon: ICONS.mPeople, ai: true },
  { kind: 'radial', label: 'Radial', desc: 'An oval area', icon: ICONS.mRadial },
  { kind: 'linear', label: 'Gradient', desc: 'Fade across, like a sky', icon: ICONS.mLinear },
  { kind: 'brush', label: 'Brush', desc: 'Paint it in', icon: ICONS.mBrush },
  { kind: 'point', label: 'Point', desc: 'A spot + similar colors', icon: ICONS.mPoint },
  { kind: 'luma', label: 'Light', desc: 'By brightness', icon: ICONS.mLuma },
  { kind: 'color', label: 'Color', desc: 'By color', icon: ICONS.mColor },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class App {
  private g!: GL;
  private pipe!: Pipeline;
  private canvas = $<HTMLCanvasElement>('view');
  private stage = $('stage');
  private frame = $('frame');
  private appEl = $('app');
  private img: Img | null = null;
  private file: File | null = null;
  /** set while editing a video (see src/video) */
  private video: VideoMode | null = null;

  state: EditState = defaultState();
  private history: string[] = [];
  private hIdx = -1;

  /** null = tool bar showing; otherwise the open section */
  private tool: ToolDef | null = null;
  private paramIdx: Record<string, number> = {};
  private sub: Record<string, string> = {};
  private aspectId = 'free';

  private compare = false;
  private showHist = false;
  private uiOff = false;
  zoom = { s: 1, x: 0, y: 0 };
  private view = { cx: 0, cy: 0, base: 1 };
  private raf = 0;
  private histTimer = 0;

  private look: { base: EditState | null; idx: number; amt: number } = { base: null, idx: -1, amt: 100 };
  private thumbsKey = '';
  private thumbCache: ImageData[] = [];

  private curve!: CurveEditor;
  private crop!: CropOverlay;
  private maskOv!: MaskOverlay;
  private blurOv!: BlurOverlay;
  private vigOv!: VignetteOverlay;
  /** two-finger shaping (blur / vignette): where the gesture started */
  private lshape0: { d: number; a: number; scale: number; rot: number; x: number; y: number; mf: { x: number; y: number } } | null = null;
  private shape0: { d: number; a: number; size: number; angle: number; mid: number; sx: number; sy: number } | null = null;
  private healOv!: HealOverlay;
  /** selected Remove spot (its source ring can be dragged), or -1 */
  private spotSel = -1;
  private hd: { i: number; kind: 'src' | 'spot' | 'new'; f0: { x: number; y: number }; sp0: Spot | null; moved: boolean } | null = null;
  private loupe = new Loupe($<HTMLCanvasElement>('loupe'));
  private atlas!: BrushAtlas;
  private maskSel = -1;
  private brushMode: 'paint' | 'erase' | 'swipe' | 'aiAdd' | 'aiSub' = 'paint';
  // AI selection: the segmenter, rasters for subject masks (by selection key), the latest
  // raster per mask (shown while a new one is computed) and the photo as the models see it
  private seg = new Segmenter();
  private neural = new NeuralFill();
  private bases = new Map<string, HTMLCanvasElement>();
  private lastBase = new Map<number, HTMLCanvasElement>();
  private baseJobs = new Set<string>();
  private baseFailed = new Set<string>();
  private frameImg: { key: string; canvas: HTMLCanvasElement; px: Uint8ClampedArray; w: number; h: number } | null = null;
  private aiStroke: { neg: boolean; pts: number[] } | null = null;
  private maskFlashTimer = 0;
  // double exposure: the second photo on the GPU, its hide/show brush, and the drag mode
  private ovAtlas!: BrushAtlas;
  private ovImg: { id: string; tex: WebGLTexture } | null = null;
  private ovLoading = '';
  private dxMode: 'move' | 'hide' | 'show' = 'move';
  private dxStroke: Stroke | null = null;
  private ld: { kind: 'move' | 'size'; x: number; y: number; f0: { x: number; y: number }; scale: number; rot: number; d0: number; a0: number } | null = null;
  private layerOv!: LayerOverlay;
  private lkTex = new Map<string, WebGLTexture>();
  // content-aware fill results (by what they were made from), newest last
  private fillCache: { key: string; tex: WebGLTexture }[] = [];
  private fillJob = '';
  private fillWaiters: (() => void)[] = [];
  private pickMode: 'pick' | 'swipe' = 'pick';
  private maskOverlayOn = false;
  private maskInteracting = false;
  private analysisCache: { key: string; px: Float32Array; w: number; h: number } | null = null;
  private saveTimer = 0;
  private animTimer = 0;
  private camera!: Camera;
  /** state when the open section was entered, for back-gesture cancel */
  private sectionStart = '';
  /** how long GL start-up (creating the shader programs) took */
  initMs = 0;
  private detailTimer = 0;
  /** full-res pixels of a region of the output, for deep zoom */
  private detail: { px: Uint8Array; x: number; y: number; w: number; h: number; W: number; H: number; ver: number } | null = null;
  private renderVer = 0;
  private zv: { img: ImageData | null; on: boolean } = { img: null, on: false };

  constructor() {
    const t0 = performance.now();
    try {
      this.initGL();
      this.initMs = Math.round(performance.now() - t0);
    } catch (e) {
      this.fatal((e as Error).message);
      return;
    }
    this.curve = new CurveEditor($('curveWrap'), () => this.state.curves, (c, commit) => {
      this.state.curves = c;
      this.requestRender();
      if (commit) this.commitAndRefresh();
    });
    this.crop = new CropOverlay($('cropLayer'), () => this.state.geo.crop, (r, commit) => {
      this.state.geo.crop = r;
      if (commit) this.commitAndRefresh();
    }, () => this.aspectNorm());
    this.maskOv = new MaskOverlay($('maskLayer'), () => ({ mask: this.selMask(), frame: this.frameInfo() }), (m, commit) => {
      this.state.masks[this.maskSel] = m;
      this.maskInteracting = !commit;
      if (commit) {
        this.updateSmartRef(m);
        this.commitAndRefresh();
      }
      this.requestRender();
    });
    this.blurOv = new BlurOverlay($('blurLayer'), () => {
      const v = this.state.v;
      return {
        type: Math.round(v.blurType), x: v.blurX, y: v.blurY,
        size: (v.blurSize / 100) * 0.6, feather: 0.02 + (v.blurFeather / 100) * 0.5, angle: (v.blurAngle * Math.PI) / 180,
      };
    }, (p, commit) => {
      const v = this.state.v;
      if (p.x !== undefined) v.blurX = p.x;
      if (p.y !== undefined) v.blurY = p.y;
      if (p.size !== undefined) v.blurSize = clampParam('blurSize', (p.size / 0.6) * 100);
      if (p.angle !== undefined) v.blurAngle = wrap90((p.angle * 180) / Math.PI);
      this.requestRender();
      if (Object.keys(p).length) this.showHud(this.currentParam() ?? 'blurSize');
      if (commit) this.commitAndRefresh();
    });
    this.vigOv = new VignetteOverlay($('vigLayer'), () => {
      const v = this.state.v;
      return { x: v.vigX, y: v.vigY, start: 0.25 + (v.vigMidpoint / 100) * 0.9, round: v.vigRound / 100, aspect: this.canvas.width / Math.max(1, this.canvas.height) };
    }, (p, commit) => {
      const v = this.state.v;
      if (p.x !== undefined) v.vigX = p.x;
      if (p.y !== undefined) v.vigY = p.y;
      if (p.start !== undefined) v.vigMidpoint = clampParam('vigMidpoint', ((p.start - 0.25) / 0.9) * 100);
      if (p.round !== undefined) v.vigRound = clampParam('vigRound', p.round * 100);
      if (v.vignette === 0 && Object.keys(p).length) v.vignette = -35; // moving an invisible vignette: give it some strength
      this.requestRender();
      if (commit) this.commitAndRefresh();
      else if (this.currentParam()) this.showHud(this.currentParam()!);
    });
    this.healOv = new HealOverlay($('healLayer'), this.maskOv, () => ({
      spots: this.state.spots, sel: this.spotSel, aspect: this.frameInfo().aspect,
      painting: this.healPaint ? { pts: this.healPaint.pts, r: this.healPaint.r } : null,
      fills: this.state.fills ?? [],
    }));
    this.layerOv = new LayerOverlay($('layerLayer'), () => this.layerGeometry());
    this.camera = new Camera((m, ms) => this.toast(m, ms));
    this.bindChrome();
    this.bindGestures();
    this.bindBack();
    this.buildTools();
    this.setMode(null);
    this.commit();
    this.updateChrome();
    new ResizeObserver(() => this.layout()).observe(this.stage);
    new ResizeObserver(() => this.layout()).observe($('dock'));
    // reveal the start page once fonts and the saved session are known, so nothing shifts
    const fonts = Promise.race([
      Promise.all(['700 34px Silkscreen', '700 14px Silkscreen', '500 16px "Pixelify Sans"'].map((f) => document.fonts.load(f).catch(() => []))),
      new Promise((r) => setTimeout(r, 900)),
    ]);
    void Promise.all([this.offerResume(), fonts]).then(() => requestAnimationFrame(() => $('empty').classList.add('ready')));
  }

  private initGL() {
    this.g = new GL(this.canvas);
    this.pipe = new Pipeline(this.g);
    this.atlas = new BrushAtlas(this.g.gl);
    this.atlas.getBase = (m) => this.maskBase(m);
    this.ovAtlas = new BrushAtlas(this.g.gl);
    this.ovAtlas.getBase = (m) => this.maskBase(m);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
    });
    this.canvas.addEventListener('webglcontextrestored', async () => {
      this.g = new GL(this.canvas);
      this.pipe = new Pipeline(this.g);
      this.atlas = new BrushAtlas(this.g.gl);
      this.atlas.getBase = (m) => this.maskBase(m);
      this.ovAtlas = new BrushAtlas(this.g.gl);
      this.ovAtlas.getBase = (m) => this.maskBase(m);
      this.ovImg = null;
      this.lkTex.clear();
      this.fillCache = [];
      this.img = null;
      if (this.file) await this.open(this.file, true);
    });
  }

  private fatal(msg: string) {
    const e = $('empty');
    e.innerHTML = `<h1>LUMEN</h1><p>${msg}</p><p>Try the latest Safari or Chrome.</p>`;
    e.classList.add('ready');
  }

  private async offerResume() {
    const s = await loadSession();
    if (!s || this.img) return;
    const b = $<HTMLButtonElement>('btnResume');
    b.hidden = false;
    b.onclick = () => this.open(s.file, false, s.state);
  }

  // -----------------------------------------------------------------------------------
  // Opening images

  async open(file: File, keepState = false, restoreState = '') {
    if (this.video) {
      this.setMode(null);
      this.closeVideo();
    }
    this.busy('Opening');
    try {
      const maxDim = Math.min(this.g.maxTex, 8192);
      const L = await loadFile(file, maxDim, (s) => this.busy(s.replace('…', '')));
      this.busy('Preparing');
      await new Promise((r) => setTimeout(r, 0));
      const g = this.g;
      const gl = g.gl;
      this.disposeImage();
      let full: Source;
      if (L.kind === 'bitmap') {
        const tex = g.texture(L.w, L.h, 'u8');
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, L.bitmap);
        L.bitmap.close();
        full = { tex, w: L.w, h: L.h, linear: false };
      } else {
        const tex = g.texture(L.w, L.h, 'rgb16f');
        const rows = Math.max(1, Math.floor(1_500_000 / L.w));
        for (let y = 0; y < L.h; y += rows) {
          const n = Math.min(rows, L.h - y);
          const f = new Float32Array(L.w * n * 3);
          const src = L.data.subarray(y * L.w * 3, (y + n) * L.w * 3);
          for (let i = 0; i < f.length; i++) f[i] = src[i] / 65535;
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, L.w, n, gl.RGB, gl.FLOAT, f);
        }
        full = { tex, w: L.w, h: L.h, linear: true };
      }
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const P = Math.round(Math.min(2048, Math.max(1280, Math.max(innerWidth, innerHeight) * dpr)));
      const k = Math.min(1, P / Math.max(full.w, full.h));
      const previewT = this.pipe.resize(full, Math.round(full.w * k), Math.round(full.h * k));
      const kt = Math.min(1, 200 / Math.max(full.w, full.h));
      const thumbT = this.pipe.resize(previewT, Math.round(full.w * kt), Math.round(full.h * kt));
      this.img = {
        full,
        preview: { tex: previewT.tex, w: previewT.w, h: previewT.h, linear: full.linear },
        thumb: { tex: thumbT.tex, w: thumbT.w, h: thumbT.h, linear: full.linear },
        previewT, thumbT,
        name: file.name,
        info: L.info,
      };
      this.file = file;
      this.pipe.invalidate();
      if (!keepState) {
        this.state = defaultState();
        if (restoreState) {
          try {
            const r = JSON.parse(restoreState) as EditState;
            this.state = { ...defaultState(), ...r, v: { ...defaultValues(), ...r.v }, masks: r.masks ?? [], spots: r.spots ?? [] };
          } catch {
            /* ignore a broken autosave */
          }
        } else {
          // RAW orientation is applied as a quarter turn, like the crop tool's rotate
          if (L.quarter) this.state.geo.quarter = L.quarter;
          saveFile(file);
        }
        this.history = [];
        this.hIdx = -1;
        this.paramIdx = {};
        this.sub = {};
        this.look = { base: null, idx: -1, amt: 100 };
        this.aspectId = 'free';
        this.zoom = { s: 1, x: 0, y: 0 };
        this.maskSel = this.state.masks.length ? 0 : -1;
        this.commit();
      }
      this.analysisCache = null;
      this.syncAtlasSize();
      this.thumbsKey = '';
      if (this.homeOver) this.showHome(false);
      $('btnResume').hidden = true;
      $('empty').classList.add('hidden');
      this.frame.classList.remove('empty');
      $('title').textContent = L.info;
      this.setMode(null);
      this.layout();
      this.requestRender();
      this.toast(L.note ?? L.info, L.note ? 5000 : 1800);
    } catch (e) {
      console.error(e);
      this.toast((e as Error).message || 'Could not open that file.', 5000);
    } finally {
      this.busy(null);
      this.updateChrome();
    }
  }

  private disposeImage() {
    if (!this.img) return;
    if (this.video) {
      // the frame textures belong to the video editor
      this.g.destroy(this.img.thumbT);
      this.img = null;
      this.pipe.invalidate();
      return;
    }
    const gl = this.g.gl;
    gl.deleteTexture(this.img.full.tex);
    this.g.destroy(this.img.previewT);
    this.g.destroy(this.img.thumbT);
    this.img = null;
    this.pipe.invalidate();
    this.g.trim(0);
  }

  // -----------------------------------------------------------------------------------
  // Rendering

  requestRender() {
    this.renderVer++;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow();
    });
  }

  private kind() {
    return this.tool?.kind ?? null;
  }

  /** On-screen render scale (<= 1): the preview is rendered at about the size it's shown at. */
  private rs = 1;
  private wantRs() {
    if (!this.img) return 1;
    const fw = parseFloat(this.frame.style.width);
    if (!fw) return 1;
    const shown = fw * this.view.base * this.zoom.s * (window.devicePixelRatio || 1); // device px across the photo
    const fullW = outputSize(this.viewState(), this.img.preview.w, this.img.preview.h).w;
    // a playing / scrubbing video may render a little softer if the phone can't keep up
    const need = Math.min((shown / fullW) * 1.04, this.video?.renderCap() ?? 1);
    let lv = [0.4, 0.55, 0.7, 0.85, 1].find((l) => l >= need) ?? 1;
    // don't flip-flop at the edge of a level (unless a video is asking for less on purpose)
    if (lv < this.rs && need > this.rs * 0.8 && (this.video?.renderCap() ?? 1) >= this.rs) lv = this.rs;
    return lv;
  }
  private syncRenderScale() {
    const n = this.wantRs();
    if (n !== this.rs) {
      this.rs = n;
      this.requestRender();
    }
  }

  /** What's on screen: the edit, the original (compare), or the uncropped frame (crop section). */
  private viewState(): EditState {
    let s = this.state;
    if (this.compare) s = this.origState();
    if (this.kind() === 'crop') s = { ...s, geo: { ...s.geo, crop: { x: 0, y: 0, w: 1, h: 1 } } };
    return s;
  }

  private renderNow() {
    if (!this.img || this.video?.exporting) return;
    const st = this.viewState();
    const full = outputSize(st, this.img.preview.w, this.img.preview.h);
    // render only as many pixels as the screen can show (a big saving while dragging sliders)
    const w = Math.max(1, Math.round(full.w * this.rs)), h = Math.max(1, Math.round(full.h * this.rs));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.layout();
    }
    const aiMode = this.selMask()?.type === 'subject' && (this.brushMode === 'aiAdd' || this.brushMode === 'aiSub');
    this.atlas.sync(st.masks);
    this.pipe.brushTex = this.atlas.tex;
    this.syncOverlay(st);
    this.pipe.showMask = this.kind() === 'masks' && (this.maskOverlayOn || this.maskInteracting || aiMode) ? this.maskSel : -1;
    try {
      this.pipe.render(this.img.preview, st, w, h, null);
      this.video?.afterRender(w, h);
    } catch (e) {
      console.error(e);
      this.toast('Render error: ' + (e as Error).message, 4000);
    }
    // zoomed in, the sharp full-resolution copy on top is now out of date: show the live
    // preview until it's redone (otherwise brush strokes and slider moves only appear once
    // you stop)
    if (this.detail && this.detail.ver !== this.renderVer) {
      $('detail').classList.remove('on');
      this.setZoomView(false);
    }
    // the loupe copies from the canvas while its frame is still current
    if (this.loupe.pos) this.loupe.draw(this.canvas, this.stage.getBoundingClientRect());
    if (this.showHist || this.kind() === 'curves') this.scheduleHist();
    this.scheduleDetail(true);
    if (!this.compare && !this.video) this.scheduleOrig();
  }

  // ---- pixel-level zoom: render what's visible at full resolution when the preview runs out

  private outFull() {
    const img = this.img!;
    return outputSize(this.viewState(), img.full.w, img.full.h);
  }

  /** CSS px per full-resolution output pixel at zoom 1. */
  private pxPerOut() {
    const fw = parseFloat(this.frame.style.width) || 1;
    return (fw * this.view.base) / this.outFull().w;
  }

  private maxZoom() {
    if (!this.img) return 12;
    return Math.max(12, 32 / this.pxPerOut());
  }

  private scheduleDetail(changed = false) {
    const det = $<HTMLCanvasElement>('detail');
    clearTimeout(this.detailTimer);
    // nothing to do at normal zoom — skip the timer entirely
    if (this.zoom.s <= 1.01 && !det.classList.contains('on') && !this.zv.on) return;
    this.detailTimer = window.setTimeout(() => this.renderDetail(), changed ? 200 : 90);
  }

  /**
   * Deep zoom. Below ~2 screen px per image pixel the transformed preview/detail canvas is
   * fine. Beyond that the app paints the zoomed pixels itself into a screen-sized canvas,
   * computing every pixel edge once and drawing the grid on those same edges, so pixels and
   * grid can't disagree.
   */
  private renderDetail() {
    const det = $<HTMLCanvasElement>('detail');
    const off = () => {
      det.classList.remove('on');
      this.setZoomView(false);
    };
    if (!this.img || this.compare || this.kind() === 'crop' || this.zoom.s <= 1.01) return off();
    // mid-stroke or mid-drag: the full-resolution render would stall the finger; wait until it's done
    if (this.stroke || this.dxStroke || this.vd || this.aiStroke || this.healPaint) {
      this.detailTimer = window.setTimeout(() => this.renderDetail(), 160);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const fr = this.frame.getBoundingClientRect();
    const { w: W, h: H } = this.outFull();
    const cell = fr.width / W; // CSS px per image pixel
    const deep = cell >= 2;
    const blurry = (fr.width * dpr) / this.canvas.width >= 1.2 && W > this.canvas.width * 1.05;
    if (!deep && !blurry) return off();
    const st = this.stage.getBoundingClientRect();
    const vx0 = Math.max(0, Math.floor(((st.left - fr.left) / fr.width) * W));
    const vx1 = Math.min(W, Math.ceil(((st.right - fr.left) / fr.width) * W));
    const vy0 = Math.max(0, Math.floor(((st.top - fr.top) / fr.height) * H));
    const vy1 = Math.min(H, Math.ceil(((st.bottom - fr.top) / fr.height) * H));
    if (vx1 <= vx0 || vy1 <= vy0) return off();
    const D = this.detail;
    const covered = D && D.ver === this.renderVer && D.W === W && D.H === H &&
      D.x <= vx0 && D.y <= vy0 && D.x + D.w >= vx1 && D.y + D.h >= vy1;
    if (!covered) {
      // render the visible area plus a margin, so panning doesn't need a new render each time
      const mw = Math.ceil((vx1 - vx0) * 0.6), mh = Math.ceil((vy1 - vy0) * 0.6);
      const x = Math.max(0, vx0 - mw), y = Math.max(0, vy0 - mh);
      const w = Math.min(W, vx1 + mw) - x, h = Math.min(H, vy1 + mh) - y;
      if (w * h > 8_000_000 || w < 1 || h < 1) return off();
      try {
        this.atlas.sync(this.state.masks);
        this.pipe.brushTex = this.atlas.tex;
        this.syncOverlay(this.viewState());
        const px = this.pipe.renderRegion(this.img.full, this.img.preview, this.viewState(), W, H, { x, y, w, h });
        this.detail = { px, x, y, w, h, W, H, ver: this.renderVer };
      } catch (e) {
        console.warn('detail render failed', e);
        return off();
      }
    }
    const d = this.detail!;
    if (deep) {
      det.classList.remove('on');
      this.setZoomView(true);
      this.drawZoomView();
    } else {
      this.setZoomView(false);
      det.width = d.w;
      det.height = d.h;
      det.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.px.buffer, d.px.byteOffset, d.w * d.h * 4), d.w, d.h), 0, 0);
      Object.assign(det.style, { left: (d.x / W) * 100 + '%', top: (d.y / H) * 100 + '%', width: (d.w / W) * 100 + '%', height: (d.h / H) * 100 + '%' });
      det.classList.add('on');
    }
  }

  private setZoomView(on: boolean) {
    if (this.zv.on === on) return;
    this.zv.on = on;
    $('zoomView').classList.toggle('on', on);
    this.frame.classList.toggle('zv', on);
  }

  /** Paint the zoomed pixels (nearest neighbour) and the pixel grid at device resolution. */
  private drawZoomView() {
    const D = this.detail;
    if (!this.zv.on || !D) return;
    const cv = $<HTMLCanvasElement>('zoomView');
    const dpr = window.devicePixelRatio || 1;
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    const CW = Math.round(sw * dpr), CH = Math.round(sh * dpr);
    if (cv.width !== CW || cv.height !== CH) {
      cv.width = CW;
      cv.height = CH;
      this.zv.img = null;
    }
    const ctx = cv.getContext('2d')!;
    if (!this.zv.img) this.zv.img = ctx.createImageData(CW, CH);
    const out = new Uint32Array(this.zv.img.data.buffer);
    const src = new Uint32Array(D.px.buffer, D.px.byteOffset, D.w * D.h);
    const fr = this.frame.getBoundingClientRect();
    const st = this.stage.getBoundingClientRect();
    const cellX = (fr.width / D.W) * dpr, cellY = (fr.height / D.H) * dpr;
    const ox = (fr.left - st.left) * dpr, oy = (fr.top - st.top) * dpr;
    // device column/row -> source column/row (or -1), from rounded pixel edges
    const colOf = new Int32Array(CW).fill(-1);
    const rowOf = new Int32Array(CH).fill(-1);
    const gridCols: number[] = [], gridRows: number[] = [];
    for (let i = D.x; i <= D.x + D.w; i++) {
      const e0 = Math.round(ox + i * cellX), e1 = Math.round(ox + (i + 1) * cellX);
      if (e1 <= 0 || e0 >= CW) continue;
      if (i < D.x + D.w) for (let x = Math.max(0, e0); x < Math.min(CW, e1); x++) colOf[x] = i - D.x;
      if (e0 >= 0 && e0 < CW) gridCols.push(e0);
    }
    for (let j = D.y; j <= D.y + D.h; j++) {
      const e0 = Math.round(oy + j * cellY), e1 = Math.round(oy + (j + 1) * cellY);
      if (e1 <= 0 || e0 >= CH) continue;
      if (j < D.y + D.h) for (let y = Math.max(0, e0); y < Math.min(CH, e1); y++) rowOf[y] = j - D.y;
      if (e0 >= 0 && e0 < CH) gridRows.push(e0);
    }
    const BG = 0xff090a0b; // #0b0a09 as little-endian ABGR
    let prevRow = -2;
    for (let y = 0; y < CH; y++) {
      const r = rowOf[y];
      const base = y * CW;
      if (r === prevRow && y > 0) {
        out.copyWithin(base, base - CW, base);
        continue;
      }
      prevRow = r;
      if (r < 0) {
        out.fill(BG, base, base + CW);
        continue;
      }
      const sBase = r * D.w;
      for (let x = 0; x < CW; x++) {
        const c = colOf[x];
        out[base + x] = c < 0 ? BG : src[sBase + c];
      }
    }
    // grid: same edges as the pixels, faded in as pixels get bigger
    const cellCss = fr.width / D.W;
    if (cellCss >= 10) {
      const a = Math.min(1, (cellCss - 10) / 10) * 0.3;
      const blend = (p: number) => {
        const r = p & 255, g = (p >>> 8) & 255, b = (p >>> 16) & 255;
        return (0xff << 24) | (Math.round(b + (223 - b) * a) << 16) | (Math.round(g + (233 - g) * a) << 8) | Math.round(r + (239 - r) * a);
      };
      for (const x of gridCols) for (let y = 0; y < CH; y++) if (rowOf[y] >= 0) out[y * CW + x] = blend(out[y * CW + x]);
      for (const y of gridRows) {
        const base = y * CW;
        for (let x = 0; x < CW; x++) if (colOf[x] >= 0) out[base + x] = blend(out[base + x]);
      }
    }
    ctx.putImageData(this.zv.img, 0, 0);
  }

  private updatePixelGrid() {
    // the grid is part of the zoom view now; keep the preview crisp when magnified
    if (!this.img) return;
    const fr = this.frame.getBoundingClientRect();
    this.canvas.classList.toggle('pixelated', fr.width / this.canvas.width >= 3);
    if (this.zv.on) this.drawZoomView();
  }

  private scheduleHist() {
    clearTimeout(this.histTimer);
    this.histTimer = window.setTimeout(() => {
      if (!this.img) return;
      const st = this.viewState();
      const { w, h } = outputSize(st, this.img.thumb.w, this.img.thumb.h);
      const px = this.pipe.renderPixels(this.img.thumb, st, w, h);
      this.curve.hist = drawHistogram($<HTMLCanvasElement>('hist'), px);
      if (this.kind() === 'curves') this.curve.draw();
    }, 90);
  }

  /** Space left for the photo between the floating top bar and the dock. */
  private region() {
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    if (this.uiOff) return { top: 0, bot: 0, sw, sh };
    const topEl = document.querySelector('.top') as HTMLElement;
    const top = topEl.offsetHeight - 16;
    // the dock only holds the visible half (tools or section), so its height is what's covered
    const bot = $('dock').offsetHeight - 6;
    return { top, bot, sw, sh };
  }

  private layout(animate = false) {
    const R = this.region();
    const root = document.documentElement.style;
    if (!this.uiOff) {
      root.setProperty('--top-h', R.top + 'px');
      root.setProperty('--bot-h', R.bot + 'px');
    }
    const cw = this.canvas.width || 1;
    const ch = this.canvas.height || 1;
    // the photo element is sized for full screen; the UI-visible fit is a transform on top
    const full = Math.min(R.sw / cw, R.sh / ch);
    this.frame.style.width = Math.max(1, cw * full) + 'px';
    this.frame.style.height = Math.max(1, ch * full) + 'px';
    const fit = Math.min((R.sw - 12) / cw, (R.sh - R.top - R.bot - 10) / ch);
    this.view = { cx: R.sw / 2, cy: R.top + (R.sh - R.top - R.bot) / 2, base: Math.min(1, Math.max(0.2, fit / full)) };
    this.applyZoom(animate);
    if (this.kind() === 'crop') this.crop.update();
    if (this.kind() === 'curves') this.curve.draw();
  }

  private applyZoom(animate = false) {
    const z = this.zoom;
    const V = this.view;
    if (animate) {
      this.frame.classList.add('anim');
      clearTimeout(this.animTimer);
      this.animTimer = window.setTimeout(() => {
        this.frame.classList.remove('anim');
        this.redrawOverlays();
        this.updatePixelGrid();
      }, 280);
    }
    this.frame.style.transform = `translate(${V.cx + z.x}px, ${V.cy + z.y}px) scale(${V.base * z.s}) translate(-50%, -50%)`;
    this.syncRenderScale();
    const b = $('zoomBadge');
    b.classList.toggle('on', z.s > 1.01);
    if (z.s > 1.01) b.textContent = this.img && this.pxPerOut() * z.s >= 1 ? `${Math.round(this.pxPerOut() * z.s * 100)}%` : Math.round(z.s * 100) + '%';
    this.redrawOverlays();
    if (this.img) {
      if (animate) this.setZoomView(false);
      else this.updatePixelGrid();
      this.scheduleDetail();
    }
  }

  private redrawOverlays() {
    const k = this.kind();
    if (k === 'masks') this.maskOv.draw();
    if (k === 'blur') this.blurOv.draw();
    if (k === 'heal') this.healOv.draw();
    if (this.tool?.id === 'vignette') this.vigOv.draw();
  }

  /** Tap the photo: fade all controls away (or back). */
  private toggleUI(force?: boolean) {
    this.uiOff = force ?? !this.uiOff;
    this.appEl.classList.toggle('ui-off', this.uiOff);
    this.showMenu(false);
    this.layout(true);
  }

  // -----------------------------------------------------------------------------------
  // History

  commit() {
    const s = JSON.stringify(this.state);
    if (this.history[this.hIdx] === s) return;
    this.history = this.history.slice(0, this.hIdx + 1);
    this.history.push(s);
    if (this.history.length > 200) this.history.shift();
    // brush-heavy edits make big states: keep the whole history under ~60 MB of text
    let size = 0;
    for (const h of this.history) size += h.length;
    while (size > 60_000_000 && this.history.length > 3) size -= this.history.shift()!.length;
    this.hIdx = this.history.length - 1;
    this.updateChrome();
    if (this.img && !this.video) {
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => saveState(this.history[this.hIdx]), 800);
    }
    if (this.video) this.video.updateTitle();
  }

  private commitAndRefresh() {
    this.commit();
    this.updateSecBar();
  }

  /** Undo / redo with a click you can feel and a badge saying what changed. */
  private undoRedo(dir: -1 | 1) {
    const i = this.hIdx + dir;
    if (i < 0 || i >= this.history.length) return;
    const before = this.history[this.hIdx];
    const after = this.history[i];
    this.restore(i);
    tick(true);
    const what = describeChange(before, after);
    this.flash((dir < 0 ? 'Undo' : 'Redo') + (what ? ' · ' + what : ''));
    const b = $(dir < 0 ? 'btnUndo' : 'btnRedo');
    b.classList.remove('kick');
    void b.offsetWidth;
    b.classList.add('kick');
  }

  /** Every step of the edit, newest first. Tap one to jump there. */
  private openHistory() {
    const list = $('histList');
    list.innerHTML = '';
    for (let i = this.history.length - 1; i >= 0; i--) {
      const label = i === 0 ? 'Opened' : describeChange(this.history[i - 1], this.history[i]) || 'Edit';
      const b = document.createElement('button');
      b.className = 'hrow' + (i === this.hIdx ? ' on' : i > this.hIdx ? ' future' : '');
      b.innerHTML = `<span class="n">${i}</span><span class="t">${escapeHtml(label)}</span>${i === this.hIdx ? '<span class="m">NOW</span>' : ''}`;
      b.onclick = () => {
        $('historySheet').classList.remove('on');
        if (i === this.hIdx) return;
        this.restore(i);
        tick(true);
        this.flash(`Back to · ${label}`);
      };
      list.appendChild(b);
    }
    $('historySheet').classList.add('on');
    (list.querySelector('.on') as HTMLElement | null)?.scrollIntoView({ block: 'center' });
  }

  private flashTimer = 0;
  private flash(text: string) {
    const el = $('flash');
    el.textContent = text;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => el.classList.remove('on'), 900);
  }

  private restore(i: number) {
    if (i < 0 || i >= this.history.length) return;
    this.hIdx = i;
    this.state = { spots: [], ...JSON.parse(this.history[i]) };
    this.maskSel = Math.min(this.maskSel, this.state.masks.length - 1);
    if (this.maskSel < 0 && this.state.masks.length) this.maskSel = 0;
    this.syncAtlasSize();
    this.look.base = null;
    this.look.idx = -1;
    this.video?.onRestore();
    this.requestRender();
    this.refreshSection();
    this.updateChrome();
  }

  // -----------------------------------------------------------------------------------
  // Params. Plain ids are global; 'lookAmt' = look strength; 'ma.x' / 'mg.x' = selected
  // mask's adjustments / mask settings.

  private def(id: string): ParamDef {
    if (id === 'lookAmt') return LOOK_AMT;
    if (id.startsWith('vd.') && this.video) return this.video.def(id);
    if (id.startsWith('ma.')) return MASK_ADJ_MAP[id.slice(3)];
    if (id.startsWith('mg.')) return MASK_SETTINGS[id.slice(3)];
    return PARAM_MAP[id];
  }
  private get(id: string) {
    if (id === 'lookAmt') return this.look.amt;
    if (id.startsWith('vd.')) return this.video?.get(id) ?? 0;
    const m = this.selMask();
    if (id.startsWith('ma.')) return m ? m.a[id.slice(3)] ?? 0 : 0;
    if (id.startsWith('mg.')) return m ? m.g[id.slice(3)] ?? this.def(id).def : 0;
    return this.state.v[id];
  }
  private set(id: string, v: number) {
    const d = this.def(id);
    v = Math.min(d.max, Math.max(d.min, v));
    if (id.startsWith('vd.')) {
      this.video?.set(id, v);
      this.requestRender();
      return;
    }
    if (id === 'lookAmt') {
      this.look.amt = v;
      if (this.look.base && this.look.idx >= 0) this.applyLookValues();
    } else if (id.startsWith('ma.') || id.startsWith('mg.')) {
      const m = this.selMask();
      if (!m) return;
      (id.startsWith('ma.') ? m.a : m.g)[id.slice(3)] = v;
      if (id === 'mg.smart' && v > 0) this.updateSmartRef(m);
      if (id.startsWith('mg.')) this.maskOv.draw();
    } else {
      this.state.v[id] = v;
      if (id.startsWith('blur')) this.blurOv.draw();
      if (id.startsWith('vig')) this.vigOv.draw();
    }
    this.requestRender();
  }

  /** Painting a brush or subject mask: the slider holds the brush settings. */
  private brushing() {
    const m = this.kind() === 'masks' ? this.selMask() : null;
    return !!m && (m.type === 'brush' || m.type === 'subject') && (this.brushMode === 'paint' || this.brushMode === 'erase');
  }
  /** Which remembered slider position applies (the brush settings keep their own). */
  private pkey() {
    return this.brushing() ? 'masks:brush' : this.tool!.id;
  }

  private params(): string[] {
    const t = this.tool;
    if (!t) return [];
    if (t.kind === 'masks') {
      const m = this.selMask();
      if (!m) return [];
      if (this.brushing()) return ['mg.size', 'mg.hard', 'mg.flow'];
      return [...MASK_ADJ.map((d) => 'ma.' + d.id), ...MASK_TYPE_SETTINGS[m.type].map((k) => 'mg.' + k)];
    }
    if (t.kind === 'blur') return t.params(String(Math.round(this.state.v.blurType)));
    if (t.kind === 'heal') return ['healSize'];
    if (t.kind === 'double' || t.kind === 'leak') {
      const k = t.kind === 'double' ? 'dx' : 'lk';
      if (!this.layerOf(k)) return [];
      return this.dxMode === 'move' ? [k + 'Opacity', k + 'Scale', k + 'Rot', ...(k === 'lk' ? ['lkBlend'] : [])] : [k + 'Brush', k + 'Hard', k + 'Opacity'];
    }
    if (t.kind === 'looks') return this.look.idx > 0 ? ['lookAmt'] : [];
    return t.params(this.sub[t.id] ?? t.subs?.[0].id ?? '');
  }
  private currentParam(): string | null {
    const ps = this.params();
    if (!ps.length || !this.tool) return null;
    return ps[Math.min(ps.length - 1, this.paramIdx[this.pkey()] ?? 0)];
  }
  private fmt(id: string, v = this.get(id)) {
    return (this.def(id).fmt ?? plain)(v);
  }
  private isModified(ids: string[]) {
    return ids.some((id) => id !== 'lookAmt' && Math.abs(this.get(id) - this.def(id).def) > 1e-6);
  }
  private toolModified(t: ToolDef) {
    const v = this.state.v;
    switch (t.kind) {
      case 'looks':
        return this.look.base !== null && this.look.idx > 0;
      case 'masks':
        return this.state.masks.length > 0;
      case 'curves':
        return JSON.stringify(this.state.curves) !== JSON.stringify(defaultState().curves);
      case 'crop': {
        const g = this.state.geo;
        return g.quarter !== 0 || g.flipH || g.flipV || g.crop.w < 0.999 || g.crop.h < 0.999 || v.straighten !== 0;
      }
      case 'blur':
        return v.blurType > 0;
      case 'heal':
        return this.state.spots.length > 0 || !!this.state.fills?.length;
      case 'double':
        return !!this.state.overlay;
      case 'leak':
        return !!this.state.leak;
      case 'video':
        return !!this.video?.isModified(t.id);
      default: {
        const subs = t.subs ? t.subs.map((s) => s.id) : [''];
        return subs.some((s) => t.params(s).some((p) => Math.abs(v[p] - PARAM_MAP[p].def) > 1e-6));
      }
    }
  }

  // -----------------------------------------------------------------------------------
  // Chrome

  private bindChrome() {
    $('btnHome').innerHTML = ICONS.home;
    $('btnHome').onclick = () => {
      tick();
      this.showHome(true, true);
    };
    $('btnCamera').onclick = () => this.takePhoto();
    $('btnUndo').innerHTML = ICONS.undo;
    $('btnRedo').innerHTML = ICONS.redo;
    $('btnHistory').innerHTML = ICONS.history;
    $('btnHistory').onclick = () => {
      tick();
      this.openHistory();
    };
    $('btnMore').innerHTML = ICONS.more;
    $('secReset').innerHTML = ICONS.reset;
    $('secDone').innerHTML = ICONS.check;

    // image/* lets Android show its photo picker, which includes Google Photos (and DNGs)
    const input = $<HTMLInputElement>('file');
    input.onchange = () => this.openFiles([...(input.files ?? [])]);
    $('btnOpenBig').onclick = () => this.pickPhoto();
    $('btnUndo').onclick = () => this.undoRedo(-1);
    $('btnRedo').onclick = () => this.undoRedo(1);
    $('secDone').onclick = () => {
      tick();
      this.closeSection();
    };
    $('secReset').onclick = () => {
      tick(true);
      this.resetSection();
    };
    $('paramName').onclick = () => this.showMenu(true, true);
    $('zoomBadge').onclick = () => {
      this.zoom = { s: 1, x: 0, y: 0 };
      this.applyZoom(true);
    };
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.openFiles([...(e.dataTransfer?.files ?? [])]);
    });
    this.bindValueInput();
    this.bindSlider();
    this.bindExport();
    this.bindMore();
    this.bindPresets();
    this.bindMaskSheet();
    this.bindKeys();
  }

  /** Open media: one photo edits the photo; any video (or several files) starts a video. */
  openFiles(files: File[]) {
    if (!files.length) return;
    if (files.length === 1 && !isVideoFile(files[0])) return void this.open(files[0]);
    void this.openVideo(files);
  }

  private resetEdit() {
    this.history = [];
    this.hIdx = -1;
    this.paramIdx = {};
    this.sub = {};
    this.look = { base: null, idx: -1, amt: 100 };
    this.aspectId = 'free';
    this.zoom = { s: 1, x: 0, y: 0 };
    this.maskSel = -1;
  }

  /** Start a video project with these files. */
  async openVideo(files: File[]) {
    this.setMode(null);
    if (this.video) this.closeVideo();
    else this.disposeImage();
    this.file = null;
    this.state = defaultState();
    this.state.video = newProject();
    this.resetEdit();
    this.busy('Opening');
    let Mode: typeof VideoMode;
    try {
      Mode = (await import('../video/mode')).VideoMode;
    } catch (e) {
      this.busy(null);
      this.toast('Couldn’t load the video editor: ' + (e as Error).message, 5000);
      return;
    }
    this.appEl.classList.add('video');
    this.video = new Mode(this.videoHost());
    this.buildTools();
    await this.video.addFiles(files);
    if (!this.state.video?.clips.length) {
      this.closeVideo();
      this.updateChrome();
      return;
    }
    this.analysisCache = null;
    this.syncAtlasSize();
    this.thumbsKey = '';
    if (this.homeOver) this.showHome(false);
    $('btnResume').hidden = true;
    $('empty').classList.add('hidden');
    this.frame.classList.remove('empty');
    this.setMode(null);
    this.layout();
    this.requestRender();
    this.updateChrome();
    this.toast('Drag the timeline to scrub · tap a clip to edit it · tap the video to play', 3200);
  }

  /** Leave video mode (back to photos). */
  private closeVideo() {
    if (!this.video) return;
    this.video.dispose();
    this.video = null;
    if (this.img) this.g.destroy(this.img.thumbT);
    this.img = null;
    this.pipe.invalidate();
    this.appEl.classList.remove('video');
    this.buildTools();
  }

  private videoHost(): VideoHost {
    return {
      g: this.g,
      pipe: this.pipe,
      canvas: this.canvas,
      state: () => this.state,
      commit: () => this.commit(),
      requestRender: () => this.requestRender(),
      renderSync: () => {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.renderVer++;
        this.renderNow();
      },
      syncScale: () => this.syncRenderScale(),
      frameChanged: (src, target, resized) => {
        if (!this.img || resized) {
          if (this.img) this.g.destroy(this.img.thumbT);
          const kt = Math.min(1, 200 / Math.max(src.w, src.h));
          const thumbT = this.pipe.resize(src, Math.round(src.w * kt), Math.round(src.h * kt));
          this.img = {
            full: src, preview: src, thumb: { tex: thumbT.tex, w: thumbT.w, h: thumbT.h, linear: false },
            previewT: target, thumbT, name: 'Video', info: this.video?.info ?? 'Video',
          };
          this.thumbsKey = '';
          this.analysisCache = null;
        }
        this.pipe.invalidate();
        if (resized) {
          this.syncAtlasSize();
          requestAnimationFrame(() => this.layout());
        }
        this.requestRender();
      },
      toast: (m, ms) => this.toast(m, ms),
      busy: (m) => this.busy(m),
      refreshSection: () => this.refreshSection(),
      openTool: (id) => {
        const t = id ? this.toolList().find((x) => x.id === id) ?? null : null;
        if (t !== this.tool) this.setMode(t);
        else this.refreshSection();
      },
      toolId: () => this.tool?.id ?? null,
      chip: (row, c, on, onClick) => this.chip(row, c, on, onClick),
      tile: (row, icon, label, cls, onClick) => this.tile(row, icon, label, cls, onClick),
      renderFull: (src, w, h) => {
        this.syncOverlay(this.state);
        this.pipe.brushTex = this.atlas.tex;
        this.pipe.invalidate();
        this.pipe.render(src, this.state, w, h, null);
      },
      save: async (blob, name) => {
        const how = await saveOrShare(blob, name, (f) => this.busy(`Saving ${Math.round(f * 100)}%`));
        if (how === 'shown') this.toast('Exported (downloads are blocked in this preview)', 3000);
        else if (how === 'gallery') this.toast('Saved to your gallery · Movies/Lumen', 2600);
        else if (how === 'shared') this.toast('Shared');
        else this.toast(`Saved · Downloads/${name}`, 3000);
      },
    };
  }

  /** Looks thumbnails in a video come from the frame on screen. */
  private refreshVideoThumb() {
    if (!this.video || !this.img) return;
    this.g.destroy(this.img.thumbT);
    const src = this.img.preview;
    const kt = Math.min(1, 200 / Math.max(src.w, src.h));
    const thumbT = this.pipe.resize(src, Math.round(src.w * kt), Math.round(src.h * kt));
    this.img.thumbT = thumbT;
    this.img.thumb = { tex: thumbT.tex, w: thumbT.w, h: thumbT.h, linear: false };
    this.thumbsKey = '';
  }

  private toolList(): ToolDef[] {
    return this.video ? [...this.video.tools, ...TOOLS.filter((t) => !VIDEO_HIDDEN.has(t.id))] : TOOLS;
  }

  pickPhoto() {
    const input = $<HTMLInputElement>('file');
    input.value = '';
    input.click();
  }

  async takePhoto() {
    if (isNative) {
      try {
        const r = await Native.captureRaw();
        this.busy('Loading RAW');
        const f = await fileFromPath(r.path, r.name, 'image/x-adobe-dng');
        await this.open(f);
        if (r.savedToGallery) this.toast('RAW saved to Pictures/Lumen · editing it now', 2600);
      } catch (e) {
        const m = (e as Error).message;
        if (m && m !== 'cancelled') this.toast(m, 4000);
        this.busy(null);
      }
      return;
    }
    if (!this.camera.supported) return this.toast('This browser has no camera access');
    this.camera.open((f) => this.open(f));
  }

  /** The home screen (logo + open / take photo). Over an open photo it's a page you can go back from. */
  private homeOver = false;
  /** opened with the home button (back returns to the photo) rather than by going back */
  private homeFromButton = false;
  private showHome(on: boolean, fromButton = false) {
    const el = $('empty');
    if (!this.img) return;
    if (on === this.homeOver) return;
    this.homeOver = on;
    this.homeFromButton = on && fromButton;
    const resume = $<HTMLButtonElement>('btnResume');
    if (on) {
      this.setMode(null);
      el.classList.remove('hidden');
      el.classList.add('over', 'ready');
      resume.hidden = false;
      resume.textContent = this.video ? 'Back to video' : 'Back to photo';
      if (this.video?.player.playing) this.video.togglePlay();
      resume.onclick = () => this.showHome(false);
    } else {
      el.classList.remove('over');
      el.classList.add('hidden');
      resume.hidden = true;
    }
    this.syncGuard();
  }

  /**
   * Hold for the original. The original is rendered once (it only depends on the photo and
   * its geometry) into its own canvas over the edit, so holding and letting go are instant:
   * the edit itself is never re-rendered. Deep zoom keeps the old path.
   */
  private cmpOn = false;
  private origKey = '';
  private origTimer = 0;
  private setCompare(on: boolean) {
    if (!this.img || (this.compare || this.cmpOn) === on) return;
    $('badge').textContent = 'ORIGINAL';
    $('badge').classList.toggle('on', on);
    const orig = $('orig');
    if (!on) {
      orig.classList.remove('on');
      if (this.cmpOn) {
        this.cmpOn = false;
        return;
      }
      this.compare = false;
      this.requestRender();
      return;
    }
    if (!this.zv.on && this.kind() !== 'crop' && !this.video && this.prepareOrig()) {
      this.cmpOn = true;
      orig.classList.add('on');
      return;
    }
    this.compare = true;
    this.requestRender();
  }

  /** What the original looks like at the current on-screen size (geometry only). */
  private origState(): EditState {
    const s = this.state;
    return { v: { ...defaultValues(), straighten: s.v.straighten }, curves: defaultState().curves, geo: s.geo, masks: [], spots: [], overlay: null, leak: null, fills: [] };
  }
  private prepareOrig() {
    if (!this.img) return false;
    const w = this.canvas.width, h = this.canvas.height;
    const key = JSON.stringify([this.img.name, this.img.preview.w, this.state.geo, this.state.v.straighten, w, h]);
    if (key === this.origKey) return true;
    try {
      const px = this.pipe.renderPixels(this.img.preview, this.origState(), w, h);
      const c = $<HTMLCanvasElement>('orig');
      c.width = w;
      c.height = h;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
      this.origKey = key;
      return true;
    } catch (e) {
      console.warn('original render failed', e);
      return false;
    }
  }
  /** Get the original ready in a quiet moment, so the first hold is instant too. */
  private scheduleOrig() {
    clearTimeout(this.origTimer);
    this.origTimer = window.setTimeout(() => {
      if (!this.img || this.cmpOn || this.kind() === 'crop') return;
      const run = () => this.prepareOrig();
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
      else run();
    }, 900);
  }

  private updateChrome() {
    const has = !!this.img;
    this.appEl.classList.toggle('noimg', !has);
    ($('btnUndo') as HTMLButtonElement).disabled = !has || this.hIdx <= 0;
    ($('btnRedo') as HTMLButtonElement).disabled = !has || this.hIdx >= this.history.length - 1;
    ($('btnHistory') as HTMLButtonElement).disabled = !has || this.history.length < 2;
    ($('btnExport') as HTMLButtonElement).disabled = !has;
    $('tools').classList.toggle('disabled', !has);
    document.querySelectorAll<HTMLButtonElement>('#tools button').forEach((b) => {
      const t = this.toolList().find((x) => x.id === b.dataset.id);
      if (t) b.classList.toggle('mod', this.toolModified(t));
    });
  }

  private buildTools() {
    const nav = $('tools');
    nav.innerHTML = '';
    for (const t of this.toolList()) {
      const b = document.createElement('button');
      b.dataset.id = t.id;
      b.innerHTML = `${t.icon}<span>${t.label}</span>`;
      b.onclick = () => {
        tick();
        this.setMode(t);
      };
      nav.appendChild(b);
    }
    this.buildAll();
    this.bindDockSwipe();
  }

  // ---- all tools: a grid you swipe up from the tool bar

  private allOpen = false;
  private allTab = 'all';
  private buildAll() {
    const tabs = $('allTabs');
    const grid = $('allGrid');
    const groups: Record<string, string[]> = {
      all: this.toolList().map((t) => t.id),
      ...(this.video ? { video: this.video.tools.map((t) => t.id) } : {}),
      tone: ['light', 'color', 'curves', 'hsl', 'grade', 'bw'],
      fix: ['heal', 'crop', 'detail', 'masks'],
      style: ['looks', 'double', 'leak', 'blur', 'grain', 'halation', 'glow', 'vignette', 'film'],
    };
    tabs.innerHTML = '';
    for (const k of Object.keys(groups)) {
      const b = document.createElement('button');
      b.textContent = k;
      b.classList.toggle('on', k === this.allTab);
      b.onclick = () => {
        tick();
        this.allTab = k;
        this.buildAll();
      };
      tabs.appendChild(b);
    }
    grid.innerHTML = '';
    groups[this.allTab].forEach((id, i) => {
      const t = this.toolList().find((x) => x.id === id);
      if (!t) return;
      const b = document.createElement('button');
      b.innerHTML = `${t.icon}<span>${t.label}</span>`;
      b.style.setProperty('--i', String(i));
      b.classList.toggle('mod', !!this.img && this.toolModified(t));
      b.onclick = () => {
        tick();
        this.showAll(false);
        this.setMode(t);
      };
      grid.appendChild(b);
    });
  }

  private showAll(on: boolean) {
    if (on === this.allOpen || (on && !this.img)) return;
    this.allOpen = on;
    if (on) this.buildAll();
    $('allTools').classList.toggle('on', on);
    this.syncGuard();
  }

  /** Swipe up on the tool bar (or tap the handle) to see every tool at once. */
  private bindDockSwipe() {
    const dock = $('dock');
    let start: { x: number; y: number; id: number } | null = null;
    dock.addEventListener('pointerdown', (e) => {
      start = this.tool ? null : { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    dock.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (dy < -34 && Math.abs(dy) > Math.abs(dx) * 1.2) {
        start = null;
        tick(true);
        this.showAll(true);
      }
    });
    const end = () => (start = null);
    dock.addEventListener('pointerup', end);
    dock.addEventListener('pointercancel', end);
    $('grab').onclick = () => {
      tick();
      this.showAll(true);
    };
    $('allClose').onclick = () => {
      tick();
      this.showAll(false);
    };
    // swipe down anywhere on the grid page to put it away
    const all = $('allTools');
    let down: { y: number; id: number } | null = null;
    all.addEventListener('pointerdown', (e) => (down = { y: e.clientY, id: e.pointerId }));
    all.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const dy = e.clientY - down.y;
      if (dy > 0) (all.querySelector('.all-grid') as HTMLElement).style.transform = `translateY(${dy * 0.5}px)`;
      if (dy > 70) {
        down = null;
        tick();
        this.showAll(false);
      }
    });
    const reset = () => {
      down = null;
      (all.querySelector('.all-grid') as HTMLElement).style.transform = '';
    };
    all.addEventListener('pointerup', reset);
    all.addEventListener('pointercancel', reset);
  }

  /** Open a section (focused controls) or go back to the tool bar (null). */
  private setMode(t: ToolDef | null) {
    const prev = this.tool;
    if (prev?.kind === 'looks' && t?.kind !== 'looks') {
      this.look.base = null;
      this.look.idx = -1;
    }
    if (prev && !t) this.commit();
    queueMicrotask(() => this.syncGuard());
    if (t && !prev) this.sectionStart = JSON.stringify(this.state);
    this.tool = t;
    this.showMenu(false);
    this.loupe.hide();
    this.appEl.dataset.mode = t ? 'section' : 'tools';
    if (t && t !== prev) {
      this.paramIdx[t.id] = 0; // every section starts on its first adjustment
      // rows slide in once when a section opens (not on every rebuild)
      const sec = $('section');
      sec.classList.remove('enter');
      void sec.offsetWidth;
      sec.classList.add('enter');
      setTimeout(() => sec.classList.remove('enter'), 420);
    }
    $('title').textContent = t ? t.label : this.video ? this.video.info : this.img?.info ?? '';
    if (t?.kind === 'video' && t !== prev) this.video?.onOpenTool(t.id);
    if (t?.kind === 'looks' && this.video) this.refreshVideoThumb();
    if (prev?.kind === 'crop' || t?.kind === 'crop') this.zoom = { s: 1, x: 0, y: 0 };
    if (t?.kind === 'curves' && !this.sub.curves) this.sub.curves = 'rgb';
    this.curve.channel = (this.sub.curves ?? 'rgb') as keyof Curves;
    this.curve.show(t?.kind === 'curves' && !!this.img);
    this.crop.show(t?.kind === 'crop' && !!this.img);
    this.maskOv.show(t?.kind === 'masks' && !!this.img);
    this.blurOv.show(t?.kind === 'blur' && !!this.img);
    this.vigOv.show(t?.id === 'vignette' && !!this.img);
    if (t?.kind !== 'heal') this.spotSel = -1;
    this.healOv.show(t?.kind === 'heal' && !!this.img);
    if (t?.kind === 'masks' && this.maskSel < 0 && this.state.masks.length) this.maskSel = 0;
    this.refreshSection();
    // wait for the dock to settle, then refit the photo smoothly
    requestAnimationFrame(() => this.layout(true));
    this.requestRender();
    if (t?.kind === 'masks' && !this.state.masks.length && this.img) setTimeout(() => this.openMaskSheet(), 180);
    if (t?.kind === 'double' && this.img && !this.state.overlay) setTimeout(() => this.pickOverlay(), 200);
    if (t?.kind === 'leak' && this.img && !this.state.leak) this.setLeak(LEAKS[0].id);
    if (t?.kind === 'double' || t?.kind === 'leak') this.dxMode = 'move';
    this.layerOv.show((t?.kind === 'double' || t?.kind === 'leak') && !!this.img);
    if (t?.kind === 'heal' && this.img) this.toast('Paint over what to remove · let go to fix it', 2600);
  }

  private refreshSection() {
    if (!this.tool) {
      this.updateChrome();
      return;
    }
    this.buildSubs();
    this.buildActs();
    this.updateSecBar();
    if (this.kind() === 'crop') this.crop.update();
    if (this.kind() === 'curves') this.curve.draw();
    this.redrawOverlays();
  }

  private updateSecBar() {
    const t = this.tool;
    this.updateChrome();
    if (!t) return;
    $('secReset').classList.toggle('gone', t.kind === 'video' || !this.toolModified(t));
    const id = this.currentParam();
    $('pill').classList.toggle('gone', !id);
    $('slider').classList.toggle('gone', !id);
    if (id) this.showHud(id);
  }

  // ---- section rows

  private chip(row: HTMLElement, c: Chip, on: boolean, onClick: () => void) {
    const b = document.createElement('button');
    b.className = 'chip' + (on ? ' on' : '');
    b.innerHTML = (c.icon ?? '') + `<span>${escapeHtml(c.label)}</span>`;
    b.onclick = () => {
      tick();
      onClick();
    };
    row.appendChild(b);
    return b;
  }

  private tile(row: HTMLElement, icon: string, label: string, cls: string, onClick: () => void) {
    const b = document.createElement('button');
    b.className = 'tile ' + cls;
    b.innerHTML = `<span class="b">${icon}</span><small>${escapeHtml(label)}</small>`;
    b.onclick = () => {
      tick();
      onClick();
    };
    row.appendChild(b);
    return b;
  }

  private buildSubs() {
    const row = $('subs');
    row.innerHTML = '';
    const t = this.tool!;
    if (t.kind === 'video') return this.video?.buildSubs(t, row);
    if (t.kind === 'looks') return this.buildLooks();
    if (t.kind === 'masks') return this.buildMaskList();
    if (t.kind === 'leak') return this.buildLeaks();
    if (!t.subs) return;
    if (t.kind === 'double' && !this.state.overlay) return;
    const cur = t.kind === 'crop' ? this.aspectId : t.kind === 'blur' ? String(Math.round(this.state.v.blurType))
      : t.kind === 'double' ? String(Math.round(this.state.v.dxBlend)) : this.sub[t.id] ?? t.subs[0].id;
    for (const s of t.subs) {
      const on = s.id === cur;
      if (s.color) {
        // color dots (HSL bands, curve channels)
        const b = document.createElement('button');
        const mod = t.kind === 'params' && this.isModified(t.params(s.id));
        b.className = 'dotchip' + (on ? ' on' : '') + (mod ? ' mod' : '');
        b.setAttribute('aria-label', s.label);
        b.innerHTML = `<i style="background:${s.color}"></i>`;
        b.onclick = () => {
          tick();
          this.pickSub(s.id);
        };
        row.appendChild(b);
      } else {
        this.chip(row, s, on, () => this.pickSub(s.id));
      }
    }
  }

  private pickSub(id: string) {
    const t = this.tool!;
    if (t.kind === 'crop') this.setAspect(id);
    else if (t.kind === 'double') {
      this.state.v.dxBlend = +id;
      this.commit();
      this.requestRender();
    } else if (t.kind === 'blur') {
      const v = this.state.v;
      if (v.blurType === 0 && id !== '0') {
        v.blurX = 0.5;
        v.blurY = 0.5;
      }
      v.blurType = +id;
      this.paramIdx.blur = 0;
      this.commit();
      this.requestRender();
      if (id !== '0') this.toast('Drag the orange dot to place the focus', 2400);
    } else {
      this.sub[t.id] = id;
      if (t.kind === 'heal') {
        if (id === 'fill') this.askFillModel();
        this.spotSel = -1;
        this.toast(id === 'fill' ? 'Paint over the object · let go and the AI rebuilds what’s behind it' : 'Paint over a blemish · drag the yellow copy to pick the source', 3000);
        this.healOv.draw();
      }
      if (t.kind === 'curves') {
        this.curve.channel = id as keyof Curves;
        this.curve.draw();
      }
    }
    this.refreshSection();
  }

  private buildActs() {
    const row = $('acts');
    row.innerHTML = '';
    const t = this.tool!;
    if (t.kind === 'video') return this.video?.buildActs(t, row);
    if (t.kind === 'masks') return this.buildMaskActs();
    if (t.kind === 'heal') return this.buildHealActs();
    if (t.kind === 'double') return this.buildLayerActs('dx');
    if (t.kind === 'leak') return this.buildLayerActs('lk');
    for (const a of t.actions ?? []) {
      if (a.icon) this.tile(row, a.icon, a.label, '', () => this.action(a.id));
      else this.chip(row, a, false, () => this.action(a.id));
    }
  }

  // -----------------------------------------------------------------------------------
  // HUD + menu

  /** The readout at the bottom of a section: name + value, and the full-width slider above it. */
  private showHud(id: string) {
    const d = this.def(id);
    if (!d) return;
    $('paramName').textContent = d.label;
    $('paramValue').textContent = this.fmt(id);
    const pos = (x: number) => ((x - d.min) / (d.max - d.min)) * 100;
    const z = pos(d.def), p = pos(this.get(id));
    const sl = $('slider');
    const fill = sl.querySelector('.fill') as HTMLElement;
    fill.style.left = Math.min(z, p) + '%';
    fill.style.width = Math.abs(p - z) + '%';
    (sl.querySelector('.thumb') as HTMLElement).style.left = p + '%';
    sl.classList.toggle('hue', !!d.hue);
    sl.classList.toggle('at-def', Math.abs(this.get(id) - d.def) < 1e-6);
  }

  // ---- value dragging, shared by the photo swipe and the slider. Default values have a
  // small detent: the value sticks there for a bit of travel, so it's easy to land on 0.

  private vd: { id: string; raw: number } | null = null;
  private snapW(d: ParamDef) {
    return d.hue ? 0 : (d.max - d.min) * 0.035;
  }
  private toRaw(d: ParamDef, v: number) {
    const w = this.snapW(d);
    if (!w || Math.abs(v - d.def) < 1e-9) return v;
    return v > d.def ? v + w : v - w;
  }
  private fromRaw(d: ParamDef, r: number) {
    const w = this.snapW(d);
    if (!w) return r;
    if (Math.abs(r - d.def) <= w) return d.def;
    return r > d.def ? r - w : r + w;
  }
  private beginValue(id: string) {
    this.vd = { id, raw: this.toRaw(this.def(id), this.get(id)) };
  }
  /** Move the value being dragged by `delta` units (before the detent). */
  private moveValue(delta: number) {
    const vd = this.vd;
    if (!vd) return;
    const d = this.def(vd.id);
    const span = d.max - d.min;
    const w = this.snapW(d);
    const before = this.get(vd.id);
    vd.raw += delta;
    let v: number;
    if (d.hue) {
      vd.raw = ((vd.raw % 360) + 360) % 360;
      v = vd.raw;
    } else {
      vd.raw = Math.min(d.max + w, Math.max(d.min - w, vd.raw));
      v = Math.min(d.max, Math.max(d.min, this.fromRaw(d, vd.raw)));
    }
    if (v === before) return;
    this.set(vd.id, v);
    // haptics: 50 notches across the range; a firm click when landing on the default or an end
    const notch = (x: number) => Math.floor((x - d.min) / (span / 50));
    const landed = v === d.def || (before - d.def) * (v - d.def) < 0;
    const hitEnd = v === d.min || v === d.max;
    if (landed || hitEnd) tick(true);
    else if (notch(v) !== notch(before)) tick();
    this.showHud(vd.id);
    if (this.kind() === 'blur') this.blurOv.draw();
    this.showSizeRing(vd.id);
  }

  /** While a brush size changes, show the brush at that size in the middle of the photo. */
  private sizeTimer = 0;
  private showSizeRing(id: string) {
    const k = this.maskOv.pxPerFrameH();
    const lay = id.slice(0, 2) as 'dx' | 'lk';
    const px = id === 'healSize' ? this.healPx()
      : id === 'mg.size' || id === 'mg.hard' || id === 'mg.flow' ? this.brushRadius() * k
      : /^(dx|lk)(Brush|Hard)$/.test(id) ? this.layerRadius(lay) * k : 0;
    if (!px) return;
    const ring = $('brushRing');
    // the inside shows how hard the edge is (and how strong each pass is)
    const hard = id.startsWith('mg.') ? (this.selMask()?.g.hard ?? 25) / 100 : id === 'healSize' ? 0.6 : (this.state.v[lay + 'Hard'] ?? 35) / 100;
    const flow = id.startsWith('mg.') ? (this.selMask()?.g.flow ?? 70) / 100 : 0.8;
    const a = (0.2 + flow * 0.45).toFixed(2);
    ring.style.background = `radial-gradient(closest-side, rgba(255,200,61,${a}) ${Math.round(Math.min(0.95, hard) * 100)}%, rgba(255,200,61,0) 100%)`;
    const st = this.stage.getBoundingClientRect();
    const cy = (this.region().top + st.height - this.region().bot) / 2;
    ring.style.width = ring.style.height = px * 2 + 'px';
    ring.style.transform = `translate(${st.width / 2 - px}px, ${cy - px}px)`;
    ring.classList.remove('erase');
    ring.classList.add('on', 'size');
    clearTimeout(this.sizeTimer);
    this.sizeTimer = window.setTimeout(() => {
      ring.classList.remove('on', 'size');
      ring.style.background = '';
    }, 650);
  }
  private endValue() {
    if (!this.vd) return;
    this.vd = null;
    this.commit();
    this.refreshSection();
  }

  /** The slider: drag anywhere on it (1:1 with the track), double-tap to reset. */
  private bindSlider() {
    const sl = $('slider');
    let lastX = 0, downT = 0, downX = 0, lastTap = 0, moved = false;
    sl.addEventListener('pointerdown', (e) => {
      const id = this.currentParam();
      if (!id) return;
      sl.setPointerCapture(e.pointerId);
      lastX = downX = e.clientX;
      downT = e.timeStamp;
      moved = false;
      sl.classList.add('active');
      this.beginValue(id);
    });
    sl.addEventListener('pointermove', (e) => {
      if (!this.vd || !sl.hasPointerCapture(e.pointerId)) return;
      if (Math.abs(e.clientX - downX) > 3) moved = true;
      const d = this.def(this.vd.id);
      const track = sl.querySelector('.track') as HTMLElement;
      this.moveValue(((e.clientX - lastX) / Math.max(1, track.clientWidth)) * (d.max - d.min));
      lastX = e.clientX;
    });
    const up = (e: PointerEvent) => {
      if (!this.vd) return;
      sl.classList.remove('active');
      const id = this.vd.id;
      if (!moved && e.timeStamp - downT < 250) {
        if (e.timeStamp - lastTap < 320) {
          // double tap: back to the default
          this.set(id, this.def(id).def);
          tick(true);
          lastTap = 0;
        } else lastTap = e.timeStamp;
      }
      this.endValue();
    };
    sl.addEventListener('pointerup', up);
    sl.addEventListener('pointercancel', up);
  }

  private hideHudSoon(_ms = 0) {
    /* the readout stays put */
  }

  private menuTap = false;
  private showMenu(on: boolean, tapMode = false) {
    const menu = $('menu');
    const ps = this.params();
    if (!on || ps.length < 2 || !this.tool) {
      menu.classList.remove('on');
      this.menuTap = false;
      return;
    }
    this.menuTap = tapMode;
    const items = menu.querySelector('.items') as HTMLElement;
    items.innerHTML = '';
    const cur = Math.min(ps.length - 1, this.paramIdx[this.pkey()] ?? 0);
    ps.forEach((id, i) => {
      const b = document.createElement('button');
      const d = this.def(id);
      const changed = id !== 'lookAmt' && Math.abs(this.get(id) - d.def) > 1e-6;
      b.className = 'it' + (i === cur ? ' sel' : '') + (changed ? ' changed' : '') + (id.startsWith('mg.') ? ' maskset' : '');
      b.dataset.i = String(i);
      b.innerHTML = `<span>${d.label}</span><span class="v">${this.fmt(id)}</span>`;
      b.onpointerup = (e) => {
        if (!this.menuTap) return;
        e.stopPropagation();
        this.paramIdx[this.pkey()] = i;
        tick();
        this.showMenu(false);
        this.updateSecBar();
        this.showHud(id);
        this.hideHudSoon();
      };
      items.appendChild(b);
    });
    menu.style.pointerEvents = tapMode ? 'auto' : 'none';
    menu.classList.add('on');
    this.highlightMenu(cur, true);
  }
  /** The list behaves like a picker wheel: the chosen row snaps to the middle. */
  private highlightMenu(i: number, instant = false) {
    const menu = $('menu');
    const items = menu.querySelector('.items') as HTMLElement;
    let target: HTMLElement | null = null;
    menu.querySelectorAll<HTMLElement>('.it').forEach((el) => {
      const k = Number(el.dataset.i);
      el.classList.toggle('sel', k === i);
      const d = Math.abs(k - i);
      el.style.opacity = String(Math.max(0.12, 1 - d * 0.3));
      el.style.transform = `scale(${Math.max(0.84, 1 - d * 0.06)})`;
      if (k === i) target = el;
    });
    if (!target) return;
    const t = target as HTMLElement;
    const ty = menu.clientHeight / 2 - (t.offsetTop + t.offsetHeight / 2);
    items.style.transition = instant ? 'none' : '';
    items.style.transform = `translateY(${ty}px)`;
    if (!instant) {
      t.classList.remove('bump');
      void t.offsetWidth;
      t.classList.add('bump');
    }
  }

  /** Tap the value to type an exact number. */
  private bindValueInput() {
    const btn = $<HTMLButtonElement>('paramValue');
    const input = $<HTMLInputElement>('paramInput');
    btn.onclick = () => {
      const id = this.currentParam();
      if (!id) return;
      const d = this.def(id);
      const v = this.get(id);
      input.value = String(Math.abs(d.max - d.min) <= 10 ? Math.round(v * 100) / 100 : Math.round(v));
      btn.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    };
    const done = (apply: boolean) => {
      if (input.hidden) return;
      const id = this.currentParam();
      const n = parseFloat(input.value.replace(',', '.').replace('°', ''));
      input.hidden = true;
      btn.hidden = false;
      if (apply && id && Number.isFinite(n)) {
        this.set(id, n);
        this.commit();
        this.refreshSection();
      }
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    };
    input.onblur = () => done(true);
  }

  // -----------------------------------------------------------------------------------
  // Gestures on the photo
  //   swipe ↔ change the adjustment (with haptic ticks)   swipe ↕ choose the adjustment
  //   tap: hide/show controls   double tap: reset adjustment   hold: original   pinch: zoom

  private bindGestures() {
    const st = this.stage;
    const pts = new Map<number, { x: number; y: number }>();
    type Mode = 'none' | 'pending' | 'value' | 'menu' | 'pinch' | 'crop' | 'compare' | 'mask' | 'paint' | 'pick' | 'blur' | 'pan' | 'heal' | 'ai' | 'dx' | 'vig' | 'shape' | 'lshape' | 'vtext';
    let mode: Mode = 'none';
    let sx = 0, sy = 0, startIdx = 0, lastStep = 0;
    let lastX = 0, lastT = 0;
    let pinch0 = { d: 1, mx: 0, my: 0, s: 1, x: 0, y: 0 };
    let pan0 = { x: 0, y: 0 };
    let anchorY = 0;
    let holdTimer = 0, tapTimer = 0;
    let armed = false;
    let lastTap = { t: 0, x: 0, y: 0 };

    const stageXY = (cx: number, cy: number) => {
      const r = st.getBoundingClientRect();
      return { x: cx - r.left, y: cy - r.top };
    };

    st.addEventListener('pointerdown', (e) => {
      if (!this.img) return;
      if ((e.target as HTMLElement).closest('button')) return; // e.g. the zoom badge
      if (this.menuTap) {
        if (!(e.target as HTMLElement).closest('#menu')) this.showMenu(false);
        return;
      }
      st.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && this.kind() !== 'crop') {
        clearTimeout(holdTimer);
        clearTimeout(tapTimer);
        if (mode === 'value' || mode === 'menu') this.finishSwipe(mode);
        if (mode === 'paint') this.cancelStroke();
        if (mode === 'ai') {
          this.aiStroke = null;
          this.hideBrushRing();
        }
        if (mode === 'dx') this.layerUp();
        if (mode === 'mask') this.maskOv.cancel();
        if (mode === 'pick') this.endPick(false);
        if (mode === 'heal') this.healCancel();
        this.hideBrushRing();
        this.setCompare(false);
        if (mode === 'vig') this.vigOv.end();
        if (mode === 'blur') this.blurOv.end();
        const [a, b] = [...pts.values()];
        const m = stageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y, ...this.zoom };
        // in Blur and Vignette two fingers shape the effect (pinch = size, twist = angle)
        const v = this.state.v;
        if ((this.kind() === 'blur' && v.blurType > 0) || this.tool?.id === 'vignette') {
          this.shape0 = {
            d: pinch0.d, a: Math.atan2(b.y - a.y, b.x - a.x), size: v.blurSize, angle: v.blurAngle, mid: v.vigMidpoint,
            sx: Math.abs(b.x - a.x), sy: Math.abs(b.y - a.y),
          };
          mode = 'shape';
          return;
        }
        // double exposure / light leak in Move: two fingers place the layer (pinch = size, twist = angle)
        const lk = this.layerKey();
        if (lk && this.layerOf(lk) && this.dxMode === 'move') {
          const L = this.state.v;
          const mf = this.maskOv.toFrame((a.x + b.x) / 2, (a.y + b.y) / 2);
          this.lshape0 = { d: pinch0.d, a: Math.atan2(b.y - a.y, b.x - a.x), scale: L[lk + 'Scale'], rot: L[lk + 'Rot'], x: L[lk + 'X'], y: L[lk + 'Y'], mf: { x: mf.x, y: mf.y } };
          mode = 'lshape';
          return;
        }
        mode = 'pinch';
        return;
      }
      if (pts.size > 1) return;
      sx = e.clientX;
      sy = e.clientY;
      const k = this.kind();
      if (k === 'crop' && this.cropGrab(e)) {
        mode = 'crop';
        return;
      }
      if (this.tool?.id === 'vignette' && this.vigOv.start(e)) {
        mode = 'vig';
        tick();
        return;
      }
      if (k === 'blur' && this.blurOv.start(e)) {
        mode = 'blur';
        tick();
        return;
      }
      if (k === 'heal') {
        mode = 'heal';
        this.healDown(e);
        return;
      }
      if (this.video?.stageDown(e, this.frame.getBoundingClientRect())) {
        mode = 'vtext';
        return;
      }
      if ((k === 'double' || k === 'leak') && this.layerOf(this.layerKey()!)) {
        mode = 'dx';
        this.layerDown(e);
        return;
      }
      if (k === 'masks') {
        const m = this.selMask();
        if (m && this.maskOv.start(e)) {
          mode = 'mask';
          this.maskInteracting = true;
          tick();
          this.requestRender();
          return;
        }
        if (m && m.type === 'subject' && (this.brushMode === 'aiAdd' || this.brushMode === 'aiSub')) {
          mode = 'ai';
          this.startAiStroke(e);
          return;
        }
        if (m && (m.type === 'brush' || m.type === 'subject') && (this.brushMode === 'paint' || this.brushMode === 'erase')) {
          mode = 'paint';
          this.startStroke(e);
          return;
        }
        if (m && (m.type === 'luma' || m.type === 'color') && this.pickMode === 'pick') {
          mode = 'pick';
          this.pickAt(e);
          return;
        }
      }
      mode = 'pending';
      armed = false;
      clearTimeout(holdTimer);
      const toCompare = () => {
        if (mode === 'pending') {
          mode = 'compare';
          this.setCompare(true);
          tick(true);
        }
      };
      if (this.zoom.s > 1.01 && this.currentParam()) {
        // zoomed in, a drag pans; hold a moment first (a tick) and the drag adjusts instead.
        // keep holding still and it shows the original as usual
        holdTimer = window.setTimeout(() => {
          if (mode !== 'pending') return;
          armed = true;
          tick();
          $('pill').classList.add('armed');
          // a good while longer before the original shows, so there's time to start the swipe
          holdTimer = window.setTimeout(toCompare, 1000);
        }, 230);
      } else holdTimer = window.setTimeout(toCompare, 380);
    });

    st.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const m = stageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
        const s = Math.min(this.maxZoom(), Math.max(1, (pinch0.s * d) / pinch0.d));
        const V = this.view;
        const E0 = V.base * pinch0.s, E1 = V.base * s;
        const px = (pinch0.mx - V.cx - pinch0.x) / E0;
        const py = (pinch0.my - V.cy - pinch0.y) / E0;
        this.zoom = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: m.x - V.cx - px * E1, y: m.y - V.cy - py * E1 };
        this.applyZoom();
        return;
      }
      if (mode === 'shape' && pts.size >= 2 && this.shape0) {
        const [a, b] = [...pts.values()];
        const S = this.shape0, v = this.state.v;
        const ratio = Math.hypot(a.x - b.x, a.y - b.y) / S.d;
        if (this.kind() === 'blur') {
          v.blurSize = clampParam('blurSize', S.size * ratio);
          if (v.blurType === 1) v.blurAngle = wrap90(S.angle + ((Math.atan2(b.y - a.y, b.x - a.x) - S.a) * 180) / Math.PI);
          this.blurOv.draw();
        } else {
          const start = (0.25 + (S.mid / 100) * 0.9) * ratio;
          v.vigMidpoint = clampParam('vigMidpoint', ((start - 0.25) / 0.9) * 100);
          this.vigOv.draw();
        }
        this.requestRender();
        const id = this.currentParam();
        if (id) this.showHud(id);
        return;
      }
      if (mode === 'vig') return this.vigOv.moveTo(e);
      if (mode === 'crop') return this.crop.move(e);
      if (mode === 'blur') return this.blurOv.moveTo(e);
      if (mode === 'mask') {
        this.maskOv.move(e);
        const m = this.selMask();
        if (m && m.type === 'radial' && m.g.smart > 0) {
          // selective point: show what's under the center while dragging
          this.updateSmartRef(m);
          this.loupe.color = rgbCss([m.g.sr, m.g.sg, m.g.sb]);
          this.loupe.show(e.clientX, e.clientY);
        }
        return;
      }
      if (mode === 'paint') return this.continueStroke(e);
      if (mode === 'ai') return this.continueAiStroke(e);
      if (mode === 'dx') return this.layerMove(e);
      if (mode === 'lshape' && pts.size >= 2 && this.lshape0) return this.layerPinch(pts);
      if (mode === 'pick') return this.pickAt(e);
      if (mode === 'heal') return this.healMove(e);
      if (mode === 'vtext') return this.video?.stageMove(e, this.frame.getBoundingClientRect());
      if (mode === 'pan') {
        this.zoom = { ...this.zoom, x: pan0.x + e.clientX - sx, y: pan0.y + e.clientY - sy };
        this.applyZoom();
        return;
      }
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (mode === 'pending' && Math.hypot(dx, dy) > 8) {
        clearTimeout(holdTimer);
        $('pill').classList.remove('armed');
        if (this.zoom.s > 1.01 && !armed) {
          // zoomed in: one finger pans
          mode = 'pan';
          pan0 = { x: this.zoom.x, y: this.zoom.y };
          return;
        }
        const id = this.currentParam();
        if (!id) {
          mode = 'none';
          return;
        }
        if (Math.abs(dx) >= Math.abs(dy)) {
          mode = 'value';
          this.beginValue(id);
          lastX = sx;
          lastT = e.timeStamp;
          if (this.kind() === 'crop') this.crop.setGrid(true);
          if (this.kind() === 'blur') this.blurOv.guides = true;
        } else if (this.params().length > 1) {
          mode = 'menu';
          startIdx = this.paramIdx[this.pkey()] ?? 0;
          lastStep = startIdx;
          anchorY = e.clientY;
          this.showMenu(true);
        } else mode = 'none';
      }
      if (mode === 'value') {
        const d = this.def(this.vd?.id ?? this.currentParam()!);
        const range = (d.swipe ?? d.max - d.min) * 1.15;
        const ddx = e.clientX - lastX;
        const speed = Math.abs(ddx) / Math.max(1, e.timeStamp - lastT);
        const fine = speed < 0.06 ? 0.6 : 1;
        lastX = e.clientX;
        lastT = e.timeStamp;
        this.moveValue((ddx / st.clientWidth) * range * fine);
      } else if (mode === 'menu') {
        const n = this.params().length;
        // detents: every 42px of travel moves exactly one row (at most one per event),
        // measured from where the list opened; swiping up moves down the list
        const STEP = 42;
        let d = anchorY - e.clientY;
        let i = lastStep;
        if (d >= STEP && i < n - 1) {
          i++;
          anchorY -= STEP;
        } else if (d <= -STEP && i > 0) {
          i--;
          anchorY += STEP;
        }
        // at either end, re-anchor so reversing responds straight away
        d = anchorY - e.clientY;
        if ((i === n - 1 && d > 0) || (i === 0 && d < 0)) anchorY = e.clientY;
        if (i !== lastStep) {
          lastStep = i;
          tick(true);
          this.paramIdx[this.pkey()] = i;
          this.highlightMenu(i);
          this.showHud(this.currentParam()!);
        }
      }
    });

    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      clearTimeout(holdTimer);
      $('pill').classList.remove('armed');
      if (armed && mode === 'pending') mode = 'none'; // a hold that never moved isn't a tap
      armed = false;
      if (mode === 'pinch') {
        if (pts.size === 0) mode = 'none';
        return;
      }
      if (mode === 'lshape') {
        if (pts.size === 0) {
          mode = 'none';
          this.lshape0 = null;
          tick();
          this.commitAndRefresh();
        }
        return;
      }
      if (mode === 'shape') {
        if (pts.size === 0) {
          mode = 'none';
          this.shape0 = null;
          tick();
          this.commitAndRefresh();
        }
        return;
      }
      if (mode === 'vig') {
        this.vigOv.end();
        mode = 'none';
        return;
      }
      if (mode === 'crop') {
        this.crop.end();
        this.updateSecBar();
      } else if (mode === 'blur') {
        this.blurOv.end();
        this.updateSecBar();
      } else if (mode === 'mask') {
        this.maskOv.end();
        this.maskInteracting = false;
        this.loupe.hide();
        this.requestRender();
      } else if (mode === 'paint') {
        this.endStroke();
      } else if (mode === 'ai') {
        this.endAiStroke();
      } else if (mode === 'dx') {
        this.layerUp();
      } else if (mode === 'pick') {
        this.endPick(true);
      } else if (mode === 'vtext') {
        this.video?.stageUp();
      } else if (mode === 'heal') {
        this.healUp();
      } else if (mode === 'compare') {
        this.setCompare(false);
      } else if (mode === 'value' || mode === 'menu') {
        this.finishSwipe(mode);
      } else if (mode === 'pending' && e.type === 'pointerup') {
        const now = performance.now();
        const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
        if (now - lastTap.t < 300 && near) {
          // double tap: zoomed in -> back to the whole photo; otherwise reset the current
          // adjustment (either way the pending hide/show is cancelled)
          clearTimeout(tapTimer);
          const id = this.currentParam();
          if (this.zoom.s > 1.01) {
            this.zoom = { s: 1, x: 0, y: 0 };
            this.applyZoom(true);
            tick();
          } else if (!id) {
            // nothing to reset: zoom in on that spot
            const m = stageXY(e.clientX, e.clientY);
            const V = this.view, s = 3;
            const px = (m.x - V.cx) / V.base, py = (m.y - V.cy) / V.base;
            this.zoom = { s, x: m.x - V.cx - px * V.base * s, y: m.y - V.cy - py * V.base * s };
            this.applyZoom(true);
            tick();
          } else if (id) {
            this.set(id, this.def(id).def);
            this.commit();
            this.showHud(id);
            this.hideHudSoon();
            this.refreshSection();
            tick(true);
          }
          lastTap = { t: 0, x: 0, y: 0 };
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
          clearTimeout(tapTimer);
          // a tap plays / pauses a video; on a photo it hides the controls
          tapTimer = window.setTimeout(() => (this.video ? this.video.togglePlay() : this.toggleUI()), 260);
        }
      }
      mode = 'none';
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    st.addEventListener('wheel', (e) => {
      if (!this.img || this.kind() === 'crop') return;
      e.preventDefault();
      const m = stageXY(e.clientX, e.clientY);
      const V = this.view;
      const s = Math.min(this.maxZoom(), Math.max(1, this.zoom.s * Math.exp(-e.deltaY * 0.002)));
      const E0 = V.base * this.zoom.s, E1 = V.base * s;
      const px = (m.x - V.cx - this.zoom.x) / E0;
      const py = (m.y - V.cy - this.zoom.y) / E0;
      this.zoom = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: m.x - V.cx - px * E1, y: m.y - V.cy - py * E1 };
      this.applyZoom();
    }, { passive: false });
  }

  private finishSwipe(mode: 'value' | 'menu') {
    this.crop.setGrid(false);
    this.blurOv.guides = false;
    this.blurOv.draw();
    if (mode === 'value') {
      this.endValue();
    } else {
      this.showMenu(false);
      const id = this.currentParam();
      if (id) {
        this.showHud(id);
        this.hideHudSoon(900);
      }
    }
    this.refreshSection();
  }

  /** Grab the crop box. With an uncropped frame, a drag in the middle straightens instead. */
  private cropGrab(e: PointerEvent) {
    if (!this.crop.start(e)) return false;
    const c = this.state.geo.crop;
    if (c.w > 0.999 && c.h > 0.999) {
      const r = $('cropLayer').getBoundingClientRect();
      const T = 40;
      if (e.clientX > r.left + T && e.clientX < r.right - T && e.clientY > r.top + T && e.clientY < r.bottom - T) {
        this.crop.cancel();
        return false;
      }
    }
    return true;
  }

  // -----------------------------------------------------------------------------------
  // Masks

  private selMask(): Mask | null {
    return this.state.masks[this.maskSel] ?? null;
  }

  private frameInfo() {
    const img = this.img;
    const f = img ? frameSize(this.state.geo, img.full.w, img.full.h) : { w: 1, h: 1 };
    const crop = this.kind() === 'crop' ? { x: 0, y: 0, w: 1, h: 1 } : this.state.geo.crop;
    return { crop, aspect: f.w / f.h };
  }

  private syncAtlasSize() {
    if (!this.img) return;
    this.atlas.resize(this.frameInfo().aspect);
    this.ovAtlas.resize(this.frameInfo().aspect);
  }

  private maskIcon(m: Mask) {
    if (m.type === 'radial' && m.g.smart > 0) return ICONS.mPoint;
    if (m.type === 'subject') return m.ai?.part !== undefined ? ICONS.mPeople : ICONS.mSubject;
    return { radial: ICONS.mRadial, linear: ICONS.mLinear, brush: ICONS.mBrush, luma: ICONS.mLuma, color: ICONS.mColor }[m.type];
  }

  // ---- AI selection

  /** What the photo frame looks like to the models: identifies the image + geometry. */
  private frameKey() {
    const g = this.state.geo, v = this.state.v;
    return JSON.stringify([this.img?.name, this.img?.full.w, this.img?.full.h, g.quarter, g.flipH, g.flipV, v.straighten, v.distortion]);
  }

  /** The uncropped, turned frame at ~1024px, in sRGB, for the segmenters and the edge refine. */
  private frameImage() {
    const key = this.frameKey();
    if (this.frameImg?.key === key) return this.frameImg;
    const img = this.img!;
    const st = { ...defaultState(), geo: { ...this.state.geo, crop: { x: 0, y: 0, w: 1, h: 1 } }, spots: this.state.spots };
    st.v.straighten = this.state.v.straighten;
    st.v.distortion = this.state.v.distortion;
    const f = outputSize(st, img.preview.w, img.preview.h);
    const k = Math.min(1, 1024 / Math.max(f.w, f.h));
    const w = Math.max(1, Math.round(f.w * k)), h = Math.max(1, Math.round(f.h * k));
    const R = this.pipe.geometryRegion(img.preview, st, w, h, { x: 0, y: 0, w, h });
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const l = i / 255;
      lut[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
    }
    const px = new Uint8ClampedArray(R.w * R.h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = lut[R.px[i]];
      px[i + 1] = lut[R.px[i + 1]];
      px[i + 2] = lut[R.px[i + 2]];
      px[i + 3] = 255;
    }
    const canvas = document.createElement('canvas');
    canvas.width = R.w;
    canvas.height = R.h;
    canvas.getContext('2d')!.putImageData(new ImageData(px, R.w, R.h), 0, 0);
    this.frameImg = { key, canvas, px, w: R.w, h: R.h };
    return this.frameImg;
  }

  private baseKey(m: Mask) {
    return this.frameKey() + '|' + JSON.stringify(m.ai ?? null);
  }

  /** Raster for a subject mask; kicks off the model when it isn't ready yet. */
  private maskBase(m: Mask): HTMLCanvasElement | null {
    if (!this.img || !m.ai) return null;
    const key = this.baseKey(m);
    const hit = this.bases.get(key);
    if (hit) {
      this.lastBase.set(m.id, hit);
      return hit;
    }
    if (!this.baseJobs.has(key) && !this.baseFailed.has(key)) void this.computeBase(m, key);
    return this.lastBase.get(m.id) ?? null;
  }

  private async computeBase(m: Mask, key: string) {
    this.baseJobs.add(key);
    const ai = JSON.parse(JSON.stringify(m.ai)) as NonNullable<Mask['ai']>;
    const people = ai.part !== undefined;
    const hasInput = people || ai.strokes.some((s) => s.pts.length >= 2);
    let shown = false;
    const progress = (f: number) => {
      shown = true;
      this.busy(`Downloading AI model ${Math.round(f * 100)}%`);
    };
    try {
      if (!hasInput) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        this.bases.set(key, c);
        this.lastBase.set(m.id, c);
        return;
      }
      const F = this.frameImage();
      const slow = !this.seg.warm(people ? 'people' : 'subject', F.key);
      if (slow) {
        shown = true;
        this.busy(people ? 'Finding people' : 'Looking at your photo');
        await new Promise((r) => setTimeout(r, 30));
      }
      const md = people
        ? await this.seg.peopleMask(F.canvas, F.key, PEOPLE_PARTS[ai.part!].cats, progress)
        : await this.seg.subjectMask(F.canvas, F.key, ai.strokes, progress);
      if (shown) this.busy('Refining edges');
      const q = refineMask(md, F.px, F.w, F.h);
      const c = document.createElement('canvas');
      c.width = F.w;
      c.height = F.h;
      const ctx = c.getContext('2d')!;
      const out = ctx.createImageData(F.w, F.h);
      for (let i = 0; i < q.length; i++) {
        const o = i * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
        out.data[o + 3] = Math.round(q[i] * 255);
      }
      ctx.putImageData(out, 0, 0);
      this.bases.set(key, c);
      this.lastBase.set(m.id, c);
      // show what got selected for a moment
      this.maskInteracting = true;
      clearTimeout(this.maskFlashTimer);
      this.maskFlashTimer = window.setTimeout(() => {
        this.maskInteracting = false;
        this.requestRender();
      }, 1400);
      // keep the cache small: rasters are ~1 MP each
      while (this.bases.size > 24) this.bases.delete(this.bases.keys().next().value!);
    } catch (e) {
      console.error(e);
      this.baseFailed.add(key);
      this.toast('AI selection failed: ' + ((e as Error).message || 'unknown error') + (navigator.onLine ? '' : ' (the model needs internet once)'), 5000);
    } finally {
      this.baseJobs.delete(key);
      if (shown) this.busy(null);
      this.requestRender();
    }
  }

  private buildMaskList() {
    const row = $('subs');
    this.tile(row, ICONS.plus, 'Add', 'add', () => this.openMaskSheet());
    this.state.masks.forEach((m, i) => {
      this.tile(row, this.maskIcon(m), m.name, i === this.maskSel ? 'on' : '', () => {
        this.maskSel = i;
        this.paramIdx.masks = 0;
        const t = this.selMask()!.type;
        if (t === 'luma' || t === 'color') this.pickMode = 'swipe';
        this.refreshSection();
        this.requestRender();
      });
    });
  }

  private buildMaskActs() {
    const row = $('acts');
    const m = this.selMask();
    if (!m) return;
    const sep = () => row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
    if (m.type === 'subject') {
      if (m.ai?.part !== undefined) {
        PEOPLE_PARTS.forEach((pp, k) => this.chip(row, { id: String(k), label: pp.label }, m.ai!.part === k, () => {
          m.ai!.part = k;
          m.name = pp.label;
          this.commit();
          this.refreshSection();
          this.requestRender();
        }));
        sep();
      } else {
        this.tile(row, ICONS.plus, 'Add', this.brushMode === 'aiAdd' ? 'on' : '', () => this.setBrushMode('aiAdd'));
        this.tile(row, ICONS.close, 'Exclude', this.brushMode === 'aiSub' ? 'on' : '', () => this.setBrushMode('aiSub'));
      }
      this.tile(row, ICONS.paint, 'Brush', this.brushMode === 'paint' ? 'on' : '', () => this.setBrushMode('paint'));
      this.tile(row, ICONS.erase, 'Erase', this.brushMode === 'erase' ? 'on' : '', () => this.setBrushMode('erase'));
      this.tile(row, ICONS.swipe, 'Adjust', this.brushMode === 'swipe' ? 'on' : '', () => this.setBrushMode('swipe'));
      sep();
    } else if (m.type === 'brush') {
      this.tile(row, ICONS.paint, 'Paint', this.brushMode === 'paint' ? 'on' : '', () => this.setBrushMode('paint'));
      this.tile(row, ICONS.erase, 'Erase', this.brushMode === 'erase' ? 'on' : '', () => this.setBrushMode('erase'));
      this.tile(row, ICONS.swipe, 'Adjust', this.brushMode === 'swipe' ? 'on' : '', () => this.setBrushMode('swipe'));
      sep();
    }
    if (this.brushing()) this.brushChips(row, sep);
    if (m.type === 'luma' || m.type === 'color') {
      this.tile(row, ICONS.pick, 'Pick', this.pickMode === 'pick' ? 'on' : '', () => {
        this.pickMode = 'pick';
        this.toast('Drag on the photo to choose');
        this.refreshSection();
      });
      this.tile(row, ICONS.swipe, 'Adjust', this.pickMode === 'swipe' ? 'on' : '', () => {
        this.pickMode = 'swipe';
        this.refreshSection();
      });
      sep();
    }
    this.tile(row, ICONS.eye, 'Show', this.maskOverlayOn ? 'hot' : '', () => {
      this.maskOverlayOn = !this.maskOverlayOn;
      this.refreshSection();
      this.requestRender();
    });
    this.tile(row, ICONS.invert, 'Invert', m.invert ? 'hot' : '', () => this.maskAction('invert'));
    this.tile(row, ICONS.duplicate, 'Copy', '', () => this.maskAction('dup'));
    this.tile(row, ICONS.trash, 'Delete', 'danger', () => this.maskAction('delete'));
  }

  /** Size · Hardness · Flow: which one the slider changes. */
  private brushChips(row: HTMLElement, sep: () => void) {
    const ps = this.params();
    const cur = this.currentParam();
    ps.forEach((id, i) => this.chip(row, { id, label: id === 'mg.hard' ? 'Hardness' : this.def(id).label }, id === cur, () => {
      this.paramIdx[this.pkey()] = i;
      this.refreshSection();
      this.showSizeRing(id);
    }));
    sep();
  }

  private setBrushMode(m: 'paint' | 'erase' | 'swipe' | 'aiAdd' | 'aiSub') {
    this.brushMode = m;
    this.refreshSection();
    this.requestRender();
  }

  // AI strokes: a tap or a scribble over what to include (or exclude)
  private startAiStroke(e: PointerEvent) {
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    this.aiStroke = { neg: this.brushMode === 'aiSub', pts: [f.x, f.y] };
    this.showBrushRing(e, 14);
  }
  private continueAiStroke(e: PointerEvent) {
    const s = this.aiStroke;
    if (!s) return;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    const n = s.pts.length;
    if (Math.hypot(f.x - s.pts[n - 2], f.y - s.pts[n - 1]) > 0.004) s.pts.push(f.x, f.y);
    this.showBrushRing(e, 14);
  }
  private endAiStroke() {
    const m = this.selMask();
    const s = this.aiStroke;
    this.aiStroke = null;
    this.hideBrushRing();
    if (!m || !s || m.type !== 'subject') return;
    m.ai ??= { strokes: [] };
    m.ai.strokes.push(s);
    tick(true);
    this.commit();
    this.refreshSection();
    this.requestRender();
  }

  private bindMaskSheet() {
    const sheet = $('maskSheet');
    const grid = $('maskGrid');
    for (const k of MASK_KINDS) {
      const b = document.createElement('button');
      b.className = 'mask-tile' + (k.ai ? ' ai' : '');
      b.innerHTML = `${k.icon}<b>${k.label}</b><span>${k.desc}</span>`;
      b.onclick = () => {
        tick();
        sheet.classList.remove('on');
        this.addMask(k.kind);
      };
      grid.appendChild(b);
    }
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
  }

  private openMaskSheet() {
    if (this.state.masks.length >= MAX_MASKS) return this.toast(`Up to ${MAX_MASKS} masks per photo`);
    $('maskSheet').classList.add('on');
  }

  private addMask(kind: string) {
    const { crop, aspect } = this.frameInfo();
    const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
    const type: MaskType = kind === 'point' ? 'radial' : kind === 'people' ? 'subject' : (kind as MaskType);
    const g: Record<string, number> = {};
    for (const key of MASK_TYPE_SETTINGS[type]) g[key] = MASK_SETTINGS[key].def;
    const a: Record<string, number> = Object.fromEntries(MASK_ADJ.map((d) => [d.id, 0]));
    if (type === 'radial') {
      const r = kind === 'point' ? 0.1 : 0.28 * crop.h;
      Object.assign(g, { cx, cy, rx: kind === 'point' ? r : Math.min(r * 1.25, (crop.w * aspect) / 2), ry: r, angle: 0 });
      if (kind === 'point') Object.assign(g, { smart: 55, feather: 75 });
    } else if (type === 'linear') {
      Object.assign(g, { x0: cx, y0: crop.y + crop.h * 0.08, x1: cx, y1: crop.y + crop.h * 0.5 });
    }
    const n = this.state.masks.filter((m) => m.type === type && (kind === 'point') === (m.g.smart > 0)).length + 1;
    const label = kind === 'point' ? 'Point' : kind === 'people' ? 'Person' : MASK_LABEL[type].replace(' range', '');
    const m: Mask = { id: Date.now() % 1e9, type, name: kind === 'people' ? label : `${label} ${n}`, invert: false, g, a, strokes: [] };
    if (type === 'subject') m.ai = kind === 'people' ? { strokes: [], part: 0 } : { strokes: [] };
    this.state.masks.push(m);
    this.maskSel = this.state.masks.length - 1;
    this.paramIdx.masks = 0;
    if (type === 'radial' && g.smart > 0) this.updateSmartRef(m);
    if (type === 'brush') this.brushMode = 'paint';
    if (type === 'subject') this.brushMode = kind === 'people' ? 'swipe' : 'aiAdd';
    if (type === 'luma' || type === 'color') this.pickMode = 'pick';
    this.commit();
    this.refreshSection();
    this.requestRender();
    const tips: Record<string, string> = {
      radial: 'Drag the orange dot to move · white dots resize and rotate',
      point: 'Drag the point onto what you want to change',
      linear: 'Full effect at the solid line, fading out by the dashed one',
      brush: 'Paint over the area · two fingers to zoom',
      subject: 'Tap the subject (or paint over it) · Exclude to take parts away',
      people: 'Pick a part: person, face, skin, hair, clothes or background',
      luma: 'Drag on the photo to choose a brightness',
      color: 'Drag on the photo to choose a color',
    };
    this.toast(tips[kind], 3000);
  }

  private maskAction(what: string) {
    const m = this.selMask();
    if (!m) return;
    if (what === 'invert') m.invert = !m.invert;
    else if (what === 'dup') {
      if (this.state.masks.length >= MAX_MASKS) return this.toast(`Up to ${MAX_MASKS} masks per photo`);
      const c: Mask = JSON.parse(JSON.stringify(m));
      c.id = (Date.now() + 1) % 1e9;
      c.name = m.name + '+';
      this.state.masks.splice(this.maskSel + 1, 0, c);
      this.maskSel++;
    } else if (what === 'delete') {
      this.state.masks.splice(this.maskSel, 1);
      this.maskSel = Math.min(this.maskSel, this.state.masks.length - 1);
    }
    this.commit();
    this.refreshSection();
    this.requestRender();
  }

  private analysisPixels() {
    const img = this.img!;
    const st = { ...defaultState(), geo: this.state.geo, spots: this.state.spots };
    st.v.straighten = this.state.v.straighten;
    const { w, h } = outputSize(st, img.thumb.w, img.thumb.h);
    const key = JSON.stringify([st.geo, st.v.straighten, img.name, this.state.spots.length]);
    if (this.analysisCache?.key !== key) {
      this.analysisCache = { key, px: this.pipe.analysisPixels(img.thumb, st, w, h), w, h };
    }
    return this.analysisCache;
  }

  /** Image color (pre-tone, perceptual) at a frame point — what the shader compares masks against. */
  private colorAt(fx: number, fy: number): [number, number, number] {
    const A = this.analysisPixels();
    const c = this.state.geo.crop;
    const u = Math.min(1, Math.max(0, (fx - c.x) / c.w));
    const v = Math.min(1, Math.max(0, (fy - c.y) / c.h));
    const x = Math.min(A.w - 1, Math.floor(u * A.w)), y = Math.min(A.h - 1, Math.floor(v * A.h));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(A.h - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(A.w - 1, x + 1); xx++) {
        const i = (yy * A.w + xx) * 4;
        r += A.px[i]; g += A.px[i + 1]; b += A.px[i + 2]; n++;
      }
    }
    const wb = wbMul(this.state.v.temp / 100, this.state.v.tint / 100);
    const ex = 2 ** this.state.v.exposure;
    return [r / n, g / n, b / n].map((l, k) => Math.pow(Math.max(0, l * wb[k] * ex), 1 / 2.2)) as [number, number, number];
  }

  private updateSmartRef(m: Mask) {
    if (m.type !== 'radial' || !this.img || !(m.g.smart > 0)) return;
    const [r, g, b] = this.colorAt(m.g.cx, m.g.cy);
    m.g.sr = r;
    m.g.sg = g;
    m.g.sb = b;
  }

  /** Live picking for light/color range masks, with the loupe above the finger. */
  private pickAt(e: PointerEvent) {
    const m = this.selMask();
    if (!m || !this.img) return;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    const [r, g, b] = this.colorAt(f.x, f.y);
    if (m.type === 'color') {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d > 0.03) {
        const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        m.g.hue = Math.round((h * 60 + 360) % 360);
      }
    } else {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      m.g.lo = Math.max(0, Math.round(y * 100 - 14));
      m.g.hi = Math.min(100, Math.round(y * 100 + 14));
    }
    this.maskInteracting = true;
    this.loupe.color = rgbCss([r, g, b]);
    this.loupe.show(e.clientX, e.clientY);
    this.requestRender();
  }

  private endPick(commit: boolean) {
    this.loupe.hide();
    this.maskInteracting = false;
    if (commit) {
      tick(true);
      this.pickMode = 'swipe';
      this.commit();
      this.refreshSection();
      this.toast('Swipe ↔ to adjust · Pick to choose again');
    }
    this.requestRender();
  }

  // brush painting
  private stroke: Stroke | null = null;
  private brushRadius() {
    const size = this.selMask()?.g.size ?? 25;
    return 0.006 + Math.pow(size / 100, 1.5) * 0.22;
  }
  private startStroke(e: PointerEvent) {
    const m = this.selMask()!;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    this.stroke = {
      r: this.brushRadius(),
      hard: (m.g.hard ?? 25) / 100,
      flow: (m.g.flow ?? 70) / 100,
      erase: this.brushMode === 'erase',
      pts: [f.x, f.y],
    };
    m.strokes.push(this.stroke);
    this.maskInteracting = true;
    this.showBrushRing(e);
    this.requestRender();
  }
  private continueStroke(e: PointerEvent) {
    if (!this.stroke) return;
    const P = this.stroke.pts;
    const { aspect } = this.frameInfo();
    let added = false;
    // every point the phone sampled since the last event, not just the latest
    for (const c of coalesced(e)) {
      const f = this.maskOv.toFrame(c.clientX, c.clientY);
      if (Math.hypot((f.x - P[P.length - 2]) * aspect, f.y - P[P.length - 1]) > this.stroke.r * 0.08) {
        P.push(f.x, f.y);
        added = true;
      }
    }
    if (added) this.requestRender();
    this.showBrushRing(e);
  }
  private endStroke() {
    this.stroke = null;
    this.maskInteracting = false;
    this.hideBrushRing();
    this.commit();
    this.updateSecBar();
    this.requestRender();
  }
  private cancelStroke() {
    const m = this.selMask();
    if (m && this.stroke) m.strokes.splice(m.strokes.indexOf(this.stroke), 1);
    this.stroke = null;
    this.maskInteracting = false;
    this.requestRender();
  }
  private showBrushRing(e: PointerEvent, px = 0) {
    const ring = $('brushRing');
    const r = px || this.brushRadius() * this.maskOv.pxPerFrameH();
    const st = this.stage.getBoundingClientRect();
    ring.style.width = ring.style.height = r * 2 + 'px';
    ring.style.transform = `translate(${e.clientX - st.left - r}px, ${e.clientY - st.top - r}px)`;
    ring.classList.toggle('erase', this.brushMode === 'erase' || this.brushMode === 'aiSub');
    ring.classList.add('on');
  }
  private hideBrushRing() {
    $('brushRing').classList.remove('on');
  }

  /** Keep masks on the same content when the frame is rotated or flipped. */
  private transformMasks(kind: 'rot' | 'flipH' | 'flipV') {
    const aspect = this.frameInfo().aspect;
    for (const m of this.state.masks) {
      const g = m.g;
      const pt = (x: number, y: number): [number, number] =>
        kind === 'rot' ? [1 - y, x] : kind === 'flipH' ? [1 - x, y] : [x, 1 - y];
      if (m.type === 'radial') {
        [g.cx, g.cy] = pt(g.cx, g.cy);
        if (kind === 'rot') {
          g.rx /= aspect;
          g.ry /= aspect;
          g.angle += Math.PI / 2;
        } else g.angle = -g.angle;
      } else if (m.type === 'linear') {
        [g.x0, g.y0] = pt(g.x0, g.y0);
        [g.x1, g.y1] = pt(g.x1, g.y1);
      }
      for (const st of m.ai?.strokes ?? []) {
        for (let i = 0; i < st.pts.length; i += 2) [st.pts[i], st.pts[i + 1]] = pt(st.pts[i], st.pts[i + 1]);
      }
      for (const st of m.strokes) {
        if (kind === 'rot') st.r /= aspect;
        for (let i = 0; i < st.pts.length; i += 2) [st.pts[i], st.pts[i + 1]] = pt(st.pts[i], st.pts[i + 1]);
      }
    }
    for (const f of this.state.fills ?? []) {
      const fp = (x: number, y: number): [number, number] => (kind === 'rot' ? [1 - y, x] : kind === 'flipH' ? [1 - x, y] : [x, 1 - y]);
      for (let i = 0; i < f.pts.length; i += 2) [f.pts[i], f.pts[i + 1]] = fp(f.pts[i], f.pts[i + 1]);
      if (kind === 'rot') f.r /= aspect;
    }
    for (const sp of this.state.spots) {
      const tp = (x: number, y: number): [number, number] => (kind === 'rot' ? [1 - y, x] : kind === 'flipH' ? [1 - x, y] : [x, 1 - y]);
      if (sp.pts) for (let i = 0; i < sp.pts.length; i += 2) [sp.pts[i], sp.pts[i + 1]] = tp(sp.pts[i], sp.pts[i + 1]);
      const [x, y] = kind === 'rot' ? [1 - sp.y, sp.x] : kind === 'flipH' ? [1 - sp.x, sp.y] : [sp.x, 1 - sp.y];
      const [ox, oy] = kind === 'rot' ? [-sp.oy, sp.ox] : kind === 'flipH' ? [-sp.ox, sp.oy] : [sp.ox, -sp.oy];
      Object.assign(sp, { x, y, ox, oy });
      if (kind === 'rot') sp.r /= aspect;
    }
  }

  // -----------------------------------------------------------------------------------
  // Remove: paint over what should go (you see it as you paint), let go and it's filled from
  // a matching patch nearby; drag the yellow copy to choose the source yourself.

  /** Brush radius in screen px, from the Brush size slider. */
  private healPx() {
    return 4 + this.state.v.healSize * 0.72;
  }
  private healRadius() {
    return this.healPx() / this.maskOv.pxPerFrameH(); // frame heights; constant size on screen
  }

  private healLoupe(x: number, y: number, rPx: number) {
    this.loupe.color = '#f4f4f2';
    this.loupe.ring = rPx;
    this.loupe.zoom = Math.min(6, Math.max(1.6, 30 / Math.max(1, rPx)));
    this.loupe.show(x, y);
  }

  private healRing(e: PointerEvent) {
    const ring = $('brushRing');
    const r = this.healPx();
    const st = this.stage.getBoundingClientRect();
    ring.style.width = ring.style.height = r * 2 + 'px';
    ring.style.transform = `translate(${e.clientX - st.left - r}px, ${e.clientY - st.top - r}px)`;
    ring.classList.remove('erase', 'size');
    ring.classList.add('on');
  }

  /** the stroke being painted: screen points (for drawing) and frame points (for the patch) */
  private healPaint: { pts: { x: number; y: number }[]; frame: number[]; r: number } | null = null;

  private fillMode() {
    return (this.sub.heal ?? 'heal') === 'fill';
  }

  private healDown(e: PointerEvent) {
    const f0 = this.maskOv.toFrame(e.clientX, e.clientY);
    const spots = this.state.spots;
    const sel = spots[this.spotSel];
    if (this.fillMode()) {
      // Fill: just paint over what should go
      this.hd = { i: -1, kind: 'new', f0, sp0: null, moved: false };
      this.healPaint = { pts: [{ x: e.clientX, y: e.clientY }], frame: [f0.x, f0.y], r: this.healPx() };
      this.healRing(e);
      this.healLoupe(e.clientX, e.clientY, this.healPx());
      this.healOv.draw();
      return;
    }
    if (sel) {
      const h = this.healOv.hit(sel, e.clientX, e.clientY, 10);
      if (h.source || h.target) {
        this.hd = { i: this.spotSel, kind: h.source ? 'src' : 'spot', f0, sp0: JSON.parse(JSON.stringify(sel)), moved: false };
        if (h.source) tick();
        return;
      }
    }
    // an unselected patch: a tap selects it, a drag paints a new one
    let hit = -1;
    for (let i = spots.length - 1; i >= 0; i--) {
      if (this.healOv.hit(spots[i], e.clientX, e.clientY, 2).target) {
        hit = i;
        break;
      }
    }
    this.hd = { i: hit, kind: 'new', f0, sp0: null, moved: false };
    this.healPaint = { pts: [{ x: e.clientX, y: e.clientY }], frame: [f0.x, f0.y], r: this.healPx() };
    this.healRing(e);
    this.healLoupe(e.clientX, e.clientY, this.healPx());
    this.healOv.draw();
    this.requestRender();
  }

  private healMove(e: PointerEvent) {
    const hd = this.hd;
    if (!hd) return;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    const dx = f.x - hd.f0.x, dy = f.y - hd.f0.y;
    if (!hd.moved && Math.hypot(dx * this.frameInfo().aspect, dy) * this.maskOv.pxPerFrameH() > 6) hd.moved = true;
    if (hd.kind === 'new') {
      const P = this.healPaint!;
      const last = P.pts[P.pts.length - 1];
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) > Math.max(2, P.r * 0.25)) {
        P.pts.push({ x: e.clientX, y: e.clientY });
        P.frame.push(f.x, f.y);
        this.healOv.draw();
      }
      this.healRing(e);
      this.healLoupe(e.clientX, e.clientY, this.healPx());
      this.requestRender();
      return;
    }
    const sp = this.state.spots[hd.i];
    if (!sp || !hd.sp0 || !hd.moved) return;
    if (hd.kind === 'src') {
      sp.ox = hd.sp0.ox + dx;
      sp.oy = hd.sp0.oy + dy;
    } else {
      sp.x = hd.sp0.x + dx;
      sp.y = hd.sp0.y + dy;
      if (hd.sp0.pts) sp.pts = hd.sp0.pts.map((v, k) => v + (k % 2 ? dy : dx));
    }
    // watch the result live in the loupe, centred on the patch
    const g = this.healOv.geom(sp);
    this.healLoupe(g.t.x, g.t.y, g.r);
    this.healOv.draw();
    this.requestRender();
  }

  private healUp() {
    const hd = this.hd;
    const paint = this.healPaint;
    this.hd = null;
    this.healPaint = null;
    this.loupe.hide();
    this.loupe.ring = 0;
    this.loupe.zoom = 3.2;
    this.hideBrushRing();
    if (!hd || !this.img) return this.healOv.draw();
    if (hd.kind === 'new' && this.fillMode()) {
      this.addFill(paint!);
      return;
    }
    if (hd.kind === 'new') {
      if (!hd.moved && hd.i >= 0) {
        this.spotSel = hd.i;
        tick();
        this.healOv.draw();
        this.refreshSection();
        return;
      }
      this.addSpot(paint!, hd.moved);
      return;
    }
    const sp = this.state.spots[hd.i];
    if (!sp) return;
    if (!hd.moved) {
      if (hd.kind === 'spot') this.spotSel = -1; // tap the selected patch again to deselect
    } else {
      sp.c = this.spotCorr(hd.i);
      tick(true);
      this.commit();
    }
    this.healOv.draw();
    this.refreshSection();
    this.requestRender();
  }

  private healCancel() {
    const hd = this.hd;
    if (hd?.sp0 && this.state.spots[hd.i]) this.state.spots[hd.i] = hd.sp0;
    this.hd = null;
    this.healPaint = null;
    this.loupe.hide();
    this.hideBrushRing();
    this.healOv.draw();
    this.requestRender();
  }

  /** Content-aware fill: the painted area is rebuilt from the rest of the photo. */
  private addFill(paint: { frame: number[]; r: number }) {
    if ((this.state.fills ?? []).length >= 12) {
      this.healOv.draw();
      return this.toast('Up to 12 fills per photo');
    }
    const pts = paint.frame.slice();
    if (pts.length < 4) pts.push(pts[0], pts[1]);
    (this.state.fills ??= []).push({ pts, r: this.healRadius() });
    tick(true);
    this.commit();
    this.refreshSection();
    this.healOv.draw();
    this.requestRender(); // computes the fill; shows its progress
  }

  /** Turn the painted stroke (or a tap) into a patch filled from the best match nearby. */
  private addSpot(paint: { frame: number[] }, painted: boolean) {
    this.requestRender();
    if (this.state.spots.length >= MAX_SPOTS) {
      this.healOv.draw();
      return this.toast(`Up to ${MAX_SPOTS} fixes per photo`);
    }
    const F = paint.frame;
    let cx = 0, cy = 0;
    for (let i = 0; i < F.length; i += 2) {
      cx += F[i];
      cy += F[i + 1];
    }
    const n = F.length / 2;
    const spot: Spot = { x: cx / n, y: cy / n, r: this.healRadius(), ox: 0, oy: 0, c: [0, 0, 0] };
    if (painted && F.length >= 4) spot.pts = F.slice();
    else {
      spot.x = F[0];
      spot.y = F[1];
    }
    const fill = this.findPatch(spot, -1);
    if (!fill) {
      this.healOv.draw();
      return this.toast('Couldn’t find a clean patch nearby — try zooming in');
    }
    Object.assign(spot, fill);
    this.state.spots.push(spot);
    const first = this.spotSel < 0 && this.state.spots.length === 1;
    this.spotSel = this.state.spots.length - 1;
    tick(true);
    this.commit();
    this.refreshSection();
    this.healOv.draw();
    this.requestRender();
    if (first) this.toast('Drag the yellow copy to choose what fills it', 3000);
  }

  /** The unedited, geometry-applied preview without patch `exclude` (and its pixel size). */
  private healBase(exclude: number) {
    const img = this.img!;
    const st = { ...defaultState(), geo: this.state.geo, spots: this.state.spots.filter((_, j) => j !== exclude) };
    st.v.straighten = this.state.v.straighten;
    st.v.distortion = this.state.v.distortion;
    const { w: W, h: H } = outputSize(st, img.preview.w, img.preview.h);
    return { st, W, H };
  }

  /** Points around (ring) and inside a patch, in preview px. */
  private patchSamples(sp: Spot, W: number, H: number) {
    const c = this.state.geo.crop;
    const toPx = (x: number, y: number): [number, number] => [((x - c.x) / c.w) * W, ((y - c.y) / c.h) * H];
    const circles = spotCircles(sp, this.frameInfo().aspect).map(([x, y]) => toPx(x, y));
    const rp = Math.max(1.5, (sp.r / c.h) * H);
    const ring: [number, number][] = [];
    const inside: [number, number][] = [];
    const nA = circles.length > 1 ? 12 : 28;
    for (const [cx, cy] of circles) {
      inside.push([cx, cy]);
      for (let k = 0; k < 6; k++) inside.push([cx + Math.cos(k * 1.047) * rp * 0.55, cy + Math.sin(k * 1.047) * rp * 0.55]);
      for (let k = 0; k < nA; k++) {
        const a = (k / nA) * Math.PI * 2;
        for (const rr of [1.15, 1.45]) {
          const x = cx + Math.cos(a) * rp * rr, y = cy + Math.sin(a) * rp * rr;
          if (circles.every(([qx, qy]) => Math.hypot(x - qx, y - qy) > rp * 1.08)) ring.push([x, y]);
        }
      }
    }
    const thin = <T,>(a: T[], max: number) => (a.length <= max ? a : a.filter((_, i) => i % Math.ceil(a.length / max) === 0));
    let mx = 0, my = 0;
    for (const [x, y] of circles) {
      mx += x / circles.length;
      my += y / circles.length;
    }
    let ext = rp;
    for (const [x, y] of circles) ext = Math.max(ext, Math.hypot(x - mx, y - my) + rp);
    return { ring: thin(ring, 160), inside: thin(inside, 120), rp, ext, mx, my, circles };
  }

  /** Find where to copy a patch from: the surroundings must match and the source must be clean. */
  private findPatch(sp: Spot, exclude: number): Pick<Spot, 'ox' | 'oy' | 'c'> | null {
    const img = this.img!;
    const { st, W, H } = this.healBase(exclude);
    const c = this.state.geo.crop;
    const S = this.patchSamples(sp, W, H);
    const base = Math.max(S.ext, S.rp);
    const dists = [1.25, 1.75, 2.4].map((k) => base * k + S.rp * 0.9);
    const reach = dists[2] + base + S.rp * 1.6;
    const R = this.pipe.geometryRegion(img.preview, st, W, H, { x: S.mx - reach, y: S.my - reach, w: reach * 2, h: reach * 2 });
    const at = (x: number, y: number): [number, number, number] | null => {
      const ix = Math.round(x - R.x), iy = Math.round(y - R.y);
      if (ix < 0 || iy < 0 || ix >= R.w || iy >= R.h) return null;
      const i = (iy * R.w + ix) * 4;
      return [R.px[i] / 255, R.px[i + 1] / 255, R.px[i + 2] / 255];
    };
    const dst = S.ring.map(([x, y]) => at(x, y));
    const lum = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    let best: { cost: number; ox: number; oy: number; corr: [number, number, number] } | null = null;
    for (const dist of dists) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const ox = Math.cos(a) * dist, oy = Math.sin(a) * dist;
        const mean = [0, 0, 0], meanD = [0, 0, 0];
        const pairs: [number[], number[]][] = [];
        S.ring.forEach(([x, y], j) => {
          const d = dst[j];
          const sc = at(x + ox, y + oy);
          if (!d || !sc) return;
          pairs.push([d, sc]);
          for (let ch = 0; ch < 3; ch++) {
            mean[ch] += sc[ch];
            meanD[ch] += d[ch];
          }
        });
        const n = pairs.length;
        // near the photo's edge part of the ring falls outside; enough of it must match, and
        // the whole source must be inside the photo
        if (n < S.ring.length * 0.45 || S.inside.some(([x, y]) => !at(x + ox, y + oy))) continue;
        const corr = [0, 1, 2].map((ch) => (meanD[ch] - mean[ch]) / n) as [number, number, number];
        let cost = 0;
        for (const [d, sc] of pairs) for (let ch = 0; ch < 3; ch++) cost += (d[ch] - sc[ch] - corr[ch]) ** 2;
        cost = (cost / n) * 56;
        // the source itself must be clean: anything standing out from its own surroundings
        // (another blemish, an edge) is penalized hard
        const ringL = lum(mean) / n;
        let inner = 0;
        for (const [x, y] of S.inside) {
          const dl = lum(at(x + ox, y + oy)!) - ringL;
          inner += dl * dl;
        }
        cost += (inner / S.inside.length) * 56 * 6 + Math.hypot(...corr) * 2 + (dist / S.rp) * 0.002;
        if (!best || cost < best.cost) best = { cost, ox, oy, corr };
      }
    }
    if (!best) return null;
    return { ox: (best.ox / W) * c.w, oy: (best.oy / H) * c.h, c: best.corr };
  }

  /** Color correction for a patch: the difference between the rings around target and source. */
  private spotCorr(i: number): [number, number, number] {
    const img = this.img!;
    const sp = this.state.spots[i];
    const { st, W, H } = this.healBase(i);
    const c = this.state.geo.crop;
    const S = this.patchSamples(sp, W, H);
    const ox = (sp.ox / c.w) * W, oy = (sp.oy / c.h) * H;
    const pad = S.ext + S.rp * 1.6;
    const R = this.pipe.geometryRegion(img.preview, st, W, H, {
      x: Math.min(S.mx, S.mx + ox) - pad, y: Math.min(S.my, S.my + oy) - pad, w: Math.abs(ox) + pad * 2, h: Math.abs(oy) + pad * 2,
    });
    const at = (x: number, y: number) => {
      const ix = Math.round(x - R.x), iy = Math.round(y - R.y);
      if (ix < 0 || iy < 0 || ix >= R.w || iy >= R.h) return null;
      const o = (iy * R.w + ix) * 4;
      return [R.px[o] / 255, R.px[o + 1] / 255, R.px[o + 2] / 255];
    };
    const a = [0, 0, 0], b = [0, 0, 0];
    let n = 0;
    for (const [x, y] of S.ring) {
      const p = at(x, y), q = at(x + ox, y + oy);
      if (!p || !q) continue;
      for (let ch = 0; ch < 3; ch++) {
        a[ch] += p[ch];
        b[ch] += q[ch];
      }
      n++;
    }
    return n ? [(a[0] - b[0]) / n, (a[1] - b[1]) / n, (a[2] - b[2]) / n] : [0, 0, 0];
  }

  private buildHealActs() {
    const row = $('acts');
    if (this.fillMode()) {
      const n = this.state.fills?.length ?? 0;
      if (n) {
        this.tile(row, ICONS.undo, 'Undo fill', '', () => {
          this.state.fills!.pop();
          this.commit();
          this.refreshSection();
          this.healOv.draw();
          this.requestRender();
        });
        this.tile(row, ICONS.trash, 'Clear fills', 'danger', () => {
          this.state.fills = [];
          this.commit();
          this.refreshSection();
          this.healOv.draw();
          this.requestRender();
        });
      }
      return;
    }
    const sel = this.state.spots[this.spotSel];
    if (sel) {
      this.tile(row, ICONS.detail, 'Auto fill', '', () => {
        const auto = this.findPatch(sel, this.spotSel);
        if (auto) Object.assign(sel, auto);
        this.commit();
        this.refreshSection();
        this.requestRender();
      });
      this.tile(row, ICONS.trash, 'Delete', 'danger', () => {
        this.state.spots.splice(this.spotSel, 1);
        this.spotSel = -1;
        this.commit();
        this.refreshSection();
        this.requestRender();
      });
      this.tile(row, ICONS.check, 'Done', '', () => {
        this.spotSel = -1;
        this.refreshSection();
      });
    } else if (this.state.spots.length) {
      this.tile(row, ICONS.undo, 'Undo fix', '', () => {
        this.state.spots.pop();
        this.commit();
        this.refreshSection();
        this.requestRender();
      });
    }
  }

  // -----------------------------------------------------------------------------------
  // Layers: Double exposure (a second photo) and Light leaks (built-in glows). Both are placed
  // on the photo — drag to move, drag the corner square or pinch to scale and turn — blended,
  // and brushed away where you don't want them.

  private layerKey(): 'dx' | 'lk' | null {
    return this.tool?.id === 'double' ? 'dx' : this.tool?.id === 'leak' ? 'lk' : null;
  }
  private layerOf(k: 'dx' | 'lk' | null) {
    return k === 'dx' ? this.state.overlay ?? null : k === 'lk' ? this.state.leak ?? null : null;
  }

  /** Screen corners (top-left, top-right, bottom-right, bottom-left) and centre of the placed layer. */
  private layerGeometry() {
    const k = this.layerKey();
    const L = this.layerOf(k);
    if (!k || !L || this.dxMode !== 'move' || !this.img) return null;
    const v = this.state.v;
    const fa = this.frameInfo().aspect;
    const kk = Math.max(fa / L.aspect, 1) * (v[k + 'Scale'] / 100);
    const hw = (L.aspect * kk) / 2, hh = kk / 2;
    const rot = (v[k + 'Rot'] * Math.PI) / 180, co = Math.cos(rot), si = Math.sin(rot);
    const at = (sx: number, sy: number) => {
      const lx = sx * hw, ly = sy * hh;
      const px = lx * co - ly * si, py = lx * si + ly * co;
      return this.maskOv.toScreen(v[k + 'X'] + px / fa, v[k + 'Y'] + py);
    };
    return { corners: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], centre: this.maskOv.toScreen(v[k + 'X'], v[k + 'Y']) };
  }

  private layerRadius(k: 'dx' | 'lk') {
    return 0.006 + Math.pow(this.state.v[k + 'Brush'] / 100, 1.5) * 0.22;
  }

  private layerDown(e: PointerEvent) {
    const k = this.layerKey()!;
    const L = this.layerOf(k)!;
    const v = this.state.v;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    if (this.dxMode === 'move') {
      const g = this.layerGeometry();
      const mode = g && Math.hypot(g.corners[2].x - e.clientX, g.corners[2].y - e.clientY) < 34 ? 'size' : 'move';
      const c = g?.centre ?? { x: e.clientX, y: e.clientY };
      this.ld = {
        kind: mode, x: v[k + 'X'], y: v[k + 'Y'], f0: f, scale: v[k + 'Scale'], rot: v[k + 'Rot'],
        d0: Math.hypot(e.clientX - c.x, e.clientY - c.y) || 1, a0: Math.atan2(e.clientY - c.y, e.clientX - c.x),
      };
      if (mode === 'size') tick();
      return;
    }
    // the strokes paint the hidden part; with the mask inverted, Hide and Show swap so they still mean what they say
    const show = this.dxMode === 'show';
    this.dxStroke = { r: this.layerRadius(k), hard: (v[k + 'Hard'] ?? 35) / 100, flow: 0.8, erase: L.invert ? !show : show, pts: [f.x, f.y] };
    L.strokes.push(this.dxStroke);
    this.showLayerRing(e);
    this.requestRender();
  }

  private layerMove(e: PointerEvent) {
    const k = this.layerKey();
    if (!k) return;
    const v = this.state.v;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    if (this.ld) {
      const D = this.ld;
      if (D.kind === 'move') {
        v[k + 'X'] = D.x + (f.x - D.f0.x);
        v[k + 'Y'] = D.y + (f.y - D.f0.y);
      } else {
        const g = this.layerGeometry();
        const c = g?.centre ?? { x: e.clientX, y: e.clientY };
        const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
        v[k + 'Scale'] = clampParam(k + 'Scale', D.scale * (d / D.d0));
        v[k + 'Rot'] = wrap180(D.rot + ((Math.atan2(e.clientY - c.y, e.clientX - c.x) - D.a0) * 180) / Math.PI);
        const id = this.currentParam();
        if (id) this.showHud(id);
      }
      this.layerOv.draw();
      this.requestRender();
      return;
    }
    const st = this.dxStroke;
    if (!st) return;
    const P = st.pts;
    const { aspect } = this.frameInfo();
    let added = false;
    for (const c of coalesced(e)) {
      const q = this.maskOv.toFrame(c.clientX, c.clientY);
      if (Math.hypot((q.x - P[P.length - 2]) * aspect, q.y - P[P.length - 1]) > st.r * 0.08) {
        P.push(q.x, q.y);
        added = true;
      }
    }
    if (added) this.requestRender();
    this.showLayerRing(e);
  }

  /** Two fingers: pinch scales, twist turns, dragging both moves. */
  private layerPinch(pts: Map<number, { x: number; y: number }>) {
    const k = this.layerKey(), S = this.lshape0;
    if (!k || !S) return;
    const [a, b] = [...pts.values()];
    const v = this.state.v;
    v[k + 'Scale'] = clampParam(k + 'Scale', S.scale * (Math.hypot(a.x - b.x, a.y - b.y) / S.d));
    v[k + 'Rot'] = wrap180(S.rot + ((Math.atan2(b.y - a.y, b.x - a.x) - S.a) * 180) / Math.PI);
    const mf = this.maskOv.toFrame((a.x + b.x) / 2, (a.y + b.y) / 2);
    v[k + 'X'] = S.x + (mf.x - S.mf.x);
    v[k + 'Y'] = S.y + (mf.y - S.mf.y);
    const id = this.currentParam();
    if (id) this.showHud(id);
    this.layerOv.draw();
    this.requestRender();
  }

  private layerUp() {
    const changed = !!this.ld || !!this.dxStroke;
    this.ld = null;
    this.dxStroke = null;
    this.hideBrushRing();
    if (changed) {
      this.commit();
      this.refreshSection();
    }
  }

  private showLayerRing(e: PointerEvent) {
    const k = this.layerKey();
    if (!k) return;
    const ring = $('brushRing');
    const r = this.layerRadius(k) * this.maskOv.pxPerFrameH();
    const st = this.stage.getBoundingClientRect();
    ring.style.width = ring.style.height = r * 2 + 'px';
    ring.style.transform = `translate(${e.clientX - st.left - r}px, ${e.clientY - st.top - r}px)`;
    ring.classList.toggle('erase', this.dxMode === 'hide');
    ring.classList.add('on');
  }

  private buildLayerActs(k: 'dx' | 'lk') {
    const row = $('acts');
    const L = this.layerOf(k);
    if (k === 'dx') this.tile(row, ICONS.image, L ? 'Replace' : 'Choose', L ? '' : 'hot', () => this.pickOverlay());
    if (!L) return;
    const mode = (m: 'move' | 'hide' | 'show') => () => {
      this.dxMode = m;
      this.paramIdx[this.pkey()] = 0;
      this.refreshSection();
      this.layerOv.draw();
      if (m !== 'move') this.toast(m === 'hide' ? 'Paint over the parts to hide' : 'Paint to bring parts back', 1800);
    };
    if (k === 'dx') row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
    this.tile(row, ICONS.move, 'Move', this.dxMode === 'move' ? 'on' : '', mode('move'));
    this.tile(row, ICONS.erase, 'Hide', this.dxMode === 'hide' ? 'on' : '', mode('hide'));
    this.tile(row, ICONS.paint, 'Show', this.dxMode === 'show' ? 'on' : '', mode('show'));
    const sep = () => row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
    sep();
    this.tile(row, ICONS.mPeople, 'Person', L.person ? 'hot' : '', () => {
      L.person = !L.person;
      // the classic double exposure: the photo shows inside the person
      if (L.person && !L.strokes.length) L.invert = true;
      if (L.person) this.toast(L.invert ? 'Shows inside the person · Invert for outside' : 'Hidden over the person · Invert for inside', 2600);
      this.commit();
      this.refreshSection();
      this.requestRender();
    });
    this.tile(row, ICONS.invert, 'Invert', L.invert ? 'hot' : '', () => {
      L.invert = !L.invert;
      this.commit();
      this.refreshSection();
      this.requestRender();
    });
    if (L.strokes.length) {
      this.tile(row, ICONS.reset, 'Clear brush', '', () => {
        L.strokes = [];
        this.commit();
        this.refreshSection();
        this.requestRender();
      });
    }
    if (k === 'dx') {
      this.tile(row, ICONS.trash, 'Remove', 'danger', () => {
        this.state.overlay = null;
        this.commit();
        this.refreshSection();
        this.requestRender();
      });
    }
  }

  // ---- double exposure: the second photo

  private pickOverlay() {
    const input = $<HTMLInputElement>('fileOverlay');
    input.value = '';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void this.setOverlay(f);
    };
    input.click();
  }

  private async setOverlay(file: File) {
    this.busy('Adding photo');
    try {
      const id = Date.now().toString(36);
      const bmp = await this.overlayBitmap(file);
      await saveBlob('ov:' + id, file);
      const aspect = bmp.width / bmp.height;
      this.uploadOverlay(id, bmp);
      const v = this.state.v;
      v.dxX = 0.5;
      v.dxY = 0.5;
      v.dxScale = 100;
      v.dxRot = 0;
      this.state.overlay = { id, aspect, strokes: [] };
      this.dxMode = 'move';
      this.commit();
      this.refreshSection();
      this.layerOv.draw();
      this.requestRender();
      this.toast('Drag to move · corner square or pinch to scale · Hide brush paints it away', 3400);
    } catch (e) {
      this.toast('Couldn’t open that photo: ' + (e as Error).message, 4000);
    } finally {
      this.busy(null);
    }
  }

  /** Decode the second photo (JPEG/PNG/HEIC as the browser allows, or RAW) at up to 3072px. */
  private async overlayBitmap(blob: Blob): Promise<ImageBitmap> {
    const file = blob instanceof File ? blob : new File([blob], 'overlay');
    const L = await loadFile(file, Math.min(3072, this.g.maxTex), () => {});
    if (L.kind === 'bitmap') return L.bitmap;
    // RAW: linear 16-bit -> sRGB 8-bit
    const lut = new Uint8ClampedArray(4096);
    for (let i = 0; i < 4096; i++) {
      const l = i / 4095;
      lut[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055) * 255);
    }
    const px = new Uint8ClampedArray(L.w * L.h * 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      px[i] = lut[L.data[j] >> 4];
      px[i + 1] = lut[L.data[j + 1] >> 4];
      px[i + 2] = lut[L.data[j + 2] >> 4];
      px[i + 3] = 255;
    }
    return createImageBitmap(new ImageData(px, L.w, L.h));
  }

  private uploadOverlay(id: string, bmp: ImageBitmap) {
    const gl = this.g.gl;
    if (this.ovImg) gl.deleteTexture(this.ovImg.tex);
    const tex = this.g.texture(bmp.width, bmp.height, 'u8');
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    bmp.close();
    this.ovImg = { id, tex };
    this.pipe.invalidate();
  }

  private async loadOverlay(id: string) {
    this.ovLoading = id;
    try {
      const blob = await loadBlob('ov:' + id);
      if (!blob) throw new Error('missing');
      const bmp = await this.overlayBitmap(blob);
      if (this.state.overlay?.id === id) this.uploadOverlay(id, bmp);
      else bmp.close();
    } catch {
      this.toast('The double-exposure photo isn’t on this device any more', 3000);
    } finally {
      this.ovLoading = '';
      this.requestRender();
    }
  }

  // ---- light leaks

  private setLeak(id: string) {
    const keep = this.state.leak;
    this.state.leak = { id, aspect: LEAK_W / LEAK_H, strokes: keep?.strokes ?? [] };
    if (!keep) {
      const v = this.state.v;
      v.lkX = 0.5;
      v.lkY = 0.5;
      v.lkScale = 100;
      v.lkRot = 0;
    }
    this.commit();
    this.refreshSection();
    this.layerOv.draw();
    this.requestRender();
  }

  private leakTexture(id: string) {
    let tex = this.lkTex.get(id);
    if (!tex) {
      const gl = this.g.gl;
      const c = leakCanvas(id);
      tex = this.g.texture(c.width, c.height, 'u8');
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, c);
      this.lkTex.set(id, tex);
    }
    return tex;
  }

  private buildLeaks() {
    const row = $('subs');
    const cur = this.state.leak?.id;
    const off = document.createElement('button');
    off.className = 'look save';
    off.innerHTML = `<span class="th">${ICONS.off}</span><small>None</small>`;
    off.onclick = () => {
      tick();
      this.state.leak = null;
      this.commit();
      this.refreshSection();
      this.requestRender();
    };
    row.appendChild(off);
    for (const L of LEAKS) {
      const b = document.createElement('button');
      b.className = 'look' + (L.id === cur ? ' on' : '');
      const c = document.createElement('canvas');
      c.className = 'th';
      c.width = 132;
      c.height = 132;
      const x = c.getContext('2d')!;
      x.fillStyle = '#000';
      x.fillRect(0, 0, 132, 132);
      const src = leakCanvas(L.id);
      x.drawImage(src, (src.width - src.height) / 2, 0, src.height, src.height, 0, 0, 132, 132);
      b.appendChild(c);
      const label = document.createElement('small');
      label.textContent = L.name;
      b.appendChild(label);
      b.onclick = () => {
        tick();
        this.setLeak(L.id);
      };
      row.appendChild(b);
    }
  }

  /** Bring the GPU side (layers, their brush, the content-aware fill) in line with a state before rendering. */
  private syncOverlay(st: EditState) {
    const ov = st.overlay, lk = st.leak;
    if (ov && this.ovImg?.id !== ov.id && this.ovLoading !== ov.id) void this.loadOverlay(ov.id);
    this.pipe.overlay = ov && this.ovImg?.id === ov.id ? this.ovImg : null;
    this.pipe.leak = lk ? { id: lk.id, tex: this.leakTexture(lk.id) } : null;
    // a layer's mask: the person in the photo (AI, optional) plus its brush strokes
    const slot = (L: typeof ov, id: number) =>
      L?.person ? ({ id, type: 'subject', strokes: L.strokes, ai: { strokes: [], part: 0 } } as unknown as Mask)
      : L?.strokes.length ? ({ id, type: 'brush', strokes: L.strokes } as unknown as Mask)
      : ({ id: 0, type: 'radial', strokes: [] } as unknown as Mask);
    this.ovAtlas.sync([slot(ov, -1), slot(lk, -2)]);
    this.pipe.overlayMask = this.ovAtlas.tex[0];
    this.syncFill(st);
  }

  // ---- content-aware fill

  private fillKey(fills: NonNullable<EditState['fills']>) {
    return this.frameKey() + '|' + JSON.stringify(fills);
  }

  private syncFill(st: EditState) {
    const fills = st.fills ?? [];
    if (!fills.length || !this.img) {
      this.pipe.fill = null;
      return;
    }
    const key = this.fillKey(fills);
    const hit = this.fillCache.find((f) => f.key === key);
    if (hit) {
      this.pipe.fill = hit;
      return;
    }
    // keep showing the last result while the new one is being made
    this.pipe.fill = this.fillCache[this.fillCache.length - 1] ?? null;
    if (this.fillJob !== key) void this.computeFill(key, fills);
  }

  /** Resolves once the fill for this state is ready (export waits for it). */
  private async ensureFill(st: EditState) {
    const fills = st.fills ?? [];
    if (!fills.length) return;
    const key = this.fillKey(fills);
    if (this.fillCache.some((f) => f.key === key)) return;
    if (this.fillJob !== key) void this.computeFill(key, fills);
    await new Promise<void>((res) => this.fillWaiters.push(res));
    if (!this.fillCache.some((f) => f.key === key)) await this.ensureFill(st);
  }

  private async computeFill(key: string, fills: NonNullable<EditState['fills']>) {
    if (!this.img) return;
    this.fillJob = key;
    const img = this.img;
    try {
      this.busy('Filling');
      await new Promise((r) => setTimeout(r, 30));
      // the photo in frame space (turned, straightened, uncropped, no heals) in sRGB
      const st = { ...defaultState(), geo: { ...this.state.geo, crop: { x: 0, y: 0, w: 1, h: 1 } } };
      st.v.straighten = this.state.v.straighten;
      const { w: W, h: H } = outputSize(st, img.preview.w, img.preview.h);
      const rgba = new Uint8ClampedArray(this.pipe.renderPixels(img.preview, st, W, H).buffer);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      // what to remove: the painted strokes
      const mc = document.createElement('canvas');
      mc.width = W;
      mc.height = H;
      const mx = mc.getContext('2d')!;
      mx.fillStyle = '#000';
      mx.fillRect(0, 0, W, H);
      mx.strokeStyle = '#fff';
      mx.fillStyle = '#fff';
      mx.lineCap = mx.lineJoin = 'round';
      for (const f of fills) {
        mx.lineWidth = Math.max(2, f.r * H * 2);
        mx.beginPath();
        mx.moveTo(f.pts[0] * W, f.pts[1] * H);
        for (let i = 2; i < f.pts.length; i += 2) mx.lineTo(f.pts[i] * W, f.pts[i + 1] * H);
        if (f.pts.length <= 2) mx.lineTo(f.pts[0] * W + 0.01, f.pts[1] * H);
        mx.stroke();
      }
      const md = mx.getImageData(0, 0, W, H).data;
      const mask = new Uint8Array(W * H);
      for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4] > 127 ? 1 : 0;

      let out: Uint8ClampedArray | null = null;
      const first: NeuralKind = this.fillModel() === 'lama' ? 'lama' : 'migan';
      for (const kind of first === 'lama' ? (['lama', 'migan'] as const) : (['migan'] as const)) {
        try {
          // each attempt gets its own copies, so a failed one doesn't use up the pixels
          out = await this.neural.fill(kind, rgba.slice(), W, H, mask.slice(), (m) => this.busy(m));
          break;
        } catch (err) {
          console.warn(`${kind} fill failed`, err);
          if (kind === 'lama') this.toast(`LaMa couldn’t run (${(err as Error).message}) — using the built-in model`, 4500);
        }
      }
      if (!out) {
        this.toast('The AI models couldn’t run here, so the classic fill was used', 3500);
        this.busy('Filling');
        out = await new Promise<Uint8ClampedArray>((res, rej) => {
          const wk = new Worker(new URL('../ai/inpaintWorker.ts', import.meta.url), { type: 'module' });
          wk.onmessage = (e) => {
            if (e.data.progress !== undefined) this.busy(`Filling ${Math.round(e.data.progress * 100)}%`);
            else if (e.data.done) {
              res(e.data.done);
              wk.terminate();
            } else if (e.data.error) {
              rej(new Error(e.data.error));
              wk.terminate();
            }
          };
          wk.onerror = (e) => {
            rej(new Error(e.message || 'Fill failed'));
            wk.terminate();
          };
          wk.postMessage({ rgba, w: W, h: H, mask }, [rgba.buffer]);
        });
      }
      if (this.img !== img) return;
      const gl = this.g.gl;
      const tex = this.g.texture(W, H, 'u8');
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
      this.fillCache.push({ key, tex });
      while (this.fillCache.length > 4) gl.deleteTexture(this.fillCache.shift()!.tex);
      this.pipe.invalidate();
    } catch (e) {
      console.error(e);
      this.toast('Fill failed: ' + ((e as Error).message || 'unknown error'), 4000);
      this.state.fills = (this.state.fills ?? []).filter((f) => fills.some((q) => q === f) === false);
    } finally {
      this.fillJob = '';
      this.busy(null);
      const w = this.fillWaiters.splice(0);
      w.forEach((r) => r());
      this.requestRender();
    }
  }

  // -----------------------------------------------------------------------------------
  // Back gesture (Android): back leaves a section without keeping its changes, or closes a sheet

  private bindBack() {
    // the Android app asks this first when you swipe back: true = handled inside the editor
    (window as unknown as { lumenBack: () => boolean }).lumenBack = () => this.goBack();
    // in the browser, one guard history entry stands in for "there's somewhere to go back to"
    window.addEventListener('popstate', () => {
      if (this.goBack()) this.syncGuard();
    });
    document.querySelectorAll<HTMLElement>('.sheet').forEach((el) => {
      new MutationObserver(() => this.syncGuard()).observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /** One step back: camera, sheet, picker, tool grid, section (dropping its changes), then home. */
  goBack(): boolean {
    if (this.camera.isOpen()) {
      this.camera.close();
      return true;
    }
    const sheet = document.querySelector('.sheet.on');
    if (sheet) {
      sheet.classList.remove('on');
      return true;
    }
    if (this.menuTap) {
      this.showMenu(false);
      return true;
    }
    if (this.allOpen) {
      this.showAll(false);
      return true;
    }
    if (this.tool) {
      this.cancelSection();
      return true;
    }
    if (this.homeOver) {
      if (!this.homeFromButton) return false; // home reached by going back: next back leaves
      this.showHome(false);
      return true;
    }
    if (this.img) {
      this.showHome(true);
      return true;
    }
    return false;
  }

  private canGoBack() {
    return this.camera.isOpen() || !!document.querySelector('.sheet.on') || this.allOpen || !!this.tool ||
      (this.homeOver ? this.homeFromButton : !!this.img);
  }

  /** Browser only: keep exactly one guard entry while back has something to do. */
  private syncGuard() {
    if (isNative) return;
    if (this.canGoBack() && history.state?.lumen !== 'guard') history.pushState({ lumen: 'guard' }, '');
  }

  /** ✓: keep the changes and go back to the tool bar. */
  private closeSection() {
    this.setMode(null);
  }

  /** Back: drop this section's changes. */
  private cancelSection() {
    if (this.tool?.kind === 'video') return this.setMode(null);
    if (this.sectionStart) {
      const before = JSON.parse(this.sectionStart) as EditState;
      if (this.video) before.video = this.state.video;
      const changed = JSON.stringify(before) !== JSON.stringify(this.state);
      this.state = before;
      this.maskSel = Math.min(this.maskSel, this.state.masks.length - 1);
      this.syncAtlasSize();
      if (changed) this.toast('Changes discarded', 1200);
    }
    this.look.base = null;
    this.look.idx = -1;
    this.setMode(null);
    this.requestRender();
  }

  // -----------------------------------------------------------------------------------
  // Actions + section reset

  private action(id: string) {
    const v = this.state.v;
    const g = this.state.geo;
    const setMany = (o: Record<string, number>) => Object.assign(v, o);
    const [kind, arg] = id.split(':');
    switch (kind) {
      case 'grain':
        setMany({
          fine: { grain: 20, grainSize: 12, grainRough: 25, grainColor: 0, grainShadows: 60, grainHighlights: 30 },
          '400': { grain: 35, grainSize: 30, grainRough: 45, grainColor: 10, grainShadows: 70, grainHighlights: 35 },
          '3200': { grain: 62, grainSize: 55, grainRough: 82, grainColor: 0, grainShadows: 90, grainHighlights: 50 },
          s8: { grain: 72, grainSize: 78, grainRough: 70, grainColor: 35, grainShadows: 80, grainHighlights: 60 },
          color: { grain: 38, grainSize: 36, grainRough: 50, grainColor: 75, grainShadows: 75, grainHighlights: 40 },
        }[arg]!);
        break;
      case 'hal':
        setMany({
          subtle: { halation: 25, halThreshold: 70, halRadius: 25, halHue: 10, halSat: 80 },
          cine: { halation: 70, halThreshold: 55, halRadius: 40, halHue: 2, halSat: 95 },
          dream: { halation: 55, halThreshold: 45, halRadius: 70, halHue: 18, halSat: 70, glow: 20 },
        }[arg]!);
        break;
      case 'curve': {
        const presets: Record<string, CurvePoint[]> = {
          linear: LINEAR,
          s: [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]],
          strong: [[0, 0], [0.22, 0.13], [0.5, 0.5], [0.78, 0.88], [1, 1]],
          fade: [[0, 0.08], [0.3, 0.3], [0.75, 0.76], [1, 0.95]],
          film: [[0, 0.05], [0.2, 0.17], [0.5, 0.52], [0.8, 0.84], [1, 0.96]],
        };
        const ch = (this.sub.curves ?? 'rgb') as keyof Curves;
        this.state.curves[ch] = presets[arg].map((p) => [...p] as CurvePoint);
        this.curve.draw();
        break;
      }
      case 'rot':
        this.transformMasks('rot');
        g.quarter = (g.quarter + 1) % 4;
        g.crop = fitAspect(this.aspectNorm());
        this.syncAtlasSize();
        break;
      case 'flipH':
        this.transformMasks('flipH');
        g.flipH = !g.flipH;
        break;
      case 'flipV':
        this.transformMasks('flipV');
        g.flipV = !g.flipV;
        break;
    }
    this.commit();
    this.requestRender();
    this.refreshSection();
  }

  private resetSection() {
    const t = this.tool;
    if (!t) return;
    const v = this.state.v;
    const g = this.state.geo;
    switch (t.kind) {
      case 'looks':
        if (this.look.base) {
          const geo = this.state.geo;
          const masks = this.state.masks;
          this.state = cloneState(this.look.base);
          this.state.geo = geo;
          this.state.masks = masks;
        }
        this.look.idx = 0;
        break;
      case 'masks':
        this.state.masks = [];
        this.maskSel = -1;
        break;
      case 'heal':
        this.state.spots = [];
        this.state.fills = [];
        this.spotSel = -1;
        break;
      case 'double':
        this.state.overlay = null;
        for (const p of ['dxOpacity', 'dxScale', 'dxRot', 'dxBlend', 'dxX', 'dxY']) v[p] = PARAM_MAP[p].def;
        break;
      case 'leak':
        this.state.leak = null;
        for (const p of ['lkOpacity', 'lkScale', 'lkRot', 'lkBlend', 'lkX', 'lkY']) v[p] = PARAM_MAP[p].def;
        break;
      case 'curves':
        this.state.curves = defaultState().curves;
        break;
      case 'crop':
        if (g.flipH) this.transformMasks('flipH');
        if (g.flipV) this.transformMasks('flipV');
        for (let q = g.quarter; q % 4 !== 0; q++) this.transformMasks('rot');
        this.state.geo = defaultState().geo;
        v.straighten = 0;
        this.aspectId = 'free';
        this.syncAtlasSize();
        break;
      case 'blur':
        for (const p of ['blurType', 'blurAmt', 'blurSize', 'blurFeather', 'blurAngle', 'blurX', 'blurY']) v[p] = PARAM_MAP[p].def;
        break;
      default: {
        const subs = t.subs ? t.subs.map((x) => x.id) : [''];
        for (const sub of subs) for (const p of t.params(sub)) v[p] = PARAM_MAP[p].def;
        if (t.id === 'vignette') v.vigX = v.vigY = 0.5;
      }
    }
    this.commit();
    this.requestRender();
    this.refreshSection();
    this.toast(`${t.label} reset`, 1200);
  }

  private aspectNorm(): number | null {
    const a = ASPECTS[this.aspectId];
    if (!a || !this.img) return null;
    const f = frameSize(this.state.geo, this.img.full.w, this.img.full.h);
    const ratio = a === -1 ? f.w / f.h : a;
    return (ratio * f.h) / f.w;
  }

  private setAspect(id: string) {
    this.aspectId = id;
    const a = this.aspectNorm();
    if (a) this.state.geo.crop = fitAspect(a);
    this.commit();
    this.crop.update();
    this.requestRender();
  }

  // -----------------------------------------------------------------------------------
  // Looks + presets

  private allLooks(): (Look & { user?: boolean })[] {
    return [...LOOKS, ...this.userLooks().map((l) => ({ ...l, user: true }))];
  }
  private userLooks(): Look[] {
    try {
      return JSON.parse(localStorage.getItem('lumen.looks') || '[]');
    } catch {
      return [];
    }
  }
  private setUserLooks(l: Look[]) {
    try {
      localStorage.setItem('lumen.looks', JSON.stringify(l));
    } catch {
      this.toast('Could not save presets on this device');
    }
  }

  /** Brightness / color measurements of the photo as edited so far (for adaptive looks). */
  private statsCache: { key: string; s: ImgStats } | null = null;
  private photoStats(base: EditState): ImgStats {
    const img = this.img!;
    const key = JSON.stringify([img.name, base.v, base.curves, base.geo]);
    if (this.statsCache?.key !== key) {
      const { w, h } = outputSize(base, img.thumb.w, img.thumb.h);
      this.statsCache = { key, s: measure(this.pipe.renderPixels(img.thumb, base, w, h)) };
    }
    return this.statsCache.s;
  }

  /** A look's settings for this photo: adaptive looks look at it first. */
  private resolveLook(base: EditState, L: Look): Look {
    if (!L.auto || !this.img) return L;
    return { ...L, ...L.auto(this.photoStats(base)) };
  }

  private lookState(base: EditState, L0: Look, t: number): EditState {
    const L = this.resolveLook(base, L0);
    const s = cloneState(base);
    for (const [k, val] of Object.entries(L.v)) {
      if (!(k in s.v)) continue;
      s.v[k] = base.v[k] + (val - base.v[k]) * t;
    }
    for (const [ch, pts] of Object.entries(L.curves ?? {}) as [keyof Curves, CurvePoint[]][]) {
      const f = makeSpline(base.curves[ch]);
      s.curves[ch] = pts.map(([x, y]) => [x, f(x) + (y - f(x)) * t]);
    }
    return s;
  }

  private applyLookValues() {
    const L = this.allLooks()[this.look.idx];
    if (!L || !this.look.base) return;
    const geo = this.state.geo;
    const straighten = this.state.v.straighten;
    const masks = this.state.masks;
    this.state = this.lookState(this.look.base, L, this.look.amt / 100);
    this.state.geo = geo;
    this.state.masks = masks;
    this.state.v.straighten = straighten;
  }

  private buildLooks() {
    if (!this.img) return;
    const row = $('subs');
    const base = this.look.base ?? this.state;
    const looks = this.allLooks();
    const img = this.img;
    const save = document.createElement('button');
    save.className = 'look save';
    save.innerHTML = `<span class="th">${ICONS.plus}</span><small>Save</small>`;
    save.onclick = () => {
      tick();
      this.openPresetSheet();
    };
    row.appendChild(save);
    const canvases: HTMLCanvasElement[] = [];
    looks.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'look' + (i === this.look.idx ? ' on' : '') + (L.user ? ' user' : '');
      const c = document.createElement('canvas');
      c.className = 'th';
      canvases.push(c);
      b.appendChild(c);
      const label = document.createElement('small');
      label.textContent = L.name;
      b.appendChild(label);
      let press = 0;
      let long = false;
      b.onpointerdown = () => {
        long = false;
        if (L.user) {
          press = window.setTimeout(() => {
            long = true;
            tick(true);
            this.confirm(`Delete “${L.name}”?`, 'This removes the preset from this device.', () => {
              const u = this.userLooks();
              u.splice(i - LOOKS.length, 1);
              this.setUserLooks(u);
              if (this.look.idx === i) this.look.idx = 0;
              this.thumbsKey = '';
              this.refreshSection();
            });
          }, 550);
        }
      };
      b.onpointerup = b.onpointerleave = () => clearTimeout(press);
      b.onclick = () => {
        if (long) return;
        tick();
        if (!this.look.base) this.look.base = cloneState(this.state);
        if (this.look.idx !== i) this.look.amt = 100;
        this.look.idx = i;
        this.paramIdx.looks = 0;
        this.applyLookValues();
        this.commit();
        this.requestRender();
        this.refreshSection();
      };
      row.appendChild(b);
    });
    // thumbnails render progressively and are cached between rebuilds
    const key = JSON.stringify([base.v, base.curves, base.geo, looks.length, img.name]);
    if (key !== this.thumbsKey) {
      this.thumbsKey = key;
      this.thumbCache = [];
    }
    let i = 0;
    const step = () => {
      if (this.thumbsKey !== key || i >= looks.length || this.img !== img || this.kind() !== 'looks') return;
      let data = this.thumbCache[i];
      if (!data) {
        const st = this.lookState(base, looks[i], 1);
        const { w, h } = outputSize(st, img.thumb.w, img.thumb.h);
        data = new ImageData(new Uint8ClampedArray(this.pipe.renderPixels(img.thumb, st, w, h).buffer), w, h);
        this.thumbCache[i] = data;
      }
      const c = canvases[i];
      if (c && c.isConnected) {
        c.width = data.width;
        c.height = data.height;
        c.getContext('2d')!.putImageData(data, 0, 0);
      }
      i++;
      if (this.thumbCache[i]) step();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private bindPresets() {
    const sheet = $('presetSheet');
    const input = $<HTMLInputElement>('presetName');
    $('presetCancel').onclick = () => sheet.classList.remove('on');
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
    $('presetSave').onclick = () => {
      const name = input.value.trim() || `Preset ${this.userLooks().length + 1}`;
      const d = defaultValues();
      const v: Record<string, number> = {};
      for (const [k, x] of Object.entries(this.state.v)) {
        if (!['straighten', 'distortion', 'blurX', 'blurY', 'vigX', 'vigY'].includes(k) && !k.startsWith('dx') && x !== d[k]) v[k] = x;
      }
      const looks = this.userLooks();
      looks.push({ name, v, curves: this.state.curves });
      this.setUserLooks(looks);
      sheet.classList.remove('on');
      this.thumbsKey = '';
      tick(true);
      this.toast(`Saved “${name}” · find it in Looks`);
      if (this.kind() === 'looks') this.refreshSection();
    };
  }

  private openPresetSheet() {
    if (!this.img) return;
    const input = $<HTMLInputElement>('presetName');
    input.value = '';
    $('presetSheet').classList.add('on');
    setTimeout(() => input.focus(), 250);
  }

  private confirm(title: string, text: string, yes: () => void, o: { yes?: string; no?: string; onNo?: () => void } = {}) {
    const sheet = $('confirmSheet');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmYes').textContent = o.yes ?? 'Delete';
    $('confirmNo').textContent = o.no ?? 'Cancel';
    sheet.classList.add('on');
    $('confirmNo').onclick = () => {
      sheet.classList.remove('on');
      o.onNo?.();
    };
    $('confirmYes').onclick = () => {
      sheet.classList.remove('on');
      yes();
    };
  }

  // ---- which model does AI fill use? LaMa (best, downloaded once) or the small built-in one

  private fillModel(): NeuralKind | null {
    try {
      const v = localStorage.getItem('lumen.fillModel');
      return v === 'lama' || v === 'migan' ? v : null;
    } catch {
      return null;
    }
  }
  private setFillModel(k: NeuralKind) {
    try {
      localStorage.setItem('lumen.fillModel', k);
    } catch {
      /* not saved */
    }
    this.renderFillModel();
  }
  private renderFillModel() {
    const k = this.fillModel();
    const el = $('fillModelState');
    el.textContent = k === 'lama' ? 'LaMa' : k === 'migan' ? 'Built-in' : 'Ask';
    el.classList.toggle('on', k === 'lama');
  }
  private askFillModel() {
    if (this.fillModel()) return;
    this.confirm(
      'Use LaMa for AI fill?',
      `LaMa gives the best results. It needs a one-time ${LAMA_MB} MB download, then works offline. Otherwise a smaller built-in model is used (you can switch in the ⋯ menu).`,
      () => this.setFillModel('lama'),
      { yes: 'Use LaMa', no: 'Built-in', onNo: () => this.setFillModel('migan') },
    );
  }

  // -----------------------------------------------------------------------------------
  // More menu

  private bindMore() {
    const sheet = $('moreSheet');
    const setState = (id: string, on: boolean) => {
      const el = $(id);
      el.textContent = on ? 'On' : 'Off';
      el.classList.toggle('on', on);
    };
    if (isNative || !/Android/i.test(navigator.userAgent)) $('getApp').style.display = 'none';
    this.renderFillModel();
    $('btnMore').onclick = () => sheet.classList.add('on');
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
    sheet.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        sheet.classList.remove('on');
        const a = b.dataset.a;
        if (a === 'open') return this.pickPhoto();
        if (a === 'camera') return this.takePhoto();
        if (a === 'aimodel') {
          const next: NeuralKind = this.fillModel() === 'lama' ? 'migan' : 'lama';
          this.setFillModel(next);
          this.toast(next === 'lama' ? `AI fill uses LaMa (one-time ${LAMA_MB} MB download on first use)` : 'AI fill uses the small built-in model', 3200);
          return;
        }
        if (a === 'getApp') {
          const a2 = document.createElement('a');
          a2.href = 'lumen.apk';
          a2.download = 'Lumen.apk';
          document.body.appendChild(a2);
          a2.click();
          a2.remove();
          this.toast('Downloading Lumen.apk — open it when it finishes to install');
          return;
        }
        if (a === 'hist') {
          this.showHist = !this.showHist;
          $('hist').classList.toggle('on', this.showHist);
          setState('histState', this.showHist);
          if (this.showHist) this.scheduleHist();
          return;
        }
        if (a === 'clip') {
          this.pipe.clip = !this.pipe.clip;
          setState('clipState', this.pipe.clip);
          this.requestRender();
          if (this.pipe.clip) this.toast('Blown highlights show orange, crushed shadows cyan');
          return;
        }
        if (!this.img) return;
        if (a === 'copy') {
          localStorage.setItem('lumen.clipboard', JSON.stringify({ v: this.state.v, curves: this.state.curves }));
          this.toast('Edits copied');
        } else if (a === 'paste') {
          const raw = localStorage.getItem('lumen.clipboard');
          if (!raw) return this.toast('Nothing copied yet');
          const c = JSON.parse(raw);
          const straighten = this.state.v.straighten;
          this.state.v = { ...defaultValues(), ...c.v, straighten };
          this.state.curves = c.curves;
          this.commit();
          this.requestRender();
          this.refreshSection();
          this.toast('Edits pasted');
        } else if (a === 'savePreset') {
          this.openPresetSheet();
        } else if (a === 'resetAll') {
          this.confirm('Reset all edits?', 'You can still undo this.', () => {
            this.state = defaultState();
            this.maskSel = -1;
            this.aspectId = 'free';
            this.look = { base: null, idx: -1, amt: 100 };
            this.syncAtlasSize();
            this.commit();
            this.requestRender();
            this.refreshSection();
          });
        }
      };
    });
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.img || /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.restore(this.hIdx + (e.shiftKey ? 1 : -1));
        return;
      }
      if (e.key === '\\') return this.setCompare(!this.compare);
      if (e.key === ' ' && this.video && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        e.preventDefault();
        return this.video.togglePlay();
      }
      if (e.key === 'Escape' && this.tool) return this.setMode(null);
      if (e.key === 'h') return this.toggleUI();
      const id = this.currentParam();
      if (!id) return;
      const d = this.def(id);
      const n = this.params().length;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.paramIdx[this.pkey()] = Math.max(0, Math.min(n - 1, (this.paramIdx[this.pkey()] ?? 0) + (e.key === 'ArrowUp' ? -1 : 1)));
        this.updateSecBar();
        this.showHud(this.currentParam()!);
        this.hideHudSoon();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = ((d.max - d.min) / 200) * (e.shiftKey ? 10 : 1);
        this.set(id, this.get(id) + (e.key === 'ArrowRight' ? step : -step));
        this.updateSecBar();
        this.showHud(id);
        this.hideHudSoon();
        this.commit();
      }
    });
  }

  // -----------------------------------------------------------------------------------
  // Export

  private exportOpts = { size: 'full', format: 'jpeg' as 'jpeg' | 'png', quality: 100 };

  private bindExport() {
    const sheet = $('sheet');
    $('btnExport').onclick = () => {
      if (!this.img) return;
      if (this.video) return this.video.openExport();
      this.buildExportSizes();
      sheet.classList.add('on');
    };
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
    $('exCancel').onclick = () => sheet.classList.remove('on');
    $('exFormat').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        this.exportOpts.format = b.dataset.v as 'jpeg' | 'png';
        $('exFormat').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        this.buildExportSizes();
      };
    });
    const q = $<HTMLInputElement>('exQuality');
    q.oninput = () => {
      this.exportOpts.quality = +q.value;
      $('exQVal').textContent = q.value;
      this.scheduleEstimate();
    };
    $('exGo').onclick = () => this.doExport();
    $('resultDone').onclick = () => $('resultSheet').classList.remove('on');
  }

  private exportDims(size: string) {
    const img = this.img!;
    const full = outputSize(this.state, img.full.w, img.full.h);
    const long = Math.max(full.w, full.h);
    const target = size === 'full' ? long : +size;
    let k = Math.min(1, target / long);
    return { w: Math.max(1, Math.round(full.w * k)), h: Math.max(1, Math.round(full.h * k)), k };
  }

  private buildExportSizes() {
    const box = $('exSize');
    box.innerHTML = '';
    const img = this.img!;
    const full = outputSize(this.state, img.full.w, img.full.h);
    const long = Math.max(full.w, full.h);
    const opts = [['full', 'Full'], ['4096', '4K'], ['2048', 'Large'], ['1080', 'Social']].filter(([v]) => v === 'full' || +v < long);
    if (!opts.some(([v]) => v === this.exportOpts.size)) this.exportOpts.size = 'full';
    for (const [v, label] of opts) {
      const d = this.exportDims(v);
      const b = document.createElement('button');
      b.innerHTML = `${label}<small>${d.w}×${d.h}</small>`;
      b.classList.toggle('on', v === this.exportOpts.size);
      b.onclick = () => {
        this.exportOpts.size = v;
        this.buildExportSizes();
      };
      box.appendChild(b);
    }
    const isPng = this.exportOpts.format === 'png';
    $('exQLabel').style.display = isPng ? 'none' : '';
    $<HTMLInputElement>('exQuality').style.display = isPng ? 'none' : '';
    const d = this.exportDims(this.exportOpts.size);
    this.exMP = `${((d.w * d.h) / 1e6).toFixed(1)} MP`;
    $('exHint').textContent = `${this.exMP} · working out the file size…`;
    this.scheduleEstimate();
    ($('exGo') as HTMLButtonElement).textContent = framed ? 'Export' : /iPhone|iPad|Android/i.test(navigator.userAgent) ? 'Save' : 'Download';
  }

  // ---- file size estimate: eight thin strips across the full width, rendered at the export
  // size and encoded with the export's own encoder; their bytes per pixel × the picture's
  // pixels. Within about 1% on real photos in tests.

  private exMP = '';
  private estTimer = 0;
  private estSamples: { key: string; tiles: { px: Uint8Array; prev: Uint8Array; w: number; h: number }[]; area: number } | null = null;
  private scheduleEstimate() {
    clearTimeout(this.estTimer);
    this.estTimer = window.setTimeout(() => void this.estimateSize(), 120);
  }
  private async estimateSize() {
    if (!this.img || !$('sheet').classList.contains('on')) return;
    const d = this.exportDims(this.exportOpts.size);
    const key = JSON.stringify([d.w, d.h, this.img.name, this.history[this.hIdx] ?? '']);
    try {
      if (this.estSamples?.key !== key) {
        this.atlas.sync(this.state.masks);
        this.pipe.brushTex = this.atlas.tex;
        await this.ensureFill(this.state);
        this.syncOverlay(this.state);
        const N = 8, R = Math.min(32, Math.max(1, Math.floor(d.h / N) - 1)), TW = 2048;
        // each strip: R rows plus the row above (PNG filters against it); wide strips in pieces.
        // Strips start on a multiple of 16 rows: a photo that was a JPEG still carries its 8×8
        // (or 16×16) block grid, and an offset strip encodes noticeably bigger or smaller.
        const rs = [];
        for (let j = 0; j < N; j++) {
          const y0 = Math.round((((j + 0.5) / N) * d.h - R / 2) / 16) * 16;
          const y = Math.max(0, Math.min(d.h - R - 1, y0 - 1));
          for (let x = 0; x < d.w; x += TW) rs.push({ x, y, w: Math.min(TW, d.w - x), h: R + 1 });
        }
        const px = this.pipe.renderSamples(this.img.full, this.img.preview, this.state, d.w, d.h, rs);
        const tiles = [];
        for (let j = 0, k = 0; j < N; j++) {
          const strip = new Uint8Array(d.w * (R + 1) * 4);
          for (; k < rs.length && rs[k].y === rs[j * Math.ceil(d.w / TW)].y && k < (j + 1) * Math.ceil(d.w / TW); k++) {
            const t = rs[k], src = px[k];
            for (let r = 0; r <= R; r++) strip.set(src.subarray(r * t.w * 4, (r + 1) * t.w * 4), (r * d.w + t.x) * 4);
          }
          tiles.push({ prev: strip.subarray(0, d.w * 4), px: strip.subarray(d.w * 4), w: d.w, h: R });
        }
        this.estSamples = { key, tiles, area: d.w * d.h };
      }
      const S = this.estSamples;
      const png = this.exportOpts.format === 'png';
      let bytes = 0, n = 0;
      for (const t of S.tiles) {
        bytes += png ? encodePngBand(t.px, t.w, t.h, t.prev, 2).idat.length : encodeJpegBand(t.px, t.w, t.h, 0, t.h, this.exportOpts.quality).length;
        n += t.w * t.h;
      }
      const est = (bytes / n) * S.area + (png ? 100 : 700);
      const mb = est / 1048576;
      const txt = mb >= 1 ? `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` : `${Math.max(1, Math.round(est / 1024))} KB`;
      $('exHint').textContent = `${this.exMP} · about ${txt}`;
    } catch (e) {
      console.warn('size estimate failed', e);
      $('exHint').textContent = `${this.exMP} · every edit applied at full quality`;
    }
  }

  private async doExport() {
    if (!this.img) return;
    $('sheet').classList.remove('on');
    const img = this.img;
    const d = this.exportDims(this.exportOpts.size);
    this.busy('Exporting 0%');
    let tmp: Target | null = null;
    try {
      let full = img.full;
      if (d.k < 0.5) {
        const kk = Math.min(1, d.k * 1.5);
        tmp = this.pipe.resize(img.full, Math.round(img.full.w * kk), Math.round(img.full.h * kk));
        full = { tex: tmp.tex, w: tmp.w, h: tmp.h, linear: img.full.linear };
      }
      this.atlas.sync(this.state.masks);
      this.pipe.brushTex = this.atlas.tex;
      await this.ensureFill(this.state);
      this.syncOverlay(this.state);
      const blob = await renderExport({
        pipeline: this.pipe, full, analysis: img.preview, state: this.state, w: d.w, h: d.h,
        format: this.exportOpts.format, quality: this.exportOpts.quality,
        // rendering and encoding run together (the encoders work while the GPU renders)
        progress: (f) => this.busy(`Exporting ${Math.round(f * 100)}%`),
      });
      if (tmp) {
        this.g.destroy(tmp);
        tmp = null;
      }
      const name = `${img.name.replace(/\.[^.]+$/, '')}-lumen.${this.exportOpts.format === 'png' ? 'png' : 'jpg'}`;
      this.busy('Saving 0%');
      const how = await saveOrShare(blob, name, (f) => this.busy(`Saving ${Math.round(f * 100)}%`));
      this.busy(null);
      if (how === 'shown') this.showResult(blob);
      else if (how === 'gallery') this.toast('Saved to your gallery · Pictures/Lumen', 2600);
      else if (how === 'shared') this.toast('Shared');
      else this.toast(/Android/i.test(navigator.userAgent) ? `Saved to your phone · Downloads/${name}` : `Saved ${name}`, 3200);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error(e);
        this.toast('Export failed: ' + (e as Error).message, 5000);
      }
    } finally {
      if (tmp) this.g.destroy(tmp);
      this.busy(null);
      this.pipe.invalidate();
      this.requestRender();
    }
  }

  private resultUrl = '';
  private showResult(blob: Blob) {
    if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
    this.resultUrl = URL.createObjectURL(blob);
    $<HTMLImageElement>('resultImg').src = this.resultUrl;
    $('resultSheet').classList.add('on');
  }

  // -----------------------------------------------------------------------------------
  // Feedback

  /** The busy screen. A percentage in the message drives the rising sun; without one it shimmers. */
  private busyRows: SVGElement[] = [];
  private busy(msg: string | null) {
    const b = $('busy');
    b.classList.toggle('on', !!msg);
    if (!msg) return;
    (b.querySelector('.msg') as HTMLElement).textContent = msg;
    if (!this.busyRows.length) this.busyRows = [...b.querySelectorAll<SVGElement>('.sun .s')];
    const m = /(\d+)%/.exec(msg);
    b.classList.toggle('ind', !m);
    const rows = this.busyRows;
    const n = Math.max(...rows.map((r) => +r.style.getPropertyValue('--i'))) + 1;
    // rows lit from the bottom up; the row being worked on blinks
    const lit = m ? Math.min(n, Math.floor((+m[1] / 100) * n + 0.0001)) : 0;
    for (const r of rows) {
      const i = +r.style.getPropertyValue('--i');
      r.classList.toggle('lit', !!m && i <= lit);
      r.classList.toggle('top', !!m && i === Math.min(lit, n - 1));
    }
  }

  private toastTimer = 0;
  toast(msg: string, ms = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('on'), ms);
  }
}

/** The pointer samples merged into this event (Android delivers several per frame). */
function coalesced(e: PointerEvent): PointerEvent[] {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

/** What changed on the timeline, in a word or two. */
function videoChange(a: NonNullable<EditState['video']>, b: NonNullable<EditState['video']>): string {
  const j = (x: unknown) => JSON.stringify(x);
  if (b.clips.length > a.clips.length) {
    const fresh = b.clips.filter((c) => !a.clips.some((x) => x.id === c.id));
    if (fresh.length === 1) {
      const n = fresh[0];
      // a split: the new clip starts where an existing clip of the same source now ends
      if (b.clips.some((c) => c.id !== n.id && c.src === n.src && Math.abs(c.out - n.in) < 1e-6)) return 'Split';
      if (b.clips.some((c) => c.id !== n.id && c.src === n.src && c.in === n.in && c.out === n.out)) return 'Copy';
    }
    return fresh.length > 1 ? 'Clips added' : 'Clip added';
  }
  if (b.clips.length < a.clips.length) {
    // undoing a split or copy reads as that, not as a deletion
    const r = videoChange(b, a);
    return r === 'Split' || r === 'Copy' ? r : 'Clip deleted';
  }
  if (j(a.clips.map((c) => c.id)) !== j(b.clips.map((c) => c.id))) return 'Clips moved';
  for (let i = 0; i < b.clips.length; i++) {
    const x = a.clips[i], y = b.clips[i];
    if (x.speed !== y.speed) return 'Speed';
    if (x.vol !== y.vol) return y.vol === 0 ? 'Mute' : 'Volume';
    if (x.in !== y.in || x.out !== y.out) return 'Trim';
  }
  if (j(a.texts) !== j(b.texts)) return b.texts.length > a.texts.length ? 'Text added' : b.texts.length < a.texts.length ? 'Text deleted' : 'Text';
  if (j(a.music) !== j(b.music)) return !a.music ? 'Music added' : !b.music ? 'Music removed' : 'Music';
  return 'Canvas';
}

/** A short name for what differs between two saved states (for the undo badge and history). */
function describeChange(a: string, b: string): string {
  try {
    const A = JSON.parse(a) as EditState, B = JSON.parse(b) as EditState;
    const toolFor = (id: string) => {
      if (id.startsWith('dx')) return 'Double';
      if (id.startsWith('lk')) return 'Leaks';
      if (id.startsWith('blur')) return 'Blur';
      const t = TOOLS.find((x) => x.kind === 'params' && (x.subs ? x.subs.some((s) => x.params(s.id).includes(id)) : x.params('').includes(id)));
      return t?.label ?? '';
    };
    const ids = Object.keys(B.v).filter((k) => A.v[k] !== B.v[k] && !['healSize', 'vigX', 'vigY', 'blurX', 'blurY'].includes(k));
    const tools = [...new Set(ids.map(toolFor).filter(Boolean))];
    const other = () => {
      const j = (x: unknown) => JSON.stringify(x);
      if (j(A.fills) !== j(B.fills)) return (B.fills?.length ?? 0) > (A.fills?.length ?? 0) ? 'AI fill' : 'Fill removed';
      if (j(A.spots) !== j(B.spots)) return 'Remove';
      if (j(A.masks) !== j(B.masks)) return 'Mask';
      if (j(A.curves) !== j(B.curves)) return 'Curves';
      if (j(A.geo) !== j(B.geo)) return 'Crop';
      if (j(A.overlay) !== j(B.overlay)) return 'Double';
      if (j(A.leak) !== j(B.leak)) return 'Leak';
      if (A.video && B.video && j(A.video) !== j(B.video)) return videoChange(A.video, B.video);
      return '';
    };
    if (ids.length === 1) {
      const lab = PARAM_MAP[ids[0]]?.label ?? '';
      return tools[0] && tools[0] !== lab ? `${tools[0]} · ${lab}` : lab;
    }
    if (tools.length === 1) return tools[0];
    if (tools.length > 1) return ids.length > 8 ? 'Look' : tools.slice(0, 2).join(' + ');
    return other();
  } catch {
    /* fall through */
  }
  return '';
}

function wrap180(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function wrap90(deg: number) {
  return ((((deg + 90) % 180) + 180) % 180) - 90;
}

function escapeHtml(t: string) {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function rgbCss(c: number[]) {
  return `rgb(${c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)).join(',')})`;
}
