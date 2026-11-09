# Boardforge

A PCB toolchain core that runs anywhere JavaScript runs and needs nothing from the network. It reads and
writes native KiCad 9 files, checks designs, routes them, and generates a 3D printable enclosure that
follows the board, with real-world print tolerances built in.

No runtime dependencies. No network calls. Node 22.6+ with type stripping (`--experimental-strip-types`),
no build step.

Status: early. The core below works and is tested; several pieces of the pipeline are not built yet (see
[What is not done](#what-is-not-done)).

## What is in it

| Part | What it does | Where |
| --- | --- | --- |
| KiCad files | Read and write `.kicad_pcb` (KiCad 9). Round-trips real boards saved by KiCad. | `src/kicad-read.ts`, `src/kicad-write.ts`, `src/sexp.ts` |
| Footprints | Parametric R/C/LED, SOIC, SOT-23, pin headers, USB-C. Generated from numbers, nothing fetched. | `src/library.ts` |
| Design rule check | Clearance, shorts, track width, vias, annular ring, hole-to-hole, board edge, unconnected nets. | `src/drc/` |
| Autorouter | Grid A* with rip-up and vias, behind a swappable `Router` interface. | `src/router/` |
| Headless engine | JSON commands in, JSON results out, invertible atomic patches, undo/redo. The one surface that a KiCad plugin, a web app and a browser agent are all meant to sit on. | `src/engine/` |
| Enclosure generator | Board in, parametric OpenSCAD out. Cavity follows the outline, openings are cut on the wall each connector faces, standoffs sit under mounting holes. | `src/case/` |
| Print tolerances | `ideal`, `resin`, `fdm`, `fdm-loose` profiles: extra room for the board, openings, screws, and the lid lip, with vertical holes compensated. | `src/case/tolerance.ts` |
| STEP reader | Part 21 parser, per-shape length units, curves, surfaces, B-rep walk, tessellation to a watertight mesh. In progress. | `src/step/` |

## How it was checked

The aim was to measure, not to eyeball.

- **Against KiCad.** Routed boards are run through `kicad-cli pcb drc` and must come back with 0 violations
  and 0 unconnected. The DRC is compared rule by rule with KiCad's on a board with one deliberate fault of each kind.
- **Against the compiled geometry.** Enclosure tests compile the OpenSCAD and measure the mesh: wall
  positions, hole diameters, standoff heights, lid lip clearance, to within thousandths of a millimetre.
- **Golden files.** Seven reference boards are pinned as SCAD bytes plus a canonical STL hash, so a change to
  a dimension has to be a conscious re-bless.
- **Mutation testing.** After writing tests, the code is deliberately broken (wrong sign on a clearance,
  an off-by-one, a dropped term) and the tests must notice. Survivors are either given a test or proven
  equivalent and deleted.

## Running the tests

```sh
node --experimental-strip-types --test tests/*.test.ts
```

Optional tools make more tests run. Without them those tests are skipped, not failed:

- `kicad-cli` (KiCad 9) enables the DRC cross-checks.
- `openscad` (2021.01 was used to bless the goldens) enables the compiled-geometry tests and golden suite
  (`node --experimental-strip-types specs/run.ts`).
- Real STEP models enable the reader's fixture tests. They are **not in this repository**: KiCad's 3D library
  is CC-BY-SA 4.0 with an exception that does not cover redistributing it as a collection. Point
  `BOARDFORGE_REFS` at a folder containing the models (default: `../refs/` next to this repo). On a clean
  clone about 37 tests skip for this reason; the rest pass.

## What is not done

- Importing real footprint libraries (`.kicad_mod`, EasyEDA/LCSC). Only the small built-in set exists.
- Auto-placement. The engine can move parts; nothing decides where they go.
- Schematic files (`.kicad_sch`).
- Using STEP models in a preview or in the KiCad output. The reader is not finished.
- The three front ends: a KiCad plugin (IPC API), a self-contained web app, and an EasyEDA browser agent.
  They are designed as thin shells over the engine; none is written.
- Autorouting quality: 4-direction moves only (no 45 degree tracks), one routing strategy.

## Credits

Method and some code come from open-source projects. [`NOTICE.md`](NOTICE.md) lists each ported file with
its source, author and licence. The enclosure approach (derive the case from per-part records, treat design
flaws as errors, pin output with golden files) follows [kqrla/keeberia](https://github.com/kqrla/keeberia)'s
paracraft engine, which was read for method; no code was copied from it.

## Licence

MIT, see [`LICENSE`](LICENSE). Ported files keep their upstream MIT notice in [`licenses/`](licenses/).
