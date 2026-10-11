// Content-aware fill: remove an object and rebuild what was behind it from the rest of the
// photo. Multi-scale PatchMatch inpainting (Wexler et al. / Barnes et al.): the hole is filled
// roughly at a small scale, then refined level by level — each hole pixel repeatedly takes the
// average of the best-matching real patches found elsewhere in the picture.
// Pure functions, so it runs in a worker (and in tests).

interface Lvl {
  w: number;
  h: number;
  img: Float32Array; // rgb, 0..255
  hole: Uint8Array; // 1 = to be filled
}

const R = 3; // patch radius (7x7 patches)

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function dilate(mask: Uint8Array, w: number, h: number, r: number) {
  let cur = mask;
  for (let k = 0; k < r; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cur[y * w + x]) continue;
        if ((x > 0 && cur[y * w + x - 1]) || (x < w - 1 && cur[y * w + x + 1]) || (y > 0 && cur[(y - 1) * w + x]) || (y < h - 1 && cur[(y + 1) * w + x])) next[y * w + x] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

function downLevel(l: Lvl): Lvl {
  const w = Math.max(1, l.w >> 1), h = Math.max(1, l.h >> 1);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, r = 0, g = 0, b = 0, hl = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(l.w - 1, x * 2 + dx), sy = Math.min(l.h - 1, y * 2 + dy);
          const i = sy * l.w + sx;
          if (l.hole[i]) hl = 1;
          else {
            r += l.img[i * 3];
            g += l.img[i * 3 + 1];
            b += l.img[i * 3 + 2];
            n++;
          }
        }
      }
      const o = y * w + x;
      hole[o] = hl;
      if (n) {
        img[o * 3] = r / n;
        img[o * 3 + 1] = g / n;
        img[o * 3 + 2] = b / n;
      }
    }
  }
  return { w, h, img, hole };
}

/** Smooth starting guess: peel the hole from its edge inward, averaging known neighbours. */
function diffuse(l: Lvl) {
  const { w, h, img, hole } = l;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < known.length; i++) known[i] = hole[i] ? 0 : 1;
  let left = hole.reduce((a, v) => a + v, 0);
  while (left > 0) {
    const fill: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let n = 0, r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!known[j]) continue;
            r += img[j * 3];
            g += img[j * 3 + 1];
            b += img[j * 3 + 2];
            n++;
          }
        }
        if (n) {
          img[i * 3] = r / n;
          img[i * 3 + 1] = g / n;
          img[i * 3 + 2] = b / n;
          fill.push(i);
        }
      }
    }
    if (!fill.length) break; // nothing known at all
    for (const i of fill) known[i] = 1;
    left -= fill.length;
  }
}

