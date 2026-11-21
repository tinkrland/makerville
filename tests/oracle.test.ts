/**
 * Step 10: the oracle test.
 *
 * Our tessellation is checked against KiCad's own 3D export of the same STEP file, so a bug in our reader
 * cannot hide behind a bug in our tests. KiCad 9 meshes STEP with an independent importer, and
 * `kicad-cli pcb export stl` writes the result, which is parsed here.
 *
 * Only comparisons that survive an axis swap are used: the SORTED bounding-box extents and the volume.
 * KiCad's board frame flips and rotates Y relative to the STEP frame, so asserting per-axis values would be
 * testing a frame convention rather than the geometry.
 *
 * The tolerances are the ones the plan sets: extents within 0.05 mm, volume within 2%. Measured today, the
 * worst extent error across all six fixtures is 0.0194 mm (the TO-92, whose curved body meshes differently)
 * and the worst volume error is 0.53%, so these are real margins, not a lucky pass.
 *
 * Skipped when kicad-cli is not installed, because the oracle genuinely cannot run without it.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { readStep } from "../src/step/index.ts"
import { kicadOracle } from "../tools/oracle.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const hasKicad = (() => {
  try { execFileSync("kicad-cli", ["version"], { stdio: "pipe" }); return true } catch { return false }
})()

const FIXTURES = [
  ["R_0603_1608Metric.step", "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step"],
  ["TO-92_Inline.step", "circuit-json-to-gltf/tests/assets/TO-92_Inline.step"],
  ["Contact.step", "circuit-json-to-gltf/tests/assets/Contact.step"],
  ["TYPE-C-31-M-12.step", "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"],
  ["plcc44.stp", "freerouting/fixtures/Issue191-processor.Z80/plcc44.stp"],
  ["solidworks.step", "circuit-json-to-step/test/basics/basics22/solidworks.step"],
] as const

const present = FIXTURES.filter(([, rel]) => fs.existsSync(path.join(REFS, rel)))

test("kicad-cli is available, so the oracle can actually run", { skip: !hasKicad }, () => {
  assert.ok(hasKicad)
})

for (const [name, rel] of present) {
  test(`${name}: our mesh agrees with KiCad's own export`, { skip: !hasKicad }, () => {
    const file = path.join(REFS, rel)
    const ours = readStep(fs.readFileSync(file, "latin1"))
    const [lo, hi] = ours.boundsMm
    const ourDims = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].sort((a, b) => a - b)
    const kicad = kicadOracle(file)

    assert.equal(kicad.components > 0, true, "KiCad produced no geometry for the model")
    const worst = Math.max(...ourDims.map((d, i) => Math.abs(d - kicad.dims[i]!)))
    assert.ok(worst <= 0.05, `bounding box differs by ${worst.toFixed(4)} mm (limit 0.05): ours ${ourDims.map((d) => d.toFixed(4))} vs kicad ${kicad.dims.map((d) => d.toFixed(4))}`)

    const pct = Math.abs(ours.volumeMm3 - kicad.volume) / kicad.volume * 100
    assert.ok(pct <= 2, `volume differs by ${pct.toFixed(2)}% (limit 2%): ours ${ours.volumeMm3.toFixed(3)} vs kicad ${kicad.volume.toFixed(3)}`)
  })
}

test("the oracle is a real check: it would catch a model scaled by 5 percent", { skip: !hasKicad }, () => {
  // Guard against the oracle silently agreeing with anything. Take a fixture, scale our reading by 5%, and
  // confirm the comparison then fails. If this test passes trivially, the oracle is not measuring anything.
  const [, rel] = present.find(([n]) => n === "Contact.step") ?? present[0]!
  const ours = readStep(fs.readFileSync(path.join(REFS, rel), "latin1"))
  const [lo, hi] = ours.boundsMm
  const dims = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].sort((a, b) => a - b).map((d) => d * 1.05)
  const kicad = kicadOracle(path.join(REFS, rel))
  const worst = Math.max(...dims.map((d, i) => Math.abs(d - kicad.dims[i]!)))
  assert.ok(worst > 0.05, `a 5% scale error produced only ${worst.toFixed(4)} mm of difference, so the oracle is too loose to be useful`)
})
