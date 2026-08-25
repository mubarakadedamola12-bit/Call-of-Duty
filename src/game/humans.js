// Background civilians, loaded from the Quaternius CC0 "Background Posed
// Humans" pack (glTF/GLB).
//
// These are *static posed* meshes with no skeleton, so they cannot stand in for
// the player or the AI — they exist as scenery. They are baked straight into
// the world's static batches, which means the whole crowd costs one draw call.

import { loadGLB, flattenGLB } from '../render/gltf.js';
import { MAT, PLAIN_ALBEDO } from '../render/textures.js';

const DIR = 'assets/models/humans/';

export const HUMAN_MODELS = [
  'male_standing', 'male_standing_hips', 'male_standing_waving',
  'male_standing_coveringeyes', 'male_lookingup', 'male_walking',
  'male_running', 'male_sitting', 'male_sitting_cheering', 'male_pickingup',
  'female_standing', 'female_standing_hips', 'female_standing_coveringeyes',
  'female_lookingup', 'female_walking', 'female_running',
  'female_sitting', 'female_sitting_cheering', 'female_pickingup',
  'woman_standing_waving',
];

/** A real adult, used to normalise the pack's arbitrary unit scale. */
const TARGET_HEIGHT = 1.78;

export class HumanLibrary {
  constructor() {
    this.models = new Map();   // name -> { prims, height, scale }
    this.scale = 1;
    this.loaded = false;
  }

  /**
   * @param onProgress fraction 0..1
   * @param names      optional subset, for cutting load time on weak devices
   */
  async load(onProgress, names = HUMAN_MODELS) {
    const results = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      try {
        const glb = await loadGLB(`${DIR}${n}.glb`);
        results.push([n, flattenGLB(glb)]);
      } catch (err) {
        // A missing model should cost that model, not the whole boot.
        console.warn(`[humans] skipped ${n}:`, err.message);
      }
      if (onProgress) onProgress((i + 1) / names.length);
    }
    if (!results.length) return this;

    // Derive one global scale from an upright reference so every figure keeps
    // the same proportions — per-model normalisation would make a crouching
    // figure as tall as a standing one.
    const ref = results.find(([n]) => n === 'male_standing')
      || results.find(([n]) => /_standing$/.test(n)) || results[0];
    this.scale = TARGET_HEIGHT / (ref[1].height || 1);

    for (const [name, geo] of results) {
      this.models.set(name, { ...geo, scale: this.scale });
    }
    this.loaded = true;
    return this;
  }

  get(name) { return this.models.get(name); }
  has(name) { return this.models.has(name); }
  names() { return [...this.models.keys()]; }
}

/**
 * Material for imported models. The tint is divided by the plain texture's
 * mean albedo so a glTF baseColorFactor lands on screen as the colour the
 * artist authored.
 */
export function humanMaterialKey() { return 'humans'; }

export function humanMaterial() {
  return {
    key: 'humans', layer: MAT.PLAIN, uvScale: [1.6, 1.6],
    tint: [1, 1, 1], rough: 1, metal: 1, normalScale: 0.9, macro: 0,
  };
}

export const tintFor = (rgb) => [
  rgb[0] / PLAIN_ALBEDO, rgb[1] / PLAIN_ALBEDO, rgb[2] / PLAIN_ALBEDO,
];
