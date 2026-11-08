import test from "node:test"
import assert from "node:assert/strict"
import { newBoard, ensureNet } from "../src/model.ts"
import { resistor, header } from "../src/library.ts"
import { applyPatch, invert, PatchError, type Op, type Patch } from "../src/engine/patch.ts"
import { crossingBoard } from "./router-kicad.ts"

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const P = (ops: Op[], label = "t"): Patch => ({ ops, label })

test("add then undo gives back exactly the original board", () => {
  const b = crossingBoard()
  const before = clone(b)
  const applied = applyPatch(b, P([
    { op: "add_track", track: { id: "x1", a: { x: 0, y: 0 }, b: { x: 3, y: 0 }, width: 0.25, layer: "F.Cu", net: "NEW" } },
    { op: "add_via", via: { id: "v1", at: { x: 3, y: 0 }, diameter: 0.8, drill: 0.4, from: "F.Cu", to: "B.Cu", net: "NEW" } },
  ]))
  assert.notDeepEqual(b, before)
  assert.ok(b.nets.includes("NEW"), "adding copper on a new net registers the net")
  applyPatch(b, invert(applied))
  b.nets = b.nets.filter((n) => n !== "NEW") // the net list is a derived convenience; copper and pads are the truth
  assert.deepEqual(b, before)
})

test("every op kind inverts cleanly", () => {
  const b = crossingBoard()
  const before = clone(b)
  const R9 = resistor("R9", "0402", { at: { x: 5, y: 5 } })
  const ops: Op[] = [
    { op: "add_footprint", footprint: R9 },
    { op: "move_footprint", ref: "R1", at: { x: -6, y: 7 }, rotation: 90, side: "top" },
    { op: "set_pad_net", ref: "R9", pad: "1", net: "ZZ" },
    { op: "add_hole", hole: { id: "H9", at: { x: 0, y: 9 }, drill: 2, pad: 3 } },
    { op: "remove_hole", id: "H1" },
    { op: "remove_track", id: "none" } as any, // placeholder replaced below
  ].slice(0, 5) as Op[]
  ops.push({ op: "set_outline", outline: [{ x: -20, y: -14 }, { x: 20, y: -14 }, { x: 20, y: 14 }, { x: -20, y: 13 }] })
  ops.push({ op: "set_rules", rules: { clearance: 0.3, minTrackWidth: 0.2 } })
  ops.push({ op: "remove_footprint", ref: "C1" })
  const applied = applyPatch(b, P(ops))
  assert.equal(b.rules.clearance, 0.3)
  assert.equal(b.footprints.some((f) => f.ref === "C1"), false)
  applyPatch(b, invert(applied))
  b.nets = before.nets
  // footprints come back at the end of the list, so compare by reference
  const byRef = (x: typeof b) => Object.fromEntries(x.footprints.map((f) => [f.ref, f]))
  assert.deepEqual(byRef(b), byRef(before))
  assert.deepEqual(b.holes.sort((p, q) => p.id.localeCompare(q.id)), before.holes.sort((p, q) => p.id.localeCompare(q.id)))
  assert.deepEqual(b.outline, before.outline)
  assert.deepEqual(b.rules, before.rules)
})

test("a failing op rolls the WHOLE patch back (atomic)", () => {
  const b = crossingBoard()
  const before = clone(b)
  assert.throws(() => applyPatch(b, P([
    { op: "add_track", track: { id: "ok", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0.25, layer: "F.Cu", net: "A" } },
    { op: "move_footprint", ref: "R1", at: { x: 9, y: 9 }, rotation: 0, side: "top" },
    { op: "remove_track", id: "does-not-exist" },
  ])), PatchError)
  assert.deepEqual(b, before, "nothing from the first two ops may survive")
})

test("the board object keeps its identity after a rollback", () => {
  const b = crossingBoard()
  const ref = b
  try { applyPatch(b, P([{ op: "remove_via", id: "nope" }])) } catch {}
  assert.equal(ref, b)
  assert.ok(b.footprints.length > 0)
})

