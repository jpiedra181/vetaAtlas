export type Uniforms = Record<string, WebGLUniformLocation>;

export interface Program {
  prog: WebGLProgram;
  u: Uniforms;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  const u: Uniforms = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name)!;
  }
  return { prog, u };
}

/** Subdivided unit quad so the vertex shader can bend cells smoothly. */
export function gridMesh(gl: WebGL2RenderingContext, seg: number) {
  const verts: number[] = [];
  const idx: number[] = [];
  for (let y = 0; y <= seg; y++) for (let x = 0; x <= seg; x++) verts.push(x / seg, y / seg);
  for (let y = 0; y < seg; y++)
    for (let x = 0; x < seg; x++) {
      const i = y * (seg + 1) + x;
      idx.push(i, i + 1, i + seg + 1, i + 1, i + seg + 2, i + seg + 1);
    }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: idx.length };
}

export function createTexture(gl: WebGL2RenderingContext, target: number) {
  const tex = gl.createTexture()!;
  gl.bindTexture(target, tex);
  return tex;
}
