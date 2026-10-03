/**
 * One requestAnimationFrame loop for the whole app. Systems register tickers
 * that return `true` while they still need frames; when every ticker is idle
 * the loop stops completely (render-on-demand → zero GPU work at rest).
 */
type Ticker = (dt: number, now: number) => boolean | void;

const tickers: Ticker[] = [];
const renderers: Array<(now: number) => void> = [];
let raf = 0;
let last = 0;
let paused = false;

export const now = () => performance.now() / 1000;

export function addTicker(fn: Ticker) {
  tickers.push(fn);
  wake();
  return () => {
    const i = tickers.indexOf(fn);
    if (i >= 0) tickers.splice(i, 1);
  };
}

export function onRender(fn: (now: number) => void) {
  renderers.push(fn);
}

export function wake() {
  if (!raf && !paused) raf = requestAnimationFrame(loop);
}

function loop(ms: number) {
  raf = 0;
  const t = ms / 1000;
  const dt = last && t - last < 0.1 ? t - last : 1 / 60;
  last = t;
  let active = false;
  const list = tickers.slice();
  for (let i = 0; i < list.length; i++) if (list[i](dt, t)) active = true;
  for (const r of renderers) r(t);
  if (active) wake();
  else last = 0;
}

document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
  if (!paused) {
    last = 0;
    wake();
  }
});

/* ---------- easing ---------- */

export const ease = {
  linear: (x: number) => x,
  outCubic: (x: number) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outExpo: (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inOutQuart: (x: number) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  outQuart: (x: number) => 1 - Math.pow(1 - x, 4),
};

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential smoothing. */
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export interface Tween { cancel(): void; done: Promise<void> }

export function tween(opts: {
  duration: number;
  ease?: (x: number) => number;
  delay?: number;
  update: (v: number) => void;
}): Tween {
  const e = opts.ease ?? ease.outCubic;
  let start = -1;
  let cancelled = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const dur = Math.max(0.0001, opts.duration);
  const remove = addTicker((_dt, t) => {
    if (cancelled) return false;
    if (start < 0) start = t + (opts.delay ?? 0);
    const x = clamp((t - start) / dur, 0, 1);
    if (t >= start) opts.update(e(x));
    if (x >= 1) {
      queueMicrotask(() => remove());
      resolve();
      return false;
    }
    return true;
  });
  return {
    cancel() {
      cancelled = true;
      remove();
      resolve();
    },
    done,
  };
}
