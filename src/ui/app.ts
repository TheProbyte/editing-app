import { GL, Target } from '../gl/glutil';
import { Pipeline, Source, frameSize, outputSize } from '../gl/pipeline';
import {
  EditState, PARAM_MAP, ParamDef, CurvePoint, Curves, cloneState, defaultState, defaultValues, LINEAR, plain,
} from '../params';
import { makeSpline } from '../curves';
import { LOOKS, Look } from '../presets';
import { loadFile, RAW_EXT } from '../io/loader';
import { CANVAS_LIMIT, renderExport, saveOrShare } from '../io/export';
import { TOOLS, ToolDef, ICONS, Chip } from './tools';
import { CurveEditor } from './curveEditor';
import { CropOverlay, fitAspect } from './cropOverlay';
import { drawHistogram } from './histogram';

interface Img {
  full: Source;
  preview: Source;
  thumb: Source;
  previewT: Target;
  thumbT: Target;
  name: string;
  info: string;
}

const LOOK_AMT: ParamDef = { id: 'lookAmt', label: 'Strength', min: 0, max: 100, def: 100, fmt: plain };
const ASPECTS: Record<string, number | null> = {
  free: null, orig: -1, '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '3:2': 3 / 2, '2:3': 2 / 3,
  '16:9': 16 / 9, '9:16': 9 / 16, '1.85': 1.85, '2.39': 2.39,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const buzz = (ms = 6) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
};

export class App {
  private g!: GL;
  private pipe!: Pipeline;
  private canvas = $<HTMLCanvasElement>('view');
  private stage = $('stage');
  private frame = $('frame');
  private img: Img | null = null;
  private file: File | null = null;

  state: EditState = defaultState();
  private history: string[] = [];
  private hIdx = -1;

  private tool: ToolDef = TOOLS[1];
  private paramIdx: Record<string, number> = {};
  private sub: Record<string, string> = {};
  private aspectId = 'free';

  private compare = false;
  private showHist = false;
  private zoom = { s: 1, x: 0, y: 0 };
  private raf = 0;
  private histTimer = 0;

  private look: { base: EditState | null; idx: number; amt: number } = { base: null, idx: -1, amt: 100 };
  private thumbsKey = '';

