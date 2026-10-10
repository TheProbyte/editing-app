import './styles.css';
import { App } from './ui/app';

// The RAW decoder needs a cross-origin isolated page. Static hosts (e.g. GitHub Pages)
// can't send the required headers, so the service worker adds them; the first visit
// reloads once after the worker takes control.
async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || window.top !== window) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    if (!self.crossOriginIsolated) {
      const reloaded = sessionStorage.getItem('lumen.coi-reload');
      if (!reloaded) {
        sessionStorage.setItem('lumen.coi-reload', '1');
        if (!navigator.serviceWorker.controller) {
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
            reg.active?.postMessage('claim');
            await new Promise((r) => {
              navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
              setTimeout(r, 3000);
            });
          }
        }
        location.reload();
      }
    } else {
      sessionStorage.removeItem('lumen.coi-reload');
    }
  } catch (e) {
    console.warn('Service worker registration failed', e);
  }
}

ensureServiceWorker();
(window as unknown as { lumen: App }).lumen = new App();
