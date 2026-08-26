// Bootstrap: loading, menu, settings, the frame loop.

import { createContext } from './core/gl.js';
import { Renderer, QUALITY } from './render/renderer.js';
import { Input } from './core/input.js';
import { TouchControls } from './core/touch.js';
import { Audio } from './core/audio.js';
import { HUD } from './game/hud.js';
import { Game, DIFFICULTY } from './game/game.js';
import { MAPS } from './game/world.js';
import { HumanLibrary } from './game/humans.js';
import { setBevel } from './render/geometry.js';
import { WEAPONS } from './game/weapons.js';
import { clamp } from './core/math.js';

const glCanvas = document.getElementById('gl');
const hudCanvas = document.getElementById('hud');
const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------- device profile */

// iPadOS reports itself as a Mac, so the UA alone is not enough.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
const COARSE = matchMedia('(pointer: coarse)').matches;
const FINE = matchMedia('(any-pointer: fine)').matches;
// `?touch=1` forces the mobile build on, which is handy for testing on a desktop.
const FORCE_TOUCH = new URLSearchParams(location.search).has('touch');

// A touchscreen laptop still has a mouse, so a fine pointer wins unless the UA
// says otherwise. Everything else with a coarse-only pointer gets touch controls.
const IS_MOBILE = FORCE_TOUCH || IS_IOS || /Android/i.test(navigator.userAgent)
  || (COARSE && !FINE);
const IS_TOUCH = IS_MOBILE;

const defaultQuality = IS_MOBILE ? 'low' : 'high';
const defaultScale = IS_MOBILE ? 0.65 : 1;

const settings = {
  scale: defaultScale, fov: IS_MOBILE ? 85 : 80, grain: 0.38, vol: 0.55,
  // Render resolution is the single biggest cost lever: a 1440x860 window at
  // devicePixelRatio 2 is a 5-megapixel deferred frame. 1.5 with FXAA on top
  // is visually near-identical for roughly half the pixels.
  dprCap: IS_MOBILE ? 2 : 1.5,
  fpsCap: 60,
  primary: 'kilo', quality: defaultQuality,
  sens: 1.0,
  adsSens: 0.85,
  lookAccel: 2.1,
  invertY: false,
  aimAssist: IS_TOUCH ? 0.85 : 0,
  difficulty: 'regular',
  map: 'scrapyard',
  bloom: 0.55,
  chroma: 0.13,
  vignette: 0.58,
  motionBlur: 1,
  clouds: 0.55,
  ssr: 0.9,
  wetness: 1.0,
  showFps: true,
};
const DEFAULTS = JSON.parse(JSON.stringify(settings));
try { Object.assign(settings, JSON.parse(localStorage.getItem('ob_settings') || '{}')); } catch { /* ignore */ }
const saveSettings = () => { try { localStorage.setItem('ob_settings', JSON.stringify(settings)); } catch { /* ignore */ } };

let gl, renderer, input, audio, hud, game, touch;
let humans = null;
let running = false, paused = false, started = false;
const safe = { l: 0, r: 0, t: 0, b: 0 };

function readSafeInsets() {
  const el = $('safeprobe');
  if (!el) return;
  const cs = getComputedStyle(el);
  safe.t = parseFloat(cs.paddingTop) || 0;
  safe.r = parseFloat(cs.paddingRight) || 0;
  safe.b = parseFloat(cs.paddingBottom) || 0;
  safe.l = parseFloat(cs.paddingLeft) || 0;
}

function checkOrientation() {
  if (!IS_MOBILE) return true;
  const vv = window.visualViewport;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  // A tablet has room to play either way up; a phone in portrait does not, so
  // nudge it sideways rather than shipping an unplayable layout.
  const isPhone = Math.min(w, h) < 500;
  const block = isPhone && h > w;
  const el = $('rotate');
  if (el) el.classList.toggle('hidden', !block);
  return !block;
}

/* -------------------------------------------------------------- lifecycle */

function fail(msg) {
  $('loadmsg').textContent = msg;
  $('loadmsg').style.color = '#ff5a45';
  $('loadbar').style.background = '#ff5a45';
}

