import { GL, Target } from '../gl/glutil';
import { Pipeline, Source, frameSize, outputSize, wbMul } from '../gl/pipeline';
import { BrushAtlas } from '../gl/brushAtlas';
import {
  EditState, PARAM_MAP, ParamDef, CurvePoint, Curves, cloneState, defaultState, defaultValues, LINEAR, plain,
  Mask, MaskType, MASK_ADJ, MASK_SETTINGS, MASK_TYPE_SETTINGS, MASK_LABEL, MAX_MASKS, Stroke, Spot, MAX_SPOTS,
} from '../params';
import { makeSpline } from '../curves';
import { LOOKS, Look } from '../presets';
import { loadFile, RAW_EXT } from '../io/loader';
import { CANVAS_LIMIT, framed, renderExport, saveOrShare } from '../io/export';
import { loadSession, saveFile, saveState } from '../io/session';
import { TOOLS, ToolDef, Chip } from './tools';
import { ICONS } from './icons';
import { CurveEditor } from './curveEditor';
import { CropOverlay, fitAspect } from './cropOverlay';
import { MaskOverlay } from './maskOverlay';
import { BlurOverlay } from './blurOverlay';
import { Loupe } from './loupe';
import { drawHistogram } from './histogram';
import { tick } from './haptics';
import { Camera } from './camera';

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
const MASK_KINDS: { kind: string; label: string; desc: string; icon: string }[] = [
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
  private loupe = new Loupe($<HTMLCanvasElement>('loupe'));
  private atlas!: BrushAtlas;
  private maskSel = -1;
  private brushMode: 'paint' | 'erase' | 'swipe' = 'paint';
  private pickMode: 'pick' | 'swipe' = 'pick';
  private maskOverlayOn = false;
  private maskInteracting = false;
  private analysisCache: { key: string; px: Float32Array; w: number; h: number } | null = null;
  private saveTimer = 0;
  private animTimer = 0;
  private camera!: Camera;
  /** state when the open section was entered, for back-gesture cancel */
  private sectionStart = '';
  private ignorePop = false;
  private healSize = 22; // spot radius in screen px
  private detailTimer = 0;
  private detailKey = '';

  constructor() {
    try {
      this.initGL();
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
    }, (x, y, commit) => {
      this.state.v.blurX = x;
      this.state.v.blurY = y;
      this.requestRender();
      if (commit) this.commit();
    });
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
    this.offerResume();
  }

  private initGL() {
    this.g = new GL(this.canvas);
    this.pipe = new Pipeline(this.g);
    this.atlas = new BrushAtlas(this.g.gl);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
    });
    this.canvas.addEventListener('webglcontextrestored', async () => {
      this.g = new GL(this.canvas);
      this.pipe = new Pipeline(this.g);
      this.atlas = new BrushAtlas(this.g.gl);
      this.img = null;
      if (this.file) await this.open(this.file, true);
    });
  }

  private fatal(msg: string) {
    const e = $('empty');
    e.innerHTML = `<h1>LUMEN</h1><p>${msg}</p><p>Try the latest Safari or Chrome.</p>`;
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
          saveFile(file);
        }
        this.history = [];
        this.hIdx = -1;
        this.look = { base: null, idx: -1, amt: 100 };
        this.aspectId = 'free';
        this.zoom = { s: 1, x: 0, y: 0 };
        this.maskSel = this.state.masks.length ? 0 : -1;
        this.commit();
      }
      this.analysisCache = null;
      this.syncAtlasSize();
      this.thumbsKey = '';
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
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow();
    });
  }

  private kind() {
    return this.tool?.kind ?? null;
  }

  /** What's on screen: the edit, the original (compare), or the uncropped frame (crop section). */
  private viewState(): EditState {
    let s = this.state;
    if (this.compare) {
      s = { v: { ...defaultValues(), straighten: s.v.straighten }, curves: defaultState().curves, geo: s.geo, masks: [], spots: [] };
    }
    if (this.kind() === 'crop') s = { ...s, geo: { ...s.geo, crop: { x: 0, y: 0, w: 1, h: 1 } } };
    return s;
  }

  private renderNow() {
    if (!this.img) return;
    const st = this.viewState();
    const { w, h } = outputSize(st, this.img.preview.w, this.img.preview.h);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.layout();
    }
    this.atlas.sync(st.masks);
    this.pipe.brushTex = this.atlas.tex;
    this.pipe.showMask = this.kind() === 'masks' && (this.maskOverlayOn || this.maskInteracting) ? this.maskSel : -1;
    try {
      this.pipe.render(this.img.preview, st, w, h, null);
    } catch (e) {
      console.error(e);
      this.toast('Render error: ' + (e as Error).message, 4000);
    }
    // the loupe copies from the canvas while its frame is still current
    if (this.loupe.pos) this.loupe.draw(this.canvas, this.stage.getBoundingClientRect());
    if (this.showHist || this.kind() === 'curves') this.scheduleHist();
    this.scheduleDetail(true);
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
    if (changed && det.classList.contains('on')) {
      // the image changed under the detail tile; refresh it shortly
      this.detailKey = '';
    }
    clearTimeout(this.detailTimer);
    // nothing to do at normal zoom — skip the timer entirely
    if (this.zoom.s <= 1.01 && !det.classList.contains('on')) return;
    this.detailTimer = window.setTimeout(() => {
      this.renderDetail();
      this.updatePixelGrid();
    }, changed ? 260 : 140);
  }

  private renderDetail() {
    const det = $<HTMLCanvasElement>('detail');
    const hide = () => {
      det.classList.remove('on');
      this.detailKey = '';
    };
    if (!this.img || this.compare || this.kind() === 'crop' || this.zoom.s <= 1.01) return hide();
    const dpr = window.devicePixelRatio || 1;
    const fr = this.frame.getBoundingClientRect();
    // preview pixels per screen pixel: if the preview is still sharp, nothing to do
    if ((fr.width * dpr) / this.canvas.width < 1.2) return hide();
    const { w: W, h: H } = this.outFull();
    if (W <= this.canvas.width * 1.05) return hide();
    const st = this.stage.getBoundingClientRect();
    const u0 = Math.max(0, (st.left - fr.left) / fr.width), u1 = Math.min(1, (st.right - fr.left) / fr.width);
    const v0 = Math.max(0, (st.top - fr.top) / fr.height), v1 = Math.min(1, (st.bottom - fr.top) / fr.height);
    if (u1 <= u0 || v1 <= v0) return hide();
    const x = Math.max(0, Math.floor(u0 * W) - 4), y = Math.max(0, Math.floor(v0 * H) - 4);
    const w = Math.min(W - x, Math.ceil((u1 - u0) * W) + 8), h = Math.min(H - y, Math.ceil((v1 - v0) * H) + 8);
    if (w * h > 6_000_000 || w < 2 || h < 2) return hide();
    const key = JSON.stringify([this.hIdx, x, y, w, h, this.history[this.hIdx]?.length]);
    if (key === this.detailKey && det.classList.contains('on')) return;
    this.detailKey = key;
    try {
      this.atlas.sync(this.state.masks);
      this.pipe.brushTex = this.atlas.tex;
      const px = this.pipe.renderRegion(this.img.full, this.img.preview, this.viewState(), W, H, { x, y, w, h });
      det.width = w;
      det.height = h;
      det.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
      Object.assign(det.style, { left: (x / W) * 100 + '%', top: (y / H) * 100 + '%', width: (w / W) * 100 + '%', height: (h / H) * 100 + '%' });
      det.classList.add('on');
    } catch (e) {
      console.warn('detail render failed', e);
      hide();
    }
  }

  /**
   * Pixel grid, drawn in screen space from the photo's exact on-screen rectangle so the lines
   * sit on real pixel edges at any zoom. It follows whatever is shown: the full-res detail
   * tile when it's up, otherwise the preview's own pixels.
   */
  private updatePixelGrid() {
    const gc = $<HTMLCanvasElement>('gridCanvas');
    const ctx = gc.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    if (gc.width !== Math.round(sw * dpr) || gc.height !== Math.round(sh * dpr)) {
      gc.width = Math.round(sw * dpr);
      gc.height = Math.round(sh * dpr);
    }
    ctx.clearRect(0, 0, gc.width, gc.height);
    if (!this.img || this.kind() === 'crop' || this.compare) return;
    const fr = this.frame.getBoundingClientRect();
    const det = $('detail').classList.contains('on');
    const srcW = det ? this.outFull().w : this.canvas.width;
    const srcH = det ? this.outFull().h : this.canvas.height;
    const cell = fr.width / srcW; // CSS px per shown pixel
    this.canvas.classList.toggle('pixelated', cell >= 3);
    if (cell < 10) return;
    const st = this.stage.getBoundingClientRect();
    const ox = fr.left - st.left, oy = fr.top - st.top;
    const cellY = fr.height / srcH;
    ctx.globalAlpha = Math.min(1, (cell - 10) / 10) * 0.32;
    ctx.fillStyle = '#efe9df';
    const x0 = Math.max(0, Math.ceil(-ox / cell)), x1 = Math.min(srcW, Math.floor((sw - ox) / cell));
    const y0 = Math.max(0, Math.ceil(-oy / cellY)), y1 = Math.min(srcH, Math.floor((sh - oy) / cellY));
    const top = Math.max(0, oy) * dpr, bottom = Math.min(sh, oy + fr.height) * dpr;
    const left = Math.max(0, ox) * dpr, right = Math.min(sw, ox + fr.width) * dpr;
    for (let i = x0; i <= x1; i++) ctx.fillRect(Math.round((ox + i * cell) * dpr), top, 1, bottom - top);
    for (let j = y0; j <= y1; j++) ctx.fillRect(left, Math.round((oy + j * cellY) * dpr), right - left, 1);
    ctx.globalAlpha = 1;
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
    const dock = $('dock');
    const tools = $('tools'), section = $('section');
    const active = this.tool ? section : tools;
    const bot = dock.offsetHeight - Math.max(tools.offsetHeight, section.offsetHeight) + active.offsetHeight - 14;
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
    const b = $('zoomBadge');
    b.classList.toggle('on', z.s > 1.01);
    if (z.s > 1.01) b.textContent = this.img && this.pxPerOut() * z.s >= 1 ? `${Math.round(this.pxPerOut() * z.s * 100)}%` : Math.round(z.s * 100) + '%';
    this.redrawOverlays();
    if (this.img) {
      this.updatePixelGrid();
      this.scheduleDetail();
    }
  }

  private redrawOverlays() {
    const k = this.kind();
    if (k === 'masks') this.maskOv.draw();
    if (k === 'blur') this.blurOv.draw();
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
    this.hIdx = this.history.length - 1;
    this.updateChrome();
    if (this.img) {
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => saveState(this.history[this.hIdx]), 800);
    }
  }

  private commitAndRefresh() {
    this.commit();
    this.updateSecBar();
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
    this.requestRender();
    this.refreshSection();
    this.updateChrome();
  }

  // -----------------------------------------------------------------------------------
  // Params. Plain ids are global; 'lookAmt' = look strength; 'ma.x' / 'mg.x' = selected
  // mask's adjustments / mask settings.

  private def(id: string): ParamDef {
    if (id === 'lookAmt') return LOOK_AMT;
    if (id.startsWith('ma.')) return MASK_ADJ_MAP[id.slice(3)];
    if (id.startsWith('mg.')) return MASK_SETTINGS[id.slice(3)];
    return PARAM_MAP[id];
  }
  private get(id: string) {
    if (id === 'lookAmt') return this.look.amt;
    const m = this.selMask();
    if (id.startsWith('ma.')) return m ? m.a[id.slice(3)] ?? 0 : 0;
    if (id.startsWith('mg.')) return m ? m.g[id.slice(3)] ?? this.def(id).def : 0;
    return this.state.v[id];
  }
  private set(id: string, v: number) {
    const d = this.def(id);
    v = Math.min(d.max, Math.max(d.min, v));
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
    }
    this.requestRender();
  }

  private params(): string[] {
    const t = this.tool;
    if (!t) return [];
    if (t.kind === 'masks') {
      const m = this.selMask();
      if (!m) return [];
      return [...MASK_ADJ.map((d) => 'ma.' + d.id), ...MASK_TYPE_SETTINGS[m.type].map((k) => 'mg.' + k)];
    }
    if (t.kind === 'blur') return t.params(String(Math.round(this.state.v.blurType)));
    if (t.kind === 'heal') return [];
    if (t.kind === 'looks') return this.look.idx > 0 ? ['lookAmt'] : [];
    return t.params(this.sub[t.id] ?? t.subs?.[0].id ?? '');
  }
  private currentParam(): string | null {
    const ps = this.params();
    if (!ps.length || !this.tool) return null;
    return ps[Math.min(ps.length - 1, this.paramIdx[this.tool.id] ?? 0)];
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
        return this.state.spots.length > 0;
      default: {
        const subs = t.subs ? t.subs.map((s) => s.id) : [''];
        return subs.some((s) => t.params(s).some((p) => Math.abs(v[p] - PARAM_MAP[p].def) > 1e-6));
      }
    }
  }

  // -----------------------------------------------------------------------------------
  // Chrome

  private bindChrome() {
    $('btnOpen').innerHTML = ICONS.open;
    $('btnCam').innerHTML = ICONS.camera;
    const shoot = () => {
      if (!this.camera.supported) return this.toast('This browser has no camera access');
      this.camera.open((f) => this.open(f));
    };
    $('btnCam').onclick = shoot;
    $('btnCamera').onclick = shoot;
    $('btnUndo').innerHTML = ICONS.undo;
    $('btnRedo').innerHTML = ICONS.redo;
    $('btnMore').innerHTML = ICONS.more;
    $('secReset').innerHTML = ICONS.reset;
    $('secDone').innerHTML = ICONS.check;

    // image/* lets Android show its photo picker, which includes Google Photos
    const input = $<HTMLInputElement>('file');
    const rawInput = $<HTMLInputElement>('fileRaw');
    rawInput.accept = RAW_EXT.map((e) => '.' + e).join(',') + ',image/*';
    const pick = (el: HTMLInputElement) => () => {
      el.value = '';
      el.click();
    };
    for (const el of [input, rawInput]) {
      el.onchange = () => {
        const f = el.files?.[0];
        if (f) this.open(f);
      };
    }
    $('btnOpen').onclick = pick(input);
    $('btnOpenBig').onclick = pick(input);
    $('btnOpenRaw').onclick = pick(rawInput);
    $('btnUndo').onclick = () => this.restore(this.hIdx - 1);
    $('btnRedo').onclick = () => this.restore(this.hIdx + 1);
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
      const f = e.dataTransfer?.files?.[0];
      if (f) this.open(f);
    });
    this.bindValueInput();
    this.bindExport();
    this.bindMore();
    this.bindPresets();
    this.bindMaskSheet();
    this.bindKeys();
  }

  private setCompare(on: boolean) {
    if (this.compare === on || !this.img) return;
    this.compare = on;
    $('badge').textContent = 'ORIGINAL';
    $('badge').classList.toggle('on', on);
    this.requestRender();
    this.updatePixelGrid();
  }

  private updateChrome() {
    const has = !!this.img;
    ($('btnUndo') as HTMLButtonElement).disabled = !has || this.hIdx <= 0;
    ($('btnRedo') as HTMLButtonElement).disabled = !has || this.hIdx >= this.history.length - 1;
    ($('btnExport') as HTMLButtonElement).disabled = !has;
    $('tools').classList.toggle('disabled', !has);
    document.querySelectorAll<HTMLButtonElement>('#tools button').forEach((b) => {
      const t = TOOLS.find((x) => x.id === b.dataset.id)!;
      b.classList.toggle('mod', this.toolModified(t));
    });
  }

  private buildTools() {
    const nav = $('tools');
    nav.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.dataset.id = t.id;
      b.innerHTML = `${t.icon}<span>${t.label}</span>`;
      b.onclick = () => {
        tick();
        this.setMode(t);
      };
      nav.appendChild(b);
    }
  }

  /** Open a section (focused controls) or go back to the tool bar (null). */
  private setMode(t: ToolDef | null) {
    const prev = this.tool;
    if (prev?.kind === 'looks' && t?.kind !== 'looks') {
      this.look.base = null;
      this.look.idx = -1;
    }
    if (prev && !t) this.commit();
    if (t && !prev) {
      this.sectionStart = JSON.stringify(this.state);
      history.pushState({ lumen: 'section' }, '');
    }
    this.tool = t;
    this.showMenu(false);
    this.loupe.hide();
    this.appEl.dataset.mode = t ? 'section' : 'tools';
    $('title').textContent = t ? t.label : this.img?.info ?? '';
    if (prev?.kind === 'crop' || t?.kind === 'crop') this.zoom = { s: 1, x: 0, y: 0 };
    if (t?.kind === 'curves' && !this.sub.curves) this.sub.curves = 'rgb';
    this.curve.channel = (this.sub.curves ?? 'rgb') as keyof Curves;
    this.curve.show(t?.kind === 'curves' && !!this.img);
    this.crop.show(t?.kind === 'crop' && !!this.img);
    this.maskOv.show(t?.kind === 'masks' && !!this.img);
    this.blurOv.show(t?.kind === 'blur' && !!this.img);
    if (t?.kind === 'masks' && this.maskSel < 0 && this.state.masks.length) this.maskSel = 0;
    this.refreshSection();
    // wait for the dock to settle, then refit the photo smoothly
    requestAnimationFrame(() => this.layout(true));
    this.requestRender();
    if (t?.kind === 'masks' && !this.state.masks.length && this.img) setTimeout(() => this.openMaskSheet(), 180);
    if (t?.kind === 'heal' && this.img) this.toast('Tap a spot to remove it · pinch to zoom in close', 2600);
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
    $('secReset').classList.toggle('gone', !this.toolModified(t));
    const id = this.currentParam();
    $('pill').classList.toggle('gone', !id);
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
    if (t.kind === 'looks') return this.buildLooks();
    if (t.kind === 'masks') return this.buildMaskList();
    if (!t.subs) return;
    const cur = t.kind === 'crop' ? this.aspectId : t.kind === 'blur' ? String(Math.round(this.state.v.blurType)) : this.sub[t.id] ?? t.subs[0].id;
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
    else if (t.kind === 'blur') {
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
    if (t.kind === 'masks') return this.buildMaskActs();
    if (t.kind === 'heal') return this.buildHealActs();
    for (const a of t.actions ?? []) {
      if (a.icon) this.tile(row, a.icon, a.label, '', () => this.action(a.id));
      else this.chip(row, a, false, () => this.action(a.id));
    }
  }

  // -----------------------------------------------------------------------------------
  // HUD + menu

  /** The readout at the bottom of a section: name, value and a ruler. Always visible. */
  private showHud(id: string) {
    const d = this.def(id);
    if (!d) return;
    $('paramName').textContent = d.label;
    $('paramValue').textContent = this.fmt(id);
    const pos = (x: number) => ((x - d.min) / (d.max - d.min)) * 100;
    const z = pos(d.def), p = pos(this.get(id));
    const pill = $('pill');
    const bar = pill.querySelector('.ruler i') as HTMLElement;
    bar.style.left = Math.min(z, p) + '%';
    bar.style.width = Math.abs(p - z) + '%';
    (pill.querySelector('.ruler b') as HTMLElement).style.left = p + '%';
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
    const cur = Math.min(ps.length - 1, this.paramIdx[this.tool.id] ?? 0);
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
        this.paramIdx[this.tool!.id] = i;
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
      el.style.opacity = String(Math.max(0.18, 1 - Math.abs(k - i) * 0.22));
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
    type Mode = 'none' | 'pending' | 'value' | 'menu' | 'pinch' | 'crop' | 'compare' | 'mask' | 'paint' | 'pick' | 'blur' | 'pan' | 'heal';
    let mode: Mode = 'none';
    let sx = 0, sy = 0, startIdx = 0, lastStep = 0;
    let curVal = 0, lastX = 0, lastT = 0, lastNotch = 0;
    let pinch0 = { d: 1, mx: 0, my: 0, s: 1, x: 0, y: 0 };
    let pan0 = { x: 0, y: 0 };
    let anchorY = 0;
    let holdTimer = 0, tapTimer = 0;
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
        if (mode === 'mask') this.maskOv.cancel();
        if (mode === 'pick') this.endPick(false);
        if (mode === 'heal') this.loupe.hide();
        this.hideBrushRing();
        this.setCompare(false);
        const [a, b] = [...pts.values()];
        const m = stageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y, ...this.zoom };
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
      if (k === 'blur' && this.blurOv.start(e)) {
        mode = 'blur';
        tick();
        return;
      }
      if (k === 'heal') {
        mode = 'heal';
        this.healPreview(e);
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
        if (m && m.type === 'brush' && this.brushMode !== 'swipe') {
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
      clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        if (mode === 'pending') {
          mode = 'compare';
          this.setCompare(true);
          tick(true);
        }
      }, 380);
    });

    st.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // while something is being dragged, the glass bars skip their live blur (it would be
      // recomputed every frame over the changing photo)
      if (mode !== 'pending' && mode !== 'none' && mode !== 'compare' && !this.appEl.classList.contains('live')) this.appEl.classList.add('live');
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
      if (mode === 'pick') return this.pickAt(e);
      if (mode === 'heal') return this.healPreview(e);
      if (mode === 'pan') {
        this.zoom = { ...this.zoom, x: pan0.x + e.clientX - sx, y: pan0.y + e.clientY - sy };
        this.applyZoom();
        return;
      }
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (mode === 'pending' && Math.hypot(dx, dy) > 8) {
        clearTimeout(holdTimer);
        if (this.zoom.s > 1.01) {
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
          curVal = this.get(id);
          lastX = sx;
          lastT = e.timeStamp;
          const d = this.def(id);
          lastNotch = Math.floor((curVal - d.min) / ((d.max - d.min) / 50));
          if (this.kind() === 'crop') this.crop.setGrid(true);
          if (this.kind() === 'blur') this.blurOv.guides = true;
        } else if (this.params().length > 1) {
          mode = 'menu';
          startIdx = this.paramIdx[this.tool!.id] ?? 0;
          lastStep = startIdx;
          anchorY = e.clientY;
          this.showMenu(true);
        } else mode = 'none';
      }
      if (mode === 'value') {
        const id = this.currentParam()!;
        const d = this.def(id);
        const span = d.max - d.min;
        const range = (d.swipe ?? span) * 1.15;
        const ddx = e.clientX - lastX;
        const speed = Math.abs(ddx) / Math.max(1, e.timeStamp - lastT);
        const fine = speed < 0.06 ? 0.6 : 1;
        lastX = e.clientX;
        lastT = e.timeStamp;
        const before = curVal;
        curVal += (ddx / st.clientWidth) * range * fine;
        if (d.hue) curVal = ((curVal % 360) + 360) % 360;
        else curVal = Math.min(d.max, Math.max(d.min, curVal));
        this.set(id, curVal);
        // haptic notches: 50 across the range, a stronger one at the default and the ends
        const notch = Math.floor((curVal - d.min) / (span / 50));
        const crossedDefault = (before - d.def) * (curVal - d.def) < 0;
        const hitEnd = (curVal === d.min || curVal === d.max) && before !== curVal;
        if (crossedDefault || hitEnd) tick(true);
        else if (notch !== lastNotch) tick();
        lastNotch = notch;
        this.showHud(id);
        $('paramValue').textContent = this.fmt(id);
        if (this.kind() === 'blur') this.blurOv.draw();
      } else if (mode === 'menu') {
        const n = this.params().length;
        // detents: every 30px of travel moves exactly one row (at most one per event),
        // measured from where the list opened; swiping up moves down the list
        const STEP = 30;
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
          this.paramIdx[this.tool!.id] = i;
          this.highlightMenu(i);
          this.showHud(this.currentParam()!);
        }
      }
    });

    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size === 0) this.appEl.classList.remove('live');
      clearTimeout(holdTimer);
      if (mode === 'pinch') {
        if (pts.size === 0) mode = 'none';
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
      } else if (mode === 'pick') {
        this.endPick(true);
      } else if (mode === 'heal') {
        this.addSpot(e);
      } else if (mode === 'compare') {
        this.setCompare(false);
      } else if (mode === 'value' || mode === 'menu') {
        this.finishSwipe(mode);
      } else if (mode === 'pending' && e.type === 'pointerup') {
        const now = performance.now();
        const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
        if (now - lastTap.t < 300 && near) {
          // double tap: reset the current adjustment (and cancel the pending hide/show)
          clearTimeout(tapTimer);
          const id = this.currentParam();
          if (id) {
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
          tapTimer = window.setTimeout(() => this.toggleUI(), 260);
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
      this.commit();
      this.hideHudSoon();
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
    if (this.img) this.atlas.resize(this.frameInfo().aspect);
  }

  private maskIcon(m: Mask) {
    if (m.type === 'radial' && m.g.smart > 0) return ICONS.mPoint;
    return { radial: ICONS.mRadial, linear: ICONS.mLinear, brush: ICONS.mBrush, luma: ICONS.mLuma, color: ICONS.mColor }[m.type];
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
    if (m.type === 'brush') {
      this.tile(row, ICONS.paint, 'Paint', this.brushMode === 'paint' ? 'on' : '', () => this.setBrushMode('paint'));
      this.tile(row, ICONS.erase, 'Erase', this.brushMode === 'erase' ? 'on' : '', () => this.setBrushMode('erase'));
      this.tile(row, ICONS.swipe, 'Adjust', this.brushMode === 'swipe' ? 'on' : '', () => this.setBrushMode('swipe'));
      sep();
    } else if (m.type === 'luma' || m.type === 'color') {
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

  private setBrushMode(m: 'paint' | 'erase' | 'swipe') {
    this.brushMode = m;
    this.refreshSection();
  }

  private bindMaskSheet() {
    const sheet = $('maskSheet');
    const grid = $('maskGrid');
    for (const k of MASK_KINDS) {
      const b = document.createElement('button');
      b.className = 'mask-tile';
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
    const type: MaskType = kind === 'point' ? 'radial' : (kind as MaskType);
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
    const label = kind === 'point' ? 'Point' : MASK_LABEL[type].replace(' range', '');
    const m: Mask = { id: Date.now() % 1e9, type, name: `${label} ${n}`, invert: false, g, a, strokes: [] };
    this.state.masks.push(m);
    this.maskSel = this.state.masks.length - 1;
    this.paramIdx.masks = 0;
    if (type === 'radial' && g.smart > 0) this.updateSmartRef(m);
    if (type === 'brush') this.brushMode = 'paint';
    if (type === 'luma' || type === 'color') this.pickMode = 'pick';
    this.commit();
    this.refreshSection();
    this.requestRender();
    const tips: Record<string, string> = {
      radial: 'Drag the orange dot to move · white dots resize and rotate',
      point: 'Drag the point onto what you want to change',
      linear: 'Full effect at the solid line, fading out by the dashed one',
      brush: 'Paint over the area · two fingers to zoom',
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
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    const P = this.stroke.pts;
    const { aspect } = this.frameInfo();
    const d = Math.hypot((f.x - P[P.length - 2]) * aspect, f.y - P[P.length - 1]);
    if (d > this.stroke.r * 0.12) {
      P.push(f.x, f.y);
      this.requestRender();
    }
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
  private showBrushRing(e: PointerEvent) {
    const ring = $('brushRing');
    const r = this.brushRadius() * this.maskOv.pxPerFrameH();
    const st = this.stage.getBoundingClientRect();
    ring.style.width = ring.style.height = r * 2 + 'px';
    ring.style.transform = `translate(${e.clientX - st.left - r}px, ${e.clientY - st.top - r}px)`;
    ring.classList.toggle('erase', this.brushMode === 'erase');
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
      for (const st of m.strokes) {
        if (kind === 'rot') st.r /= aspect;
        for (let i = 0; i < st.pts.length; i += 2) [st.pts[i], st.pts[i + 1]] = pt(st.pts[i], st.pts[i + 1]);
      }
    }
    for (const sp of this.state.spots) {
      const [x, y] = kind === 'rot' ? [1 - sp.y, sp.x] : kind === 'flipH' ? [1 - sp.x, sp.y] : [sp.x, 1 - sp.y];
      const [ox, oy] = kind === 'rot' ? [-sp.oy, sp.ox] : kind === 'flipH' ? [-sp.ox, sp.oy] : [sp.ox, -sp.oy];
      Object.assign(sp, { x, y, ox, oy });
      if (kind === 'rot') sp.r /= aspect;
    }
  }

  // -----------------------------------------------------------------------------------
  // Remove (spot healing)

  private healRadius() {
    return this.healSize / this.maskOv.pxPerFrameH(); // frame heights; constant size on screen
  }

  private healPreview(e: PointerEvent) {
    const ring = $('brushRing');
    const r = this.healSize;
    const st = this.stage.getBoundingClientRect();
    ring.style.width = ring.style.height = r * 2 + 'px';
    ring.style.transform = `translate(${e.clientX - st.left - r}px, ${e.clientY - st.top - r}px)`;
    ring.classList.remove('erase');
    ring.classList.add('on');
    this.loupe.color = '#efe9df';
    this.loupe.show(e.clientX, e.clientY);
    this.requestRender();
  }

  /** Heal a spot: find a nearby patch whose surroundings match, then blend it in. */
  private addSpot(e: PointerEvent) {
    this.loupe.hide();
    this.hideBrushRing();
    this.requestRender();
    if (!this.img) return;
    const f = this.maskOv.toFrame(e.clientX, e.clientY);
    if (f.u < 0 || f.u > 1 || f.v < 0 || f.v > 1) return;
    if (this.state.spots.length >= MAX_SPOTS) return this.toast(`Up to ${MAX_SPOTS} spots per photo`);
    const r = this.healRadius();
    const spot = this.findPatch(f.x, f.y, r);
    if (!spot) return this.toast('Couldn’t find a clean patch nearby — try zooming in');
    this.state.spots.push(spot);
    tick(true);
    this.commit();
    this.updateSecBar();
    this.requestRender();
  }

  private findPatch(fx: number, fy: number, r: number): Spot | null {
    const img = this.img!;
    const st = { ...defaultState(), geo: this.state.geo, spots: this.state.spots };
    st.v.straighten = this.state.v.straighten;
    st.v.distortion = this.state.v.distortion;
    const { w: W, h: H } = outputSize(st, img.preview.w, img.preview.h);
    const c = this.state.geo.crop;
    const cx = ((fx - c.x) / c.w) * W, cy = ((fy - c.y) / c.h) * H;
    const rp = Math.max(1.5, (r / c.h) * H); // radius in preview px
    const reach = rp * 5.5;
    const R = this.pipe.geometryRegion(img.preview, st, W, H, { x: cx - reach, y: cy - reach, w: reach * 2, h: reach * 2 });
    const at = (x: number, y: number): [number, number, number] | null => {
      const ix = Math.round(x - R.x), iy = Math.round(y - R.y);
      if (ix < 0 || iy < 0 || ix >= R.w || iy >= R.h) return null;
      const i = (iy * R.w + ix) * 4;
      return [R.px[i] / 255, R.px[i + 1] / 255, R.px[i + 2] / 255];
    };
    // the ring around the spot describes what the patch has to blend into
    const ring: [number, number][] = [];
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      for (const rr of [1.15, 1.45]) ring.push([Math.cos(a) * rp * rr, Math.sin(a) * rp * rr]);
    }
    const dst = ring.map(([x, y]) => at(cx + x, cy + y));
    const inside: [number, number][] = [[0, 0]];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const rr of [0.35, 0.7]) inside.push([Math.cos(a) * rp * rr, Math.sin(a) * rp * rr]);
    }
    let best: { cost: number; ox: number; oy: number; corr: [number, number, number] } | null = null;
    for (const dist of [2.2, 2.9, 3.8]) {
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        const ox = Math.cos(a) * rp * dist, oy = Math.sin(a) * rp * dist;
        // keep away from other healed spots
        let cost = 0, n = 0;
        const mean = [0, 0, 0], meanD = [0, 0, 0];
        let ok = true;
        for (let j = 0; j < ring.length; j++) {
          const d = dst[j];
          const sCol = at(cx + ring[j][0] + ox, cy + ring[j][1] + oy);
          if (!d || !sCol) { ok = false; break; }
          for (let ch = 0; ch < 3; ch++) {
            mean[ch] += sCol[ch];
            meanD[ch] += d[ch];
          }
          n++;
        }
        if (!ok || !n) continue;
        const corr = [0, 1, 2].map((ch) => (meanD[ch] - mean[ch]) / n) as [number, number, number];
        // texture match after removing the average difference
        for (let j = 0; j < ring.length; j++) {
          const d = dst[j]!;
          const sCol = at(cx + ring[j][0] + ox, cy + ring[j][1] + oy)!;
          for (let ch = 0; ch < 3; ch++) cost += (d[ch] - sCol[ch] - corr[ch]) ** 2;
        }
        // the donor patch itself must be clean: anything inside it that stands out from its
        // own surroundings (another blemish, an edge) is penalized hard
        const lum = (p: number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
        const ringL = lum(mean) / n;
        let inner = 0, ni = 0;
        for (const [ix, iy] of inside) {
          const q = at(cx + ox + ix, cy + oy + iy);
          if (!q) continue;
          const dl = lum(q) - ringL;
          inner += dl * dl;
          ni++;
        }
        if (ni) cost += (inner / ni) * ring.length * 6;
        cost += Math.hypot(...corr) * 2 + dist * 0.002;
        if (!best || cost < best.cost) best = { cost, ox, oy, corr };
      }
    }
    if (!best) return null;
    return {
      x: fx, y: fy, r,
      ox: (best.ox / W) * c.w, oy: (best.oy / H) * c.h,
      c: best.corr,
    };
  }

  private buildHealActs() {
    const row = $('acts');
    const sizes: [string, number][] = [['Small', 12], ['Medium', 22], ['Large', 38], ['XL', 60]];
    for (const [label, px] of sizes) {
      const b = this.tile(row, `<i class="sz" style="width:${Math.min(24, px * 0.45 + 4)}px;height:${Math.min(24, px * 0.45 + 4)}px"></i>`, label, this.healSize === px ? 'on' : '', () => {
        this.healSize = px;
        this.refreshSection();
      });
      b.setAttribute('aria-label', `${label} spot`);
    }
    if (this.state.spots.length) {
      row.appendChild(Object.assign(document.createElement('i'), { className: 'sep' }));
      this.tile(row, ICONS.undo, 'Undo spot', '', () => {
        this.state.spots.pop();
        this.commit();
        this.refreshSection();
        this.requestRender();
      });
    }
  }

  // -----------------------------------------------------------------------------------
  // Back gesture (Android): back leaves a section without keeping its changes, or closes a sheet

  private bindBack() {
    window.addEventListener('popstate', () => {
      if (this.ignorePop) {
        this.ignorePop = false;
        return;
      }
      if (this.camera.isOpen()) return this.camera.close(true);
      const sheet = document.querySelector('.sheet.on');
      if (sheet) {
        sheet.classList.remove('on');
        return;
      }
      if (this.tool) this.cancelSection();
    });
    // sheets: give each open one a history entry so back closes it
    document.querySelectorAll<HTMLElement>('.sheet').forEach((el) => {
      new MutationObserver(() => {
        const on = el.classList.contains('on');
        if (on && !el.dataset.nav) {
          el.dataset.nav = '1';
          history.pushState({ lumen: 'sheet' }, '');
        } else if (!on && el.dataset.nav) {
          delete el.dataset.nav;
          if (history.state?.lumen === 'sheet') {
            this.ignorePop = true;
            history.back();
          }
        }
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /** ✓: keep the changes and go back to the tool bar. */
  private closeSection() {
    this.setMode(null);
    if (history.state?.lumen === 'section') {
      this.ignorePop = true;
      history.back();
    }
  }

  /** Back: drop this section's changes. */
  private cancelSection() {
    if (this.sectionStart) {
      const before = JSON.parse(this.sectionStart) as EditState;
      const changed = this.sectionStart !== JSON.stringify(this.state);
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

  private lookState(base: EditState, L: Look, t: number): EditState {
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
        if (!['straighten', 'distortion', 'blurX', 'blurY'].includes(k) && x !== d[k]) v[k] = x;
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

  private confirm(title: string, text: string, yes: () => void) {
    const sheet = $('confirmSheet');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    sheet.classList.add('on');
    $('confirmNo').onclick = () => sheet.classList.remove('on');
    $('confirmYes').onclick = () => {
      sheet.classList.remove('on');
      yes();
    };
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
    $('btnMore').onclick = () => sheet.classList.add('on');
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
    sheet.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        sheet.classList.remove('on');
        const a = b.dataset.a;
        if (a === 'open') return $('btnOpen').click();
        if (a === 'openRaw') return $('btnOpenRaw').click();
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
      if (!this.img || (e.target as HTMLElement).tagName === 'INPUT') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.restore(this.hIdx + (e.shiftKey ? 1 : -1));
        return;
      }
      if (e.key === '\\') return this.setCompare(!this.compare);
      if (e.key === 'Escape' && this.tool) return this.setMode(null);
      if (e.key === 'h') return this.toggleUI();
      const id = this.currentParam();
      if (!id) return;
      const d = this.def(id);
      const n = this.params().length;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.paramIdx[this.tool!.id] = Math.max(0, Math.min(n - 1, (this.paramIdx[this.tool!.id] ?? 0) + (e.key === 'ArrowUp' ? -1 : 1)));
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

  private exportOpts = { size: 'full', format: 'jpeg' as 'jpeg' | 'png', quality: 92 };

  private bindExport() {
    const sheet = $('sheet');
    $('btnExport').onclick = () => {
      if (!this.img) return;
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
    if (this.exportOpts.format === 'png' && full.w * full.h * k * k > CANVAS_LIMIT) k = Math.sqrt(CANVAS_LIMIT / (full.w * full.h));
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
    $('exHint').textContent = isPng && d.k < 1 && this.exportOpts.size === 'full'
      ? 'PNG is limited to ~16 MP on phones; use JPEG for full resolution.'
      : `${((d.w * d.h) / 1e6).toFixed(1)} MP · every edit applied at full quality`;
    ($('exGo') as HTMLButtonElement).textContent = framed ? 'Export' : /iPhone|iPad|Android/i.test(navigator.userAgent) ? 'Save' : 'Download';
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
      const blob = await renderExport({
        pipeline: this.pipe, full, analysis: img.preview, state: this.state, w: d.w, h: d.h,
        format: this.exportOpts.format, quality: this.exportOpts.quality,
        progress: (f) => this.busy(`Exporting ${Math.round(f * 100)}%`),
      });
      if (tmp) {
        this.g.destroy(tmp);
        tmp = null;
      }
      this.busy(null);
      const name = `${img.name.replace(/\.[^.]+$/, '')}-lumen.${this.exportOpts.format === 'png' ? 'png' : 'jpg'}`;
      const how = await saveOrShare(blob, name);
      if (how === 'shown') this.showResult(blob);
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

  private busy(msg: string | null) {
    const b = $('busy');
    b.classList.toggle('on', !!msg);
    if (msg) (b.querySelector('.msg') as HTMLElement).textContent = msg;
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

function escapeHtml(t: string) {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function rgbCss(c: number[]) {
  return `rgb(${c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)).join(',')})`;
}
