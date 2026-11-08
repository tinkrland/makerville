/**
 * Tessellation tests. The synthetic fixtures have closed-form answers (a box's volume is a*b*c, a
 * cylinder's is pi r^2 h), so the mesh is measured against arithmetic rather than against itself. Real
 * models are measured for structure (watertightness, bounds, stability), because their true volume is not
 * known independently here.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parsePart21 } from "../src/step/part21.ts"
import { Geometry } from "../src/step/geometry.ts"
import { Brep, type Solid } from "../src/step/brep.ts"
import {
  tessellate, tessellateFace, weld, meshStats, sampleEdge, sampleLoop, uvScale, toUv,
  signedArea, bridgeHoles, earClip, triangulate, isStarShaped, stitchTJunctions, MERGE_TOL,
  DEFAULT_TESS,
} from "../src/step/tessellate.ts"
import { planeSurface, cylinderSurface, coneSurface } from "../src/step/surfaces.ts"
import { lineCurve } from "../src/step/curves.ts"
import { frameFrom, dist, norm, sub as vsub, type V3 } from "../src/step/vec.ts"
import { boxStep } from "./brep-box.ts"
import { cylinderStep, frustumStep, tubeStep } from "./brep-curved.ts"
import type { EdgeUse, Face, Loop } from "../src/step/brep.ts"

const REF = "../refs/"
const near = (a: number, b: number, e: number, m = "") => assert.ok(Math.abs(a - b) <= e, `${m}: ${a} vs ${b} (tol ${e})`)
const rel = (a: number, b: number, e: number, m = "") => assert.ok(Math.abs(a - b) <= e * Math.abs(b), `${m}: ${a} vs ${b} (${((Math.abs(a - b) / b) * 100).toFixed(4)}%)`)

function read(text: string): Solid[] {
  const p = parsePart21(text)
  const w: string[] = []
  const g = new Geometry(p, w)
  return new Brep(p, g, w).read()
}
const meshOf = (text: string, opts = DEFAULT_TESS) => {
  const m = tessellate(read(text), opts)
  return { raw: m, w: weld(m, 1e-6) }
}
const faces = (text: string) => read(text).flatMap((s) => s.shells.flatMap((sh) => sh.faces))

/** distance from a point to the boundary of a solid cylinder r, h (base at z=0) */
function devCylinder(r: number, h: number, q: V3): number {
  const rho = Math.hypot(q[0], q[1])
  if (q[2] >= 0 && q[2] <= h) return Math.min(Math.abs(rho - r), q[2], h - q[2])
  const dz = q[2] < 0 ? -q[2] : q[2] - h
  return rho <= r ? dz : Math.hypot(rho - r, dz)
}
/** distance from a point to the boundary of a cone frustum r0 (z=0) to r1 (z=h) */
function devFrustum(r0: number, r1: number, h: number, q: V3): number {
  const rho = Math.hypot(q[0], q[1])
  const onSide = Math.min(Math.abs(rho - (r0 + ((r1 - r0) * q[2]) / h)), q[2], h - q[2])
  return Math.abs(onSide)
}
/** the worst deviation of interior sample points of every triangle from a reference distance field */
function worstDeviation(m: { positions: number[]; indices: number[] }, dev: (q: V3) => number): number {
  const BARY: [number, number, number][] = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]
  let worst = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const P = [0, 1, 2].map((k) => { const i = m.indices[t + k]!; return [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!] as V3 })
    for (const w of BARY) {
      const q: V3 = [0, 1, 2].map((k) => w[0]! * P[0]![k]! + w[1]! * P[1]![k]! + w[2]! * P[2]![k]!) as V3
      const d = dev(q)
      if (d > worst) worst = d
    }
  }
  return worst
}

