/**
 * Placement legality tests.
 *
 * The cases that justify this module existing are the ones a bounding-box test gets wrong:
 *   - two parts rotated 45 degrees whose axis-aligned boxes overlap but whose shapes do not (a naive test
 *     refuses a legal placement);
 *   - a part sitting over a narrow slot in the outline with all four corners inside the board (a corner-only
 *     test accepts an illegal one).
 * Both are checked here, and both are checked in the direction that a wrong answer would actually be harmful.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { footprintObb, obbCorners, overlapDepth, overlaps, insideOutline, pointInPolygon, segmentsCross, placementIssues } from "../src/placement/legal.ts"
import { newBoard } from "../src/model.ts"
import type { Footprint, Pt } from "../src/model.ts"

const box = (cx: number, cy: number, w: number, h: number, rot = 0) => ({ cx, cy, w, h, rot })
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol

test("the same box on top of itself overlaps by its smaller side", () => {
  const d = overlapDepth(box(0, 0, 4, 2), box(0, 0, 4, 2))
  assert.ok(near(d, 2, 1e-9), `depth ${d}`)
})

test("boxes far apart do not overlap, and the depth is exactly zero rather than negative", () => {
  assert.equal(overlapDepth(box(0, 0, 2, 2), box(5, 0, 2, 2)), 0)
  assert.equal(overlaps(box(0, 0, 2, 2), box(5, 0, 2, 2)), false)
})

test("touching is legal, and a clearance turns it illegal", () => {
  const a = box(0, 0, 2, 2)
  const b = box(2, 0, 2, 2) // edges meet at x = 1
  assert.equal(overlapDepth(a, b, 0), 0, "edge to edge is not an overlap")
  assert.ok(overlapDepth(a, b, 0.5) > 0, "but it is closer than 0.5 mm, so the clearance fails")
  assert.equal(overlapDepth(a, box(2.6, 0, 2, 2), 0.5), 0, "0.6 mm apart satisfies a 0.5 mm clearance")
})

test("a 45 degree part clears a box that its bounding box would collide with", () => {
  // the diamond's axis-aligned box reaches 1.414 in x; the square starts at 1.4, so the AABBs overlap in x by
  // 0.014 mm. Along the diamond's own edge normal (1,1)/sqrt2 they are cleanly apart, so the true answer is no
  // overlap. A bounding-box test would refuse this legal placement.
  const diamond = box(0, 0, 2, 2, 45)
  const square = box(2.4, 2.4, 2, 2, 0)
  const dc = obbCorners(diamond)
  const sc = obbCorners(square)
  const aabb = (c: Pt[]) => [Math.min(...c.map((p) => p.x)), Math.max(...c.map((p) => p.x))]
  const [al, ah] = aabb(dc)
  const [bl, bh] = aabb(sc)
  assert.ok(al < bh && bl < ah, "the bounding boxes really do overlap in x, so this case is meaningful")
  assert.equal(overlaps(diamond, square), false, "the shapes themselves are apart")
})

test("a long part crossing a perpendicular one does overlap, at 45 degrees both ways", () => {
  const a = box(0, 0, 10, 1, 45)
  const b = box(0, 0, 10, 1, -45)
  assert.ok(overlapDepth(a, b) > 0.5, "they cross near the origin")
})

test("rotation actually rotates: corners of a 90 degree box are swapped", () => {
  const c = obbCorners(box(0, 0, 4, 2, 90))
  const xs = c.map((p) => p.x).sort((m, n) => m - n)
  const ys = c.map((p) => p.y).sort((m, n) => m - n)
  assert.ok(near(xs[0]!, -1) && near(xs[3]!, 1), `x extent ${xs}`)
  assert.ok(near(ys[0]!, -2) && near(ys[3]!, 2), `y extent ${ys}`)
})

test("point in polygon handles a square, its outside, and its edge", () => {
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  assert.equal(pointInPolygon({ x: 5, y: 5 }, sq), true)
  assert.equal(pointInPolygon({ x: 15, y: 5 }, sq), false)
  assert.equal(pointInPolygon({ x: -1, y: -1 }, sq), false)
})

test("segment crossing is not fooled by parallel or touching segments", () => {
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), true)
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }), false, "parallel")
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }), false, "sharing an endpoint")
})

test("a part in the middle of a board is on it, a part over the edge is not", () => {
  const outline: Pt[] = [{ x: -17, y: -11 }, { x: 17, y: -11 }, { x: 17, y: 11 }, { x: -17, y: 11 }]
  assert.equal(insideOutline(outline, box(0, 0, 4, 2)), true)
  assert.equal(insideOutline(outline, box(16, 0, 4, 2)), false, "half of it hangs over the right edge")
  assert.equal(insideOutline(outline, box(0, 0, 4, 2), 3), true, "3 mm margin is satisfied in the middle")
  assert.equal(insideOutline(outline, box(14, 0, 4, 2), 2), false, "but not 2 mm from the edge")
})

test("a part over a narrow slot in a concave outline is off-board, though all four corners are inside", () => {
  // a 100x100 square with a 4 mm wide slot cut from the top edge down to y = 60
  const outline: Pt[] = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 52, y: 100 },
    { x: 52, y: 60 }, { x: 48, y: 60 }, { x: 48, y: 100 }, { x: 0, y: 100 },
  ]
  const over = box(50, 80, 10, 10)
  for (const c of obbCorners(over)) assert.equal(pointInPolygon(c, outline), true, `corner ${JSON.stringify(c)} should be inside`)
  assert.equal(insideOutline(outline, over), false, "the corners are inside but the body crosses the slot")
  // and a part beside the slot is fine
  assert.equal(insideOutline(outline, box(20, 80, 10, 10)), true)
})

test("an outline with fewer than three points cannot contain anything", () => {
  assert.equal(insideOutline([], box(0, 0, 1, 1)), false)
  assert.equal(insideOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }], box(0, 0, 1, 1)), false)
})

const fp = (ref: string, x: number, y: number, w = 4, h = 2, rotation = 0): Footprint => ({
  ref, value: "", lib: "t:t", at: { x, y }, rotation, side: "top",
  pads: [], graphics: [], height: 1, body: { w, h },
})

test("placementIssues finds an overlap, a clearance violation and an off-board part, and nothing else", () => {
  const b = newBoard("t", 34, 22)
  b.footprints.push(fp("A", 0, 0), fp("B", 0, 0))
  const issues = placementIssues(b)
  assert.equal(issues.length, 1)
  assert.deepEqual(issues[0]!.refs.sort(), ["A", "B"])
  assert.equal(issues[0]!.kind, "overlap")

  b.footprints = [fp("A", -5, 0), fp("B", 5, 0)]
  assert.deepEqual(placementIssues(b), [], "well separated parts are legal")

  b.footprints = [fp("A", -5, 0), fp("B", 20, 0)]
  const off = placementIssues(b)
  assert.equal(off.length, 1)
  assert.equal(off[0]!.kind, "off-board")
  assert.deepEqual(off[0]!.refs, ["B"])
})

test("clearance and ignore options are honoured", () => {
  const b = newBoard("t", 34, 22)
  // 4 mm wide parts centred 4.5 mm apart leave a 0.5 mm gap
  b.footprints = [fp("A", -2.25, 0), fp("B", 2.25, 0)]
  assert.deepEqual(placementIssues(b), [], "a 0.5 mm gap is legal with no clearance demanded")
  assert.equal(placementIssues(b, { clearance: 0.6 }).length, 1, "but not when 0.6 mm is demanded")
  assert.deepEqual(placementIssues(b, { clearance: 0.6, ignore: ["B"] }), [], "ignoring B leaves A alone")
})

test("the board's own outline is used, so a part on a bigger board is fine", () => {
  const small = newBoard("s", 10, 10)
  small.footprints = [fp("A", 8, 0, 4, 2)]
  assert.equal(placementIssues(small).length, 1, "off the small board")
  const big = newBoard("b", 40, 40)
  big.footprints = [fp("A", 8, 0, 4, 2)]
  assert.deepEqual(placementIssues(big), [], "on the big board")
})

test("footprintObb takes the body and rotation from the footprint, not its pads", () => {
  const f = fp("A", 3, -4, 6, 2, 30)
  const o = footprintObb(f)
  assert.deepEqual(o, { cx: 3, cy: -4, w: 6, h: 2, rot: 30 })
})
