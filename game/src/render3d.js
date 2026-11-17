// CHAINFIRE 3D — renderer. Written fresh for the 3D rebuild.
// Owns the WebGL scene: terrain, fort, characters, trail ribbon, fire,
// explosions, beacon, popups, camera. All per-frame animation derives from
// world.time (deterministic) — NO Math.random, NO Date.now in this file.
// Bloom is faked with additive glow materials (no post-processing chain,
// which keeps staging byte-identical).

import { THREE } from './three.js';
import { PALETTE, WORLD, POWDER_TYPES, ENEMY_TYPES, SIM } from './data.js';
import { terrainHeight, buildTerrain, makeKegTextureSeeded } from './terrain.js';
import { buildFort, wallTopY } from './fort.js';
import { buildCharacter } from './models.js';
import { mulberry32 } from './rng.js';

const POPUP_POOL = 24;
const FLASH_POOL = 8;
const SCORCH_POOL = 40;
const SMOKE_POOL = 12;

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255, 200, 90, 1)');
  grad.addColorStop(0.4, 'rgba(255, 140, 40, 0.55)');
  grad.addColorStop(1, 'rgba(255, 120, 20, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Fireball texture (P3): a shaped fireball, not a flat bright disc —
// white-gold core, orange mid, deep-orange edge, plus six fixed flame
// tongues around the rim. Fixed drawing = identical every load.
function makeFireballTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255, 244, 200, 1)');
  grad.addColorStop(0.25, 'rgba(255, 205, 90, 0.95)');
  grad.addColorStop(0.55, 'rgba(255, 140, 30, 0.7)');
  grad.addColorStop(0.8, 'rgba(220, 90, 10, 0.35)');
  grad.addColorStop(1, 'rgba(200, 60, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255, 150, 40, 0.45)';
  for (const deg of [15, 75, 140, 205, 265, 330]) {
    const a = (deg * Math.PI) / 180;
    ctx.save();
    ctx.translate(64 + Math.cos(a) * 42, 64 + Math.sin(a) * 42);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.ellipse(0, 0, 15, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Smoke texture (P3): a soft warm-gray puff — the dark counterweight to
// the additive fire, so a blast reads as fire + smoke, not a white hole.
function makeSmokeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
  grad.addColorStop(0, 'rgba(120, 100, 80, 0.55)');
  grad.addColorStop(0.5, 'rgba(100, 85, 70, 0.35)');
  grad.addColorStop(1, 'rgba(90, 75, 60, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const CAMERA_PRESETS = {
  game: { pos: [34, 30, 44], target: [-10, 2, 0] },
  title: { pos: [20, 27, 54], target: [-20, 4, 0] },
  // P8 (Rizal fix round 2): eagle B KEEPS — [22,42,58]->[2,0,0], 34 deg down.
  // The round-2 experiment (eagle A [15,38,52]->[-5,0,0]) FAILED capture
  // verification: the Titan's BODY is cut at the right frame edge and the
  // bottom-right popup clips, for only +4px on the defenders (Thom 33->37).
  // The titan-hunt's point test said A keeps the Titan, but it tests only
  // the Titan's CENTER — the 12.8u body extends past the frustum edge.
  // The hunt proves no tighter preset keeps the whole Titan in frame at
  // the first x8 moment (D/E/F/G/H/I all fail the center test; F only at
  // later moments with fewer enemies). So B stays: Titan fully in frame
  // (~160px), 16 enemies, Thom ~33px — and the defenders read via the
  // celebrate pose (arms up, chainMul>=4), not via the camera.
  action: { pos: [22, 42, 58], target: [2, 0, 0] },
  draft: { pos: [10, 34, 52], target: [-16, 2, 0] },
  results: { pos: [6, 28, 54], target: [-22, 4, 0] }
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xe8a860, 95, 210);

    this.camera = new THREE.PerspectiveCamera(45, 1280 / 720, 0.1, 500);
    this.camPos = new THREE.Vector3(34, 30, 44);
    this.camTarget = new THREE.Vector3(-10, 2, 0);
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.zoom = 1;
    this.preset = 'game';

    // Evening sun: low from the left (matches the sun disc in terrain.js).
    // P10: mirrored from +x to -x with the disc — the title/action/draft
    // cameras all look toward -x, so the sun must live on that side or no
    // shot ever shows it. Shadows now fall toward +x (toward the camera).
    this.sun = new THREE.DirectionalLight(0xffd9a0, 2.6);
    this.sun.position.set(-90, 42, -46);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x8a6ab8, 0x3d6b46, 0.85);
    this.scene.add(this.hemi);

    this.glowTex = makeGlowTexture();
    this.fireballTex = makeFireballTexture();
    this.smokeTex = makeSmokeTexture();
    this.world = null;
    this.time = 0;

    // Environment.
    const rng = mulberry32(20261117);
    const env = buildTerrain(this.scene, rng);
    this.env = env;
    const fort = buildFort(this.scene, rng);
    this.fort = fort;

    // Wheat sway bases (deterministic phase from instance index).
    this.wheatBase = [];
    {
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      for (let i = 0; i < env.wheat.count; i += 1) {
        env.wheat.getMatrixAt(i, m);
        m.decompose(p, q, s);
        this.wheatBase.push({ p: p.clone(), q: q.clone(), s: s.clone() });
      }
    }
    // Grass + dry-grass sway bases (round 2 — same pattern as wheat).
    this.grassBase = [];
    this.dryGrassBase = [];
    {
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      for (let i = 0; i < env.grass.count; i += 1) {
        env.grass.getMatrixAt(i, m);
        m.decompose(p, q, s);
        this.grassBase.push({ p: p.clone(), q: q.clone(), s: s.clone() });
      }
      for (let i = 0; i < env.dryGrass.count; i += 1) {
        env.dryGrass.getMatrixAt(i, m);
        m.decompose(p, q, s);
        this.dryGrassBase.push({ p: p.clone(), q: q.clone(), s: s.clone() });
      }
    }
    // Cloud bases.
    this.cloudBase = env.clouds.children.map((c) => ({ x: c.position.x, y: c.position.y, z: c.position.z, drift: c.userData.drift }));

    // Characters.
    this.enemyPool = { cinderling: [], torchbearer: [], ironhide: [], saboteur: [] };
    this.enemyMeshes = new Map();
    this.bossMesh = null;
    this.defenders = {};
    const defPos = { wren: -5, pip: -14, thom: 6, mira: 14 };
    for (const kind of ['wren', 'pip', 'thom', 'mira']) {
      const ch = buildCharacter(kind, { seed: 11 });
      ch.group.visible = true;
      this.scene.add(ch.group);
      this.defenders[kind] = { ...ch, z: defPos[kind] };
    }

    // Trail ribbon.
    this.trailMesh = null;
    this.trailGeo = null;
    this.trailMat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });

    // Fire front: flame cone + glow sprite + point light.
    this.fireGroup = new THREE.Group();
    this.fireGroup.visible = false;
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(1.4, 3.4, 10),
      new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff6a00, emissiveIntensity: 3, transparent: true, opacity: 0.95 })
    );
    flame.position.y = 1.7;
    this.fireGroup.add(flame);
    const fireGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffa030, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    fireGlow.scale.set(9, 9, 1);
    fireGlow.position.y = 1.2;
    this.fireGroup.add(fireGlow);
    this.fireLight = new THREE.PointLight(0xff8a2a, 26, 22, 1.5);
    this.fireLight.position.y = 2;
    this.fireGroup.add(this.fireLight);
    this.scene.add(this.fireGroup);

    // Beacon (x8 moment): volumetric pillar + ground glow + light.
    // P3 (Rizal fix round 2): the 26u pillar (core 0.5) + 13u glow STILL
    // washed a ~30%-wide band of the right frame (mean brightness ~175 vs
    // ~90-118 beside it, measured on the round-1 action shot). Shrunk
    // again: 16u pillar, core opacity 0.35, 8u glow, weaker light — a warm
    // gold column that reads at 320px without whiting out the subjects.
    // ITEM 2 (Mark 18:18 WIB): the 16u pillar STILL reads as a burning
    // white column — the eye sees "gosongin kanan frame" even though the
    // near-white % halved. Root cause is not size alone: the CORE is
    // near-white (0xfff2c0) and additive, so pillar + core + glow + light
    // stack into white over the bright field. Fix: shorter + narrower
    // pillar, core colour moved off white to warm amber, all opacities
    // down, glow + light smaller — the beacon must read GOLD, not white.
    // The x8 stays readable via the giant x8 numeral + ground glow +
    // chain popups, which are untouched.
    this.beacon = new THREE.Group();
    this.beacon.visible = false;
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 1.0, 10, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf59e2c, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    pillar.position.y = 5;
    this.beacon.add(pillar);
    const pillarCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.4, 10, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd97a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    pillarCore.position.y = 5;
    this.beacon.add(pillarCore);
    const beaconGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffc53d, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending }));
    beaconGlow.scale.set(5, 5, 1);
    beaconGlow.position.y = 2;
    this.beacon.add(beaconGlow);
    this.beaconLight = new THREE.PointLight(0xffb347, 8, 14, 1.4);
    this.beaconLight.position.y = 6;
    this.beacon.add(this.beaconLight);
    this.scene.add(this.beacon);

    // Explosion flashes + shockwave rings (pooled). P3: the flash was a
    // uniform gold sphere — a flat white-yellow disc at peak. Now a
    // textured fireball sprite (shaped, orange/gold, flame tongues) with a
    // slightly thicker shockwave ring. Embers + debris come from the sim
    // particles; smoke has its own pool below.
    this.flashes = [];
    for (let i = 0; i < FLASH_POOL; i += 1) {
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.fireballTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      flash.visible = false;
      this.scene.add(flash);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.3, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.scene.add(ring);
      this.flashes.push({ flash, ring, t: 99, ttl: 0.5, x: 0, z: 0, maxR: 5 });
    }

    // Smoke puffs (pooled): warm gray billboards, normal blending.
    this.smokes = [];
    for (let i = 0; i < SMOKE_POOL; i += 1) {
      const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, opacity: 0, depthWrite: false }));
      puff.visible = false;
      this.scene.add(puff);
      this.smokes.push({ puff, t: 99, ttl: 1.4, x: 0, z: 0, born: 0 });
    }

    // Scorch decals (pooled).
    this.scorches = [];
    const scorchGeo = new THREE.CircleGeometry(1, 20);
    for (let i = 0; i < SCORCH_POOL; i += 1) {
      const decal = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({ color: 0x1a120c, transparent: true, opacity: 0, depthWrite: false }));
      decal.rotation.x = -Math.PI / 2;
      decal.visible = false;
      this.scene.add(decal);
      this.scorches.push({ mesh: decal, used: false });
    }
    this.scorchIndex = 0;
    this.scorchedKegs = new Set();
    this.scorchedWall = new Set();

    // Sim particles -> instanced spheres.
    this.particleMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.16, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      SIM.MAX_PARTICLES
    );
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.count = 0;
    this.particleMesh.frustumCulled = false;
    this.scene.add(this.particleMesh);

    // Popup sprites (pooled, canvas textures).
    this.popups = [];
    for (let i = 0; i < POPUP_POOL; i += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sprite.visible = false;
      sprite.renderOrder = 10;
      sprite.scale.set(9, 2.25, 1);
      this.scene.add(sprite);
      this.popups.push({ sprite, canvas, tex, text: null });
    }

    // Keg meshes (rebuilt per wave).
    this.kegMeshes = new Map();
    this.kegGeo = new THREE.CylinderGeometry(0.85, 0.85, 1.2, 10);
    this.kegMat = new THREE.MeshStandardMaterial({ map: makeKegTextureSeeded(51), roughness: 0.9 });
    this.kegBandMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.5, metalness: 0.6 });
    this.kegGlowMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff6a00, emissiveIntensity: 2 });

    this._dummy = new THREE.Object3D();
    this._tmpColor = new THREE.Color();
    this._v1 = new THREE.Vector3();
    this.resize(1280, 720);
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setWorld(world) {
    this.world = world;
    this.time = world ? world.time : 0;
  }

  setCameraPreset(name) {
    const preset = CAMERA_PRESETS[name] || CAMERA_PRESETS.game;
    this.preset = name;
    this.camPos.set(preset.pos[0], preset.pos[1], preset.pos[2]);
    this.camTarget.set(preset.target[0], preset.target[1], preset.target[2]);
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.zoom = 1;
  }

  setCameraFree(pos, target) {
    this.preset = 'free';
    this.camPos.set(pos[0], pos[1], pos[2]);
    this.camTarget.set(target[0], target[1], target[2]);
  }

  applyOrbit(dYaw, dPitch, dZoom) {
    this.orbitYaw = Math.max(-0.52, Math.min(0.52, this.orbitYaw + dYaw));
    this.orbitPitch = Math.max(-0.26, Math.min(0.26, this.orbitPitch + dPitch));
    this.zoom = Math.max(0.7, Math.min(1.5, this.zoom * dZoom));
  }

  // --- character pooling -------------------------------------------------
  _takeEnemy(kind) {
    const pool = this.enemyPool[kind];
    if (pool.length > 0) {
      const ch = pool.pop();
      ch.group.visible = true;
      return ch;
    }
    const ch = buildCharacter(kind, { seed: 7 });
    ch.kind = kind;
    this.scene.add(ch.group);
    return ch;
  }

  _freeEnemy(kind, ch) {
    ch.group.visible = false;
    if (this.enemyPool[kind].length < 24) this.enemyPool[kind].push(ch);
    else this.scene.remove(ch.group);
  }

  // --- trail ribbon -------------------------------------------------------
  _updateTrail() {
    const world = this.world;
    const trail = world ? world.trail : null;
    if (!trail || !trail.points || trail.points.length < 2) {
      if (this.trailMesh) this.trailMesh.visible = false;
      if (this.trailGlowMesh) this.trailGlowMesh.visible = false;
      if (this.trailBedMesh) this.trailBedMesh.visible = false;
      return;
    }
    const pts = trail.points;
    const def = POWDER_TYPES[trail.type] || POWDER_TYPES.BLACK;
    const n = pts.length;
    const positions = new Float32Array(n * 2 * 3);
    // Glow halo: a second, wider ribbon under the main one (same path,
    // additive, low opacity, uniform DEEP orange 0xff5a00). The 0.3u ribbon
    // is ~1px at 320px and vanishes in the thumbnail; the 1.6u halo makes
    // the trail read as a line of light without changing the ribbon's spec
    // width. Gold-on-tan-road has almost no contrast, so the halo is deep
    // orange, not gold. The main ribbon keeps the powder's own glow color.
    const glowPositions = new Float32Array(n * 2 * 3);
    const glowColors = new Float32Array(n * 2 * 3);
    const colHalo = new THREE.Color(0xff5a00);
    // Bed: a dark powder-bed ribbon under the glow (1.0u wide, dark warm
    // brown). The dark bed gives the bright trail a contrast edge so it
    // reads as a line at 320px — like an outline under text. The powder
    // itself is dark, so the bed is realistic: dark powder, bright fire
    // on top.
    const bedPositions = new Float32Array(n * 2 * 3);
    const bedColors = new Float32Array(n * 2 * 3);
    const colBed = new THREE.Color(0x241608);
    const colors = new Float32Array(n * 2 * 3);
    const indices = [];
    const colUnburnt = new THREE.Color(def.glow);
    const colBurnt = new THREE.Color(0xff5a00);
    const colDark = new THREE.Color(0x1a1a1a);
    let dist = 0;
    for (let i = 0; i < n; i += 1) {
      if (i > 0) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      // Direction (for the ribbon width, perpendicular to the trail).
      let dx = 0;
      let dz = 1;
      if (i < n - 1) { dx = pts[i + 1].x - pts[i].x; dz = pts[i + 1].z - pts[i].z; }
      else if (i > 0) { dx = pts[i].x - pts[i - 1].x; dz = pts[i].z - pts[i - 1].z; }
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len * 0.15;
      const pz = dx / len * 0.15;
      const y = terrainHeight(pts[i].x, pts[i].z) + 0.18;
      positions[i * 6] = pts[i].x + px;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = pts[i].z + pz;
      positions[i * 6 + 3] = pts[i].x - px;
      positions[i * 6 + 4] = y;
      positions[i * 6 + 5] = pts[i].z - pz;
      // Glow halo vertices: 5x wider, 0.06u below the main ribbon.
      const gx = -dz / len * 0.8;
      const gz = dx / len * 0.8;
      const gy = terrainHeight(pts[i].x, pts[i].z) + 0.12;
      glowPositions[i * 6] = pts[i].x + gx;
      glowPositions[i * 6 + 1] = gy;
      glowPositions[i * 6 + 2] = pts[i].z + gz;
      glowPositions[i * 6 + 3] = pts[i].x - gx;
      glowPositions[i * 6 + 4] = gy;
      glowPositions[i * 6 + 5] = pts[i].z - gz;
      for (let v = 0; v < 2; v += 1) {
        glowColors[(i * 2 + v) * 3] = colHalo.r;
        glowColors[(i * 2 + v) * 3 + 1] = colHalo.g;
        glowColors[(i * 2 + v) * 3 + 2] = colHalo.b;
      }
      // Bed vertices: 1.0u wide (half-width 0.5), 0.02u below the halo.
      const bx = -dz / len * 0.5;
      const bz = dx / len * 0.5;
      const by = terrainHeight(pts[i].x, pts[i].z) + 0.10;
      bedPositions[i * 6] = pts[i].x + bx;
      bedPositions[i * 6 + 1] = by;
      bedPositions[i * 6 + 2] = pts[i].z + bz;
      bedPositions[i * 6 + 3] = pts[i].x - bx;
      bedPositions[i * 6 + 4] = by;
      bedPositions[i * 6 + 5] = pts[i].z - bz;
      for (let v = 0; v < 2; v += 1) {
        bedColors[(i * 2 + v) * 3] = colBed.r;
        bedColors[(i * 2 + v) * 3 + 1] = colBed.g;
        bedColors[(i * 2 + v) * 3 + 2] = colBed.b;
      }
      // Trail colors: burnt = bright ember orange; ahead-of-fire WHILE
      // BURNING = the powder's glow (gold) so the whole trail reads as one
      // continuous fire line. The near-black is ONLY for the armed (unlit)
      // state — an unlit powder trail is dark; a burning one must glow.
      // (Before: the ahead portion stayed near-black while burning, so the
      // trail read as a dark line and vanished at 320px — hard-rule failure.)
      const burnt = trail.state === 'burning' && dist <= trail.burnDist;
      const col = burnt ? colBurnt : (trail.state === 'armed' ? colDark : colUnburnt);
      for (let v = 0; v < 2; v += 1) {
        colors[(i * 2 + v) * 3] = col.r;
        colors[(i * 2 + v) * 3 + 1] = col.g;
        colors[(i * 2 + v) * 3 + 2] = col.b;
      }
      if (i < n - 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    if (!this.trailGeo) {
      this.trailGeo = new THREE.BufferGeometry();
      this.trailMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
      this.trailMesh = new THREE.Mesh(this.trailGeo, this.trailMat);
      this.trailMesh.frustumCulled = false;
      this.scene.add(this.trailMesh);
    }
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.trailGeo.setIndex(indices);
    this.trailGeo.computeBoundingSphere();
    this.trailMesh.visible = true;
    // Glow halo mesh (same path, deep-orange, wider, additive).
    if (!this.trailGlowGeo) {
      this.trailGlowGeo = new THREE.BufferGeometry();
      this.trailGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
      this.trailGlowMesh = new THREE.Mesh(this.trailGlowGeo, this.trailGlowMat);
      this.trailGlowMesh.frustumCulled = false;
      this.scene.add(this.trailGlowMesh);
    }
    this.trailGlowGeo.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3));
    this.trailGlowGeo.setAttribute('color', new THREE.BufferAttribute(glowColors, 3));
    this.trailGlowGeo.setIndex(indices);
    this.trailGlowGeo.computeBoundingSphere();
    this.trailGlowMesh.visible = true;
    // Bed mesh (dark powder bed under the glow).
    if (!this.trailBedGeo) {
      this.trailBedGeo = new THREE.BufferGeometry();
      this.trailBedMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
      this.trailBedMesh = new THREE.Mesh(this.trailBedGeo, this.trailBedMat);
      this.trailBedMesh.frustumCulled = false;
      this.scene.add(this.trailBedMesh);
    }
    this.trailBedGeo.setAttribute('position', new THREE.BufferAttribute(bedPositions, 3));
    this.trailBedGeo.setAttribute('color', new THREE.BufferAttribute(bedColors, 3));
    this.trailBedGeo.setIndex(indices);
    this.trailBedGeo.computeBoundingSphere();
    this.trailBedMesh.visible = true;
  }

  // --- events -------------------------------------------------------------
  _drainEvents() {
    const world = this.world;
    if (!world || !world.events) return;
    for (const ev of world.events) {
      if (ev.type === 'boom') {
        // Burst centroid: average of the newest particles. Computed once
        // per event so the flash and the smoke puffs share one position.
        const c = this._burstCentroid(world);
        if (c) {
          this._spawnFlash(world, ev.time, c.x, c.z);
          this._spawnSmoke(world, ev.time, c.x, c.z);
        }
      }
    }
    world.events.length = 0;
  }

  _burstCentroid(world) {
    const parts = world.particles;
    if (!parts || parts.length === 0) return null;
    let x = 0;
    let z = 0;
    let count = 0;
    for (let i = Math.max(0, parts.length - 14); i < parts.length; i += 1) {
      x += parts[i].x;
      z += parts[i].z;
      count += 1;
    }
    if (count === 0) return null;
    return { x: x / count, z: z / count };
  }

  _spawnFlash(world, evTime, x, z) {
    for (const slot of this.flashes) {
      if (slot.t > slot.ttl) {
        // Birth in SIM time (the event carries world.time): the flash's
        // progress is then a pure function of world.time, so a frozen
        // staged frame renders identically no matter how many render
        // frames ran before the screenshot. (Before: slot.t += dt per
        // render frame, so the title shot's flash depended on capture
        // timing — the 04:45 title --twice MISMATCH, 18 bytes.)
        slot.born = (typeof evTime === 'number' ? evTime : this.time);
        slot.t = this.time - slot.born;
        slot.ttl = 0.5;
        slot.x = x;
        slot.z = z;
        slot.maxR = 5;
        slot.flash.visible = true;
        slot.ring.visible = true;
        return;
      }
    }
  }

  _spawnSmoke(world, evTime, x, z) {
    // Three puffs at fixed offsets around the burst — deterministic.
    // Birth in SIM time, same as the flash, so a frozen staged frame is
    // byte-identical no matter when the screenshot lands.
    const offs = [[-1.5, 0.5], [0.8, 1.0], [1.4, -0.9]];
    for (const [dx, dz] of offs) {
      for (const slot of this.smokes) {
        if (slot.t > slot.ttl) {
          slot.born = (typeof evTime === 'number' ? evTime : this.time);
          slot.t = this.time - slot.born;
          slot.ttl = 1.4;
          slot.x = x + dx;
          slot.z = z + dz;
          slot.puff.visible = true;
          break;
        }
      }
    }
  }

  _updateSmokes(dt) {
    for (const slot of this.smokes) {
      slot.t = (slot.born !== undefined) ? (this.time - slot.born) : (slot.t + dt);
      if (slot.t > slot.ttl) {
        slot.puff.visible = false;
        continue;
      }
      const f = Math.min(1, slot.t / slot.ttl);
      const y = terrainHeight(slot.x, slot.z) + 1 + f * 4;
      slot.puff.position.set(slot.x, y, slot.z);
      slot.puff.scale.setScalar(2 + f * 4);
      slot.puff.material.opacity = 0.38 * (1 - f);
    }
  }

  _updateFlashes(dt) {
    for (const slot of this.flashes) {
      // Progress from sim time (frozen when the sim is paused/staged);
      // fall back to per-frame dt only for slots born before this fix.
      slot.t = (slot.born !== undefined) ? (this.time - slot.born) : (slot.t + dt);
      if (slot.t > slot.ttl) {
        slot.flash.visible = false;
        slot.ring.visible = false;
        continue;
      }
      const f = Math.min(1, slot.t / slot.ttl);
      const y = terrainHeight(slot.x, slot.z) + 1;
      const r = 1 + f * slot.maxR;
      slot.flash.position.set(slot.x, y, slot.z);
      slot.flash.scale.setScalar(r);
      slot.flash.material.opacity = (1 - f) * 0.85;
      slot.ring.position.set(slot.x, y + 0.2, slot.z);
      slot.ring.scale.setScalar(1 + f * slot.maxR * 1.4);
      slot.ring.material.opacity = (1 - f) * 0.8;
    }
  }

  _placeScorch(x, z, radius) {
    const slot = this.scorches[this.scorchIndex % SCORCH_POOL];
    this.scorchIndex += 1;
    slot.mesh.position.set(x, terrainHeight(x, z) + 0.07, z);
    slot.mesh.scale.setScalar(radius);
    slot.mesh.material.opacity = 0.75;
    slot.mesh.visible = true;
    slot.used = true;
  }

  _updateScorches() {
    const world = this.world;
    if (!world) return;
    for (const keg of world.kegs) {
      if (keg.state === 'gone' && !this.scorchedKegs.has(keg)) {
        this.scorchedKegs.add(keg);
        this._placeScorch(keg.x, keg.z, 2.6);
      }
    }
    for (const s of world.wallScorch) {
      if (!this.scorchedWall.has(s)) {
        this.scorchedWall.add(s);
        // Wall scorch: dark plane on the wall face.
        const slot = this.scorches[this.scorchIndex % SCORCH_POOL];
        this.scorchIndex += 1;
        slot.mesh.position.set(WORLD.WALL_X + 1.7, terrainHeight(WORLD.WALL_X, s.z) + 3.4, s.z);
        slot.mesh.rotation.set(0, Math.PI / 2, 0);
        slot.mesh.scale.setScalar(2.2);
        slot.mesh.material.opacity = 0.8;
        slot.mesh.visible = true;
        slot.used = true;
      }
    }
    if (world.boss && world.boss.defeated && !this.scorchedKegs.has(world.boss)) {
      this.scorchedKegs.add(world.boss);
      this._placeScorch(world.boss.x, world.boss.z, 7);
    }
  }

  _updateKegs() {
    const world = this.world;
    if (!world) return;
    const seen = new Set();
    for (const keg of world.kegs) {
      seen.add(keg);
      let mesh = this.kegMeshes.get(keg);
      if (!mesh) {
        mesh = new THREE.Group();
        const body = new THREE.Mesh(this.kegGeo, this.kegMat);
        body.castShadow = true;
        mesh.add(body);
        const band = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.07, 6, 14), this.kegBandMat);
        band.rotation.x = Math.PI / 2;
        band.position.y = 0.3;
        mesh.add(band);
        const glow = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), this.kegGlowMat);
        glow.position.y = 0.7;
        glow.visible = false;
        mesh.add(glow);
        mesh.userData.glow = glow;
        this.scene.add(mesh);
        this.kegMeshes.set(keg, mesh);
      }
      mesh.visible = keg.alive;
      if (keg.alive) {
        mesh.position.set(keg.x, terrainHeight(keg.x, keg.z) + 0.6, keg.z);
        mesh.userData.glow.visible = keg.state === 'lit';
        if (keg.state === 'lit') {
          const s = 1 + Math.sin(this.time * 30) * 0.15;
          mesh.userData.glow.scale.setScalar(s);
        }
      }
    }
    for (const [keg, mesh] of this.kegMeshes) {
      if (!seen.has(keg)) {
        this.scene.remove(mesh);
        this.kegMeshes.delete(keg);
      }
    }
  }

  _updatePopups() {
    const world = this.world;
    const list = world ? world.popups : [];
    // Screen-space de-confliction: sort by (x, z), project each popup to
    // NDC, and stack any whose screen rect overlaps an already-placed one.
    // The old world-space proximity stack (2.5u + fixed 1.3u step) was the
    // wrong space: a chain sprite is 9u wide, so kills 3–4u apart along the
    // trail still overlapped on screen ("+800 x8" over "+400 x4" in the S2
    // final), and a kill near the spawn edge projected off-frame ("+200 x2"
    // cut at the right edge). The clamp is extent-aware: the centre is kept
    // inside 1 - halfWidth - margin, so the whole sprite fits. A lone,
    // in-frame popup keeps its old anchor exactly (terrain + 3.2), so it
    // renders pixel-identical to before; only overlapping / off-frame
    // popups move. Projection uses camPos/camTarget (set synchronously by
    // setCameraPreset, so correct on the frozen screenshot frame even though
    // this.camera.position lags one frame).
    const sorted = list.slice().sort((a, b) => (a.x - b.x) || (a.z - b.z));
    const tanV = Math.tan(((this.camera.fov || 45) / 2) * Math.PI / 180);
    const tanH = tanV * (this.camera.aspect || 16 / 9);
    const fwd = new THREE.Vector3().subVectors(this.camTarget, this.camPos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const placed = []; // NDC rects {left, right, top, bottom}
    for (let i = 0; i < this.popups.length; i += 1) {
      const slot = this.popups[i];
      const popup = sorted[i];
      if (!popup) {
        slot.sprite.visible = false;
        slot.text = null;
        continue;
      }
      const scale = (popup.size || 20) / 20;
      const wHalfW = (9 * scale) / 2; // world half-width of the sprite
      const hHalfW = (2.25 * scale) / 2; // world half-height of the sprite
      const ax = popup.x;
      const ay = terrainHeight(popup.x, popup.z) + 3.2;
      const az = popup.z;
      const vx = ax - this.camPos.x;
      const vy = ay - this.camPos.y;
      const vz = az - this.camPos.z;
      const zc = vx * fwd.x + vy * fwd.y + vz * fwd.z;
      if (zc <= 0.1) {
        // Behind the camera: the GPU culls it anyway; keep the old anchor.
        slot.sprite.position.set(ax, ay, az);
        slot.sprite.scale.set(9 * scale, 2.25 * scale, 1);
      } else {
        const xc = vx * right.x + vy * right.y + vz * right.z;
        const yc = vx * up.x + vy * up.y + vz * up.z;
        let ndcX = xc / (zc * tanH);
        let ndcY = yc / (zc * tanV);
        const hw = wHalfW / (zc * tanH);
        const hh = hHalfW / (zc * tanV);
        // Clamp FIRST, then stack: clamping after stacking used to drag a
        // raised popup back onto a placed one at the frame edge — the
        // corner pile-up the overlap checker caught (several off-frame
        // popups all clamped to the same corner, overlapping). Clamping
        // first keeps the stack working on the final in-frame positions.
        // A lone, in-frame popup is untouched by the clamp (identity), so
        // it renders pixel-identical to before.
        const maxX = Math.max(0, 1 - hw - 0.02);
        const maxY = Math.max(0, 1 - hh - 0.02);
        const minY = -maxY;
        ndcX = Math.max(-maxX, Math.min(maxX, ndcX));
        ndcY = Math.max(minY, Math.min(maxY, ndcY));
        // Stack above any overlapping placed rect (repeat until stable).
        // The raise is capped at maxY so a popup never escapes the top
        // of the frame.
        for (let pass = 0; pass < 3; pass += 1) {
          let raised = false;
          for (const r of placed) {
            if (ndcX + hw > r.left - 0.01 && ndcX - hw < r.right + 0.01
              && ndcY + hh > r.bottom - 0.01 && ndcY - hh < r.top + 0.01) {
              ndcY = Math.min(maxY, r.top + hh + 0.02);
              raised = true;
            }
          }
          if (!raised) break;
        }
        const nx = ndcX * zc * tanH;
        const ny = ndcY * zc * tanV;
        const px = this.camPos.x + fwd.x * zc + right.x * nx + up.x * ny;
        const py = this.camPos.y + fwd.y * zc + right.y * nx + up.y * ny;
        const pz = this.camPos.z + fwd.z * zc + right.z * nx + up.z * ny;
        placed.push({ left: ndcX - hw, right: ndcX + hw, top: ndcY + hh, bottom: ndcY - hh, text: popup.text });
        slot.sprite.position.set(px, py, pz);
        slot.sprite.scale.set(9 * scale, 2.25 * scale, 1);
      }
      const alpha = popup.t < popup.ttl - 0.25 ? 1 : Math.max(0, (popup.ttl - popup.t) / 0.25);
      slot.sprite.material.opacity = alpha;
      const textKey = `${popup.text}|${popup.color}`;
      if (slot.text !== textKey) {
        slot.text = textKey;
        const ctx = slot.canvas.getContext('2d');
        ctx.clearRect(0, 0, 256, 64);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Fit the text to the 256px canvas: the boss popup ("CINDER TITAN
        // DOWN! +4330", 25 chars) is ~425px at 30px and was clipped on
        // both ends in the results frame ("ER TITAN DOWN!"). Shrink the
        // font until it fits (min 12px); chain popups ("+800 x8 CHAIN",
        // ~230px) already fit, so they keep 30px exactly.
        let fontPx = 30;
        ctx.font = `bold ${fontPx}px Arial, sans-serif`;
        const tw = ctx.measureText(popup.text).width;
        if (tw > 240) fontPx = Math.max(12, Math.floor(30 * 240 / tw));
        ctx.font = `bold ${fontPx}px Arial, sans-serif`;
        const hex = `#${(popup.color || 0xffc53d).toString(16).padStart(6, '0')}`;
        ctx.lineWidth = Math.max(2, fontPx * 0.2);
        ctx.strokeStyle = 'rgba(20, 10, 5, 0.9)';
        ctx.strokeText(popup.text, 128, 32);
        ctx.fillStyle = hex;
        ctx.fillText(popup.text, 128, 32);
        slot.tex.needsUpdate = true;
      }
      slot.sprite.visible = true;
    }
    // P2: keep the final screen-space rects for the overlap checker
    // (verify-3d/overlap-check.cjs) — it reads them via popupRects().
    this.popupRectsCache = placed;
  }

  // P2: overlap checker hook — returns the final popup screen rects
  // (NDC) from the last _updatePopups pass, plus every intersecting pair.
  popupRects() {
    const rects = (this.popupRectsCache || []).map((r) => ({ ...r }));
    const overlaps = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom) {
          overlaps.push({ a: a.text, b: b.text });
        }
      }
    }
    return { count: rects.length, rects, overlaps };
  }

  _updateParticles() {
    const world = this.world;
    const parts = world ? world.particles : [];
    const mesh = this.particleMesh;
    const count = Math.min(parts.length, SIM.MAX_PARTICLES);
    mesh.count = count;
    for (let i = 0; i < count; i += 1) {
      const p = parts[i];
      const life = 1 - p.t / p.ttl;
      this._dummy.position.set(p.x, (p.y || 0) + terrainHeight(p.x, p.z) + 0.5, p.z);
      this._dummy.scale.setScalar(Math.max(0.2, life) * (p.size || 0.3) * 2);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.updateMatrix();
      mesh.setMatrixAt(i, this._dummy.matrix);
      this._tmpColor.setHex(p.color || 0xff7a1a);
      mesh.setColorAt(i, this._tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _updateCharacters() {
    const world = this.world;
    if (!world) return;
    const seen = new Set();
    for (const enemy of world.enemies) {
      seen.add(enemy.id);
      let ch = this.enemyMeshes.get(enemy.id);
      if (!ch) {
        ch = this._takeEnemy(enemy.type);
        this.enemyMeshes.set(enemy.id, ch);
      }
      const y = terrainHeight(enemy.x, enemy.z) + (enemy.bob || 0);
      ch.group.position.set(enemy.x, y, enemy.z);
      ch.group.rotation.y = 0; // models face -x by default (toward the fort)
      const anim = enemy.dead ? 'dead' : 'walk';
      ch.setPose(anim, enemy.dead ? enemy.deathT : enemy.animT, {
        shieldBroken: enemy.shieldBroken
      });
    }
    for (const [id, ch] of this.enemyMeshes) {
      if (!seen.has(id)) {
        const kind = ch.kind || 'torchbearer';
        this._freeEnemy(kind, ch);
        this.enemyMeshes.delete(id);
      }
    }
    // Boss.
    const boss = world.boss;
    if (boss) {
      if (!this.bossMesh) {
        this.bossMesh = buildCharacter('titan', { seed: 13 });
        this.scene.add(this.bossMesh.group);
      }
      const frac = boss.maxHp > 0 ? boss.hp / boss.maxHp : 0;
      const damageState = frac <= 0.25 ? 2 : (frac <= 0.5 ? 1 : 0);
      this.bossMesh.group.visible = boss.alive || boss.defeated;
      this.bossMesh.group.position.set(boss.x, terrainHeight(boss.x, boss.z), boss.z);
      this.bossMesh.group.rotation.y = 0; // models face -x by default
      this.bossMesh.setPose(boss.defeated ? 'dead' : (boss.state === 'attack' ? 'attack' : 'walk'), world.time, { damageState });
    } else if (this.bossMesh) {
      this.bossMesh.group.visible = false;
    }
    // Defenders on the wall.
    const phase = world.phase;
    for (const kind of ['wren', 'pip', 'thom', 'mira']) {
      const def = this.defenders[kind];
      const z = def.z;
      def.group.position.set(WORLD.WALL_X - 0.5, wallTopY(z), z);
      def.group.rotation.y = Math.PI; // face +x (toward the horde)
      let anim = 'idle';
      let expr = 'normal';
      if (phase === 'won') { anim = 'celebrate'; expr = 'cheer'; }
      else if (phase === 'lost') { anim = 'dead'; expr = 'worried'; }
      else if (world.wallHp / world.wallMax < 0.4) { expr = 'worried'; }
      // Round 2 (P6): defenders CHEER with arms up while a big chain runs —
      // the idle breathe (±3%) was invisible at eagle distance, so from a
      // still they read as statues. The celebrate pose (arms up + jump) is
      // a pure function of world.time, so it stays deterministic, and it
      // makes the defenders readable on the wall at the x8 moment.
      else if (world.chainMul >= 4) { anim = 'celebrate'; expr = 'cheer'; }
      def.setPose(anim, world.time, { expression: expr });
    }
    // Wall damage visual.
    if (this.fort.setWallDamage) {
      this.fort.setWallDamage(world.wallMax > 0 ? world.wallHp / world.wallMax : 0);
    }
  }

  _updateAmbient(t) {
    // Wheat sway (deterministic phase from instance index).
    const wheat = this.env.wheat;
    for (let i = 0; i < this.wheatBase.length; i += 1) {
      const base = this.wheatBase[i];
      const sway = Math.sin(t * 1.3 + i * 0.6180339) * 0.07;
      this._dummy.position.copy(base.p);
      this._dummy.quaternion.copy(base.q);
      this._dummy.rotateZ(sway);
      this._dummy.scale.copy(base.s);
      this._dummy.updateMatrix();
      wheat.setMatrixAt(i, this._dummy.matrix);
    }
    wheat.instanceMatrix.needsUpdate = true;
    // Grass + dry-grass sway (round 2 — same pattern, slightly larger
    // amplitude so the blades visibly breathe; phase offsets differ).
    const grass = this.env.grass;
    for (let i = 0; i < this.grassBase.length; i += 1) {
      const base = this.grassBase[i];
      const sway = Math.sin(t * 1.3 + i * 0.6180339 + 1.3) * 0.09;
      this._dummy.position.copy(base.p);
      this._dummy.quaternion.copy(base.q);
      this._dummy.rotateZ(sway);
      this._dummy.scale.copy(base.s);
      this._dummy.updateMatrix();
      grass.setMatrixAt(i, this._dummy.matrix);
    }
    grass.instanceMatrix.needsUpdate = true;
    const dryGrass = this.env.dryGrass;
    for (let i = 0; i < this.dryGrassBase.length; i += 1) {
      const base = this.dryGrassBase[i];
      const sway = Math.sin(t * 1.3 + i * 0.6180339 + 2.9) * 0.09;
      this._dummy.position.copy(base.p);
      this._dummy.quaternion.copy(base.q);
      this._dummy.rotateZ(sway);
      this._dummy.scale.copy(base.s);
      this._dummy.updateMatrix();
      dryGrass.setMatrixAt(i, this._dummy.matrix);
    }
    dryGrass.instanceMatrix.needsUpdate = true;
    // Clouds drift (wrap around).
    for (let i = 0; i < this.env.clouds.children.length; i += 1) {
      const cloud = this.env.clouds.children[i];
      const base = this.cloudBase[i];
      let x = base.x + t * base.drift;
      x = ((x + 130) % 260 + 260) % 260 - 130;
      cloud.position.x = x;
    }
    // Birds fly across (deterministic from time).
    for (const bird of this.env.birds.children) {
      const u = bird.userData;
      const x = -90 + (((t * u.speed + u.offset * 17) % 200) + 200) % 200;
      bird.position.set(x, u.y + Math.sin(t * 0.8 + u.phase) * 1.2, -30 - u.offset * 4);
      bird.rotation.y = -Math.PI / 2;
      const flap = Math.sin(t * 9 + u.phase) * 0.55;
      bird.children[0].rotation.z = flap;
      bird.children[1].rotation.z = -flap;
    }
    // Flags wave.
    for (let i = 0; i < this.fort.flags.length; i += 1) {
      this.fort.flags[i].rotation.y = Math.sin(t * 3 + i * 1.7) * 0.35;
    }
    // Torch flames flicker.
    for (let i = 0; i < this.fort.torches.length; i += 1) {
      const flame = this.fort.torches[i];
      flame.scale.y = 1 + Math.sin(t * 11 + i * 2.3) * 0.18;
      flame.scale.x = 1 + Math.sin(t * 13 + i) * 0.1;
    }
  }

  update(dt) {
    const world = this.world;
    const t = world ? world.time : this.time + dt;
    this.time = t;
    this._drainEvents();
    this._updateTrail();
    this._updateKegs();
    this._updateCharacters();
    this._updatePopups();
    this._updateParticles();
    this._updateScorches();
    this._updateFlashes(dt);
    this._updateSmokes(dt);
    this._updateAmbient(t);

    // Fire front.
    const trail = world ? world.trail : null;
    if (trail && trail.state === 'burning') {
      this.fireGroup.visible = true;
      const fx = trail.frontX ?? trail.points[0].x;
      const fz = trail.frontZ ?? trail.points[0].z;
      this.fireGroup.position.set(fx, terrainHeight(fx, fz) + 0.2, fz);
      const flicker = 1 + Math.sin(t * 23) * 0.12;
      this.fireGroup.scale.setScalar(flicker);
    } else {
      this.fireGroup.visible = false;
    }

    // Beacon while the chain multiplier is x8.
    if (world && world.chainMul >= 8 && world.chain > 0) {
      this.beacon.visible = true;
      const bx = trail && trail.state === 'burning' ? (trail.frontX ?? 0) : (world.lastKillX ?? 0);
      const bz = trail && trail.state === 'burning' ? (trail.frontZ ?? 0) : (world.lastKillZ ?? 0);
      this.beacon.position.set(bx, terrainHeight(bx, bz), bz);
      const pulse = 0.85 + Math.sin(t * 6) * 0.15;
      this.beacon.scale.setScalar(pulse);
    } else {
      this.beacon.visible = false;
    }

    // Camera: orbit + zoom around the preset, plus deterministic shake.
    const dir = this._v1.copy(this.camPos).sub(this.camTarget);
    const len = dir.length() * (1 / this.zoom);
    const yaw = this.orbitYaw;
    const pitch = this.orbitPitch;
    const cosP = Math.cos(pitch);
    const off = new THREE.Vector3(
      Math.sin(yaw) * cosP,
      Math.sin(pitch),
      Math.cos(yaw) * cosP
    );
    // Rebuild the offset from the preset direction, rotated by orbit.
    const baseDir = new THREE.Vector3().copy(this.camPos).sub(this.camTarget).normalize();
    const right = new THREE.Vector3().crossVectors(baseDir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const rotated = baseDir.clone()
      .add(right.multiplyScalar(Math.sin(yaw) * 0.9))
      .add(up.multiplyScalar(Math.sin(pitch) * 0.9))
      .normalize();
    const camPos = new THREE.Vector3().copy(this.camTarget).add(rotated.multiplyScalar(len));
    if (world && world.shake > 0) {
      const s = world.shake * 0.12;
      camPos.x += Math.sin(t * 47) * s;
      camPos.y += Math.cos(t * 53) * s;
    }
    this.camera.position.copy(camPos);
    this.camera.lookAt(this.camTarget);
    void off;
    void dir;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
