import { Renderer, type GridParams, type HeroParams, type LightParams } from '../gl/renderer';
import { materials, makeLayout, loc, type Layout, type Material } from '../data/materials';
import { addTicker, onRender, wake, damp, clamp, lerp, ease, now } from '../lib/anim';
import { reducedMotion, isSelected } from '../state';
import { t, type Key } from '../i18n';
import { h, finePointer } from '../lib/dom';

export interface Rect { x: number; y: number; w: number; h: number }
type Cell = [number, number];

export interface HeroController {
  /** Params for this frame, or null once the hero is gone. */
  frame(dt: number, time: number): HeroParams | null;
  busy(): boolean;
}

const ZMIN = 0.45;
const ZMAX = 2.2;
const GAP = 0.042;
const NONE: Cell = [-1e8, -1e8];
const srgb = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const ACCENT: [number, number, number] = [srgb(0xe0 / 255), srgb(0x7a / 255), srgb(0x4f / 255)];

const imod = (a: number, n: number) => ((a % n) + n) % n;
const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1];

export class Atlas {
  onOpen: (m: Material, rect: Rect, cell: Cell) => void = () => {};
  onCamera: () => void = () => {};
  onHover: (m: Material | null) => void = () => {};

  cx = 0;
  cy = 0;
  zoom = 1;
  private targetZoom = 1;
  private anchor: [number, number] = [0, 0];
  private vx = 0;
  private vy = 0;
  private wheel: [number, number] = [0, 0];
  private fly: null | { x0: number; y0: number; x1: number; y1: number; z0: number; z1: number; t0: number; dur: number; dip: number } = null;
  private base = 240;
  vw = 1;
  vh = 1;
  layout: Layout = { order: [], W: 1, H: 1 };
  list: Material[] = [];

  private pointers = new Map<number, { x: number; y: number }>();
  private drag: null | { x: number; y: number; cx: number; cy: number; moved: boolean; type: string } = null;
  private pinch: null | { dist: number; zoom: number; wx: number; wy: number } = null;
  private samples: Array<{ t: number; x: number; y: number }> = [];

  private hovered: Cell = NONE;
  private hover = 0;
  private hoverSince = 0;
  private light = { x: 0, y: 0, tx: 0, ty: 0, k: 0, tk: 0.85, script: 0 };
  private bend = 0;
  private lift = 0;
  private speed = 0;
  private lastCam = [0, 0, 1];
  private rippleStart = -100;
  private rippleOrigin: Cell = [0, 0];
  private rippleLen = 0;
  private pulseCell: Cell = NONE;
  private pulseStart = -100;

  hero: HeroController | null = null;
  heroCell: Cell = NONE;
  heroHide = 0;
  dim = 0;
  dimTarget = 0;
  dimOrigin: [number, number] = [0, 0];
  showGrid = true;
  interactive = true;
  private dirty = true;
  private ratio = 1;
  private slowFrames = 0;

  private grid!: HTMLElement;
  private cells: HTMLElement[] = [];
  private focusCell: Cell | null = null;
  private activeCellEl: HTMLElement | null = null;
  private caption: HTMLElement;
  private captionCell: Cell = NONE;
  /** Cell whose hover caption was dismissed with Escape (WCAG 1.4.13); cleared on the next cell. */
  private captionDismissed: Cell = NONE;
  private labels: HTMLElement[] = [];
  private labelLayer: HTMLElement;

  constructor(readonly renderer: Renderer, readonly canvas: HTMLCanvasElement, root: HTMLElement) {
    this.grid = root.querySelector('#atlas-grid')!;
    this.caption = root.querySelector('#caption')!;
    this.labelLayer = root.querySelector('#labels')!;
    this.resize();
    addEventListener('resize', () => this.resize());
    this.bindPointer();
    this.bindKeys();
    renderer.bank.wake = () => wake();
    renderer.bank.onLoaded = (layer, kind) => {
      renderer.setLoadedAt(layer, kind, now());
      this.invalidate(0.7);
    };
    addTicker((dt, time) => this.tick(dt, time));
    onRender((time) => this.render(time));
    reducedMotion.sub(() => this.invalidate());
  }

