import { bySlug, loc, parseFormat, texUrl, type Material } from '../data/materials';
import { selection, toggleSelected, type SelItem } from '../state';
import { t, tn, type Key } from '../i18n';
import { h, svgIcon } from '../lib/dom';
import { announce, toast } from './live';

type Step = 'list' | 'form' | 'ok';

/** Field named in each link of the error summary, so identical messages stay distinguishable (WCAG 2.4.4). */
const FIELD_NAME: Record<string, Key> = { 'rq-name': 'form.name', 'rq-email': 'form.email', 'rq-project': 'form.project', 'rq-privacy': 'form.privacy.short' };

export class SelectionUI {
  onOpenMaterial: (m: Material) => void = () => {};
  private step: Step = 'list';
  private ref = '';

  constructor(private dlg: HTMLDialogElement, private badge: HTMLElement) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener('close', () => (this.step = 'list'));
    selection.sub(() => {
      this.syncBadge();
      if (dlg.open && this.step === 'list') this.render();
    });
    this.syncBadge();
  }

  open(step: Step = 'list') {
    this.step = selection.get().length ? step : 'list';
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
    this.focusFirst();
  }

  private focusFirst() {
    const target = this.dlg.querySelector<HTMLElement>(this.step === 'form' ? '#rq-name' : this.step === 'ok' ? '.ok h3' : '.dlg-head button');
    target?.focus();
  }

  private syncBadge() {
    const n = selection.get().length;
    this.badge.hidden = n === 0;
    this.badge.textContent = String(n);
    this.badge.setAttribute('aria-label', tn('sel.count', n));
  }

  render() {
    const items = selection.get();
    const close = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('sel.close'), onclick: () => this.dlg.close() }, svgIcon('close'));
    const title = this.step === 'list' ? t('sel.title') : t('form.title');
    const head = h('div.dlg-head', {},
      h('div', {}, h('p.eyebrow', {}, tn('sel.count', items.length)), h('h2', { id: 'sel-title' }, title)), close);
    if (this.step === 'form') return this.dlg.replaceChildren(head, this.form());
    if (this.step === 'ok') return this.dlg.replaceChildren(head, this.success(items));

    if (!items.length) return this.dlg.replaceChildren(head, h('p.sel-empty', {}, t('sel.empty')));
    const list = h('ul.sel-list', { role: 'list' });
    for (const it of items) {
      const m = bySlug.get(it.slug)!;
      list.append(h('li.sel-item', {},
        h('button.open', { type: 'button', 'aria-label': t('index.open', { name: m.name }), onclick: () => { this.dlg.close(); this.onOpenMaterial(m); } },
          h('img', { src: texUrl('s', m.slug, 'c'), alt: '', width: 64, height: 64, loading: 'lazy' })),
        h('div', {}, h('b', {}, m.name), h('span', {}, `${loc(m.collection.name)} · ${t(`finish.${it.finish}` as Key)} · ${parseFormat(it.format).label}`)),
        h('button.btn.btn-icon.btn-ghost', { type: 'button', 'aria-label': t('sel.remove', { name: m.name }), onclick: () => {
          toggleSelected(it);
          announce(t('sel.removed', { name: m.name }));
          requestAnimationFrame(() => this.dlg.querySelector<HTMLElement>('.sel-item .btn, .dlg-head .btn')?.focus());
        } }, svgIcon('close'))));
    }
    const actions = h('div.sel-actions', {},
      h('button.btn.btn-primary.btn-block', { type: 'button', onclick: () => { this.step = 'form'; this.render(); this.focusFirst(); } }, svgIcon('sample', 16), t('sel.request')),
      h('div.row', {},
        h('button.btn', { type: 'button', onclick: () => this.share() }, svgIcon('link', 16), t('sel.share')),
        h('button.btn', { type: 'button', onclick: () => this.moodboard(items) }, svgIcon('download', 16), t('sel.download'))),
      h('button.btn.btn-ghost', { type: 'button', onclick: () => selection.set([]) }, t('sel.clear')),
    );
    this.dlg.replaceChildren(head, list, actions);
  }

  private share() {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('sel', selection.get().map((s) => `${s.slug}~${s.finish}~${s.format}`).join(','));
    const text = url.toString();
    const done = () => toast(t('sel.copied'));
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => prompt('', text));
    else prompt('', text);
  }

  private async moodboard(items: SelItem[]) {
    const W = 1800;
    const cols = items.length <= 4 ? items.length : items.length <= 9 ? 3 : 4;
    const rows = Math.ceil(items.length / cols);
    const pad = 90;
    const gap = 28;
    const cell = (W - pad * 2 - gap * (cols - 1)) / cols;
    const H = Math.round(pad * 2 + 120 + rows * (cell + 90) - 20);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    await document.fonts.ready;
    ctx.fillStyle = '#0e0d0c';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ede7de';
    ctx.font = '400 72px "Instrument Serif"';
    ctx.fillText(`VETA — ${t('sel.title')}`, pad, pad + 40);
    ctx.font = '500 18px "Geist Mono"';
    ctx.fillStyle = '#aaa298';
    ctx.fillText(new Date().toLocaleDateString(), W - pad - 200, pad + 40);
    const imgs = await Promise.all(items.map((it) => fetch(texUrl('g', it.slug, 'c')).then((r) => r.blob()).then((b) => createImageBitmap(b))));
    items.forEach((it, i) => {
      const m = bySlug.get(it.slug)!;
      const x = pad + (i % cols) * (cell + gap);
      const y = pad + 120 + Math.floor(i / cols) * (cell + 90);
      ctx.drawImage(imgs[i], x, y, cell, cell);
      ctx.fillStyle = '#ede7de';
      ctx.font = '400 34px "Instrument Serif"';
      ctx.fillText(m.name, x, y + cell + 40);
      ctx.fillStyle = '#aaa298';
      ctx.font = '500 15px "Geist Mono"';
      ctx.fillText(`${m.code} · ${t(`finish.${it.finish}` as Key).toUpperCase()} · ${parseFormat(it.format).label}`, x, y + cell + 66);
    });
    imgs.forEach((b) => b.close());
    c.toBlob((blob) => {
      if (!blob) return;
      const a = h('a', { href: URL.createObjectURL(blob), download: 'veta-moodboard.png' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  private form() {
    const field = (id: string, label: string, input: HTMLElement, optional = false) => {
      const err = h('p.err', { id: `${id}-err`, hidden: true });
      input.id = id;
      input.setAttribute('aria-describedby', `${id}-err`);
      return h('div.field', {}, h('label', { for: id }, label, optional ? h('span.opt', {}, ` (${t('form.optional')})`) : null), input, err);
    };
    // No role=alert: the summary receives focus and NVDA reads it in full; with both,
    // it was announced twice.
    const summary = h('div.err-summary', { tabindex: -1, hidden: true });
    const name = h('input', { name: 'name', autocomplete: 'name', required: true });
    const email = h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true, inputmode: 'email' });
    const studio = h('input', { name: 'studio', autocomplete: 'organization' });
    const role = h('select', { name: 'role' }, ...(['arq', 'int', 'con', 'par'] as const).map((r) => h('option', { value: r }, t(`form.role.${r}` as Key))));
    const project = h('input', { name: 'project', required: true });
    const privacy = h('input', { type: 'checkbox', id: 'rq-privacy', name: 'privacy', required: true, 'aria-describedby': 'rq-privacy-err' });
    const form = h('form.request', { novalidate: true },
      h('p.note', {}, t('form.intro')),
      summary,
      field('rq-name', t('form.name'), name),
      field('rq-email', t('form.email'), email),
      field('rq-studio', t('form.studio'), studio, true),
      field('rq-role', t('form.role'), role),
      field('rq-project', t('form.project'), project),
      h('div.field', {}, h('label.check', { for: 'rq-privacy' }, privacy, h('span', {}, t('form.privacy'))), h('p.err', { id: 'rq-privacy-err', hidden: true })),
      h('button.btn.btn-primary.btn-block', { type: 'submit' }, t('form.submit')),
      h('p.note', {}, t('form.demo')),
      h('button.btn.btn-ghost', { type: 'button', onclick: () => { this.step = 'list'; this.render(); this.focusFirst(); } }, svgIcon('arrow-left', 16), t('sel.back')),
    ) as HTMLFormElement;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const errors: Array<[HTMLElement, string]> = [];
      const check = (el: HTMLInputElement, msg: string, ok: boolean) => {
        const err = form.querySelector<HTMLElement>(`#${el.id}-err`)!;
        el.setAttribute('aria-invalid', String(!ok));
        err.hidden = ok;
        err.textContent = ok ? '' : msg;
        if (!ok) errors.push([el, msg]);
      };
      const n = name as HTMLInputElement;
      const em = email as HTMLInputElement;
      const pr = project as HTMLInputElement;
      const pv = privacy as HTMLInputElement;
      check(n, t('form.err.required'), n.value.trim().length > 1);
      check(em, em.value.trim() ? t('form.err.email') : t('form.err.required'), /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em.value.trim()));
      check(pr, t('form.err.required'), pr.value.trim().length > 1);
      check(pv, t('form.err.privacy'), pv.checked);
      if (errors.length) {
        summary.hidden = false;
        summary.replaceChildren(h('p', {}, t('form.err.summary', { n: errors.length })),
          h('ul', {}, ...errors.map(([el, msg]) => h('li', {}, h('a', { href: `#${el.id}`, onclick: (ev: Event) => { ev.preventDefault(); el.focus(); } }, `${t(FIELD_NAME[el.id])}: ${msg}`)))));
        summary.focus();
        return;
      }
      this.ref = `VT-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      this.step = 'ok';
      this.render();
      this.focusFirst();
    });
    return form;
  }

  private success(items: SelItem[]) {
    return h('div.ok', { role: 'status' },
      h('h3', { tabindex: -1 }, t('form.ok.title')),
      h('p', {}, t('form.ok.body', { n: items.length, ref: '' }), h('code', {}, this.ref)),
      h('p.note', {}, t('form.demo')),
      h('button.btn.btn-primary', { type: 'button', onclick: () => this.dlg.close() }, t('form.ok.done')),
    );
  }
}