  private curve!: CurveEditor;
  private crop!: CropOverlay;

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
      if (commit) this.commit();
    });
    this.crop = new CropOverlay($('cropLayer'), () => this.state.geo.crop, (r, commit) => {
      this.state.geo.crop = r;
      if (commit) this.commit();
    }, () => this.aspectNorm());
    this.bindChrome();
    this.bindGestures();
    this.buildTools();
    this.selectTool(TOOLS[1]);
    this.commit();
    this.updateChrome();
    new ResizeObserver(() => this.layout()).observe(this.stage);
  }

  private initGL() {
    this.g = new GL(this.canvas);
    this.pipe = new Pipeline(this.g);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
    });
    this.canvas.addEventListener('webglcontextrestored', async () => {
      this.g = new GL(this.canvas);
      this.pipe = new Pipeline(this.g);
      this.img = null;
      if (this.file) await this.open(this.file, true);
    });
  }

  private fatal(msg: string) {
    const e = $('empty');
    e.innerHTML = `<h1>Can’t start</h1><p>${msg}</p><p>Try the latest Safari or Chrome.</p>`;
  }

  // -----------------------------------------------------------------------------------
  // Opening images

  async open(file: File, keepState = false) {
    this.busy('Opening…');
    try {
      const maxDim = Math.min(this.g.maxTex, 8192);
      const L = await loadFile(file, maxDim, (s) => this.busy(s));
      this.busy('Preparing…');
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
        this.history = [];
        this.hIdx = -1;
        this.look = { base: null, idx: -1, amt: 100 };
        this.aspectId = 'free';
        this.zoom = { s: 1, x: 0, y: 0 };
        this.commit();
      }
      this.thumbsKey = '';
      $('empty').classList.add('hidden');
      this.frame.classList.remove('empty');
      $('title').textContent = L.info;
      this.selectTool(this.tool);
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

  /** What's on screen: the edit, the original (compare), or the uncropped frame (crop tool). */
  private viewState(): EditState {
    let s = this.state;
    if (this.compare) {
      s = { v: { ...defaultValues(), straighten: s.v.straighten }, curves: defaultState().curves, geo: s.geo };
    }
    if (this.tool.kind === 'crop') {
      s = { ...s, geo: { ...s.geo, crop: { x: 0, y: 0, w: 1, h: 1 } } };
    }
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
    try {
      this.pipe.render(this.img.preview, st, w, h, null);
    } catch (e) {
      console.error(e);
      this.toast('Render error: ' + (e as Error).message, 4000);
    }
    if (this.showHist || this.tool.kind === 'curves') this.scheduleHist();
  }

  private scheduleHist() {
    clearTimeout(this.histTimer);
    this.histTimer = window.setTimeout(() => {
      if (!this.img) return;
      const st = this.viewState();
      const { w, h } = outputSize(st, this.img.thumb.w, this.img.thumb.h);
      const px = this.pipe.renderPixels(this.img.thumb, st, w, h);
      const l = drawHistogram($<HTMLCanvasElement>('hist'), px);
      this.curve.hist = l;
      if (this.tool.kind === 'curves') this.curve.draw();
    }, 90);
  }

  private layout() {
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const cw = this.canvas.width || 1;
    const ch = this.canvas.height || 1;
    const m = 10;
    const k = Math.min((sw - m * 2) / cw, (sh - m * 2) / ch);
    this.frame.style.width = Math.max(1, cw * k) + 'px';
    this.frame.style.height = Math.max(1, ch * k) + 'px';
    this.applyZoom();
    if (this.tool.kind === 'crop') this.crop.update();
    if (this.tool.kind === 'curves') this.curve.draw();
  }

  private applyZoom() {
    const z = this.zoom;
    this.frame.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s}) translate(-50%, -50%)`;
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
  }

  private restore(i: number) {
    if (i < 0 || i >= this.history.length) return;
    this.hIdx = i;
    this.state = JSON.parse(this.history[i]);
    this.look.base = null;
    this.look.idx = -1;
    this.requestRender();
    this.refreshPanel();
    this.updateChrome();
  }

  // -----------------------------------------------------------------------------------
  // Params

  private def(id: string): ParamDef {
    return id === 'lookAmt' ? LOOK_AMT : PARAM_MAP[id];
  }
  private get(id: string) {
    return id === 'lookAmt' ? this.look.amt : this.state.v[id];
  }
  private set(id: string, v: number) {
    const d = this.def(id);
    v = Math.min(d.max, Math.max(d.min, v));
    if (id === 'lookAmt') {
      this.look.amt = v;
      if (this.look.base && this.look.idx >= 0) this.applyLookValues();
    } else {
      this.state.v[id] = v;
    }
    this.requestRender();
  }

  private params() {
    return this.tool.params(this.sub[this.tool.id] ?? this.tool.subs?.[0].id ?? '');
  }
  private currentParam(): string | null {
    const ps = this.params();
    if (!ps.length) return null;
    const i = Math.min(ps.length - 1, this.paramIdx[this.tool.id] ?? 0);
    return ps[i];
  }

  private fmt(id: string, v = this.get(id)) {
    const d = this.def(id);
    return (d.fmt ?? plain)(v);
  }

  private isModified(ids: string[]) {
    return ids.some((id) => id !== 'lookAmt' && Math.abs(this.state.v[id] - PARAM_MAP[id].def) > 1e-6);
  }

  private toolModified(t: ToolDef) {
    if (t.kind === 'looks') return false;
    if (t.kind === 'curves') return JSON.stringify(this.state.curves) !== JSON.stringify(defaultState().curves);
    if (t.kind === 'crop') {
      const g = this.state.geo;
      return g.quarter !== 0 || g.flipH || g.flipV || g.crop.w < 1 || g.crop.h < 1 || this.state.v.straighten !== 0;
    }
    const subs = t.subs ? t.subs.map((s) => s.id) : [''];
    return subs.some((s) => this.isModified(t.params(s)));
  }

  // -----------------------------------------------------------------------------------
  // Chrome (top bar, tools, panel)

  private bindChrome() {
    const setIcon = (id: string, svg: string) => ($(id).innerHTML = svg);
    setIcon('btnOpen', ICONS.open);
    setIcon('btnUndo', ICONS.undo);
    setIcon('btnRedo', ICONS.redo);
    setIcon('btnCompare', ICONS.compare);
    setIcon('btnHist', ICONS.hist);
    setIcon('btnMore', ICONS.more);

    const input = $<HTMLInputElement>('file');
    input.accept = 'image/*,' + RAW_EXT.map((e) => '.' + e).join(',');
    const pick = () => {
      input.value = '';
      input.click();
    };
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) this.open(f);
    };
    $('btnOpen').onclick = pick;
    $('btnOpenBig').onclick = pick;
    $('btnUndo').onclick = () => this.restore(this.hIdx - 1);
    $('btnRedo').onclick = () => this.restore(this.hIdx + 1);
    $('btnHist').onclick = () => {
      this.showHist = !this.showHist;
      $('hist').classList.toggle('on', this.showHist);
      $('btnHist').classList.toggle('on', this.showHist);
      if (this.showHist) this.scheduleHist();
    };
    const cmp = $('btnCompare');
    const on = (e: Event) => {
      e.preventDefault();
      this.setCompare(true);
    };
    const off = () => this.setCompare(false);
    cmp.addEventListener('pointerdown', on);
    cmp.addEventListener('pointerup', off);
    cmp.addEventListener('pointerleave', off);
    cmp.addEventListener('pointercancel', off);
    cmp.addEventListener('contextmenu', (e) => e.preventDefault());

    // drag & drop (desktop)
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) this.open(f);
    });

    // param name button opens a tap-to-pick list
    $('paramName').onclick = () => this.showMenu(true, true);
    this.bindTrack();
    this.bindExport();
    this.bindMore();
    this.bindKeys();
  }

  private setCompare(on: boolean) {
    if (this.compare === on || !this.img) return;
    this.compare = on;
    $('badge').textContent = 'ORIGINAL';
    $('badge').classList.toggle('on', on);
    this.requestRender();
  }

  private updateChrome() {
    const has = !!this.img;
    ($('btnUndo') as HTMLButtonElement).disabled = !has || this.hIdx <= 0;
    ($('btnRedo') as HTMLButtonElement).disabled = !has || this.hIdx >= this.history.length - 1;
    ($('btnExport') as HTMLButtonElement).disabled = !has;
    ($('btnCompare') as HTMLButtonElement).disabled = !has;
    $('panel').classList.toggle('hidden', !has);
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
      b.onclick = () => this.selectTool(t);
      nav.appendChild(b);
    }
  }

  private selectTool(t: ToolDef) {
    const prev = this.tool;
    if (prev.kind === 'crop' && t.kind !== 'crop') this.zoom = { s: 1, x: 0, y: 0 };
    if (prev.kind === 'looks' && t.kind !== 'looks') {
      this.look.base = null;
      this.look.idx = -1;
    }
    this.tool = t;
    if (t.kind === 'crop') this.zoom = { s: 1, x: 0, y: 0 };
    document.querySelectorAll<HTMLButtonElement>('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.id === t.id));
    const btn = document.querySelector<HTMLElement>(`#tools button[data-id="${t.id}"]`);
    btn?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    if (t.kind === 'curves' && !this.sub.curves) this.sub.curves = 'rgb';
    this.curve.channel = (this.sub.curves ?? 'rgb') as keyof Curves;
    this.curve.show(t.kind === 'curves' && !!this.img);
    this.crop.show(t.kind === 'crop' && !!this.img);
    this.refreshPanel();
    this.layout();
    this.requestRender();
    if (t.kind === 'looks') this.buildThumbs();
  }

  private refreshPanel() {
    this.buildChips();
    this.updateParamBar();
    const looks = $('looks');
    looks.style.display = this.tool.kind === 'looks' ? '' : 'none';
    if (this.tool.kind === 'looks') this.markLooks();
    this.updateChrome();
    if (this.tool.kind === 'crop') this.crop.update();
    if (this.tool.kind === 'curves') this.curve.draw();
  }

  private buildChips() {
    const row = $('chips');
    row.innerHTML = '';
    const t = this.tool;
    const mk = (c: Chip, cls: string, onClick: () => void, selected = false, modified = false) => {
      const b = document.createElement('button');
      b.className = `chip ${cls}${selected ? ' on' : ''}`;
      if (c.color) {
        const dot = document.createElement('span');
        dot.className = 'dot' + (c.color === 'conic' ? ' conic' : '') + (modified ? ' mod' : '');
        if (c.color !== 'conic') dot.style.background = c.color;
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(c.label));
      b.onclick = onClick;
      row.appendChild(b);
      return b;
    };
    if (t.subs) {
      const cur = t.kind === 'crop' ? this.aspectId : this.sub[t.id] ?? t.subs[0].id;
      for (const s of t.subs) {
        const mod = t.kind === 'params' && this.isModified(t.params(s.id).filter((p) => !p.startsWith('cg_b')));
        mk(s, 'sel', () => {
          if (t.kind === 'crop') this.setAspect(s.id);
          else {
            this.sub[t.id] = s.id;
            if (t.kind === 'curves') {
              this.curve.channel = s.id as keyof Curves;
              this.curve.draw();
            }
          }
          this.refreshPanel();
        }, s.id === cur, mod);
      }
    }
    for (const a of t.actions ?? []) mk(a, 'act', () => this.action(a.id));
  }

  private updateParamBar() {
    const id = this.currentParam();
    const bar = $('paramBar');
    bar.classList.toggle('hidden', !id || (this.tool.kind === 'looks' && this.look.idx < 1));
    if (!id) return;
    const d = this.def(id);
    const v = this.get(id);
    ($('paramName').firstElementChild as HTMLElement).textContent = d.label;
    $('paramValue').textContent = this.fmt(id);
    const track = $('track');
    track.classList.toggle('hue', !!d.hue);
    const pos = (x: number) => ((x - d.min) / (d.max - d.min)) * 100;
    const z = pos(d.def);
    const p = pos(v);
    (track.querySelector('.zero') as HTMLElement).style.left = z + '%';
    const fill = track.querySelector('.fill') as HTMLElement;
    fill.style.left = Math.min(z, p) + '%';
    fill.style.width = Math.abs(p - z) + '%';
    (track.querySelector('.knob') as HTMLElement).style.left = p + '%';
    const knob = track.querySelector('.knob') as HTMLElement;
    knob.style.background = d.hue ? `hsl(${v}, 90%, 55%)` : '#fff';
  }

  private bindTrack() {
    const track = $('track');
    let active = -1;
    const setFrom = (e: PointerEvent) => {
      const id = this.currentParam();
      if (!id) return;
      const d = this.def(id);
      const r = track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      let v = d.min + f * (d.max - d.min);
      // snap to default near it
      if (Math.abs(v - d.def) < (d.max - d.min) * 0.015) v = d.def;
      this.set(id, v);
      this.updateParamBar();
      this.showHud(id);
    };
    track.addEventListener('pointerdown', (e) => {
      active = e.pointerId;
      track.setPointerCapture(e.pointerId);
      setFrom(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (e.pointerId === active) setFrom(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = -1;
      this.commit();
      this.hideHudSoon();
      this.updateChrome();
      this.buildChips();
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  // -----------------------------------------------------------------------------------
  // HUD + menu

  private hudTimer = 0;
  private showHud(id: string) {
    const d = this.def(id);
    const hud = $('hud');
    (hud.querySelector('.name') as HTMLElement).textContent = d.label;
    (hud.querySelector('.val') as HTMLElement).textContent = this.fmt(id);
    const pos = (x: number) => ((x - d.min) / (d.max - d.min)) * 100;
    const z = pos(d.def);
    const p = pos(this.get(id));
    const bar = hud.querySelector('.bar i') as HTMLElement;
    bar.style.left = Math.min(z, p) + '%';
    bar.style.width = Math.max(1, Math.abs(p - z)) + '%';
    hud.classList.add('on');
    clearTimeout(this.hudTimer);
  }
  private hideHudSoon() {
    clearTimeout(this.hudTimer);
    this.hudTimer = window.setTimeout(() => $('hud').classList.remove('on'), 700);
  }

  private menuTap = false;
  private showMenu(on: boolean, tapMode = false) {
    const menu = $('menu');
    const ps = this.params();
    if (!on || ps.length < 2) {
      menu.classList.remove('on');
      this.menuTap = false;
      return;
    }
    this.menuTap = tapMode;
    menu.innerHTML = '';
    const cur = this.paramIdx[this.tool.id] ?? 0;
    ps.forEach((id, i) => {
      const b = document.createElement('button');
      const d = this.def(id);
      const changed = id !== 'lookAmt' && Math.abs(this.get(id) - d.def) > 1e-6;
      b.className = 'it' + (i === cur ? ' sel' : '') + (changed ? ' changed' : '');
      b.innerHTML = `<span>${d.label}</span><span class="v">${this.fmt(id)}</span>`;
      b.onpointerup = (e) => {
        if (!this.menuTap) return;
        e.stopPropagation();
        this.paramIdx[this.tool.id] = i;
        this.showMenu(false);
        this.updateParamBar();
        this.showHud(id);
        this.hideHudSoon();
      };
      menu.appendChild(b);
    });
    menu.style.pointerEvents = tapMode ? 'auto' : 'none';
    $('hud').classList.remove('on');
    menu.classList.add('on');
  }
  private highlightMenu(i: number) {
    $('menu').querySelectorAll('.it').forEach((el, k) => el.classList.toggle('sel', k === i));
  }

  // -----------------------------------------------------------------------------------
  // Gestures on the photo:
  //   vertical swipe   → choose adjustment     horizontal swipe → change it
  //   double tap       → reset adjustment      press & hold     → show original
  //   pinch            → zoom / pan

  private bindGestures() {
    const st = this.stage;
    const pts = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pending' | 'value' | 'menu' | 'pinch' | 'crop' | 'compare' = 'none';
    let sx = 0, sy = 0, startVal = 0, startIdx = 0, lastStep = 0;
    let pinch0 = { d: 1, mx: 0, my: 0, s: 1, x: 0, y: 0 };
    let holdTimer = 0;
    let lastTap = { t: 0, x: 0, y: 0 };

    const center = () => {
      const r = st.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };

    st.addEventListener('pointerdown', (e) => {
      if (!this.img) return;
      if (this.menuTap) {
        if (!(e.target as HTMLElement).closest('#menu')) this.showMenu(false);
        return;
      }
      st.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && this.tool.kind !== 'crop') {
        clearTimeout(holdTimer);
        if (mode === 'value' || mode === 'menu') this.finishSwipe(mode);
        this.setCompare(false);
        const [a, b] = [...pts.values()];
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ...this.zoom };
        mode = 'pinch';
        return;
      }
      if (pts.size > 1) return;
      sx = e.clientX;
      sy = e.clientY;
      if (this.tool.kind === 'crop' && this.cropGrab(e)) {
        mode = 'crop';
        return;
      }
      mode = 'pending';
      clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        if (mode === 'pending') {
          mode = 'compare';
          this.setCompare(true);
          buzz(10);
        }
      }, 420);
    });

    st.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const s = Math.min(10, Math.max(1, (pinch0.s * d) / pinch0.d));
        const { cx, cy } = center();
        const px = (pinch0.mx - cx - pinch0.x) / pinch0.s;
        const py = (pinch0.my - cy - pinch0.y) / pinch0.s;
        this.zoom = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: mx - cx - px * s, y: my - cy - py * s };
        this.applyZoom();
        return;
      }
      if (mode === 'crop') {
        this.crop.move(e);
        return;
      }
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (mode === 'pending' && Math.hypot(dx, dy) > 9) {
        clearTimeout(holdTimer);
        const id = this.currentParam();
        if (!id) {
          mode = 'none';
          return;
        }
        if (Math.abs(dx) >= Math.abs(dy)) {
          mode = 'value';
          startVal = this.get(id);
          if (this.tool.kind === 'crop') this.crop.setGrid(true);
        } else if (this.params().length > 1) {
          mode = 'menu';
          startIdx = this.paramIdx[this.tool.id] ?? 0;
          lastStep = startIdx;
          this.showMenu(true);
        } else mode = 'none';
      }
      if (mode === 'value') {
        const id = this.currentParam()!;
        const d = this.def(id);
        const range = (d.swipe ?? d.max - d.min) * 0.85;
        const before = this.get(id);
        let v = startVal + ((e.clientX - sx) / st.clientWidth) * range;
        if (d.hue) v = ((v % 360) + 360) % 360;
        this.set(id, v);
        const after = this.get(id);
        if ((before - d.def) * (after - d.def) < 0 || ((after === d.min || after === d.max) && before !== after)) buzz(8);
        this.showHud(id);
        this.updateParamBar();
      } else if (mode === 'menu') {
        const n = this.params().length;
        const i = Math.max(0, Math.min(n - 1, startIdx + Math.round((e.clientY - sy) / 40)));
        if (i !== lastStep) {
          lastStep = i;
          buzz(4);
          this.paramIdx[this.tool.id] = i;
          this.highlightMenu(i);
        }
      }
    });

    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      clearTimeout(holdTimer);
      if (mode === 'pinch') {
        if (pts.size === 0) mode = 'none';
        return;
      }
      if (mode === 'crop') {
        this.crop.end();
        this.updateChrome();
      } else if (mode === 'compare') {
        this.setCompare(false);
      } else if (mode === 'value' || mode === 'menu') {
        this.finishSwipe(mode);
      } else if (mode === 'pending' && e.type === 'pointerup') {
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          const id = this.currentParam();
          if (id) {
            this.set(id, this.def(id).def);
            this.commit();
            this.showHud(id);
            this.hideHudSoon();
            this.updateParamBar();
            this.buildChips();
            buzz(10);
          }
          lastTap = { t: 0, x: 0, y: 0 };
        } else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      mode = 'none';
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    // desktop: wheel = zoom
    st.addEventListener('wheel', (e) => {
      if (!this.img || this.tool.kind === 'crop') return;
      e.preventDefault();
      const { cx, cy } = center();
      const s = Math.min(10, Math.max(1, this.zoom.s * Math.exp(-e.deltaY * 0.002)));
      const px = (e.clientX - cx - this.zoom.x) / this.zoom.s;
      const py = (e.clientY - cy - this.zoom.y) / this.zoom.s;
      this.zoom = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: e.clientX - cx - px * s, y: e.clientY - cy - py * s };
      this.applyZoom();
    }, { passive: false });
  }

  private finishSwipe(mode: 'value' | 'menu') {
    this.crop.setGrid(false);
    if (mode === 'value') {
      this.commit();
      this.hideHudSoon();
      this.buildChips();
    } else {
      this.showMenu(false);
      const id = this.currentParam();
      if (id) {
        this.showHud(id);
        this.hideHudSoon();
      }
    }
    this.updateParamBar();
    this.updateChrome();
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
  // Tool actions

  private action(id: string) {
    const v = this.state.v;
    const g = this.state.geo;
    const setMany = (o: Record<string, number>) => Object.assign(v, o);
    const [kind, arg] = id.split(':');
    switch (kind) {
      case 'auto':
        this.autoTone();
        break;
      case 'autowb':
        this.autoWB();
        break;
      case 'bw':
        v.bw = v.bw > 0 ? 0 : 100;
        break;
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
        g.quarter = (g.quarter + 1) % 4;
        g.crop = fitAspect(this.aspectNorm());
        break;
      case 'flipH':
        g.flipH = !g.flipH;
        break;
      case 'flipV':
        g.flipV = !g.flipV;
        break;
      case 'cropReset':
        this.state.geo = defaultState().geo;
        v.straighten = 0;
        this.aspectId = 'free';
        break;
    }
    this.commit();
    this.requestRender();
    this.refreshPanel();
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

  private analysis() {
    const img = this.img!;
    const st = { ...defaultState(), geo: this.state.geo };
    st.v.straighten = this.state.v.straighten;
    const { w, h } = outputSize(st, img.thumb.w, img.thumb.h);
    return this.pipe.analysisPixels(img.thumb, st, w, h);
  }

  private autoTone() {
    if (!this.img) return;
    const px = this.analysis();
    const ys: number[] = [];
    for (let i = 0; i < px.length; i += 4) ys.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    ys.sort((a, b) => a - b);
    const q = (f: number) => ys[Math.min(ys.length - 1, Math.floor(f * ys.length))];
    const med = Math.max(1e-4, q(0.5));
    const ev = Math.max(-2, Math.min(2, Math.log2(0.16 / med) * 0.7));
    const k = 2 ** ev;
    const perc = (l: number) => Math.pow(Math.max(0, l * k), 1 / 2.2);
    const hi = perc(q(0.985));
    const lo = perc(q(0.02));
    const v = this.state.v;
    v.exposure = Math.round(ev * 100) / 100;
    v.highlights = hi > 0.92 ? -Math.round(Math.min(70, (hi - 0.85) * 220)) : 0;
    v.whites = hi < 0.86 ? Math.round(Math.min(45, (0.92 - hi) * 140)) : 0;
    v.shadows = lo < 0.1 ? Math.round(Math.min(45, (0.14 - lo) * 260)) : 0;
    v.blacks = lo > 0.12 ? -Math.round(Math.min(35, (lo - 0.06) * 110)) : 0;
    v.contrast = Math.max(v.contrast, 8);
    v.vibrance = Math.max(v.vibrance, 10);
    this.toast('Auto adjusted');
  }

  /**
   * Estimate white balance from pixels that are probably neutral (stone, cloud, walls):
   * low saturation, not too dark, not clipped. Falls back to the brightest unclipped pixels.
   */
  private autoWB() {
    if (!this.img) return;
    const px = this.analysis();
    const pick = (maxSat: number) => {
      let R = 0, G = 0, B = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx > 0.97 || mx < 0.03) continue;
        if ((mx - mn) / mx > maxSat) continue;
        const w = mx; // brighter neutrals are more reliable
        R += r * w;
        G += g * w;
        B += b * w;
        n++;
      }
      return { R, G, B, n };
    };
    const total = px.length / 4;
    let s = pick(0.18);
    if (s.n < total * 0.01) s = pick(0.32);
    if (s.n < total * 0.005) {
      this.toast('No neutral areas found to set white balance');
      return;
    }
    const A = Math.log2(s.G / Math.max(s.R, 1e-6));
    const Bb = Math.log2(s.G / Math.max(s.B, 1e-6));
    // analysis pixels are unedited, so this is an absolute setting
    const t = (A - Bb) / 1.1;
    const m = (A + Bb) / 1.3;
    this.state.v.temp = Math.round(Math.max(-60, Math.min(60, t * 100 * 0.9)));
    this.state.v.tint = Math.round(Math.max(-50, Math.min(50, m * 100 * 0.9)));
    this.toast('White balance set');
  }

  // -----------------------------------------------------------------------------------
  // Looks

  private allLooks(): Look[] {
    return [...LOOKS, ...this.userLooks()];
  }
  private userLooks(): Look[] {
    try {
      return JSON.parse(localStorage.getItem('lumen.looks') || '[]');
    } catch {
      return [];
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
    this.state = this.lookState(this.look.base, L, this.look.amt / 100);
    this.state.geo = geo;
    this.state.v.straighten = straighten;
  }

  private buildThumbs() {
    if (!this.img) return;
    const base = this.look.base ?? this.state;
    const looks = this.allLooks();
    const key = JSON.stringify([base, looks.length, this.img.name]);
    const row = $('looks');
    if (key === this.thumbsKey && row.childElementCount === looks.length) {
      this.markLooks();
      return;
    }
    this.thumbsKey = key;
    row.innerHTML = '';
    const img = this.img;
    looks.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'look';
      const c = document.createElement('canvas');
      c.className = 'th';
      b.appendChild(c);
      b.appendChild(document.createTextNode(L.name));
      b.onclick = () => {
        if (!this.look.base) this.look.base = cloneState(this.state);
        if (this.look.idx !== i) this.look.amt = 100;
        this.look.idx = i;
        this.applyLookValues();
        this.commit();
        this.requestRender();
        this.refreshPanel();
      };
      row.appendChild(b);
    });
    // render thumbnails progressively so the UI stays responsive
    let i = 0;
    const step = () => {
      if (this.thumbsKey !== key || i >= looks.length || this.img !== img) return;
      const st = this.lookState(base, looks[i], 1);
      const { w, h } = outputSize(st, img.thumb.w, img.thumb.h);
      const px = this.pipe.renderPixels(img.thumb, st, w, h);
      const c = row.children[i]?.querySelector('canvas') as HTMLCanvasElement | null;
      if (c) {
        c.width = w;
        c.height = h;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
        c.style.objectFit = 'cover';
      }
      i++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    this.markLooks();
  }

  private markLooks() {
    $('looks').querySelectorAll('.look').forEach((el, i) => el.classList.toggle('on', i === this.look.idx));
    $('paramBar').classList.toggle('hidden', this.look.idx < 1);
  }

  // -----------------------------------------------------------------------------------
  // More menu

  private bindMore() {
    const sheet = $('moreSheet');
    $('btnMore').onclick = () => sheet.classList.add('on');
    sheet.onclick = (e) => {
      if (e.target === sheet) sheet.classList.remove('on');
    };
    sheet.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        sheet.classList.remove('on');
        const a = b.dataset.a;
        if (a === 'open') $('btnOpen').click();
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
          this.refreshPanel();
          this.toast('Edits pasted');
        } else if (a === 'savePreset') {
          const name = prompt('Name this look', 'My look');
          if (!name) return;
          const d = defaultValues();
          const v: Record<string, number> = {};
          for (const [k, x] of Object.entries(this.state.v)) {
            if (k !== 'straighten' && k !== 'distortion' && x !== d[k]) v[k] = x;
          }
          const looks = this.userLooks();
          looks.push({ name, v, curves: this.state.curves });
          localStorage.setItem('lumen.looks', JSON.stringify(looks));
          this.thumbsKey = '';
          this.toast(`Saved “${name}” to Looks`);
        } else if (a === 'resetAll') {
          this.state = defaultState();
          this.aspectId = 'free';
          this.look = { base: null, idx: -1, amt: 100 };
          this.commit();
          this.requestRender();
          this.refreshPanel();
        }
      };
    });
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.img || (e.target as HTMLElement).tagName === 'INPUT') return;
      const id = this.currentParam();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.restore(this.hIdx + (e.shiftKey ? 1 : -1));
        return;
      }
      if (e.key === '\\') {
        this.setCompare(!this.compare);
        return;
      }
      if (!id) return;
      const d = this.def(id);
      const n = this.params().length;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = Math.max(0, Math.min(n - 1, (this.paramIdx[this.tool.id] ?? 0) + (e.key === 'ArrowUp' ? -1 : 1)));
        this.paramIdx[this.tool.id] = i;
        this.updateParamBar();
        this.showHud(this.currentParam()!);
        this.hideHudSoon();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = ((d.max - d.min) / 200) * (e.shiftKey ? 10 : 1);
        this.set(id, this.get(id) + (e.key === 'ArrowRight' ? step : -step));
        this.updateParamBar();
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
  }

  private exportDims(size: string) {
    const img = this.img!;
    const full = outputSize(this.state, img.full.w, img.full.h);
    const long = Math.max(full.w, full.h);
    let target = size === 'full' ? long : +size;
    let k = Math.min(1, target / long);
    if (this.exportOpts.format === 'png' && full.w * full.h * k * k > CANVAS_LIMIT) {
      k = Math.sqrt(CANVAS_LIMIT / (full.w * full.h));
    }
    return { w: Math.max(1, Math.round(full.w * k)), h: Math.max(1, Math.round(full.h * k)), k };
  }

  private buildExportSizes() {
    const box = $('exSize');
    box.innerHTML = '';
    const img = this.img!;
    const full = outputSize(this.state, img.full.w, img.full.h);
    const long = Math.max(full.w, full.h);
    const opts = [
      ['full', 'Full'],
      ['4096', '4K'],
      ['2048', 'Large'],
      ['1080', 'Social'],
    ].filter(([v]) => v === 'full' || +v < long);
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
      : `${((d.w * d.h) / 1e6).toFixed(1)} MP · all edits applied at full quality`;
    ($('exGo') as HTMLButtonElement).textContent = /iPhone|iPad|Android/i.test(navigator.userAgent) ? 'Save / Share' : 'Download';
  }

  private async doExport() {
    if (!this.img) return;
    $('sheet').classList.remove('on');
    const img = this.img;
    const d = this.exportDims(this.exportOpts.size);
    this.busy('Exporting… 0%');
    let tmp: Target | null = null;
    try {
      // for big downscales, start from a smaller copy of the source to avoid aliasing
      let full = img.full;
      if (d.k < 0.5) {
        const kk = Math.min(1, d.k * 1.5);
        tmp = this.pipe.resize(img.full, Math.round(img.full.w * kk), Math.round(img.full.h * kk));
        full = { tex: tmp.tex, w: tmp.w, h: tmp.h, linear: img.full.linear };
      }
      const blob = await renderExport({
        pipeline: this.pipe,
        full,
        analysis: img.preview,
        state: this.state,
        w: d.w,
        h: d.h,
        format: this.exportOpts.format,
        quality: this.exportOpts.quality,
        progress: (f) => this.busy(`Exporting… ${Math.round(f * 100)}%`),
      });
      if (tmp) {
        this.g.destroy(tmp);
        tmp = null;
      }
      this.busy(null);
      const base = img.name.replace(/\.[^.]+$/, '');
      const name = `${base}-lumen.${this.exportOpts.format === 'png' ? 'png' : 'jpg'}`;
      const how = await saveOrShare(blob, name);
      this.toast(how === 'shared' ? 'Shared' : `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB)`);
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
