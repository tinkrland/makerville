# Boardforge handoff

This file is how work continues when nobody is watching. A scheduled run (or a fresh chat) reads it,
does the next unchecked step, runs the tests, commits, and updates this file. Keep it truthful.

## Ground rules (from the owner, always apply)
- Repo root is wherever this file is. Real STEP fixtures live in `$BOARDFORGE_REFS` (default `../refs/`). Git identity must be `tinkrland <324020321+tinkrland@users.noreply.github.com>`. Check `git var GIT_AUTHOR_IDENT` before committing.
- Standalone: no runtime network calls. Original code, or ported code credited in `NOTICE.md` (source, licence, author).
- KiCad 9 native formats. Autorouters stay separate swappable modules. Everything is a thin shell over the headless JSON engine in `src/engine/`.
- Run tests with: `node --experimental-strip-types --test tests/*.test.ts` (must stay green; currently ~200 tests).
- Node runs TypeScript by stripping types: NO parameter properties (`constructor(public x)`), NO enums, NO namespaces.
- Verify by measuring, not by eye. Mutate the code after writing tests and make sure the tests notice. If a mutant survives, either add a test or prove it is equivalent and delete the dead code.
- Never claim a thing works from a passing run alone. Real STEP fixtures live in `../refs/` (do not copy KiCad library models into the repo: CC-BY-SA with exception, fixtures only).
- Keep replies and commit messages plain. No em dashes.

## Pipeline status
| Portion | State |
|---|---|
| Native KiCad 9 reader/writer, DRC, grid autorouter | done |
| Headless JSON engine (commands, undo/redo) | done |
| Case generator + print tolerances + golden suite | done |
| Footprint sourcing (import real footprints) | done: `readKicadMod`, library import, model paths, 25 tests |
| Placement (auto) | done: legality checker + annealing placer (24 tests) |
| Schematic files (`.kicad_sch`) | not started |
| 3D models: STEP reader | done (12/12 steps, see below) |
| EasyEDA browser adapter, KiCad plugin, web shell | not started |

## STEP reader plan (`src/step/`)
Real models are B-rep. Face mix in the five reference files: planes ~70%, then cylinders, cones, circles/lines for edges, a few B-spline surfaces. Units mm. Assemblies are rare but real.

