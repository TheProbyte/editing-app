import { isNative, Native, writeBlob, fileFromPath } from '../native';
export const RAW_EXT = [
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'srw',
  'x3f', '3fr', 'iiq', 'rwl', 'mrw', 'erf', 'kdc', 'dcr', 'mef', 'mos', 'raw', 'gpr',
];

export type Loaded =
  | { kind: 'bitmap'; bitmap: ImageBitmap; w: number; h: number; info: string; note?: string; quarter?: number }
  | { kind: 'raw'; data: Uint16Array; w: number; h: number; info: string; note?: string; quarter?: number };

/** EXIF/LibRaw orientation -> clockwise quarter turns (mirrored variants are rare; ignored). */
function flipToQuarter(flip: number | undefined) {
  return flip === 6 ? 1 : flip === 3 ? 2 : flip === 5 ? 3 : 0;
}

export function isRaw(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return RAW_EXT.includes(ext);
}

export async function loadFile(file: File, maxDim: number, onStatus: (s: string) => void): Promise<Loaded> {
  if (isRaw(file)) {
    onStatus('Developing RAW…');
    try {
      return await decodeRaw(file, maxDim);
    } catch (err) {
      console.warn('Full RAW decode failed', err);
      if (isNative) {
        // the Android app can develop DNGs itself
        try {
          onStatus('Developing RAW (Android)…');
          const { path } = await writeBlob(file, 'in_' + Date.now() + '_' + file.name.replace(/[^\w.]/g, '_'), 'cache');
          const out = await Native.decodeFile({ path: path! });
          const jpg = await fileFromPath(out.path, 'decoded.jpg', 'image/jpeg');
          const bmp = await toBitmap(jpg, maxDim);
          return { kind: 'bitmap', bitmap: bmp, w: bmp.width, h: bmp.height, info: `${bmp.width}×${bmp.height} RAW (Android)`, note: 'Developed by Android’s RAW decoder (8-bit).' };
        } catch (e2) {
          console.warn('Native RAW decode failed', e2);
        }
      }
      onStatus('Using RAW preview…');
      const prev = await embeddedPreview(file, maxDim);
      if (prev) {
        prev.note = 'Full RAW decoding isn’t available here, so the camera’s embedded full-size JPEG is being edited.';
        return prev;
      }
      throw new Error('Could not read this RAW file.');
    }
  }
  onStatus('Opening…');
  try {
    const bmp = await toBitmap(file, maxDim);
    return { kind: 'bitmap', bitmap: bmp, w: bmp.width, h: bmp.height, info: `${bmp.width}×${bmp.height}` };
  } catch {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'heic' || ext === 'heif') {
      throw new Error('This browser can’t open HEIC photos. Open the app in Safari on iPhone, or set Camera → Formats → Most Compatible.');
    }
    // maybe it's a RAW with an unusual extension
    const prev = await embeddedPreview(file, maxDim);
    if (prev) return prev;
    throw new Error('This file type isn’t supported.');
  }
}

async function toBitmap(blob: Blob, maxDim: number): Promise<ImageBitmap> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  } catch {
    // older Safari: no options support, or no decoder for createImageBitmap — go through <img>
    return viaImageElement(blob, maxDim);
  }
  return fitBitmap(bmp, maxDim);
}

async function fitBitmap(bmp: ImageBitmap, maxDim: number): Promise<ImageBitmap> {
  const long = Math.max(bmp.width, bmp.height);
  if (long <= maxDim) return bmp;
  const k = maxDim / long;
  const w = Math.round(bmp.width * k);
  const h = Math.round(bmp.height * k);
  try {
    const scaled = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    bmp.close();
    return scaled;
  } catch {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return createImageBitmap(c);
  }
}

