import { materials, matches, facetIds, facetOptions, optionLabel, filterCount, emptyFilters, type FacetId, type Filters } from '../data/materials';
import { filters, toggleFilter } from '../state';
import { t, tn, type Key } from '../i18n';
import { h, svgIcon } from '../lib/dom';

const FACET_LABEL: Record<FacetId, Key> = {
  collection: 'filters.collection', tone: 'filters.tone', temp: 'filters.temp',
  finish: 'filters.finish', use: 'filters.use', format: 'filters.format',
};

function countWith(f: Filters, facet: FacetId, opt: string) {
  const probe = { ...f, [facet]: new Set([opt]) } as Filters;
  return materials.reduce((n, m) => n + (matches(m, probe) ? 1 : 0), 0);
}

export class FiltersUI {
  private body!: HTMLElement;
  private showBtn!: HTMLButtonElement;
  private empty!: HTMLElement;

  constructor(private dlg: HTMLDialogElement, private bar: HTMLElement, private badge: HTMLElement) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    filters.sub(() => this.sync());
    this.build();
    this.sync();
  }

  open() {
    this.build();
    this.sync();
    this.dlg.showModal();
  }

  build() {
    const close = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('filters.close'), onclick: () => this.dlg.close() }, svgIcon('close'));
    this.body = h('div.facets');
    for (const facet of facetIds) {
      const legendId = `fl-${facet}`;
      const chips = h('div.chips');
      for (const opt of facetOptions[facet]) {
        chips.append(h('button.chip', { type: 'button', 'data-facet': facet, 'data-opt': opt, 'aria-pressed': 'false', onclick: () => toggleFilter(facet, opt) },
          h('span', {}, optionLabel(facet, opt)), h('span.n', { 'aria-hidden': 'true' })));
      }
      this.body.append(h('fieldset.facet', { 'aria-labelledby': legendId }, h('legend.eyebrow', { id: legendId }, t(FACET_LABEL[facet])), chips));
    }
    this.empty = h('p.f-empty', { role: 'status', hidden: true }, t('filters.none'));
    this.showBtn = h('button.btn.btn-primary', { type: 'button', onclick: () => this.dlg.close() }) as HTMLButtonElement;
    const clear = h('button.btn.btn-ghost', { type: 'button', onclick: () => filters.set(emptyFilters()) }, t('filters.clear'));
    this.dlg.replaceChildren(
      h('div.dlg-head', {}, h('h2', { id: 'f-title' }, t('filters.title')), close),
      this.body,
      this.empty,
      h('div.dlg-foot', {}, clear, this.showBtn),
    );
  }

  private sync() {
    const f = filters.get();
    const n = materials.filter((m) => matches(m, f)).length;
    this.body.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
      const facet = chip.dataset.facet as FacetId;
      const opt = chip.dataset.opt!;
      const on = f[facet].has(opt);
      chip.setAttribute('aria-pressed', String(on));
      const c = countWith(f, facet, opt);
      chip.querySelector('.n')!.textContent = String(c);
      chip.dataset.zero = String(c === 0 && !on);
      chip.setAttribute('aria-label', `${optionLabel(facet, opt)} (${c})`);
    });
    this.empty.hidden = n > 0;
    this.showBtn.textContent = tn('filters.show', n);
    this.showBtn.toggleAttribute('disabled', n === 0);
    const active = filterCount(f);
    this.badge.hidden = active === 0;
    this.badge.textContent = String(active);
    this.badge.setAttribute('aria-label', t('filters.active', { n: active }));
    this.renderBar(f);
  }

  private renderBar(f: Filters) {
    const pills: HTMLElement[] = [];
    for (const facet of facetIds)
      for (const opt of f[facet]) {
        const name = optionLabel(facet, opt);
        pills.push(h('button.pill', { type: 'button', 'aria-label': t('filters.remove', { name }), onclick: () => toggleFilter(facet, opt) }, name, svgIcon('close', 14)));
      }
    this.bar.replaceChildren(...pills);
    this.bar.hidden = pills.length === 0;
  }
}
