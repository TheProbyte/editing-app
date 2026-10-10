// Streaming baseline JPEG encoder (4:4:4). Rows are fed in strips so that huge exports
// never need one giant canvas or one giant pixel buffer.

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

function huff(counts: number[], values: number[]) {
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

export class JpegStreamEncoder {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 20);
  private pos = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  private qY = new Uint8Array(64);
  private qC = new Uint8Array(64);
  private fY = new Float32Array(64);
  private fC = new Float32Array(64);
  private pw: number;
  private planes: Float32Array[];
  private pending = 0;
  private dc = [0, 0, 0];
  private blk = new Float32Array(64);
  private du = new Int32Array(64);

  constructor(private w: number, private h: number, quality: number) {
    const q = Math.max(1, Math.min(100, Math.round(quality)));
    const sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);
    for (let i = 0; i < 64; i++) {
      this.qY[ZIGZAG[i]] = clampQ(Math.floor((Y_QT[i] * sf + 50) / 100));
      this.qC[ZIGZAG[i]] = clampQ(Math.floor((C_QT[i] * sf + 50) / 100));
    }
    for (let r = 0, k = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++, k++) {
        const s = AASF[r] * AASF[c] * 8;
        this.fY[k] = 1 / (this.qY[ZIGZAG[k]] * s);
        this.fC[k] = 1 / (this.qC[ZIGZAG[k]] * s);
      }
    }
    this.pw = Math.ceil(w / 8) * 8;
    this.planes = [0, 1, 2].map(() => new Float32Array(this.pw * 8));
    this.writeHeaders();
  }

  /** Feed `rows` rows of RGBA pixels (width = this.w). */
  addRows(rgba: Uint8Array, rows: number) {
    const { w, pw } = this;
    const [Y, U, V] = this.planes;
    for (let r = 0; r < rows; r++) {
      const off = this.pending * pw;
      let i = r * w * 4;
      for (let x = 0; x < pw; x++) {
        const j = x < w ? i + x * 4 : i + (w - 1) * 4;
        const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2];
        Y[off + x] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
        U[off + x] = -0.168736 * R - 0.331264 * G + 0.5 * B;
        V[off + x] = 0.5 * R - 0.418688 * G - 0.081312 * B;
      }
      this.pending++;
      if (this.pending === 8) this.flushBlockRow();
    }
  }

  finish(): Uint8Array[] {
    if (this.pending > 0) {
      const { pw } = this;
      for (const p of this.planes) {
        const last = (this.pending - 1) * pw;
        for (let r = this.pending; r < 8; r++) p.copyWithin(r * pw, last, last + pw);
      }
      this.pending = 8;
      this.flushBlockRow();
    }
    if (this.bitCnt > 0) this.writeBits((1 << (8 - this.bitCnt)) - 1, 8 - this.bitCnt);
    this.word(0xffd9);
    this.chunks.push(this.buf.slice(0, this.pos));
    this.pos = 0;
    return this.chunks;
  }

  private flushBlockRow() {
    const { pw, blk, du } = this;
    for (let bx = 0; bx < pw; bx += 8) {
      for (let c = 0; c < 3; c++) {
        const p = this.planes[c];
        for (let r = 0; r < 8; r++) {
          const o = r * pw + bx;
          for (let k = 0; k < 8; k++) blk[r * 8 + k] = p[o + k];
        }
        fdctQuant(blk, c === 0 ? this.fY : this.fC, du);
        this.dc[c] = this.encodeBlock(du, this.dc[c], c === 0 ? HUFF.dcL : HUFF.dcC, c === 0 ? HUFF.acL : HUFF.acC);
      }
    }
    this.pending = 0;
  }

  private encodeBlock(du: Int32Array, prevDC: number, dcT: { code: Int32Array; len: Int32Array }, acT: { code: Int32Array; len: Int32Array }) {
    const diff = du[0] - prevDC;
    if (diff === 0) this.writeBits(dcT.code[0], dcT.len[0]);
    else {
      const cat = bitLen(diff);
      this.writeBits(dcT.code[cat], dcT.len[cat]);
      this.writeBits(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
    }
    let end = 63;
    while (end > 0 && du[end] === 0) end--;
    if (end === 0) {
      this.writeBits(acT.code[0], acT.len[0]);
      return du[0];
    }
    let i = 1;
    while (i <= end) {
      const start = i;
      while (du[i] === 0 && i <= end) i++;
      let zeros = i - start;
      while (zeros >= 16) {
        this.writeBits(acT.code[0xf0], acT.len[0xf0]);
        zeros -= 16;
      }
      const v = du[i];
      const cat = bitLen(v);
      const sym = (zeros << 4) + cat;
      this.writeBits(acT.code[sym], acT.len[sym]);
      this.writeBits(v < 0 ? v + (1 << cat) - 1 : v, cat);
      i++;
    }
    if (end !== 63) this.writeBits(acT.code[0], acT.len[0]);
    return du[0];
  }

  private writeBits(value: number, len: number) {
    for (let b = len - 1; b >= 0; b--) {
      this.bitBuf = (this.bitBuf << 1) | ((value >> b) & 1);
      this.bitCnt++;
      if (this.bitCnt === 8) {
        this.byte(this.bitBuf);
        if (this.bitBuf === 0xff) this.byte(0);
        this.bitBuf = 0;
        this.bitCnt = 0;
      }
    }
  }

  private byte(b: number) {
    if (this.pos === this.buf.length) {
      this.chunks.push(this.buf);
      this.buf = new Uint8Array(1 << 20);
      this.pos = 0;
    }
    this.buf[this.pos++] = b;
  }
  private word(w: number) {
    this.byte((w >> 8) & 0xff);
    this.byte(w & 0xff);
  }

  private writeHeaders() {
    this.word(0xffd8);
    // APP0 JFIF
    this.word(0xffe0);
    this.word(16);
    [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0].forEach((b) => this.byte(b));
    this.word(1);
    this.word(1);
    this.byte(0);
    this.byte(0);
    // DQT
    this.word(0xffdb);
    this.word(132);
    this.byte(0);
    this.qY.forEach((b) => this.byte(b));
    this.byte(1);
    this.qC.forEach((b) => this.byte(b));
    // SOF0
    this.word(0xffc0);
    this.word(17);
    this.byte(8);
    this.word(this.h);
    this.word(this.w);
    this.byte(3);
    for (let c = 1; c <= 3; c++) {
      this.byte(c);
      this.byte(0x11);
      this.byte(c === 1 ? 0 : 1);
    }
    // DHT
    const tables: [number, number[], number[]][] = [
      [0x00, DC_L_N, DC_V], [0x10, AC_L_N, AC_L_V], [0x01, DC_C_N, DC_V], [0x11, AC_C_N, AC_C_V],
    ];
    let len = 2;
    for (const [, , v] of tables) len += 17 + v.length;
    this.word(0xffc4);
    this.word(len);
    for (const [id, n, v] of tables) {
      this.byte(id);
      n.forEach((b) => this.byte(b));
      v.forEach((b) => this.byte(b));
    }
    // SOS
    this.word(0xffda);
    this.word(12);
    this.byte(3);
    this.byte(1); this.byte(0x00);
    this.byte(2); this.byte(0x11);
    this.byte(3); this.byte(0x11);
    this.byte(0); this.byte(63); this.byte(0);
  }
}

function clampQ(v: number) {
  return Math.min(255, Math.max(1, v));
}

function bitLen(v: number) {
  let a = Math.abs(v);
  let n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
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
