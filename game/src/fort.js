// CHAINFIRE 3D — the fort. Written fresh for the 3D rebuild.
// The fort sits on the fort hill at x = WALL_X (-42.7): 7 stone blocks, 3
// towers with red cone roofs, gate, parapet, torches, powder store, Mira's
// workshop, horse stable. Wall damage is visual: setWallDamage(frac) tilts
// and darkens blocks as wall HP falls (frac = wallHp / wallMax).

import { THREE } from './three.js';
import { PALETTE, WORLD } from './data.js';
import { terrainHeight, makeBrickTextureSeeded, makeWoodTextureSeeded, makeKegTextureSeeded } from './terrain.js';
import { range } from './rng.js';

export const WALL_TOP_OFFSET = 6;

export function wallTopY(z) {
  return terrainHeight(WORLD.WALL_X, z) + WALL_TOP_OFFSET;
}

function makeHorse(matBody, matMane) {
  const horse = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 0.9), matBody);
  body.position.y = 1.5;
  horse.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 1.1, 6), matBody);
  neck.position.set(1.2, 2.2, 0);
  neck.rotation.z = -0.5;
  horse.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.45), matBody);
  head.position.set(1.7, 2.7, 0);
  horse.add(head);
  const mane = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 0.3), matMane);
  mane.position.set(1.1, 2.6, 0);
  mane.rotation.z = -0.5;
  horse.add(mane);
  for (const [lx, lz] of [[-0.8, -0.3], [-0.8, 0.3], [0.8, -0.3], [0.8, 0.3]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.1, 6), matBody);
    leg.position.set(lx, 0.55, lz);
    horse.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.25, 0.25), matMane);
  tail.position.set(-1.3, 1.8, 0);
  tail.rotation.z = 0.5;
  horse.add(tail);
  horse.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  return horse;
}

