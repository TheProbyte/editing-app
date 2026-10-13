import { isNative, writeBlob } from '../native';
import type { Pipeline, Source } from '../gl/pipeline';
import type { EditState } from '../params';
import { jpegHeader } from './jpegEncoder';
import { adlerCombine, chunk } from './pngEncoder';

/** Mobile Safari refuses canvases above ~16.7 MP (only the canvas fallback below needs this). */
export const CANVAS_LIMIT = 16_000_000;

export interface ExportOptions {
  pipeline: Pipeline;
  full: Source;
  analysis: Source;
  state: EditState;
  w: number;
  h: number;
  format: 'jpeg' | 'png';
  quality: number; // 1..100
  progress: (f: number) => void;
}

export async function renderExport(o: ExportOptions): Promise<Blob> {
  try {
    return await viaWorkers(o);
  } catch (e) {
    // no workers here (or one failed to start): the browser's own encoder
    console.warn('parallel encode failed, using the canvas', e);
    if (o.format === 'png' || o.w * o.h <= CANVAS_LIMIT) return viaCanvas(o);
    throw e;
  }
}

async function viaCanvas(o: ExportOptions): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = o.w;
  canvas.height = o.h;
  const ctx = canvas.getContext('2d')!;
  await o.pipeline.exportTiled(o.full, o.analysis, o.state, o.w, o.h, (px, y, rows) => {
    const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, o.w * rows * 4), o.w, rows);
    ctx.putImageData(img, 0, y);
  }, (f) => o.progress(f * 0.9));
  o.progress(0.95);
  const type = o.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, o.quality / 100));
  canvas.width = canvas.height = 1;
  if (!blob) throw new Error('Could not encode the image (it may be too large for this device).');
  return blob;
}

/** Rows per encoding job (a multiple of 8, the JPEG block height). */
const BAND = 128;

/**
 * Encode on every core while the GPU is still rendering: each rendered strip is cut into
 * bands of rows, and a pool of workers encodes them in parallel (see jpegEncoder.ts and
 * pngEncoder.ts for how separately-encoded bands join into one file).
 */
async function viaWorkers(o: ExportOptions): Promise<Blob> {
  const cores = navigator.hardwareConcurrency || 4;
  const n = Math.max(2, Math.min(8, cores - 1));
  const pool = Array.from({ length: n }, () => new Worker(new URL('./encodeWorker.ts', import.meta.url), { type: 'module' }));
  const load = new Array(n).fill(0);
  const waiting = new Map<number, { res: (d: { out: Uint8Array; adler?: number; len?: number }) => void; rej: (e: Error) => void; w: number }>();
  let failed: Error | null = null;
  pool.forEach((wk, k) => {
    wk.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      load[job.w]--;
      job.res(e.data);
    };
    wk.onerror = (e) => {
      failed = new Error(e.message || 'encoder worker failed');
      for (const [id, job] of waiting) if (job.w === k) {
        waiting.delete(id);
        job.rej(failed);
      }
    };
  });
  const png = o.format === 'png';
  const totalRows = o.h;
  let rendered = 0, encoded = 0;
  // rendering and encoding each count for half (encoding usually finishes just after the render)
  const report = () => o.progress(Math.min(0.99, (rendered / totalRows) * 0.5 + (encoded / totalRows) * 0.5));
  const results: Promise<{ out: Uint8Array; adler?: number; len?: number }>[] = [];
  let id = 0;
  let prevRow: Uint8Array | null = null;
  const send = (data: Uint8Array, rows: number, y0: number) => {
    if (failed) throw failed;
    // the least busy worker
    let w = 0;
    for (let k = 1; k < n; k++) if (load[k] < load[w]) w = k;
    load[w]++;
    const jid = id++;
    const msg: Record<string, unknown> = { id: jid, kind: o.format, w: o.w, h: o.h, rows, y0, q: o.quality, level: 2, data: data.buffer };
    const tr: Transferable[] = [data.buffer];
    if (png && prevRow) {
      msg.prev = prevRow.buffer;
      tr.push(prevRow.buffer);
    }
    const p = new Promise<{ out: Uint8Array; adler?: number; len?: number }>((res, rej) => waiting.set(jid, { res, rej, w }));
    results.push(p.then((d) => {
      encoded += rows;
      report();
      return d;
    }));
    pool[w].postMessage(msg, tr);
  };
  try {
    await o.pipeline.exportTiled(o.full, o.analysis, o.state, o.w, o.h, async (strip, y, rows) => {
      for (let r = 0; r < rows; r += BAND) {
        const k = Math.min(BAND, rows - r);
        const band = strip.slice(r * o.w * 4, (r + k) * o.w * 4);
        const last = band.slice((k - 1) * o.w * 4);
        send(band, k, y + r);
        prevRow = png ? last : null;
      }
      rendered = y + rows;
      report();
    }, (f) => {
      rendered = Math.max(rendered, Math.round(f * totalRows * 0.98));
      report();
    }, 8);
    const parts = await Promise.all(results);
    o.progress(1);
    if (!png) return new Blob([jpegHeader(o.w, o.h, o.quality), ...parts.map((p) => p.out), new Uint8Array([0xff, 0xd9])] as BlobPart[], { type: 'image/jpeg' });
    let adler = 1;
    for (const p of parts) adler = adlerCombine(adler, p.adler!, p.len!);
    return new Blob([pngHead(o.w, o.h), ...parts.map((p) => p.out), pngTail(adler)] as BlobPart[], { type: 'image/png' });
  } finally {
    for (const wk of pool) wk.terminate();
  }
}

/** PNG signature, header (8-bit RGB), sRGB tag, and the zlib stream's 2-byte header in its own IDAT. */
export function pngHead(w: number, h: number) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('sRGB', new Uint8Array([0])), chunk('IDAT', new Uint8Array([0x78, 0x5e]))];
  return concat(parts);
}

/** The final (empty) deflate block, the Adler-32 of all the filtered rows, and IEND. */
export function pngTail(adler: number) {
  const d = new Uint8Array(6);
  d.set([0x03, 0x00]);
  new DataView(d.buffer).setUint32(2, adler);
  return concat([chunk('IDAT', d), chunk('IEND', new Uint8Array(0))]);
}

function concat(parts: Uint8Array[]) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) {
    out.set(p, n);
    n += p.length;
  }
  return out;
}

/** Embedded in a frame (e.g. a hosted preview) downloads and the share sheet are blocked. */
export const framed = (() => {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
})();

export async function saveOrShare(blob: Blob, name: string, onProgress?: (f: number) => void): Promise<'shared' | 'downloaded' | 'shown' | 'gallery'> {
  if (isNative) {
    await writeBlob(blob, name, 'gallery', onProgress);
    return 'gallery';
  }
  if (framed) return 'shown';
  // Android: save straight to the phone (Downloads, which Google Photos shows on-device)
  if (/Android/i.test(navigator.userAgent)) return download(blob, name);
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  return download(blob, name);
}

function download(blob: Blob, name: string): 'downloaded' {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
