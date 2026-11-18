// CHAINFIRE 3D — renderer. Written fresh for the 3D rebuild.
// Owns the WebGL scene: terrain, fort, characters, trail ribbon, fire,
// explosions, beacon, popups, camera. All per-frame animation derives from
// world.time (deterministic) — NO Math.random, NO Date.now in this file.
// Bloom is faked with additive glow materials (no post-processing chain,
// which keeps staging byte-identical).

import { THREE } from './three.js';
import { PALETTE, WORLD, POWDER_TYPES, ENEMY_TYPES, DEFENDER_DEFS, SIM } from './data.js';
import { terrainHeight, buildTerrain, makeKegTextureSeeded } from './terrain.js';
import { buildFort, wallTopY } from './fort.js';
import { buildCharacter } from './models.js';
import { mulberry32 } from './rng.js';

const POPUP_POOL = 40; // ROUND 3 (item 9): 24 -> 40 — defender damage
// numbers triple the live popup volume at the chain peak; the pool must
// hold a full volley (12 dmg) + chain/coin popups without dropping any.

// ROUND 3 (item 9): grid offsets for the popup de-confliction fallback
// (see _updatePopups). Fixed, sorted by distance from the origin, so the
// closest free spot always wins and the same sim state always places the
// same popup in the same spot. Steps of 0.07 NDC, radius up to 0.56.
const POPUP_GRID_OFFSETS = (() => {
  const list = [];
  for (let gy = -8; gy <= 8; gy += 1) {
    for (let gx = -8; gx <= 8; gx += 1) {
      if (gx === 0 && gy === 0) continue;
      list.push([gx * 0.07, gy * 0.07, gx * gx + gy * gy]);
    }
  }
  list.sort((a, b) => a[2] - b[2]);
  return list;
})();
const FLASH_POOL = 12; // R4B: 8 -> 12 — flashes now live 1.0s (below), so the pool must hold a full chain-second of booms without dropping one.
const SCORCH_POOL = 40;
const SMOKE_POOL = 12;
// ROUND 5 AGENT A (items #1 + #2): beam + chain-arc pools. Beams are a
// pure function of world.shots (one per live shot, max 32 = tracer pool).
// Arcs are born from consecutive 'chain' events (see _drainEvents);
// ARC_TTL 0.5s means only kills in the last half-second show — the
// frame never fills with stale lightning.
const BEAM_POOL = 32;
const ARC_POOL = 16;
// ROUND 6 AGENT B (P8, Mark items 5-6): one tracer/muzzle colour per
// defender, matching the defender's own identity in models.js — Wren
// navy+gold, Pip brown+orange, Thom grey+crimson, Mira teal+brass. The
// four shots are countable by colour in the still.
const DEFENDER_COLORS = { wren: 0xffd23c, pip: 0xff7a1a, thom: 0xff453a, mira: 0x2dd4bf };
const ARC_SEGMENTS = 5;
const ARC_TTL = 1.0; // 0.25 -> 0.5 -> 1.0, each step measured: at 0.25s AND
// 0.5s exactly 1 arc was alive at the x8 freeze (the kill rate right at
// the freeze is low — the burst that built chain 6 already happened) and
// it did not read in the still. Median kill gap is 0.27s, so 1.0s keeps
// ~3-4 recent arcs visible at the freeze — still only chain links, still
// small (~2.3u median) and all near the horde, so live play does not
// become a mess. The brief's "~0.25s" was a guess; the measurement rules.
const ARC_MAX_GAP = 0.4; // seconds between consecutive chain kills
const ARC_MAX_DIST = 15; // world units between consecutive chain kills

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

