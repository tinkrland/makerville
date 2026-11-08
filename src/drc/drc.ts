/**
 * Design rule check. Pure geometry on a Board, no I/O, fast enough to run on
 * every edit. Rule names follow KiCad's so results can be compared directly.
 *
 *   clearance           two copper items of different nets closer than the rule
 *   shorting_items      two copper items of different nets that overlap
 *   track_width         a track narrower than the minimum
 *   via_diameter        a via smaller than the minimum
 *   hole_size           a drill smaller than the minimum
 *   annular_width       copper ring around a drill thinner than the minimum
 *   hole_to_hole        two drills closer than the minimum (edge to edge)
 *   copper_edge_clearance  copper or a drill too close to the board edge
 *   unconnected_items   a net whose pads are not all joined by copper
 *   dangling_copper     tracks/vias on a net that reach no pad (warning; KiCad: track_dangling)
 *   courtyards_overlap  two footprints' courtyards overlap
 *   duplicate_ref       two footprints share a reference
 */
import type { Board, Footprint, Pad, Pt, Rules } from "../model.ts"
import { padWorld, padWorldSize } from "../model.ts"
import { type Shape, bounds, capsule, centre, circle, distance, oval, pointInPoly, ptSeg, rect } from "./shapes.ts"

export type Severity = "error" | "warning"

export interface Violation {
  type: string
  severity: Severity
  message: string
  at: Pt
  /** ids of the board objects involved: "R1.2" for a pad, track/via ids otherwise */
  items: string[]
  /** measured value and the limit it broke, in mm, when the rule is a distance */
  actual?: number
  required?: number
}

export interface DrcResult {
  violations: Violation[]
  errors: number
  warnings: number
  unconnected: { net: string; a: string; b: string; at: Pt; island?: boolean }[]
  ms: number
}

type Item = {
  id: string
  kind: "pad" | "track" | "via"
  net: string
  /** copper shape per layer it exists on */
  layers: Map<string, Shape>
  /** a drill, if any, as a circle */
  drill?: { c: Pt; r: number; plated: boolean }
  /** connected-component membership is by net name; pads with no net never connect */
  at: Pt
  /** the footprint reference for a pad, so a part's own pads can be told apart */
  owner?: string
}

