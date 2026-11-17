// CHAINFIRE 3D — simulation. Pure logic: no DOM, no rendering, no wall
// clock, no audio calls. Written fresh for the 3D rebuild; mechanics and
// numbers are the VERIFIED 2D values, rescaled to 3D world units (data.js).
// Coordinates: x = approach axis (horde spawns at +x, walks to the wall at
// -x), z = lateral lanes, y = terrain height (read via terrainHeight).

import {
  WORLD, PX, POWDER_TYPES, POWDER_ORDER, ENEMY_TYPES, WAVES, DIFFICULTIES,
  DIFF_ORDER, CARD_DEFS, FEATS, SIM, BOSS, gradeFor, gradeChecklist
} from './data.js';
import { mulberry32, shuffleInPlace } from './rng.js';

const TYPE_TIER = { cinderling: 0, torchbearer: 1, ironhide: 2, saboteur: 3 };
const TYPE_LABEL = { cinderling: 'Cinderling', torchbearer: 'Torchbearer', ironhide: 'Ironhide', saboteur: 'Saboteur' };

function readBest() {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem('chainfire3d_best') : null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (err) {
    return 0;
  }
}

function writeBest(value) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem('chainfire3d_best', String(value));
  } catch (err) {
    // Storage is optional (headless tests).
  }
}

function pushEvent(world, type) {
  world.events.push({ type, time: world.time });
}

function pushPopup(world, popup) {
  world.popups.push(popup);
}

function currentWaveStats(world) {
  if (!world || !world.stats || !Array.isArray(world.stats.perWave)) return null;
  for (const entry of world.stats.perWave) {
    if (entry && entry.wave === world.wave) return entry;
  }
  const entry = { wave: world.wave, kills: 0, blasts: 0, kegs: 0, trails: 0 };
  world.stats.perWave.push(entry);
  return entry;
}

function spawnBurst(world, x, z, count, palette) {
  const colors = palette || [0xff7a1a, 0xffb020, 0xffc53d, 0x6b5d4f];
  for (let i = 0; i < count; i += 1) {
    if (world.particles.length >= SIM.MAX_PARTICLES) return;
    const angle = world.rng() * Math.PI * 2;
    const speed = (40 + world.rng() * 190) / PX;
    world.particles.push({
      x, z,
      vx: Math.cos(angle) * speed,
      vz: Math.sin(angle) * speed,
      vy: 2 + world.rng() * 6,
      t: 0,
      ttl: 0.35 + world.rng() * 0.5,
      color: colors[Math.floor(world.rng() * colors.length)],
      size: 0.2 + world.rng() * 0.4
    });
  }
}

function setShake(world, amount, seconds) {
  world.shake = amount;
  world.shakeTime = seconds;
}

export function trailLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

export { FEATS, gradeFor, gradeChecklist };

export function evaluateFeats(world) {
  if (!world) return [];
  if (!Array.isArray(world.featsUnlocked)) world.featsUnlocked = [];
  const unlocked = [];
  for (const feat of FEATS) {
    if (world.featsUnlocked.includes(feat.id)) continue;
    if (feat.check(world)) {
      world.featsUnlocked.push(feat.id);
      unlocked.push(feat.id);
    }
  }
  return unlocked;
}

function buildSegments(points) {
  const segments = [];
  let total = 0;
  if (!Array.isArray(points)) return { segments, total };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len <= 0) continue;
    segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, dx, dz, len, start: total, end: total + len });
    total += len;
  }
  return { segments, total };
}

