// Builds avatar/models/amara-portrait.glb from assets/amara.webp.
// MediaPipe Face Landmarker (Apache-2.0) supplied the 3D landmarks.
// The photo is the texture, so the skin is hers. No FLAME, DECA, EMOCA,
// MICA, 3DDFA, or Avaturn data: those licenses are non-commercial or
// need an account. Morph names match TalkingHead / Oculus visemes plus
// a few ARKit shapes. This is a head only. It has no Mixamo skeleton,
// so TalkingHead.showAvatar cannot load it.
//
// Run from the repo root: node avatar/build-portrait-head.cjs

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const mesh = JSON.parse(fs.readFileSync(path.join(ROOT, 'avatar/landmarks/amara.json'), 'utf8'));
const W = mesh.w;
const H = mesh.h;
const depthPath = path.join(ROOT, 'avatar/landmarks/amara-depth.json');

function loadDepth() {
  if (fs.existsSync(depthPath)) {
    const saved = JSON.parse(fs.readFileSync(depthPath, 'utf8'));
    if (saved.z && saved.z.length === mesh.role.length) return saved.z;
  }
  const lm = JSON.parse(fs.readFileSync('/tmp/amara-lm.json', 'utf8')).lm;
  const map = new Map();
  lm.forEach(p => map.set(Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5), p[2]));
  const z = [];
  for (let i = 0; i < mesh.xy.length; i += 2) {
    const key = Math.round(mesh.xy[i] * 1e5) + ',' + Math.round(mesh.xy[i + 1] * 1e5);
    if (!map.has(key)) throw new Error('No depth for vertex ' + (i / 2));
    z.push(map.get(key));
  }
  fs.writeFileSync(depthPath, JSON.stringify({ z }));
  return z;
}

const depthZ = loadDepth();
const N = mesh.role.length;
const noseX = mesh.nose[0];
const noseY = mesh.nose[1];
const xy = mesh.xy;
const role = mesh.role;

function vertXY(i) { return [xy[i * 2], xy[i * 2 + 1]]; }

let earL = 0;
let earR = 0;
{
  let bestL = Infinity;
  let bestR = -Infinity;
  for (let i = 0; i < N; i++) {
    const x = xy[i * 2];
    if (x < bestL) { bestL = x; earL = i; }
    if (x > bestR) { bestR = x; earR = i; }
  }
}
const S = 0.152 / ((xy[earR * 2] - xy[earL * 2]) * W);
const ZSCALE = 0.72;

function project(x, y, zMp) {
  return [
    (x - noseX) * W * S,
    (noseY - y) * H * S,
    -(zMp || 0) * W * S * ZSCALE
  ];
}

const facePos = new Float32Array(N * 3);
const faceUv = new Float32Array(N * 2);
for (let i = 0; i < N; i++) {
  const p = project(xy[i * 2], xy[i * 2 + 1], depthZ[i]);
  facePos[i * 3] = p[0];
  facePos[i * 3 + 1] = p[1];
  facePos[i * 3 + 2] = p[2];
  faceUv[i * 2] = xy[i * 2];
  faceUv[i * 2 + 1] = xy[i * 2 + 1];
}