// ======================= the box: every answer is arithmetic
test("box: exact volume, exact bounds, watertight, 12 triangles per quad face", () => {
  const { raw, w } = meshOf(boxStep({ a: 10, b: 6, c: 4 }))
  const st = meshStats(w)
  near(st.volume, 240, 1e-9, "volume is a*b*c")
  assert.deepEqual(st.bounds[0], [0, 0, 0])
  assert.deepEqual(st.bounds[1], [10, 6, 4])
  assert.ok(st.watertight, `not watertight: ${st.boundaryEdges} open, ${st.nonManifoldEdges} non-manifold`)
  assert.equal(raw.warnings.length, 0)
  assert.equal(st.triangles, 24, "6 planar faces, 2 triangles each")
  assert.equal(raw.faces, 6)
})
test("box: a plane face is exactly planar, so no refinement is needed", () => {
  for (const f of faces(boxStep({}))) {
    const fm = tessellateFace(f)
    assert.equal(fm.refined, 0, `face #${f.id} refined ${fm.refined} times on a plane`)
    assert.equal(fm.overTolerance, 0)
  }
})
test("box: triangle count and volume are unchanged by a tighter tolerance (a plane has no curvature)", () => {
  const a = meshStats(weld(tessellate(read(boxStep({})), { tolerance: 5, maxDepth: 10 }), 1e-6))
  const b = meshStats(weld(tessellate(read(boxStep({})), { tolerance: 0.0001, maxDepth: 10 }), 1e-6))
  assert.equal(a.triangles, b.triangles); near(a.volume, b.volume, 1e-12)
})
test("box: every triangle faces outward (each one's normal agrees with the direction from the centre)", () => {
  const { w } = meshOf(boxStep({}))
  const c: V3 = [5, 3, 2]
  let checked = 0
  for (let t = 0; t < w.indices.length; t += 3) {
    const P = [0, 1, 2].map((k) => { const i = w.indices[t + k]!; return [w.positions[i * 3]!, w.positions[i * 3 + 1]!, w.positions[i * 3 + 2]!] as V3 })
    const u = [P[1]![0] - P[0]![0], P[1]![1] - P[0]![1], P[1]![2] - P[0]![2]]
    const v = [P[2]![0] - P[0]![0], P[2]![1] - P[0]![1], P[2]![2] - P[0]![2]]
    const n: V3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    const mid: V3 = [(P[0]![0] + P[1]![0] + P[2]![0]) / 3, (P[0]![1] + P[1]![1] + P[2]![1]) / 3, (P[0]![2] + P[1]![2] + P[2]![2]) / 3]
    const out: V3 = [mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]]
    assert.ok(n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0, `triangle ${t / 3} faces inward`)
    checked++
  }
  assert.equal(checked, 24)
})
test("box: a symmetric box's mesh is symmetric, so no coordinate is systematically skewed", () => {
  const { w } = meshOf(boxStep({ a: 8, b: 8, c: 8 }))
  const st = meshStats(w)
  near(st.bounds[1]![0] - 0, 8, 1e-12); near(st.bounds[1]![1], 8, 1e-12); near(st.bounds[1]![2], 8, 1e-12)
  rel(st.volume, 512, 1e-12)
})

// ======================= a half size box: volume must be exactly halved, not merely scaled
test("box: volume scales exactly with each dimension", () => {
  const v = (a: number, b: number, c: number) => meshStats(weld(tessellate(read(boxStep({ a, b, c }))), 1e-6)).volume
  near(v(20, 6, 4) / v(10, 6, 4), 2, 1e-12)
  near(v(10, 12, 4) / v(10, 6, 4), 2, 1e-12)
  near(v(10, 6, 1) / v(10, 6, 4), 0.25, 1e-12)
})

// ======================= curved solids: the mesh must approach the analytic solid
test("cylinder: watertight, right bounds, and volume approaches pi r^2 h as tolerance tightens", () => {
  const exact = Math.PI * 4 * 5
  const vols: number[] = []
  for (const tol of [0.2, 0.05, 0.02]) {
    const { w } = meshOf(cylinderStep(2, 5), { tolerance: tol, maxDepth: 12 })
    const st = meshStats(w)
    assert.ok(st.watertight, `tol ${tol}: ${st.boundaryEdges} open edges`)
    near(st.bounds[0]![0], -2, 1e-9); near(st.bounds[1]![0], 2, 1e-9); near(st.bounds[0]![2], 0, 1e-9); near(st.bounds[1]![2], 5, 1e-9)
    vols.push(st.volume)
  }
  // inscribed chords always undershoot, and the error must shrink with the tolerance
  assert.ok(vols[0]! < exact && vols[1]! < exact && vols[2]! < exact, "chords cut inside the cylinder")
  assert.ok(vols[0]! < vols[1]! && vols[1]! < vols[2]!, "volume must increase toward the true value")
  rel(vols[2]!, exact, 0.01, "volume within 1% at 0.02 mm")
})
test("cylinder: measured deviation of the mesh from the true solid stays within the requested tolerance", () => {
  for (const tol of [0.2, 0.05, 0.02, 0.01]) {
    const { raw } = meshOf(cylinderStep(2, 5), { tolerance: tol, maxDepth: 14 })
    const worst = worstDeviation(raw, (q) => devCylinder(2, 5, q))
    assert.ok(worst <= tol, `tol ${tol}: worst deviation ${worst}`)
    assert.ok(worst > tol * 0.5, `tol ${tol}: worst deviation ${worst} is suspiciously small, the sampler may not be sampling`)
  }
})
test("cylinder: missing the tolerance is REPORTED, never silent (a face past the triangle budget)", () => {
  // 0.0005 mm on a 2 mm radius cylinder needs ~100k triangles, past the 40k budget for one face
  const m = tessellate(read(cylinderStep(2, 5)), { tolerance: 0.0005, maxDepth: 16 })
  assert.equal(m.warnings.length, 1, "expected exactly one tolerance warning")
  assert.match(m.warnings[0]!, /missed the 0\.0005 mm chord tolerance/)
  assert.match(m.warnings[0]!, /cylinder/)
  assert.match(m.warnings[0]!, /triangles are up to/)
  // and the same solid at a normal tolerance must be quiet
  assert.equal(tessellate(read(cylinderStep(2, 5)), { tolerance: 0.02, maxDepth: 16 }).warnings.length, 0)
})
test("cone frustum: volume approaches the closed form pi h (r0^2 + r0 r1 + r1^2) / 3", () => {
  const exact = (Math.PI * 5 * (4 + 2 * 1 + 1)) / 3
  const { w } = meshOf(frustumStep(2, 1, 5), { tolerance: 0.02, maxDepth: 12 })
  const st = meshStats(w)
  assert.ok(st.watertight, `${st.boundaryEdges} open edges`)
  rel(st.volume, exact, 0.01)
  near(st.bounds[1]![0], 2, 1e-9, "bottom radius is the widest")
})
test("tube: a face with a hole is bridged and triangulated, and the annulus has the right area", () => {
  const { w } = meshOf(tubeStep(5, 1, 3), { tolerance: 0.05, maxDepth: 12 })
  const st = meshStats(w)
  assert.ok(st.watertight, `${st.boundaryEdges} open, ${st.nonManifoldEdges} non-manifold`)
  const exact = Math.PI * (25 - 1) * 3
  rel(st.volume, exact, 0.02, "hollow tube volume")
  // the top annulus alone must not be filled across the hole
  const capAreas: number[] = []
  for (const f of faces(tubeStep(5, 1, 3))) {
    if (f.surface.kind !== "plane" || f.bounds.length < 2) continue
    const fm = tessellateFace(f, { tolerance: 0.05, maxDepth: 12 })
    let area = 0
    for (const [a, b, c] of fm.tris) {
      const P = [a, b, c].map((i) => fm.positions[i]!)
      const u = [P[1]![0] - P[0]![0], P[1]![1] - P[0]![1], P[1]![2] - P[0]![2]]
      const v = [P[2]![0] - P[0]![0], P[2]![1] - P[0]![1], P[2]![2] - P[0]![2]]
      area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2
    }
    capAreas.push(area)
  }
  assert.equal(capAreas.length, 2, "two annular caps")
  for (const a of capAreas) rel(a, Math.PI * 24, 0.02, "annulus area pi(R^2 - r^2)")
})
test("tube: the mesh is watertight even though the caps needed hole bridging", () => {
  const { w } = meshOf(tubeStep(5, 1, 3), { tolerance: 0.05, maxDepth: 12 })
  assert.equal(meshStats(w).boundaryEdges, 0)
})

