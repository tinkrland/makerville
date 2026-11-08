/**
 * Turns trimmed B-rep faces into triangles.
 *
 * A trimmed face is a 2D region in its surface's own (u, v) parameter space: one outer ring plus any
 * number of holes. So boundary loops are sampled to a chord tolerance in 3D, projected to (u, v), scaled
 * so u and v are comparable lengths, bridged into one simple polygon, ear clipped, and lifted back to 3D
 * through the surface.
 *
 * ORIENTATION is settled by measuring, not by convention. The sign of the sampled ring's (u, v) area was
 * the obvious guide and it is wrong: a cylinder's parameter frame can be left handed, and a real model
 * produced a correctly wound quarter cylinder with NEGATIVE area. So the ring is only normalised for ear
 * clipping, and the final winding is chosen by comparing the area weighted triangle normal against the
 * normal the face claims (surface normal, flipped when same_sense is false). Disagreement is reported.
 *
 * Original code. Hole bridging follows the classic approach described by Eberly (Geometric Tools),
 * reimplemented here; ear clipping is the standard O(n^2) method.
 */
import type { EdgeUse, Face, Loop, Solid } from "./brep.ts"
import type { Surface } from "./surfaces.ts"
import { dist, type V3 } from "./vec.ts"

export interface TessOptions {
  /** largest allowed distance between a chord and the true curve, in millimetres */
  tolerance: number
  /** recursion limit for edge sampling */
  maxDepth: number
}

export const DEFAULT_TESS: TessOptions = { tolerance: 0.02, maxDepth: 10 }

export interface Mesh {
  /** x,y,z per vertex */
  positions: number[]
  /** triangles, counter-clockwise seen from outside */
  indices: number[]
  /** unit normal per vertex, from the surface (smooth shading) */
  normals: number[]
  triangles: number
  /** faces that produced triangles */
  faces: number
  warnings: string[]
}

const MAX_SEGMENTS = 4096

/**
 * Two points closer than this are the same point. Real exporters write a shared vertex twice with
 * last-digit noise: the TYPE-C model's face #6126 has consecutive corners 2.01e-11 mm apart, and at a
 * 1e-12 threshold those duplicates survived, so ear clipping met zero-area ears and produced ONE
 * triangle for a rectangle (measured: 26 faces lost or truncated). This is 1e-9 mm, eight orders below
 * the smallest feature we care about, so it merges noise without touching geometry.
 */
export const MERGE_TOL = 1e-9
type P2 = [number, number]

/** Sample one edge use into 3D points, subdividing while the chord strays more than tol from the curve. */
export function sampleEdge(e: EdgeUse, opts: TessOptions = DEFAULT_TESS): V3[] {
  const t0 = e.tFrom, t1 = e.tTo
  if (Math.abs(t1 - t0) < 1e-15) return [e.curve.at(t0)]
  const params: number[] = [t0]
  const rec = (a: number, pa: V3, b: number, pb: V3, depth: number) => {
    if (depth >= opts.maxDepth) return
    const m = (a + b) / 2
    const pm = e.curve.at(m)
    const cm: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]
    if (dist(pm, cm) <= opts.tolerance) return
    rec(a, pa, m, pm, depth + 1)
    params.push(m)
    rec(m, pm, b, pb, depth + 1)
  }
  rec(t0, e.curve.at(t0), t1, e.curve.at(t1), 0)
  params.push(t1)
  // Subdivision is symmetric in (t0, t1), so a shared edge sampled from either face gives the same
  // points and welding can close the seam. Fall back to a uniform split only if the budget is exceeded.
  if (params.length > MAX_SEGMENTS) {
    const out: V3[] = []
    for (let i = 0; i <= MAX_SEGMENTS; i++) out.push(e.curve.at(t0 + ((t1 - t0) * i) / MAX_SEGMENTS))
    return out
  }
  return params.map((t) => e.curve.at(t))
}

/** the metric size of one unit of u, and of one unit of v, on this surface near these points */
export function uvScale(s: Surface, pts: V3[]): [number, number] {
  const su: number[] = [], sv: number[] = []
  for (const p of pts.slice(0, 40)) {
    const [u, v] = s.project(p)
    const h = s.uPeriod > 0 ? s.uPeriod * 1e-4 : 1e-3
    const du = dist(s.at(u + h, v), s.at(u - h, v)) / (2 * h)
    const dv = dist(s.at(u, v + h), s.at(u, v - h)) / (2 * h)
    if (Number.isFinite(du) && du > 1e-9) su.push(du)
    if (Number.isFinite(dv) && dv > 1e-9) sv.push(dv)
  }
  const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1]! : 1)
  return [med(su), med(sv)]
}

