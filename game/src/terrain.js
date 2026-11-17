// CHAINFIRE 3D — terrain + environment. Written fresh for the 3D rebuild.
// heightAt(x, z) is the single source of truth for ground height: the sim
// uses it to place trail/keg/enemy y positions, the renderer uses it to
// displace the terrain mesh. All randomness is seeded (deterministic).

import { THREE } from './three.js';
import { PALETTE, WORLD } from './data.js';
import { mulberry32, range, pick } from './rng.js';

// Value-noise heightfield: deterministic, seeded, smooth.
function hash2(x, z, seed) {
  let h = (x * 374761393 + z * 668265263 + seed * 974634) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967295;
}

function smoothNoise(x, z, seed) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function terrainHeight(x, z) {
  // Fort hill: rises toward the fort (x < -28), up to +6 at the back.
  const hill = x < -28 ? Math.min(6, (-28 - x) * 0.35) : 0;
  // Valley: gentle dip toward the spawn side (x > 30), down to -2.5.
  const valley = x > 30 ? -Math.min(2.5, (x - 30) * 0.12) : 0;
  // Rolling noise, gentler on the lanes (z near -14.5/0/14.5 is flatter).
  const laneDist = Math.min(
    Math.abs(z + 14.5), Math.abs(z), Math.abs(z - 14.5)
  );
  const laneFlat = Math.min(1, laneDist / 6);
  const noise = (smoothNoise(x * 0.06, z * 0.06, 7) - 0.5) * 2.2 * (0.25 + 0.75 * laneFlat)
    + (smoothNoise(x * 0.18, z * 0.18, 13) - 0.5) * 0.7 * (0.25 + 0.75 * laneFlat);
  // Flatten right under the fort wall so the wall sits level.
  const wallFlat = x > -50 && x < -38 ? 0.35 : 1;
  return (hill + valley + noise) * wallFlat;
}