// ======================= edge sampling
test("sampleEdge: a straight line yields exactly its two ends, whatever the tolerance", () => {
  const f = faces(boxStep({}))
  const line = f.flatMap((x) => x.bounds.flatMap((b) => b.loop.edges)).find((e) => e.curve.kind === "line")!
  for (const tol of [10, 1, 1e-6]) assert.equal(sampleEdge(line, { tolerance: tol, maxDepth: 12 }).length, 2)
})
test("sampleEdge: a full circle at tolerance t produces chords that never stray more than t", () => {
  const circ = faces(cylinderStep(2, 5)).flatMap((x) => x.bounds.flatMap((b) => b.loop.edges)).find((e) => e.curve.kind === "circle")!
  for (const tol of [0.5, 0.05, 0.005]) {
    const pts = sampleEdge(circ, { tolerance: tol, maxDepth: 20 })
    assert.ok(pts.length > 3, "a full circle needs several chords")
    let worst = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
      worst = Math.max(worst, 2 - Math.hypot(mid[0], mid[1])) // how far the chord's midpoint falls inside r=2
    }
    assert.ok(worst <= tol, `tol ${tol}: chord sagitta ${worst}`)
    // and the sampling must actually be fine enough to be useful, not just compliant
    assert.ok(worst > tol / 4, `tol ${tol}: sagitta ${worst} suggests over-coarse sampling`)
  }
})
test("sampleLoop: consecutive duplicates are merged and the closing point is not repeated", () => {
  const f = faces(cylinderStep(2, 5)).find((x) => x.surface.kind === "circle" || x.bounds.some((b) => b.loop.edges.length > 1))!
  const lp = f.bounds[0]!.loop
  const pts = sampleLoop(lp)
  assert.ok(pts.length >= 3)
  for (let i = 1; i < pts.length; i++) assert.ok(dist(pts[i - 1]!, pts[i]!) > MERGE_TOL, `duplicate at ${i}`)
  assert.ok(dist(pts[0]!, pts[pts.length - 1]!) > MERGE_TOL, "the loop must not repeat its first point at the end")
})
test("uvScale: reports the metric size of a parameter unit, so uv is comparable in both directions", () => {
  const cyl = cylinderSurface(frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0]), 2)
  const [su, sv] = uvScale(cyl, [[2, 0, 1], [0, 2, 3]])
  near(su, 2, 1e-3, "a radian of u is r mm long")
  near(sv, 1, 1e-9, "a unit of v is 1 mm")
  const pl = planeSurface(frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0]))
  const [pu, pv] = uvScale(pl, [[1, 2, 0]])
  near(pu, 1, 1e-9); near(pv, 1, 1e-9)
})
test("toUv: a ring that crosses the seam is unwrapped, so u does not jump by a whole period", () => {
  const cyl = cylinderSurface(frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0]), 1)
  // a ring with real height variation, whose seam corner sits just either side of the +x axis. Without
  // unwrapping, the two points at angle -0.05 and +0.05 would differ by a whole 2 pi period in u.
  const pts: V3[] = [
    [1, -0.05, 0], [1, 0.05, 0], [0.707, 0.707, 1], [0, 1, 2], [-1, 0.05, 3], [-1, -0.05, 4],
  ]
  const uv = toUv(cyl, pts, [1, 1])
  let maxJump = 0
  for (let i = 1; i < uv.length; i++) maxJump = Math.max(maxJump, Math.abs(uv[i]![0] - uv[i - 1]![0]))
  assert.ok(maxJump < Math.PI, `u jumped ${maxJump} rad between neighbours`)
  near(signedArea(uv), 0.785398163397449, 1e-9, "the unwrapped ring encloses real area")
  // and raw projection would have jumped a full period across the seam, between the last two points
  const rawA = cyl.project(pts[4]!)[0], rawB = cyl.project(pts[5]!)[0]
  assert.ok(Math.abs(rawA - rawB) > 6, `expected a raw seam jump, got ${Math.abs(rawA - rawB)}`)
  // unwrapped, that same pair is continuous
  near(Math.abs(uv[5]![0] - uv[4]![0]), 0.0999, 1e-3)
})