let faceIdx = Uint16Array.from(mesh.tris);
function faceNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
    n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
    n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
  }
  return n;
}
let fn = faceNormals(facePos, faceIdx);
let nz = 0;
for (let i = 2; i < fn.length; i += 3) nz += fn[i];
if (nz < 0) {
  for (let t = 0; t < faceIdx.length; t += 3) {
    const tmp = faceIdx[t + 1];
    faceIdx[t + 1] = faceIdx[t + 2];
    faceIdx[t + 2] = tmp;
  }
  fn = faceNormals(facePos, faceIdx);
}
function normalize(n) {
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
  }
  return n;
}
normalize(fn);

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const indexOfLm = new Map();
{
  const lmPath = '/tmp/amara-lm.json';
  if (fs.existsSync(lmPath)) {
    const lm = JSON.parse(fs.readFileSync(lmPath, 'utf8')).lm;
    const map = new Map();
    for (let i = 0; i < N; i++) {
      map.set(Math.round(xy[i * 2] * 1e5) + ',' + Math.round(xy[i * 2 + 1] * 1e5), i);
    }
    OVAL.forEach(id => {
      const p = lm[id];
      const key = Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5);
      if (map.has(key)) indexOfLm.set(id, map.get(key));
    });
  }
}
const oval = [];
if (indexOfLm.size >= 30) {
  OVAL.forEach(id => { if (indexOfLm.has(id)) oval.push(indexOfLm.get(id)); });
} else {
  // Depth file only: the silhouette is the convex hull of the face, walked
  // by angle around the nose. Good enough to keep hair off the cheeks.
  const order = [];
  for (let i = 0; i < N; i++) {
    const x = xy[i * 2] - noseX;
    const y = xy[i * 2 + 1] - noseY;
    order.push([Math.atan2(y, x), i, x * x + y * y]);
  }
  order.sort((a, b) => a[0] - b[0]);
  const bins = 36;
  for (let b = 0; b < bins; b++) {
    const a0 = -Math.PI + (b / bins) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / bins;
    let best = null;
    for (const row of order) {
      if (row[0] < a0 || row[0] >= a1) continue;
      if (!best || row[2] > best[2]) best = row;
    }
    if (best) oval.push(best[1]);
  }
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = xy[poly[i] * 2], yi = xy[poly[i] * 2 + 1];
    const xj = xy[poly[j] * 2], yj = xy[poly[j] * 2 + 1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}
function distToPoly(x, y, poly) {
  let best = 1e9;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = xy[poly[j] * 2], ay = xy[poly[j] * 2 + 1];
    const bx = xy[poly[i] * 2], by = xy[poly[i] * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1e-9;
    let t = ((x - ax) * dx + (y - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const ddx = (x - px) * W, ddy = (y - py) * H;
    const d = Math.hypot(ddx, ddy);
    if (d < best) best = d;
  }
  return best;
}

const rgbPath = '/tmp/amara-head.rgb';
execFileSync('ffmpeg', ['-y', '-i', path.join(ROOT, 'assets/amara.webp'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgbPath], { stdio: 'ignore' });
const rgb = fs.readFileSync(rgbPath);
function sample(x, y) {
  const ix = Math.max(0, Math.min(W - 1, Math.round(x * (W - 1))));
  const iy = Math.max(0, Math.min(H - 1, Math.round(y * (H - 1))));
  const i = (iy * W + ix) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}
function lum(p) { return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; }
function srgbToLinear(c) {
  const u = c / 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}
function avgColor(points) {
  let r = 0, g = 0, b = 0, n = 0;
  points.forEach(([x, y]) => {
    const p = sample(x, y);
    if (lum(p) < 18) return;
    r += p[0]; g += p[1]; b += p[2]; n++;
  });
  if (!n) return [0.05, 0.03, 0.02];
  return [srgbToLinear(r / n), srgbToLinear(g / n), srgbToLinear(b / n)];
}
const hairColor = avgColor([[0.45, 0.16], [0.50, 0.14], [0.40, 0.18], [0.55, 0.17], [0.48, 0.12]]);
const skinColor = avgColor([[0.456, 0.30], [0.48, 0.32], [0.43, 0.34], [0.50, 0.36]]);

function closestFaceZ(x, y) {
  let best = 1e9;
  let z = 0;
  for (let i = 0; i < N; i++) {
    const dx = (x - xy[i * 2]) * W;
    const dy = (y - xy[i * 2 + 1]) * H;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; z = facePos[i * 3 + 2]; }
  }
  return z;
}

function buildGrid(spec) {
  const cols = spec.cols;
  const rows = spec.rows;
  const ids = [];
  const pos = [];
  const uv = [];
  const valid = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = spec.x0 + (spec.x1 - spec.x0) * (i / (cols - 1));
      const y = spec.y0 + (spec.y1 - spec.y0) * (j / (rows - 1));
      const inside = pointInPoly(x, y, oval);
      const edge = distToPoly(x, y, oval);
      const p = sample(x, y);
      const ok = spec.keep(x, y, inside, edge, lum(p));
      if (!ok) { valid.push(-1); continue; }
      const back = spec.back(x, y, inside, edge);
      const z = (inside && edge < 10 ? closestFaceZ(x, y) : closestFaceZ(x, y)) - back;
      const id = pos.length / 3;
      const pr = project(x, y, 0);
      pos.push(pr[0], pr[1], z);
      uv.push(x, y);
      valid.push(id);
    }
  }
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = valid[j * cols + i];
      const b = valid[j * cols + i + 1];
      const c = valid[(j + 1) * cols + i + 1];
      const d = valid[(j + 1) * cols + i];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      idx.push(a, d, b, b, d, c);
    }
  }
  return { pos: Float32Array.from(pos), uv: Float32Array.from(uv), idx: Uint16Array.from(idx) };
}

