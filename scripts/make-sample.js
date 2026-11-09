// Generates a sample sofa (.glb) + seamless fabric textures into ./sample for testing/demo.
import { Document, NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'sample');
fs.mkdirSync(OUT, { recursive: true });

// ---------- geometry ----------
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('Sofa');
const fabric = doc.createMaterial('Fabric').setBaseColorFactor([0.82, 0.8, 0.77, 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
const wood = doc.createMaterial('Legs').setBaseColorFactor([0.18, 0.11, 0.06, 1]).setRoughnessFactor(0.55).setMetallicFactor(0);

// Box with world-size based UVs (1 UV unit = 0.5 m) so fabric density is consistent across parts.
function boxPrim(w, hgt, d, mat, round = 0) {
  const pos = [], nrm = [], uv = [], idx = [];
  const hx = w / 2, hy = hgt / 2, hz = d / 2, U = 2;
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const seg = round ? 8 : 1;
  for (const [n, u, v] of faces) {
    const half = [hx, hy, hz];
    const du = Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2];
    const dv = Math.abs(v[0]) * half[0] + Math.abs(v[1]) * half[1] + Math.abs(v[2]) * half[2];
    const dn = Math.abs(n[0]) * half[0] + Math.abs(n[1]) * half[1] + Math.abs(n[2]) * half[2];
    const base = pos.length / 3;
    for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * 2 - 1, b = (j / seg) * 2 - 1;
      // "pillow" puff for cushions: bulge the face centre outward
      const puff = round ? round * (1 - a * a) * (1 - b * b) : 0;
      const p = [0, 1, 2].map((k) => n[k] * (dn + puff) + u[k] * a * du + v[k] * b * dv);
      pos.push(...p);
      nrm.push(...n);
      uv.push((a * du + du) * U, (b * dv + dv) * U);
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const q = base + j * (seg + 1) + i;
      idx.push(q, q + 1, q + seg + 2, q, q + seg + 2, q + seg + 1);
    }
  }
  // recompute smooth-ish normals for puffed cushions
  if (round) {
    const N = new Float32Array(pos.length);
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
      const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const k of [a, b, c]) { N[k] += cr[0]; N[k + 1] += cr[1]; N[k + 2] += cr[2]; }
    }
    for (let k = 0; k < N.length; k += 3) {
      const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1;
      nrm[k] = N[k] / l; nrm[k + 1] = N[k + 1] / l; nrm[k + 2] = N[k + 2] / l;
    }
  }
  const acc = (type, arr, T) => doc.createAccessor().setType(type).setArray(new T(arr)).setBuffer(buffer);
  return doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', pos, Float32Array))
    .setAttribute('NORMAL', acc('VEC3', nrm, Float32Array))
    .setAttribute('TEXCOORD_0', acc('VEC2', uv, Float32Array))
    .setIndices(acc('SCALAR', idx, Uint16Array))
    .setMaterial(mat);
}
function part(name, [w, h, d], [x, y, z], mat, parent, opts = {}) {
  const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(boxPrim(w, h, d, mat, opts.round))).setTranslation([x, y, z]);
  if (opts.rotX) node.setRotation([Math.sin(opts.rotX / 2), 0, 0, Math.cos(opts.rotX / 2)]);
  parent.addChild(node);
  return node;
}

const root = doc.createNode('Sofa');
scene.addChild(root);
const LEG = 0.12;
part('Base', [2.0, 0.25, 0.9], [0, LEG + 0.125, 0], fabric, root);
part('Arm_L', [0.2, 0.5, 0.9], [-0.9, LEG + 0.25, 0], fabric, root, { round: 0.02 });
part('Arm_R', [0.2, 0.5, 0.9], [0.9, LEG + 0.25, 0], fabric, root, { round: 0.02 });
part('Back', [1.6, 0.42, 0.18], [0, LEG + 0.25 + 0.21, -0.36], fabric, root);
const seats = doc.createNode('Seat_Cushions'); root.addChild(seats);
part('Seat_Cushion_L', [0.78, 0.13, 0.68], [-0.395, LEG + 0.25 + 0.065, 0.08], fabric, seats, { round: 0.03 });
part('Seat_Cushion_R', [0.78, 0.13, 0.68], [0.395, LEG + 0.25 + 0.065, 0.08], fabric, seats, { round: 0.03 });
const backs = doc.createNode('Back_Cushions'); root.addChild(backs);
part('Back_Cushion_L', [0.78, 0.4, 0.15], [-0.395, LEG + 0.25 + 0.13 + 0.2, -0.2], fabric, backs, { round: 0.04, rotX: -0.18 });
part('Back_Cushion_R', [0.78, 0.4, 0.15], [0.395, LEG + 0.25 + 0.13 + 0.2, -0.2], fabric, backs, { round: 0.04, rotX: -0.18 });
const legs = doc.createNode('Legs_Main'); root.addChild(legs);
for (const [x, z] of [[-0.92, -0.38], [0.92, -0.38], [-0.92, 0.38], [0.92, 0.38]]) part(`Leg_${x}_${z}`, [0.05, LEG, 0.05], [x, LEG / 2, z], wood, legs);

