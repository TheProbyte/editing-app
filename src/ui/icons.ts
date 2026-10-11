// Lumen's own icon set: simple geometric glyphs on a 24px grid, mostly solid shapes
// with a few 2px round-capped lines, so they read cleanly at small sizes.

const I = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const L = (d: string, w = 2) => `<path d="${d}" fill="none" stroke-width="${w}"/>`;

export const ICONS = {
  // --- chrome
  open: I('<path fill-rule="evenodd" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v9.2l4.3-4.3a1 1 0 0 1 1.4 0L14 14.2l1.3-1.3a1 1 0 0 1 1.4 0L19 15.2V6z"/><circle cx="15.5" cy="9" r="1.8"/>'),
  undo: I(L('M9 6L4 11l5 5') + L('M4.5 11H14a5.5 5.5 0 0 1 0 11h-2', 2)),
  redo: I(L('M15 6l5 5-5 5') + L('M19.5 11H10a5.5 5.5 0 0 0 0 11h2', 2)),
  compare: I('<path fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2v14a7 7 0 0 0 0-14z"/>'),
  hist: I('<rect x="3" y="12" width="4" height="9" rx="1.2"/><rect x="10" y="5" width="4" height="16" rx="1.2"/><rect x="17" y="9" width="4" height="12" rx="1.2"/>'),
  more: I('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>'),
  check: I(L('M5 12.5l4.5 4.5L19 7.5', 2.6)),
  reset: I(L('M5 12a7 7 0 1 0 2.1-5', 2.2) + '<path d="M3.5 4.2l4.6.6-.8 4.6z"/>'),
  close: I(L('M6 6l12 12M18 6L6 18', 2.2)),
  plus: I(L('M12 5v14M5 12h14', 2.4)),
  eye: I('<path fill-rule="evenodd" d="M12 5c5.5 0 9 5.6 9.6 6.6a.8.8 0 0 1 0 .8C21 13.4 17.5 19 12 19S3 13.4 2.4 12.4a.8.8 0 0 1 0-.8C3 10.6 6.5 5 12 5zm0 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>'),
  invert: I('<path fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 0 0 0 14z"/><circle cx="16" cy="12" r="2.2"/>'),
  duplicate: I('<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M5.5 3H14a2.5 2.5 0 0 1 2.5 2.5V6H8a2 2 0 0 0-2 2v8.5h-.5A2.5 2.5 0 0 1 3 14V5.5A2.5 2.5 0 0 1 5.5 3z" opacity=".5"/>'),
  trash: I('<path d="M9 3h6l1 2h4v2H4V5h4z"/><path d="M5.5 8.5h13l-1 11a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5z"/>'),
  save: I('<path fill-rule="evenodd" d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm2 2v5h9V5zm5 9a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>'),
  rotate: I('<rect x="4" y="9" width="11" height="11" rx="2"/>' + L('M10 4.5h4.5A4.5 4.5 0 0 1 19 9v3', 2) + '<path d="M16.2 11.2h5.6L19 15z"/>'),
  flipH: I('<path d="M10 4v16L3 17V7z"/><path d="M14 4l7 3v10l-7 3z" opacity=".45"/>'),
  flipV: I('<path d="M4 10h16l-3-7H7z"/><path d="M4 14h16l-3 7H7z" opacity=".45"/>'),

  // --- tools
  looks: I('<rect x="3" y="3" width="8" height="8" rx="2.5"/><rect x="13" y="3" width="8" height="8" rx="4"/><rect x="3" y="13" width="8" height="8" rx="4"/><rect x="13" y="13" width="8" height="8" rx="2.5" opacity=".5"/>'),
  light: I('<circle cx="12" cy="12" r="4.6"/>' + L('M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6', 2)),
  color: I('<path d="M12 2.5c3.6 4.4 6.6 7.9 6.6 11.6a6.6 6.6 0 0 1-13.2 0c0-3.7 3-7.2 6.6-11.6z"/>'),
  masks: I('<circle cx="10" cy="10" r="6.5" fill="none" stroke-width="2" stroke-dasharray="2.6 2.6"/><circle cx="16.5" cy="16.5" r="5"/>'),
  detail: I('<path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>'),
  curves: I(L('M3.5 20C10 20 9.5 4 20.5 4', 2.2) + '<circle cx="8" cy="15.6" r="2.2"/><circle cx="15.6" cy="6.4" r="2.2"/>'),
  hsl: I('<path d="M12 3a9 9 0 0 1 7.8 4.5L12 12z"/><path d="M20.4 9.3A9 9 0 0 1 13 20.9L12 12z" opacity=".7"/><path d="M10.9 20.9A9 9 0 0 1 4 8L12 12z" opacity=".4"/>'),
  grade: I('<circle cx="8.5" cy="9" r="5.5" opacity=".55"/><circle cx="15.5" cy="9" r="5.5" opacity=".55"/><circle cx="12" cy="15.5" r="5.5" opacity=".55"/>'),
  bw: I('<path fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2v14a7 7 0 0 0 0-14z"/>'),
  grain: I('<circle cx="5" cy="5" r="1.6"/><circle cx="12" cy="4.5" r="1.1"/><circle cx="19" cy="6" r="1.8"/><circle cx="7.5" cy="11" r="2"/><circle cx="14" cy="11.5" r="1.3"/><circle cx="20" cy="13" r="1"/><circle cx="4.5" cy="18" r="1.2"/><circle cx="11" cy="18.5" r="1.8"/><circle cx="18" cy="19" r="1.4"/>'),
  halation: I('<circle cx="12" cy="12" r="3.6"/><circle cx="12" cy="12" r="6.6" fill="none" stroke-width="1.8" opacity=".6"/><circle cx="12" cy="12" r="9.6" fill="none" stroke-width="1.6" opacity=".3"/>'),
  glow: I('<path d="M11 2.5l1.9 6.6 6.6 1.9-6.6 1.9L11 19.5l-1.9-6.6-6.6-1.9 6.6-1.9z"/><path d="M19 15l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" opacity=".6"/>'),
  blur: I('<circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="4" r="1.3" opacity=".5"/><circle cx="12" cy="20" r="1.3" opacity=".5"/><circle cx="4" cy="12" r="1.3" opacity=".5"/><circle cx="20" cy="12" r="1.3" opacity=".5"/><circle cx="6.3" cy="6.3" r="1.1" opacity=".35"/><circle cx="17.7" cy="17.7" r="1.1" opacity=".35"/><circle cx="17.7" cy="6.3" r="1.1" opacity=".35"/><circle cx="6.3" cy="17.7" r="1.1" opacity=".35"/>'),
  vignette: I('<path fill-rule="evenodd" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm7 3.5c-3.3 0-5.5 2-5.5 4.5s2.2 4.5 5.5 4.5 5.5-2 5.5-4.5-2.2-4.5-5.5-4.5z"/>'),
  film: I('<path fill-rule="evenodd" d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm1 2v2h2V5zm0 4v2h2V9zm0 4v2h2v-2zm0 4v2h2v-2zM16 5v2h2V5zm0 4v2h2V9zm0 4v2h2v-2zm0 4v2h2v-2zM9.5 6v12h5V6z"/>'),
  crop: I('<path d="M5 2h2.4v14.6H22V19H5z"/><path d="M8.6 5H19v10.4h-2.4V7.4H8.6z" opacity=".55"/>'),

  // --- masks
  mRadial: I('<ellipse cx="12" cy="12" rx="9" ry="7" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="2.6"/>'),
  mLinear: I('<rect x="3" y="4" width="18" height="3.2" rx="1.6"/><rect x="3" y="10.4" width="18" height="3.2" rx="1.6" opacity=".55"/><rect x="3" y="16.8" width="18" height="3.2" rx="1.6" opacity=".22"/>'),
  mBrush: I('<path d="M20.5 3.5a1.5 1.5 0 0 1 0 2.1l-8 8-2.1-2.1 8-8a1.5 1.5 0 0 1 2.1 0z"/><path d="M9.3 12.6l2.1 2.1c0 3.1-2.5 5.8-7.9 5.8 1.6-1.3 1.2-3.2 2.1-5 .8-1.6 2.3-2.6 3.7-2.9z"/>'),
  mPoint: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke-width="2"/><circle cx="12" cy="12" r="3.4"/>'),
  mLuma: I('<path fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 0 0 0 14z"/><rect x="13" y="7" width="2" height="2" rx=".5" opacity=".5"/><rect x="15.5" y="11" width="2" height="2" rx=".5" opacity=".5"/><rect x="13" y="15" width="2" height="2" rx=".5" opacity=".5"/>'),
  mColor: I('<circle cx="12" cy="8.5" r="5.2"/><circle cx="8" cy="15" r="5.2" opacity=".6"/><circle cx="16" cy="15" r="5.2" opacity=".35"/>'),
  paint: I('<path d="M20.5 3.5a1.5 1.5 0 0 1 0 2.1l-8 8-2.1-2.1 8-8a1.5 1.5 0 0 1 2.1 0z"/><path d="M9.3 12.6l2.1 2.1c0 3.1-2.5 5.8-7.9 5.8 1.6-1.3 1.2-3.2 2.1-5 .8-1.6 2.3-2.6 3.7-2.9z"/>'),
  erase: I('<path d="M14.6 3.8a2 2 0 0 1 2.8 0l3.8 3.8a2 2 0 0 1 0 2.8L12 19.6H7.5L3.8 16a2 2 0 0 1 0-2.8z"/><rect x="11" y="18.5" width="10" height="2" rx="1"/><path d="M4.8 14.4l5.6-5.6 4.8 4.8-5.6 5.6" fill="#000" opacity=".35"/>'),
  pick: I('<path d="M17.8 2.9a2.6 2.6 0 0 1 3.7 3.7l-2.6 2.6 1 1-1.8 1.8-1-1-7.3 7.3a2.5 2.5 0 0 1-1.3.7l-3 .6.6-3a2.5 2.5 0 0 1 .7-1.3l7.3-7.3-1-1L14.9 5l1 1z"/>'),
  swipe: I(L('M4 12h16', 2.2) + '<path d="M3 12l4-3.6v7.2zM21 12l-4-3.6v7.2z"/>'),
  off: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke-width="2"/>' + L('M6 18L18 6', 2)),
  tilt: I('<rect x="3" y="3" width="18" height="3" rx="1.5" opacity=".3"/><rect x="3" y="8" width="18" height="2" rx="1" opacity=".55"/><rect x="3" y="11" width="18" height="2" rx="1"/><rect x="3" y="14" width="18" height="2" rx="1" opacity=".55"/><rect x="3" y="18" width="18" height="3" rx="1.5" opacity=".3"/>'),
  radialBlur: I('<circle cx="12" cy="12" r="9.5" opacity=".2"/><circle cx="12" cy="12" r="6.5" opacity=".35"/><circle cx="12" cy="12" r="3.5"/>'),
};

export type IconName = keyof typeof ICONS;
