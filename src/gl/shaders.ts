// All GLSL for the editing pipeline.
//
// Conventions:
//  * uv.y = 0 is the TOP row of the image in every texture. Only the final pass to the
//    on-screen canvas flips Y.
//  * Intermediate images are linear-light RGB. Tonal work happens in a "perceptual"
//    space (pure 2.2 gamma, unclipped) so sliders feel even across the range.

const COMMON = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toPerc(vec3 l) { return pow(max(l, 0.0), vec3(1.0 / 2.2)); }
vec3 toLin(vec3 p) { return pow(max(p, 0.0), vec3(2.2)); }
vec3 srgbToLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rnd(ivec2 c, uint seed) {
  return float(pcg(uint(c.x) * 1973u ^ pcg(uint(c.y) + seed * 9277u))) * (1.0 / 4294967295.0);
}
`;

/** Geometry: crop, straighten, quarter turns, flips and lens distortion. Outputs linear RGB. */
export const GEOMETRY = COMMON + `
uniform sampler2D uSrc;
uniform float uSrcLinear;
uniform vec2 uSrcSize;    // source pixel size (any scale)
uniform vec2 uFrameSize;  // quarter-turned frame size, same scale as uSrcSize
uniform vec4 uCrop;       // normalized crop in frame
uniform float uAngle;     // straighten (radians)
uniform float uCover;     // zoom so straightened image covers the frame
uniform int uQuarter;
uniform vec2 uFlip;
uniform float uDistort;
uniform vec2 uFull;       // output (cropped) image size in px
uniform vec4 uTile;       // tile offset.xy, size.zw in output px

void main() {
  vec2 g = (uTile.xy + vUv * uTile.zw) / uFull;
  if (uDistort != 0.0) {
    float aspect = uFull.x / uFull.y;
    vec2 d = (g - 0.5) * vec2(aspect, 1.0);
    float r2 = dot(d, d) / (0.25 * (aspect * aspect + 1.0));
    float k = uDistort;
    float f = (1.0 - k * r2) / (k < 0.0 ? 1.0 - k : 1.0);
    g = 0.5 + (g - 0.5) * f;
  }
  vec2 q = (uCrop.xy + g * uCrop.zw) * uFrameSize - 0.5 * uFrameSize;
  float c = cos(-uAngle), s = sin(-uAngle);
  q = mat2(c, s, -s, c) * q / uCover;
  q *= uFlip;
  for (int i = 0; i < 3; i++) {
    if (i < uQuarter) q = vec2(q.y, -q.x);
  }
  vec2 suv = (q + 0.5 * uSrcSize) / uSrcSize;
  vec3 col = texture(uSrc, suv).rgb;
  if (uSrcLinear < 0.5) col = srgbToLin(col);
  outColor = vec4(col, 1.0);
}`;

/** 4-tap bilinear downsample (a 4x4 tent), used for halving and for resizes. */
export const DOWNSAMPLE = COMMON + `
uniform sampler2D uSrc;
uniform vec2 uTexel; // source texel size
void main() {
  vec2 o = uTexel;
  vec3 c = texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb + texture(uSrc, vUv + vec2(o.x, -o.y)).rgb
         + texture(uSrc, vUv + vec2(-o.x, o.y)).rgb + texture(uSrc, vUv + vec2(o.x, o.y)).rgb;
  outColor = vec4(c * 0.25, 1.0);
}`;

/** Separable gaussian. */
export const BLUR = COMMON + `
uniform sampler2D uSrc;
uniform vec2 uDir;    // one texel step along the blur axis
uniform float uSigma; // in texels
void main() {
  int r = int(ceil(uSigma * 3.0));
  float inv = -0.5 / (uSigma * uSigma);
  vec3 acc = texture(uSrc, vUv).rgb;
  float wsum = 1.0;
  for (int i = 1; i <= 16; i++) {
    if (i > r) break;
    float w = exp(float(i * i) * inv);
    acc += w * (texture(uSrc, vUv + uDir * float(i)).rgb + texture(uSrc, vUv - uDir * float(i)).rgb);
    wsum += 2.0 * w;
  }
  outColor = vec4(acc / wsum, 1.0);
}`;

/** Extract the bright parts of an image (for halation and glow). */
export const BRIGHT = COMMON + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  vec2 o = uTexel;
  vec3 c = 0.25 * (texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb + texture(uSrc, vUv + vec2(o.x, -o.y)).rgb
         + texture(uSrc, vUv + vec2(-o.x, o.y)).rgb + texture(uSrc, vUv + vec2(o.x, o.y)).rgb);
  float y = luma(toPerc(c));
  float m = smoothstep(uThreshold, uThreshold + 0.25, y);
  outColor = vec4(c * m, 1.0);
}`;

