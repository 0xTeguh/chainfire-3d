// CHAINFIRE 3D — shared constants. Pure data, no side effects.
// Written fresh for the 3D rebuild. All mechanics numbers are the VERIFIED
// 2D numbers, rescaled from 2D pixels to 3D world units (1 unit = 11 px).
// Roster names are the NEW 3D roster; stats are identical to the 2D originals.

import { mulberry32, range } from './rng.js';

// 2D pixels per 3D world unit.
export const PX = 11;

// World layout (x = approach axis, horde spawns at +x and walks to the wall
// at -x; z = lateral lanes; y = terrain height, from terrain.js).
export const WORLD = {
  X_MIN: -58,
  X_MAX: 58,
  Z_MIN: -32,
  Z_MAX: 32,
  WALL_X: -42.7, // 2D WALL_LINE_X 170px: raiders reaching here hit the wall
  BACKFIRE_X: -40, // 2D BACKFIRE_X 200px: trail drawn past here backfires
  BOSS_STOP_X: -39.1, // 2D WALL_X1+40 = 210px: where the Titan stops to attack
  SPAWN_X: 58.2, // 2D x = 1280 + radius
  LANES_Z: [-14.5, 0, 14.5], // 2D LANES y = 200 / 360 / 520
  LANE_JITTER: 0.9,
  FORT_X: -45,
  GROUND_Y: 0
};

export const PALETTE = {
  GOLD: 0xffb347,
  EMBER: 0xe85d26,
  HILL_DARK: 0x2e5e4e,
  HILL_LIGHT: 0x5fa860,
  SKY_DUSK: 0x6b4e8e,
  CREAM: 0xf5e6c8,
  CHARCOAL: 0x2b2b2b,
  SKY_TOP: 0x7a5a9e,
  SKY_HORIZON: 0xefae5e,
  SUN: 0xffdf8a,
  FIELD_A: 0x5fa860,
  FIELD_B: 0x57a05b,
  PATH: 0xc9a86a,
  WALL_STONE: 0xc9b8a3,
  WALL_MORTAR: 0x8a7a66,
  WALL_TOP: 0xe8dcc8,
  ROOF_RED: 0xa63a2e,
  GATE_WOOD: 0x4a3a2e,
  FIRE: 0xff7a1a,
  FIRE_BRIGHT: 0xffb020,
  SMOKE: 0x6b5d4f,
  HUD_GOLD: 0xffc53d,
  HUD_RED: 0xff4d3d,
  HUD_GREEN: 0x7ed957,
  KEG_WOOD: 0x8a5a2b
};

// Powder types: mechanics identical to the verified 2D build.
// BLACK = standard (black + crystal glint), NAPHTHA = gold shimmer (ground
// fire pools), STAR = red-hot (biggest blasts). Colors are visual only.
export const POWDER_TYPES = {
  // ROUND 4 AGENT C (item 14): `effect` is the honest one-line effect shown
  // on the powder button — real mechanics only (BLACK: baseline 100 dmg /
  // 4.2 blast; NAPHTHA: 20 dps burn for 2s on top of the 100 dmg blast;
  // STAR: 6.4 blast radius, 140 dmg).
  BLACK: { costPer12px: 1, burnSpeed: 38.2, blastRadius: 4.2, damage: 100, color: 0x3a3a3a, glow: 0xffd23f, label: 'BLACK', effect: 'STANDARD' },
  NAPHTHA: { costPer12px: 2, burnSpeed: 34.5, blastRadius: 4.2, damage: 100, dotDps: 20, dotSeconds: 2, color: 0xffb347, glow: 0xffc53d, label: 'NAPHTHA', effect: 'BURNS 2s' },
  STAR: { costPer12px: 3, burnSpeed: 41.8, blastRadius: 6.4, damage: 140, color: 0xe85d26, glow: 0xff7a1a, label: 'STAR', effect: 'BIG BLAST 140' }
};
export const POWDER_ORDER = ['BLACK', 'NAPHTHA', 'STAR'];

// The Garrison: defender kind + wall position (z). Shared by the sim
// (defender-fire state) and the renderer (placement) — one source, so the
// shots always leave from the defender the player sees on the wall.
// ROUND 3 AGENT A (items 1+3).
export const DEFENDER_DEFS = [
  { kind: 'wren', z: -5 },
  { kind: 'pip', z: -14 },
  { kind: 'thom', z: 6 },
  { kind: 'mira', z: 14 }
];