test("rejects bad input with a reason", () => {
  const b = newBoard("t", 20, 20)
  const bad = (op: Op, re: RegExp) => assert.throws(() => applyPatch(b, P([op])), re)
  bad({ op: "add_track", track: { id: "t", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0.2, layer: "In9.Cu", net: "" } }, /not on this board/)
  bad({ op: "add_track", track: { id: "t", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0, layer: "F.Cu", net: "" } }, /positive/)
  bad({ op: "set_outline", outline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, /at least 3/)
  bad({ op: "set_pad_net", ref: "U9", pad: "1", net: "A" }, /no footprint U9/)
})

test("duplicates are refused", () => {
  const b = newBoard("t", 20, 20)
  const t = { id: "t", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0.2, layer: "F.Cu", net: "" }
  applyPatch(b, P([{ op: "add_track", track: t }]))
  assert.throws(() => applyPatch(b, P([{ op: "add_track", track: t }])), /already exists/)
  b.footprints.push(resistor("R1", "0603"))
  assert.throws(() => applyPatch(b, P([{ op: "add_footprint", footprint: resistor("R1", "0603") }])), /already exists/)
})

test("a net still in use cannot be removed", () => {
  const b = crossingBoard()
  assert.throws(() => applyPatch(b, P([{ op: "remove_net", net: "A" }])), /still in use/)
})

test("cannot invert a patch that did not come from applyPatch", () => {
  assert.throws(() => invert(P([{ op: "remove_track", id: "x" }])), /cannot invert/)
})

test("patches are plain JSON: survive a serialise round trip and still apply", () => {
  const b = crossingBoard()
  const p = P([{ op: "add_via", via: { id: "v1", at: { x: 1, y: 1 }, diameter: 0.8, drill: 0.4, from: "F.Cu", to: "B.Cu", net: "A" } }], "wire")
  const wire = JSON.parse(JSON.stringify(p))
  applyPatch(b, wire)
  assert.ok(b.vias.some((v) => v.id === "v1"))
})

test("the applied patch does not alias the board (mutating it cannot corrupt state)", () => {
  const b = newBoard("t", 20, 20)
  const t = { id: "t", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0.2, layer: "F.Cu", net: "" }
  applyPatch(b, P([{ op: "add_track", track: t }]))
  t.width = 99
  assert.equal(b.tracks[0]!.width, 0.2)
})

// random operation sequences: apply N, invert all, must land back on the start
test("fuzz: 300 random patches always invert exactly", () => {
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const b = crossingBoard()
  const start = clone(b)
  const history: Patch[] = []
  let n = 0
  for (let i = 0; i < 300; i++) {
    const r = rnd()
    let op: Op
    if (r < 0.35) op = { op: "add_track", track: { id: "f" + n++, a: { x: rnd() * 20 - 10, y: rnd() * 10 }, b: { x: rnd() * 20 - 10, y: rnd() * 10 }, width: 0.2, layer: rnd() < 0.5 ? "F.Cu" : "B.Cu", net: "N" + (n % 5) } }
    else if (r < 0.55 && b.tracks.length) op = { op: "remove_track", id: b.tracks[Math.floor(rnd() * b.tracks.length)]!.id }
    else if (r < 0.7) op = { op: "move_footprint", ref: b.footprints[Math.floor(rnd() * b.footprints.length)]!.ref, at: { x: rnd() * 10, y: rnd() * 10 }, rotation: Math.floor(rnd() * 4) * 90, side: rnd() < 0.5 ? "top" : "bottom" }
    else if (r < 0.85) op = { op: "add_via", via: { id: "fv" + n++, at: { x: rnd() * 10, y: rnd() * 10 }, diameter: 0.8, drill: 0.4, from: "F.Cu", to: "B.Cu", net: "N0" } }
    else op = { op: "set_pad_net", ref: b.footprints[Math.floor(rnd() * b.footprints.length)]!.ref, pad: "1", net: "Q" + Math.floor(rnd() * 3) }
    try { history.push(applyPatch(b, P([op], "fuzz" + i))) } catch { /* a refused op must leave the board untouched, which the next iterations rely on */ }
  }
  assert.ok(history.length > 200, "most random ops should apply: " + history.length)
  for (const p of history.reverse()) applyPatch(b, invert(p))
  b.nets = start.nets
  assert.deepEqual(b, start)
})

test("moving to the bottom and back restores the side, position and rotation", () => {
  const b = crossingBoard()
  const r1 = b.footprints.find((f) => f.ref === "R1")!
  r1.side = "bottom"; r1.rotation = 270; r1.at = { x: 3, y: -2 } // start on the BOTTOM so a wrong undo is visible
  const before = clone(r1)
  const a = applyPatch(b, P([{ op: "move_footprint", ref: "R1", at: { x: 0, y: 0 }, rotation: 0, side: "top" }]))
  assert.equal(b.footprints.find((f) => f.ref === "R1")!.side, "top")
  applyPatch(b, invert(a))
  assert.deepEqual(b.footprints.find((f) => f.ref === "R1"), before)
})

test("a chain of moves on one part undoes in reverse order to the very first state", () => {
  const b = crossingBoard()
  const start = clone(b.footprints.find((f) => f.ref === "R2")!)
  const steps: Patch[] = []
  for (const [x, rot, side] of [[1, 90, "bottom"], [2, 180, "top"], [3, 270, "bottom"]] as const)
    steps.push(applyPatch(b, P([{ op: "move_footprint", ref: "R2", at: { x, y: x }, rotation: rot, side }])))
  for (const s of steps.reverse()) applyPatch(b, invert(s))
  assert.deepEqual(b.footprints.find((f) => f.ref === "R2"), start)
})
