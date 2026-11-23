// Export: every output frame is decoded exactly (Mediabunny), put through the same GPU
// pipeline as the preview at full size and handed to the hardware encoder straight from the
// canvas. Audio (clips at their speed and volume, plus the music) is mixed offline first. The
// file is written to the site's private storage as it's made (a long export would not fit in
// memory), and handed back as that file.
import {
  AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_VERY_HIGH,
  StreamTarget, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, type VideoSample,
} from 'mediabunny';
import type { Media, MediaLib } from './media';
import { MIX_RATE, type AudioEngine } from './audio';
import { clipLen, layout, srcAt, type VClip, type VideoProject } from './project';

export interface VideoExportOptions {
  lib: MediaLib;
  audio: AudioEngine;
  project: VideoProject;
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  fps: number;
  quality: 'high' | 'max';
  /** extra bitrate for pictures that are hard to compress (moving film grain), 1 = none */
  boost?: number;
  /** before a clip's frames are drawn (e.g. to read a still at full size) */
  prepare?: (clip: VClip, media: Media) => Promise<void>;
  /** draw the finished frame for timeline time T onto the canvas (w×h) */
  drawFrame: (clip: VClip, media: Media, sample: VideoSample | null, T: number) => void;
  progress: (f: number, stage: string) => void;
  cancelled: () => boolean;
}

/** the folder (in the site's private storage) exports are written into */
const DIR = 'lumen-exports';

/**
 * A new file for an export in the site's private storage. What earlier exports left there goes
 * first (the last one stays until then: it may still be being saved). Null where there's no such
 * storage (older WebViews): the export is then built in memory, as before.
 */
async function diskFile() {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return null;
    const dir = await root.getDirectoryHandle(DIR, { create: true });
    const old: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) old.push(name);
    for (const name of old) await dir.removeEntry(name).catch(() => {});
    const name = `export-${Date.now()}.mp4`;
    const fh = await dir.getFileHandle(name, { create: true });
    const drop = () => dir.removeEntry(name).catch(() => {});
    if (typeof fh.createWritable !== 'function') {
      await drop();
      return null;
    }
    return { fh, writable: await fh.createWritable(), drop };
  } catch (e) {
    console.warn('no private storage for the export: building it in memory', e);
    return null;
  }
}

export async function exportVideo(o: VideoExportOptions): Promise<Blob> {
  const p = o.project;
  const { starts, total } = layout(p);
  if (total <= 0) throw new Error('Nothing to export');
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: o.w, height: o.h });
  if (!vcodec) throw new Error(`This phone can’t encode ${o.w}×${o.h} video`);
  const hasAudio = p.clips.some((c) => c.vol > 0 && o.lib.get(c.src)?.audio) || !!(p.music && o.lib.get(p.music.src)?.audio && p.music.vol > 0);
  const acodec = hasAudio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: MIX_RATE }) : null;

  const disk = await diskFile();
  // on disk the index goes at the end, written once everything's length is known (a plain MP4
  // every player and gallery reads); only in memory can it go at the front
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: disk ? false : 'in-memory' }),
    target: disk ? new StreamTarget(disk.writable, { chunked: true, chunkSize: 4 * 2 ** 20 }) : new BufferTarget(),
  });
  // bits per pixel per frame, capped at what phones record at
  const bitrate = Math.round(Math.min(80e6, o.w * o.h * o.fps * (o.quality === 'max' ? 0.3 : 0.16) * (o.boost ?? 1)));
  const video = new CanvasSource(o.canvas, { codec: vcodec, bitrate: bitrate || (o.quality === 'max' ? QUALITY_VERY_HIGH : QUALITY_HIGH), keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: o.fps });
  let audio: AudioBufferSource | null = null;
  if (acodec) {
    audio = new AudioBufferSource({ codec: acodec, bitrate: 192_000 });
    output.addAudioTrack(audio);
  }
  await output.start();

  try {
    // ---- sound
    if (audio) {
      o.progress(0, 'Mixing sound');
      // the same premixed soundtrack the preview plays
      const mix = await o.audio.mix(p);
      if (o.cancelled()) throw new DOMException('cancelled', 'AbortError');
      if (mix) await audio.add(mix);
      audio.close();
    }

    // ---- pictures
    const frames = Math.max(1, Math.round(total * o.fps));
    let n = 0;
    for (let i = 0; i < p.clips.length; i++) {
      const clip = p.clips[i];
      const m = o.lib.get(clip.src);
      if (!m) continue;
      const start = starts[i], end = start + clipLen(clip);
      // the output frames that fall in this clip
      const k0 = Math.ceil(start * o.fps - 1e-6), k1 = Math.min(frames, Math.ceil(end * o.fps - 1e-6));
      if (k1 <= k0) continue;
      const times = Array.from({ length: k1 - k0 }, (_, j) => (k0 + j) / o.fps);
      await o.prepare?.(clip, m);
      if (m.kind === 'image' || !m.video) {
        for (const T of times) {
          if (o.cancelled()) throw new DOMException('cancelled', 'AbortError');
          o.drawFrame(clip, m, null, T);
          await video.add(T, 1 / o.fps);
          o.progress(++n / frames, 'Exporting');
        }
        continue;
      }
      const sink = o.lib.videoSink(m)!;
      const srcTimes = times.map((T) => Math.min(clip.out - 1e-4, srcAt(clip, T - start)));
      let j = 0;
      let last: VideoSample | null = null;
      try {
        for await (const s of sink.samplesAtTimestamps(srcTimes)) {
          if (o.cancelled()) {
            s?.close();
            throw new DOMException('cancelled', 'AbortError');
          }
          const T = times[j++];
          // no frame (before the file's first one): the last one again, or at the very start
          // of a clip its first frame, rather than whatever the previous clip left
          if (!s && !last) last = await sink.getSample(await m.video.getFirstTimestamp()).catch(() => null);
          const use = s ?? last;
          o.drawFrame(clip, m, use, T);
          if (s) {
            if (last && last !== s) last.close();
            last = s;
          }
          await video.add(T, 1 / o.fps);
          o.progress(++n / frames, 'Exporting');
        }
      } finally {
        last?.close();
      }
    }
    video.close();
    o.progress(1, 'Finishing');
    await output.finalize();
    if (disk) {
      // the file itself (read from disk when it's saved), not a copy of it in memory
      const f = await disk.fh.getFile();
      if (!f.size) throw new Error('The video came out empty');
      return new File([f], f.name, { type: 'video/mp4' });
    }
    const buf = (output.target as BufferTarget).buffer;
    if (!buf) throw new Error('The video came out empty');
    return new Blob([buf], { type: 'video/mp4' });
  } catch (e) {
    await output.cancel().catch(() => {});
    // a cancelled or failed export leaves no file behind
    await disk?.drop();
    throw e;
  }
}
