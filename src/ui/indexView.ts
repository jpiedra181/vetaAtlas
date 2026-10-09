import { loc, texUrl, type Material } from '../data/materials';
import { isSelected, selection } from '../state';
import { t, tn, type Key } from '../i18n';
import { h } from '../lib/dom';

export type Sort = 'tone' | 'name' | 'collection';

/** Button name: the selection dot on the card is said too (WCAG 1.3.1). */
const cardLabel = (m: Material) => t('index.open', { name: m.name }) + (isSelected(m.slug) ? `, ${t('detail.added').toLowerCase()}` : '');

export class IndexView {
  onOpen: (m: Material, rect: DOMRect) => void = () => {};
  sort: Sort = 'tone';
  private list: Material[] = [];
  private toneOrder: number[] = [];
  order: number[] = [];

  constructor(private root: HTMLElement, private cards: HTMLElement, private count: HTMLElement, select: HTMLSelectElement) {
    select.addEventListener('change', () => {
      this.sort = select.value as Sort;
      this.render();
    });
    cards.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.card button');
      if (!btn) return;
      const li = btn.closest<HTMLElement>('.card')!;
      const m = this.list.find((x) => x.slug === li.dataset.slug)!;
      this.onOpen(m, li.querySelector('.img')!.getBoundingClientRect());
    });
    selection.sub(() => this.syncDots());
  }

  set(list: Material[], toneOrder: number[]) {
    this.list = list;
    this.toneOrder = toneOrder;
    if (!this.root.hidden) this.render();
  }

  render() {
    const by = this.sort;
    const sorted = [...this.list];
    if (by === 'tone') sorted.sort((a, b) => this.toneOrder.indexOf(a.index) - this.toneOrder.indexOf(b.index));
    else if (by === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else sorted.sort((a, b) => a.collection.id.localeCompare(b.collection.id) || b.L - a.L);
    this.order = sorted.map((m) => m.index);
    this.count.textContent = tn('atlas.count', sorted.length);
    this.cards.replaceChildren(
      ...sorted.map((m) =>
        h('li.card', { 'data-slug': m.slug },
          h('button', { type: 'button', 'aria-label': cardLabel(m) },
            h('div.img', {},
              h('img', { src: texUrl('s', m.slug, 'c'), alt: '', width: 256, height: 256, loading: 'lazy', decoding: 'async' }),
              isSelected(m.slug) ? h('span.dot', { 'aria-hidden': 'true' }) : null),
            h('div', {}, h('b', {}, m.name), h('span', {}, `${loc(m.collection.name)} · ${m.finishes.map((f) => t(`finish.${f}` as Key)).join(' / ')}`))),
        ),
      ),
    );
  }

  private syncDots() {
    if (this.root.hidden) return;
    this.cards.querySelectorAll<HTMLElement>('.card').forEach((li) => {
      const on = isSelected(li.dataset.slug!);
      const img = li.querySelector('.img')!;
      const dot = img.querySelector('.dot');
      if (on && !dot) img.append(h('span.dot', { 'aria-hidden': 'true' }));
      else if (!on && dot) dot.remove();
      const m = this.list.find((x) => x.slug === li.dataset.slug);
      if (m) li.querySelector('button')!.setAttribute('aria-label', cardLabel(m));
    });
  }
}
