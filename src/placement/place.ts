/**
 * Auto-placement.
 *
 * The job: take a board whose footprints are wherever they happen to be, and find an arrangement that is legal
 * and shortens the wiring. "Legal" is not negotiable and is defined by `placementIssues` from `legal.ts`, so
 * this module never reports success while that returns anything. "Shorter" is the half-perimeter wire length of
 * every net's pads, which is the standard cheap proxy for routed length.
 *
 * Method is simulated annealing over three moves: shift one part, swap two parts, turn one part a quarter. It
 * starts from a packed legal arrangement rather than from the incoming positions, because a board that arrives
 * with everything stacked on the origin gives the search nothing to work with. Overlaps are not rejected
 * outright, they are priced: a candidate that overlaps is allowed only while the temperature is high, and the
 * penalty is proportional to the penetration depth, which is why `overlapDepth` returns millimetres instead of
 * a boolean.
 *
 * Everything is deterministic given `seed`. That matters more than it sounds: an auto-placer that returns a
 * different answer each run cannot be tested, and a user who re-runs it after a crash would not recognise
 * their own board.
 */
import type { Board, Footprint, Pt } from "../model.ts"
import { padWorld, polygonBounds } from "../model.ts"
import { footprintObb, placementIssues, overlapDepth, insideOutline, type PlacementIssue } from "./legal.ts"

export interface PlaceOptions {
  /** minimum gap between two bodies, mm */
  clearance?: number
  /** minimum gap to the board edge, mm */
  margin?: number
  /** deterministic seed. Same seed and same input gives the same output. */
  seed?: number
  /** effort: annealing steps. Default 8000. Measured: 8000 with this temperature beats 2000 on every seed. */
  steps?: number
  /** refs that must not move */
  fixed?: string[]
  /** how heavily an overlap is punished, in mm of wire length per mm of penetration. Default 1000. */
  overlapWeight?: number
}

export interface PlaceResult {
  /** the arranged footprints; unchanged refs, new positions */
  footprints: Footprint[]
  /** true only when `placementIssues` returns nothing for the result */
  legal: boolean
  issues: PlacementIssue[]
  /** half-perimeter wire length of the result, mm */
  wireLength: number
  /** wire length of the packed start, before annealing. The packed start may be illegal on a tight board; only
   * the final result is promised to be legal. */
  startWireLength: number
  /** the incoming wire length, for reference */
  incomingWireLength: number
  /** moves actually applied */
  accepted: number
}

/** mulberry32: small, fast, and identical across machines, which is what determinism needs */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** half-perimeter wire length: for each net, the bounding box of its pads */
export function wireLength(fps: Footprint[]): number {
  const byNet = new Map<string, Pt[]>()
  for (const f of fps) {
    for (const p of f.pads) {
      if (!p.net) continue
      const w = padWorld(f, p)
      const list = byNet.get(p.net)
      if (list) list.push(w)
      else byNet.set(p.net, [w])
    }
  }
  let total = 0
  for (const pts of byNet.values()) {
    if (pts.length < 2) continue
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of pts) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    total += maxX - minX + (maxY - minY)
  }
  return total
}

/** total penetration across all overlapping pairs, mm. Zero when nothing overlaps. */
function totalOverlap(fps: Footprint[], clearance: number): number {
  let sum = 0
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const a = footprintObb(fps[i]!)
      const b = footprintObb(fps[j]!)
      // inline the depth so the hot loop does not allocate corners twice
      const d = overlapDepth(a, b, clearance)
      if (d > 0) sum += d
    }
  }
  return sum
}

/** how far outside the outline a part reaches, in mm. Zero when it is inside. */
function outsideAmount(outline: Pt[], fps: Footprint[], margin: number): number {
  let sum = 0
  for (const f of fps) {
    const b = footprintObb(f)
    if (insideOutline(outline, b, margin)) continue
    // a rough measure of how far out: the distance of the body centre beyond the outline's bounding box
    const bb = polygonBounds(outline)
    const dx = Math.max(0, bb.minX + margin - b.cx, b.cx - (bb.maxX - margin))
    const dy = Math.max(0, bb.minY + margin - b.cy, b.cy - (bb.maxY - margin))
    sum += Math.max(dx, dy, 0.5) // a part that is outside for a shape reason still costs something
  }
  return sum
}

/**
 * Pack parts into rows inside the outline's bounding box. This is only a starting point: it is legal when it
 * fits, and when it does not the search is told so by the penalty rather than by an exception.
 */
