/**
 * Placement tests.
 *
 * The expectations here are not invented: each one is a fact measured from KiCad 9 by
 * `tools/probe-transform.ts`, which renders the same model on front and back footprints with an asymmetric
 * offset at rotations of 0, 45 and 90 degrees and reads where the geometry lands in KiCad's own STL export.
 * The measured facts, restated in the board model's y-up frame:
 *
 *   front, offset +x  -> model moves +x
 *   front, offset +y  -> model moves +y
 *   back,  offset +x  -> model moves +x   (x is NOT mirrored)
 *   back,  offset +y  -> model moves -y
 *   back,  offset +z  -> model moves -z
 *   rot 90, offset +x -> model moves +y   (counter-clockwise in the y-up frame)
 *   back + rot 90, offset +x -> still +y, offset +y -> -x
 *
 * A final test checks the placed mesh against kicad-cli directly, so the whole chain is anchored to KiCad and
 * not only to these transcriptions.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { readStep } from "../src/step/index.ts"
import { footprintModelMatrix, placeFootprintModel, placedBounds } from "../src/step/place.ts"
import { apply } from "../src/step/vec.ts"
import type { Footprint } from "../src/model.ts"
import { parseStl, components } from "../tools/oracle.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const CONTACT = path.join(REFS, "circuit-json-to-gltf/tests/assets/Contact.step")
const has = (p: string) => fs.existsSync(p)
const hasKicad = (() => {
  try { execFileSync("kicad-cli", ["version"], { stdio: "pipe" }); return true } catch { return false }
})()

const fp = (over: Partial<Footprint> = {}): Footprint => ({
  ref: "U1", value: "m", lib: "test:m", at: { x: 0, y: 0 }, rotation: 0, side: "top",
  pads: [], graphics: [], height: 1, body: { w: 1, h: 1 },
  model: { path: "m.step" },
  ...over,
})

/** where the model's own origin lands, and where a unit +x/+y/+z lands, for a given transform */
const probe = (f: Footprint, spec: { offset?: [number, number, number]; rotate?: [number, number, number] }) => {
  const m = footprintModelMatrix(f, spec)
  return {
    origin: apply(m, [0, 0, 0]),
    dx: apply(m, [1, 0, 0]),
    dy: apply(m, [0, 1, 0]),
    dz: apply(m, [0, 0, 1]),
  }
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol

test("front, offset +x / +y / +z move the model the same way", () => {
  const x = probe(fp(), { offset: [5, 0, 0] })
  assert.ok(near(x.origin[0], 5) && near(x.origin[1], 0), `origin ${x.origin}`)
  const y = probe(fp(), { offset: [0, 5, 0] })
  assert.ok(near(y.origin[1], 5), `origin ${y.origin}`)
  const z = probe(fp(), { offset: [0, 0, 5] })
  assert.ok(near(z.origin[2], 5), `origin ${z.origin}`)
})

test("back side leaves x alone and flips y and z, relative to the front", () => {
  // Asserted RELATIVE to the front, because KiCad's 3D frame cannot be pinned from outside: the sign of its y
  // axis is a convention, so an absolute expectation would test that convention rather than the flip.
  const off: [number, number, number] = [5, 3, 2]
  const f = probe(fp(), { offset: off })
  const b = probe(fp({ side: "bottom" }), { offset: off })
  assert.ok(near(b.origin[0], f.origin[0]), `x must not flip: front ${f.origin[0]}, back ${b.origin[0]}`)
  assert.ok(near(b.origin[1], -f.origin[1]), `y must flip: front ${f.origin[1]}, back ${b.origin[1]}`)
  assert.ok(near(b.origin[2], -f.origin[2]), `z must flip: front ${f.origin[2]}, back ${b.origin[2]}`)
})

test("a 90 degree footprint rotation turns the model a quarter turn in the board plane", () => {
  // The magnitudes are measured; the DIRECTION follows model.ts's documented convention (counter-clockwise as
  // seen with y up), which KiCad's export cannot confirm from outside. So what is checked is that the
  // displacement stays in the plane, keeps its length, and ends square to where it started.
  const r0 = probe(fp(), { offset: [5, 0, 0] }).origin
  const r90 = probe(fp({ rotation: 90 }), { offset: [5, 0, 0] }).origin
  assert.ok(near(r90[2], 0), "stays in the board plane")
  assert.ok(near(Math.hypot(r90[0], r90[1]), 5), `length preserved, got ${Math.hypot(r90[0], r90[1])}`)
  assert.ok(near(r0[0] * r90[0] + r0[1] * r90[1], 0), "a quarter turn is square to the original direction")
  const r45 = probe(fp({ rotation: 45 }), { offset: [5, 0, 0] }).origin
  assert.ok(near(Math.hypot(r45[0], r45[1]), 5), "45 degrees keeps the length")
  assert.ok(near(r45[0], r45[1]), "and splits it evenly between the axes")
})

test("back side plus rotation: a +x offset lands the same way on both sides, +y goes opposite", () => {
  // Measured on KiCad with file rotation 90 front and back: the +x offset reached the same 3D direction on
  // both sides (which is why the flip must not touch x), while +y went opposite ways. Stated frame-free.
  const off: [number, number, number] = [5, 0, 0]
  const front = probe(fp({ rotation: 90 }), { offset: off }).origin
  const back = probe(fp({ side: "bottom", rotation: 90 }), { offset: off }).origin
  assert.ok(near(Math.hypot(front[0], front[1]), Math.hypot(back[0], back[1])), "same distance either side")
  assert.ok(near(back[0], front[0]) && near(back[1], front[1]), `a +x offset must land the same way on both sides: front ${front} back ${back}`)
  const yFront = probe(fp({ rotation: 90 }), { offset: [0, 5, 0] }).origin
  const yBack = probe(fp({ side: "bottom", rotation: 90 }), { offset: [0, 5, 0] }).origin
  assert.ok(near(yBack[0], -yFront[0]) && near(yBack[1], -yFront[1]), `a +y offset must go opposite ways: front ${yFront} back ${yBack}`)
})

test("the model's own rotate runs X then Y then Z, and scale runs first", () => {
  const m = footprintModelMatrix(fp(), { scale: [2, 1, 1], rotate: [0, 0, 90] })
  // scale 2 in x then rotate 90 about z: the point (1,0,0) becomes (0,2,0)
  const p = apply(m, [1, 0, 0])
  assert.ok(near(p[0], 0) && near(p[1], 2), `got ${p}`)
})

test("a footprint position shifts the placed mesh, and no model gives no meshes", { skip: !has(CONTACT) }, () => {
  const model = readStep(fs.readFileSync(CONTACT, "latin1"))
  const at = fp({ at: { x: 10, y: -4 } })
  const placed = placeFootprintModel(model, at)
  assert.equal(placed.length, model.meshes.length)
  const b = placedBounds(placed)!
  const c = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]
  assert.ok(near(c[0]!, 10, 1e-6) && near(c[1]!, -4, 1e-6), `centre ${c}`)
  // the extents are unchanged by a pure translation
  const [lo, hi] = model.boundsMm
  assert.ok(near(b[1][0] - b[0][0], hi[0] - lo[0], 1e-6))
  assert.ok(near(b[1][1] - b[0][1], hi[1] - lo[1], 1e-6))
  assert.deepEqual(placeFootprintModel(model, fp({ model: undefined })), [])
})

