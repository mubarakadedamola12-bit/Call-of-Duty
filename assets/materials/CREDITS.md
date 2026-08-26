# Material scans

Photogrammetry PBR scans from [ambientCG](https://ambientcg.com), released under
[CC0 1.0 Universal](https://docs.ambientcg.com/license/) (public domain).
Attribution is not required; this file records provenance anyway.

Each set is downsampled to 512×512 JPEG from the published 1K release. Only the
maps the renderer reads are kept — Color, NormalGL, Roughness, and where they
exist AmbientOcclusion and Metalness. Displacement and the DirectX-convention
normals are dropped.

| Slot | Asset | Tile |
| --- | --- | --- |
| Sand | Ground093C | 2.0 m |
| Concrete | Concrete031 | 2.0 m |
| Container | CorrugatedSteel005 | 2.4 m |
| Corrugated steel | CorrugatedSteel005 | 1.4 m |
| Wood | Wood095 | 1.5 m |
| Gunmetal | Metal038 | 0.9 m |
| Polymer | Plastic011 | 0.5 m |
| Sandbag | Fabric028 | 0.7 m |
| Rusted barrel | Metal041B | 1.0 m |
| Asphalt | Asphalt022 | 1.85 m |
| Fatigues | Fabric066 | 0.40 m |
| Brick | Bricks104 | 1.5 m |
| Mud brick | Bricks091 | 2.2 m |

Tile sizes are the real-world size of one texture repeat; `scanUV()` in
`src/render/scans.js` turns them into UV rates so nothing is guessed by eye.
