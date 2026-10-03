import { materials, loc, normalise, texUrl, type Material } from '../data/materials';
import { t, type Key } from '../i18n';
import { h, svgIcon } from '../lib/dom';
import { announce } from './live';

export class SearchUI {
  onChoose: (m: Material) => void = () => {};
  getOrder: () => number[] = () => materials.map((m) => m.index);
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private results: Material[] = [];
  private active = 0;

  constructor(private dlg: HTMLDialogElement) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    this.build();
  }

  build() {
    this.input = h('input', {
      id: 's-input', type: 'search', role: 'combobox', autocomplete: 'off', spellcheck: 'false',
      'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': 's-list', 'aria-labelledby': 's-label',
      placeholder: t('search.placeholder'), enterkeyhint: 'go',
    }) as HTMLInputElement;
    this.list = h('ul.s-list', { id: 's-list', role: 'listbox', 'aria-labelledby': 's-label' });
    const close = h('button.btn.btn-icon.btn-ghost', { type: 'button', 'aria-label': t('search.close'), onclick: () => this.dlg.close() }, svgIcon('close'));
    this.dlg.replaceChildren(
      h('label', { id: 's-label', for: 's-input', class: 'sr-only' }, t('search.label')),
      h('div.s-field', {}, svgIcon('search', 22), this.input, close),
      this.list,
      h('p.s-hint', { 'aria-hidden': 'true' }, t('search.hint')),
    );
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.results.length) return;
        this.setActive((this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.results.length) % this.results.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const m = this.results[this.active];
        if (m) this.choose(m);
      }
    });
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (li) this.choose(this.results[Number(li.dataset.i)]);
    });
  }

  open() {
    this.input.value = '';
    this.run();
    this.dlg.showModal();
    this.input.focus();
  }

  private choose(m: Material) {
    this.dlg.close();
    this.onChoose(m);
  }

  private run() {
    const q = normalise(this.input.value.trim());
    const tokens = q.split(/\s+/).filter(Boolean);
    const order = this.getOrder();
    const pool = order.map((i) => materials[i]);
    const extra = materials.filter((m) => !order.includes(m.index));
    let res = [...pool, ...extra].filter((m) => tokens.every((tk) => m.search.includes(tk)));
    if (tokens.length) {
      const score = (m: Material) => {
        const n = normalise(m.name);
        return n.startsWith(q) ? 0 : n.includes(q) ? 1 : tokens.every((tk) => n.includes(tk)) ? 2 : 3;
      };
      res = res.map((m, i) => ({ m, s: score(m) * 1000 + i })).sort((a, b) => a.s - b.s).map((x) => x.m);
    }
    this.results = res;
    this.list.replaceChildren(
      ...res.map((m, i) =>
        h('li.s-opt', { role: 'option', id: `s-opt-${i}`, 'data-i': i, 'aria-selected': 'false' },
          h('img', { src: texUrl('s', m.slug, 'c'), alt: '', width: 44, height: 44, loading: 'lazy', decoding: 'async' }),
          h('div', {}, h('b', {}, m.name), h('span', {}, `${loc(m.collection.name)} · ${m.finishes.map((f) => t(`finish.${f}` as Key)).join(' / ')}`)),
          h('code', {}, m.code)),
      ),
    );
    if (!res.length) this.list.append(h('li.s-empty', { role: 'presentation' }, t('search.empty', { q: this.input.value.trim() })));
    this.setActive(0);
    if (tokens.length) announce(t('search.results', { n: res.length }), 350);
  }

  private setActive(i: number) {
    this.active = i;
    const opts = this.list.querySelectorAll<HTMLElement>('[role="option"]');
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === i)));
    const cur = opts[i];
    if (cur) {
      this.input.setAttribute('aria-activedescendant', cur.id);
      cur.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }
}
