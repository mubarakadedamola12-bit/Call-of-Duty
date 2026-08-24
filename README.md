# OPERATION BLACKOUT — *Scrapyard*

A Call of Duty–inspired first-person shooter that runs in the browser. Written
from scratch in JavaScript on raw **WebGL2** — no game engine, no 3D library, no
binary assets. Every texture, mesh, sound and animation is generated at runtime.

```bash
python3 -m http.server 8124
```

Then open <http://localhost:8124> and click **DEPLOY**. Any static file server
works; ES modules need HTTP, so opening `index.html` straight from disk will
not.

Runs on desktop (mouse + keyboard) and on **Android / iOS** with touch controls.
Needs WebGL2, which means iOS 15+ or any current Android browser. To play on
your phone, serve on your LAN and open the machine's IP from the device:

```bash
python3 -m http.server 8124 --bind 0.0.0.0
```

Append `?touch=1` to any URL to force the mobile build — useful for checking the
touch layout from a desktop browser.

---

## What the research fed into

The design follows the conventions modern Call of Duty is built on:

* **Three-lane map.** Scrapyard runs a left container corridor, an open central
  pad around a climbable derrick, and a right-hand warehouse, cross-connected at
  three points so every push has an answer.
* **No hipfire bloom.** Accuracy is a pure function of recoil, stance and
  movement — never hidden randomness. Every weapon has a learnable recoil
  pattern with only a small stochastic component.
* **TTK-first weapon tuning.** The AR and SMG both kill in ~250 ms; the sniper
  is a one-shot to the upper body; the shotgun is lethal inside ~7 m and falls
  off a cliff after that.
* **ADS trade-offs.** Faster handling means less range and control, and the
  sight picture scales with your FOV setting rather than forcing a hard zoom.
* **Killstreaks** at 3 (UAV) and 5 (Precision Airstrike).