const hair = buildGrid({
  x0: 0.33, x1: 0.63, y0: 0.08, y1: 0.50, cols: 42, rows: 36,
  keep(x, y, inside, edge, L) {
    if (L < 22) return false;
    if (inside && edge > 14) return false;
    if (!inside && edge > 78) return false;
    return true;
  },
  back(x, y, inside, edge) {
    const gx = (x - noseX) / 0.07;
    const gy = (y - 0.14) / 0.07;
    const crown = Math.exp(-(gx * gx + gy * gy));
    const wrap = inside ? 0.0012 : Math.min(0.04, (edge * S) * 0.65);
    return wrap + crown * 0.028;
  }
});

const neck = buildGrid({
  x0: 0.40, x1: 0.54, y0: 0.58, y1: 0.90, cols: 18, rows: 16,
  keep(x, y, inside, edge, L) {
    if (L < 28) return false;
    if (y < 0.62 && inside && edge > 18) return false;
    return true;
  },
  back(x, y) {
    const u = (x - noseX) / 0.07;
    return 0.004 + u * u * 0.016 + Math.max(0, y - 0.64) * 0.01;
  }
});

function ellipsoid(stacks, slices, radii, center, colorAt, keep) {
  const pos = [];
  const col = [];
  const idx = [];
  const grid = [];
  for (let i = 0; i <= stacks; i++) {
    const v = i / stacks;
    const theta = v * Math.PI;
    const row = [];
    for (let j = 0; j <= slices; j++) {
      const u = j / slices;
      const phi = u * Math.PI * 2;
      const x = Math.sin(theta) * Math.cos(phi) * radii[0];
      const y = Math.cos(theta) * radii[1];
      const z = Math.sin(theta) * Math.sin(phi) * radii[2];
      const p = [center[0] + x, center[1] + y, center[2] + z];
      if (keep && !keep(p, x, y, z)) { row.push(-1); continue; }
      const id = pos.length / 3;
      pos.push(p[0], p[1], p[2]);
      const c = colorAt(p);
      col.push(c[0], c[1], c[2]);
      row.push(id);
    }
    grid.push(row);
  }
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = grid[i][j];
      const b = grid[i][j + 1];
      const c = grid[i + 1][j + 1];
      const d = grid[i + 1][j];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      idx.push(a, b, d, b, c, d);
    }
  }
  return { pos: Float32Array.from(pos), color: Float32Array.from(col), idx: Uint16Array.from(idx) };
}

const earLZ = facePos[earL * 3 + 2];
const earRZ = facePos[earR * 3 + 2];
const earY = (facePos[earL * 3 + 1] + facePos[earR * 3 + 1]) * 0.5;
const earZ = (earLZ + earRZ) * 0.5;
const forehead = project(noseX, 0.211, 0);
const chin = project(noseX, mesh.chin, 0);
const halfW = Math.abs(facePos[earR * 3] - facePos[earL * 3]) * 0.5;

