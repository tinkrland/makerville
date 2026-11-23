/**
 * Placement legality: do two parts collide, and does a part fit on the board.
 *
 * An auto-placer is only worth having if it can tell a legal arrangement from an illegal one, so this is the
 * piece that gets measured first. A footprint's extent is its body rectangle turned by the footprint's
 * rotation, which is an oriented box, not an axis-aligned one: a 45 degree part overlaps things that a
 * bounding-box test would call clear, and a bounding-box test would also call clear two parts that are only
 * separated by a hair.
 *
 * So the overlap test is separating-axis on the two oriented boxes, which is exact for convex shapes, and the
 * board test is corner containment PLUS an edge-crossing check. Corners alone are not enough: a small part can
 * sit in a notch of a concave outline with all four corners inside and still hang over the edge.
 *
 * Everything is in board-model millimetres (x right, y up), matching the rest of the model.
 */
import type { Board, Footprint, Pt } from "../model.ts"

/** an oriented box: centre, size before rotation, and rotation in degrees counter-clockwise */
export interface Obb {
  cx: number
  cy: number
  w: number
  h: number
  rot: number
}

const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * The hair subtracted from the closed bounds. It has to sit between two much larger numbers: well above the
 * ~1e-15 of floating-point dust that two exactly-touching boxes produce, and well below the tolerance any test
 * or caller would use when comparing sizes. 1e-12 is a thousand times either way.
 */
const EPS = 1e-12

/** the box a footprint occupies: its body, at its position and rotation */
export function footprintObb(fp: Pick<Footprint, "at" | "rotation" | "body">): Obb {
  return { cx: fp.at.x, cy: fp.at.y, w: fp.body.w, h: fp.body.h, rot: fp.rotation }
}

/** the four corners, counter-clockwise from the one at (-w/2, -h/2) in the box's own frame */
export function obbCorners(b: Obb): Pt[] {
  const c = Math.cos(rad(b.rot))
  const s = Math.sin(rad(b.rot))
  const hw = b.w / 2
  const hh = b.h / 2
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({ x: b.cx + x! * c - y! * s, y: b.cy + x! * s + y! * c }))
}

/** the box grown by `by` on every side, used to enforce a clearance */
function grown(b: Obb, by: number): Obb {
  return { ...b, w: b.w + by * 2, h: b.h + by * 2 }
}

/** the unit axes a box's faces are perpendicular to */
function axes(b: Obb): Pt[] {
  const c = Math.cos(rad(b.rot))
  const s = Math.sin(rad(b.rot))
  return [
    { x: c, y: s },
    { x: -s, y: c },
  ]
}

const project = (pts: Pt[], ax: Pt): [number, number] => {
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    const d = p.x * ax.x + p.y * ax.y
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return [lo, hi]
}

/**
 * How far two boxes overlap, in mm. Zero means they are at least `clearance` apart.
 *
 * The number is the smallest penetration across all four separating axes, which is the depth you would have to
 * push one box to clear the other: useful to an annealer that wants to know how bad an overlap is, not just
 * that one exists.
 */
export function overlapDepth(a: Obb, b: Obb, clearance = 0): number {
  // Inflate both by half the clearance, so the test enforces a gap of `clearance` between the real shapes. The
  // clearance is a CLOSED bound, like the board margin: parts packed exactly `clearance` apart are legal. The
  // hair subtracted here is what makes that true, because without it two parts sitting exactly at the limit
  // report a penetration of about 1e-15 and a legal arrangement is called illegal.
  const half = clearance / 2 - EPS
  const A = grown(a, half)
  const B = grown(b, half)
  const ca = obbCorners(A)
  const cb = obbCorners(B)
  let depth = Infinity
  for (const ax of [...axes(A), ...axes(B)]) {
    const [alo, ahi] = project(ca, ax)
    const [blo, bhi] = project(cb, ax)
    const pen = Math.min(ahi, bhi) - Math.max(alo, blo)
    if (pen <= 0) return 0 // a separating axis exists, so they are apart
    if (pen < depth) depth = pen
  }
  return depth === Infinity ? 0 : depth
}

/** true when the boxes are closer than `clearance` */
export function overlaps(a: Obb, b: Obb, clearance = 0): boolean {
  return overlapDepth(a, b, clearance) > 0
}

/** crossing-number point in polygon; the outline may be convex or not */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** true when the open segments a-b and c-d properly cross */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const orient = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0
}

/**
 * Whether a box lies inside the board outline, keeping `margin` clear of the edge.
 *
 * Both checks are needed. Corner containment alone misses a box poking through a concave notch; edge crossing
 * alone misses a box that is entirely outside the board. The margin is applied by testing the corners of the
 * grown box and by requiring no edge crossing, which is conservative in the right direction.
 */
export function insideOutline(outline: Pt[], b: Obb, margin = 0): boolean {
  if (outline.length < 3) return false
  // The margin is a CLOSED bound: a part exactly `margin` from the edge is legal, and a part that packs flush
  // against it is the common case, not an edge case. Shrinking the grown box by a hair keeps the test on the
  // inside of the boundary, where point-in-polygon is unambiguous. Without this, a flush-packed part has its
  // edge exactly on the outline and the crossing-number test calls those corners outside.
  // applied at margin 0 as well: a body resting exactly on the board edge is on the board
  const box = grown(b, margin - EPS)
  const corners = obbCorners(box)
  for (const c of corners) if (!pointInPolygon(c, outline)) return false
  for (let i = 0; i < 4; i++) {
    const p = corners[i]!
    const q = corners[(i + 1) % 4]!
    for (let j = 0; j < outline.length; j++) {
      const a = outline[j]!
      const c2 = outline[(j + 1) % outline.length]!
      if (segmentsCross(p, q, a, c2)) return false
    }
  }
  return true
}

export interface PlacementIssue {
  kind: "overlap" | "off-board"
  /** the footprints involved, by ref */
  refs: string[]
  /** mm of penetration for an overlap; mm outside the outline is not measured, so 0 */
  amount: number
}

export interface PlacementOptions {
  /** minimum gap between two bodies, mm. Default 0: touching is legal. */
  clearance?: number
  /** minimum gap to the board edge, mm */
  margin?: number
  /** refs to ignore entirely (fiducials, logos, mounting holes placed by hand) */
  ignore?: string[]
}

/**
 * Everything wrong with a placement. Empty means legal, which is the only thing an auto-placer may report as
 * success.
 */
export function placementIssues(board: Pick<Board, "outline" | "footprints">, opts: PlacementOptions = {}): PlacementIssue[] {
  const clearance = opts.clearance ?? 0
  const margin = opts.margin ?? 0
  const skip = new Set(opts.ignore ?? [])
  const fps = board.footprints.filter((f) => !skip.has(f.ref))
  const issues: PlacementIssue[] = []
  for (const f of fps) {
    const b = footprintObb(f)
    if (!insideOutline(board.outline, b, margin)) issues.push({ kind: "off-board", refs: [f.ref], amount: 0 })
  }
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const d = overlapDepth(footprintObb(fps[i]!), footprintObb(fps[j]!), clearance)
      if (d > 0) issues.push({ kind: "overlap", refs: [fps[i]!.ref, fps[j]!.ref], amount: d })
    }
  }
  return issues
}