async function boot() {
  try {
    gl = createContext(glCanvas);
  } catch (e) {
    fail('WEBGL2 UNAVAILABLE — TRY A DESKTOP BROWSER');
    return;
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  $('gpuinfo').textContent = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).toUpperCase().slice(0, 88)
    : 'WEBGL2';

  input = new Input(glCanvas);
  input.touchMode = IS_TOUCH;
  audio = new Audio();
  hud = new HUD(hudCanvas);
  renderer = new Renderer(glCanvas, gl, settings.quality);
  if (IS_TOUCH) {
    touch = new TouchControls(input, hudCanvas);
    touch.onPause = () => togglePause(true);
    document.body.classList.add('touch');
  }
  if (IS_MOBILE) document.body.classList.add('mobile');
  if (IS_TOUCH) {
    const dh = $('deployhint');
    if (dh) dh.textContent = 'Left thumb moves · right thumb aims · drag from FIRE to shoot while aiming';
  }
  initUI();

  const setProgress = (p, msg) => {
    $('loadbar').style.width = (p * 100).toFixed(0) + '%';
    if (msg) $('loadmsg').textContent = msg;
  };

  setProgress(0.05, 'COMPILING SHADERS…');
  await frame();

  setProgress(0.10, 'BAKING MATERIALS…');
  await renderer.loadMaterials(
    (p) => setProgress(0.10 + p * 0.62, 'BAKING MATERIALS… ' + (p * 100 | 0) + '%'),
    IS_MOBILE ? 384 : 512,
  );

  setProgress(0.74, 'LOADING CIVILIANS…');
  humans = new HumanLibrary();
  // Scenery, not gameplay: if the pack is missing the game still runs.
  await humans.load((p) => setProgress(0.74 + p * 0.12, `LOADING CIVILIANS… ${(p * 100) | 0}%`))
    .catch((e) => { console.warn('[humans] pack unavailable:', e.message); });

  // Chamfered edges cost ~74% more triangles; worth it on desktop, not on a
  // phone that cannot resolve a 2 cm highlight anyway.
  setBevel(IS_MOBILE ? 0 : 0.018);

  setProgress(0.87, 'BUILDING BATTLEGROUND…');
  await frame();
  resize();

  game = new Game(gl, renderer, audio, input, hud, settings.difficulty, settings.map, humans);
  game.touch = touch;
  setProgress(0.94, 'DEPLOYING SQUADS…');
  await frame();
  hud.buildMinimap(game.world);

  applySettings();
  buildLobby();
  setProgress(1, 'READY');
  await new Promise((r) => setTimeout(r, 260));
  game.cine.active = true;
  $('loading').classList.add('hidden');
  $('menu').classList.remove('hidden');
  running = true;
  requestAnimationFrame(loop);
}

// Yield to the browser. Uses a timer as well as rAF so loading still advances
// when the tab is not being painted (background tab, offscreen preview).
const frame = () => new Promise((r) => {
  let done = false;
  const fin = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 40);
});

function resize() {
  readSafeInsets();
  const dpr = Math.min(window.devicePixelRatio || 1, settings.dprCap);
  const vv = window.visualViewport;
  const w = Math.round(vv ? vv.width : window.innerWidth);
  const h = Math.round(vv ? vv.height : window.innerHeight);
  const rw = Math.max(2, Math.round(w * dpr * settings.scale));
  const rh = Math.max(2, Math.round(h * dpr * settings.scale));
  glCanvas.width = rw; glCanvas.height = rh;
  glCanvas.style.width = w + 'px'; glCanvas.style.height = h + 'px';
  renderer.resize(rw, rh);
  hud.resize(w, h, dpr, safe);
  if (touch) touch.layout(w, h, safe);
  checkOrientation();
  needsRedraw = true;
}
addEventListener('resize', () => { if (renderer) resize(); });
// iOS hands back stale viewport dimensions for a beat after a rotation, so
// re-measure a few times instead of trusting the first number.
addEventListener('orientationchange', () => {
  for (const d of [60, 220, 500, 900]) setTimeout(() => { if (renderer) resize(); }, d);
});
if (window.visualViewport) visualViewport.addEventListener('resize', () => { if (renderer) resize(); });