Sources: [Modern Warfare 4 multiplayer systems](https://www.callofduty.com/blog/2026/08/call-of-duty-modern-warfare-4-next-highlights-multiplayer-gameplay-systems) ·
[Making of Call of Duty maps](https://devotedstudios.com/the-making-of-call-of-duty-maps-a-behind-the-scenes-look/) ·
[Game engine mechanics / TTK](https://callofduty.fandom.com/wiki/Game_Engine/Mechanics) ·
[ADS explained](https://hone.gg/blog/ads-in-call-of-duty/)

---

## Controls

### Touch (phone / tablet)

| Input | Action |
|---|---|
| Left half | Floating stick — drag to move, analog, so a half-push walks |
| Push the stick fully forward | Sprint · flick it forward twice for tactical sprint |
| Right half | Drag to look |
| **FIRE** | Hold to shoot — **keep sliding your thumb off it to aim while firing** |
| **ADS** | Aim down sights (also draggable) |
| **CROUCH** | Tap to toggle · tap while sprinting to slide |
| **JUMP** | Jump · into a ledge to mantle |
| **RELOAD / FRAG / SWAP** | As labelled |
| **▲ / ✈** | UAV / Airstrike |
| **⏸** | Pause |

The game gates itself behind a rotate-to-landscape screen, requests fullscreen
and a landscape orientation lock on deploy (both best-effort — iPhone Safari
grants neither), and lays the HUD out inside `env(safe-area-inset-*)` so nothing
hides under a notch or the home indicator.

### Keyboard + mouse

| Input | Action |
|---|---|
| `W A S D` **or** `↑ ← ↓ →` | Move |
| `Shift` | Sprint · double-tap for tactical sprint |
| `Ctrl` / `C` | Crouch — tap to toggle, hold to stay down |
| `Shift` + `C` | Slide · jump out of it to keep your speed |
| `Space` | Jump · into a ledge to mantle over it |
| `LMB` / `RMB` | Fire / aim down sights |
| `R` · `G` · `F` | Reload · frag · inspect weapon |
| `1` `2` / `Q` | Swap weapon |
| `4` `5` | Deploy UAV / Airstrike |
| `Esc` | Pause |

## Movement model

Acceleration is Quake-lineage rather than a naive lerp — friction plus
*accelerate toward the wish direction*. Projecting current velocity onto the
input direction is what makes momentum feel real, and it is what lets you steer
a slide or air-strafe instead of simply overwriting your velocity.

* Directional speed: full forward, ×0.88 strafing, ×0.76 backpedalling.
* Diagonals are normalised — no diagonal speed bonus.
* **Coyote time** (0.12 s) and **jump buffering** (0.16 s).
* **Ground snapping** so walking down steps doesn't launch you into a one-frame
  fall, which reads as a stutter and desyncs the footstep cadence.
* **Mantling** for ledges between 0.3 m and 1.6 m, with a clearance test on the
  far side. A normal jump clears ~1.03 m, so mantling meaningfully extends your
  reach without making everything climbable.
* **Slide** requires real speed, steers slightly, and can be jump-cancelled to
  carry the momentum out of it.
* **Sprint-to-fire delay** of 0.15 s; aiming or firing drops sprint instantly.

Touch feeds the same code path: the stick writes an analog axis that the
keyboard adds into, and the buttons synthesise the same key codes, so there is
no separate mobile controller to keep in sync.

## Aim assist

A thumb cannot track a strafing target the way a mouse can, so touch enables the
two-part assist console shooters use — both scaled by how centred the target
already is, so it never takes the shot for you:

* **Slowdown** — look sensitivity drops to 40% while the reticle is on a target,
  which makes it easy to stop on them.
* **Magnetism** — the view is nudged toward the target, but only while you are
  actually firing or aiming.

It defaults to 85% on touch and **off** on desktop, and there's a slider for it
on the briefing screen either way.

---

## Rendering pipeline

A deferred renderer, built pass by pass:

```
shadow (2 cascades) → G-buffer (+decals) → depth blit → SSAO + bilateral blur
  → deferred PBR resolve (+analytic sky, height fog) → forward FX (tracers,
  particles) → bloom pyramid → tonemap/grade → FXAA → screen
```

* **G-buffer** — albedo + baked AO, world normal + roughness, emissive +
  metallic, 32F depth.
* **Shading** — Cook-Torrance GGX with Smith visibility, Karis' analytic
  environment BRDF, and an ambient/specular IBL sampled from the same analytic
  sky function the skybox uses.
* **Shadows** — two cascades (a tight one snapped ahead of the player, one for
  the arena), 8-tap spiral PCF jittered by Interleaved Gradient Noise, with
  **normal-offset bias** derived from the *geometric* normal rather than the
  normal-mapped one.
* **SSAO** — half-res 16-sample hemisphere with a depth-aware bilateral blur.
* **Bloom** — the pyramidal down/upsample from the Call of Duty: Advanced
  Warfare talk: Karis-weighted prefilter, 13-tap downsample, 3×3 tent upsample,
  blended progressively so the pyramid stays energy-neutral.
* **Grade** — ACES filmic (Hill fit), lift/gain/contrast/saturation, vignette,
  chromatic aberration, film grain, and ordered dithering to kill banding.
* Radial sprint blur, peripheral ADS blur, damage and low-health grading.

Everything draws from 2 texture arrays and ~20 batched meshes; a typical frame
is ~300 draw calls at ~1.3 ms of GPU work at 2880×1720.

## Procedural content

* **Materials** — 14 PBR materials (sand, concrete, shipping container,
  corrugated steel, wood, gunmetal, polymer, sandbag, rusted barrel, asphalt,
  fatigues, brick, tarp, dirty glass) generated at 512² from tileable Perlin and
  Worley noise, with normal maps sobel-derived from a height channel, and albedo
  written in sRGB so the sampler decodes back to the authored linear value.
* **Map** — geometry, collision (Y-rotated OBBs), the nav grid, spawn points and
  cover positions all come out of one seeded layout script.
* **Weapons** — five weapons modelled from primitives in gun-local space, with
  the optic placed so that aiming down sights is a pure translation.
* **Audio** — every sound is synthesised. Gunshots are a filtered noise
  transient plus a pitch-dropping body plus an environment tail, run through a
  procedurally generated convolution reverb.

## Bots

Nine bots (4 allies, 5 enemies) with perception (FOV + line of sight + reaction
time), A* over a baked nav grid with a step-height gate, preferred engagement
ranges per weapon class, strafing, burst discipline, and aim error that starts
wide on acquisition and converges as they settle.

## Layout

```
index.html          shell + briefing screen
styles.css
src/main.js         bootstrap, settings, frame loop
src/core/           math · WebGL2 wrapper · input · touch controls · procedural audio
src/render/         renderer · shaders (GLSL) · procedural materials · geometry
src/game/           world · game rules · actors/AI · weapons · viewmodel · fx · hud
```

## Quality tiers

Detected automatically (mobile → `low`) and overridable on the briefing screen.
Shadow resolution and SSAO are the first things a phone GPU cannot afford:

| | shadows | SSAO | bloom mips | bots |
|---|---|---|---|---|
| **low** | 1024² | off | 4 | 5 |
| **medium** | 1536² | 10 samples | 5 | 7 |
| **high** | 2048² | 16 samples | 6 | 9 |

Mobile also starts at a 0.65 resolution scale and a wider 85° FOV.

## Settings

Quality, resolution scale, FOV, film grain, sensitivity, aim assist and volume
live on the briefing screen and persist to `localStorage`. Drop the resolution
scale first if you need more frames.

## Layout note

`src/core/touch.js` owns the on-screen control layout and hit testing; the HUD
draws from the same objects, so the buttons you see and the buttons you can
press can never drift apart.
