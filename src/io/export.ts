import type { Pipeline, Source } from '../gl/pipeline';
import type { EditState } from '../params';

/** Mobile Safari refuses canvases above ~16.7 MP, so larger JPEGs are streamed through our own encoder. */
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
  const area = o.w * o.h;
  if (o.format === 'png' || area <= CANVAS_LIMIT) return viaCanvas(o);
  return viaStream(o);
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

async function viaStream(o: ExportOptions): Promise<Blob> {
  const worker = new Worker(new URL('./jpegWorker.ts', import.meta.url), { type: 'module' });
  try {
    worker.postMessage({ type: 'init', w: o.w, h: o.h, q: o.quality });
    await o.pipeline.exportTiled(o.full, o.analysis, o.state, o.w, o.h, (px, _y, rows) => {
      worker.postMessage({ type: 'rows', data: px.buffer, rows }, [px.buffer]);
    }, (f) => o.progress(f * 0.85));
    o.progress(0.9);
    const chunks = await new Promise<Uint8Array[]>((res, rej) => {
      worker.onmessage = (e) => res(e.data.chunks);
      worker.onerror = (e) => rej(new Error(e.message));
      worker.postMessage({ type: 'finish' });
    });
    return new Blob(chunks as BlobPart[], { type: 'image/jpeg' });
  } finally {
    worker.terminate();
  }
}

/** Embedded in a frame (e.g. a hosted preview) downloads and the share sheet are blocked. */
export const framed = (() => {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
})();

export async function saveOrShare(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'shown'> {
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
