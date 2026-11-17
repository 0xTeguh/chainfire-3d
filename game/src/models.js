// CHAINFIRE 3D — character models. Written fresh for the 3D rebuild.
// All characters are built ONLY from THREE primitives (Box, Sphere,
// Cylinder, Cone, Torus, CapsuleGeometry, Icosahedron). No textures, no
// sprites, no network, no Math.random — build-time variation comes from a
// seeded mulberry32 rng, and animation is a pure function of (anim, t,
// params): no clock, no internal state that drifts between calls.
//
// Conventions:
// - group origin is at the character's feet (y = 0 at ground).
// - Every character faces -x by default (walking toward the fort at -x),
//   so faces (eyes, mouth) sit on the -x side of the head.
// - An inner "rig" group carries all pose offsets (bob, lean, fall) so the
//   renderer's world placement of the outer group is never disturbed.
// - All dimensions below are written in "scale units": multiply by the
//   character's scale `s` to get world units. Base height is 3.2 units at
//   scale 1.0, so height = 3.2 * s exactly.
// - Horde = charcoal / ember / red / purple. Garrison = warm, bright
//   colours. Friend vs foe must read by colour instantly.

import { THREE } from './three.js';
import { mulberry32, range } from './rng.js';

export const KINDS = ['cinderling', 'torchbearer', 'ironhide', 'saboteur', 'titan', 'wren', 'pip', 'thom', 'mira'];

const BASE_HEIGHT = 3.2;

const SCALES = {
  cinderling: 0.6,
  torchbearer: 1.0,
  ironhide: 2.0,
  saboteur: 0.75,
  titan: 4.0,
  // R3E (Mark 23:58 WIB): defenders read 1.3x — at eagle distance the
  // Garrison was 29-33px and invisible as shooters; 1.3x puts Thom ~46px
  // in the action frame. Visual only (sim uses positions, not scale).
  // Cinderling/enemies UNTOUCHED (Mark's freeze).
  wren: 1.3,
  pip: 0.72,
  thom: 1.37,
  mira: 1.24
};

// ---------------------------------------------------------------------------
// Material / mesh helpers
// ---------------------------------------------------------------------------

function std(color, o = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: o.rough !== undefined ? o.rough : 0.85,
    metalness: o.metal !== undefined ? o.metal : 0.0,
    flatShading: true,
    emissive: o.emissive !== undefined ? o.emissive : 0x000000,
    emissiveIntensity: o.ei !== undefined ? o.ei : 1
  });
}

