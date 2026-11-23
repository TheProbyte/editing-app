// Where the removal models look. The hole mask is split into its separate areas and each gets
// its own window (a crop with surroundings), so two removals far apart are each filled at full
// detail instead of sharing one big, blurry window — or one of them being left out.
// Pure functions, so they run in the worker and in tests.

/** LaMa's fixed input size. */
export const LAMA = 512;
/** MI-GAN crops are scaled down to this long side. */
export const MIGAN_MAX = 1100;
/** More windows than this and nearby areas are grouped anyway (each window is a model run; MI-GAN's are quick). */
const MAX_RUNS = { lama: 6, migan: 16 };

/** A rectangle, edges included. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FillWindow {
  x0: number;
  y0: number;
  rw: number;
  rh: number;
  /** the areas (labels) this window fills; other holes in it are left for their own window */
  ids: number[];
  /** a tile of an area too big for one window: fill only up to here, the next tile does the rest */
  lim?: { axis: 'x' | 'y'; max: number };
}

/** The separate areas of a 0/1 mask (8-neighbours): a label per pixel (0 = none, area i is i + 1) and each area's box. */
export function labelHoles(mask: Uint8Array, w: number, h: number) {
  const labels = new Int32Array(w * h);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = boxes.length + 1;
    const b = { x0: w, y0: h, x1: -1, y1: -1 };
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) {
            labels[j] = id;
            stack.push(j);
          }
        }
      }
    }
    boxes.push(b);
  }
  return { labels, boxes };
}

/** LaMa's window for a hole: a square with room around it, as big as the photo's short side at most. */
export function lamaWindow(box: Box, w: number, h: number) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  let side = Math.round(Math.max(bw, bh) * 2.4);
  side = Math.min(Math.min(w, h), Math.max(side, Math.min(LAMA, Math.min(w, h))));
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const x0 = Math.min(w - side, Math.max(0, Math.round(cx - side / 2)));
  const y0 = Math.min(h - side, Math.max(0, Math.round(cy - side / 2)));
  return { x0, y0, rw: side, rh: side };
}

/** MI-GAN's crop for a hole: plenty of surroundings for the network to learn the scene from (any shape). */
export function miganWindow(box: Box, w: number, h: number) {
  const m = Math.max(64, Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.9));
  const x0 = Math.max(0, box.x0 - m), y0 = Math.max(0, box.y0 - m);
  const x1 = Math.min(w - 1, box.x1 + m), y1 = Math.min(h - 1, box.y1 + m);
  return { x0, y0, rw: x1 - x0 + 1, rh: y1 - y0 + 1 };
}

const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

/**
 * The windows to run, in order. Areas share a window when that costs (almost) no detail, i.e.
 * the shared window is no bigger than the larger of their own; a LaMa area wider than the
 * photo's short side can't fit any window, so it's covered by overlapping tiles instead.
 */
export function planWindows(boxes: Box[], w: number, h: number, kind: 'lama' | 'migan') {
  const S = Math.min(w, h);
  const win = (b: Box) => (kind === 'lama' ? lamaWindow(b, w, h) : miganWindow(b, w, h));
  // how much a window gets scaled down for the model: bigger = less detail
  const span = (b: Box) => {
    const r = win(b);
    return Math.max(kind === 'lama' ? LAMA : MIGAN_MAX, r.rw, r.rh);
  };
  const fits = (b: Box) => kind === 'migan' || Math.max(b.x1 - b.x0, b.y1 - b.y0) + 1 <= S;
  const groups = boxes.map((box, i) => ({ ids: [i + 1], box }));
  const merge = (i: number, j: number) => {
    groups[i].ids.push(...groups[j].ids);
    groups[i].box = union(groups[i].box, groups[j].box);
    groups.splice(j, 1);
  };
  // first every merge that loses no detail
  const loss = (i: number, j: number) => {
    const u = union(groups[i].box, groups[j].box);
    return fits(u) ? span(u) / Math.max(span(groups[i].box), span(groups[j].box)) : Infinity;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (loss(i, j) > 1) continue;
        merge(i, j--);
        changed = true;
      }
    }
  }
  // then, if that leaves too many runs, the merges that lose the least
  while (groups.length > MAX_RUNS[kind]) {
    let best = Infinity, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const l = loss(i, j);
        if (l < best) [best, bi, bj] = [l, i, j];
      }
    }
    if (bi < 0) break;
    merge(bi, bj);
  }
  const windows: FillWindow[] = [];
  let tiled = 0;
  for (const g of groups) {
    if (fits(g.box)) {
      windows.push({ ...win(g.box), ids: g.ids });
      continue;
    }
    // too wide (only the long side can be): squares of the full short side along it, each
    // overlapping the next, so every tile sees what the one before it filled
    tiled++;
    const axis = w > h ? 'x' : 'y';
    const a = axis === 'x' ? g.box.x0 : g.box.y0, b = axis === 'x' ? g.box.x1 : g.box.y1, L = axis === 'x' ? w : h;
    const ctx = Math.round(S * 0.2), ov = Math.max(4, Math.round(S / 4));
    const lo = Math.max(0, a - ctx), hi = Math.min(L, b + 1 + ctx);
    const n = Math.max(2, Math.ceil((hi - lo - ov) / (S - ov)));
    const step = (hi - lo - S) / (n - 1);
    for (let k = 0; k < n; k++) {
      const p = Math.round(lo + k * step);
      const lim = k < n - 1 ? { axis, max: p + S - (ov >> 1) } as const : undefined;
      windows.push(axis === 'x' ? { x0: p, y0: 0, rw: S, rh: S, ids: g.ids, lim } : { x0: 0, y0: p, rw: S, rh: S, ids: g.ids, lim });
    }
  }
  return { windows, tiled };
}