/* --------------------------------------------------------------- settings */

/* ---------------------------------------------------------- settings page */

/**
 * One schema drives the whole options screen: the DOM, the live application,
 * persistence and reset. Adding a setting means adding a row here, not wiring
 * up another handler.
 *
 *   toUI/fromUI  translate between the stored value and the slider's integer
 *   fmt          the readout text
 *   apply        pushes the value into the live systems
 *   only         'touch' | 'desktop' to hide irrelevant rows
 */
function schema() {
  return [
    ['GRAPHICS', [
      { k: 'quality', label: 'Quality preset', type: 'select',
        options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
        hint: 'Shadow resolution, ambient occlusion, bloom detail and squad size.',
        apply: (v) => renderer.setQuality(v) },
      { k: 'dprCap', label: 'Render resolution', type: 'range', min: 75, max: 200, step: 25,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => v.toFixed(2) + '\u00d7',
        hint: 'The biggest performance lever. Lower this first if the fans spin up.',
        apply: () => resize() },
      { k: 'scale', label: 'Resolution scale', type: 'range', min: 40, max: 100, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => Math.round(v * 100) + '%',
        apply: () => resize() },
      { k: 'fpsCap', label: 'Frame rate limit', type: 'select', num: true,
        options: [[30, '30 FPS'], [60, '60 FPS'], [120, '120 FPS'], [0, 'Unlimited']],
        hint: 'Capping saves a lot of power on a high-refresh display.' },
      { k: 'fov', label: 'Field of view', type: 'range', min: 65, max: 115, step: 1,
        fmt: (v) => String(v | 0), apply: (v) => { if (game) game.fovBase = v; } },
      { k: 'bloom', label: 'Bloom', type: 'range', min: 0, max: 150, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => Math.round(v * 100) + '%',
        apply: (v) => { renderer.bloomAmt = v; } },
      { k: 'grain', label: 'Film grain', type: 'range', min: 0, max: 100, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => Math.round(v * 100) + '%',
        apply: (v) => { renderer.grain = v * 0.10; } },
      { k: 'chroma', label: 'Chromatic aberration', type: 'range', min: 0, max: 60, step: 2,
        toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v < 0.005 ? 'OFF' : Math.round(v * 100) + '%'),
        apply: (v) => { renderer.chroma = v; } },
      { k: 'vignette', label: 'Vignette', type: 'range', min: 0, max: 120, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => Math.round(v * 100) + '%',
        apply: (v) => { renderer.vignette = v; } },
      { k: 'motionBlur', label: 'Motion blur', type: 'range', min: 0, max: 150, step: 10,
        toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v < 0.05 ? 'OFF' : Math.round(v * 100) + '%'),
        apply: (v) => { if (game) game.motionBlur = v; } },
      { k: 'ssr', label: 'Reflections', type: 'range', min: 0, max: 120, step: 10,
        toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v < 0.02 ? 'OFF' : Math.round(v * 100) + '%'),
        hint: 'Screen-space reflections. Needs Medium quality or higher.',
        apply: (v) => { renderer.ssrIntensity = v; } },
      { k: 'wetness', label: 'Surface wetness', type: 'range', min: 0, max: 150, step: 10,
        toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v < 0.02 ? 'DRY' : Math.round(v * 100) + '%'),
        hint: 'Scales each map\u2019s own weather — Blacksite is wet, Dustbowl is not.',
        apply: (v) => { renderer.wetnessScale = v; renderer.wetness = renderer.baseWetness * v; } },
      { k: 'clouds', label: 'Cloud shadows', type: 'range', min: 0, max: 100, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v < 0.02 ? 'OFF' : Math.round(v * 100) + '%'),
        apply: (v) => { renderer.cloudAmount = v; } },
      { k: 'showFps', label: 'Show FPS', type: 'toggle',
        apply: (v) => { $('fps').style.display = v ? '' : 'none'; } },
    ]],

    ['CONTROLS', [
      { k: 'sens', label: 'Look sensitivity', type: 'range', min: 20, max: 450, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => v.toFixed(2) + '\u00d7',
        apply: (v) => { input.sensitivity = Input.BASE_SENSITIVITY * v; } },
      { k: 'adsSens', label: 'ADS sensitivity', type: 'range', min: 30, max: 150, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => v.toFixed(2) + '\u00d7',
        hint: 'Multiplier applied on top while aiming down sights.',
        apply: (v) => { if (game) game.adsSensMul = v; } },
      { k: 'lookAccel', label: 'Look acceleration', type: 'range', min: 100, max: 350, step: 10,
        only: 'touch', toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v <= 1.02 ? 'OFF' : v.toFixed(1) + '\u00d7'),
        hint: 'Fast swipes turn faster, so a 180 is one thumb motion.',
        apply: (v) => { if (touch) touch.lookAccel = v; } },
      { k: 'aimAssist', label: 'Aim assist', type: 'range', min: 0, max: 100, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100,
        fmt: (v) => (v <= 0 ? 'OFF' : Math.round(v * 100) + '%'),
        hint: 'Slows the reticle over a target and nudges toward it while firing.',
        apply: (v) => { if (game) game.aimAssist = v; } },
      { k: 'invertY', label: 'Invert vertical look', type: 'toggle',
        apply: (v) => { input.invertY = v; } },
    ]],

    ['GAMEPLAY', [
      { k: 'map', label: 'Battleground', type: 'select',
        options: Object.keys(MAPS).map((k) => [k, MAPS[k].name]),
        hint: 'Takes effect on the next match — use Restart Match to deploy there now.' },
      { k: 'difficulty', label: 'Difficulty', type: 'select',
        options: Object.keys(DIFFICULTY).map((k) => [k, DIFFICULTY[k].name]),
        hint: 'Scales everyone\u2019s health (so firefights last longer), how much '
            + 'damage you take, and how sharp the enemy AI is.',
        apply: (v) => { if (game) game.applyDifficulty(v); } },
    ]],

    ['AUDIO', [
      { k: 'vol', label: 'Master volume', type: 'range', min: 0, max: 100, step: 5,
        toUI: (v) => v * 100, fromUI: (v) => v / 100, fmt: (v) => Math.round(v * 100) + '%',
        apply: (v) => audio.setMasterVolume(v) },
    ]],
  ];
}