export function buildCharacter(kind, opts = {}) {
  if (!KINDS.includes(kind)) {
    throw new Error('unknown character kind: ' + kind);
  }
  const seed = opts.seed !== undefined ? opts.seed : 7;
  const rng = mulberry32(seed);
  const s = SCALES[kind];
  const height = BASE_HEIGHT * s;

  const group = new THREE.Group();
  group.name = kind;
  const inner = new THREE.Group();
  inner.name = 'rig';
  group.add(inner);

  const parts = {};
  const resetList = []; // objects whose base transform is restored each setPose
  const flicker = []; // { obj, mat, kind, base, amp, speed, phase }

  // Register an object so setPose() restores its base transform first.
  function reg(obj) {
    obj.userData.basePos = obj.position.clone();
    obj.userData.baseRot = { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z };
    obj.userData.baseScale = obj.scale.clone();
    resetList.push(obj);
    return obj;
  }

  // Pivot group (a joint). Optional base rotation in radians.
  function piv(x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.set(rx, ry, rz);
    inner.add(g);
    return reg(g);
  }

  function mesh(parent, geo, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }

  function box(parent, w, h, d, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const m = mesh(parent, new THREE.BoxGeometry(w, h, d), material, x, y, z);
    m.rotation.set(rx, ry, rz);
    return m;
  }

  function ball(parent, r, material, x = 0, y = 0, z = 0) {
    return mesh(parent, new THREE.SphereGeometry(r, 14, 10), material, x, y, z);
  }

  function cyl(parent, rt, rb, h, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 12) {
    const m = mesh(parent, new THREE.CylinderGeometry(rt, rb, h, seg), material, x, y, z);
    m.rotation.set(rx, ry, rz);
    return m;
  }

  function cone(parent, r, h, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 12) {
    const m = mesh(parent, new THREE.ConeGeometry(r, h, seg), material, x, y, z);
    m.rotation.set(rx, ry, rz);
    return m;
  }

  function cap(parent, r, len, material, x = 0, y = 0, z = 0) {
    return mesh(parent, new THREE.CapsuleGeometry(r, len, 4, 10), material, x, y, z);
  }

  // Glowing ember eye (Horde): orange orb + hot yellow core.
  function emberEye(parent, x, y, z, r) {
    ball(parent, r, std(0xff7a1a, { emissive: 0xff5a00, ei: 1.8, rough: 0.4 }), x, y, z);
    ball(parent, r * 0.45, std(0xffd23f, { emissive: 0xffb020, ei: 2.4, rough: 0.3 }), x - r * 0.35, y, z);
  }

  // Normal eye (Garrison): white ball + dark pupil, pupil pushed to -x.
  function plainEye(parent, x, y, z, r) {
    ball(parent, r, std(0xffffff, { rough: 0.35 }), x, y, z);
    ball(parent, r * 0.5, std(0x1a1210, { rough: 0.3 }), x - r * 0.55, y + r * 0.1, z);
  }

  // Smile (lower half-torus, U shape) / frown (upper half-torus), facing -x.
  function mouthArc(parent, x, y, z, r, tube, smile) {
    const m = mesh(
      parent,
      new THREE.TorusGeometry(r, tube, 8, 16, Math.PI),
      std(0x1a1210, { rough: 0.6 }),
      x, y, z
    );
    m.rotation.set(0, Math.PI / 2, smile ? Math.PI : 0);
    return m;
  }

  // -- shared rig slots (filled in by every builder below) ------------------
  let head = null;
  let body = null;
  let armL = null;
  let armR = null;
  let legL = null;
  let legR = null;
  const cracks = []; // titan damage cracks, hidden until damageState >= 1
  let coreMat = null; // titan furnace core material (dims with damage)

  // =========================================================================
  // THE ASHEN HORDE
  // =========================================================================

  if (kind === 'cinderling') {
    // Small round ember creature. One big round body, oversized head,
    // glowing eyes, open mouth, ember cracks. Fast scuttle pose.
    // P5 (Rizal fix round 2): the round-1 warm mid-brown (0x4a3226) STILL
    // reads as a black blob at eagle distance — Rizal: still a black blob.
    // Lighter warm-tan skin + hotter, BIGGER ember details (cracks, belly,
    // eyes, head tuft, mouth glow) so the creature reads hot orange-brown
    // against the green field at 320px, not black.
    // ITEM 3 (18:36 WIB): STILL a blob in the action frame — the close-up
    // reads (face + cracks visible) but the ACTION camera sees the
    // cinderling's BACK (+x side: enemies face -x toward the fort), and
    // the back was plain dark skin with NO ember at all. At 0.6x the whole
    // creature is ~10px, so the face-side ember is sub-pixel anyway.
    // Fix: the ember must wrap the WHOLE creature, not just the face.
    // Much lighter skin + warm emissive so the body can never render
    // near-black in shadow; ember cracks + glow patch on the BACK; a hot
    // patch on TOP (what the 34-degree eagle camera actually sees);
    // a 3-spike ember crown (spiky silhouette from above); bigger eyes
    // and belly glow. The body must read AMBER, not brown, at distance.
    const skin = std(0xa8653c, { rough: 0.9, emissive: 0x8a3d00, ei: 0.7 });
    const ember = std(0xff7a1a, { emissive: 0xff5a00, ei: 4.0 });

    legL = piv(0, 0.5 * s, 0.28 * s);
    cap(legL, 0.11 * s, 0.22 * s, skin, 0, -0.16 * s, 0);
    ball(legL, 0.13 * s, skin, -0.03 * s, -0.36 * s, 0);
    legR = piv(0, 0.5 * s, -0.28 * s);
    cap(legR, 0.11 * s, 0.22 * s, skin, 0, -0.16 * s, 0);
    ball(legR, 0.13 * s, skin, -0.03 * s, -0.36 * s, 0);

    body = ball(inner, 0.85 * s, skin, 0, 1.15 * s, 0);
    reg(body);
    // Ember cracks: small glowing boxes stuck on the belly front (-x).
    for (let i = 0; i < 4; i += 1) {
      const cy = 0.9 * s + i * 0.26 * s;
      const cz = range(rng, -0.35, 0.35) * s;
      const crack = box(inner, 0.04 * s, 0.26 * s, 0.1 * s, ember, -0.82 * s, cy, cz, 0, 0, range(rng, -0.4, 0.4));
      crack.rotation.y = range(rng, -0.25, 0.25);
    }
    // ITEM 3: ember cracks on the BACK (+x) — the side the action camera
    // sees. Same recipe, mirrored, so the creature glows from every angle.
    for (let i = 0; i < 3; i += 1) {
      const cy = 0.95 * s + i * 0.3 * s;
      const cz = range(rng, -0.35, 0.35) * s;
      const crack = box(inner, 0.04 * s, 0.26 * s, 0.1 * s, ember, 0.82 * s, cy, cz, 0, 0, range(rng, -0.4, 0.4));
      crack.rotation.y = range(rng, -0.25, 0.25);
    }
    // Belly glow: a warm patch low on the body so the silhouette reads hot.
    ball(inner, 0.42 * s, std(0xff7a1a, { emissive: 0xff5a00, ei: 3.0 }), -0.55 * s, 0.75 * s, 0).scale.set(0.5, 1, 1);
    // ITEM 3: back glow patch (+x) + top glow patch (what the eagle
    // camera sees from 34 degrees down). Both flattened ember balls.
    ball(inner, 0.4 * s, std(0xff7a1a, { emissive: 0xff5a00, ei: 3.0 }), 0.55 * s, 0.8 * s, 0).scale.set(0.5, 1, 1);
    const topGlow = ball(inner, 0.48 * s, std(0xff9a2a, { emissive: 0xff6a00, ei: 3.6 }), 0.1 * s, 1.9 * s, 0);
    topGlow.scale.set(1, 0.45, 1);

    armL = piv(0, 1.5 * s, 0.78 * s, 0.25, 0, 0);
    cap(armL, 0.09 * s, 0.26 * s, skin, 0, -0.2 * s, 0);
    armR = piv(0, 1.5 * s, -0.78 * s, -0.25, 0, 0);
    cap(armR, 0.09 * s, 0.26 * s, skin, 0, -0.2 * s, 0);

    head = piv(0, 2.35 * s, 0);
    const skull = ball(head, 0.6 * s, skin, 0, 0, 0);
    parts.headMesh = skull;
    emberEye(head, -0.48 * s, 0.1 * s, 0.24 * s, 0.21 * s);
    emberEye(head, -0.48 * s, 0.1 * s, -0.24 * s, 0.21 * s);
    // Open mouth: dark hollow + hot glow inside.
    const mouth = ball(head, 0.17 * s, std(0x140a06, { rough: 0.7 }), -0.52 * s, -0.2 * s, 0);
    mouth.scale.set(0.4, 1, 1.25);
    ball(head, 0.08 * s, std(0xff7a1a, { emissive: 0xff5a00, ei: 2.6 }), -0.56 * s, -0.26 * s, 0);
    // Ember crown on top: THREE spikes now (was one small cone) — the
    // tallest point, keeps the silhouette spiky from above and behind.
    cone(head, 0.26 * s, 0.5 * s, ember, 0, 0.72 * s, 0, 0, 0, range(rng, -0.15, 0.15));
    cone(head, 0.16 * s, 0.36 * s, ember, 0.1 * s, 0.62 * s, 0.22 * s, 0, 0, 0.3);
    cone(head, 0.16 * s, 0.36 * s, ember, 0.1 * s, 0.62 * s, -0.22 * s, 0, 0, -0.3);
  }

  if (kind === 'torchbearer') {
    // Tall hooded figure, dark red robe, hood with glowing eyes inside,
    // torch held OUT to the side so it never sinks into the body.
    const robe = std(0x8a2d1e, { rough: 0.95 });
    const dark = std(0x3a1a12, { rough: 0.95 });
    // ROUND 3 AGENT B (item 11, Rizal): the torch flame was a 1-2px dot at
    // 320px — each torchbearer must read as a distinct orange point. Flame
    // bigger + hotter so the group does not merge into one red blob.
    const flameMat = std(0xff7a1a, { emissive: 0xff6a00, ei: 2.8, rough: 0.5 });
    const flameCoreMat = std(0xffd23f, { emissive: 0xffb020, ei: 3.0, rough: 0.4 });

    legL = piv(0, 0.35 * s, 0.3 * s);
    cap(legL, 0.12 * s, 0.2 * s, dark, 0, -0.14 * s, 0);
    box(legL, 0.24 * s, 0.1 * s, 0.3 * s, dark, -0.04 * s, -0.3 * s, 0);
    legR = piv(0, 0.35 * s, -0.3 * s);
    cap(legR, 0.12 * s, 0.2 * s, dark, 0, -0.14 * s, 0);
    box(legR, 0.24 * s, 0.1 * s, 0.3 * s, dark, -0.04 * s, -0.3 * s, 0);

    body = cone(inner, 0.85 * s, 2.0 * s, robe, 0, 1.0 * s, 0);
    reg(body);
    // Robe hem band + belt cord.
    cyl(inner, 0.86 * s, 0.88 * s, 0.12 * s, dark, 0, 0.12 * s, 0);
    const torso = ball(inner, 0.45 * s, robe, 0, 2.05 * s, 0);
    torso.scale.set(1, 1.1, 1);
    // Sleeve cuffs.
    ball(inner, 0.16 * s, dark, 0, 2.28 * s, 0.5 * s);
    ball(inner, 0.16 * s, dark, 0, 2.28 * s, -0.5 * s);

    armL = piv(0, 2.25 * s, 0.48 * s, 0.3, 0, 0.25);
    cap(armL, 0.13 * s, 0.42 * s, robe, 0, -0.28 * s, 0);
    // Torch arm: held out to the character's right (-z) and forward (-x).
    armR = piv(0, 2.25 * s, -0.48 * s, -0.85, 0, 0.45);
    cap(armR, 0.13 * s, 0.42 * s, robe, 0, -0.28 * s, 0);
    const torch = new THREE.Group();
    torch.position.set(0, -0.58 * s, 0);
    armR.add(torch);
    cyl(torch, 0.05 * s, 0.06 * s, 0.7 * s, std(0x4a3a2e, { rough: 0.9 }), 0, 0.15 * s, 0);
    cyl(torch, 0.09 * s, 0.07 * s, 0.14 * s, std(0x2b2b2b, { rough: 0.9 }), 0, 0.5 * s, 0);
    const flame = new THREE.Group();
    flame.position.set(0, 0.62 * s, 0);
    torch.add(flame);
    cone(flame, 0.22 * s, 0.6 * s, flameMat, 0, 0.24 * s, 0);
    cone(flame, 0.12 * s, 0.4 * s, flameCoreMat, 0, 0.18 * s, 0);
    flicker.push({ obj: flame, kind: 'scale', base: 1, amp: 0.18, speed: 9, phase: rng() * 6 });
    parts.flame = flame;
    parts.torch = torch;

    head = piv(0, 2.55 * s, 0);
    ball(head, 0.38 * s, std(0x140a08, { rough: 1 }), 0, 0, 0);
    // Hood: cone over the head, point tipped slightly forward.
    cone(head, 0.5 * s, 0.62 * s, dark, 0.04 * s, 0.3 * s, 0, 0, 0, 0.12);
    // Glowing eyes deep inside the hood.
    emberEye(head, -0.3 * s, 0.05 * s, 0.14 * s, 0.09 * s);
    emberEye(head, -0.3 * s, 0.05 * s, -0.14 * s, 0.09 * s);
    box(head, 0.03 * s, 0.04 * s, 0.18 * s, std(0x140a08), -0.36 * s, -0.12 * s, 0);
  }

  if (kind === 'ironhide') {
    // Wide tank: boxy steel armor, big shoulders, tower shield (separate
    // mesh), helmet with slit eyes, grey steel + red accent.
    // R4B (item 9, Mark 00:51 WIB): the ironhide read as a dark box at
    // action distance — and the two ironhides nearest the fire front have
    // shieldBroken=true, so their tower shield DROPS to the ground and the
    // bright rim frame (R3B) vanishes with it. Fixes that survive a broken
    // shield: brighter steel overall + RED BACK accents (the action camera
    // sees the ironhide's back: +x/+z side), a wider crest, and a brighter
    // + thicker shield rim so the DROPPED shield still reads as a
    // bright-edged slab on the ground.
    const steel = std(0x9298a1, { rough: 0.55, metal: 0.45 });
    const steelDark = std(0x61656e, { rough: 0.6, metal: 0.4 });
    const red = std(0xff4d3d, { rough: 0.7 });
    const redGlow = std(0xff4d3d, { emissive: 0xff2a00, ei: 1.6 });

    legL = piv(0, 1.05 * s, 0.42 * s);
    cyl(legL, 0.26 * s, 0.28 * s, 0.95 * s, steelDark, 0, -0.5 * s, 0);
    box(legL, 0.5 * s, 0.22 * s, 0.62 * s, steelDark, -0.08 * s, -0.95 * s, 0);
    legR = piv(0, 1.05 * s, -0.42 * s);
    cyl(legR, 0.26 * s, 0.28 * s, 0.95 * s, steelDark, 0, -0.5 * s, 0);
    box(legR, 0.5 * s, 0.22 * s, 0.62 * s, steelDark, -0.08 * s, -0.95 * s, 0);

    body = box(inner, 0.95 * s, 1.15 * s, 1.35 * s, steel, 0, 1.6 * s, 0);
    reg(body);
    // Chest plate + red chest stripe (the accent colour).
    box(inner, 0.1 * s, 0.9 * s, 1.0 * s, steelDark, -0.5 * s, 1.62 * s, 0);
    box(inner, 0.06 * s, 0.14 * s, 1.02 * s, red, -0.54 * s, 1.9 * s, 0);
    // R4B: red BACK stripe — mirror of the front stripe on the +x face,
    // so the ironhide carries its red accent from the camera side too.
    box(inner, 0.1 * s, 0.9 * s, 1.0 * s, steelDark, 0.5 * s, 1.62 * s, 0);
    box(inner, 0.06 * s, 0.14 * s, 1.02 * s, red, 0.54 * s, 1.9 * s, 0);
    box(inner, 0.98 * s, 0.14 * s, 1.38 * s, steelDark, 0, 1.08 * s, 0);
    // Pauldrons.
    ball(inner, 0.42 * s, steel, 0, 2.2 * s, 0.72 * s);
    ball(inner, 0.42 * s, steel, 0, 2.2 * s, -0.72 * s);
    box(inner, 0.5 * s, 0.16 * s, 0.55 * s, red, 0, 2.55 * s, 0.72 * s);
    box(inner, 0.5 * s, 0.16 * s, 0.55 * s, red, 0, 2.55 * s, -0.72 * s);

    armL = piv(0, 2.15 * s, 0.8 * s, 0.15, 0, 0);
    cap(armL, 0.2 * s, 0.5 * s, steel, 0, -0.35 * s, 0);
    ball(armL, 0.22 * s, steelDark, 0, -0.72 * s, 0);
    armR = piv(0, 2.15 * s, -0.8 * s, -0.15, 0, 0);
    cap(armR, 0.2 * s, 0.5 * s, steel, 0, -0.35 * s, 0);
    ball(armR, 0.22 * s, steelDark, 0, -0.72 * s, 0);
    // Mace in the right hand.
    cyl(armR, 0.06 * s, 0.06 * s, 0.7 * s, std(0x4a3a2e), 0, -0.95 * s, 0);
    ball(armR, 0.2 * s, steelDark, 0, -1.32 * s, 0);
    cone(armR, 0.12 * s, 0.22 * s, steelDark, 0, -1.55 * s, 0, Math.PI, 0, 0);

    // Tower shield: separate mesh, left side (+z), held forward.
    const shield = new THREE.Group();
    shield.position.set(-0.55 * s, 1.45 * s, 1.05 * s);
    shield.rotation.set(0, 0, 0.06);
    inner.add(shield);
    reg(shield);
    box(shield, 0.14 * s, 1.7 * s, 1.0 * s, steel, 0, 0, 0);
    box(shield, 0.06 * s, 1.5 * s, 0.22 * s, red, -0.09 * s, 0, 0);
    ball(shield, 0.26 * s, red, -0.1 * s, 0, 0);
    // ROUND 3 AGENT B (item 11, Rizal): the dark rim trim let ironhides
    // merge into the Titan's dark mass at 320px. Bright steel rim instead
    // — each ironhide carries a light outline that separates it from its
    // neighbours and from the boss.
    // R4B: rim brighter (0xb8bcc4 -> 0xd8dce4) + thicker (0.16 -> 0.22), so
    // it survives at action distance AND on the dropped shield.
    const rimBright = std(0xd8dce4, { rough: 0.4, metal: 0.6 });
    box(shield, 0.22 * s, 0.1 * s, 1.02 * s, rimBright, 0, 0.82 * s, 0);
    box(shield, 0.22 * s, 0.1 * s, 1.02 * s, rimBright, 0, -0.82 * s, 0);
    // Vertical rim on both side edges too — a full light frame around the
    // shield, so the ironhide outline reads even inside a tight group.
    box(shield, 0.22 * s, 1.66 * s, 0.1 * s, rimBright, 0, 0, 0.47 * s);
    box(shield, 0.22 * s, 1.66 * s, 0.1 * s, rimBright, 0, 0, -0.47 * s);
    parts.shield = shield;

    head = piv(0, 2.5 * s, 0);
    box(head, 0.55 * s, 0.5 * s, 0.55 * s, steel, 0, 0, 0);
    box(head, 0.6 * s, 0.12 * s, 0.6 * s, steelDark, 0, -0.28 * s, 0);
    // Red crest fin on top + spike (tallest point).
    // ROUND 3 AGENT B (item 11): crest taller so the ironhide silhouette
    // reads at 320px even inside a group.
    // R4B: crest WIDER too (0.08 -> 0.12 wide, 0.5 -> 0.62 long) — the
    // crest is the ironhide's topmost silhouette and reads from behind.
    box(head, 0.12 * s, 0.4 * s, 0.62 * s, red, 0, 0.4 * s, 0);
    cone(head, 0.12 * s, 0.42 * s, steelDark, 0, 0.55 * s, 0);
    // Slit eyes: glowing red.
    box(head, 0.03 * s, 0.05 * s, 0.16 * s, redGlow, -0.29 * s, 0.05 * s, 0.13 * s);
    box(head, 0.03 * s, 0.05 * s, 0.16 * s, redGlow, -0.29 * s, 0.05 * s, -0.13 * s);
    box(head, 0.03 * s, 0.04 * s, 0.3 * s, steelDark, -0.29 * s, -0.12 * s, 0);
  }

  if (kind === 'saboteur') {
    // Hunched digger ("Fuse-Eater"): purple robe, helmet with a lamp,
    // lit fuse curving up its back, toothy grin, green glow accent.
    // P5: the 0.75x body vanished at distance — brighter robe + bigger,
    // hotter lamp so the telegraph reads in the wide preset.
    const robe = std(0x6b5aa8, { rough: 0.95 });
    const dark = std(0x2e2447, { rough: 0.95 });
    // ROUND 3 AGENT B (item 11, Rizal): the helmet lamp was a 1px dot at
    // 320px. Bigger + hotter so each saboteur carries a distinct green point.
    const lampMat = std(0x7ed957, { emissive: 0x4caf2a, ei: 3.2 });
    const fuseMat = std(0x8a6a3a, { rough: 0.9 });

    legL = piv(0, 0.55 * s, 0.25 * s);
    cap(legL, 0.12 * s, 0.3 * s, dark, 0, -0.18 * s, 0);
    box(legL, 0.22 * s, 0.1 * s, 0.3 * s, dark, -0.05 * s, -0.38 * s, 0);
    legR = piv(0, 0.55 * s, -0.25 * s);
    cap(legR, 0.12 * s, 0.3 * s, dark, 0, -0.18 * s, 0);
    box(legR, 0.22 * s, 0.1 * s, 0.3 * s, dark, -0.05 * s, -0.38 * s, 0);

    body = cone(inner, 0.62 * s, 1.5 * s, robe, 0.08 * s, 0.85 * s, 0);
    reg(body);
    // Hunch: the whole upper body leans forward toward -x.
    body.rotation.z = 0.22;
    body.userData.baseRot = { x: 0, y: 0, z: 0.22 };
    // Rope belt.
    cyl(inner, 0.5 * s, 0.52 * s, 0.1 * s, fuseMat, 0.05 * s, 0.95 * s, 0);

    armL = piv(-0.1 * s, 1.55 * s, 0.5 * s, 0.15, 0, 0.15);
    cap(armL, 0.11 * s, 0.55 * s, robe, 0, -0.32 * s, 0);
    ball(armL, 0.12 * s, dark, 0, -0.65 * s, 0);
    armR = piv(-0.1 * s, 1.55 * s, -0.5 * s, -0.15, 0, 0.15);
    cap(armR, 0.11 * s, 0.55 * s, robe, 0, -0.32 * s, 0);
    ball(armR, 0.12 * s, dark, 0, -0.65 * s, 0);

    head = piv(-0.15 * s, 1.95 * s, 0);
    ball(head, 0.42 * s, std(0x6b5a7a, { rough: 0.9 }), 0, 0, 0);
    // Helmet: squashed dome + lamp on the front.
    const helm = ball(head, 0.45 * s, dark, 0, 0.16 * s, 0);
    helm.scale.set(1, 0.62, 1);
    cyl(head, 0.05 * s, 0.05 * s, 0.16 * s, dark, -0.42 * s, 0.22 * s, 0);
    const lamp = box(head, 0.22 * s, 0.22 * s, 0.22 * s, lampMat, -0.5 * s, 0.26 * s, 0);
    flicker.push({ obj: lamp, kind: 'emissive', mat: lampMat, base: 2.0, amp: 0.25, speed: 7, phase: rng() * 6 });
    // Green glowing eyes.
    ball(head, 0.11 * s, std(0x7ed957, { emissive: 0x4caf2a, ei: 1.8 }), -0.38 * s, 0.06 * s, 0.16 * s);
    ball(head, 0.11 * s, std(0x7ed957, { emissive: 0x4caf2a, ei: 1.8 }), -0.38 * s, 0.06 * s, -0.16 * s);
    // Toothy grin: dark mouth + three white teeth.
    box(head, 0.04 * s, 0.12 * s, 0.3 * s, std(0x140a06), -0.41 * s, -0.18 * s, 0);
    for (let i = -1; i <= 1; i += 1) {
      box(head, 0.03 * s, 0.06 * s, 0.07 * s, std(0xffffff, { rough: 0.4 }), -0.43 * s, -0.15 * s, i * 0.1 * s);
    }

    // Lit fuse on the back: a curved tube rising above the head, with a
    // glowing green tip (the tallest point of the silhouette).
    const fuse = new THREE.Group();
    fuse.position.set(0.3 * s, 2.65 * s, 0);
    inner.add(fuse);
    const fuseTube = mesh(
      fuse,
      new THREE.TorusGeometry(0.5 * s, 0.06 * s, 8, 20, 4.2),
      fuseMat, 0, 0, 0
    );
    fuseTube.rotation.z = 2.0;
    const tip = ball(fuse, 0.1 * s, lampMat, -0.19 * s, 0.41 * s, 0);
    flicker.push({ obj: tip, kind: 'scale', base: 1, amp: 0.3, speed: 11, phase: rng() * 6 });
    parts.fuse = fuse;
  }

  if (kind === 'titan') {
    // THE CINDER TITAN: furnace golem, 4x scale. Wide shoulders, chimney
    // on the back, glowing furnace core in the chest, crown of embers,
    // huge arms. Must read as a BOSS at a glance.
    // ROUND 5 AGENT B (item #3, Mark 01:37 WIB): the Titan read as a
    // near-black blob in the action frame — dark iron (0x2b2b2b, metal
    // 0.35) eats the golden-hour light on every face the camera sees
    // (proven by verify-3d/capture-titan.jpg: body black, only the core /
    // eyes / crown glow). Warm ember-iron instead: the body now reads as
    // hot rusted iron, the core is bigger + hotter, and glowing ember
    // seams wrap the camera-facing sides (front -x + south +z) — the
    // cinderling lesson: ember must wrap the creature, not sit on its
    // hidden back. Model scale UNCHANGED (4.0x); sim untouched.
    const iron = std(0x7a5238, { rough: 0.6, metal: 0.15 });
    const ironDark = std(0x54382a, { rough: 0.75, metal: 0.15 });
    const brass = std(0xc9a227, { rough: 0.45, metal: 0.6 });
    const emberMat = std(0xff7a1a, { emissive: 0xff5a00, ei: 2.6 });
    coreMat = std(0xff7a1a, { emissive: 0xff5a00, ei: 3.2, rough: 0.4 });

    legL = piv(0, 1.0 * s, 0.55 * s);
    cyl(legL, 0.4 * s, 0.44 * s, 0.9 * s, iron, 0, -0.5 * s, 0);
    box(legL, 0.7 * s, 0.3 * s, 0.95 * s, ironDark, -0.1 * s, -0.92 * s, 0);
    legR = piv(0, 1.0 * s, -0.55 * s);
    cyl(legR, 0.4 * s, 0.44 * s, 0.9 * s, iron, 0, -0.5 * s, 0);
    box(legR, 0.7 * s, 0.3 * s, 0.95 * s, ironDark, -0.1 * s, -0.92 * s, 0);

    body = box(inner, 1.3 * s, 1.3 * s, 1.7 * s, iron, 0, 1.75 * s, 0);
    reg(body);
    box(inner, 1.34 * s, 0.5 * s, 1.74 * s, ironDark, 0, 1.25 * s, 0);
    // Furnace core: glowing circle on the chest front (-x) + brass ring.
    // R5B: bigger (0.34s -> 0.44s) + hotter (flicker base 2.2 -> 3.2) so
    // the furnace reads at 320px, not just at close-up.
    const core = mesh(inner, new THREE.CircleGeometry(0.44 * s, 20), coreMat, -0.67 * s, 1.8 * s, 0);
    core.rotation.y = -Math.PI / 2;
    const ring = mesh(inner, new THREE.TorusGeometry(0.48 * s, 0.07 * s, 8, 24), brass, -0.67 * s, 1.8 * s, 0);
    ring.rotation.y = Math.PI / 2;
    flicker.push({ obj: core, kind: 'emissive', mat: coreMat, base: 3.2, amp: 0.25, speed: 5, phase: rng() * 6 });
    parts.core = core;
    // Damage cracks (hidden until damageState >= 1).
    const crackMat = std(0x0d0d0d, { rough: 1 });
    for (const [cy, cz, rz] of [[2.2, 0.5, 0.5], [1.5, -0.4, -0.7], [2.0, 0, 0.2]]) {
      const c = box(inner, 0.03 * s, 0.5 * s, 0.08 * s, crackMat, -0.66 * s, cy * s, cz * s, 0, 0, rz);
      c.visible = false;
      cracks.push(c);
    }
    // R5B: ember seams — glowing cracks wrapping the CAMERA-facing sides
    // (front -x + south +z). Always visible: the Titan is a furnace, its
    // seams glow even at full HP (the damage cracks above stay gated).
    // Body face is x -0.65s / z +0.85s; seams sit half-embedded like the
    // damage cracks, so no z-fighting.
    const seam = (w, h, d, x, y, z, rz = 0) => box(inner, w, h, d, emberMat, x, y, z, 0, 0, rz);
    seam(0.04 * s, 0.55 * s, 0.07 * s, -0.66 * s, 1.35 * s, 0.55 * s, 0.15);
    seam(0.04 * s, 0.5 * s, 0.07 * s, -0.66 * s, 2.15 * s, -0.5 * s, -0.2);
    seam(0.04 * s, 0.4 * s, 0.07 * s, -0.66 * s, 1.15 * s, -0.55 * s, 0.5);
    seam(0.07 * s, 0.5 * s, 0.04 * s, 0.25 * s, 1.5 * s, 0.86 * s, 0.2);
    seam(0.07 * s, 0.45 * s, 0.04 * s, -0.3 * s, 2.1 * s, 0.86 * s, -0.25);

    // Wide shoulders + spikes.
    ball(inner, 0.55 * s, iron, 0, 2.45 * s, 1.0 * s);
    ball(inner, 0.55 * s, iron, 0, 2.45 * s, -1.0 * s);
    cone(inner, 0.2 * s, 0.5 * s, emberMat, 0, 2.95 * s, 1.0 * s);
    cone(inner, 0.2 * s, 0.5 * s, emberMat, 0, 2.95 * s, -1.0 * s);

    armL = piv(0, 2.4 * s, 1.02 * s, 0.2, 0, 0);
    cap(armL, 0.32 * s, 0.85 * s, iron, 0, -0.55 * s, 0);
    ball(armL, 0.4 * s, ironDark, 0, -1.15 * s, 0);
    ball(armL, 0.14 * s, emberMat, -0.38 * s, -1.15 * s, 0); // ember knuckle
    armR = piv(0, 2.4 * s, -1.02 * s, -0.2, 0, 0);
    cap(armR, 0.32 * s, 0.85 * s, iron, 0, -0.55 * s, 0);
    ball(armR, 0.4 * s, ironDark, 0, -1.15 * s, 0);
    ball(armR, 0.14 * s, emberMat, -0.38 * s, -1.15 * s, 0);

    // Chimney on the back (+x side), with a glowing ember cap.
    const chimney = new THREE.Group();
    chimney.position.set(0.55 * s, 2.6 * s, 0.35 * s);
    inner.add(chimney);
    reg(chimney);
    cyl(chimney, 0.28 * s, 0.32 * s, 0.9 * s, ironDark, 0, 0, 0);
    cyl(chimney, 0.34 * s, 0.34 * s, 0.12 * s, brass, 0, 0.48 * s, 0);
    cyl(chimney, 0.24 * s, 0.24 * s, 0.08 * s, emberMat, 0, 0.55 * s, 0);
    parts.chimney = chimney;

    head = piv(0, 2.7 * s, 0);
    ball(head, 0.48 * s, iron, 0, 0, 0);
    // Jaw plate.
    box(head, 0.3 * s, 0.22 * s, 0.5 * s, ironDark, -0.3 * s, -0.3 * s, 0);
    // Crown of embers: 5 spikes around the top.
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      const cx = Math.cos(a) * 0.3 * s;
      const cz = Math.sin(a) * 0.3 * s;
      cone(head, 0.1 * s, 0.24 * s, emberMat, cx, 0.5 * s, cz, range(rng, -0.15, 0.15), 0, range(rng, -0.15, 0.15));
    }
    emberEye(head, -0.42 * s, 0.08 * s, 0.2 * s, 0.15 * s);
    emberEye(head, -0.42 * s, 0.08 * s, -0.2 * s, 0.15 * s);
    // Heavy brow + dark mouth with ember teeth.
    box(head, 0.08 * s, 0.1 * s, 0.56 * s, ironDark, -0.44 * s, 0.22 * s, 0);
    box(head, 0.04 * s, 0.1 * s, 0.34 * s, std(0x0d0d0d), -0.46 * s, -0.18 * s, 0);
    box(head, 0.03 * s, 0.06 * s, 0.08 * s, emberMat, -0.48 * s, -0.14 * s, 0.1 * s);
    box(head, 0.03 * s, 0.06 * s, 0.08 * s, emberMat, -0.48 * s, -0.14 * s, -0.1 * s);
  }

  // =========================================================================
  // THE GARRISON (defenders — warm / bright colours)
  // =========================================================================

  if (kind === 'wren') {
    // Captain Wren: navy coat, gold epaulettes, wide-brim hat with gold
    // band (the big accessory), sword at hip, expressive face.
    // Item 4: navy brightened one step (0x1f3a6e -> 0x2a4d8f) — the dark
    // navy read as a black blob against the wall shadow at eagle distance.
    const navy = std(0x2a4d8f, { rough: 0.85 });
    const navyDark = std(0x1d3560, { rough: 0.9 });
    const gold = std(0xffc53d, { rough: 0.4, metal: 0.55 });
    const skin = std(0xe8b98a, { rough: 0.7 });

    legL = piv(0, 0.9 * s, 0.22 * s);
    cap(legL, 0.13 * s, 0.55 * s, navyDark, 0, -0.32 * s, 0);
    box(legL, 0.24 * s, 0.14 * s, 0.36 * s, std(0x2b2b2b), -0.04 * s, -0.72 * s, 0);
    legR = piv(0, 0.9 * s, -0.22 * s);
    cap(legR, 0.13 * s, 0.55 * s, navyDark, 0, -0.32 * s, 0);
    box(legR, 0.24 * s, 0.14 * s, 0.36 * s, std(0x2b2b2b), -0.04 * s, -0.72 * s, 0);

    body = box(inner, 0.7 * s, 1.1 * s, 0.85 * s, navy, 0, 1.45 * s, 0);
    reg(body);
    cone(inner, 0.55 * s, 0.6 * s, navy, 0, 0.75 * s, 0); // coat skirt
    // Gold buttons down the front + belt.
    for (let i = 0; i < 3; i += 1) {
      ball(inner, 0.05 * s, gold, -0.36 * s, (1.2 + i * 0.25) * s, 0);
    }
    box(inner, 0.72 * s, 0.12 * s, 0.87 * s, navyDark, 0, 1.05 * s, 0);
    box(inner, 0.06 * s, 0.1 * s, 0.16 * s, gold, -0.37 * s, 1.05 * s, 0);
    // Gold epaulettes.
    box(inner, 0.25 * s, 0.08 * s, 0.4 * s, gold, 0, 2.05 * s, 0.5 * s);
    box(inner, 0.25 * s, 0.08 * s, 0.4 * s, gold, 0, 2.05 * s, -0.5 * s);
    // Sword at the left hip (+z), hanging vertically.
    const sword = new THREE.Group();
    sword.position.set(0.1 * s, 0.9 * s, 0.55 * s);
    sword.rotation.z = 0.12;
    inner.add(sword);
    box(sword, 0.05 * s, 0.85 * s, 0.1 * s, std(0xb8bcc4, { rough: 0.35, metal: 0.6 }), 0, 0, 0);
    ball(sword, 0.07 * s, gold, 0, 0.48 * s, 0);
    cyl(sword, 0.04 * s, 0.04 * s, 0.18 * s, std(0x4a3a2e), 0, 0.6 * s, 0);
    parts.sword = sword;

    armL = piv(0, 1.95 * s, 0.48 * s, 0.12, 0, 0);
    cap(armL, 0.12 * s, 0.5 * s, navy, 0, -0.3 * s, 0);
    ball(armL, 0.12 * s, skin, 0, -0.62 * s, 0);
    armR = piv(0, 1.95 * s, -0.48 * s, -0.12, 0, 0.25);
    cap(armR, 0.12 * s, 0.5 * s, navy, 0, -0.3 * s, 0);
    ball(armR, 0.12 * s, skin, 0, -0.62 * s, 0);

    head = piv(0, 2.5 * s, 0);
    ball(head, 0.42 * s, skin, 0, 0, 0);
    // Wide-brim hat with gold band — the big accessory.
    cyl(head, 0.62 * s, 0.62 * s, 0.06 * s, navyDark, 0, 0.36 * s, 0, 0, 0, 0, 20);
    const dome = ball(head, 0.34 * s, navyDark, 0, 0.42 * s, 0);
    dome.scale.set(1, 0.75, 1);
    const band = mesh(head, new THREE.TorusGeometry(0.35 * s, 0.045 * s, 8, 20), gold, 0, 0.4 * s, 0);
    band.rotation.x = Math.PI / 2;
    // Face: eyes, brows, nose, toggleable mouth.
    plainEye(head, -0.34 * s, 0.06 * s, 0.16 * s, 0.095 * s);
    plainEye(head, -0.34 * s, 0.06 * s, -0.16 * s, 0.095 * s);
    box(head, 0.04 * s, 0.04 * s, 0.16 * s, std(0x4a3a2e), -0.36 * s, 0.2 * s, 0.16 * s);
    box(head, 0.04 * s, 0.04 * s, 0.16 * s, std(0x4a3a2e), -0.36 * s, 0.2 * s, -0.16 * s);
    ball(head, 0.06 * s, skin, -0.42 * s, -0.04 * s, 0);
    const smile = mouthArc(head, -0.38 * s, -0.16 * s, 0, 0.1 * s, 0.025 * s, true);
    const frown = mouthArc(head, -0.38 * s, -0.14 * s, 0, 0.1 * s, 0.025 * s, false);
    frown.visible = false;
    parts.mouthSmile = smile;
    parts.mouthFrown = frown;
  }

  if (kind === 'pip') {
    // Small powder-monkey: brown + orange, tiny cap, powder keg on his
    // back, big eyes.
    const brown = std(0x8a5a2b, { rough: 0.9 });
    const brownDark = std(0x5a3d1e, { rough: 0.9 });
    const orange = std(0xff7a1a, { rough: 0.8 });
    const skin = std(0xe8b98a, { rough: 0.7 });

    legL = piv(0, 0.45 * s, 0.24 * s);
    cap(legL, 0.09 * s, 0.2 * s, brownDark, 0, -0.14 * s, 0);
    ball(legL, 0.11 * s, brownDark, -0.02 * s, -0.3 * s, 0);
    legR = piv(0, 0.45 * s, -0.24 * s);
    cap(legR, 0.09 * s, 0.2 * s, brownDark, 0, -0.14 * s, 0);
    ball(legR, 0.11 * s, brownDark, -0.02 * s, -0.3 * s, 0);

    body = ball(inner, 0.62 * s, brown, 0, 1.0 * s, 0);
    reg(body);
    // Orange scarf ring around the neck.
    const scarf = mesh(inner, new THREE.TorusGeometry(0.5 * s, 0.12 * s, 8, 18), orange, 0, 1.55 * s, 0);
    scarf.rotation.x = Math.PI / 2;
    box(inner, 0.16 * s, 0.3 * s, 0.1 * s, orange, 0.35 * s, 1.4 * s, 0.3 * s, 0, 0, 0.3);

    armL = piv(0, 1.35 * s, 0.55 * s, 0.3, 0, 0);
    cap(armL, 0.08 * s, 0.25 * s, brown, 0, -0.18 * s, 0);
    armR = piv(0, 1.35 * s, -0.55 * s, -0.3, 0, 0);
    cap(armR, 0.08 * s, 0.25 * s, brown, 0, -0.18 * s, 0);

    // Powder keg on the back (+x side), with brass bands + a short fuse.
    const keg = new THREE.Group();
    keg.position.set(0.5 * s, 1.9 * s, 0);
    keg.rotation.z = 0.25;
    inner.add(keg);
    cyl(keg, 0.42 * s, 0.42 * s, 0.65 * s, std(0x8a5a2b, { rough: 0.85 }), 0, 0, 0, 0, 0, Math.PI / 2);
    for (const bx of [-0.22, 0.22]) {
      const band = mesh(keg, new THREE.TorusGeometry(0.43 * s, 0.035 * s, 8, 20), std(0xc9a227, { metal: 0.6, rough: 0.4 }), bx * s, 0, 0);
      band.rotation.y = Math.PI / 2;
    }
    cyl(keg, 0.04 * s, 0.04 * s, 0.3 * s, std(0x8a6a3a), 0.3 * s, 0.3 * s, 0, 0, 0, 0.5);
    const spark = ball(keg, 0.06 * s, std(0xffd23f, { emissive: 0xffb020, ei: 2.2 }), 0.42 * s, 0.44 * s, 0);
    flicker.push({ obj: spark, kind: 'scale', base: 1, amp: 0.35, speed: 12, phase: rng() * 6 });
    parts.keg = keg;

    head = piv(0, 2.25 * s, 0);
    ball(head, 0.62 * s, skin, 0, 0, 0);
    // Tiny cap + hair tuft (tallest point).
    cyl(head, 0.4 * s, 0.42 * s, 0.12 * s, orange, 0, 0.58 * s, 0);
    box(head, 0.3 * s, 0.05 * s, 0.4 * s, orange, -0.45 * s, 0.54 * s, 0);
    cone(head, 0.12 * s, 0.22 * s, brownDark, 0.1 * s, 0.72 * s, 0, 0, 0, range(rng, -0.2, 0.2));
    // Big eyes — the whole point of Pip.
    plainEye(head, -0.5 * s, 0.1 * s, 0.22 * s, 0.17 * s);
    plainEye(head, -0.5 * s, 0.1 * s, -0.22 * s, 0.17 * s);
    mouthArc(head, -0.55 * s, -0.22 * s, 0, 0.09 * s, 0.022 * s, true);
    ball(head, 0.05 * s, skin, -0.6 * s, -0.05 * s, 0);
  }

  if (kind === 'thom') {
    // Old Thom: veteran, grey/white beard, grey coat, musket in hand,
    // weathered face.
    const grey = std(0x8a8a8a, { rough: 0.95 });
    const greyDark = std(0x5a5a5a, { rough: 0.95 });
    const white = std(0xf0ede4, { rough: 0.95 });
    const skin = std(0xd8a878, { rough: 0.75 });
    const wood = std(0x6b4a2e, { rough: 0.9 });
    // Item 4 (defender visibility): crimson sash + cap band — Thom is the
    // biggest defender and jumps above the parapet in celebrate, so a
    // high-contrast red element is what reads at eagle distance. Grey coat
    // kept (veteran identity); only the accent is bright.
    const crimson = std(0xc03028, { rough: 0.8 });

    legL = piv(0, 0.95 * s, 0.24 * s);
    cap(legL, 0.14 * s, 0.6 * s, greyDark, 0, -0.35 * s, 0);
    box(legL, 0.26 * s, 0.14 * s, 0.38 * s, std(0x2b2b2b), -0.04 * s, -0.78 * s, 0);
    legR = piv(0, 0.95 * s, -0.24 * s);
    cap(legR, 0.14 * s, 0.6 * s, greyDark, 0, -0.35 * s, 0);
    box(legR, 0.26 * s, 0.14 * s, 0.38 * s, std(0x2b2b2b), -0.04 * s, -0.78 * s, 0);

    body = box(inner, 0.75 * s, 1.2 * s, 0.9 * s, grey, 0, 1.5 * s, 0);
    reg(body);
    box(inner, 0.78 * s, 0.16 * s, 0.92 * s, greyDark, 0, 1.0 * s, 0);
    // Collar + satchel strap.
    box(inner, 0.5 * s, 0.14 * s, 0.6 * s, white, 0, 2.08 * s, 0);
    box(inner, 0.1 * s, 1.0 * s, 0.92 * s, std(0x4a3a2e), -0.05 * s, 1.55 * s, 0, 0, 0, 0.35);
    // Item 4: crimson sash crossing the strap (opposite diagonal, slightly
    // proud) — the red X on the chest is Thom's high-contrast marker.
    box(inner, 0.12 * s, 1.05 * s, 0.94 * s, crimson, -0.06 * s, 1.55 * s, 0, 0, 0, -0.35);

    armL = piv(0, 1.95 * s, 0.5 * s, 0.12, 0, 0);
    cap(armL, 0.13 * s, 0.5 * s, grey, 0, -0.3 * s, 0);
    ball(armL, 0.12 * s, skin, 0, -0.62 * s, 0);
    armR = piv(0, 1.95 * s, -0.5 * s, -0.12, 0, 0.1);
    cap(armR, 0.13 * s, 0.5 * s, grey, 0, -0.3 * s, 0);
    ball(armR, 0.12 * s, skin, 0, -0.62 * s, 0);
    // Musket held upright in the right hand — tallest point.
    const musket = new THREE.Group();
    musket.position.set(0, -0.5 * s, 0);
    armR.add(musket);
    cyl(musket, 0.045 * s, 0.045 * s, 1.9 * s, std(0x3a3a3a, { metal: 0.5, rough: 0.5 }), 0, 0.45 * s, 0);
    box(musket, 0.09 * s, 0.8 * s, 0.12 * s, wood, 0, -0.25 * s, 0);
    cyl(musket, 0.06 * s, 0.06 * s, 0.1 * s, std(0xc9a227, { metal: 0.6, rough: 0.4 }), 0, 1.33 * s, 0);
    parts.musket = musket;

    head = piv(0, 2.55 * s, 0);
    ball(head, 0.4 * s, skin, 0, 0, 0);
    // White beard: cone pointing down + side puffs. Kept clear of the eyes:
    // the cone top used to reach y=+0.07s, merging with the white eyeballs
    // and eyebrows into one unreadable white blob (found 06:45 WIB).
    cone(head, 0.28 * s, 0.7 * s, white, -0.32 * s, -0.38 * s, 0, Math.PI, 0, 0.15);
    ball(head, 0.14 * s, white, -0.3 * s, -0.2 * s, 0.18 * s);
    ball(head, 0.14 * s, white, -0.3 * s, -0.2 * s, -0.18 * s);
    // Bushy white eyebrows + weathered eyes. Eyes enlarged 0.08s -> 0.12s
    // and pushed out to x=-0.36s so the pupils clear the brow shadow.
    box(head, 0.04 * s, 0.05 * s, 0.18 * s, white, -0.37 * s, 0.16 * s, 0.15 * s);
    box(head, 0.04 * s, 0.05 * s, 0.18 * s, white, -0.37 * s, 0.16 * s, -0.15 * s);
    plainEye(head, -0.36 * s, 0.05 * s, 0.15 * s, 0.12 * s);
    plainEye(head, -0.36 * s, 0.05 * s, -0.15 * s, 0.12 * s);
    box(head, 0.04 * s, 0.05 * s, 0.24 * s, std(0x8a8a8a), -0.38 * s, -0.14 * s, 0);
    // Flat cap.
    cyl(head, 0.42 * s, 0.44 * s, 0.1 * s, greyDark, 0, 0.38 * s, 0);
    // Item 4: crimson cap band — red ring around the cap base, reads above
    // the parapet at eagle distance.
    cyl(head, 0.45 * s, 0.45 * s, 0.045 * s, crimson, 0, 0.33 * s, 0);
    box(head, 0.3 * s, 0.04 * s, 0.36 * s, greyDark, -0.42 * s, 0.34 * s, 0);
    // White hair at the back.
    ball(head, 0.2 * s, white, 0.3 * s, 0.1 * s, 0);
  }

  if (kind === 'mira') {
    // Mira: engineer, teal coat, brass goggles on forehead, wrench in
    // hand, hair bun, brass fan-crank at her side.
    const teal = std(0x1f7a6e, { rough: 0.85 });
    const tealDark = std(0x155a50, { rough: 0.9 });
    const brass = std(0xc9a227, { rough: 0.4, metal: 0.6 });
    const skin = std(0xe8b98a, { rough: 0.7 });
    const hairMat = std(0x4a2e1a, { rough: 0.9 });

    legL = piv(0, 0.85 * s, 0.22 * s);
    cap(legL, 0.13 * s, 0.55 * s, tealDark, 0, -0.32 * s, 0);
    box(legL, 0.24 * s, 0.14 * s, 0.36 * s, std(0x2b2b2b), -0.04 * s, -0.7 * s, 0);
    legR = piv(0, 0.85 * s, -0.22 * s);
    cap(legR, 0.13 * s, 0.55 * s, tealDark, 0, -0.32 * s, 0);
    box(legR, 0.24 * s, 0.14 * s, 0.36 * s, std(0x2b2b2b), -0.04 * s, -0.7 * s, 0);

    body = box(inner, 0.7 * s, 1.15 * s, 0.85 * s, teal, 0, 1.4 * s, 0);
    reg(body);
    // Brass buttons + tool belt.
    for (let i = 0; i < 3; i += 1) {
      ball(inner, 0.05 * s, brass, -0.36 * s, (1.15 + i * 0.25) * s, 0);
    }
    box(inner, 0.72 * s, 0.12 * s, 0.87 * s, tealDark, 0, 1.0 * s, 0);
    // Brass fan-crank at her left side (+z): disc + 3 fan blades + handle.
    const crank = new THREE.Group();
    crank.position.set(0.15 * s, 1.1 * s, 0.55 * s);
    inner.add(crank);
    cyl(crank, 0.22 * s, 0.22 * s, 0.06 * s, brass, 0, 0, 0, Math.PI / 2, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * Math.PI * 2;
      box(crank, 0.05 * s, 0.16 * s, 0.02 * s, brass, Math.cos(a) * 0.1 * s, Math.sin(a) * 0.1 * s, 0.05 * s, 0, 0, a + 0.5);
    }
    box(crank, 0.05 * s, 0.2 * s, 0.05 * s, brass, 0.12 * s, -0.14 * s, 0.08 * s, 0, 0, 0.4);
    cyl(crank, 0.035 * s, 0.035 * s, 0.14 * s, std(0x4a3a2e), 0.2 * s, -0.2 * s, 0.08 * s, 0, 0, Math.PI / 2);
    parts.crank = crank;

    armL = piv(0, 1.9 * s, 0.48 * s, 0.12, 0, 0);
    cap(armL, 0.12 * s, 0.5 * s, teal, 0, -0.3 * s, 0);
    ball(armL, 0.12 * s, skin, 0, -0.62 * s, 0);
    armR = piv(0, 1.9 * s, -0.48 * s, -0.12, 0, 0.1);
    cap(armR, 0.12 * s, 0.5 * s, teal, 0, -0.3 * s, 0);
    ball(armR, 0.12 * s, skin, 0, -0.62 * s, 0);
    // Wrench in the right hand.
    const wrench = new THREE.Group();
    wrench.position.set(0, -0.62 * s, 0);
    armR.add(wrench);
    box(wrench, 0.06 * s, 0.5 * s, 0.06 * s, brass, 0, 0, 0);
    const jaw = mesh(wrench, new THREE.TorusGeometry(0.12 * s, 0.045 * s, 8, 14, 4.5), brass, 0, 0.3 * s, 0);
    jaw.rotation.set(0, 0, 0.6);
    parts.wrench = wrench;

    head = piv(0, 2.45 * s, 0);
    ball(head, 0.4 * s, skin, 0, 0, 0);
    // Hair: cap of brown + bun at the back-top.
    const hair = ball(head, 0.42 * s, hairMat, 0.06 * s, 0.12 * s, 0);
    hair.scale.set(1, 0.85, 1);
    ball(head, 0.18 * s, hairMat, 0.32 * s, 0.28 * s, 0);
    // Brass goggles pushed up on the forehead.
    for (const side of [-1, 1]) {
      const lens = mesh(head, new THREE.TorusGeometry(0.11 * s, 0.03 * s, 8, 16), brass, -0.38 * s, 0.18 * s, side * 0.15 * s);
      lens.rotation.y = Math.PI / 2;
      cyl(head, 0.09 * s, 0.09 * s, 0.02 * s, std(0x9fd8e8, { rough: 0.2, metal: 0.3 }), -0.39 * s, 0.18 * s, side * 0.15 * s, 0, 0, Math.PI / 2);
    }
    box(head, 0.05 * s, 0.05 * s, 0.5 * s, hairMat, -0.1 * s, 0.2 * s, 0);
    plainEye(head, -0.33 * s, 0.02 * s, 0.16 * s, 0.09 * s);
    plainEye(head, -0.33 * s, 0.02 * s, -0.16 * s, 0.09 * s);
    mouthArc(head, -0.37 * s, -0.18 * s, 0, 0.09 * s, 0.022 * s, true);
    ball(head, 0.05 * s, skin, -0.4 * s, -0.06 * s, 0);
  }

  // -- shared parts ----------------------------------------------------------
  parts.head = head;
  parts.body = body;
  parts.armL = armL;
  parts.armR = armR;
  parts.legL = legL;
  parts.legR = legR;

  // Safety net: every mesh casts a shadow.
  group.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });

  // =========================================================================
  // setPose — pure function of (anim, t, params). Resets every joint to its
  // base transform first, so repeated calls never accumulate drift.
  // =========================================================================
  function setPose(anim, t, params) {
    const tt = typeof t === 'number' && Number.isFinite(t) ? t : 0;
    const p = params || {};

    for (const obj of resetList) {
      obj.position.copy(obj.userData.basePos);
      obj.rotation.set(obj.userData.baseRot.x, obj.userData.baseRot.y, obj.userData.baseRot.z);
      obj.scale.copy(obj.userData.baseScale);
    }
    inner.position.set(0, 0, 0);
    inner.rotation.set(0, 0, 0);

    const breathe = Math.sin(tt * 2.2);
    const swing = Math.sin(tt * 7);

    switch (anim) {
      case 'walk': {
        legL.rotation.z = 0.55 * swing;
        legR.rotation.z = -0.55 * swing;
        armL.rotation.z = -0.45 * swing;
        armR.rotation.z = 0.45 * swing;
        inner.position.y = Math.abs(Math.cos(tt * 7)) * 0.07 * s;
        inner.rotation.z = 0.05;
        head.rotation.z = 0.06 * swing;
        break;
      }
      case 'attack': {
        const pulse = Math.sin(tt * 6);
        inner.rotation.z = 0.16 + 0.04 * pulse;
        armR.rotation.z = 1.15 + 0.12 * pulse; // weapon arm lunges forward
        armL.rotation.z = -0.35;
        legL.rotation.z = 0.45;
        legR.rotation.z = -0.3;
        head.rotation.z = 0.1;
        break;
      }
      case 'dead': {
        inner.rotation.x = 1.35; // fall over sideways
        inner.position.y = -0.1 * s; // sink slightly, stay visible
        armL.rotation.z = 0.9;
        armR.rotation.z = -0.9;
        legL.rotation.z = 0.25;
        legR.rotation.z = -0.2;
        head.rotation.z = 0.3;
        break;
      }
      case 'celebrate': {
        inner.position.y = Math.abs(Math.sin(tt * 4)) * 0.35 * s; // jump
        armL.rotation.z = 2.2; // both arms up, forward
        armR.rotation.z = 2.2;
        armL.rotation.x = 0.4; // splayed outward
        armR.rotation.x = -0.4;
        legL.rotation.z = 0.25;
        legR.rotation.z = -0.25;
        head.rotation.z = -0.12;
        break;
      }
      case 'hurt': {
        const shake = (Math.sin(tt * 25) * 0.05 * s) / (1 + tt);
        inner.position.x = shake;
        inner.rotation.z = -0.22; // flinch backwards
        head.rotation.z = -0.18;
        armL.rotation.z = 0.7;
        armR.rotation.z = 0.7;
        break;
      }
      case 'idle':
      default: {
        body.scale.y = body.userData.baseScale.y * (1 + 0.03 * breathe);
        body.scale.x = body.userData.baseScale.x * (1 - 0.012 * breathe);
        head.position.y += 0.03 * s * Math.sin(tt * 2.2 + 0.6);
        armL.rotation.z = 0.06 * breathe;
        armR.rotation.z = -0.06 * breathe;
        inner.position.y = 0.02 * s * breathe;
        break;
      }
    }

    // Deterministic flicker: flames, lamp, fuse tip, keg spark, titan core.
    for (const f of flicker) {
      const v = Math.sin(tt * f.speed + f.phase);
      if (f.kind === 'scale') {
        const sv = f.base * (1 + f.amp * v);
        f.obj.scale.set(sv, sv, sv);
      } else if (f.kind === 'emissive' && f.mat) {
        f.mat.emissiveIntensity = f.base * (1 + f.amp * v);
      }
    }

    // -- params: expression / shield / damage (applied AFTER the anim) -----
    if (parts.mouthSmile && parts.mouthFrown) {
      const ex = p.expression || 'normal';
      const smiling = ex === 'normal' || ex === 'cheer';
      parts.mouthSmile.visible = smiling;
      parts.mouthFrown.visible = !smiling;
    }

    if (kind === 'ironhide' && parts.shield) {
      if (p.shieldBroken) {
        // Drop the tower shield on the ground beside the character.
        parts.shield.position.set(0.7 * s, 0.14 * s, 1.25 * s);
        parts.shield.rotation.set(1.35, 0.3, 0.5);
      }
    }

    if (kind === 'titan') {
      const ds = p.damageState || 0;
      if (parts.chimney) parts.chimney.visible = ds < 1;
      for (const c of cracks) c.visible = ds >= 1;
      if (coreMat) coreMat.emissiveIntensity *= ds >= 1 ? 0.35 : 1;
      if (ds >= 2 && armL) {
        // Left arm detaches and lies on the ground beside the Titan.
        armL.position.set(0.8 * s, 0.3 * s, 1.35 * s);
        armL.rotation.set(0.3, 0.5, 1.5);
      }
    }

    return group;
  }

  return { group, height, setPose, parts };
}