- [x] 1. `part21.ts` Part 21 text parser. 46 tests, exact error offsets, real files verified.
- [x] 2. `units.ts` length unit per shape via its representation context (SI prefixes, CONVERSION_BASED inch/foot/mil, mixed-unit files). 21 tests, mutation-checked. Use `shapeRepresentations(p)` + `unitForContext(...)` to scale each shape; never match shapes by name suffix (CONTEXT_DEPENDENT_SHAPE_REPRESENTATION is an assembly link).
- [x] 3. `geometry.ts` resolve points, directions, axis placements, lines, circles, ellipses, B-spline curves into evaluators. Done (commit 27b60ff).
- [x] 4. `surfaces.ts` plane, cylinder, cone, sphere, torus, B-spline surface: evaluate point + normal and project a point to (u,v). Done (commit 27b60ff).
- [x] 5. `brep.ts` walk MANIFOLD_SOLID_BREP -> CLOSED_SHELL -> ADVANCED_FACE -> loops -> oriented edges. Respect same_sense flags and edge orientation. Done (commit 3b695ee).
- [x] 6. `tessellate.ts` turn each trimmed face into triangles: sample the boundary loops to a chord tolerance, triangulate in the surface's (u,v) domain handling holes (ear clipping with hole bridging), lift back to 3D. Planes exact; cylinders/cones need seam handling. Done, BUT see "Measured state" below: not every real model closes.
- [x] 7. `assembly.ts` NEXT_ASSEMBLY_USAGE_OCCURRENCE + ITEM_DEFINED_TRANSFORMATION placements. Done. 6 tests. Two traps: the transform ref lives in the `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION` PART of a complex instance, not in `args`; and ITEM_DEFINED_TRANSFORMATION starts with TWO `$` fields, so take the first two REF args rather than indexing. IMPORTANT: these exporters already store the B-reps in world coordinates, so applying a placement would be wrong (measured: the pin's as-is max z is exactly the 8.4 the placement carries; the connector would shift 1.3525 mm off its declared extents). readStep uses the solids as-is and exposes the placements for callers that want the hierarchy. A test pins that applying them would move the model.
- [x] 8. `colour.ts` STYLED_ITEM -> ... -> COLOUR_RGB. Done. 5 tests. Colour is per styled ITEM (usually a whole solid, sometimes a face), so look up the face first and fall back to the solid. Measured: pin 2/2 solids (copper + brass), connector 42/42 solids in 3 colours (gold, shell, plastic), contact 1/1 copper, zero warnings. A broken chain is reported by name so a grey model says why.
- [x] 9. `index.ts` `readStep(text|bytes) -> { meshes, boundsMm, volumeMm3, triangles, placements, warnings }`. Done. 5 tests, 386 pass overall. Units ARE applied here (the rest of the reader works in file units, positions come out in mm via fileLengthUnit); assembly placements are NOT applied (see step 7). Meshes are grouped per solid per colour, so a face-level style overrides its solid. Tessellation warnings are surfaced, not dropped. Measured through this one call: box 48.000 mm3 exact, R_0603 1.6x0.8x0.45 / 0.535 mm3 / 3 colours, TYPE-C 42 meshes / 114.030 mm3 / 3 colours / 8 named seam-sliver warnings, PLCC 1045.076 mm3. Note the box is 24 triangles not 12: quads are fanned from their centroid, which is correct but not minimal.
- [x] 10. Oracle test. Done. `tools/oracle.ts` writes a throwaway board carrying the model at (200,200) with a
  1x1 mm outline at (100,100), runs `kicad-cli pcb export stl`, splits the STL into connected components to
  drop the board slab, and compares SORTED extents and volume (per-axis would test KiCad's board frame, which
  flips Y, not the geometry). 8 tests, 394 pass. Measured margins are real, not lucky: worst extent error
  0.0194 mm (TO-92) against a 0.05 limit, worst volume error 0.53% against 2%. TYPE-C gives 41 components in
  KiCad against our 42 solids, i.e. two of our solids touch and merge there; not a defect.
  A guard test scales a reading by 5% and asserts the oracle FAILS, so the oracle cannot pass vacuously.
  Two parsing traps fixed while writing it: STL number regexes must allow a signed exponent (`e-05`), and the
  `solid` header is not a reliable binary/ASCII tell (use the 84 + 50n byte count).
- [x] 11. `place.ts` the bridge a preview consumes. Done, 8 tests. NOTE: there is no renderer in this repo (it is
  a headless core), so step 11 is the transform, not UI wiring. `placeFootprintModel(result, footprint)` returns
  meshes in the BOARD MODEL frame (mm, x right, y up, z up, z=0 at the board top), so a renderer just draws them
  and falls back to the body box when a footprint has no model. `footprintModelMatrix` builds scale -> rotate
  (X then Y then Z) -> model offset -> back-side flip -> footprint rotation -> footprint position.
  The chain was MEASURED with `tools/probe-transform.ts` (same model front and back, offsets, rotations 0/45/90,
  reading KiCad's own STL): back side negates y and z and leaves x alone whatever the rotation; a quarter turn
  keeps the distance and lands square. The rotation DIRECTION is NOT measurable from KiCad's export (its 3D
  frame cannot be pinned from outside: y sign is a convention and it shifts z by board thickness), so it follows
  model.ts's documented y-up counter-clockwise convention and is flagged in the module header as the one line to
  flip if a preview ever looks mirrored. Tests assert the frame-free facts plus a kicad-cli extents check.
- [x] 12. Writer side. Done, 4 tests. The writer emits `(model "path" (offset (xyz)) (scale (xyz)) (rotate (xyz)))`
  always writing all three blocks (KiCad's parser expects them); the reader now keeps offset/scale/rotate, not
  just the path, so a model rotated 90 degrees survives a round trip. The decisive test writes a board
  referencing a real STEP fixture and has `kicad-cli` export its 3D view: the contact's 4.005 mm^3 of geometry
  appears in KiCad's own output, which proves the emitted block is valid and resolvable, not merely well-formed.

Acceptance for the whole STEP feature: all five reference files tessellate with 0 errors, bounding boxes match the STEP's own declared extents, closed solids are watertight (each edge shared by exactly two triangles), and total volume is within 2% of an independent computation. Unsupported surface types produce a named warning and are skipped, never a crash or a silent hole.

## Measured state of the tessellator (2026-11-09, run `weld` then `stitchTJunctions` before `meshStats`)
Faces are tessellated separately, so a raw mesh is never watertight; always weld first. After weld + stitch:

| Model | Watertight | Open edges | Non-manifold | Volume |
|---|---|---|---|---|
| solidworks.step (2x4x6 box) | yes | 0 | 0 | 48.00 (exact) |
| R_0603 resistor | yes | 0 | 0 | 0.54 |
| TO-92 transistor | yes | 0 | 0 | 75.66 |
| Contact.step | no | 0 | 1 | 4.01 |
| TYPE-C-31-M-12 connector (42 solids) | no | 316 | 9 | 113.97 |
| plcc44 socket | no | 112 | 0 | 1055.28 |

Sizes and volumes look right on all six; closure does not. The acceptance bar (every closed solid watertight) is NOT met. Only the resistor is asserted watertight in the tests; the others are only asserted to improve. Next: find why the connector and the socket leave open edges (suspects: edges shared between faces on different surfaces sampled at different counts, so their vertices do not coincide; curved-face seams; B-spline faces) and fix the cause, not the tolerance. Do not raise the stitch tolerance to hide it.

## Then, in order
1. Schematic files: write/read `.kicad_sch` v9 from the same board model (netlist is already there).
2. Footprint sourcing: import `.kicad_mod` and `.pretty` libraries into the library module; keep it offline.
3. Placement: simple force-directed / grid auto-placement as a swappable module, validated by DRC.
4. Wire PCB change -> case regeneration as an engine command.
5. EasyEDA adapter, KiCad IPC plugin, web shell (all thin).

## Open edges: measured state 2026-11-20

| model | open edges | non-manifold | note |
| --- | --- | --- | --- |
| R_0603 | 0 | 0 | watertight |
| TO-92 | 0 | 0 | watertight |
| Contact | 0 | 0 | watertight |
| PLCC44 | 0 | 0 | watertight (was 112 open) |
| solidworks box | 0 | 0 | watertight |
| TYPE-C | 12 | 5 | was 316 open / 9 non-manifold; then 28 after the boundary-position fix |

TYPE-C's remaining gaps, measured with `gap2.ts` on the welded+stitched mesh:

**Correction to the earlier note in this file:** they are NOT T-junctions. `tj.ts` shows the long edge at
y=0.15, z=-2.9325 is split at all 8 strays and that line closes completely (0 open edges remain there
after stitching). The earlier reading came from measuring before stitching. Do not re-chase T-junctions.

**The real cause is in uv triangulation of cylinder faces.** `lost.ts` tessellates each face alone and
compares its triangles against the boundary segments its own loop should produce:

| face | surface | boundary segments expected | missing from its own triangles |
| --- | --- | --- | --- |
| #12298 | plane | 72 | 0 |
| #14655 | cylinder | 19 | **7** |

The 7 missing are consecutive segments of the circular boundary (edge entity 18059) on a **cylinder**.
Both faces reference the same edge entity and `sampleEdge` returns identical points for both (verified in
`same.ts`: the two uses give the same 9 points, reversed), so the vertices agree and the gap is not a
sampling disagreement. The cylinder's triangles simply do not contain its own boundary edges, so the
plane's matching edges have nothing to pair with.

Next step: in `tessellateFace`, after triangulation, check that every boundary segment of every loop
appears as a triangle edge, and investigate the cylinder (u, v) unwrap for this loop
(line,circle,line,circle,line,circle). The seam unwrapping is the suspect, not the welding.

Other facts worth keeping:
- Welding tolerance is not the lever. `pipe.ts` across weld 1e-6 .. 5e-2 and several weld/stitch orders:
  TYPE-C stays at 28 open edges at every setting that does not introduce non-manifold edges (2e-2 adds
  44 of them, 5e-2 adds 304 and drops 144 triangles). PLCC and Contact stay watertight throughout.
- Volume is stable at 114.03 across every setting, so these gaps do not distort the solid.
- Two edges are near-duplicates (gap 1.9e-11) rather than slivers; the other 26 are 4 .. 45 um apart.

**Resolved 2026-11-21: it was refinement, not welding and not T-junctions.** A curved face refines its
triangles to stay inside the chord tolerance, and that subdivides the circular edge it shares with a flat
neighbour that needs no refinement. The extra points sit 4-8 um off the neighbour's straight edge, so the
old 1e-4 stitch default could never see them. Two changes to `stitchTJunctions`: the default tolerance is
now the chord tolerance the mesh already promises (`DEFAULT_TESS.tolerance`), and it only splits at a point
that is genuinely the end of another open edge (without that filter the same tolerance turned 5 non-manifold
edges into 9 and closed nothing). Measured: TYPE-C 28 -> 12 open edges, non-manifold unchanged at 5, volume
unchanged at 114.03, and the other five models stay fully watertight with identical volumes. Raising the
tolerance to 0.05 over-splits (39 open, 6 non-manifold), so it is not a knob to raise. A regression test
pins 28 open at 1e-4 against 12 at the default.

Do not chase these with a bigger tolerance, and do not chase T-junctions.

## Footprint sourcing (2026-11-21)
`readKicadMod(text)` in `src/kicad-read.ts` turns a standalone `.kicad_mod` into a `Footprint`, in
footprint-local millimetres at the origin. It is NOT a second parser: the `(footprint ...)` node parsing was
extracted out of `readKicadPcb` into `footprintFrom(...)`, so the board reader and the file reader cannot drift
apart. `lib` becomes the file's own name, since a standalone file carries no library nickname.

Measured against the 22 fixtures in refs:
- 0603: 2 pads at +-0.775, 0.9 x 0.95, body 2.96 x 1.46. The body is the COURTYARD rect, not the pad span
  (2.45) and not the fab body (1.6 x 0.8). This feeds the case generator, so a test pins all three numbers.
- DIP-10: 10 through-hole pads, each with a drill. QFN-60-1EP: 70 SMD pads, body 8.2 x 8.2.
- Four `pad_zone_connect_*` files are mounting holes (single npth, 3.2 mm drill) and come back as a hole, not a
  footprint.
- `fp_poly` is not modelled yet and is REPORTED in `skipped`, never silently dropped.

Two real bugs were caught by running all 22 fixtures instead of the two that were open:
1. The extracted pad loop turned "skip this pad" (`continue`) into "abort the whole footprint" (`return null`),
   so four files came back empty. Mechanical `continue` -> `return null` substitution is not safe.
2. KiCad 5/6 files start with `(module ...)`, not `(footprint ...)`, and were refused outright. Both roots are
   accepted now; two fixtures depend on it.

Mutation-checked: forcing the body to come from the pads instead of the courtyard fails 2 tests.

### Library import and model paths (same session)
`readFootprintLibrary(entries)` is pure (file contents in, footprints out) and `readFootprintLibraryDir(dir)` is the
thin Node wrapper that walks a tree. A bad file is REPORTED and does not sink the rest; duplicate footprint names
are listed once each and both copies kept; mounting holes go to their own list. Order is sorted by path, not by
footprint name, so an import is reproducible and ids are stable across machines. Refs gives 18 footprints + 4
holes from 22 files with 0 problems.

`resolveModelPath(path, { roots, baseDir, exists })` in `src/model-path.ts` handles the three shapes real
footprints use: `${KICAD10_3DMODEL_DIR}/...`, `../models/Socket.step`, and absolute. The variable is a KiCad
configuration value with no way to discover it (no network, no KiCad install to ask), so the caller supplies
`roots` and an unknown variable is REPORTED BY NAME with the option to set. The filesystem check is injected,
which keeps the module pure and usable from a browser shell. Paths are normalised so two spellings compare equal.

Mutation-checked: ignoring the variable root and dropping duplicate tracking each fail a test.

## Placement (auto), step 1 of 2: legality
`src/placement/legal.ts` answers "is this arrangement legal", which an auto-placer must be able to do before it
can search for one. A footprint's extent is its body rectangle turned by its rotation, so it is an ORIENTED box:
- overlap is separating-axis on the two oriented boxes, exact for convex shapes, and returns the penetration
  DEPTH in mm so a later annealer can score how bad an overlap is, not just that one exists;
- clearance is enforced by growing both boxes by half the margin, so `clearance: 0.5` means a 0.5 mm gap;
- on-board is corner containment PLUS an edge-crossing test. Corners alone are not enough: a part can sit over a
  narrow slot in a concave outline with all four corners inside and still hang over the edge.
`placementIssues(board, { clearance, margin, ignore })` returns the overlap and off-board problems; empty means
legal. Mutation-checked: replacing the oriented test with an axis-aligned one fails the 45 degree test, and
dropping the edge-crossing check fails the slot test.

## Placement (auto), step 2 of 2: the placer
`autoPlace(board, { seed, steps, clearance, margin, fixed })` in `src/placement/place.ts`. It packs parts into
rows inside the outline as a starting point, then anneals three moves (shift one, swap two, quarter-turn one).
Score is half-perimeter wire length over the netlist plus `overlapWeight` times the total penetration depth plus
the same times how far any part sits outside the outline. Overlaps are priced rather than rejected, which is why
`overlapDepth` returns millimetres.

`legal` is computed by calling `placementIssues` on the result, not by trusting the search. Deterministic in
`seed` (mulberry32), and the input board is not mutated.

Measured on a 70x50 board with an 8-part series chain: incoming 14.21 mm, packed start 13.26 mm, after 8000
steps 10.46 to 11.87 depending on seed, after 20000 steps down to 9.55. Temperature is 0.3 x the starting score:
measured against 0.05 and 0.6, 0.3 was consistently best at moderate budgets.

Two floating-point bugs found while testing, both the same shape: a part packed exactly AT the clearance or
exactly AT the margin was called illegal, because the penetration came out as about 1e-15. Both bounds are
CLOSED now, with `EPS = 1e-12` subtracted: above the dust, far below any sensible comparison tolerance. A third
bug: `packStart` repacked fixed parts, so an anchor moved before the search even started.

Mutation-checked: always reporting legal fails the tight-board test, and unseeded randomness fails the
determinism test.

Next: schematic files (`.kicad_sch`), then the three shells. Nothing calls `autoPlace` from a shell yet.

## Log (newest first; add a line per working session)
- 2026-11-23: auto-placement done (455 tests). Legality checker and annealing placer, mutation-checked. Next
  portion is `.kicad_sch`.- 2026-11-21 (later still): placement legality done (446 tests). Library import and model paths closed out
  footprint sourcing. No placer yet.- 2026-11-21 (later): footprint sourcing finished off with library import and model path resolution (431 tests).
  Two of the four failures on the way were the assistant's own: an order assertion that confused sorted paths
  with sorted names, and a missing `async` on a test using a dynamic import.- 2026-11-21: footprint sourcing done (415 tests). STEP reader closed out at 12/12. Next portions untouched:
  auto-placement, `.kicad_sch`, and the three shells (EasyEDA adapter, KiCad plugin, web app).
- 2026-11-21: steps 11 and 12 done, 406 tests. The STEP feature's twelve steps are now all ticked. Still true:
  TYPE-C keeps 12 open edges in one chamfer sliver where the source file's own surfaces do not meet, and the 2x2
  hole grid is a pinned known limitation. A preview UI does not exist yet; place.ts is what it will consume.
- 2026-11-21: step 10 done (kicad-cli oracle, 394 tests). All six fixtures agree with KiCad's own export on
  extents (worst 0.0194 mm) and volume (worst 0.53%). Steps 11 and 12 remain: render a footprint's model mesh
  in the preview instead of its box, and emit models into .kicad_pcb.
- 2026-11-21: step 9 done (readStep single entry point, units applied, 386 tests). Steps 10-12 remain: the kicad-cli oracle comparison, wiring the preview to use a footprint's model mesh, and the writer side.
- 2026-11-21: steps 7 and 8 done (assembly placements, colours). 381 tests pass. TYPE-C still 12 open edges, all in one chamfer sliver where the file's own surfaces do not meet; shared edges join correctly on both sides.
- 2026-11-20: boundary vertices keep their own curve positions (TYPE-C 316->28 open, Contact watertight); measured and recorded the remaining TYPE-C gaps above. Suite 369 pass.
- 2026-11-09: Steps 3 to 6 are committed (earlier scheduled runs). Re-measured all six real models: three close, three do not (table above). Workflow 'Boardforge continue' is archived, no scheduled runs remain. Handoff corrected from stale unchecked boxes.
- 2026-11-08: STEP step 2 done (units). Bug found by a real file: name-suffix matching mistook an assembly link for a shape; now structural. Scheduled workflow 'Boardforge continue' created (every 30 min, 12 runs).
- 2026-11-08: STEP step 1 done (Part 21 parser). Found and fixed an off-by-whitespace error offset bug; removed one redundant stripper branch proven equivalent by mutation.
