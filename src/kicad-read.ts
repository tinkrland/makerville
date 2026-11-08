/**
 * .kicad_pcb -> Board. The reverse of kicad-write.
 *
 * Reads files saved by KiCad 7, 8 or 9 (the s-expression layout is the same
 * for everything this reads) as well as files written by kicad-write.
 *
 * What it reads: outline (Edge.Cuts lines, arcs, rects, circles, polys),
 * nets, footprints with pads / graphics / reference / value / 3D model,
 * segments, vias. Arcs are flattened to polylines. Zones are counted but not
 * modelled yet (reported in `skipped`).
 */
import type { Board, Footprint, FootprintGraphic, Pad, Pt, Track, Via } from "./model.ts"
import { DEFAULT_RULES } from "./model.ts"
import { type List, parse, head, all, first, at, numAt, field, textField, isList, isAtom } from "./sexp.ts"

export interface ReadResult {
  board: Board
  /** things in the file this reader does not model, with counts */
  skipped: Record<string, number>
  warnings: string[]
}

const PAGE: Record<string, Pt> = {} // reserved for future page-origin handling

/** KiCad page coordinates are y-down; we recentre on the outline and flip */
export function readKicadPcb(text: string): ReadResult {
  const root = parse(text)
  if (head(root) !== "kicad_pcb") throw new Error(`not a kicad_pcb file (starts with "${head(root)}")`)
  const warnings: string[] = []
  const skipped: Record<string, number> = {}
  const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1)

  // ---- nets (id -> name)
  const netName = new Map<number, string>([[0, ""]])
  for (const n of all(root, "net")) {
    const id = numAt(n, 1)
    const nm = at(n, 2)
    if (id !== undefined && nm !== undefined) netName.set(id, nm)
  }

  // KiCad 7+ writes `(net 3)` inside segments/vias/pads (id only) in some versions and
  // `(net "name")` in the newest. Accept both.
  const netOf = (l: List): string => {
    const n = first(l, "net")
    if (!n) return ""
    const a = at(n, 1)
    if (a === undefined) return ""
    const asNum = Number(a)
    const second = at(n, 2)
    if (second !== undefined) return second
    if (Number.isInteger(asNum) && netName.has(asNum)) return netName.get(asNum)!
    return a
  }

  // ---- copper layers
  const copper: string[] = []
  const layers = first(root, "layers")
  if (layers) {
    for (const l of layers) {
      if (!isList(l)) continue
      const nm = at(l, 1)
      if (nm && /\.Cu$/.test(nm)) copper.push(nm)
    }
  }
  if (copper.length === 0) copper.push("F.Cu", "B.Cu")

  const thickness = field(first(root, "general") ?? [], "thickness") ?? 1.6

  // ---- outline: gather every Edge.Cuts primitive as a segment soup, then chain it
  const edge: [Pt, Pt][] = []
  const Y = (y: number) => -y // flip once, recentre after
  const P = (x: number, y: number): Pt => ({ x, y: Y(y) })
  const onEdge = (l: List) => textField(l, "layer") === "Edge.Cuts"
  const pt = (l: List | undefined): Pt | undefined => (l && numAt(l, 1) !== undefined && numAt(l, 2) !== undefined ? P(numAt(l, 1)!, numAt(l, 2)!) : undefined)

  for (const g of all(root, "gr_line")) if (onEdge(g)) {
    const a = pt(first(g, "start"))
    const b = pt(first(g, "end"))
    if (a && b) edge.push([a, b])
  }
  for (const g of all(root, "gr_rect")) if (onEdge(g)) {
    const a = pt(first(g, "start"))
    const b = pt(first(g, "end"))
    if (a && b) {
      const c: Pt[] = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
      for (let i = 0; i < 4; i++) edge.push([c[i]!, c[(i + 1) % 4]!])
    }
  }
  for (const g of all(root, "gr_arc")) if (onEdge(g)) {
    const s = pt(first(g, "start"))
    const m = pt(first(g, "mid"))
    const e = pt(first(g, "end"))
    if (s && m && e) {
      const poly = arcThrough(s, m, e)
      for (let i = 0; i < poly.length - 1; i++) edge.push([poly[i]!, poly[i + 1]!])
    }
  }
  const circles: Pt[][] = []
  for (const g of all(root, "gr_circle")) if (onEdge(g)) {
    const c = pt(first(g, "center"))
    const e = pt(first(g, "end"))
    if (c && e) circles.push(circlePoly(c, Math.hypot(e.x - c.x, e.y - c.y)))
  }
  for (const g of all(root, "gr_poly")) if (onEdge(g)) {
    const pts = first(g, "pts")
    const poly: Pt[] = []
    for (const xy of pts ? all(pts, "xy") : []) {
      const p = pt(xy)
      if (p) poly.push(p)
    }
    if (poly.length >= 3) circles.push(poly)
  }

  const loops = chainLoops(edge)
  for (const c of circles) loops.push(c)
  if (loops.length === 0) warnings.push("no closed outline found on Edge.Cuts")
  // largest loop is the board, others are cut-outs
  loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))

  // ---- footprints
  const fps: Footprint[] = []
  const holes: Board["holes"] = []
  for (const f of all(root, "footprint")) {
    const lib = at(f, 1) ?? "unknown"
    const atN = first(f, "at")
    const fx = numAt(atN, 1) ?? 0
    const fy = numAt(atN, 2) ?? 0
    const rotKicad = numAt(atN, 3) ?? 0
    const side: "top" | "bottom" = textField(f, "layer") === "B.Cu" ? "bottom" : "top"
    let ref = ""
    let value = ""
    for (const p of all(f, "property")) {
      const k = at(p, 1)
      if (k === "Reference") ref = at(p, 2) ?? ""
      if (k === "Value") value = at(p, 2) ?? ""
    }
    // older files use fp_text
    for (const t of all(f, "fp_text")) {
      if (at(t, 1) === "reference") ref = at(t, 2) ?? ref
      if (at(t, 1) === "value") value = at(t, 2) ?? value
    }

    const pads: Pad[] = []
    for (const p of all(f, "pad")) {
      const kindTxt = at(p, 2)
      const shape = at(p, 3) as Pad["shape"]
      const kind: Pad["kind"] = kindTxt === "smd" ? "smd" : kindTxt === "np_thru_hole" ? "npth" : "thru"
      if (kindTxt === "connect") {
        skip("edge-connector pads")
        continue
      }
      const pat = first(p, "at")
      const sz = first(p, "size")
      const drill = field(p, "drill")
      const lay: string[] = []
      const ll = first(p, "layers")
      if (ll) for (let i = 1; i < ll.length; i++) {
        const v = at(ll, i)
        if (v) lay.push(v)
      }
      const cu = lay.filter((x) => /\.Cu$/.test(x))
      const layersOut = cu.length ? (cu.some((x) => x.startsWith("*")) ? ["F.Cu", "B.Cu"] : cu) : kind === "smd" ? [side === "top" ? "F.Cu" : "B.Cu"] : ["F.Cu", "B.Cu"]
      pads.push({
        name: at(p, 1) ?? "",
        kind,
        shape: (["rect", "circle", "oval", "roundrect"].includes(shape) ? shape : "rect") as Pad["shape"],
        at: { x: numAt(pat, 1) ?? 0, y: -(numAt(pat, 2) ?? 0) },
        size: { w: numAt(sz, 1) ?? 0, h: numAt(sz, 2) ?? numAt(sz, 1) ?? 0 },
        drill: drill,
        layers: layersOut,
        net: netOf(p),
      })
    }

    // a lone non-plated pad in a footprint that is just a hole becomes a MountHole
    if (pads.length === 1 && /MountingHole/i.test(lib) && pads[0]!.drill) {
      holes.push({ id: ref || `H${holes.length + 1}`, at: { x: fx, y: Y(fy) }, drill: pads[0]!.drill!, pad: pads[0]!.size.w })
      continue
    }

    const graphics: FootprintGraphic[] = []
    const gl = (l: List) => textField(l, "layer") ?? ""
    const gw = (l: List) => field(first(l, "stroke") ?? [], "width") ?? field(l, "width") ?? 0.1
    for (const g of all(f, "fp_line")) {
      const a = first(g, "start"), b = first(g, "end")
      graphics.push({ kind: "line", layer: gl(g), a: { x: numAt(a, 1) ?? 0, y: -(numAt(a, 2) ?? 0) }, b: { x: numAt(b, 1) ?? 0, y: -(numAt(b, 2) ?? 0) }, width: gw(g) })
    }
    for (const g of all(f, "fp_rect")) {
      const a = first(g, "start"), b = first(g, "end")
      graphics.push({ kind: "rect", layer: gl(g), a: { x: numAt(a, 1) ?? 0, y: -(numAt(a, 2) ?? 0) }, b: { x: numAt(b, 1) ?? 0, y: -(numAt(b, 2) ?? 0) }, width: gw(g) })
    }
    for (const g of all(f, "fp_circle")) {
      const a = first(g, "center"), b = first(g, "end")
      graphics.push({ kind: "circle", layer: gl(g), a: { x: numAt(a, 1) ?? 0, y: -(numAt(a, 2) ?? 0) }, b: { x: numAt(b, 1) ?? 0, y: -(numAt(b, 2) ?? 0) }, width: gw(g) })
    }
    for (const k of ["fp_arc", "fp_poly", "fp_curve"]) for (const _ of all(f, k)) skip(k)

    // body size: courtyard if present, else the pad extents
    const cyard = graphics.filter((g) => g.layer.endsWith("CrtYd"))
    const body = bodyFrom(cyard, pads)

    const m3 = first(f, "model")
    const fp: Footprint = {
      ref: ref || `U${fps.length + 1}`,
      value,
      lib,
      at: { x: fx, y: Y(fy) },
      rotation: -rotKicad,
      side,
      pads,
      graphics,
      height: 0,
      body,
    }
    if (m3) {
      const path = at(m3, 1)
      if (path) fp.model = { path }
    }
    fps.push(fp)
  }

  for (const z of all(root, "zone")) skip("zone")
  for (const _ of all(root, "gr_text")) skip("gr_text")

  // ---- tracks and vias
  const tracks: Track[] = []
  let ti = 0
  for (const s of all(root, "segment")) {
    const a = pt(first(s, "start")), b = pt(first(s, "end"))
    if (!a || !b) continue
    tracks.push({ id: `t${++ti}`, a, b, width: field(s, "width") ?? 0.25, layer: textField(s, "layer") ?? "F.Cu", net: netOf(s) })
  }
  for (const s of all(root, "arc")) {
    // track arcs: flatten into segments
    const a = pt(first(s, "start")), m = pt(first(s, "mid")), e = pt(first(s, "end"))
    if (!a || !m || !e) continue
    const poly = arcThrough(a, m, e)
    for (let i = 0; i < poly.length - 1; i++) tracks.push({ id: `t${++ti}`, a: poly[i]!, b: poly[i + 1]!, width: field(s, "width") ?? 0.25, layer: textField(s, "layer") ?? "F.Cu", net: netOf(s) })
  }
  const vias: Via[] = []
  let vi = 0
  for (const v of all(root, "via")) {
    const p = pt(first(v, "at"))
    if (!p) continue
    const ly = first(v, "layers")
    vias.push({ id: `v${++vi}`, at: p, diameter: field(v, "size") ?? 0.8, drill: field(v, "drill") ?? 0.4, from: at(ly, 1) ?? "F.Cu", to: at(ly, 2) ?? "B.Cu", net: netOf(v) })
  }

  // ---- recentre everything on the outline's bounding-box centre so the model is board-local
  const outline = loops[0] ?? []
  let cx = 0
  let cy = 0
  if (outline.length) {
    const xs = outline.map((p) => p.x)
    const ys = outline.map((p) => p.y)
    cx = (Math.min(...xs) + Math.max(...xs)) / 2
    cy = (Math.min(...ys) + Math.max(...ys)) / 2
  }
  const sh = (p: Pt): Pt => ({ x: p.x - cx, y: p.y - cy })
  const board: Board = {
    name: "imported",
    thickness,
    copper,
    outline: orient(outline.map(sh)),
    cutouts: loops.slice(1).map((l) => orient(l.map(sh))),
    nets: [...new Set([...netName.values()].filter((n) => n !== ""))],
    footprints: fps.map((f) => ({ ...f, at: sh(f.at) })),
    tracks: tracks.map((t) => ({ ...t, a: sh(t.a), b: sh(t.b) })),
    vias: vias.map((v) => ({ ...v, at: sh(v.at) })),
    holes: holes.map((h) => ({ ...h, at: sh(h.at) })),
    rules: { ...DEFAULT_RULES },
  }
  return { board, skipped, warnings }
}

