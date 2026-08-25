# OPERATION BLACKOUT

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

## Battlegrounds

Three maps, selectable in Settings → Gameplay (applies on the next match):

| | | |
|---|---|---|
| **SCRAPYARD** | Desert container yard, golden hour | Three lanes: a container corridor, an open pad with a climbable derrick, a warehouse |
| **BLACKSITE** | Night refinery, floodlit | Storage tanks and overhead pipe racks; long lanes, blind crossings, pools of light |
| **DUSTBOWL** | Ruined village, high noon | Adobe shells with doorways — a warren of corners and short sightlines |

Each map owns an atmosphere preset (sun angle and colour, ambient, fog, cloud
cover, sky gradient, exposure, grade) applied wholesale to the renderer. The
same geometry under a different sky reads as a different place, so this is
doing as much work as the layouts are.

## Characters

Soldiers are a single skinned mesh over a 19-bone rig, not a stack of
primitives. The body is lofted through elliptical cross-sections — bodies are
wider than they are deep, and a chest that is 1.5× wider than it is thick is
most of what sells a silhouette as human. Vertices are weighted across two
bones at every joint, so elbows and knees bend instead of coming apart.

Proportions are a ~1.78 m adult at roughly 7.4 heads tall. Anatomy that
mattered: a deltoid bulge so the shoulder is not a pipe in a socket, a calf
belly above a thin ankle, a jaw so the head is not a ball, and gear (plate
carrier, pouches, pack, helmet) as separate volumes sitting proud of the body.

Skinning also cut the cost: one draw call per soldier instead of 28.

**Ceiling worth stating plainly:** this is a stylised human, not a photoreal
one. Photoreal characters need scanned geometry and authored albedo/normal/
roughness maps — assets, not code. Everything here is generated at runtime.

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
| Right half | Drag to look — flick fast to turn fast (see below) |
| **FIRE** | Hold to shoot — **keep sliding your thumb off it to aim while firing** |
| **ADS** | Aim down sights (also draggable) |
| **CROUCH** | Tap to toggle · tap while sprinting to slide |
| **JUMP** | Jump · into a ledge to mantle |
| **RELOAD / FRAG / SWAP** | As labelled |
| **▲ / ✈** | UAV / Airstrike |
| **⏸** | Pause |

**Phones** are gated behind a rotate-to-landscape screen, since a portrait phone
has nowhere to put the controls. **Tablets play either way up** — an iPad has
room for the full layout in portrait as well as landscape. Deploy requests
fullscreen and a landscape orientation lock (both best-effort — iPhone Safari
grants neither), and the HUD lays out inside `env(safe-area-inset-*)` so nothing
hides under a notch or the home indicator.

Control sizes are tuned for a thumb, not for the screen: an iPad gets slightly
larger buttons, not proportionally larger ones, and the movement zone is capped
in absolute width so its edge never lands past thumb reach on a big display.

### Look speed

Touch look has **flick acceleration** — a slow drag stays 1:1 for tracking, and
a fast swipe scales up, so a 180 is one thumb motion rather than three:

| drag speed | turn rate | thumb travel for a 180 |
|---|---|---|
| slow (tracking) | 0.54°/px | 336 px |
| fast (flick) | 1.13°/px | 160 px |

Both the sensitivity and the acceleration amount are sliders on the briefing
screen; acceleration can be turned off entirely.

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
* **Cloud shadows** — drifting cover projected onto the world from a baked
  tileable noise map. Two texture fetches rather than ten octaves of FBM per
  pixel, which at 2.7 megapixels is the difference between free and expensive.
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
src/render/         renderer · shaders (GLSL) · materials · geometry · skinning
src/game/           world/maps · game rules · soldier rig · actors/AI · weapons
                    viewmodel · fx · hud