let SCHEMA = null;
const rowVisible = (it) => !(it.only === 'touch' && !IS_TOUCH) && !(it.only === 'desktop' && IS_TOUCH);

/** Pushes every stored setting into the live systems. */
function applySettings() {
  if (!SCHEMA) SCHEMA = schema();
  for (const [, items] of SCHEMA) {
    for (const it of items) {
      if (it.apply) { try { it.apply(settings[it.k]); } catch { /* not built yet */ } }
    }
  }
  refreshSettingsUI();
}

function buildSettingsUI() {
  if (!SCHEMA) SCHEMA = schema();
  const tabs = $('settabs'), body = $('setbody');
  if (!tabs || !body) return;
  tabs.innerHTML = ''; body.innerHTML = '';

  SCHEMA.forEach(([group, items], gi) => {
    const tab = document.createElement('button');
    tab.className = 'tab' + (gi === 0 ? ' on' : '');
    tab.textContent = group;
    tab.addEventListener('click', () => {
      [...tabs.children].forEach((c) => c.classList.remove('on'));
      [...body.children].forEach((c) => c.classList.remove('on'));
      tab.classList.add('on');
      body.children[gi].classList.add('on');
      audio.uiClick();
    });
    tabs.appendChild(tab);

    const panel = document.createElement('div');
    panel.className = 'setgroup' + (gi === 0 ? ' on' : '');
    for (const it of items) {
      if (!rowVisible(it)) continue;
      const row = document.createElement('label');
      row.className = 'setrow';
      const name = document.createElement('span');
      name.textContent = it.label;
      row.appendChild(name);

      let ctrl, out = null;
      if (it.type === 'select') {
        ctrl = document.createElement('select');
        for (const [val, text] of it.options) {
          const o = document.createElement('option');
          o.value = String(val); o.textContent = text;
          ctrl.appendChild(o);
        }
        ctrl.addEventListener('change', () => {
          settings[it.k] = it.num ? parseFloat(ctrl.value) : ctrl.value;
          commit(it);
        });
      } else if (it.type === 'toggle') {
        ctrl = document.createElement('input');
        ctrl.type = 'checkbox';
        ctrl.addEventListener('change', () => { settings[it.k] = ctrl.checked; commit(it); });
      } else {
        ctrl = document.createElement('input');
        ctrl.type = 'range';
        ctrl.min = it.min; ctrl.max = it.max; ctrl.step = it.step;
        ctrl.addEventListener('input', () => {
          const raw = parseFloat(ctrl.value);
          settings[it.k] = it.fromUI ? it.fromUI(raw) : raw;
          commit(it);
        });
        out = document.createElement('b');
      }
      row.appendChild(ctrl);
      if (out) row.appendChild(out);
      if (it.hint) {
        const h = document.createElement('div');
        h.className = 'hint2';
        h.textContent = it.hint;
        row.appendChild(h);
      }
      it._ctrl = ctrl; it._out = out;
      panel.appendChild(row);
    }
    body.appendChild(panel);
  });
  refreshSettingsUI();
}

