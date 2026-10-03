import type { Atlas } from '../atlas/atlas';
import { materials } from '../data/materials';

/** Tone map of the repeating block, with the viewport drawn on top. */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private px = 9;
  private raf = 0;
  private mark = -1;

  constructor(private canvas: HTMLCanvasElement, hit: HTMLElement, private atlas: Atlas) {
    this.ctx = canvas.getContext('2d')!;
    atlas.onCamera = () => this.schedule();
    atlas.onHover = (m) => {
      this.mark = m ? this.atlas.layout.order.indexOf(m.index) : -1;
      this.schedule();
    };
    let dragging = false;
    const go = (e: PointerEvent, instant: boolean) => {
      const r = this.canvas.getBoundingClientRect();
      const { W, H, order } = this.atlas.layout;
      const c = Math.floor(((e.clientX - r.left) / r.width) * W);
      const rr = Math.floor(((e.clientY - r.top) / r.height) * H);
      const k = rr * W + c;
      if (c < 0 || c >= W || rr < 0 || k >= order.length) return;
      const cell = this.atlas.nearestCell(materials[order[k]]);
      if (cell) this.atlas.flyTo(cell, { instant });
    };
    hit.addEventListener('pointerdown', (e) => {
      dragging = true;
      hit.setPointerCapture(e.pointerId);
      go(e, false);
    });
    hit.addEventListener('pointermove', (e) => dragging && go(e, true));
    hit.addEventListener('pointerup', () => (dragging = false));
    hit.addEventListener('pointercancel', () => (dragging = false));
    addEventListener('resize', () => this.layout());
  }

  layout() {
    const { W, H } = this.atlas.layout;
    const small = innerWidth < 720;
    const maxW = small ? 78 : 112;
    const maxH = small ? 52 : 72;
    this.px = Math.max(4, Math.min(small ? 14 : 20, Math.floor(maxW / W), Math.floor(maxH / H)));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = W * this.px * dpr;
    this.canvas.height = H * this.px * dpr;
    this.canvas.style.width = `${W * this.px}px`;
    this.canvas.style.height = `${H * this.px}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    const { W, H, order } = this.atlas.layout;
    const N = order.length;
    if (!N) return;
    const ctx = this.ctx;
    const p = this.px;
    ctx.clearRect(0, 0, W * p, H * p);
    order.forEach((mi, k) => {
      ctx.fillStyle = materials[mi].hex;
      ctx.fillRect((k % W) * p + 0.5, Math.floor(k / W) * p + 0.5, p - 1, p - 1);
    });
    // viewport in block coordinates (wrapping)
    const a = this.atlas;
    const ci = Math.floor(a.cx);
    const cj = Math.floor(a.cy);
    const pos = (((ci + cj * W) % N) + N) % N;
    const bx = (pos % W) + (a.cx - ci);
    const by = Math.floor(pos / W) + (a.cy - cj);
    const vw = Math.min(W, a.vw / a.S);
    const vh = Math.min(H, a.vh / a.S);
    ctx.strokeStyle = 'rgba(237,231,222,0.95)';
    ctx.lineWidth = 1.5;
    for (const ox of [-W, 0, W])
      for (const oy of [-H, 0, H]) ctx.strokeRect((bx - vw / 2 + ox) * p, (by - vh / 2 + oy) * p, vw * p, vh * p);
    if (this.mark >= 0) {
      // the hovered surface, located on the tone map
      ctx.strokeStyle = '#e07a4f';
      ctx.lineWidth = 2;
      ctx.strokeRect((this.mark % W) * p - 1, Math.floor(this.mark / W) * p - 1, p + 1, p + 1);
    }
  }
}