```

## Settings

A dedicated settings screen (from the briefing, or from pause) covering
**Graphics**, **Controls**, **Gameplay** and **Audio**. One schema in
`src/main.js` drives the DOM, the live application, persistence and reset —
adding an option means adding a row, not wiring another handler.

### Difficulty

Firefights being decided in a quarter of a second is authentic but unforgiving,
so difficulty scales *everyone's* health rather than just the player's:

| | health | damage you take | enemy skill | AR time-to-kill |
|---|---|---|---|---|
| Recruit | 190 | 55% | 42% | 583 ms |
| **Regular** (default) | **150** | **78%** | **62%** | **417 ms** |
| Hardened | 120 | 100% | 84% | 333 ms |
| Veteran | 100 | 115% | 100% | 250 ms |

Changing it mid-match rescales everyone proportionally rather than requiring a
restart.

## Performance

The frame was costing ~7.3 ms of CPU, essentially all of it in draw submission
and fill rate. Three changes account for most of the fix:

* **Fewer draw calls — ~950 to ~300.** Materials became per-vertex (a `layer`
  and `tint` in the vertex format), so a soldier is one draw per bone instead
  of one per bone *per material*, and a weapon is one draw instead of five.
* **Culling.** Every draw carries a bounding sphere; the G-buffer pass tests it
  against the view frustum and the shadow pass against each cascade's ortho box.
  The visible set is then sorted by material so the "same material as last
  draw" guard actually hits.
* **Render resolution.** A 1440×860 window at `devicePixelRatio` 2 is a
  5-megapixel deferred frame. The cap now defaults to 1.5, which with FXAA on
  top is visually near-identical for roughly half the pixels.

Plus a 60 FPS limiter (a 120 Hz panel was doing twice the work for nothing) and
a quarter-rate simulation behind the briefing screen.

**Idle throttling.** The loop used to render a full deferred frame 60 times a
second whenever the page was open — including while you read the briefing, sat
in the settings, or left a paused game and walked away. Redraw rate is now tied
to what you are actually doing:

| state | redraw rate |
|---|---|
| playing | 60 (or your frame cap) |
| briefing screen | 20 |
| paused | 6 |
| window not focused | 3 |

Input still runs every frame, so the UI stays responsive.

## Audio

Every sound builds a small node graph — gain, panner, reverb send, filters.
Those were never torn down, so each shot left roughly fifteen nodes permanently
connected to the master bus and the audio thread walked a graph that only grew.
Sustained fire could leave hundreds of live nodes, which is a good way to get
crackle and a busy CPU.

Voices are now reaped on a timer, budgeted (36 concurrent, hard ceiling 58),
and dropped by distance when the budget is tight — your own weapon and anything
within 14 m always plays, distant chatter is culled first. A limiter after the
compressor stops overlapping gunfire clipping the output. The ambient wind bed
was also cut roughly in half and rolled off higher, since a constant broadband
hiss is fatiguing over a long session.

Net: **7.3 ms → 3.7 ms** per frame on desktop, **0.7 ms** on the mobile tier.
Render resolution and the frame cap are the first two knobs in the settings if
you need more.

## Quality tiers

Detected automatically (mobile → `low`) and overridable on the briefing screen.
Shadow resolution and SSAO are the first things a phone GPU cannot afford:

| | shadows | SSAO | bloom mips | bots |
|---|---|---|---|---|
| **low** | 1024² | off | 4 | 5 |
| **medium** | 1536² | 10 samples | 5 | 7 |
| **high** | 2048² | 16 samples | 6 | 9 |

Mobile also starts at a 0.65 resolution scale and a wider 85° FOV.

Sensitivity drives both input paths from one slider and one base constant
(`Input.BASE_SENSITIVITY`), spanning 0.20×–4.50×. Everything persists to
`localStorage`.

## Layout note

`src/core/touch.js` owns the on-screen control layout and hit testing; the HUD
draws from the same objects, so the buttons you see and the buttons you can
press can never drift apart.
