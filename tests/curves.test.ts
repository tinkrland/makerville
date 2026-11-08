import test from "node:test"
import assert from "node:assert/strict"
import { lineCurve, circleCurve, ellipseCurve, bsplineCurve, expandKnots, wrapAngle, arcLength } from "../src/step/curves.ts"
import { frameFrom, dist, type V3 } from "../src/step/vec.ts"

const near = (a: number, b: number, e = 1e-9, m = "") => assert.ok(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`)
const nearV = (a: V3, b: V3, e = 1e-9, m = "") => assert.ok(dist(a, b) <= e, `${m} [${a}] vs [${b}]`)
const XY = frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0])

test("line: point, parameter in units of the vector magnitude, closest point", () => {
  const l = lineCurve([1, 1, 1], [0, 0, 1], 2.5) // STEP: direction is unit, magnitude scales t
  nearV(l.at(0), [1, 1, 1]); nearV(l.at(2), [1, 1, 6])
  near(l.closest([9, 9, 6]), 2)
  near(l.closest([1, 1, 1]), 0); near(l.closest([1, 1, -1.5]), -1)
  assert.deepEqual(l.range, [-Infinity, Infinity])
})
test("line: a zero direction is refused", () => assert.throws(() => lineCurve([0, 0, 0], [0, 0, 1], 0), /zero length/))

test("circle: every sampled point is exactly radius r from the centre and lies in the plane", () => {
  const f = frameFrom([3, -2, 5], [1, 1, 1], null)
  const c = circleCurve(f, 4.5)
  for (let i = 0; i < 50; i++) {
    const p = c.at((i / 50) * Math.PI * 2)
    near(dist(p, f.o), 4.5, 1e-12)
    near((p[0] - f.o[0]) * f.z[0] + (p[1] - f.o[1]) * f.z[1] + (p[2] - f.o[2]) * f.z[2], 0, 1e-12, "in plane")
  }
  assert.equal(c.kind, "circle"); assert.ok(c.periodic)
})
test("circle: closest() inverts at() for every angle, including across the wrap", () => {
  const c = circleCurve(XY, 2)
  for (const t of [0, 0.1, 1, 2, 3, 3.14, 4, 5, 6, 6.28]) near(c.closest(c.at(t)), wrapAngle(t), 1e-12)
  near(c.closest([10, 0, 7]), 0); near(c.closest([0, 5, -1]), Math.PI / 2)
})
test("circle: closest() of an off-curve point lies on the ray through it", () => {
  const c = circleCurve(XY, 3)
  const t = c.closest([-6, 6, 2]); nearV(c.at(t), [-3 * Math.SQRT1_2, 3 * Math.SQRT1_2, 0], 1e-12)
})
test("circle: non-positive radius refused", () => { assert.throws(() => circleCurve(XY, 0), /positive/); assert.throws(() => circleCurve(XY, -1), /positive/) })

test("ellipse: points satisfy x^2/a^2 + y^2/b^2 = 1 in the local frame", () => {
  const e = ellipseCurve(XY, 5, 2)
  for (let i = 0; i < 40; i++) { const p = e.at((i / 40) * 6.283185); near((p[0] / 5) ** 2 + (p[1] / 2) ** 2, 1, 1e-12) }
  assert.equal(e.kind, "ellipse")
})
test("ellipse: closest() finds the true foot point (compare to brute force)", () => {
  const e = ellipseCurve(XY, 5, 2)
  for (const q of [[1, 1, 0], [7, 3, 0], [-2, 0.5, 0], [0, -6, 0], [4.9, 0.1, 0], [0, 0, 0.0001]] as V3[]) {
    let best = Infinity
    for (let i = 0; i <= 200000; i++) best = Math.min(best, dist(e.at((i / 200000) * Math.PI * 2), q))
    near(dist(e.at(e.closest(q)), q), best, 1e-6, `q=${q}`)
  }
})
test("ellipse: a=b is reported as a circle", () => assert.equal(ellipseCurve(XY, 3, 3).kind, "circle"))

test("wrapAngle", () => { near(wrapAngle(-0.5), Math.PI * 2 - 0.5); near(wrapAngle(7), 7 - Math.PI * 2); near(wrapAngle(0), 0) })

// ---------- B-splines
test("expandKnots expands multiplicities and refuses mismatched or descending input", () => {
  assert.deepEqual(expandKnots([0, 1, 2], [3, 1, 3]), [0, 0, 0, 1, 2, 2, 2])
  assert.throws(() => expandKnots([0, 1], [3]), /2 knots but 1 multiplicities/)
  assert.throws(() => expandKnots([1, 0], [2, 2]), /ascending/)
})

const STRAIGHT = bsplineCurve({ degree: 3, points: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], knots: [0, 1], mults: [4, 4] })
test("B-spline: interpolates its end points and reproduces a straight line", () => {
  nearV(STRAIGHT.at(0), [0, 0, 0]); nearV(STRAIGHT.at(1), [3, 0, 0])
  for (let i = 0; i <= 20; i++) nearV(STRAIGHT.at(i / 20), [(3 * i) / 20, 0, 0], 1e-12)
})
test("B-spline: t outside the range clamps to the ends", () => { nearV(STRAIGHT.at(-5), [0, 0, 0]); nearV(STRAIGHT.at(9), [3, 0, 0]) })

test("B-spline: cubic Bezier matches the closed-form Bernstein polynomial", () => {
  const P: V3[] = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 2]]
  const c = bsplineCurve({ degree: 3, points: P, knots: [0, 1], mults: [4, 4] })
  for (let i = 0; i <= 30; i++) {
    const t = i / 30, u = 1 - t
    const w = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3]
    const want = [0, 1, 2].map((k) => w.reduce((s, wi, j) => s + wi * P[j]![k]!, 0)) as V3
    nearV(c.at(t), want, 1e-12)
  }
})

test("B-spline: a multi-span uniform quadratic matches a hand-evaluated point", () => {
  // degree 2, points A..E, knots 0,0,0,1,2,3,3,3. At t=1.5 the active basis is on span [1,2]
  const P: V3[] = [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0], [4, 0, 0]]
  const c = bsplineCurve({ degree: 2, points: P, knots: [0, 1, 2, 3], mults: [3, 1, 1, 3] })
  // by hand (de Boor): span index k=3 (U3=1 <= 1.5 < U4=2). Blend of P1,P2,P3 with N = [(1-s)^2/2, (-2s^2+2s+1)/2, s^2/2], s=0.5
  const s = 0.5, N = [((1 - s) ** 2) / 2, (-2 * s * s + 2 * s + 1) / 2, (s * s) / 2]
  const want: V3 = [0, 1, 2].map((k) => N[0]! * P[1]![k]! + N[1]! * P[2]![k]! + N[2]! * P[3]![k]!) as V3
  nearV(c.at(1.5), want, 1e-12)
  nearV(c.at(0), P[0]!); nearV(c.at(3), P[4]!)
})

test("B-spline: a rational quadratic with weights 1, sqrt(2)/2, 1 is exactly a quarter circle", () => {
  const w = Math.SQRT1_2
  const c = bsplineCurve({ degree: 2, points: [[1, 0, 0], [1, 1, 0], [0, 1, 0]], weights: [1, w, 1], knots: [0, 1], mults: [3, 3] })
  for (let i = 0; i <= 50; i++) near(Math.hypot(...(c.at(i / 50).slice(0, 2) as [number, number])), 1, 1e-12, "radius")
  near(arcLength(c, 0, 1, 4000), Math.PI / 2, 1e-6, "arc length")
})
test("B-spline: unit weights give the same curve as no weights", () => {
  const P: V3[] = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 2]]
  const a = bsplineCurve({ degree: 3, points: P, knots: [0, 1], mults: [4, 4] })
  const b = bsplineCurve({ degree: 3, points: P, weights: [1, 1, 1, 1], knots: [0, 1], mults: [4, 4] })
  for (let i = 0; i <= 10; i++) nearV(a.at(i / 10), b.at(i / 10), 1e-14)
})
test("B-spline: scaling every weight by a constant changes nothing", () => {
  const P: V3[] = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 2]], W = [1, 2, 0.5, 3]
  const a = bsplineCurve({ degree: 3, points: P, weights: W, knots: [0, 1], mults: [4, 4] })
  const b = bsplineCurve({ degree: 3, points: P, weights: W.map((x) => x * 7), knots: [0, 1], mults: [4, 4] })
  for (let i = 0; i <= 10; i++) nearV(a.at(i / 10), b.at(i / 10), 1e-12)
})
test("B-spline: a heavier weight pulls the curve toward its control point", () => {
  const P: V3[] = [[0, 0, 0], [1, 2, 0], [3, 2, 0], [4, 0, 0]]
  const lo = bsplineCurve({ degree: 3, points: P, weights: [1, 1, 1, 1], knots: [0, 1], mults: [4, 4] })
  const hi = bsplineCurve({ degree: 3, points: P, weights: [1, 5, 1, 1], knots: [0, 1], mults: [4, 4] })
  assert.ok(dist(hi.at(0.4), P[1]!) < dist(lo.at(0.4), P[1]!))
})
test("B-spline: closest() inverts at() across a curved spline", () => {
  const c = bsplineCurve({ degree: 3, points: [[0, 0, 0], [1, 2, 0], [3, 2, 0], [4, 0, 0]], knots: [0, 1], mults: [4, 4] })
  for (let i = 0; i <= 40; i++) near(c.closest(c.at(i / 40)), i / 40, 1e-9)
})
test("B-spline: closest() on a non-uniform knot range reports parameters in that range", () => {
  const c = bsplineCurve({ degree: 1, points: [[0, 0, 0], [10, 0, 0]], knots: [2, 6], mults: [2, 2] })
  near(c.closest([5, 3, 0]), 4, 1e-9); assert.deepEqual(c.range, [2, 6])
})

test("B-spline: invalid definitions are refused with a message that names the problem", () => {
  const P: V3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]]
  assert.throws(() => bsplineCurve({ degree: 0, points: P, knots: [0, 1], mults: [1, 1] }), /degree must be at least 1/)
  assert.throws(() => bsplineCurve({ degree: 5, points: P, knots: [0, 1], mults: [6, 6] }), /needs at least 6 control points/)
  assert.throws(() => bsplineCurve({ degree: 3, points: P, knots: [0, 1], mults: [3, 4] }), /knot vector has 7 entries but 4 points of degree 3 need 8/)
  assert.throws(() => bsplineCurve({ degree: 3, points: P, weights: [1, 1], knots: [0, 1], mults: [4, 4] }), /weights and control points differ/)
  assert.throws(() => bsplineCurve({ degree: 3, points: P, weights: [1, 0, 1, 1], knots: [0, 1], mults: [4, 4] }), /weights must be positive/)
})

test("arcLength of a line segment and of a circle", () => {
  near(arcLength(lineCurve([0, 0, 0], [1, 0, 0], 1), 0, 7), 7, 1e-12)
  near(arcLength(circleCurve(XY, 2), 0, Math.PI * 2, 20000), 4 * Math.PI, 1e-6)
})

// Regression/hardening: evaluating exactly at the end of the range must not enter the span search.
// With a strict `>` in findSpan the binary search never terminates when t equals the last knot.
test("B-spline: evaluating exactly at the start and end of a multi-span curve terminates and returns the end points", () => {
  const P: V3[] = [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0], [4, 0, 0]]
  const clamped = bsplineCurve({ degree: 2, points: P, knots: [0, 1, 2, 3], mults: [3, 1, 1, 3] })
  nearV(clamped.at(3), [4, 0, 0]); nearV(clamped.at(0), [0, 0, 0])
  // an unclamped (uniform) spline: its valid range is [U[p], U[n+1]], strictly inside the knot vector
  const open = bsplineCurve({ degree: 2, points: P, knots: [0, 1, 2, 3, 4, 5, 6, 7], mults: [1, 1, 1, 1, 1, 1, 1, 1] })
  assert.deepEqual(open.range, [2, 5])
  nearV(open.at(5), [3.5, 0.5, 0]); nearV(open.at(2), [0.5, 0.5, 0])
})
test("B-spline: every knot value, exactly, including interior knots of multiplicity > 1", () => {
  const P: V3[] = [[0, 0, 0], [1, 2, 0], [2, 0, 0], [3, 2, 0], [4, 0, 0], [5, 2, 0]]
  const c = bsplineCurve({ degree: 2, points: P, knots: [0, 1, 2, 3], mults: [3, 2, 1, 3] }) // 9 knots = 6 + 2 + 1
  for (const t of [0, 1, 2, 3]) assert.ok(Number.isFinite(c.at(t)[0]), `t=${t}`)
  nearV(c.at(0), P[0]!); nearV(c.at(3), P[5]!)
  // an interior knot of multiplicity = degree makes the curve touch a control point
  nearV(c.at(1), P[2]!, 1e-12, "C0 at the double interior knot")
})
