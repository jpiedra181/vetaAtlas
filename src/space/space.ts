import {
  ACESFilmicToneMapping, BoxGeometry, CanvasTexture, Color, CylinderGeometry, DirectionalLight, Group,
  HemisphereLight, LatheGeometry, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PCFShadowMap,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, RepeatWrapping, Scene, SphereGeometry, SRGBColorSpace,
  Vector2, Vector3, WebGLRenderer, type ShaderMaterial, type Material as ThreeMaterial, type Texture,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { detailBitmaps } from '../gl/textures';
import { parseFormat, shading, type Finish, type Material } from '../data/materials';
import { reducedMotion } from '../state';
import { t } from '../i18n';

export interface SpaceOpts { material: Material; finish: Finish; format: string; joint: string | null }
export type OrbitDir = 'left' | 'right' | 'up' | 'down' | 'in' | 'out';
export interface SpaceHandle {
  set(o: SpaceOpts): void;
  /** One camera step, from the keyboard or the buttons of the viewer. */
  orbit(dir: OrbitDir): void;
  pause(): void;
  resume(): void;
  resize(): void;
  dispose(): void;
}

const ROOM = { w: 7, d: 6, h: 3.2 };

// camera orbit around the target: azimuth and elevation in radians, distance in metres
const ORBIT_HOME = { az: 0.54, el: 0.1, dist: 5.85 };
const AZ = { min: 0.1, max: 0.95 };
const EL = { min: 0.02, max: 0.4 };
const DIST = { min: 3.6, max: 6.4 };
/** One step of the keyboard and of the camera buttons. */
const ORBIT_STEP = { az: 0.08, el: 0.04, zoom: 0.9 };
const ORBIT_DIR: Record<OrbitDir, [number, number, number]> = {
  left: [-ORBIT_STEP.az, 0, 1],
  right: [ORBIT_STEP.az, 0, 1],
  up: [0, ORBIT_STEP.el, 1],
  down: [0, -ORBIT_STEP.el, 1],
  in: [0, 0, ORBIT_STEP.zoom],
  out: [0, 0, 1 / ORBIT_STEP.zoom],
};
// WCAG 2.1.1: the camera also moves from the keyboard while the room has focus
const ORBIT_KEYS: Record<string, OrbitDir> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', '_': 'out',
};
const clamp = (v: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, v));

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Lay real tiles (joints, bond, distinct faces) into a repeatable patch. */
function bake(src: ImageBitmap, phys: number, format: string, joint: string, normal: boolean, seed: number) {
  const f = parseFormat(format);
  const cols = Math.max(1, Math.round(240 / f.w));
  const rows = Math.max(1, Math.round(240 / f.h));
  const pw = cols * f.w;
  const ph = rows * f.h;
  const ppc = Math.min(2048 / Math.max(pw, ph), 7);
  const c = document.createElement('canvas');
  c.width = Math.round(pw * ppc);
  c.height = Math.round(ph * ppc);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = normal ? 'rgb(128,128,255)' : joint;
  ctx.fillRect(0, 0, c.width, c.height);
  const pat = ctx.createPattern(src, 'repeat')!;
  const s = (ppc * phys) / src.width;
  const jw = Math.max(0.18 * ppc, 1);
  const r = rng(seed);
  const bonds = Array.from({ length: rows }, () => (f.plank ? r() * f.w : 0));
  const faces = Array.from({ length: rows * cols }, () => [r() * src.width, r() * src.height]);
  for (let row = 0; row < rows; row++) {
    for (let col = -1; col <= cols; col++) {
      const face = faces[row * cols + ((col % cols) + cols) % cols];
      const x = (col * f.w + bonds[row]) * ppc;
      const y = row * f.h * ppc;
      pat.setTransform(new DOMMatrix().translate(x - face[0] * s, y - face[1] * s).scale(s));
      ctx.fillStyle = pat;
      ctx.fillRect(x + jw / 2, y + jw / 2, f.w * ppc - jw, f.h * ppc - jw);
    }
  }
  return { canvas: c, pw, ph };
}

