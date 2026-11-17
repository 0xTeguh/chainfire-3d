// CHAINFIRE 3D — entry point: game loop, state machine, staging API.
// Written fresh for the 3D rebuild (Stage 1+). The sim advances in FIXED
// 1/60s steps only — the render loop never feeds wall-clock dt into the
// sim, so a staged run is byte-identical across machines.

import {
  createWorld, update, startTrail, addTrailPoint, endTrail, lightTrail,
  clearTrail, setPowderType, pickDraftCard, rerollDraft, offerDraft,
  loadProfile, saveProfile, recordRun
} from './sim.js';
import { Renderer } from './render3d.js';
import { UI } from './ui.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { SIM, WORLD } from './data.js';
import { terrainHeight } from './terrain.js';
import { wallTopY } from './fort.js';

const params = new URLSearchParams(window.location.search);
const SEED = (Number(params.get('seed') || '7') >>> 0) || 7;
const SHOT = params.get('shot') || null;
const FPS_MODE = params.get('fps') === '1';

// Staged profile for the title/results screenshots: the S-grade bot run's
// real numbers (seed 7, STANDARD — WON 213s, score 102,250, wall 360/360,
// kills 162, longest chain 23, grade S, feats 7/8), so BEST is consistent
// across all 4 shots. Last runs 2-3 are two earlier real 3D bot runs.
// ROUND 3 AGENT A — re-derived 17 Nov 21:xx WIB from the new bot runs
// (seed 7, STANDARD, BOT_FN unchanged): group spawning (item 2) makes
// kills bursty, so the chain breaks between groups — longestChain 23 -> 9
// and the chain-multiplied score falls. The win run is still S-grade,
// flawless wall, 7/8 feats (missing keg_master, 0 kegs blown), same 9
// cards. BEST 102,250 -> 69,650; lastRuns[0] = the new win run
// (69,650, S, wave 10, kills 160, longestChain 9, time 214s = 03:34).
// Lifetime = the 3 pre-change runs (a/b/c, unchanged) + the new S run:
// raiders 619 - 162 + 160 = 617, biggestChain max(9, 13, 10, 9) = 13
// (the old S run's 23 is superseded by the balance change — recorded in
// build-log-3d.md, ROUND 3 AGENT A). Numbers file:
// verify-3d/proof-r3a/numbers-new.json.
const STAGED_PROFILE = {
  best: 69650,
  feats: { unlocked: ['first_blood', 'flawless_wall', 'powder_hoarder', 'speed_clear', 'chain_reaction', 'cool_head', 'boss_slayer'], total: 8 },
  lifetime: { raidersBlown: 617, biggestChain: 13, runsPlayed: 4, wins: 3 },
  lastRuns: [
    { score: 69650, wave: 10, result: 'won', grade: 'S', kills: 160, longestChain: 9, time: 214 },
    { score: 58680, wave: 10, result: 'won', grade: 'A', kills: 147, longestChain: 10, time: 436 },
    { score: 57130, wave: 10, result: 'won', grade: 'A', kills: 155, longestChain: 9, time: 433 }
  ],
  seenCards: ['trail_runner', 'chain_window', 'keg_charge', 'powder_pouch', 'quick_burn', 'wide_blast', 'stone_skin', 'masons_oath', 'bounty_powder']
};

const canvas = document.getElementById('gl');
const renderer = new Renderer(canvas);
const audio = createAudio();
const profile = loadProfile();
if (profile.best > 0) profile.best = Math.max(profile.best, 0);

let world = null;
let mode = 'title'; // 'title' | 'play' | 'draft' | 'results' | 'help'
let helpReturn = 'play';
let paused = false; // user pause (shown in the UI)
let botPaused = false; // staging freeze (bot drives the sim; hidden from the UI)
let renderEnabled = true; // diagnostic: the shot tool disables WebGL rendering while the bot steps 10-17k sim steps (swiftshader rasterizes every frame and saturates the CPU); renderer.update() keeps running so all visual state stays current (events drained, flashes born in sim time, popup rects exact) — only the draw is skipped. Re-enabled before the screenshot; the frozen frame is identical.
let frozen = false; // staging freeze for title/smoke: stop stepDemo so the
// staged frame (burning demo trail, sway, clouds, birds) is byte-identical
// no matter when the screenshot lands — otherwise world.time advances with
// wall-clock dt and the capture timing changes the pixels.
let difficulty = 'STANDARD';
let demoTimer = 0;
let fpsFrames = 0;
let fpsStart = 0;
let fpsDone = false;

