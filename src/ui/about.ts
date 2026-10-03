import { t, lang, setLang, type Key } from '../i18n';
import { reducedMotion, setReducedMotion } from '../state';
import { h, svgIcon } from '../lib/dom';

export class AboutUI {
  constructor(private dlg: HTMLDialogElement) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    reducedMotion.sub(() => this.dlg.open && this.render());
  }

  open() {
    this.render();
    this.dlg.showModal();
  }

  render() {
    const close = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('about.close'), onclick: () => this.dlg.close() }, svgIcon('close'));
    const langBtn = h('button.btn', { type: 'button', lang: lang() === 'es' ? 'en' : 'es', 'aria-label': t('nav.lang.label'), onclick: () => {
      setLang(lang() === 'es' ? 'en' : 'es');
      this.render();
      this.dlg.querySelector<HTMLElement>('.toggle-row .btn')?.focus();
    } }, t('nav.lang'));
    const motionBtn = h('button.btn', { type: 'button', 'aria-pressed': String(reducedMotion.get()), onclick: () => setReducedMotion(!reducedMotion.get()) },
      reducedMotion.get() ? svgIcon('check', 16) : null, t('nav.motion'));
    const keys: Array<[string[], Key]> = [
      [['/', 'Ctrl K'], 'kbd.search'],
      [['F'], 'kbd.filters'],
      [['I'], 'kbd.index'],
      [['+', '−'], 'kbd.zoom'],
      [['←', '↑', '→', '↓'], 'kbd.arrows'],
      [['Intro'], 'kbd.open'],
      [['Esc'], 'kbd.close'],
    ];
    const kbd = h('dl.kbd-list', {}, ...keys.flatMap(([ks, label]) => [
      h('dt', {}, ...ks.map((k) => h('kbd.k', {}, k === 'Intro' && lang() === 'en' ? 'Enter' : k))),
      h('dd', {}, t(label)),
    ]));
    this.dlg.replaceChildren(
      h('div.dlg-head', {}, h('div', {}, h('p.eyebrow', {}, 'VETA'), h('h2', { id: 'about-title' }, t('about.title'))), close),
      h('div.about-body', {},
        h('p', {}, t('about.p1')),
        h('p', {}, t('about.p2')),
        h('p', {}, t('about.p3')),
        h('div.toggle-row', {}, langBtn, motionBtn),
        h('h3', { id: 'kbd-title' }, t('about.shortcuts')),
        kbd,
        h('h3', {}, t('about.credits')),
        h('ul', {}, h('li', {}, t('about.c1')), h('li', {}, t('about.c2')), h('li', {}, t('about.c3'))),
      ),
    );
  }
}
