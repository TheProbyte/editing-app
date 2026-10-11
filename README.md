# Lumen — photo editor for your phone

A Snapseed/Lightroom-style photo editor that runs in your phone's browser and installs to the
home screen like an app. Everything runs on-device on the GPU — photos never leave your phone.

## Using it

- **Open** a photo (or **Take photo** — RAW/DNG in the Android app). The home button returns to the start page.
- **Tool bar**: tap a tool, or **swipe up** on the bar for a grid of every tool.
- In a section: **swipe ↔ on the photo** or **drag the slider** to change the value (it sticks at 0 for a
  moment so it's easy to land back on it; double-tap the slider to reset). **Swipe ↕** to pick the adjustment.
  **✓** keeps it, **Back** (or the Android back gesture) drops the section's changes.
- **Tap** the photo to hide/show the controls, **hold** to see the original, **pinch** to zoom (to pixel level,
  with a pixel grid), **one finger** pans when zoomed, **double-tap** zooms in/out.

## Features

- **Formats:** JPEG, HEIC (Safari), PNG, WebP, and **RAW** — DNG, CR2, CR3, NEF, ARW, RAF, ORF,
  RW2, PEF and more, decoded with LibRaw (WebAssembly) in 16-bit linear. If full RAW decoding
  isn't possible on a device, the camera's embedded full-size JPEG is used instead.
- **Remove:** tap blemishes, dust or small objects to heal them (auto-picks a matching patch).
- **Camera:** take a photo in-app — a plain full-resolution capture from the camera without the phone's HDR/computational processing (swipe for exposure).
- **Blur:** tilt-shift and radial focus blur with a draggable focus point (true linear-light lens blur).
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
- **Crop & rotate:** free or fixed aspect ratios, straighten, rotate 90°, flip.
- Undo/redo with a history list (tap any step to jump there), histogram, copy/paste edits, **full-resolution export** (JPEG/PNG, tiled rendering
  plus a streaming JPEG encoder, so even 40+ MP files export on a phone), saves straight to the phone on Android (Downloads), Share sheet on iPhone.
- Works offline once loaded, and autosaves — reopen the app and tap **Continue editing**.
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
- `src/io/` — file loading (incl. RAW), export, streaming JPEG encoder.
- `public/sw.js` — offline cache + the cross-origin isolation headers the multi-threaded RAW
  decoder needs on static hosts like GitHub Pages.

## Credits and licences

- **MI-GAN** (Picsart AI Research, MIT) — the `migan_pipeline_v2.onnx` weights used for the built-in AI fill, taken from the
  `migan-onnx` npm package. **LaMa** (Samsung AI Center, Apache-2.0) is fetched on request. The weights were trained on Places2 / FFHQ research datasets, so treat this as a
  personal-use app.
- **LibRaw** (via `libraw-wasm`), **MediaPipe Tasks Vision** (Apache-2.0) for subject / people selection,
  **ONNX Runtime Web** (MIT), Pixelify Sans and Silkscreen (OFL).