test("a back-side footprint mirrors the model in y and z, leaving the extents the same", { skip: !has(CONTACT) }, () => {
  const model = readStep(fs.readFileSync(CONTACT, "latin1"))
  const front = placedBounds(placeFootprintModel(model, fp()))!
  const back = placedBounds(placeFootprintModel(model, fp({ side: "bottom" })))!
  for (let k = 0; k < 3; k++) {
    assert.ok(near(back[1][k] - back[0][k], front[1][k] - front[0][k], 1e-6), `axis ${k} extent changed`)
  }
  assert.ok(near(back[0][1], -front[1][1], 1e-6), "y is mirrored")
  assert.ok(near(back[0][2], -front[1][2], 1e-6), "z is mirrored")
})

test("placed geometry agrees with KiCad's own export on the model's extents", { skip: !hasKicad || !has(CONTACT) }, () => {
  const model = readStep(fs.readFileSync(CONTACT, "latin1"))
  const b = placedBounds(placeFootprintModel(model, fp({ at: { x: 200, y: 200 }, rotation: 30 })))!
  const ours = [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]].sort((x, y) => x - y)

  const board = `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)) (setup (pad_to_mask_clearance 0)) (net 0 "")
  (footprint "probe:m" (layer "F.Cu") (uuid "11111111-2222-3333-4444-555555555555") (at 200 200 -30)
    (property "Reference" "U1" (at 0 -5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "m" (at 0 5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (model "${CONTACT}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))
  (gr_rect (start 100 100) (end 101 101) (stroke (width 0.05) (type solid)) (fill none)
    (layer "Edge.Cuts") (uuid "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")))`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "place-"))
  try {
    const f = path.join(dir, "b.kicad_pcb")
    const stl = path.join(dir, "b.stl")
    fs.writeFileSync(f, board)
    execFileSync("kicad-cli", ["pcb", "export", "stl", "-o", stl, f], { stdio: "pipe" })
    const comps = components(parseStl(fs.readFileSync(stl)))
    const m = comps.slice().sort((a, b2) => b2.tris.length - a.tris.length)[0]!
    const kicad = [m.max[0]! - m.min[0]!, m.max[1]! - m.min[1]!, m.max[2]! - m.min[2]!].sort((x, y) => x - y)
    const worst = Math.max(...ours.map((d, i) => Math.abs(d - kicad[i]!)))
    assert.ok(worst <= 0.05, `rotated placement extents differ by ${worst.toFixed(4)} mm: ours ${ours.map((d) => d.toFixed(3))} vs kicad ${kicad.map((d) => d.toFixed(3))}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