async function viaImageElement(blob: Blob, maxDim: number): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // mobile Safari caps canvas area at ~16.7 MP
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight), Math.sqrt(16_000_000 / (img.naturalWidth * img.naturalHeight)));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await createImageBitmap(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------------------
// RAW decoding with LibRaw (WebAssembly, runs in a worker)

function decodeRaw(file: File, maxDim: number): Promise<Loaded> {
  // the threaded WASM build needs SharedArrayBuffer
  if (typeof SharedArrayBuffer === 'undefined') return Promise.reject(new Error('SharedArrayBuffer unavailable'));
  return new Promise(async (resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('libraw/worker.js', document.baseURI), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    let id = 0;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    worker.onmessage = ({ data }) => {
      const p = pending.get(data?.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.rej(new Error(data.error));
      else p.res(data.out);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.rej(new Error(e.message || 'RAW worker failed'));
      pending.clear();
    };
    const call = (fn: string, ...args: any[]) =>
      new Promise<any>((res, rej) => {
        const i = id++;
        pending.set(i, { res, rej });
        const transfer = args.filter((a) => ArrayBuffer.isView(a)).map((a) => (a as Uint8Array).buffer);
        worker.postMessage({ id: i, fn, args }, transfer);
      });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('RAW decode timed out'));
    }, 120000);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await call('open', bytes, {
        useCameraWb: true,
        outputBps: 16,
        outputColor: 1,
        gamm: [1, 1],
        highlight: 2,
        userQual: 3,
        noAutoBright: false,
        autoBrightThr: 0.003,
        // never rotate the pixels; the orientation becomes a (non-destructive) quarter turn
        userFlip: 0,
      });
      const meta = await call('metadata', false).catch(() => null);
      const img = await call('imageData');
      if (!img || !img.data) throw new Error('No image data');
      let { width: w, height: h } = img;
      let data: Uint16Array = img.data instanceof Uint16Array ? img.data : new Uint16Array(img.data.buffer);
      if (img.bits === 8) {
        const d8 = img.data as Uint8Array;
        data = new Uint16Array(d8.length);
        for (let i = 0; i < d8.length; i++) data[i] = d8[i] * 257;
      }
      const colors = img.colors || 3;
      if (colors !== 3) data = toRgb(data, colors);
      // Scale down by an integer factor if it's larger than the GPU can hold
      const f = Math.ceil(Math.max(w, h) / maxDim);
      if (f > 1) ({ data, w, h } = boxDown(data, w, h, f));
      const info = meta
        ? [meta.camera_make, meta.camera_model].filter(Boolean).join(' ') +
          (meta.iso_speed ? ` · ISO ${Math.round(meta.iso_speed)}` : '') +
          (meta.shutter ? ` · ${fmtShutter(meta.shutter)}` : '') +
          (meta.aperture ? ` · f/${(+meta.aperture).toFixed(1)}` : '') +
          ` · ${w}×${h} RAW`
        : `${w}×${h} RAW`;
      resolve({ kind: 'raw', data, w, h, info, quarter: flipToQuarter(meta?.flip) });
    } catch (e) {
      reject(e);
    } finally {
      clearTimeout(timeout);
      worker.terminate();
    }
  });
}

function fmtShutter(s: number) {
  return s >= 1 ? `${s.toFixed(1)}s` : `1/${Math.round(1 / s)}s`;
}

function toRgb(d: Uint16Array, colors: number) {
  const n = d.length / colors;
  const out = new Uint16Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = d[i * colors + Math.min(c, colors - 1)];
  }
  return out;
}

function boxDown(d: Uint16Array, w: number, h: number, f: number) {
  const nw = Math.floor(w / f);
  const nh = Math.floor(h / f);
  const out = new Uint16Array(nw * nh * 3);
  const inv = 1 / (f * f);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let yy = 0; yy < f; yy++) {
        let i = ((y * f + yy) * w + x * f) * 3;
        for (let xx = 0; xx < f; xx++, i += 3) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
      }
      const o = (y * nw + x) * 3;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
    }
  }
  return { data: out, w: nw, h: nh };
}

// ---------------------------------------------------------------------------------------
// Fallback: nearly every RAW format embeds a full-size JPEG preview. Find the biggest one.

async function embeddedPreview(file: File, maxDim: number): Promise<Loaded | null> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const starts: number[] = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const m = buf[i + 3];
      if (m === 0xdb || m === 0xe0 || m === 0xe1 || m === 0xc0 || m === 0xc4 || m === 0xdd || m === 0xee) starts.push(i);
    }
  }
  let best: ImageBitmap | null = null;
  for (const s of starts.slice(0, 12)) {
    try {
      const bmp = await createImageBitmap(new Blob([buf.subarray(s)], { type: 'image/jpeg' }));
      if (!best || bmp.width * bmp.height > best.width * best.height) {
        best?.close();
        best = bmp;
      } else bmp.close();
    } catch {
      /* not a decodable JPEG */
    }
  }
  if (!best || best.width < 320) return null;
  const bmp = await fitBitmap(best, maxDim);
  return { kind: 'bitmap', bitmap: bmp, w: bmp.width, h: bmp.height, info: `${bmp.width}×${bmp.height} (RAW preview)` };
}
