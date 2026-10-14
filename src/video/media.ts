// Media for the video editor: every file added to the project is opened once here. Videos are
// read with Mediabunny (demuxing + the phone's hardware decoders through WebCodecs), which
// gives frame-exact access for scrubbing and export; stills become fixed-length clips.
import {
  ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input, VideoSampleSink,
  type InputAudioTrack, type InputVideoTrack,
} from 'mediabunny';
import { isAudioFile, isVideoFile, uid } from './project';

export interface Media {
  id: string;
  name: string;
  file: Blob;
  kind: 'video' | 'image' | 'audio';
  /** seconds (stills: 0) */
  duration: number;
  /** display size (rotation applied) */
  w: number;
  h: number;
  fps: number;
  input: Input | null;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  /** decoded still */
  bitmap: ImageBitmap | null;
  /** small frames for the timeline, in source order */
  thumbs: { t: number; c: CanvasImageSource }[];
  thumbsDone: boolean;
}

export { isVideoFile, isAudioFile } from './project';

export class MediaLib {
  items = new Map<string, Media>();
  /** called whenever new thumbnails are ready */
  onThumbs: () => void = () => {};

  get(id: string) {
    return this.items.get(id) ?? null;
  }

  /** Add a file (with `id`: reopening a saved project, whose clips refer to it by that id). */
  async add(file: File, id?: string): Promise<Media> {
    const m = isVideoFile(file) || isAudioFile(file) ? await this.addAV(file) : await this.addImage(file);
    if (id && id !== m.id) {
      this.items.delete(m.id);
      m.id = id;
      this.items.set(id, m);
    }
    return m;
  }

  private async addAV(file: File): Promise<Media> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    if (!(await input.canRead())) throw new Error(`Can’t read ${file.name}`);
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (video && !(await video.canDecode())) {
      throw new Error(`This phone can’t decode ${file.name} (${video.codec ?? 'unknown'} video)`);
    }
    const okAudio = audio && (await audio.canDecode()) ? audio : null;
    if (!video && !okAudio) throw new Error(`${file.name} has no video or audio this phone can play`);
    const duration = await input.computeDuration();
    let fps = 30;
    if (video) {
      try {
        const st = await video.computePacketStats(90);
        if (st.averagePacketRate > 1) fps = st.averagePacketRate;
      } catch {
        /* keep 30 */
      }
    }
    const m: Media = {
      id: uid(), name: file.name, file, kind: video ? 'video' : 'audio', duration,
      w: video?.displayWidth ?? 0, h: video?.displayHeight ?? 0, fps,
      input, video, audio: okAudio, bitmap: null, thumbs: [], thumbsDone: !video,
    };
    this.items.set(m.id, m);
    if (video) void this.makeThumbs(m);
    return m;
  }

  private async addImage(file: File): Promise<Media> {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error(`Can’t open ${file.name}`);
    }
    // keep stills at a sane size for a video frame
    const k = Math.min(1, 3840 / Math.max(bmp.width, bmp.height));
    if (k < 1) {
      const b2 = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = b2;
    }
    const thumb = await createImageBitmap(bmp, { resizeHeight: 96, resizeQuality: 'medium' });
    const m: Media = {
      id: uid(), name: file.name, file, kind: 'image', duration: 0, w: bmp.width, h: bmp.height, fps: 30,
      input: null, video: null, audio: null, bitmap: bmp, thumbs: [{ t: 0, c: thumb }], thumbsDone: true,
    };
    this.items.set(m.id, m);
    return m;
  }

  /** Thumbnails across the clip (a coarse pass first, so the strip fills in quickly). */
  private async makeThumbs(m: Media) {
    if (!m.video) return;
    try {
      const sink = new CanvasSink(m.video, { height: 96, fit: 'contain' });
      const N = Math.max(2, Math.min(48, Math.ceil(m.duration)));
      const at = (k: number, n: number) => (m.duration * (k + 0.5)) / n;
      const passes = [Math.min(6, N), N];
      for (const n of passes) {
        const ts = Array.from({ length: n }, (_, k) => at(k, n));
        let k = 0;
        for await (const w of sink.canvasesAtTimestamps(ts)) {
          if (w) {
            m.thumbs.push({ t: ts[k], c: w.canvas });
            m.thumbs.sort((a, b) => a.t - b.t);
          }
          k++;
          if (k % 4 === 0) this.onThumbs();
        }
        this.onThumbs();
      }
    } catch (e) {
      console.warn('thumbnails failed', e);
    }
    m.thumbsDone = true;
    this.onThumbs();
  }

  /** The thumbnail nearest a source time. */
  thumbAt(m: Media, t: number) {
    const T = m.thumbs;
    if (!T.length) return null;
    let best = T[0];
    for (const x of T) if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x;
    return best.c;
  }

  videoSink(m: Media) {
    return m.video ? new VideoSampleSink(m.video) : null;
  }
  audioSink(m: Media) {
    return m.audio ? new AudioBufferSink(m.audio) : null;
  }
}
