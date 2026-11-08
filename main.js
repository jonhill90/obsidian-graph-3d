'use strict';
/*
 * Graph 3D — a dependency-free 3D graph view for the Research vault.
 *
 * Plain CommonJS, no build step, no network calls, no eval / new Function.
 * Rendering: raw WebGL 1 (additive-glow point sprites + line links).
 * Layout: 3D force simulation with a Barnes-Hut octree, run in time-boxed
 * chunks on the main thread so the UI stays responsive.
 * Colours: read at load time from .obsidian/graph.json colour groups
 * (read-only; this plugin never writes graph.json or any note).
 */
const { Plugin, ItemView, Notice } = require('obsidian');

const VIEW_TYPE = 'graph-3d-view';

/* ------------------------------------------------------------------ math */

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/* ---------------------------------------------------------------- colour */

const colourProbe = (() => {
  let ctx = null;
  return (css, fallback) => {
    if (!css) return fallback;
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = '#010203';
    ctx.fillStyle = css.trim();
    const v = ctx.fillStyle;
    if (v === '#010203' && css.trim() !== '#010203') return fallback;
    if (v[0] === '#') {
      const n = parseInt(v.slice(1), 16);
      return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }
    const m = v.match(/[\d.]+/g);
    return m ? [m[0] / 255, m[1] / 255, m[2] / 255] : fallback;
  };
})();

function rgbIntToVec(n) {
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/* ---------------------------------------------------------------- layout */

/** 3D force layout: many-body (Barnes-Hut), links, folder clustering. */
class Layout {
  constructor(n, links, groupOf, groupCount) {
    this.n = n;
    this.x = new Float32Array(n); this.y = new Float32Array(n); this.z = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.links = links; // Int32Array [s0,t0,s1,t1,...]
    this.deg = new Float32Array(n);
    for (let i = 0; i < links.length; i += 2) { this.deg[links[i]]++; this.deg[links[i + 1]]++; }
    this.groupOf = groupOf;
    this.alpha = 1;
    this.alphaMin = 0.001;
    this.alphaDecay = 1 - Math.pow(this.alphaMin, 1 / 300);
    this.velocityDecay = 0.4;
    this.charge = -45;
    this.linkDistance = 34;
    this.clusterStrength = 0.035;
    this.theta2 = 1.0;
    this.ticks = 0;

    // Folder anchors on a Fibonacci sphere: each top-level folder gets a home.
    const R = 360;
    this.ax = new Float32Array(groupCount); this.ay = new Float32Array(groupCount); this.az = new Float32Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
      const t = groupCount === 1 ? 0.5 : g / (groupCount - 1);
      const yy = 1 - 2 * t, r = Math.sqrt(Math.max(0, 1 - yy * yy));
      const phi = g * Math.PI * (3 - Math.sqrt(5));
      this.ax[g] = Math.cos(phi) * r * R; this.ay[g] = yy * R * 0.6; this.az[g] = Math.sin(phi) * r * R;
    }
    for (let i = 0; i < n; i++) {
      const g = groupOf[i];
      this.x[i] = this.ax[g] + gauss() * 90;
      this.y[i] = this.ay[g] + gauss() * 90;
      this.z[i] = this.az[g] + gauss() * 90;
    }
  }

  get settled() { return this.alpha < this.alphaMin; }

  reheat(a) { this.alpha = Math.max(this.alpha, a); }

  tick() {
    const { n, x, y, z, vx, vy, vz } = this;
    const alpha = this.alpha;
    this.manyBody(alpha);

    // Links (d3-force style, degree-biased).
    const L = this.links, deg = this.deg, dist = this.linkDistance;
    for (let k = 0; k < L.length; k += 2) {
      const s = L[k], t = L[k + 1];
      let dx = x[t] + vx[t] - x[s] - vx[s];
      let dy = y[t] + vy[t] - y[s] - vy[s];
      let dz = z[t] + vz[t] - z[s] - vz[s];
      let l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      const strength = 1 / Math.min(deg[s], deg[t]);
      l = (l - dist) / l * alpha * strength;
      dx *= l; dy *= l; dz *= l;
      const b = deg[s] / (deg[s] + deg[t]);
      vx[t] -= dx * b; vy[t] -= dy * b; vz[t] -= dz * b;
      vx[s] += dx * (1 - b); vy[s] += dy * (1 - b); vz[s] += dz * (1 - b);
    }

    // Folder clustering.
    const cs = this.clusterStrength * alpha, g = this.groupOf;
    for (let i = 0; i < n; i++) {
      const a = g[i];
      vx[i] += (this.ax[a] - x[i]) * cs;
      vy[i] += (this.ay[a] - y[i]) * cs;
      vz[i] += (this.az[a] - z[i]) * cs;
    }

    const keep = 1 - this.velocityDecay;
    for (let i = 0; i < n; i++) {
      vx[i] *= keep; vy[i] *= keep; vz[i] *= keep;
      x[i] += vx[i]; y[i] += vy[i]; z[i] += vz[i];
    }
    this.alpha += (0 - this.alpha) * this.alphaDecay;
    this.ticks++;
  }

  manyBody(alpha) {
    const { n, x, y, z, vx, vy, vz } = this;
    // Bounds.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i];
      if (z[i] < z0) z0 = z[i]; if (z[i] > z1) z1 = z[i];
    }
    const half = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2 + 1;
    const root = new Cell((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, half);
    for (let i = 0; i < n; i++) root.insert(i, x[i], y[i], z[i], 0);
    root.finish();

    const w0 = this.charge * alpha, th2 = this.theta2;
    const stack = [];
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i], zi = z[i];
      let fx = 0, fy = 0, fz = 0;
      stack.length = 0; stack.push(root);
      while (stack.length) {
        const c = stack.pop();
        const dx = c.cx - xi, dy = c.cy - yi, dz = c.cz - zi;
        let d2 = dx * dx + dy * dy + dz * dz;
        const width = c.h * 2;
        if (c.kids === null) {
          for (let b = 0; b < c.bodies.length; b++) {
            const j = c.bodies[b];
            if (j === i) continue;
            const ex = x[j] - xi, ey = y[j] - yi, ez = z[j] - zi;
            let e2 = ex * ex + ey * ey + ez * ez;
            if (e2 < 1) e2 = 1;
            const w = w0 / e2;
            fx += ex * w; fy += ey * w; fz += ez * w;
          }
        } else if (width * width / Math.max(d2, 1e-9) < th2) {
          if (d2 < 1) d2 = 1;
          const w = w0 * c.mass / d2;
          fx += dx * w; fy += dy * w; fz += dz * w;
        } else {
          for (let k = 0; k < 8; k++) if (c.kids[k]) stack.push(c.kids[k]);
        }
      }
      vx[i] += fx; vy[i] += fy; vz[i] += fz;
    }
  }
}