const ui = new UI(
  { hud: document.getElementById('hud'), bottom: document.getElementById('bottom'), screen: document.getElementById('screen'), toast: document.getElementById('toast') },
  {
    onPlay: () => startRun(difficulty, SEED),
    onDifficulty: (name) => { audio.unlock(); audio.play('click'); difficulty = name; ui.showTitle(profile, difficulty); },
    onLightFuse: () => { if (world) lightTrail(world); },
    onPause: () => togglePause(),
    onMute: () => toggleMute(),
    onHelp: () => showHelp(),
    onHelpClose: () => closeHelp(),
    onPowderType: (i) => { if (world) setPowderType(world, i); },
    onPickCard: (id) => {
      if (!world) return;
      if (pickDraftCard(world, id)) {
        profile.seenCards = profile.seenCards || [];
        if (!profile.seenCards.includes(id)) profile.seenCards.push(id);
        saveProfile(profile);
        audio.play('coin');
        mode = 'play';
        ui.hideScreens();
        ui.toast(`${id.replace(/_/g, ' ').toUpperCase()} picked!`);
      }
    },
    onReroll: () => {
      if (!world) return;
      if (mode === 'draft') {
        // ROUND 3 (item 13): UI click sound (the results branch is covered
        // by startRun below — do not double-play).
        audio.play('click');
        if (rerollDraft(world)) ui.showDraft(world, profile);
      } else if (mode === 'results') {
        startRun(difficulty, SEED);
      }
    },
    onSkipDraft: () => {
      if (!world) return;
      audio.play('click'); // ROUND 3 (item 13): UI click sound.
      world.draft = null;
      mode = 'play';
      ui.hideScreens();
    },
    onNewRun: () => startRun(difficulty, SEED),
    onMenu: () => { audio.play('click'); mode = 'title'; showTitle(); } // ROUND 3 (item 13): UI click sound.
  }
);

const input = createInput(canvas, renderer, {
  onTrailStart: (x, z) => {
    if (mode !== 'play' || paused || !world) return;
    if (world.phase !== 'combat' && world.phase !== 'build') return;
    startTrail(world, x, z);
    audio.unlock();
  },
  onTrailMove: (x, z) => {
    if (mode !== 'play' || paused || !world) return;
    addTrailPoint(world, x, z);
  },
  onTrailEnd: () => {
    if (mode !== 'play' || paused || !world) return;
    endTrail(world);
  },
  onTrailCancel: () => {
    if (!world) return;
    clearTrail(world);
  },
  onTap: () => {
    if (mode !== 'play' || paused || !world) return;
    if (world.trail && world.trail.state === 'armed') lightTrail(world);
  },
  onLightFuse: () => { if (world && mode === 'play') lightTrail(world); },
  onPause: () => togglePause(),
  onMute: () => toggleMute(),
  onReroll: () => {
    if (mode === 'draft' && world) {
      if (rerollDraft(world)) ui.showDraft(world, profile);
    }
  },
  onHelp: () => showHelp(),
  onEscape: () => {
    if (mode === 'help') closeHelp();
    else togglePause();
  },
  onPowderType: (i) => { if (world) setPowderType(world, i); },
  onOrbit: (dy, dp) => renderer.applyOrbit(dy, dp, 1),
  onZoom: (f) => renderer.applyOrbit(0, 0, f)
});

function toggleMute() {
  audio.play('click'); // ROUND 3 (item 13): UI click sound (plays while still unmuted; no-ops when muted).
  audio.unlock();
  audio.setMuted(!audio.isMuted());
  ui.setMuted(audio.isMuted());
}

function togglePause() {
  if (mode !== 'play') return;
  audio.play('click'); // ROUND 3 (item 13): UI click sound.
  paused = !paused;
  ui.toast(paused ? 'PAUSED' : 'RESUMED');
}

function showHelp() {
  if (mode === 'help') { closeHelp(); return; } // closeHelp plays the click — do not double-play.
  audio.play('click'); // ROUND 3 (item 13): UI click sound.
  helpReturn = mode;
  mode = 'help';
  ui.showHelp();
}

