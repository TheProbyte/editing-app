# Lumen — photo editor for your phone

A Snapseed/Lightroom-style photo editor that runs in your phone's browser and installs to the
home screen like an app. Everything runs on-device on the GPU — photos never leave your phone.

## Using it

- **Open media**: one photo opens the photo editor; a video (or several files) opens the **video editor**.
  **Take photo** shoots RAW/DNG in the Android app. The home button returns to the start page.
- **Tool bar**: tap a tool, or **swipe up** on the bar for a grid of every tool. Tools and sections you've
  changed carry a yellow dot.
- **Home**: recent projects with their names (and a video's length); **hold** one to rename it, pin it to the
  front or delete it. **Open with / Share to Lumen** from Google Photos and other apps.
- **⋯ menu**: Settings (export format and quality, AI remove model, haptics, tips), Storage (what's kept on the
  phone, a size limit for recent projects), a Performance readout, before/after **split** view (the button on
  the photo).
- In a section: **swipe ↔ on the photo** or **drag the slider** to change the value (it sticks at 0 for a
  moment so it's easy to land back on it; double-tap the slider to reset). **Swipe ↕** to pick the adjustment.
  **✓** keeps it, **Back** (or the Android back gesture) drops the section's changes.
- **Tap** the photo to hide/show the controls, **hold** to see the original, **pinch** to zoom (to pixel level,
  with a pixel grid), **one finger** pans when zoomed, **double-tap** zooms in/out.

## Video

**Recent projects:** the home screen keeps your last 8 photos and videos with their edits (files, edit and a
thumbnail are stored on the device); tap one to carry on exactly where you were, × to forget it.

Pick one or more videos (and photos, as 3-second stills) with **Open media**. Every look and adjustment
from the photo editor applies to the whole video; the timeline sits above the tool bar.

- **Timeline:** drag to scrub (flick to coast), pinch to zoom, tap a clip to select it, drag its yellow
  handles to trim, hold a clip to pick it up and move it. **+** adds more clips (after the selected one).
- **Edit:** Split at the playhead, Copy, Mute, Delete, **Speed** (0.25–4×) and **Volume** on the slider.
- **Speed ramps:** **Ramp** in Edit: Montage, Hero, Bullet, Flash in, Flash out, Jump cut, or Custom. The
  curve shows above the timeline; drag its points up (faster) or down (slower), 0.1×–10×. The speed changes
  smoothly along the curve (exactly: the timeline ↔ source mapping is solved per straight piece), and
  playback, scrubbing, trimming, splitting, the sound (its rate follows the curve) and the export all follow it.
- **A look per clip, and animated looks:** every adjustment section starts with **All clips / This clip**.
  *This clip* gives the clip under the playhead its own look (starting from the current one); the sliders
  then change only that clip. **◆ Key** keys the look at the playhead: once a clip has look keyframes,
  changing any setting elsewhere in it adds a keyframe there, and the look eases between them (white
  diamonds on the timeline). *All clips* puts the clip back on the whole-video look.
- **Framing & keyframes:** with a clip selected (Edit), drag the video to move the clip and pinch to zoom /
  twist to rotate it (or use Zoom, Position and Rotate on the slider). **Keyframe** (◆) marks the framing at
  the playhead; once a clip has keyframes, changing the framing anywhere keys it there, and the motion eases
  between them. Keyframes sit on the clip's content, so trimming or speed changes don't move them.
  **Ken Burns** adds a slow push-in (photos move while playing too).
- **Canvas:** Original, 9:16, 4:5, 1:1 or 16:9; Fit or Fill; background **Blur** (strength on the slider),
  **Color**, **Gradient** or your own **Photo** (sharp or blurred).
- **Text:** titles with Pixel / Sans / Serif type, colours and a box; drag them on the video, and drag or
  trim their bar in the timeline to set when they show.
- **Music:** add a song (fades in/out), set its volume and where in the song to start.
- **Freeze & Reverse:** Freeze holds the frame at the playhead for 2 s; Reverse plays a clip backwards
  (picture and sound), and again to go back. Frame-step buttons beside play; drags snap to cuts and
  keyframes; titles stay with the moment of their clip.
- **Light leaks that move:** Leaks in a video get **Motion** (drift, turn, breathing light).
- **Transitions:** tap the marker on a cut: Crossfade, Black, White, Zoom, Whip, Burn, 0.2–2 s (the clips
  overlap; the sound crossfades too); Preview, All cuts, Remove.
- **Fades:** Edit → Fade: picture from / to black and the sound in / out, per clip.
- **Voiceover:** Voice → record (3-2-1, then the video plays while you talk); each take is a clip on its own
  lane you can move, trim, set the volume of or delete. The music ducks under the voice.
- **Captions:** Text → Captions listens to the clips (on the phone, Whisper tiny; a one-time 44 MB download)
  and adds titles at the right moments; run it again to redo them, edit any like a title.
- **Beats:** the song's beats show on the music lane and drags snap to them; Music → **Cut to beat** trims
  the clips so every cut lands on a beat (every 1, 2 or 4).
- **Cine motion:** Frame → Motion holds the picture at 18 / 12 / 8 fps for a film-camera feel (the sound
  stays as it is).
- **Person:** the AI follows the people through the video: brighten or color them, darken or grey the
  background (Spotlight, Color pop, Bright subject).
- **Film grain that moves:** in Grain, video adds **Motion** (Still / 12 fps / 24 fps / every frame),
  **Flicker**, **Gate weave** (the picture drifting in the projector gate) and **Dust & scratches**, plus
  **8mm / 16mm / 35mm / Clean** presets. Everything is keyed to the film frame, so the export matches the
  preview frame for frame, and exports with moving grain get extra bitrate so the grain survives encoding.
- **Play:** the play button or a tap on the video.
- **Waveforms:** each clip's sound is drawn along the bottom of its strip (scaled by its volume, following speed
  ramps) and the song's in the music lane, so beats and voices are easy to cut to.
- **How it stays smooth:** frames are decoded ahead and copied to GPU textures the moment they arrive; one
  display loop shows each on the refresh it's due, against the audio output's own clock (interpolated, and
  allowing for Bluetooth delay). The soundtrack is mixed once in the background after each edit into one
  continuous track, so playback has nothing to schedule and can't drop out. Scrubbing keeps a decoder open
  (forward is just decoding on), keeps small copies of frames it has decoded for reverse scrubbing (and decodes the second before the one you're scrubbing back through ahead of time, also while you're stopped on a frame), and lands on
  the exact frame when you stop. Every key frame of a clip is also decoded once in the background into a
  small picture: a drag faster than the decoder can follow (it learns how fast that is) shows those
  instantly, and no frame is ever shown against the direction you're dragging. 480p / 720p footage is
  previewed at its own size, an edit with no adjustments skips the photo pipeline entirely, and the preview
  resolution only steps down if a phone can't keep up.
- **Export:** 720p / 1080p / 1440p / 4K (up to the source), 24 / 30 / 60 fps, MP4 with the phone's hardware
  encoder (H.264 where available, else HEVC / VP9 / AV1) and AAC or Opus sound (the same mix the preview
  plays); saved to Movies/Lumen in the Android app. Each frame goes through the same GPU pipeline as the
  preview, at full size. The screen stays on while it exports, photos in the timeline are read at the
  export's size (the preview keeps smaller copies), and the last size / frame rate / quality you chose
  for that kind of footage is remembered.
- **Sound that doesn't crackle:** the mix passes through a limiter that does nothing below full level
  and turns the level down smoothly around moments that would go over (a loud clip plus music, a clip
  at 200%).
- Undo, redo and the history list cover timeline edits too.
- Built on **Mediabunny** (demuxing, frame-exact decoding and MP4 muxing through WebCodecs), loaded only
  when a video is opened. Video projects aren't autosaved yet.

## Features

- **Formats:** JPEG, HEIC (Safari), PNG, WebP, and **RAW** — DNG, CR2, CR3, NEF, ARW, RAF, ORF,
  RW2, PEF and more, decoded with LibRaw (WebAssembly) in 16-bit linear. If full RAW decoding
  isn't possible on a device, the camera's embedded full-size JPEG is used instead.
- **Remove:** tap blemishes, dust or small objects to heal them (auto-picks a matching patch).
- **Camera:** take a photo in-app — a plain full-resolution capture from the camera without the phone's HDR/computational processing (swipe for exposure).
- **Blur:** tilt-shift and radial focus blur with a draggable focus point (true linear-light lens blur).
  **Lens** is a portrait-mode style blur from the photo's depth: tap where it should be sharp; Blur strength,
  Depth of field and Bokeh on the slider. The depth comes from Depth Anything V2 (small, run on the phone;
  27 MB, downloaded once), its edges snapped to the photo's with a guided filter. The blur is a gathered
  disc per pixel where each sample only reaches as far as its own blur (so a sharp subject isn't smeared
  by the background, and a blurred foreground spreads over what's behind), with bright points weighted
  up so lights turn into round bokeh. Sharp vs blurred is decided per pixel at full size, so subject edges
  stay crisp in the full-resolution export.
- **Masks & selective edits:** up to 8 per photo — **Subject** (AI: tap or scribble over it, Exclude to
  take parts away), **People** (AI: person, face, skin, hair, clothes or background), Radial, Gradient,
  Brush (paint/erase with size, hardness, flow), Selective point (Snapseed-style, follows similar colors),
  Light range and Color range (tap the photo to pick). AI masks run on the phone (MediaPipe Magic Touch v2
  and selfie-multiclass, downloaded once and cached), are snapped to edges with a guided filter, and can
  be refined with the brush. Each mask has Exposure, Contrast, Highlights, Shadows, Temperature, Tint,
  Saturation, Clarity and Dehaze, plus invert, strength, duplicate and an overlay to see what's selected.
- **Remove:** press on a blemish, slide to place it (a loupe shows it close up), let go to remove it.
  Each fix shows where it copied from — drag that yellow ring to choose the source yourself (e.g. a clean
  bit of chain over a necklace clasp); Auto fill and Delete for the selected spot.
- **AI fill (in Remove):** paint over an object and let go: a neural network rebuilds what's behind it,
  on the phone. Two models (More ⋯ → *AI fill model*):
  - **LaMa** (big-lama, Apache-2.0) — the best quality. 208 MB, downloaded once from Hugging Face the first
    time you use it (the app asks), then kept on the device and used offline.
  - **MI-GAN** (Picsart AI Research, MIT) — small (28 MB), ships with the app (`public/models/migan.onnx`).
    Used when LaMa isn't chosen/downloaded or can't run.
  Both run with ONNX Runtime Web in a worker (`public/ort/` is copied from `node_modules` at build). If neither
  can run, a classic PatchMatch fill (`src/ai/inpaint.ts`) steps in.
- **Light leaks:** 22 built-in leaks (flares, burns, prisms, streaks, orbs) drawn on the fly; move, scale,
  rotate (drag, corner square or pinch), blend modes, and a Hide/Show brush.
- **Double exposure:** add a second photo, drag to place it, size/rotate/opacity, 9 blend modes, and
  Hide/Show brushes to paint it away.
- **Looks & presets:** 17 film-style looks (Portra, CineStill 800T, Tri-X, Velvia, Chrome, Matte, Teal &
  Orange, …) with strength; save your own presets (long-press one to delete).
- **Light:** Exposure, Contrast, Brightness, Highlights, Shadows, Whites, Blacks.
- **Color:** Temperature, Tint, Vibrance, Saturation.
- **Detail:** Sharpening (amount, radius, masking), Texture, Clarity, Dehaze, Noise reduction,
  Color noise reduction.
- **Curves:** RGB + per-channel point curves with live histogram and presets.
- **HSL:** Hue / Saturation / Luminance for 8 color ranges.
- **Color grading:** Shadows / Midtones / Highlights / Global hue, saturation and luminance, plus
  Blending and Balance.
- **Black & White:** per-color B&W mix and split toning.
- **Grain:** Amount, Size, Roughness, Color, Shadow & Highlight response, plus film-stock presets.
  Grain is resolution-independent, so it looks the same in the preview and the full-res export.
- **Halation:** the red-orange glow film gets around bright highlights — Amount, Threshold,
  Spread, Hue, Saturation.
- **Glow / Diffusion:** bloom and mist-filter softness.
- **Vignette:** Amount, Size, Feather, Roundness, highlight protection.
- **Film & Lens:** Fade (with warmth), color fringing, lens distortion.
- **Crop & rotate:** free or fixed aspect ratios, straighten, rotate 90°, flip, and **perspective**
  (Vertical / Horizontal) to stand converging building lines up straight.
- **Air:** haze that builds with distance (from the depth map: near things stay clear) and the sky's
  brightness, color and warmth; presets Morning mist, Far hills, Bluer sky, Warm sky.
- **Frame:** film gates with perforations — Super 16, 35mm, Super 8 — plus VHS and Instant print, with a
  glowing **date stamp** (the photo's own date from its EXIF). Works on video too.
- **AI denoise / upscale (Detail):** Real-ESRGAN on the phone (5 MB, ships with the app): AI denoise keeps the
  size, Upscale 2× / 4× up to 36 MP; **Original pixels** goes back; the edit carries over.
- **LUTs:** import `.cube` files in Looks (**LUT**): they become looks with a strength; hold one to delete it.
- Undo/redo with a history list (tap any step to jump there), histogram, copy/paste edits, **full-resolution export** (JPEG/PNG, tiled rendering
  plus a streaming JPEG encoder, so even 40+ MP files export on a phone), saves straight to the phone on Android (Downloads), Share sheet on iPhone.
- Works offline once loaded (the whole app, video editor included, is saved ahead; the big decoders
  and AI runtimes are kept from first use and survive app updates, as do downloaded models), and
  autosaves — reopen the app and pick up from **Recent**.
- A file that can't be read never costs you what's open, and after the GPU hiccups (context loss) the
  photo or video comes back as it was.
- Clipping warnings, per-tool Reset, zoom badge (tap to fit).
- Pixel look: Pixelify Sans + Silkscreen type, hand-drawn pixel icons, yellow on near-black.

## Put it on your phone

1. In this repo on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Re-run the `Deploy to GitHub Pages` workflow (Actions tab), or push to the default branch. It publishes at
   `https://<your-user>.github.io/<repo>/`.
3. Open that link on your phone.
   - iPhone (Safari): Share → **Add to Home Screen**.
   - Android (Chrome): ⋮ → **Install app** / **Add to Home screen**.

## Android app (APK)

Every push builds a signed APK and publishes it next to the web app:
`https://theprobyte.github.io/editing-app/lumen.apk` (also in the web app: ⋯ → **Get the Android app**).

1. Open the link in Chrome on the phone and let it download.
2. Tap the download → if asked, allow **Install unknown apps** for Chrome → **Install**.
3. Play Protect may warn about an unknown developer: **More details → Install anyway**.

Later builds install over the old one (same signing key in `android/lumen.keystore`), keeping your data.

The app adds: Camera2 RAW capture saved as real DNG files (oriented the way you held the phone), exports saved straight to
**Pictures/Lumen** in the gallery, the phone's own haptic ticks, and Android's RAW decoder as a
fallback. Native code lives in `android/app/src/main/java/app/lumen/editor/`.

Build it locally: `npm run build && npx cap sync android && cd android && ./gradlew assembleRelease`.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173 (also on your LAN, so you can open it on your phone)
npm run build    # production build in dist/
npm run preview
```

Code map:

- `src/gl/shaders.ts` — all image processing (GLSL): geometry, develop (tone/color/detail/grading),
  finish (halation, glow, vignette, grain).
- `src/gl/pipeline.ts` — runs the passes, caches blurs, and does tiled full-resolution export.
- `src/params.ts` — every adjustment, with its range and default.
- `src/presets.ts` — the Looks.
- `src/ui/` — app controller, gestures, curve editor, crop overlay, histogram.
- `src/io/` — file loading (incl. RAW), export, and the JPEG / PNG encoders that split an export
  into bands of rows and encode them on every core while the GPU is still rendering.
- `public/sw.js` — offline cache + the cross-origin isolation headers the multi-threaded RAW
  decoder needs on static hosts like GitHub Pages. `scripts/stamp-sw.mjs` (run by `npm run build`)
  tells it which files make up the build.

## Credits and licences

- **MI-GAN** (Picsart AI Research, MIT) — the `migan_pipeline_v2.onnx` weights used for the built-in AI fill, taken from the
  `migan-onnx` npm package. **LaMa** (Samsung AI Center, Apache-2.0) is fetched on request. The weights were trained on Places2 / FFHQ research datasets, so treat this as a
  personal-use app.
- **Depth Anything V2 Small** (Apache-2.0; `onnx-community/depth-anything-v2-small`, quantized) for the lens blur,
  fetched from Hugging Face the first time Lens is used.
- **Real-ESRGAN** `realesr-general-x4v3` and `realesr-general-wdn-x4v3` (Xintao Wang et al., BSD-3-Clause) for AI
  denoise and upscale: converted to one ONNX file (`public/models/realesr-x4.onnx`, 5 MB, fp16 weights) whose `dn`
  input blends the two weight sets like the original `-dn` option; ships with the app. Also used by Air and the lens
  blur: Depth Anything (above).
- **LibRaw** (via `libraw-wasm`), **MediaPipe Tasks Vision** (Apache-2.0) for subject / people selection,
  **ONNX Runtime Web** (MIT), **fflate** (MIT) for PNG compression, **Mediabunny** (MPL-2.0) for video,
  Pixelify Sans and Silkscreen (OFL).