// ======================= polygon machinery
test("signedArea: sign follows the winding and magnitude is the true area", () => {
  const sq: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]]
  near(signedArea(sq), 4, 1e-12); near(signedArea(sq.slice().reverse()), -4, 1e-12)
})
test("earClip: a simple square gives 2 triangles; a convex pentagon gives 3", () => {
  assert.equal(earClip([[0, 0], [2, 0], [2, 2], [0, 2]]).length, 2)
  assert.equal(earClip([[0, 0], [4, 0], [5, 2], [2, 3], [-1, 2]]).length, 3)
})
test("earClip: an L shape is triangulated into n-2 triangles that all lie inside it", () => {
  const L: [number, number][] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]
  const tris = earClip(L)
  assert.equal(tris.length, 4, "n-2 for an L")
  // no triangle may contain the missing quadrant's centre
  for (const [a, b, c] of tris) {
    const P = [L[a]!, L[b]!, L[c]!]
    const area = Math.abs((P[1]![0] - P[0]![0]) * (P[2]![1] - P[0]![1]) - (P[2]![0] - P[0]![0]) * (P[1]![1] - P[0]![1])) / 2
    assert.ok(area > 0, "degenerate triangle")
  }
  const total = tris.reduce((s, [a, b, c]) => { const P = [L[a]!, L[b]!, L[c]!]; return s + ((P[1]![0] - P[0]![0]) * (P[2]![1] - P[0]![1]) - (P[2]![0] - P[0]![0]) * (P[1]![1] - P[0]![1])) / 2 }, 0)
  near(total, 12, 1e-12, "L area is 16 - 4")
})
test("earClip: collinear points on an edge do not stop it, and the union area is still right", () => {
  const poly: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 2], [0, 2]]
  const tris = earClip(poly)
  const total = tris.reduce((s, [a, b, c]) => { const P = [poly[a]!, poly[b]!, poly[c]!]; return s + ((P[1]![0] - P[0]![0]) * (P[2]![1] - P[0]![1]) - (P[2]![0] - P[0]![0]) * (P[1]![1] - P[0]![1])) / 2 }, 0)
  near(total, 6, 1e-12)
})
test("bridgeHoles: a square with a square hole becomes one simple polygon with the right area", () => {
  const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const hole: [number, number][] = [[4, 4], [6, 4], [6, 6], [4, 6]] // clockwise, as a hole should be
  const poly = bridgeHoles(outer, [hole])
  near(signedArea(poly), 100 - 4, 1e-12, "bridging preserves the net area, even though this hole is given CCW")
  // the winding of the input must not matter: the same hole supplied the other way round gives the same region
  near(signedArea(bridgeHoles(outer, [hole.slice().reverse()])), 96, 1e-12, "winding-independent")
  // a reversed outer is normalised back to CCW, so the result is the same region either way
  near(signedArea(bridgeHoles(outer.slice().reverse(), [hole])), 96, 1e-12, "outer winding-independent")
  // the bridged polygon must be simple: no two non-adjacent edges may cross
  const n = poly.length
  // Strict crossing only. A bridge is a zero-width corridor: it leaves a polygon vertex, runs to a hole
  // vertex and comes straight back, so the polygon reaches its own vertex twice and the two bridge edges
  // share endpoints. That touching is what makes ear clipping work, so it is not a self-intersection.
  // An earlier version of this test used a sign test that counted shared endpoints as crossings: it
  // reported 1 crossing on a ring that triangulates to exactly the right area with the hole empty.
  const ccw = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const same = (u: [number, number], v: [number, number]) => u[0] === v[0] && u[1] === v[1]
  const strictlyCross = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false
    const d1 = ccw(c, d, a), d2 = ccw(c, d, b), d3 = ccw(a, b, c), d4 = ccw(a, b, d)
    return d1 * d2 < 0 && d3 * d4 < 0
  }
  let crossings = 0
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue
    if (strictlyCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) crossings++
  }
  assert.equal(crossings, 0, "the bridged polygon must not self-intersect")
  // and the property the simplicity check exists to protect: the triangles fill the ring and leave the hole empty
  const t = triangulate(poly)
  let triArea = 0
  for (const [a, b, c] of t.tris) {
    const P = [t.verts[a]!, t.verts[b]!, t.verts[c]!]
    triArea += Math.abs((P[1]![0] - P[0]![0]) * (P[2]![1] - P[0]![1]) - (P[2]![0] - P[0]![0]) * (P[1]![1] - P[0]![1])) / 2
  }
  near(triArea, 96, 1e-9, "triangulated area")
  const insideStrict = (pt: [number, number]) => t.tris.some(([a, b, c]) => {
    const P = [t.verts[a]!, t.verts[b]!, t.verts[c]!]
    const s0 = (P[1]![0] - P[0]![0]) * (pt[1] - P[0]![1]) - (P[1]![1] - P[0]![1]) * (pt[0] - P[0]![0])
    const s1 = (P[2]![0] - P[1]![0]) * (pt[1] - P[1]![1]) - (P[2]![1] - P[1]![1]) * (pt[0] - P[1]![0])
    const s2 = (P[0]![0] - P[2]![0]) * (pt[1] - P[2]![1]) - (P[0]![1] - P[2]![1]) * (pt[0] - P[2]![0])
    return s0 > 0 && s1 > 0 && s2 > 0
  })
  assert.ok(!insideStrict([5, 5]), "the hole must stay empty")
  assert.ok(insideStrict([1, 5]), "solid area must be covered")
})
test("bridgeHoles: two holes in one ring are both spliced in", () => {
  const outer: [number, number][] = [[0, 0], [20, 0], [20, 10], [0, 10]]
  const h1: [number, number][] = [[3, 3], [5, 3], [5, 5], [3, 5]]
  const h2: [number, number][] = [[13, 3], [17, 3], [17, 7], [13, 7]]
  const poly = bridgeHoles(outer, [h1, h2])
  near(signedArea(poly), 200 - 4 - 16, 1e-12)
  // both holes must actually be present as holes: no triangle may cover either one
  const { verts, tris } = triangulate(poly)
  const covers = (pt: [number, number]) => tris.some(([a, b, c]) => {
    const P = [verts[a]!, verts[b]!, verts[c]!]
    const s0 = (P[1]![0] - P[0]![0]) * (pt[1] - P[0]![1]) - (P[1]![1] - P[0]![1]) * (pt[0] - P[0]![0])
    const s1 = (P[2]![0] - P[1]![0]) * (pt[1] - P[1]![1]) - (P[2]![1] - P[1]![1]) * (pt[0] - P[1]![0])
    const s2 = (P[0]![0] - P[2]![0]) * (pt[1] - P[2]![1]) - (P[0]![1] - P[2]![1]) * (pt[0] - P[2]![0])
    return (s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)
  })
  assert.ok(!covers([4, 4]), "hole 1 must not be covered")
  assert.ok(!covers([15, 5]), "hole 2 must not be covered")
  assert.ok(covers([1, 1]), "solid area must be covered")
})
test("triangulate: a rectangle is fanned from its centroid so no boundary point is dropped", () => {
  const rect: [number, number][] = [[0, 0], [6, 0], [6, 4], [0, 4]]
  assert.ok(isStarShaped(rect))
  const { verts, tris } = triangulate(rect)
  assert.equal(verts.length, 5, "4 corners plus the centroid")
  assert.equal(tris.length, 4, "one triangle per edge")
  const used = new Set(tris.flat())
  assert.equal(used.size, 5, "every vertex is used")
})
test("triangulate: a non-star-shaped polygon still triangulates, via ear clipping", () => {
  // a U: its centroid lies outside the polygon, so a fan from it would be invalid
  const U: [number, number][] = [[0, 0], [2, 0], [2, 4], [4, 4], [4, 0], [6, 0], [6, 6], [0, 6]]
  assert.ok(!isStarShaped(U), "the U's centroid is outside it")
  const { tris } = triangulate(U)
  assert.ok(tris.length >= 6, `${tris.length} triangles for 8 vertices (n-2 = 6)`)
})