// Enemy roster — THE ASHEN HORDE. Stats are the verified 2D stats, rescaled.
// scale = visual height multiplier (standard = 1.0, ~3.2 world units tall).
export const ENEMY_TYPES = {
  cinderling: { hp: 60, speed: 5.0, dmg: 10, radius: 2.0, tier: 0, scale: 0.6, minWave: 1, label: 'Cinderling', color: 0x2b2320, ember: 0xff7a1a, hpBar: false },
  torchbearer: { hp: 100, speed: 3.45, dmg: 15, radius: 2.36, tier: 1, scale: 1.0, minWave: 1, label: 'Torchbearer', color: 0x8a2d1e, ember: 0xffb020, hpBar: true },
  ironhide: { hp: 220, speed: 2.18, dmg: 30, radius: 3.1, tier: 2, scale: 2.0, minWave: 3, label: 'Ironhide', color: 0x6b5a4a, ember: 0xff4d3d, hpBar: true, shield: true },
  saboteur: { hp: 80, speed: 2.9, dmg: 40, radius: 2.18, tier: 3, scale: 0.75, minWave: 4, label: 'Saboteur', color: 0x5b4a8a, ember: 0x7ed957, hpBar: true, deathBlast: 50, deathRadius: 5.5 }
};
export const ENEMY_ORDER = ['cinderling', 'torchbearer', 'ironhide', 'saboteur'];

export const BOSS = {
  name: 'THE CINDER TITAN',
  hp: 900,
  radius: 4.2,
  speed: 1.09,
  dmg: 50,
  attackInterval: 2.0,
  scale: 4.0
};

const KEG_BASE = [
  { x: 5.5, z: -14.5 },
  { x: 23.6, z: 0 },
  { x: -10.9, z: 14.5 }
];

function kegSpotsFor(wave) {
  const jitterRng = mulberry32(wave * 9301 + 49297);
  return KEG_BASE.map((spot) => ({
    x: Math.round((spot.x + range(jitterRng, -3.6, 3.6)) * 10) / 10,
    z: Math.round((spot.z + range(jitterRng, -3.6, 3.6)) * 10) / 10
  }));
}

function buildWaves() {
  const waves = [];
  for (let n = 1; n <= 10; n += 1) {
    const count = 6 + 2 * n;
    const interval = Math.max(0.8, 1.5 - 0.07 * n);
    const ironhides = n >= 3 ? Math.floor(count * 0.2) : 0;
    const saboteurs = n >= 4 ? Math.floor(count * 0.15) : 0;
    const cinderlings = Math.floor((count - ironhides - saboteurs) * 0.45);
    const torchbearers = count - ironhides - saboteurs - cinderlings;
    waves.push({
      wave: n,
      count,
      interval: Math.round(interval * 100) / 100,
      ironhides,
      saboteurs,
      cinderlings,
      torchbearers,
      kegs: kegSpotsFor(n),
      isBoss: n === 10,
      bossName: n === 10 ? BOSS.name : null
    });
  }
  return waves;
}

export const WAVES = buildWaves();

export const DIFFICULTIES = {
  STANDARD: { wall: 300, hpMul: 1.0, speedMul: 1.0 },
  HARD: { wall: 260, hpMul: 1.35, speedMul: 1.15 },
  INFERNO: { wall: 220, hpMul: 1.7, speedMul: 1.3 }
};
export const DIFF_ORDER = ['STANDARD', 'HARD', 'INFERNO'];

// Draft cards: mechanics identical to the verified 2D build (15 cards).
// Display text updated for the new boss name only (Titan Breaker vs Titan).
export const CARD_DEFS = [
  { id: 'trail_runner', name: 'Trail Runner', theme: 'trail', cost: 60, effect: 0.2, tier: 'COMMON', effectText: '-20% powder cost', synergy: 'Cheap lines leave coins for Wide Blast upgrades.' },
  { id: 'quick_burn', name: 'Quick Burn', theme: 'trail', cost: 90, effect: 0.18, tier: 'RARE', effectText: '+18% fuse speed', synergy: 'Cancels the long fuse that Trail Runner encourages.' },
  { id: 'wide_blast', name: 'Wide Blast', theme: 'trail', cost: 110, effect: 12, tier: 'RARE', effectText: '+12 blast radius', synergy: 'Overlaps Naphtha pools so one trail covers two lanes.' },
  { id: 'chain_window', name: 'Chain Window', theme: 'chain', cost: 80, effect: 0.5, tier: 'COMMON', effectText: '+0.5s chain window', synergy: 'Keeps Hot Streak alive between distant keg pops.' },
  { id: 'hot_streak', name: 'Hot Streak', theme: 'chain', cost: 140, effect: 1, tier: 'RARE', effectText: '+1 chain per kill', synergy: 'Needs Chain Window to reach the x8 tier.' },
  { id: 'bounty_powder', name: 'Bounty Powder', theme: 'chain', cost: 100, effect: 2, tier: 'COMMON', effectText: '+2 powder per kill', synergy: 'Pays off huge with the multi-kills of Wide Blast.' },
  { id: 'stone_skin', name: 'Stone Skin', theme: 'wall', cost: 120, effect: 60, tier: 'RARE', effectText: '+60 max wall HP', synergy: "Mason's Oath regen scales with the bigger wall." },
  { id: 'masons_oath', name: "Mason's Oath", theme: 'wall', cost: 180, effect: 8, tier: 'EPIC', effectText: '+8 wall regen / wave', synergy: 'Worth more after Stone Skin raises the maximum.' },
  { id: 'bramble_wall', name: 'Bramble Wall', theme: 'wall', cost: 150, effect: 14, tier: 'RARE', effectText: 'Wall thorns: 14 damage', synergy: 'Bleeds Ironhides already burning in Naphtha pools.' },
  { id: 'keg_plus_one', name: 'Powder Kegs +1', theme: 'fire', cost: 160, effect: 1, tier: 'EPIC', effectText: '+1 keg per wave', synergy: 'Adds a keg for Slow Match chains to reach.' },
  { id: 'keg_charge', name: 'Keg Charge', theme: 'fire', cost: 130, effect: 0.4, tier: 'RARE', effectText: '+40% keg blast', synergy: 'Every extra keg from Powder Kegs +1 hits harder.' },
  { id: 'slow_match', name: 'Slow Match', theme: 'fire', cost: 90, effect: 1.5, tier: 'COMMON', effectText: '+1.5s ground fire', synergy: 'Holds a lane with Wide Blast ground fire.' },
  { id: 'siege_breaker', name: 'Titan Breaker', theme: 'fire', cost: 200, effect: 1.0, tier: 'EPIC', effectText: '+100% damage vs Cinder Titan', synergy: 'Built for wave 10. The Cinder Titan will regret existing.' },
  { id: 'powder_pouch', name: 'Powder Pouch', theme: 'trail', cost: 100, effect: 40, tier: 'COMMON', effectText: '+40 max powder', synergy: 'More powder means longer trails and greedier chains.' },
  { id: 'overkill', name: 'Overkill', theme: 'chain', cost: 120, effect: 0.5, tier: 'RARE', effectText: '+50% score at x4+ chain', synergy: 'Pays off only when the chain is already huge.' }
];

