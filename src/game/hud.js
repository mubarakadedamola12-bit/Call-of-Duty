// Canvas-2D HUD drawn over the WebGL canvas.

import { clamp, lerp, smoothstep } from '../core/math.js';
import { ARENA } from './world.js';

const F = (w, s, extra = '') => `${extra} ${w} ${s}px "Barlow Condensed","Oswald","Roboto Condensed",system-ui,sans-serif`;
const ACCENT = '#ffc233';
const ENEMY = '#ff3b30';
const ALLY = '#4da3ff';

export class HUD {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.killfeed = [];
    this.popups = [];
    this.hitmarker = 0; this.hitmarkerKill = false; this.hitmarkerHead = false;
    this.damageDirs = [];
    this.miniStatic = null;
    this.obituaryLimit = 5;
    this.banner = null;
  }

  resize(w, h, dpr) {
    this.dpr = dpr;
    this.c.width = w * dpr; this.c.height = h * dpr;
    this.c.style.width = w + 'px'; this.c.style.height = h + 'px';
    this.w = w; this.h = h;
  }

  /** Pre-render the static map footprint once. */
  buildMinimap(world) {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(10,14,18,0.0)';
    g.fillRect(0, 0, S, S);
    const k = S / (ARENA * 2);
    g.save();
    g.translate(S / 2, S / 2);
    for (const c of world.colliders) {
      if (c.top < 0.5) continue;
      const tall = c.top > 2.3;
      g.save();
      g.translate(c.c[0] * k, c.c[2] * k);
      g.rotate(c.ry);
      g.fillStyle = tall ? 'rgba(150,168,186,0.55)' : 'rgba(110,126,142,0.40)';
      g.fillRect(-c.h[0] * k, -c.h[2] * k, c.h[0] * 2 * k, c.h[2] * 2 * k);
      g.restore();
    }
    g.restore();
    this.miniStatic = cv;
  }

  addKill(killer, victim, weapon, isPlayer, headshot) {
    this.killfeed.push({ killer, victim, weapon, t: 0, isPlayer, headshot });
    if (this.killfeed.length > this.obituaryLimit) this.killfeed.shift();
  }
  addPopup(text, sub, color) { this.popups.push({ text, sub, color: color || ACCENT, t: 0 }); }
  addDamageDir(angle) { this.damageDirs.push({ a: angle, t: 0 }); }
  hit(kill, head) {
    this.hitmarker = 1;
    this.hitmarkerKill = kill || this.hitmarkerKill && this.hitmarker > 0.5;
    if (kill) this.hitmarkerKill = true;
    this.hitmarkerHead = head;
  }
  showBanner(title, sub, dur = 2.6) { this.banner = { title, sub, t: 0, dur }; }

  update(dt) {
    this.hitmarker = Math.max(0, this.hitmarker - dt * 3.2);
    if (this.hitmarker === 0) this.hitmarkerKill = false;
    for (let i = this.killfeed.length - 1; i >= 0; i--) {
      this.killfeed[i].t += dt;
      if (this.killfeed[i].t > 6) this.killfeed.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      this.popups[i].t += dt;
      if (this.popups[i].t > 1.6) this.popups.splice(i, 1);
    }
    for (let i = this.damageDirs.length - 1; i >= 0; i--) {
      this.damageDirs[i].t += dt;
      if (this.damageDirs[i].t > 1.2) this.damageDirs.splice(i, 1);
    }
    if (this.banner) { this.banner.t += dt; if (this.banner.t > this.banner.dur) this.banner = null; }
  }

  /* ------------------------------------------------------------------ */

  draw(s) {
    const ctx = this.ctx;
    const w = this.w, h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';

    if (s.scoped > 0.5) this._scope(ctx, w, h, s);
    if (!s.dead && s.scoped < 0.5) this._crosshair(ctx, w, h, s);
    this._hitmarker(ctx, w, h);
    this._damageDirs(ctx, w, h, s);
    this._compass(ctx, w, h, s);
    this._minimap(ctx, s);
    this._ammo(ctx, w, h, s);
    this._health(ctx, w, h, s);
    this._score(ctx, w, h, s);
    this._killfeed(ctx, w, h);
    this._popups(ctx, w, h);
    this._streaks(ctx, w, h, s);
    if (s.dead) this._deathScreen(ctx, w, h, s);
    if (this.banner) this._banner(ctx, w, h);
  }

  /* -------------------------------------------------------- crosshair */

  _crosshair(ctx, w, h, s) {
    const cx = w / 2, cy = h / 2;
    const ads = s.ads;
    const a = (1 - ads) * 0.95;
    if (a <= 0.01) {
      // ADS: just a fine centre dot.
      ctx.fillStyle = 'rgba(255,60,40,0.95)';
      ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, 6.2832); ctx.fill();
      return;
    }
    const gap = 5 + s.spread * 620 + s.moving * 5;
    const len = 7;
    ctx.strokeStyle = `rgba(235,242,250,${a})`;
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.moveTo(cx - gap - len, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
    ctx.moveTo(cx, cy - gap - len); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(235,242,250,${a * 0.9})`;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
  }

  _scope(ctx, w, h, s) {
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.40;
    ctx.save();
    // Blacked-out surround.
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cx, cy, R, 0, 6.2832, true);
    ctx.fillStyle = '#000';
    ctx.fill();
    // Lens edge falloff.
    const gr = ctx.createRadialGradient(cx, cy, R * 0.72, cx, cy, R);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.92)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fill();
    // Reticle.
    const sway = s.scopeSway || 0;
    ctx.translate(cx + sway * 12, cy + (s.scopeSwayY || 0) * 12);
    ctx.strokeStyle = 'rgba(12,14,16,0.92)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-R, 0); ctx.lineTo(-14, 0);
    ctx.moveTo(14, 0); ctx.lineTo(R, 0);
    ctx.moveTo(0, -R); ctx.lineTo(0, -14);
    ctx.moveTo(0, 14); ctx.lineTo(0, R);
    ctx.stroke();
    // Mil-dot ladder.
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 1; i <= 5; i++) {
      const y = i * R * 0.11;
      const l = i % 2 === 0 ? 9 : 5;
      ctx.moveTo(-l, y); ctx.lineTo(l, y);
    }
    for (let i = 1; i <= 3; i++) {
      const x = i * R * 0.14;
      ctx.moveTo(x, -5); ctx.lineTo(x, 5);
      ctx.moveTo(-x, -5); ctx.lineTo(-x, 5);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,30,20,0.9)';
    ctx.beginPath(); ctx.arc(0, 0, 1.5, 0, 6.2832); ctx.fill();
    ctx.restore();
    // Lens glint.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const g2 = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.3, cy + R * 0.3);
    g2.addColorStop(0, 'rgba(120,180,255,0.10)');
    g2.addColorStop(0.5, 'rgba(120,180,255,0.0)');
    ctx.fillStyle = g2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fill();
    ctx.restore();
  }

  _hitmarker(ctx, w, h) {
    if (this.hitmarker <= 0) return;
    const cx = w / 2, cy = h / 2;
    const t = this.hitmarker;
    const g = 6 + (1 - t) * 5;
    const l = 6;
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.6);
    ctx.strokeStyle = this.hitmarkerKill ? '#ff2d20' : (this.hitmarkerHead ? '#ffd54a' : '#f2f6fb');
    ctx.lineWidth = this.hitmarkerKill ? 3 : 2.4;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(cx + sx * g, cy + sy * g);
      ctx.lineTo(cx + sx * (g + l), cy + sy * (g + l));
    }
    ctx.stroke();
    ctx.restore();
  }

  _damageDirs(ctx, w, h, s) {
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.20;
    for (const d of this.damageDirs) {
      const a = 1 - d.t / 1.2;
      const rel = d.a - s.yaw;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rel);
      ctx.globalAlpha = a * 0.9;
      ctx.strokeStyle = ENEMY;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, R, -Math.PI / 2 - 0.34, -Math.PI / 2 + 0.34);
      ctx.stroke();
      ctx.globalAlpha = a * 0.35;
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* --------------------------------------------------------- compass */

  _compass(ctx, w, h, s) {
    const cx = w / 2, y = 26, halfW = Math.min(230, w * 0.22);
    ctx.save();
    ctx.beginPath(); ctx.rect(cx - halfW, y - 16, halfW * 2, 32); ctx.clip();
    const grad = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.25, 'rgba(0,0,0,0.42)');
    grad.addColorStop(0.75, 'rgba(0,0,0,0.42)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - halfW, y - 14, halfW * 2, 28);

    const yawDeg = (s.yaw * 180 / Math.PI + 360000) % 360;
    const pxPerDeg = halfW / 62;
    const marks = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
    ctx.textAlign = 'center';
    for (let d = -70; d <= 70; d += 5) {
      let deg = yawDeg + d;
      const px = cx + d * pxPerDeg;
      const norm = ((deg % 360) + 360) % 360;
      const label = marks.find((m) => Math.abs(((norm - m[1] + 540) % 360) - 180) > 179.5);
      const fade = 1 - Math.abs(d) / 74;
      if (label) {
        ctx.fillStyle = `rgba(255,255,255,${0.92 * fade})`;
        ctx.font = F(700, 13, '');
        ctx.fillText(label[0], px, y);
      } else if (norm % 15 < 2.5) {
        ctx.fillStyle = `rgba(255,255,255,${0.42 * fade})`;
        ctx.fillRect(px - 0.5, y - 4, 1, 8);
      } else {
        ctx.fillStyle = `rgba(255,255,255,${0.22 * fade})`;
        ctx.fillRect(px - 0.5, y - 2, 1, 4);
      }
    }
    ctx.restore();
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(cx, y + 13); ctx.lineTo(cx - 4, y + 19); ctx.lineTo(cx + 4, y + 19);
    ctx.closePath(); ctx.fill();
  }

  /* --------------------------------------------------------- minimap */

  _minimap(ctx, s) {
    const size = 152, pad = 18;
    const cx = pad + size / 2, cy = pad + size / 2;
    ctx.save();
    // Frame.
    ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, 6.2832);
    ctx.fillStyle = 'rgba(6,10,14,0.62)';
    ctx.fill();
    ctx.save();
    ctx.clip();

    const zoom = s.uav > 0 ? 1.5 : 2.1;
    const k = (size / (ARENA * 2)) * zoom;
    ctx.translate(cx, cy);
    ctx.rotate(-s.yaw);
    ctx.translate(-s.px * k, -s.pz * k);

    if (this.miniStatic) {
      const S = this.miniStatic.width;
      const worldSize = ARENA * 2 * k;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.miniStatic, -worldSize / 2, -worldSize / 2, worldSize, worldSize);
      ctx.globalAlpha = 1;
    }
    // Arena border.
    ctx.strokeStyle = 'rgba(120,140,160,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-ARENA * k, -ARENA * k, ARENA * 2 * k, ARENA * 2 * k);

    // Contacts.
    for (const b of s.blips) {
      ctx.save();
      ctx.translate(b.x * k, b.z * k);
      ctx.rotate(s.yaw);
      if (b.dead) { ctx.restore(); continue; }
      ctx.fillStyle = b.enemy ? ENEMY : ALLY;
      if (b.enemy) {
        ctx.save();
        ctx.rotate(b.yaw - s.yaw + s.yaw);
        ctx.beginPath();
        ctx.moveTo(0, -5); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(0, 0, 3.4, 0, 6.2832); ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();

    // UAV sweep.
    if (s.uav > 0) {
      const a = (performance.now() * 0.0016) % 6.2832;
      const g = ctx.createConicGradient ? null : null;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, 6.2832); ctx.clip();
      ctx.translate(cx, cy);
      ctx.rotate(a);
      const lg = ctx.createLinearGradient(0, 0, size / 2, 0);
      lg.addColorStop(0, 'rgba(90,200,255,0.30)');
      lg.addColorStop(1, 'rgba(90,200,255,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, size / 2, -0.5, 0);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Player arrow.
    ctx.fillStyle = '#eaf2fb';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7); ctx.lineTo(cx + 5.5, cy + 6); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx - 5.5, cy + 6);
    ctx.closePath(); ctx.fill();

    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, size / 2, 0, 6.2832);
    ctx.strokeStyle = 'rgba(200,215,230,0.45)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, size / 2 + 4, 0, 6.2832);
    ctx.strokeStyle = 'rgba(200,215,230,0.14)'; ctx.lineWidth = 1; ctx.stroke();

    if (s.uav > 0) {
      ctx.font = F(700, 11, '');
      ctx.textAlign = 'center';
      ctx.fillStyle = '#5ac8ff';
      ctx.fillText('UAV  ' + Math.ceil(s.uav) + 's', cx, pad + size + 12);
    }
  }

  /* ------------------------------------------------------------ ammo */

  _ammo(ctx, w, h, s) {
    const x = w - 34, y = h - 42;
    ctx.textAlign = 'right';
    const low = s.ammo <= Math.max(1, Math.ceil(s.magSize * 0.25));
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6;

    ctx.font = F(700, 52, '');
    ctx.fillStyle = s.ammo === 0 ? '#ff3b30' : (low ? '#ffb03a' : '#f2f6fb');
    const magStr = String(s.ammo);
    ctx.fillText(magStr, x - 62, y);
    const mw = ctx.measureText(magStr).width;

    ctx.font = F(600, 26, '');
    ctx.fillStyle = 'rgba(230,240,250,0.62)';
    ctx.fillText('/ ' + s.reserve, x, y + 3);

    ctx.font = F(600, 15, '');
    ctx.fillStyle = ACCENT;
    ctx.textAlign = 'right';
    ctx.fillText(s.weaponName, x, y - 40);
    ctx.font = F(500, 11, '');
    ctx.fillStyle = 'rgba(210,225,240,0.55)';
    ctx.fillText(s.weaponClass, x, y - 24);

    // Magazine pips.
    const pips = Math.min(s.magSize, 40);
    const pw = 4, gap = 2;
    const totalW = pips * (pw + gap);
    const px0 = x - totalW;
    for (let i = 0; i < pips; i++) {
      const filled = i < Math.round((s.ammo / s.magSize) * pips);
      ctx.fillStyle = filled ? (low ? 'rgba(255,176,58,0.9)' : 'rgba(242,246,251,0.82)') : 'rgba(255,255,255,0.14)';
      ctx.fillRect(px0 + i * (pw + gap), y + 24, pw, 7);
    }
    ctx.shadowBlur = 0;

    if (s.reloading) {
      ctx.textAlign = 'center';
      ctx.font = F(700, 15, '');
      ctx.fillStyle = ACCENT;
      ctx.fillText('RELOADING', w / 2, h * 0.62);
      const bw = 120, bx = w / 2 - bw / 2, by = h * 0.62 + 14;
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(bx, by, bw * s.reloadProgress, 3);
    } else if (s.ammo === 0 && s.reserve > 0) {
      ctx.textAlign = 'center';
      ctx.font = F(700, 16, '');
      ctx.fillStyle = (performance.now() % 700 < 380) ? '#ff3b30' : 'rgba(255,59,48,0.35)';
      ctx.fillText('PRESS  R  TO RELOAD', w / 2, h * 0.62);
    }

    // Lethal / tactical slots.
    ctx.textAlign = 'left';
    ctx.font = F(600, 12, '');
    ctx.fillStyle = s.grenades > 0 ? 'rgba(230,240,250,0.85)' : 'rgba(230,240,250,0.25)';
    ctx.fillText('◆ FRAG  x' + s.grenades, w - 250, h - 24);
    ctx.fillStyle = 'rgba(230,240,250,0.45)';
    ctx.fillText('[G]', w - 190, h - 24);
  }

  _health(ctx, w, h, s) {
    const x = 26, y = h - 40, bw = 210, bh = 7;
    const frac = clamp(s.health / s.maxHealth, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(x - 2, y - 2, bw + 4, bh + 4);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x, y, bw, bh);
    const col = frac > 0.55 ? '#4cd964' : frac > 0.28 ? '#ffb03a' : '#ff3b30';
    ctx.fillStyle = col;
    ctx.fillRect(x, y, bw * frac, bh);
    if (s.regen > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x + bw * frac, y, 3, bh);
    }
    ctx.textAlign = 'left';
    ctx.font = F(700, 12, '');
    ctx.fillStyle = 'rgba(230,240,250,0.75)';
    ctx.fillText('ARMOUR  ' + Math.ceil(s.health), x, y - 12);
  }

  /* ----------------------------------------------------------- score */

  _score(ctx, w, h, s) {
    const cx = w / 2, y = 58;
    ctx.textAlign = 'center';
    ctx.font = F(700, 22, '');
    const t = Math.max(0, s.timeLeft);
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    ctx.fillStyle = t < 30 ? '#ff3b30' : 'rgba(240,246,252,0.92)';
    ctx.fillText(`${mm}:${String(ss).padStart(2, '0')}`, cx, y);

    ctx.font = F(700, 26, '');
    ctx.textAlign = 'right';
    ctx.fillStyle = ALLY;
    ctx.fillText(String(s.scoreAllies), cx - 46, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = ENEMY;
    ctx.fillText(String(s.scoreEnemies), cx + 46, y);

    ctx.font = F(600, 10, '');
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(210,225,240,0.45)';
    ctx.fillText('TEAM DEATHMATCH  ·  ' + s.scoreLimit, cx, y + 20);

    // Score bars.
    const bw = 90;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(cx - 44 - bw, y + 28, bw, 3);
    ctx.fillRect(cx + 44, y + 28, bw, 3);
    ctx.fillStyle = ALLY;
    const fa = clamp(s.scoreAllies / s.scoreLimit, 0, 1);
    ctx.fillRect(cx - 44 - bw * fa, y + 28, bw * fa, 3);
    ctx.fillStyle = ENEMY;
    ctx.fillRect(cx + 44, y + 28, bw * clamp(s.scoreEnemies / s.scoreLimit, 0, 1), 3);
  }

  _killfeed(ctx, w, h) {
    const x = w - 26, y0 = 100;
    ctx.textAlign = 'right';
    ctx.font = F(600, 13, '');
    for (let i = 0; i < this.killfeed.length; i++) {
      const k = this.killfeed[i];
      const fade = k.t > 5 ? 1 - (k.t - 5) : 1;
      const slide = smoothstep(0, 0.18, k.t);
      const y = y0 + i * 23;
      ctx.save();
      ctx.globalAlpha = clamp(fade, 0, 1);
      ctx.translate((1 - slide) * 40, 0);
      const vw = ctx.measureText(k.victim).width;
      const kw = ctx.measureText(k.killer).width;
      const icon = 26;
      const totalW = vw + kw + icon + 18;
      ctx.fillStyle = k.isPlayer ? 'rgba(255,194,51,0.16)' : 'rgba(4,8,12,0.48)';
      ctx.fillRect(x - totalW - 8, y - 10, totalW + 12, 20);
      if (k.isPlayer) { ctx.strokeStyle = 'rgba(255,194,51,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(x - totalW - 8, y - 10, totalW + 12, 20); }
      ctx.fillStyle = ENEMY;
      ctx.fillText(k.victim, x, y);
      ctx.fillStyle = 'rgba(220,232,244,0.55)';
      ctx.fillText(k.headshot ? '⌖' : '»', x - vw - 10, y);
      ctx.fillStyle = k.isPlayer ? ACCENT : ALLY;
      ctx.fillText(k.killer, x - vw - icon - 6, y);
      ctx.restore();
    }
  }

  _popups(ctx, w, h) {
    const cx = w / 2;
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const k = p.t / 1.6;
      const a = 1 - smoothstep(0.55, 1, k);
      const rise = smoothstep(0, 0.35, k) * 26;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = F(700, 24, '');
      ctx.fillStyle = p.color;
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6;
      ctx.fillText(p.text, cx, h * 0.34 - rise);
      if (p.sub) {
        ctx.font = F(600, 13, '');
        ctx.fillStyle = 'rgba(235,244,252,0.75)';
        ctx.fillText(p.sub, cx, h * 0.34 - rise + 20);
      }
      ctx.restore();
    }
  }

  _streaks(ctx, w, h, s) {
    const x = 26, y = h - 76;
    ctx.textAlign = 'left';
    ctx.font = F(700, 12, '');
    ctx.fillStyle = 'rgba(210,225,240,0.5)';
    ctx.fillText('STREAK  ' + s.streak, x, y - 16);
    const items = s.streakRewards;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const bx = x + i * 78;
      const ready = it.ready;
      ctx.fillStyle = ready ? 'rgba(255,194,51,0.18)' : 'rgba(255,255,255,0.06)';
      ctx.fillRect(bx, y, 70, 26);
      ctx.strokeStyle = ready ? ACCENT : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, y + 0.5, 69, 25);
      ctx.fillStyle = ready ? ACCENT : 'rgba(220,232,244,0.35)';
      ctx.font = F(700, 11, '');
      ctx.fillText(it.name, bx + 7, y + 10);
      ctx.font = F(500, 9, '');
      ctx.fillStyle = ready ? 'rgba(255,220,140,0.85)' : 'rgba(220,232,244,0.28)';
      ctx.fillText(ready ? it.key : s.streak + '/' + it.at, bx + 7, y + 20);
    }
  }

  _deathScreen(ctx, w, h, s) {
    ctx.fillStyle = 'rgba(10,4,3,0.42)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.font = F(700, 44, '');
    ctx.fillStyle = 'rgba(255,60,45,0.95)';
    ctx.fillText('YOU WERE KILLED', w / 2, h * 0.36);
    ctx.font = F(600, 18, '');
    ctx.fillStyle = 'rgba(235,244,252,0.85)';
    ctx.fillText('BY  ' + s.killerName, w / 2, h * 0.36 + 34);
    ctx.font = F(600, 14, '');
    ctx.fillStyle = 'rgba(235,244,252,0.55)';
    ctx.fillText('RESPAWN IN  ' + Math.ceil(s.respawnIn), w / 2, h * 0.36 + 62);
    const bw = 200, bx = w / 2 - bw / 2, by = h * 0.36 + 76;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(bx, by, bw, 4);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(bx, by, bw * (1 - clamp(s.respawnIn / s.respawnTotal, 0, 1)), 4);
  }

  _banner(ctx, w, h) {
    const b = this.banner;
    const k = b.t / b.dur;
    const a = smoothstep(0, 0.12, k) * (1 - smoothstep(0.78, 1, k));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.font = F(700, 34, '');
    ctx.fillStyle = ACCENT;
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10;
    ctx.fillText(b.title, w / 2, h * 0.24);
    if (b.sub) {
      ctx.font = F(600, 15, '');
      ctx.fillStyle = 'rgba(235,244,252,0.8)';
      ctx.fillText(b.sub, w / 2, h * 0.24 + 26);
    }
    ctx.restore();
  }
}