/** loop -> 3D points, consecutive duplicates removed, closed again if the ends coincide */
export function sampleLoop(loop: Loop, opts: TessOptions = DEFAULT_TESS): V3[] {
  const out: V3[] = []
  const push = (p: V3) => {
    const last = out[out.length - 1]
    if (!last || dist(last, p) > MERGE_TOL) out.push(p)
  }
  for (const e of loop.edges) for (const p of sampleEdge(e, opts)) push(p)
  if (out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= MERGE_TOL) out.pop()
  return out
}

/** project a chain of 3D points into (u, v), scaling to length units and unwrapping a periodic u */
export function toUv(s: Surface, pts: V3[], scale: [number, number]): P2[] {
  const out: P2[] = []
  let prevU = Number.NaN
  for (const p of pts) {
    let [u, v] = s.project(p)
    if (s.uPeriod > 0 && !Number.isNaN(prevU)) {
      while (u - prevU > s.uPeriod / 2) u -= s.uPeriod
      while (prevU - u > s.uPeriod / 2) u += s.uPeriod
    }
    prevU = u
    out.push([u * scale[0], v * scale[1]])
  }
  return out
}

export const signedArea = (p: P2[]): number => {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!, r = p[(i + 1) % p.length]!
    a += q[0] * r[1] - r[0] * q[1]
  }
  return a / 2
}

const cross2 = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

function pointInTriangle(p: P2, a: P2, b: P2, c: P2): boolean {
  const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p)
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/** do the segments a-b and c-d properly cross (shared endpoints do not count) */
function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross2(c, d, a), d2 = cross2(c, d, b), d3 = cross2(a, b, c), d4 = cross2(a, b, d)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

/**
 * Is M -> P a legal bridge? The open segment must not cross any edge of the polygon, nor any edge of
 * any ring still to be attached (its own ring except the two edges meeting at M).
 */
