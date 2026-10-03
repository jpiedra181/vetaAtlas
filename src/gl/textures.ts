import { createTexture } from './gl';
import { materials, texUrl } from '../data/materials';

const BITMAP_OPTS: ImageBitmapOptions = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };

async function fetchBitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return createImageBitmap(await res.blob(), BITMAP_OPTS);
}

type Pending = { layer: number; kind: 'c' | 'n'; bmp: ImageBitmap };

/**
 * All 48 grid swatches live in two TEXTURE_2D_ARRAYs (albedo sRGB + normal),
 * so the whole atlas draws in a single instanced call.
 */
export class TextureBank {
  readonly color: WebGLTexture;
  readonly normal: WebGLTexture;
  readonly size: number;
  private queue: Pending[] = [];
  private mipsDirty = 0;
  private lastMips = 0;
  loadedColor = new Set<number>();
  loadedNormal = new Set<number>();
  onLoaded: (layer: number, kind: 'c' | 'n') => void = () => {};

  constructor(private gl: WebGL2RenderingContext, readonly tier: 's' | 'g') {
    this.size = tier === 'g' ? 512 : 256;
    const levels = Math.log2(this.size) + 1;
    const n = materials.length;
    const mk = (internal: number) => {
      const t = createTexture(gl, gl.TEXTURE_2D_ARRAY);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internal, this.size, this.size, n);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.color = mk(gl.SRGB8_ALPHA8);
    this.normal = mk(gl.RGBA8);
  }

  /** Stream every swatch, colour first, in the given priority order. */
  load(priority: number[]) {
    const jobs: Array<{ layer: number; kind: 'c' | 'n' }> = [
      ...priority.map((layer) => ({ layer, kind: 'c' as const })),
      ...priority.map((layer) => ({ layer, kind: 'n' as const })),
    ];
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          const bmp = await fetchBitmap(texUrl(this.tier, materials[job.layer].slug, job.kind));
          this.queue.push({ ...job, bmp });
          this.wake();
        } catch (e) {
          console.warn(e);
        }
      }
    };
    for (let i = 0; i < 6; i++) worker();
  }

  wake: () => void = () => {};

  /** Upload a few decoded bitmaps per frame to keep frames smooth. */
  pump(now: number): boolean {
    const gl = this.gl;
    let did = false;
    const budget = performance.now() + 6;
    while (this.queue.length && performance.now() < budget) {
      const { layer, kind, bmp } = this.queue.shift()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, kind === 'c' ? this.color : this.normal);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.size, this.size, 1, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      bmp.close();
      (kind === 'c' ? this.loadedColor : this.loadedNormal).add(layer);
      this.mipsDirty |= kind === 'c' ? 1 : 2;
      this.onLoaded(layer, kind);
      did = true;
    }
    const allDone = this.queue.length === 0;
    if (this.mipsDirty && (now - this.lastMips > 0.25 || allDone)) {
      if (this.mipsDirty & 1) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.color);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      }
      if (this.mipsDirty & 2) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.normal);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      }
      this.mipsDirty = 0;
      this.lastMips = now;
      did = true;
    }
    return did || this.queue.length > 0;
  }

  get pending() {
    return this.queue.length > 0 || this.mipsDirty !== 0;
  }
}

export interface DetailTex { color: WebGLTexture; normal: WebGLTexture; slug: string }

/** Full-resolution, tileable textures for the detail viewer (LRU cache). */
export class DetailCache {
  private cache = new Map<string, Promise<DetailTex>>();
  private bitmaps = new Map<string, Promise<[ImageBitmap, ImageBitmap]>>();
  private aniso: number;
  private anisoExt: EXT_texture_filter_anisotropic | null;

  constructor(private gl: WebGL2RenderingContext, readonly tier: 'm' | 'd') {
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.aniso = this.anisoExt ? Math.min(8, gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 0;
  }

  /** Download + decode only (no GPU work) — used on hover. */
  prefetch(slug: string) {
    if (!this.bitmaps.has(slug) && !this.cache.has(slug)) {
      const p = Promise.all([fetchBitmap(texUrl(this.tier, slug, 'c')), fetchBitmap(texUrl(this.tier, slug, 'n'))]);
      p.catch(() => this.bitmaps.delete(slug));
      this.bitmaps.set(slug, p);
    }
  }

  get(slug: string): Promise<DetailTex> {
    const hit = this.cache.get(slug);
    if (hit) {
      this.cache.delete(slug);
      this.cache.set(slug, hit);
      return hit;
    }
    this.prefetch(slug);
    const p = this.bitmaps.get(slug)!.then(([c, n]) => {
      this.bitmaps.delete(slug);
      return { slug, color: this.upload(c, true), normal: this.upload(n, false) };
    });
    p.catch(() => this.cache.delete(slug));
    this.cache.set(slug, p);
    while (this.cache.size > 4) {
      const [oldest, op] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      op.then((d) => {
        this.gl.deleteTexture(d.color);
        this.gl.deleteTexture(d.normal);
      }).catch(() => {});
    }
    return p;
  }

  private upload(bmp: ImageBitmap, srgb: boolean) {
    const gl = this.gl;
    const t = createTexture(gl, gl.TEXTURE_2D);
    const levels = Math.floor(Math.log2(Math.max(bmp.width, bmp.height))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, bmp.width, bmp.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (this.anisoExt && this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso);
    bmp.close();
    return t;
  }
}

/** Decoded bitmaps of the detail textures, for 2D canvas work (room view, ZIP export). */
export async function detailBitmaps(tier: 'm' | 'd', slug: string) {
  return Promise.all([fetchBitmap(texUrl(tier, slug, 'c')), fetchBitmap(texUrl(tier, slug, 'n'))]);
}
