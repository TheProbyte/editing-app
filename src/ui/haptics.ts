// Haptic ticks. Android has navigator.vibrate; iOS Safari (18+) gives a system haptic
// when a native switch control toggles, so we keep a hidden one and click it.

import { isNative, Native } from '../native';

let label: HTMLLabelElement | null = null;
let last = 0;

function iosSwitch() {
  if (!label) {
    label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
  }
  label.click();
}

/** A light tick. Rate-limited so fast drags don't turn into a buzz. */
export function tick(strong = false) {
  const now = performance.now();
  if (now - last < (strong ? 20 : 34)) return;
  last = now;
  if (isNative) {
    // Pixel's own segment ticks via the native view
    Native.tick({ strong }).catch(() => {});
    return;
  }
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(strong ? 12 : 5);
    else iosSwitch();
  } catch {
    /* no haptics available */
  }
}
