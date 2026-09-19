'use client';

// Perspective-correct image warp via WebGL.
//
// HTML5 2D canvas transforms are affine-only (6 params) and therefore CANNOT render a true
// perspective/projective warp — a rectangle can only ever become a parallelogram. To map an
// image rectangle onto an ARBITRARY quadrilateral (the four draggable corners of a Photoshop
// "Distort"/"Perspective"/"Skew" transform), we render it as a single textured quad on a shared
// offscreen WebGL canvas and hand the result back as a CanvasImageSource for the 2D pipeline to
// drawImage(). The perspective-correctness comes from the classic projective-texcoord ("vec3 q")
// trick: each corner carries a weight q derived from the quad's diagonal intersection, the texture
// coords are passed as (u*q, v*q, q), and the fragment shader divides by q — so interpolation is
// perspective-correct across the quad with no triangle "swimming" and no matrix solver.
//
// One module-level GL context is lazily created on first use (never at import — SSR-safe) and
// reused for every box. If WebGL is unavailable the warp returns null and the caller falls back
// to a plain (unwarped) drawImage.

export type WarpPt = { x: number; y: number };

const VERT = `
attribute vec2 a_pos;     // clip-space position (-1..1)
attribute vec3 a_uvq;     // projective texcoord (u*q, v*q, q)
varying vec3 v_uvq;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uvq = a_uvq;
}`;

const FRAG = `
precision mediump float;
varying vec3 v_uvq;
uniform sampler2D u_tex;
void main() {
  vec2 uv = v_uvq.xy / v_uvq.z;   // perspective divide -> perspective-correct sample
  gl_FragColor = texture2D(u_tex, uv);
}`;

let glCanvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;
let tex: WebGLTexture | null = null;
let vbo: WebGLBuffer | null = null;
let aPos = -1, aUvq = -1;
let maxTexSize = 0;
let initFailed = false;

function compile(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = g.createShader(type);
  if (!sh) return null;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) { g.deleteShader(sh); return null; }
  return sh;
}

function init(): boolean {
  if (gl && program) return true;
  if (initFailed) return false;
  if (typeof document === 'undefined') return false;
  const c = document.createElement('canvas');
  const g = (c.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true, depth: false, stencil: false })
    || c.getContext('experimental-webgl', { alpha: true, premultipliedAlpha: false, antialias: true })) as WebGLRenderingContext | null;
  if (!g) { initFailed = true; return false; }
  const vs = compile(g, g.VERTEX_SHADER, VERT);
  const fs = compile(g, g.FRAGMENT_SHADER, FRAG);
  const prog = g.createProgram();
  if (!vs || !fs || !prog) { initFailed = true; return false; }
  g.attachShader(prog, vs);
  g.attachShader(prog, fs);
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) { initFailed = true; return false; }
  g.useProgram(prog);
  aPos = g.getAttribLocation(prog, 'a_pos');
  aUvq = g.getAttribLocation(prog, 'a_uvq');
  g.uniform1i(g.getUniformLocation(prog, 'u_tex'), 0);
  vbo = g.createBuffer();
  tex = g.createTexture();
  if (!vbo || !tex) { initFailed = true; return false; }
  maxTexSize = (g.getParameter(g.MAX_TEXTURE_SIZE) as number) || 4096;
  g.bindTexture(g.TEXTURE_2D, tex);
  // Non-power-of-two source: clamp + linear, no mipmaps.
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.disable(g.BLEND);     // single quad, no self-overlap → write straight-alpha texels directly
  g.clearColor(0, 0, 0, 0);
  glCanvas = c;
  gl = g;
  program = prog;
  // On context loss, drop every cached GL object so the next call rebuilds from scratch on a fresh
  // context. {once} auto-removes this listener (the discarded canvas gets a new one on re-init).
  c.addEventListener('webglcontextlost', e => { e.preventDefault(); gl = null; program = null; tex = null; vbo = null; glCanvas = null; initFailed = false; }, { once: true });
  return true;
}