function closeHelp() {
  if (mode !== 'help') return;
  audio.play('click'); // ROUND 3 (item 13): UI click sound.
  mode = helpReturn;
  if (mode === 'title') showTitle();
  else ui.hideScreens();
}

function showTitle() {
  mode = 'title';
  paused = false;
  renderer.setCameraPreset('title');
  ui.showTitle(profile, difficulty);
  startDemoWorld();
}

function startDemoWorld() {
  // Attract-mode diorama: a fresh world that plays a demo trail on a loop.
  world = createWorld('STANDARD', 7);
  renderer.setWorld(world);
  demoTimer = 0;
  demoTrailDrawn = false;
}

let demoTrailDrawn = false;

function stepDemo(dt) {
  if (!world) return;
  demoTimer += dt;
  // Advance the demo world to combat, then draw + light a demo trail.
  if (world.phase === 'build' && world.time < 8) {
    update(world, SIM.STEP_DT);
    return;
  }
  if (world.phase === 'build') {
    update(world, SIM.STEP_DT);
    return;
  }
  if (!demoTrailDrawn) {
    // Demo trail: a sweeping curve across all three lanes.
    const pts = [];
    for (let i = 0; i <= 24; i += 1) {
      const f = i / 24;
      const x = 34 - f * 52;
      const z = -14.5 + Math.sin(f * Math.PI) * 24 + (f - 0.5) * 4;
      pts.push({ x, z });
    }
    startTrail(world, pts[0].x, pts[0].z);
    for (const p of pts.slice(1)) addTrailPoint(world, p.x, p.z);
    endTrail(world);
    lightTrail(world);
    demoTrailDrawn = true;
    return;
  }
  update(world, SIM.STEP_DT);
  // Loop the demo every ~9 seconds of sim time.
  if (demoTimer > 9) {
    startDemoWorld();
  }
}

function startRun(diffName, seed) {
  difficulty = diffName || difficulty;
  world = createWorld(difficulty, seed);
  renderer.setWorld(world);
  renderer.setCameraPreset('game');
  mode = 'play';
  paused = false;
  ui.hideScreens();
  ui.bark('waveStart', 0);
  audio.unlock();
  // ROUND 3 (item 13): UI click sound (PLAY / NEW RUN / reroll-in-results).
  // AFTER unlock(): on the first PLAY the context does not exist yet, so a
  // play() before unlock() would early-return silently.
  audio.play('click');
  audio.startAmbient();
  audio.setMusicMood('calm');
  input.setEnabled(true);
}

function drainAudioEvents() {
  if (!world || !world.events) return;
  for (const ev of world.events) {
    // ROUND 3 (item 13): the drain runs once per sim step, but the renderer
    // only clears the list once per frame — inside a runSteps() batch (or a
    // multi-step frame under lag) every event replayed once per step, so one
    // explosion sounded hundreds of times. Mark each event played; the
    // renderer still consumes + clears the list as before.
    if (ev._played) continue;
    ev._played = true;
    if (ev.type === 'chain') audio.play('chain', { pitch: world.chainMul });
    else if (ev.type === 'coin') audio.play('coin');
    else audio.play(ev.type);
    if (ev.type === 'backfire') ui.bark('backfire', world.wave);
    if (ev.type === 'boom' && world.chainMul >= 8) ui.bark('x8', world.wave);
  }
}

let lastPhase = null;
let lastDraft = null;

function checkPhaseTransitions() {
  if (!world) return;
  if (world.phase !== lastPhase) {
    if (world.phase === 'won' || world.phase === 'lost') {
      const won = world.phase === 'won';
      recordRun(profile, world);
      saveProfile(profile);
      mode = 'results';
      renderer.setCameraPreset('results');
      ui.showResults(world, profile, won);
      audio.setMusicMood(won ? 'victory' : 'off');
      audio.play(won ? 'victory' : 'defeat');
      ui.bark(won ? 'win' : 'lose', world.wave);
    }
    if (world.phase === 'combat' && world.wave === 10 && world.boss && world.boss.alive) {
      ui.bark('boss', 10);
      audio.setMusicMood('tense');
    }
    lastPhase = world.phase;
  }
  if (world.draft && world.draft !== lastDraft && mode === 'play') {
    mode = 'draft';
    ui.showDraft(world, profile);
    audio.play('horn');
  }
  lastDraft = world.draft;
}