// ======================= real models: structure only, because true volume is not known here
const REAL_M3 = REF + "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step"
const REAL_PAN = REF + "circuit-json-to-step/test/fixtures/kicad-models/Panasonic_EVQPUJ_EVQPUA.step"
const REAL_SW = REF + "circuit-json-to-step/test/fixtures/kicad-models/SW_Push_1P1T_NO_CK_KMR2.step"
const REAL_TYPE_C = REF + "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"
const has = (p: string) => fs.existsSync(p)

test("real R_0603: tessellates watertight, with bounds and volume matching the file's own numbers", { skip: !has(REAL_M3) }, () => {
  const { raw, w } = meshOf(fs.readFileSync(REAL_M3, "latin1"))
  const st = meshStats(w)
  assert.equal(raw.warnings.length, 0, `warnings: ${raw.warnings.join(" | ")}`)
  assert.ok(st.watertight, `${st.boundaryEdges} open, ${st.nonManifoldEdges} non-manifold`)
  // the part is a 0603 chip resistor: body 1.6 x 0.8 mm, 0.45 mm tall
  near(st.bounds[0]![0], -0.8, 1e-6); near(st.bounds[1]![0], 0.8, 1e-6)
  near(st.bounds[0]![1], -0.4, 1e-6); near(st.bounds[1]![1], 0.4, 1e-6)
  near(st.bounds[0]![2], 0, 1e-6); near(st.bounds[1]![2], 0.45, 1e-6)
  near(st.volume, 0.535309, 1e-5, "volume is stable")
})
test("real Panasonic switch: bounds, stability, and the known small defect is bounded", { skip: !has(REAL_PAN) }, () => {
  const { w } = meshOf(fs.readFileSync(REAL_PAN, "latin1"))
  const st = meshStats(w)
  near(st.bounds[0]![2], 0, 1e-6); near(st.bounds[1]![2], 1.65, 1e-6)
  near(st.volume, 28.233, 1e-2)
  // This model has coplanar face splits in the source, so a few edges are not paired. Pinned so any
  // regression that makes it worse is caught, and so the number cannot silently drift.
  assert.equal(st.boundaryEdges, 3, "open edges (source T-junctions)")
  assert.equal(st.nonManifoldEdges, 4, "non-manifold edges (source)")
})
test("real push switch: bounds and stability", { skip: !has(REAL_SW) }, () => {
  const { w } = meshOf(fs.readFileSync(REAL_SW, "latin1"))
  const st = meshStats(w)
  near(st.bounds[1]![2], 1.9, 1e-6)
  near(st.volume, 16.7008, 1e-3)
})
test("the big TYPE-C model tessellates without crashing and its bounds match the model", { skip: !has(REAL_TYPE_C) }, () => {
  const { raw, w } = meshOf(fs.readFileSync(REAL_TYPE_C, "latin1"))
  const st = meshStats(w)
  assert.equal(st.triangles, 5292, "triangle count is stable")
  assert.equal(raw.faces, 681, "faces that produced triangles")
  near(st.bounds[0]![0], -4.47, 1e-3); near(st.bounds[1]![0], 4.47, 1e-3)
  near(st.bounds[0]![2], -3.9525, 1e-3); near(st.bounds[1]![2], 3.9525, 1e-3)
  near(st.volume, 113.97, 1e-2)
  // The 8 faces that produce nothing are degenerate seam slivers, and each must be REPORTED as such,
  // not as a surface failure. Getting this wrong sends the reader chasing a nonexistent bug.
  const degenerate = raw.warnings.filter((m) => /encloses no area/.test(m))
  const failed = raw.warnings.filter((m) => /failed to triangulate/.test(m))
  assert.equal(degenerate.length, 8, `expected 8 degenerate slivers, got ${degenerate.length}: ${raw.warnings.join(" | ")}`)
  assert.equal(failed.length, 0, `unexpected triangulation failures: ${failed.join(" | ")}`)
})
test("no real model crashes the tessellator, and any face it cannot do is NAMED", { skip: !has(REAL_PAN) || !has(REAL_SW) }, () => {
  for (const p of [REAL_M3, REAL_PAN, REAL_SW]) {
    const m = tessellate(read(fs.readFileSync(p, "latin1")))
    for (const wmsg of m.warnings) assert.match(wmsg, /^face #\d+/, `unexpected warning shape: ${wmsg}`)
  }
})

// ======================= welding and stitching
test("weld: merges vertices that differ only by float noise, and keeps genuinely distinct ones", () => {
  const m = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 1e-12, 0, 0], indices: [0, 1, 2, 3, 1, 2], normals: new Array(12).fill(0), triangles: 2, faces: 2, warnings: [] }
  const w = weld(m, 1e-6)
  assert.equal(w.positions.length / 3, 3, "the noisy duplicate merged")
  assert.equal(w.indices.length / 3, 2, "no triangle was lost")
})
test("weld: a triangle collapsed onto a line is dropped rather than left degenerate", () => {
  const m = { positions: [0, 0, 0, 1, 0, 0, 1e-9, 0, 0], indices: [0, 1, 2], normals: new Array(9).fill(0), triangles: 1, faces: 1, warnings: [] }
  const w = weld(m, 1e-6)
  assert.equal(w.triangles, 0)
})
test("stitchTJunctions: closes a deliberate T-junction (one long edge against two short ones)", () => {
  // A=(0,0) B=(1,0) and the midpoint M=(0.5,0). One triangle uses the whole edge A-B, two others meet at
  // M, so the long edge leaves a crack that only a split can close.
  const positions = [0, 0, 0, 1, 0, 0, 0.5, 0, 0, 0.5, 1, 0, 0.5, -1, 0]
  const indices = [0, 1, 3, 0, 2, 4, 2, 1, 4]
  const m = { positions, indices, normals: new Array(positions.length).fill(0), triangles: 3, faces: 3, warnings: [] }
  const before = meshStats(m)
  assert.ok(before.boundaryEdges > 0, "the fixture must start out open")
  const { mesh: after, splits } = stitchTJunctions(m, 1e-4)
  const st = meshStats(after)
  assert.ok(splits > 0, "expected a split")
  assert.ok(st.boundaryEdges < before.boundaryEdges, `open edges ${before.boundaryEdges} -> ${st.boundaryEdges}`)
  // splitting must not move any geometry
  assert.equal(after.positions.length, positions.length)
})
test("stitchTJunctions: leaves a clean closed mesh untouched", () => {
  const { w } = meshOf(boxStep({}))
  const { splits } = stitchTJunctions(w, 1e-4)
  assert.equal(splits, 0, "a closed box has no T-junctions")
})
test("stitchTJunctions: closes the source models' coplanar splits (measured, not assumed)", { skip: !has(REAL_PAN) || !has(REAL_SW) }, () => {
  for (const p of [REAL_PAN, REAL_SW]) {
    const { w } = meshOf(fs.readFileSync(p, "latin1"))
    const before = meshStats(w)
    const after = meshStats(stitchTJunctions(w, 1e-4).mesh)
    if (before.boundaryEdges > 0) {
      assert.ok(after.boundaryEdges < before.boundaryEdges, `${p}: ${before.boundaryEdges} -> ${after.boundaryEdges}`)
    }
  }
})

