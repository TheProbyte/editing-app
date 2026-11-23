// When a photo was taken, for the date stamp: the camera's own date (EXIF DateTimeOriginal) from
// a JPEG, else the file's date.

/** Reads the first 128 KB only (EXIF sits at the start of a JPEG). */
export async function photoDate(file: File): Promise<Date> {
  const fallback = new Date(file.lastModified || Date.now());
  try {
    const buf = new DataView(await file.slice(0, 131072).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return fallback;
    let o = 2;
    while (o + 4 < buf.byteLength) {
      const marker = buf.getUint16(o), len = buf.getUint16(o + 2);
      // APP1 with "Exif\0\0"
      if (marker === 0xffe1 && buf.getUint32(o + 4) === 0x45786966) return exifDate(buf, o + 10) ?? fallback;
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      o += 2 + len;
    }
  } catch {
    /* unreadable: the file's date */
  }
  return fallback;
}

function exifDate(v: DataView, tiff: number): Date | null {
  const le = v.getUint16(tiff) === 0x4949;
  const u16 = (p: number) => v.getUint16(p, le), u32 = (p: number) => v.getUint32(p, le);
  /** a tag's value offset in an IFD (absolute), or -1 */
  const find = (ifd: number, tag: number) => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === tag) return e;
    }
    return -1;
  };
  const ifd0 = tiff + u32(tiff + 4);
  let e = -1;
  const sub = find(ifd0, 0x8769);
  if (sub >= 0) e = find(tiff + u32(sub + 8), 0x9003); // DateTimeOriginal
  if (e < 0) e = find(ifd0, 0x0132); // DateTime
  if (e < 0) return null;
  const at = tiff + u32(e + 8);
  let s = '';
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(at + i));
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(+d) || +m[1] < 1900 ? null : d;
}
