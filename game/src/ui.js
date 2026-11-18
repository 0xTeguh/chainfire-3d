// CHAINFIRE 3D — DOM UI: HUD, title, draft, results, help screens.
// All text is English. Screens are DOM overlays on top of the live 3D scene
// (the diorama behind the title is the real game world). Written fresh.

import { CARD_DEFS, FEATS, POWDER_TYPES, POWDER_ORDER, DIFF_ORDER, WAVES, ENEMY_TYPES, gradeFor } from './data.js';

const ROSTER_STRIP = [
  { name: 'Cinderling', color: '#ff7a1a', role: 'Fast ember' },
  { name: 'Torchbearer', color: '#ff2d1e', role: 'Hooded torch' },
  { name: 'Ironhide', color: '#b8b0a0', role: 'Shield tank' },
  { name: 'Saboteur', color: '#9a7bff', role: 'Fuse-eater' },
  { name: 'CINDER TITAN', color: '#e85d26', role: 'Boss · 900 HP' },
  { name: 'Wren', color: '#2e5e8a', role: 'Captain' },
  { name: 'Pip', color: '#c86a2e', role: 'Powder-monkey' },
  { name: 'Old Thom', color: '#8a8a8a', role: 'Veteran' },
  { name: 'Mira', color: '#2e8a7a', role: 'Engineer' }
];

// ROUND 3 AGENT D (item 5): THREAT -> ANSWER roster for the title — each
// Horde type's behaviour and the honest counter (real mechanics: a
// cinderling has 60 HP vs a 100-damage blast, so one blast kills it; the
// ironhide's shield soaks the first blast visually, so it needs a second
// hit or a keg; the saboteur eats fuses, so light fast).
const THREAT_ANSWERS = [
  { name: 'Cinderling', color: '#ff7a1a', behavior: 'Fast swarm, dies in 1 blast', answer: 'Chain the pack' },
  { name: 'Torchbearer', color: '#ff2d1e', behavior: 'Hooded, carries fire to the wall', answer: 'Blast it at range' },
  { name: 'Ironhide', color: '#b8b0a0', behavior: 'Shield soaks the 1st blast', answer: 'Hit twice — or a keg' },
  { name: 'Saboteur', color: '#9a7bff', behavior: 'Eats your fuse if it digs in', answer: 'Light fast, short trails' },
  { name: 'CINDER TITAN', color: '#e85d26', behavior: '900 HP boss, breaks the wall', answer: 'Titan Breaker + keg chains' }
];

// Dot colors for the threat-queue panel (same roster colors as the title).
const THREAT_DOT = { cinderling: '#ff7a1a', torchbearer: '#ff2d1e', ironhide: '#b8b0a0', saboteur: '#9a7bff', titan: '#e85d26' };

// Chain tiers (same thresholds as sim.js chainMultiplier): x2 at 2 links,
// x4 at 3, x8 at 5. Progress to the next tier is chain / nextThreshold.
const CHAIN_TIERS = [{ min: 2, mul: 2 }, { min: 3, mul: 4 }, { min: 5, mul: 8 }];