class Cell {
  constructor(x, y, z, h) {
    this.x = x; this.y = y; this.z = z; this.h = h;
    this.mass = 0; this.cx = 0; this.cy = 0; this.cz = 0;
    this.kids = null; this.bodies = [];
  }
  insert(i, px, py, pz, depth) {
    this.mass++; this.cx += px; this.cy += py; this.cz += pz;
    if (this.kids === null) {
      if (this.bodies.length === 0 || depth > 18) { this.bodies.push(i); return; }
      // Subdivide and push the existing bodies down.
      this.kids = new Array(8).fill(null);
      const old = this.bodies; this.bodies = [];
      for (const j of old) this.child(this._px(j), this._py(j), this._pz(j)).insert(j, this._px(j), this._py(j), this._pz(j), depth + 1);
    }
    this.child(px, py, pz).insert(i, px, py, pz, depth + 1);
  }
  child(px, py, pz) {
    const k = (px >= this.x ? 1 : 0) | (py >= this.y ? 2 : 0) | (pz >= this.z ? 4 : 0);
    if (!this.kids[k]) {
      const h = this.h / 2;
      this.kids[k] = new Cell(this.x + (k & 1 ? h : -h), this.y + (k & 2 ? h : -h), this.z + (k & 4 ? h : -h), h);
    }
    return this.kids[k];
  }
  finish() {
    if (this.mass) { this.cx /= this.mass; this.cy /= this.mass; this.cz /= this.mass; }
    if (this.kids) for (const k of this.kids) if (k) k.finish();
  }
}
// Positions of bodies already stored in a leaf are needed when it splits.
Cell.prototype._px = function (j) { return Cell.P.x[j]; };
Cell.prototype._py = function (j) { return Cell.P.y[j]; };
Cell.prototype._pz = function (j) { return Cell.P.z[j]; };
Cell.P = null;

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------------------------------------------------------------- shaders */

const NODE_VS = `
attribute vec3 aPos; attribute vec3 aCol; attribute float aSize; attribute float aDim;
uniform mat4 uVP; uniform float uScale;
varying vec3 vCol; varying float vDim;
void main() {
  vec4 p = uVP * vec4(aPos, 1.0);
  gl_Position = p;
  gl_PointSize = clamp(aSize * uScale / max(p.w, 1.0), 1.5, 120.0);
  vCol = aCol; vDim = aDim;
}`;

const NODE_FS = `
precision mediump float;
varying vec3 vCol; varying float vDim;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = smoothstep(0.10, 0.0, r2);
  float body = smoothstep(0.16, 0.06, r2);
  float halo = exp(-r2 * 6.0) * 0.45;
  vec3 col = vCol * (halo + body * 0.75) + vec3(core * 0.55);
  gl_FragColor = vec4(col * vDim, 1.0);
}`;

const LINE_VS = `
attribute vec3 aPos; attribute vec4 aCol;
uniform mat4 uVP;
varying vec4 vCol;
void main() { gl_Position = uVP * vec4(aPos, 1.0); vCol = aCol; }`;

const LINE_FS = `
precision mediump float;
varying vec4 vCol;
void main() { gl_FragColor = vec4(vCol.rgb * vCol.a, 1.0); }`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const a = gl.getActiveAttrib(p, i); loc[a.name] = gl.getAttribLocation(p, a.name); }
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
  return { p, loc };
}

