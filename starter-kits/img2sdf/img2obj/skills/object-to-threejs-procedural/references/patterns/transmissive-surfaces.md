# Glass, Liquid, and Transmissive Surface Patterns

Load this reference only for glass, transparent plastic, lenses, liquid,
crystal, clear display covers, or visibly translucent volumes.

## Form routing

- preserve the outer silhouette and visible wall thickness;
- distinguish a thin sheet from a closed volume;
- give liquid a container/contact relationship, fill boundary, and meniscus or
  free surface only when visible;
- separate transparent cover, interior object, frame, and emissive display when
  they are constructionally distinct;
- avoid coplanar transparent layers and accidental self-intersections.

Use existing components, `dimensions`, `geometryDescriptor`, attachments and
topology groups. Thickness values are in component/mesh space and must be
consistent with modeled scale.

## Lookdev routing

Use `materialProfile: "glass"` or `"liquid"` only when supported by the observed
surface. Set transmission, IOR, thickness, attenuation, roughness, dispersion
and environment response from evidence. With non-zero transmission, keep
opacity at one; generic transparent blending is a different effect.

An environment map/credible reflected environment is strongly recommended for
physical materials. It improves reflection/refraction but does not make a wrong
shape correct. Avoid clearcoat when the transmission model already represents
the visible boundary unless a separate coating is actually observed.

Do not assign universal IOR/thickness presets to unknown materials. Record a
bounded assumption when material class is uncertain.

## Review

Check silhouette, double images, sorting, background distortion, interior
visibility, contact and scale under at least one non-flat environment. Reject
black/dead glass, invisible boundaries, opaque-looking transmission, excessive
chromatic effects, implausible liquid volume, or reflection intensity used to
hide missing interior geometry.
