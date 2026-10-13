import { GL, Program, Target } from './glutil';
import { BLUR, BRIGHT, DEVELOP, DOWNSAMPLE, FINISH, GEOMETRY } from './shaders';
import { buildCurveLut, isIdentity, LUT_SIZE } from '../curves';
import { EditState, GRADE_ZONES, HSL_BANDS, Geometry, MAX_MASKS, MAX_SPOTS, MAX_SPOT_CIRCLES, spotCircles } from '../params';

export interface Source {
  tex: WebGLTexture;
  w: number;
  h: number;
  linear: boolean;
}

interface Globals {
  key: string;
  w: number;
  h: number;
  A: Target;
  /** Large blurs for texture / clarity / dehaze / diffusion; only made when one of those is in use. */
  texB: Target | null;
  clarB: Target | null;
  largeB: Target | null;
}

interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Geometry helpers shared by the pipeline and the crop UI. */
export function frameSize(geo: Geometry, w: number, h: number) {
  return geo.quarter % 2 ? { w: h, h: w } : { w, h };
}
export function coverScale(angleRad: number, fw: number, fh: number) {
  const c = Math.abs(Math.cos(angleRad));
  const s = Math.abs(Math.sin(angleRad));
  return Math.max((fw * c + fh * s) / fw, (fw * s + fh * c) / fh);
}
export function outputSize(state: EditState, w: number, h: number) {
  const f = frameSize(state.geo, w, h);
  return {
    w: Math.max(1, Math.round(f.w * state.geo.crop.w)),
    h: Math.max(1, Math.round(f.h * state.geo.crop.h)),
  };
}

/** Settings only the finish pass reads (halation/glow/blur *amounts* are checked separately). */
/** brush settings: they only change what the next stroke looks like */
const BRUSH_ONLY = /^((dx|lk)(Brush|Hard)|healSize)$/;
const FINISH_ONLY = /^(halation|halThreshold|halRadius|halHue|halSat|glow|glowThreshold|glowRadius|glowWarmth|vig\w*|grain\w*|ca|blur(Type|Amt|Size|Feather|Angle|X|Y))$/;

export class Pipeline {
  g: GL;
  private geo: Program;
  private down: Program;
  private blurP: Program;
  private bright: Program;
  private dev: Program;
  private fin: Program;
  private lut: WebGLTexture;
  private lutKey = '';
  private globals: Globals | null = null;
  private smallCache = new Map<string, Target>();
  private smallCacheKey = '';
  private black: WebGLTexture;
  /** Brush mask atlas (two RGBA textures = 8 channels), owned by the app. */
  brushTex: [WebGLTexture, WebGLTexture] | null = null;
  /** Index of the mask to tint on screen, or -1. */
  showMask = -1;
  /** Highlight clipped highlights/shadows on screen. */
  clip = false;
  /** Tests: always build the big blurs, to compare against the lazy path. */
  forceBlurs = false;
  /** Double exposure: the second photo's texture (sRGB) and its hide-brush (atlas, red channel). */
  overlay: { tex: WebGLTexture; id: string } | null = null;
  /** Light leak texture (procedural) */
  leak: { tex: WebGLTexture; id: string } | null = null;
  /** Hide-brush atlas for both layers (red = double exposure, green = leak) */
  overlayMask: WebGLTexture | null = null;
  /** Content-aware fill result in frame space (rgb + amount), and the key of what it was made from */
  fill: { tex: WebGLTexture; key: string } | null = null;