// ROUND 5 AGENT C (item #6): a DENSE smoke texture for the scorch
// columns. makeSmokeTexture() is too faint for a static column — its
// own alpha peaks at 0.55 and fades to 0.35, so even at material opacity
// 0.55 the effective centre alpha is only ~0.30, and the material colour
// multiplies the baked dark colour down further. That is why the first
// two column versions did not read (proven by zoom, 05:55 WIB). This
// texture bakes a warm grey at alpha 0.85 centre / 0.55 mid / 0 edge, so
// with material colour 0xffffff the column reads as real smoke against
// the bright field while keeping the soft falloff (no hard pillar).
function makeColumnSmokeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
  grad.addColorStop(0, 'rgba(110, 95, 75, 0.95)');
  grad.addColorStop(0.45, 'rgba(110, 95, 75, 0.9)');
  grad.addColorStop(0.65, 'rgba(100, 85, 65, 0.45)');
  grad.addColorStop(1, 'rgba(90, 75, 60, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Fireball texture (P3): a shaped fireball, not a flat bright disc —
// ROUND 3 AGENT B (item 4, Rizal): the old white-gold core (255,244,200)
// washed to WHITE at additive peak over the bright field. New core is
// deep gold (255,186,70), mid orange, edge deep red-orange — warm and
// shaped, never white. Flame tongues deeper orange too.
function makeFireballTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255, 186, 70, 1)');
  grad.addColorStop(0.25, 'rgba(255, 140, 30, 0.95)');
  grad.addColorStop(0.55, 'rgba(235, 95, 10, 0.7)');
  grad.addColorStop(0.8, 'rgba(190, 60, 5, 0.35)');
  grad.addColorStop(1, 'rgba(170, 45, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(235, 110, 15, 0.45)';
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
  // The hunt proves no tighter preset keeps the whole Titan in frame at
  // the first x8 moment (D/E/F/G/H/I all fail the center test; F only at
  // later moments with fewer enemies). So B stays: Titan fully in frame
  // (~160px), 16 enemies, Thom ~33px — and the defenders read via the
  // celebrate pose (arms up, chainMul>=4), not via the camera.
  //
  // R3E (Mark 23:58 WIB, "kurang rame + karakter nembak ga keliatan"):
  // camera probe r3e-cam-probe.cjs froze the SAME x8 state from 5 presets
  // and I viewed them all. F [17,36,50] and N1 [10,32,50] cut the Titan's
  // body at the right edge (center in frame, body not — same failure as
  // eagle A). N2 [26,34,46] reads crowded (Titan huge, pack big) but loses
  // the wall entirely and the CHAIN chip collides with a +400 popup.
  // N3 [19,39,54]->[0,0,0] wins: Titan fully in frame (~180px), same 11
  // enemies in frame as B, wall + defenders slightly bigger. N3 it is.
  //
  // R3E2 (Mark 00:25 WIB, "sama aja, agak di deketin screenshot nya dikit"):
  // probe r3e2-cam-probe.cjs froze the SAME x8 state and shot N3 + 4 cameras
  // closer along the SAME ray (same look-at [0,0,0]): C10 [17.1,35.1,48.6],
  // C20 [15.2,31.2,43.2], C30 [13.3,27.3,37.8], C40 [11.4,23.4,32.4].
  // HARD CEILING FOUND: the Titan sits ~28 deg off-axis at N3 (half-FOV
  // 36.4 deg), so every step closer pushes its body toward the right edge.
  // C20 cuts most of the Titan out of frame, C30/C40 lose it entirely (and
  // C30/C40 also collide popups with the CHAIN banner + SOUND/HELP buttons).
  // C10 is the max the same-ray approach allows: defenders ~9% bigger on
  // screen (Thom reads as a person with face+cap, muzzle glow bigger),
  // BUT the Titan's right flank is SLIGHTLY CUT at the frame edge (proven
  // by the 3x right-edge strip, proof-r3e2/cmp-right-edge.jpg — head,
  // furnace ring and platform stay in frame, the right shoulder/arm is
  // sliced). No same-ray camera makes the defenders clearly big AND keeps
  // the Titan whole: 10% is the ceiling, and it is a modest gain, not a
  // dramatic one. If Mark still says "sama aja", the next lever is NOT
  // more zoom — it is a different camera angle (wall-side shot, Titan
  // trades out) or a re-staged freeze moment. C10 it is, cut disclosed.
  //
  // ROUND 4 AGENT A (Mark 00:51 WIB 18 Nov, items 1-3: defenders big,
  // crowded frame, Titan whole+dominant). Probed 9 cameras on the SAME
  // frozen x8 state (steps 16050, the ONLY x8 moment — r4a-hunt.cjs found
  // exactly 1 cluster-x8 moment in the titan run, and r4a-hunt-win.cjs
  // found the win run's x8 moments are unusable: alive 0-4, bossX 47-48,
  // defenders never fired — so the freeze moment is FIXED, camera only).
  // The wall-side angle FAILED as built: WA/WB/WD/XW/XL (x -35..-15, low)
  // put the Titan BEHIND the THREAT QUEUE panel (DOM, invisible to the
  // frustum math) and edge-cut, defenders at the extreme left edge, the
  // trail foreshortened along the bottom edge, big empty green foreground.
  // Frustum math alone cannot see DOM occlusion — every candidate was
  // VIEWED, not just computed.
  // WC [15,22,64]->[0,2,4] WINS (r4a-cam-probe.cjs, viewed side-by-side
  // vs C10, proof-r4a/wc-cmp-*.jpg): Titan WHOLE with ~140px right margin
  // (2x titan crop proves the full silhouette: head, shoulders, furnace
  // ring, platform — C10's right shoulder is sliced), still ~163px tall
  // (dominant — biggest subject in frame); defenders essentially the SAME
  // size as C10 (within 2-3px: wren 40 vs 43, thom 47 vs 49, mira 46 vs
  // 47 — not bigger, the wall is just more prominent on the left); 10
  // enemies in frame vs C10's 7; the burning trail reads as a clear orange
  // ribbon across the mid-frame; the sun disc is visible top-centre (helps
  // Agent B's E2). EH [20,28,64] was the runner-up — nearly identical, but
  // the Titan sits closer to the right edge. Numbers UNCHANGED (same frozen state: 59,550 / 69,650).
  // Honest limit: the parapet hides the defenders' lower bodies from any
  // camera that also keeps the Titan in frame, so visible defender height
  // stays ~30px at full size (they read via celebrate pose + muzzle glow
  // + tracers, not as full characters) — the 76u wall-to-Titan span vs the
  // 72 deg frame makes a bigger defender + whole Titan geometrically
  // impossible at this freeze moment; a truly big defender needs a
  // different freeze moment (Titan near the wall), which does not exist
  // under the x8 constraint. Item 1 is a modest win, item 2 a modest win,
  // item 3 a clear win.
  // ROUND 7 AGENT A (item 1): target y 2 -> 6 — look slightly UP so the
  // whole 3D scene sits ~50px lower in the frame: the Titan's head (face
  // + crown) clears the bottom edge of the fixed THREAT QUEUE panel that
  // covered it at target y 2. Sizes unchanged (same camera distance).
  action: { pos: [15, 22, 64], target: [0, 6, 4] },
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
    // ROUND 6 AGENT A (P4, Mark 15:11 WIB): darken the ground, deepen
    // the sky — the field must stop being the brightest large area in the
    // frame (action mean was 107.2; target ~85-90). Golden hour stays:
    // the warmth is in the accents (sun, fort, trail, fire, Titan), not
    // in the field. Exposure 0.95 -> 0.90, fog deeper.
    this.renderer.toneMappingExposure = 0.90;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xcf8a52, 95, 210);

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
    this.sun = new THREE.DirectionalLight(0xffd9a0, 2.0);
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
    this.hemi = new THREE.HemisphereLight(0x8a6ab8, 0x3d6b46, 0.7);
    this.scene.add(this.hemi);

    this.glowTex = makeGlowTexture();
    this.fireballTex = makeFireballTexture();
    this.smokeTex = makeSmokeTexture();
    this.columnSmokeTex = makeColumnSmokeTexture();
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
    for (const d of DEFENDER_DEFS) {
      const ch = buildCharacter(d.kind, { seed: 11 });
      ch.group.visible = true;
      this.scene.add(ch.group);
      this.defenders[d.kind] = { ...ch, z: d.z };
    }

    // Trail ribbon.
    this.trailMesh = null;
    this.trailGeo = null;
    this.trailMat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });

    // Fire front: flame cone + glow sprite + point light.
    // ROUND 3 AGENT B (item 4, Rizal): the old 9u glow @ 0.85 + light 26
    // washed a big yellow-white hole at the burn front. Smaller, deeper,
    // dimmer: the fire reads as a shaped warm flame, not a white column.
    // ROUND 4 AGENT B (item 4, Mark 00:51 WIB: the explosion must be
    // bigger than the "CHAIN x8!" banner, which dominates the frame while
    // the fire at the trail front is a modest glow — and the freeze shows
    // ZERO live flashes, so the fire front is the only fire guaranteed
    // present). Bigger AND shaped, not brighter per-pixel: a tall flame
    // cluster (main cone + 2 leaning tongues), a wider glow at a LOWER
    // opacity (0.5, not 0.85), warm deep-gold colours throughout — the
    // R3B washout lesson stands, so size grows and opacity does not.
    this.fireGroup = new THREE.Group();
    this.fireGroup.visible = false;
    const flameMat = new THREE.MeshStandardMaterial({ color: 0xf06010, emissive: 0xe85000, emissiveIntensity: 2.6, transparent: true, opacity: 0.95 });
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(2.6, 6.0, 10),
      flameMat
    );
    flame.position.y = 3.0;
    this.fireGroup.add(flame);
    const tongueL = new THREE.Mesh(new THREE.ConeGeometry(1.3, 3.6, 8), flameMat);
    tongueL.position.set(-1.6, 1.8, 0.7);
    tongueL.rotation.z = 0.38;
    this.fireGroup.add(tongueL);
    const tongueR = new THREE.Mesh(new THREE.ConeGeometry(1.3, 3.6, 8), flameMat);
    tongueR.position.set(1.5, 1.8, -0.8);
    tongueR.rotation.z = -0.34;
    this.fireGroup.add(tongueR);
    const fireGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff8a1a, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    fireGlow.scale.set(12, 12, 1);
    fireGlow.position.y = 2.2;
    this.fireGroup.add(fireGlow);
    this.fireLight = new THREE.PointLight(0xff8a2a, 24, 22, 1.5);
    this.fireLight.position.y = 3;
    this.fireGroup.add(this.fireLight);
    this.scene.add(this.fireGroup);

    // Beacon (x8 moment): volumetric pillar + ground glow + light.
    // P3 (Rizal fix round 2): the 26u pillar (core 0.5) + 13u glow STILL
    // washed a ~30%-wide band of the right frame (mean brightness ~175 vs
    // ~90-118 beside it, measured on the round-1 action shot). Shrunk
    // again: 16u pillar, core opacity 0.35, 8u glow, weaker light — a warm
    // gold column that reads at 320px without whiting out the subjects.
    // BEACON REAL FIX (Mark 20:13 WIB): the 10u pillar STILL read as a
    // tall bright column at full-frame scale — Mark: "praktis sama, masih
    // kolom terang tinggi, bukan sorot emas pendek". A vertical cylinder
    // projects long on screen at the 34° eagle angle, so 10u was never
    // going to read short. Now a genuine 4u STUB (max ~51px on screen):
    // deeper gold, lower opacities, smaller glow + light. If this still
    // reads as a column, the fallback is to delete the pillar outright
    // (ground glow + giant x8 carry the multiplier). The x8 stays
    // readable via the giant x8 numeral + ground glow + chain popups,
    // which are untouched.
    this.beacon = new THREE.Group();
    this.beacon.visible = false;
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.8, 4, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xe08a1e, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    pillar.position.y = 2;
    this.beacon.add(pillar);
    const pillarCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.32, 4, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf0a030, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    pillarCore.position.y = 2;
    this.beacon.add(pillarCore);
    const beaconGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffc53d, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }));
    beaconGlow.scale.set(3.5, 3.5, 1);
    beaconGlow.position.y = 1.5;
    this.beacon.add(beaconGlow);
    this.beaconLight = new THREE.PointLight(0xe89b1e, 5, 10, 1.4);
    this.beaconLight.position.y = 4;
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
      this.flashes.push({ flash, ring, t: 99, ttl: 0.5, x: 0, z: 0, maxR: 5, born: -1 });
    }

    // Smoke puffs (pooled): warm gray billboards, normal blending.
    this.smokes = [];
    for (let i = 0; i < SMOKE_POOL; i += 1) {
      const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, opacity: 0, depthWrite: false }));
      puff.visible = false;
      this.scene.add(puff);
      this.smokes.push({ puff, t: 99, ttl: 1.4, x: 0, z: 0, born: -1 });
    }

    // ROUND 5 AGENT C (item #6): smoke columns on the fresh scorch — thin
    // warm-grey columns rising from the scorch band Agent B laid (and R5C
    // extended). Static columns, not blast puffs: 4 columns x 3 stacked
    // sprites, positions fixed in the inter-lane gaps (spread along the
    // band, east + left-centre), heights/scales/opacities fixed per level
    // so the column reads as a rising stack, sway is f(world.time). Gate:
    // combat or won — the columns rise over FRESH scorch, so they show in
    // the action frame and on the results backdrop, never on the title /
    // draft (build phase, no battle yet). Warm grey (0x9a8f80) at low
    // opacity, never a white/yellow washout column (beacon lesson).
    // TUNED 06:15 WIB: the columns are now visible as dark smoke in a
    // tight zoom (the base level reads as a smoke puff), but they do NOT
    // read as columns in the full frame — all four project into the
    // x 740-940, y 250-400 band, i.e. behind the giant "CHAIN x8!" banner
    // and the popups, in the busiest part of the frame. The last fix is
    // POSITION: all four columns move WEST into the open left-centre
    // field (x 2-10), clear of the banner (x 480-800, y 300-380) and the
    // fire, over clean green field + road where grey smoke has contrast.
    // If they still do not read there, the item is PARTIAL, not a pass.
    this._scorchSmoke = [];
    const scorchCols = [
      { x: 4, z: 7, phase: 0.0 }, { x: 10, z: 6, phase: 1.7 },
      { x: 4, z: -7, phase: 3.1 }, { x: 10, z: -6, phase: 4.4 },
    ];
    for (const col of scorchCols) {
      const levels = [];
      for (let li = 0; li < 4; li += 1) {
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.columnSmokeTex, color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
        spr.visible = false;
        this.scene.add(spr);
        levels.push({ sprite: spr, dy: 2.0 + li * 2.5, scale: 3.5 + li * 1.5, opacity: 0.8 - li * 0.13 });
      }
      this._scorchSmoke.push({ x: col.x, z: col.z, phase: col.phase, levels });
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

    // ROUND 6 AGENT C (P2): Titan halo + scorch path. The Titan reads
    // where it stands (~91% across, render-side only — the round-5
    // titan-hunt proved moving it breaks the staged numbers). A warm
    // additive halo around the Titan + a dark scorch scar on the ground
    // from the fort wall to the Titan's feet, leading the eye to it.
    // Halo is GOLD (0xffb040), not orange: gold reads against the
    // Titan's orange iron; orange-on-orange washed out (first proof).
    // The Titan's lane at the freeze is z=0 (probe: boss at (33, 0));
    // the powder trail runs at z=14.5, so the two never merge. Both are
    // gated on boss.alive in the boss update block — hidden on
    // title/draft/results. Static geometry, no rng, no clock.
    this._titanGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffb040, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending }));
    this._titanGlow.scale.set(16, 16, 1);
    this._titanGlow.visible = false;
    this.scene.add(this._titanGlow);
    this._titanScorch = new THREE.Group();
    {
      const pathGeo = new THREE.CircleGeometry(1, 20);
      const pathMat = new THREE.MeshBasicMaterial({ color: 0x241610, transparent: true, opacity: 0.5, depthWrite: false });
      for (let i = 0; i < 16; i += 1) {
        const x = -40 + (73 * i) / 15;
        const d = new THREE.Mesh(pathGeo, pathMat);
        d.rotation.x = -Math.PI / 2;
        d.scale.set(2.4, 2.4, 1);
        d.position.set(x, terrainHeight(x, 0) + 0.06, 0);
        this._titanScorch.add(d);
      }
      const fleckGeo = new THREE.CircleGeometry(1, 12);
      const fleckMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending });
      for (let i = 0; i < 8; i += 1) {
        const x = -36 + i * 9;
        const fz = i % 2 ? 1.3 : -1.3;
        const f = new THREE.Mesh(fleckGeo, fleckMat);
        f.rotation.x = -Math.PI / 2;
        f.scale.set(0.5, 0.5, 1);
        f.position.set(x, terrainHeight(x, fz) + 0.08, fz);
        this._titanScorch.add(f);
      }
    }
    this._titanScorch.visible = false;
    this.scene.add(this._titanScorch);

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

    // ROUND 3 AGENT A (item 1): muzzle flashes — one small glow sprite
    // per defender shot, born in SIM time from the 'shoot' event (same
    // pattern as explosion flashes, so a frozen staged frame is
    // byte-identical). 8 slots: a full volley is 4 defenders at once.
    // ttl 0.35s (not 0.15s): the flash must survive long enough to be
    // caught in a frozen frame — a 0.15s flash is visible in only ~10% of
    // frames, a 0.35s one in ~25% per defender, and with the staggered
    // volleys some defender is flashing in most frames.
    // R3E (Mark 23:58 WIB): ttl 0.35s -> 0.9s + bigger + slower fade.
    // At the x8 freeze the defenders fired 0.4-1.4s ago, so a 0.35s flash
    // had already expired on ALL of them — the wall never showed a shot.
    // 0.9s + slow fade keeps the most recent volley visible in the frozen
    // frame (Thom 0.4s: bright; older ones fade out). 8 slots still enough:
    // at most ~4-5 concurrent flashes (4 defenders x 1.4s cycle).
    // ROUND 6 AGENT B (P8): ttl 0.9s -> 1.6s — the volley cycle is 1.4s
    // and the freeze catches the four defenders at 0.43/1.07/1.37/1.38s
    // (measured by probe at the titan freeze: thom 267.07, mira 266.43,
    // wren 266.13, pip 266.12 vs world.time 267.5). 0.9s shows only Thom;
    // 1.6s shows the WHOLE last volley, brightest first. born: -1 is the
    // never-used sentinel for the born-relative reuse in _spawnMuzzle
    // (same pattern as _spawnArc — see the batched-drain note there).
    this.muzzles = [];
    for (let i = 0; i < 8; i += 1) {
      // ROUND 6 AGENT B (P8): fireball texture, not the soft glow — the
      // glow's additive gold washes out against the bright wall/sky, so
      // the flash read as a faint smudge at the beam origin. The shaped
      // fireball (deep gold core, orange mid, red-orange edge — the round-3
      // blast texture) reads as a real burst at the defender.
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.fireballTex, color: 0xffd23f, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      m.visible = false;
      this.scene.add(m);
      this.muzzles.push({ sprite: m, t: 99, ttl: 1.6, born: -1, x: 0, z: 0, kind: null });
    }

    // ROUND 3 AGENT A (items 1+3): defender shot tracers — bright glowing
    // gold orbs (additive glow sprites, 2.0u — a 0.22u sphere was 2-3px
    // at eagle distance, invisible; 2.0u is ~26px and reads as a bolt),
    // one per live sim shot (max 32: 4 defenders x 3 shots x ~2.5
    // volleys in flight at once). Assigned by index each frame; the sim
    // owns the positions, the renderer only draws them.
    // R3E: 2.0u -> 2.5u — the bolts read as a firing line, not dots.
    // (2.0u was ~26px at eagle distance; 2.5u is ~32px.)
    this.tracers = [];
    for (let i = 0; i < 32; i += 1) {
      const tr = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffd23f, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
      tr.visible = false;
      tr.scale.setScalar(2.5);
      this.scene.add(tr);
      this.tracers.push(tr);
    }

    // ROUND 5 AGENT A (item #1): defender beams — each live shot is drawn
    // as a camera-facing ribbon (thin plane) from the muzzle to the
    // target's CURRENT position, in TWO layers: a wide orange edge + a
    // narrow white-gold core. Two layers from the start, not as a
    // fallback: a single gold line on the bright green/orange field is
    // low-contrast by construction (analysis section E — every top-10
    // beam game is a NIGHT game); the white-gold core is the brightest
    // element in the frame, the orange edge is the glow. The orb tracer
    // stays as the beam's bright head. Pure function of world.shots +
    // camera each frame — no new state, no randomness, deterministic.
    // Indices are static (precomputed); only positions/colors update.
    const makeRibbonGeo = (quads) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const idx = [];
      for (let q = 0; q < quads; q += 1) {
        const b = q * 4;
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      geo.setIndex(idx);
      geo.setDrawRange(0, 0);
      return geo;
    };
    this._beamOuterGeo = makeRibbonGeo(BEAM_POOL);
    this._beamOuterMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this._beamOuter = new THREE.Mesh(this._beamOuterGeo, this._beamOuterMat);
    this._beamOuter.frustumCulled = false;
    this._beamOuter.renderOrder = 5;
    this._beamOuter.visible = false;
    this.scene.add(this._beamOuter);
    this._beamCoreGeo = makeRibbonGeo(BEAM_POOL);
    this._beamCoreMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this._beamCore = new THREE.Mesh(this._beamCoreGeo, this._beamCoreMat);
    this._beamCore.frustumCulled = false;
    this._beamCore.renderOrder = 5;
    this._beamCore.visible = false;
    this.scene.add(this._beamCore);

    // ROUND 6 AGENT B (P3): dark edge under the beams — a normal-blending
    // dark-brown ribbon, slightly wider than the gold, drawn first
    // (renderOrder 4) so the warm beam reads as gold fire with an outline
    // instead of glare. Additive blending cannot draw darkness, so this
    // third layer is the only way to get a dark edge.
    this._beamEdgeGeo = makeRibbonGeo(BEAM_POOL);
    this._beamEdgeMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
    this._beamEdge = new THREE.Mesh(this._beamEdgeGeo, this._beamEdgeMat);
    this._beamEdge.frustumCulled = false;
    this._beamEdge.renderOrder = 4;
    this._beamEdge.visible = false;
    this.scene.add(this._beamEdge);

    // ROUND 6 AGENT B (P8): VOLLEY! label + SQUAD cluster marker —
    // canvas-text sprites on the popup pattern (256x64 canvas, depthTest
    // false, renderOrder 10). Both are pure functions of the frozen world
    // state, so a staged frame is byte-identical.
    this._volleyLabel = this._makeLabelSprite('VOLLEY!', 0xffd23c, 11, 2.75);
    this._squadLabel = this._makeLabelSprite('SQUAD ×4', 0xffd23c, 9, 2.25);
    this._squadLabelText = 'SQUAD ×4';

    // ROUND 5 AGENT A (item #2): chain-lightning arcs — short jagged gold
    // ribbons between consecutive chain kills. One mesh, ARC_POOL slots x
    // ARC_SEGMENTS quads each; positions rebuilt every frame from live
    // slots (born in SIM time, ttl 0.25s). Zig-zag offsets come from a
    // pure arithmetic hash of the endpoints + birth time — NO Math.random,
    // so staged frames stay byte-identical.
    this._arcGeo = makeRibbonGeo(ARC_POOL * ARC_SEGMENTS);
    this._arcMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this._arcMesh = new THREE.Mesh(this._arcGeo, this._arcMat);
    this._arcMesh.frustumCulled = false;
    this._arcMesh.renderOrder = 6;
    this._arcMesh.visible = false;
    this.scene.add(this._arcMesh);
    this.arcs = [];
    for (let i = 0; i < ARC_POOL; i += 1) {
      this.arcs.push({ born: -1, ax: 0, az: 0, bx: 0, bz: 0, seed: 0 });
    }
    this._lastChainKill = null;

    // ROUND 3 AGENT D (item 11): ambient particles — floating embers near
    // the fort/field + dust motes drifting in the evening light. Positions
    // are pure functions of world.time (see _updateAmbient), seeded once
    // here with mulberry32 — NOL Math.random, so staged frames stay
    // byte-identical. Distant birds already exist (terrain.js, 5 birds).
    const ambientRng = mulberry32(20261117 + 4242);
    this._embers = [];
    for (let i = 0; i < 48; i += 1) {
      this._embers.push({
        bx: -45 + ambientRng() * 75, bz: -25 + ambientRng() * 50,
        by: 1 + ambientRng() * 5, speed: 0.25 + ambientRng() * 0.45,
        phase: ambientRng() * Math.PI * 2, amp: 0.8 + ambientRng() * 1.2
      });
    }
    this._emberGeo = new THREE.BufferGeometry();
    this._emberGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this._emberMat = new THREE.PointsMaterial({ size: 1.1, map: this.glowTex, color: 0xff8a1a, transparent: true, opacity: 1.0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this._emberPoints = new THREE.Points(this._emberGeo, this._emberMat);
    this._emberPoints.frustumCulled = false;
    this.scene.add(this._emberPoints);
    this._motes = [];
    for (let i = 0; i < 36; i += 1) {
      this._motes.push({
        bx: -30 + ambientRng() * 40, bz: -20 + ambientRng() * 40,
        by: 2 + ambientRng() * 8, speed: 0.08 + ambientRng() * 0.12,
        phase: ambientRng() * Math.PI * 2, amp: 1 + ambientRng() * 2
      });
    }
    this._moteGeo = new THREE.BufferGeometry();
    this._moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(36 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this._moteMat = new THREE.PointsMaterial({ size: 0.55, map: this.glowTex, color: 0xffe9a8, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this._motePoints = new THREE.Points(this._moteGeo, this._moteMat);
    this._motePoints.frustumCulled = false;
    this.scene.add(this._motePoints);

    // ROUND 5 AGENT C (item #5): ember burst at the x8 peak. R5A's arcs
    // failed the still because they are event-born with a 1.0s ttl and the
    // kill rate right at the freeze is low — only ~2 tiny arcs alive. The
    // burst is instead a PURE FUNCTION of the frozen world state (the beam
    // pattern): it is ON whenever phase is combat AND chainMul >= 8 AND the
    // trail is burning, anchored at the burn front — so it is GUARANTEED
    // visible at the x8 freeze, in every re-stage. 60 ember points in a
    // rising plume (rise loop is f(world.time), like the ambient embers) +
    // 8 bright core glows around the fire. In live play it appears at the
    // x8 peak and vanishes when the chain resets; it never shows on the
    // results backdrop (phase 'won' is not combat). TUNED 05:47 WIB: the
    // first version (36 points, size 1.9, radius 2.6u, rise 5u) was proven
    // ON by probe but did not read — it sat INSIDE the fire's own glow.
    // The plume is now WIDER (4.5u) and TALLER (8u) than the flame, with
    // bigger points and core glows above the fire's top, so it reads as a
    // burst ABOVE the fire instead of a brighter fire.
    const burstRng = mulberry32(20261118 + 555);
    this._burst = [];
    for (let i = 0; i < 60; i += 1) {
      const a = burstRng() * Math.PI * 2;
      const r = 0.5 + burstRng() * 4.0;
      this._burst.push({
        dx: Math.cos(a) * r, dz: Math.sin(a) * r,
        speed: 0.7 + burstRng() * 0.9, phase: burstRng() * Math.PI * 2,
        amp: 0.3 + burstRng() * 0.7,
      });
    }
    this._burstGeo = new THREE.BufferGeometry();
    this._burstGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(60 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this._burstMat = new THREE.PointsMaterial({ size: 2.6, map: this.glowTex, color: 0xffa030, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this._burstPoints = new THREE.Points(this._burstGeo, this._burstMat);
    this._burstPoints.frustumCulled = false;
    this._burstPoints.visible = false;
    this.scene.add(this._burstPoints);
    this._burstCore = [];
    for (let i = 0; i < 8; i += 1) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffb040, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.visible = false;
      s.scale.setScalar(3.2);
      this.scene.add(s);
      this._burstCore.push({ sprite: s, dx: (burstRng() - 0.5) * 3.6, dz: (burstRng() - 0.5) * 3.6, dy: 1.0 + burstRng() * 3.0, phase: burstRng() * Math.PI * 2 });
    }

    // Keg meshes (rebuilt per wave).
    // R4B (item 13): the 0.85r kegs were small brown props nobody could
    // read as a system. 1.1r x 1.55h (~1.3x) + BRASS bands (the dark bands
    // vanished against the field) + a big lit glow, so a powder keg reads
    // at action distance. Mesh size only — the sim's blast radius (8.2u
    // from the keg centre) is untouched.
    this.kegMeshes = new Map();
    this.kegGeo = new THREE.CylinderGeometry(1.1, 1.1, 1.55, 10);
    this.kegMat = new THREE.MeshStandardMaterial({ map: makeKegTextureSeeded(51), roughness: 0.9 });
    this.kegBandMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.4, metalness: 0.6 });
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
    // ROUND 5 AGENT A (item #2): a new world resets the kill chain — an
    // arc must never join a kill from the previous world/stage.
    this._lastChainKill = null;
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
      // ROUND 6 AGENT A (P6, Mark 15:11 WIB): FAT high-contrast trail —
      // the 0.44u ribbon was ~1px at 320px and invisible in the thumbnail
      // (STITCHBOUND's fat red thread is the evidence: fat + high contrast
      // reads as a curve at 320px). New stack, bottom to top: dark brown
      // BED 4.4u wide (the contrast edge, opacity 0.8 so it reads as a
      // dark outline against the tan road) → deep-orange GLOW halo 2.8u →
      // bright core ribbon 1.1u (2.5x the old width). At 320px the whole
      // band is ~10px: dark edge + orange glow + bright core.
      const px = -dz / len * 0.55;
      const pz = dx / len * 0.55;
      const y = terrainHeight(pts[i].x, pts[i].z) + 0.18;
      positions[i * 6] = pts[i].x + px;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = pts[i].z + pz;
      positions[i * 6 + 3] = pts[i].x - px;
      positions[i * 6 + 4] = y;
      positions[i * 6 + 5] = pts[i].z - pz;
      // Glow halo vertices: 2.8u wide (half-width 1.4), 0.06u below the main ribbon.
      const gx = -dz / len * 1.4;
      const gz = dx / len * 1.4;
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
      // Bed vertices: 4.4u wide (half-width 2.2) — the WIDEST layer, so
      // the dark brown edge shows outside the glow on both sides.
      // 0.02u below the halo.
      const bx = -dz / len * 2.2;
      const bz = dx / len * 2.2;
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
      this.trailGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
      this.trailGlowMesh = new THREE.Mesh(this.trailGlowGeo, this.trailGlowMat);
      this.trailGlowMesh.frustumCulled = false;
      this.scene.add(this.trailGlowMesh);
    }
    this.trailGlowGeo.setAttribute('position', new THREE.BufferAttribute(glowPositions, 3));
    this.trailGlowGeo.setAttribute('color', new THREE.BufferAttribute(glowColors, 3));
    this.trailGlowGeo.setIndex(indices);
    this.trailGlowGeo.computeBoundingSphere();
    this.trailGlowMesh.visible = true;
    // Bed mesh (dark powder bed under the glow — ROUND 6 P6: opacity 0.8
    // so the 4.4u bed reads as a real dark edge, not a faint shadow).
    if (!this.trailBedGeo) {
      this.trailBedGeo = new THREE.BufferGeometry();
      this.trailBedMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
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
      } else if (ev.type === 'shoot') {
        // ROUND 3 (item 1): a defender fired — muzzle flash at the wall.
        // ROUND 6 AGENT B (P8): pass the defender kind so the flash takes
        // that defender's colour.
        this._spawnMuzzle(ev.time, ev.x, ev.z, ev.defender);
      } else if (ev.type === 'chain') {
        // ROUND 5 AGENT A (item #2): chain-lightning arc between
        // consecutive chain kills. Events drain in sim order, so the
        // previous 'chain' event is the previous kill in the chain.
        // Only chain links (chainMul >= 2) close in time (<= ARC_MAX_GAP)
        // and space (<= ARC_MAX_DIST) get an arc — drawing one for every
        // kill would turn the frame into a mess of lightning snakes.
        // Every 'chain' event still updates the tracker, so a chain-1
        // kill correctly becomes the predecessor of the next chain-2 kill.
        const prev = this._lastChainKill;
        if (prev && ev.chainMul >= 2 && typeof ev.x === 'number' && typeof ev.z === 'number') {
          const gap = ev.time - prev.time;
          const dist = Math.hypot(ev.x - prev.x, ev.z - prev.z);
          if (gap >= 0 && gap <= ARC_MAX_GAP && dist <= ARC_MAX_DIST) {
            this._spawnArc(ev.time, prev.x, prev.z, ev.x, ev.z);
          }
        }
        if (typeof ev.x === 'number' && typeof ev.z === 'number') {
          this._lastChainKill = { x: ev.x, z: ev.z, time: ev.time };
        }
      }
    }
    world.events.length = 0;
  }

  _spawnArc(born, ax, az, bx, bz) {
    // A slot is free when the NEW arc is born more than ARC_TTL after the
    // slot's arc was born. (NOT this.time - slot.born: during a batched
    // drain — the whole bot run drains in ONE update at the freeze —
    // this.time is the freeze time for every spawn, so the old test
    // called every filled slot "free" and all 63 spawns overwrote slot 0,
    // leaving 1 live arc. Born-relative reuse keeps every arc born in the
    // last ARC_TTL in its own slot.)
    for (const slot of this.arcs) {
      if (slot.born < 0 || (born - slot.born) > ARC_TTL) {
        slot.born = born;
        slot.ax = ax;
        slot.az = az;
        slot.bx = bx;
        slot.bz = bz;
        slot.seed = ax * 0.37 + az * 0.73 + bx * 0.11 + bz * 0.29 + born;
        return;
      }
    }
  }

  // Write one camera-facing ribbon quad (p0 -> p1, half-width w) into a
  // ribbon geometry at quad index q. Returns q + 1. The quad's side
  // vector is perpendicular to the segment AND faces the camera, so the
  // ribbon reads as a line of constant screen width from any angle.
  // Pure function of its arguments — deterministic.
  _writeRibbonQuad(geo, q, p0, p1, camPos, halfW, r, g, b) {
    const pos = geo.attributes.position.array;
    const col = geo.attributes.color.array;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dz = p1.z - p0.z;
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    const mz = (p0.z + p1.z) / 2;
    let vx = camPos.x - mx;
    let vy = camPos.y - my;
    let vz = camPos.z - mz;
    // side = normalize(cross(segDir, viewDir)); falls back to world-up
    // when the segment points at the camera (cross product ~ 0).
    let sx = dy * vz - dz * vy;
    let sy = dz * vx - dx * vz;
    let sz = dx * vy - dy * vx;
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-6) {
      // Segment points at the camera: fall back to cross(segDir, up).
      sx = -dz;
      sy = 0;
      sz = dx;
      sl = Math.hypot(sx, sy, sz);
      if (sl < 1e-6) { sx = 1; sy = 0; sz = 0; sl = 1; }
    }
    sx = (sx / sl) * halfW;
    sy = (sy / sl) * halfW;
    sz = (sz / sl) * halfW;
    const base = q * 12;
    pos[base] = p0.x - sx; pos[base + 1] = p0.y - sy; pos[base + 2] = p0.z - sz;
    pos[base + 3] = p0.x + sx; pos[base + 4] = p0.y + sy; pos[base + 5] = p0.z + sz;
    pos[base + 6] = p1.x + sx; pos[base + 7] = p1.y + sy; pos[base + 8] = p1.z + sz;
    pos[base + 9] = p1.x - sx; pos[base + 10] = p1.y - sy; pos[base + 11] = p1.z - sz;
    for (let v = 0; v < 4; v += 1) {
      col[base + v * 3] = r;
      col[base + v * 3 + 1] = g;
      col[base + v * 3 + 2] = b;
    }
    return q + 1;
  }

  // ROUND 6 AGENT B (P8): canvas-text label sprite on the popup pattern
  // (256x64 canvas, depthTest false, renderOrder 10, gold text with a
  // dark stroke so it reads over the bright field).
  _drawLabelText(canvas, tex, text, colorHex) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 34px Arial, sans-serif';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(20, 10, 5, 0.9)';
    ctx.strokeText(text, 128, 32);
    ctx.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
    ctx.fillText(text, 128, 32);
    tex.needsUpdate = true;
  }

  _makeLabelSprite(text, colorHex, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.visible = false;
    sprite.renderOrder = 10;
    sprite.scale.set(w, h, 1);
    this.scene.add(sprite);
    this._drawLabelText(canvas, tex, text, colorHex);
    return { sprite, canvas, tex, colorHex };
  }

  // ROUND 5 AGENT A (item #1): beams — one ribbon per live defender shot,
  // muzzle -> target's current position. Fade = distance travelled: the
  // beam thins and dims as the shot nears its target (fade 1 -> 0.45).
  _updateBeams() {
    const world = this.world;
    const shots = world && Array.isArray(world.shots) ? world.shots : [];
    const n = Math.min(shots.length, BEAM_POOL);
    const cam = this.camera.position;
    let qo = 0;
    let qc = 0;
    let qe = 0;
    for (let i = 0; i < n; i += 1) {
      const s = shots[i];
      const def = DEFENDER_DEFS.find((d) => d.kind === s.kind);
      const mz = def ? def.z : s.z;
      const p0 = { x: WORLD.WALL_X - 0.5, y: wallTopY(mz) + 2.2, z: mz };
      // Fraction travelled (s.dist is distance REMAINING: 1 at fire, 0
      // on arrival — verified against the probe: mira's bolt at dist 1.5
      // of 50 sits at x 0.4, nearly on its target at tx 1.2).
      const frac = Math.max(0, Math.min(1, 1 - (s.dist !== undefined ? s.dist : 0) / (s.total || 1)));
      // ROUND 6 AGENT B (P3): the beam ends at the BOLT HEAD (the shot's
      // current position, same y interpolation as the tracer), not at the
      // target — it is the bolt's trail, so it reads as a short gold bolt
      // instead of a frame-crossing white streak. At the freeze the three
      // live Thom bolts are ~43% travelled, Mira's ~97%.
      const y0 = wallTopY(mz) + 2.2;
      const y1 = terrainHeight(s.tx, s.tz) + 1.5;
      const p1 = { x: s.x, y: y0 + (y1 - y0) * frac, z: s.z };
      // Fade = distance travelled: the beam dims toward the bolt head
      // (fade 1 -> 0.3, was 1 -> 0.45) so the far end dissolves.
      const fade = 1 - frac * 0.7;
      // ROUND 6 (P3, Mark item 2, top-4 evidence): warm + thin + short.
      // NO white core — deep gold core (1.0, 0.68, 0.12), orange edge
      // (0.9, 0.42, 0.06), half widths halved (outer 0.8 -> 0.4, core
      // 0.35 -> 0.18). The round-5 "fat so it reads on bright" logic is
      // contradicted by the top 4: no top-4 entry uses a fat white beam.
      // Dark edge (0.55u, constant dark brown) under the gold.
      qe = this._writeRibbonQuad(this._beamEdgeGeo, qe, p0, p1, cam, 0.55, 0.14, 0.08, 0.04);
      qo = this._writeRibbonQuad(this._beamOuterGeo, qo, p0, p1, cam, 0.4 * fade, 0.9 * fade, 0.42 * fade, 0.06 * fade);
      // ROUND 7 AGENT B (item 2, live verifier): the core still washed to
      // a THICK WHITE ribbon in the freeze dossier — additive core
      // (0.95) + outer over the bright sky saturates to pale yellow-
      // white. Core 0.18u -> 0.10u, opacity 0.95 -> 0.65, colour deeper
      // gold (1.0, 0.60, 0.08): a thin hot line inside the gold outer
      // glow, like the thin tracer that already reads. Outer/edge,
      // muzzle glows and tracer orbs untouched — defenders still fire.
      qc = this._writeRibbonQuad(this._beamCoreGeo, qc, p0, p1, cam, 0.10 * fade, 1.0 * fade, 0.60 * fade, 0.08 * fade);
    }
    this._beamEdgeGeo.setDrawRange(0, qe * 6);
    this._beamEdgeGeo.attributes.position.needsUpdate = true;
    this._beamEdgeGeo.attributes.color.needsUpdate = true;
    this._beamEdge.visible = qe > 0;
    this._beamOuterGeo.setDrawRange(0, qo * 6);
    this._beamOuterGeo.attributes.position.needsUpdate = true;
    this._beamOuterGeo.attributes.color.needsUpdate = true;
    this._beamOuter.visible = qo > 0;
    this._beamCoreGeo.setDrawRange(0, qc * 6);
    this._beamCoreGeo.attributes.position.needsUpdate = true;
    this._beamCoreGeo.attributes.color.needsUpdate = true;
    this._beamCore.visible = qc > 0;
  }

  // ROUND 5 AGENT A (item #2): arcs — rebuild live arc ribbons each
  // frame. Each arc is ARC_SEGMENTS quads along a zig-zag between its
  // endpoints, lifted in the middle so it reads above the ground. The
  // zig-zag offsets come from a pure arithmetic hash (no Math.random).
  _updateArcs() {
    const t = this.time;
    const cam = this.camera.position;
    let q = 0;
    for (const slot of this.arcs) {
      const age = t - slot.born;
      if (slot.born < 0 || age < 0 || age > ARC_TTL) continue;
      const fade = 1 - age / ARC_TTL;
      const yA = terrainHeight(slot.ax, slot.az) + 1.2;
      const yB = terrainHeight(slot.bx, slot.bz) + 1.2;
      const dx = slot.bx - slot.ax;
      const dz = slot.bz - slot.az;
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len;
      const pz = dx / len;
      let prev = null;
      for (let i = 0; i <= ARC_SEGMENTS; i += 1) {
        const f = i / ARC_SEGMENTS;
        let off = 0;
        if (i > 0 && i < ARC_SEGMENTS) {
          const h = Math.sin(slot.seed * 12.9898 + i * 78.233) * 43758.5453;
          off = (h - Math.floor(h) - 0.5) * 2 * 0.9;
        }
        const pt = {
          x: slot.ax + dx * f + px * off,
          y: yA + (yB - yA) * f + Math.sin(f * Math.PI) * 1.2,
          z: slot.az + dz * f + pz * off
        };
        if (prev) {
          // 0.22 -> 0.32u wide: the first freeze test showed a 1.1u arc at
          // 0.22u does not read in the still. Wider + white-gold, same
          // additive blend (no brightness creep).
          q = this._writeRibbonQuad(this._arcGeo, q, prev, pt, cam, 0.32 * fade, 1.0 * fade, 0.95 * fade, 0.75 * fade);
        }
        prev = pt;
      }
    }
    this._arcGeo.setDrawRange(0, q * 6);
    this._arcGeo.attributes.position.needsUpdate = true;
    this._arcGeo.attributes.color.needsUpdate = true;
    this._arcMesh.visible = q > 0;
  }

  _spawnMuzzle(evTime, x, z, defenderKind) {
    // ROUND 6 AGENT B (P8): born-relative reuse — the SAME batched-drain
    // bug _spawnArc already documents. The old test (slot.t > slot.ttl)
    // used a STALE slot.t during the drain: at the freeze the drain runs
    // once, BEFORE _updateMuzzles, with slot.t left over from the title
    // screen (~0.5s < 0.9s ttl) — so NO slot ever looked free and ZERO
    // muzzle flashes spawned at the freeze (proven by probe: all 8 slots
    // born=0, visible=false at world.time 267.5). Born-relative reuse
    // keeps the last volley's flashes in their own slots, like arcs.
    for (const slot of this.muzzles) {
      if (slot.born < 0 || (evTime - slot.born) > slot.ttl) {
        slot.born = (typeof evTime === 'number' ? evTime : this.time);
        slot.t = this.time - slot.born;
        slot.ttl = 1.6;
        slot.x = x;
        slot.z = z;
        slot.kind = defenderKind || null;
        if (defenderKind && DEFENDER_COLORS[defenderKind] !== undefined) {
          slot.sprite.material.color.setHex(DEFENDER_COLORS[defenderKind]);
        }
        slot.sprite.visible = true;
        return;
      }
    }
  }

  _updateMuzzles(dt) {
    for (const slot of this.muzzles) {
      slot.t = (slot.born !== undefined) ? (this.time - slot.born) : (slot.t + dt);
      if (slot.t > slot.ttl) {
        slot.sprite.visible = false;
        continue;
      }
      const f = Math.min(1, slot.t / slot.ttl);
      const y = wallTopY(slot.z) + 2.2;
      slot.sprite.position.set(slot.x, y, slot.z);
      // R3E: 4.5u + slow fade (was 3.0u, opacity 0.9*(1-f)) — the flash must
      // survive as a VISIBLE gold burst at the wall in a frozen frame.
      slot.sprite.scale.setScalar(4.5 * (1 - f * 0.3));
      slot.sprite.material.opacity = 0.9 * (1 - f * 0.6);
    }
  }

  _updateTracers() {
    const world = this.world;
    const shots = world && Array.isArray(world.shots) ? world.shots : [];
    const n = Math.min(shots.length, this.tracers.length);
    for (let i = 0; i < this.tracers.length; i += 1) {
      const tr = this.tracers[i];
      if (i >= n) {
        tr.visible = false;
        continue;
      }
      const s = shots[i];
      // ROUND 6 AGENT B (P8): one tracer colour per defender, so the
      // four shots are countable by colour (wren gold, pip orange, thom
      // red, mira teal — DEFENDER_COLORS). Tracers are reassigned by
      // index each frame, so the colour follows the shot's kind.
      tr.material.color.setHex(DEFENDER_COLORS[s.kind] || 0xffd23f);
      // y interpolates from the muzzle (wall top + chest height) down to
      // the target's torso by the fraction travelled (the sim tracks
      // dist/total, so the arc is a pure function of sim state). Sprites
      // always face the camera, so no orientation is needed — the bright
      // gold orb reads as a bolt against the green field.
      const def = DEFENDER_DEFS.find((d) => d.kind === s.kind);
      const y0 = wallTopY(def ? def.z : s.z) + 2.2;
      const y1 = terrainHeight(s.tx, s.tz) + 1.5;
      const frac = Math.max(0, Math.min(1, 1 - (s.dist !== undefined ? s.dist : 0) / (s.total || 1)));
      const y = y0 + (y1 - y0) * frac;
      tr.position.set(s.x, y, s.z);
      tr.visible = true;
    }
  }

  // ROUND 6 AGENT B (P8): VOLLEY! — when 2+ live shots converge on the
  // same target (same targetId), the multi-shot moment gets a label above
  // that target. Pure function of world.shots, so the staged frame is
  // byte-identical. At the titan freeze Mira + Thom both target enemy 161
  // (measured by probe), so the label shows at (1.2, 0.9). The ULTIMATE
  // proof is still Rizal's playtest — this is supporting evidence in the
  // still.
  _updateVolleyLabel() {
    const world = this.world;
    const label = this._volleyLabel;
    if (!label) return;
    const shots = world && Array.isArray(world.shots) ? world.shots : [];
    const byTarget = new Map();
    for (const s of shots) {
      const k = s.targetId;
      if (k === undefined || k === null) continue;
      const e = byTarget.get(k) || { n: 0, tx: s.tx, tz: s.tz };
      e.n += 1;
      byTarget.set(k, e);
    }
    let best = null;
    for (const e of byTarget.values()) {
      if (e.n >= 2 && (!best || e.n > best.n)) best = e;
    }
    if (!best) { label.sprite.visible = false; return; }
    // R6B fix (proof): +6.5u put the label ON TOP of the "CHAIN x8!"
    // DOM text. +10u lifts it clear of the banner and the top bars.
    // ROUND 7 AGENT A: +13u — the R7A camera (target y 2 -> 6) shifts
    // the whole scene ~50px down, which dropped the label back behind
    // the "CHAIN x8!" banner; +13u lifts it clear again (and clear of
    // the +200 popup above it). Sprite only; sim untouched.
    const y = terrainHeight(best.tx, best.tz) + 13;
    label.sprite.position.set(best.tx, y, best.tz);
    label.sprite.visible = true;
  }

  // ROUND 6 AGENT B (P8): SQUAD cluster marker — the densest group of
  // 4-5 live enemies in one lane (the round-3 spawnGroup size) gets a
  // "SQUAD ×n" tag. Pure function of world.enemies.
  // At the titan freeze the tightest group is lane 0, ids 167-170, x
  // 42.3-52.5 (10.2u spread, 6-16u from the gate at SPAWN_X 58.2).
  // Groups spawn in the sim (spawnGroup, round 3) — this only MARKS
  // them; no sim change. NOTE: a ground ring under the cluster was tried
  // and REMOVED — from the action camera the cluster sits behind the
  // Titan, so no ring colour/opacity read in the still; the tag alone is
  // the marker.
  _updateSquadMarker() {
    const world = this.world;
    const label = this._squadLabel;
    if (!label) return;
    const enemies = world && Array.isArray(world.enemies) ? world.enemies.filter((e) => !e.dead) : [];
    const byLane = new Map();
    for (const e of enemies) {
      const list = byLane.get(e.lane) || [];
      list.push(e);
      byLane.set(e.lane, list);
    }
    let best = null;
    for (const list of byLane.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 3; j < Math.min(list.length, i + 5); j += 1) {
          const spread = list[j].x - list[i].x;
          if (spread > 12) break;
          const n = j - i + 1;
          if (n >= 4 && (!best || n > best.n || (n === best.n && spread < best.spread))) {
            let cx = 0;
            let cz = 0;
            for (let k = i; k <= j; k += 1) { cx += list[k].x; cz += list[k].z; }
            best = { n, spread, cx: cx / n, cz: cz / n };
          }
        }
      }
    }
    if (!best) { label.sprite.visible = false; return; }
    // ROUND 8B: the SQUAD tag is a world-space sprite (depthTest false),
    // updated every frame regardless of camera preset. After the r8a move
    // (cx-26, y+7.0) it reads whole in the action frame but leaks ~15px
    // into the title frame's right edge (title 6e55bf75 vs b471912a, diff
    // bbox x 1263-1280 y 495-545). No position fixes both: the action and
    // title x-windows do not overlap. Hide it under the title preset
    // only — visibility gate, no position/sim change.
    if (this.preset === 'title') { label.sprite.visible = false; return; }
    const y = terrainHeight(best.cx, best.cz);
    const text = `SQUAD ×${best.n}`;
    if (text !== this._squadLabelText) {
      this._squadLabelText = text;
      this._drawLabelText(label.canvas, label.tex, text, label.colorHex);
    }
    // R6B fix (proof): the tag at the centroid (x ~47, near the spawn
    // gate) was HALF OFF the right frame edge. The tag sits 10u toward
    // the wall so it reads fully in-frame.
    // ROUND 8 AGENT A: the tag at cx-10 sat dead-centre on the Titan's
    // furnace ring (plate bbox ~1093-1173 x 355-397 vs ring left edge
    // ~1043, measured on 2-action.jpg at 87dc9be) — the ring's centre
    // was covered in the 2x Titan crop. Move it 16u further toward the
    // wall (cx-26, expected screen centre ~990) and 1.5u up (y+7.0,
    // expected ~336) so it clears the ring's left edge AND the Titan's
    // shoulder (x >= 1033 at that height) AND the "+400 x4 CHAIN"
    // popup below (~y 385). It lands over the hillside pines left of
    // the Titan, still at the cluster's height, still the squad marker.
    // Sprite only; sim untouched.
    label.sprite.position.set(best.cx - 26, y + 7.0, best.cz);
    label.sprite.visible = true;
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
    // ROUND 6 AGENT B (P8): born-relative reuse — same batched-drain bug
    // as _spawnMuzzle/_spawnArc. The old test (slot.t > slot.ttl) made
    // every boom in the drain overwrite slot 0 (this.time is the freeze
    // time for every spawn, so a just-born slot always looked free) and
    // only the LAST boom's fireball survived the freeze.
    for (const slot of this.flashes) {
      if (slot.born < 0 || (evTime - slot.born) > slot.ttl) {
        // Birth in SIM time (the event carries world.time): the flash's
        // progress is then a pure function of world.time, so a frozen
        // staged frame renders identically no matter how many render
        // frames ran before the screenshot. (Before: slot.t += dt per
        // render frame, so the title shot's flash depended on capture
        // timing — the 04:45 title --twice MISMATCH, 18 bytes.)
        slot.born = (typeof evTime === 'number' ? evTime : this.time);
        slot.t = this.time - slot.born;
        // R4B (item 4): ttl 0.5 -> 1.0 + maxR 5 -> 8. The frozen action
        // frame showed ZERO live flashes (all booms older than 0.5s at the
        // freeze), so the chain's fireballs never survived into the shot.
        // A 1.0s life keeps the most recent booms visible as big shaped
        // fireballs; opacity still fades (1-f)*0.6, so no washout pile-up.
        slot.ttl = 1.0;
        slot.x = x;
        slot.z = z;
        slot.maxR = 8;
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
        // ROUND 6 AGENT B (P8): born-relative reuse — same batched-drain
        // bug as _spawnFlash: the old stale-t test let every boom in the
        // drain overwrite the same puff slots.
        if (slot.born < 0 || (evTime - slot.born) > slot.ttl) {
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
      // R4B (item 4): puffs 2+f*4 -> 2.5+f*5 — the smoke column should read
      // as part of the big blast, not a faint wisp beside it.
      slot.puff.scale.setScalar(2.5 + f * 5);
      slot.puff.material.opacity = 0.42 * (1 - f);
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
      slot.flash.material.opacity = (1 - f) * 0.6;
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
        const band = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.09, 6, 14), this.kegBandMat);
        band.rotation.x = Math.PI / 2;
        band.position.y = 0.4;
        mesh.add(band);
        const band2 = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.09, 6, 14), this.kegBandMat);
        band2.rotation.x = Math.PI / 2;
        band2.position.y = -0.4;
        mesh.add(band2);
        const glow = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), this.kegGlowMat);
        glow.position.y = 0.95;
        glow.visible = false;
        mesh.add(glow);
        mesh.userData.glow = glow;
        // R4B (item 13): a lit keg gets a big additive fuse-glow sprite on
        // top of the sphere — the old 0.3u sphere was invisible at action
        // distance, so "lit" never read. The sprite is the fuse fire.
        const fuseGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff8a1a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        fuseGlow.scale.set(3.2, 3.2, 1);
        fuseGlow.position.y = 1.1;
        mesh.add(fuseGlow);
        mesh.userData.fuseGlow = fuseGlow;
        this.scene.add(mesh);
        this.kegMeshes.set(keg, mesh);
      }
      mesh.visible = keg.alive;
      if (keg.alive) {
        mesh.position.set(keg.x, terrainHeight(keg.x, keg.z) + 0.78, keg.z);
        mesh.userData.glow.visible = keg.state === 'lit';
        mesh.userData.fuseGlow.material.opacity = keg.state === 'lit' ? 0.85 : 0;
        if (keg.state === 'lit') {
          const s = 1 + Math.sin(this.time * 30) * 0.15;
          mesh.userData.glow.scale.setScalar(s);
          mesh.userData.fuseGlow.scale.setScalar(3.2 * s);
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

  // ROUND 4 AGENT C (item 7): popups are 3D sprites, but the HUD is DOM on
  // top of the canvas (z-index 5) — a popup whose NDC rect falls under a
  // chip, the boss bar, the threat panel, the bark, the toast, the banner
  // or a bottom button renders BEHIND it ("+400 x4 CHAIN" read as
  // "00x4 CHAIN" behind the boss bar; 7 popup-vs-DOM hits at the action
  // freeze, proof-r4c/before-dom.json). So the placer treats the visible
  // DOM chrome as obstacles: the stack + grid search route around them.
  // The rects are cached and refreshed only when a deterministic key
  // changes (viewport, banner/bark/toast text) or every 0.5 SIM-seconds
  // (world.time — sim time, so the frozen screenshot stays byte-identical
  // across runs; never wall-clock, or determinism would break).
  _domObstacles() {
    const world = this.world;
    if (typeof document === 'undefined' || !world) return [];
    const canvas = this.renderer && this.renderer.domElement;
    const W = (canvas && canvas.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const H = (canvas && canvas.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 720);
    const banner = document.querySelector('.event-banner');
    const bark = document.querySelector('.bark');
    const toast = document.querySelector('#toast');
    // ROUND 4 AGENT C (item 7, cache-poisoning fix): the old key only covered
    // the banner/bark/toast TEXTS. The HUD chrome hides on title/draft/
    // results screens (ui.setChrome sets #hud/#bottom style.display none),
    // so a rect set computed while the HUD was hidden is EMPTY — and an
    // empty array is truthy, so that poisoned [] was returned for the same
    // key at the action freeze (sim time frozen => the 0.5s expiry can
    // never fire there), leaving popups unblocked against the banner and
    // the top chips (probe: 5 domHits, blockers []). The key now includes
    // the chrome visibility (inline style.display, the exact setChrome
    // signal — free to read, no layout) + the full HUD/bottom text (chip
    // widths + threat-panel height both follow the text), so a hidden-
    // chrome computation can never be reused for a visible-chrome frame.
    // Belt and braces: a cached empty set is never trusted while the HUD
    // is displayed — the chips are unconditional children of #hud, so an
    // empty set with a visible HUD is always stale.
    const hud = document.querySelector('#hud');
    const bottom = document.querySelector('#bottom');
    const hudDisplay = hud ? (hud.style.display || 'flex') : 'none';
    const bottomDisplay = bottom ? (bottom.style.display || 'flex') : 'none';
    const key = [W, H, hudDisplay, hud ? hud.textContent : '', bottomDisplay, bottom ? bottom.textContent : '',
      banner ? banner.textContent : '',
      bark ? bark.textContent : '',
      toast && toast.classList.contains('show') ? toast.textContent : '',
    ].join('|');
    const t = world.time || 0;
    if (this._domObs && this._domObsKey === key && t - this._domObsTime < 0.5) {
      if (this._domObs.length === 0 && hudDisplay !== 'none') {
        // Poisoned empty cache: fall through and recompute.
      } else {
        return this._domObs;
      }
    }
    const rects = [];
    const M = 6; // px margin so a popup never kisses a panel edge
    const grab = (el) => {
      if (!el) return;
      if (getComputedStyle(el).display === 'none') return;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return;
      const l = Math.max(0, b.left - M);
      const r = Math.min(W, b.right + M);
      const tp = Math.max(0, b.top - M);
      const bt = Math.min(H, b.bottom + M);
      if (r <= l || bt <= tp) return;
      rects.push({
        left: (l / W) * 2 - 1, right: (r / W) * 2 - 1,
        top: 1 - (tp / H) * 2, bottom: 1 - (bt / H) * 2,
      });
    };
    document.querySelectorAll('#hud .hud-chip, #hud .hud-mult, .boss-bar, .threat-panel').forEach(grab);
    if (bark && bark.textContent.trim()) grab(bark);
    if (toast && toast.classList.contains('show')) grab(toast);
    if (banner) grab(banner);
    // ROUND 5 AGENT C (items #7 + #8): the minimap + wave strip are DOM
    // chrome above the bar — popups must route around them too.
    document.querySelectorAll('#bottom .powder-btn, #bottom .light-btn, #bottom .ctl-btn, #bottom .minimap-wrap, #bottom .wave-strip').forEach(grab);
    this._domObs = rects;
    this._domObsKey = key;
    this._domObsTime = t;
    return rects;
  }

  _updatePopups() {
    const world = this.world;
    // ROUND 5 AGENT C (results-backdrop cleanup, Mark 01:37 WIB): the
    // results screen's backdrop is the live 3D scene, and the win run's
    // final popups ("+800 x8 CHAIN" x3, "CINDER TITAN DOWN! +5600") were
    // still alive at the win moment (ttl 0.9-1.4s), so they sat on the
    // backdrop — the only stray-UI defect in the set, and no top-5 entry
    // has one. The results screen is up only in won/lost, so hide every
    // popup sprite there. Purely visual: the sim's world.popups list is
    // untouched (no score/state change), and popupRectsCache is emptied
    // so the overlap checker reads 0 rects on a results frame.
    if (world && (world.phase === 'won' || world.phase === 'lost')) {
      for (const slot of this.popups) slot.sprite.visible = false;
      this.popupRectsCache = [];
      return;
    }
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
    // ROUND 4 AGENT C (item 7): the stack + grid search must avoid the DOM
    // chrome too, not just other popups. `blockers` starts as the DOM
    // obstacle rects and grows with each placed popup; `placed` stays
    // popup-only so popupRectsCache (the overlap checker) is unchanged.
    const blockers = this._domObstacles().slice();
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
      // ROUND 3 (item 9): bound the SCREEN size of a popup. The sprite
      // is a fixed 9u x 2.25u in world units, so an anchor close to the
      // camera (a kill near the spawn in the game camera, zc ~15) projects
      // to 0.82 x 0.37 NDC — one number covering 40% of the screen width,
      // and nine of them cannot be placed without overlapping no matter
      // how the stack/grid searches. Clamp the half-extents to hw <= 0.12
      // / hh <= 0.06 (full 0.24 x 0.12 NDC) by shrinking the sprite; the
      // action-camera frame is untouched (its biggest popup is hw 0.11 /
      // hh 0.05, below the clamp), and a lone in-frame popup still keeps
      // its old anchor exactly.
      let spriteShrink = 1;
      if (zc <= 0.1) {
        // Behind the camera: the GPU culls it anyway; keep the old anchor.
        slot.sprite.position.set(ax, ay, az);
        slot.sprite.scale.set(9 * scale, 2.25 * scale, 1);
      } else {
        const xc = vx * right.x + vy * right.y + vz * right.z;
        const yc = vx * up.x + vy * up.y + vz * up.z;
        let ndcX = xc / (zc * tanH);
        let ndcY = yc / (zc * tanV);
        let hw = wHalfW / (zc * tanH);
        let hh = hHalfW / (zc * tanV);
        spriteShrink = Math.min(1, 0.12 / hw, 0.06 / hh);
        hw *= spriteShrink;
        hh *= spriteShrink;
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
        // Stack above any overlapping placed rect or DOM obstacle (repeat
        // until stable). The raise is capped at maxY so a popup never
        // escapes the top of the frame.
        for (let pass = 0; pass < 3; pass += 1) {
          let raised = false;
          for (const r of blockers) {
            if (ndcX + hw > r.left - 0.01 && ndcX - hw < r.right + 0.01
              && ndcY + hh > r.bottom - 0.01 && ndcY - hh < r.top + 0.01) {
              ndcY = Math.min(maxY, r.top + hh + 0.02);
              raised = true;
            }
          }
          if (!raised) break;
        }
        // ROUND 3 (item 9): the vertical stack saturates when a whole
        // group dies at once (4-5 chain popups + coins + damage numbers
        // anchored off-frame right, all clamped to the same edge x, then
        // all raised to the top row). Fallback: a deterministic grid
        // search around the stacked position — closest free spot first —
        // so a popup always lands somewhere readable instead of piling
        // onto the top row. The old horizontal nudge (4 attempts) could
        // not clear a saturated column; the grid search covers the whole
        // frame (288 candidates) and the overlap checker proves it.
        const overlapsPlaced = () => blockers.some((r) => ndcX + hw > r.left - 0.01 && ndcX - hw < r.right + 0.01
          && ndcY + hh > r.bottom - 0.01 && ndcY - hh < r.top + 0.01);
        if (overlapsPlaced()) {
          const baseX = ndcX;
          const baseY = ndcY;
          for (const [dx, dy] of POPUP_GRID_OFFSETS) {
            const tryX = Math.max(-maxX, Math.min(maxX, baseX + dx));
            const tryY = Math.max(minY, Math.min(maxY, baseY + dy));
            const saveX = ndcX;
            const saveY = ndcY;
            ndcX = tryX;
            ndcY = tryY;
            if (!overlapsPlaced()) break;
            ndcX = saveX;
            ndcY = saveY;
          }
        }
        const nx = ndcX * zc * tanH;
        const ny = ndcY * zc * tanV;
        const px = this.camPos.x + fwd.x * zc + right.x * nx + up.x * ny;
        const py = this.camPos.y + fwd.y * zc + right.y * nx + up.y * ny;
        const pz = this.camPos.z + fwd.z * zc + right.z * nx + up.z * ny;
        const rect = { left: ndcX - hw, right: ndcX + hw, top: ndcY + hh, bottom: ndcY - hh, text: popup.text };
        placed.push(rect);
        blockers.push(rect);
        slot.sprite.position.set(px, py, pz);
        slot.sprite.scale.set(9 * scale * spriteShrink, 2.25 * scale * spriteShrink, 1);
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
      // ROUND 7 AGENT A (item 1, Mark 17:49 WIB): in the action shot the
      // Titan faces the CAMERA. At the x8 freeze its face (-x, toward the
      // fort) points ~105 deg away from the action camera, so the frame
      // only ever saw its back/side — an orange pillar with no face, eyes
      // or furnace ring. Yaw toward the camera preset, gated on
      // preset === 'action' so live play (preset 'game') and the
      // title/draft/results shots are untouched. Same aim formula as the
      // defenders: yaw = atan2(dz, -dx) faces (dx, dz). Pure render-side:
      // sim untouched, staged numbers unchanged, deterministic (boss pos +
      // camera preset are both frozen).
      let bossYaw = 0;
      if (this.preset === 'action') {
        const dx = this.camPos.x - boss.x;
        const dz = this.camPos.z - boss.z;
        bossYaw = Math.atan2(dz, -dx);
      }
      this.bossMesh.group.rotation.y = bossYaw; // models face -x by default
      this.bossMesh.setPose(boss.defeated ? 'dead' : (boss.state === 'attack' ? 'attack' : 'walk'), world.time, { damageState });
      // ROUND 6 AGENT C (P2): Titan halo + scorch path — only while the
      // Titan lives (wave-10 combat). Hidden on title/draft/results and
      // after the win, so only the action shot changes.
      this._titanGlow.visible = !!boss.alive;
      if (boss.alive) this._titanGlow.position.set(boss.x - 0.8, terrainHeight(boss.x, boss.z) + 5.5, boss.z);
      this._titanScorch.visible = !!boss.alive;
    } else if (this.bossMesh) {
      this.bossMesh.group.visible = false;
      this._titanGlow.visible = false;
      this._titanScorch.visible = false;
    }
    // Defenders on the wall.
    const phase = world.phase;
    const defStates = world.defenders || [];
    for (const kind of ['wren', 'pip', 'thom', 'mira']) {
      const def = this.defenders[kind];
      const z = def.z;
      def.group.position.set(WORLD.WALL_X - 0.5, wallTopY(z), z);
      // ROUND 3 (item 1): AIM — face the last fired-at target (yaw toward
      // aimX/aimZ); default +x (toward the horde) before the first shot.
      // Models face -x at yaw 0, so yaw = atan2(dz, -dx) faces (dx, dz).
      const st = defStates.find((d) => d.kind === kind);
      let yaw = Math.PI;
      if (st && st.hasAim) {
        const dx = st.aimX - (WORLD.WALL_X - 0.5);
        const dz = st.aimZ - z;
        yaw = Math.atan2(dz, -dx);
      }
      def.group.rotation.y = yaw;
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
      // ROUND 3 (item 1): a defender that just fired shows the attack
      // pose (recoil — weapon arm lunges) for 0.5s of sim time, so the
      // shot reads as an ACTION, not a statue. At the x8 freeze this mixes
      // with celebrate: some defenders shoot, some cheer.
      if (st && world.time - st.lastShotT < 0.5 && phase !== 'won' && phase !== 'lost') anim = 'attack';
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
    // ROUND 3 AGENT D (item 11): embers rise and drift over the field;
    // dust motes drift slowly in the evening light. Pure functions of t —
    // deterministic at any frozen time. Y is terrain-relative so no mote
    // ever sinks under the fort hill.
    {
      const pos = this._emberGeo.attributes.position.array;
      for (let i = 0; i < this._embers.length; i += 1) {
        const e = this._embers[i];
        const rise = ((t * e.speed + e.phase) % 6 + 6) % 6;
        const x = e.bx + Math.sin(t * 0.4 + e.phase) * e.amp;
        const z = e.bz + Math.cos(t * 0.3 + e.phase) * e.amp;
        pos[i * 3] = x;
        pos[i * 3 + 1] = terrainHeight(x, z) + 0.5 + e.by * 0.4 + rise;
        pos[i * 3 + 2] = z;
      }
      this._emberGeo.attributes.position.needsUpdate = true;
      this._emberMat.opacity = 0.85 + Math.sin(t * 2) * 0.15;
      const mpos = this._moteGeo.attributes.position.array;
      for (let i = 0; i < this._motes.length; i += 1) {
        const m = this._motes[i];
        const x = m.bx + Math.sin(t * 0.15 + m.phase) * m.amp;
        const z = m.bz + Math.cos(t * 0.12 + m.phase) * m.amp;
        mpos[i * 3] = x;
        mpos[i * 3 + 1] = terrainHeight(x, z) + 1 + m.by * 0.5 + Math.sin(t * 0.1 + m.phase * 2) * 0.8;
        mpos[i * 3 + 2] = z;
      }
      this._moteGeo.attributes.position.needsUpdate = true;
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

  // ROUND 5 AGENT C (item #5): x8 ember burst — pure function of the
  // frozen world state (see the constructor note). On only while combat +
  // chainMul >= 8 + trail burning, anchored at the burn front. The plume
  // rises in a loop (f(world.time), so the frozen frame is byte-identical
  // across runs) and the core glows pulse gently; opacity never drops
  // below 0.75, so the burst always reads at the freeze.
  _updateX8Burst(t) {
    const world = this.world;
    const trail = world ? world.trail : null;
    const on = !!(world && world.phase === 'combat' && world.chainMul >= 8 && world.chain > 0 && trail && trail.state === 'burning');
    this._burstPoints.visible = on;
    for (const c of this._burstCore) c.sprite.visible = on;
    if (!on) return;
    const fx = trail.frontX ?? trail.points[0].x;
    const fz = trail.frontZ ?? trail.points[0].z;
    const gy = terrainHeight(fx, fz);
    const pos = this._burstGeo.attributes.position.array;
    for (let i = 0; i < this._burst.length; i += 1) {
      const b = this._burst[i];
      const rise = ((t * b.speed + b.phase) % 8 + 8) % 8;
      pos[i * 3] = fx + b.dx + Math.sin(t * 0.7 + b.phase) * b.amp;
      pos[i * 3 + 1] = gy + 0.5 + rise;
      pos[i * 3 + 2] = fz + b.dz + Math.cos(t * 0.6 + b.phase) * b.amp;
    }
    this._burstGeo.attributes.position.needsUpdate = true;
    this._burstMat.opacity = 0.85 + Math.sin(t * 3) * 0.1;
    for (const c of this._burstCore) {
      c.sprite.position.set(fx + c.dx, gy + c.dy + Math.sin(t * 5 + c.phase) * 0.3, fz + c.dz);
      c.sprite.scale.setScalar(3.2 + Math.sin(t * 6 + c.phase) * 0.4);
      c.sprite.material.opacity = 0.75 + Math.sin(t * 4 + c.phase) * 0.1;
    }
  }

  // ROUND 5 AGENT C (item #6): scorch smoke columns — pure function of
  // world state + world.time (see the constructor note). On in combat from
  // wave 6 on, and on the results backdrop (won) — the columns rise over
  // FRESH scorch, so they never show on the title diorama (a wave-1
  // combat world: no battle has scorched anything yet) or the draft
  // (build phase). The wave-6 floor was added after the first version
  // leaked 1 column set into the title shot (its diorama world is phase
  // 'combat', wave 1 — the gate must test the wave, not just the phase).
  _updateScorchSmoke(t) {
    const world = this.world;
    const on = !!(world && ((world.phase === 'combat' && world.wave >= 6) || world.phase === 'won'));
    for (const col of this._scorchSmoke) {
      const swayX = Math.sin(t * 0.4 + col.phase) * 0.5;
      const swayZ = Math.cos(t * 0.33 + col.phase) * 0.3;
      const gy = terrainHeight(col.x, col.z);
      for (const lv of col.levels) {
        lv.sprite.visible = on;
        if (!on) continue;
        lv.sprite.position.set(col.x + swayX, gy + lv.dy, col.z + swayZ);
        lv.sprite.scale.setScalar(lv.scale);
        lv.sprite.material.opacity = lv.opacity;
      }
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
    this._updateMuzzles(dt);
    this._updateTracers();
    this._updateParticles();
    this._updateScorches();
    this._updateFlashes(dt);
    this._updateSmokes(dt);
    this._updateAmbient(t);
    this._updateX8Burst(t);
    this._updateScorchSmoke(t);

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

    // ROUND 5 AGENT A (items #1 + #2): beams + arcs AFTER the camera is
    // positioned — both are camera-facing ribbons, so they need the final
    // camera position for their side vectors.
    this._updateBeams();
    this._updateArcs();

    // ROUND 6 AGENT B (P8): VOLLEY! label + SQUAD cluster marker.
    this._updateVolleyLabel();
    this._updateSquadMarker();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