export function buildFort(scene, rng) {
  const group = new THREE.Group();
  group.name = 'fort';
  // 3 brick variants (seeds 31/32/33) so the 7 blocks + 3 towers don't all
  // share one identical texture; towers get a 2x repeat (circumference
  // ~20u — the plain texture would stretch the bricks wide).
  const stoneMats = [31, 32, 33].map((s) => new THREE.MeshStandardMaterial({ map: makeBrickTextureSeeded(s), roughness: 0.9 }));
  const towerTex = makeBrickTextureSeeded(31, { clean: true }).clone();
  towerTex.repeat.set(2, 2);
  towerTex.needsUpdate = true;
  const towerMat = new THREE.MeshStandardMaterial({ map: towerTex, roughness: 0.9 });
  const woodTexMat = new THREE.MeshStandardMaterial({ map: makeWoodTextureSeeded(41), roughness: 0.9 });
  const stoneDark = new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 0.95 });
  const roofMat = new THREE.MeshStandardMaterial({ color: PALETTE.ROOF_RED, roughness: 0.8, flatShading: true });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffc53d, roughness: 0.4, metalness: 0.6 });
  const flagMat = new THREE.MeshStandardMaterial({ color: 0xffc53d, roughness: 0.8, side: THREE.DoubleSide, emissive: 0x8a6a1a, emissiveIntensity: 0.3 });

  const wallBlocks = [];
  const blockZ = [-24, -16, -8, 0, 8, 16, 24];
  for (let i = 0; i < blockZ.length; i += 1) {
    const z = blockZ[i];
    const y = terrainHeight(WORLD.WALL_X, z);
    const block = new THREE.Mesh(new THREE.BoxGeometry(3, WALL_TOP_OFFSET, 7.4), stoneMats[i % 3].clone());
    block.position.set(WORLD.WALL_X, y + WALL_TOP_OFFSET / 2, z);
    block.castShadow = true;
    block.receiveShadow = true;
    block.userData.baseY = y;
    block.userData.baseRotZ = 0;
    block.userData.index = i;
    group.add(block);
    wallBlocks.push(block);
    // Crenellations on top of each block.
    for (let c = -1; c <= 1; c += 1) {
      const cren = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1, 1.4), stoneDark);
      cren.position.set(WORLD.WALL_X, y + WALL_TOP_OFFSET + 0.5, z + c * 2.6);
      cren.castShadow = true;
      group.add(cren);
    }
  }

  // Arrow slits: dark vertical slots on the wall's outer face (2 per block).
  const slitGeo = new THREE.BoxGeometry(0.15, 1.2, 0.3);
  const slitMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 1 });
  const slits = new THREE.InstancedMesh(slitGeo, slitMat, wallBlocks.length * 2);
  {
    const d = new THREE.Object3D();
    let si = 0;
    for (const block of wallBlocks) {
      for (const dz of [-1.8, 1.8]) {
        d.position.set(WORLD.WALL_X + 1.55, block.userData.baseY + 3.5, block.position.z + dz);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        slits.setMatrixAt(si, d.matrix);
        si += 1;
      }
    }
  }
  group.add(slits);

  // Gate: double wooden doors in the center block (z = 0), with an arch.
  const gateY = terrainHeight(WORLD.WALL_X, 0);
  for (const side of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4.6, 3.2), woodTexMat);
    door.position.set(WORLD.WALL_X + 1.6, gateY + 2.3, side * 1.65);
    door.castShadow = true;
    group.add(door);
  }
  const arch = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.5, 6, 12, Math.PI), stoneDark);
  arch.position.set(WORLD.WALL_X + 1.6, gateY + 4.6, 0);
  arch.rotation.y = Math.PI / 2;
  arch.rotation.z = 0;
  group.add(arch);
  const portcullis = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 4.4, 6.4),
    new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.5, metalness: 0.7 })
  );
  portcullis.position.set(WORLD.WALL_X + 1.8, gateY + 2.2, 0);
  group.add(portcullis);

  // 3 towers with red cone roofs + waving flags.
  const flags = [];
  const towerZ = [-21, 0, 21];
  for (const z of towerZ) {
    const y = terrainHeight(WORLD.WALL_X - 1, z);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 10, 10), towerMat.clone());
    tower.position.set(WORLD.WALL_X - 1, y + 5, z);
    tower.castShadow = true;
    tower.receiveShadow = true;
    group.add(tower);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.9, 3.2, 10), roofMat);
    roof.position.set(WORLD.WALL_X - 1, y + 10 + 1.6, z);
    roof.castShadow = true;
    group.add(roof);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.4, 6), goldMat);
    pole.position.set(WORLD.WALL_X - 1, y + 10 + 3.2 + 1.1, z);
    group.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1), flagMat);
    flag.position.set(WORLD.WALL_X - 1 + 0.95, y + 10 + 3.2 + 1.6, z);
    flag.userData.baseRotY = 0;
    group.add(flag);
    flags.push(flag);
    // Tower window (glowing).
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 1, 0.7),
      new THREE.MeshStandardMaterial({ color: 0xffc873, emissive: 0xffb347, emissiveIntensity: 1.2 })
    );
    win.position.set(WORLD.WALL_X + 2.3, y + 7, z);
    group.add(win);
  }

  // Torches on the wall (2 point lights max for the fort; the rest emissive).
  const torches = [];
  const torchLights = [];
  for (const z of [-12, 12]) {
    const y = terrainHeight(WORLD.WALL_X, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.2, 6), woodTexMat);
    post.position.set(WORLD.WALL_X + 1.8, y + WALL_TOP_OFFSET + 0.6, z);
    group.add(post);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1, 8),
      new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff8a1a, emissiveIntensity: 2.2 })
    );
    flame.position.set(WORLD.WALL_X + 1.8, y + WALL_TOP_OFFSET + 1.6, z);
    flame.userData.isFlame = true;
    group.add(flame);
    torches.push(flame);
    const light = new THREE.PointLight(0xff8a2a, 14, 16, 1.6);
    light.position.set(WORLD.WALL_X + 2.5, y + WALL_TOP_OFFSET + 2, z);
    group.add(light);
    torchLights.push(light);
  }

  // Powder store (hut behind the wall, z = -12) with a keg stack.
  const store = new THREE.Group();
  const storeBase = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 4), woodTexMat);
  storeBase.position.y = 1.5;
  storeBase.castShadow = true;
  store.add(storeBase);
  const storeRoof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 1.8, 4), roofMat);
  storeRoof.position.y = 3.9;
  storeRoof.rotation.y = Math.PI / 4;
  storeRoof.castShadow = true;
  store.add(storeRoof);
  const kegMat = new THREE.MeshStandardMaterial({ map: makeKegTextureSeeded(51), roughness: 0.9 });
  for (let i = 0; i < 3; i += 1) {
    const keg = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.1, 10), kegMat);
    keg.position.set(-3.2 + i * 0.2, 0.55, 2.6);
    keg.castShadow = true;
    store.add(keg);
  }
  store.position.set(-50, terrainHeight(-50, -12), -12);
  group.add(store);

  // Mira's workshop (hut behind the wall, z = +10) with chimney + brass crank.
  const shop = new THREE.Group();
  const shopBase = new THREE.Mesh(new THREE.BoxGeometry(5, 3.2, 4.4), new THREE.MeshStandardMaterial({ color: 0x7a8a6a, roughness: 0.9 }));
  shopBase.position.y = 1.6;
  shopBase.castShadow = true;
  shop.add(shopBase);
  const shopRoof = new THREE.Mesh(new THREE.ConeGeometry(3.8, 1.8, 4), new THREE.MeshStandardMaterial({ color: 0x5a6a8a, roughness: 0.9, flatShading: true }));
  shopRoof.position.y = 4.1;
  shopRoof.rotation.y = Math.PI / 4;
  shopRoof.castShadow = true;
  shop.add(shopRoof);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.2, 0.7), stoneDark);
  chimney.position.set(1.4, 4.4, -1);
  shop.add(chimney);
  const crank = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.12, 6, 12), goldMat);
  crank.position.set(2.6, 1.6, 0);
  crank.rotation.y = Math.PI / 2;
  shop.add(crank);
  shop.position.set(-50, terrainHeight(-50, 10), 10);
  group.add(shop);

  // Horse stable: fence + 2 horses.
  const stable = new THREE.Group();
  const fenceMat = woodTexMat;
  for (let i = 0; i < 5; i += 1) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.2, 0.25), fenceMat);
    post.position.set(-2 + i * 2, 0.6, 2.2);
    stable.add(post);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(9, 0.18, 0.18), fenceMat);
  rail.position.set(2, 1.1, 2.2);
  stable.add(rail);
  const horse1 = makeHorse(new THREE.MeshStandardMaterial({ color: 0x6b3a1e, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color: 0x2b1a0e, roughness: 1 }));
  horse1.position.set(0.5, 0, 0.5);
  horse1.rotation.y = 0.4;
  stable.add(horse1);
  const horse2 = makeHorse(new THREE.MeshStandardMaterial({ color: 0xc8b8a0, roughness: 0.9 }), new THREE.MeshStandardMaterial({ color: 0x8a7a66, roughness: 1 }));
  horse2.position.set(3.5, 0, -0.5);
  horse2.rotation.y = -0.3;
  stable.add(horse2);
  stable.position.set(-53, terrainHeight(-53, 18), 18);
  group.add(stable);

  scene.add(group);

  function setWallDamage(frac) {
    // frac = wallHp / wallMax. Blocks tilt + darken as the wall falls.
    const dmg = Math.max(0, Math.min(1, 1 - frac));
    for (const block of wallBlocks) {
      const i = block.userData.index;
      const local = Math.max(0, dmg * 2 - i * 0.18);
      block.rotation.z = local * 0.05 * (i % 2 ? 1 : -1);
      const shade = 1 - local * 0.45;
      block.material.color.setRGB(shade, shade * 0.95, shade * 0.9);
    }
  }

  return { group, wallBlocks, flags, torches, torchLights, setWallDamage };
}
