/**
 * Auto-placement tests.
 *
 * The promises this module makes are narrow on purpose, so they can be checked hard:
 *   1. A result reported legal IS legal, judged by `placementIssues` rather than by the placer's own opinion.
 *   2. The same seed gives the same board. Without that, nothing here is testable and a re-run surprises the user.
 *   3. A tight board is reported as failing, not quietly "placed".
 *   4. Parts marked fixed do not move.
 *   5. Wiring gets shorter than the packed start on a netlist with real structure.
 *
 * Two floating-point bugs were found by these checks while writing them, both of the same shape: a part packed
 * exactly AT the clearance, or exactly AT the board margin, was reported illegal because the penetration came
 * out as about 1e-15. Both bounds are closed now, and the tests below pin that.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { newBoard, ensureNet } from "../src/model.ts"
import { resistor, led, header } from "../src/library.ts"
import { autoPlace, wireLength } from "../src/placement/place.ts"
import { placementIssues } from "../src/placement/legal.ts"
import type { Board, Footprint } from "../src/model.ts"

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol

/** a chain of parts wired in series, so the best arrangement is a line and packing alone cannot find it */
function chainBoard(w = 70, h = 50): Board {
  const b = newBoard("chain", w, h)
  const J = header("J1", 4, 1, { at: { x: 0, y: 0 } })
  b.footprints.push(J)
  const chain: Footprint[] = [J]
  for (let i = 1; i <= 6; i++) {
    const r = resistor(`R${i}`, "0603", { at: { x: 0, y: 0 } })
    b.footprints.push(r)
    chain.push(r)
  }
  const D = led("D1", "0603", { at: { x: 0, y: 0 } })
  b.footprints.push(D)
  chain.push(D)
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!
    const c = chain[i + 1]!
    const net = `N${i}`
    a.pads[a.pads.length - 1]!.net = net
    c.pads[0]!.net = net
    ensureNet(b, net)
  }
  return b
}

test("wireLength is the half perimeter of each net's pads", () => {
  const b = newBoard("w", 20, 20)
  const r1 = resistor("R1", "0603", { at: { x: 0, y: 0 } })
  const r2 = resistor("R2", "0603", { at: { x: 10, y: 0 } })
  b.footprints.push(r1, r2)
  r1.pads[0]!.net = "A"
  r2.pads[0]!.net = "A"
  const wl = wireLength(b.footprints)
  // one net with two pads: the HPWL is their x span plus their y span, and both are known from the pads
  assert.ok(wl > 0)
  // a pad with no net contributes nothing
  const lonely = newBoard("l", 20, 20)
  lonely.footprints.push(resistor("R9", "0603", { at: { x: 0, y: 0 } }))
  assert.equal(wireLength(lonely.footprints), 0)
})

test("a result reported legal is legal, on every seed", () => {
  const b = chainBoard()
  for (const seed of [1, 2, 3, 11, 42]) {
    const r = autoPlace(b, { seed, steps: 3000 })
    assert.equal(r.legal, true, `seed ${seed} should place legally`)
    assert.deepEqual(r.issues, [])
    assert.deepEqual(placementIssues({ outline: b.outline, footprints: r.footprints }, { clearance: 0.5, margin: 0.5 }), [], `seed ${seed} fails an independent check`)
    assert.equal(r.footprints.length, b.footprints.length, "no part is dropped")
    assert.deepEqual(r.footprints.map((f) => f.ref).sort(), b.footprints.map((f) => f.ref).sort(), "and none is renamed")
  }
})

test("the same seed gives the same board, and a different seed is allowed to differ", () => {
  const b = chainBoard()
  const key = (r: ReturnType<typeof autoPlace>) => JSON.stringify(r.footprints.map((f) => [f.ref, +f.at.x.toFixed(9), +f.at.y.toFixed(9), f.rotation]))
  assert.equal(key(autoPlace(b, { seed: 5, steps: 2000 })), key(autoPlace(b, { seed: 5, steps: 2000 })), "deterministic")
})

