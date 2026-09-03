# Material And Lighting Realism

Use this reference whenever the model silhouette is acceptable but the render still looks unlike the source image.

## Common Failure Pattern

A procedural object often fails after the shape pass because the render has:

- one flat albedo color per material
- no roughness variation or cavity response
- no normal/bump/displacement response on surfaces that should be tactile
- missing local overrides such as moss, stains, edge wear, dirt, sap, rust, dust, scorch, or faded zones
- lighting that is only ambient or too evenly exposed
- weak contact shadows, no rim separation, and no tone mapping/exposure target

Treat this as a `LookDev Reset`, not a geometry problem.

## Lookdev Material Requirements

Before accepting `lookdev`, the spec must contain:

- an assessed `surfaceDescriptor` for every important material: `rigidity` (`rigid`, `semi-rigid`, `flexible`, or `soft`), optical `finish` (`mirror`, `glossy`, `satin`, or `matte`), and `microRelief` (`smooth`, `grain`, `pebbled`, `wrinkled`, `fibrous`, `pitted`, `brushed`, or `custom`) with its executable `none|normal|bump|displacement` channel. Each claim records `basis: observed|inferred` and confidence; the descriptor records `evidenceRefs`.
- `albedo` palette: dominant, secondary, accent colors, and where they appear on the object.
- `roughness` response: base value, variation, and local response such as smoother worn edges or rougher cavities.
- tactile response: for visibly tactile surfaces, at least one of `normal`, `bump`, or `displacement` with scale/amplitude/strength; an evidenced smooth surface explicitly uses `microRelief.channel: none`.
- locality: `localOverrides`, dirt, wear, scratches, chips, stains, moss, patina, wetness, soot, or cavity masks tied to `viewEvidence`.
- material-specific behavior: alpha/transmission/translucency for thin or transparent parts, metalness/clearcoat for reflective parts, cloth/fiber grain for fabric-like parts.
- explicit special response: select `materialProfile` only when `cloth`, `fiber`, `glass`, `liquid`, or `volume` behavior is needed; omitted profiles stay on the standard material path.
- independent PBR channels: every channel that is present must be generated or authored independently; never reuse albedo as a roughness, height, normal, or AO map. Omit an unsupported channel instead of fabricating it, then use an evidence-backed scalar or an explicit smooth/unlit rule.
- reference-derived PBR extraction: for `reference-fidelity`, crop one material region and run:

  ```bash
  python3 <plugin-root>/scripts/sculpt.py pbr /absolute/path/material-crop.png \
    --out-dir /absolute/path/pbr-output \
    --material-id <material-id> \
    --material-crop-confirmed \
    --url-prefix <project-url-prefix>
  ```

  Never patch from a full UI/demo screenshot. Respect each channel's eligibility; below the configured suitability target, stop, omit unsafe channels, use an authored fallback, or request better material evidence.
- scale hierarchy: close-up materials must describe macro, meso, and micro surface-frequency bands with object-relative frequency and amplitude.
- projection/UV intent: use emitted `textureProjection.mode` values `uv`, `planar`, `cylindrical`, or `spherical`; `uv` preserves authored UVs. Set `axis` to `x`, `y`, or `z` when observable, otherwise let the generator infer it from effective scaled dimensions. State repeat/texel-density intent, and do not describe these modes as triplanar blending.
- quality-first resolution: use at least 1024px procedural maps for important close-up materials and prefer 2048px when reference fidelity is the priority.
- runtime/offline split: author important 2048px reference maps offline with material masks and tile-safe borders; keep runtime procedural fallback bounded so map generation does not stall the browser.
- geometric relief: if a ridge, crack, seam, chip, bark plate, fold, or dent affects the visible silhouette, represent it with geometry or displacement-capable topology instead of texture alone.

Do not accept "brown bark", "gold leaves", "dark metal", or "rough stone" as sufficient. Translate it into PBR terms: albedo palette, roughness, normal/bump, AO, dirt/wear, and local masks.

Do not conflate material axes. `rigid` describes physical/deformation behavior, `matte` or `glossy` describes optical roughness, and `smooth`, `wrinkled`, or `pebbled` describes geometric or normal-scale relief. For example, rigid painted metal can be matte and smooth; flexible rubber can be glossy and pebbled. The validator rejects an assessed descriptor when its numeric roughness or relief channel contradicts the declared surface.

Do not claim exact PBR recovery from a single image. Pixels include baked lighting, exposure, shadow, view angle, and camera response. Treat extracted maps as reference-derived material evidence that still needs neutral/grazing/reference screenshot review.

## Texture Source And ImageGen Fallback

Choose one explicit source for the active texture set:

