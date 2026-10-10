import { JpegStreamEncoder } from './jpegEncoder';

let enc: JpegStreamEncoder | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') enc = new JpegStreamEncoder(m.w, m.h, m.q);
  else if (m.type === 'rows') enc!.addRows(new Uint8Array(m.data), m.rows);
  else if (m.type === 'finish') {
    const chunks = enc!.finish();
    enc = null;
    (self as unknown as Worker).postMessage({ chunks }, chunks.map((c) => c.buffer));
  }
};
