// Light leaks, drawn on the fly: soft glows, streaks, flares and burns on black, meant to be
// blended with Screen / Add / Lighten (black adds nothing). Nothing to download.

export interface LeakDef {
  id: string;
  name: string;
  draw: (c: CanvasRenderingContext2D, W: number, H: number, rnd: () => number) => void;
}

export const LEAK_W = 1536;
export const LEAK_H = 1024;

type Stop = [number, string];

function radial(c: CanvasRenderingContext2D, x: number, y: number, r: number, stops: Stop[], sx = 1, sy = 1) {
  c.save();
  c.translate(x, y);
  c.scale(sx, sy);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
  for (const [t, col] of stops) g.addColorStop(t, col);
  c.fillStyle = g;
  c.fillRect(-r, -r, r * 2, r * 2);
  c.restore();
}

function band(c: CanvasRenderingContext2D, W: number, H: number, angle: number, pos: number, width: number, stops: Stop[]) {
  // a soft stripe across the frame: `pos` 0..1 across, `width` as a fraction of the frame diagonal
  const D = Math.hypot(W, H);
  c.save();
  c.translate(W / 2, H / 2);
  c.rotate(angle);
  const g = c.createLinearGradient(0, (pos - 0.5) * D - (width * D) / 2, 0, (pos - 0.5) * D + (width * D) / 2);
  for (const [t, col] of stops) g.addColorStop(t, col);
  c.fillStyle = g;
  c.fillRect(-D, -D, D * 2, D * 2);
  c.restore();
}

/** Value noise for ragged burns. */
function noise(rnd: () => number, n = 64) {
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x: number, y: number) => {
    const fx = x * (n - 1), fy = y * (n - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const s = (t: number) => t * t * (3 - 2 * t);
    const a = g[y0 * n + x0], b = g[y0 * n + Math.min(n - 1, x0 + 1)], c2 = g[Math.min(n - 1, y0 + 1) * n + x0], d = g[Math.min(n - 1, y0 + 1) * n + Math.min(n - 1, x0 + 1)];
    return (a * (1 - s(tx)) + b * s(tx)) * (1 - s(ty)) + (c2 * (1 - s(tx)) + d * s(tx)) * s(ty);
  };
}

const edgeBurn = (side: 'l' | 'r' | 't' | 'b', colors: [string, string, string], reach = 0.5) => (c: CanvasRenderingContext2D, W: number, H: number, rnd: () => number) => {
  const n = noise(rnd), n2 = noise(rnd, 24);
  const img = c.createImageData(W / 4, H / 4);
  const w = W / 4, h = H / 4;
  const parse = (s: string) => [0, 1, 2].map((i) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16));
  const [c1, c2, c3] = colors.map(parse);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      const d = side === 'l' ? u : side === 'r' ? 1 - u : side === 't' ? v : 1 - v;
      const along = side === 'l' || side === 'r' ? v : u;
      // ragged edge: distance threshold wobbles along the edge
      const edge = reach * (0.55 + 0.9 * n2(along, d * 0.6)) - 0.1;
      const t = 1 - d / Math.max(0.05, edge);
      if (t <= 0) continue;
      const k = Math.min(1, t) * (0.75 + 0.25 * n(u, v));
      const hot = Math.pow(Math.min(1, k), 2.2);
      const col = hot > 0.55 ? c3 : hot > 0.25 ? c2 : c1;
      const mix = (a: number[], b: number[], f: number) => a.map((q, i) => q * (1 - f) + b[i] * f);
      const out = hot > 0.55 ? mix(c2, c3, (hot - 0.55) / 0.45) : hot > 0.25 ? mix(c1, c2, (hot - 0.25) / 0.3) : mix([0, 0, 0], c1, hot / 0.25);
      void col;
      const o = (y * w + x) * 4;
      img.data[o] = out[0] * Math.min(1, k * 1.4);
      img.data[o + 1] = out[1] * Math.min(1, k * 1.4);
      img.data[o + 2] = out[2] * Math.min(1, k * 1.4);
      img.data[o + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(tmp, 0, 0, W, H);
};