- `procedural`: bounded generated fields for regular or parameterizable surfaces.
- `reference-extracted`: confirmed source-material pixels, represented by the legacy-compatible `referencePbr` path or a texture set with per-channel eligibility.
- `imagegen-authored`: an offline project-local texture created when irregular, hand-painted, ornamental, organic, distressed, or fantasy appearance is impractical to encode procedurally.
- `external-authored`: a user-supplied project-local texture with traceable provenance.

ImageGen texture authoring is a Lookdev fallback, distinct from ImageGen reference preparation. A prepared object image may become `sourceImage`; an authored material swatch never does. `sourceImage` remains the sole reconstruction and acceptance authority.

For an `imagegen-authored` texture:

- use the `imagegen` skill in built-in mode unless its own fallback rules require otherwise;
- request a square front-on material swatch with flat neutral illumination, no perspective, object edges, cast shadows, directional highlights, text, or watermark;
- request seamless borders only when the target projection repeats;
- copy the selected output into the project workspace and record its browser URL, final prompt, SHA-256, and evidence refs;
- use the output as albedo by default. Do not ask separate ImageGen calls to invent roughness, height, normal, AO, or metalness and assume they are aligned; author those channels independently or use evidence-backed scalar response;
- record `authoringChecks.flatNeutralLighting`, `bakedLightingFree`, and `seamChecked` when repetition applies.

The runtime marks loaded channels `pending`, `ready`, or `error` and exposes a `materialReady` promise. Lookdev cannot pass on `error`, before loading settles, or when the selected style treatment was silently replaced by generic PBR. Use the existing disposal hook; do not regenerate ImageGen assets during builds or browser runtime.

An executable `localOverrides` entry needs `id`, a supported surface `type`, `amount`, `color`, at least one `evidenceRefs` id, and a `mask` with `pattern` (`noise`, `cavity`, `edge`, `vertical`, `speckle`, or `streak`). Use paired `mask.uvCenter`/`uvScale` plus `feather` when evidence confines the effect to one UV region. Optional `roughnessDelta`, `metalnessDelta`, and `heightDelta` alter independent map channels. Put scratches and chips here as `scratch`/`chip` layers; descriptive arrays alone do not change the shader. A `material-map-evidence` entry is provenance only and must never count as an applied dirt/wear layer.

Use `rust` or `oxide` for observed corrosion and `patina` for an observed
weathered surface film. Their defaults make the affected region rougher and
less metallic, but explicit evidence-backed channel deltas remain authoritative.

Use `specularIntensity`, `specularColor`, and `envMapIntensity` to control dielectric reflection strength independently from roughness. These values are authored estimates unless multi-light or measured material evidence is available.

Do not accept a material merely because all required fields are present. The browser render must prove that:

- roughness breaks highlights independently from albedo color
- normal/height detail remains readable under grazing light
- cavities and contacts have coherent AO rather than uniformly dark noise
- referencePbr maps, when present, are loaded by the generated Three.js material and have confidence at or above the configured threshold
- micro detail does not visibly tile or swim when the object is scaled
- local overrides appear in the same regions supported by `viewEvidence`
- color distribution, edge/detail density, and highlight coverage/energy are not grossly inconsistent with the reference diagnostics

## Lookdev Lighting Requirements

The same `lookdev` review must also contain:

- key light direction, color temperature, intensity, and shadow softness
- fill light color/intensity, or explicit reason for no fill
- rim/back light or environment reflection cue when the silhouette needs separation
- ambient/hemisphere/environment color
- exposure and tone-mapping intent
- background color or gradient
- contact shadow / ground shadow behavior

For generated review scenes, install the exported look-dev environment helper.
It accepts an equirectangular source and otherwise creates a bounded procedural
studio PMREM. Dispose its cleanup function when the scene is removed.

Separate object material from photo lighting: a material should still read correctly in neutral turntable lighting, then a reference-matching lighting setup can be added.

## Screenshot Review

For material and lighting screenshots, compare in this order:

1. Albedo palette: are dominant and accent colors close to the reference?
2. Value range: are dark cavities and bright highlights in the right places?
3. Surface response: does roughness/normal/bump catch light?
4. Locality: are moss, stains, dirt, wear, chips, or color patches placed where the reference shows them?
5. Light structure: can you identify key, fill, rim/environment, contact shadow, and exposure?
6. Material-vs-light split: if the scene is relit neutrally, does the object still have believable material detail?

For quality-first work, capture three deliberate look-dev views before choosing `continue`:

1. `neutral`: broad soft key/fill lighting for honest albedo and form reading.
2. `grazing`: a low-angle hard or semi-hard key close-up that exposes smooth-plastic highlights, weak normals, uniform roughness, and texture tiling.
3. `reference-match`: the source camera and lighting direction as closely as the available evidence allows.

A material that only looks convincing in the reference-matched light has not passed. Fix its PBR response first, then tune the reference lighting.

If the mismatch is mostly color/texture/lighting, choose `refine-code` only when the spec already has the above details. Otherwise choose `refine-spec` first.