function bridgeIsClear(M: P2, P: P2, poly: P2[], rings: P2[][], own: P2[], ownIndex: number): boolean {
  const crossesRing = (ring: P2[], skip: number, skip2: number) => {
    for (let i = 0; i < ring.length; i++) {
      if (i === skip || i === skip2) continue
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      // ignore an edge that merely touches M or P at an endpoint
      const sharesEndpoint = (q: P2, r: P2) => dist2(q, M) < 1e-12 || dist2(q, P) < 1e-12 || dist2(r, M) < 1e-12 || dist2(r, P) < 1e-12
      if (sharesEndpoint(a, b)) continue
      if (segmentsCross(M, P, a, b)) return true
    }
    return false
  }
  if (crossesRing(poly, -1, -1)) return false
  for (const r of rings) if (r !== own && crossesRing(r, -1, -1)) return false
  // the hole's own two edges at M share the endpoint, and are skipped by the endpoint rule
  void ownIndex
  return !crossesRing(own, -1, -1)
}
const dist2 = (a: P2, b: P2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

/**
 * Splice every hole into the outer ring with a bridge, producing one simple polygon.
 *
 * Each hole is attached through its rightmost vertex M, which is visible from the outside of the hole in
 * the +x direction. The candidate bridge targets are the polygon vertices, cheapest first (nearest, then
 * the classic "reflex vertex inside the ray triangle" choice), and each candidate is VALIDATED: the
 * segment must not cross any ring. Measurement on a real model showed that choosing a target purely by the
 * ray test produced a self-intersecting polygon on a non-convex outline, which cost a face its
 * triangulation, so validation is not optional here.
 */
export function bridgeHoles(outer: P2[], holes: P2[][]): P2[] {
  // Normalise the winding here rather than trusting the caller. A hole supplied the same way round as
  // the outer ring would be ADDED, not subtracted: measured on a 10x10 square with a 2x2 hole, the wrong
  // winding gave area 104 instead of 96, and the bridged polygon touched itself so ear clipping then
  // produced garbage. Cheap to check, and impossible to get wrong from outside.
  let poly = signedArea(outer) < 0 ? outer.slice().reverse() : outer.slice()
  holes = holes.map((h) => (signedArea(h) > 0 ? h.slice().reverse() : h))
  const remaining = holes.slice()
  for (let h = 0; h < remaining.length; h++) {
    const hole = remaining[h]!
    if (hole.length < 3) continue
    const rings = remaining.slice(h + 1)
    // rightmost hole vertex (lowest y breaks a tie, so the choice is deterministic)
    let hi = 0
    for (let i = 1; i < hole.length; i++) {
      const b = hole[i]!, a = hole[hi]!
      if (b[0] > a[0] || (b[0] === a[0] && b[1] < a[1])) hi = i
    }
    const M = hole[hi]!

    // candidates: polygon vertices, nearest first, then by how much the segment opens toward +x
    const order = poly
      .map((q, i) => ({ i, d: dist2(q, M), ang: Math.abs(Math.atan2(q[1] - M[1], q[0] - M[0])) }))
      .filter((c) => c.d > 1e-24)
      .sort((a, b) => a.d - b.d || a.ang - b.ang)

    let pIdx = -1
    for (const c of order) {
      if (bridgeIsClear(M, poly[c.i]!, poly, rings, hole, hi)) { pIdx = c.i; break }
    }

    if (pIdx < 0) {
      // nothing visible: keep the ring so its triangles are not lost, and let the caller warn
      poly = poly.concat(hole.slice(hi).concat(hole.slice(0, hi)), [M])
      continue
    }
    const P = poly[pIdx]!
    const ring = hole.slice(hi).concat(hole.slice(0, hi))
    // poly.slice(0, pIdx + 1) already ends with P, so the bridge is  ...P, M, hole..., M, P, rest...
    // Adding a second P here would repeat the vertex and leave a zero-length edge, which then defeats
    // ear clipping (a duplicate point sits "inside" every candidate ear).
    poly = [...poly.slice(0, pIdx + 1), ...ring, ring[0]!, P, ...poly.slice(pIdx + 1)]
  }
  return poly
}

/**
 * Ear clipping of a counter-clockwise simple polygon, returning index triples into poly.
 *
 * Two details matter for real trimmed faces:
 *  - Only a REFLEX vertex can block an ear. Testing every vertex against the triangle is both slower and
 *    wrong once a hole bridge duplicates a point, because the duplicate always sits on the ear's edge.
 *  - A vertex coincident with one of the ear's own corners is ignored, for the same reason.
 * If no ear can be found the clip STOPS and says so. The earlier version dropped the most degenerate
 * vertex and carried on, which silently punched an unpaired edge into the mesh (measured: 242 open edges
 * on a real model) while still looking like a success.
 */
export function earClip(poly: P2[]): [number, number, number][] {
  const out: [number, number, number][] = []
  if (poly.length < 3) return out
  const idx = poly.map((_, i) => i)
  const same = (a: P2, b: P2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
  const area2 = (a: P2, b: P2, c: P2) => cross2(a, b, c)
  let guard = 0
  const limit = poly.length * poly.length * 4 + 32
  while (idx.length > 3 && guard++ < limit) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const n = idx.length
      const i0 = idx[(i - 1 + n) % n]!, i1 = idx[i]!, i2 = idx[(i + 1) % n]!
      const a = poly[i0]!, b = poly[i1]!, c = poly[i2]!
      if (area2(a, b, c) <= 1e-14) continue // reflex or degenerate, not an ear of a CCW polygon
      let ok = true
      for (let k = 0; k < n && ok; k++) {
        const j = idx[k]!
        if (j === i0 || j === i1 || j === i2) continue
        const p = poly[j]!
        if (same(p, a) || same(p, b) || same(p, c)) continue // a bridged duplicate, not an obstruction
        const before = poly[idx[(k - 1 + n) % n]!]!, after = poly[idx[(k + 1) % n]!]!
        if (area2(before, p, after) >= 0) continue // convex vertices cannot block
        if (pointInTriangle(p, a, b, c)) { ok = false; break }
      }
      if (!ok) continue
      out.push([i0, i1, i2])
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) return out // report failure by returning fewer triangles; the caller warns
  }
  if (idx.length === 3 && cross2(poly[idx[0]!]!, poly[idx[1]!]!, poly[idx[2]!]!) > 0) {
    out.push([idx[0]!, idx[1]!, idx[2]!])
  }
  return out
}

/**
 * Triangulate a simple CCW polygon given in (u, v).
 *
 * Ear clipping alone is wrong for CURVED surfaces, and that is not a subtlety: a ring of points at constant
 * v on a cylinder is a straight line in (u, v), so ear clipping treats every one of them as a degenerate
 * ear and merges the whole rim into one chord. The flat area is still correct, which is why it went
 * unnoticed, but the lift to 3D cuts through the barrel. Measured on TO-92_Inline: the barrel rim had 33
 * points, 31 collinear, and 31 were dropped, leaving the model open.
 *
 * So when the polygon is star shaped about its own centroid (true of the long curved faces that hit this
 * problem: cylinder barrels, cone skirts, and every rectangle), it is fanned from the centroid, which uses
 * EVERY boundary point and therefore lifts accurately. Otherwise it falls back to ear clipping. The fan is
 * also cheaper than clipping for the common rectangular face.
 */
