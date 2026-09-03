# Procedural Landform Generation

Load this pattern only when a bounded static terrain, boulder, or cliff needs an
automatic first Form construction. Use `procedural-patterns.md` directly when
the observed landform has already been decomposed.

## Authoring contract

The generator is a one-shot authoring compiler, not a live terrain engine or a
new primitive. It runs only on a monolithic schema 3.x spec whose Form input
still has one root component and no repetition systems. It always writes a
separate challenger.

```bash
python3 scripts/sculpt.py landform object-sculpt.json \
  --recipe landform-recipe.json \
  --ground-material ground \
  --rock-material rock \
  --out object-landform.challenger.json
```

Minimal terrain recipe:

```json
{
  "version": 1,
  "kind": "terrain",
  "seed": 42,
  "size": [6.0, 1.5, 6.0],
  "profile": "ridged",
  "roughness": 0.35,
  "rockCount": 120,
  "terrainAnchors": [
    {
      "id": "main-summit",
      "type": "peak",
      "position": [0.1, -0.2],
      "radius": 0.28,
      "strength": 0.8
    }
  ]
}
```

Set `kind` to `terrain`, `boulder`, or `cliff`. Omitted values use bounded
profile defaults. Unknown, kind-incompatible, non-finite, or over-budget values
fail closed. The same normalized recipe and seed must produce identical
geometry. Declared anchors remain stable when the seed changes; only unobserved
variation may change.

## Profiles and output

- terrain profiles `rolling`, `ridged`, and `terraced` combine deterministic
  fBm/ridged noise, optional terraces, bounded thermal relaxation, edge fade,
  and reference-backed peak/valley/plateau/ridge anchors;
- boulder profiles `rounded`, `angular`, and `layered` compile connected field
  masses plus bounded strata, fractures, and surface breakup;
- cliff profiles `weathered` and `layered` compile a tall connected field mass
  with controlled horizontal strata and diagonal creases.

The compiler emits only existing canonical geometry:

- root `deformable-surface` for a bounded terrain sheet;
- root `sculpted-surface` for a closed boulder or cliff;
- child `instanced-cluster` of ellipsoids for terrain rocks, with explicit
  transforms sampled from terrain height and rejected above the slope limit.

After expansion, edit the emitted control grid, field sources/modifiers, or
instance transforms directly. Never rerun the recipe over generated or authored
geometry. Use `reshape-landform`, `redistribute-rocks`, and
`retune-earth-material` for typed corrections owned by the
`terrain-landform` capability pack.

## Phase and quality boundaries

The generator owns Form only. Earth color, wetness, moss, sediment bands,
roughness, normals, displacement, and image-authored geological textures remain
Lookdev work. Because expansion changes macro silhouette, rerun the normal
source-bound Blockout/Form visual gate before promotion.

Reject when a signature anchor disagrees with the source, terrain edges rise
unintentionally, rocks float or sink implausibly, scatter visibly stamps one
shape, a hero rock becomes blobby, strata erase the main silhouette, or the
closed field splits into islands.

This route supports bounded static landforms. True hydraulic erosion, caves or
complex overhangs, exact fracture topology, GIS data, terrain chunking,
streaming, collision LOD, and infinite worlds remain capability gaps.
