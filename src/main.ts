import './styles/main.css';
import { applyI18n, t, tn, onLang, lang, type Key } from './i18n';
import { materials, matches, bySlug, emptyFilters, loc, parseFormat, texUrl, type Material, type Finish } from './data/materials';
import { filters, selection, reducedMotion, singleKeys, view, writeQuery, upsertSelected, isSelected, type View } from './state';
import { Renderer } from './gl/renderer';
import { Atlas } from './atlas/atlas';
import { Detail, type OpenCtx } from './ui/detail';
import { FiltersUI } from './ui/filters';
import { SearchUI } from './ui/search';
import { SelectionUI } from './ui/selection';
import { IndexView } from './ui/indexView';
import { Minimap } from './ui/minimap';
import { AboutUI } from './ui/about';
import { announce, toast } from './ui/live';
import { $, $$, h, svgIcon, finePointer } from './lib/dom';

const body = document.body;
document.documentElement.lang = lang();
document.title = t('meta.title');
applyI18n();
const syncMotion = () => (document.documentElement.dataset.motion = reducedMotion.get() ? 'reduce' : 'full');
syncMotion();
reducedMotion.sub(syncMotion);

/* ---------------------------------------------------------------- quality tiers */

const dpr = Math.min(devicePixelRatio || 1, 2);
const baseCell = Math.min(300, Math.max(120, Math.min(innerWidth, innerHeight * 1.3) / 4.4));
const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
const lite = !!conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '');
const gridTier = !lite && baseCell * dpr > 310 ? 'g' : 's';
const detailTier = !lite && Math.max(innerWidth, innerHeight) * dpr > 1700 ? 'd' : 'm';

/* ---------------------------------------------------------------- core */

const canvas = $<HTMLCanvasElement>('#gl');
let renderer: Renderer;
try {
  renderer = new Renderer(canvas, gridTier, detailTier);
} catch (e) {
  console.warn(e);
  fallback();
  throw e;
}

const atlas = new Atlas(renderer, canvas, $('#atlas'));
if (import.meta.env.DEV) (window as unknown as { __atlas: Atlas }).__atlas = atlas;
const detail = new Detail($<HTMLDialogElement>('#detail'), atlas);
const filtersUI = new FiltersUI($<HTMLDialogElement>('#filters'), $('#active-filters'), $('#filter-badge'));
const search = new SearchUI($<HTMLDialogElement>('#search'));
const selUI = new SelectionUI($<HTMLDialogElement>('#selection'), $('#sel-badge'));
const about = new AboutUI($<HTMLDialogElement>('#about'));
const index = new IndexView($('#index'), $('#cards'), $('#index-count'), $<HTMLSelectElement>('#index-sort'));
const minimap = new Minimap($<HTMLCanvasElement>('#map-canvas'), $('#map-hit'), atlas);

let list = materials.filter((m) => matches(m, filters.get()));
if (!list.length) {
  filters.set(emptyFilters());
  list = [...materials];
}
atlas.setList(list, false);
index.set(list, atlas.layout.order);
minimap.layout();

const countEl = $('#count');
const updateCount = () => (countEl.textContent = tn('atlas.count', list.length));
updateCount();

/* ---------------------------------------------------------------- state wiring */

filters.sub(() => {
  const next = materials.filter((m) => matches(m, filters.get()));
  if (!next.length) {
    announce(t('filters.none'));
    return;
  }
  list = next;
  atlas.setList(list, true);
  index.set(list, atlas.layout.order);
  minimap.layout();
  updateCount();
  announce(t('filters.results', { n: list.length }), 500);
});

const syncSelected = () => {
  renderer.setSelected(materials.map((m) => isSelected(m.slug)));
  // the dot drawn on the canvas also goes into each cell's name
  atlas.relabel();
  atlas.invalidate();
};
selection.sub(syncSelected);
syncSelected();

/* ---------------------------------------------------------------- views */

const btnAtlas = $('#view-atlas');
const btnIndex = $('#view-index');