export function triangulate(poly: P2[]): { verts: P2[]; tris: [number, number, number][] } {
  if (poly.length < 3) return { verts: poly, tris: [] }
  if (poly.length > 3 && isStarShaped(poly)) {
    // The centroid must be pushed through the surface's (u, v) values, not averaged in uv, or a periodic
    // surface would get a centroid on the wrong side of its seam; averaging is fine here because the ring
    // was already unwrapped and the centroid of a star-shaped ring lies inside it.
    let ux = 0, uy = 0, w = 0
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!
      const c = a[0] * b[1] - b[0] * a[1]
      ux += (a[0] + b[0]) * c; uy += (a[1] + b[1]) * c; w += c * 3
    }
    if (Math.abs(w) < 1e-18) return { verts: poly, tris: earClip(poly) }
    const centre: P2 = [ux / w, uy / w]
    if (!Number.isFinite(centre[0]) || !Number.isFinite(centre[1])) return { verts: poly, tris: earClip(poly) }
    const out: [number, number, number][] = []
    const n = poly.length
    // the centroid becomes vertex n; triangles keep the ring's winding
    for (let i = 0; i < n; i++) {
      const a = i, b = (i + 1) % n
      if (cross2(poly[a]!, poly[b]!, centre) <= 1e-18) return { verts: poly, tris: earClip(poly) } // not actually star shaped
      out.push([a, b, n])
    }
    const verts = poly.concat([centre])
    return { verts, tris: out }
  }
  return { verts: poly, tris: earClip(poly) }
}

/** true when every edge of the CCW polygon sees its centroid on the inner side (so a fan is valid) */
export function isStarShaped(poly: P2[]): boolean {
  if (poly.length < 4) return true
  let ux = 0, uy = 0, w = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!
    const c = a[0] * b[1] - b[0] * a[1]
    ux += (a[0] + b[0]) * c; uy += (a[1] + b[1]) * c; w += c * 3
  }
  if (Math.abs(w) < 1e-18) return false
  const c: P2 = [ux / w, uy / w]
  for (let i = 0; i < poly.length; i++) {
    if (cross2(poly[i]!, poly[(i + 1) % poly.length]!, c) <= 1e-15) return false
  }
  return true
}

export interface FaceMesh {
  positions: V3[]
  tris: [number, number, number][]
  /** how many triangles the curvature refinement had to split */
  refined: number
  /**
   * The worst distance, in mm, by which a remaining triangle still strays from the true surface, and how
   * many triangles do. Non-zero means the tolerance was NOT met: either the triangle budget or the pass
   * limit ran out. It is reported rather than hidden, because a mesh that silently sits outside the
   * requested chord tolerance is wrong in a way no amount of looking at it reveals.
   */
  worstDeviation: number
  overTolerance: number
  /**
   * Overlap in the (u,v) plane, in square uv units: the summed area of the triangles minus the area the
   * trimmed region actually has. Zero for a clean triangulation. It becomes non-zero when the region is
   * PINCHED, which happens when a hole touches the outer ring: the bridge then has zero length and the
   * ring visits one vertex twice, so ear clipping can close overlapping ears.
   *
   * Measured on a 10x10 square whose 2x2 hole shares a corner vertex with it: the bridged ring had the
   * right area (96) but the triangles summed to 146, i.e. 50 square units of double cover, and nothing
   * said so. None of the four real fixture models has a touching ring (smallest gap between two rings of
   * one face: 0.05 uv units on SW_Push, 0.14 on TYPE-C, 0.18 on Panasonic), so this is a guard rather
   * than a common path. It is reported, never silently accepted.
   */
  overlapUv2: number
}

/** triangle budget per face before refinement gives up and says so */
const REFINE_BUDGET = 40000

/**
 * Split triangles until every triangle sits within `tol` of the true surface.
 *
 * Subdividing the BOUNDARY is not enough. The boundary is sampled to tolerance, but the interior of a
 * triangle is a flat chord between three sampled points, and on a curved surface that chord can leave the
 * surface by far more than the tolerance. A full cylinder shows how bad it gets: the whole (u,v) rectangle
 * was fanned from its centroid, so a triangle from u=0 to the centroid at u=pi/2 becomes a chord straight
 * through the barrel. Measured on a r=2, h=5 cylinder: 65 of 66 wall triangles were wound inward relative
 * to the real surface and the wall contributed zero net volume, while the mesh still looked closed.
 *
 * The refinement is per EDGE, not per triangle, and that is what keeps the mesh conforming: an edge's
 * deviation depends only on its two endpoints, so both triangles sharing it make the same decision and the
 * midpoint is cached, so they use the same new vertex. No crack can appear inside a face.
 *
 * Boundary edges need no special case. `sampleEdge` already bisected them with this same tolerance, so
 * their midpoints fit within tolerance and they are left alone, which keeps the shared boundary with the
 * neighbouring face unchanged.
 */
