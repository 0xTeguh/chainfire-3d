// CHAINFIRE 3D — DOM UI: HUD, title, draft, results, help screens.
// All text is English. Screens are DOM overlays on top of the live 3D scene
// (the diorama behind the title is the real game world). Written fresh.

import { CARD_DEFS, FEATS, POWDER_TYPES, POWDER_ORDER, DIFF_ORDER, gradeChecklist } from './data.js';

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
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
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
    left.append(this.hudWave, this.hudScore, this.hudBest);
    const mid = el('div', 'hud-mid');
    this.hudMult = el('div', 'hud-mult', 'x1');
    this.hudChain = el('div', 'hud-chip', 'CHAIN 0');
    this.hudLeft = el('div', 'hud-chip', '0 LEFT');
    mid.append(this.hudMult, this.hudChain, this.hudLeft);
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
    this.barkLine = el('div', 'bark', '');
    hud.append(this.barkLine);
  }

  _buildBottom() {
    const bar = this.refs.bottom;
    bar.innerHTML = '';
    const powderBox = el('div', 'powder-box');
    this.powderBtns = [];
    POWDER_ORDER.forEach((type, i) => {
      const def = POWDER_TYPES[type];
      const b = el('button', 'powder-btn', `${def.label} · ${def.costPer12px} POWDER`);
      b.style.setProperty('--powder-color', `#${def.glow.toString(16).padStart(6, '0')}`);
      b.addEventListener('click', () => this.cb.onPowderType(i));
      powderBox.append(b);
      this.powderBtns.push(b);
    });
    this.lightBtn = el('button', 'light-btn', 'LIGHT FUSE');
    this.lightBtn.addEventListener('click', () => this.cb.onLightFuse());
    const ctl = el('div', 'ctl-box');
    this.pauseBtn = el('button', 'ctl-btn', 'PAUSE (P)');
    this.pauseBtn.addEventListener('click', () => this.cb.onPause());
    this.muteBtn = el('button', 'ctl-btn', 'SOUND ON (M)');
    this.muteBtn.addEventListener('click', () => this.cb.onMute());
    this.helpBtn = el('button', 'ctl-btn', 'HELP (H)');
    this.helpBtn.addEventListener('click', () => this.cb.onHelp());
    ctl.append(this.pauseBtn, this.muteBtn, this.helpBtn);
    bar.append(powderBox, this.lightBtn, ctl);
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
    this._setText(this.hudMult, 'mult', `x${world.chainMul}`);
    this.hudMult.classList.toggle('mult-hot', world.chainMul >= 4);
    this.hudMult.classList.toggle('mult-max', world.chainMul >= 8);
    this._setText(this.hudChain, 'chain', `CHAIN ${world.chain}`);
    const left = world.spawnQueue.length + world.enemies.filter((e) => !e.dead).length + (world.boss && world.boss.alive ? 1 : 0);
    this._setText(this.hudLeft, 'left', `${left} LEFT`);
    const wallFrac = world.wallMax > 0 ? world.wallHp / world.wallMax : 0;
    this.hudWallBar.style.width = `${Math.round(wallFrac * 100)}%`;
    this.hudWallBar.classList.toggle('bar-low', wallFrac < 0.4);
    const wallNum = this.hudWall.querySelector('.hud-wall-num');
    this._setText(wallNum, 'wallnum', `${Math.ceil(world.wallHp)}/${world.wallMax}`);
    const powFrac = world.powderMax > 0 ? world.powder / world.powderMax : 0;
    this.hudPowderBar.style.width = `${Math.round(powFrac * 100)}%`;
    const powNum = this.hudPowder.querySelector('.hud-powder-num');
    this._setText(powNum, 'pownum', `${Math.floor(world.powder)}`);
    this._setText(this.hudCoins, 'coins', `COINS ${world.coins}`);
    const fuseState = world.trail
      ? (world.trail.state === 'burning' ? 'FUSE: BURNING' : (world.trail.state === 'armed' ? 'FUSE: ARMED — LIGHT IT!' : 'FUSE: DRAWING…'))
      : 'FUSE: READY';
    this._setText(this.hudFuse, 'fuse', fuseState);
    this.hudFuse.classList.toggle('fuse-armed', !!(world.trail && world.trail.state === 'armed'));
    this.lightBtn.classList.toggle('light-ready', !!(world.trail && world.trail.state === 'armed'));
    this.lightBtn.disabled = !(world.trail && world.trail.state === 'armed');
    this.pauseBtn.textContent = paused ? 'RESUME (P)' : 'PAUSE (P)';
    this.powderBtns.forEach((b, i) => b.classList.toggle('active', POWDER_ORDER[i] === world.powderType));
    if (this.barkTimer > 0) {
      this.barkTimer -= 1 / 60;
      if (this.barkTimer <= 0) this.barkLine.textContent = '';
    }
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
    const screen = this.refs.screen;
    screen.innerHTML = '';
    screen.className = 'screen screen-title';
    const wrap = el('div', 'title-wrap');
    const title = el('h1', 'game-title', 'CHAINFIRE');
    const tag = el('div', 'tagline', 'DRAW THE TRAIL. LIGHT THE FUSE. CHAIN THE BLAST.');
    wrap.append(title, tag);

    const chips = el('div', 'chip-row');
    const chipData = [
      ['GOAL', 'Stop the Ashen Horde before it breaches the fort.'],
      ['DRAW', 'Drag to lay a powder trail. Longer trail = bigger multiplier.'],
      ['LIGHT', 'Click LIGHT FUSE — fire runs the trail and chain-explodes raiders.'],
      ['CHAIN', 'x2 · x4 · x8 — chain kills through kegs for the jackpot.'],
      ['WIN', 'Survive all 10 waves and sink the Cinder Titan.'],
      ['LOSE', 'The wall falls, or the Titan reaches the gate.']
    ];
    for (const [label, text] of chipData) {
      const c = el('div', 'chip');
      c.append(el('div', 'chip-label', label), el('div', 'chip-text', text));
      chips.append(c);
    }
    wrap.append(chips);

    const roster = el('div', 'roster-strip');
    roster.append(el('div', 'roster-title', 'MEET THE HORDE — AND THE GARRISON'));
    const row = el('div', 'roster-row');
    for (const r of ROSTER_STRIP) {
      const item = el('div', 'roster-item');
      const dot = el('span', 'roster-dot');
      dot.style.background = r.color;
      item.append(dot, el('span', 'roster-name', r.name), el('span', 'roster-role', r.role));
      row.append(item);
    }
    roster.append(row);
    wrap.append(roster);

    const how = el('div', 'how-strip');
    how.append(
      el('div', 'how-step', '1 · DRAW — drag a trail through the raiders'),
      el('div', 'how-arrow', '→'),
      el('div', 'how-step', '2 · LIGHT — click LIGHT FUSE'),
      el('div', 'how-arrow', '→'),
      el('div', 'how-step', '3 · CHAIN — fire blasts the trail + kegs'),
      el('div', 'how-arrow', '→'),
      el('div', 'how-step', '4 · DRAFT — pick 1 of 3 cards'),
      el('div', 'how-arrow', '→'),
      el('div', 'how-step', '5 · BOSS — wave 10: THE CINDER TITAN')
    );
    wrap.append(how);

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

    const controls = el('div', 'controls-line',
      'DRAG draw trail · CLICK LIGHT FUSE · 1/2/3 powder · WHEEL zoom · Q/E orbit · P pause · M mute · R reroll · H help');
    wrap.append(controls);
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
      `NEXT: WAVE ${world.wave} — ${(world.wave === 10 ? 'THE CINDER TITAN' : (world.nextInfo ? world.nextInfo.label : '—'))} · WALL ${Math.ceil(world.wallHp)}/${world.wallMax} · POWDER ${Math.floor(world.powder)} · COINS ${world.coins}`);
    wrap.append(ctx);
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
      cardEl.append(el('div', 'card-synergy', card.synergy || ''));
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
    screen.append(wrap);
  }

  showResults(world, profile, won) {
    const screen = this.refs.screen;
    screen.innerHTML = '';
    screen.className = 'screen screen-results';
    const wrap = el('div', 'results-wrap');
    wrap.append(el('h2', 'results-title', won ? 'THE CINDER TITAN IS ASH!' : 'THE FORT HAS FALLEN'));
    const gradeRow = el('div', 'grade-row');
    const grade = el('div', 'grade-circle', world.grade || 'C');
    const scoreBox = el('div', 'score-box');
    const isBest = world.score >= profile.best;
    scoreBox.append(el('div', 'score-num', Math.floor(world.score).toLocaleString('en-US')));
    scoreBox.append(el('div', 'score-label', isBest ? 'NEW BEST!' : `BEST ${Math.floor(profile.best).toLocaleString('en-US')}`));
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

    const chart = el('div', 'chart');
    chart.append(el('div', 'chart-title', 'BLASTS PER WAVE'));
    const chartBars = el('div', 'chart-bars');
    const maxBlasts = Math.max(1, ...perWave.map((w) => w.blasts || 0));
    for (const w of perWave) {
      const bar = el('div', 'chart-bar');
      const fill = el('div', 'chart-fill');
      fill.style.height = `${Math.round(((w.blasts || 0) / maxBlasts) * 100)}%`;
      bar.append(fill, el('div', 'chart-num', `${w.blasts || 0}`), el('div', 'chart-wave', `W${w.wave}`));
      chartBars.append(bar);
    }
    chart.append(chartBars);
    wrap.append(chart);

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

    const build = el('div', 'build-box', `BUILD: ${world.pickedCards.length > 0 ? world.pickedCards.map((id) => (CARD_DEFS.find((c) => c.id === id) || {}).name).join(' · ') : 'No cards picked'}`);
    wrap.append(build);

    const goal = el('div', 'goal-box', `NEXT GOAL: ${nextGoal(world, profile)}`);
    wrap.append(goal);

    const forS = el('div', 'fors-box');
    forS.append(el('div', 'fors-title', 'FOR S:'));
    for (const item of gradeChecklist(world)) {
      forS.append(el('div', `fors-item${item.met ? ' met' : ''}`, `${item.met ? '✓' : '✗'} ${item.label}`));
    }
    wrap.append(forS);

    const lifetime = el('div', 'lifetime-box',
      `LIFETIME: ${profile.lifetime.runsPlayed} runs · ${profile.lifetime.wins} wins · ${profile.lifetime.raidersBlown} raiders blown · biggest chain x${profile.lifetime.biggestChain >= 5 ? 8 : profile.lifetime.biggestChain >= 3 ? 4 : profile.lifetime.biggestChain >= 2 ? 2 : 1}`);
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
    this.muteBtn.textContent = muted ? 'SOUND OFF (M)' : 'SOUND ON (M)';
  }
}
