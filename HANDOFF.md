# Boardforge handoff

This file is how work continues when nobody is watching. A scheduled run (or a fresh chat) reads it,
does the next unchecked step, runs the tests, commits, and updates this file. Keep it truthful.

## Ground rules (from the owner, always apply)
- Repo: `/app/conversations/6af0495dcaf878e1398c29c6/boardforge`. Git identity must be `tinkrland <324020321+tinkrland@users.noreply.github.com>`. Check `git var GIT_AUTHOR_IDENT` before committing.
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
- [ ] 2. `units.ts` read length unit (SI mm/m, CONVERSION_BASED inch) and return a scale to millimetres.
- [ ] 3. `geometry.ts` resolve points, directions, axis placements, lines, circles, ellipses, B-spline curves into evaluators.
- [ ] 4. `surfaces.ts` plane, cylinder, cone, sphere, torus, B-spline surface: evaluate point + normal and project a point to (u,v).
- [ ] 5. `brep.ts` walk MANIFOLD_SOLID_BREP -> CLOSED_SHELL -> ADVANCED_FACE -> loops -> oriented edges. Respect same_sense flags and edge orientation.
- [ ] 6. `tessellate.ts` turn each trimmed face into triangles: sample the boundary loops to a chord tolerance, triangulate in the surface's (u,v) domain handling holes (ear clipping with hole bridging), lift back to 3D. Planes exact; cylinders/cones need seam handling.
- [ ] 7. `assembly.ts` NEXT_ASSEMBLY_USAGE_OCCURRENCE + ITEM_DEFINED_TRANSFORMATION placements; instance shared parts.
- [ ] 8. `colour.ts` STYLED_ITEM -> COLOUR_RGB per face.
- [ ] 9. `index.ts` `readStep(bytes) -> { meshes: [{ positions, indices, colour }], boundsMm, warnings }`.
- [ ] 10. Oracle test: for each real fixture compare our mesh to `kicad-cli pcb export` output or a hand-made board using the model (bounding box within 0.05 mm, volume within 2%, watertight where the solid is closed).
- [ ] 11. Wire into the preview: `Footprint.model = { path, offset, rotation, scale }` is already in the model; a footprint with a model renders its mesh instead of the box.
- [ ] 12. Writer side: embed/emit models in `.kicad_pcb` (`(model "path" (offset) (scale) (rotate))`) so KiCad shows them.

Acceptance for the whole STEP feature: all five reference files tessellate with 0 errors, bounding boxes match the STEP's own declared extents, closed solids are watertight (each edge shared by exactly two triangles), and total volume is within 2% of an independent computation. Unsupported surface types produce a named warning and are skipped, never a crash or a silent hole.

## Then, in order
1. Schematic files: write/read `.kicad_sch` v9 from the same board model (netlist is already there).
2. Footprint sourcing: import `.kicad_mod` and `.pretty` libraries into the library module; keep it offline.
3. Placement: simple force-directed / grid auto-placement as a swappable module, validated by DRC.
4. Wire PCB change -> case regeneration as an engine command.
5. EasyEDA adapter, KiCad IPC plugin, web shell (all thin).

## Log (newest first; add a line per working session)
- 2026-11-08: STEP step 1 done (Part 21 parser). Found and fixed an off-by-whitespace error offset bug; removed one redundant stripper branch proven equivalent by mutation.