function refineTris(s: Surface, uv: P2[], tris: [number, number, number][], scale: [number, number], tol: number): { refined: number; worstDeviation: number; overTolerance: number } {
  const lift = (i: number): V3 => { const q = uv[i]!; return s.at(q[0] / scale[0], q[1] / scale[1]) }
  const midCache = new Map<string, number>()
  const devCache = new Map<string, number>()
  const key = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`)
  const mid = (i: number, j: number): number => {
    const k = key(i, j)
    const hit = midCache.get(k)
    if (hit !== undefined) return hit
    const a = uv[i]!, b = uv[j]!
    const idx = uv.length
    uv.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
    midCache.set(k, idx)
    return idx
  }
  /** how far the true surface strays from the flat chord at the edge's parameter midpoint */
  const dev = (i: number, j: number): number => {
    const k = key(i, j)
    const hit = devCache.get(k)
    if (hit !== undefined) return hit
    const a = uv[i]!, b = uv[j]!
    const onSurface = s.at((a[0] + b[0]) / 2 / scale[0], (a[1] + b[1]) / 2 / scale[1])
    const p = lift(i), q = lift(j)
    const chord: V3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]
    const d = Math.hypot(onSurface[0] - chord[0], onSurface[1] - chord[1], onSurface[2] - chord[2])
    devCache.set(k, d)
    return d
  }

  let refined = 0
  let work = tris
  for (let pass = 0; pass < 40; pass++) {
    if (work.length > REFINE_BUDGET) break
    const next: [number, number, number][] = []
    let splitAny = false
    for (const [a, b, c] of work) {
      const sab = dev(a, b) > tol, sbc = dev(b, c) > tol, sca = dev(c, a) > tol
      const n = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0)
      if (n === 0) { next.push([a, b, c]); continue }
      splitAny = true
      refined++
      if (n === 3) {
        const m1 = mid(a, b), m2 = mid(b, c), m3 = mid(c, a)
        next.push([a, m1, m3], [m1, b, m2], [m3, m2, c], [m1, m2, m3])
      } else if (n === 2) {
        // each case keeps the original winding a -> b -> c
        if (sab && sbc) {
          const m1 = mid(a, b), m2 = mid(b, c)
          next.push([a, m1, c], [m1, b, m2], [m1, m2, c])
        } else if (sbc && sca) {
          const m2 = mid(b, c), m3 = mid(c, a)
          next.push([a, b, m2], [a, m2, m3], [m3, m2, c])
        } else {
          const m1 = mid(a, b), m3 = mid(c, a)
          next.push([a, m1, m3], [m1, b, c], [m1, c, m3])
        }
      } else if (sab) {
        const m1 = mid(a, b)
        next.push([a, m1, c], [m1, b, c])
      } else if (sbc) {
        const m2 = mid(b, c)
        next.push([b, m2, a], [m2, c, a])
      } else {
        const m3 = mid(c, a)
        next.push([c, m3, b], [m3, a, b])
      }
    }
    work = next
    if (!splitAny) break
  }
  tris.length = 0
  tris.push(...work)
  // Measure what survived. The loop can leave out-of-tolerance triangles two ways: the budget check
  // breaks BEFORE splitting the current set, and the pass limit ends the loop mid refinement. Both used
  // to return normally, so a cylinder refined at 0.001 mm stayed 5.3x outside its tolerance and said
  // nothing. Count and report instead of assuming success.
  let worstDeviation = 0, overTolerance = 0
  for (const [a, b, c] of work) {
    const d = Math.max(dev(a, b), dev(b, c), dev(c, a))
    if (d > tol) overTolerance++
    if (d > worstDeviation) worstDeviation = d
  }
  return { refined, worstDeviation, overTolerance }
}

/** Triangulate one face in (u, v), refine it to the chord tolerance, and lift the result back to 3D. */
export function tessellateFace(face: Face, opts: TessOptions = DEFAULT_TESS): FaceMesh {
  const loops3d = face.bounds.map((b) => sampleLoop(b.loop, opts)).filter((p) => p.length >= 3)
  if (loops3d.length === 0) return { positions: [], tris: [], refined: 0, worstDeviation: 0, overTolerance: 0, overlapUv2: 0 }
  const scale = uvScale(face.surface, loops3d.flat())
  const outerAt = Math.max(0, face.bounds.findIndex((b) => b.outer))
  const outerLoop = loops3d[Math.min(outerAt, loops3d.length - 1)]!
  const holeLoops = loops3d.filter((l) => l !== outerLoop)

  // normalise rings to a consistent wind for ear clipping only (see the header note on orientation)
  const outerUv = toUv(face.surface, outerLoop, scale)
  const outer = signedArea(outerUv) < 0 ? outerUv.slice().reverse() : outerUv
  const holes = holeLoops.map((l) => {
    const h = toUv(face.surface, l, scale)
    return signedArea(h) > 0 ? h.slice().reverse() : h
  })

  const poly = holes.length ? bridgeHoles(outer, holes) : outer
  const tri = triangulate(poly)
  const vertsUv = tri.verts.slice()
  const { refined, worstDeviation, overTolerance } = refineTris(face.surface, vertsUv, tri.tris, scale, opts.tolerance)
  const positions: V3[] = vertsUv.map(([u, v]) => face.surface.at(u / scale[0], v / scale[1]))
  const raw: [number, number, number][] = []
  for (const [a, b, c] of tri.tris) {
    const p = positions[a]!, q = positions[b]!, r = positions[c]!
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2]
    const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2]
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-14) continue
    raw.push([a, b, c])
  }
  if (raw.length === 0) return { positions, tris: [], refined, worstDeviation, overTolerance, overlapUv2: 0 }

  // Which way the triangles face depends on whether the surface's (u, v) frame is right handed, which
  // differs per surface type and even per face (a cylinder frame can be flipped). So measure it, but NOT
  // by summing the triangle normals across the whole face: on a face that wraps all the way round (a
  // cylinder wall, a full disc rim) the outward normals point every way and the sum is zero, so the sign
  // of the agreement is pure noise. Measured on a cylinder before this was fixed: the wall's summed normal
  // was 0.000 and it was wound inward, which made the solid's volume come out negative and a third of the
  // true value. Instead each triangle votes on its own patch of surface, weighted by its area, and the
  // majority wins. A single triangle always lies on one side of the surface, so no vote can cancel.
  let votes = 0
  for (const [a, b, c] of raw) {
    const p = positions[a]!, q = positions[b]!, r = positions[c]!
    const nx = (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1])
    const ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2])
    const nz = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    const area2 = Math.hypot(nx, ny, nz)
    if (area2 < 1e-18) continue
    const mid: V3 = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3]
    const [mu, mv] = face.surface.project(mid)
    const sn = face.surface.normal(mu, mv)
    const k = face.sameSense ? 1 : -1
    const d = (nx * sn[0] + ny * sn[1] + nz * sn[2]) * k
    votes += Math.sign(d) * area2
  }
  const tris = votes < 0 ? raw.map(([a, b, c]) => [a, c, b] as [number, number, number]) : raw

  // Did the triangles actually cover the region, and only the region? Compare areas in (u,v), where the
  // trimmed region is a plain polygon, so the comparison needs no surface geometry.
  const regionArea = Math.abs(signedArea(poly))
  let triArea = 0
  for (const [a, b, c] of tris) {
    const P = vertsUv[a]!, Q = vertsUv[b]!, R = vertsUv[c]!
    triArea += Math.abs((Q[0] - P[0]) * (R[1] - P[1]) - (R[0] - P[0]) * (Q[1] - P[1])) / 2
  }
  // tolerance is relative to the region so it scales with the face; 1% of area is far above float noise
  const overlapUv2 = triArea - regionArea > Math.max(1e-12, regionArea * 0.01) ? triArea - regionArea : 0
  return { positions, tris, refined, worstDeviation, overTolerance, overlapUv2 }
}

/** Tessellate every face of every solid into one mesh. */
export function tessellate(solids: Solid[], opts: TessOptions = DEFAULT_TESS): Mesh {
  const positions: number[] = [], indices: number[] = [], normals: number[] = []
  const warnings: string[] = []
  let triangles = 0, faces = 0
  for (const s of solids) for (const sh of s.shells) for (const f of sh.faces) {
    const fm = tessellateFace(f, opts)
    if (fm.tris.length === 0) {
      // Distinguish a face that has no area from one that failed. A degenerate sliver is what an exporter
      // leaves where a seam collapses: the TYPE-C model has 8 cylinder faces whose loop is two lines with
      // identical x and y, so the loop encloses nothing and there is correctly nothing to draw. Reporting
      // that as a surface problem sends whoever reads the warning looking for a bug that is not there.
      // AREA is the criterion, not extent: a sliver can be half a millimetre long and still enclose
      // nothing, which is exactly what the TYPE-C seam collapses are (two lines at identical x and y).
      const pts = f.bounds.map((b) => sampleLoop(b.loop, opts)).filter((l) => l.length >= 3)
      let area = 0
      if (pts.length) {
        const sc = uvScale(f.surface, pts.flat())
        area = pts.reduce((sum, l) => sum + Math.abs(signedArea(toUv(f.surface, l, sc))), 0)
      }
      if (area <= 1e-12) warnings.push(`face #${f.id} encloses no area on its ${f.surface.kind} surface (a collapsed seam sliver) and correctly has no triangles; skipped`)
      else warnings.push(`face #${f.id} failed to triangulate on its ${f.surface.kind} surface despite enclosing ${area.toFixed(4)} mm2; skipped`)
      continue
    }
    if (fm.overlapUv2 > 0) {
      warnings.push(
        `face #${f.id} on its ${f.surface.kind} surface triangulates to ${(fm.overlapUv2).toFixed(6)} square uv units ` +
          `more than the region it covers: a hole touches the outer ring (a pinched ring), so triangles overlap; ` +
          `the mesh draws the face but double covers part of it`,
      )
    }
    if (fm.overTolerance > 0) {
      warnings.push(
        `face #${f.id} on its ${f.surface.kind} surface missed the ${opts.tolerance} mm chord tolerance: ` +
          `${fm.overTolerance} of ${fm.tris.length} triangles are up to ${fm.worstDeviation.toFixed(4)} mm off ` +
          `(refinement budget or pass limit reached; raise the tolerance or split the face)`,
      )
    }
    faces++
    const base = positions.length / 3
    const flip = f.sameSense ? 1 : -1
    for (const p of fm.positions) {
      positions.push(p[0], p[1], p[2])
      const [u, v] = f.surface.project(p)
      const nn = f.surface.normal(u, v)
      normals.push(nn[0] * flip, nn[1] * flip, nn[2] * flip)
    }
    for (const [a, b, c] of fm.tris) {
      indices.push(base + a, base + b, base + c)
      triangles++
    }
  }
  return { positions, indices, normals, triangles, faces, warnings }
}

