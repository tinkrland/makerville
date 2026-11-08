/**
 * Exact 2D shapes for copper and the edge-to-edge distance between any two.
 *
 * Every copper item reduces to one of three primitives:
 *   circle   centre + radius              (round pad, via, drilled hole)
 *   capsule  segment + radius             (track, oval pad)
 *   poly     convex or concave polygon    (rect pad, rotated pad, outline)
 *
 * distance(a, b) is the gap between the two filled shapes: 0 if they touch or
 * overlap, otherwise the shortest edge-to-edge distance. Clearance rules are
 * then a plain `distance < clearance` comparison.
 */
import type { Pt } from "../model.ts"

export type Circle = { kind: "circle"; c: Pt; r: number }
export type Capsule = { kind: "capsule"; a: Pt; b: Pt; r: number }
export type Poly = { kind: "poly"; pts: Pt[] }
export type Shape = Circle | Capsule | Poly

export const circle = (c: Pt, r: number): Circle => ({ kind: "circle", c, r })
export const capsule = (a: Pt, b: Pt, r: number): Capsule => ({ kind: "capsule", a, b, r })
export const poly = (pts: Pt[]): Poly => ({ kind: "poly", pts })

/** rectangle centred at c, w x h, rotated ccw by deg */
export function rect(c: Pt, w: number, h: number, deg = 0): Poly {
  const r = (deg * Math.PI) / 180
  const cs = Math.cos(r)
  const sn = Math.sin(r)
  const hw = w / 2
  const hh = h / 2
  const p = (x: number, y: number): Pt => ({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs })
  return poly([p(-hw, -hh), p(hw, -hh), p(hw, hh), p(-hw, hh)])
}

/** an oval pad is a capsule along its long axis */
export function oval(c: Pt, w: number, h: number, deg = 0): Capsule | Circle {
  const r = (deg * Math.PI) / 180
  if (Math.abs(w - h) < 1e-9) return circle(c, w / 2)
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const half = (long - short) / 2
  const ang = w >= h ? r : r + Math.PI / 2
  const dx = Math.cos(ang) * half
  const dy = Math.sin(ang) * half
  return capsule({ x: c.x - dx, y: c.y - dy }, { x: c.x + dx, y: c.y + dy }, short / 2)
}

// ---- primitive distances ---------------------------------------------------

export function ptSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

export function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  const on = (p: Pt, q: Pt, r: Pt) => Math.min(p.x, q.x) - 1e-12 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-12 && Math.min(p.y, q.y) - 1e-12 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-12
  if (Math.abs(d1) < 1e-12 && on(c, d, a)) return true
  if (Math.abs(d2) < 1e-12 && on(c, d, b)) return true
  if (Math.abs(d3) < 1e-12 && on(a, b, c)) return true
  if (Math.abs(d4) < 1e-12 && on(a, b, d)) return true
  return false
}

export function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segsIntersect(a, b, c, d)) return 0
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b))
}

export function pointInPoly(p: Pt, pts: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!
    const b = pts[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function ptPolyEdge(p: Pt, pts: Pt[]): number {
  let m = Infinity
  for (let i = 0; i < pts.length; i++) m = Math.min(m, ptSeg(p, pts[i]!, pts[(i + 1) % pts.length]!))
  return m
}

function segPoly(a: Pt, b: Pt, pts: Pt[]): number {
  if (pointInPoly(a, pts) || pointInPoly(b, pts)) return 0
  let m = Infinity
  for (let i = 0; i < pts.length; i++) m = Math.min(m, segSeg(a, b, pts[i]!, pts[(i + 1) % pts.length]!))
  return m
}

function polyPoly(p: Pt[], q: Pt[]): number {
  if (pointInPoly(p[0]!, q) || pointInPoly(q[0]!, p)) return 0
  let m = Infinity
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) m = Math.min(m, segSeg(p[i]!, p[(i + 1) % p.length]!, q[j]!, q[(j + 1) % q.length]!))
  return m
}

/** gap between two filled shapes, 0 when they touch or overlap */
export function distance(a: Shape, b: Shape): number {
  if (a.kind === "circle" && b.kind === "circle") return Math.max(0, Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) - a.r - b.r)
  if (a.kind === "circle" && b.kind === "capsule") return Math.max(0, ptSeg(a.c, b.a, b.b) - a.r - b.r)
  if (a.kind === "capsule" && b.kind === "circle") return distance(b, a)
  if (a.kind === "capsule" && b.kind === "capsule") return Math.max(0, segSeg(a.a, a.b, b.a, b.b) - a.r - b.r)
  if (a.kind === "circle" && b.kind === "poly") return pointInPoly(a.c, b.pts) ? 0 : Math.max(0, ptPolyEdge(a.c, b.pts) - a.r)
  if (a.kind === "poly" && b.kind === "circle") return distance(b, a)
  if (a.kind === "capsule" && b.kind === "poly") return Math.max(0, segPoly(a.a, a.b, b.pts) - a.r)
  if (a.kind === "poly" && b.kind === "capsule") return distance(b, a)
  return polyPoly((a as Poly).pts, (b as Poly).pts)
}

export function bounds(s: Shape): { minX: number; minY: number; maxX: number; maxY: number } {
  if (s.kind === "circle") return { minX: s.c.x - s.r, minY: s.c.y - s.r, maxX: s.c.x + s.r, maxY: s.c.y + s.r }
  if (s.kind === "capsule") return { minX: Math.min(s.a.x, s.b.x) - s.r, minY: Math.min(s.a.y, s.b.y) - s.r, maxX: Math.max(s.a.x, s.b.x) + s.r, maxY: Math.max(s.a.y, s.b.y) + s.r }
  const xs = s.pts.map((p) => p.x)
  const ys = s.pts.map((p) => p.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/** a representative point, used to place the marker in the UI */
export function centre(s: Shape): Pt {
  if (s.kind === "circle") return s.c
  if (s.kind === "capsule") return { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }
  const b = bounds(s)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}
