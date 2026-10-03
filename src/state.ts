import { emptyFilters, facetIds, facetOptions, bySlug, type Filters, type Finish, type FacetId } from './data/materials';

type Listener = () => void;

function signal<T>(initial: T) {
  let value = initial;
  const subs = new Set<Listener>();
  return {
    get: () => value,
    set(v: T) {
      value = v;
      subs.forEach((fn) => fn());
    },
    sub(fn: Listener) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/* ---------- reduced motion (system preference + user override) ---------- */

const mq = matchMedia('(prefers-reduced-motion: reduce)');
const stored = (() => {
  try { return localStorage.getItem('veta:motion'); } catch { return null; }
})();
export const reducedMotion = signal<boolean>(stored ? stored === 'reduce' : mq.matches);
mq.addEventListener('change', () => {
  if (!stored) reducedMotion.set(mq.matches);
});
export function setReducedMotion(v: boolean) {
  try { localStorage.setItem('veta:motion', v ? 'reduce' : 'full'); } catch {}
  reducedMotion.set(v);
}

/* ---------- filters (synced with ?query) ---------- */

const QS: Record<FacetId, string> = { collection: 'c', tone: 't', temp: 'k', finish: 'f', use: 'u', format: 'x' };

function readFilters(): Filters {
  const f = emptyFilters();
  const q = new URLSearchParams(location.search);
  for (const id of facetIds) {
    const v = q.get(QS[id]);
    if (v) for (const opt of v.split(',')) if (facetOptions[id].includes(opt)) f[id].add(opt);
  }
  return f;
}

export const filters = signal<Filters>(readFilters());

export function writeQuery(mut: (q: URLSearchParams) => void) {
  const url = new URL(location.href);
  mut(url.searchParams);
  history.replaceState(history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
}

filters.sub(() => {
  const f = filters.get();
  writeQuery((q) => {
    for (const id of facetIds) {
      if (f[id].size) q.set(QS[id], [...f[id]].join(','));
      else q.delete(QS[id]);
    }
  });
});

export function toggleFilter(facet: FacetId, id: string) {
  const f = filters.get();
  const next = { ...f, [facet]: new Set(f[facet]) } as Filters;
  if (next[facet].has(id)) next[facet].delete(id);
  else next[facet].add(id);
  filters.set(next);
}

/* ---------- selection / moodboard ---------- */

export interface SelItem { slug: string; finish: Finish; format: string }

function readSelection(): SelItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem('veta:selection') ?? '[]') as SelItem[];
    return raw.filter((s) => bySlug.has(s.slug));
  } catch {
    return [];
  }
}

export const selection = signal<SelItem[]>(readSelection());
selection.sub(() => {
  try { localStorage.setItem('veta:selection', JSON.stringify(selection.get())); } catch {}
});

export const isSelected = (slug: string) => selection.get().some((s) => s.slug === slug);

export function toggleSelected(item: SelItem): boolean {
  const list = selection.get();
  if (list.some((s) => s.slug === item.slug)) {
    selection.set(list.filter((s) => s.slug !== item.slug));
    return false;
  }
  selection.set([...list, item]);
  return true;
}

export function upsertSelected(item: SelItem) {
  const list = selection.get().filter((s) => s.slug !== item.slug);
  selection.set([...list, item]);
}

/* ---------- view ---------- */

export type View = 'atlas' | 'index';
export const view = signal<View>('atlas');