export async function createSpace(host: HTMLElement, tier: 'm' | 'd', hintId?: string): Promise<SpaceHandle> {
  const canvas = document.createElement('canvas');
  // application y no img: con img, NVDA en modo exploración se queda las flechas
  // para su propio cursor y la cámara no gira. Con application pasa solo a modo foco.
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', t('space.role'));
  canvas.tabIndex = 0;
  if (hintId) canvas.setAttribute('aria-describedby', hintId);
  host.append(canvas);
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = new Color('#f3ead9');
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.32;

  const camera = new PerspectiveCamera(36, 1, 0.1, 60);
  const target = new Vector3(-0.8, 0.9, -1.8);

  // ---- room
  const plaster = new MeshStandardMaterial({ color: '#d7d1c7', roughness: 0.93 });
  const neutralFloor = new MeshStandardMaterial({ color: '#8d8881', roughness: 0.8 });
  const surface = new MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.5 });
  const room = new Group();
  const floor = new Mesh(new PlaneGeometry(ROOM.w, ROOM.d), surface);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);
  const back = new Mesh(new PlaneGeometry(ROOM.w, ROOM.h), plaster);
  back.position.set(0, ROOM.h / 2, -ROOM.d / 2);
  back.receiveShadow = true;
  room.add(back);
  // left wall with a window opening
  const wallT = 0.25;
  const win = { z0: -1.9, z1: 0.5, y0: 0.55, y1: 2.65 };
  const wallPart = (zA: number, zB: number, yA: number, yB: number) => {
    const m = new Mesh(new BoxGeometry(wallT, yB - yA, zB - zA), plaster);
    m.position.set(-ROOM.w / 2 - wallT / 2, (yA + yB) / 2, (zA + zB) / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    room.add(m);
  };
  wallPart(-ROOM.d / 2, win.z0, 0, ROOM.h);
  wallPart(win.z1, ROOM.d / 2, 0, ROOM.h);
  wallPart(win.z0, win.z1, 0, win.y0);
  wallPart(win.z0, win.z1, win.y1, ROOM.h);
  const ceiling = new Mesh(new BoxGeometry(ROOM.w + wallT, 0.1, ROOM.d), plaster);
  ceiling.position.set(-wallT / 2, ROOM.h + 0.05, 0);
  ceiling.castShadow = true;
  room.add(ceiling);
  scene.add(room);

  // ---- objects
  const bench = new Mesh(new BoxGeometry(2.3, 0.42, 0.46), plaster);
  bench.position.set(-1.0, 0.21, -ROOM.d / 2 + 0.24);
  const plinth = new Mesh(new CylinderGeometry(0.24, 0.24, 0.72, 48), plaster);
  plinth.position.set(0.75, 0.36, -2.35);
  const vaseProfile = [
    [0.0, 0], [0.11, 0], [0.16, 0.06], [0.19, 0.18], [0.17, 0.3], [0.09, 0.4], [0.07, 0.46], [0.09, 0.5],
  ].map(([x, y]) => new Vector2(x, y));
  const glaze = new MeshPhysicalMaterial({ color: '#2a2622', roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const vase = new Mesh(new LatheGeometry(vaseProfile, 64), glaze);
  vase.position.set(0.75, 0.72, -2.35);
  const oak = new MeshStandardMaterial({ color: '#3d3129', roughness: 0.55 });
  const table = new Group();
  const top = new Mesh(new CylinderGeometry(0.46, 0.46, 0.05, 64), oak);
  top.position.y = 0.36;
  const leg = new Mesh(new CylinderGeometry(0.16, 0.2, 0.34, 48), oak);
  leg.position.y = 0.17;
  table.add(top, leg);
  table.position.set(-1.35, 0, -0.75);
  const sphere = new Mesh(new SphereGeometry(0.26, 64, 40), new MeshStandardMaterial({ color: '#b9b1a5', roughness: 0.9 }));
  sphere.position.set(1.85, 0.26, -1.55);
  const book = new Mesh(new BoxGeometry(0.34, 0.05, 0.26), new MeshStandardMaterial({ color: '#c9b9a0', roughness: 0.8 }));
  book.position.set(-1.25, 0.41, -0.7);
  book.rotation.y = 0.4;
  table.traverse((o) => ((o as Mesh).castShadow = (o as Mesh).receiveShadow = true));
  for (const o of [bench, plinth, vase, table, sphere, book]) {
    o.castShadow = true;
    o.receiveShadow = true;
    scene.add(o);
  }

  // ---- light: low sun through the window + soft sky
  const sun = new DirectionalLight('#ffdcb8', 4.2);
  sun.position.set(-9, 4.6, 2.4);
  sun.target.position.set(0.4, 0, -1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -5; sc.right = 5; sc.top = 5; sc.bottom = -5; sc.near = 1; sc.far = 25;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  scene.add(new HemisphereLight('#e6dfd2', '#2f2924', 0.38));
  const fill = new DirectionalLight('#c3cedb', 0.22);
  fill.position.set(5, 3, 6);
  scene.add(fill);

  // ---- planar reflection: an invisible mirror renders the room upside down,
  // and the floor material blends it in with a Fresnel term
  const reflector = new Reflector(new PlaneGeometry(ROOM.w, ROOM.d), { textureWidth: 512, textureHeight: 512, clipBias: 0.002 });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.y = 0.0005;
  const rmat = reflector.material as ShaderMaterial;
  rmat.colorWrite = false;
  rmat.depthWrite = false;
  scene.add(reflector);
  const reflU = {
    tReflect: { value: reflector.getRenderTarget().texture },
    uReflMatrix: rmat.uniforms.textureMatrix,
    uReflK: { value: 0 },
  };
  surface.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, reflU);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform mat4 uReflMatrix;
varying vec4 vReflUv;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vReflUv = uReflMatrix * vec4(transformed, 1.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tReflect;
uniform float uReflK;
varying vec4 vReflUv;`)
      .replace('#include <opaque_fragment>', `if (uReflK > 0.0) {
        vec2 ruv = vReflUv.xy / vReflUv.w + normal.xy * 0.018;
        vec3 refl = texture2D(tReflect, ruv).rgb;
        float ndv = saturate(dot(normalize(vViewPosition), normal));
        float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
        outgoingLight += refl * uReflK * fres;
      }
      #include <opaque_fragment>`);
  };

  // ---- camera orbit (drag, wheel, keyboard, buttons), render on demand
  const H = ORBIT_HOME;
  const orbit = { az: H.az, el: H.el, dist: H.dist, taz: H.az, tel: H.el, tdist: H.dist };
  let raf = 0;
  let paused = false;
  let disposed = false;
  const place = () => {
    const { az, el, dist } = orbit;
    camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(target);
  };
  const frame = () => {
    raf = 0;
    if (paused || disposed) return;
    const k = reducedMotion.get() ? 1 : 0.14;
    orbit.az += (orbit.taz - orbit.az) * k;
    orbit.el += (orbit.tel - orbit.el) * k;
    orbit.dist += (orbit.tdist - orbit.dist) * k;
    place();
    renderer.render(scene, camera);
    if (Math.abs(orbit.taz - orbit.az) + Math.abs(orbit.tel - orbit.el) + Math.abs(orbit.tdist - orbit.dist) > 0.0005) request();
  };
  const request = () => {
    if (!raf && !paused && !disposed) raf = requestAnimationFrame(frame);
  };
  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    const pr = renderer.getPixelRatio() * 0.6;
    reflector.getRenderTarget().setSize(Math.round(w * pr), Math.round(h * pr));
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 52 : 38;
    camera.updateProjectionMatrix();
    request();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchD = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD) orbit.tdist = clamp(orbit.tdist * (pinchD / d), DIST);
      pinchD = d;
    } else {
      orbit.taz = clamp(orbit.taz - dx * 0.004, AZ);
      orbit.tel = clamp(orbit.tel + dy * 0.003, EL);
    }
    request();
  });
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinchD = 0;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      orbit.tdist = clamp(orbit.tdist * Math.exp(e.deltaY * 0.001), DIST);
      request();
    },
    { passive: false },
  );
  const orbitStep = (dir: OrbitDir) => {
    const [dAz, dEl, kDist] = ORBIT_DIR[dir];
    orbit.taz = clamp(orbit.taz + dAz, AZ);
    orbit.tel = clamp(orbit.tel + dEl, EL);
    orbit.tdist = clamp(orbit.tdist * kDist, DIST);
    request();
  };
  canvas.addEventListener('keydown', (e) => {
    const dir = ORBIT_KEYS[e.key];
    if (dir) orbitStep(dir);
    else if (e.key === 'Home') [orbit.taz, orbit.tel, orbit.tdist] = [H.az, H.el, H.dist];
    else return;
    // keep the arrows from also stepping to the previous / next surface
    e.preventDefault();
    e.stopPropagation();
    request();
  });

  // ---- material application
  let current: { slug: string; bitmaps: Promise<[ImageBitmap, ImageBitmap]> } | null = null;
  let textures: Texture[] = [];
  let version = 0;
  const set = async (o: SpaceOpts) => {
    const v = ++version;
    canvas.setAttribute('aria-label', `${o.material.name} — ${t('detail.tab.space')}`);
    if (!current || current.slug !== o.material.slug) {
      current?.bitmaps.then(([a, b]) => (a.close(), b.close())).catch(() => {});
      current = { slug: o.material.slug, bitmaps: detailBitmaps(tier, o.material.slug) };
    }
    const [cBmp, nBmp] = await current.bitmaps;
    if (v !== version || disposed) return;
    const m = o.material;
    const joint = o.joint ?? `rgb(${m.linear.map((c) => Math.round(Math.pow(c * 0.42, 1 / 2.2) * 255)).join(',')})`;
    const seed = m.index * 97 + 13;
    const col = bake(cBmp, m.collection.phys, o.format, joint, false, seed);
    const nor = bake(nBmp, m.collection.phys, o.format, joint, true, seed);
    const map = new CanvasTexture(col.canvas);
    map.colorSpace = SRGBColorSpace;
    const nmap = new CanvasTexture(nor.canvas);
    for (const tx of [map, nmap]) {
      tx.wrapS = tx.wrapT = RepeatWrapping;
      tx.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
    const sh = shading(m, o.finish);
    const isWall = m.uses.length === 1 && m.uses[0] === 'pared';
    const target = isWall ? back : floor;
    const other = isWall ? floor : back;
    const sizeW = isWall ? ROOM.w : ROOM.w;
    const sizeH = isWall ? ROOM.h : ROOM.d;
    map.repeat.set((sizeW * 100) / col.pw, (sizeH * 100) / col.ph);
    nmap.repeat.copy(map.repeat);
    surface.map = map;
    surface.normalMap = nmap;
    surface.normalScale.set(sh.normal * 0.7, sh.normal * 0.7);
    surface.roughness = o.finish === 'pulido' ? 0.1 : o.finish === 'mate' ? 0.62 : 0.82;
    surface.clearcoat = 0;
    surface.needsUpdate = true;
    target.material = surface;
    other.material = isWall ? neutralFloor : plaster;
    reflU.uReflK.value = isWall ? 0 : o.finish === 'pulido' ? 1 : o.finish === 'mate' ? 0.18 : 0;
    surface.envMapIntensity = o.finish === 'pulido' ? 0.35 : 0.6;
    reflector.visible = !isWall;
    textures.forEach((tx) => tx.dispose());
    textures = [map, nmap];
    request();
  };

  resize();
  place();
  request();

  return {
    set: (o) => void set(o),
    orbit: orbitStep,
    pause() {
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    resume() {
      paused = false;
      resize();
    },
    resize,
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      current?.bitmaps.then(([a, b]) => (a.close(), b.close())).catch(() => {});
      textures.forEach((tx) => tx.dispose());
      env.dispose();
      pmrem.dispose();
      reflector.dispose();
      scene.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as ThreeMaterial | undefined;
        mat?.dispose?.();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
