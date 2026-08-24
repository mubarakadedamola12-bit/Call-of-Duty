// Bootstrap: loading, menu, settings, the frame loop.

import { createContext } from './core/gl.js';
import { Renderer, QUALITY } from './render/renderer.js';
import { Input } from './core/input.js';
import { TouchControls } from './core/touch.js';
import { Audio } from './core/audio.js';
import { HUD } from './game/hud.js';
import { Game } from './game/game.js';
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
  scale: defaultScale, fov: IS_MOBILE ? 85 : 80, grain: 0.38, sens: 1, vol: 0.55,
  primary: 'kilo', quality: defaultQuality,
  touchSens: 1, aimAssist: IS_TOUCH ? 0.85 : 0,
};
try { Object.assign(settings, JSON.parse(localStorage.getItem('ob_settings') || '{}')); } catch { /* ignore */ }
const saveSettings = () => { try { localStorage.setItem('ob_settings', JSON.stringify(settings)); } catch { /* ignore */ } };

let gl, renderer, input, audio, hud, game, touch;
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
  const portrait = window.innerHeight > window.innerWidth;
  $('rotate').classList.toggle('hidden', !portrait);
  return !portrait;
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
  game.touch = touch;
  game.aimAssist = settings.aimAssist;
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
  readSafeInsets();
  // Phones lie about devicePixelRatio for our purposes — 3x on a mid-range GPU
  // is a slideshow, and the difference is invisible at arm's length.
  const dprCap = IS_MOBILE ? 2 : 2;
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
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
}
addEventListener('resize', () => { if (renderer) resize(); });
addEventListener('orientationchange', () => setTimeout(() => { if (renderer) resize(); }, 220));
if (window.visualViewport) visualViewport.addEventListener('resize', () => { if (renderer) resize(); });

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
  input.sensitivity = 0.0022 * (IS_TOUCH ? settings.touchSens : settings.sens);
  audio.setMasterVolume(settings.vol);
  if (game) { game.fovBase = settings.fov; game.aimAssist = settings.aimAssist; }

  const qs = $('optQuality');
  if (qs) {
    qs.value = settings.quality;
    $('optQualityV').textContent = settings.quality.toUpperCase();
  }
  const as = $('optAssist');
  if (as) {
    as.value = Math.round(settings.aimAssist * 100);
    $('optAssistV').textContent = settings.aimAssist > 0
      ? Math.round(settings.aimAssist * 100) + '%' : 'OFF';
  }
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

  const qs = $('optQuality');
  if (qs) qs.addEventListener('change', () => {
    settings.quality = qs.value;
    $('optQualityV').textContent = settings.quality.toUpperCase();
    renderer.setQuality(settings.quality);
    saveSettings();
  });
  const as = $('optAssist');
  if (as) as.addEventListener('input', () => {
    settings.aimAssist = parseFloat(as.value) / 100;
    $('optAssistV').textContent = settings.aimAssist > 0
      ? Math.round(settings.aimAssist * 100) + '%' : 'OFF';
    if (game) game.aimAssist = settings.aimAssist;
    saveSettings();
  });

  $('deploy').addEventListener('click', deploy);
  $('resume').addEventListener('click', deploy);
  $('tomenu').addEventListener('click', () => {
    paused = false;
    started = false;
    if (touch) { touch.enabled = false; touch.releaseAll(); }
    $('pause').classList.add('hidden');
    $('menu').classList.remove('hidden');
  });
  $('restart').addEventListener('click', () => {
    game = new Game(gl, renderer, audio, input, hud);
    game.touch = touch;
    game.aimAssist = settings.aimAssist;
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
    } else if (started && !paused && !IS_TOUCH) {
      togglePause(true);
    }
  };

  // Clicking the view re-acquires the mouse — pointer lock can be refused or
  // dropped by the browser, and a dead click would otherwise look like a hang.
  glCanvas.addEventListener('click', () => {
    if (started && !input.locked && !IS_TOUCH) { audio.resume(); input.requestLock(); }
  });

  // Backgrounding the tab (or taking a call) should never cost you a life.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && started && !paused) togglePause(true);
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

  const active = started && !paused && input.active && checkOrientation();
  if (touch) touch.enabled = started && !paused;
  if (active && touch) touch.update(dt);
  else if (touch && !active) { input.axis.x = 0; input.axis.y = 0; }
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
