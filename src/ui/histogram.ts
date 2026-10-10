/** Draws an RGB + luminance histogram from RGBA8 pixels. Returns the normalized luma bins. */
export function drawHistogram(canvas: HTMLCanvasElement, px: Uint8Array): Float32Array {
  const bins = 128;
  const r = new Float32Array(bins), g = new Float32Array(bins), b = new Float32Array(bins), l = new Float32Array(bins);
  const s = bins / 256;
  for (let i = 0; i < px.length; i += 4) {
    r[(px[i] * s) | 0]++;
    g[(px[i + 1] * s) | 0]++;
    b[(px[i + 2] * s) | 0]++;
    l[((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) * s) | 0]++;
  }
  const norm = (a: Float32Array) => {
    // sqrt scale reads better than linear; ignore the extreme bins for scaling
    let m = 1;
    for (let i = 1; i < bins - 1; i++) m = Math.max(m, a[i]);
    for (let i = 0; i < bins; i++) a[i] = Math.min(1, Math.sqrt(a[i] / m));
    return a;
  };
  [r, g, b, l].forEach(norm);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(canvas.clientWidth * dpr) || 240;
  const H = Math.round(canvas.clientHeight * dpr) || 90;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const plot = (a: Float32Array, color: string) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < bins; i++) ctx.lineTo((i / (bins - 1)) * W, H - a[i] * H * 0.95);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  plot(r, 'rgba(255,60,60,.55)');
  plot(g, 'rgba(60,220,90,.5)');
  plot(b, 'rgba(60,130,255,.55)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  for (let i = 0; i < bins; i++) ctx[i ? 'lineTo' : 'moveTo']((i / (bins - 1)) * W, H - l[i] * H * 0.95);
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.lineWidth = dpr;
  ctx.stroke();
  return l;
}
