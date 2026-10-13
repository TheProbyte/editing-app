// Encodes one band of an export (see export.ts): JPEG or PNG.
import { encodeJpegBand } from './jpegEncoder';
import { encodePngBand } from './pngEncoder';

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  const px = new Uint8Array(m.data);
  if (m.kind === 'jpeg') {
    const out = encodeJpegBand(px, m.w, m.rows, m.y0, m.h, m.q).slice();
    (self as unknown as Worker).postMessage({ id: m.id, out }, [out.buffer]);
  } else {
    const r = encodePngBand(px, m.w, m.rows, m.prev ? new Uint8Array(m.prev) : null, m.level);
    (self as unknown as Worker).postMessage({ id: m.id, out: r.idat, adler: r.adler, len: r.len }, [r.idat.buffer]);
  }
};