function upsampleInto(dst: Lvl, src: Lvl) {
  for (let y = 0; y < dst.h; y++) {
    const fy = Math.min(src.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(src.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dst.w; x++) {
      const i = y * dst.w + x;
      if (!dst.hole[i]) continue;
      const fx = Math.min(src.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(src.w - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = src.img[(y0 * src.w + x0) * 3 + c] * (1 - tx) + src.img[(y0 * src.w + x1) * 3 + c] * tx;
        const b = src.img[(y1 * src.w + x0) * 3 + c] * (1 - tx) + src.img[(y1 * src.w + x1) * 3 + c] * tx;
        dst.img[i * 3 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
}

/** Refine one level: NNF search + voting, `iters` times. */
function refine(l: Lvl, prev: { l: Lvl; nx: Int32Array; ny: Int32Array } | null, iters: number, rand: () => number, tick: () => void, sharp = 8) {
  const { w, h, img, hole } = l;
  // integral image of the hole mask: a source patch must contain no hole pixels
  const W1 = w + 1;
  const integ = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hole[y * w + x];
      integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
    }
  }
  const valid = (sx: number, sy: number) => {
    if (sx < R || sy < R || sx >= w - R || sy >= h - R) return false;
    const x0 = sx - R, y0 = sy - R, x1 = sx + R + 1, y1 = sy + R + 1;
    return integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0] === 0;
  };
  const srcList: number[] = [];
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) if (valid(x, y)) srcList.push(y * w + x);
  const targets: number[] = [];
  for (let i = 0; i < w * h; i++) if (hole[i]) targets.push(i);
  if (!srcList.length || !targets.length) return { nx: new Int32Array(w * h), ny: new Int32Array(w * h) };

  const nx = new Int32Array(w * h), ny = new Int32Array(w * h);
  const dist = new Float32Array(w * h).fill(Infinity);

  const patchDist = (tx: number, ty: number, sx: number, sy: number, limit: number) => {
    let d = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = Math.min(h - 1, Math.max(0, ty + dy));
      const so = ((sy + dy) * w + sx - R) * 3;
      for (let dx = -R; dx <= R; dx++) {
        const xx = Math.min(w - 1, Math.max(0, tx + dx));
        const ti = (yy * w + xx) * 3, si = so + (dx + R) * 3;
        const a = img[ti] - img[si], b = img[ti + 1] - img[si + 1], c = img[ti + 2] - img[si + 2];
        d += a * a + b * b + c * c;
      }
      if (d >= limit) return d;
    }
    return d;
  };

  // initial guess: from the coarser level where possible, otherwise random real patches
  for (const t of targets) {
    const tx = t % w, ty = (t / w) | 0;
    let ok = false;
    if (prev) {
      const pi = Math.min(prev.l.h - 1, ty >> 1) * prev.l.w + Math.min(prev.l.w - 1, tx >> 1);
      const sx = prev.nx[pi] * 2 + (tx & 1), sy = prev.ny[pi] * 2 + (ty & 1);
      if (valid(sx, sy)) {
        nx[t] = sx;
        ny[t] = sy;
        ok = true;
      }
    }
    if (!ok) {
      const s = srcList[Math.floor(rand() * srcList.length)];
      nx[t] = s % w;
      ny[t] = (s / w) | 0;
    }
    dist[t] = patchDist(tx, ty, nx[t], ny[t], Infinity);
  }

  const maxR = Math.max(w, h);
  const acc = new Float32Array(w * h * 3), wsum = new Float32Array(w * h);
  for (let it = 0; it < iters; it++) {
    const fwd = it % 2 === 0;
    const order = fwd ? targets : targets.slice().reverse();
    const step = fwd ? 1 : -1;
    for (const t of order) {
      const tx = t % w, ty = (t / w) | 0;
      let bx = nx[t], by = ny[t], bd = dist[t];
      // propagation from the already-visited neighbours
      for (const [ox, oy] of [[-step, 0], [0, -step]]) {
        const qx = tx + ox, qy = ty + oy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        if (!hole[q]) continue;
        const sx = nx[q] - ox, sy = ny[q] - oy;
        if (!valid(sx, sy)) continue;
        const d = patchDist(tx, ty, sx, sy, bd);
        if (d < bd) {
          bd = d;
          bx = sx;
          by = sy;
        }
      }
      // random search, shrinking around the best so far
      for (let rr = maxR; rr >= 1; rr = Math.floor(rr / 2)) {
        const sx = bx + Math.round((rand() * 2 - 1) * rr), sy = by + Math.round((rand() * 2 - 1) * rr);
        if (!valid(sx, sy)) continue;
        const d = patchDist(tx, ty, sx, sy, bd);
        if (d < bd) {
          bd = d;
          bx = sx;
          by = sy;
        }
      }
      nx[t] = bx;
      ny[t] = by;
      dist[t] = bd;
    }
    // vote: every hole pixel becomes the weighted average of what the patches around it say
    acc.fill(0);
    wsum.fill(0);
    for (const t of targets) {
      const tx = t % w, ty = (t / w) | 0;
      // low `sharp` = trust only the best matches (crisp texture); high = blend many (smooth)
      const wt = Math.exp(-Math.sqrt(dist[t] / (3 * (2 * R + 1) ** 2)) / (it === iters - 1 ? sharp * 0.4 : sharp));
      for (let dy = -R; dy <= R; dy++) {
        const qy = ty + dy;
        if (qy < 0 || qy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const qx = tx + dx;
          if (qx < 0 || qx >= w) continue;
          const q = qy * w + qx;
          if (!hole[q]) continue;
          const si = ((ny[t] + dy) * w + nx[t] + dx) * 3;
          acc[q * 3] += img[si] * wt;
          acc[q * 3 + 1] += img[si + 1] * wt;
          acc[q * 3 + 2] += img[si + 2] * wt;
          wsum[q] += wt;
        }
      }
    }
    for (const t of targets) {
      if (wsum[t] > 0) {
        img[t * 3] = acc[t * 3] / wsum[t];
        img[t * 3 + 1] = acc[t * 3 + 1] / wsum[t];
        img[t * 3 + 2] = acc[t * 3 + 2] / wsum[t];
      }
    }
    tick();
  }
  return { nx, ny };
}

/** A soft 0..1 edge for a fill: the (grown) mask blurred a little. */
export function featherAlpha(grown: Uint8Array, w: number, h: number) {
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = grown[i];
  for (let pass = 0; pass < 2; pass++) {
    const src = alpha.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[(y + dy) * w + x + dx];
        alpha[y * w + x] = s / 9;
      }
    }
  }
  return alpha;
}