const cranium = ellipsoid(18, 24, [halfW * 0.96, (forehead[1] - chin[1]) * 0.52, 0.058], [0, (forehead[1] + chin[1]) * 0.5, earZ], p => {
  const t = Math.max(0, Math.min(1, (p[1] - chin[1]) / ((forehead[1] - chin[1]) || 1)));
  return [
    skinColor[0] + (hairColor[0] - skinColor[0]) * t,
    skinColor[1] + (hairColor[1] - skinColor[1]) * t,
    skinColor[2] + (hairColor[2] - skinColor[2]) * t
  ];
}, p => p[2] < earZ + 0.012);

const bun = ellipsoid(14, 18, [0.034, 0.026, 0.030], [0, forehead[1] + 0.012, earZ - 0.018], () => hairColor, p => p[2] < earZ + 0.01);

function torus(R, tube, major, minor, center, xSign) {
  const pos = [];
  const idx = [];
  const grid = [];
  for (let i = 0; i <= major; i++) {
    const theta = (i / major) * Math.PI * 2;
    const row = [];
    for (let j = 0; j <= minor; j++) {
      const phi = (j / minor) * Math.PI * 2;
      const cy = Math.cos(theta) * (R + Math.cos(phi) * tube);
      const cz = Math.sin(theta) * (R + Math.cos(phi) * tube);
      const cx = Math.sin(phi) * tube * xSign;
      pos.push(center[0] + cx, center[1] + cy, center[2] + cz);
      row.push((pos.length / 3) - 1);
    }
    grid.push(row);
  }
  for (let i = 0; i < major; i++) {
    for (let j = 0; j < minor; j++) {
      const a = grid[i][j], b = grid[i][j + 1], c = grid[i + 1][j + 1], d = grid[i + 1][j];
      idx.push(a, b, d, b, c, d);
    }
  }
  return { pos: Float32Array.from(pos), idx: Uint16Array.from(idx) };
}

function earringAt(x, y, sign) {
  const base = project(x, y, 0);
  const z = sign < 0 ? earLZ : earRZ;
  return torus(0.011, 0.0017, 18, 8, [base[0] + sign * 0.006, base[1] - 0.004, z], sign);
}
const hoopL = earringAt(0.383, 0.458, -1);
const hoopR = earringAt(0.570, 0.372, 1);

function lipDelta(i, open, wide, round) {
  const x = xy[i * 2];
  const kind = role[i];
  const side = x < noseX ? -1 : 1;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  if (kind === 1) {
    dy -= Math.max(0, open) * 0.014 + Math.min(0, open) * 0.010;
    dx += side * wide * 0.010 - side * round * 0.012;
    dz += Math.max(0, round) * 0.004;
  } else if (kind === 2) {
    dy += Math.max(0, open) * 0.032 + Math.min(0, open) * 0.020;
    dx += side * wide * 0.008 - side * round * 0.010;
    dz += Math.max(0, round) * 0.003;
  } else if (kind === 3) {
    dx += side * wide * 0.022 - side * round * 0.026;
    dy += Math.max(0, open) * 0.008 + Math.min(0, open) * 0.012;
  } else if (kind === 9) {
    dy += Math.max(0, open) * 0.016 + Math.min(0, open) * 0.008;
  } else if (kind === 10) {
    dy += open * 0.005;
    dx += side * wide * 0.004;
  }
  return [dx * W * S, -dy * H * S, dz];
}

function fillDelta(fn) {
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const d = fn(i);
    out[i * 3] = d[0];
    out[i * 3 + 1] = d[1];
    out[i * 3 + 2] = d[2];
  }
  return out;
}