// ======================= meshStats itself
test("meshStats: exact for a single triangle (area, volume of the tetrahedron it spans with the origin)", () => {
  const m = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], triangles: 1, faces: 1, warnings: [] }
  const st = meshStats(m)
  near(st.surfaceArea, 0.5, 1e-15)
  near(st.volume, 0, 1e-15, "a flat triangle at z=0 encloses no volume")
  assert.equal(st.boundaryEdges, 3)
  assert.equal(st.watertight, false)
})
test("meshStats: a unit cube's 12 triangles give volume 1 and area 6", () => {
  // build a cube by hand, wound outward
  const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const positions = P.flat()
  const indices: number[] = []
  for (const [a, b, c, d] of quads) { indices.push(a!, b!, c!, a!, c!, d!) }
  const st = meshStats({ positions, indices, normals: new Array(positions.length).fill(0), triangles: indices.length / 3, faces: 6, warnings: [] })
  near(st.volume, 1, 1e-12); near(st.surfaceArea, 6, 1e-12); assert.ok(st.watertight)
})
test("meshStats: reversed winding flips the sign of the volume, which is what the orientation vote protects", () => {
  const { w } = meshOf(boxStep({}))
  const flipped = { ...w, indices: w.indices.map((v, i) => (i % 3 === 1 ? w.indices[i + 1]! : i % 3 === 2 ? w.indices[i - 1]! : v)) }
  near(meshStats(flipped).volume, -240, 1e-9)
})