/* ------------------------------------------------------------------ view */

class Graph3DView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.raf = 0;
    this.cam = { yaw: 0.6, pitch: 0.35, dist: 1500, tx: 0, ty: 0, tz: 0 };
    this.camGoal = null;
    this.autoOrbit = true;
    this.lastInput = 0;
    this.hover = -1;
    this.focus = -1;
    this.highlight = null; // Set of node indices or null
    this.mouse = null;
    this.stats = { nodes: 0, links: 0, settleMs: null, fps: 0, frameMs: 0, openedAt: 0 };
    this.frameTimes = [];
    this.forceRender = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Graph 3D'; }
  getIcon() { return 'orbit'; }

  async onOpen() {
    this.stats.openedAt = performance.now();
    const root = this.contentEl;
    root.empty();
    root.addClass('graph3d-root');
    this.glCanvas = root.createEl('canvas', { cls: 'graph3d-gl' });
    this.labelCanvas = root.createEl('canvas', { cls: 'graph3d-labels' });
    this.buildHud(root);

    const gl = this.glCanvas.getContext('webgl', { antialias: true, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) { root.createDiv({ cls: 'graph3d-error', text: 'WebGL is not available.' }); return; }
    this.gl = gl;
    this.nodeProg = compile(gl, NODE_VS, NODE_FS);
    this.lineProg = compile(gl, LINE_VS, LINE_FS);
    this.lctx = this.labelCanvas.getContext('2d');

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(root);
    this.resize();
    this.bindInput();

    await this.buildGraph();
    this.requestFrame();
  }

  async onClose() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    if (this.resizeObs) this.resizeObs.disconnect();
    const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.gl = null;
  }

  /* ---------------------------------------------------------- data */

  async buildGraph() {
    const app = this.app;
    const cfg = await this.plugin.readGraphConfig();
    const excludes = cfg.excludes;
    const files = app.vault.getMarkdownFiles().filter(f => !excludes.some(ex => f.path.includes(ex)));
    const index = new Map();
    files.forEach((f, i) => index.set(f.path, i));

    // Undirected, de-duplicated resolved links.
    const resolved = app.metadataCache.resolvedLinks;
    const seen = new Set();
    const pairs = [];
    for (const src in resolved) {
      const s = index.get(src);
      if (s === undefined) continue;
      for (const dst in resolved[src]) {
        const t = index.get(dst);
        if (t === undefined || t === s) continue;
        const key = s < t ? s * 1e6 + t : t * 1e6 + s;
        if (seen.has(key)) continue;
        seen.add(key); pairs.push(s, t);
      }
    }
    const links = new Int32Array(pairs);

    // Groups: top-level folder; colours from graph.json colour groups.
    const groupNames = [];
    const groupIdx = new Map();
    const groupOf = new Int32Array(files.length);
    const fallback = colourProbe(getComputedStyle(document.body).getPropertyValue('--graph-node'), [0.6, 0.6, 0.6]);
    const colours = new Float32Array(files.length * 3);
    files.forEach((f, i) => {
      const top = f.path.includes('/') ? f.path.split('/')[0] : '(root)';
      if (!groupIdx.has(top)) { groupIdx.set(top, groupNames.length); groupNames.push(top); }
      groupOf[i] = groupIdx.get(top);
      let c = fallback;
      for (const g of cfg.groups) { if (f.path.includes(g.path)) { c = g.rgb; break; } }
      colours[i * 3] = c[0]; colours[i * 3 + 1] = c[1]; colours[i * 3 + 2] = c[2];
    });

    this.files = files;
    this.links = links;
    this.colours = colours;
    this.groupNames = groupNames;
    this.layout = new Layout(files.length, links, groupOf, groupNames.length);
    Cell.P = this.layout;
    const deg = this.layout.deg;
    this.neighbours = Array.from({ length: files.length }, () => []);
    for (let k = 0; k < links.length; k += 2) { this.neighbours[links[k]].push(links[k + 1]); this.neighbours[links[k + 1]].push(links[k]); }
    this.sizes = new Float32Array(files.length);
    for (let i = 0; i < files.length; i++) this.sizes[i] = 9 + Math.sqrt(deg[i]) * 4.5;
    this.dims = new Float32Array(files.length).fill(1);
    this.linePos = new Float32Array(links.length * 3);
    this.lineCol = new Float32Array(links.length * 4);
    this.updateLineColours();

    this.stats.nodes = files.length;
    this.stats.links = links.length / 2;
    this.stats.settleMs = null;
    this.stats.buildMs = performance.now() - this.stats.openedAt;
    this.uploadStatic();
    this.makeStars();
    this.updateHud();
  }

  uploadStatic() {
    const gl = this.gl;
    const mk = () => gl.createBuffer();
    this.buf = this.buf || { pos: mk(), col: mk(), size: mk(), dim: mk(), lpos: mk(), lcol: mk(), spos: mk(), scol: mk(), ssize: mk(), sdim: mk() };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.col); gl.bufferData(gl.ARRAY_BUFFER, this.colours, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.size); gl.bufferData(gl.ARRAY_BUFFER, this.sizes, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.dim); gl.bufferData(gl.ARRAY_BUFFER, this.dims, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lcol); gl.bufferData(gl.ARRAY_BUFFER, this.lineCol, gl.DYNAMIC_DRAW);
  }

  makeStars() {
    const gl = this.gl, N = 2500;
    const p = new Float32Array(N * 3), c = new Float32Array(N * 3), s = new Float32Array(N), d = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 5000 + Math.random() * 7000;
      const q = Math.sqrt(1 - u * u);
      p[i * 3] = Math.cos(th) * q * r; p[i * 3 + 1] = u * r; p[i * 3 + 2] = Math.sin(th) * q * r;
      const tint = Math.random();
      c[i * 3] = 0.75 + 0.25 * tint; c[i * 3 + 1] = 0.8; c[i * 3 + 2] = 1.0 - 0.2 * tint;
      s[i] = 10 + Math.random() * 30; d[i] = 0.12 + Math.random() * 0.25;
    }
    this.starCount = N;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.spos); gl.bufferData(gl.ARRAY_BUFFER, p, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.scol); gl.bufferData(gl.ARRAY_BUFFER, c, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.ssize); gl.bufferData(gl.ARRAY_BUFFER, s, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.sdim); gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
  }

  updateLineColours() {
    const L = this.links, C = this.colours, out = this.lineCol, H = this.highlight;
    const centre = this.focus >= 0 ? this.focus : this.hover;
    for (let k = 0, v = 0; k < L.length; k += 2) {
      const s = L[k], t = L[k + 1];
      let a = 0.07;
      if (H) a = (s === centre || t === centre) ? 0.75 : 0.012;
      for (const n of [s, t]) {
        out[v++] = C[n * 3]; out[v++] = C[n * 3 + 1]; out[v++] = C[n * 3 + 2]; out[v++] = a;
      }
    }
  }

  setHighlight(centre) {
    if (centre < 0) { this.highlight = null; this.dims.fill(1); }
    else {
      const H = new Set([centre, ...this.neighbours[centre]]);
      this.highlight = H;
      for (let i = 0; i < this.dims.length; i++) this.dims[i] = H.has(i) ? (i === centre ? 1.6 : 1.15) : 0.1;
    }
    this.updateLineColours();
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.dim); gl.bufferData(gl.ARRAY_BUFFER, this.dims, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lcol); gl.bufferData(gl.ARRAY_BUFFER, this.lineCol, gl.DYNAMIC_DRAW);
    this.requestFrame();
  }

  /* ---------------------------------------------------------- HUD */

  buildHud(root) {
    const hud = root.createDiv({ cls: 'graph3d-hud' });
    this.hudStats = hud.createDiv({ cls: 'graph3d-stats' });
    const row = hud.createDiv({ cls: 'graph3d-row' });
    this.search = row.createEl('input', { cls: 'graph3d-search', attr: { type: 'search', placeholder: 'find note…', spellcheck: 'false' } });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.findAndFocus(this.search.value);
      if (e.key === 'Escape') { this.search.value = ''; this.clearFocus(); }
      e.stopPropagation();
    });
    const btn = (label, title, fn) => { const b = row.createEl('button', { cls: 'graph3d-btn', text: label, attr: { 'aria-label': title } }); b.onclick = fn; return b; };
    this.orbitBtn = btn('orbit', 'Toggle slow auto-orbit', () => { this.autoOrbit = !this.autoOrbit; this.updateHud(); this.requestFrame(); });
    btn('reset', 'Reset camera', () => { this.clearFocus(); this.camGoal = { ...this.centre(), dist: this.fitDistance() }; this.requestFrame(); });
    btn('reheat', 'Re-run the layout', () => { if (this.layout) { this.layout.reheat(0.5); this.stats.settleMs = null; this.settleStart = performance.now(); this.requestFrame(); } });
    btn('rebuild', 'Reload notes and links', async () => { this.clearFocus(); this.stats.openedAt = performance.now(); await this.buildGraph(); this.requestFrame(); });
    this.card = root.createDiv({ cls: 'graph3d-card is-hidden' });
  }

  updateHud() {
    if (!this.hudStats) return;
    const s = this.stats;
    const settle = s.settleMs == null ? 'settling…' : `settled ${(s.settleMs / 1000).toFixed(2)}s`;
    this.hudStats.setText(`${s.nodes} notes · ${s.links} links · ${settle} · ${s.fps.toFixed(0)} fps`);
    if (this.orbitBtn) this.orbitBtn.toggleClass('is-active', this.autoOrbit);
  }

  showCard(i) {
    const card = this.card;
    card.empty();
    if (i < 0) { card.addClass('is-hidden'); return; }
    card.removeClass('is-hidden');
    const f = this.files[i];
    card.createDiv({ cls: 'graph3d-card-title', text: f.basename });
    card.createDiv({ cls: 'graph3d-card-path', text: f.parent ? f.parent.path : '' });
    card.createDiv({ cls: 'graph3d-card-meta', text: `${this.neighbours[i].length} links · click again to open` });
    const open = card.createEl('button', { cls: 'graph3d-btn', text: 'open' });
    open.onclick = () => this.openNode(i);
  }

  /* ---------------------------------------------------------- input */

  bindInput() {
    const el = this.glCanvas;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey, button: e.button };
      el.setPointerCapture(e.pointerId);
      this.lastInput = performance.now();
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
        if (down.moved) {
          if (down.pan) this.pan(dx, dy);
          else { this.cam.yaw -= dx * 0.005; this.cam.pitch = Math.max(-1.5, Math.min(1.5, this.cam.pitch + dy * 0.005)); }
          down.x = e.clientX; down.y = e.clientY;
          this.camGoal = null;
        }
        this.lastInput = performance.now();
      }
      this.pendingPick = true;
      this.requestFrame();
    });
    el.addEventListener('pointerup', (e) => {
      if (down && !down.moved && down.button === 0) {
        const i = this.pick(this.mouse.x, this.mouse.y);
        if (i >= 0 && (e.metaKey || e.ctrlKey)) this.openNode(i);
        else if (i >= 0 && i === this.focus) this.openNode(i);
        else if (i >= 0) this.focusNode(i);
        else this.clearFocus();
      }
      down = null;
    });
    el.addEventListener('pointerleave', () => { this.mouse = null; if (this.hover >= 0) { this.hover = -1; if (this.focus < 0) this.setHighlight(-1); } });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(40, Math.min(9000, this.cam.dist * Math.exp(e.deltaY * 0.0012)));
      if (this.camGoal) this.camGoal.dist = undefined;
      this.lastInput = performance.now();
      this.requestFrame();
    }, { passive: false });
    this.registerDomEvent(this.contentEl, 'keydown', (e) => { if (e.key === 'Escape') this.clearFocus(); });
    this.contentEl.tabIndex = 0;
  }

  pan(dx, dy) {
    const c = this.cam, k = c.dist * 0.0012;
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    // camera right = (cos yaw, 0, -sin yaw); approximate up = world up.
    c.tx -= cy * dx * k; c.tz += sy * dx * k; c.ty += dy * k;
  }

  findAndFocus(q) {
    q = q.trim().toLowerCase();
    if (!q || !this.files) return;
    let best = -1, bestScore = -1;
    this.files.forEach((f, i) => {
      const b = f.basename.toLowerCase();
      const at = b.indexOf(q);
      if (at < 0) return;
      const score = (at === 0 ? 1000 : 0) + this.neighbours[i].length - b.length * 0.01;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) this.focusNode(best); else new Notice('Graph 3D: no matching note');
  }

  focusNode(i) {
    this.focus = i;
    this.setHighlight(i);
    this.showCard(i);
    const L = this.layout;
    this.camGoal = { tx: L.x[i], ty: L.y[i], tz: L.z[i], dist: Math.min(this.cam.dist, 420) };
    this.lastInput = performance.now();
    this.requestFrame();
  }

  clearFocus() {
    this.focus = -1;
    this.showCard(-1);
    this.setHighlight(this.hover);
  }

  openNode(i) {
    const f = this.files[i];
    if (f) this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ---------------------------------------------------------- render */

  resize() {
    const r = this.contentEl.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    for (const c of [this.glCanvas, this.labelCanvas]) {
      c.width = Math.round(this.cssW * dpr); c.height = Math.round(this.cssH * dpr);
      c.style.width = this.cssW + 'px'; c.style.height = this.cssH + 'px';
    }
    this.requestFrame();
  }

  requestFrame() {
    if (!this.raf && this.gl) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  wantsAnimation() {
    if (!this.layout) return false;
    if (this.forceRender) return true;
    if (!this.layout.settled) return true;
    if (this.camGoal) return true;
    if (this.autoOrbit) return true;
    return false;
  }

  frame(now) {
    this.raf = 0;
    if (!this.gl || !this.layout) return;
    const idleOrbitOnly = this.layout.settled && !this.camGoal && !this.forceRender && now - this.lastInput > 1000;
    if (idleOrbitOnly && this.lastFrame && now - this.lastFrame < 31) { this.requestFrame(); return; }
    this.frameCount = (this.frameCount || 0) + 1;
    const t0 = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;

    // Layout: time-boxed chunk of ticks.
    const L = this.layout;
    if (!L.settled) {
      if (this.settleStart == null) this.settleStart = this.stats.openedAt;
      const budget = 9;
      do { L.tick(); } while (!L.settled && performance.now() - t0 < budget);
      if (L.settled) {
        this.stats.settleMs = performance.now() - this.settleStart;
        this.stats.settleTicks = L.ticks;
        this.settleStart = null;
        if (!this.fitted && this.focus < 0) { this.fitted = true; this.camGoal = { ...this.centre(), dist: this.fitDistance() }; }
      }
      this.positionsDirty = true;
    }

    // Camera: eased goal, auto-orbit after 4 s without input.
    const c = this.cam;
    if (this.camGoal) {
      const g = this.camGoal, k = 1 - Math.pow(0.004, dt / 1000);
      c.tx += (g.tx - c.tx) * k; c.ty += (g.ty - c.ty) * k; c.tz += (g.tz - c.tz) * k;
      if (g.dist !== undefined) c.dist += (g.dist - c.dist) * k;
      if (Math.abs(g.tx - c.tx) + Math.abs(g.ty - c.ty) + Math.abs(g.tz - c.tz) < 0.5 && (g.dist === undefined || Math.abs(g.dist - c.dist) < 0.5)) this.camGoal = null;
    }
    const orbiting = this.autoOrbit && now - this.lastInput > 4000;
    if (orbiting) c.yaw += dt * 0.00006 * (this.orbitSpeed || 1);

    this.draw();
    this.drawLabels();

    // Stats.
    const ft = performance.now() - t0;
    this.frameTimes.push({ now, ft });
    while (this.frameTimes.length && now - this.frameTimes[0].now > 1000) this.frameTimes.shift();
    this.stats.fps = this.frameTimes.length;
    this.stats.frameMs = this.frameTimes.reduce((a, b) => a + b.ft, 0) / this.frameTimes.length;
    if ((this.hudTick = (this.hudTick || 0) + 1) % 15 === 0) this.updateHud();

    if (this.wantsAnimation() && this.containerEl.isShown()) this.requestFrame();
    else this.updateHud();
  }

  draw() {
    const gl = this.gl, c = this.cam, L = this.layout, n = L.n;
    const W = this.glCanvas.width, H = this.glCanvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const eye = [
      c.tx + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw),
      c.ty + c.dist * Math.sin(c.pitch),
      c.tz + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw),
    ];
    const fov = 0.9;
    const P = perspective(fov, W / H, 5, 30000);
    const V = lookAt(eye, [c.tx, c.ty, c.tz], [0, 1, 0]);
    this.VP = mat4mul(P, V);
    const scale = H / (2 * Math.tan(fov / 2));

    // Positions → GPU when the layout moved.
    if (this.positionsDirty) {
      const pos = this.posArr || (this.posArr = new Float32Array(n * 3));
      for (let i = 0; i < n; i++) { pos[i * 3] = L.x[i]; pos[i * 3 + 1] = L.y[i]; pos[i * 3 + 2] = L.z[i]; }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      const lp = this.linePos, Lk = this.links;
      for (let k = 0, v = 0; k < Lk.length; k++) { const i = Lk[k]; lp[v++] = L.x[i]; lp[v++] = L.y[i]; lp[v++] = L.z[i]; }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lpos); gl.bufferData(gl.ARRAY_BUFFER, lp, gl.DYNAMIC_DRAW);
      this.positionsDirty = false;
    }

    const bind = (prog, name, buf, size) => {
      const loc = prog.loc[name];
      if (loc === undefined || loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };

    // Links.
    const lp = this.lineProg;
    gl.useProgram(lp.p);
    gl.uniformMatrix4fv(lp.loc.uVP, false, this.VP);
    bind(lp, 'aPos', this.buf.lpos, 3);
    bind(lp, 'aCol', this.buf.lcol, 4);
    gl.drawArrays(gl.LINES, 0, this.links.length);
    gl.disableVertexAttribArray(lp.loc.aPos); gl.disableVertexAttribArray(lp.loc.aCol);

    // Stars, then nodes (same program).
    const np = this.nodeProg;
    gl.useProgram(np.p);
    gl.uniformMatrix4fv(np.loc.uVP, false, this.VP);
    gl.uniform1f(np.loc.uScale, scale);
    bind(np, 'aPos', this.buf.spos, 3); bind(np, 'aCol', this.buf.scol, 3);
    bind(np, 'aSize', this.buf.ssize, 1); bind(np, 'aDim', this.buf.sdim, 1);
    gl.drawArrays(gl.POINTS, 0, this.starCount);
    bind(np, 'aPos', this.buf.pos, 3); bind(np, 'aCol', this.buf.col, 3);
    bind(np, 'aSize', this.buf.size, 1); bind(np, 'aDim', this.buf.dim, 1);
    gl.drawArrays(gl.POINTS, 0, n);
    for (const a of ['aPos', 'aCol', 'aSize', 'aDim']) gl.disableVertexAttribArray(np.loc[a]);

    // Hover pick after the matrix is current.
    if (this.pendingPick && this.mouse) {
      this.pendingPick = false;
      const i = this.pick(this.mouse.x, this.mouse.y);
      if (i !== this.hover) {
        this.hover = i;
        this.glCanvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
        if (this.focus < 0) this.setHighlight(i);
      }
    }
  }

  /** Camera distance that frames ~95% of notes. */
  /** Median point of the cloud (robust to far orphans). */
  centre() {
    const L = this.layout, med = (a) => { const s = Array.from(a).sort((p, q) => p - q); return s[s.length >> 1] || 0; };
    return { tx: med(L.x), ty: med(L.y), tz: med(L.z) };
  }

  fitDistance() {
    const L = this.layout, r = [], c = this.centre();
    for (let i = 0; i < L.n; i++) r.push(Math.hypot(L.x[i] - c.tx, L.y[i] - c.ty, L.z[i] - c.tz));
    r.sort((a, b) => a - b);
    const r95 = r[Math.floor(r.length * 0.9)] || 500;
    return Math.max(300, Math.min(8000, r95 / Math.tan(0.45) * 1.1));
  }

  project(i) {
    const m = this.VP, L = this.layout;
    const x = L.x[i], y = L.y[i], z = L.z[i];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1) return null;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    return { x: (cx * 0.5 + 0.5) * this.cssW, y: (1 - (cy * 0.5 + 0.5)) * this.cssH, w };
  }

  pick(mx, my) {
    if (!this.VP || !this.layout) return -1;
    const scale = this.cssH / (2 * Math.tan(0.9 / 2));
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.layout.n; i++) {
      const p = this.project(i);
      if (!p) continue;
      const r = Math.max(5, this.sizes[i] * scale / p.w * 0.22);
      const dx = p.x - mx, dy = p.y - my, d2 = dx * dx + dy * dy;
      if (d2 < r * r && p.w < bestD) { bestD = p.w; best = i; }
    }
    return best;
  }

  drawLabels() {
    const ctx = this.lctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const n = this.layout.n;
    const scale = this.cssH / (2 * Math.tan(0.9 / 2));
    let cand = [];
    if (this.highlight) {
      for (const i of this.highlight) cand.push(i);
      cand.sort((a, b) => (b === this.focus || b === this.hover) - (a === this.focus || a === this.hover) || this.neighbours[b].length - this.neighbours[a].length);
      cand = cand.slice(0, 36);
    } else {
      // Near nodes only: largest on screen.
      const scored = [];
      for (let i = 0; i < n; i++) {
        const p = this.project(i);
        if (!p) continue;
        const px = this.sizes[i] * scale / p.w;
        if (px > 14) scored.push([px, i]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      cand = scored.slice(0, 24).map(s => s[1]);
    }
    const font = this.font || (this.font = getComputedStyle(document.body).getPropertyValue('--font-interface').trim() || 'monospace');
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
    for (const i of cand) {
      const p = this.project(i);
      if (!p || p.x < -50 || p.y < -20 || p.x > this.cssW + 50 || p.y > this.cssH + 20) continue;
      const main = i === this.focus || i === this.hover;
      const px = this.sizes[i] * scale / p.w;
      const a = main ? 1 : Math.max(0.35, Math.min(0.9, px / 60));
      ctx.font = `${main ? 13 : 11}px ${font}`;
      const C = this.colours;
      ctx.fillStyle = main ? `rgba(255,255,255,${a})` : `rgba(${C[i * 3] * 255 | 0},${C[i * 3 + 1] * 255 | 0},${C[i * 3 + 2] * 255 | 0},${a})`;
      ctx.fillText(this.files[i].basename, p.x + Math.max(6, px * 0.18), p.y);
    }
  }
}

/* ---------------------------------------------------------------- plugin */

module.exports = class Graph3DPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new Graph3DView(leaf, this));
    this.addRibbonIcon('orbit', 'Open Graph 3D', () => this.activateView());
    this.addCommand({ id: 'open', name: 'Open Graph 3D', callback: () => this.activateView() });
    this.addCommand({ id: 'benchmark', name: 'Run benchmark (writes bench.json in the plugin folder)', callback: () => this.runBenchmark({}) });

    // ```graph-3d``` code block → a button that opens the view.
    this.registerMarkdownCodeBlockProcessor('graph-3d', (src, el) => {
      const b = el.createEl('button', { cls: 'graph3d-open-btn mod-cta', text: src.trim() || 'Open Graph 3D' });
      b.onclick = () => this.activateView();
    });

    // Measurement hook: a bench-request.json in the plugin folder runs the
    // scripted benchmark once on startup and is then deleted.
    this.app.workspace.onLayoutReady(async () => {
      const req = `${this.manifest.dir}/bench-request.json`;
      if (await this.app.vault.adapter.exists(req)) {
        let opts = {};
        try { opts = JSON.parse(await this.app.vault.adapter.read(req)); } catch (e) { /* use defaults */ }
        await this.app.vault.adapter.remove(req);
        // Wait for the metadata cache so links are present.
        if (!this.app.metadataCache.resolvedLinks || Object.keys(this.app.metadataCache.resolvedLinks).length === 0) {
          await new Promise((res) => { const r = this.app.metadataCache.on('resolved', () => { this.app.metadataCache.offref(r); res(); }); });
        }
        this.runBenchmark(opts);
      }
    });
  }

  async readGraphConfig() {
    const out = { groups: [], excludes: [] };
    try {
      const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/graph.json`);
      const g = JSON.parse(raw);
      for (const cg of g.colorGroups || []) {
        const m = /^path:"?([^"]+)"?$/.exec((cg.query || '').trim());
        if (m && cg.color) out.groups.push({ path: m[1], rgb: rgbIntToVec(cg.color.rgb) });
      }
      for (const m of (g.search || '').matchAll(/-path:"?([^"\s]+)"?/g)) out.excludes.push(m[1]);
    } catch (e) { /* no graph.json: theme colours only */ }
    return out;
  }

  async activateView() {
    const { workspace } = this.app;
    const inMain = (l) => l.getRoot() === workspace.rootSplit;
    let leaf = null;
    for (const l of workspace.getLeavesOfType(VIEW_TYPE)) {
      if (!leaf && inMain(l)) leaf = l; else l.detach();
    }
    if (!leaf) {
      const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
      if (recent) workspace.setActiveLeaf(recent, { focus: false });
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async runBenchmark(opts) {
    const file = `${this.manifest.dir}/bench.json`;
    const out = { startedAt: new Date().toISOString(), phases: [] };
    const write = (phase) => { out.phase = phase; out.phases.push({ phase, at: new Date().toISOString() }); return this.app.vault.adapter.write(file, JSON.stringify(out, null, 2)); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Optional: close leaves showing given notes, for a clean measurement.
    for (const path of opts.closePaths || []) {
      this.app.workspace.getLeavesOfType('markdown').forEach((l) => { if (l.view.file && l.view.file.path === path) l.detach(); });
    }
    const t0 = performance.now();
    const view = await this.activateView();
    while (!view.stats || view.stats.settleMs == null) await sleep(50);
    out.openToSettledMs = Math.round(performance.now() - t0);
    out.settleMs = Math.round(view.stats.settleMs);
    out.settleTicks = view.stats.settleTicks;
    out.buildMs = Math.round(view.stats.buildMs);
    out.nodes = view.stats.nodes;
    out.links = view.stats.links;
    out.viewport = { cssW: view.cssW, cssH: view.cssH, dpr: view.dpr };

    const sample = async (ms) => {
      const frames = [];
      const start = performance.now();
      let last = start;
      await new Promise((res) => {
        const step = () => {
          const now = performance.now();
          frames.push(now - last); last = now;
          if (now - start < ms) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      const sorted = frames.slice().sort((a, b) => a - b);
      return {
        fps: +(frames.length / (ms / 1000)).toFixed(1),
        frameIntervalP50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
        frameIntervalP95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        renderMsAvg: +view.stats.frameMs.toFixed(2),
      };
    };

    // Phase 1: default view with slow auto-orbit, held for a screenshot.
    view.autoOrbit = true; view.lastInput = 0; view.requestFrame();
    await write('default');
    await sleep(opts.holdMs || 8000);

    // Phase 2: forced redraw with a still camera (worst-case "idle" cost).
    view.autoOrbit = false; view.forceRender = true; view.requestFrame();
    await sleep(500);
    out.idleForced = await sample(5000);
    view.forceRender = false;
    // Phase 3: true idle (no orbit, settled) — the view stops drawing.
    await sleep(500);
    await write('idle');
    const f0 = view.frameCount || 0;
    await sleep(opts.idleMs || 10000);
    out.idleFramesDrawn = (view.frameCount || 0) - f0;
    out.idleState = { settled: view.layout.settled, alpha: view.layout.alpha, camGoal: view.camGoal, autoOrbit: view.autoOrbit, forceRender: view.forceRender, hover: view.hover, focus: view.focus, shown: view.containerEl.isShown() };
    out.idleSeconds = (opts.idleMs || 10000) / 1000;
    // Phase 4: orbiting fast.
    view.autoOrbit = true; view.lastInput = 0; view.orbitSpeed = 12; view.forceRender = true; view.requestFrame();
    await sleep(300);
    out.orbiting = await sample(5000);
    view.orbitSpeed = 1; view.forceRender = false;
    await write('orbit-idle');
    const g0 = view.frameCount || 0;
    await sleep(opts.idleMs || 10000);
    out.slowOrbitFpsDrawn = +(((view.frameCount || 0) - g0) / ((opts.idleMs || 10000) / 1000)).toFixed(1);

    // Phase 5: focus mode on one note.
    if (opts.focus) {
      const i = view.files.findIndex((f) => f.path === opts.focus || f.basename === opts.focus);
      if (i >= 0) { view.focusNode(i); out.focus = view.files[i].path; out.focusNeighbours = view.neighbours[i].length; }
      await write('focus');
      await sleep(opts.holdMs || 8000);
      view.clearFocus();
    }

    // Phase 6: side-by-side with a comparison note.
    if (opts.compare) {
      const f = this.app.vault.getAbstractFileByPath(opts.compare);
      if (f) {
        view.cam.dist = view.fitDistance();
        const leaf = this.app.workspace.createLeafBySplit(view.leaf, 'vertical');
        await leaf.openFile(f);
        view.resize();
      }
      await write('compare');
      await sleep(opts.holdMs || 8000);
    }
    await write('done');
  }
};

// Exposed for offline tests.
module.exports.Layout = Layout;
module.exports.Cell = Cell;
