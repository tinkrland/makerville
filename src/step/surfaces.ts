/**
 * Surface evaluators for STEP faces: plane, cylinder, cone, sphere, torus, B-spline (incl. rational).
 *
 * The tessellator works in the surface's own (u, v) parameter space, where a trimmed face is a flat
 * 2D polygon with holes, and then lifts the triangles back to 3D. So every surface answers:
 *   at(u, v)       the 3D point
 *   normal(u, v)   the outward normal (before the face's same_sense flip)
 *   project(p)     the (u, v) of a 3D point on or near the surface
 *   uPeriod / vPeriod   the period when the surface wraps (cylinder u, sphere u, torus u and v), else 0
 *
 * Parameter meaning follows ISO 10303-42:
 *   plane      (u, v) are lengths along the frame's X and Y
 *   cylinder   u = angle about Z, v = height along Z
 *   cone       u = angle, v = distance along the axis from the reference circle (radius grows with v)
 *   sphere     u = longitude, v = latitude in [-pi/2, pi/2]
 *   torus      u = angle round the main axis, v = angle round the tube
 * Original code.
 */
import { add, scale, sub, dot, cross, norm, toWorld, toLocal, type Frame, type V3 } from "./vec.ts"
import { expandKnots } from "./curves.ts"

export interface Surface {
  kind: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "bspline"
  at(u: number, v: number): V3
  normal(u: number, v: number): V3
  project(p: V3): [number, number]
  uPeriod: number
  vPeriod: number
}

const TAU = Math.PI * 2

export function planeSurface(f: Frame): Surface {
  return {
    kind: "plane",
    at: (u, v) => toWorld(f, [u, v, 0]),
    normal: () => f.z,
    project: (p) => { const l = toLocal(f, p); return [l[0], l[1]] },
    uPeriod: 0, vPeriod: 0,
  }
}

export function cylinderSurface(f: Frame, r: number): Surface {
  if (!(r > 0)) throw new Error(`cylinder radius must be positive (got ${r})`)
  return {
    kind: "cylinder",
    at: (u, v) => toWorld(f, [r * Math.cos(u), r * Math.sin(u), v]),
    normal: (u) => add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u))),
    project: (p) => { const l = toLocal(f, p); return [Math.atan2(l[1], l[0]), l[2]] },
    uPeriod: TAU, vPeriod: 0,
  }
}

/** radius is the radius at the reference circle (v = 0); semiAngle is the half angle between axis and surface */
export function coneSurface(f: Frame, r: number, semiAngle: number): Surface {
  if (!(r >= 0)) throw new Error(`cone radius must not be negative (got ${r})`)
  if (!(Math.abs(semiAngle) > 0 && Math.abs(semiAngle) < Math.PI / 2)) throw new Error(`cone semi-angle must be between 0 and 90 degrees (got ${semiAngle} rad)`)
  const t = Math.tan(semiAngle), c = Math.cos(semiAngle), s = Math.sin(semiAngle)
  // v is distance ALONG THE AXIS, so the radius at v is r + v tan(a)
  return {
    kind: "cone",
    at: (u, v) => { const rr = r + v * t; return toWorld(f, [rr * Math.cos(u), rr * Math.sin(u), v]) },
    // outward normal tilts away from the axis direction the cone opens toward
    normal: (u) => add(scale(add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u))), c), scale(f.z, -s)),
    project: (p) => { const l = toLocal(f, p); return [Math.atan2(l[1], l[0]), l[2]] },
    uPeriod: TAU, vPeriod: 0,
  }
}

export function sphereSurface(f: Frame, r: number): Surface {
  if (!(r > 0)) throw new Error(`sphere radius must be positive (got ${r})`)
  return {
    kind: "sphere",
    at: (u, v) => toWorld(f, [r * Math.cos(v) * Math.cos(u), r * Math.cos(v) * Math.sin(u), r * Math.sin(v)]),
    normal: (u, v) => add(add(scale(f.x, Math.cos(v) * Math.cos(u)), scale(f.y, Math.cos(v) * Math.sin(u))), scale(f.z, Math.sin(v))),
    project: (p) => { const l = toLocal(f, p); return [Math.atan2(l[1], l[0]), Math.atan2(l[2], Math.hypot(l[0], l[1]))] },
    uPeriod: TAU, vPeriod: 0,
  }
}

export function torusSurface(f: Frame, major: number, minor: number): Surface {
  if (!(major > 0) || !(minor > 0)) throw new Error(`torus radii must be positive (got ${major}, ${minor})`)
  return {
    kind: "torus",
    at: (u, v) => { const rr = major + minor * Math.cos(v); return toWorld(f, [rr * Math.cos(u), rr * Math.sin(u), minor * Math.sin(v)]) },
    normal: (u, v) => add(scale(add(scale(f.x, Math.cos(u)), scale(f.y, Math.sin(u))), Math.cos(v)), scale(f.z, Math.sin(v))),
    project: (p) => {
      const l = toLocal(f, p)
      const u = Math.atan2(l[1], l[0])
      return [u, Math.atan2(l[2], Math.hypot(l[0], l[1]) - major)]
    },
    uPeriod: TAU, vPeriod: TAU,
  }
}

export interface BSplineSurfaceData {
  uDegree: number
  vDegree: number
  /** points[i][j]: i along u, j along v */
  points: V3[][]
  weights?: number[][]
  uKnots: number[]; uMults: number[]
  vKnots: number[]; vMults: number[]
}

function span(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n + 1]!) return n
  if (t <= U[p]!) return p
  let lo = p, hi = n + 1, mid = (lo + hi) >> 1
  while (t < U[mid]! || t >= U[mid + 1]!) { if (t < U[mid]!) hi = mid; else lo = mid; mid = (lo + hi) >> 1 }
  return mid
}

