import type { Atlas, HeroController, Rect } from '../atlas/atlas';
import type { HeroParams } from '../gl/renderer';
import type { OrbitDir } from '../space/space';
import type { DetailTex } from '../gl/textures';
import {
  materials, loc, parseFormat, shading, thicknessMm, boxInfo, slipClass, calc, pairings, texUrl,
  type Material, type Finish,
} from '../data/materials';
import { t, num, type Key } from '../i18n';
import { h, svgIcon, finePointer } from '../lib/dom';
import { clamp, damp, ease, lerp, now, wake } from '../lib/anim';
import { reducedMotion, isSelected, toggleSelected, upsertSelected, selection } from '../state';
import { announce, toast } from './live';

type Cell = [number, number];
export interface OpenCtx { from: 'atlas' | 'index' | 'route'; rect?: Rect; cell?: Cell }

const CM_PER_PX = 2.54 / 96;
/** Zoom factor of one key press or button press in the viewer. */
const ZOOM_STEP = 1.3;
/** One press of a pan button moves the piece this fraction of the shorter side of the viewer. */
const PAN_BUTTON_STEP = 0.2;
/** Finger travel (px) before a one-finger touch pans the piece instead of only moving the light. */
const TOUCH_PAN_SLOP = 9;

type Tab = 'piece' | 'space';
// The same six buttons pan the piece («Pieza») and move the camera («Espacio»): the single-pointer
// alternative to dragging and pinching (WCAG 2.5.1 and 2.5.7). Label key and icon per tab.
const PAD: Array<{ dir: OrbitDir; piece: [Key, string]; space: [Key, string] }> = [
  { dir: 'left', piece: ['detail.pan.left', 'chevron-left'], space: ['space.turn.left', 'turn-left'] },
  { dir: 'right', piece: ['detail.pan.right', 'chevron-right'], space: ['space.turn.right', 'turn-right'] },
  { dir: 'up', piece: ['detail.pan.up', 'chevron-up'], space: ['space.tilt.up', 'chevron-up'] },
  { dir: 'down', piece: ['detail.pan.down', 'chevron-down'], space: ['space.tilt.down', 'chevron-down'] },
  { dir: 'out', piece: ['zoom.out', 'minus'], space: ['zoom.out', 'minus'] },
  { dir: 'in', piece: ['zoom.in', 'plus'], space: ['zoom.in', 'plus'] },
];
type JointId = 'tone' | 'light' | 'grey' | 'dark';
const JOINTS: Record<JointId, string | null> = { tone: null, light: '#d9d3ca', grey: '#8b867f', dark: '#2a2825' };
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const hexLin = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
};

interface Win { cx: number; cy: number; k: number }
interface Morph { t0: number; dur: number; from: Rect; to: () => Rect; wFrom: Win; wTo: () => Win; r0: number; r1: number; done: () => void }

export class Detail implements HeroController {
  m: Material | null = null;
  finish: Finish = 'mate';
  format = '60x60';
  joint: JointId = 'tone';
  pushed = false;
  getSequence: () => number[] = () => materials.map((m) => m.index);
  onClosed: (m: Material, ctx: OpenCtx) => void = () => {};
  onSample: () => void = () => {};

  private ctx: OpenCtx = { from: 'atlas' };
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed';
  private morph: Morph | null = null;
  private rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private radius = 0;
  private win: Win = { cx: 30, cy: 30, k: 0.2 };
  private winT: Win = { cx: 30, cy: 30, k: 0.2 };
  private jointA = 0;
  private jointT = 0;
  private opacity = 1;
  private opacityT = 1;
  private shade: [number, number, number] = [0.5, 1, 0.2];
  private shadeT: [number, number, number] = [0.5, 1, 0.2];
  private tex: DetailTex | null = null;
  private mix = 0;
  private lastT = 0;
  private realScale = false;
  private tab: Tab = 'piece';
  private space: import('../space/space').SpaceHandle | null = null;
  private spaceLoading: Promise<void> | null = null;
  private interacted: Record<Tab, boolean> = { piece: false, space: false };
  /** The viewer or the room has keyboard focus: the hint shows the keys. */
  private keyHint = false;
  private pan: null | { id: number; x: number; y: number; cx: number; cy: number; moved: boolean } = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: null | { d: number; k: number; mx: number; my: number; cx: number; cy: number } = null;

  private hole!: HTMLElement;
  private els: Record<string, HTMLElement> = {};

