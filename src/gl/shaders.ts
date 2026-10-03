/* All lighting happens in linear space; output is gamma-encoded by hand
   because the default WebGL framebuffer is not sRGB. */

const common = /* glsl */ `
uniform vec3 uLight;      // css px x, y and height
uniform float uLightK;    // light intensity (fades in/out)
uniform float uLightR;    // falloff radius, css px

vec3 shoulder(vec3 c) {
  vec3 x = max(c - 0.8, 0.0);
  return min(c, 0.8) + 0.2 * (1.0 - exp(-x / 0.2));
}

vec3 shade(vec3 albedo, vec3 n, float rough, float spec, vec2 px) {
  vec3 Lv = vec3(uLight.x - px.x, px.y - uLight.y, uLight.z);
  float d2 = dot(Lv.xy, Lv.xy);
  vec3 L = normalize(Lv);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float ndl = max(dot(n, L), 0.0);
  float ndh = max(dot(n, H), 0.0);
  float fall = uLightK / (1.0 + d2 / (uLightR * uLightR));
  float a = rough * rough;
  float shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
  float s = pow(ndh, shin) * spec * fall * (0.6 + 0.4 * ndl);
  // a broad, faint sheen around the hot spot so polished stone reads as glossy, not as a flash
  s += pow(ndh, shin * 0.06 + 2.0) * spec * spec * fall * 0.35;
  float amb = 0.84 + 0.11 * n.y;
  float diff = ndl * fall * 0.36;
  return albedo * (amb + diff) + vec3(1.0, 0.95, 0.88) * s;
}

vec3 toScreen(vec3 c) { return pow(shoulder(c), vec3(1.0 / 2.2)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
`;

export const gridVert = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

layout(location = 0) in vec2 aPos;

uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform float uCell;
uniform float uInset;
uniform ivec2 uFirst;
uniform int uCols;
uniform usampler2D uOrder;
uniform usampler2D uPrevOrder;
uniform int uW;
uniform int uN;
uniform int uPW;
uniform int uPN;
uniform float uRippleT;
uniform ivec2 uRippleOrigin;
uniform float uBend;
uniform float uLift;
uniform ivec2 uHoverCell;
uniform float uHover;
uniform ivec2 uPulseCell;
uniform float uPulse;
uniform ivec2 uHeroCell;
uniform float uHeroHide;
uniform float uDim;
uniform vec2 uDimOrigin;

out vec2 vUv;
out vec2 vLocal;
out vec2 vPx;
flat out int vMat;
flat out float vSize;
out float vAlpha;
out float vShade;

int imod(int a, int n) { return a - n * int(floor(float(a) / float(n))); }

