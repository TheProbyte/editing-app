// Baseline JPEG encoder (4:4:4) that works in horizontal bands, so several workers can
// encode one picture at once. Every row of 8×8 blocks ends with a restart marker (the
// restart interval is one block row), which resets the DC predictors and byte-aligns the
// stream: bands encoded separately just get joined end to end.

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];
const Y_QT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const C_QT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array(32).fill(99),
];
const AASF = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

const DC_L_N = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_C_N = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_V = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_L_N = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_L_V = hex(
  '01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa',
);
const AC_C_N = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_C_V = hex(
  '000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa',
);

function hex(s: string) {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

interface Huff { code: Int32Array; len: Int32Array }
function huff(counts: number[], values: number[]): Huff {
  const code = new Int32Array(256);
  const len = new Int32Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let j = 0; j < counts[l - 1]; j++) {
      code[values[k]] = c;
      len[values[k]] = l;
      k++;
      c++;
    }
    c <<= 1;
  }
  return { code, len };
}

const HUFF = {
  dcL: huff(DC_L_N, DC_V),
  dcC: huff(DC_C_N, DC_V),
  acL: huff(AC_L_N, AC_L_V),
  acC: huff(AC_C_N, AC_C_V),
};

function quantTables(quality: number) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);
  const qY = new Uint8Array(64), qC = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    qY[ZIGZAG[i]] = clampQ(Math.floor((Y_QT[i] * sf + 50) / 100));
    qC[ZIGZAG[i]] = clampQ(Math.floor((C_QT[i] * sf + 50) / 100));
  }
  const fY = new Float32Array(64), fC = new Float32Array(64);
  for (let r = 0, k = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++, k++) {
      const s = AASF[r] * AASF[c] * 8;
      fY[k] = 1 / (qY[ZIGZAG[k]] * s);
      fC[k] = 1 / (qC[ZIGZAG[k]] * s);
    }
  }
  return { qY, qC, fY, fC };
}

/** Growable byte writer with JPEG bit packing (0xFF bytes in entropy data get a 0 stuffed after them). */
class Out {
  buf: Uint8Array;
  pos = 0;
  private acc = 0;
  private n = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(4096, size));
  }
  private room(k: number) {
    if (this.pos + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + k));
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
  byte(b: number) {
    this.room(1);
    this.buf[this.pos++] = b;
  }
  word(w: number) {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }
  /** Append `len` (<= 16) bits of `code`, most significant first. */
  bits(code: number, len: number) {
    this.acc = (this.acc << len) | (code & ((1 << len) - 1));
    this.n += len;
    if (this.n < 8) return;
    this.room(6);
    const buf = this.buf;
    while (this.n >= 8) {
      this.n -= 8;
      const b = (this.acc >>> this.n) & 0xff;
      buf[this.pos++] = b;
      if (b === 0xff) buf[this.pos++] = 0;
    }
    this.acc &= (1 << this.n) - 1;
  }
  /** Pad the last byte with 1 bits (as restart markers and the end need). */
  align() {
    if (this.n > 0) this.bits((1 << (8 - this.n)) - 1, 8 - this.n);
  }
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

/** Everything before the image data (SOI … SOS), with a restart interval of one block row. */
export function jpegHeader(w: number, h: number, quality: number): Uint8Array {
  const { qY, qC } = quantTables(quality);
  const o = new Out(1024);
  o.word(0xffd8);
  // APP0 JFIF
  o.word(0xffe0);
  o.word(16);
  [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0].forEach((b) => o.byte(b));
  o.word(1);
  o.word(1);
  o.byte(0);
  o.byte(0);
  // DQT
  o.word(0xffdb);
  o.word(132);
  o.byte(0);
  qY.forEach((b) => o.byte(b));
  o.byte(1);
  qC.forEach((b) => o.byte(b));
  // SOF0
  o.word(0xffc0);
  o.word(17);
  o.byte(8);
  o.word(h);
  o.word(w);
  o.byte(3);
  for (let c = 1; c <= 3; c++) {
    o.byte(c);
    o.byte(0x11);
    o.byte(c === 1 ? 0 : 1);
  }
  // DHT
  const tables: [number, number[], number[]][] = [
    [0x00, DC_L_N, DC_V], [0x10, AC_L_N, AC_L_V], [0x01, DC_C_N, DC_V], [0x11, AC_C_N, AC_C_V],
  ];
  let len = 2;
  for (const [, , v] of tables) len += 17 + v.length;
  o.word(0xffc4);
  o.word(len);
  for (const [id, n, v] of tables) {
    o.byte(id);
    n.forEach((b) => o.byte(b));
    v.forEach((b) => o.byte(b));
  }
  // DRI: restart after every block row
  o.word(0xffdd);
  o.word(4);
  o.word(Math.ceil(w / 8));
  // SOS
  o.word(0xffda);
  o.word(12);
  o.byte(3);
  o.byte(1); o.byte(0x00);
  o.byte(2); o.byte(0x11);
  o.byte(3); o.byte(0x11);
  o.byte(0); o.byte(63); o.byte(0);
  return o.bytes().slice();
}

const tableCache = new Map<number, ReturnType<typeof quantTables>>();

/**
 * Encode `rows` rows of RGBA (width w) that start at pixel row y0 (a multiple of 8) of an
 * image `h` rows tall. Returns the entropy-coded bytes for those block rows, restart
 * markers included; the band holding the last row ends without one.
 */
