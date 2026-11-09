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
| Footprint sourcing (import real footprints) | not started |
| Placement (auto) | not started |
| Schematic files (`.kicad_sch`) | not started |
| 3D models: STEP reader | **in progress** (see below) |
| EasyEDA browser adapter, KiCad plugin, web shell | not started |

## STEP reader plan (`src/step/`)
Real models are B-rep. Face mix in the five reference files: planes ~70%, then cylinders, cones, circles/lines for edges, a few B-spline surfaces. Units mm. Assemblies are rare but real.

- [x] 1. `part21.ts` Part 21 text parser. 46 tests, exact error offsets, real files verified.
- [x] 2. `units.ts` length unit per shape via its representation context (SI prefixes, CONVERSION_BASED inch/foot/mil, mixed-unit files). 21 tests, mutation-checked. Use `shapeRepresentations(p)` + `unitForContext(...)` to scale each shape; never match shapes by name suffix (CONTEXT_DEPENDENT_SHAPE_REPRESENTATION is an assembly link).
- [x] 3. `geometry.ts` resolve points, directions, axis placements, lines, circles, ellipses, B-spline curves into evaluators. Done (commit 27b60ff).
- [x] 4. `surfaces.ts` plane, cylinder, cone, sphere, torus, B-spline surface: evaluate point + normal and project a point to (u,v). Done (commit 27b60ff).
- [x] 5. `brep.ts` walk MANIFOLD_SOLID_BREP -> CLOSED_SHELL -> ADVANCED_FACE -> loops -> oriented edges. Respect same_sense flags and edge orientation. Done (commit 3b695ee).
- [x] 6. `tessellate.ts` turn each trimmed face into triangles: sample the boundary loops to a chord tolerance, triangulate in the surface's (u,v) domain handling holes (ear clipping with hole bridging), lift back to 3D. Planes exact; cylinders/cones need seam handling. Done, BUT see "Measured state" below: not every real model closes.
- [ ] 7. `assembly.ts` NEXT_ASSEMBLY_USAGE_OCCURRENCE + ITEM_DEFINED_TRANSFORMATION placements; instance shared parts.
- [ ] 8. `colour.ts` STYLED_ITEM -> COLOUR_RGB per face.
- [ ] 9. `index.ts` `readStep(bytes) -> { meshes: [{ positions, indices, colour }], boundsMm, warnings }`.
- [ ] 10. Oracle test: for each real fixture compare our mesh to `kicad-cli pcb export` output or a hand-made board using the model (bounding box within 0.05 mm, volume within 2%, watertight where the solid is closed).
- [ ] 11. Wire into the preview: `Footprint.model = { path, offset, rotation, scale }` is already in the model; a footprint with a model renders its mesh instead of the box.
- [ ] 12. Writer side: embed/emit models in `.kicad_pcb` (`(model "path" (offset) (scale) (rotate))`) so KiCad shows them.

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

## Log (newest first; add a line per working session)
- 2026-11-09: Steps 3 to 6 are committed (earlier scheduled runs). Re-measured all six real models: three close, three do not (table above). Workflow 'Boardforge continue' is archived, no scheduled runs remain. Handoff corrected from stale unchecked boxes.
- 2026-11-08: STEP step 2 done (units). Bug found by a real file: name-suffix matching mistook an assembly link for a shape; now structural. Scheduled workflow 'Boardforge continue' created (every 30 min, 12 runs).
- 2026-11-08: STEP step 1 done (Part 21 parser). Found and fixed an off-by-whitespace error offset bug; removed one redundant stripper branch proven equivalent by mutation.