export interface InpaintResult {
  /** RGBA, same size as the input: filled colors, alpha = how much of the fill to use */
  rgba: Uint8ClampedArray;
}

/**
 * Fill the masked area of an RGBA image. `mask[i] = 1` marks pixels to remove.
 * Returns the whole image with the area rebuilt and a feathered alpha (0 outside the fill).
 */
export function inpaint(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, mask: Uint8Array, progress: (f: number) => void = () => {}): InpaintResult {
  const out = new Uint8ClampedArray(w * h * 4);
  const grown = dilate(mask, w, h, 2);
  // region of interest: the hole plus plenty of surroundings to borrow from
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grown[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { rgba: out };
  const m = Math.max(40, Math.round(Math.max(x1 - x0, y1 - y0) * 1.1));
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;

  // work at a size the phone can afford
  const MAXPX = 700_000;
  const k = rw * rh > MAXPX ? Math.sqrt(MAXPX / (rw * rh)) : 1;
  const ww = Math.max(16, Math.round(rw * k)), wh = Math.max(16, Math.round(rh * k));
  const base: Lvl = { w: ww, h: wh, img: new Float32Array(ww * wh * 3), hole: new Uint8Array(ww * wh) };
  for (let y = 0; y < wh; y++) {
    const sy = y0 + Math.min(rh - 1, Math.floor((y / wh) * rh));
    for (let x = 0; x < ww; x++) {
      const sx = x0 + Math.min(rw - 1, Math.floor((x / ww) * rw));
      const si = sy * w + sx, o = y * ww + x;
      base.hole[o] = grown[si];
      base.img[o * 3] = rgba[si * 4];
      base.img[o * 3 + 1] = rgba[si * 4 + 1];
      base.img[o * 3 + 2] = rgba[si * 4 + 2];
    }
  }

  // pyramid
  const levels: Lvl[] = [base];
  while (Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > 56 && levels.length < 6) levels.push(downLevel(levels[levels.length - 1]));
  diffuse(levels[levels.length - 1]);

  const rand = rng(12345);
  const total = levels.reduce((a, _l, i) => a + (i === levels.length - 1 ? 6 : i === 0 ? 5 : 4), 0);
  let done = 0;
  let prev: { l: Lvl; nx: Int32Array; ny: Int32Array } | null = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li];
    if (prev) upsampleInto(l, prev.l);
    else if (levels.length === 1) diffuse(l);
    const iters = li === levels.length - 1 ? 6 : li === 0 ? 5 : 4;
    const nn = refine(l, prev, iters, rand, () => progress(Math.min(0.98, ++done / total)), li === 0 ? 4 : 8);
    prev = { l, nx: nn.nx, ny: nn.ny };
  }
  const res = levels[0];

  const alpha = featherAlpha(grown, w, h);
  // write back at full size (bilinear when the work was scaled down)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (!grown[i] && alpha[i] <= 0.001) continue;
      const fx = Math.min(res.w - 1, Math.max(0, ((x - x0 + 0.5) / rw) * res.w - 0.5));
      const fy = Math.min(res.h - 1, Math.max(0, ((y - y0 + 0.5) / rh) * res.h - 0.5));
      const ax = Math.floor(fx), ay = Math.floor(fy), bx = Math.min(res.w - 1, ax + 1), by = Math.min(res.h - 1, ay + 1);
      const tx = fx - ax, ty = fy - ay;
      for (let c = 0; c < 3; c++) {
        const a = res.img[(ay * res.w + ax) * 3 + c] * (1 - tx) + res.img[(ay * res.w + bx) * 3 + c] * tx;
        const b = res.img[(by * res.w + ax) * 3 + c] * (1 - tx) + res.img[(by * res.w + bx) * 3 + c] * tx;
        out[i * 4 + c] = grown[i] ? a * (1 - ty) + b * ty : rgba[i * 4 + c];
      }
      out[i * 4 + 3] = Math.round(Math.min(1, alpha[i]) * 255);
    }
  }
  progress(1);
  return { rgba: out };
}