// Brick texture: individual bricks + mortar + sunlit top edge + moss +
// cracks. Per spek Mark 04:56 (benteng s.d. 50%, kontras ~30%, DILARANG
// sambungan ubin): opts.clean=true menghilangkan lumut, retak, dan base
// course — dipakai menara (repeat 2,2) supaya ubinnya mulus; bata sendiri
// men-tile mulus (8 baris genap, offset selang-seling).
function makeBrickTexture(rng, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c9b8a3';
  ctx.fillRect(0, 0, 256, 256);
  const rows = 8;
  const bh = 256 / rows;
  for (let r = 0; r < rows; r += 1) {
    const offset = (r % 2) * 32;
    for (let c = -1; c < 5; c += 1) {
      // Stronger per-brick variation (0.78–1.22) so the relief reads at
      // distance — the old 0.85–1.15 washed out to flat cream.
      const shade = 0.78 + rng() * 0.44;
      const base = [201, 184, 163];
      ctx.fillStyle = `rgb(${Math.round(base[0] * shade)},${Math.round(base[1] * shade)},${Math.round(base[2] * shade)})`;
      ctx.fillRect(c * 64 + offset + 2, r * bh + 2, 60, bh - 4);
      // Sunlit top edge.
      ctx.fillStyle = 'rgba(255, 240, 210, 0.5)';
      ctx.fillRect(c * 64 + offset + 2, r * bh + 2, 60, 3);
    }
  }
  // Darker, thicker mortar lines.
  ctx.strokeStyle = 'rgba(120, 104, 84, 0.9)';
  ctx.lineWidth = 3;
  for (let r = 0; r <= rows; r += 1) {
    ctx.beginPath();
    ctx.moveTo(0, r * bh);
    ctx.lineTo(256, r * bh);
    ctx.stroke();
  }
  if (!opts.clean) {
  // Weathered base course: the bottom 2 rows are darker (damp, trodden).
  ctx.fillStyle = 'rgba(70, 60, 48, 0.22)';
  ctx.fillRect(0, 256 - bh * 2, 256, bh * 2);
  // Moss: seeded green blobs, biased to the bottom rows (damp base).
  // Per spek Mark 04:56 (benteng s.d. 50%, kontras ~30%): 22 blob, alpha ≤0.42.
  for (let i = 0; i < 22; i += 1) {
    const mx = rng() * 256;
    const my = 150 + rng() * 106;
    const mr = 5 + rng() * 11;
    const grad = ctx.createRadialGradient(mx, my, 0, mx, my, mr);
    grad.addColorStop(0, `rgba(90, 130, 70, ${0.25 + rng() * 0.17})`);
    grad.addColorStop(1, 'rgba(90, 130, 70, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, Math.PI * 2);
    ctx.fill();
  }
  // Cracks: dark jagged polylines from brick edges.
  ctx.strokeStyle = 'rgba(60, 50, 40, 0.65)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i += 1) {
    let cx = rng() * 256;
    let cy = rng() * 200;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 4; s += 1) {
      cx += (rng() - 0.5) * 36;
      cy += 8 + rng() * 14;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural wood grain: vertical planks + wavy grain lines + knots.
// Seeded canvas texture — deterministic, no external file.
function makeWoodTexture(rng) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#6b4a2e';
  ctx.fillRect(0, 0, 256, 256);
  const planks = 4;
  const pw = 256 / planks;
  for (let p = 0; p < planks; p += 1) {
    const shade = 0.85 + rng() * 0.3;
    ctx.fillStyle = `rgb(${Math.round(107 * shade)},${Math.round(74 * shade)},${Math.round(46 * shade)})`;
    ctx.fillRect(p * pw + 1, 0, pw - 2, 256);
    // Grain: wavy vertical strokes inside the plank.
    for (let g = 0; g < 10; g += 1) {
      const gx = p * pw + 6 + rng() * (pw - 12);
      ctx.strokeStyle = `rgba(60, 40, 20, ${0.15 + rng() * 0.2})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      for (let y = 0; y <= 256; y += 32) {
        ctx.lineTo(gx + Math.sin(y * 0.05 + g) * 3, y);
      }
      ctx.stroke();
    }
    // Dark seam between planks.
    ctx.fillStyle = 'rgba(40, 25, 15, 0.8)';
    ctx.fillRect(p * pw, 0, 2, 256);
  }
  // 2 knots.
  for (let k = 0; k < 2; k += 1) {
    const kx = rng() * 256;
    const ky = rng() * 256;
    ctx.strokeStyle = 'rgba(50, 32, 16, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(kx, ky, 7, 10, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(kx, ky, 3, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildTerrain(scene, rng) {
  const group = new THREE.Group();
  group.name = 'terrain';

  // Ground mesh: 160 x 140 units, displaced by terrainHeight. It extends
  // past the playfield so the camera never sees past the ground's edge
  // into the sky dome (the playfield itself is x -58..+58, z -32..+32).
  const geo = new THREE.PlaneGeometry(160, 140, 160, 140);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const colA = new THREE.Color(PALETTE.FIELD_A);
  const colB = new THREE.Color(PALETTE.FIELD_B);
  const colPath = new THREE.Color(PALETTE.PATH);
  const colDry = new THREE.Color(0xb59a68);
  const colTrample = new THREE.Color(0x8a7a5a);
  const colWear = new THREE.Color(0xd8bc84);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrainHeight(x, z);
    pos.setY(i, y);
    const n = smoothNoise(x * 0.3, z * 0.3, 21);
    tmp.copy(colA).lerp(colB, n);
    // Fine mottle: high-frequency noise + per-cell hash speckle.
    // Per spek Mark 04:56 — kontras tekstur RENDAH (~30% MAKS, tanah 35% MAKS):
    // lapisan digabung tidak boleh >~23% di titik terburuk (0.10+0.05+0.08).
    const fine = smoothNoise(x * 1.1, z * 1.1, 41) - 0.5;
    const speck = hash2(Math.floor(x), Math.floor(z), 77) - 0.5;
    tmp.multiplyScalar(1 + fine * 0.10 + speck * 0.05);
    // Medium patches (clover / dry-grass patches at 3–6u scale, ±4%).
    const med = smoothNoise(x * 0.35, z * 0.35, 47) - 0.5;
    tmp.multiplyScalar(1 + med * 0.08);
    // Large tint: drier + tanner toward the spawn side, greener near the
    // fort — a slow gradient the eye reads as "lived-in land", ±5%.
    const dry = smoothNoise(x * 0.08, z * 0.08, 59) - 0.5;
    const dryTint = (x > 0 ? 0.6 : 0.2) * (0.5 + dry);
    tmp.lerp(colDry, Math.max(0, Math.min(0.10, dryTint * 0.12)));
    // Trampled earth at the wall base (x -52..-38): defenders' worn ground.
    if (x > -52 && x < -38) {
      tmp.lerp(colTrample, 0.20 * (1 - Math.abs(x + 45) / 7));
    }
    // Dirt road: a band along each lane, merging toward the gate.
    const laneDist = Math.min(Math.abs(z + 14.5), Math.abs(z), Math.abs(z - 14.5));
    // Irregular road edges (55% pass): the band wobbles along its length
    // instead of running ruler-straight.
    const edgeWobble = 0.85 + smoothNoise(x * 0.25, z * 0.1, 61) * 0.3;
    const roadWidth = (2.2 + Math.max(0, (x + 45) * 0.02)) * edgeWobble;
    if (laneDist < roadWidth && x > -44) {
      const roadMix = Math.min(1, (roadWidth - laneDist) / 1.2);
      tmp.lerp(colPath, roadMix * 0.85);
      // Wheel ruts: darker stripes running along the road + stony speckle.
      // Kontras jalan dijaga rendah (0.12+0.06+0.08 = maks ~26%).
      const rut = smoothNoise(x * 0.15, z * 1.4, 55) - 0.5;
      const stone = hash2(Math.floor(x * 2), Math.floor(z * 2), 91) - 0.5;
      tmp.multiplyScalar(1 + rut * 0.12 + stone * 0.06);
      // Center wear: the middle of the road is lighter, walked bare.
      tmp.lerp(colWear, (1 - laneDist / roadWidth) * 0.08);
    }
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  ground.position.set(0, 0, 0);
  ground.receiveShadow = true;
  group.add(ground);

  // Far hills: 3 layers of big low-poly hills beyond the field edges.
  const hillLayers = [
    { count: 7, dist: 78, size: [22, 10, 18], color: 0x3d7a52 },
    { count: 6, dist: 100, size: [30, 16, 24], color: 0x356b4a },
    { count: 5, dist: 128, size: [40, 22, 30], color: 0x2e5e4e }
  ];
  for (const layer of hillLayers) {
    for (let i = 0; i < layer.count; i += 1) {
      const angle = (i / layer.count) * Math.PI * 2 + range(rng, -0.2, 0.2);
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(layer.size[0], layer.size[1], 7),
        new THREE.MeshStandardMaterial({ color: layer.color, roughness: 1, flatShading: true })
      );
      hill.position.set(Math.cos(angle) * layer.dist, layer.size[1] * 0.32, Math.sin(angle) * layer.dist);
      hill.scale.z = layer.size[2] / layer.size[0];
      hill.rotation.y = rng() * Math.PI;
      group.add(hill);
    }
  }

  // Town skyline: small rooftops on the far left horizon (behind the fort).
  for (let i = 0; i < 8; i += 1) {
    const house = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(4, 2.6, 3.4),
      new THREE.MeshStandardMaterial({ color: 0xd8c8a8, roughness: 0.9 })
    );
    base.position.y = 1.3;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(3, 1.8, 4),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xa63a2e : 0x7a4a2e, roughness: 0.9, flatShading: true })
    );
    roof.position.y = 3.5;
    roof.rotation.y = Math.PI / 4;
    house.add(base);
    house.add(roof);
    house.position.set(-72 - rng() * 8, terrainHeight(-72, 0) * 0 + 4.5, -34 + i * 9.5 + range(rng, -2, 2));
    group.add(house);
  }

  // River: a flat blue ribbon in the valley (x ~ 34..40), with a bridge.
  // Procedural water texture: current streaks + foam speckles.
  const river = new THREE.Mesh(
    new THREE.PlaneGeometry(4.5, 64),
    new THREE.MeshStandardMaterial({ map: makeWaterTextureSeeded(57), roughness: 0.25, metalness: 0.1, emissive: 0x1a3a55, emissiveIntensity: 0.25 })
  );
  river.rotation.x = -Math.PI / 2;
  river.position.set(37, -2.2, 0);
  river.receiveShadow = true;
  group.add(river);

  const bridge = new THREE.Group();
  const bridgeWood = new THREE.MeshStandardMaterial({ map: makeWoodTextureSeeded(43), roughness: 0.9 });
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(7, 0.5, 8),
    bridgeWood
  );
  deck.position.y = 0.4;
  bridge.add(deck);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(7, 0.9, 0.3),
      bridgeWood
    );
    rail.position.set(0, 1.1, side * 3.8);
    bridge.add(rail);
  }
  bridge.position.set(37, -1.2, 0);
  group.add(bridge);

  // Trees: instanced low-poly (trunk + 3 foliage spheres). Trunks wear the
  // procedural bark texture; the third crown sphere adds depth.
  const treeCount = 26;
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 2.2, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ map: makeBarkTextureSeeded(53), roughness: 1, flatShading: true });
  const folGeo = new THREE.IcosahedronGeometry(1.6, 0);
  const folMat = new THREE.MeshStandardMaterial({ color: 0x3f7d46, roughness: 1, flatShading: true });
  const folMat2 = new THREE.MeshStandardMaterial({ color: 0x4d8a3f, roughness: 1, flatShading: true });
  const folMat3 = new THREE.MeshStandardMaterial({ color: 0x6aa848, roughness: 1, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const fols = new THREE.InstancedMesh(folGeo, folMat, treeCount);
  const fols2 = new THREE.InstancedMesh(folGeo, folMat2, treeCount);
  const fols3 = new THREE.InstancedMesh(folGeo, folMat3, treeCount);
  const dummy = new THREE.Object3D();
  const cTmp = new THREE.Color();
  const treeSpots = [];
  for (let i = 0; i < treeCount; i += 1) {
    const x = range(rng, -56, 56);
    const z = pick(rng, [-1, 1]) * range(rng, 24, 31);
    const s = range(rng, 0.8, 1.5);
    treeSpots.push({ x, z, s });
    dummy.position.set(x, terrainHeight(x, z) + 1.1 * s, z);
    dummy.scale.setScalar(s);
    dummy.rotation.y = rng() * Math.PI;
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = terrainHeight(x, z) + (2.6 + 1.2) * s;
    dummy.updateMatrix();
    fols.setMatrixAt(i, dummy.matrix);
    dummy.position.y = terrainHeight(x, z) + (2.6 + 2.2) * s;
    dummy.scale.setScalar(s * 0.7);
    dummy.updateMatrix();
    fols2.setMatrixAt(i, dummy.matrix);
    dummy.position.y = terrainHeight(x, z) + (2.6 + 3.1) * s;
    dummy.scale.setScalar(s * 0.45);
    dummy.updateMatrix();
    fols3.setMatrixAt(i, dummy.matrix);
  }
  // Per-instance foliage/trunk tint variation (seeded, ±~12% brightness,
  // slight green shift) — the trees stop being 26 identical clones.
  for (let i = 0; i < treeCount; i += 1) {
    cTmp.setRGB(0.88 + rng() * 0.24, 0.88 + rng() * 0.24, 0.88 + rng() * 0.24);
    trunks.setColorAt(i, cTmp);
    cTmp.setRGB(0.85 + rng() * 0.2, 0.95 + rng() * 0.2, 0.85 + rng() * 0.2);
    fols.setColorAt(i, cTmp);
    cTmp.setRGB(0.85 + rng() * 0.2, 0.95 + rng() * 0.2, 0.85 + rng() * 0.2);
    fols2.setColorAt(i, cTmp);
    cTmp.setRGB(0.85 + rng() * 0.2, 0.95 + rng() * 0.2, 0.85 + rng() * 0.2);
    fols3.setColorAt(i, cTmp);
  }
  trunks.instanceColor.needsUpdate = true;
  fols.instanceColor.needsUpdate = true;
  fols2.instanceColor.needsUpdate = true;
  fols3.instanceColor.needsUpdate = true;
  trunks.castShadow = true;
  fols.castShadow = true;
  fols2.castShadow = true;
  fols3.castShadow = true;
  group.add(trunks);
  group.add(fols);
  group.add(fols2);
  group.add(fols3);

  // Bushes: squashed dark-green blobs clustered near the trees.
  const bushCount = 40;
  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x2e6b34, roughness: 1, flatShading: true });
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, bushCount);
  for (let i = 0; i < bushCount; i += 1) {
    const t = treeSpots[Math.floor(rng() * treeSpots.length)];
    const x = t.x + range(rng, -3, 3);
    const z = t.z + range(rng, -3, 3);
    const s = range(rng, 0.7, 1.6);
    dummy.position.set(x, terrainHeight(x, z) + 0.35 * s, z);
    dummy.scale.set(s, s * 0.55, s);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.updateMatrix();
    bushes.setMatrixAt(i, dummy.matrix);
    cTmp.setRGB(0.85 + rng() * 0.25, 0.9 + rng() * 0.25, 0.85 + rng() * 0.2);
    bushes.setColorAt(i, cTmp);
  }
  bushes.instanceColor.needsUpdate = true;
  group.add(bushes);

  // Rocks: instanced deformed icosahedra.
  const rockCount = 18;
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8a7a, roughness: 1, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  for (let i = 0; i < rockCount; i += 1) {
    const x = range(rng, -54, 54);
    const z = pick(rng, [-1, 1]) * range(rng, 20, 30);
    const s = range(rng, 0.5, 1.4);
    dummy.position.set(x, terrainHeight(x, z) + 0.3 * s, z);
    dummy.scale.set(s, s * 0.7, s);
    dummy.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  for (let i = 0; i < rockCount; i += 1) {
    cTmp.setRGB(0.85 + rng() * 0.3, 0.85 + rng() * 0.3, 0.82 + rng() * 0.3);
    rocks.setColorAt(i, cTmp);
  }
  rocks.instanceColor.needsUpdate = true;
  rocks.castShadow = true;
  group.add(rocks);

  // Pebbles: small stones scattered near the lanes (ground clutter).
  const pebCount = 90;
  const pebGeo = new THREE.IcosahedronGeometry(0.28, 0);
  const pebMat = new THREE.MeshStandardMaterial({ color: 0x9a958a, roughness: 1, flatShading: true });
  const pebbles = new THREE.InstancedMesh(pebGeo, pebMat, pebCount);
  for (let i = 0; i < pebCount; i += 1) {
    const lane = pick(rng, [-14.5, 0, 14.5]);
    const x = range(rng, -40, 55);
    const z = lane + range(rng, -3.5, 3.5);
    const s = range(rng, 0.5, 1.4);
    dummy.position.set(x, terrainHeight(x, z) + 0.1 * s, z);
    dummy.scale.set(s, s * 0.6, s);
    dummy.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);
    cTmp.setRGB(0.8 + rng() * 0.35, 0.78 + rng() * 0.35, 0.72 + rng() * 0.3);
    pebbles.setColorAt(i, cTmp);
  }
  pebbles.instanceColor.needsUpdate = true;
  group.add(pebbles);

  // Boulders: 6 large rocks anchoring the field edges near the hills.
  const boulderCount = 6;
  const boulderGeo = new THREE.IcosahedronGeometry(1, 0);
  const boulderMat = new THREE.MeshStandardMaterial({ color: 0x8a8a7a, roughness: 1, flatShading: true });
  const boulders = new THREE.InstancedMesh(boulderGeo, boulderMat, boulderCount);
  for (let i = 0; i < boulderCount; i += 1) {
    const x = pick(rng, [-1, 1]) * range(rng, 48, 56);
    const z = pick(rng, [-1, 1]) * range(rng, 26, 32);
    const s = range(rng, 2, 3.5);
    dummy.position.set(x, terrainHeight(x, z) + 0.4 * s, z);
    dummy.scale.set(s, s * 0.75, s);
    dummy.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    dummy.updateMatrix();
    boulders.setMatrixAt(i, dummy.matrix);
    cTmp.setRGB(0.85 + rng() * 0.3, 0.85 + rng() * 0.3, 0.82 + rng() * 0.3);
    boulders.setColorAt(i, cTmp);
  }
  boulders.instanceColor.needsUpdate = true;
  boulders.castShadow = true;
  group.add(boulders);

  // Wheat field: instanced tapered blades in three patches near the lanes.
  // Tapered blade (narrow tip) reads as wheat, not a flat rectangle.
  const wheatCount = 540;
  const bladeGeo = (() => {
    const v = new Float32Array([
      -0.14, 0, 0, 0.14, 0, 0, 0.04, 1.5, 0,
      -0.14, 0, 0, 0.04, 1.5, 0, -0.04, 1.5, 0
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  })();
  const wheatMat = new THREE.MeshStandardMaterial({
    color: 0xd8a84a, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x8a6a1a, emissiveIntensity: 0.25
  });
  const wheat = new THREE.InstancedMesh(bladeGeo, wheatMat, wheatCount);
  wheat.userData.isWheat = true;
  for (let i = 0; i < wheatCount; i += 1) {
    const patch = i % 3 === 0 ? { x0: -20, x1: 10, z0: -30, z1: -22 } : i % 3 === 1 ? { x0: 4, x1: 30, z0: 22, z1: 30 } : { x0: -35, x1: -15, z0: 22, z1: 30 };
    const x = range(rng, patch.x0, patch.x1);
    const z = range(rng, patch.z0, patch.z1);
    dummy.position.set(x, terrainHeight(x, z), z);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.scale.setScalar(range(rng, 0.8, 1.3));
    dummy.updateMatrix();
    wheat.setMatrixAt(i, dummy.matrix);
  }
  for (let i = 0; i < wheatCount; i += 1) {
    cTmp.setRGB(1.0 + rng() * 0.15, 0.9 + rng() * 0.15, 0.8 + rng() * 0.15);
    wheat.setColorAt(i, cTmp);
  }
  wheat.instanceColor.needsUpdate = true;
  group.add(wheat);

  // Grass (ITEM 1, trust repair: round-2 blades FAILED the human
  // side-by-side — at eagle distance (68u, 34 deg down) a 1.3u blade
  // projects as a 2x17px DARK scratch, so the field still read as the
  // same dark rectangles in the same places. New recipe: TALLER blades
  // (2.8u — reads as a tuft at full size AND at 320px), BRIGHTER overall
  // (mid-green base, never dark — the dark base is what read as dirt),
  // WIDER (0.32u base), DENSER clusters (10 blades per tuft, 60 tufts),
  // still clustered at the meadow-band edges, never evenly scattered,
  // never on roads/river. Flat dark-green quads are FORBIDDEN.
  const makeBladeGeo = (base, tip) => {
    const v = new Float32Array([
      -0.16, 0, 0, 0.16, 0, 0, 0.05, 2.8, 0,
      -0.16, 0, 0, 0.05, 2.8, 0, -0.05, 2.8, 0
    ]);
    const c = new Float32Array([
      base[0], base[1], base[2], base[0], base[1], base[2], tip[0], tip[1], tip[2],
      base[0], base[1], base[2], tip[0], tip[1], tip[2], tip[0], tip[1], tip[2]
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.computeVertexNormals();
    return g;
  };
  const grassGeo = makeBladeGeo([0.42, 0.62, 0.20], [0.80, 0.96, 0.45]);
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    emissive: 0x3a5a22, emissiveIntensity: 0.25
  });
  // Clusters live in the meadow bands at the lane edges — never on a road,
  // never in the river (x 34..40), never evenly scattered.
  const grassPatches = [
    { x0: -28, x1: -2, z0: -30, z1: -20 },
    { x0: 6, x1: 30, z0: 20, z1: 30 },
    { x0: -30, x1: -8, z0: -10, z1: -5 },
    { x0: 10, x1: 32, z0: 5, z1: 10 },
    { x0: 42, x1: 54, z0: -30, z1: -20 }
  ];
  const grassCount = 600; // 60 clusters x 10 blades (ITEM 1: dense tufts)
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
  grass.userData.isGrass = true;
  {
    let gi = 0;
    for (let ci = 0; ci < 60 && gi < grassCount; ci += 1) {
      const patch = grassPatches[ci % grassPatches.length];
      const cx = range(rng, patch.x0, patch.x1);
      const cz = range(rng, patch.z0, patch.z1);
      for (let b = 0; b < 10 && gi < grassCount; b += 1, gi += 1) {
        const x = Math.max(-55, Math.min(55, cx + range(rng, -0.8, 0.8)));
        const z = Math.max(-31, Math.min(31, cz + range(rng, -0.8, 0.8)));
        dummy.position.set(x, terrainHeight(x, z), z);
        dummy.rotation.set(range(rng, -0.12, 0.12), rng() * Math.PI, range(rng, -0.12, 0.12));
        dummy.scale.setScalar(range(rng, 0.9, 1.25));
        dummy.updateMatrix();
        grass.setMatrixAt(gi, dummy.matrix);
        cTmp.setRGB(0.9 + rng() * 0.25, 0.95 + rng() * 0.25, 0.85 + rng() * 0.2);
        grass.setColorAt(gi, cTmp);
      }
    }
  }
  grass.instanceColor.needsUpdate = true;
  group.add(grass);

  // Dry grass: same blade recipe in tan/gold (ITEM 1: same taller/brighter
  // rebuild — the old 1.3u tan blades were the same speck failure).
  // 60 blades in 2 patches at the field edges.
  const dryBladeGeo = makeBladeGeo([0.55, 0.42, 0.18], [0.90, 0.78, 0.42]);
  const dryGrassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    emissive: 0x6a4a1a, emissiveIntensity: 0.2
  });
  const dryPatches = [
    { x0: -20, x1: 0, z0: 20, z1: 30 },
    { x0: 30, x1: 52, z0: -30, z1: -22 }
  ];
  const dryGrassCount = 60; // 10 clusters x 6 blades
  const dryGrass = new THREE.InstancedMesh(dryBladeGeo, dryGrassMat, dryGrassCount);
  dryGrass.userData.isDryGrass = true;
  {
    let gi = 0;
    for (let ci = 0; ci < 10 && gi < dryGrassCount; ci += 1) {
      const patch = dryPatches[ci % dryPatches.length];
      const cx = range(rng, patch.x0, patch.x1);
      const cz = range(rng, patch.z0, patch.z1);
      for (let b = 0; b < 6 && gi < dryGrassCount; b += 1, gi += 1) {
        const x = Math.max(-55, Math.min(55, cx + range(rng, -0.8, 0.8)));
        const z = Math.max(-31, Math.min(31, cz + range(rng, -0.8, 0.8)));
        dummy.position.set(x, terrainHeight(x, z), z);
        dummy.rotation.set(range(rng, -0.12, 0.12), rng() * Math.PI, range(rng, -0.12, 0.12));
        dummy.scale.setScalar(range(rng, 0.9, 1.25));
        dummy.updateMatrix();
        dryGrass.setMatrixAt(gi, dummy.matrix);
        cTmp.setRGB(0.9 + rng() * 0.2, 0.88 + rng() * 0.2, 0.8 + rng() * 0.2);
        dryGrass.setColorAt(gi, cTmp);
      }
    }
  }
  dryGrass.instanceColor.needsUpdate = true;
  group.add(dryGrass);

  // Wildflowers: tiny blossoms on stems, meadow bands away from the lanes.
  // Per spek Mark 04:56 (warna SEKELUARGA, dilarang geser hue): hanya
  // krem/kuning/emas — ungu & pink DIHAPUS. 80 bunga.
  const flowerCount = 80;
  const stemGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.35, 4);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3a7a3a, roughness: 1 });
  const stems = new THREE.InstancedMesh(stemGeo, stemMat, flowerCount);
  const blosGeo = new THREE.IcosahedronGeometry(0.16, 0);
  const blosMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, flatShading: true });
  const blossoms = new THREE.InstancedMesh(blosGeo, blosMat, flowerCount);
  const flowerCols = [0xfff8e0, 0xffd23f, 0xe8b840];
  for (let i = 0; i < flowerCount; i += 1) {
    const x = range(rng, -50, 50);
    const z = pick(rng, [-1, 1]) * range(rng, 18, 30);
    const y = terrainHeight(x, z);
    dummy.position.set(x, y + 0.17, z);
    dummy.scale.setScalar(1);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    stems.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, y + 0.38, z);
    dummy.updateMatrix();
    blossoms.setMatrixAt(i, dummy.matrix);
    cTmp.setHex(pick(rng, flowerCols));
    blossoms.setColorAt(i, cTmp);
  }
  blossoms.instanceColor.needsUpdate = true;
  group.add(stems);
  group.add(blossoms);

  // Mushrooms: tiny red caps on white stems, clustered near the trees.
  const mushCount = 20;
  const mushStemGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.3, 5);
  const mushStemMat = new THREE.MeshStandardMaterial({ color: 0xf5e6c8, roughness: 0.9 });
  const mushStems = new THREE.InstancedMesh(mushStemGeo, mushStemMat, mushCount);
  const mushCapGeo = new THREE.ConeGeometry(0.22, 0.22, 8);
  const mushCapMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.8, flatShading: true });
  const mushCaps = new THREE.InstancedMesh(mushCapGeo, mushCapMat, mushCount);
  for (let i = 0; i < mushCount; i += 1) {
    const t = treeSpots[Math.floor(rng() * treeSpots.length)];
    const x = t.x + range(rng, -2.5, 2.5);
    const z = t.z + range(rng, -2.5, 2.5);
    const y = terrainHeight(x, z);
    const s = range(rng, 0.7, 1.4);
    dummy.position.set(x, y + 0.15 * s, z);
    dummy.scale.setScalar(s);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.updateMatrix();
    mushStems.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, y + 0.38 * s, z);
    dummy.updateMatrix();
    mushCaps.setMatrixAt(i, dummy.matrix);
  }
  group.add(mushStems);
  group.add(mushCaps);

  // Sky dome: gradient (dusk purple top -> orange horizon) + sun disc.
  const skyGeo = new THREE.SphereGeometry(220, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(PALETTE.SKY_TOP) },
      horizon: { value: new THREE.Color(PALETTE.SKY_HORIZON) }
    },
    vertexShader: 'varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vPos; void main() { float h = clamp(vPos.y / 220.0, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.7)); c += 0.018 * sin(vPos.y * 0.32 + 1.7) * vec3(1.0, 0.55, 0.25); gl_FragColor = vec4(c, 1.0); }'
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'sky';
  group.add(sky);

  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(8, 32),
    new THREE.MeshBasicMaterial({ color: 0xffc53d, fog: false })
  );
  // P10 (Rizal fix): the disc was at +x (120, 26, -60) — ~70° off-axis
  // from the title/action/draft cameras (all look toward -x), so no shot
  // ever showed the sun. Mirrored to -x so the low disc + halo read in
  // every backdrop. The directional light moves with it (render3d.js).
  // Round 2: the first try (14u disc, pale gold) rendered as a giant
  // white moon behind the title — now a smaller (8u), deeper-gold disc,
  // lower in the sky. Warm, not blinding white.
  // Round 3: (-135, 20, -48) landed BEHIND the new top-left title panel.
  // (-40, 18, -130) puts it in the top-right sky of the title frame
  // (clear of the panel) and near the top edge of the draft frame.
  sun.position.set(-40, 18, -130);
  sun.lookAt(0, 6, 0);
  sun.name = 'sunDisc';
  group.add(sun);

  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(13, 32),
    new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.45, fog: false })
  );
  halo.position.set(-40, 18, -130.5);
  halo.lookAt(0, 6, 0);
  halo.name = 'sunHalo';
  group.add(halo);

  // Clouds: flattened white puffs drifting (deterministic drift from sim time).
  const clouds = new THREE.Group();
  clouds.name = 'clouds';
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xfff2d8, roughness: 1, flatShading: true, transparent: true, opacity: 0.85, emissive: 0xffd9a0, emissiveIntensity: 0.2 });
  for (let i = 0; i < 10; i += 1) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(rng() * 3);
    for (let p = 0; p < puffs; p += 1) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(range(rng, 2.5, 5), 8, 6), cloudMat);
      puff.position.set(p * 3.5 - puffs * 1.5, range(rng, -0.6, 0.6), range(rng, -1.5, 1.5));
      puff.scale.y = 0.55;
      cloud.add(puff);
    }
    cloud.position.set(range(rng, -100, 120), range(rng, 34, 52), range(rng, -80, -20));
    cloud.userData.drift = range(rng, 0.3, 0.9);
    clouds.add(cloud);
  }
  group.add(clouds);

  // Birds: 5 dark V shapes, animated deterministically from sim time.
  const birds = new THREE.Group();
  birds.name = 'birds';
  const birdMat = new THREE.MeshBasicMaterial({ color: 0x2b2b2b, side: THREE.DoubleSide });
  for (let i = 0; i < 5; i += 1) {
    const bird = new THREE.Group();
    const wingGeo = new THREE.PlaneGeometry(1.1, 0.28);
    wingGeo.translate(0.55, 0, 0);
    const left = new THREE.Mesh(wingGeo, birdMat);
    const right = new THREE.Mesh(wingGeo, birdMat);
    right.rotation.y = Math.PI;
    bird.add(left);
    bird.add(right);
    bird.userData = { offset: i * 2.4, phase: rng() * Math.PI * 2, y: range(rng, 24, 36), speed: range(rng, 2.2, 3.4) };
    birds.add(bird);
  }
  group.add(birds);

  scene.add(group);
  return { group, wheat, grass, dryGrass, clouds, birds, brickTexture: null };
}

export function makeBrickTextureSeeded(seed, opts = {}) {
  return makeBrickTexture(mulberry32(seed), opts);
}

export function makeWoodTextureSeeded(seed) {
  return makeWoodTexture(mulberry32(seed));
}

// Powder-keg texture: vertical staves + 2 dark iron bands (wraps the
// cylinder side). Used by the field kegs (render3d) and the powder store.
function makeKegTexture(rng) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(0, 0, 256, 128);
  const staves = 8;
  const sw = 256 / staves;
  for (let s = 0; s < staves; s += 1) {
    const shade = 0.85 + rng() * 0.3;
    ctx.fillStyle = `rgb(${Math.round(138 * shade)},${Math.round(90 * shade)},${Math.round(43 * shade)})`;
    ctx.fillRect(s * sw + 1, 0, sw - 2, 128);
    // Grain: a few vertical streaks per stave.
    for (let g = 0; g < 5; g += 1) {
      const gx = s * sw + 4 + rng() * (sw - 8);
      ctx.strokeStyle = `rgba(70, 45, 20, ${0.2 + rng() * 0.25})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx + (rng() - 0.5) * 6, 128);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(50, 32, 16, 0.85)';
    ctx.fillRect(s * sw, 0, 2, 128);
  }
  // Iron bands (top + bottom).
  for (const by of [14, 100]) {
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, by, 256, 14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(0, by, 256, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Bark texture: vertical dark streaks on brown (tree trunks).
function makeBarkTexture(rng) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#5a3d24';
  ctx.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 46; i += 1) {
    const x = rng() * 128;
    const w = 2 + rng() * 5;
    const light = rng() > 0.5;
    ctx.fillStyle = light ? `rgba(140, 100, 60, ${0.25 + rng() * 0.3})` : `rgba(30, 18, 10, ${0.3 + rng() * 0.35})`;
    ctx.fillRect(x, 0, w, 256);
    // Wrap: a streak crossing the right edge continues at the left —
    // no visible vertical seam where the texture wraps around the trunk.
    if (x + w > 128) ctx.fillRect(x - 128, 0, w, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Water texture: blue with lighter current streaks + foam speckles.
function makeWaterTexture(rng) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4a8ab5';
  ctx.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 26; i += 1) {
    const y = rng() * 256;
    ctx.strokeStyle = `rgba(200, 230, 250, ${0.12 + rng() * 0.2})`;
    ctx.lineWidth = 1 + rng() * 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(40, y + (rng() - 0.5) * 10, 90, y + (rng() - 0.5) * 10, 128, y);
    ctx.stroke();
  }
  for (let i = 0; i < 40; i += 1) {
    ctx.fillStyle = `rgba(230, 245, 255, ${0.2 + rng() * 0.3})`;
    ctx.beginPath();
    ctx.arc(rng() * 128, rng() * 256, 1 + rng() * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeKegTextureSeeded(seed) {
  return makeKegTexture(mulberry32(seed));
}

export function makeBarkTextureSeeded(seed) {
  return makeBarkTexture(mulberry32(seed));
}

export function makeWaterTextureSeeded(seed) {
  return makeWaterTexture(mulberry32(seed));
}