function commit(it) {
  if (it.apply) it.apply(settings[it.k]);
  refreshRow(it);
  saveSettings();
  needsRedraw = true;   // the menus render on an idle clock
}

function refreshRow(it) {
  const v = settings[it.k];
  if (!it._ctrl) return;
  if (it.type === 'select') it._ctrl.value = String(v);
  else if (it.type === 'toggle') it._ctrl.checked = !!v;
  else {
    it._ctrl.value = String(it.toUI ? it.toUI(v) : v);
    if (it._out) it._out.textContent = it.fmt ? it.fmt(v) : String(v);
  }
}

function refreshSettingsUI() {
  if (!SCHEMA) return;
  for (const [, items] of SCHEMA) for (const it of items) refreshRow(it);
  renderLobbyRules();
}

function openSettings(fromPause) {
  settingsReturn = fromPause ? 'pause' : 'menu';
  $('menu').classList.add('hidden');
  $('pause').classList.add('hidden');
  $('settings').classList.remove('hidden');
  refreshSettingsUI();
}

function closeSettings() {
  $('settings').classList.add('hidden');
  if (settingsReturn === 'pause') { $('pause').classList.remove('hidden'); updatePauseStats(); }
  else $('menu').classList.remove('hidden');
}

let settingsReturn = 'menu';

/* --------------------------------------------------------------------- UI */

function initUI() {
  buildSettingsUI();

  $('opensettings').addEventListener('click', () => { audio.init(); openSettings(false); });
  $('pausesettings').addEventListener('click', () => openSettings(true));
  $('setback').addEventListener('click', () => { audio.uiClick(); closeSettings(); });
  $('setreset').addEventListener('click', () => {
    Object.assign(settings, JSON.parse(JSON.stringify(DEFAULTS)));
    applySettings();
    resize();
    saveSettings();
    audio.uiClick();
  });

  $('deploy').addEventListener('click', deploy);
  $('resume').addEventListener('click', deploy);
  $('tomenu').addEventListener('click', () => {
    paused = false;
    started = false;
    if (touch) { touch.enabled = false; touch.releaseAll(); }
    if (game) { game.cine.active = true; game.cine.cutAt = 0; }
    renderRoster();
    renderLobbyRules();
    $('pause').classList.add('hidden');
    $('menu').classList.remove('hidden');
    needsRedraw = true;
  });
  $('restart').addEventListener('click', () => {
    if (game) game.dispose();
    game = new Game(gl, renderer, audio, input, hud, settings.difficulty, settings.map, humans);
    game.touch = touch;
    hud.buildMinimap(game.world);
    game.loadout[0] = settings.primary;
    hud.killfeed.length = 0;
    applySettings();
    paused = false;
    $('pause').classList.add('hidden');
    deploy();
  });

  input.onLockChange = (locked) => {
    document.body.classList.toggle('playing', locked);
    if (locked) {
      paused = false;
      $('pause').classList.add('hidden');
      $('menu').classList.add('hidden');
      $('settings').classList.add('hidden');
    } else if (started && !paused && !IS_TOUCH && $('settings').classList.contains('hidden')) {
      togglePause(true);
    }
  };

  // Clicking the view re-acquires the mouse — pointer lock can be refused or
  // dropped by the browser, and a dead click would otherwise look like a hang.
  glCanvas.addEventListener('click', () => {
    if (started && !input.locked && !IS_TOUCH && !paused) { audio.resume(); input.requestLock(); }
  });

  // Backgrounding the tab (or taking a call) should never cost you a life.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && started && !paused) togglePause(true);
  });
}