// ---------------------------------------------------------------------------

function bodyFrom(cy: FootprintGraphic[], pads: Pad[]): { w: number; h: number } {
  const xs: number[] = []
  const ys: number[] = []
  for (const g of cy) {
    xs.push(g.a.x, g.b.x)
    ys.push(g.a.y, g.b.y)
  }
  if (xs.length === 0) {
    for (const p of pads) {
      xs.push(p.at.x - p.size.w / 2, p.at.x + p.size.w / 2)
      ys.push(p.at.y - p.size.h / 2, p.at.y + p.size.h / 2)
    }
  }
  if (xs.length === 0) return { w: 0, h: 0 }
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

const area = (p: Pt[]) => {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]!
    a += p[i]!.x * q.y - q.x * p[i]!.y
  }
  return a / 2
}

/** counter-clockwise */
const orient = (p: Pt[]) => (area(p) < 0 ? [...p].reverse() : p)

function circlePoly(c: Pt, r: number, n = 48): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }))
}

/** three points on an arc -> a polyline from start to end (inclusive) */
export function arcThrough(s: Pt, m: Pt, e: Pt, maxStepDeg = 7.5): Pt[] {
  const ax = s.x, ay = s.y, bx = m.x, by = m.y, cx = e.x, cy = e.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return [s, e] // collinear: a straight line
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  let a0 = Math.atan2(ay - uy, ax - ux)
  const am = Math.atan2(by - uy, bx - ux)
  let a1 = Math.atan2(cy - uy, cx - ux)
  // choose the direction that passes through the midpoint
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const ccwSpan = norm(a1 - a0)
  const ccwMid = norm(am - a0)
  const goesCcw = ccwMid <= ccwSpan
  const span = goesCcw ? ccwSpan : -norm(a0 - a1)
  const steps = Math.max(2, Math.ceil(Math.abs(span) / ((maxStepDeg * Math.PI) / 180)))
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (span * i) / steps
    out.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) })
  }
  out[0] = s
  out[out.length - 1] = e
  return out
}

/** join loose segments end-to-end into closed loops */
export function chainLoops(segs: [Pt, Pt][], tol = 1e-3): Pt[][] {
  const key = (p: Pt) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`
  const left = segs.map((s) => ({ a: s[0], b: s[1], used: false }))
  const byEnd = new Map<string, number[]>()
  left.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p)
      if (!byEnd.has(k)) byEnd.set(k, [])
      byEnd.get(k)!.push(i)
    }
  })
  const loops: Pt[][] = []
  for (let i = 0; i < left.length; i++) {
    if (left[i]!.used) continue
    left[i]!.used = true
    const path: Pt[] = [left[i]!.a, left[i]!.b]
    for (;;) {
      const tail = path[path.length - 1]!
      if (path.length > 2 && key(tail) === key(path[0]!)) {
        path.pop()
        loops.push(path)
        break
      }
      const cand = (byEnd.get(key(tail)) ?? []).find((j) => !left[j]!.used)
      if (cand === undefined) break // open chain, dropped
      const s = left[cand]!
      s.used = true
      path.push(key(s.a) === key(tail) ? s.b : s.a)
    }
  }
  return loops
}