// --- staging API ----------------------------------------------------------
// Deterministic setups for the shot tool (window.__chainfire3d).
function runSteps(n) {
  for (let i = 0; i < n; i += 1) {
    if (!world) break;
    update(world, SIM.STEP_DT);
    drainAudioEvents();
    checkPhaseTransitions();
  }
  renderer.update(SIM.STEP_DT);
  renderer.render();
}

function stageTitle() {
  // Demo world, combat phase, demo trail burning mid-frame, title UI with
  // the staged profile (BEST 71,150 — consistent with the results shot).
  world = createWorld('STANDARD', 7);
  renderer.setWorld(world);
  renderer.setCameraPreset('title');
  mode = 'title';
  // Fast-forward: build (5s) + 2s of combat.
  for (let i = 0; i < 420; i += 1) update(world, SIM.STEP_DT);
  const pts = [];
  for (let i = 0; i <= 24; i += 1) {
    const f = i / 24;
    pts.push({ x: 34 - f * 52, z: -14.5 + Math.sin(f * Math.PI) * 24 + (f - 0.5) * 4 });
  }
  startTrail(world, pts[0].x, pts[0].z);
  for (const p of pts.slice(1)) addTrailPoint(world, p.x, p.z);
  endTrail(world);
  lightTrail(world);
  for (let i = 0; i < 40; i += 1) update(world, SIM.STEP_DT);
  ui.showTitle(STAGED_PROFILE, 'STANDARD');
  renderer.update(SIM.STEP_DT);
  renderer.render();
  frozen = true;
  window.__shotReady = true;
}

function stageDraft() {
  // Wave 5 cleared, draft offered, board visible behind the cards.
  // Numbers are the REAL S-grade bot run's state at the wave-5 draft
  // (seed 7): score 21,050, coins 360, powder 140, wall 300/300, 4 cards
  // picked, offered [quick_burn, siege_breaker, bounty_powder].
  // ROUND 3 AGENT A: re-derived — only the score changed vs the old run
  // (28,450 -> 21,050); coins, powder, wall, picked and offered are
  // identical to the old run (see verify-3d/proof-r3a/numbers-new.json).
  world = createWorld('STANDARD', 7);
  renderer.setWorld(world);
  renderer.setCameraPreset('draft');
  mode = 'draft';
  world.clearedWave = 5;
  world.wave = 6;
  world.score = 21050;
  world.coins = 360;
  world.wallHp = 300;
  world.wallMax = 300;
  world.powder = 140;
  world.powderMax = 140;
  world.pickedCards = ['trail_runner', 'chain_window', 'keg_charge', 'powder_pouch'];
  world.nextInfo = { label: '8 Torchbearers + 5 Cinderlings + 3 Ironhides + 2 Saboteurs' };
  world.draft = { offered: ['quick_burn', 'siege_breaker', 'bounty_powder'], rerolls: 0, rerollCost: 25 };
  ui.showDraft(world, STAGED_PROFILE);
  renderer.update(SIM.STEP_DT);
  renderer.render();
  window.__shotReady = true;
}

function stageResults(stagedWorld) {
  // Results screen from a real (bot-played) run's final world state.
  const w = stagedWorld || world;
  if (!w) return;
  world = w;
  renderer.setWorld(world);
  renderer.setCameraPreset('results');
  mode = 'results';
  const prof = loadProfile();
  // Merge the staged lifetime numbers so the screen is consistent.
  // BEST comes from STAGED_PROFILE (102,250), NOT the live profile — the
  // live profile is empty in headless, which made "NEW BEST!" show even
  // for a score-0 demo world (isBest was score >= score, always true).
  // Coherence (P11): LAST RUNS[0] IS this win run (same score/grade/wave
  // as STAGED_PROFILE.lastRuns[0]) — but the staged record's time (212s)
  // is from an earlier win; the live run took 212.6s, so TIME showed
  // 03:33 while LAST RUNS showed 03:32. Use the live run's rounded time
  // for that entry so TIME and LAST RUNS agree for the same run.
  const lastRuns = STAGED_PROFILE.lastRuns.map((r, i) =>
    (i === 0 && world.phase === 'won') ? { ...r, time: Math.round(world.time) } : r);
  ui.showResults(world, {
    best: Math.max(STAGED_PROFILE.best, world.score, prof.best),
    feats: { unlocked: world.featsUnlocked || [], total: 8 },
    lifetime: STAGED_PROFILE.lifetime,
    lastRuns
  }, world.phase === 'won');
  renderer.update(SIM.STEP_DT);
  renderer.render();
  window.__shotReady = true;
}