/* -------------------------------------------------------------- the lobby */

/** Normalised 0..1 bars derived from the weapon definitions themselves. */
function weaponBars(w) {
  const inv = (v, lo, hi) => clamp(1 - (v - lo) / (hi - lo), 0, 1);
  const norm = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);
  const recoil = w.recoil.v + w.recoil.h * 0.5;
  return [
    ['Damage', norm(w.damage * (w.bullets > 1 ? w.bullets * 0.55 : 1), 18, 135)],
    ['Range', norm(w.falloffStart, 6, 60)],
    ['Fire rate', norm(w.rpm, 45, 980)],
    ['Handling', inv(w.adsTime, 0.16, 0.40) * 0.6 + norm(w.moveMul, 0.86, 1.15) * 0.4],
    ['Control', inv(recoil, 0.5, 3.5)],
  ];
}

function buildLobby() {
  // --- battlegrounds
  const ml = $('maplist');
  ml.innerHTML = '';
  for (const id of Object.keys(MAPS)) {
    const m = MAPS[id];
    const el = document.createElement('div');
    el.className = 'pick' + (settings.map === id ? ' on' : '');
    el.innerHTML = `<div class="row1"><b>${m.name}</b><i>${id === settings.map ? 'SELECTED' : ''}</i></div>`
      + `<small>${m.blurb}</small>`;
    el.addEventListener('click', () => {
      if (settings.map === id) return;
      settings.map = id;
      saveSettings();
      selectMap(id);
    });
    ml.appendChild(el);
  }

  // --- primary weapon
  const el = $('loadout');
  el.innerHTML = '';
  for (const w of WEAPONS) {
    if (w.id === 'pistol') continue;
    const d = document.createElement('div');
    d.className = 'pick' + (settings.primary === w.id ? ' on' : '');
    d.innerHTML = `<div class="row1"><b>${w.name}</b><i>${w.class}</i></div>`;
    d.addEventListener('click', () => {
      settings.primary = w.id;
      saveSettings();
      if (game) {
        game.loadout[0] = w.id;
        game.slot = 0;
        game.ammo[w.id] = w.mag;
        game.vm.startSwitch(0.5);
      }
      [...el.children].forEach((c) => c.classList.remove('on'));
      d.classList.add('on');
      renderWeaponStats();
      audio.uiClick();
    });
    el.appendChild(d);
  }
  renderWeaponStats();
  renderRoster();
  renderLobbyRules();
}

function renderWeaponStats() {
  const host = $('weaponstats');
  if (!host) return;
  const w = WEAPONS.find((x) => x.id === settings.primary) || WEAPONS[0];
  host.innerHTML = weaponBars(w).map(([label, v]) =>
    `<div class="stat"><span>${label}</span><div class="bar"><i style="width:${(v * 100).toFixed(0)}%"></i></div></div>`).join('');
}

