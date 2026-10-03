import { program, gridMesh, createTexture, type Program } from './gl';
import { gridVert, gridFrag, quadVert, heroFrag, bgVert, bgFrag } from './shaders';
import { TextureBank, DetailCache, type DetailTex } from './textures';
import { materials, shading } from '../data/materials';

export interface GridParams {
  origin: [number, number];
  cell: number;
  inset: number;
  first: [number, number];
  cols: number;
  rows: number;
  rippleT: number;
  rippleOrigin: [number, number];
  bend: number;
  lift: number;
  hoverCell: [number, number];
  hover: number;
  pulseCell: [number, number];
  pulse: number;
  heroCell: [number, number];
  heroHide: number;
  dim: number;
  dimOrigin: [number, number];
  radius: number;
}

export interface HeroParams {
  rect: [number, number, number, number];
  win: [number, number, number];
  phys: number;
  crop: [number, number];
  tile: [number, number, number];
  tileOff: [number, number];
  jointW: number;
  joint: [number, number, number, number];
  detailMix: number;
  detail: DetailTex | null;
  layer: number;
  avg: [number, number, number];
  shade: [number, number, number];
  radius: number;
  opacity: number;
}

export interface LightParams { x: number; y: number; z: number; k: number; r: number }

const BG: [number, number, number] = [0.0047, 0.0042, 0.0037];

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly bank: TextureBank;
  readonly details: DetailCache;
  private grid: Program;
  private hero: Program;
  private bg: Program;
  private mesh: { vao: WebGLVertexArrayObject; count: number };
  private quad: WebGLVertexArrayObject;
  private empty: WebGLVertexArrayObject;
  private matTex: WebGLTexture;
  private matData: Float32Array;
  private orderTex: WebGLTexture;
  private prevTex: WebGLTexture;
  private dummy2D: WebGLTexture;
  order = { W: 1, N: 0 };
  prev = { W: 1, N: 0 };
  width = 0;
  height = 0;
  pxRatio = 1;
  private matDirty = true;

  constructor(readonly canvas: HTMLCanvasElement, gridTier: 's' | 'g', detailTier: 'm' | 'd') {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('webgl2');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.grid = program(gl, gridVert, gridFrag);
    this.hero = program(gl, quadVert, heroFrag);
    this.bg = program(gl, bgVert, bgFrag);
    this.mesh = gridMesh(gl, 10);
    this.quad = gridMesh(gl, 1).vao;
    this.empty = gl.createVertexArray()!;
    this.bank = new TextureBank(gl, gridTier);
    this.details = new DetailCache(gl, detailTier);

    const n = materials.length;
    this.matData = new Float32Array(n * 4 * 3);
    materials.forEach((m, i) => {
      const s = shading(m);
      this.matData.set([s.rough, s.normal, s.spec, 1e6], i * 4);
      this.matData.set([...m.linear, 1e6], (n + i) * 4);
      this.matData.set([0, 0, 0, 0], (2 * n + i) * 4);
    });
    this.matTex = createTexture(gl, gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, n, 3);

    const mkOrder = () => {
      const t = createTexture(gl, gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
      return t;
    };
    this.orderTex = mkOrder();
    this.prevTex = mkOrder();

    this.dummy2D = createTexture(gl, gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 255, 255]));

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(cssW: number, cssH: number, ratio: number) {
    this.pxRatio = ratio;
    this.width = cssW;
    this.height = cssH;
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  setOrder(order: number[], W: number, keepPrev: boolean) {
    const gl = this.gl;
    if (keepPrev) {
      [this.orderTex, this.prevTex] = [this.prevTex, this.orderTex];
      this.prev = { ...this.order };
    } else {
      this.prev = { W: 1, N: 0 };
    }
    gl.bindTexture(gl.TEXTURE_2D, this.orderTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, order.length, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(order));
    this.order = { W, N: order.length };
  }

  setLoadedAt(layer: number, kind: 'c' | 'n', t: number) {
    const n = materials.length;
    this.matData[(kind === 'c' ? layer : n + layer) * 4 + 3] = t;
    this.matDirty = true;
  }

  setSelected(flags: boolean[]) {
    const n = materials.length;
    flags.forEach((f, i) => (this.matData[(2 * n + i) * 4] = f ? 1 : 0));
    this.matDirty = true;
  }

  begin(light: LightParams, bgAlpha: number) {
    const gl = this.gl;
    if (this.matDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.matTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, materials.length, 3, gl.RGBA, gl.FLOAT, this.matData);
      this.matDirty = false;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (bgAlpha > 0) {
      const { prog, u } = this.bg;
      gl.useProgram(prog);
      gl.uniform2f(u.uViewport, this.width, this.height);
      gl.uniform1f(u.uPxRatio, this.pxRatio);
      gl.uniform3fv(u.uBg, BG);
      gl.uniform1f(u.uAlpha, bgAlpha);
      this.light(u, light);
      gl.bindVertexArray(this.empty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private light(u: Record<string, WebGLUniformLocation>, l: LightParams) {
    const gl = this.gl;
    gl.uniform3f(u.uLight, l.x, l.y, l.z);
    gl.uniform1f(u.uLightK, l.k);
    gl.uniform1f(u.uLightR, l.r);
  }

  drawGrid(p: GridParams, light: LightParams, time: number, accent: [number, number, number]) {
    if (this.order.N === 0) return;
    const gl = this.gl;
    const { prog, u } = this.grid;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.bank.color);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.bank.normal);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.orderTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex);
    gl.uniform1i(u.uAlbedo, 0);
    gl.uniform1i(u.uNormal, 1);
    gl.uniform1i(u.uMatData, 2);
    gl.uniform1i(u.uOrder, 3);
    gl.uniform1i(u.uPrevOrder, 4);
    gl.uniform2f(u.uViewport, this.width, this.height);
    gl.uniform2f(u.uOrigin, p.origin[0], p.origin[1]);
    gl.uniform1f(u.uCell, p.cell);
    gl.uniform1f(u.uInset, p.inset);
    gl.uniform2i(u.uFirst, p.first[0], p.first[1]);
    gl.uniform1i(u.uCols, p.cols);
    gl.uniform1i(u.uW, this.order.W);
    gl.uniform1i(u.uN, this.order.N);
    gl.uniform1i(u.uPW, this.prev.W);
    gl.uniform1i(u.uPN, this.prev.N);
    gl.uniform1f(u.uRippleT, p.rippleT);
    gl.uniform2i(u.uRippleOrigin, p.rippleOrigin[0], p.rippleOrigin[1]);
    gl.uniform1f(u.uBend, p.bend);
    gl.uniform1f(u.uLift, p.lift);
    gl.uniform2i(u.uHoverCell, p.hoverCell[0], p.hoverCell[1]);
    gl.uniform1f(u.uHover, p.hover);
    gl.uniform2i(u.uPulseCell, p.pulseCell[0], p.pulseCell[1]);
    gl.uniform1f(u.uPulse, p.pulse);
    gl.uniform2i(u.uHeroCell, p.heroCell[0], p.heroCell[1]);
    gl.uniform1f(u.uHeroHide, p.heroHide);
    gl.uniform1f(u.uDim, p.dim);
    gl.uniform2f(u.uDimOrigin, p.dimOrigin[0], p.dimOrigin[1]);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uRadius, p.radius);
    gl.uniform3fv(u.uAccent, accent);
    this.light(u, light);
    gl.bindVertexArray(this.mesh.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_SHORT, 0, p.cols * p.rows);
  }

  drawHero(p: HeroParams, light: LightParams) {
    const gl = this.gl;
    const { prog, u } = this.hero;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.bank.color);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.bank.normal);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, p.detail?.color ?? this.dummy2D);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, p.detail?.normal ?? this.dummy2D);
    gl.uniform1i(u.uAlbedo, 0);
    gl.uniform1i(u.uNormal, 1);
    gl.uniform1i(u.uDetC, 5);
    gl.uniform1i(u.uDetN, 6);
    gl.uniform2f(u.uViewport, this.width, this.height);
    gl.uniform4fv(u.uRect, p.rect);
    gl.uniform3fv(u.uWin, p.win);
    gl.uniform1f(u.uPhys, p.phys);
    gl.uniform2fv(u.uCrop, p.crop);
    gl.uniform3fv(u.uTile, p.tile);
    gl.uniform2fv(u.uTileOff, p.tileOff);
    gl.uniform1f(u.uJointW, p.jointW);
    gl.uniform4fv(u.uJoint, p.joint);
    gl.uniform1f(u.uDetailMix, p.detail ? p.detailMix : 0);
    gl.uniform1i(u.uLayer, p.layer);
    gl.uniform1f(u.uLayerReady, this.bank.loadedColor.has(p.layer) ? 1 : 0);
    gl.uniform3fv(u.uAvg, p.avg);
    gl.uniform3fv(u.uShade, p.shade);
    gl.uniform1f(u.uRadius, p.radius);
    gl.uniform1f(u.uOpacity, p.opacity);
    this.light(u, light);
    gl.bindVertexArray(this.quad);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }
}