const BARKS = {
  waveStart: ['Hold the line!', 'They come again — steady!', 'Powder ready. Wait for my mark.'],
  x8: ['NOW! LIGHT IT!', 'The whole field is ours!', 'CHAIN IT ALL!'],
  backfire: ['Careful! That was OUR wall!', 'Mind the fuse, Pip!'],
  boss: ['THE TITAN! Aim for the core!', 'All powder on the Titan!'],
  win: ['The fort stands! The fort STANDS!', 'We did it, crew!'],
  lose: ['Fall back… the fort is lost.', 'We will rebuild. We always do.']
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function fmtTime(t) {
  // Round FIRST, then floor-divide: the recorded run time is Math.round'd
  // (sim.js recordRun), so a raw float here showed 07:01 for the same run
  // whose LAST RUNS entry showed 07:02. One rounding rule everywhere.
  const rt = Math.round(t);
  const m = Math.floor(rt / 60);
  const s = Math.floor(rt % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function nextGoal(world, profile) {
  const unlocked = new Set(world.featsUnlocked || []);
  if (!unlocked.has('keg_master')) return 'Unlock Keg Master';
  if (world.grade !== 'S') return 'Win with grade S';
  if (world.difficultyName === 'STANDARD') return 'Win on HARD';
  if (world.difficultyName === 'HARD') return 'Win on INFERNO';
  return 'Win on INFERNO with zero backfires';
}

export class UI {
  constructor(refs, callbacks) {
    this.refs = refs;
    this.cb = callbacks;
    this.lastHud = {};
    this.barkTimer = 0;
    // ROUND 3 AGENT D (item 1): event-banner trackers. Reset to the neutral
    // baseline whenever the world object changes (a new run / a staged
    // world) — NOT to the world's current values, or the first observation
    // after a bot-driven freeze would swallow the tier-up (the bot steps
    // the sim synchronously inside one evaluate, so no rAF frame observes
    // the intermediate states; the banner is set from the frozen state).
    this._bannerWorld = null;
    this._banner = null;
    this._lastChainMul = 1;
    this._lastTrailState = null;
    this._bossDownShown = false;
    this._buildHud();
    this._buildBottom();
  }

  _buildHud() {
    const hud = this.refs.hud;
    hud.innerHTML = '';
    const left = el('div', 'hud-left');
    this.hudWave = el('div', 'hud-chip hud-wave', 'WAVE 1/10');
    this.hudScore = el('div', 'hud-chip', 'SCORE 0');
    this.hudBest = el('div', 'hud-chip', 'BEST 0');
    // ROUND 3 AGENT D (item 3): prominent live grade badge, computed every
    // frame from the same gradeFor() the results screen uses.
    this.hudGrade = el('div', 'hud-chip hud-grade', 'GRADE C');
    left.append(this.hudWave, this.hudScore, this.hudBest, this.hudGrade);
    const mid = el('div', 'hud-mid');
    this.hudMult = el('div', 'hud-mult', 'x1');
    this.hudChain = el('div', 'hud-chip hud-chain', 'CHAIN 0');
    // ROUND 3 AGENT D (item 7): progress to the next chain tier — a thin
    // bar under the CHAIN chip, full gold at the x8 max tier.
    this.hudChainProg = el('div', 'chain-progress');
    this.hudChainProgFill = el('div', 'chain-progress-fill');
    this.hudChainProg.append(this.hudChainProgFill);
    this.hudLeft = el('div', 'hud-chip', '0 LEFT');
    // ROUND 3 AGENT D (item 6): boss bar + phase, only while the Titan
    // lives (wave 10). Name + phase line, HP bar, HP numbers.
    this.hudBoss = el('div', 'boss-bar');
    this.hudBossName = el('div', 'boss-name', 'CINDER TITAN');
    this.hudBossPhase = el('div', 'boss-phase', 'PHASE 1 · STOKING');
    const bossBarWrap = el('div', 'boss-bar-track');
    this.hudBossFill = el('div', 'boss-bar-fill');
    bossBarWrap.append(this.hudBossFill);
    this.hudBossHp = el('span', 'boss-hp', '900/900');
    const bossBarRow = el('div', 'boss-bar-row');
    bossBarRow.append(bossBarWrap, this.hudBossHp);
    this.hudBoss.append(this.hudBossName, this.hudBossPhase, bossBarRow);
    mid.append(this.hudMult, this.hudChain, this.hudChainProg, this.hudLeft, this.hudBoss);
    const right = el('div', 'hud-right');
    this.hudWall = el('div', 'hud-chip');
    this.hudWallBar = el('div', 'hud-bar-fill');
    const wallWrap = el('div', 'hud-bar');
    wallWrap.append(this.hudWallBar);
    this.hudWall.append(el('span', '', 'WALL '), wallWrap, el('span', 'hud-wall-num', '300/300'));
    this.hudPowder = el('div', 'hud-chip');
    this.hudPowderBar = el('div', 'hud-bar-fill hud-bar-powder');
    const powWrap = el('div', 'hud-bar');
    powWrap.append(this.hudPowderBar);
    this.hudPowder.append(el('span', '', 'POWDER '), powWrap, el('span', 'hud-powder-num', '100'));
    this.hudCoins = el('div', 'hud-chip', 'COINS 0');
    this.hudFuse = el('div', 'hud-chip hud-fuse', 'FUSE: READY');
    right.append(this.hudWall, this.hudPowder, this.hudCoins, this.hudFuse);
    hud.append(left, mid, right);
    // (The bark lives in #bottom now — see _buildBottom.)
    // ROUND 3 AGENT D (item 4): threat-queue panel — live counts of what is
    // on the field, what is still queued, the NEXT group to spawn, and the
    // kegs' live readiness %. Absolute, top-right below the HUD (same row
    // as the bark, which is centered — no overlap at 1280px). Lives inside
    // #hud, so it only shows in play mode. Content is rendered by
    // _updateThreatPanel() (one innerHTML write, only when it changes).
    this.threatPanel = el('div', 'threat-panel');
    this._threatHtml = null;
    hud.append(this.threatPanel);
    // ROUND 3 AGENT D (item 1): big moment text in the action frame
    // ("CHAIN x8!" / "TRAIL IGNITED!" / "TITAN DOWN!"). Set from
    // updateEventBanner() on sim-state transitions; shown for 3 sim-seconds
    // (world.time is frozen in staged shots, so it holds for the capture).
    // Also inside #hud, so it only ever shows in play mode.
    this.eventBanner = el('div', 'event-banner', '');
    this.eventBanner.style.display = 'none';
    hud.append(this.eventBanner);
    // ROUND 6 AGENT C (P1): giant event word at the x8 peak ("CHAINFIRE!").
    // Shown in the same 3s window as the CHAIN x8! banner (see
    // updateEventBanner). Also inside #hud, so play mode only.
    this.eventWord = el('div', 'event-word', 'CHAINFIRE!');
    this.eventWord.style.display = 'none';
    hud.append(this.eventWord);
  }

  _buildBottom() {
    const bar = this.refs.bottom;
    bar.innerHTML = '';
    const powderBox = el('div', 'powder-box');
    this.powderBtns = [];
    this.powderLabels = [];
    POWDER_ORDER.forEach((type, i) => {
      const def = POWDER_TYPES[type];
      // ROUND 4 AGENT C (item 14): two lines — the powder name over its
      // real effect + cost (def.effect is real mechanics from data.js).
      // The ✓ selected marker is set in update() (see below).
      const b = el('button', 'powder-btn');
      const lab = el('span', 'powder-label', def.label);
      const eff = el('span', 'powder-effect', `${def.effect} · ${def.costPer12px} POWDER`);
      b.append(lab, eff);
      b.style.setProperty('--powder-color', `#${def.glow.toString(16).padStart(6, '0')}`);
      b.addEventListener('click', () => this.cb.onPowderType(i));
      powderBox.append(b);
      this.powderBtns.push(b);
      this.powderLabels.push(lab);
    });
    this.lightBtn = el('button', 'light-btn', 'LIGHT FUSE');
    this.lightBtn.addEventListener('click', () => this.cb.onLightFuse());
    const ctl = el('div', 'ctl-box');
    this.pauseBtn = el('button', 'ctl-btn', 'PAUSE (P)');
    this.pauseBtn.addEventListener('click', () => this.cb.onPause());
    // ROUND 6 AGENT C (P9): the SOUND button carries its label in a span
    // (so setMuted never wipes the ♪ badge) + a ♪ badge that pulses while
    // audio is live (driven by frozen world.time in update() — the staged
    // shot stays deterministic). Badge is supporting evidence only; the
    // real proof is Rizal hearing the fuse hiss + chain blasts on his phone.
    this._muted = false;
    this.muteBtn = el('button', 'ctl-btn');
    this.muteLabel = el('span', '', 'SOUND ON (M)');
    this.muteNote = el('span', 'sound-note', '♪');
    this.muteNote.style.display = 'none';
    this.muteBtn.append(this.muteLabel, this.muteNote);
    this.muteBtn.addEventListener('click', () => this.cb.onMute());
    this.helpBtn = el('button', 'ctl-btn', 'HELP (H)');
    this.helpBtn.addEventListener('click', () => this.cb.onHelp());
    ctl.append(this.pauseBtn, this.muteBtn, this.helpBtn);
    bar.append(powderBox, this.lightBtn, ctl);
    // ROUND 4 AGENT C (item 6): the bark lives here, absolutely positioned
    // just above the bar (bottom: calc(100% + 8px) in CSS) — it tracks the
    // bar's real height at every viewport, so it can never overlap the
    // powder buttons (a fixed bottom:58px collided with them at 844x390
    // and 390x844, where the wrapped two-line buttons make the bar
    // taller). It must be created AFTER bar.innerHTML = '' above, or it
    // would be wiped. #bottom hides with the chrome on screens, so the
    // bark hides with it (no win-bark over the results screen).
    this.barkLine = el('div', 'bark', '');
    bar.append(this.barkLine);
    // ROUND 5 AGENT C (item #7): minimap — a live schematic of the field
    // (fort, trail, enemies, Titan), drawn from world state every frame
    // by _updateMinimap(). A canvas inside #bottom, bottom-right above
    // the ctl-box, so it hides with the chrome on screens. Deterministic:
    // a pure function of world state (no rng, no clock) — the frozen
    // shot is byte-identical across runs.
    this.minimapWrap = el('div', 'minimap-wrap');
    this.minimapLabel = el('div', 'minimap-label', 'MAP');
    this.minimap = document.createElement('canvas');
    this.minimap.width = 150;
    this.minimap.height = 104;
    this.minimapWrap.append(this.minimapLabel, this.minimap);
    bar.append(this.minimapWrap);
    // ROUND 5 AGENT C (item #8): 10-wave journey strip — waves 1-10, the
    // run's journey at a glance. Centred above LIGHT FUSE, inside #bottom.
    // Segments are numbered; done waves green, the current wave gold.
    this.waveStrip = el('div', 'wave-strip');
    this.waveStrip.append(el('span', 'wave-strip-label', 'WAVES'));
    this.waveSegs = [];
    for (let i = 1; i <= 10; i += 1) {
      const seg = el('div', 'wave-seg', String(i));
      this.waveStrip.append(seg);
      this.waveSegs.push(seg);
    }
    bar.append(this.waveStrip);
  }

  _setText(node, key, value) {
    if (this.lastHud[key] !== value) {
      this.lastHud[key] = value;
      node.textContent = value;
    }
  }

  update(world, paused) {
    if (!world) return;
    this._setText(this.hudWave, 'wave', `WAVE ${world.wave}/10`);
    this._setText(this.hudScore, 'score', `SCORE ${Math.floor(world.score).toLocaleString('en-US')}`);
    this._setText(this.hudBest, 'best', `BEST ${Math.floor(Math.max(world.best, world.score)).toLocaleString('en-US')}`);
    // ROUND 3 AGENT D (item 3): live grade badge — same gradeFor() the
    // results screen uses, so the HUD grade and the final grade agree.
    const liveGrade = gradeFor(world);
    this._setText(this.hudGrade, 'grade', `GRADE ${liveGrade}`);
    this.hudGrade.classList.toggle('grade-s', liveGrade === 'S');
    this._setText(this.hudMult, 'mult', `x${world.chainMul}`);
    this.hudMult.classList.toggle('mult-hot', world.chainMul >= 4);
    this.hudMult.classList.toggle('mult-max', world.chainMul >= 8);
    // ROUND 3 AGENT D (item 7): bigger chain counter — the chip carries the
    // current chain AND the next tier (or MAX at x8); the bar under it is
    // the progress to that tier (chain / next threshold).
    let chainText = `CHAIN ${world.chain}`;
    let chainProg = 0;
    if (world.chainMul >= 8) {
      chainText += ' · x8 MAX';
      chainProg = 1;
    } else {
      const next = CHAIN_TIERS.find((t) => t.mul > world.chainMul);
      if (next) {
        chainText += ` · → x${next.mul}`;
        chainProg = Math.min(1, world.chain / next.min);
      }
    }
    this._setText(this.hudChain, 'chain', chainText);
    this.hudChainProgFill.style.width = `${Math.round(chainProg * 100)}%`;
    this.hudChainProgFill.classList.toggle('chain-progress-max', world.chainMul >= 8);
    const left = world.spawnQueue.length + world.enemies.filter((e) => !e.dead).length + (world.boss && world.boss.alive ? 1 : 0);
    this._setText(this.hudLeft, 'left', `${left} LEFT`);
    // ROUND 3 AGENT D (item 6): boss bar + phase. Phases by HP: >50%
    // STOKING, 25–50% ENRAGED, <25% BURNING OUT. Hidden unless the Titan
    // is alive (wave 10) — no dead bar hanging around after the win.
    const bossAlive = !!(world.boss && world.boss.alive && world.wave >= 10);
    this.hudBoss.style.display = bossAlive ? '' : 'none';
    if (bossAlive) {
      const frac = world.boss.maxHp > 0 ? world.boss.hp / world.boss.maxHp : 0;
      const phase = frac > 0.5 ? 'PHASE 1 · STOKING' : frac > 0.25 ? 'PHASE 2 · ENRAGED' : 'PHASE 3 · BURNING OUT';
      this._setText(this.hudBossPhase, 'bossphase', phase);
      this.hudBossFill.style.width = `${Math.round(frac * 100)}%`;
      this._setText(this.hudBossHp, 'bosshp', `${Math.ceil(world.boss.hp)}/${world.boss.maxHp}`);
    }
    const wallFrac = world.wallMax > 0 ? world.wallHp / world.wallMax : 0;
    this.hudWallBar.style.width = `${Math.round(wallFrac * 100)}%`;
    this.hudWallBar.classList.toggle('bar-low', wallFrac < 0.4);
    const wallNum = this.hudWall.querySelector('.hud-wall-num');
    // ROUND 3 AGENT D (item 2): live wall HP % next to the raw numbers.
    this._setText(wallNum, 'wallnum', `${Math.ceil(world.wallHp)}/${world.wallMax} · ${Math.round(wallFrac * 100)}%`);
    const powFrac = world.powderMax > 0 ? world.powder / world.powderMax : 0;
    this.hudPowderBar.style.width = `${Math.round(powFrac * 100)}%`;
    const powNum = this.hudPowder.querySelector('.hud-powder-num');
    this._setText(powNum, 'pownum', `${Math.floor(world.powder)}`);
    this._setText(this.hudCoins, 'coins', `COINS ${world.coins}`);
    // ROUND 3 AGENT D (item 2): live fuse/trail % — the burn fraction of
    // the lit trail (burnDist / total trail length).
    let fuseState;
    if (world.trail) {
      if (world.trail.state === 'burning') {
        let total = 0;
        const pts = world.trail.points || [];
        for (let i = 1; i < pts.length; i += 1) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        const pct = total > 0 ? Math.round((world.trail.burnDist / total) * 100) : 0;
        fuseState = `FUSE: BURNING ${pct}%`;
      } else if (world.trail.state === 'armed') fuseState = 'FUSE: ARMED — LIGHT IT!';
      else fuseState = 'FUSE: DRAWING…';
    } else fuseState = 'FUSE: READY';
    this._setText(this.hudFuse, 'fuse', fuseState);
    this.hudFuse.classList.toggle('fuse-armed', !!(world.trail && world.trail.state === 'armed'));
    this.lightBtn.classList.toggle('light-ready', !!(world.trail && world.trail.state === 'armed'));
    this.lightBtn.disabled = !(world.trail && world.trail.state === 'armed');
    this.pauseBtn.textContent = paused ? 'RESUME (P)' : 'PAUSE (P)';
    // ROUND 6 AGENT C (P9): visible audio pulse on the SOUND button.
    // The ♪ badge shows + pulses while the fuse is burning and sound is
    // on. Pulse is a pure function of frozen world.time, so the staged
    // shot is byte-identical across runs. Supporting evidence only — the
    // real proof is Rizal hearing the fuse hiss + chain blasts on his phone.
    const audioLive = !this._muted && !!(world.trail && world.trail.state === 'burning');
    if (audioLive) {
      const p = Math.sin(world.time * 5);
      this.muteNote.style.display = '';
      this.muteNote.style.opacity = (0.7 + 0.3 * p).toFixed(3);
      this.muteNote.style.transform = `scale(${(1 + 0.18 * p).toFixed(3)})`;
    } else {
      this.muteNote.style.display = 'none';
    }
    // ROUND 4 AGENT C (item 14): the selected powder reads as a choice —
    // filled button + a ✓ on the label (the fill alone was easy to miss
    // against the bright world).
    this.powderBtns.forEach((b, i) => {
      const active = POWDER_ORDER[i] === world.powderType;
      b.classList.toggle('active', active);
      this._setText(this.powderLabels[i], `powlab${i}`, active ? `✓ ${POWDER_TYPES[POWDER_ORDER[i]].label}` : POWDER_TYPES[POWDER_ORDER[i]].label);
    });
    // ROUND 3 AGENT D (item 4): threat-queue panel — live counts, grouped
    // by type (queue order preserved for the NEXT group).
    this._updateThreatPanel(world);
    // ROUND 5 AGENT C (items #7 + #8): minimap + wave journey strip.
    this._updateMinimap(world);
    this._updateWaveStrip(world);
    // ROUND 3 AGENT D (item 1): big moment text on sim-state transitions.
    this.updateEventBanner(world);
    if (this.barkTimer > 0) {
      this.barkTimer -= 1 / 60;
      if (this.barkTimer <= 0) this.barkLine.textContent = '';
    }
  }

  // ROUND 5 AGENT C (item #7): minimap draw. Pure function of world
  // state: field + lanes + burning trail + fort + defenders + enemies +
  // Titan + kegs, all mapped from world coords (x -45..60, z -20..20)
  // to the 150x104 canvas. No rng, no clock — deterministic at the
  // freeze. Redrawn every rAF frame from the live world; cheap (one
  // small canvas, a handful of dots).
  _updateMinimap(world) {
    const cv = this.minimap;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    const px = (x) => 4 + ((x + 45) / 105) * (W - 8);
    const pz = (z) => 4 + ((z + 20) / 40) * (H - 8);
    ctx.fillStyle = '#2a4a22';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(245,230,200,0.25)';
    ctx.lineWidth = 1;
    for (const z of [-14.5, 0, 14.5]) {
      ctx.beginPath();
      ctx.moveTo(px(-45), pz(z));
      ctx.lineTo(px(60), pz(z));
      ctx.stroke();
    }
    if (world.trail && world.trail.state === 'burning') {
      ctx.strokeStyle = '#ff7a1a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px(-42.7), pz(world.trail.frontZ));
      ctx.lineTo(px(world.trail.frontX), pz(world.trail.frontZ));
      ctx.stroke();
    }
    ctx.fillStyle = '#ffc53d';
    ctx.fillRect(px(-44) - 2, 4, 4, H - 8);
    ctx.fillStyle = '#4ac8ff';
    for (const d of world.defenders || []) {
      if (typeof d.z !== 'number') continue;
      ctx.beginPath();
      ctx.arc(px(-42.7), pz(d.z), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const e of world.enemies || []) {
      if (e.dead || typeof e.x !== 'number' || typeof e.z !== 'number') continue;
      ctx.fillStyle = e.type === 'ironhide' ? '#ff4d3d' : '#ff8a5c';
      ctx.beginPath();
      ctx.arc(px(e.x), pz(e.z), e.type === 'ironhide' ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (world.boss && world.boss.alive && typeof world.boss.x === 'number') {
      ctx.fillStyle = '#ff7a1a';
      ctx.beginPath();
      ctx.arc(px(world.boss.x), pz(world.boss.z), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px(world.boss.x), pz(world.boss.z), 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#b8a080';
    for (const k of world.kegs || []) {
      if (!k.alive || typeof k.x !== 'number' || typeof k.z !== 'number') continue;
      ctx.beginPath();
      ctx.arc(px(k.x), pz(k.z), 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ROUND 5 AGENT C (item #8): wave journey strip — waves < current are
  // done (green), the current wave is gold, future waves stay dim.
  // Class toggles only; the segment numbers never change.
  _updateWaveStrip(world) {
    if (!this.waveSegs) return;
    for (let i = 0; i < 10; i += 1) {
      const seg = this.waveSegs[i];
      const w = i + 1;
      seg.classList.toggle('done', w < world.wave);
      seg.classList.toggle('current', w === world.wave);
    }
  }

  _groupCounts(types) {
    const counts = {};
    for (const t of types) counts[t] = (counts[t] || 0) + 1;
    return counts;
  }

  _threatList(counts, order) {
    // "5× Ironhide · 6× Torchbearer" — strongest first (ironhide, then
    // saboteur, torchbearer, cinderling), Titan last when present.
    const parts = [];
    for (const type of order) {
      if (!counts[type]) continue;
      const label = type === 'titan' ? 'Cinder Titan' : (ENEMY_TYPES[type] ? ENEMY_TYPES[type].label : type);
      const dot = THREAT_DOT[type] || '#f5e6c8';
      parts.push(`<span class="threat-dot" style="background:${dot}"></span>${counts[type]}× ${label}`);
    }
    return parts.join(' · ');
  }

  _updateThreatPanel(world) {
    // update() runs every rAF frame — only touch the DOM when the text
    // actually changed (innerHTML churn every frame would thrash layout).
    const aliveTypes = world.enemies.filter((e) => !e.dead).map((e) => e.type);
    if (world.boss && world.boss.alive) aliveTypes.push('titan');
    const fieldHtml = this._threatList(this._groupCounts(aliveTypes), ['ironhide', 'saboteur', 'torchbearer', 'cinderling', 'titan']);
    const queueTotal = (world.spawnQueue || []).length;
    const nextCounts = this._groupCounts((world.spawnQueue || []).slice(0, 5));
    const nextHtml = this._threatList(nextCounts, ['ironhide', 'saboteur', 'torchbearer', 'cinderling']);
    // ROUND 3 AGENT D (item 2): kegs' live readiness % — alive/total, or
    // the lit keg's fuse % while one is about to blow.
    const kegs = world.kegs || [];
    const aliveKegs = kegs.filter((k) => k.alive);
    const lit = kegs.find((k) => k.alive && k.state === 'lit');
    let kegText;
    if (lit) {
      const fusePct = Math.round(((0.25 - (lit.fuse || 0)) / 0.25) * 100);
      kegText = `KEG LIT — ${Math.max(0, Math.min(100, fusePct))}%`;
    } else if (kegs.length > 0) {
      kegText = `KEGS ${aliveKegs.length}/${kegs.length} · ${Math.round((aliveKegs.length / kegs.length) * 100)}% READY`;
    } else kegText = 'KEGS —';
    // ROUND 4 AGENT C (item 5): QUEUED + NEXT were two rows saying almost
    // the same thing (NEXT is just the first 5 of the queue). One QUEUE
    // row now: the total still queued + the next group to spawn. Same
    // info, one row shorter — the panel drops from 126px to ~90px tall
    // at the action freeze and stops covering the Titan's zone.
    const html = `<div class="threat-title">THREAT QUEUE — WAVE ${world.wave}/10</div>`
      + `<div class="threat-row"><span class="threat-label">ON FIELD</span><span class="threat-vals">${fieldHtml || '— clear'}</span></div>`
      + `<div class="threat-row"><span class="threat-label">QUEUE</span><span class="threat-vals">${queueTotal > 0 ? `${queueTotal} — next: ${nextHtml}` : '0 — all spawned'}</span></div>`
      + `<div class="threat-row"><span class="threat-label">KEGS</span><span class="threat-vals">${kegText}</span></div>`;
    if (html !== this._threatHtml) {
      this._threatHtml = html;
      this.threatPanel.innerHTML = html;
    }
  }

  // ROUND 3 AGENT D (item 1): big moment text, driven by sim-state
  // transitions observed on each call. Called from update() (live play)
  // AND from main.js runSteps() (staged captures — the bot steps the sim
  // synchronously inside one evaluate, so no rAF frame observes the
  // intermediate states; runSteps(0) at the freeze is what sets it).
  updateEventBanner(world) {
    if (!world) return;
    if (this._bannerWorld !== world) {
      // New world: neutral baseline, so the first observation after a
      // bot-driven freeze still fires the tier-up (see constructor note).
      this._bannerWorld = world;
      this._banner = null;
      this._lastChainMul = 1;
      this._lastTrailState = null;
      this._bossDownShown = false;
    }
    const trailState = world.trail ? world.trail.state : null;
    if (trailState === 'burning' && this._lastTrailState !== 'burning') {
      this._banner = { text: 'TRAIL IGNITED!', born: world.time };
    }
    this._lastTrailState = trailState;
    if (world.chainMul > this._lastChainMul && world.chainMul >= 2) {
      this._banner = { text: `CHAIN x${world.chainMul}!`, born: world.time };
    }
    this._lastChainMul = world.chainMul;
    if (world.boss && world.boss.defeated && !this._bossDownShown) {
      this._banner = { text: 'TITAN DOWN!', born: world.time };
      this._bossDownShown = true;
    }
    if (this._banner && world.time - this._banner.born < 3) {
      if (this.eventBanner.textContent !== this._banner.text) this.eventBanner.textContent = this._banner.text;
      this.eventBanner.style.display = '';
    } else {
      this.eventBanner.style.display = 'none';
    }
    // ROUND 6 AGENT C (P1): the giant event word rides the CHAIN x8!
    // banner — same 3s window, same freeze moment. It is a second 320px
    // carrier next to "CHAIN x8!", not a replacement for it.
    const showWord = !!(this._banner && this._banner.text === 'CHAIN x8!' && world.time - this._banner.born < 3);
    this.eventWord.style.display = showWord ? '' : 'none';
  }

  bark(kind, seed) {
    const lines = BARKS[kind];
    if (!lines) return;
    const line = lines[Math.abs(seed || 0) % lines.length];
    this.barkLine.textContent = `Wren: “${line}”`;
    this.barkTimer = 3;
  }

  toast(msg, ms) {
    const t = this.refs.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  showTitle(profile, difficulty) {
    // P1 (Rizal fix): the old title was a 65.4%-of-frame text wall — 6 chips
    // + 9 roster items + 5 how-to steps + 3 difficulties + PLAY + stats +
    // controls. Now a top-left cluster (CSS .screen-title, max 600px):
    // title + tagline, 3-step how, one goal line, the roster as ONE line,
    // difficulty + PLAY + one stats line. The world shows through the rest.
    const screen = this.refs.screen;
    screen.innerHTML = '';
    screen.className = 'screen screen-title';
    const wrap = el('div', 'title-wrap');
    const title = el('h1', 'game-title', 'CHAINFIRE');
    const tag = el('div', 'tagline', 'DRAW THE TRAIL. LIGHT THE FUSE. CHAIN THE BLAST.');
    wrap.append(title, tag);

    // ROUND 3 AGENT D (item 10): how-to as 3 cards, each with a mini
    // diagram (inline SVG, no network) + a short label.
    const HOW_CARDS = [
      { n: '1 · DRAW', svg: '<svg viewBox="0 0 44 28" width="44" height="28"><path d="M4 22 C 14 6, 26 26, 40 8" stroke="#ffd23f" stroke-width="3" fill="none" stroke-dasharray="1 4" stroke-linecap="round"/><circle cx="4" cy="22" r="2.5" fill="#ff7a1a"/><circle cx="40" cy="8" r="2.5" fill="#ff7a1a"/></svg>', text: 'Drag a trail through the raiders' },
      { n: '2 · LIGHT', svg: '<svg viewBox="0 0 44 28" width="44" height="28"><path d="M22 3 C 27 10, 31 12, 31 18 A 9 9 0 1 1 13 18 C 13 12, 17 10, 22 3 Z" fill="#ff7a1a"/><path d="M22 13 C 24 16, 26 17, 26 19.5 A 4 4 0 1 1 18 19.5 C 18 17, 20 16, 22 13 Z" fill="#ffd23f"/></svg>', text: 'Click LIGHT FUSE' },
      { n: '3 · CHAIN', svg: '<svg viewBox="0 0 44 28" width="44" height="28"><g stroke="#ffd23f" stroke-width="2.5" stroke-linecap="round"><line x1="22" y1="14" x2="22" y2="3"/><line x1="22" y1="14" x2="33" y2="7"/><line x1="22" y1="14" x2="33" y2="21"/><line x1="22" y1="14" x2="22" y2="25"/><line x1="22" y1="14" x2="11" y2="21"/><line x1="22" y1="14" x2="11" y2="7"/></g><circle cx="22" cy="14" r="4" fill="#ff7a1a"/></svg>', text: 'Fire blasts the trail + kegs' }
    ];
    const how = el('div', 'how-strip');
    for (const card of HOW_CARDS) {
      const c = el('div', 'how-card');
      const d = el('div', 'how-diagram');
      d.innerHTML = card.svg;
      c.append(d, el('div', 'how-card-title', card.n), el('div', 'how-card-text', card.text));
      how.append(c);
    }
    wrap.append(how);

    wrap.append(el('div', 'goal-line', 'SURVIVE 10 WAVES — SINK THE CINDER TITAN (900 HP) ON WAVE 10'));

    // ROUND 3 AGENT D (item 5): THREAT → ANSWER roster — each Horde type's
    // behaviour and the honest counter. The Garrison stays as one line.
    const threat = el('div', 'threat-table');
    threat.append(el('div', 'threat-table-title', 'THREAT → ANSWER'));
    for (const t of THREAT_ANSWERS) {
      const row = el('div', 'threat-table-row');
      const dot = el('span', 'roster-dot');
      dot.style.background = t.color;
      row.append(dot, el('span', 'threat-table-name', t.name));
      row.append(el('span', 'threat-table-behavior', t.behavior));
      row.append(el('span', 'threat-table-arrow', '→'));
      row.append(el('span', 'threat-table-answer', t.answer));
      threat.append(row);
    }
    wrap.append(threat);

    const rosterLine = el('div', 'roster-line');
    rosterLine.append(el('span', 'roster-group', 'GARRISON: '));
    for (let i = 5; i < ROSTER_STRIP.length; i += 1) {
      const r = ROSTER_STRIP[i];
      const dot = el('span', 'roster-dot');
      dot.style.background = r.color;
      rosterLine.append(dot, el('span', 'roster-name', r.name));
      if (i < ROSTER_STRIP.length - 1) rosterLine.append(document.createTextNode(' · '));
    }
    wrap.append(rosterLine);

    const diffRow = el('div', 'diff-row');
    for (const name of DIFF_ORDER) {
      const b = el('button', 'diff-btn' + (name === difficulty ? ' active' : ''), name);
      b.addEventListener('click', () => this.cb.onDifficulty(name));
      diffRow.append(b);
    }
    wrap.append(diffRow);

    const stats = el('div', 'title-stats');
    const last = profile.lastRuns && profile.lastRuns[0];
    stats.append(
      el('span', '', `BEST ${Math.floor(profile.best).toLocaleString('en-US')}`),
      el('span', '', `FEATS ${profile.feats.unlocked.length}/${profile.feats.total}`),
      el('span', '', last ? `LAST RUN: ${last.result === 'won' ? 'WIN' : 'DEFEAT'} ${Math.floor(last.score).toLocaleString('en-US')} (${last.grade})` : 'LAST RUN: —'),
      el('span', '', `LIFETIME: ${profile.lifetime.runsPlayed} runs · ${profile.lifetime.wins} wins`)
    );
    wrap.append(stats);

    const play = el('button', 'play-btn', 'PLAY');
    play.addEventListener('click', () => this.cb.onPlay());
    wrap.append(play);
    screen.append(wrap);
  }

  showDraft(world, profile) {
    const screen = this.refs.screen;
    screen.innerHTML = '';
    screen.className = 'screen screen-draft';
    const draft = world.draft;
    if (!draft) return;
    const wrap = el('div', 'draft-wrap');
    wrap.append(el('h2', 'draft-title', `WAVE ${world.clearedWave || world.wave} CLEARED — PICK 1 CARD`));
    const ctx = el('div', 'draft-context',
      `WALL ${Math.ceil(world.wallHp)}/${world.wallMax} · POWDER ${Math.floor(world.powder)} · COINS ${world.coins}`);
    wrap.append(ctx);
    // ROUND 3 AGENT D (item 9): COMING NEXT strip — the next wave's
    // composition as colored count chips (from WAVES, the same data the sim
    // spawns), so the player drafts against what is actually coming. This
    // replaces the old NEXT text in the context line above — one source,
    // no duplication.
    const nextWave = WAVES[world.wave - 1];
    if (nextWave) {
      const strip = el('div', 'coming-next');
      strip.append(el('span', 'coming-next-title', `COMING NEXT — WAVE ${world.wave}:`));
      const counts = [
        ['cinderling', nextWave.cinderlings],
        ['torchbearer', nextWave.torchbearers],
        ['ironhide', nextWave.ironhides],
        ['saboteur', nextWave.saboteurs]
      ];
      for (const [type, n] of counts) {
        if (!n) continue;
        const chip = el('span', 'coming-next-chip');
        const dot = el('span', 'roster-dot');
        dot.style.background = THREAT_DOT[type];
        chip.append(dot, document.createTextNode(`${n}× ${ENEMY_TYPES[type].label}`));
        strip.append(chip);
      }
      if (nextWave.isBoss) {
        const chip = el('span', 'coming-next-chip coming-next-boss');
        const dot = el('span', 'roster-dot');
        dot.style.background = THREAT_DOT.titan;
        chip.append(dot, document.createTextNode('THE CINDER TITAN · 900 HP'));
        strip.append(chip);
      }
      wrap.append(strip);
    }
    const cards = el('div', 'card-row');
    for (const id of draft.offered) {
      const card = CARD_DEFS.find((c) => c.id === id);
      if (!card) continue;
      const isNew = !(profile.seenCards || []).includes(id);
      const affordable = world.coins >= card.cost;
      const cardEl = el('button', `card tier-${card.tier.toLowerCase()}${affordable ? '' : ' unaffordable'}`);
      cardEl.disabled = !affordable;
      cardEl.append(el('div', 'card-tier', card.tier));
      if (isNew) cardEl.append(el('div', 'card-new', 'NEW!'));
      cardEl.append(el('div', 'card-name', card.name));
      cardEl.append(el('div', 'card-effect', card.effectText));
      // ROUND 3 AGENT D (item 9): synergy is now labelled, so it reads as
      // a synergy line and not a second effect line.
      cardEl.append(el('div', 'card-synergy', card.synergy ? `↗ SYNERGY — ${card.synergy}` : ''));
      cardEl.append(el('div', 'card-cost', `${card.cost} COINS`));
      cardEl.addEventListener('click', () => this.cb.onPickCard(id));
      cards.append(cardEl);
    }
    wrap.append(cards);
    const actions = el('div', 'draft-actions');
    const reroll = el('button', 'draft-btn', `REROLL — ${draft.rerollCost} COINS (R)`);
    reroll.disabled = world.coins < draft.rerollCost;
    reroll.addEventListener('click', () => this.cb.onReroll());
    const skip = el('button', 'draft-btn', 'SKIP');
    skip.addEventListener('click', () => this.cb.onSkipDraft());
    actions.append(reroll, skip);
    wrap.append(actions);
    const build = el('div', 'build-so-far', `BUILD SO FAR: ${world.pickedCards.length > 0 ? world.pickedCards.map((id) => (CARD_DEFS.find((c) => c.id === id) || {}).name).join(' · ') : '—'} · ${9 - world.pickedCards.length} picks left`);
    wrap.append(build);
    // ROUND 6 AGENT C (P10): 10-wave journey strip — the run's road at a
    // glance, reusing the action shot's WAVES strip language (numbered
    // segments: done green, current gold, wave 10 marked boss). A pure
    // function of world.wave, so the staged draft shot is deterministic.
    const journey = el('div', 'draft-journey');
    journey.append(el('span', 'wave-strip-label', 'JOURNEY'));
    for (let i = 1; i <= 10; i += 1) {
      const cls = ['wave-seg'];
      if (i < world.wave) cls.push('done');
      if (i === world.wave) cls.push('current');
      if (i === 10) cls.push('wave-seg-boss');
      journey.append(el('div', cls.join(' '), String(i)));
    }
    wrap.append(journey);
    screen.append(wrap);
  }

  showResults(world, profile, won) {
    // P1 (Rizal fix): the old results panel was 70.2% of the frame — title,
    // grade, 8 stats, a 10-bar chart, feats, last 3, build, goal, FOR S
    // checklist, lifetime, actions. Now a middle-left cluster (CSS
    // .screen-results, max 480px): title + grade, 8 stats (2-col), feats,
    // last 3, ONE combined lifetime + next-goal line, actions. The chart
    // duplicated the BLASTS stat; the build duplicates the draft shot; the
    // FOR S checklist duplicated the grade. The fort + sky + sun show on
    // the right ~60% of the frame. The "TITAN IS DOWN!" popup now sits
    // behind this left panel instead of crossing the MENU button.
    const screen = this.refs.screen;
    screen.innerHTML = '';
    screen.className = 'screen screen-results';
    const wrap = el('div', 'results-wrap');
    wrap.append(el('h2', 'results-title', won ? 'THE CINDER TITAN IS ASH!' : 'THE FORT HAS FALLEN'));
    const gradeRow = el('div', 'grade-row');
    const grade = el('div', 'grade-circle', world.grade || 'C');
    const scoreBox = el('div', 'score-box');
    // ROUND 3 AGENT D (item 8): NEW BEST is honest — the run beats the
    // best of the PREVIOUS runs. profile.lastRuns[0] IS this run (recordRun
    // prepends it, and stageResults builds the same order), so the previous
    // best is the max of lastRuns[1..]. The old check (score > profile.best)
    // could never fire: profile.best already includes this run.
    const prevBest = Math.max(0, ...(profile.lastRuns || []).slice(1).map((r) => r.score || 0));
    const isBest = world.score > prevBest;
    scoreBox.append(el('div', 'score-num', Math.floor(world.score).toLocaleString('en-US')));
    const scoreLabel = el('div', isBest ? 'score-label new-best-badge' : 'score-label', isBest ? '★ NEW BEST!' : `BEST ${Math.floor(profile.best).toLocaleString('en-US')}`);
    scoreBox.append(scoreLabel);
    gradeRow.append(grade, scoreBox);
    wrap.append(gradeRow);

    const stats = el('div', 'stat-grid');
    const perWave = world.stats.perWave || [];
    const blasts = perWave.reduce((s, w) => s + (w.blasts || 0), 0);
    const statData = [
      ['SCORE', Math.floor(world.score).toLocaleString('en-US')],
      ['WAVE', `${world.wave}/10`],
      ['KILLS', `${world.kills}`],
      ['LONGEST CHAIN', `x${world.chainMul >= 8 ? 8 : world.chainMul} · best ${world.longestChain}`],
      ['KEGS BLOWN', `${world.stats.kegsBlown}`],
      ['BLASTS', `${blasts}`],
      ['BACKFIRES', `${world.stats.backfires}`],
      ['TIME', fmtTime(world.time)]
    ];
    for (const [label, value] of statData) {
      const cell = el('div', 'stat-cell');
      cell.append(el('div', 'stat-value', value), el('div', 'stat-label', label));
      stats.append(cell);
    }
    wrap.append(stats);

    // ROUND 3 AGENT D (item 8): per-wave BLASTS chart — the real
    // world.stats.perWave of this run (same numbers as the BLASTS stat
    // above, broken down per wave so the run's shape reads at a glance).
    const waveRows = world.stats.perWave || [];
    if (waveRows.length > 0) {
      const chart = el('div', 'chart');
      chart.append(el('div', 'chart-title', 'BLASTS PER WAVE'));
      const bars = el('div', 'chart-bars');
      const maxBlasts = Math.max(1, ...waveRows.map((w) => w.blasts || 0));
      for (const w of waveRows) {
        const bar = el('div', 'chart-bar');
        const fillWrap = el('div', 'chart-fill-wrap');
        const fill = el('div', 'chart-fill');
        fill.style.height = `${Math.max(2, Math.round(((w.blasts || 0) / maxBlasts) * 100))}%`;
        fillWrap.append(fill);
        bar.append(el('div', 'chart-num', `${w.blasts || 0}`), fillWrap, el('div', 'chart-wave', `W${w.wave}`));
        bars.append(bar);
      }
      chart.append(bars);
      wrap.append(chart);
    }

    const feats = el('div', 'feats-box');
    feats.append(el('div', 'feats-title', `FEATS ${world.featsUnlocked.length}/${FEATS.length}`));
    for (const feat of FEATS) {
      const got = world.featsUnlocked.includes(feat.id);
      feats.append(el('div', `feat${got ? ' got' : ''}`, `${got ? '✓' : '·'} ${feat.name} — ${feat.desc}`));
    }
    wrap.append(feats);

    const last3 = el('div', 'last3-box');
    last3.append(el('div', 'last3-title', 'LAST 3 RUNS'));
    for (const run of (profile.lastRuns || []).slice(0, 3)) {
      last3.append(el('div', 'last3-row', `${run.result === 'won' ? 'WIN' : 'DEFEAT'} · ${Math.floor(run.score).toLocaleString('en-US')} · grade ${run.grade} · wave ${run.wave} · ${fmtTime(run.time)}`));
    }
    wrap.append(last3);

    const lifetime = el('div', 'lifetime-box',
      `LIFETIME: ${profile.lifetime.runsPlayed} runs · ${profile.lifetime.wins} wins · ${profile.lifetime.raidersBlown} raiders blown · biggest chain x${profile.lifetime.biggestChain >= 5 ? 8 : profile.lifetime.biggestChain >= 3 ? 4 : profile.lifetime.biggestChain >= 2 ? 2 : 1} — NEXT GOAL: ${nextGoal(world, profile)}`);
    wrap.append(lifetime);

    const actions = el('div', 'results-actions');
    const again = el('button', 'play-btn', 'NEW RUN (R)');
    again.addEventListener('click', () => this.cb.onNewRun());
    const menu = el('button', 'draft-btn', 'MENU');
    menu.addEventListener('click', () => this.cb.onMenu());
    actions.append(again, menu);
    wrap.append(actions);
    screen.append(wrap);
  }

  showHelp() {
    const screen = this.refs.screen;
    screen.innerHTML = '';
    screen.className = 'screen screen-help';
    const wrap = el('div', 'help-wrap');
    wrap.append(el('h2', 'help-title', 'HOW TO PLAY'));
    const rows = [
      ['DRAG (mouse / 1 finger)', 'Draw a powder trail on the field. Longer trail = bigger chain multiplier (x2 / x4 / x8).'],
      ['CLICK LIGHT FUSE', 'Fire runs the trail and chain-explodes every raider and keg it touches.'],
      ['1 / 2 / 3', 'Switch powder: BLACK (cheap), NAPHTHA (burning ground fire), STAR (big blasts).'],
      ['WHEEL / PINCH', 'Zoom the camera (0.7x – 1.5x).'],
      ['Q / E or 2-FINGER DRAG', 'Orbit the camera.'],
      ['P', 'Pause.   M — mute.   R — reroll draft / new run.   H — close this help.'],
      ['WALL', 'Raiders that reach the wall damage it. A trail drawn over the wall BACKFIRES (-15).'],
      ['KEGS', 'Powder kegs explode when fire touches them — chain them for the jackpot.'],
      ['BOSS', 'Wave 10: THE CINDER TITAN, 900 HP. Break it before it breaks the wall.']
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'help-row');
      row.append(el('div', 'help-key', k), el('div', 'help-val', v));
      wrap.append(row);
    }
    const close = el('button', 'play-btn', 'CLOSE (H)');
    close.addEventListener('click', () => this.cb.onHelpClose());
    wrap.append(close);
    screen.append(wrap);
  }

  hideScreens() {
    this.refs.screen.innerHTML = '';
    this.refs.screen.className = 'screen';
  }

  setChrome(visible) {
    this.refs.hud.style.display = visible ? '' : 'none';
    this.refs.bottom.style.display = visible ? '' : 'none';
  }

  setMuted(muted) {
    // ROUND 6 AGENT C (P9): label lives in its own span so this never
    // wipes the ♪ badge; _muted drives the badge in update().
    this._muted = !!muted;
    if (this.muteLabel) this.muteLabel.textContent = muted ? 'SOUND OFF (M)' : 'SOUND ON (M)';
  }
}