function captureCharacter(kind) {
  // Close-up of one character for the 9 character captures.
  // The boot sequence shows the title screen first — hide it, or the DOM
  // panel covers the canvas (bug found 06:10 WIB: all 9 captures showed
  // the title screen with the character hidden behind the panel).
  ui.hideScreens();
  ui.setChrome(false);
  world = createWorld('STANDARD', 7);
  renderer.setWorld(world);
  renderer.setCameraPreset('game');
  // Spawn the character at a fixed spot in front of the camera.
  const defs = {
    cinderling: { x: 6, z: -6 }, torchbearer: { x: 6, z: -6 },
    ironhide: { x: 6, z: -6 }, saboteur: { x: 6, z: -6 },
    titan: { x: 2, z: 0 },
    wren: { x: -40, z: -5 }, pip: { x: -40, z: -14 },
    thom: { x: -40, z: 6 }, mira: { x: -40, z: 14 }
  };
  const pos = defs[kind] || { x: 6, z: -6 };
  const isDefender = ['wren', 'pip', 'thom', 'mira'].includes(kind);
  const isBoss = kind === 'titan';
  // Character heights in world units (base 3.2u x scale). The camera sits on
  // the FRONT side — faces are on -x for the Horde, +x for the Garrison — at
  // ~2.5x the height, so the face fills the frame. First capture pass put the
  // camera BEHIND the enemies (faces invisible) and too close for Ironhide
  // (head cut off); the defenders were too far and small.
  const HEIGHTS = {
    cinderling: 1.92, torchbearer: 3.2, ironhide: 6.4, saboteur: 2.4, titan: 12.8,
    wren: 3.2, pip: 1.76, thom: 3.36, mira: 3.04
  };
  const h = HEIGHTS[kind] || 3.2;
  const d = 2.5 * h;
  // Build the character through the renderer's own pools by faking a world.
  if (isBoss) {
    world.boss = { name: 'THE CINDER TITAN', hp: 900, maxHp: 900, x: pos.x, z: pos.z, lane: 1, radius: 4.2, speed: 1.09, dmg: 50, attackTimer: 0, alive: true, defeated: false, state: 'walk' };
    world.wave = 10;
    const y = terrainHeight(pos.x, pos.z);
    renderer.setCameraFree([pos.x - 0.7 * d, y + 0.62 * h, pos.z + 0.7 * d], [pos.x, y + 0.55 * h, pos.z]);
  } else if (isDefender) {
    // Defenders face +x (toward the horde / camera). Pip is short — his head
    // barely clears the parapet, so his camera is higher and closer. Thom's
    // face did not read at a 45-degree angle (wide-brim hat + beard shadow
    // it), so his camera is nearly frontal.
    const lift = kind === 'pip' ? 2.0 : 0.35;
    const dd = kind === 'pip' ? 1.7 * h : d;
    const xf = kind === 'thom' ? 0.9 : 0.7;
    const zf = kind === 'thom' ? 0.25 : 0.7;
    renderer.setCameraFree(
      [WORLD.WALL_X + xf * dd, wallTopY(pos.z) + 0.62 * h + lift, pos.z + zf * dd],
      [WORLD.WALL_X - 0.5, wallTopY(pos.z) + 0.55 * h, pos.z]);
  } else {
    world.enemies.push({
      id: 9001, type: kind, hp: 100, maxHp: 100, speed: 0, dmg: 0, radius: 2,
      x: pos.x, z: pos.z, lane: 1, bobPhase: 0, bob: 0, dead: false,
      shieldBroken: kind === 'ironhide' ? false : false, anim: 'walk', animT: 1.2, deathT: 0
    });
    world.phase = 'combat';
    const y = terrainHeight(pos.x, pos.z);
    renderer.setCameraFree([pos.x - 0.7 * d, y + 0.62 * h, pos.z + 0.7 * d], [pos.x, y + 0.55 * h, pos.z]);
  }
  for (let i = 0; i < 72; i += 1) update(world, SIM.STEP_DT);
  renderer.update(SIM.STEP_DT);
  renderer.render();
  // Freeze the sim after the staged render: mode 'draft' advances nothing
  // in the rAF loop, so the frame is deterministic (same fix as the title
  // shot's `frozen` flag — play mode would keep stepping on wall-clock dt).
  mode = 'draft';
  window.__shotReady = true;
}

