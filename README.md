# Lumen — photo editor for your phone

A Snapseed/Lightroom-style photo editor that runs in your phone's browser and installs to the
home screen like an app. Everything runs on-device on the GPU — photos never leave your phone.

## Using it

Tap a tool in the bottom bar to open its section. Everything in a section is done on the photo:

| Gesture | What it does |
| --- | --- |
| **Swipe left / right** | Change the adjustment (with haptic ticks; slow swipes are finer) |
| **Swipe up / down** | Move through the adjustments (up = further down the list) |
| **Tap** | Hide / show all controls |
| **Double-tap** | Reset the current adjustment |
| **Press & hold** | Show the original |
| **Pinch** | Zoom |
| Tap the value at the bottom | Type an exact number |
| ✓ (bottom right) | Done — back to the tool bar · ↺ (bottom left) resets the section |

## Features

- **Formats:** JPEG, HEIC (Safari), PNG, WebP, and **RAW** — DNG, CR2, CR3, NEF, ARW, RAF, ORF,
  RW2, PEF and more, decoded with LibRaw (WebAssembly) in 16-bit linear. If full RAW decoding
  isn't possible on a device, the camera's embedded full-size JPEG is used instead.
- **Blur:** tilt-shift and radial focus blur with a draggable focus point (true linear-light lens blur).
- **Masks & selective edits:** up to 8 per photo — Radial, Gradient, Brush (paint/erase with size,
  hardness, flow), Selective point (Snapseed-style, follows similar colors), Light range and Color
  range (tap the photo to pick). Each has Exposure, Contrast, Highlights, Shadows, Temperature,
  Tint, Saturation, Clarity and Dehaze, plus invert, strength, duplicate and a cyan overlay to see
  exactly what's selected. Light/color picking shows a magnifier above your finger.
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
- Undo/redo, histogram, copy/paste edits, **full-resolution export** (JPEG/PNG, tiled rendering
  plus a streaming JPEG encoder, so even 40+ MP files export on a phone), Share sheet to save to
  Photos.
- Works offline once loaded, and autosaves — reopen the app and tap **Continue editing**.
- Clipping warnings, per-tool Reset, zoom badge (tap to fit).

## Put it on your phone

1. In this repo on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Re-run the `Deploy to GitHub Pages` workflow (Actions tab), or push to the default branch. It publishes at
   `https://<your-user>.github.io/<repo>/`.
3. Open that link on your phone.
   - iPhone (Safari): Share → **Add to Home Screen**.
   - Android (Chrome): ⋮ → **Install app** / **Add to Home screen**.

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