for (const side of ['L', 'R']) {
  const sx = side === 'L' ? -1 : 1;
  const g = doc.createNode(`Chaise_${side}`);
  root.addChild(g);
  part(`Chaise_${side}_Base`, [0.8, 0.25, 0.75], [sx * 0.4, LEG + 0.125, 0.82], fabric, g);
  part(`Chaise_${side}_Cushion`, [0.78, 0.13, 0.72], [sx * 0.395, LEG + 0.25 + 0.065, 0.8], fabric, g, { round: 0.03 });
  part(`Chaise_${side}_Leg`, [0.05, LEG, 0.05], [sx * 0.75, LEG / 2, 1.15], wood, g);
}
fs.writeFileSync(path.join(OUT, 'sofa.glb'), await new NodeIO().writeBinary(doc));

// ---------- textures ----------
const S = 512;
function hash(x, y, s = 0) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function smoothNoise(x, y, period, seed) { // tileable value noise
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const g = (a, b) => hash(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  return (g(xi, yi) * (1 - sx) + g(xi + 1, yi) * sx) * (1 - sy) + (g(xi, yi + 1) * (1 - sx) + g(xi + 1, yi + 1) * sx) * sy;
}
function writePng(name, fn) {
  const png = new PNG({ width: S, height: S });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const [r, g, b] = fn(x, y); const i = (y * S + x) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

// Linen – plain weave with slub noise (neutral, tintable)
writePng('linen.png', (x, y) => {
  const warp = Math.sin((x / S) * Math.PI * 2 * 128) * 0.5 + 0.5;
  const weft = Math.sin((y / S) * Math.PI * 2 * 128) * 0.5 + 0.5;
  const cell = ((x >> 2) + (y >> 2)) & 1;
  const slub = smoothNoise(x / 4, y / 64, S / 4, 1) * 0.6 + smoothNoise(x / 64, y / 4, S / 64 * 8, 2) * 0.4;
  const v = 200 + 22 * (cell ? warp : weft) + 25 * slub + 8 * hash(x, y, 3);
  return [clamp(v), clamp(v - 2), clamp(v - 6)];
});
// Velvet – soft, low-frequency sheen variation
writePng('velvet.png', (x, y) => {
  const n = smoothNoise(x / 64, y / 64, 8, 4) * 0.6 + smoothNoise(x / 16, y / 16, 32, 5) * 0.3 + hash(x, y, 6) * 0.1;
  const v = 205 + 45 * n;
  return [clamp(v), clamp(v), clamp(v)];
});
// Boucle – looped yarn height field + matching normal map
const H = new Float32Array(S * S);
for (let k = 0; k < 2600; k++) {
  const cx = hash(k, 1, 7) * S, cy = hash(k, 2, 7) * S, r = 5 + hash(k, 3, 7) * 7;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const d = Math.hypot(dx, dy) / r; if (d > 1) continue;
    const ring = Math.exp(-((d - 0.65) ** 2) / 0.03);
    const px = ((Math.round(cx + dx) % S) + S) % S, py = ((Math.round(cy + dy) % S) + S) % S;
    H[py * S + px] = Math.max(H[py * S + px], ring * (0.6 + 0.4 * hash(k, 4, 7)));
  }
}
const hAt = (x, y) => H[(((y % S) + S) % S) * S + (((x % S) + S) % S)];
writePng('boucle.png', (x, y) => { const v = 175 + 75 * hAt(x, y); return [clamp(v), clamp(v - 1), clamp(v - 4)]; });
writePng('boucle_normal.png', (x, y) => {
  const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * 2.5, dy = (hAt(x, y + 1) - hAt(x, y - 1)) * 2.5;
  const l = Math.hypot(dx, dy, 1);
  return [clamp((-dx / l * 0.5 + 0.5) * 255), clamp((dy / l * 0.5 + 0.5) * 255), clamp((1 / l * 0.5 + 0.5) * 255)];
});

console.log('Sample assets written to', OUT, fs.readdirSync(OUT));
