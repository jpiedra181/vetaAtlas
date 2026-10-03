let el: HTMLElement | null = null;
let timer = 0;

/** Polite screen-reader announcement (debounced so rapid changes coalesce). */
export function announce(msg: string, delay = 120) {
  el ??= document.getElementById('live');
  if (!el) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    el!.textContent = '';
    requestAnimationFrame(() => (el!.textContent = msg));
  }, delay);
}

let toastEl: HTMLElement | null = null;
let toastTimer = 0;

/** Small visual confirmation; also announced. */
export function toast(msg: string) {
  toastEl ??= document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl!.dataset.show = 'false'), 2600);
  announce(msg, 0);
}
