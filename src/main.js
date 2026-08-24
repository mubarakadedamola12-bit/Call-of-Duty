// Bootstrap: loading, menu, settings, the frame loop.

import { createContext } from './core/gl.js';
import { Renderer } from './render/renderer.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { HUD } from './game/hud.js';
import { Game } from './game/game.js';
import { WEAPONS } from './game/weapons.js';
import { clamp } from './core/math.js';

const glCanvas = document.getElementById('gl');
const hudCanvas = document.getElementById('hud');
const $ = (id) => document.getElementById(id);

const settings = {
  scale: 1, fov: 80, grain: 0.38, sens: 1, vol: 0.55, primary: 'kilo',
};
try { Object.assign(settings, JSON.parse(localStorage.getItem('ob_settings') || '{}')); } catch { /* ignore */ }
const saveSettings = () => { try { localStorage.setItem('ob_settings', JSON.stringify(settings)); } catch { /* ignore */ } };

let gl, renderer, input, audio, hud, game;
let running = false, paused = false, started = false;

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
  audio = new Audio();
  hud = new HUD(hudCanvas);
  renderer = new Renderer(glCanvas, gl);
  initUI();

  const setProgress = (p, msg) => {
    $('loadbar').style.width = (p * 100).toFixed(0) + '%';
    if (msg) $('loadmsg').textContent = msg;
  };

  setProgress(0.05, 'COMPILING SHADERS…');
  await frame();

  setProgress(0.10, 'BAKING MATERIALS…');
  await renderer.loadMaterials((p) => setProgress(0.10 + p * 0.62, 'BAKING MATERIALS… ' + (p * 100 | 0) + '%'));

  setProgress(0.76, 'BUILDING SCRAPYARD…');
  await frame();
  resize();

  game = new Game(gl, renderer, audio, input, hud);
  setProgress(0.94, 'DEPLOYING SQUADS…');
  await frame();
  hud.buildMinimap(game.world);

  applySettings();
  buildLoadoutUI();
  setProgress(1, 'READY');
  await new Promise((r) => setTimeout(r, 260));
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
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  const rw = Math.max(2, Math.round(w * dpr * settings.scale));
  const rh = Math.max(2, Math.round(h * dpr * settings.scale));
  glCanvas.width = rw; glCanvas.height = rh;
  glCanvas.style.width = w + 'px'; glCanvas.style.height = h + 'px';
  renderer.resize(rw, rh);
  hud.resize(w, h, dpr);
}
addEventListener('resize', () => { if (renderer) resize(); });

/* --------------------------------------------------------------- settings */

function applySettings() {
  $('optScale').value = settings.scale * 100;
  $('optScaleV').textContent = (settings.scale * 100 | 0) + '%';
  $('optFov').value = settings.fov;
  $('optFovV').textContent = settings.fov;
  $('optGrain').value = settings.grain * 100;
  $('optGrainV').textContent = (settings.grain * 100 | 0);
  $('optSens').value = settings.sens * 100;
  $('optSensV').textContent = settings.sens.toFixed(2);
  $('optVol').value = settings.vol * 100;
  $('optVolV').textContent = (settings.vol * 100 | 0);

  renderer.grain = settings.grain * 0.10;
  input.sensitivity = 0.0022 * settings.sens;
  audio.setMasterVolume(settings.vol);
  if (game) { game.fovBase = settings.fov; }
}

function bindSlider(id, key, fmt, onChange) {
  const el = $(id), out = $(id + 'V');
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    settings[key] = onChange ? onChange(v) : v;
    out.textContent = fmt(settings[key]);
    saveSettings();
  });
}

function initUI() {
  bindSlider('optScale', 'scale', (v) => (v * 100 | 0) + '%', (v) => { const s = v / 100; settings.scale = s; resize(); return s; });
  bindSlider('optFov', 'fov', (v) => String(v | 0), (v) => { if (game) game.fovBase = v; return v; });
  bindSlider('optGrain', 'grain', (v) => String(v * 100 | 0), (v) => { const g = v / 100; renderer.grain = g * 0.10; return g; });
  bindSlider('optSens', 'sens', (v) => v.toFixed(2), (v) => { const s = v / 100; input.sensitivity = 0.0022 * s; return s; });
  bindSlider('optVol', 'vol', (v) => String(v * 100 | 0), (v) => { const a = v / 100; audio.setMasterVolume(a); return a; });

  $('deploy').addEventListener('click', deploy);
  $('resume').addEventListener('click', deploy);
  $('tomenu').addEventListener('click', () => {
    paused = false;
    $('pause').classList.add('hidden');
    $('menu').classList.remove('hidden');
  });
  $('restart').addEventListener('click', () => {
    game = new Game(gl, renderer, audio, input, hud);
    game.fovBase = settings.fov;
    game.loadout[0] = settings.primary;
    hud.killfeed.length = 0;
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
    } else if (started && !paused) {
      paused = true;
      $('pause').classList.remove('hidden');
      updatePauseStats();
    }
  };

  // Clicking the view re-acquires the mouse — pointer lock can be refused or
  // dropped by the browser, and a dead click would otherwise look like a hang.
  glCanvas.addEventListener('click', () => {
    if (started && !input.locked) { audio.resume(); input.requestLock(); }
  });
}

function buildLoadoutUI() {
  const el = $('loadout');
  el.innerHTML = '';
  for (const w of WEAPONS) {
    if (w.id === 'pistol') continue;
    const d = document.createElement('div');
    d.className = 'wpn' + (settings.primary === w.id ? ' on' : '');
    d.innerHTML = `<b>${w.name}</b><i>${w.class}</i>`;
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
      audio.uiClick();
    });
    el.appendChild(d);
  }
}

function deploy() {
  audio.init();
  audio.resume();
  if (game) { game.loadout[0] = settings.primary; game.fovBase = settings.fov; }
  $('menu').classList.add('hidden');
  $('pause').classList.add('hidden');
  paused = false;
  started = true;
  input.requestLock();
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

function loop(now) {
  requestAnimationFrame(loop);
  if (!running) return;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    fpsShown = Math.round(fpsN / fpsAcc);
    $('fps').textContent = fpsShown + ' FPS';
    fpsAcc = 0; fpsN = 0;
  }

  const active = started && !paused && input.locked;
  renderer.beginFrame(dt);

  if (active) game.update(dt);
  else if (!started) {
    // Briefing screen: keep the firefight running behind the menu.
    game.hud.update(dt);
    game.updateBots(dt);
    game.updateProjectiles(dt);
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
  forceStart() { audio.init(); started = true; paused = false; input.locked = true;
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden'); },
};