  /* ---------------- sizing ---------------- */

  resize() {
    this.vw = innerWidth;
    this.vh = innerHeight;
    this.base = clamp(Math.min(this.vw, this.vh * 1.3) / 4.4, 120, 300);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.ratio = Math.min(this.ratio === 1 ? dpr : this.ratio, dpr);
    if (this.ratio < 1) this.ratio = 1;
    this.renderer.resize(this.vw, this.vh, Math.max(this.ratio, Math.min(dpr, 1)));
    if (!this.light.script && this.light.x === 0) {
      this.light.x = this.light.tx = this.vw * 0.62;
      this.light.y = this.light.ty = this.vh * 0.38;
    }
    this.invalidate();
  }

  get S() {
    return this.base * this.zoom;
  }

  invalidate(forSeconds = 0) {
    this.dirty = true;
    if (forSeconds > 0) this.keepAliveUntil = Math.max(this.keepAliveUntil, now() + forSeconds);
    wake();
  }
  private keepAliveUntil = 0;

  /* ---------------- layout ---------------- */

  setList(list: Material[], animate: boolean) {
    const first = this.list.length === 0;
    this.list = list;
    this.layout = makeLayout(list);
    this.renderer.setOrder(this.layout.order, this.layout.W, !first);
    if (first) {
      this.cx = Math.floor(this.layout.W / 2) + 0.5;
      this.cy = Math.floor(this.layout.H / 2) + 0.5;
      this.lastCam = [this.cx, this.cy, this.zoom];
    }
    this.rippleOrigin = [Math.floor(this.cx), Math.floor(this.cy)];
    const reach = Math.hypot(this.vw, this.vh) / this.S / 2 + 3;
    this.rippleLen = reach * 0.05 + 0.6;
    this.rippleStart = animate && !reducedMotion.get() ? now() : -100;
    if (first && !animate) this.rippleStart = -100;
    this.buildA11yGrid();
    this.syncRoving();
    this.invalidate(this.rippleLen + 0.1);
  }

  /** Cells flip in from the centre while the light sweeps across. */
  intro() {
    this.renderer.prev = { W: 1, N: 0 };
    this.rippleOrigin = [Math.floor(this.cx), Math.floor(this.cy)];
    const reach = Math.hypot(this.vw, this.vh) / this.S / 2 + 3;
    this.rippleLen = reach * 0.05 + 0.6;
    if (reducedMotion.get()) {
      this.rippleStart = -100;
      this.light.k = 0.85;
    } else {
      this.rippleStart = now();
      this.scriptLight(2.6);
    }
    this.invalidate(this.rippleLen + 0.2);
  }

  /** Material indices ordered by distance from the screen centre (texture priority). */
  visiblePriority(): number[] {
    const S = this.S;
    const ci = Math.floor(this.cx);
    const cj = Math.floor(this.cy);
    const ri = Math.ceil(this.vw / S / 2) + 1;
    const rj = Math.ceil(this.vh / S / 2) + 1;
    const cells: Array<[number, number, number]> = [];
    for (let j = cj - rj; j <= cj + rj; j++)
      for (let i = ci - ri; i <= ci + ri; i++) cells.push([i, j, Math.hypot((i - ci) / ri, (j - cj) / rj)]);
    cells.sort((a, b) => a[2] - b[2]);
    const seen = new Set<number>();
    for (const [i, j] of cells) seen.add(this.materialAt([i, j]).index);
    this.visibleCount = seen.size;
    for (const m of materials) seen.add(m.index);
    return [...seen];
  }
  visibleCount = 0;

  /** Material shown at a world cell. */
  materialAt(c: Cell): Material {
    const { order, W } = this.layout;
    return materials[order[imod(c[0] + c[1] * W, order.length)]];
  }