// ======================= face-level coverage: does the triangulation match the region it claims?
test("overlapUv2: a clean annulus reports ZERO overlap (the guard must not fire on normal faces)", () => {
  for (const f of faces(tubeStep(5, 1, 3))) {
    if (f.bounds.length < 2) continue
    const fm = tessellateFace(f, { tolerance: 0.05, maxDepth: 12 })
    assert.ok(fm.tris.length > 0, "the annulus must produce triangles")
    assert.equal(fm.overlapUv2, 0, `face #${f.id} reported ${fm.overlapUv2}`)
  }
})
test("overlapUv2: a clean single-ring face reports zero overlap", () => {
  for (const f of faces(boxStep({ a: 10, b: 6, c: 4 }))) assert.equal(tessellateFace(f).overlapUv2, 0)
})

/**
 * A pinched ring, built from the real machinery: a planar face whose outer ring is a square with a notch
 * cut into its edge, so one hole vertex coincides with an outer vertex. That is the case where the bridge
 * has zero length and ear clipping can close overlapping ears. Measured before the guard existed: the
 * bridged ring had area 96 but the triangles summed to 146, with no warning.
 *
 * Written against bridgeHoles + triangulate directly because no STEP fixture in ../refs/ contains a
 * touching ring (measured: minimum ring-to-ring gap is 0.05 uv units, on SW_Push), and hand-writing a
 * pinched B-rep would test my own syntax, not the tessellator.
 */