const SHAPE = {
  PP: { open: -0.42, wide: -0.06, round: 0.04 },
  FF: { open: -0.12, wide: 0.08, round: 0.05 },
  aa: { open: 0.48, wide: 0.06, round: 0 },
  E: { open: 0.16, wide: 0.55, round: 0 },
  I: { open: 0.12, wide: 0.42, round: 0 },
  O: { open: 0.22, wide: -0.16, round: 0.72 },
  U: { open: 0.14, wide: -0.22, round: 0.84 },
  DD: { open: 0.16, wide: 0.04, round: 0.04 },
  nn: { open: 0.08, wide: 0.02, round: 0 },
  SS: { open: 0.06, wide: 0.18, round: 0.04 },
  CH: { open: 0.14, wide: 0.06, round: 0.18 },
  kk: { open: 0.18, wide: 0.02, round: 0.06 },
  RR: { open: 0.14, wide: 0.02, round: 0.12 },
  TH: { open: 0.12, wide: 0.1, round: 0.04 }
};

const targets = [];
const targetNames = [];
function addTarget(name, arr) {
  targetNames.push(name);
  targets.push(arr);
}
addTarget('viseme_sil', new Float32Array(N * 3));
['PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'].forEach(name => {
  const s = SHAPE[name];
  addTarget('viseme_' + name, fillDelta(i => lipDelta(i, s.open, s.wide, s.round)));
});
addTarget('jawOpen', fillDelta(i => {
  const kind = role[i];
  if (kind === 2) return lipDelta(i, 0.85, 0.02, 0);
  if (kind === 9) return lipDelta(i, 1, 0, 0);
  if (kind === 3) return lipDelta(i, 0.45, 0, 0);
  if (kind === 10) return lipDelta(i, 0.2, 0, 0);
  return [0, 0, 0];
}));
function smileDelta(i, wantRight) {
  const x = xy[i * 2];
  const onSide = wantRight ? x > noseX : x < noseX;
  if (!onSide) return [0, 0, 0];
  const kind = role[i];
  const side = x < noseX ? -1 : 1;
  if (kind === 3) return [side * 0.007 * W * S, 0.006 * H * S, 0];
  if (kind === 4) return [side * 0.003 * W * S, 0.003 * H * S, 0];
  return [0, 0, 0];
}
addTarget('mouthSmileLeft', fillDelta(i => smileDelta(i, true)));
addTarget('mouthSmileRight', fillDelta(i => smileDelta(i, false)));
function blinkDelta(i, wantRight) {
  const x = xy[i * 2];
  const onSide = wantRight ? x > noseX : x < noseX;
  if (!onSide) return [0, 0, 0];
  const kind = role[i];
  if (kind === 5) return [0, -0.018 * H * S, 0];
  if (kind === 6) return [0, 0.005 * H * S, 0];
  return [0, 0, 0];
}
addTarget('eyeBlinkLeft', fillDelta(i => blinkDelta(i, true)));
addTarget('eyeBlinkRight', fillDelta(i => blinkDelta(i, false)));
addTarget('browInnerUp', fillDelta(i => {
  if (role[i] !== 8) return [0, 0, 0];
  const x = xy[i * 2];
  const fall = Math.max(0, 1 - Math.abs(x - noseX) / 0.08);
  return [0, 0.012 * fall * H * S, 0];
}));