export const FEATS = [
  { id: 'first_blood', name: 'First Blood', desc: 'Blast your first raider.', check: (w) => w.kills >= 1 },
  { id: 'chain_reaction', name: 'Chain Reaction', desc: 'Reach a x8 chain.', check: (w) => w.longestChain >= 5 },
  { id: 'keg_master', name: 'Keg Master', desc: 'Blow up 10 kegs in one run.', check: (w) => w.stats.kegsBlown >= 10 },
  { id: 'flawless_wall', name: 'Flawless Wall', desc: 'Clear a wave with a full wall.', check: (w) => w._flawlessWave === true },
  { id: 'cool_head', name: 'Cool Head', desc: 'Win with zero backfires.', check: (w) => w.phase === 'won' && w.stats.backfires === 0 },
  { id: 'boss_slayer', name: 'Boss Slayer', desc: 'Defeat the Cinder Titan.', check: (w) => !!(w.boss && w.boss.defeated) },
  { id: 'powder_hoarder', name: 'Powder Hoarder', desc: 'End a wave with 90+ powder.', check: (w) => w._hoarderWave === true },
  { id: 'speed_clear', name: 'Speed Clear', desc: 'Clear a wave in under 20s.', check: (w) => w._speedWave === true }
];

export function gradeChecklist(world) {
  return [
    { label: 'Wall 80%+ remaining', met: world.wallMax > 0 && world.wallHp / world.wallMax >= 0.8 },
    { label: 'Chain x8 reached', met: world.longestChain >= 5 },
    { label: 'Zero backfires', met: world.stats.backfires === 0 },
    { label: 'Cleared in under 6:00', met: world.time <= 360 }
  ];
}

export function gradeFor(world) {
  const order = ['S', 'A', 'B', 'C'];
  let scoreBand = 'C';
  if (world.score >= 20000) scoreBand = 'S';
  else if (world.score >= 14000) scoreBand = 'A';
  else if (world.score >= 8000) scoreBand = 'B';
  const metCount = gradeChecklist(world).filter((item) => item.met).length;
  let checklistCap = 'C';
  if (metCount === 4) checklistCap = 'S';
  else if (metCount === 3) checklistCap = 'A';
  else if (metCount === 2) checklistCap = 'B';
  return order[Math.max(order.indexOf(scoreBand), order.indexOf(checklistCap))];
}

// Sim tuning constants (verified 2D values, rescaled by PX).
export const SIM = {
  STEP_DT: 1 / 60,
  CHAIN_WINDOW: 1.2,
  MAX_PARTICLES: 300,
  BUILD_SECONDS: 5,
  POWDER_REGEN: 6,
  POWDER_MAX: 100,
  TRAIL_POINT_SPACING: 0.73, // 8px
  TRAIL_MIN_LENGTH: 3.6, // 40px
  KEG_RADIUS: 1.8, // 20px
  KEG_BLAST_RADIUS: 8.2, // 90px
  KEG_DAMAGE: 150,
  GROUND_FIRE_RADIUS: 3.6, // 40px
  GROUND_FIRE_DPS: 20,
  BACKFIRE_DAMAGE: 15,
  WAVE_CLEAR_POWDER: 25,
  WAVE_CLEAR_WALL: 20,
  WAVE_CLEAR_SCORE: 250, // x wave
  WAVE_CLEAR_COINS: 10, // x wave
  KILL_POWDER: 4,
  BOSS_BONUS_BASE: 2000,
  BOSS_BONUS_PER_WALL: 10
};