function pointAtArc(points, segments, dist) {
  if (!points || points.length === 0) return { x: 0, z: 0 };
  if (dist <= 0) return { x: points[0].x, z: points[0].z };
  for (const seg of segments) {
    if (dist <= seg.end) {
      const f = seg.len > 0 ? (dist - seg.start) / seg.len : 0;
      return { x: seg.ax + seg.dx * f, z: seg.az + seg.dz * f };
    }
  }
  const last = points[points.length - 1];
  return { x: last.x, z: last.z };
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function updateNextInfo(world) {
  world.nextInfo = getNextInfo(world);
}

export function getNextInfo(world) {
  const counts = { cinderling: 0, torchbearer: 0, ironhide: 0, saboteur: 0 };
  const queue = world && Array.isArray(world.spawnQueue) ? world.spawnQueue : [];
  for (const type of queue) {
    if (counts[type] !== undefined) counts[type] += 1;
  }
  const parts = [];
  for (const type of ['torchbearer', 'cinderling', 'ironhide', 'saboteur']) {
    const count = counts[type];
    if (count > 0) parts.push(`${count} ${TYPE_LABEL[type]}${count === 1 ? '' : 's'}`);
  }
  return { label: parts.length > 0 ? parts.join(' + ') : '—' };
}

function makeKegs(world, waveNumber) {
  const cfg = WAVES[waveNumber - 1];
  const spots = cfg.kegs.slice();
  const extra = world.mods.kegsPerWaveBonus;
  for (let i = 0; i < extra; i += 1) {
    spots.push({
      x: Math.round((10.9 + (world.rng() * 2 - 1) * 3.6) * 10) / 10,
      z: Math.round((7.3 + (world.rng() * 2 - 1) * 3.6) * 10) / 10
    });
  }
  world.kegs = spots.map((spot) => ({
    x: spot.x,
    z: spot.z,
    r: SIM.KEG_RADIUS,
    state: 'idle',
    fuse: 0,
    alive: true
  }));
}

function setupWave(world, waveNumber) {
  const cfg = WAVES[waveNumber - 1];
  world.wave = waveNumber;
  world.phase = 'build';
  world.phaseTime = world.buildSeconds;
  world.buildCountdown = world.buildSeconds;
  world.waveStartTime = world.time;
  world.combatStartTime = null;
  world.waveTotal = cfg.count;
  world.spawnedCount = 0;
  world.spawnTimer = cfg.interval;

  const queue = [];
  for (let i = 0; i < cfg.ironhides; i += 1) queue.push('ironhide');
  for (let i = 0; i < cfg.saboteurs; i += 1) queue.push('saboteur');
  for (let i = 0; i < cfg.cinderlings; i += 1) queue.push('cinderling');
  for (let i = 0; i < cfg.torchbearers; i += 1) queue.push('torchbearer');
  world.spawnQueue = shuffleInPlace(world.rng, queue);

  makeKegs(world, waveNumber);

  if (waveNumber === 10) {
    const bossHp = BOSS.hp * world.difficulty.hpMul;
    world.boss = {
      name: cfg.bossName || BOSS.name,
      hp: bossHp,
      maxHp: bossHp,
      x: WORLD.SPAWN_X,
      z: WORLD.LANES_Z[1],
      lane: 1,
      radius: BOSS.radius,
      speed: BOSS.speed,
      dmg: BOSS.dmg,
      attackTimer: 0,
      alive: true,
      defeated: false,
      state: 'walk'
    };
  } else {
    world.boss = null;
  }

  if (!world.stats.perWave) world.stats.perWave = [];
  world.stats.perWave.push({ wave: waveNumber, kills: 0, blasts: 0, kegs: 0, trails: 0 });

  updateNextInfo(world);
}

function spawnEnemy(world, type, laneOverride) {
  const def = ENEMY_TYPES[type] || ENEMY_TYPES.torchbearer;
  const lane = laneOverride !== undefined ? laneOverride : Math.floor(world.rng() * WORLD.LANES_Z.length);
  const z = WORLD.LANES_Z[lane] + (world.rng() * 2 - 1) * WORLD.LANE_JITTER;
  const enemy = {
    id: world.idCounter,
    type,
    hp: def.hp * world.difficulty.hpMul,
    maxHp: def.hp * world.difficulty.hpMul,
    speed: def.speed * world.difficulty.speedMul,
    dmg: def.dmg,
    radius: def.radius,
    x: WORLD.SPAWN_X + def.radius,
    z,
    lane,
    bobPhase: world.rng() * Math.PI * 2,
    bob: 0,
    dead: false,
    shieldBroken: false,
    anim: 'walk',
    animT: 0,
    deathT: 0
  };
  world.idCounter += 1;
  world.spawnedCount += 1;
  world.enemies.push(enemy);
  return enemy;
}

function beginCombat(world) {
  const cfg = WAVES[world.wave - 1];
  world.phase = 'combat';
  world.phaseTime = 0;
  world.combatStartTime = world.time;
  const lanes = [0, 1, 2];
  for (let i = 0; i < 3 && world.spawnQueue.length > 0; i += 1) {
    spawnEnemy(world, world.spawnQueue.shift(), lanes[i]);
  }
  world.spawnTimer = cfg.interval;
  updateNextInfo(world);
}

function endGame(world, result) {
  if (world.phase === 'won' || world.phase === 'lost') return;
  world.phase = result;
  world.grade = gradeFor(world);
  if (world.score > world.best) {
    world.best = world.score;
    writeBest(world.best);
  }
  evaluateFeats(world);
  pushEvent(world, 'horn');
}

function damageBoss(world, amount) {
  const boss = world.boss;
  if (!boss || !boss.alive) return;
  boss.hp -= amount * world.mods.bossDmgMul;
  spawnBurst(world, boss.x, boss.z, 10);
  if (boss.hp > 0) return;
  boss.hp = 0;
  boss.alive = false;
  boss.defeated = true;
  boss.state = 'dead';
  spawnBurst(world, boss.x, boss.z, 40);
  const bonus = SIM.BOSS_BONUS_BASE + world.wallHp * SIM.BOSS_BONUS_PER_WALL;
  world.score += bonus;
  pushPopup(world, {
    text: `CINDER TITAN DOWN! +${bonus}`,
    x: boss.x,
    z: boss.z,
    t: 0,
    ttl: 1.4,
    color: 0xffc53d,
    size: 28,
    kind: 'boss'
  });
  endGame(world, 'won');
}

function damageWall(world, amount, x, z, text, size) {
  if (world.phase === 'won' || world.phase === 'lost') return;
  world.wallHp -= amount;
  setShake(world, 4, 0.2);
  pushEvent(world, 'thud');
  pushPopup(world, {
    text: text || `-${amount} WALL`,
    x, z,
    t: 0,
    ttl: 1,
    color: 0xff4d3d,
    size: size || 18,
    kind: 'wall'
  });
  if (world.wallHp <= 0) {
    world.wallHp = 0;
    endGame(world, 'lost');
  }
}

function backfire(world, x, z) {
  world.stats.backfires += 1;
  world.lastBackfire = { x, z, time: world.time };
  world.wallScorch.push({ x: WORLD.WALL_X + 1.2, z, time: world.time });
  world.trail = null;
  setShake(world, 4, 0.2);
  pushEvent(world, 'backfire');
  damageWall(world, SIM.BACKFIRE_DAMAGE, WORLD.WALL_X + 2, Math.max(-28, Math.min(28, z)), 'BACKFIRE! -15 WALL', 28);
  spawnBurst(world, x, z, 10);
}

function chainMultiplier(chain) {
  if (chain >= 5) return 8;
  if (chain >= 3) return 4;
  if (chain >= 2) return 2;
  return 1;
}

function registerKill(world, enemy) {
  world.kills += 1;
  world.lastKillX = enemy.x;
  world.lastKillZ = enemy.z;
  const killStats = currentWaveStats(world);
  if (killStats) killStats.kills += 1;
  world.powder = Math.min(world.powderMax, world.powder + SIM.KILL_POWDER + world.mods.powderPerKillBonus);

  const window_ = SIM.CHAIN_WINDOW + world.mods.chainWindowBonus;
  const continues = world.chain > 0 && world.time - world.lastKillTime <= window_;
  world.chain = continues ? world.chain + 1 + world.mods.chainPerKillBonus : 1;
  world.lastKillTime = world.time;
  world.chainTimer = window_;
  world.chainMul = chainMultiplier(world.chain);
  if (world.chain > world.longestChain) world.longestChain = world.chain;

  const gain = world.chainMul >= 4
    ? Math.round(100 * world.chainMul * (1 + world.mods.overkillBonus))
    : 100 * world.chainMul;
  world.score += gain;
  const coins = 5 + 5 * (TYPE_TIER[enemy.type] || 0);
  world.coins += coins;

  const suffix = world.chainMul > 1 ? ` x${world.chainMul} CHAIN` : '';
  pushPopup(world, {
    text: `+${gain}${suffix}`,
    x: enemy.x,
    z: enemy.z,
    t: 0,
    ttl: 0.9,
    color: 0xffc53d,
    size: 20,
    kind: 'chain'
  });
  pushPopup(world, {
    text: `+${coins}`,
    x: enemy.x,
    z: enemy.z + 1.6,
    t: 0,
    ttl: 0.7,
    color: 0xffc53d,
    size: 13,
    kind: 'coin'
  });
  pushEvent(world, 'coin');
  evaluateFeats(world);
}

function damageEnemy(world, enemy, amount, source) {
  if (!enemy || enemy.dead) return;
  enemy.hp -= amount;
  // Ironhide's tower shield shattering on the first explosion is VISUAL
  // feedback only (the shield mesh falls off, he looks shocked). Damage
  // applies exactly as in the verified 2D build, so hits-to-kill are
  // unchanged; only the presentation differs.
  if (enemy.type === 'ironhide' && !enemy.shieldBroken && (source === 'trail' || source === 'keg')) {
    enemy.shieldBroken = true;
    pushEvent(world, 'shield_break');
  }
  if (enemy.hp > 0) return;
  enemy.dead = true;
  enemy.anim = 'dead';
  enemy.deathT = 0;
  registerKill(world, enemy);
  if (enemy.type === 'saboteur') {
    const blast = ENEMY_TYPES.saboteur;
    spawnBurst(world, enemy.x, enemy.z, 10);
    pushEvent(world, 'boom');
    const others = world.enemies.slice();
    for (const other of others) {
      if (other === enemy || other.dead) continue;
      const dist = Math.hypot(other.x - enemy.x, other.z - enemy.z);
      if (dist <= blast.deathRadius) damageEnemy(world, other, blast.deathBlast, source || 'saboteur');
    }
  }
}

function igniteKeg(world, keg) {
  if (!keg || !keg.alive || keg.state !== 'idle') return;
  keg.state = 'lit';
  keg.fuse = 0.25;
}

function explodeKeg(world, keg) {
  if (!keg || !keg.alive) return;
  keg.alive = false;
  keg.state = 'gone';
  keg.explodeT = world.time;
  world.stats.kegsBlown += 1;
  const kegStats = currentWaveStats(world);
  if (kegStats) {
    kegStats.kegs += 1;
    kegStats.blasts += 1;
  }
  spawnBurst(world, keg.x, keg.z, 14);
  setShake(world, 4, 0.2);
  pushEvent(world, 'boom');

  const enemies = world.enemies.slice();
  for (const enemy of enemies) {
    if (enemy.dead) continue;
    if (Math.hypot(enemy.x - keg.x, enemy.z - keg.z) <= SIM.KEG_BLAST_RADIUS + world.mods.blastRadiusBonus) {
      damageEnemy(world, enemy, SIM.KEG_DAMAGE * world.mods.kegDamageMul, 'keg');
    }
  }
  if (world.boss && world.boss.alive) {
    const ring = SIM.KEG_BLAST_RADIUS + world.mods.blastRadiusBonus;
    if (Math.hypot(world.boss.x - keg.x, world.boss.z - keg.z) <= ring + world.boss.radius) {
      damageBoss(world, SIM.KEG_DAMAGE * world.mods.kegDamageMul);
    }
  }
  for (const other of world.kegs) {
    if (other === keg || !other.alive || other.state !== 'idle') continue;
    if (Math.hypot(other.x - keg.x, other.z - keg.z) <= SIM.KEG_BLAST_RADIUS) igniteKeg(world, other);
  }
}

function updateKegs(world, dt) {
  for (const keg of world.kegs) {
    if (!keg.alive || keg.state !== 'lit') continue;
    keg.fuse -= dt;
    if (keg.fuse <= 0) explodeKeg(world, keg);
  }
  // Exploded ('gone') kegs are KEPT in world.kegs: the renderer draws scorch
  // marks from them. makeKegs replaces the array each wave, so nothing
  // accumulates across waves.
}

function updateBurningTrail(world, dt) {
  const trail = world.trail;
  if (!trail || trail.state !== 'burning') return;
  const def = POWDER_TYPES[trail.type] || POWDER_TYPES.BLACK;
  const { segments, total } = buildSegments(trail.points);

  for (const point of trail.points) {
    if (point.x <= WORLD.BACKFIRE_X) {
      backfire(world, point.x, point.z);
      return;
    }
  }

  if (total <= 0) {
    world.trail = null;
    return;
  }

  const previous = trail.burnDist;
  const front = Math.min(total, previous + def.burnSpeed * dt * world.mods.burnSpeedMul);
  trail.burnDist = front;
  const frontPos = pointAtArc(trail.points, segments, front);
  trail.frontX = frontPos.x;
  trail.frontZ = frontPos.z;

  if (def.dotDps && def.dotSeconds) {
    while (trail.patchDist + 2.18 <= front) {
      trail.patchDist += 2.18;
      const p = pointAtArc(trail.points, segments, trail.patchDist);
      world.groundFire.push({ x: p.x, z: p.z, r: SIM.GROUND_FIRE_RADIUS, t: 0 });
    }
  }

  for (const seg of segments) {
    if (seg.start >= front) break;
    const portionEnd = Math.min(seg.end, front);
    const f = seg.len > 0 ? (portionEnd - seg.start) / seg.len : 0;
    const bx = seg.ax + seg.dx * f;
    const bz = seg.az + seg.dz * f;

    for (const enemy of world.enemies) {
      if (enemy.dead || trail.hit.has(enemy.id)) continue;
      if (pointSegmentDistance(enemy.x, enemy.z, seg.ax, seg.az, bx, bz) <= (def.blastRadius || 4.2) + world.mods.blastRadiusBonus) {
        trail.hit.add(enemy.id);
        damageEnemy(world, enemy, def.damage || 100, 'trail');
      }
    }

    if (world.boss && world.boss.alive && !trail.hit.has('boss')) {
      const radius = (def.blastRadius || 4.2) + world.mods.blastRadiusBonus;
      if (Math.hypot(world.boss.x - bx, world.boss.z - bz) <= radius + world.boss.radius) {
        trail.hit.add('boss');
        damageBoss(world, def.damage || 100);
      }
    }

    for (const keg of world.kegs) {
      if (!keg.alive || keg.state !== 'idle') continue;
      if (pointSegmentDistance(keg.x, keg.z, seg.ax, seg.az, bx, bz) <= (def.blastRadius || 4.2) + world.mods.blastRadiusBonus) {
        igniteKeg(world, keg);
      }
    }
  }

  if (front >= total) world.trail = null;
}

function updateGroundFire(world, dt) {
  if (world.groundFire.length === 0) return;
  for (const patch of world.groundFire) {
    patch.t += dt;
    for (const enemy of world.enemies) {
      if (enemy.dead) continue;
      if (Math.hypot(enemy.x - patch.x, enemy.z - patch.z) <= patch.r) {
        damageEnemy(world, enemy, SIM.GROUND_FIRE_DPS * dt, 'naphtha');
      }
    }
  }
  world.groundFire = world.groundFire.filter((patch) => patch.t < 2 + world.mods.groundFireBonus);
}

function updateEnemies(world, dt) {
  for (const enemy of world.enemies) {
    if (enemy.dead) {
      enemy.deathT += dt;
      continue;
    }
    enemy.x -= enemy.speed * dt;
    enemy.bob = Math.sin(world.time * 8 + enemy.bobPhase) * 0.23;
    enemy.animT += dt;
    if (enemy.x <= WORLD.WALL_X) {
      enemy.dead = true;
      enemy.anim = 'dead';
      damageWall(world, enemy.dmg, WORLD.WALL_X + 2, enemy.z, `-${enemy.dmg} WALL`);
      if (world.mods.thornsDamage > 0) {
        enemy.dead = false;
        damageEnemy(world, enemy, world.mods.thornsDamage, 'thorns');
        enemy.dead = true;
        enemy.anim = 'dead';
      }
      if (world.phase === 'lost') break;
    }
  }
  world.enemies = world.enemies.filter((enemy) => !enemy.dead || enemy.deathT < 1.2);
}

function clearWave(world) {
  if (world.wave === 10 && world.boss && world.boss.alive) return;
  world.clearedWave = world.wave;
  if (world.wallHp === world.wallMax) world._flawlessWave = true;
  if (world.powder >= 90) world._hoarderWave = true;
  if (world.time - world.waveStartTime < 20) world._speedWave = true;
  world.powder = Math.min(world.powderMax, world.powder + SIM.WAVE_CLEAR_POWDER);
  world.wallHp = Math.min(world.wallMax, world.wallHp + SIM.WAVE_CLEAR_WALL);
  const bonus = SIM.WAVE_CLEAR_SCORE * world.wave;
  world.score += bonus;
  world.coins += SIM.WAVE_CLEAR_COINS * world.wave;
  world.wallHp = Math.min(world.wallMax, world.wallHp + world.mods.wallRegenPerWave);
  pushEvent(world, 'horn');

  if (world.wave >= 10) {
    endGame(world, 'won');
    return;
  }

  if (world.wave < 10 && getDraftPool(world).left > 0) offerDraft(world);
  evaluateFeats(world);
  setupWave(world, world.wave + 1);
}

function ageEffects(world, dt) {
  for (const popup of world.popups) popup.t += dt;
  world.popups = world.popups.filter((popup) => popup.t < popup.ttl);

  for (const particle of world.particles) {
    particle.t += dt;
    particle.x += particle.vx * dt;
    particle.z += particle.vz * dt;
    particle.y = (particle.y || 0) + particle.vy * dt;
    particle.vy -= 9 * dt;
  }
  world.particles = world.particles.filter((particle) => particle.t < particle.ttl);

  if (world.shakeTime > 0) {
    world.shakeTime -= dt;
    world.shake = world.shakeTime > 0 ? 4 : 0;
    if (world.shakeTime <= 0) {
      world.shakeTime = 0;
      world.shake = 0;
    }
  } else {
    world.shake = 0;
  }
}

export function createWorld(difficultyName, seed) {
  const name = DIFF_ORDER.indexOf(difficultyName) >= 0 ? difficultyName : 'STANDARD';
  const difficulty = DIFFICULTIES[name];
  const world = {
    difficulty,
    difficultyName: name,
    rng: mulberry32(seed),
    draftRng: mulberry32((seed >>> 0) ^ 0xd7af7),
    mods: {
      powderCostMul: 1,
      burnSpeedMul: 1,
      blastRadiusBonus: 0,
      chainWindowBonus: 0,
      chainPerKillBonus: 0,
      powderPerKillBonus: 0,
      wallMaxBonus: 0,
      wallRegenPerWave: 0,
      thornsDamage: 0,
      kegsPerWaveBonus: 0,
      kegDamageMul: 1,
      groundFireBonus: 0,
      bossDmgMul: 1,
      powderMaxBonus: 0,
      overkillBonus: 0
    },
    pickedCards: [],
    draft: null,
    time: 0,
    wave: 1,
    phase: 'build',
    phaseTime: SIM.BUILD_SECONDS,
    buildSeconds: SIM.BUILD_SECONDS,
    wallHp: difficulty.wall,
    wallMax: difficulty.wall,
    powder: 100,
    powderMax: SIM.POWDER_MAX,
    score: 0,
    coins: 0,
    kills: 0,
    chain: 0,
    chainTimer: 0,
    chainMul: 1,
    longestChain: 0,
    enemies: [],
    kegs: [],
    trail: null,
    popups: [],
    particles: [],
    shake: 0,
    shakeTime: 0,
    boss: null,
    spawnQueue: [],
    spawnTimer: 0,
    spawnedCount: 0,
    waveTotal: 0,
    nextInfo: { label: '—' },
    best: readBest(),
    events: [],
    stats: { trailsLit: 0, kegsBlown: 0, backfires: 0, perWave: [] },
    lastBackfire: null,
    lastFizzle: null,
    wallScorch: [],
    featsUnlocked: [],
    grade: null,
    _flawlessWave: false,
    _hoarderWave: false,
    _speedWave: false,
    powderType: 'BLACK',
    buildCountdown: SIM.BUILD_SECONDS,
    waveStartTime: 0,
    combatStartTime: null,
    groundFire: [],
    idCounter: 1,
    lastKillTime: -999,
    lastKillX: 0,
    lastKillZ: 0,
    clearedWave: 0
  };
  setupWave(world, 1);
  return world;
}

function findCard(cardId) {
  for (const card of CARD_DEFS) {
    if (card.id === cardId) return card;
  }
  return null;
}

export function applyCard(world, cardId) {
  if (!world) return false;
  const card = findCard(cardId);
  if (!card) return false;
  if (world.pickedCards.includes(cardId)) return false;
  if (world.coins < card.cost) return false;

  world.coins -= card.cost;
  switch (cardId) {
    case 'trail_runner':
      world.mods.powderCostMul = 0.8;
      break;
    case 'quick_burn':
      world.mods.burnSpeedMul = 1.18;
      break;
    case 'wide_blast':
      world.mods.blastRadiusBonus = 12 / PX;
      break;
    case 'chain_window':
      world.mods.chainWindowBonus = 0.5;
      break;
    case 'hot_streak':
      world.mods.chainPerKillBonus = 1;
      break;
    case 'bounty_powder':
      world.mods.powderPerKillBonus = 2;
      break;
    case 'stone_skin': {
      world.mods.wallMaxBonus = 60;
      world.wallMax += 60;
      world.wallHp = Math.min(world.wallMax, world.wallHp + 60);
      break;
    }
    case 'masons_oath':
      world.mods.wallRegenPerWave = 8;
      break;
    case 'bramble_wall':
      world.mods.thornsDamage = 14;
      break;
    case 'keg_plus_one':
      world.mods.kegsPerWaveBonus = 1;
      break;
    case 'keg_charge':
      world.mods.kegDamageMul = 1.4;
      break;
    case 'slow_match':
      world.mods.groundFireBonus = 1.5;
      break;
    case 'siege_breaker':
      world.mods.bossDmgMul = 2.0;
      break;
    case 'powder_pouch':
      world.mods.powderMaxBonus = 40;
      world.powderMax += 40;
      break;
    case 'overkill':
      world.mods.overkillBonus = 0.5;
      break;
    default:
      break;
  }
  world.pickedCards.push(cardId);
  return true;
}

export function getDraftPool(world) {
  const picked = world && Array.isArray(world.pickedCards) ? world.pickedCards.length : 0;
  return { total: CARD_DEFS.length, picked, left: CARD_DEFS.length - picked };
}

function draftOffers(world, pool) {
  const shuffled = shuffleInPlace(world.draftRng, pool.slice());
  const offered = shuffled.slice(0, 3);
  const coins = Number(world.coins) || 0;
  const affordable = (id) => {
    const card = findCard(id);
    return !!card && coins >= card.cost;
  };
  if (offered.length > 0 && !offered.some(affordable)) {
    const affordablePool = pool.filter((id) => !offered.includes(id) && affordable(id));
    if (affordablePool.length > 0) {
      affordablePool.sort((a, b) => findCard(a).cost - findCard(b).cost);
      let priciest = 0;
      for (let i = 1; i < offered.length; i += 1) {
        if (findCard(offered[i]).cost > findCard(offered[priciest]).cost) priciest = i;
      }
      offered[priciest] = affordablePool[0];
    }
  }
  return offered;
}

export function offerDraft(world) {
  if (!world) return null;
  if (world.draft) return world.draft;
  const pool = CARD_DEFS.map((card) => card.id).filter((id) => !world.pickedCards.includes(id));
  if (pool.length === 0) return null;
  world.draft = { offered: draftOffers(world, pool), rerolls: 0, rerollCost: 25 };
  return world.draft;
}

export function rerollDraft(world) {
  if (!world || !world.draft) return null;
  if (world.coins < world.draft.rerollCost) return null;
  world.coins -= world.draft.rerollCost;
  world.draft.rerolls += 1;
  world.draft.rerollCost = 25 * (world.draft.rerolls + 1);
  const pool = CARD_DEFS.map((card) => card.id).filter((id) => !world.pickedCards.includes(id));
  world.draft.offered = draftOffers(world, pool);
  return world.draft;
}

export function pickDraftCard(world, cardId) {
  if (!world || !world.draft) return false;
  if (!world.draft.offered.includes(cardId)) return false;
  if (!applyCard(world, cardId)) return false;
  world.draft = null;
  return true;
}

export function startTrail(world, x, z) {
  if (!world) return;
  if (world.trail && world.trail.state === 'burning') return;
  world.trail = {
    points: [{ x, z }],
    type: POWDER_TYPES[world.powderType] ? world.powderType : 'BLACK',
    state: 'drawing',
    burnDist: 0,
    patchDist: 0,
    hit: new Set(),
    frontX: x,
    frontZ: z
  };
}

export function addTrailPoint(world, x, z) {
  if (!world || !world.trail || world.trail.state !== 'drawing') return;
  if (world.powder <= 0) return;
  const points = world.trail.points;
  const last = points[points.length - 1];
  const dist = Math.hypot(x - last.x, z - last.z);
  if (dist < SIM.TRAIL_POINT_SPACING) return;

  const def = POWDER_TYPES[world.trail.type] || POWDER_TYPES.BLACK;
  // Cost: 2D cost was (distPx / 12) * costPer12px; distPx = dist * PX.
  const cost = ((dist * PX) / 12) * def.costPer12px * world.mods.powderCostMul;
  points.push({ x, z });
  world.powder = Math.max(0, world.powder - cost);
}

export function endTrail(world) {
  if (!world || !world.trail || world.trail.state !== 'drawing') return;
  const length = trailLength(world.trail.points);
  if (length >= SIM.TRAIL_MIN_LENGTH) {
    world.trail.state = 'armed';
    pushEvent(world, 'click');
    return;
  }
  const last = world.trail.points[world.trail.points.length - 1];
  pushEvent(world, 'fizzle');
  world.lastFizzle = { x: last.x, z: last.z, time: world.time };
  if (world.particles.length < SIM.MAX_PARTICLES) {
    world.particles.push({
      x: last.x, z: last.z, vx: 0, vz: 0, vy: -1,
      t: 0, ttl: 0.45, color: 0x9a9a9a, size: 0.5
    });
  }
  world.trail = null;
}

export function lightTrail(world) {
  if (!world || !world.trail || world.trail.state !== 'armed') return;
  world.trail.state = 'burning';
  world.trail.burnDist = 0;
  world.trail.patchDist = 0;
  world.trail.hit = new Set();
  world.stats.trailsLit += 1;
  const waveStats = currentWaveStats(world);
  if (waveStats) {
    waveStats.trails += 1;
    waveStats.blasts += 1;
  }
  pushEvent(world, 'click');
}

export function clearTrail(world) {
  if (!world || !world.trail) return;
  if (world.trail.state === 'burning') return;
  world.trail = null;
}

export function setPowderType(world, i) {
  if (!world) return;
  if (world.trail && world.trail.state === 'burning') return;
  const type = POWDER_ORDER[i];
  if (!type || !POWDER_TYPES[type]) return;
  world.powderType = type;
  if (world.trail && world.trail.state === 'drawing') world.trail.type = type;
  pushEvent(world, 'click');
}

export function update(world, dt) {
  if (!world) return;
  const step = typeof dt === 'number' && Number.isFinite(dt) ? dt : SIM.STEP_DT;

  world.time += step;
  world.powder = Math.min(world.powderMax, world.powder + SIM.POWDER_REGEN * step);

  if (world.phase === 'build') {
    world.phaseTime -= step;
    world.buildCountdown = Math.max(0, Math.ceil(world.phaseTime));
    if (world.phaseTime <= 0) beginCombat(world);
  } else if (world.phase === 'combat') {
    world.phaseTime += step;

    if (world.boss && world.boss.alive) {
      if (world.boss.x > WORLD.BOSS_STOP_X) {
        world.boss.x = Math.max(WORLD.BOSS_STOP_X, world.boss.x - world.boss.speed * world.difficulty.speedMul * step);
        world.boss.state = 'walk';
      } else {
        world.boss.state = 'attack';
        world.boss.attackTimer += step;
        if (world.boss.attackTimer >= BOSS.attackInterval) {
          world.boss.attackTimer -= BOSS.attackInterval;
          damageWall(world, world.boss.dmg, WORLD.WALL_X + 2, world.boss.z);
        }
      }
    }

    while (world.spawnQueue.length > 0 && world.spawnTimer <= 0) {
      spawnEnemy(world, world.spawnQueue.shift());
      world.spawnTimer += WAVES[world.wave - 1].interval;
    }
    if (world.spawnQueue.length > 0) world.spawnTimer -= step;

    updateEnemies(world, step);
    updateBurningTrail(world, step);
    updateGroundFire(world, step);
    updateKegs(world, step);

    world.enemies = world.enemies.filter((enemy) => !enemy.dead || enemy.deathT < 1.2);

    if (world.phase === 'combat' && world.spawnQueue.length === 0 && world.enemies.length === 0
      && !(world.wave === 10 && world.boss && world.boss.alive)) {
      clearWave(world);
    }
  } else {
    updateBurningTrail(world, step);
    updateGroundFire(world, step);
    updateKegs(world, step);
  }

  if (world.chain > 0) {
    world.chainTimer -= step;
    if (world.chainTimer <= 0) {
      world.chain = 0;
      world.chainTimer = 0;
      world.chainMul = 1;
    }
  }

  ageEffects(world, step);
  updateNextInfo(world);
}

const PROFILE_KEY = 'chainfire3d_profile';

export function defaultProfile() {
  return {
    best: 0,
    feats: { unlocked: [], total: 8 },
    lifetime: { raidersBlown: 0, biggestChain: 0, runsPlayed: 0, wins: 0 },
    lastRuns: []
  };
}

function mergeProfile(raw) {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object') return base;
  if (typeof raw.best === 'number' && Number.isFinite(raw.best)) base.best = raw.best;
  if (raw.feats && typeof raw.feats === 'object') {
    if (Array.isArray(raw.feats.unlocked)) {
      base.feats.unlocked = raw.feats.unlocked.filter((id) => typeof id === 'string');
    }
    if (typeof raw.feats.total === 'number' && Number.isFinite(raw.feats.total)) {
      base.feats.total = raw.feats.total;
    }
  }
  if (raw.lifetime && typeof raw.lifetime === 'object') {
    for (const key of ['raidersBlown', 'biggestChain', 'runsPlayed', 'wins']) {
      if (typeof raw.lifetime[key] === 'number' && Number.isFinite(raw.lifetime[key])) {
        base.lifetime[key] = raw.lifetime[key];
      }
    }
  }
  if (Array.isArray(raw.lastRuns)) {
    base.lastRuns = raw.lastRuns.filter((run) => run && typeof run === 'object').slice(0, 3);
  }
  return base;
}

export function loadProfile() {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(PROFILE_KEY) : null;
    if (!raw) return defaultProfile();
    return mergeProfile(JSON.parse(raw));
  } catch (err) {
    return defaultProfile();
  }
}