  /** World cell nearest to the camera that shows the given material. */
  nearestCell(m: Material, from: Cell = [Math.floor(this.cx), Math.floor(this.cy)]): Cell | null {
    const { order, W } = this.layout;
    const N = order.length;
    const p = order.indexOf(m.index);
    if (p < 0) return null;
    const R = Math.ceil(N / W) + 2;
    let best: Cell | null = null;
    let bestD = Infinity;
    const aspect = this.vw / this.vh;
    for (let dj = -R; dj <= R; dj++) {
      const j = from[1] + dj;
      const base = imod(p - j * W, N);
      const k = Math.round((from[0] - base) / N);
      for (const kk of [k - 1, k, k + 1]) {
        const i = base + kk * N;
        const d = Math.pow((i - from[0]) / aspect, 2) + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = [i, j];
        }
      }
    }
    return best;
  }

  /* ---------------- geometry ---------------- */

  private bendPoint(x: number, y: number): [number, number] {
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    const diag = 0.5 * Math.hypot(this.vw, this.vh);
    const dx = (x - cx) / diag;
    const dy = (y - cy) / diag;
    const f = (1 - this.bend * (dx * dx + dy * dy)) * (1 - this.lift);
    return [cx + (x - cx) * f, cy + (y - cy) * f];
  }

  /** Screen rect (css px) of the image area of a world cell. */
  cellRect(c: Cell): Rect {
    const S = this.S;
    const inset = S * GAP * 0.5;
    const x = (c[0] - this.cx) * S + this.vw / 2 + inset;
    const y = (c[1] - this.cy) * S + this.vh / 2 + inset;
    const size = S - inset * 2;
    const [ax, ay] = this.bendPoint(x, y);
    const [bx, by] = this.bendPoint(x + size, y + size);
    return { x: ax, y: ay, w: bx - ax, h: by - ay };
  }

  pick(sx: number, sy: number): Cell | null {
    const S = this.S;
    const wx = this.cx + (sx - this.vw / 2) / S;
    const wy = this.cy + (sy - this.vh / 2) / S;
    const i = Math.floor(wx);
    const j = Math.floor(wy);
    const g = GAP * 0.5;
    const fx = wx - i;
    const fy = wy - j;
    if (fx < g || fx > 1 - g || fy < g || fy > 1 - g) return null;
    return [i, j];
  }

  /* ---------------- camera moves ---------------- */

  flyTo(c: Cell, opts: { zoom?: number; instant?: boolean; offset?: [number, number] } = {}) {
    const x1 = c[0] + 0.5 + (opts.offset?.[0] ?? 0);
    const y1 = c[1] + 0.5 + (opts.offset?.[1] ?? 0);
    const z1 = opts.zoom ?? this.zoom;
    this.vx = this.vy = 0;
    this.wheel = [0, 0];
    if (opts.instant || reducedMotion.get()) {
      this.fly = null;
      this.cx = x1;
      this.cy = y1;
      this.zoom = this.targetZoom = z1;
      // a jump is not a movement: no speed, no lens bend
      this.lastCam = [x1, y1, z1];
      this.speed = this.bend = this.lift = 0;
      this.onCamera();
      this.invalidate();
      return;
    }
    const dist = Math.hypot(x1 - this.cx, y1 - this.cy);
    this.fly = {
      x0: this.cx, y0: this.cy, x1, y1, z0: this.zoom, z1,
      t0: now(), dur: clamp(0.55 + dist * 0.06, 0.55, 1.5), dip: clamp((dist - 3) * 0.05, 0, 0.35),
    };
    this.invalidate();
  }

  zoomBy(f: number, ax = this.vw / 2, ay = this.vh / 2) {
    this.fly = null;
    this.targetZoom = clamp(this.targetZoom * f, ZMIN, ZMAX);
    this.anchor = [ax, ay];
    if (reducedMotion.get()) this.applyZoom(this.targetZoom);
    this.invalidate();
  }

  resetView() {
    const c: Cell = [Math.floor(this.layout.W / 2), Math.floor(this.layout.H / 2)];
    this.flyTo(c, { zoom: 1 });
  }

  private applyZoom(z: number) {
    const [ax, ay] = this.anchor;
    const S0 = this.S;
    const wx = this.cx + (ax - this.vw / 2) / S0;
    const wy = this.cy + (ay - this.vh / 2) / S0;
    this.zoom = z;
    const S1 = this.S;
    this.cx = wx - (ax - this.vw / 2) / S1;
    this.cy = wy - (ay - this.vh / 2) / S1;
  }

  pulse(c: Cell) {
    this.pulseCell = c;
    this.pulseStart = now();
    this.invalidate(1.5);
  }

  /** Light used by the hero viewer too. */
  setLightTarget(x: number, y: number, k = 1) {
    this.light.script = 0;
    this.light.tx = x;
    this.light.ty = y;
    this.light.tk = k;
    wake();
  }

  scriptLight(seconds: number) {
    this.light.script = now() + seconds;
    this.light.k = 0;
    this.light.tk = 1;
    wake();
  }

  /* ---------------- input ---------------- */

  private bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.interactive) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.fly = null;
      this.vx = this.vy = 0;
      this.wheel = [0, 0];
      if (this.pointers.size === 1) {
        this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false, type: e.pointerType };
        this.samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      } else if (this.pointers.size === 2) {
        this.startPinch();
      }
      if (e.pointerType !== 'mouse') this.setLightTarget(e.clientX, e.clientY);
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        this.zoom = this.targetZoom = clamp((this.pinch.zoom * dist) / this.pinch.dist, ZMIN, ZMAX);
        this.cx = this.pinch.wx - (mx - this.vw / 2) / this.S;
        this.cy = this.pinch.wy - (my - this.vh / 2) / this.S;
        this.invalidate();
        return;
      }
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > (d.type === 'mouse' ? 4 : 9)) {
        d.moved = true;
        document.body.classList.add('is-dragging');
        this.hovered = NONE;
        this.onHover(null);
      }
      if (d.moved) {
        this.cx = d.cx - dx / this.S;
        this.cy = d.cy - dy / this.S;
        const t = performance.now();
        this.samples.push({ t, x: e.clientX, y: e.clientY });
        while (this.samples.length > 2 && t - this.samples[0].t > 90) this.samples.shift();
        this.invalidate();
      }
      if (e.pointerType !== 'mouse') this.setLightTarget(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const d = this.drag;
      if (this.pointers.size === 1) {
        // pinch → pan with the remaining finger
        const [p] = [...this.pointers.values()];
        this.pinch = null;
        this.drag = { x: p.x, y: p.y, cx: this.cx, cy: this.cy, moved: true, type: e.pointerType };
        this.samples = [];
        return;
      }
      this.pinch = null;
      this.drag = null;
      document.body.classList.remove('is-dragging');
      if (!d) return;
      if (!d.moved && e.type === 'pointerup') {
        const cell = this.pick(e.clientX, e.clientY);
        if (cell) this.open(cell);
        return;
      }
      const s = this.samples;
      if (s.length >= 2 && performance.now() - s[s.length - 1].t < 60) {
        const a = s[0];
        const b = s[s.length - 1];
        const dt = Math.max(16, b.t - a.t) / 1000;
        const k = reducedMotion.get() ? 0 : 1;
        this.vx = (-(b.x - a.x) / dt / this.S) * k;
        this.vy = (-(b.y - a.y) / dt / this.S) * k;
      }
      this.invalidate();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', end);

    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.interactive) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.vh : 1;
        let dx = e.deltaX * unit;
        let dy = e.deltaY * unit;
        if (e.ctrlKey || e.metaKey) {
          this.zoomBy(Math.exp(-dy * 0.0085), e.clientX, e.clientY);
          return;
        }
        if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
        this.fly = null;
        this.wheel[0] += dx / this.S;
        this.wheel[1] += dy / this.S;
        this.invalidate();
      },
      { passive: false },
    );

    // the light follows the cursor anywhere in the window
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        this.setLightTarget(e.clientX, e.clientY, 1);
        if (!this.interactive || this.drag) return;
        const overCanvas = e.target === c;
        const cell = overCanvas ? this.pick(e.clientX, e.clientY) : null;
        const prev = this.hovered;
        if (!cell) {
          if (prev !== NONE) this.onHover(null);
          this.hovered = NONE;
        } else if (cell[0] !== prev[0] || cell[1] !== prev[1]) {
          this.hovered = cell;
          this.captionDismissed = NONE;
          this.hover = 0;
          this.hoverSince = now();
          this.onHover(this.materialAt(cell));
        }
        c.style.cursor = this.drag ? 'grabbing' : cell ? 'pointer' : 'grab';
        this.invalidate();
      },
      { passive: true },
    );
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.hovered === NONE || document.querySelector('dialog[open]')) return;
      this.captionDismissed = this.hovered;
      this.invalidate();
    });
    document.addEventListener('pointerleave', () => {
      this.light.tk = 0.55;
      this.hovered = NONE;
      this.onHover(null);
      wake();
    });
  }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    this.pinch = {
      dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: this.zoom,
      wx: this.cx + (mx - this.vw / 2) / this.S,
      wy: this.cy + (my - this.vh / 2) / this.S,
    };
    if (this.drag) this.drag.moved = true;
  }

  open(cell: Cell) {
    const m = this.materialAt(cell);
    this.focusCell = cell;
    this.onOpen(m, this.cellRect(cell), cell);
  }

  /* ---------------- accessible grid (keyboard + screen readers) ---------------- */

  private buildA11yGrid() {
    const { order, W, H } = this.layout;
    this.grid.replaceChildren();
    this.grid.setAttribute('aria-rowcount', String(H));
    this.grid.setAttribute('aria-colcount', String(W));
    this.cells = [];
    for (let r = 0; r < H; r++) {
      const row = h('div', { role: 'row', 'aria-rowindex': r + 1 });
      for (let c = 0; c < W; c++) {
        const k = r * W + c;
        if (k >= order.length) break;
        const m = materials[order[k]];
        const cell = h('div.gc', { role: 'gridcell', tabindex: -1, 'aria-colindex': c + 1, 'data-k': k, id: `gc-${k}` });
        cell.append(h('span', {}, this.cellLabel(m)));
        row.append(cell);
        this.cells.push(cell);
      }
      this.grid.append(row);
    }
    const startK = this.focusCell ? imod(this.focusCell[0] + this.focusCell[1] * W, order.length) : 0;
    this.cells[startK]?.setAttribute('tabindex', '0');
  }

  private cellLabel(m: Material) {
    // the selection dot is drawn on the canvas: say it in the name too (WCAG 1.3.1)
    const sel = isSelected(m.slug) ? ` ${t('detail.added')}.` : '';
    return `${m.name}. ${loc(m.collection.name)}, ${t(`finish.${m.defaultFinish}` as Key).toLowerCase()}.${sel}`;
  }

  relabel() {
    const { order } = this.layout;
    this.cells.forEach((el, k) => (el.firstElementChild!.textContent = this.cellLabel(materials[order[k]])));
  }

  private bindKeys() {
    this.grid.addEventListener('focusin', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.gc');
      if (!el) return;
      const k = Number(el.dataset.k);
      const { order, W } = this.layout;
      const fc = this.focusCell;
      if (!fc || imod(fc[0] + fc[1] * W, order.length) !== k) {
        this.focusCell = this.nearestCell(materials[order[k]]);
      }
      this.setActiveCell(el);
      if (!this.fly) this.ensureVisible(this.focusCell!);
    });
    this.grid.addEventListener('focusout', (e) => {
      if (!this.grid.contains(e.relatedTarget as Node)) this.setActiveCell(null);
    });
    this.grid.addEventListener('keydown', (e) => {
      const fc = this.focusCell;
      if (!fc) return;
      const moves: Record<string, Cell> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        this.focusWorld([fc[0] + mv[0], fc[1] + mv[1]]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.open(fc);
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.resetView();
      }
    });
  }

  /** Move keyboard focus to a world cell (wrapping into the finite DOM grid). */
  focusWorld(c: Cell, viaKeyboard = true, ensure = true) {
    const { order, W } = this.layout;
    const k = imod(c[0] + c[1] * W, order.length);
    this.focusCell = c;
    const el = this.cells[k];
    this.cells.forEach((x) => x.setAttribute('tabindex', '-1'));
    el.setAttribute('tabindex', '0');
    if (viaKeyboard) el.focus({ preventScroll: true });
    this.setActiveCell(viaKeyboard ? el : null);
    if (ensure) this.ensureVisible(c);
  }

  focusGrid() {
    const el = this.grid.querySelector<HTMLElement>('[tabindex="0"]') ?? this.cells[0];
    el?.focus({ preventScroll: true });
  }

  /** Remember a cell (e.g. after search) so keyboard focus starts there. */
  setFocusCell(c: Cell) {
    const { order, W } = this.layout;
    const k = imod(c[0] + c[1] * W, order.length);
    this.focusCell = c;
    this.cells.forEach((x, i) => x.setAttribute('tabindex', i === k ? '0' : '-1'));
  }

  private rovingTimer = 0;

  /** While the grid is not focused, Tab should land on the surface at the centre of the screen. */
  private syncRoving() {
    if (this.grid.contains(document.activeElement) || !this.cells.length) return;
    const c = this.pick(this.vw / 2, this.vh / 2) ?? ([Math.floor(this.cx), Math.floor(this.cy)] as Cell);
    this.setFocusCell(c);
  }

  private setActiveCell(el: HTMLElement | null) {
    if (this.activeCellEl && this.activeCellEl !== el) this.activeCellEl.removeAttribute('data-active');
    this.activeCellEl = el;
    if (el) el.setAttribute('data-active', '');
    this.invalidate();
  }

  private ensureVisible(c: Cell) {
    const r = this.cellRect(c);
    const top = 84;
    const bottom = this.vh - (this.vw < 720 ? 120 : 96);
    const left = 20;
    const right = this.vw - 20;
    let dx = 0;
    let dy = 0;
    if (r.x < left) dx = r.x - left;
    else if (r.x + r.w > right) dx = r.x + r.w - right;
    if (r.y < top) dy = r.y - top;
    else if (r.y + r.h > bottom) dy = r.y + r.h - bottom;
    if (dx || dy) {
      const S = this.S;
      const tx = this.cx + dx / S;
      const ty = this.cy + dy / S;
      this.flyTo([tx - 0.5, ty - 0.5], { instant: false });
      if (this.fly) this.fly.dur = 0.45;
    }
  }

  /* ---------------- per frame ---------------- */

  private tick(dt: number, time: number): boolean {
    let active = false;
    const bank = this.renderer.bank;
    if (bank.pending) {
      if (bank.pump(time)) this.dirty = true;
      active = true;
    }

    if (this.fly) {
      const f = this.fly;
      const p = clamp((time - f.t0) / f.dur, 0, 1);
      const e = ease.inOutCubic(p);
      this.cx = lerp(f.x0, f.x1, e);
      this.cy = lerp(f.y0, f.y1, e);
      this.zoom = this.targetZoom = lerp(f.z0, f.z1, e) * (1 - f.dip * Math.sin(Math.PI * p));
      if (p >= 1) {
        this.zoom = this.targetZoom = f.z1;
        this.fly = null;
      }
      active = true;
    } else if (!this.drag && !this.pinch) {
      if (Math.abs(this.vx) + Math.abs(this.vy) > 0.0005) {
        this.cx += this.vx * dt;
        this.cy += this.vy * dt;
        const fr = Math.exp(-dt * 3.2);
        this.vx *= fr;
        this.vy *= fr;
        active = true;
      } else this.vx = this.vy = 0;
      if (Math.abs(this.wheel[0]) + Math.abs(this.wheel[1]) > 0.0002) {
        const k = reducedMotion.get() ? 1 : 1 - Math.exp(-dt * 16);
        const sx = this.wheel[0] * k;
        const sy = this.wheel[1] * k;
        this.cx += sx;
        this.cy += sy;
        this.wheel[0] -= sx;
        this.wheel[1] -= sy;
        active = true;
      }
      if (Math.abs(this.zoom - this.targetZoom) > 0.0005) {
        this.applyZoom(damp(this.zoom, this.targetZoom, 12, dt));
        active = true;
      }
    }

    // velocity → bend (the grid curves like a lens while it travels)
    const S = this.S;
    const moved = Math.hypot(this.cx - this.lastCam[0], this.cy - this.lastCam[1]) * S;
    const camChanged = moved > 0.01 || Math.abs(this.zoom - this.lastCam[2]) > 1e-5;
    this.lastCam = [this.cx, this.cy, this.zoom];
    this.speed = damp(this.speed, moved / Math.max(dt, 1e-3), 10, dt);
    const rm = reducedMotion.get();
    const bendT = rm ? 0 : clamp(this.speed / 4200, 0, 1) * 0.11;
    const liftT = rm ? 0 : clamp(this.speed / 6000, 0, 1) * 0.035 + (this.drag?.moved ? 0.012 : 0);
    this.bend = damp(this.bend, bendT, 7, dt);
    this.lift = damp(this.lift, liftT, 7, dt);
    if (this.bend > 0.0004 || this.lift > 0.0004 || this.speed > 1) active = true;
    if (camChanged) {
      this.dirty = true;
      this.onCamera();
      clearTimeout(this.rovingTimer);
      this.rovingTimer = window.setTimeout(() => this.syncRoving(), 250);
    }

    // light
    const L = this.light;
    if (L.script && time < L.script) {
      const p = 1 - (L.script - time) / 2.6;
      L.tx = this.vw * lerp(0.18, 0.72, ease.inOutCubic(clamp(p, 0, 1)));
      L.ty = this.vh * (0.42 - 0.12 * Math.sin(p * Math.PI));
      active = true;
    }
    const lx = damp(L.x, L.tx, 9, dt);
    const ly = damp(L.y, L.ty, 9, dt);
    const lk = damp(L.k, L.tk, 4, dt);
    if (Math.abs(lx - L.x) + Math.abs(ly - L.y) > 0.05 || Math.abs(lk - L.k) > 0.001) {
      active = true;
      this.dirty = true;
    }
    L.x = lx;
    L.y = ly;
    L.k = lk;

    // hover
    const hoverT = this.hovered !== NONE ? 1 : 0;
    const hv = damp(this.hover, hoverT, 14, dt);
    if (Math.abs(hv - this.hover) > 0.001) {
      active = true;
      this.dirty = true;
    }
    this.hover = hv;
    if (this.hovered !== NONE && time - this.hoverSince > 0.12) {
      this.renderer.details.prefetch(this.materialAt(this.hovered).slug);
      this.hoverSince = Infinity;
    }

    // detail mode
    const dm = rm ? this.dimTarget : damp(this.dim, this.dimTarget, 6.5, dt);
    if (Math.abs(dm - this.dim) > 0.0005) active = true;
    this.dim = Math.abs(dm - this.dimTarget) < 0.001 ? this.dimTarget : dm;
    if (this.hero?.busy()) active = true;

    if (time - this.rippleStart < this.rippleLen) active = true;
    if (time - this.pulseStart < 1.5) active = true;
    if (time < this.keepAliveUntil) active = true;
    if (active) this.dirty = true;

    // adaptive resolution: if we keep missing frames, render fewer pixels
    if (active && dt > 1 / 40) {
      if (++this.slowFrames > 45 && this.ratio > 1) {
        this.ratio = Math.max(1, this.ratio - 0.25);
        this.slowFrames = 0;
        this.renderer.resize(this.vw, this.vh, this.ratio);
      }
    } else this.slowFrames = Math.max(0, this.slowFrames - 1);
    return active;
  }

  get lightParams(): LightParams {
    const z = clamp(Math.min(this.vw, this.vh) * 0.42, 170, 480);
    return { x: this.light.x, y: this.light.y, z, k: this.light.k, r: Math.max(this.vw, this.vh) * 0.42 };
  }

  private render(time: number) {
    if (!this.dirty) return;
    this.dirty = false;
    const r = this.renderer;
    const light = this.lightParams;
    const heroParams = this.hero ? this.hero.frame(0, time) : null;
    const gridVisible = this.showGrid && this.dim < 0.999;
    const bgAlpha = this.showGrid ? 1 : this.dim;
    r.begin(light, bgAlpha);
    if (gridVisible) r.drawGrid(this.gridParams(time), light, time, ACCENT);
    if (heroParams) r.drawHero(heroParams, light);
    this.updateOverlays();
  }

  private gridParams(time: number): GridParams {
    const S = this.S;
    const margin = 1 + Math.ceil((this.bend + this.lift + 0.02) * Math.max(this.vw, this.vh) * 0.7 / S);
    const fi = Math.floor(this.cx - this.vw / 2 / S) - margin;
    const fj = Math.floor(this.cy - this.vh / 2 / S) - margin;
    const cols = Math.ceil(this.vw / S) + margin * 2 + 1;
    const rows = Math.ceil(this.vh / S) + margin * 2 + 1;
    const pulse = clamp((time - this.pulseStart) / 1.4, 0, 1);
    return {
      origin: [(fi - this.cx) * S + this.vw / 2, (fj - this.cy) * S + this.vh / 2],
      cell: S,
      inset: S * GAP * 0.5,
      first: [fi, fj],
      cols,
      rows,
      rippleT: time - this.rippleStart,
      rippleOrigin: this.rippleOrigin,
      bend: this.bend,
      lift: this.lift,
      hoverCell: this.hovered,
      hover: this.hover,
      pulseCell: this.pulseCell,
      pulse: pulse < 1 ? (pulse * 2) % 1 : 0,
      heroCell: this.heroCell,
      heroHide: this.heroHide,
      dim: this.dim,
      dimOrigin: this.dimOrigin,
      radius: Math.min(3, S * 0.012),
    };
  }

  /* ---------------- DOM overlays: caption, zoom labels, focus ring ---------------- */

  private updateOverlays() {
    const busy = this.dim > 0.01 || !this.showGrid;
    // focus ring follows its world cell
    if (this.activeCellEl && this.focusCell && !busy) {
      const r = this.cellRect(this.focusCell);
      const s = this.activeCellEl.style;
      s.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
      s.width = `${r.w}px`;
      s.height = `${r.h}px`;
    }

    const S = this.S;
    const showLabels = S >= 330 && !busy && this.bend < 0.02;
    this.labelLayer.hidden = !showLabels;
    if (showLabels) {
      const fi = Math.floor(this.cx - this.vw / 2 / S);
      const fj = Math.floor(this.cy - this.vh / 2 / S);
      let n = 0;
      for (let j = fj; j <= fj + Math.ceil(this.vh / S) + 1; j++)
        for (let i = fi; i <= fi + Math.ceil(this.vw / S) + 1; i++) {
          const r = this.cellRect([i, j]);
          if (r.x > this.vw || r.y > this.vh || r.x + r.w < 0 || r.y + r.h < 0) continue;
          const el = (this.labels[n] ??= this.labelLayer.appendChild(h('div.zlabel', { 'aria-hidden': 'true' }, h('b'), h('span'))));
          const m = this.materialAt([i, j]);
          if (el.dataset.slug !== m.slug) {
            el.dataset.slug = m.slug;
            el.firstElementChild!.textContent = m.name;
            el.lastElementChild!.textContent = `${loc(m.collection.name)} · ${t(`finish.${m.defaultFinish}` as Key)}`;
          }
          el.style.transform = `translate3d(${r.x + 14}px, ${r.y + r.h - 14}px, 0) translateY(-100%)`;
          el.hidden = false;
          n++;
        }
      for (let k = n; k < this.labels.length; k++) this.labels[k].hidden = true;
    }

    const cap = this.caption;
    const showCap = !showLabels && !busy && this.hovered !== NONE && !this.drag && finePointer() && !sameCell(this.hovered, this.captionDismissed);
    if (showCap) {
      const c = this.hovered;
      if (c[0] !== this.captionCell[0] || c[1] !== this.captionCell[1]) {
        this.captionCell = c;
        const m = this.materialAt(c);
        cap.querySelector('b')!.textContent = m.name;
        cap.querySelector('span')!.textContent = `${loc(m.collection.name)} · ${t(`finish.${m.defaultFinish}` as Key)}`;
      }
      const r = this.cellRect(c);
      cap.style.transform = `translate3d(${r.x + 12}px, ${r.y + r.h - 12}px, 0) translateY(-100%)`;
      cap.dataset.show = 'true';
    } else if (cap.dataset.show === 'true') {
      cap.dataset.show = 'false';
      this.captionCell = NONE;
    }
  }
}
