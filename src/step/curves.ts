/**
 * Curve evaluators for STEP edges: line, circle, ellipse, B-spline (incl. rational / NURBS).
 *
 * Every curve answers the same three questions the B-rep walker needs:
 *   at(t)       the point at parameter t
 *   closest(p)  the parameter of the point on the curve nearest p (used to place a vertex on its edge)
 *   range       the natural parameter interval, and whether the curve is periodic
 *
 * Parameter meaning follows STEP: a LINE is  P + t * (dir * magnitude)  so t is in units of the VECTOR's
 * length; a CIRCLE and ELLIPSE use an angle in radians; a B-spline uses its knot vector.
 * Original code written against ISO 10303-42.
 */
import { add, scale, sub, dot, len, dist, toWorld, type Frame, type V3 } from "./vec.ts"

export interface Curve {
  kind: "line" | "circle" | "ellipse" | "bspline"
  at(t: number): V3
  closest(p: V3): number
  /** natural parameter interval; infinite for a line */
  range: [number, number]
  periodic: boolean
}

export function lineCurve(origin: V3, dir: V3, magnitude: number): Curve {
  const d = scale(dir, magnitude)
  const dd = dot(d, d)
  if (dd < 1e-300) throw new Error("line has zero length direction")
  return {
    kind: "line",
    at: (t) => add(origin, scale(d, t)),
    closest: (p) => dot(sub(p, origin), d) / dd,
    range: [-Infinity, Infinity],
    periodic: false,
  }
}

const TAU = Math.PI * 2
/** wrap an angle into [0, 2pi) */
export const wrapAngle = (a: number) => ((a % TAU) + TAU) % TAU

export function ellipseCurve(frame: Frame, a: number, b: number): Curve {
  if (!(a > 0) || !(b > 0)) throw new Error(`ellipse radii must be positive (got ${a}, ${b})`)
  const at = (t: number): V3 => toWorld(frame, [a * Math.cos(t), b * Math.sin(t), 0])
  return {
    kind: a === b ? "circle" : "ellipse",
    at,
    closest: (p) => {
      const d = sub(p, frame.o)
      const x = dot(d, frame.x), y = dot(d, frame.y)
      if (a === b) return wrapAngle(Math.atan2(y, x))
      // Newton on f(t) = (E(t) - q) . E'(t) = 0, the foot-point condition for E(t) = (a cos t, b sin t):
      //   f(t)  = -a sin t (a cos t - x) + b cos t (b sin t - y)
      //   f'(t) = -a cos t (a cos t - x) + a^2 sin^2 t - b sin t (b sin t - y) + b^2 cos^2 t
      // Starting from the scaled-circle angle lands in the right basin for any point not near the centre;
      // several starts are tried and the nearest result kept, so points near the axes or centre are safe.
      const D = (t: number) => Math.hypot(a * Math.cos(t) - x, b * Math.sin(t) - y)
      let bestT = 0, bestD = Infinity
      const starts = [Math.atan2(y / b, x / a), Math.atan2(y, x), 0, Math.PI / 2, Math.PI, -Math.PI / 2]
      for (const t0 of starts) {
        let t = t0
        for (let i = 0; i < 40; i++) {
          const c = Math.cos(t), s = Math.sin(t)
          const f = -a * s * (a * c - x) + b * c * (b * s - y)
          const fp = -a * c * (a * c - x) + a * a * s * s - b * s * (b * s - y) + b * b * c * c
          if (Math.abs(fp) < 1e-300) break
          const dt = f / fp
          t -= dt
          if (Math.abs(dt) < 1e-15) break
        }
        const d = D(t)
        if (d < bestD - 1e-15) { bestD = d; bestT = t }
      }
      const t = bestT
      return wrapAngle(t)
    },
    range: [0, TAU],
    periodic: true,
  }
}
export const circleCurve = (frame: Frame, radius: number): Curve => ellipseCurve(frame, radius, radius)

export interface BSplineData {
  degree: number
  points: V3[]
  /** same length as points; omit for a non-rational spline */
  weights?: number[]
  /** distinct knot values */
  knots: number[]
  /** how many times each distinct knot repeats */
  mults: number[]
  closed?: boolean
}

/** expand (knots, multiplicities) into the full knot vector */
export function expandKnots(knots: number[], mults: number[]): number[] {
  if (knots.length !== mults.length) throw new Error(`B-spline has ${knots.length} knots but ${mults.length} multiplicities`)
  const out: number[] = []
  for (let i = 0; i < knots.length; i++) for (let m = 0; m < mults[i]!; m++) out.push(knots[i]!)
  for (let i = 1; i < out.length; i++) if (out[i]! < out[i - 1]!) throw new Error("B-spline knots are not in ascending order")
  return out
}