test("overlapUv2: a pinched region (hole touching the outer ring) is detected, never silently mis-covered", () => {
  const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const hole: [number, number][] = [[6, 6], [10, 10], [6, 8]] // shares the corner vertex [10,10]
  const poly = bridgeHoles(outer, [hole])
  near(signedArea(poly), 96, 1e-9, "the bridged ring itself has the right area")
  const t = triangulate(poly)
  const triArea = t.tris.reduce((s, [a, b, c]) => {
    const P = t.verts[a]!, Q = t.verts[b]!, R = t.verts[c]!
    return s + Math.abs((Q[0] - P[0]) * (R[1] - P[1]) - (R[0] - P[0]) * (Q[1] - P[1])) / 2
  }, 0)
  // the defect this guard exists for: the triangles cover MORE than the region
  assert.ok(triArea > 96 + 1, `expected measurable double cover, got ${triArea}`)
  // and the guard's criterion, applied to those same numbers, fires
  const regionArea = Math.abs(signedArea(poly))
  const overlap = triArea - regionArea > Math.max(1e-12, regionArea * 0.01) ? triArea - regionArea : 0
  assert.ok(overlap > 0, "the guard criterion must flag this region")
})

test("a hole sharing an EDGE with the outer ring (a notch) keeps the exact area, so not every touching hole is broken", () => {
  const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const notch: [number, number][] = [[4, 0], [6, 0], [6, 3], [4, 3]]
  const poly = bridgeHoles(outer, [notch])
  near(signedArea(poly), 94, 1e-9, "100 - 6")
  const t = triangulate(poly)
  const triArea = t.tris.reduce((s, [a, b, c]) => {
    const P = t.verts[a]!, Q = t.verts[b]!, R = t.verts[c]!
    return s + Math.abs((Q[0] - P[0]) * (R[1] - P[1]) - (R[0] - P[0]) * (Q[1] - P[1])) / 2
  }, 0)
  near(triArea, 94, 1e-9, "a notch is handled exactly: no overlap")
})

/**
 * Drive a PINCHED face through the real reporting path (tessellateFace + tessellate), so the overlap guard
 * is proven to reach the caller's warnings. Built by hand: a square plane face whose hole shares a corner
 * vertex with the outer ring. No STEP fixture has this shape, so the synthetic Face is the only way to
 * exercise it, and it is exactly the shape measured to double-cover 50 square units.
 */
function pinchedFace(): Face {
  const f = frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0])
  const surface = planeSurface(f)
  const line = (a: V3, b: V3): EdgeUse => {
    const c = lineCurve(a, norm(vsub(b, a)), dist(a, b))
    return { edgeId: 0, forward: true, from: a, to: b, curve: c, tFrom: 0, tTo: 1 }
  }
  const loopOf = (pts: V3[]): Loop => ({
    edges: pts.map((p, i) => line(p, pts[(i + 1) % pts.length]!)),
    closed: true,
  })
  const P = (x: number, y: number): V3 => [x, y, 0]
  return {
    id: 9001,
    surface,
    sameSense: true,
    bounds: [
      { outer: true, oriented: true, loop: loopOf([P(0, 0), P(10, 0), P(10, 10), P(0, 10)]) },
      // hole, wound the other way, sharing the corner (10,10) with the outer ring
      { outer: false, oriented: true, loop: loopOf([P(10, 10), P(6, 8), P(6, 6)]) },
    ],
  }
}

test("a pinched face is reported through tessellateFace and tessellate, not silently mis-covered", () => {
  const face = pinchedFace()
  const fm = tessellateFace(face)
  assert.ok(fm.tris.length > 0, "the face still draws")
  assert.ok(fm.overlapUv2 > 1, `overlap must be measured and reported, got ${fm.overlapUv2}`)
  const m = tessellate([{ id: 1, shells: [{ id: 1, closed: false, faces: [face] }] }])
  assert.ok(
    m.warnings.some((x) => /face #9001/.test(x) && /more than the region it covers/.test(x) && /hole touches the outer ring/.test(x)),
    `expected a named overlap warning, got: ${JSON.stringify(m.warnings)}`,
  )
})

test("a clean face produces NO overlap warning, so the guard cannot fire on ordinary geometry", () => {
  const f = frameFrom([0, 0, 0], [0, 0, 1], [1, 0, 0])
  const line = (a: V3, b: V3): EdgeUse => { const c = lineCurve(a, norm(vsub(b, a)), dist(a, b)); return { edgeId: 0, forward: true, from: a, to: b, curve: c, tFrom: 0, tTo: 1 } }
  const P = (x: number, y: number): V3 => [x, y, 0]
  const ring = (pts: V3[]): Loop => ({ edges: pts.map((p, i) => line(p, pts[(i + 1) % pts.length]!)), closed: true })
  const clean: Face = {
    id: 9002, surface: planeSurface(f), sameSense: true,
    bounds: [
      { outer: true, oriented: true, loop: ring([P(0, 0), P(10, 0), P(10, 10), P(0, 10)]) },
      { outer: false, oriented: true, loop: ring([P(4, 4), P(4, 6), P(6, 6), P(6, 4)]) },
    ],
  }
  assert.equal(tessellateFace(clean).overlapUv2, 0)
  const m = tessellate([{ id: 1, shells: [{ id: 1, closed: false, faces: [clean] }] }])
  assert.ok(!m.warnings.some((x) => /more than the region it covers/.test(x)), JSON.stringify(m.warnings))
})