/** The main develop pass: white balance, tone, detail, curves, color, grading, B&W, fade. */
export const DEVELOP = COMMON + `
uniform sampler2D uA;        // geometry output (tile), linear
uniform sampler2D uSharpB;   // small blur of A for sharpening (tile)
uniform sampler2D uNoiseB;   // small blur of A for noise reduction (tile)
uniform sampler2D uTexB;     // global blurs, sampled with global uv
uniform sampler2D uClarB;
uniform sampler2D uLargeB;
uniform sampler2D uLut;
uniform vec2 uFull;
uniform vec4 uTile;

uniform vec3 uWB;            // white balance * exposure
uniform float uContrast, uHighlights, uShadows, uWhites, uBlacks, uBrightness;
uniform float uVibrance, uSaturation;
uniform float uSharpen, uSharpMask, uTexture, uClarity, uDehaze, uDenoise, uColorDenoise;
uniform float uUseLut;
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform float uBw;
uniform float uBwMix[8];
uniform vec3 uBwTone;
uniform float uBwToneAmt;
uniform vec3 uCgShadow, uCgMid, uCgHigh, uCgGlobal; // chroma offsets
uniform vec4 uCgLum;          // shadows, mids, highs, global
uniform float uCgBlend, uCgBalance;
uniform float uFade, uFadeWarm, uDiffuse;
uniform float uRawBase;

// masks (local adjustments)
uniform int uMaskCount;
uniform int uMType[8];
uniform vec4 uMG0[8];   // shape: radial cx,cy,rx,ry | linear x0,y0,x1,y1 | luma lo,hi,soft | color hue,range | brush slot
uniform vec4 uMG1[8];   // radial angle, feather, smart, - | all: .w = invert
uniform vec4 uMG2[8];   // smart reference color (perceptual) rgb, amount
uniform vec4 uMA0[8];   // exposure, contrast, highlights, shadows
uniform vec4 uMA1[8];   // white balance multiplier rgb (perceptual), saturation
uniform vec4 uMA2[8];   // clarity, dehaze
uniform sampler2D uBrush0, uBrush1;
uniform vec4 uCrop;      // crop rect in frame coords
uniform float uFrameAspect;
uniform int uShowMask;

const float CENTERS[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 225.0, 270.0, 315.0, 360.0);

void bandWeights(float hueDeg, out float w[8]) {
  for (int i = 0; i < 8; i++) w[i] = 0.0;
  for (int i = 0; i < 8; i++) {
    float c0 = CENTERS[i], c1 = CENTERS[i + 1];
    if (hueDeg >= c0 && hueDeg < c1) {
      float t = smoothstep(0.0, 1.0, (hueDeg - c0) / (c1 - c0));
      w[i] += 1.0 - t;
      w[(i + 1) % 8] += t;
    }
  }
}

vec3 contrastCurve(vec3 x, float k) {
  const float piv = 0.46;
  float e = 1.0 + k;
  vec3 lo = piv * pow(clamp(x / piv, 0.0, 1.0), vec3(e));
  vec3 hi = 1.0 - (1.0 - piv) * pow(clamp((1.0 - x) / (1.0 - piv), 0.0, 1.0), vec3(e));
  vec3 r = mix(lo, hi, step(piv, x));
  return mix(r, x, step(1.0, x)); // leave out-of-range highlights alone
}

float maskWeight(int i, vec2 f, vec3 p0) {
  int t = uMType[i];
  vec4 g0 = uMG0[i], g1 = uMG1[i];
  float w = 0.0;
  if (t == 1) {
    vec2 d = (f - g0.xy) * vec2(uFrameAspect, 1.0);
    float c = cos(-g1.x), s = sin(-g1.x);
    d = mat2(c, s, -s, c) * d;
    float e = length(d / max(g0.zw, vec2(1e-4)));
    w = 1.0 - smoothstep(1.0 - max(g1.y, 0.01), 1.0, e);
    if (g1.z > 0.0) {
      float sig = mix(0.5, 0.05, g1.z);
      vec3 dc = p0 - uMG2[i].rgb;
      w *= exp(-dot(dc, dc) / (2.0 * sig * sig));
    }
  } else if (t == 2) {
    vec2 asp = vec2(uFrameAspect, 1.0);
    vec2 dir = (g0.zw - g0.xy) * asp;
    float tt = dot((f - g0.xy) * asp, dir) / max(dot(dir, dir), 1e-6);
    w = 1.0 - smoothstep(0.0, 1.0, tt);
  } else if (t == 3) {
    int slot = int(g0.x + 0.5);
    vec4 m = slot < 4 ? texture(uBrush0, f) : texture(uBrush1, f);
    int ch = slot - (slot < 4 ? 0 : 4);
    w = ch == 0 ? m.r : ch == 1 ? m.g : ch == 2 ? m.b : m.a;
  } else if (t == 4) {
    float y = clamp(luma(p0), 0.0, 1.0);
    w = smoothstep(g0.x - g0.z, g0.x + 0.001, y) * (1.0 - smoothstep(g0.y - 0.001, g0.y + g0.z, y));
  } else if (t == 5) {
    vec3 hsv = rgb2hsv(clamp(p0, 0.0, 1.0));
    float dh = abs(hsv.x - g0.x);
    dh = min(dh, 1.0 - dh);
    w = (1.0 - smoothstep(g0.y * 0.55, g0.y, dh)) * smoothstep(0.06, 0.25, hsv.y) * smoothstep(0.02, 0.1, hsv.z);
  }
  if (g1.w > 0.5) w = 1.0 - w;
  return clamp(w, 0.0, 1.0) * uMG2[i].a;
}

void main() {
  vec2 gUv = (uTile.xy + vUv * uTile.zw) / uFull;
  vec3 lin = texture(uA, vUv).rgb * uWB;
  vec3 p = toPerc(lin);
  if (uRawBase > 0.5) {
    // RAW files arrive scene-linear and flat; give them a gentle base tone curve + color
    p = contrastCurve(p, 0.2);
    float yb = luma(p);
    p = max(yb + (p - yb) * 1.08, 0.0);
  }
  float y0 = luma(p);
  vec3 p0 = p; // reference color for masks (before any tonal edits)

  vec3 pTex = toPerc(texture(uTexB, gUv).rgb * uWB);
  float yTex = luma(pTex);
  float yClar = luma(toPerc(texture(uClarB, gUv).rgb * uWB));
  vec3 pLarge = toPerc(texture(uLargeB, gUv).rgb * uWB);
  float yLarge = luma(pLarge);

  // --- noise reduction -------------------------------------------------------------
  if (uDenoise > 0.0) {
    float yN = luma(toPerc(texture(uNoiseB, vUv).rgb * uWB));
    float d = y0 - yN;
    float t = 0.012 + uDenoise * 0.05;
    float w = uDenoise * exp(-(d * d) / (2.0 * t * t));
    p += (yN - y0) * w;
    y0 = luma(p);
  }
  if (uColorDenoise > 0.0) {
    vec3 chroma = mix(p - y0, pTex - yTex, uColorDenoise);
    p = y0 + chroma;
  }

  // --- detail signals (computed before tone so they don't drift with it) -----------
  float ySharp = luma(toPerc(texture(uSharpB, vUv).rgb * uWB));
  float dSharp = y0 - ySharp;
  float sharpM = 1.0;
  if (uSharpMask > 0.0) sharpM = mix(1.0, smoothstep(0.004, 0.05, abs(y0 - yTex)), uSharpMask);
  float dTex = ySharp - yTex;
  float dClar = y0 - yClar;
  // soft-limit big edges so local contrast doesn't draw halos around them
  dTex = dTex / (1.0 + abs(dTex) * 8.0);
  dClar = dClar / (1.0 + abs(dClar) * 5.0);

  // --- dehaze -----------------------------------------------------------------------
  if (uDehaze > 0.0) {
    float dark = min(pLarge.r, min(pLarge.g, pLarge.b));
    float t = max(1.0 - uDehaze * 0.85 * dark, 0.12);
    p = 1.0 - (1.0 - p) / t;
    p = max(p, 0.0);
    float y = luma(p);
    p = y + (p - y) * (1.0 + uDehaze * 0.25);
  } else if (uDehaze < 0.0) {
    float h = -uDehaze * 0.6;
    p = mix(p, vec3(max(0.75, yLarge)), h * 0.6);
  }

  // --- shadows / highlights (local, luminance preserving hue) -----------------------
  float y = max(luma(p), 1e-5);
  float yLoc = mix(y, yLarge, 0.55);
  if (uShadows != 0.0 || uHighlights != 0.0) {
    float mS = pow(1.0 - smoothstep(0.0, 0.55, yLoc), 2.0);
    float mH = pow(smoothstep(0.45, 1.0, yLoc), 1.5);
    float gain = exp2(uShadows * mS * 1.4) * exp2(uHighlights * mH * (uHighlights < 0.0 ? 0.8 : 0.5));
    // areas that were blown in the source have no detail to recover; keep them bright
    vec3 src = texture(uA, vUv).rgb;
    float blown = smoothstep(0.96, 1.0, min(src.r, min(src.g, src.b)));
    if (uHighlights < 0.0) gain = mix(gain, max(gain, 0.9), blown);
    p *= gain;
  }

  // --- whites / blacks --------------------------------------------------------------
  if (uWhites != 0.0) {
    float wg = 1.0 / (1.0 - uWhites * 0.3);
    p = mix(p, p * wg, smoothstep(0.25, 1.0, p));
  }
  if (uBlacks != 0.0) {
    float bp = -uBlacks * 0.08;
    p = mix((p - bp) / (1.0 - bp), p, smoothstep(0.0, 0.6, p));
    p = max(p, 0.0);
  }

  // --- brightness (midtone gamma) ---------------------------------------------------
  if (uBrightness != 0.0) {
    float g = exp2(-uBrightness * 0.75);
    p = mix(pow(clamp(p, 0.0, 1.0), vec3(g)), 1.0 + (p - 1.0) * g, step(1.0, p));
  }

  // --- contrast ---------------------------------------------------------------------
  if (uContrast != 0.0) {
    float k = uContrast * 0.85;
    float yl = max(luma(p), 1e-5);
    vec3 byLum = p * (contrastCurve(vec3(yl), k).r / yl);
    p = mix(byLum, contrastCurve(p, k), 0.5);
  }

  // --- texture / clarity / sharpening -----------------------------------------------
  float yNow = luma(p);
  float mid = 1.0 - pow(abs(clamp(yNow, 0.0, 1.0) * 2.0 - 1.0), 2.0);
  p += dTex * uTexture * 2.2;
  p += dClar * uClarity * 0.9 * (0.35 + 0.65 * mid);
  p += dSharp * uSharpen * 1.6 * sharpM;
  p = max(p, 0.0);

  // --- masks (local adjustments) ----------------------------------------------------
  float overlay = 0.0;
  if (uMaskCount > 0) {
    vec2 f = uCrop.xy + gUv * uCrop.zw;
    for (int i = 0; i < 8; i++) {
      if (i >= uMaskCount) break;
      float w = maskWeight(i, f, p0);
      if (i == uShowMask) overlay = w;
      if (w < 0.002) continue;
      vec4 a0 = uMA0[i], a1 = uMA1[i], a2 = uMA2[i];
      p *= mix(vec3(1.0), a1.rgb, w);
      if (a0.x != 0.0) p *= exp2(a0.x * w / 2.2);
      if (a0.y != 0.0) p = mix(p, contrastCurve(p, a0.y * 0.85), w);
      if (a0.z != 0.0 || a0.w != 0.0) {
        float yl = luma(p);
        float mS = pow(1.0 - smoothstep(0.0, 0.55, yl), 2.0);
        float mH = pow(smoothstep(0.45, 1.0, yl), 1.5);
        p *= exp2((a0.w * mS * 1.4 + a0.z * mH * (a0.z < 0.0 ? 0.8 : 0.5)) * w);
      }
      if (a2.y > 0.0) {
        float dark = min(pLarge.r, min(pLarge.g, pLarge.b));
        float t = max(1.0 - a2.y * 0.85 * dark, 0.12);
        p = mix(p, max(1.0 - (1.0 - p) / t, 0.0), w);
      } else if (a2.y < 0.0) {
        p = mix(p, vec3(max(0.75, yLarge)), -a2.y * 0.36 * w);
      }
      if (a2.x != 0.0) p += dClar * a2.x * 1.2 * w;
      if (a1.w != 0.0) {
        float yb = luma(p);
        p = yb + (p - yb) * max(0.0, 1.0 + a1.w * w);
      }
      p = max(p, 0.0);
    }
  }

  // --- curves -----------------------------------------------------------------------
  if (uUseLut > 0.5) {
    vec3 c = clamp(p, 0.0, 1.0);
    float off = 0.5 / 1024.0, sc = 1023.0 / 1024.0;
    vec3 over = max(p - 1.0, 0.0);
    p = vec3(texture(uLut, vec2(off + c.r * sc, 0.5)).r,
             texture(uLut, vec2(off + c.g * sc, 0.5)).g,
             texture(uLut, vec2(off + c.b * sc, 0.5)).b) + over;
  }

  // --- HSL --------------------------------------------------------------------------
  vec3 hsv = rgb2hsv(clamp(p, 0.0, 1.0));
  float w[8];
  bandWeights(hsv.x * 360.0, w);
  float dh = 0.0, ds = 0.0, dl = 0.0, mixBw = 0.0;
  for (int i = 0; i < 8; i++) {
    dh += w[i] * uHslH[i];
    ds += w[i] * uHslS[i];
    dl += w[i] * uHslL[i];
    mixBw += w[i] * uBwMix[i];
  }
  float chromaAmt = smoothstep(0.0, 0.35, hsv.y) * smoothstep(0.0, 0.08, hsv.z);
  if (dh != 0.0) {
    float yb = luma(p);
    vec3 shifted = hsv2rgb(vec3(fract(hsv.x + dh * 30.0 / 360.0), hsv.y, hsv.z));
    shifted *= yb / max(luma(shifted), 1e-5) * 0.5 + 0.5; // keep brightness roughly stable
    p = mix(p, shifted, chromaAmt);
  }
  {
    float yb = luma(p);
    p = yb + (p - yb) * max(0.0, 1.0 + ds);
    p *= 1.0 + dl * 0.55 * chromaAmt;
  }

  // --- vibrance / saturation --------------------------------------------------------
  {
    float yb = luma(p);
    float mx = max(p.r, max(p.g, p.b)), mn = min(p.r, min(p.g, p.b));
    float sat = clamp((mx - mn) / max(mx, 1e-4), 0.0, 1.0);
    // protect skin-ish hues (orange) a little when boosting vibrance
    float skin = w[1] * 0.5;
    float vib = uVibrance > 0.0 ? uVibrance * pow(1.0 - sat, 2.0) * (1.0 - skin) : uVibrance * (1.0 - sat * 0.5);
    p = yb + (p - yb) * max(0.0, (1.0 + vib) * (1.0 + uSaturation));
  }

  // --- color grading ----------------------------------------------------------------
  {
    float yb = clamp(luma(p), 0.0, 1.0);
    float piv = 0.5 - uCgBalance * 0.3;
    float x = yb < piv ? 0.5 * yb / piv : 0.5 + 0.5 * (yb - piv) / (1.0 - piv);
    float spread = mix(0.1, 0.45, uCgBlend);
    float wS = 1.0 - smoothstep(0.0, 0.5 + spread, x);
    float wH = smoothstep(0.5 - spread, 1.0, x);
    float wM = smoothstep(0.0, 1.0, 1.0 - abs(x - 0.5) * 2.0) * (0.6 + spread);
    p += uCgShadow * wS + uCgMid * wM + uCgHigh * wH + uCgGlobal;
    p += (uCgLum.x * wS + uCgLum.y * wM + uCgLum.z * wH + uCgLum.w) * 0.22;
    p = max(p, 0.0);
  }

  // --- black & white ----------------------------------------------------------------
  if (uBw > 0.0) {
    float yb = luma(p);
    float chroma = max(p.r, max(p.g, p.b)) - min(p.r, min(p.g, p.b));
    float g = max(0.0, yb + mixBw * chroma * 0.6);
    vec3 toned = vec3(g);
    if (uBwToneAmt > 0.0) {
      vec3 tc = uBwTone / max(luma(uBwTone), 1e-4);
      float m = uBwToneAmt * (0.4 + 0.6 * (1.0 - abs(clamp(g, 0.0, 1.0) * 2.0 - 1.0)));
      toned = g * mix(vec3(1.0), tc, m * 0.6);
    }
    p = mix(p, toned, uBw);
  }

  // --- diffusion (soft, glowing midtones like a mist filter) ------------------------
  if (uDiffuse > 0.0) {
    vec3 soft = toPerc(texture(uClarB, gUv).rgb * uWB);
    vec3 screen = 1.0 - (1.0 - clamp(p, 0.0, 1.0)) * (1.0 - clamp(soft, 0.0, 1.0));
    p = mix(p, mix(p, screen, 0.55), uDiffuse);
    p = mix(p, soft, uDiffuse * 0.18);
  }

  // --- fade -------------------------------------------------------------------------
  if (uFade > 0.0) {
    vec3 tint = vec3(1.0) + vec3(0.06, 0.0, -0.08) * uFadeWarm;
    float lift = uFade * 0.22;
    p = lift * tint + p * (1.0 - lift - uFade * 0.05);
  }

  if (uShowMask >= 0) p = mix(p, vec3(0.15, 0.9, 1.0), overlay * 0.55);
  outColor = vec4(min(toLin(p), vec3(16.0)), 1.0);
}`;