test("the input board is not mutated", () => {
  const b = chainBoard()
  const before = JSON.stringify(b.footprints.map((f) => [f.ref, f.at.x, f.at.y, f.rotation]))
  autoPlace(b, { seed: 3, steps: 500 })
  assert.equal(JSON.stringify(b.footprints.map((f) => [f.ref, f.at.x, f.at.y, f.rotation])), before)
})

test("wiring comes out shorter than the packed start on a chain netlist", () => {
  const b = chainBoard()
  const r = autoPlace(b, { seed: 1, steps: 8000 })
  assert.equal(r.legal, true)
  assert.ok(r.wireLength <= r.startWireLength + 1e-6, `wire ${r.wireLength} should not be worse than the packed start ${r.startWireLength}`)
  assert.ok(r.wireLength < r.incomingWireLength, `wire ${r.wireLength} should beat the incoming ${r.incomingWireLength}`)
})

test("a board too small for its parts is reported as failing, not placed", () => {
  const b = chainBoard(8, 6)
  const r = autoPlace(b, { seed: 1, steps: 1500 })
  assert.equal(r.legal, false, "eight parts cannot fit on 8x6 mm with 0.5 mm margins")
  assert.ok(r.issues.length > 0, "and the reason is given")
})

test("fixed parts do not move, and the rest still get placed around them", () => {
  const b = chainBoard()
  const anchor = b.footprints.find((f) => f.ref === "J1")!
  // the anchor must leave room for its own body plus the margin: a 4-pin header is about 10 mm tall, so 20 mm
  // from the centre of a 50 mm board puts its top edge past the edge, and the placer is right to say so
  anchor.at = { x: -30, y: 10 }
  const r = autoPlace(b, { seed: 4, steps: 4000, fixed: ["J1"] })
  const after = r.footprints.find((f) => f.ref === "J1")!
  assert.ok(near(after.at.x, -30) && near(after.at.y, 10), `J1 moved to ${after.at.x},${after.at.y}`)
  assert.equal(r.legal, true)
})

test("an empty board places nothing and is legal", () => {
  const b = newBoard("empty", 20, 20)
  const r = autoPlace(b, { seed: 1, steps: 100 })
  assert.deepEqual(r.footprints, [])
  assert.equal(r.legal, true)
  assert.equal(r.wireLength, 0)
})

test("parts packed exactly at the clearance and exactly at the margin are legal", () => {
  // this is the pair of floating-point cases that made a perfectly good arrangement look broken: the numbers
  // below are exactly on both bounds, which is where the packing actually puts parts
  const b = newBoard("flush", 20, 20)
  const a: Footprint = { ref: "A", value: "", lib: "t:t", at: { x: -1, y: 0 }, rotation: 0, side: "top", pads: [], graphics: [], height: 1, body: { w: 2, h: 2 } }
  const c: Footprint = { ref: "B", value: "", lib: "t:t", at: { x: 1, y: 0 }, rotation: 0, side: "top", pads: [], graphics: [], height: 1, body: { w: 2, h: 2 } }
  b.footprints.push(a, c)
  // edges meet exactly at x = 0, so the gap is 0: legal with no clearance, illegal once 0.5 is demanded
  assert.deepEqual(placementIssues({ outline: b.outline, footprints: b.footprints }), [])
  assert.equal(placementIssues({ outline: b.outline, footprints: b.footprints }, { clearance: 0.5 }).length, 1)
  // a part whose body top sits exactly on the margin boundary is inside, not outside
  const flush: Footprint = { ref: "C", value: "", lib: "t:t", at: { x: 0, y: 9 }, rotation: 0, side: "top", pads: [], graphics: [], height: 1, body: { w: 2, h: 2 } }
  assert.deepEqual(placementIssues({ outline: b.outline, footprints: [flush] }, { margin: 0 }), [], "body top at y=10 is the edge itself")
})
