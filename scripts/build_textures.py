"""
Builds every texture tier used by the site from the ambientCG 2K sources.

  python scripts/build_textures.py <raw_dir>

<raw_dir> must contain one folder per ambientCG asset id with Color.jpg,
NormalGL.jpg (and Roughness.jpg, unused). Outputs:

  public/tex/s/<slug>-{c,n}.webp   256px  60x60 cm swatch  (grid, 1x screens)
  public/tex/g/<slug>-{c,n}.webp   512px  60x60 cm swatch  (grid, hi-dpi)
  public/tex/m/<slug>-{c,n}.webp   1024/512px full tile    (detail, mobile)
  public/tex/d/<slug>-{c,n}.webp   2048/1024px full tile   (detail, desktop)
  src/data/textures.json           colour statistics + swatch crop origin
"""
import json, os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('VETA_RAW', '')
SWATCH_CM = 60
SRC = 2048

catalog = json.load(open(os.path.join(ROOT, 'src/data/catalog.json'), encoding='utf-8'))
cols = catalog['collections']


def srgb2lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin2srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0, None), 1 / 2.4) - 0.055)


def to_lab(lin):
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = (m @ lin) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return 116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])


def square(arr):
    h, w = arr.shape[:2]
    if h == w:
        return arr
    reps = (w // h, 1, 1) if h < w else (1, h // w, 1)
    return np.tile(arr, reps)[:SRC, :SRC]


def rotate_normal_ccw(arr):
    rot = np.rot90(arr, 1).copy()
    r, g = rot[..., 0].copy(), rot[..., 1].copy()
    rot[..., 0] = 255 - g
    rot[..., 1] = r
    return rot


def best_crop(color, size):
    """Pick the most characterful swatch window (wrapping, tileable source)."""
    if size >= SRC:
        return 0, 0
    small = np.asarray(Image.fromarray(color).resize((256, 256), Image.BILINEAR)).astype(np.float32).mean(2)
    s = max(1, round(256 * size / SRC))
    best, best_xy = -1, (0, 0)
    for gy in range(8):
        for gx in range(8):
            x, y = gx * 32, gy * 32
            win = np.roll(np.roll(small, -y, 0), -x, 1)[:s, :s]
            score = win.std()
            if score > best:
                best, best_xy = score, (x * SRC // 256, y * SRC // 256)
    return best_xy


def save(arr, path, size, quality):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im = Image.fromarray(arr)
    if im.size[0] != size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(path, 'WEBP', quality=quality, method=6)


out = {}
for mat in catalog['materials']:
    slug, asset = mat['slug'], mat['asset']
    phys = cols[mat['collection']]['phys']
    color = square(np.asarray(Image.open(os.path.join(RAW, asset, 'Color.jpg')).convert('RGB')))
    normal = square(np.asarray(Image.open(os.path.join(RAW, asset, 'NormalGL.jpg')).convert('RGB')))
    if mat.get('rotate') == 90:
        color = np.rot90(color, 1).copy()
        normal = rotate_normal_ccw(normal)

    crop = min(SRC, round(SRC * SWATCH_CM / phys))
    cx, cy = best_crop(color, crop)
    sw_c = np.roll(np.roll(color, -cy, 0), -cx, 1)[:crop, :crop]
    sw_n = np.roll(np.roll(normal, -cy, 0), -cx, 1)[:crop, :crop]

    pub = os.path.join(ROOT, 'public', 'tex')
    save(sw_c, f'{pub}/s/{slug}-c.webp', 256, 74)
    save(sw_n, f'{pub}/s/{slug}-n.webp', 256, 80)
    save(sw_c, f'{pub}/g/{slug}-c.webp', 512, 76)
    save(sw_n, f'{pub}/g/{slug}-n.webp', 512, 80)
    save(color, f'{pub}/m/{slug}-c.webp', 1024, 78)
    save(normal, f'{pub}/m/{slug}-n.webp', 512, 80)
    save(color, f'{pub}/d/{slug}-c.webp', 2048, 80)
    save(normal, f'{pub}/d/{slug}-n.webp', 1024, 82)

    small = np.asarray(Image.fromarray(sw_c).resize((128, 128), Image.BILINEAR)).astype(np.float64) / 255
    lin = srgb2lin(small).reshape(-1, 3).mean(0)
    L, A, B = to_lab(lin)
    q = Image.fromarray(sw_c).resize((96, 96)).quantize(4, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[:12]
    counts = sorted(q.getcolors(), reverse=True)
    out[slug] = {
        'hex': '#%02x%02x%02x' % tuple((lin2srgb(lin) * 255).round().astype(int)),
        'L': round(float(L), 1), 'a': round(float(A), 1), 'b': round(float(B), 1),
        'palette': ['#%02x%02x%02x' % tuple(pal[i * 3:i * 3 + 3]) for _, i in counts[:3]],
        'crop': [round(cx / SRC, 4), round(cy / SRC, 4)],
    }
    print(slug, out[slug]['hex'], out[slug]['crop'], flush=True)

with open(os.path.join(ROOT, 'src/data/textures.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
print('ok', len(out))