/** Final pass: lens fringe, halation, glow, vignette, grain, dithering, output encode. */
export const FINISH = COMMON + `
uniform sampler2D uB;     // develop output (padded tile)
uniform sampler2D uHal, uHal2;   // global halation blurs (core, wide)
uniform sampler2D uGlow, uGlow2; // global glow blurs (core, wide)
uniform sampler2D uBlur1, uBlur2; // global lens blurs (medium, large)
uniform int uBlurType;            // 0 off, 1 tilt-shift, 2 radial
uniform vec4 uBlurP;              // focus x, y, size, transition
uniform float uBlurAngle;
uniform vec4 uBRect;      // vUv -> B uv: offset.xy, scale.zw
uniform vec2 uBSize;      // B texture pixel size
uniform vec2 uFull;
uniform vec4 uTile;
uniform float uFlipY;
uniform float uCa;
uniform float uHalAmt;
uniform vec3 uHalColor;
uniform float uGlowAmt;
uniform vec3 uGlowColor;
uniform float uVig, uVigMid, uVigRound, uVigFeather, uVigHi;
uniform float uGrain, uGrainCell, uGrainRough, uGrainColor, uGrainSh, uGrainHi;
uniform float uSeed;
uniform float uClip;

vec2 gradDir(ivec2 c, uint seed) {
  float a = rnd(c, seed) * 6.2831853;
  return vec2(cos(a), sin(a));
}
float gnoise(vec2 p, uint seed) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(gradDir(i, seed), f);
  float b = dot(gradDir(i + ivec2(1, 0), seed), f - vec2(1.0, 0.0));
  float c = dot(gradDir(i + ivec2(0, 1), seed), f - vec2(0.0, 1.0));
  float d = dot(gradDir(i + ivec2(1, 1), seed), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
}
float grainField(vec2 q, uint seed) {
  float r = uGrainRough;
  float n = gnoise(q, seed) * (1.0 - r * 0.45);
  n += gnoise(q * 2.07 + 13.1, seed + 7u) * (0.25 + r * 0.55);
  n += gnoise(q * 4.31 + 41.7, seed + 19u) * (r * r * 0.6);
  // rougher grain gets a harder, clumpier distribution
  n = sign(n) * pow(abs(n), mix(1.0, 0.65, r));
  return n;
}

void main() {
  vec2 uv = vUv;
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
  vec2 px = uTile.xy + uv * uTile.zw;
  vec2 gUv = px / uFull;
  vec2 bUv = uBRect.xy + uv * uBRect.zw;
  float shortEdge = min(uFull.x, uFull.y);

  vec3 c;
  if (uCa > 0.0) {
    vec2 d = (gUv - 0.5) * uFull / shortEdge; // aspect-correct
    vec2 shiftPx = d * uCa * 0.006 * shortEdge;
    vec2 sh = shiftPx / uBSize;
    c = vec3(texture(uB, bUv + sh).r, texture(uB, bUv).g, texture(uB, bUv - sh).b);
  } else {
    c = texture(uB, bUv).rgb;
  }

  if (uBlurType > 0) {
    float aspect = uFull.x / uFull.y;
    vec2 v = (gUv - uBlurP.xy) * vec2(aspect, 1.0);
    float dist = uBlurType == 1 ? abs(dot(v, vec2(-sin(uBlurAngle), cos(uBlurAngle)))) : length(v);
    float w = smoothstep(uBlurP.z, uBlurP.z + uBlurP.w, dist);
    if (w > 0.0) {
      c = mix(c, texture(uBlur1, gUv).rgb, smoothstep(0.0, 0.55, w));
      c = mix(c, texture(uBlur2, gUv).rgb, smoothstep(0.45, 1.0, w));
    }
  }

  if (uHalAmt > 0.0) {
    float hl = luma(texture(uHal, gUv).rgb) * 0.55 + luma(texture(uHal2, gUv).rgb) * 0.6;
    // halation glows into the darker surroundings, so weaken it on top of the source highlight
    float base = luma(c);
    c += uHalColor * hl * uHalAmt * (1.0 - 0.6 * smoothstep(0.5, 1.5, base));
  }
  if (uGlowAmt > 0.0) {
    vec3 g = (texture(uGlow, gUv).rgb * 0.5 + texture(uGlow2, gUv).rgb * 0.6) * uGlowColor * uGlowAmt;
    c = c + g * (1.0 - clamp(c, 0.0, 1.0) * 0.6);
  }

  vec3 p = toPerc(c);

  if (uVig != 0.0) {
    vec2 d = (gUv - 0.5) * 2.0;
    float aspect = uFull.x / uFull.y;
    float rt = clamp(uVigRound, 0.0, 1.0);
    d *= mix(vec2(1.0), vec2(aspect, 1.0) / max(aspect, 1.0), rt);
    float n = 2.0 + max(0.0, -uVigRound) * 6.0;
    float r = pow(pow(abs(d.x), n) + pow(abs(d.y), n), 1.0 / n);
    float start = 0.25 + uVigMid * 0.9;
    float m = smoothstep(start, start + 0.08 + uVigFeather * 1.3, r);
    if (uVig < 0.0) {
      m *= 1.0 - uVigHi * smoothstep(0.55, 1.0, luma(p));
      p *= 1.0 + uVig * m;
    } else {
      p = p + (1.0 - p) * uVig * m * 0.9;
    }
  }

  if (uGrain > 0.0) {
    // grain is defined on a virtual 1500px-short-edge grid so it looks the same in the
    // preview and in a full-resolution export
    vec2 q = px * (1500.0 / shortEdge) / uGrainCell;
    uint seed = uint(uSeed);
    float mono = grainField(q, seed);
    vec3 n = vec3(mono);
    if (uGrainColor > 0.0) {
      vec3 col = vec3(grainField(q + 101.3, seed + 31u), grainField(q + 57.9, seed + 53u), grainField(q + 211.7, seed + 97u));
      n = mix(n, col, uGrainColor);
    }
    float y = clamp(luma(p), 0.0, 1.0);
    float resp = mix(uGrainSh, uGrainHi, smoothstep(0.15, 0.85, y));
    float env = 0.35 + 0.65 * (4.0 * y * (1.0 - y));
    float amp = uGrain * 0.2 * resp * env;
    p += n * amp;
    p = max(p, 0.0);
  }

  vec3 outc = linToSrgb(toLin(p));
  if (uClip > 0.5) {
    if (min(outc.r, min(outc.g, outc.b)) >= 0.99) outc = vec3(1.0, 0.54, 0.24);
    else if (max(outc.r, max(outc.g, outc.b)) <= 0.004) outc = vec3(0.24, 0.9, 1.0);
  }
  float dither = (rnd(ivec2(px), 777u) + rnd(ivec2(px) + 31, 999u) - 1.0) / 255.0;
  outColor = vec4(outc + dither, 1.0);
}`;
