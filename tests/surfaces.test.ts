import test from "node:test"
import assert from "node:assert/strict"
import { planeSurface, cylinderSurface, coneSurface, sphereSurface, torusSurface, bsplineSurface, type Surface } from "../src/step/surfaces.ts"
import { frameFrom, dist, dot, sub, len, scale, add, toLocal, type V3 } from "../src/step/vec.ts"

const near = (a: number, b: number, e = 1e-9, m = "") => assert.ok(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`)
const nearV = (a: V3, b: V3, e = 1e-9, m = "") => assert.ok(dist(a, b) <= e, `${m} [${a}] vs [${b}]`)
const TILT = frameFrom([1, -2, 3], [1, 2, 2], [0, 0, 1]) // an awkward, tilted, offset frame
const ID = frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0])

/** the three universal properties, checked on a grid of (u,v): project inverts at, normal is unit, normal is perpendicular to the surface */
function universal(name: string, s: Surface, us: number[], vs: number[], eps = 1e-6) {
  for (const u of us) for (const v of vs) {
    const p = s.at(u, v)
    const [pu, pv] = s.project(p)
    // parameters may differ by a period, so compare the POINTS they give
    nearV(s.at(pu, pv), p, 1e-7, `${name} project(at(${u},${v}))`)
    const n = s.normal(u, v)
    near(len(n), 1, 1e-9, `${name} |normal|`)
    const tu = sub(s.at(u + eps, v), s.at(u - eps, v)), tv = sub(s.at(u, v + eps), s.at(u, v - eps))
    near(dot(n, tu) / (len(tu) || 1), 0, 1e-5, `${name} normal . du at (${u},${v})`)
    near(dot(n, tv) / (len(tv) || 1), 0, 1e-5, `${name} normal . dv at (${u},${v})`)
  }
}

test("plane: lengths along the frame axes; normal is the frame Z; project is the local XY", () => {
  const s = planeSurface(TILT)
  nearV(s.at(2, 3), add(add(TILT.o, scale(TILT.x, 2)), scale(TILT.y, 3)))
  nearV(s.normal(0, 0), TILT.z)
  const [u, v] = s.project(add(add(TILT.o, scale(TILT.x, -4)), add(scale(TILT.y, 5), scale(TILT.z, 9)))) // off-plane points project straight down
  near(u, -4); near(v, 5)
  universal("plane", s, [-3, 0, 2.5], [-1, 0, 7])
})

test("cylinder: every point is radius r from the axis; the normal points away from it", () => {
  const s = cylinderSurface(TILT, 2.5)
  for (let i = 0; i < 12; i++) for (const v of [-3, 0, 4]) {
    const p = s.at((i / 12) * 6.2832, v)
    const l = toLocal(TILT, p)
    near(Math.hypot(l[0], l[1]), 2.5, 1e-12); near(l[2], v, 1e-12)
    assert.ok(dot(s.normal((i / 12) * 6.2832, v), sub(p, add(TILT.o, scale(TILT.z, v)))) > 0, "outward")
  }
  universal("cylinder", s, [0, 1, 2, 3, 4, 5, 6], [-2, 0, 3])
  assert.equal(s.uPeriod, Math.PI * 2)
})

test("cone: radius grows as r + v tan(a); normal is perpendicular to the slant", () => {
  const s = coneSurface(ID, 1, 0.3)
  for (const v of [-0.5, 0, 1, 4]) near(Math.hypot(...(s.at(0.7, v).slice(0, 2) as [number, number])), 1 + v * Math.tan(0.3), 1e-12)
  universal("cone", s, [0, 1, 2, 4, 6], [-0.5, 0, 1, 3])
  universal("cone tilted", coneSurface(TILT, 2, -0.5), [0.2, 1.5, 3, 5], [0, 1, 2])
})
test("cone: a zero reference radius is a valid apex cone", () => { const s = coneSurface(ID, 0, 0.5); nearV(s.at(1, 0), [0, 0, 0]); near(Math.hypot(...(s.at(0, 2).slice(0, 2) as [number, number])), 2 * Math.tan(0.5), 1e-12) })

test("sphere: every point is radius r from the centre; normal is the radial direction", () => {
  const s = sphereSurface(TILT, 3)
  for (const u of [0, 1, 2, 3, 4, 5]) for (const v of [-1.4, -0.5, 0, 0.7, 1.4]) {
    const p = s.at(u, v)
    near(dist(p, TILT.o), 3, 1e-12)
    nearV(s.normal(u, v), scale(sub(p, TILT.o), 1 / 3), 1e-12)
  }
  universal("sphere", s, [0.3, 1.7, 3.1, 5], [-1.2, 0, 1.2])
})

test("torus: distance from the tube centre circle is the minor radius; normal points away from the tube centre", () => {
  const s = torusSurface(TILT, 5, 1.2)
  for (const u of [0, 1.5, 3, 4.5]) for (const v of [0, 1, 2.5, 4, 5.5]) {
    const p = s.at(u, v), l = toLocal(TILT, p)
    near(Math.hypot(Math.hypot(l[0], l[1]) - 5, l[2]), 1.2, 1e-12)
  }
  universal("torus", s, [0.3, 1.7, 3.1, 5], [0.2, 1.3, 2.6, 4, 5.5])
  assert.equal(s.vPeriod, Math.PI * 2)
})

test("analytic surfaces refuse impossible dimensions", () => {
  assert.throws(() => cylinderSurface(ID, 0), /positive/); assert.throws(() => cylinderSurface(ID, -1), /positive/)
  assert.throws(() => sphereSurface(ID, 0), /positive/); assert.throws(() => torusSurface(ID, 0, 1), /positive/); assert.throws(() => torusSurface(ID, 1, 0), /positive/)
  assert.throws(() => coneSurface(ID, -1, 0.3), /not be negative/); assert.throws(() => coneSurface(ID, 1, 0), /semi-angle/); assert.throws(() => coneSurface(ID, 1, Math.PI / 2), /semi-angle/)
})

// ---------- B-spline surfaces
const FLAT = (): Parameters<typeof bsplineSurface>[0] => ({
  uDegree: 1, vDegree: 1,
  points: [[[0, 0, 0], [0, 4, 0]], [[6, 0, 0], [6, 4, 0]]],
  uKnots: [0, 1], uMults: [2, 2], vKnots: [0, 1], vMults: [2, 2],
})
test("B-spline surface: a bilinear patch is the rectangle it spans", () => {
  const s = bsplineSurface(FLAT())
  nearV(s.at(0, 0), [0, 0, 0]); nearV(s.at(1, 1), [6, 4, 0]); nearV(s.at(0.5, 0.5), [3, 2, 0]); nearV(s.at(1, 0), [6, 0, 0])
  nearV(s.normal(0.3, 0.6), [0, 0, 1])
  const [u, v] = s.project([4.5, 1, 2]); near(u, 0.75, 1e-9); near(v, 0.25, 1e-9)
})

/** a bicubic Bezier patch, checked against the explicit Bernstein double sum */
const BUMP = (): Parameters<typeof bsplineSurface>[0] => {
  const pts: V3[][] = []
  for (let i = 0; i < 4; i++) { pts.push([]); for (let j = 0; j < 4; j++) pts[i]!.push([i, j, (i === 1 || i === 2) && (j === 1 || j === 2) ? 2 : 0]) }
  return { uDegree: 3, vDegree: 3, points: pts, uKnots: [0, 1], uMults: [4, 4], vKnots: [0, 1], vMults: [4, 4] }
}
const bern = (t: number) => [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3]
test("B-spline surface: a bicubic Bezier patch matches the Bernstein double sum", () => {
  const d = BUMP(), s = bsplineSurface(d)
  for (const u of [0, 0.2, 0.5, 0.9, 1]) for (const v of [0, 0.3, 0.5, 0.8, 1]) {
    const bu = bern(u), bv = bern(v)
    let want: V3 = [0, 0, 0]
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) want = add(want, scale(d.points[i]![j]!, bu[i]! * bv[j]!))
    nearV(s.at(u, v), want, 1e-12, `(${u},${v})`)
  }
})
test("B-spline surface: universal properties on a curved patch", () => universal("bspline", bsplineSurface(BUMP()), [0.15, 0.4, 0.7, 0.9], [0.2, 0.5, 0.85], 1e-5))

test("B-spline surface: a rational patch makes an exact cylinder section (quarter circle swept along z)", () => {
  const w = Math.SQRT1_2
  const s = bsplineSurface({
    uDegree: 2, vDegree: 1,
    points: [[[1, 0, 0], [1, 0, 5]], [[1, 1, 0], [1, 1, 5]], [[0, 1, 0], [0, 1, 5]]],
    weights: [[1, 1], [w, w], [1, 1]],
    uKnots: [0, 1], uMults: [3, 3], vKnots: [0, 1], vMults: [2, 2],
  })
  for (let i = 0; i <= 20; i++) for (const v of [0, 0.5, 1]) { const p = s.at(i / 20, v); near(Math.hypot(p[0], p[1]), 1, 1e-12, "radius"); near(p[2], 5 * v, 1e-12) }
  universal("rational", s, [0.2, 0.5, 0.8], [0.3, 0.7], 1e-5)
})

test("B-spline surface: invalid definitions are refused with a named problem", () => {
  const f = FLAT()
  assert.throws(() => bsplineSurface({ ...f, uDegree: 0 }), /degrees must be at least 1/)
  assert.throws(() => bsplineSurface({ ...f, uDegree: 3, uMults: [4, 4] }), /needs at least 4x2 control points/)
  assert.throws(() => bsplineSurface({ ...f, points: [[[0, 0, 0], [0, 4, 0]], [[6, 0, 0]]] }), /ragged/)
  assert.throws(() => bsplineSurface({ ...f, uMults: [2, 3] }), /u knot vector has 5 entries/)
  assert.throws(() => bsplineSurface({ ...f, vMults: [3, 2] }), /v knot vector has 5 entries/)
  assert.throws(() => bsplineSurface({ ...f, weights: [[1, 1]] }), /differ in shape/)
  assert.throws(() => bsplineSurface({ ...f, weights: [[1, 0], [1, 1]] }), /must be positive/)
})

// Perpendicularity cannot tell a normal from its negative, so pin the OUTWARD sign explicitly.
test("normals point outward: cone away from the axis, torus away from the tube centre, sphere away from the centre", () => {
  const c = coneSurface(TILT, 2, 0.4)
  for (const u of [0.3, 2, 4]) for (const v of [0, 1.5]) {
    const p = c.at(u, v), onAxis = add(TILT.o, scale(TILT.z, v))
    assert.ok(dot(c.normal(u, v), sub(p, onAxis)) > 0, `cone u=${u} v=${v}`)
    // and moving a little along the normal increases the distance from the axis
    const q = add(p, scale(c.normal(u, v), 0.01)), l = toLocal(TILT, q), l0 = toLocal(TILT, p)
    assert.ok(Math.hypot(l[0], l[1]) - (2 + l[2] * Math.tan(0.4)) > Math.hypot(l0[0], l0[1]) - (2 + l0[2] * Math.tan(0.4)) - 1e-12, "outside the cone")
  }
  const t = torusSurface(TILT, 5, 1.2)
  for (const u of [0.4, 2.2]) for (const v of [0, 1.6, 3.4, 5]) {
    const p = t.at(u, v)
    const centre = add(TILT.o, scale(add(scale(TILT.x, Math.cos(u)), scale(TILT.y, Math.sin(u))), 5))
    assert.ok(dot(t.normal(u, v), sub(p, centre)) > 0, `torus u=${u} v=${v}`)
  }
})
test("a cone that opens upward and one that opens downward have opposite axial tilt in the normal", () => {
  const up = coneSurface(ID, 1, 0.4).normal(0, 0), down = coneSurface(ID, 1, -0.4).normal(0, 0)
  assert.ok(up[2] < 0 && down[2] > 0, `${up[2]} ${down[2]}`)
})
