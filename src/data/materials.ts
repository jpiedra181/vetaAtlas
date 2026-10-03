import catalog from './catalog.json';
import textures from './textures.json';
import { lang, t, type Key } from '../i18n';

export type Finish = 'pulido' | 'mate' | 'estructurado';
export type Use = 'suelo' | 'pared' | 'exterior' | 'encimera' | 'piscina';
export type Tone = 'claro' | 'medio' | 'oscuro';
export type Temp = 'frio' | 'neutro' | 'calido';
type Localised = { es: string; en: string };

export interface Collection {
  id: string;
  name: Localised;
  blurb: Localised;
  code: string;
  phys: number;
  finishes: Finish[];
  formats: string[];
  defaultFormat: string;
  uses: Use[];
  variation: string;
  faces: number;
}

export interface Material {
  index: number;
  slug: string;
  asset: string;
  name: string;
  collection: Collection;
  desc: Localised;
  finishes: Finish[];
  defaultFinish: Finish;
  formats: string[];
  defaultFormat: string;
  uses: Use[];
  hex: string;
  /** linear rgb 0..1 */
  linear: [number, number, number];
  L: number;
  a: number;
  b: number;
  warmth: number;
  tone: Tone;
  temp: Temp;
  palette: string[];
  /** swatch crop origin in uv (image space, v down) */
  crop: [number, number];
  code: string;
  isPlank: boolean;
  search: string;
}

type RawCollection = Omit<Collection, 'id' | 'finishes' | 'uses'> & { finishes: string[]; uses: string[] };
type RawMaterial = {
  slug: string; asset: string; name: string; collection: string; desc: Localised;
  uses?: string[]; defaultFinish?: string; rotate?: number;
};

const rawCollections = catalog.collections as Record<string, RawCollection>;
const tex = textures as unknown as Record<string, { hex: string; L: number; a: number; b: number; palette: string[]; crop: [number, number] }>;

export const collections: Collection[] = Object.entries(rawCollections).map(([id, c]) => ({
  ...c,
  id,
  finishes: c.finishes as Finish[],
  uses: c.uses as Use[],
}));
const colById = new Map(collections.map((c) => [c.id, c]));

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const hexToLinear = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
};

export const normalise = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function colourWords(L: number, a: number, b: number): string {
  const words: string[] = [];
  const chroma = Math.hypot(a, b);
  if (L > 80) words.push('blanco white claro light');
  else if (L < 30) words.push('negro black oscuro dark');
  else if (L < 45) words.push('oscuro dark');
  if (chroma < 6) words.push('gris grey gray neutro neutral');
  if (b > 8 && a < 12 && L > 60) words.push('beige crema cream arena sand');
  if (b > 12 && a > 5 && L < 65) words.push('marron brown');
  if (a > 18) words.push('rojo red naranja orange terracota terracotta');
  if (a < -2) words.push('verde green');
  if (b < -3) words.push('azul blue');
  if (a > 3 && b < 6 && L > 55) words.push('rosa pink');
  if (b > 20) words.push('calido warm dorado gold');
  return words.join(' ');
}

export const materials: Material[] = (catalog.materials as RawMaterial[]).map((m, index) => {
  const col = colById.get(m.collection)!;
  const tx = tex[m.slug];
  const warmth = tx.b + tx.a * 0.5;
  const finishes = col.finishes;
  const defaultFinish = (m.defaultFinish as Finish) ?? finishes[0];
  const uses = (m.uses as Use[]) ?? col.uses;
  const tone: Tone = tx.L > 70 ? 'claro' : tx.L >= 42 ? 'medio' : 'oscuro';
  const temp: Temp = warmth < 2.5 ? 'frio' : warmth <= 11 ? 'neutro' : 'calido';
  const code = `VT·${col.code}·${String(index + 1).padStart(2, '0')}`;
  const search = normalise(
    [m.name, col.name.es, col.name.en, m.desc.es, m.desc.en, colourWords(tx.L, tx.a, tx.b),
      ...finishes.flatMap((f) => [f, t(`finish.${f}` as Key)]),
      ...uses.flatMap((u) => [u, t(`use.${u}` as Key)]), code].join(' '),
  );
  return {
    index, slug: m.slug, asset: m.asset, name: m.name, collection: col, desc: m.desc,
    finishes, defaultFinish, formats: col.formats, defaultFormat: col.defaultFormat, uses,
    hex: tx.hex, linear: hexToLinear(tx.hex), L: tx.L, a: tx.a, b: tx.b, warmth, tone, temp,
    palette: tx.palette, crop: tx.crop, code, isPlank: col.id === 'madera', search,
  };
});

export const bySlug = new Map(materials.map((m) => [m.slug, m]));

export const loc = (l: Localised) => l[lang()];

/* ---------- formats & technical data ---------- */

export interface Format { w: number; h: number; plank: boolean; label: string }

export function parseFormat(f: string): Format {
  const [a, b] = f.split('x').map(Number);
  // planks are listed as width x length; lay them horizontally (length along x)
  const plank = a < 40 && b >= 100;
  return plank ? { w: b, h: a, plank, label: `${a} × ${b}` } : { w: a, h: b, plank, label: `${a} × ${b}` };
}

export function thicknessMm(format: string, finish: Finish) {
  if (format === '120x280') return 6;
  if (finish === 'estructurado') return 20;
  return 10;
}

const BOX: Record<string, number> = {
  '60x60': 3, '60x120': 2, '120x120': 2, '120x280': 1, '20x120': 6, '23x150': 5, '30x180': 4,
};