/** index of the knot span containing t, clamped so the end of the range evaluates on the last span */
function findSpan(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n + 1]!) return n
  if (t <= U[p]!) return p
  let lo = p, hi = n + 1
  let mid = (lo + hi) >> 1
  while (t < U[mid]! || t >= U[mid + 1]!) {
    if (t < U[mid]!) hi = mid
    else lo = mid
    mid = (lo + hi) >> 1
  }
  return mid
}

/** de Boor on homogeneous coordinates, so rational splines come out right with the same code */
export function bsplineCurve(d: BSplineData): Curve {
  const p = d.degree
  const n = d.points.length - 1
  if (p < 1) throw new Error(`B-spline degree must be at least 1 (got ${p})`)
  if (n < p) throw new Error(`a degree ${p} B-spline needs at least ${p + 1} control points (got ${n + 1})`)
  const U = expandKnots(d.knots, d.mults)
  if (U.length !== n + p + 2) throw new Error(`B-spline knot vector has ${U.length} entries but ${n + 1} points of degree ${p} need ${n + p + 2}`)
  if (d.weights && d.weights.length !== d.points.length) throw new Error("B-spline weights and control points differ in count")
  const w = d.weights ?? d.points.map(() => 1)
  if (w.some((x) => !(x > 0))) throw new Error("B-spline weights must be positive")
  const H = d.points.map((pt, i) => [pt[0] * w[i]!, pt[1] * w[i]!, pt[2] * w[i]!, w[i]!])
  const lo = U[p]!, hi = U[n + 1]!

  const at = (t: number): V3 => {
    const tt = Math.min(Math.max(t, lo), hi)
    const k = findSpan(n, p, tt, U)
    const dd = H.slice(k - p, k + 1).map((r) => r.slice())
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const left = U[k - p + j]!
        const right = U[j + 1 + k - r]!
        const alpha = right - left === 0 ? 0 : (tt - left) / (right - left)
        for (let c = 0; c < 4; c++) dd[j]![c] = (1 - alpha) * dd[j - 1]![c]! + alpha * dd[j]![c]!
      }
    }
    const r = dd[p]!
    return [r[0]! / r[3]!, r[1]! / r[3]!, r[2]! / r[3]!]
  }

  // closest point: coarse sampling to find the basin, then golden-section refinement
  const closest = (q: V3): number => {
    const N = Math.max(64, (n + 1) * 16)
    let best = lo, bd = Infinity
    for (let i = 0; i <= N; i++) {
      const t = lo + ((hi - lo) * i) / N
      const dd = dist(at(t), q)
      if (dd < bd) { bd = dd; best = t }
    }
    let a = Math.max(lo, best - (hi - lo) / N), b = Math.min(hi, best + (hi - lo) / N)
    const g = (Math.sqrt(5) - 1) / 2
    const f = (t: number) => { const v = sub(at(t), q); return dot(v, v) }
    let c = b - g * (b - a), e = a + g * (b - a)
    let fc = f(c), fe = f(e)
    for (let i = 0; i < 60 && b - a > 1e-9; i++) {
      if (fc < fe) { b = e; e = c; fe = fc; c = b - g * (b - a); fc = f(c) }
      else { a = c; c = e; fc = fe; e = a + g * (b - a); fe = f(e) }
    }
    // polish: Newton on d/dt |C(t)-q|^2 = 0 using central differences, kept inside the bracket
    let t = (a + b) / 2
    const h = (hi - lo) * 1e-6
    for (let i = 0; i < 8; i++) {
      const f0 = f(t), fp = f(Math.min(hi, t + h)), fm = f(Math.max(lo, t - h))
      const d1 = (fp - fm) / (2 * h), d2 = (fp - 2 * f0 + fm) / (h * h)
      if (!(d2 > 0)) break
      const nt = Math.min(hi, Math.max(lo, t - d1 / d2))
      if (Math.abs(nt - t) < 1e-14) { t = nt; break }
      t = nt
    }
    return t
  }
  return { kind: "bspline", at, closest, range: [lo, hi], periodic: false }
}

/** chord length of a curve between two parameters, by dense sampling; for tolerances and tests */
export function arcLength(c: Curve, t0: number, t1: number, steps = 400): number {
  let s = 0
  let prev = c.at(t0)
  for (let i = 1; i <= steps; i++) {
    const cur = c.at(t0 + ((t1 - t0) * i) / steps)
    s += len(sub(cur, prev))
    prev = cur
  }
  return s
}
