/**
 * readStep tests: the single entry point.
 *
 * The box fixture has a closed-form answer (2 x 4 x 6 = 48 mm^3, corners at +-1, +-2, +-3), so the whole
 * pipeline is checked against arithmetic rather than against itself. The real components are checked for the
 * things a renderer depends on: millimetre bounds that match the file's declared extents, a volume that has
 * not drifted, every solid coloured, and every problem named in warnings.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { readStep } from "../src/step/index.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const has = (rel: string) => fs.existsSync(path.join(REFS, rel))
const read = (rel: string) => readStep(fs.readFileSync(path.join(REFS, rel), "latin1"))
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol

const BOX = "circuit-json-to-step/test/basics/basics22/solidworks.step"
const R0603 = "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step"
const TYPE_C = "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"

test("box: millimetre bounds and volume are exact, because 2x4x6 is arithmetic", { skip: !has(BOX) }, () => {
  const r = read(BOX)
  assert.deepEqual(r.warnings, [])
  assert.equal(r.meshes.length, 1)
  const [lo, hi] = r.boundsMm
  assert.ok(near(lo[0], -1) && near(hi[0], 1), `x ${lo[0]}..${hi[0]}`)
  assert.ok(near(lo[1], -2) && near(hi[1], 2), `y ${lo[1]}..${hi[1]}`)
  assert.ok(near(lo[2], -3) && near(hi[2], 3), `z ${lo[2]}..${hi[2]}`)
  assert.ok(near(r.volumeMm3, 48, 1e-6), `volume ${r.volumeMm3}`)
  // 24, not 12: each quad is fanned from its centroid, so it becomes 4 triangles rather than 2. Correct but
  // not minimal; pinned so a change in triangulation shows up. Ear clipping would give 2 per quad if the
  // extra triangles ever cost enough to matter.
  assert.equal(r.triangles, 24, "6 faces, 4 triangles each, from the centroid fan")
})

test("R_0603: a real resistor keeps its declared 1.6 x 0.8 x 0.45 mm and its three colours", { skip: !has(R0603) }, () => {
  const r = read(R0603)
  assert.deepEqual(r.warnings, [])
  const [lo, hi] = r.boundsMm
  assert.ok(near(hi[0] - lo[0], 1.6, 1e-3), `length ${hi[0] - lo[0]}`)
  assert.ok(near(hi[1] - lo[1], 0.8, 1e-3), `width ${hi[1] - lo[1]}`)
  assert.ok(near(hi[2] - lo[2], 0.45, 1e-3), `height ${hi[2] - lo[2]}`)
  assert.ok(near(r.volumeMm3, 0.535, 1e-2), `volume ${r.volumeMm3}`)
  const colours = new Set(r.meshes.map((m) => (m.colour ? `${m.colour.r},${m.colour.g},${m.colour.b}` : "none")))
  assert.equal(colours.size, 3, "body, end cap and terminal are different colours")
  assert.ok(!colours.has("none"), "every group has a colour")
})

test("TYPE-C: 42 solids, declared extents, three colours, and the seam slivers reported not hidden", { skip: !has(TYPE_C) }, () => {
  const r = read(TYPE_C)
  assert.equal(r.meshes.length, 42, "one mesh per solid")
  assert.equal(r.triangles, 5312)
  assert.ok(near(r.volumeMm3, 114.03, 1e-2), `volume ${r.volumeMm3}`)
  const [lo, hi] = r.boundsMm
  assert.ok(near(lo[0], -4.47) && near(hi[0], 4.47), `x ${lo[0]}..${hi[0]}`)
  assert.ok(near(lo[2], -3.9525) && near(hi[2], 3.9525), `z ${lo[2]}..${hi[2]}`)
  const colours = new Set(r.meshes.map((m) => (m.colour ? `${m.colour.r},${m.colour.g},${m.colour.b}` : "none")))
  assert.equal(colours.size, 3)
  assert.equal(r.placements.length, 1, "the file has one assembly placement, exposed but not applied")
  // the 8 warnings must be the known degenerate seam slivers, each saying it correctly has no triangles
  assert.equal(r.warnings.length, 8, `warnings: ${r.warnings.join(" | ")}`)
  for (const w of r.warnings) assert.match(w, /encloses no area/, `unexpected warning: ${w}`)
})

test("readStep accepts bytes as well as text and gives the same answer", { skip: !has(BOX) }, () => {
  const buf = fs.readFileSync(path.join(REFS, BOX))
  const a = readStep(buf.toString("latin1"))
  const b = readStep(new Uint8Array(buf))
  assert.equal(b.triangles, a.triangles)
  assert.ok(near(b.volumeMm3, a.volumeMm3, 1e-9))
  assert.deepEqual(b.boundsMm, a.boundsMm)
})

test("every real model gives finite bounds and no mesh with a non-finite coordinate", { skip: !has(TYPE_C) }, () => {
  for (const rel of [BOX, R0603, TYPE_C, "circuit-json-to-gltf/tests/assets/Contact.step", "freerouting/fixtures/Issue191-processor.Z80/plcc44.stp"]) {
    if (!has(rel)) continue
    const r = read(rel)
    for (const v of [...r.boundsMm[0], ...r.boundsMm[1]]) assert.ok(Number.isFinite(v), `${rel}: non-finite bound`)
    for (const m of r.meshes) {
      assert.equal(m.positions.length % 3, 0, `${rel}: positions are not triples`)
      assert.equal(m.indices.length % 3, 0, `${rel}: indices are not triples`)
      const nv = m.positions.length / 3
      for (const i of m.indices) assert.ok(i >= 0 && i < nv, `${rel}: index ${i} out of range for ${nv} vertices`)
      for (const x of m.positions) assert.ok(Number.isFinite(x), `${rel}: non-finite coordinate`)
    }
  }
})