// --- main loop ------------------------------------------------------------
let lastT = performance.now();
let acc = 0;
let frames = 0;
let firstFrame = true;

function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = Math.min(100, now - lastT);
  lastT = now;
  const dt = dtMs / 1000;

  if (FPS_MODE && !fpsDone) {
    if (fpsStart === 0) fpsStart = now;
    fpsFrames += 1;
    if (now - fpsStart >= 60000) {
      fpsDone = true;
      const seconds = (now - fpsStart) / 1000;
      window.__fpsResult = { frames: fpsFrames, seconds: Math.round(seconds * 10) / 10, avgFps: Math.round((fpsFrames / seconds) * 10) / 10 };
      window.__shotReady = true;
    }
  }

  if (mode === 'title' && !frozen) {
    stepDemo(dt);
  } else if (mode === 'play' && !paused && !botPaused && world) {
    acc += dt;
    let steps = 0;
    while (acc >= SIM.STEP_DT && steps < 5) {
      update(world, SIM.STEP_DT);
      drainAudioEvents();
      acc -= SIM.STEP_DT;
      steps += 1;
    }
    if (steps >= 5) acc = 0;
    checkPhaseTransitions();
  } else if (mode === 'draft' || mode === 'results') {
    // Frozen: the sim does not advance while a screen is up.
  }

  if (world) {
    renderer.update(SIM.STEP_DT);
    ui.update(world, paused);
  }
  // Chrome (HUD + bottom bar) is only visible while actually playing.
  ui.setChrome(mode === 'play');
  if (renderEnabled) renderer.render();

  if (firstFrame) {
    firstFrame = false;
    if (!SHOT && !FPS_MODE) window.__shotReady = true;
  }
  frames += 1;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// Boot.
showTitle();
if (SHOT === 'title') stageTitle();
else if (SHOT === 'draft') stageDraft();
else if (SHOT && SHOT.startsWith('capture:')) captureCharacter(SHOT.slice(8));
else if (SHOT === 'smoke') {
  // Minimal deterministic frame (Stage 0 smoke): bare 3D scene, no UI.
  ui.hideScreens();
  ui.setChrome(false);
  renderer.update(SIM.STEP_DT);
  renderer.render();
  frozen = true;
  window.__shotReady = true;
}
if (FPS_MODE) {
  // Busy scene for the 60s fps log: wave-8-style combat — a live world with
  // a full field of enemies, a burning trail, and the beacon armed.
  world = createWorld('STANDARD', 7);
  renderer.setWorld(world);
  renderer.setCameraPreset('action');
  mode = 'play';
  ui.hideScreens();
  // Fast-forward to combat, then inject a busy field directly (deterministic
  // — the fps log measures render cost, not sim fairness).
  for (let i = 0; i < 300; i += 1) update(world, SIM.STEP_DT);
  const fpsRng = { i: 0 };
  const kinds = ['cinderling', 'torchbearer', 'ironhide', 'saboteur'];
  for (let n = 0; n < 24; n += 1) {
    const kind = kinds[n % 4];
    const def = { cinderling: { hp: 60 }, torchbearer: { hp: 100 }, ironhide: { hp: 220 }, saboteur: { hp: 80 } }[kind];
    world.enemies.push({
      id: 5000 + n, type: kind, hp: def.hp, maxHp: def.hp,
      speed: 3, dmg: 10, radius: 2,
      x: 10 + (n % 8) * 5, z: WORLD.LANES_Z[n % 3] + ((n % 5) - 2) * 1.2,
      lane: n % 3, bobPhase: n * 0.7, bob: 0, dead: false,
      shieldBroken: false, anim: 'walk', animT: n * 0.3, deathT: 0
    });
    fpsRng.i += 1;
  }
  world.wave = 8;
  world.chain = 5;
  world.chainMul = 8;
  world.chainTimer = 1.2;
  const pts = [];
  for (let i = 0; i <= 20; i += 1) {
    const f = i / 20;
    pts.push({ x: 30 - f * 40, z: -12 + Math.sin(f * Math.PI) * 20 });
  }
  startTrail(world, pts[0].x, pts[0].z);
  for (const p of pts.slice(1)) addTrailPoint(world, p.x, p.z);
  endTrail(world);
  lightTrail(world);
}