function renderRoster() {
  const host = $('roster');
  if (!host || !game) return;
  const team = (n) => game.bots.filter((b) => b.team === n).map((b) => b.name);
  const row = (name, tag, you) =>
    `<div class="op${you ? ' you' : ''}">${name}<em>${tag}</em></div>`;
  host.innerHTML =
    `<div class="team"><div class="teamhead allies"><i></i>ALLIES</div>`
    + row('YOU', 'OPERATOR', true)
    + team(0).map((n) => row(n, 'AI')).join('')
    + `</div><div class="team"><div class="teamhead enemies"><i></i>HOSTILES</div>`
    + team(1).map((n) => row(n, 'AI')).join('')
    + `</div>`;
}

function renderLobbyRules() {
  const m = MAPS[settings.map] || MAPS.scrapyard;
  const d = DIFFICULTY[settings.difficulty] || DIFFICULTY.regular;
  const mr = $('maprules');
  if (mr) {
    mr.innerHTML = `Mode <b>TEAM DEATHMATCH</b><br>`
      + `Score limit <b>${game ? game.scoreLimit : 75}</b> · `
      + `Time <b>${Math.round((game ? game.timeLimit : 600) / 60)} min</b>`;
  }
  const en = $('engagement');
  if (en) {
    en.innerHTML = `Difficulty <b>${d.name}</b><br>`
      + `Health <b>${Math.round(100 * d.healthScale)}</b> · Damage taken <b>${Math.round(d.damageTaken * 100)}%</b><br>`
      + `Quality <b>${settings.quality.toUpperCase()}</b>${settings.fpsCap ? ` · <b>${settings.fpsCap} FPS</b>` : ''}`;
  }
}

/** Rebuilds the match on the chosen map so the lobby flies over the real thing. */
function selectMap(id) {
  audio.uiClick();
  if (game) game.dispose();
  game = new Game(gl, renderer, audio, input, hud, settings.difficulty, id, humans);
  game.touch = touch;
  game.cine.active = true;
  applySettings();
  hud.buildMinimap(game.world);
  hud.killfeed.length = 0;
  buildLobby();
  needsRedraw = true;
}


function togglePause(on) {
  if (!started) return;
  paused = on;
  if (on) {
    if (touch) touch.releaseAll();
    $('pause').classList.remove('hidden');
    updatePauseStats();
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    $('pause').classList.add('hidden');
  }
}

/** Fullscreen is best-effort: iPhone Safari has no Element.requestFullscreen. */
async function goFullscreen() {
  if (!IS_MOBILE || document.fullscreenElement) return;
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch { /* iOS Safari — the browser chrome just stays. */ }
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch { /* not permitted outside fullscreen, or unsupported */ }
}

function deploy() {
  audio.init();
  audio.resume();
  goFullscreen();
  if (game) { game.loadout[0] = settings.primary; game.fovBase = settings.fov; }
  $('menu').classList.add('hidden');
  $('pause').classList.add('hidden');
  $('settings').classList.add('hidden');
  if (game) game.cine.active = false;
  paused = false;
  started = true;
  if (touch) { touch.enabled = true; touch.releaseAll(); }
  input.requestLock();
  resize();
}

function updatePauseStats() {
  if (!game) return;
  const kd = game.deaths ? (game.kills / game.deaths).toFixed(2) : game.kills.toFixed(2);
  $('pausestats').innerHTML =
    `SCORE <b>${game.score[0]}</b> — <b>${game.score[1]}</b><br>` +
    `KILLS <b>${game.kills}</b> &nbsp; DEATHS <b>${game.deaths}</b> &nbsp; K/D <b>${kd}</b><br>` +
    `BEST STREAK <b>${game.bestStreak}</b> &nbsp; XP <b>${game.xp}</b>`;
}

/* ------------------------------------------------------------------ loop */

let last = performance.now();
let fpsAcc = 0, fpsN = 0, fpsShown = 0;
let nextFrame = 0;
let menuAcc = 0;
// Redraw rate when nobody is actually playing. Rendering a full deferred frame
// 60 times a second while the player reads the briefing — or has walked away
// from a paused game — is pure heat for no benefit.
// The lobby flies a camera over the map, so it needs a smooth-ish rate; a
// paused match is a still frame and needs almost nothing.
export const IDLE_FPS = { menu: 30, paused: 6, blurred: 3 };

