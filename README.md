# Strata

A browser app for designing laser-cut plate + cast-concrete sculptures. Curved, sculptural
forms become clean, flat, laser-ready plates (every edge cut at 90°) plus CNC plywood moulds
for the concrete, all driven by one live parameter graph.

```
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build    # static site in dist/
```

## What it does

- **Parameter graph.** Every dimension is a named parameter; any value can be an expression
  that links to others (`pitch = thickness * 2`, `plateCount = floor(stackLength / pitch)`).
  Changing a value re-runs only the pipeline stages downstream of it. Lock / randomise, seeded
  noise, presets, saved variants, side-by-side compare, undo / redo.
- **Slicer.** Parallel, radial or waffle (interlocking half-depth slots with kerf allowance).
  Slice the eroded-strata block or any form (fin, cone, cylinder, box, loft, revolve, extrude,
  imported STL/OBJ). Each plate is a 2D section extruded straight through.
- **Cavities in 2D.** The insert is sectioned at each plate's front, back and mid planes; the
  cavity is the larger (or smaller, or mid) section plus a fit clearance. The bevel a 3D boolean
  would have left is reported, and insert collisions are flagged.
- **Erosion.** Layered noise with amplitude, wavelength, octaves, roughness, banding (strata
  terraces), neighbour follow, crest and slope.
- **Image-driven plates.** Top surface impression (each plate's top edge is cut down where its
  strip of the image is dark, so the picture reads looking down on the stack; carve or raise,
  stepped or smooth, flat terraces or following the strata, turnable; tone / pillow / balloon /
  chamfer profiles so a flat PNG silhouette inflates from its edges; cut-edge smoothing; fit the
  stack to the image proportions; a 3D relief preview with a tilt slider and a "gentle impression"
  shuffle); front face as layered cut-outs whose
  depth follows darkness, halftone holes, and etched hatch / contour lines; side profile (image as
  overall plate height, or traced silhouette) mixed with the strata.
- **Edges and size.** Strata flow (low-pass of the eroded top line) and round-all-corners
  smoothing that leaves the insert cavity, anchor holes and slots crisp. Master size scales the
  whole piece, including plate count and thickness, while tolerances and stock sizes stay real.
- **Base and support.** Chamfered base corners and top edge (cut into every mould ring, with a
  chamfer strip note for the top edge). An optional radial support ring cut from the same sheet is
  cast into the concrete at a set depth; each plate drops a tenon through a slot in it, so the
  stack keeps its spacing and angles.
- **Unfold.** Unrolls cylinders, cones, straight lofts and fins into flat patterns; faceted
  versions get bend lines with K-factor bend allowance. Double-curved forms are detected by the
  stretch they would need.
- **Moulds + pour.** Stacked plywood rings (split in halves to release) with draft, dowels and
  clamp tabs, a floor board and a plate jig; a stepped mould for a concrete insert; a strata pour
  plan with tinted bands previewed in 3D (plain / layers / sanded back).
- **Fabrication output.** Per-plate DXF (R12: closed polylines with true arcs, or LINE + ARC),
  nested sheet DXFs, CUT / ETCH / BEND layers, kerf compensation, etched part numbers in a
  single-stroke font, mould DXF/SVG/STL, model STL, cut list CSV, pour plan, and the project
  JSON — all in one ZIP.
- **Fit checks.** Thin material below the minimum feature, gaps narrower than the kerf, parts
  too small or too big for the sheet, islands that would fall out, pieces that don't reach the
  concrete, holes smaller than the sheet thickness, insert collisions.

The project saves as one readable JSON file (parameters, pour plan, images, imported meshes,
variants). Exports are always regenerated from the parameters.

STEP import isn't supported yet (it needs a CAD kernel); export STL in mm from Fusion instead.

## Code map

- `src/core/` — the engine (no UI): `params.ts` + `expr.ts` (graph), `forms.ts`, `section.ts`
  (mesh-plane sections), `heightfield.ts`, `image.ts`, `slicer.ts`, `checks.ts`, `arcs.ts` +
  `dxf.ts`, `nest.ts`, `mould.ts`, `unfold.ts`, `bom.ts`, `pipeline.ts`, `exporters.ts`.
- `src/ui/` — React + React Three Fiber views.
- `test/` — vitest tests for the engine, including a DXF round trip that reads the exported files
  back (bulges, LINE, ARC) and checks them against the true outlines.