export function boxInfo(format: string) {
  const f = parseFormat(format);
  const pcs = BOX[format] ?? 2;
  const pieceM2 = (f.w * f.h) / 10000;
  return { pcs, pieceM2, m2: pcs * pieceM2 };
}

export const slipClass = (finish: Finish) => (finish === 'pulido' ? 0 : finish === 'mate' ? 1 : 3);

export function calc(format: string, finish: Finish, area: number, waste: number) {
  const { pcs, pieceM2 } = boxInfo(format);
  const need = area * (1 + waste);
  const pieces = Math.ceil(need / pieceM2);
  const boxes = Math.ceil(pieces / pcs);
  const total = boxes * pcs;
  const m2 = total * pieceM2;
  const kg = m2 * thicknessMm(format, finish) * 2.35;
  return { boxes, pieces: total, m2, kg };
}

/* ---------- finish → shading parameters (shared by grid and viewer) ---------- */

export interface Shading { rough: number; normal: number; spec: number }
export function shading(m: Material, finish: Finish = m.defaultFinish): Shading {
  const relief = m.collection.id === 'cal' || m.collection.id === 'granito' ? 1.25 : 1;
  switch (finish) {
    case 'pulido': return { rough: 0.28, normal: 0.45, spec: 0.72 };
    case 'mate': return { rough: 0.55, normal: 0.85 * relief, spec: 0.16 };
    default: return { rough: 0.72, normal: 1.9 * relief, spec: 0.1 };
  }
}

/* ---------- filters ---------- */

export type FacetId = 'collection' | 'tone' | 'temp' | 'finish' | 'use' | 'format';
export type Filters = Record<FacetId, Set<string>>;
export const facetIds: FacetId[] = ['collection', 'tone', 'temp', 'finish', 'use', 'format'];

export const facetOptions: Record<FacetId, string[]> = {
  collection: collections.map((c) => c.id),
  tone: ['claro', 'medio', 'oscuro'],
  temp: ['frio', 'neutro', 'calido'],
  finish: ['pulido', 'mate', 'estructurado'],
  use: ['suelo', 'pared', 'exterior', 'encimera', 'piscina'],
  format: ['60x60', '60x120', '120x120', '120x280', 'tablon'],
};

export function optionLabel(facet: FacetId, id: string): string {
  switch (facet) {
    case 'collection': return loc(colById.get(id)!.name);
    case 'tone': return t(`tone.${id}` as Key);
    case 'temp': return t(`temp.${id}` as Key);
    case 'finish': return t(`finish.${id}` as Key);
    case 'use': return t(`use.${id}` as Key);
    case 'format': return id === 'tablon' ? t('format.tablon') : parseFormat(id).label;
  }
}

export const emptyFilters = (): Filters =>
  Object.fromEntries(facetIds.map((f) => [f, new Set<string>()])) as Filters;

export function matches(m: Material, f: Filters): boolean {
  const any = (set: Set<string>, values: string[]) => set.size === 0 || values.some((v) => set.has(v));
  return (
    any(f.collection, [m.collection.id]) &&
    any(f.tone, [m.tone]) &&
    any(f.temp, [m.temp]) &&
    any(f.finish, m.finishes) &&
    any(f.use, m.uses) &&
    any(f.format, m.formats.map((x) => (parseFormat(x).plank ? 'tablon' : x)))
  );
}

export const filterCount = (f: Filters) => facetIds.reduce((n, id) => n + f[id].size, 0);

/* ---------- the map: lightness rows, warmth columns ---------- */

export interface Layout { order: number[]; W: number; H: number }

export function makeLayout(list: Material[]): Layout {
  const n = list.length;
  const W = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (4 / 3)))));
  const H = Math.ceil(n / W);
  const byL = [...list].sort((p, q) => q.L - p.L);
  const order: number[] = [];
  for (let r = 0; r < H; r++) {
    const row = byL.slice(r * W, r * W + W).sort((p, q) => p.warmth - q.warmth);
    order.push(...row.map((m) => m.index));
  }
  return { order, W, H };
}

/* ---------- pairing ---------- */

export function pairings(m: Material): Material[] {
  const others = materials.filter((o) => o.collection.id !== m.collection.id);
  const picked: Material[] = [];
  const take = (list: Material[]) => {
    const o = list.find((x) => !picked.includes(x));
    if (o) picked.push(o);
  };
  const dw = (o: Material) => Math.abs(o.warmth - m.warmth);
  const dL = (o: Material) => Math.abs(o.L - m.L);
  // tonal companion
  take([...others].sort((p, q) => dL(p) + dw(p) * 1.4 - (dL(q) + dw(q) * 1.4)));
  // strong contrast with compatible temperature
  take([...others].filter((o) => dw(o) < 14).sort((p, q) => dL(q) - dL(p)));
  // a warm wood unless the material is wood
  if (m.collection.id !== 'madera')
    take(materials.filter((o) => o.collection.id === 'madera').sort((p, q) => Math.abs(dL(p) - 28) - Math.abs(dL(q) - 28)));
  else take([...others].filter((o) => o.collection.id === 'marmol' || o.collection.id === 'cal').sort((p, q) => dL(q) - dL(p)));
  // mid contrast
  take([...others].sort((p, q) => Math.abs(dL(p) - 22) + dw(p) - (Math.abs(dL(q) - 22) + dw(q))));
  return picked.slice(0, 4);
}

export const texUrl = (tier: string, slug: string, kind: 'c' | 'n') => `tex/${tier}/${slug}-${kind}.webp`;