// Line-line intersection of the quad's diagonals (P0P2 and P1P3). Returns null if (near-)parallel.
function diagIntersection(c: WarpPt[]): WarpPt | null {
  const [p0, p1, p2, p3] = c;
  const r = { x: p2.x - p0.x, y: p2.y - p0.y };
  const s = { x: p3.x - p1.x, y: p3.y - p1.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((p1.x - p0.x) * s.y - (p1.y - p0.y) * s.x) / denom;
  return { x: p0.x + t * r.x, y: p0.y + t * r.y };
}

// Per-corner perspective weights from the diagonal intersection X:
// q_i = (d_i + d_opposite) / d_opposite, where d is the distance from the corner to X.
function quadWeights(c: WarpPt[]): [number, number, number, number] | null {
  const x = diagIntersection(c);
  if (!x) return null;
  const d = c.map(p => Math.hypot(p.x - x.x, p.y - x.y));
  if (d[0] < 1e-6 || d[1] < 1e-6 || d[2] < 1e-6 || d[3] < 1e-6) return null;
  return [
    (d[0] + d[2]) / d[2],
    (d[1] + d[3]) / d[3],
    (d[2] + d[0]) / d[0],
    (d[3] + d[1]) / d[1],
  ];
}

/**
 * Warp `src` (a rectangular image/canvas) onto the quad `corners` (tl, tr, br, bl — clockwise),
 * given in OUTPUT pixel space (0..outW, 0..outH, top-left origin). Returns the shared GL canvas
 * (sized outW×outH) holding the perspective-correct result, or null if WebGL is unavailable or
 * the quad is degenerate (caller should fall back to a plain drawImage).
 */
export function warpImageToQuad(
  src: TexImageSource,
  corners: [WarpPt, WarpPt, WarpPt, WarpPt],
  outW: number,
  outH: number,
): HTMLCanvasElement | null {
  if (!init() || !gl || !glCanvas || !program) return null;
  const g = gl;
  const w = Math.max(1, Math.round(outW));
  const h = Math.max(1, Math.round(outH));
  const q = quadWeights(corners);
  if (!q) return null;
  // Stay within the GPU's texture/viewport limit. An oversized texImage2D raises a GL error that is
  // NOT a JS throw (so the try/catch below won't see it) and would leave a broken/blank canvas — so
  // bail here and let the caller fall back to a plain (unwarped) drawImage. This only bites a
  // near-full-slide perspective box at 4× export on a GPU with a small (4096) limit.
  const srcW = (src as { width?: number }).width ?? 0;
  const srcH = (src as { height?: number }).height ?? 0;
  if (w > maxTexSize || h > maxTexSize || srcW > maxTexSize || srcH > maxTexSize) return null;

  if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
  g.viewport(0, 0, w, h);

  // tl, tr, br, bl
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const order = [0, 1, 2, 0, 2, 3];   // two triangles
  const data = new Float32Array(order.length * 5);
  let o = 0;
  for (const i of order) {
    const p = corners[i];
    data[o++] = (2 * p.x) / w - 1;       // clip x
    data[o++] = 1 - (2 * p.y) / h;       // clip y (top-left origin → clip space)
    data[o++] = uv[i][0] * q[i];         // u*q
    data[o++] = uv[i][1] * q[i];         // v*q
    data[o++] = q[i];                    // q
  }

  g.useProgram(program);
  g.bindBuffer(g.ARRAY_BUFFER, vbo);
  g.bufferData(g.ARRAY_BUFFER, data, g.DYNAMIC_DRAW);
  const stride = 5 * 4;
  g.enableVertexAttribArray(aPos);
  g.vertexAttribPointer(aPos, 2, g.FLOAT, false, stride, 0);
  g.enableVertexAttribArray(aUvq);
  g.vertexAttribPointer(aUvq, 3, g.FLOAT, false, stride, 2 * 4);

  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, tex);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  try {
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
  } catch {
    return null;   // e.g. a tainted/cross-origin source
  }

  g.clear(g.COLOR_BUFFER_BIT);
  g.drawArrays(g.TRIANGLES, 0, 6);
  return glCanvas;
}
