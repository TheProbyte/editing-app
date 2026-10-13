// PNG in bands, so several workers can compress one picture at once. Each band is filtered
// and deflated on its own and ends with an empty stored block (a "sync flush"): that leaves
// it byte-aligned and not final, so the bands simply follow each other inside one zlib
// stream. Each band becomes its own IDAT chunk; the main thread adds the zlib header, the
// closing block and the combined Adler-32.
import { Deflate } from 'fflate';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(b: Uint8Array, crc = -1) {
  for (let i = 0; i < b.length; i++) crc = CRC[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

export function adler32(b: Uint8Array) {
  let a = 1, s = 0;
  for (let i = 0; i < b.length; ) {
    const end = Math.min(b.length, i + 5552);
    for (; i < end; i++) {
      a += b[i];
      s += a;
    }
    a %= 65521;
    s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/** Adler-32 of A followed by B, from the two checksums and B's length. */
export function adlerCombine(a1: number, a2: number, len2: number) {
  const BASE = 65521;
  const rem = len2 % BASE;
  let sum1 = a1 & 0xffff;
  let sum2 = (rem * sum1) % BASE;
  sum1 += (a2 & 0xffff) + BASE - 1;
  sum2 += (a1 >>> 16) + (a2 >>> 16) + BASE - rem;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum2 >= BASE * 2) sum2 -= BASE * 2;
  if (sum2 >= BASE) sum2 -= BASE;
  return ((sum2 << 16) | sum1) >>> 0;
}

/** A PNG chunk: length, type, data, CRC. */
export function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, ~crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
}

/**
 * Filter + deflate `rows` RGBA rows (width w) into one IDAT chunk. `prev` is the RGBA row
 * just above the band (null for the first band). RGB output, Paeth filter on every row.
 */
export function encodePngBand(rgba: Uint8Array, w: number, rows: number, prev: Uint8Array | null, level: number) {
  const n3 = w * 3;
  const stride = n3 + 1;
  const raw = new Uint8Array(stride * rows);
  // RGB copies of the row above and this row
  let up = new Uint8Array(n3), cur = new Uint8Array(n3);
  const rgb = (src: Uint8Array, off: number, dst: Uint8Array) => {
    for (let x = 0, i = off, q = 0; x < w; x++, i += 4, q += 3) {
      dst[q] = src[i];
      dst[q + 1] = src[i + 1];
      dst[q + 2] = src[i + 2];
    }
  };
  const hasPrev = !!prev;
  if (prev) rgb(prev, 0, up);
  for (let y = 0; y < rows; y++) {
    rgb(rgba, y * w * 4, cur);
    const o = y * stride + 1;
    if (y === 0 && !hasPrev) {
      // first row of the picture: Sub
      raw[o - 1] = 1;
      for (let i = 0; i < n3; i++) raw[o + i] = (cur[i] - (i >= 3 ? cur[i - 3] : 0)) & 0xff;
    } else {
      raw[o - 1] = 4; // Paeth
      for (let i = 0; i < 3; i++) raw[o + i] = (cur[i] - up[i]) & 0xff;
      for (let i = 3; i < n3; i++) {
        const a = cur[i - 3], b = up[i], c = up[i - 3];
        const pa = b > c ? b - c : c - b; // |p - a|
        const pb = a > c ? a - c : c - a; // |p - b|
        const pcv = a + b - c - c;
        const pc = pcv < 0 ? -pcv : pcv; // |p - c|
        raw[o + i] = (cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    const t = up;
    up = cur;
    cur = t;
  }
  const parts: Uint8Array[] = [];
  const z = new Deflate({ level: level as 1 }, (d) => parts.push(d));
  z.push(raw, false);
  z.flush();
  // the bits fflate is still holding back (st.r: count in the low 3 bits, the byte above),
  // then an empty non-final stored block, which byte-aligns the stream
  const r = (z as unknown as { s: { r?: number } }).s.r ?? 0;
  const nb = r & 7;
  // held bits, then the 3 zero header bits (not final, stored), zero padding to the byte
  const tail = [(r >> 3) & ((1 << nb) - 1)];
  if (nb + 3 > 8) tail.push(0);
  tail.push(0x00, 0x00, 0xff, 0xff); // LEN 0, NLEN
  parts.push(new Uint8Array(tail));
  let n = 0;
  for (const p of parts) n += p.length;
  const data = new Uint8Array(n);
  n = 0;
  for (const p of parts) {
    data.set(p, n);
    n += p.length;
  }
  return { idat: chunk('IDAT', data), adler: adler32(raw), len: raw.length };
}