window.__chainfire3d = {
  get world() { return world; },
  get mode() { return mode; },
  get profile() { return profile; },
  renderer, ui, audio, input,
  // Diagnostic hook (no gameplay effect): step the sim without rendering,
  // so a bot diagnostic can reproduce a run in-page in seconds instead of
  // paying a WebGL render per step. Used by verify/x8-debug.cjs only.
  _debug: { simUpdate: update, setRenderEnabled: (v) => { renderEnabled = !!v; } },
  STAGED_PROFILE,
  newRun: startRun,
  runSteps,
  // Staging freeze: stops the rAF loop from stepping the sim while the bot
  // drives it via runSteps. Separate from the USER pause (which the HUD
  // shows as RESUME) — the bot's freeze must not leak into the screenshot.
  pause(v) { botPaused = !!v; },
  drawTrail(points) {
    if (!world || !Array.isArray(points) || points.length === 0) return false;
    startTrail(world, points[0].x, points[0].z);
    for (const p of points.slice(1)) addTrailPoint(world, p.x, p.z);
    endTrail(world);
    return !!(world.trail && world.trail.state === 'armed');
  },
  light() { if (world) lightTrail(world); },
  pickCard(id) {
    if (!world) return false;
    const ok = pickDraftCard(world, id);
    if (ok) {
      // Mirror the UI's onPickCard exactly: mark the card seen (NEW! pills),
      // return to play mode and hide the draft screen. Without this the
      // draft overlay from wave 1 stays on screen forever while the sim
      // keeps playing behind it (bug found in the 03:18 action capture:
      // 2-action.jpg showed the stale wave-1 draft over the wave-8 scene).
      profile.seenCards = profile.seenCards || [];
      if (!profile.seenCards.includes(id)) profile.seenCards.push(id);
      saveProfile(profile);
      mode = 'play';
      ui.hideScreens();
    }
    return ok;
  },
  skipDraft() { if (!world) return; world.draft = null; mode = 'play'; ui.hideScreens(); },
  snapshot() {
    if (!world) return null;
    return {
      phase: world.phase, wave: world.wave, clearedWave: world.clearedWave, score: world.score,
      powder: world.powder, coins: world.coins, wallHp: world.wallHp,
      chain: world.chain, chainMul: world.chainMul,
      enemies: world.enemies.filter((e) => !e.dead).map((e) => ({ x: e.x, z: e.z, type: e.type, hp: e.hp })),
      kegs: world.kegs.filter((k) => k.alive).map((k) => ({ x: k.x, z: k.z })),
      boss: world.boss ? { x: world.boss.x, z: world.boss.z, hp: world.boss.hp, alive: world.boss.alive } : null,
      trail: world.trail ? { state: world.trail.state, burnDist: world.trail.burnDist } : null,
      draft: world.draft ? world.draft.offered.slice() : null
    };
  },
  stageTitle,
  stageDraft,
  stageResults,
  captureCharacter,
  setCameraPreset: (name) => renderer.setCameraPreset(name),
  popupRects: () => renderer.popupRects(),
  state() {
    if (!world) return null;
    return {
      mode, phase: world.phase, wave: world.wave, clearedWave: world.clearedWave, score: world.score,
      wallHp: world.wallHp, wallMax: world.wallMax, powder: world.powder,
      coins: world.coins, kills: world.kills, chain: world.chain,
      chainMul: world.chainMul, longestChain: world.longestChain,
      enemies: world.enemies.length, queue: world.spawnQueue.length,
      time: world.time, grade: world.grade,
      boss: world.boss ? { hp: world.boss.hp, maxHp: world.boss.maxHp, alive: world.boss.alive } : null,
      draft: world.draft ? world.draft.offered : null,
      trail: world.trail ? { state: world.trail.state, burnDist: world.trail.burnDist } : null
    };
  }
};

requestAnimationFrame(frame);
