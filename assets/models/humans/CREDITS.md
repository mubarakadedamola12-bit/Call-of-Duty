# Background Posed Humans

**Source:** Quaternius — *Background Posed Humans* pack
**Licence:** CC0 1.0 (public domain dedication) — no attribution required, but
credited here because it is the decent thing to do.
**Site:** https://quaternius.com

20 static posed figures, converted from the pack's OBJ set to glTF 2.0 binary
(`.glb`). Roughly 1,300 triangles each, four flat-coloured material groups per
model (hair, footwear, clothing, skin) and no image textures.

## What these are, and are not

These are **static, unrigged** meshes — `skins: 0`, `animations: 0`, and no
`JOINTS_0` / `WEIGHTS_0` vertex attributes. The pose is baked into the geometry.

That means they **cannot** be used for the player or the AI soldiers: with no
skeleton there is nothing to animate, so a figure would slide around the map
frozen in one pose. The soldiers use the purpose-built skinned rig in
`src/game/soldier.js` instead.

Here they serve as scenery — civilians on rooftops and beyond the wire — baked
into the world's static geometry so the whole crowd costs one draw call.

## Adding your own models

Drop a `.glb` into this folder and add its filename (without extension) to
`HUMAN_MODELS` in `src/game/humans.js`. The loader
(`src/render/gltf.js`) handles glTF 2.0 with POSITION / NORMAL / TEXCOORD_0 and
indices, node-hierarchy transforms, and `pbrMetallicRoughness` factors.

Not yet supported, and what it would take:
- **Image textures** — the renderer samples a procedural texture array, so an
  imported model's `baseColorTexture` needs a second material path.
- **Skinning** — the vertex format and bone palette exist (see
  `src/render/skinning.js`), but the loader does not yet read `skins`,
  `JOINTS_0` / `WEIGHTS_0` or animation samplers. This is the piece to build if
  you bring in a rigged character.