export const LEAKS: LeakDef[] = [
  { id: 'amber', name: 'Amber edge', draw: (c, _W, H) => {
    radial(c, 0, H * 0.45, H * 0.95, [[0, '#ffb23a'], [0.25, '#ff7a1a'], [0.6, '#a8200a88'], [1, '#00000000']], 0.8, 1.2);
  } },
  { id: 'sunset', name: 'Sunset corner', draw: (c, W, H) => {
    radial(c, W * 1.02, H * 1.0, H * 1.35, [[0, '#fff1b0'], [0.15, '#ffb03a'], [0.45, '#ff4d1c99'], [1, '#00000000']]);
  } },
  { id: 'redstreak', name: 'Red streak', draw: (c, W, H) => {
    band(c, W, H, -0.35, 0.3, 0.18, [[0, '#00000000'], [0.45, '#ff2a1088'], [0.5, '#ff6a2acc'], [0.55, '#ff2a1088'], [1, '#00000000']]);
    band(c, W, H, -0.35, 0.42, 0.06, [[0, '#00000000'], [0.5, '#ffd08a99'], [1, '#00000000']]);
  } },
  { id: 'prism', name: 'Rainbow prism', draw: (c, W, H) => {
    const cols = ['#ff2a2a', '#ff9a1a', '#ffe81a', '#3dff6a', '#1ad8ff', '#3a5aff', '#c43aff'];
    cols.forEach((col, i) => band(c, W, H, -0.55, 0.22 + i * 0.045, 0.07, [[0, '#00000000'], [0.5, col + 'aa'], [1, '#00000000']]));
  } },
  { id: 'flare', name: 'Gold flare', draw: (c, W, H) => {
    const x = W * 0.78, y = H * 0.24;
    radial(c, x, y, H * 0.55, [[0, '#ffffffff'], [0.1, '#fff3c0ee'], [0.3, '#ffb23a66'], [1, '#00000000']]);
    c.save();
    c.translate(x, y);
    c.scale(1, 0.018);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, W * 0.9);
    g.addColorStop(0, '#ffffffcc');
    g.addColorStop(1, '#ffaa4400');
    c.fillStyle = g;
    c.fillRect(-W, -W, W * 2, W * 2);
    c.restore();
    // ghosts toward the centre of the frame
    for (const [t, r, col] of [[0.4, 40, '#ff8a2a55'], [0.7, 70, '#3aa8ff44'], [1.0, 30, '#ff3a8a44'], [1.4, 100, '#ffd24a33']] as const) {
      const gx = x + (W / 2 - x) * t, gy = y + (H / 2 - y) * t;
      radial(c, gx, gy, r, [[0, col], [0.8, col], [1, '#00000000']]);
    }
  } },
  { id: 'teal', name: 'Teal haze', draw: (c, W, H) => {
    radial(c, W * 0.5, -H * 0.15, W * 0.9, [[0, '#3affd8cc'], [0.4, '#1a9bd088'], [1, '#00000000']], 1, 0.7);
  } },
  { id: 'magenta', name: 'Magenta burn', draw: (c, W, H) => {
    radial(c, W * 1.0, H * 0.3, H * 1.0, [[0, '#ff7ad8'], [0.35, '#d41a9acc'], [0.7, '#5a0a8a66'], [1, '#00000000']], 0.9, 1.1);
  } },
  { id: 'filmburn', name: 'Film burn', draw: edgeBurn('l', ['#8a1a06', '#ff6a14', '#ffe08a'], 0.55) },
  { id: 'filmburn2', name: 'Burn right', draw: edgeBurn('r', ['#7a0e08', '#ff5a14', '#fff0a8'], 0.5) },
  { id: 'filmtop', name: 'Burn top', draw: edgeBurn('t', ['#6a1004', '#ff7a1a', '#ffe9a0'], 0.42) },
  { id: 'tape', name: 'Tape strips', draw: (c, W, H) => {
    for (const [x, w, col] of [[0.06, 0.05, '#ff6a2a'], [0.12, 0.012, '#ffe08a'], [0.88, 0.03, '#ff3a2a']] as const) {
      const g = c.createLinearGradient(W * x, 0, W * (x + w), 0);
      g.addColorStop(0, '#00000000');
      g.addColorStop(0.5, col + 'dd');
      g.addColorStop(1, '#00000000');
      c.fillStyle = g;
      c.fillRect(W * x, 0, W * w, H);
    }
  } },
  { id: 'orbs', name: 'Sun orbs', draw: (c, W, H, rnd) => {
    for (let i = 0; i < 9; i++) {
      const x = W * (0.5 + rnd() * 0.5), y = H * (rnd() * 0.7), r = 30 + rnd() * 120;
      const hue = 20 + rnd() * 30;
      radial(c, x, y, r, [[0, `hsla(${hue},100%,70%,0.55)`], [0.7, `hsla(${hue},100%,55%,0.35)`], [0.92, `hsla(${hue},100%,70%,0.5)`], [1, '#00000000']]);
    }
  } },
  { id: 'anamorphic', name: 'Anamorphic', draw: (c, W, H) => {
    const y = H * 0.5;
    c.save();
    c.translate(W * 0.5, y);
    c.scale(1, 0.02);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, W * 0.7);
    g.addColorStop(0, '#d8f4ffff');
    g.addColorStop(0.3, '#3aa0ff99');
    g.addColorStop(1, '#1a40ff00');
    c.fillStyle = g;
    c.fillRect(-W, -W, W * 2, W * 2);
    c.restore();
    radial(c, W * 0.5, y, H * 0.25, [[0, '#ffffffcc'], [0.4, '#8ad0ff55'], [1, '#00000000']]);
  } },
  { id: 'daylight', name: 'Daylight wash', draw: (c, W, H) => {
    const g = c.createLinearGradient(0, 0, W * 0.5, H);
    g.addColorStop(0, '#fff7d0ee');
    g.addColorStop(0.35, '#ffd88a66');
    g.addColorStop(1, '#00000000');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  } },
  { id: 'ember', name: 'Ember frame', draw: (c, W, H) => {
    c.save();
    for (const [x, y, r] of [[0, 0, 0.9], [W, 0, 0.8], [0, H, 0.8], [W, H, 0.9]] as const) {
      radial(c, x, y, H * r, [[0, '#ff8a2acc'], [0.35, '#ff3a1a88'], [1, '#00000000']]);
    }
    c.restore();
  } },
  { id: 'cyanflash', name: 'Cyan flash', draw: (c, W, H) => {
    const g = c.createLinearGradient(0, 0, W * 0.4, 0);
    g.addColorStop(0, '#e8ffffff');
    g.addColorStop(0.2, '#3affe8cc');
    g.addColorStop(1, '#00000000');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  } },
  { id: 'peach', name: 'Peach fuzz', draw: (c, W, H) => {
    radial(c, W * 0.2, H * 0.8, H * 0.8, [[0, '#ffb8a0cc'], [0.5, '#ff7a8a66'], [1, '#00000000']]);
    radial(c, W * 0.85, H * 0.2, H * 0.6, [[0, '#ffd8a0aa'], [0.6, '#ff9a6a44'], [1, '#00000000']]);
  } },
  { id: 'green', name: 'Green spill', draw: (c, W, H) => {
    radial(c, W * 0.0, H * 0.7, H * 0.9, [[0, '#d8ff6acc'], [0.4, '#3ad84a88'], [1, '#00000000']], 0.8, 1.1);
  } },
  { id: 'violet', name: 'Violet dream', draw: (c, W, H) => {
    radial(c, W * 0.25, H * 0.2, H * 0.8, [[0, '#a05affcc'], [0.5, '#5a2ad088'], [1, '#00000000']]);
    radial(c, W * 0.8, H * 0.85, H * 0.7, [[0, '#3a8affaa'], [0.6, '#1a3ad066'], [1, '#00000000']]);
  } },
  { id: 'shafts', name: 'Window light', draw: (c, W, H) => {
    for (const [p, w, a] of [[0.28, 0.1, 0.55], [0.46, 0.06, 0.4], [0.6, 0.12, 0.5]] as const) {
      band(c, W, H, -0.62, p, w, [[0, '#00000000'], [0.25, `rgba(255,236,190,${a})`], [0.75, `rgba(255,236,190,${a})`], [1, '#00000000']]);
    }
  } },
  { id: 'golden', name: 'Golden hour', draw: (c, W, H, rnd) => {
    const g = c.createLinearGradient(W, H * 0.2, 0, H * 0.8);
    g.addColorStop(0, '#ffd070ee');
    g.addColorStop(0.5, '#ff9a3a66');
    g.addColorStop(1, '#00000000');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    for (let i = 0; i < 70; i++) {
      const x = W * (0.45 + rnd() * 0.55), y = H * rnd(), r = 1 + rnd() * 3;
      radial(c, x, y, r * 3, [[0, '#fff0c0aa'], [1, '#00000000']]);
    }
  } },
  { id: 'dust', name: 'Dust glints', draw: (c, W, H, rnd) => {
    for (let i = 0; i < 140; i++) {
      const x = W * rnd(), y = H * rnd(), r = 1 + rnd() * rnd() * 9;
      radial(c, x, y, r * 2.5, [[0, `rgba(255,${200 + rnd() * 50 | 0},150,${0.35 + rnd() * 0.5})`], [1, '#00000000']]);
    }
  } },
];

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const cache = new Map<string, HTMLCanvasElement>();
export function leakCanvas(id: string): HTMLCanvasElement {
  let c = cache.get(id);
  if (c) return c;
  const def = LEAKS.find((l) => l.id === id) ?? LEAKS[0];
  c = document.createElement('canvas');
  c.width = LEAK_W;
  c.height = LEAK_H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, LEAK_W, LEAK_H);
  ctx.globalCompositeOperation = 'lighter';
  let h = 7;
  for (const ch of def.id) h = Math.imul(h, 31) + ch.charCodeAt(0);
  def.draw(ctx, LEAK_W, LEAK_H, seeded(h));
  cache.set(id, c);
  return c;
}
