import test from "node:test"
import assert from "node:assert/strict"
import { circle, capsule, rect, poly, oval, distance, ptSeg, segSeg, segsIntersect, pointInPoly, bounds } from "../src/drc/shapes.ts"

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`)
const P = (x: number, y: number) => ({ x, y })

test("circle-circle", () => {
  near(distance(circle(P(0, 0), 1), circle(P(5, 0), 1)), 3)
  assert.equal(distance(circle(P(0, 0), 1), circle(P(1.5, 0), 1)), 0) // overlapping
  assert.equal(distance(circle(P(0, 0), 1), circle(P(2, 0), 1)), 0) // touching
})

test("circle-capsule", () => {
  near(distance(circle(P(0, 3), 0.5), capsule(P(-5, 0), P(5, 0), 0.5)), 2)
  near(distance(circle(P(8, 0), 0.5), capsule(P(-5, 0), P(5, 0), 0.5)), 2) // beyond the end cap
})

test("capsule-capsule: parallel, crossing, end-to-end", () => {
  near(distance(capsule(P(0, 0), P(10, 0), 0.1), capsule(P(0, 1), P(10, 1), 0.1)), 0.8)
  assert.equal(distance(capsule(P(0, 0), P(10, 0), 0.1), capsule(P(5, -5), P(5, 5), 0.1)), 0)
  near(distance(capsule(P(0, 0), P(1, 0), 0.1), capsule(P(2, 0), P(3, 0), 0.1)), 0.8)
})

test("rect-circle, including centre inside and a corner approach", () => {
  const r = rect(P(0, 0), 2, 2)
  assert.equal(distance(circle(P(0, 0), 0.1), r), 0)
  near(distance(circle(P(3, 0), 0.5), r), 1.5)
  near(distance(circle(P(2, 2), 0), r), Math.SQRT2) // diagonal from corner
})

test("rotated rect: a 45 degree square of side 2 has half diagonal 1.414", () => {
  const r = rect(P(0, 0), 2, 2, 45)
  near(bounds(r).maxX, Math.SQRT2, 1e-9)
  near(distance(circle(P(3, 0), 0), r), 3 - Math.SQRT2)
})

test("rect-rect separation and overlap", () => {
  near(distance(rect(P(0, 0), 2, 2), rect(P(5, 0), 2, 2)), 3)
  assert.equal(distance(rect(P(0, 0), 2, 2), rect(P(1, 1), 2, 2)), 0)
  assert.equal(distance(rect(P(0, 0), 10, 10), rect(P(0, 0), 1, 1)), 0) // one inside the other
})

test("capsule-poly: through the middle and passing by", () => {
  assert.equal(distance(capsule(P(-5, 0), P(5, 0), 0.1), rect(P(0, 0), 1, 1)), 0)
  near(distance(capsule(P(-5, 2), P(5, 2), 0.1), rect(P(0, 0), 1, 1)), 1.4)
})

test("oval pads: round when w==h, otherwise a capsule on the long axis", () => {
  assert.equal(oval(P(0, 0), 2, 2).kind, "circle")
  const o = oval(P(0, 0), 4, 2) as any
  assert.equal(o.kind, "capsule")
  near(o.r, 1)
  near(Math.abs(o.a.x - o.b.x), 2) // long axis along x, half-length (4-2)/2 each side
  const v = oval(P(0, 0), 2, 4) as any
  near(Math.abs(v.a.y - v.b.y), 2) // taller than wide runs along y
})

test("segment helpers", () => {
  near(ptSeg(P(0, 1), P(-1, 0), P(1, 0)), 1)
  near(ptSeg(P(3, 0), P(-1, 0), P(1, 0)), 2)
  near(ptSeg(P(1, 1), P(0, 0), P(0, 0)), Math.SQRT2) // zero-length segment
  assert.equal(segsIntersect(P(0, 0), P(2, 2), P(0, 2), P(2, 0)), true)
  assert.equal(segsIntersect(P(0, 0), P(1, 0), P(0, 1), P(1, 1)), false)
  assert.equal(segsIntersect(P(0, 0), P(2, 0), P(1, 0), P(3, 0)), true) // collinear overlap
  near(segSeg(P(0, 0), P(1, 0), P(0, 1), P(1, 1)), 1)
})

test("pointInPoly on a concave L shape", () => {
  const L = [P(0, 0), P(4, 0), P(4, 1), P(1, 1), P(1, 4), P(0, 4)]
  assert.equal(pointInPoly(P(0.5, 3), L), true)
  assert.equal(pointInPoly(P(3, 3), L), false) // inside the notch
  assert.equal(pointInPoly(P(3, 0.5), L), true)
  assert.ok(poly(L).pts.length === 6)
})

test("distance is symmetric across every shape pairing", () => {
  const shapes = [circle(P(0, 0), 1), capsule(P(3, 3), P(6, 3), 0.4), rect(P(-4, 2), 2, 3, 30), rect(P(5, -4), 1, 1)]
  for (const a of shapes) for (const b of shapes) near(distance(a, b), distance(b, a))
})