/**
 * Redraw rate for a given state. Pure so it can be reasoned about and tested
 * without a browser: 0 means "every frame".
 */
export function idleTargetFps({ active, started, focused }) {
  if (active) return 0;
  if (!focused) return IDLE_FPS.blurred;
  return started ? IDLE_FPS.paused : IDLE_FPS.menu;
}

let idleAcc = 0;
let needsRedraw = true;
let windowFocused = true;
addEventListener('blur', () => { windowFocused = false; });
addEventListener('focus', () => { windowFocused = true; needsRedraw = true; });

/** Force one immediate redraw — used when a setting changes while idle. */
export function invalidate() { needsRedraw = true; }

function loop(now) {
  requestAnimationFrame(loop);
  if (!running) return;

  // Frame limiter. On a 120/144 Hz panel the browser will happily ask for
  // twice the frames, which doubles GPU load for no visible benefit.
  if (settings.fpsCap > 0) {
    const minDelta = 1000 / settings.fpsCap - 1.5;   // small slack for jitter
    if (now < nextFrame) return;
    nextFrame = Math.max(now + minDelta, nextFrame + minDelta);
    if (nextFrame < now) nextFrame = now + minDelta;
  }

  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    fpsShown = Math.round(fpsN / fpsAcc);
    $('fps').textContent = fpsShown + ' FPS';
    fpsAcc = 0; fpsN = 0;
  }

  const active = started && !paused && input.active && checkOrientation();
  if (touch) touch.enabled = started && !paused;
  if (active && touch) touch.update(dt);
  else if (touch && !active) { input.axis.x = 0; input.axis.y = 0; }

  // Idle throttling: while not playing, redraw only often enough to keep the
  // backdrop alive. Input still runs every frame so the UI stays responsive.
  let drawFrame = true;
  const target = idleTargetFps({ active, started, focused: windowFocused });
  if (target > 0) {
    idleAcc += dt;
    if (needsRedraw || idleAcc >= 1 / target) { idleAcc = 0; drawFrame = true; }
    else drawFrame = false;
  } else {
    idleAcc = 0;
  }
  needsRedraw = false;
  if (!drawFrame) { input.endFrame(); return; }

  renderer.beginFrame(dt);

  if (active) game.update(dt);
  else if (!started) {
    // Briefing screen: keep the firefight running behind the menu, but at a
    // quarter rate — nobody is aiming at it, and it should not cost a full
    // simulation while the player reads the controls.
    menuAcc += dt;
    if (menuAcc >= 1 / 15) {
      game.hud.update(menuAcc);
      game.updateBots(menuAcc);
      game.updateProjectiles(menuAcc);
      menuAcc = 0;
    }
  }
  // Paused mid-match: everything is frozen, we only keep drawing.

  game.submit(dt);
  renderer.render();

  if (started) {
    hud.draw(game.hudState());
  } else {
    hud.ctx.setTransform(1, 0, 0, 1, 0, 0);
    hud.ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  }

  input.endFrame();
}

// Surface errors instead of failing silently to a black screen.
addEventListener('error', (e) => {
  if (!started) fail('ERROR: ' + (e.message || 'unknown'));
  console.error(e.error || e.message);
});
addEventListener('unhandledrejection', (e) => {
  if (!started) fail('ERROR: ' + (e.reason && e.reason.message || e.reason));
  console.error(e.reason);
});

boot().catch((e) => {
  console.error(e);
  fail('ERROR: ' + (e && e.message ? e.message : String(e)));
});

// Debug/automation hook.
window.OB = {
  get game() { return game; },
  get renderer() { return renderer; },
  get input() { return input; },
  get hud() { return hud; },
  get settings() { return settings; },
  // Mirrors deploy() minus pointer lock, for automated checks.
  forceStart() {
    audio.init(); started = true; paused = false; input.locked = true;
    if (game) game.cine.active = false;
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    document.getElementById('settings').classList.add('hidden');
  },
};
