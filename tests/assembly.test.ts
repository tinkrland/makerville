/**
 * Assembly placement tests.
 *
 * The two real fixtures are the only files in refs with assembly data, and each has exactly one placement.
 * Their true placement is not independently known here, so the tests check the things that can be checked
 * without an oracle: that a placement is found at all, that the transform is a rigid motion (a sheared or
 * reflected matrix would mean the frames were built wrongly), that it names the right products, and that
 * applying it would MOVE the geometry away from the position the file already stores it in.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { parsePart21 } from "../src/step/part21.ts"
import { Geometry } from "../src/step/geometry.ts"
import { Brep } from "../src/step/brep.ts"
import { assemblyInstances, invertRigid } from "../src/step/assembly.ts"
import { apply, mul, fromFrame, frameFrom, IDENTITY, type M4 } from "../src/step/vec.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const has = (rel: string) => fs.existsSync(path.join(REFS, rel))
const PIN = "circuit-json-to-gltf/tests/assets/ExampleModelPin.step"
const TYPE_C = "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"
const PLAIN = "circuit-json-to-gltf/tests/assets/Contact.step"

const load = (rel: string) => {
  const p = parsePart21(fs.readFileSync(path.join(REFS, rel), "latin1"))
  const warnings: string[] = []
  const g = new Geometry(p, warnings)
  return { p, g, warnings }
}

/** the 3x3 block must be orthonormal with determinant +1, or the frames were misread */
const rigidError = (m: M4) => {
  const c = [[m[0]!, m[4]!, m[8]!], [m[1]!, m[5]!, m[9]!], [m[2]!, m[6]!, m[10]!]]
  const d = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  const det = d(c[0]!, [c[1]![1]! * c[2]![2]! - c[1]![2]! * c[2]![1]!, c[1]![2]! * c[2]![0]! - c[1]![0]! * c[2]![2]!, c[1]![0]! * c[2]![1]! - c[1]![1]! * c[2]![0]!])
  const unit = Math.max(...c.map((v) => Math.abs(d(v, v) - 1)))
  const orth = Math.max(Math.abs(d(c[0]!, c[1]!)), Math.abs(d(c[1]!, c[2]!)), Math.abs(d(c[2]!, c[0]!)))
  return Math.max(unit, orth, Math.abs(det - 1))
}

test("invertRigid: a rotation plus translation round-trips to the identity", () => {
  const f = frameFrom([3, -4, 5], [0, 0, 1], [1, 0, 0])
  const m = fromFrame(f)
  const back = mul(m, invertRigid(m))
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(back[i]! - IDENTITY[i]!) < 1e-12, `entry ${i}: ${back[i]}`)
})

test("invertRigid: a tilted frame inverts, not just an axis-aligned one", () => {
  const f = frameFrom([1, 2, 3], [0.3, 0.5, 0.81], [0.7, -0.2, -0.1])
  const m = fromFrame(f)
  const back = mul(m, invertRigid(m))
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(back[i]! - IDENTITY[i]!) < 1e-9, `entry ${i}: ${back[i]}`)
  // and it actually moves a point
  assert.ok(Math.abs(apply(m, [0, 0, 0])[2]! - 3) < 1e-9)
})

test("ExampleModelPin: one placement, rigid, naming the contact inside the pin", { skip: !has(PIN) }, () => {
  const { p, g, warnings } = load(PIN)
  const inst = assemblyInstances(p, g, warnings)
  assert.deepEqual(warnings, [], "no placement warnings")
  assert.equal(inst.length, 1)
  const i = inst[0]!
  assert.ok(rigidError(i.matrix) < 1e-9, `not a rigid motion: ${rigidError(i.matrix)}`)
  // product definitions from the file: #4401 is the pin (the assembly), #4402 the contact (the part)
  assert.equal(i.parent, 4401, "the assembly is the relating product definition")
  assert.equal(i.child, 4402, "the part is the related product definition")
  assert.match(i.name, /MpinContact_Large/)
})

test("TYPE-C: one placement, rigid", { skip: !has(TYPE_C) }, () => {
  const { p, g, warnings } = load(TYPE_C)
  const inst = assemblyInstances(p, g, warnings)
  assert.deepEqual(warnings, [], "no placement warnings")
  assert.equal(inst.length, 1)
  assert.ok(rigidError(inst[0]!.matrix) < 1e-9, `not a rigid motion: ${rigidError(inst[0]!.matrix)}`)
})

test("a file with no assembly data yields no placements and no warnings", { skip: !has(PLAIN) }, () => {
  const { p, g, warnings } = load(PLAIN)
  assert.deepEqual(assemblyInstances(p, g, warnings), [])
  assert.deepEqual(warnings, [], "absence of assemblies is not a problem to report")
})

/**
 * These exporters already store the B-reps in world coordinates, so the placement is redundant for drawing
 * and applying it would be wrong. This is measured, not assumed: for the pin, the as-is model already
 * reaches exactly z = 8.4, which is the offset the placement carries, and applying it would push the model
 * 8.4 mm further. For the connector, applying it shifts the model 1.3525 mm off the extents the file
 * declares and the tessellation tests assert. readStep therefore uses the solids as they are and exposes
 * the placements for callers that need the hierarchy.
 */
test("applying the placement would move the geometry off the position the file already stores", { skip: !has(PIN) || !has(TYPE_C) }, () => {
  for (const [rel, expectedMaxZ] of [[PIN, 8.4], [TYPE_C, 3.9525]] as const) {
    const { p, g, warnings } = load(PIN === rel ? PIN : TYPE_C)
    const solids = new Brep(p, g, warnings).read()
    const pts: number[][] = []
    for (const s of solids) for (const sh of s.shells) for (const f of sh.faces) for (const b of f.bounds) {
      for (const e of b.loop.edges as { from: number[]; to: number[] }[]) { pts.push(e.from, e.to) }
    }
    const maxZ = Math.max(...pts.map((q) => q[2]!))
    assert.ok(Math.abs(maxZ - expectedMaxZ) < 1e-3, `${rel}: as-is max z ${maxZ}, expected ${expectedMaxZ}`)
    const m = assemblyInstances(p, g, [])[0]!.matrix
    const movedMaxZ = Math.max(...pts.map((q) => apply(m, q as [number, number, number])[2]!))
    assert.ok(Math.abs(movedMaxZ - maxZ) > 0.5, `${rel}: applying the placement should visibly move the model, got ${movedMaxZ} vs ${maxZ}`)
  }
})