export function encodeJpegBand(rgba: Uint8Array, w: number, rows: number, y0: number, h: number, quality: number): Uint8Array {
  let T = tableCache.get(quality);
  if (!T) tableCache.set(quality, (T = quantTables(quality)));
  const { fY, fC } = T;
  const pw = Math.ceil(w / 8) * 8;
  const P = [new Float32Array(pw * 8), new Float32Array(pw * 8), new Float32Array(pw * 8)];
  const [Y, U, V] = P;
  const blk = new Float32Array(64);
  const du = new Int32Array(64);
  const out = new Out(Math.round(w * rows * 0.6));
  const totalRows = Math.ceil(h / 8);
  for (let r0 = 0; r0 < rows; r0 += 8) {
    // colour convert one block row (the bottom edge repeats the last row, the right edge the last column)
    for (let r = 0; r < 8; r++) {
      const sr = Math.min(rows - 1, r0 + r);
      const i = sr * w * 4;
      const off = r * pw;
      for (let x = 0; x < pw; x++) {
        const j = i + (x < w ? x : w - 1) * 4;
        const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2];
        Y[off + x] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
        U[off + x] = -0.168736 * R - 0.331264 * G + 0.5 * B;
        V[off + x] = 0.5 * R - 0.418688 * G - 0.081312 * B;
      }
    }
    const dc = [0, 0, 0];
    for (let bx = 0; bx < pw; bx += 8) {
      for (let c = 0; c < 3; c++) {
        const p = P[c];
        for (let r = 0; r < 8; r++) {
          const o = r * pw + bx;
          const b = r * 8;
          blk[b] = p[o]; blk[b + 1] = p[o + 1]; blk[b + 2] = p[o + 2]; blk[b + 3] = p[o + 3];
          blk[b + 4] = p[o + 4]; blk[b + 5] = p[o + 5]; blk[b + 6] = p[o + 6]; blk[b + 7] = p[o + 7];
        }
        fdctQuant(blk, c === 0 ? fY : fC, du);
        dc[c] = encodeBlock(out, du, dc[c], c === 0 ? HUFF.dcL : HUFF.dcC, c === 0 ? HUFF.acL : HUFF.acC);
      }
    }
    out.align();
    const R = (y0 + r0) / 8;
    if (R < totalRows - 1) out.word(0xffd0 + (R & 7));
  }
  return out.bytes();
}

function encodeBlock(o: Out, du: Int32Array, prevDC: number, dcT: Huff, acT: Huff) {
  const diff = du[0] - prevDC;
  if (diff === 0) o.bits(dcT.code[0], dcT.len[0]);
  else {
    const cat = bitLen(diff);
    o.bits(dcT.code[cat], dcT.len[cat]);
    o.bits(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
  }
  let end = 63;
  while (end > 0 && du[end] === 0) end--;
  if (end === 0) {
    o.bits(acT.code[0], acT.len[0]);
    return du[0];
  }
  let i = 1;
  while (i <= end) {
    const start = i;
    while (du[i] === 0 && i <= end) i++;
    let zeros = i - start;
    while (zeros >= 16) {
      o.bits(acT.code[0xf0], acT.len[0xf0]);
      zeros -= 16;
    }
    const v = du[i];
    const cat = bitLen(v);
    const sym = (zeros << 4) + cat;
    o.bits(acT.code[sym], acT.len[sym]);
    o.bits(v < 0 ? v + (1 << cat) - 1 : v, cat);
    i++;
  }
  if (end !== 63) o.bits(acT.code[0], acT.len[0]);
  return du[0];
}

function clampQ(v: number) {
  return Math.min(255, Math.max(1, v));
}

function bitLen(v: number) {
  return 32 - Math.clz32(v < 0 ? -v : v);
}

function fdctQuant(d: Float32Array, fdtbl: Float32Array, out: Int32Array) {
  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0 ? 1 : 8;
    const stride = pass === 0 ? 8 : 1;
    for (let i = 0; i < 8; i++) {
      const o = i * stride;
      const d0 = d[o], d1 = d[o + step], d2 = d[o + 2 * step], d3 = d[o + 3 * step];
      const d4 = d[o + 4 * step], d5 = d[o + 5 * step], d6 = d[o + 6 * step], d7 = d[o + 7 * step];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      let t10 = t0 + t3;
      const t13 = t0 - t3;
      let t11 = t1 + t2;
      let t12 = t1 - t2;
      d[o] = t10 + t11;
      d[o + 4 * step] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[o + 2 * step] = t13 + z1;
      d[o + 6 * step] = t13 - z1;
      t10 = t4 + t5;
      t11 = t5 + t6;
      t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433;
      const z2 = 0.5411961 * t10 + z5;
      const z4 = 1.306562965 * t12 + z5;
      const z3 = t11 * 0.707106781;
      const z11 = t7 + z3;
      const z13 = t7 - z3;
      d[o + 5 * step] = z13 + z2;
      d[o + 3 * step] = z13 - z2;
      d[o + step] = z11 + z4;
      d[o + 7 * step] = z11 - z4;
    }
  }
  for (let i = 0; i < 64; i++) {
    const v = d[i] * fdtbl[i];
    out[ZIGZAG[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
  }
}