/** B-spline basis functions N[0..p] non-zero on the span (Piegl & Tiller, algorithm A2.2 in spirit) */
function basis(k: number, t: number, p: number, U: number[]): number[] {
  const N = new Array<number>(p + 1).fill(0)
  const left = new Array<number>(p + 1).fill(0), right = new Array<number>(p + 1).fill(0)
  N[0] = 1
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[k + 1 - j]!
    right[j] = U[k + j]! - t
    let saved = 0
    for (let r = 0; r < j; r++) {
      const den = right[r + 1]! + left[j - r]!
      const tmp = den === 0 ? 0 : N[r]! / den
      N[r] = saved + right[r + 1]! * tmp
      saved = left[j - r]! * tmp
    }
    N[j] = saved
  }
  return N
}

export function bsplineSurface(d: BSplineSurfaceData): Surface {
  const p = d.uDegree, q = d.vDegree
  const nu = d.points.length - 1
  const nv = (d.points[0]?.length ?? 0) - 1
  if (p < 1 || q < 1) throw new Error(`B-spline surface degrees must be at least 1 (got ${p}, ${q})`)
  if (nu < p || nv < q) throw new Error(`a ${p}x${q} B-spline surface needs at least ${p + 1}x${q + 1} control points (got ${nu + 1}x${nv + 1})`)
  if (d.points.some((row) => row.length !== nv + 1)) throw new Error("B-spline surface control net is ragged")
  const U = expandKnots(d.uKnots, d.uMults), V = expandKnots(d.vKnots, d.vMults)
  if (U.length !== nu + p + 2) throw new Error(`B-spline surface u knot vector has ${U.length} entries but ${nu + 1} points of degree ${p} need ${nu + p + 2}`)
  if (V.length !== nv + q + 2) throw new Error(`B-spline surface v knot vector has ${V.length} entries but ${nv + 1} points of degree ${q} need ${nv + q + 2}`)
  const W = d.weights ?? d.points.map((row) => row.map(() => 1))
  if (W.length !== d.points.length || W.some((row, i) => row.length !== d.points[i]!.length)) throw new Error("B-spline surface weights and control points differ in shape")
  if (W.some((row) => row.some((x) => !(x > 0)))) throw new Error("B-spline surface weights must be positive")
  const u0 = U[p]!, u1 = U[nu + 1]!, v0 = V[q]!, v1 = V[nv + 1]!

  // evaluate S(u,v) and the partial derivatives by central differences on the same function (simple and robust)
  const at = (u: number, v: number): V3 => {
    const uu = Math.min(Math.max(u, u0), u1), vv = Math.min(Math.max(v, v0), v1)
    const ku = span(nu, p, uu, U), kv = span(nv, q, vv, V)
    const Nu = basis(ku, uu, p, U), Nv = basis(kv, vv, q, V)
    let x = 0, y = 0, z = 0, w = 0
    for (let a = 0; a <= p; a++) for (let b = 0; b <= q; b++) {
      const i = ku - p + a, j = kv - q + b
      const c = Nu[a]! * Nv[b]! * W[i]![j]!
      const pt = d.points[i]![j]!
      x += c * pt[0]; y += c * pt[1]; z += c * pt[2]; w += c
    }
    return [x / w, y / w, z / w]
  }
  const du = (u1 - u0) * 1e-6, dv = (v1 - v0) * 1e-6
  const normal = (u: number, v: number): V3 => {
    const a = sub(at(Math.min(u1, u + du), v), at(Math.max(u0, u - du), v))
    const b = sub(at(u, Math.min(v1, v + dv)), at(u, Math.max(v0, v - dv)))
    return norm(cross(a, b))
  }
  const project = (pt: V3): [number, number] => {
    // coarse grid to find the basin, then damped Gauss-Newton on |S(u,v) - pt|^2
    const N = Math.max(24, Math.max(nu, nv) * 8)
    let bu = u0, bv = v0, bd = Infinity
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const u = u0 + ((u1 - u0) * i) / N, v = v0 + ((v1 - v0) * j) / N
      const s = at(u, v), dd = (s[0] - pt[0]) ** 2 + (s[1] - pt[1]) ** 2 + (s[2] - pt[2]) ** 2
      if (dd < bd) { bd = dd; bu = u; bv = v }
    }
    let u = bu, v = bv
    for (let it = 0; it < 40; it++) {
      const s = at(u, v)
      const r = sub(s, pt)
      const su = scale(sub(at(Math.min(u1, u + du), v), at(Math.max(u0, u - du), v)), 1 / (Math.min(u1, u + du) - Math.max(u0, u - du)))
      const sv = scale(sub(at(u, Math.min(v1, v + dv)), at(u, Math.max(v0, v - dv))), 1 / (Math.min(v1, v + dv) - Math.max(v0, v - dv)))
      const a11 = dot(su, su), a12 = dot(su, sv), a22 = dot(sv, sv)
      const b1 = -dot(su, r), b2 = -dot(sv, r)
      const det = a11 * a22 - a12 * a12
      if (Math.abs(det) < 1e-300) break
      const dU = (b1 * a22 - b2 * a12) / det, dV = (a11 * b2 - a12 * b1) / det
      const nu_ = Math.min(u1, Math.max(u0, u + dU)), nv_ = Math.min(v1, Math.max(v0, v + dV))
      if (Math.abs(nu_ - u) < 1e-13 && Math.abs(nv_ - v) < 1e-13) { u = nu_; v = nv_; break }
      u = nu_; v = nv_
    }
    return [u, v]
  }
  return { kind: "bspline", at, normal, project, uPeriod: 0, vPeriod: 0 }
}
