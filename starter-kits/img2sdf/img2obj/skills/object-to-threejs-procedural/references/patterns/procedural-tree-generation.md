# Procedural Tree Generation

Load this pattern only when a whole static tree needs an automatic first Form
construction. For an already decomposed plant, use `vegetation.md` directly.

## Authoring contract

The generator is a one-shot authoring tool, not a new primitive or live tree
system. It runs only on a monolithic schema 3.x spec whose Form input still has
one root component and no repetition systems. It always writes a separate
challenger.

```bash
python3 scripts/sculpt.py tree object-sculpt.json \
  --recipe tree-recipe.json \
  --wood-material bark \
  --foliage-material leaves \
  --out object-tree.challenger.json
```

Minimal recipe:

```json
{
  "version": 1,
  "kind": "broadleaf",
  "seed": 42,
  "height": 4.0,
  "trunkRadius": 0.2,
  "crownRadius": 1.45,
  "crownStartRatio": 0.32,
  "branchLevels": 2,
  "branchCount": 10,
  "rootCount": 5,
  "foliageCount": 640,
  "irregularity": 0.18,
  "lean": [0.0, 0.0]
}
```

Omitted numeric fields use bounded profile defaults. Unknown fields and values
outside the executable limits fail closed. The same normalized recipe and seed
must produce identical nodes and instance transforms.

Use `majorBranchAnchors` only for silhouette-defining branches proven by the
reference. Each anchor declares semantic `id`, `heightRatio`, `azimuth`,
`elevation`, and `lengthRatio`. Anchored primary geometry remains stable when
the seed changes; unanchored growth supplies controlled variation.

## Profiles and output

- `broadleaf`: ellipsoidal crown envelope, golden-angle primary placement,
  upward forks, and foliage concentrated near terminal twigs;
- `conifer`: dominant leader, four-branch whorls, narrowing upper envelope,
  mild droop, and foliage sprays distributed along distal branches.

Both compile to existing canonical fields:

- root `branch-network` for roots, trunk, branches, taper, and curvature;
- child `instanced-cluster` of compact authored `extrude` leaf or needle-spray
  contours, avoiding a dependency on rectangular alpha cards;
- `assembled-solid` topology, planned detail coverage, review/build-pass refs,
  and one bounded hidden-growth assumption.

After expansion, edit the emitted components directly. Never rerun the recipe
over an authored hierarchy or use regeneration to erase manual corrections.
Because the expansion changes macro silhouette, its challenger normally needs
a fresh Blockout visual gate before Form continues.

## Boundaries and vetoes

This route targets stylized or standard static trees. It does not claim exact
species biology, inferred hidden accuracy, wind, seasons, per-needle conifers,
collision pruning, or automatic LOD. `branch-network` overlaps tubes and
junctions; a hero close-up requiring welded crotches is a separate topology
capability gap.

Reject the challenger when roots float, the leader is unclear, signature
branches disagree with the reference, crown width/centroid fails front or side
views, foliage is detached, or repeated contours visibly stamp one pattern.