function packStart(outline: Pt[], fps: Footprint[], clearance: number, margin: number, fixed: Set<string>): Footprint[] {
  const bb = polygonBounds(outline)
  const left = bb.minX + margin
  const right = bb.maxX - margin
  const top = bb.maxY - margin
  const bottom = bb.minY - margin

  // tall parts first, then wide: the usual shelf packing that keeps rows shallow
  // a fixed part keeps the position it was given: packing it and then refusing to move it in the search would
  // silently ignore the caller's anchor
  const placed = fps.map((f) => ({ ...f, at: { ...f.at } }))
  const order = fps
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !fixed.has(f.ref))
    .sort((a, b) => (b.f.body.h - a.f.body.h) || (b.f.body.w - a.f.body.w) || (a.i - b.i))

  let x = left
  let y = top
  let rowHeight = 0
  for (const { f, i } of order) {
    const w = f.body.w
    const h = f.body.h
    if (x + w > right && x > left) {
      x = left
      y -= rowHeight + clearance
      rowHeight = 0
    }
    // place by centre; the shelf is measured to the body's bottom-left corner
    const cx = x + w / 2
    const cy = y - h / 2
    placed[i] = { ...f, at: { x: cx, y: cy } }
    x += w + clearance
    rowHeight = Math.max(rowHeight, h)
    // if this ran past the bottom of the board the part stays where it is and the penalty reports it: a packer
    // that silently drops parts would look like it succeeded
  }
  void bottom
  return placed
}

export function autoPlace(board: Pick<Board, "outline" | "footprints">, opts: PlaceOptions = {}): PlaceResult {
  const clearance = opts.clearance ?? 0.5
  const margin = opts.margin ?? 0.5
  const steps = opts.steps ?? 8000
  const overlapWeight = opts.overlapWeight ?? 1000
  const fixed = new Set(opts.fixed ?? [])
  const random = rng(opts.seed ?? 1)

  const incoming = board.footprints.map((f) => ({ ...f, at: { ...f.at } }))
  const incomingWire = wireLength(incoming)

  let cur = packStart(board.outline, incoming, clearance, margin, fixed)
  const startWire = wireLength(cur)

  const score = (fps: Footprint[]): number =>
    wireLength(fps) + overlapWeight * totalOverlap(fps, clearance) + overlapWeight * outsideAmount(board.outline, fps, margin)

  let curScore = score(cur)
  let best = cur.map((f) => ({ ...f, at: { ...f.at } }))
  let bestScore = curScore
  let accepted = 0

  // the free indices are decided once, so a fixed part never moves and the RNG stream stays reproducible
  const free: number[] = []
  cur.forEach((f, i) => { if (!fixed.has(f.ref)) free.push(i) })

  const t0 = Math.max(1, curScore) * 0.3
  const t1 = 0.01
  for (let step = 0; step < steps; step++) {
    if (free.length === 0) break
    const t = t0 * Math.pow(t1 / t0, step / Math.max(1, steps - 1))
    const move = random()
    const cand = cur.map((f) => ({ ...f, at: { ...f.at } }))
    if (move < 0.55) {
      // shift one part
      const i = free[Math.floor(random() * free.length)]!
      const spread = 2 + 12 * (1 - step / Math.max(1, steps - 1))
      cand[i]!.at = { x: cand[i]!.at.x + (random() * 2 - 1) * spread, y: cand[i]!.at.y + (random() * 2 - 1) * spread }
    } else if (move < 0.85) {
      // swap two parts
      if (free.length < 2) continue
      const i = free[Math.floor(random() * free.length)]!
      let j = free[Math.floor(random() * free.length)]!
      if (i === j) j = free[(free.indexOf(i) + 1) % free.length]!
      const a = cand[i]!.at
      cand[i]!.at = cand[j]!.at
      cand[j]!.at = a
    } else {
      // turn one part a quarter
      const i = free[Math.floor(random() * free.length)]!
      cand[i]!.rotation = (cand[i]!.rotation + 90) % 360
    }
    const s = score(cand)
    const delta = s - curScore
    if (delta <= 0 || random() < Math.exp(-delta / Math.max(t, 1e-9))) {
      cur = cand
      curScore = s
      accepted++
      if (s < bestScore) {
        bestScore = s
        best = cand.map((f) => ({ ...f, at: { ...f.at } }))
      }
    }
  }

  const issues = placementIssues({ outline: board.outline, footprints: best }, { clearance, margin })
  return {
    footprints: best,
    legal: issues.length === 0,
    issues,
    wireLength: wireLength(best),
    startWireLength: startWire,
    incomingWireLength: incomingWire,
    accepted,
  }
}
