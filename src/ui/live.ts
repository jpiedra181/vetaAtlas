let pageLive: HTMLElement | null = null;
let timer = 0;

// With a modal <dialog> open, everything outside it is inert, and screen readers
// ignore live regions there: #live would stay silent while the filters or a sheet
// are open. So the message goes to a live region inside the open dialog.
function ensureRegion(dialog: HTMLDialogElement): { region: HTMLElement; fresh: boolean } {
  const found = dialog.querySelector<HTMLElement>(':scope > [data-live]');
  if (found) return { region: found, fresh: false };
  const region = document.createElement('div');
  region.className = 'sr-only';
  region.dataset.live = '';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  dialog.append(region);
  return { region, fresh: true };
}

// A live region created at the same moment as its first message is often missed, and
// dialogs re-render their content when they open: the region is added on every open.
new MutationObserver((records) => {
  for (const r of records) {
    const dialog = r.target as HTMLDialogElement;
    if (dialog.open) requestAnimationFrame(() => ensureRegion(dialog));
  }
}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });

function liveRegion(): { region: HTMLElement | null; fresh: boolean } {
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((d) => d.matches(':modal')).pop();
  if (!dialog) return { region: (pageLive ??= document.getElementById('live')), fresh: false };
  return ensureRegion(dialog);
}

const FRESH_REGION_DELAY_MS = 300;

/** Polite screen-reader announcement (debounced so rapid changes coalesce). */
export function announce(msg: string, delay = 120) {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const { region, fresh } = liveRegion();
    if (!region) return;
    region.textContent = '';
    const write = () => requestAnimationFrame(() => (region.textContent = msg));
    if (fresh) window.setTimeout(write, FRESH_REGION_DELAY_MS);
    else write();
  }, delay);
}

let toastEl: HTMLElement | null = null;
let toastTimer = 0;

/** Small visual confirmation; announced through announce() (the toast itself is aria-hidden). */
export function toast(msg: string) {
  toastEl ??= document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl!.dataset.show = 'false'), 2600);
  announce(msg, 0);
}