/** Merge vertices that coincide within tol, so shared edges actually share vertices. */
export function weld(mesh: Mesh, tol = 1e-6): Mesh {
  const n = mesh.positions.length / 3
  const cell = Math.max(tol, 1e-9) * 2
  const buckets = new Map<string, number[]>()
  const map = new Array<number>(n).fill(-1)
  const pos: number[] = [], nor: number[] = []
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[i * 3]!, y = mesh.positions[i * 3 + 1]!, z = mesh.positions[i * 3 + 2]!
    const cx = Math.round(x / cell), cy = Math.round(y / cell), cz = Math.round(z / cell)
    let found = -1
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`)
      if (!b) continue
      for (const j of b) {
        if (Math.hypot(pos[j * 3]! - x, pos[j * 3 + 1]! - y, pos[j * 3 + 2]! - z) <= tol) { found = j; break search }
      }
    }
    if (found < 0) {
      found = pos.length / 3
      pos.push(x, y, z)
      nor.push(mesh.normals[i * 3] ?? 0, mesh.normals[i * 3 + 1] ?? 0, mesh.normals[i * 3 + 2] ?? 0)
      const key = `${cx},${cy},${cz}`
      const b = buckets.get(key)
      if (b) b.push(found); else buckets.set(key, [found])
    }
    map[i] = found
  }
  const indices: number[] = []
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = map[mesh.indices[t]!]!, b = map[mesh.indices[t + 1]!]!, c = map[mesh.indices[t + 2]!]!
    if (a === b || b === c || a === c) continue
    indices.push(a, b, c)
  }
  return { positions: pos, indices, normals: nor, triangles: indices.length / 3, faces: mesh.faces, warnings: mesh.warnings }
}

/**
 * Close T-junctions: a vertex that lies ON a triangle edge but is not one of its ends leaves a crack, so
 * the surface is not watertight however carefully each face was triangulated.
 *
 * This is not a bug in this code, it is in the source models. Measured in R_0603_1608Metric: the bottom
 * face has ONE edge from (-0.5,-0.4,0.045) to (0.755,-0.4,0.045) while the face beside it has TWO edges
 * covering the same line, (-0.5..0.5) and (0.5..0.755). KiCad's STEP export (FreeCAD) writes such
 * coplanar splits, and so do the other exporters here. Faces can also sample the SAME curve into a
 * different number of chords when their edge uses end at slightly different parameters.
 *
 * The fix is the classic one: insert the stray vertex into the triangle by splitting it, which changes no
 * geometry, only topology. Boundary edges are found by edge use count and only those are examined, so the
 * interior of a well-formed mesh is untouched. Returns the number of splits made.
 *
 * NOT applied by default, and the reason is measured. On the reference models it closed 32 of TYPE-C's 326
 * open edges and 16 of Contact's 51, but it took Contact's non-manifold edges from 1 to 6: on a part 2.75 mm
 * wide, a vertex that is a genuine sharp corner of a neighbouring lobe can sit within tolerance of an open
 * edge, and splitting there makes an edge used by four triangles. Trading holes for non-manifold edges is
 * not an improvement, so callers opt in. The better fix for the source models' T-junctions is to snap the
 * boundary segments against each other, which is still open (see HANDOFF.md).
 */
export function stitchTJunctions(mesh: Mesh, tol = 1e-4): { mesh: Mesh; splits: number } {
  const positions = mesh.positions.slice()
  let indices = mesh.indices.slice()
  const p3 = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]
  const k = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`)
  let splits = 0

  const cell = Math.max(tol * 8, 1e-6)
  const grid = new Map<string, number[]>()
  const nv = positions.length / 3
  for (let v = 0; v < nv; v++) {
    const key = `${Math.round(positions[v * 3]! / cell)},${Math.round(positions[v * 3 + 1]! / cell)},${Math.round(positions[v * 3 + 2]! / cell)}`
    const b = grid.get(key)
    if (b) b.push(v); else grid.set(key, [v])
  }
  /** vertices of the mesh lying strictly inside segment a-b, nearest to a first */
  const straysOn = (a: number, b: number, skip: number[]): number[] => {
    const A = p3(a), B = p3(b)
    const ab: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
    if (l2 < 1e-24) return []
    const steps = Math.max(1, Math.ceil(Math.sqrt(l2) / cell))
    const seen = new Set<number>()
    for (let s2 = 1; s2 < steps; s2++) {
      const P: V3 = [A[0] + (ab[0] * s2) / steps, A[1] + (ab[1] * s2) / steps, A[2] + (ab[2] * s2) / steps]
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${Math.round(P[0] / cell) + dx},${Math.round(P[1] / cell) + dy},${Math.round(P[2] / cell) + dz}`)
        if (bucket) for (const v of bucket) seen.add(v)
      }
    }
    const out: { v: number; t: number }[] = []
    for (const v of seen) {
      if (skip.includes(v)) continue
      const P = p3(v)
      const t = ((P[0] - A[0]) * ab[0] + (P[1] - A[1]) * ab[1] + (P[2] - A[2]) * ab[2]) / l2
      if (t <= 1e-9 || t >= 1 - 1e-9) continue
      const proj: V3 = [A[0] + ab[0] * t, A[1] + ab[1] * t, A[2] + ab[2] * t]
      if (dist(proj, P) > tol) continue
      out.push({ v, t })
    }
    out.sort((x, y) => x.t - y.t)
    return out.map((x) => x.v)
  }

  // Repeat until nothing changes. Each pass splits ONE edge per triangle, so a triangle with strays on
  // two edges is finished over two passes; that keeps the splitting logic trivial to reason about.
  for (let pass = 0; pass < 12; pass++) {
    const uses = new Map<string, number>()
    for (let t = 0; t < indices.length; t += 3) for (const [i, j] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]] as [number, number][]) uses.set(k(i!, j!), (uses.get(k(i!, j!)) ?? 0) + 1)

    let thisPass = 0
    const next: number[] = []
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
      let split = false
      for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]] as [number, number, number][]) {
        if (uses.get(k(x, y)) !== 1) continue // an edge shared by two triangles is already closed
        const strays = straysOn(x, y, [a, b, c])
        if (strays.length === 0) continue
        // split at the first stray only: (x, s, z) and (s, y, z). Both halves keep the winding.
        const s = strays[0]!
        next.push(x, s, z, s, y, z)
        thisPass++
        splits++
        split = true
        break
      }
      if (!split) next.push(a, b, c)
    }
    indices = next
    if (thisPass === 0) break
  }
  return { mesh: { ...mesh, positions, indices, triangles: indices.length / 3 }, splits }
}

export interface MeshStats {
  triangles: number
  vertices: number
  bounds: [V3, V3]
  /** signed volume from the divergence theorem; positive when the surface faces outward */
  volume: number
  surfaceArea: number
  /** undirected edges used by exactly one triangle: zero for a closed surface */
  boundaryEdges: number
  /** edges used by more than two triangles */
  nonManifoldEdges: number
  watertight: boolean
}

export function meshStats(m: Mesh): MeshStats {
  const p = m.positions
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k]! < lo[k]!) lo[k] = p[i + k]!
    if (p[i + k]! > hi[k]!) hi[k] = p[i + k]!
  }
  let vol = 0, area = 0
  const edges = new Map<string, number>()
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t]!, b = m.indices[t + 1]!, c = m.indices[t + 2]!
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!
    const bx = p[b * 3]!, by = p[b * 3 + 1]!, bz = p[b * 3 + 2]!
    const cx = p[c * 3]!, cy = p[c * 3 + 1]!, cz = p[c * 3 + 2]!
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    for (const [i, j] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  let boundary = 0, nonManifold = 0
  for (const [, k] of edges) { if (k === 1) boundary++; else if (k > 2) nonManifold++ }
  return {
    triangles: m.indices.length / 3,
    vertices: p.length / 3,
    bounds: [lo, hi],
    volume: vol,
    surfaceArea: area,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    watertight: boundary === 0 && nonManifold === 0,
  }
}