function mergePhoto(parts) {
  const pos = [];
  const uv = [];
  const idx = [];
  parts.forEach(part => {
    const base = pos.length / 3;
    for (let i = 0; i < part.pos.length; i++) pos.push(part.pos[i]);
    for (let i = 0; i < part.uv.length; i++) uv.push(part.uv[i]);
    for (let i = 0; i < part.idx.length; i++) idx.push(part.idx[i] + base);
  });
  return { pos: Float32Array.from(pos), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
}
function mergeSolid(parts) {
  const pos = [];
  const color = [];
  const idx = [];
  parts.forEach(part => {
    const base = pos.length / 3;
    for (let i = 0; i < part.pos.length; i++) pos.push(part.pos[i]);
    for (let i = 0; i < part.color.length; i++) color.push(part.color[i]);
    for (let i = 0; i < part.idx.length; i++) idx.push(part.idx[i] + base);
  });
  return { pos: Float32Array.from(pos), color: Float32Array.from(color), idx: Uint32Array.from(idx) };
}
function mergePos(parts) {
  const pos = [];
  const idx = [];
  parts.forEach(part => {
    const base = pos.length / 3;
    for (let i = 0; i < part.pos.length; i++) pos.push(part.pos[i]);
    for (let i = 0; i < part.idx.length; i++) idx.push(part.idx[i] + base);
  });
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

const photo = mergePhoto([hair, neck]);
const volume = mergeSolid([cranium, bun]);
const gold = mergePos([hoopL, hoopR]);

function bounds(arr, stride) {
  const min = new Array(stride).fill(Infinity);
  const max = new Array(stride).fill(-Infinity);
  for (let i = 0; i < arr.length; i += stride) {
    for (let k = 0; k < stride; k++) {
      const v = arr[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

const jpgPath = path.join(ROOT, 'avatar/models/amara-portrait.jpg');
execFileSync('ffmpeg', ['-y', '-i', path.join(ROOT, 'assets/amara.webp'), '-q:v', '5', jpgPath], { stdio: 'ignore' });
let jpg = fs.readFileSync(jpgPath);
fs.unlinkSync(jpgPath);

const binParts = [];
let binLen = 0;
function align(n) {
  while (binLen % n) { binParts.push(Buffer.from([0])); binLen++; }
}
function pushBytes(buf) {
  align(4);
  const offset = binLen;
  binParts.push(buf);
  binLen += buf.length;
  return offset;
}
const views = [];
const accessors = [];
function pushAccessor(array, type, componentType, target) {
  const buf = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const offset = pushBytes(buf);
  const stride = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : type === 'VEC3' ? 3 : 4;
  const count = array.length / stride;
  const b = bounds(array, stride);
  const view = views.length;
  views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
  const acc = { bufferView: view, componentType, count, type, min: b.min, max: b.max };
  accessors.push(acc);
  return accessors.length - 1;
}
const ARRAY = 34962;
const ELEMENT = 34963;
const F32 = 5126;
const U16 = 5123;
const U32 = 5125;

function maxIndex(idx) {
  let m = 0;
  for (let i = 0; i < idx.length; i++) if (idx[i] > m) m = idx[i];
  return m;
}
function idxAccessor(idx) {
  const use32 = maxIndex(idx) > 65535;
  const arr = use32 ? Uint32Array.from(idx) : Uint16Array.from(idx);
  return pushAccessor(arr, 'SCALAR', use32 ? U32 : U16, ELEMENT);
}

const facePosA = pushAccessor(facePos, 'VEC3', F32, ARRAY);
const faceNrmA = pushAccessor(fn, 'VEC3', F32, ARRAY);
const faceUvA = pushAccessor(faceUv, 'VEC2', F32, ARRAY);
const faceIdxA = idxAccessor(faceIdx);
const targetAcc = targets.map(t => pushAccessor(t, 'VEC3', F32, ARRAY));

const photoN = normalize(faceNormals(photo.pos, photo.idx));
const photoPosA = pushAccessor(photo.pos, 'VEC3', F32, ARRAY);
const photoNrmA = pushAccessor(photoN, 'VEC3', F32, ARRAY);
const photoUvA = pushAccessor(photo.uv, 'VEC2', F32, ARRAY);
const photoIdxA = idxAccessor(photo.idx);

const volN = normalize(faceNormals(volume.pos, volume.idx));
const volPosA = pushAccessor(volume.pos, 'VEC3', F32, ARRAY);
const volNrmA = pushAccessor(volN, 'VEC3', F32, ARRAY);
const volColA = pushAccessor(volume.color, 'VEC3', F32, ARRAY);
const volIdxA = idxAccessor(volume.idx);

const goldN = normalize(faceNormals(gold.pos, gold.idx));
const goldPosA = pushAccessor(gold.pos, 'VEC3', F32, ARRAY);
const goldNrmA = pushAccessor(goldN, 'VEC3', F32, ARRAY);
const goldIdxA = idxAccessor(gold.idx);

align(4);
const imageOffset = binLen;
binParts.push(jpg);
binLen += jpg.length;
align(4);

const goldLinear = [198, 161, 91].map(srgbToLinear);
const gltf = {
  asset: { version: '2.0', generator: 'brimmesa-portrait-head' },
  extensionsUsed: ['KHR_materials_unlit'],
  extras: {
    source: 'assets/amara.webp',
    method: 'MediaPipe face landmarks with the portrait projected as the texture. Hair shell uses the same photo. The bun and the back of the head are solid colors sampled from the photo because one picture has no back view.',
    license: 'MediaPipe Face Landmarker is Apache-2.0. The texture is this site portrait. FLAME, DECA, EMOCA, MICA, 3DDFA, and Avaturn were not used. Morph names are Oculus viseme and ARKit labels so a TalkingHead driver can find them. There is no body skeleton.'
  },
  buffers: [{ byteLength: binLen }],
  bufferViews: views.concat([{ buffer: 0, byteOffset: imageOffset, byteLength: jpg.length }]),
  accessors,
  images: [{ bufferView: views.length, mimeType: 'image/jpeg' }],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
  materials: [
    {
      name: 'amara-photo',
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      extensions: { KHR_materials_unlit: {} },
      doubleSided: true
    },
    {
      name: 'amara-volume',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.82 },
      doubleSided: true
    },
    {
      name: 'amara-gold',
      pbrMetallicRoughness: { baseColorFactor: goldLinear.concat([1]), metallicFactor: 0.84, roughnessFactor: 0.3 }
    }
  ],
  meshes: [
    {
      name: 'AmaraFace',
      weights: targetNames.map(() => 0),
      extras: { targetNames },
      primitives: [{
        attributes: { POSITION: facePosA, NORMAL: faceNrmA, TEXCOORD_0: faceUvA },
        targets: targetAcc.map(POSITION => ({ POSITION })),
        indices: faceIdxA,
        material: 0
      }]
    },
    {
      name: 'AmaraPhotoShell',
      primitives: [{
        attributes: { POSITION: photoPosA, NORMAL: photoNrmA, TEXCOORD_0: photoUvA },
        indices: photoIdxA,
        material: 0
      }]
    },
    {
      name: 'AmaraVolume',
      primitives: [{
        attributes: { POSITION: volPosA, NORMAL: volNrmA, COLOR_0: volColA },
        indices: volIdxA,
        material: 1
      }]
    },
    {
      name: 'AmaraEarrings',
      primitives: [{
        attributes: { POSITION: goldPosA, NORMAL: goldNrmA },
        indices: goldIdxA,
        material: 2
      }]
    }
  ],
  nodes: [
    { name: 'AmaraHead', children: [1, 2, 3, 4] },
    { name: 'AmaraFace', mesh: 0 },
    { name: 'AmaraPhotoShell', mesh: 1 },
    { name: 'AmaraVolume', mesh: 2 },
    { name: 'AmaraEarrings', mesh: 3 }
  ],
  scenes: [{ nodes: [0] }],
  scene: 0
};

const json = Buffer.from(JSON.stringify(gltf));
const jsonPad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
const bin = Buffer.concat(binParts);
const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
const jsonChunk = Buffer.concat([json, jsonPad]);
const binChunk = Buffer.concat([bin, binPad]);
const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546C67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
function chunk(type, data) {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
}
const glb = Buffer.concat([header, chunk(0x4E4F534A, jsonChunk), chunk(0x004E4942, binChunk)]);
const out = path.join(ROOT, 'avatar/models/amara-portrait.glb');
fs.writeFileSync(out, glb);

const faceBounds = bounds(facePos, 3);
console.log(JSON.stringify({
  bytes: glb.length,
  jpg: jpg.length,
  faceVerts: N,
  faceTris: faceIdx.length / 3,
  hairVerts: hair.pos.length / 3,
  hairTris: hair.idx.length / 3,
  neckVerts: neck.pos.length / 3,
  targets: targetNames,
  nose: [facePos[1 * 3], facePos[1 * 3 + 1], facePos[1 * 3 + 2]],
  bounds: faceBounds,
  hairColor,
  skinColor,
  oval: oval.length
}, null, 2));