  constructor(private dlg: HTMLDialogElement, private atlas: Atlas) {
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.requestClose();
    });
    dlg.addEventListener('keydown', (e) => this.onKey(e));
    addEventListener('resize', () => {
      if (this.state === 'open') {
        this.winT.k = clamp(this.winT.k, this.kMin, this.kMax);
        this.space?.resize();
        wake();
      }
    });
    selection.sub(() => this.syncAddButton());
  }

  get isOpen() {
    return this.state !== 'closed';
  }

  /* ------------------------------------------------------------ open / close */

  open(m: Material, ctx: OpenCtx) {
    if (this.state === 'closing') this.finishClose(true);
    if (this.state !== 'closed') {
      this.swapTo(m);
      return;
    }
    this.ctx = ctx;
    this.tab = 'piece';
    this.interacted = { piece: false, space: false };
    this.setMaterial(m);
    this.build();
    this.dlg.showModal();
    document.body.classList.add('detail-open');
    this.dlg.dataset.state = 'opening';
    this.state = 'opening';
    this.realScale = false;

    const hole = this.holeRect();
    const rm = reducedMotion.get();
    let from = ctx.rect;
    if (!from) {
      const s = Math.min(hole.w, hole.h) * 0.36;
      from = { x: hole.x + (hole.w - s) / 2, y: hole.y + (hole.h - s) / 2, w: s, h: s };
      this.opacity = 0;
    } else this.opacity = 1;
    this.opacityT = 1;

    this.atlas.hero = this;
    this.atlas.interactive = false;
    this.atlas.heroCell = ctx.cell ?? [-1e8, -1e8];
    this.atlas.heroHide = 1;
    this.atlas.dimOrigin = [from.x + from.w / 2, from.y + from.h / 2];
    this.atlas.dimTarget = 0;
    if (ctx.from === 'index') this.atlas.showGrid = false;

    this.jointA = 1;
    this.jointT = 1;
    this.shade = [...this.shadeT];
    this.rect = { ...from };
    const startWin: Win = { cx: 30, cy: 30, k: 60 / Math.max(from.w, from.h) };
    this.win = { ...startWin };
    this.morph = {
      t0: now(), dur: rm ? 0.001 : 0.95, from, to: () => this.holeRect(), wFrom: startWin,
      wTo: () => this.defaultWin(), r0: 3, r1: 0,
      done: () => {
        this.state = 'open';
        this.dlg.dataset.state = 'open';
        this.winT = this.defaultWin();
        this.win = { ...this.winT };
        this.jointT = 1;
      },
    };
    requestAnimationFrame(() => (this.dlg.dataset.state = 'open-anim'));
    announce(`${m.name}. ${loc(m.collection.name)}.`);
    wake();
  }

  requestClose() {
    if (this.state === 'closed' || this.state === 'closing') return;
    if (this.pushed) {
      this.pushed = false;
      history.back(); // popstate → close()
    } else this.close();
  }

  close() {
    if (this.state === 'closed' || this.state === 'closing') return;
    const m = this.m!;
    this.state = 'closing';
    this.dlg.dataset.state = 'closing';
    this.setTab('piece', false);
    const rm = reducedMotion.get();
    const target = this.closeTarget(m);
    const fromRect = { ...this.rect };
    const fromWin = { ...this.win };
    this.atlas.dimOrigin = [target.rect.x + target.rect.w / 2, target.rect.y + target.rect.h / 2];
    this.morph = {
      t0: now(), dur: rm ? 0.001 : 0.8, from: fromRect, to: () => target.rect, wFrom: fromWin,
      wTo: () => ({ cx: 30, cy: 30, k: 60 / Math.max(target.rect.w, target.rect.h) }), r0: 0, r1: 3,
      done: () => this.finishClose(false),
    };
    if (target.fade) this.opacityT = 0;
    wake();
  }

  private finishClose(immediate: boolean) {
    this.morph = null;
    this.state = 'closed';
    this.atlas.hero = null;
    this.atlas.heroHide = 0;
    this.atlas.dim = this.atlas.dimTarget = 0;
    this.atlas.interactive = true;
    this.atlas.heroCell = [-1e8, -1e8];
    this.atlas.showGrid = document.body.dataset.view !== 'index';
    this.space?.dispose();
    this.space = null;
    this.spaceLoading = null;
    document.body.classList.remove('detail-open');
    delete this.dlg.dataset.state;
    if (this.dlg.open) this.dlg.close();
    this.atlas.invalidate();
    if (!immediate && this.m) this.onClosed(this.m, this.ctx);
  }

  private closeTarget(m: Material): { rect: Rect; fade: boolean } {
    if (document.body.dataset.view === 'index') {
      const card = document.querySelector<HTMLElement>(`.card[data-slug="${m.slug}"] .img`);
      if (card) {
        const r = card.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) card.scrollIntoView({ block: 'center' });
        const r2 = card.getBoundingClientRect();
        return { rect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height }, fade: false };
      }
      const hole = this.holeRect();
      return { rect: { x: hole.x + hole.w / 2 - 40, y: hole.y + hole.h / 2 - 40, w: 80, h: 80 }, fade: true };
    }
    let cell = this.ctx.cell && this.atlas.materialAt(this.ctx.cell).slug === m.slug ? this.ctx.cell : null;
    if (cell) {
      const r = this.atlas.cellRect(cell);
      if (r.x + r.w < 0 || r.y + r.h < 0 || r.x > innerWidth || r.y > innerHeight) cell = null;
    }
    if (!cell) {
      cell = this.atlas.nearestCell(m);
      if (!cell) return { rect: this.holeRect(), fade: true };
      this.atlas.flyTo(cell, { instant: true });
    }
    this.ctx.cell = cell;
    this.atlas.heroCell = cell;
    this.atlas.setFocusCell(cell);
    return { rect: this.atlas.cellRect(cell), fade: false };
  }

  /* ------------------------------------------------------------ material state */

  private setMaterial(m: Material) {
    this.m = m;
    const sel = selection.get().find((s) => s.slug === m.slug);
    this.finish = sel?.finish ?? m.defaultFinish;
    this.format = sel?.format ?? m.defaultFormat;
    const s = shading(m, this.finish);
    this.shadeT = [s.rough, s.normal, s.spec];
    this.tex = null;
    this.mix = 0;
    const slug = m.slug;
    this.atlas.renderer.details.get(slug).then(
      (tex) => {
        if (this.m?.slug === slug) {
          this.tex = tex;
          wake();
        }
      },
      () => {},
    );
  }

  /** Prev/next/pairing: dip the viewer, swap, rise again. */
  private swapTo(m: Material) {
    if (!this.m || m.slug === this.m.slug) return;
    const rm = reducedMotion.get();
    this.opacityT = 0;
    this.dlg.dataset.swap = 'true';
    const go = () => {
      this.setMaterial(m);
      this.winT = this.defaultWin();
      this.win = { ...this.winT };
      this.shade = [...this.shadeT];
      this.renderPanel();
      this.opacityT = 1;
      this.dlg.dataset.swap = 'false';
      if (this.space) this.updateSpace();
      if (this.pushed) history.replaceState(history.state, '', `#/s/${m.slug}`);
      announce(`${m.name}. ${loc(m.collection.name)}.`);
      wake();
    };
    if (rm) go();
    else setTimeout(go, 220);
    wake();
  }

  private step(dir: 1 | -1) {
    if (!this.m) return;
    const seq = this.getSequence();
    const i = seq.indexOf(this.m.index);
    const next = seq[(i + dir + seq.length) % seq.length];
    this.swapTo(materials[next]);
  }

  /* ------------------------------------------------------------ geometry */

  private holeRect(): Rect {
    const r = (this.hole ?? this.dlg).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  private get kMin() {
    return CM_PER_PX * 0.5;
  }
  private get kMax() {
    return 700 / Math.max(1, this.holeRect().w);
  }

  private defaultWin(): Win {
    const f = parseFormat(this.format);
    const hole = this.holeRect();
    const widthCm = clamp(f.plank ? f.w * 2.1 : f.w * 2.6, 150, 380);
    const heightCm = f.h * 1.15;
    const k = Math.max(widthCm / hole.w, Math.min(heightCm, 340) / hole.h);
    return { cx: 30, cy: 30, k: clamp(k, this.kMin, 700 / hole.w) };
  }

  /* ------------------------------------------------------------ HeroController */

  busy() {
    if (this.morph) return true;
    if (this.pan || this.pinch) return true;
    const w = this.win;
    const tt = this.winT;
    if (Math.abs(w.k - tt.k) / tt.k > 0.001 || Math.abs(w.cx - tt.cx) > 0.01 || Math.abs(w.cy - tt.cy) > 0.01) return true;
    if (Math.abs(this.jointA - this.jointT) > 0.002) return true;
    if (Math.abs(this.opacity - this.opacityT) > 0.002) return true;
    if (this.tex && this.mix < 0.999) return true;
    for (let i = 0; i < 3; i++) if (Math.abs(this.shade[i] - this.shadeT[i]) > 0.001) return true;
    return false;
  }

  frame(_dt: number, time: number): HeroParams | null {
    const m = this.m;
    if (!m) return null;
    const dt = this.lastT ? clamp(time - this.lastT, 0, 0.1) : 1 / 60;
    this.lastT = time;
    const rm = reducedMotion.get();
    const d = (a: number, b: number, l: number) => (rm ? b : damp(a, b, l, dt));

    if (this.morph) {
      const mo = this.morph;
      const p = clamp((time - mo.t0) / mo.dur, 0, 1);
      const e = ease.inOutQuart(p);
      const to = mo.to();
      this.rect = {
        x: lerp(mo.from.x, to.x, e), y: lerp(mo.from.y, to.y, e),
        w: lerp(mo.from.w, to.w, e), h: lerp(mo.from.h, to.h, e),
      };
      const wt = mo.wTo();
      this.win = {
        cx: lerp(mo.wFrom.cx, wt.cx, e), cy: lerp(mo.wFrom.cy, wt.cy, e),
        k: Math.exp(lerp(Math.log(mo.wFrom.k), Math.log(wt.k), e)),
      };
      this.radius = lerp(mo.r0, mo.r1, e);
      this.jointA = 1;
      this.atlas.dim = this.atlas.dimTarget = this.state === 'opening' ? ease.outCubic(p) : 1 - ease.inOutCubic(p);
      if (p >= 1) {
        this.morph = null;
        mo.done();
        if (this.state === 'closed') return null;
      }
    } else {
      this.rect = this.holeRect();
      this.radius = 0;
      if (!this.pan && !this.pinch) {
        this.win.k = rm ? this.winT.k : Math.exp(damp(Math.log(this.win.k), Math.log(this.winT.k), 12, dt));
        this.win.cx = d(this.win.cx, this.winT.cx, 12);
        this.win.cy = d(this.win.cy, this.winT.cy, 12);
      }
      this.jointA = d(this.jointA, this.jointT, 10);
    }
    this.opacity = d(this.opacity, this.opacityT, 14);
    this.mix = this.tex ? d(this.mix, 1, 7) : 0;
    for (let i = 0; i < 3; i++) this.shade[i] = d(this.shade[i], this.shadeT[i], 9);
    this.updateScaleTag();

    if (this.tab === 'space' && !this.morph) return null;
    const f = parseFormat(this.format);
    const r = this.rect;
    const k = this.win.k;
    const jc = JOINTS[this.joint];
    const jointRGB: [number, number, number] = jc ? hexLin(jc) : [m.linear[0] * 0.42, m.linear[1] * 0.42, m.linear[2] * 0.42];
    return {
      rect: [r.x, r.y, r.w, r.h],
      win: [this.win.cx - (r.w / 2) * k, this.win.cy - (r.h / 2) * k, k],
      phys: m.collection.phys,
      crop: m.crop,
      tile: [f.w, f.h, f.plank ? 1 : 0],
      tileOff: [(f.w - 60) / 2, f.plank ? 0 : (f.h - 60) / 2],
      jointW: Math.max(0.15, 1.15 * k),
      joint: [...jointRGB, this.jointA],
      detailMix: this.mix,
      detail: this.tex,
      layer: m.index,
      avg: m.linear,
      shade: this.shade,
      radius: this.radius,
      opacity: this.opacity,
    };
  }

  private scaleTagValue = '';
  private updateScaleTag() {
    const tag = this.els.scaleTag;
    if (!tag) return;
    const widthCm = this.win.k * this.rect.w;
    const v = widthCm >= 100 ? `≈ ${num(widthCm / 100, 1)} m` : `≈ ${num(widthCm, 0)} cm`;
    if (v !== this.scaleTagValue) tag.textContent = this.scaleTagValue = v;
  }

  /* ------------------------------------------------------------ viewer input */

  private bindViewer() {
    const hole = this.hole;
    hole.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.atlas.setLightTarget(e.clientX, e.clientY);
      const tp = this.touches.get(e.pointerId);
      if (tp) {
        tp.x = e.clientX;
        tp.y = e.clientY;
      }
      if (this.pinch && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const dd = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const k = clamp((this.pinch.k * this.pinch.d) / dd, this.kMin, this.kMax);
        const r = this.rect;
        const px = this.pinch.cx + (this.pinch.mx - (r.x + r.w / 2)) * this.pinch.k;
        const py = this.pinch.cy + (this.pinch.my - (r.y + r.h / 2)) * this.pinch.k;
        this.win.k = this.winT.k = k;
        this.win.cx = this.winT.cx = px - (mx - (r.x + r.w / 2)) * k;
        this.win.cy = this.winT.cy = py - (my - (r.y + r.h / 2)) * k;
        this.markInteracted();
        wake();
        return;
      }
      if (this.pan && this.pan.id === e.pointerId) {
        if (e.pointerType !== 'mouse') {
          this.atlas.setLightTarget(e.clientX, e.clientY);
          // a still finger moves the light; once it travels it also pans (no two-finger gesture needed)
          if (!this.pan.moved) {
            if (Math.hypot(e.clientX - this.pan.x, e.clientY - this.pan.y) < TOUCH_PAN_SLOP) return;
            this.pan = { ...this.pan, x: e.clientX, y: e.clientY, cx: this.win.cx, cy: this.win.cy, moved: true };
          }
        }
        const k = this.win.k;
        this.win.cx = this.winT.cx = this.pan.cx - (e.clientX - this.pan.x) * k;
        this.win.cy = this.winT.cy = this.pan.cy - (e.clientY - this.pan.y) * k;
        this.markInteracted();
        wake();
      }
    });
    hole.addEventListener('pointerdown', (e) => {
      if (this.state !== 'open') return;
      hole.setPointerCapture(e.pointerId);
      if (e.pointerType !== 'mouse') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.atlas.setLightTarget(e.clientX, e.clientY);
        if (this.touches.size === 2) {
          const [a, b] = [...this.touches.values()];
          this.pinch = {
            d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), k: this.win.k,
            mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cx: this.win.cx, cy: this.win.cy,
          };
          this.pan = null;
        } else this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: this.win.cx, cy: this.win.cy, moved: false };
        this.markInteracted();
        return;
      }
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: this.win.cx, cy: this.win.cy, moved: true };
      hole.classList.add('is-panning');
    });
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      if (this.pan?.id === e.pointerId) this.pan = null;
      hole.classList.remove('is-panning');
      wake();
    };
    hole.addEventListener('pointerup', up);
    hole.addEventListener('pointercancel', up);
    hole.addEventListener(
      'wheel',
      (e) => {
        if (this.state !== 'open') return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : 1;
        this.zoomAt(Math.exp(e.deltaY * unit * 0.0016), e.clientX, e.clientY);
      },
      { passive: false },
    );
    hole.addEventListener('dblclick', () => this.toggleScale());
    hole.addEventListener('keydown', (e) => {
      const step = 40 * this.win.k;
      const keys: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (keys[e.key]) {
        e.preventDefault();
        e.stopPropagation();
        this.winT.cx += keys[e.key][0];
        this.winT.cy += keys[e.key][1];
        this.markInteracted();
        wake();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.zoomAt(1 / ZOOM_STEP);
      } else if (e.key === '-') {
        e.preventDefault();
        this.zoomAt(ZOOM_STEP);
      }
    });
  }

  /** Buttons of the viewer: pan / zoom the piece, or move the camera of the room. */
  private padAction(dir: OrbitDir) {
    this.markInteracted();
    if (this.tab === 'space') {
      this.space?.orbit(dir);
      return;
    }
    if (dir === 'in' || dir === 'out') {
      this.zoomAt(dir === 'in' ? 1 / ZOOM_STEP : ZOOM_STEP);
      return;
    }
    const r = this.holeRect();
    const step = PAN_BUTTON_STEP * Math.min(r.w, r.h) * this.winT.k;
    const move: Record<'left' | 'right' | 'up' | 'down', [number, number]> = { left: [-step, 0], right: [step, 0], up: [0, -step], down: [0, step] };
    this.winT.cx += move[dir][0];
    this.winT.cy += move[dir][1];
    wake();
  }

  private syncPad() {
    const pad = this.els.pad;
    if (!pad) return;
    const tab = this.tab;
    pad.setAttribute('aria-label', t(tab === 'space' ? 'space.pad' : 'detail.pad'));
    pad.replaceChildren(...PAD.map((b) => {
      const [label, icon] = b[tab];
      return h('button.btn.btn-icon', { type: 'button', 'aria-label': t(label), onclick: () => this.padAction(b.dir) }, svgIcon(icon));
    }));
  }

  /** Usage hint of the current tab (pointer, or keys while the view has keyboard focus); the pointer
   *  hint fades after the first interaction with that tab. */
  private syncHint() {
    const hint = this.els.hint;
    if (!hint) return;
    const space = this.tab === 'space';
    const keys: Key = space ? 'space.hint.keys' : 'detail.hint.keys';
    const pointer: Key = finePointer() ? (space ? 'space.hint.mouse' : 'detail.hint.mouse') : space ? 'space.hint.touch' : 'detail.hint.touch';
    hint.textContent = t(this.keyHint ? keys : pointer);
    hint.dataset.hide = String(!this.keyHint && this.interacted[this.tab]);
    this.els.keys.textContent = t(keys);
  }

  private zoomAt(f: number, ax?: number, ay?: number) {
    const r = this.holeRect();
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    ax ??= cx;
    ay ??= cy;
    const k0 = this.winT.k;
    const k1 = clamp(k0 * f, this.kMin, this.kMax);
    const px = this.winT.cx + (ax - cx) * k0;
    const py = this.winT.cy + (ay - cy) * k0;
    this.winT.k = k1;
    this.winT.cx = px - (ax - cx) * k1;
    this.winT.cy = py - (ay - cy) * k1;
    this.realScale = Math.abs(k1 - CM_PER_PX) / CM_PER_PX < 0.04;
    this.syncScaleButton();
    this.markInteracted();
    wake();
  }

  private toggleScale() {
    this.realScale = !this.realScale;
    const centre = { cx: this.winT.cx, cy: this.winT.cy };
    this.winT = this.realScale ? { ...centre, k: CM_PER_PX } : this.defaultWin();
    this.syncScaleButton();
    announce(this.realScale ? t('detail.scale') : t('detail.scale.fit'));
    wake();
  }

  private markInteracted() {
    if (this.interacted[this.tab]) return;
    this.interacted[this.tab] = true;
    if (!this.keyHint) this.els.hint?.setAttribute('data-hide', 'true');
  }

  private onKey(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('input, select, textarea, [role="tab"], .d-hole')) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.step(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.step(-1);
    }
  }

  /* ------------------------------------------------------------ DOM */

  private build() {
    const els = this.els;
    // application, like the room view: so arrow keys reach the viewer with NVDA too.
    this.hole = h('div.d-hole', { tabindex: 0, role: 'application', 'aria-roledescription': t('detail.viewer.role'), 'aria-describedby': 'd-keys', id: 'd-hole' });
    els.space = h('div.d-space', { hidden: true, id: 'd-space' });
    for (const ev of ['pointerdown', 'wheel', 'keydown']) els.space.addEventListener(ev, () => this.markInteracted(), { passive: true, capture: true });
    els.hint = h('p.d-hint', { id: 'd-hint' });
    els.keys = h('p.sr-only', { id: 'd-keys' });
    // keyboard focus (or a key pressed after a click) on the viewer or the room: show the keys
    const keyFocus = (on: boolean) => (e: Event) => {
      if (on === this.keyHint || (on && !(e.target as HTMLElement).matches(':focus-visible'))) return;
      this.keyHint = on;
      this.syncHint();
    };
    for (const el of [this.hole, els.space]) {
      el.addEventListener('focusin', keyFocus(true));
      el.addEventListener('keydown', keyFocus(true), { capture: true });
      el.addEventListener('focusout', keyFocus(false));
    }
    els.back = h('button.btn', { type: 'button', autofocus: true, onclick: () => this.requestClose() }, svgIcon('arrow-left'), h('span', {}, t('detail.back')));
    els.prev = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('detail.prev'), onclick: () => this.step(-1) }, svgIcon('arrow-left'));
    els.next = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('detail.next'), onclick: () => this.step(1) }, svgIcon('arrow-right'));
    els.tabPiece = h('button', { type: 'button', role: 'tab', id: 'tab-piece', 'aria-selected': 'true', 'aria-controls': 'd-hole' }, t('detail.tab.piece'));
    els.tabSpace = h('button', { type: 'button', role: 'tab', id: 'tab-space', 'aria-selected': 'false', 'aria-controls': 'd-space', tabindex: -1 }, t('detail.tab.space'));
    const tabs = h('div.seg', { role: 'tablist', 'aria-label': t('detail.tabs') }, els.tabPiece, els.tabSpace);
    tabs.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[role="tab"]');
      if (b) this.setTab(b.id === 'tab-space' ? 'space' : 'piece', true);
    });
    tabs.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = this.tab === 'piece' ? 'space' : 'piece';
        this.setTab(next, true);
        (next === 'space' ? els.tabSpace : els.tabPiece).focus();
      }
    });
    els.scaleTag = h('span.d-scale-tag', { 'aria-hidden': 'true' });
    els.scale = h('button.btn', { type: 'button', 'aria-pressed': 'false', onclick: () => this.toggleScale() }, svgIcon('scale', 16), h('span', {}, t('detail.scale')));
    els.pad = h('div.d-pad', { role: 'group' });
    const ui = h('div.d-ui', {},
      h('div.d-top', {}, els.back, h('div.d-nav', {}, els.prev, els.next)),
      els.hint,
      h('div.d-bottom', {}, tabs, h('div', { style: 'display:flex;gap:6px;align-items:center' }, els.scaleTag, els.scale)),
      els.pad,
    );
    const viewer = h('div.d-viewer', {}, this.hole, els.space, ui, els.keys);
    els.panel = h('div.d-panel', {}, (els.inner = h('div.d-panel-inner')));
    this.dlg.replaceChildren(h('div.d-wrap', {}, viewer, els.panel));
    this.bindViewer();
    this.syncPad();
    this.syncHint();
    this.renderPanel();
  }

  private renderPanel() {
    const m = this.m!;
    const els = this.els;
    const seq = this.getSequence();
    const pos = seq.indexOf(m.index) + 1;
    const [first, ...rest] = m.name.split(' ');
    const fmt = parseFormat(this.format);
    this.hole.setAttribute('aria-label', t('detail.viewer', { name: m.name, format: `${fmt.label} cm`, finish: t(`finish.${this.finish}` as Key).toLowerCase() }));

    const close = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('detail.close'), onclick: () => this.requestClose() }, svgIcon('close'));
    const head = h('div.d-head', {},
      h('p.eyebrow', {}, `${loc(m.collection.name)} · ${m.code} · `, h('span', {}, t('detail.of', { i: String(pos).padStart(2, '0'), n: String(seq.length).padStart(2, '0') }))),
      close,
    );
    const title = h('div.d-title', {},
      h('h2', { id: 'd-name' }, first, rest.length ? ' ' : '', rest.length ? h('em', {}, rest.join(' ')) : null),
      h('p', {}, loc(m.desc)),
    );

    const radios = (name: string, label: Key, opts: Array<{ v: string; label: string; sw?: string }>, cur: string, onPick: (v: string) => void) => {
      const id = `lbl-${name}`;
      const group = h('div.chips', { role: 'radiogroup', 'aria-labelledby': id });
      for (const o of opts) {
        const input = h('input', { type: 'radio', name: `d-${name}`, value: o.v, checked: o.v === cur });
        input.addEventListener('change', () => onPick(o.v));
        group.append(h('label.radio', {}, input, h('span.chip', {}, o.sw ? h('span.sw', { style: `background:${o.sw}` }) : null, o.label)));
      }
      return h('div.d-group', {}, h('p.eyebrow', { id }, t(label)), group);
    };

    const finishes = radios('finish', 'detail.finish', m.finishes.map((f) => ({ v: f, label: t(`finish.${f}` as Key) })), this.finish, (v) => {
      this.finish = v as Finish;
      const s = shading(m, this.finish);
      this.shadeT = [s.rough, s.normal, s.spec];
      this.refreshSpecs();
      if (isSelected(m.slug)) upsertSelected({ slug: m.slug, finish: this.finish, format: this.format });
      this.updateSpace();
      wake();
    });
    const formats = radios('format', 'detail.format', m.formats.map((f) => ({ v: f, label: `${parseFormat(f).label}` })), this.format, (v) => {
      this.format = v;
      this.jointA = 0;
      this.jointT = 1;
      this.winT = this.realScale ? { ...this.winT } : this.defaultWin();
      this.refreshSpecs();
      if (isSelected(m.slug)) upsertSelected({ slug: m.slug, finish: this.finish, format: this.format });
      this.updateSpace();
      wake();
    });
    const toneHex = `rgb(${m.linear.map((c) => Math.round(Math.pow(c * 0.42, 1 / 2.2) * 255)).join(',')})`;
    const joints = radios('joint', 'detail.joint', (['tone', 'light', 'grey', 'dark'] as JointId[]).map((j) => ({ v: j, label: t(`joint.${j}` as Key), sw: JOINTS[j] ?? toneHex })), this.joint, (v) => {
      this.joint = v as JointId;
      this.updateSpace();
      wake();
    });
    joints.querySelector('.chips')!.classList.add('d-joints');

    els.add = h('button.btn.btn-primary.btn-block', { type: 'button', onclick: () => this.toggleAdd() });
    const sample = h('button.btn', { type: 'button', onclick: () => {
      upsertSelected({ slug: m.slug, finish: this.finish, format: this.format });
      this.onSample();
    } }, svgIcon('sample', 16), t('detail.sample'));
    els.zip = h('button.btn', { type: 'button', onclick: () => this.downloadTextures() }, svgIcon('download', 16), h('span', {}, t('detail.textures')));
    const print = h('button.btn', { type: 'button', onclick: () => this.print() }, svgIcon('print', 16), t('detail.print'));
    const actions = h('div.d-actions', {}, els.add, h('div.row', {}, sample, els.zip, print));

    els.specs = h('dl.specs');
    const specs = h('section.d-group', { 'aria-labelledby': 'h-specs' }, h('h3.eyebrow', { id: 'h-specs' }, t('detail.specs')), els.specs);

    const area = h('input', { type: 'number', id: 'calc-area', min: 1, max: 100000, step: 0.5, value: 20, inputmode: 'decimal' }) as HTMLInputElement;
    const waste = h('select', { id: 'calc-waste' },
      h('option', { value: '0.05' }, '5 %'), h('option', { value: '0.1', selected: true }, '10 %'), h('option', { value: '0.15' }, '15 %')) as HTMLSelectElement;
    els.calcOut = h('output', { for: 'calc-area calc-waste', 'aria-live': 'polite' });
    const runCalc = () => {
      const a = Math.max(0, parseFloat(area.value.replace(',', '.')) || 0);
      const r = calc(this.format, this.finish, a, parseFloat(waste.value));
      els.calcOut.textContent = t('detail.calc.result', { boxes: num(r.boxes), pieces: num(r.pieces), m2: num(r.m2, 2), kg: num(r.kg) });
    };
    area.addEventListener('input', runCalc);
    waste.addEventListener('change', runCalc);
    this.runCalc = runCalc;
    const calcBox = h('section.calc', { 'aria-labelledby': 'h-calc' },
      h('h3.eyebrow', { id: 'h-calc' }, t('detail.calc')),
      h('div.row', {},
        h('div.field', {}, h('label', { for: 'calc-area' }, `${t('detail.calc.area')} (m²)`), area),
        h('div.field', {}, h('label', { for: 'calc-waste' }, t('detail.calc.waste')), waste)),
      els.calcOut,
      h('p.note', {}, t('detail.calc.note')),
    );

    const combine = h('div.combine');
    for (const p of pairings(m)) {
      combine.append(h('button', { type: 'button', onclick: () => this.swapTo(p) },
        h('img', { src: texUrl('s', p.slug, 'c'), alt: '', width: 256, height: 256, loading: 'lazy', decoding: 'async' }),
        h('span', {}, p.name)));
    }
    const combineSec = h('section.d-group', { 'aria-labelledby': 'h-combine' }, h('h3.eyebrow', { id: 'h-combine' }, t('detail.combine')), combine);

    els.inner.replaceChildren(head, title, finishes, formats, joints, actions, specs, calcBox, combineSec);
    this.refreshSpecs();
    this.syncAddButton();
    this.syncScaleButton();
    els.panel.scrollTop = 0;
  }

  private runCalc = () => {};

  private refreshSpecs() {
    const m = this.m!;
    const fmt = parseFormat(this.format);
    const th = thicknessMm(this.format, this.finish);
    const box = boxInfo(this.format);
    const rows: Array<[Key, string]> = [
      ['spec.code', m.code],
      ['spec.format', `${fmt.label} cm`],
      ['spec.thickness', t('common.mm', { n: th })],
      ['spec.weight', t('common.kgm2', { n: num(th * 2.35, 1) })],
      ['spec.finish', t(`finish.${this.finish}` as Key)],
      ['spec.slip', t('spec.slip.value', { n: slipClass(this.finish) })],
      ['spec.variation', t(`variation.${m.collection.variation}` as Key)],
      ['spec.rectified', t('spec.rectified.value')],
      ['spec.absorption', t('spec.absorption.value')],
      ['spec.frost', t('spec.frost.value')],
      ['spec.faces', String(m.collection.faces)],
      ['spec.box', t('spec.box.value', { pcs: box.pcs, m2: num(box.m2, 2) })],
      ['spec.uses', m.uses.map((u) => t(`use.${u}` as Key)).join(', ')],
      ['spec.scale', t('spec.scale.value', { cm: m.collection.phys })],
    ];
    this.els.specs.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, t(k)), h('dd', {}, v)]));
    this.runCalc();
    const fmtLabel = `${fmt.label} cm`;
    this.hole.setAttribute('aria-label', t('detail.viewer', { name: m.name, format: fmtLabel, finish: t(`finish.${this.finish}` as Key).toLowerCase() }));
  }

  private syncAddButton() {
    const b = this.els.add;
    if (!b || !this.m) return;
    const on = isSelected(this.m.slug);
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren(svgIcon(on ? 'check' : 'plus', 16), h('span', {}, on ? t('detail.added') : t('detail.add')));
  }

  private syncScaleButton() {
    this.els.scale?.setAttribute('aria-pressed', String(this.realScale));
  }

  private toggleAdd() {
    const m = this.m!;
    const added = toggleSelected({ slug: m.slug, finish: this.finish, format: this.format });
    toast(t(added ? 'sel.added' : 'sel.removed', { name: m.name }));
  }

  /* ------------------------------------------------------------ tabs / room */

  private setTab(tab: Tab, user: boolean) {
    if (this.tab === tab && this.els.tabPiece) {
      if (!user) return;
    }
    this.tab = tab;
    const els = this.els;
    if (!els.tabPiece) return;
    els.tabPiece.setAttribute('aria-selected', String(tab === 'piece'));
    els.tabSpace.setAttribute('aria-selected', String(tab === 'space'));
    els.tabPiece.setAttribute('tabindex', tab === 'piece' ? '0' : '-1');
    els.tabSpace.setAttribute('tabindex', tab === 'space' ? '0' : '-1');
    els.space.hidden = tab !== 'space';
    els.scale.hidden = tab === 'space';
    els.scaleTag.hidden = tab === 'space';
    // the piece viewer stays under the room: out of the tab order while «Espacio» is shown (WCAG 2.4.7)
    this.hole.tabIndex = tab === 'piece' ? 0 : -1;
    this.hole.toggleAttribute('inert', tab !== 'piece');
    this.syncPad();
    this.syncHint();
    if (tab === 'space') this.ensureSpace();
    else this.space?.pause();
    this.atlas.invalidate();
  }

  private ensureSpace() {
    if (this.space) {
      this.space.resume();
      this.updateSpace();
      return;
    }
    if (this.spaceLoading) return;
    const host = this.els.space;
    const status = h('div.space-status', { role: 'status' }, t('space.loading'));
    host.replaceChildren(status);
    this.spaceLoading = import('../space/space')
      .then(async ({ createSpace }) => {
        if (this.state === 'closed') return;
        this.space = await createSpace(host, this.atlas.renderer.details.tier, this.els.keys.id);
        status.remove();
        this.updateSpace();
        if (this.tab !== 'space') this.space.pause();
      })
      .catch((e) => {
        console.error(e);
        status.textContent = t('space.error');
      });
  }

  private updateSpace() {
    if (!this.space || !this.m) return;
    this.space.set({ material: this.m, finish: this.finish, format: this.format, joint: JOINTS[this.joint] });
  }

  /* ------------------------------------------------------------ exports */

  private async downloadTextures() {
    const m = this.m!;
    const btn = this.els.zip;
    const label = btn.querySelector('span')!;
    btn.setAttribute('aria-busy', 'true');
    label.textContent = t('detail.textures.busy');
    try {
      const { buildTextureZip } = await import('../lib/zip');
      const blob = await buildTextureZip(m, this.finish, this.atlas.renderer.details.tier);
      const a = h('a', { href: URL.createObjectURL(blob), download: `veta-${m.slug}-texturas.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      console.error(e);
    } finally {
      btn.removeAttribute('aria-busy');
      label.textContent = t('detail.textures');
    }
  }

  private print() {
    const m = this.m!;
    const sheet = document.getElementById('print-sheet')!;
    const dl = this.els.specs.cloneNode(true) as HTMLElement;
    dl.removeAttribute('class');
    sheet.replaceChildren(
      h('div.ps-head', {}, h('span', {}, 'VETA — ' + t('brand.tagline')), h('span', {}, m.code)),
      h('h1', {}, m.name),
      h('div.ps-grid', {},
        h('img', { src: texUrl(this.atlas.renderer.details.tier, m.slug, 'c'), alt: m.name }),
        h('div', {}, h('p', {}, loc(m.desc)), dl)),
      h('p.ps-foot', {}, t('about.p1')),
    );
    const img = sheet.querySelector('img')!;
    const go = () => setTimeout(() => print(), 50);
    if (img.complete) go();
    else img.addEventListener('load', go, { once: true });
  }

  /** Re-render text after a language change. */
  relocalise() {
    if (this.state === 'closed' || !this.m) return;
    const keepTab = this.tab;
    const space = this.space;
    this.space = null;
    this.build();
    if (space) {
      space.dispose();
      this.spaceLoading = null;
    }
    this.setTab(keepTab, false);
    if (keepTab === 'space') this.ensureSpace();
  }
}