function setView(v: View, focus = true) {
  if (view.get() === v) return;
  view.set(v);
  body.dataset.view = v;
  btnAtlas.setAttribute('aria-pressed', String(v === 'atlas'));
  btnIndex.setAttribute('aria-pressed', String(v === 'index'));
  $('#index').hidden = v !== 'index';
  $('#atlas').hidden = v !== 'atlas';
  atlas.showGrid = v === 'atlas';
  atlas.interactive = v === 'atlas';
  atlas.invalidate();
  if (v === 'index') {
    index.render();
    scrollTo(0, 0);
    if (focus) $('#index').focus({ preventScroll: true });
  }
}
btnAtlas.addEventListener('click', () => setView('atlas'));
btnIndex.addEventListener('click', () => setView('index'));
$('.skip').addEventListener('click', (e) => {
  e.preventDefault();
  setView('index');
});

/* ---------------------------------------------------------------- detail + routing */

function openDetail(m: Material, ctx: OpenCtx) {
  detail.getSequence = () => (view.get() === 'index' ? index.order : atlas.layout.order);
  detail.open(m, ctx);
  if (!location.hash.startsWith('#/s/')) {
    history.pushState({ detail: true }, '', `#/s/${m.slug}`);
    detail.pushed = true;
  } else if (location.hash !== `#/s/${m.slug}`) history.replaceState(history.state, '', `#/s/${m.slug}`);
}

