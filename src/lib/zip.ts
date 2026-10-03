import { zipSync, strToU8 } from 'fflate';
import { detailBitmaps } from '../gl/textures';
import { shading, type Finish, type Material } from '../data/materials';

async function toJpeg(src: ImageBitmap | null, size: number, fill?: string): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  if (src) ctx.drawImage(src, 0, 0, size, size);
  else {
    ctx.fillStyle = fill!;
    ctx.fillRect(0, 0, size, size);
  }
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Colour, normal and roughness maps ready for SketchUp, 3ds Max, Blender… */
export async function buildTextureZip(m: Material, finish: Finish, tier: 'm' | 'd'): Promise<Blob> {
  const [color, normal] = await detailBitmaps(tier, m.slug);
  const size = color.width;
  const rough = Math.round(shading(m, finish).rough * 255);
  const g = rough.toString(16).padStart(2, '0');
  const files = {
    [`${m.slug}_color.jpg`]: await toJpeg(color, size),
    [`${m.slug}_normal_gl.jpg`]: await toJpeg(normal, normal.width),
    [`${m.slug}_roughness_${finish}.jpg`]: await toJpeg(null, 256, `#${g}${g}${g}`),
    'LEEME.txt': strToU8(
      [
        `VETA — ${m.name} (${m.code})`,
        '',
        `Escala: un mapa equivale a ${m.collection.phys} × ${m.collection.phys} cm. Mapas sin juntas, repetibles.`,
        `Scale: one map covers ${m.collection.phys} × ${m.collection.phys} cm. Seamless, joint-free maps.`,
        '',
        'Normal: convención OpenGL (Y+). Normal map: OpenGL convention (Y+).',
        `Rugosidad uniforme para el acabado «${finish}». Uniform roughness for the "${finish}" finish.`,
        '',
        'Proyecto conceptual. Texturas originales: ambientCG.com (CC0).',
      ].join('\r\n'),
    ),
  };
  color.close();
  normal.close();
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}