void main() {
  int id = gl_InstanceID;
  ivec2 local = ivec2(id % uCols, id / uCols);
  ivec2 cell = uFirst + local;
  vec2 center = uOrigin + (vec2(local) + 0.5) * uCell;
  float size = uCell - 2.0 * uInset;

  // filter / intro ripple: each cell flips from the previous layout to the new one
  float dist = length(vec2(cell - uRippleOrigin));
  float p = clamp((uRippleT - dist * 0.05) / 0.6, 0.0, 1.0);
  bool fresh = p >= 0.5;
  float alpha = 1.0;
  int mat = 0;
  if (fresh) {
    mat = int(texelFetch(uOrder, ivec2(imod(cell.x + cell.y * uW, uN), 0), 0).r);
  } else if (uPN > 0) {
    mat = int(texelFetch(uPrevOrder, ivec2(imod(cell.x + cell.y * uPW, uPN), 0), 0).r);
  } else {
    alpha = 0.0;
  }
  float ang = p * 3.14159265;
  float squeeze = abs(cos(ang));

  float scale = 1.0;
  if (cell == uHoverCell) scale += 0.03 * uHover;
  if (cell == uPulseCell) scale += 0.07 * sin(3.14159265 * uPulse);

  // detail mode: everything recedes, staggered from the hero
  float far = length(center - uDimOrigin) / length(uViewport);
  float dim = clamp(uDim * 1.5 - far * 0.5, 0.0, 1.0);
  scale *= 1.0 - 0.07 * dim;
  alpha *= 1.0 - dim;
  if (cell == uHeroCell) alpha *= 1.0 - uHeroHide;

  vec2 q = (aPos - 0.5) * (size + 2.0);
  vLocal = q;
  q.x *= squeeze;
  q.y *= 1.0 + 0.14 * sin(ang) * (aPos.x * 2.0 - 1.0);
  q *= scale;
  vec2 screen = center + q;

  vec2 c = uViewport * 0.5;
  vec2 d = (screen - c) / (0.5 * length(uViewport));
  screen = c + (screen - c) * (1.0 - uBend * dot(d, d)) * (1.0 - uLift);

  vPx = screen;
  vUv = vLocal / size + 0.5;
  vMat = mat;
  vSize = size * scale;
  vAlpha = alpha;
  vShade = 1.0 - 0.35 * sin(ang);
  vec2 ndc = screen / uViewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const gridFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormal;
uniform sampler2D uMatData;
uniform float uTime;
uniform float uRadius;
uniform vec3 uAccent;
${common}

in vec2 vUv;
in vec2 vLocal;
in vec2 vPx;
flat in int vMat;
flat in float vSize;
in float vAlpha;
in float vShade;
out vec4 outColor;

void main() {
  if (vAlpha <= 0.001) discard;
  // rounded rect, anti-aliased in screen space
  vec2 h = vec2(vSize * 0.5);
  vec2 qd = abs(vLocal) - h + uRadius;
  float sdf = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - uRadius;
  float aa = max(fwidth(sdf), 1e-3);
  float cover = clamp(0.5 - sdf / aa, 0.0, 1.0);
  if (cover <= 0.0) discard;

  vec4 d0 = texelFetch(uMatData, ivec2(vMat, 0), 0); // rough, normal, spec, colourLoadedAt
  vec4 d1 = texelFetch(uMatData, ivec2(vMat, 1), 0); // avg rgb, normalLoadedAt
  vec4 d2 = texelFetch(uMatData, ivec2(vMat, 2), 0); // selected
  float ca = clamp((uTime - d0.w) / 0.45, 0.0, 1.0);
  float na = clamp((uTime - d1.w) / 0.6, 0.0, 1.0);
  vec3 uvw = vec3(clamp(vUv, 0.0, 1.0), float(vMat));
  vec3 albedo = mix(d1.rgb, texture(uAlbedo, uvw).rgb, ca);
  vec3 n = texture(uNormal, uvw).xyz * 2.0 - 1.0;
  n = normalize(vec3(n.xy * d0.y * na, max(n.z, 0.2)));

  vec3 col = shade(albedo, n, d0.x, d0.z, vPx) * vShade;

  // selection marker
  if (d2.x > 0.5) {
    vec2 dotC = vec2(h.x - 14.0, -h.y + 14.0);
    float r = length(vLocal - dotC);
    float ring = smoothstep(6.5, 5.5, r);
    float core = smoothstep(4.6, 3.6, r);
    col = mix(col, vec3(0.006), ring * 0.85);
    col = mix(col, uAccent, core);
  }

  float a = cover * vAlpha;
  outColor = vec4(toScreen(col) * a, a);
}
`;

export const quadVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
uniform vec2 uViewport;
uniform vec4 uRect;
out vec2 vLocal;
void main() {
  vLocal = (aPos - 0.0) * uRect.zw;
  vec2 screen = uRect.xy + vLocal;
  vec2 ndc = screen / uViewport * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const heroFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform vec4 uRect;
uniform vec3 uWin;        // window origin (cm) and cm per css px
uniform float uPhys;      // cm covered by one texture repeat
uniform vec2 uCrop;       // swatch origin (uv)
uniform vec3 uTile;       // tile w, h (cm), plank flag
uniform vec2 uTileOff;    // shifts the joint grid so the swatch sits mid-tile
uniform float uJointW;    // cm
uniform vec4 uJoint;      // grout colour (linear) + visibility
uniform float uDetailMix;
uniform sampler2D uDetC;
uniform sampler2D uDetN;
uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormal;
uniform int uLayer;
uniform float uLayerReady;
uniform vec3 uAvg;
uniform vec3 uShade;      // rough, normal strength, spec
uniform float uRadius;
uniform float uOpacity;
${common}

in vec2 vLocal;
out vec4 outColor;

void main() {
  vec2 h = uRect.zw * 0.5;
  vec2 qd = abs(vLocal - h) - h + uRadius;
  float sdf = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - uRadius;
  float cover = clamp(0.5 - sdf / max(fwidth(sdf), 1e-3), 0.0, 1.0);
  if (cover <= 0.0) discard;

  vec2 P = uWin.xy + vLocal * uWin.z;          // physical position, cm
  vec2 T = uTile.xy;
  vec2 Q = P + uTileOff;
  float row = floor(Q.y / T.y);
  float bond = uTile.z > 0.5 ? hash12(vec2(row, 7.0)) * T.x : 0.0;
  vec2 tp = vec2(Q.x + bond, Q.y);
  vec2 tile = floor(tp / T);
  vec2 inTile = tp - tile * T;
  vec2 tMin = tile * T - vec2(bond, 0.0) - uTileOff;
  bool anchor = tMin.x < 60.0 && tMin.x + T.x > 0.0 && tMin.y < 60.0 && tMin.y + T.y > 0.0;
  vec2 face = anchor ? vec2(0.0) : floor(hash22(tile + 17.0) * 8.0) / 8.0;

  vec2 uvC = P / uPhys;                         // continuous coords for derivatives
  vec2 dx = dFdx(uvC), dy = dFdy(uvC);
  vec2 uv = uCrop + uvC + face;
  vec3 det = textureGrad(uDetC, uv, dx, dy).rgb;
  vec3 detN = textureGrad(uDetN, uv, dx, dy).xyz;

  vec2 sw = P / 60.0;
  bool inSw = all(greaterThanEqual(sw, vec2(0.0))) && all(lessThanEqual(sw, vec2(1.0)));
  vec3 swC = texture(uAlbedo, vec3(clamp(sw, 0.0, 1.0), float(uLayer))).rgb;
  vec3 swN = texture(uNormal, vec3(clamp(sw, 0.0, 1.0), float(uLayer))).xyz;
  vec3 fallC = inSw ? mix(uAvg, swC, uLayerReady) : uAvg;
  vec3 fallN = inSw && uLayerReady > 0.5 ? swN : vec3(0.5, 0.5, 1.0);

  vec3 albedo = mix(fallC, det, uDetailMix);
  vec3 n = mix(fallN, detN, uDetailMix) * 2.0 - 1.0;
  n = normalize(vec3(n.xy * uShade.y, max(n.z, 0.2)));
  float rough = uShade.x;
  float spec = uShade.z;

  // joints: recessed grout with a soft bevel on the tile edge
  vec2 e2 = min(inTile, T - inTile);
  float e = min(e2.x, e2.y);
  float hw = uJointW * 0.5;
  float aa = uWin.z * 0.8;
  float joint = (1.0 - smoothstep(hw - aa, hw + aa, e)) * uJoint.a;
  float bevel = (1.0 - smoothstep(hw, hw + max(0.25, aa * 2.0), e)) * uJoint.a;
  vec2 grad = vec2(e2.x < e2.y ? (inTile.x < T.x * 0.5 ? 1.0 : -1.0) : 0.0,
                   e2.y <= e2.x ? (inTile.y < T.y * 0.5 ? -1.0 : 1.0) : 0.0);
  n = normalize(mix(n, normalize(vec3(grad * 0.8, 1.0)), bevel * (1.0 - joint) * 0.6));
  albedo *= 1.0 - 0.18 * bevel * (1.0 - joint);
  albedo = mix(albedo, uJoint.rgb, joint);
  n = normalize(mix(n, vec3(0.0, 0.0, 1.0), joint));
  rough = mix(rough, 0.92, joint);
  spec = mix(spec, 0.04, joint);

  vec2 px = uRect.xy + vLocal;
  vec3 col = shade(albedo, n, rough, spec, px);
  float a = cover * uOpacity;
  outColor = vec4(toScreen(col) * a, a);
}
`;

export const bgVert = /* glsl */ `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`;

export const bgFrag = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uViewport;
uniform float uPxRatio;
uniform vec3 uBg;
uniform float uAlpha;
${common}
out vec4 outColor;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uViewport.y * uPxRatio - gl_FragCoord.y) / uPxRatio;
  vec2 d = px - uLight.xy;
  float glow = uLightK / (1.0 + dot(d, d) / (uLightR * uLightR * 1.6));
  vec3 col = uBg + vec3(0.030, 0.024, 0.018) * glow;
  float grain = hash12(gl_FragCoord.xy) - 0.5;
  vec3 c = toScreen(col) + grain / 255.0 * 1.5;
  outColor = vec4(c * uAlpha, uAlpha);
}
`;