export function saveProfile(profile) {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    }
  } catch (err) {
    // Storage is optional (headless tests).
  }
}

export function recordRun(profile, world) {
  const merged = mergeProfile(profile);
  const target = profile && typeof profile === 'object' ? profile : merged;
  target.best = merged.best;
  target.feats = merged.feats;
  target.lifetime = merged.lifetime;
  target.lastRuns = merged.lastRuns;
  target.lifetime.runsPlayed += 1;
  if (world.phase === 'won') target.lifetime.wins += 1;
  target.lifetime.raidersBlown += world.kills;
  target.lifetime.biggestChain = Math.max(target.lifetime.biggestChain, world.longestChain);
  target.best = Math.max(target.best, world.score, world.best || 0);

  const runFeats = Array.isArray(world.featsUnlocked) ? world.featsUnlocked : [];
  const union = target.feats.unlocked.slice();
  for (const id of runFeats) {
    if (!union.includes(id)) union.push(id);
  }
  target.feats.unlocked = FEATS.map((feat) => feat.id).filter((id) => union.includes(id));
  target.feats.total = FEATS.length;

  target.lastRuns.unshift({
    score: world.score,
    wave: world.wave,
    result: world.phase,
    grade: world.grade || gradeFor(world),
    kills: world.kills,
    longestChain: world.longestChain,
    time: Math.round(world.time)
  });
  target.lastRuns = target.lastRuns.slice(0, 3);

  return target;
}