export function runDrc(board: Board, rulesOverride?: Partial<Rules>): DrcResult {
  const t0 = Date.now()
  const rules: Rules = { ...board.rules, ...rulesOverride }
  const out: Violation[] = []
  const items = collect(board)

  // ---- spatial hash over copper items so clearance only compares neighbours
  const cell = Math.max(2, rules.clearance * 8)
  const grid = new Map<string, number[]>()
  const reach = rules.clearance
  items.forEach((it, i) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of it.layers.values()) {
      const b = bounds(s)
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    for (let x = Math.floor((minX - reach) / cell); x <= Math.floor((maxX + reach) / cell); x++)
      for (let y = Math.floor((minY - reach) / cell); y <= Math.floor((maxY + reach) / cell); y++) {
        const k = x + "," + y
        const l = grid.get(k)
        if (l) l.push(i)
        else grid.set(k, [i])
      }
  })

  const seen = new Set<string>()
  for (const bucket of grid.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a]!, j = bucket[b]!
        const key = i < j ? i + ":" + j : j + ":" + i
        if (seen.has(key)) continue
        seen.add(key)
        const A = items[i]!, B = items[j]!
        if (A.net === B.net && A.net !== "") continue // same net may touch
        // two pads of one footprint with no net each: still a clearance matter
        for (const [layer, sa] of A.layers) {
          const sb = B.layers.get(layer)
          if (!sb) continue
          const d = distance(sa, sb)
          if (d >= rules.clearance - 1e-9) continue
          if (d <= 1e-9) {
            // overlapping copper of different nets (or an unnetted item over a netted one)
            if (A.net === "" && B.net === "") continue // two unconnected items overlapping is a footprint matter, not a short
            out.push({ type: "shorting_items", severity: "error", message: `${label(A)} [${A.net || "no net"}] shorts ${label(B)} [${B.net || "no net"}] on ${layer}`, at: mid(A, B), items: [A.id, B.id], actual: 0, required: rules.clearance })
          } else {
            out.push({ type: "clearance", severity: "error", message: `Clearance ${d.toFixed(3)} mm < ${rules.clearance} mm between ${label(A)} and ${label(B)} on ${layer}`, at: mid(A, B), items: [A.id, B.id], actual: d, required: rules.clearance })
          }
          break // one report per pair, not one per layer
        }
      }
    }
  }

  // ---- per item rules
  for (const t of board.tracks) {
    if (t.width < rules.minTrackWidth - 1e-9) out.push({ type: "track_width", severity: "error", message: `Track ${t.width} mm is narrower than ${rules.minTrackWidth} mm (${t.net || "no net"})`, at: { x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2 }, items: [t.id], actual: t.width, required: rules.minTrackWidth })
  }
  for (const v of board.vias) {
    if (v.diameter < rules.minViaDiameter - 1e-9) out.push({ type: "via_diameter", severity: "error", message: `Via ${v.diameter} mm is smaller than ${rules.minViaDiameter} mm`, at: v.at, items: [v.id], actual: v.diameter, required: rules.minViaDiameter })
    if (v.drill < rules.minViaDrill - 1e-9) out.push({ type: "hole_size", severity: "error", message: `Via drill ${v.drill} mm is smaller than ${rules.minViaDrill} mm`, at: v.at, items: [v.id], actual: v.drill, required: rules.minViaDrill })
    const ring = (v.diameter - v.drill) / 2
    if (ring < rules.minAnnularRing - 1e-9) out.push({ type: "annular_width", severity: "error", message: `Via annular ring ${ring.toFixed(3)} mm < ${rules.minAnnularRing} mm`, at: v.at, items: [v.id], actual: ring, required: rules.minAnnularRing })
  }
  for (const fp of board.footprints) {
    for (const p of fp.pads) {
      if (!p.drill || p.kind === "npth") continue
      const ring = (Math.min(p.size.w, p.size.h) - p.drill) / 2
      if (ring < rules.minAnnularRing - 1e-9) out.push({ type: "annular_width", severity: "error", message: `Pad ${fp.ref}.${p.name} annular ring ${ring.toFixed(3)} mm < ${rules.minAnnularRing} mm`, at: padWorld(fp, p), items: [`${fp.ref}.${p.name}`], actual: ring, required: rules.minAnnularRing })
    }
  }

  // ---- drills: hole to hole and hole to edge
  const drills: { id: string; c: Pt; r: number }[] = []
  for (const it of items) if (it.drill) drills.push({ id: it.id, c: it.drill.c, r: it.drill.r })
  for (const h of board.holes) drills.push({ id: h.id, c: h.at, r: h.drill / 2 })
  for (let i = 0; i < drills.length; i++) for (let j = i + 1; j < drills.length; j++) {
    const a = drills[i]!, b = drills[j]!
    if (a.id === b.id) continue
    const d = Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y) - a.r - b.r
    if (d < rules.minHoleToHole - 1e-9) out.push({ type: "hole_to_hole", severity: "error", message: `Holes ${a.id} and ${b.id} are ${Math.max(0, d).toFixed(3)} mm apart, need ${rules.minHoleToHole} mm`, at: { x: (a.c.x + b.c.x) / 2, y: (a.c.y + b.c.y) / 2 }, items: [a.id, b.id], actual: Math.max(0, d), required: rules.minHoleToHole })
  }

  // ---- copper to board edge. Outline and cut-outs are polylines; copper must keep edgeClearance from each.
  const rings: Pt[][] = [board.outline, ...board.cutouts]
  const edgeSegs: [Pt, Pt][] = []
  for (const r of rings) for (let i = 0; i < r.length; i++) edgeSegs.push([r[i]!, r[(i + 1) % r.length]!])
  const edgeDist = (s: Shape): number => {
    let m = Infinity
    for (const [a, b] of edgeSegs) m = Math.min(m, distance(s, capsule(a, b, 0)))
    return m
  }
  const outsideBoard = (p: Pt) => !pointInPoly(p, board.outline) || board.cutouts.some((c) => pointInPoly(c.length ? p : p, c))
  const reported = new Set<string>()
  for (const it of items) {
    for (const [layer, s] of it.layers) {
      const key = it.id
      if (reported.has(key)) break
      const d = edgeDist(s)
      const c = centre(s)
      if (outsideBoard(c) || d < rules.edgeClearance - 1e-9) {
        reported.add(key)
        out.push({ type: "copper_edge_clearance", severity: "error", message: `${label(it)} is ${outsideBoard(c) ? "outside the board" : d.toFixed(3) + " mm from the edge"} (need ${rules.edgeClearance} mm)`, at: c, items: [it.id], actual: outsideBoard(c) ? 0 : d, required: rules.edgeClearance })
        void layer
      }
    }
  }
  for (const h of board.holes) {
    const d = edgeDist(circle(h.at, h.drill / 2))
    const pad = edgeDist(circle(h.at, h.pad / 2))
    if (!pointInPoly(h.at, board.outline) || d < rules.edgeClearance - 1e-9) out.push({ type: "copper_edge_clearance", severity: "error", message: `Hole ${h.id} is too close to the board edge (${d.toFixed(3)} mm, need ${rules.edgeClearance} mm)`, at: h.at, items: [h.id], actual: d, required: rules.edgeClearance })
    else if (pad < 0) void pad
  }

  // ---- connectivity
  const unconnected = connectivity(board, items)
  for (const u of unconnected) {
    if (u.island) out.push({ type: "dangling_copper", severity: "warning", message: `Net ${u.net}: copper at ${u.a} is not connected to any pad`, at: u.at, items: [u.a, u.b] })
    else out.push({ type: "unconnected_items", severity: "error", message: `Net ${u.net}: ${u.a} is not connected to ${u.b}`, at: u.at, items: [u.a, u.b] })
  }

  // ---- placement: courtyard overlap and duplicate references
  const courts = board.footprints.map((f) => ({ f, s: courtyard(f) }))
  for (let i = 0; i < courts.length; i++) for (let j = i + 1; j < courts.length; j++) {
    const a = courts[i]!, b = courts[j]!
    if (!a.s || !b.s || a.f.side !== b.f.side) continue
    if (distance(a.s, b.s) <= 0) out.push({ type: "courtyards_overlap", severity: "warning", message: `Courtyards of ${a.f.ref} and ${b.f.ref} overlap`, at: { x: (a.f.at.x + b.f.at.x) / 2, y: (a.f.at.y + b.f.at.y) / 2 }, items: [a.f.ref, b.f.ref] })
  }
  const refs = new Map<string, number>()
  for (const f of board.footprints) refs.set(f.ref, (refs.get(f.ref) ?? 0) + 1)
  for (const [r, n] of refs) if (n > 1) out.push({ type: "duplicate_ref", severity: "error", message: `Reference ${r} is used ${n} times`, at: board.footprints.find((f) => f.ref === r)!.at, items: [r] })

  out.sort((a, b) => (a.severity === b.severity ? a.type.localeCompare(b.type) : a.severity === "error" ? -1 : 1))
  const ratsnest = unconnected.filter((u) => !u.island)
  return { violations: out, errors: out.filter((v) => v.severity === "error").length, warnings: out.filter((v) => v.severity === "warning").length, unconnected: ratsnest, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------------------

function label(it: Item): string {
  return it.kind === "pad" ? `pad ${it.id}` : it.kind === "via" ? `via ${it.id}` : `track ${it.id}`
}

function mid(a: Item, b: Item): Pt {
  return { x: (a.at.x + b.at.x) / 2, y: (a.at.y + b.at.y) / 2 }
}

function padShape(fp: Footprint, p: Pad): Shape {
  const w = padWorld(fp, p)
  const sz = padWorldSize(fp, p)
  const rot = fp.rotation % 180 === 0 ? 0 : fp.rotation
  const q = Math.round(((fp.rotation % 360) + 360) % 360)
  const axis = q % 90 === 0
  if (p.shape === "circle") return circle(w, Math.max(sz.w, sz.h) / 2)
  if (p.shape === "oval") return oval(w, sz.w, sz.h, axis ? 0 : rot)
  return rect(w, sz.w, sz.h, axis ? 0 : rot)
}

function collect(board: Board): Item[] {
  const items: Item[] = []
  for (const fp of board.footprints) {
    for (const p of fp.pads) {
      const shape = padShape(fp, p)
      const layers = new Map<string, Shape>()
      const ls = p.kind === "npth" ? [] : p.kind === "smd" ? [fp.side === "bottom" ? flipLayer(p.layers[0] ?? "F.Cu", board.copper) : p.layers[0] ?? "F.Cu"] : board.copper
      for (const l of ls) layers.set(l, shape)
      const at = padWorld(fp, p)
      items.push({ id: `${fp.ref}.${p.name}`, kind: "pad", net: p.net, layers, at, owner: fp.ref, drill: p.drill ? { c: at, r: p.drill / 2, plated: p.kind === "thru" } : undefined })
    }
  }
  for (const t of board.tracks) {
    const layers = new Map<string, Shape>([[t.layer, capsule(t.a, t.b, t.width / 2)]])
    items.push({ id: t.id, kind: "track", net: t.net, layers, at: { x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2 } })
  }
  for (const v of board.vias) {
    const layers = new Map<string, Shape>()
    const lo = board.copper.indexOf(v.from)
    const hi = board.copper.indexOf(v.to)
    for (let k = Math.min(lo, hi); k <= Math.max(lo, hi); k++) if (k >= 0) layers.set(board.copper[k]!, circle(v.at, v.diameter / 2))
    items.push({ id: v.id, kind: "via", net: v.net, layers, at: v.at, drill: { c: v.at, r: v.drill / 2, plated: true } })
  }
  return items
}

function flipLayer(l: string, copper: string[]): string {
  return l === "F.Cu" ? copper[copper.length - 1]! : l === "B.Cu" ? copper[0]! : l
}

function courtyard(f: Footprint): Shape | null {
  const g = f.graphics.filter((x) => x.layer.endsWith("CrtYd") && x.kind === "rect")[0]
  if (!g) return null
  const w = Math.abs(g.b.x - g.a.x)
  const h = Math.abs(g.b.y - g.a.y)
  const c = padWorld(f, { name: "", kind: "smd", shape: "rect", at: { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }, size: { w: 0, h: 0 }, layers: [], net: "" })
  return rect(c, w, h, f.rotation)
}

/**
 * Connectivity by flood fill. Two copper items on the same net are joined when
 * their shapes touch on a shared layer; a via joins every layer it spans. A net
 * is complete when all its pads fall in one component.
 */
function connectivity(board: Board, items: Item[]): { net: string; a: string; b: string; at: Pt; island?: boolean }[] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  const byNet = new Map<string, number[]>()
  items.forEach((it, i) => {
    if (it.net === "") return
    if (!byNet.has(it.net)) byNet.set(it.net, [])
    byNet.get(it.net)!.push(i)
  })
  const res: { net: string; a: string; b: string; at: Pt; island?: boolean }[] = []
  for (const [net, idx] of byNet) {
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const A = items[idx[a]!]!, B = items[idx[b]!]!
      for (const [l, sa] of A.layers) {
        const sb = B.layers.get(l)
        if (sb && distance(sa, sb) <= 1e-6) {
          union(idx[a]!, idx[b]!)
          break
        }
      }
    }
    const pads = idx.filter((i) => items[i]!.kind === "pad")
    // islands: a group of tracks/vias on this net that touches no pad at all is floating copper
    const padRoots = new Set(pads.map((i) => find(i)))
    const islandSeen = new Set<number>()
    for (const i of idx) {
      const r = find(i)
      if (padRoots.has(r) || islandSeen.has(r)) continue
      islandSeen.add(r)
      const members = idx.filter((k) => find(k) === r)
      const first = items[members[0]!]!
      res.push({ net, a: first.id, b: members.length > 1 ? items[members[members.length - 1]!]!.id : first.id, at: first.at, island: true })
    }
    if (pads.length < 2) continue
    const root = find(pads[0]!)
    for (const p of pads.slice(1)) {
      if (find(p) !== root) {
        const comp = find(p)
        if (!res.some((r) => r.net === net && !r.island && find(items.findIndex((x) => x.id === r.b)) === comp)) {
          res.push({ net, a: items[pads[0]!]!.id, b: items[p]!.id, at: items[p]!.at })
        }
      }
    }
  }
  return res
}

export { collect as _collectForTests, ptSeg as _ptSeg }