  constructor(g: GL) {
    this.g = g;
    const gl = g.gl;
    this.geo = new Program(gl, GEOMETRY, 'geometry');
    this.down = new Program(gl, DOWNSAMPLE, 'downsample');
    this.blurP = new Program(gl, BLUR, 'blur');
    this.bright = new Program(gl, BRIGHT, 'bright');
    this.dev = new Program(gl, DEVELOP, 'develop');
    this.fin = new Program(gl, FINISH, 'finish');
    // all six were started above; now wait for them together
    for (const p of [this.geo, this.down, this.blurP, this.bright, this.dev, this.fin]) p.check();
    this.lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, LUT_SIZE, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.black = g.texture(1, 1, 'u8');
    gl.bindTexture(gl.TEXTURE_2D, this.black);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  /** Forget cached blurs (call when the source image changes). */
  invalidate() {
    if (this.globals) {
      for (const t of [this.globals.A, this.globals.texB, this.globals.clarB, this.globals.largeB]) this.g.release(t);
    }
    this.globals = null;
    this.clearSmall();
    this.clearFx();
  }

  private fxCache = new Map<string, { key: string; a: Target | null; b: Target | null }>();
  private clearFx() {
    for (const c of this.fxCache.values()) {
      this.g.release(c.a);
      this.g.release(c.b);
    }
    this.fxCache.clear();
  }

  /** Everything that decides what the developed image looks like (i.e. all but the finish-pass settings). */
  private devKey(state: EditState, geoKey: string) {
    const v: Record<string, number> = {};
    for (const k in state.v) if (!FINISH_ONLY.test(k) && !BRUSH_ONLY.test(k)) v[k] = state.v[k];
    return JSON.stringify([geoKey, v, state.curves, state.masks, this.showMask]);
  }

  private clearSmall() {
    for (const t of this.smallCache.values()) this.g.release(t);
    this.smallCache.clear();
  }

  // ---------------------------------------------------------------------------------
  // Basic passes

  /** Halve (roughly) until close to the target, then resample to the exact size. */
  resize(src: { tex: WebGLTexture; w: number; h: number }, w: number, h: number, float = true): Target {
    let cur: { tex: WebGLTexture; w: number; h: number } = src;
    let owned: Target | null = null;
    while (cur.w > w * 2 && cur.h > h * 2) {
      const next = this.g.acquire(Math.ceil(cur.w / 2), Math.ceil(cur.h / 2), float);
      this.downsample(cur, next);
      if (owned) this.g.release(owned);
      owned = next;
      cur = next;
    }
    const out = this.g.acquire(w, h, float);
    this.downsample(cur, out, cur.w > w * 1.25 ? 0.5 : 0.0);
    if (owned) this.g.release(owned);
    return out;
  }

  private downsample(src: { tex: WebGLTexture; w: number; h: number }, dst: Target, tap = 0.5) {
    const gl = this.g.gl;
    this.g.draw(this.down, dst, dst.w, dst.h, (p) => {
      this.g.bindTex(p, 'uSrc', src.tex);
      gl.uniform2f(p.loc('uTexel'), tap / src.w, tap / src.h);
    });
  }

  /** Gaussian blur, done at reduced resolution for big radii. Returns a new target. */
  blur(src: Target, sigma: number): Target {
    let cur = src;
    let s = sigma;
    let owned: Target | null = null;
    while (s > 4 && cur.w > 12 && cur.h > 12) {
      const next = this.g.acquire(Math.ceil(cur.w / 2), Math.ceil(cur.h / 2));
      this.downsample(cur, next);
      if (owned) this.g.release(owned);
      owned = next;
      cur = next;
      s = Math.sqrt(Math.max(0.25, (s / 2) ** 2 - 0.5));
    }
    s = Math.max(0.5, s);
    const gl = this.g.gl;
    const tmp = this.g.acquire(cur.w, cur.h);
    const out = this.g.acquire(cur.w, cur.h);
    this.g.draw(this.blurP, tmp, cur.w, cur.h, (p) => {
      this.g.bindTex(p, 'uSrc', cur.tex);
      gl.uniform2f(p.loc('uDir'), 1 / cur.w, 0);
      gl.uniform1f(p.loc('uSigma'), s);
    });
    this.g.draw(this.blurP, out, cur.w, cur.h, (p) => {
      this.g.bindTex(p, 'uSrc', tmp.tex);
      gl.uniform2f(p.loc('uDir'), 0, 1 / cur.h);
      gl.uniform1f(p.loc('uSigma'), s);
    });
    this.g.release(tmp);
    if (owned) this.g.release(owned);
    return out;
  }

  private geometryPass(src: Source, state: EditState, full: { w: number; h: number }, tile: Tile, dst: Target) {
    const gl = this.g.gl;
    const geo = state.geo;
    const f = frameSize(geo, src.w, src.h);
    const angle = (state.v.straighten * Math.PI) / 180;
    this.g.draw(this.geo, dst, dst.w, dst.h, (p) => {
      this.g.bindTex(p, 'uSrc', src.tex);
      gl.uniform1f(p.loc('uSrcLinear'), src.linear ? 1 : 0);
      gl.uniform2f(p.loc('uSrcSize'), src.w, src.h);
      gl.uniform2f(p.loc('uFrameSize'), f.w, f.h);
      gl.uniform4f(p.loc('uCrop'), geo.crop.x, geo.crop.y, geo.crop.w, geo.crop.h);
      gl.uniform1f(p.loc('uAngle'), angle);
      gl.uniform1f(p.loc('uCover'), coverScale(angle, f.w, f.h));
      gl.uniform1i(p.loc('uQuarter'), ((geo.quarter % 4) + 4) % 4);
      gl.uniform2f(p.loc('uFlip'), geo.flipH ? -1 : 1, geo.flipV ? -1 : 1);
      gl.uniform1f(p.loc('uDistort'), (state.v.distortion / 100) * 0.3);
      gl.uniform2f(p.loc('uFull'), full.w, full.h);
      gl.uniform4f(p.loc('uTile'), tile.x, tile.y, tile.w, tile.h);
      const spots = (state.spots ?? []).slice(0, MAX_SPOTS);
      const C = new Float32Array(MAX_SPOT_CIRCLES * 4), P = new Float32Array(MAX_SPOTS * 8);
      const painted = spots.filter((sp) => sp.pts && sp.pts.length >= 4).length;
      const per = Math.max(4, Math.min(48, Math.floor((MAX_SPOT_CIRCLES - (spots.length - painted)) / Math.max(1, painted))));
      let n = 0;
      spots.forEach((sp, i) => {
        P.set([sp.ox, sp.oy, sp.c[0], sp.c[1], sp.c[2], 0, 0, 0], i * 8);
        for (const [x, y] of spotCircles(sp, f.w / f.h, per)) {
          if (n >= MAX_SPOT_CIRCLES) break;
          C.set([x, y, sp.r, i], n * 4);
          n++;
        }
      });
      gl.uniform1i(p.loc('uCircCount'), n);
      gl.uniform4fv(p.loc('uCirc'), C);
      gl.uniform4fv(p.loc('uPatch'), P);
      // layers: double exposure (0) and light leak (1)
      const v = state.v;
      const layers = [
        { st: state.overlay, tex: this.overlay, pre: 'dx' },
        { st: state.leak, tex: this.leak, pre: 'lk' },
      ];
      const on = [0, 0], maskOn = [0, 0], LC = new Float32Array(4), LH = new Float32Array(4), rot = [0, 0], op = [0, 0], bl = [0, 0];
      layers.forEach((L, i) => {
        const ok = !!(L.st && L.tex && L.tex.id === L.st.id && v[L.pre + 'Opacity'] > 0);
        on[i] = ok ? 1 : 0;
        this.g.bindTex(p, i ? 'uLy1' : 'uLy0', ok ? L.tex!.tex : this.black);
        if (!ok) return;
        // at 100% the layer just covers the frame
        const k = Math.max(f.w / L.st!.aspect, f.h) * (v[L.pre + 'Scale'] / 100);
        LC.set([v[L.pre + 'X'], v[L.pre + 'Y']], i * 2);
        LH.set([(L.st!.aspect * k) / 2, k / 2], i * 2);
        rot[i] = (v[L.pre + 'Rot'] * Math.PI) / 180;
        op[i] = v[L.pre + 'Opacity'] / 100;
        bl[i] = Math.round(v[L.pre + 'Blend']);
        const has = !!((L.st!.strokes.length || L.st!.person) && this.overlayMask);
        maskOn[i] = L.st!.invert ? (has ? 2 : -1) : has ? 1 : 0;
      });
      gl.uniform1iv(p.loc('uLyOn'), on);
      gl.uniform1fv(p.loc('uLyMaskOn'), maskOn);
      gl.uniform2fv(p.loc('uLyC'), LC);
      gl.uniform2fv(p.loc('uLyHalf'), LH);
      gl.uniform1fv(p.loc('uLyRot'), rot);
      gl.uniform1fv(p.loc('uLyOpacity'), op);
      gl.uniform1iv(p.loc('uLyBlend'), bl);
      this.g.bindTex(p, 'uLayerMask', this.overlayMask ?? this.black);
      const fillOn = !!(state.fills?.length && this.fill);
      gl.uniform1i(p.loc('uFillOn'), fillOn ? 1 : 0);
      this.g.bindTex(p, 'uFill', fillOn ? this.fill!.tex : this.black);
    });
  }

  /** Read a rectangle of the unedited, geometry-applied image (linear, 8-bit). */
  geometryRegion(src: Source, state: EditState, w: number, h: number, rect: Tile) {
    const t = this.g.acquire(w, h, false);
    this.geometryPass(src, state, { w, h }, { x: 0, y: 0, w, h }, t);
    const gl = this.g.gl;
    const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
    const rw = Math.max(1, Math.min(w - x, Math.ceil(rect.w))), rh = Math.max(1, Math.min(h - y, Math.ceil(rect.h)));
    const px = new Uint8Array(rw * rh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(x, y, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.g.release(t);
    return { px, x, y, w: rw, h: rh };
  }

  private geoKey(src: Source, state: EditState, w: number, h: number) {
    const v = state.v;
    const lay = (st: EditState['overlay'], t: { id: string } | null, pre: string) =>
      st && t?.id === st.id ? [st, v[pre + 'Opacity'], v[pre + 'Scale'], v[pre + 'Rot'], v[pre + 'Blend'], v[pre + 'X'], v[pre + 'Y']] : null;
    const ov = [lay(state.overlay, this.overlay, 'dx'), lay(state.leak, this.leak, 'lk')];
    const fill = state.fills?.length && this.fill ? this.fill.key : null;
    return JSON.stringify([src.w, src.h, w, h, state.geo, v.straighten, v.distortion, state.spots, ov, fill]);
  }

  /** The full-frame analysis image and its large blurs, at (w, h). Cached by geometry. */
  private ensureGlobals(src: Source, state: EditState, w: number, h: number, cache = true): Globals {
    const key = this.geoKey(src, state, w, h);
    if (cache && this.globals && this.globals.key === key) {
      this.ensureBlurs(this.globals, state);
      return this.globals;
    }
    const A = this.g.acquire(w, h);
    this.geometryPass(src, state, { w, h }, { x: 0, y: 0, w, h }, A);
    const glb: Globals = { key, w, h, A, texB: null, clarB: null, largeB: null };
    this.ensureBlurs(glb, state);
    if (cache) {
      if (this.globals) this.invalidate();
      this.globals = glb;
    }
    return glb;
  }

  private ensureBlurs(glb: Globals, state: EditState) {
    if (glb.texB) return;
    const v = state.v;
    // everything in the develop shader that reads the blurred copies (see yTex / yClar / yLarge there)
    const need = v.texture !== 0 || v.clarity !== 0 || v.dehaze !== 0 || v.diffuse > 0 || v.shadows !== 0 || v.highlights !== 0 ||
      v.colorDenoise > 0 || v.sharpenMask > 0 || (state.masks ?? []).length > 0;
    if (!need && !this.forceBlurs) return;
    const S = Math.min(glb.w, glb.h);
    glb.texB = this.blur(glb.A, S * 0.004);
    glb.clarB = this.blur(glb.A, S * 0.02);
    glb.largeB = this.blur(glb.A, S * 0.06);
  }

  private releaseFx(fx: ReturnType<Pipeline['effects']>) {
    for (const t of [fx.hal, fx.hal2, fx.glow, fx.glow2, fx.blur1, fx.blur2]) this.g.release(t);
  }

  private releaseGlobals(glb: Globals) {
    for (const t of [glb.A, glb.texB, glb.clarB, glb.largeB]) this.g.release(t);
  }

  private updateLut(state: EditState) {
    const key = JSON.stringify(state.curves);
    if (key === this.lutKey) return;
    this.lutKey = key;
    const gl = this.g.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.FLOAT, buildCurveLut(state.curves));
  }

  /** Small blurs used by sharpening and noise reduction, for one tile. */
  private smallBlurs(A: Target, state: EditState, shortEdge: number, cacheKey: string | null) {
    const v = state.v;
    const sharpSigma = Math.max(0.6, shortEdge * 0.0007 * v.sharpenRadius);
    const noiseSigma = Math.max(0.8, shortEdge * 0.0012);
    const get = (name: string, sigma: number, needed: boolean): { t: Target | null; tex: WebGLTexture } => {
      if (!needed) return { t: null, tex: A.tex };
      if (cacheKey) {
        if (cacheKey !== this.smallCacheKey) {
          this.clearSmall();
          this.smallCacheKey = cacheKey;
        }
        const k = name + sigma.toFixed(3);
        let t = this.smallCache.get(k);
        if (!t) {
          t = this.blur(A, sigma);
          this.smallCache.set(k, t);
        }
        return { t: null, tex: t.tex };
      }
      const t = this.blur(A, sigma);
      return { t, tex: t.tex };
    };
    // texture uses the sharpen blur as its fine band, so compute it for either
    const sharp = get('s', sharpSigma, v.sharpen > 0 || v.texture !== 0);
    const noise = get('n', noiseSigma, v.denoise > 0);
    return { sharp, noise };
  }

  private developPass(
    A: Target, state: EditState, glb: Globals, full: { w: number; h: number }, tile: Tile,
    small: ReturnType<Pipeline['smallBlurs']>, dst: Target, rawBase: boolean, frameAspect: number, onScreen = false,
  ) {
    const gl = this.g.gl;
    const v = state.v;
    this.updateLut(state);
    const ex = 2 ** v.exposure;
    const wb = wbMul(v.temp / 100, v.tint / 100).map((x) => x * ex);

    const hslH = HSL_BANDS.map((b) => v[`hsl_${b}_h`] / 100);
    const hslS = HSL_BANDS.map((b) => v[`hsl_${b}_s`] / 100);
    const hslL = HSL_BANDS.map((b) => v[`hsl_${b}_l`] / 100);
    const bwMix = HSL_BANDS.map((b) => v[`bw_${b}`] / 100);
    const zone = (z: string) => chromaOffset(v[`cg_${z}_hue`], (v[`cg_${z}_sat`] / 100) * 0.18);
    const [cgS, cgM, cgH, cgG] = GRADE_ZONES.map(zone);
    const tone = hueColor(v.bw_toneHue, 0.5);

    this.g.draw(this.dev, dst, dst.w, dst.h, (p) => {
      const u1 = (n: string, x: number) => gl.uniform1f(p.loc(n), x);
      this.g.bindTex(p, 'uA', A.tex);
      this.g.bindTex(p, 'uSharpB', small.sharp.tex);
      this.g.bindTex(p, 'uNoiseB', small.noise.tex);
      // unused (and not computed) while texture / clarity / dehaze / diffusion are off
      this.g.bindTex(p, 'uTexB', (glb.texB ?? A).tex);
      this.g.bindTex(p, 'uClarB', (glb.clarB ?? A).tex);
      this.g.bindTex(p, 'uLargeB', (glb.largeB ?? A).tex);
      this.g.bindTex(p, 'uLut', this.lut);
      gl.uniform2f(p.loc('uFull'), full.w, full.h);
      gl.uniform4f(p.loc('uTile'), tile.x, tile.y, tile.w, tile.h);
      gl.uniform3f(p.loc('uWB'), wb[0], wb[1], wb[2]);
      u1('uContrast', v.contrast / 100);
      u1('uHighlights', v.highlights / 100);
      u1('uShadows', v.shadows / 100);
      u1('uWhites', v.whites / 100);
      u1('uBlacks', v.blacks / 100);
      u1('uBrightness', v.brightness / 100);
      u1('uVibrance', v.vibrance / 100);
      u1('uSaturation', v.saturation / 100);
      u1('uSharpen', v.sharpen / 100);
      u1('uSharpMask', v.sharpenMask / 100);
      u1('uTexture', v.texture / 100);
      u1('uClarity', v.clarity / 100);
      u1('uDehaze', v.dehaze / 100);
      u1('uDenoise', v.denoise / 100);
      u1('uColorDenoise', v.colorDenoise / 100);
      u1('uUseLut', isIdentity(state.curves) ? 0 : 1);
      gl.uniform1fv(p.loc('uHslH'), hslH);
      gl.uniform1fv(p.loc('uHslS'), hslS);
      gl.uniform1fv(p.loc('uHslL'), hslL);
      u1('uBw', v.bw / 100);
      gl.uniform1fv(p.loc('uBwMix'), bwMix);
      gl.uniform3fv(p.loc('uBwTone'), tone);
      u1('uBwToneAmt', v.bw_toneAmt / 100);
      gl.uniform3fv(p.loc('uCgShadow'), cgS);
      gl.uniform3fv(p.loc('uCgMid'), cgM);
      gl.uniform3fv(p.loc('uCgHigh'), cgH);
      gl.uniform3fv(p.loc('uCgGlobal'), cgG);
      gl.uniform4f(p.loc('uCgLum'), v.cg_shadows_lum / 100, v.cg_mids_lum / 100, v.cg_highs_lum / 100, v.cg_global_lum / 100);
      u1('uCgBlend', v.cg_blend / 100);
      u1('uCgBalance', v.cg_balance / 100);
      u1('uFade', v.fade / 100);
      u1('uFadeWarm', v.fadeWarmth / 100);
      u1('uDiffuse', v.diffuse / 100);
      u1('uRawBase', rawBase ? 1 : 0);
      this.maskUniforms(p, state, frameAspect, onScreen);
    });
  }

  /**
   * Halation + glow light-spread maps and the lens blur, computed from the full-frame developed
   * image. With a `devKey` (the interactive preview) each map is kept until the developed image or
   * its own settings change, so dragging the halation amount, the blur focus point, vignette,
   * grain… never recomputes them.
   */
  private effects(B: Target, state: EditState, devKey: string | null = null) {
    const v = state.v;
    const S = Math.min(B.w, B.h);
    const slot = (name: string, key: string | null, build: () => readonly [Target | null, Target | null]) => {
      if (!devKey) return build();
      const old = this.fxCache.get(name);
      if (key === null) {
        if (old) {
          this.g.release(old.a);
          this.g.release(old.b);
          this.fxCache.delete(name);
        }
        return [null, null] as const;
      }
      const full = `${devKey}|${B.w}x${B.h}|${key}`;
      if (old?.key === full) return [old.a, old.b] as const;
      if (old) {
        this.g.release(old.a);
        this.g.release(old.b);
      }
      const r = build();
      this.fxCache.set(name, { key: full, a: r[0], b: r[1] });
      return r;
    };
    const make = (amount: number, threshold: number, sigma: number, wideK: number) => {
      if (amount <= 0) return [null, null] as const;
      const gl = this.g.gl;
      const bw = Math.max(8, Math.ceil(B.w / 2));
      const bh = Math.max(8, Math.ceil(B.h / 2));
      const br = this.g.acquire(bw, bh);
      this.g.draw(this.bright, br, bw, bh, (p) => {
        this.g.bindTex(p, 'uSrc', B.tex);
        gl.uniform2f(p.loc('uTexel'), 0.5 / B.w, 0.5 / B.h);
        gl.uniform1f(p.loc('uThreshold'), threshold);
      });
      const k = bw / B.w;
      // two spreads: a tight core and a wide falloff, like light scattering in film
      const core = this.blur(br, sigma * k);
      const wide = this.blur(br, sigma * k * wideK);
      this.g.release(br);
      return [core, wide] as const;
    };
    const hT = 0.35 + (v.halThreshold / 100) * 0.6, hS = S * (0.003 + (v.halRadius / 100) ** 1.4 * 0.035);
    const gT = 0.25 + (v.glowThreshold / 100) * 0.65, gS = S * (0.008 + (v.glowRadius / 100) ** 1.4 * 0.06);
    const [hal, hal2] = slot('hal', v.halation > 0 ? `${hT}|${hS}` : null, () => make(v.halation, hT, hS, 3.5));
    const [glow, glow2] = slot('glow', v.glow > 0 ? `${gT}|${gS}` : null, () => make(v.glow, gT, gS, 3));
    // lens blur in linear light, so bright points bloom like real bokeh
    const [blur1, blur2] = slot('blur', v.blurType > 0 && v.blurAmt > 0 ? `${v.blurAmt}` : null, () => {
      const a = v.blurAmt / 100;
      return [this.blur(B, Math.max(1, S * 0.008 * a)), this.blur(B, Math.max(2, S * 0.03 * a))] as const;
    });
    return { hal, hal2, glow, glow2, blur1, blur2 };
  }

  private finishPass(
    B: Target, bRect: [number, number, number, number], state: EditState, full: { w: number; h: number }, tile: Tile,
    fx: ReturnType<Pipeline['effects']>, dst: Target | null, flipY: boolean,
  ) {
    const gl = this.g.gl;
    const v = state.v;
    const halColor = hueColor(v.halHue, v.halSat / 100);
    const gw = v.glowWarmth / 100;
    const glowColor = [1 + gw * 0.15, 1, 1 - gw * 0.25];
    const w = dst ? dst.w : tile.w;
    const h = dst ? dst.h : tile.h;
    this.g.draw(this.fin, dst, w, h, (p) => {
      const u1 = (n: string, x: number) => gl.uniform1f(p.loc(n), x);
      this.g.bindTex(p, 'uB', B.tex);
      this.g.bindTex(p, 'uHal', fx.hal ? fx.hal.tex : this.black);
      this.g.bindTex(p, 'uHal2', fx.hal2 ? fx.hal2.tex : this.black);
      this.g.bindTex(p, 'uGlow', fx.glow ? fx.glow.tex : this.black);
      this.g.bindTex(p, 'uGlow2', fx.glow2 ? fx.glow2.tex : this.black);
      this.g.bindTex(p, 'uBlur1', fx.blur1 ? fx.blur1.tex : this.black);
      this.g.bindTex(p, 'uBlur2', fx.blur2 ? fx.blur2.tex : this.black);
      gl.uniform1i(p.loc('uBlurType'), fx.blur1 ? Math.round(v.blurType) : 0);
      gl.uniform4f(p.loc('uBlurP'), v.blurX, v.blurY, (v.blurSize / 100) * 0.6, 0.02 + (v.blurFeather / 100) * 0.5);
      gl.uniform1f(p.loc('uBlurAngle'), (v.blurAngle * Math.PI) / 180);
      gl.uniform4f(p.loc('uBRect'), ...bRect);
      gl.uniform2f(p.loc('uBSize'), B.w, B.h);
      gl.uniform2f(p.loc('uFull'), full.w, full.h);
      gl.uniform4f(p.loc('uTile'), tile.x, tile.y, tile.w, tile.h);
      u1('uFlipY', flipY ? 1 : 0);
      u1('uCa', v.ca / 100);
      u1('uHalAmt', (v.halation / 100) * 3.0);
      gl.uniform3fv(p.loc('uHalColor'), halColor);
      u1('uGlowAmt', (v.glow / 100) * 1.4);
      gl.uniform3fv(p.loc('uGlowColor'), glowColor);
      u1('uVig', v.vignette / 100);
      u1('uVigMid', v.vigMidpoint / 100);
      u1('uVigRound', v.vigRound / 100);
      u1('uVigFeather', v.vigFeather / 100);
      u1('uVigHi', v.vigHighlights / 100);
      gl.uniform2f(p.loc('uVigC'), v.vigX ?? 0.5, v.vigY ?? 0.5);
      u1('uGrain', v.grain / 100);
      u1('uGrainCell', 0.55 + (v.grainSize / 100) ** 1.6 * 6.5);
      u1('uGrainRough', v.grainRough / 100);
      u1('uGrainColor', v.grainColor / 100);
      u1('uGrainSh', v.grainShadows / 100);
      u1('uGrainHi', v.grainHighlights / 100);
      u1('uSeed', 1337);
      u1('uClip', flipY && this.clip ? 1 : 0);
    });
  }

  private maskUniforms(p: Program, state: EditState, frameAspect: number, onScreen: boolean) {
    const gl = this.g.gl;
    const masks = (state.masks ?? []).slice(0, MAX_MASKS);
    const n = masks.length;
    const types = new Int32Array(8);
    const G0 = new Float32Array(32), G1 = new Float32Array(32), G2 = new Float32Array(32);
    const A0 = new Float32Array(32), A1 = new Float32Array(32), A2 = new Float32Array(32);
    masks.forEach((m, i) => {
      const g = m.g, a = m.a, o = i * 4;
      // subject (AI) masks are rasterized into the brush atlas, so they render like brushes
      types[i] = { radial: 1, linear: 2, brush: 3, luma: 4, color: 5, subject: 3 }[m.type];
      if (m.type === 'radial') G0.set([g.cx, g.cy, g.rx, g.ry], o);
      else if (m.type === 'linear') G0.set([g.x0, g.y0, g.x1, g.y1], o);
      else if (m.type === 'brush' || m.type === 'subject') G0.set([i, 0, 0, 0], o);
      else if (m.type === 'luma') {
        const lo = g.lo / 100, hi = g.hi / 100, soft = 0.01 + (g.soft / 100) * 0.35;
        G0.set([Math.min(lo, hi), Math.max(lo, hi), soft, 0], o);
      } else if (m.type === 'color') G0.set([g.hue / 360, g.range / 360, 0, 0], o);
      G1.set([g.angle ?? 0, (g.feather ?? 60) / 100, (g.smart ?? 0) / 100, m.invert ? 1 : 0], o);
      G2.set([g.sr ?? 0.5, g.sg ?? 0.5, g.sb ?? 0.5, (g.amount ?? 100) / 100], o);
      A0.set([a.exposure / 1, a.contrast / 100, a.highlights / 100, a.shadows / 100], o);
      const wb = wbMul(a.temp / 100, a.tint / 100).map((x) => Math.pow(x, 1 / 2.2));
      A1.set([wb[0], wb[1], wb[2], a.saturation / 100], o);
      A2.set([a.clarity / 100, a.dehaze / 100, 0, 0], o);
    });
    gl.uniform1i(p.loc('uMaskCount'), n);
    gl.uniform1iv(p.loc('uMType'), types);
    gl.uniform4fv(p.loc('uMG0'), G0);
    gl.uniform4fv(p.loc('uMG1'), G1);
    gl.uniform4fv(p.loc('uMG2'), G2);
    gl.uniform4fv(p.loc('uMA0'), A0);
    gl.uniform4fv(p.loc('uMA1'), A1);
    gl.uniform4fv(p.loc('uMA2'), A2);
    this.g.bindTex(p, 'uBrush0', this.brushTex?.[0] ?? this.black);
    this.g.bindTex(p, 'uBrush1', this.brushTex?.[1] ?? this.black);
    const c = state.geo.crop;
    gl.uniform4f(p.loc('uCrop'), c.x, c.y, c.w, c.h);
    gl.uniform1f(p.loc('uFrameAspect'), frameAspect);
    gl.uniform1i(p.loc('uShowMask'), onScreen && this.showMask < n ? this.showMask : -1);
  }

  // ---------------------------------------------------------------------------------
  // Public entry points

  /**
   * Render the whole image at (w, h). If `dst` is null it draws to the canvas
   * (which must already be sized w × h).
   */
  render(src: Source, state: EditState, w: number, h: number, dst: Target | null, cache = true) {
    const glb = this.ensureGlobals(src, state, w, h, cache);
    const full = { w, h };
    const tile = { x: 0, y: 0, w, h };
    const small = this.smallBlurs(glb.A, state, Math.min(w, h), cache ? glb.key : null);
    const B = this.g.acquire(w, h);
    this.developPass(glb.A, state, glb, full, tile, small, B, src.linear, aspectOf(src, state), dst === null);
    const fx = this.effects(B, state, cache ? this.devKey(state, glb.key) : null);
    this.finishPass(B, [0, 0, 1, 1], state, full, tile, fx, dst, dst === null);
    this.g.release(B);
    if (!cache) this.releaseFx(fx);
    this.g.release(small.sharp.t);
    this.g.release(small.noise.t);
    if (!cache) this.releaseGlobals(glb);
  }

  /** Render to an RGBA8 buffer (top row first). */
  renderPixels(src: Source, state: EditState, w: number, h: number, cache = false) {
    const t = this.g.acquire(w, h, false);
    this.render(src, state, w, h, t, cache);
    const gl = this.g.gl;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.g.release(t);
    return px;
  }

  /** Linear, unedited (but geometry-applied) pixels for auto adjustments. */
  analysisPixels(src: Source, state: EditState, w: number, h: number) {
    const t = this.g.acquire(w, h, false);
    this.geometryPass(src, state, { w, h }, { x: 0, y: 0, w, h }, t);
    const gl = this.g.gl;
    const b = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    this.g.release(t);
    const out = new Float32Array(w * h * 4);
    for (let i = 0; i < b.length; i++) out[i] = b[i] / 255;
    return out;
  }

  /** Image-wide passes for exports and full-res detail: blurs, halation, glow, lens blur. */
  private prepareGlobal(full: Source, analysisSrc: Source, state: EditState, outW: number, outH: number) {
    const g = this.g;
    const k = Math.min(1, 2048 / Math.max(outW, outH));
    const aw = Math.max(16, Math.round(outW * k));
    const ah = Math.max(16, Math.round(outH * k));
    const glb = this.ensureGlobals(analysisSrc, state, aw, ah, false);
    const smallG = this.smallBlurs(glb.A, state, Math.min(aw, ah), null);
    const Bg = g.acquire(aw, ah);
    this.developPass(glb.A, state, glb, { w: aw, h: ah }, { x: 0, y: 0, w: aw, h: ah }, smallG, Bg, full.linear, aspectOf(full, state));
    const fx = this.effects(Bg, state);
    g.release(Bg);
    g.release(smallG.sharp.t);
    g.release(smallG.noise.t);
    return { glb, fx };
  }

  private releaseGlobal(p: ReturnType<Pipeline['prepareGlobal']>) {
    this.releaseFx(p.fx);
    this.releaseGlobals(p.glb);
  }

  /** Render one rectangle of the full-resolution output to RGBA8 (top row first). */
  private renderTile(full: Source, state: EditState, outW: number, outH: number, r: Tile, P: ReturnType<Pipeline['prepareGlobal']>) {
    const g = this.g;
    const gl = g.gl;
    const S = Math.min(outW, outH);
    const pad = Math.ceil(S * 0.012) + 8;
    const fullSize = { w: outW, h: outH };
    const { x, y, w, h } = r;
    const pw = w + pad * 2;
    const ph = h + pad * 2;
    const ptile = { x: x - pad, y: y - pad, w: pw, h: ph };
    const A = g.acquire(pw, ph);
    this.geometryPass(full, state, fullSize, ptile, A);
    const small = this.smallBlurs(A, state, S, null);
    const B = g.acquire(pw, ph);
    this.developPass(A, state, P.glb, fullSize, ptile, small, B, full.linear, aspectOf(full, state));
    g.release(A);
    g.release(small.sharp.t);
    g.release(small.noise.t);
    const out = g.acquire(w, h, false);
    this.finishPass(B, [pad / pw, pad / ph, w / pw, h / ph], state, fullSize, { x, y, w, h }, P.fx, out, false);
    g.release(B);
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    g.release(out);
    return px;
  }

  /** Full-resolution pixels for a region of the output (used for pixel-level zoom). */
  renderRegion(full: Source, analysisSrc: Source, state: EditState, outW: number, outH: number, r: Tile) {
    const P = this.prepareGlobal(full, analysisSrc, state, outW, outH);
    const px = this.renderTile(full, state, outW, outH, r, P);
    this.releaseGlobal(P);
    return px;
  }

  /**
   * Full-resolution, tiled export. `analysisSrc` is a smaller copy of the source used
   * for the image-wide blurs (they're far larger than a tile and resolution independent).
   */
  async exportTiled(
    full: Source, analysisSrc: Source, state: EditState, outW: number, outH: number,
    onStrip: (px: Uint8Array, y: number, rows: number) => void | Promise<void>,
    progress: (f: number) => void,
    /** strips start on rows that are a multiple of this (the JPEG encoder needs 8) */
    align = 1,
  ) {
    const g = this.g;
    const P = this.prepareGlobal(full, analysisSrc, state, outW, outH);
    const S = Math.min(outW, outH);
    const pad = Math.ceil(S * 0.012) + 8;
    const T = Math.floor(Math.min(2048, g.maxTex - pad * 2) / align) * align;
    const tilesX = Math.ceil(outW / T);
    const tilesY = Math.ceil(outH / T);
    let done = 0;
    for (let ty = 0; ty < tilesY; ty++) {
      const y = ty * T;
      const h = Math.min(T, outH - y);
      const strip = new Uint8Array(outW * h * 4);
      for (let tx = 0; tx < tilesX; tx++) {
        const x = tx * T;
        const w = Math.min(T, outW - x);
        const px = this.renderTile(full, state, outW, outH, { x, y, w, h }, P);
        for (let r = 0; r < h; r++) strip.set(px.subarray(r * w * 4, (r + 1) * w * 4), (r * outW + x) * 4);
        done++;
        progress(done / (tilesX * tilesY));
        await new Promise((r) => setTimeout(r, 0));
      }
      await onStrip(strip, y, h);
    }
    this.releaseGlobal(P);
    g.trim(2048 * 2048);
  }
}

/** Luminance-neutral white balance multipliers for temperature/tint in -1..1. */
export function wbMul(t: number, m: number) {
  const wb = [2 ** (t * 0.55 + m * 0.3), 2 ** (-m * 0.35), 2 ** (-t * 0.55 + m * 0.3)];
  const l = 0.2126 * wb[0] + 0.7152 * wb[1] + 0.0722 * wb[2];
  return wb.map((x) => x / l);
}

function aspectOf(src: { w: number; h: number }, state: EditState) {
  const f = frameSize(state.geo, src.w, src.h);
  return f.w / f.h;
}

/** A zero-luminance color offset for the given hue, used by color grading. */
function chromaOffset(hueDeg: number, amount: number): number[] {
  const c = hsv(hueDeg / 360, 1, 1);
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((x) => (x - y) * amount);
}

/** A color of the given hue at `sat`, normalized to unit luminance-ish brightness. */
function hueColor(hueDeg: number, sat: number): number[] {
  const c = hsv(hueDeg / 360, sat, 1);
  return c;
}

function hsv(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}