atlas.onOpen = (m, rect, cell) => openDetail(m, { from: 'atlas', rect, cell });
index.onOpen = (m, r) => openDetail(m, { from: 'index', rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
detail.onSample = () => selUI.open('form');
detail.onClosed = (_m, ctx) => {
  if (location.hash.startsWith('#/s/')) history.replaceState(history.state, '', location.pathname + location.search);
  // keyboard users land on the surface they were last looking at
  if (ctx.cell && document.activeElement?.classList.contains('gc')) atlas.focusWorld(ctx.cell, true, false);
};
selUI.onOpenMaterial = (m) => openDetail(m, { from: 'route' });

function routeFromHash() {
  const slug = location.hash.match(/^#\/s\/([\w-]+)/)?.[1];
  const m = slug ? bySlug.get(slug) : undefined;
  if (m && !detail.isOpen) {
    if (!list.includes(m)) filters.set(emptyFilters());
    detail.pushed = false;
    detail.open(m, { from: 'route' });
  } else if (m && detail.m !== m) detail.open(m, { from: 'route' });
  else if (!m && detail.isOpen) detail.close();
}
addEventListener('popstate', routeFromHash);
addEventListener('hashchange', routeFromHash);

/* ---------------------------------------------------------------- search, filters, selection */

search.getOrder = () => (view.get() === 'index' ? index.order : atlas.layout.order);
search.onChoose = (m) => {
  if (!matches(m, filters.get())) filters.set(emptyFilters());
  if (view.get() === 'index') {
    const btn = document.querySelector<HTMLElement>(`.card[data-slug="${m.slug}"] button`);
    btn?.scrollIntoView({ block: 'center', behavior: reducedMotion.get() ? 'auto' : 'smooth' });
    btn?.focus({ preventScroll: true });
    return;
  }
  const cell = atlas.nearestCell(m);
  if (!cell) return;
  atlas.flyTo(cell);
  atlas.focusWorld(cell, true, false);
  setTimeout(() => atlas.pulse(cell), reducedMotion.get() ? 0 : 650);
  announce(t('atlas.flyto', { name: m.name }), 400);
};

$('#open-search').addEventListener('click', () => search.open());
$('#open-filters').addEventListener('click', () => filtersUI.open());
$('#open-selection').addEventListener('click', () => selUI.open());
$('#open-about').addEventListener('click', () => about.open());
$('#zoom-in').addEventListener('click', () => atlas.zoomBy(1.3));
$('#zoom-out').addEventListener('click', () => atlas.zoomBy(1 / 1.3));
$('#zoom-reset').addEventListener('click', () => atlas.resetView());

// shared selection links: ?sel=slug~finish~format,…
const shared = new URLSearchParams(location.search).get('sel');
if (shared) {
  let n = 0;
  for (const part of shared.split(',')) {
    const [slug, finish, format] = part.split('~');
    const m = bySlug.get(slug);
    if (!m) continue;
    upsertSelected({ slug, finish: (m.finishes.includes(finish as Finish) ? finish : m.defaultFinish) as Finish, format: m.formats.includes(format) ? format : m.defaultFormat });
    n++;
  }
  writeQuery((q) => q.delete('sel'));
  if (n) setTimeout(() => toast(t('sel.loaded', { n })), 1800);
}

/* ---------------------------------------------------------------- host badge */

// Netlify may inject its «Powered by Netlify» badge: a fixed iframe in the bottom-right corner,
// above everything. While it is there the dock lifts its zoom buttons out of its way (WCAG 2.4.11).
const HOST_BADGE = '#nl-badge-frame, #nl-hud-frame';
const syncHostBadge = () => body.toggleAttribute('data-host-badge', !!document.querySelector(HOST_BADGE));
new MutationObserver(syncHostBadge).observe(body, { childList: true });
syncHostBadge();

/* ---------------------------------------------------------------- keyboard */

/** Zoom keys that belong to the atlas itself (kept, while it has focus, when single-key shortcuts are off). */
const ATLAS_KEYS = ['+', '=', '-', '_', '0'];

// aria-keyshortcuts and the visible «/» only announce what is active
const keyHints = $$<HTMLElement>('[aria-keyshortcuts]').map((el) => [el, el.getAttribute('aria-keyshortcuts')!] as const);
const syncKeyHints = () => {
  const on = singleKeys.get();
  for (const [el, all] of keyHints) {
    const keep = on ? all : all.split(' ').filter((k) => k.length > 1 && k.includes('+')).join(' ');
    if (keep) el.setAttribute('aria-keyshortcuts', keep);
    else el.removeAttribute('aria-keyshortcuts');
  }
  $('.btn-search kbd').hidden = !on;
};
syncKeyHints();
singleKeys.sub(syncKeyHints);

addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  const typing = el.closest('input, textarea, select, [contenteditable="true"]');
  const dialogOpen = document.querySelector('dialog[open]');
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (!$<HTMLDialogElement>('#search').open && !detail.isOpen) search.open();
    return;
  }
  if (typing || dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return;
  // WCAG 2.1.4: single characters only act everywhere while the shortcuts are on
  // («Proyecto» → «Atajos de una tecla»); when off, zoom keys still work inside the focused atlas
  if (!singleKeys.get() && e.key.length === 1 && !(ATLAS_KEYS.includes(e.key) && el.closest('#atlas-grid'))) return;
  const inAtlas = view.get() === 'atlas';
  switch (e.key) {
    case '/':
      e.preventDefault();
      search.open();
      break;
    case 'f':
    case 'F':
      filtersUI.open();
      break;
    case 'i':
    case 'I':
      setView(view.get() === 'atlas' ? 'index' : 'atlas');
      break;
    case '?':
      about.open();
      break;
    case '+':
    case '=':
      if (inAtlas) atlas.zoomBy(1.3);
      break;
    case '-':
    case '_':
      if (inAtlas) atlas.zoomBy(1 / 1.3);
      break;
    case '0':
      if (inAtlas) atlas.resetView();
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
      if (inAtlas && (el === body || el === document.documentElement)) {
        e.preventDefault();
        atlas.focusGrid();
      }
      break;
  }
});

/* ---------------------------------------------------------------- language */

onLang(() => {
  applyI18n();
  filtersUI.build();
  search.build();
  if ($<HTMLDialogElement>('#selection').open) selUI.render();
  index.render();
  atlas.relabel();
  detail.relocalise();
  updateCount();
  setHint();
});

/* ---------------------------------------------------------------- hint */

const hint = $('#hint');
const setHint = () => (hint.textContent = finePointer() ? t('atlas.hint.mouse') : t('atlas.hint.touch'));
setHint();
const hideHint = () => setTimeout(() => (hint.dataset.hide = 'true'), 1800);
canvas.addEventListener('pointerdown', hideHint, { once: true });
canvas.addEventListener('wheel', hideHint, { once: true, passive: true });

/* ---------------------------------------------------------------- intro */

const intro = $('#intro');
const introN = $('#intro-n');
const t0 = performance.now();
const fontsReady = document.fonts?.ready ?? Promise.resolve();
let fontsOk = false;
fontsReady.then(() => (fontsOk = true));
// let the critical fonts win the network race, then stream the swatches
let texturesStarted = false;
const startTextures = () => {
  if (texturesStarted) return;
  texturesStarted = true;
  renderer.bank.load(atlas.visiblePriority());
};
fontsReady.then(() => requestAnimationFrame(() => setTimeout(startTextures, 220)));
setTimeout(startTextures, 900);

function introTick() {
  const loaded = renderer.bank.loadedColor.size;
  introN.textContent = String(loaded).padStart(2, '0');
  const elapsed = performance.now() - t0;
  const ready = fontsOk && loaded >= Math.min(atlas.visibleCount, materials.length);
  if ((ready && elapsed > (reducedMotion.get() ? 200 : 1300)) || elapsed > 5000) reveal();
  else requestAnimationFrame(introTick);
}
requestAnimationFrame(introTick);

function reveal() {
  intro.dataset.out = 'true';
  atlas.intro();
  setTimeout(() => {
    intro.remove();
    if (location.hash.startsWith('#/s/')) routeFromHash();
  }, reducedMotion.get() ? 420 : 1100);
}

/* ---------------------------------------------------------------- no WebGL 2 */

function fallback() {
  body.dataset.view = 'index';
  $('#intro')?.remove();
  $('#atlas').hidden = true;
  $('#index').hidden = false;
  $('#view-atlas').setAttribute('disabled', '');
  $('#view-atlas').setAttribute('aria-pressed', 'false');
  $('#view-index').setAttribute('aria-pressed', 'true');
  const fallbackIndex = new IndexView($('#index'), $('#cards'), $('#index-count'), $<HTMLSelectElement>('#index-sort'));
  fallbackIndex.set(materials, materials.map((m) => m.index));
  fallbackIndex.render();
  // static detail: same content, no WebGL
  const dlg = $<HTMLDialogElement>('#detail');
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  fallbackIndex.onOpen = (m) => {
    const close = h('button.btn.btn-icon', { type: 'button', 'aria-label': t('detail.close'), onclick: () => dlg.close() }, svgIcon('close'));
    const row = (k: Key, v: string) => [h('dt', {}, t(k)), h('dd', {}, v)];
    dlg.replaceChildren(h('div.d-wrap', {},
      h('div.d-viewer', {}, h('img', { src: texUrl('m', m.slug, 'c'), alt: '', style: 'width:100%;height:100%;object-fit:cover' })),
      h('div.d-panel', {}, h('div.d-panel-inner', {},
        h('div.d-head', {}, h('p.eyebrow', {}, `${loc(m.collection.name)} · ${m.code}`), close),
        h('div.d-title', {}, h('h2', { id: 'd-name' }, m.name), h('p', {}, loc(m.desc))),
        h('dl.specs', {},
          ...row('spec.finish', m.finishes.map((f) => t(`finish.${f}` as Key)).join(', ')),
          ...row('spec.format', m.formats.map((f) => `${parseFormat(f).label} cm`).join(' · ')),
          ...row('spec.variation', t(`variation.${m.collection.variation}` as Key)),
          ...row('spec.absorption', t('spec.absorption.value')),
          ...row('spec.uses', m.uses.map((u) => t(`use.${u}` as Key)).join(', ')))))));
    dlg.showModal();
  };
  toast(t('atlas.fallback'));
}
