/**
 * Walks the B-rep: MANIFOLD_SOLID_BREP -> CLOSED_SHELL -> ADVANCED_FACE -> bounds -> loops -> oriented edges.
 *
 * The only thing this layer decides is ORIENTATION and ORDER, because everything downstream (tessellation)
 * needs a boundary loop that runs head to tail around the face, in the direction the face's own normal
 * implies. Three flags combine, and getting any of them backwards silently turns a solid inside out:
 *
 *   EDGE_CURVE.same_sense    does the curve run with the edge (start -> end) or against it
 *   ORIENTED_EDGE.orientation  does this use of the edge follow the edge or its reverse
 *   FACE_BOUND.orientation     is this loop traversed as written, or reversed
 *   ADVANCED_FACE.same_sense   does the face normal equal the surface normal
 *
 * A use is forward when (oriented edge) and (bound orientation) agree; a bound that reverses is handled by
 * reversing the assembled loop once, which is equivalent and cheaper than flipping each edge.
 * Original code written against ISO 10303-42.
 */
import { ent, isRef, type Entity, type Part21, type Value } from "./part21.ts"
import { Geometry, member } from "./geometry.ts"
import type { Surface } from "./surfaces.ts"
import type { Curve } from "./curves.ts"
import type { V3 } from "./vec.ts"

export interface EdgeUse {
  edgeId: number
  /** true when this use runs from the edge curve's natural start to its natural end */
  forward: boolean
  /** the vertex this use starts at, and the one it ends at, in traversal order */
  from: V3
  to: V3
  curve: Curve
  /** parameter on `curve` at `from` and at `to` */
  tFrom: number
  tTo: number
}

export interface Loop {
  /** ordered edge uses; consecutive uses meet at a vertex */
  edges: EdgeUse[]
  /** true when the last use ends where the first begins (a properly closed loop) */
  closed: boolean
  /** VERTEX_LOOP, or a loop we could not chain: kept so the face is not silently dropped */
  reason?: string
}

export interface FaceBound {
  /** FACE_OUTER_BOUND is the outer boundary; any FACE_BOUND is a hole */
  outer: boolean
  /** the bound's own orientation flag */
  oriented: boolean
  loop: Loop
}

export interface Face {
  id: number
  surface: Surface
  /** false when the face normal is the opposite of the surface normal */
  sameSense: boolean
  bounds: FaceBound[]
}

export interface Shell {
  id: number
  closed: boolean
  faces: Face[]
}

export interface Solid {
  id: number
  shells: Shell[]
}

export interface BrepStats {
  solids: number
  shells: number
  faces: number
  loops: number
  edgeUses: number
  /** loops whose edges did not chain head to tail */
  brokenLoops: number
  /** edges used by a number of faces other than 2, within a closed shell */
  nonManifoldEdges: number
  /** faces whose surface type we cannot handle; skipped with a warning */
  skippedFaces: number
  /** furthest gap between one edge use's end and the next use's start, in file units */
  maxLoopGap: number
  /** bounds whose orientation flag was F, so their loop order was reversed */
  reversedBounds: number
  /** faces with no FACE_OUTER_BOUND, where the outer loop was deduced from the largest area */
  inferredOuter: number
  /** uses of a closed periodic edge, which traverse the whole circle */
  closedEdgeUses: number
}

/** arguments of a simple entity after its leading name, or of a complex member (which has no name) */
function argsOf(e: Entity, type: string): Value[] | null {
  const a = member(e, type)
  if (!a) return null
  if (e.parts) return a
  const first = a[0]
  return typeof first === "string" || first === null ? a.slice(1) : a
}
const flag = (v: Value | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === null) return dflt
  const en = (v as { enum?: string }).enum
  if (en === "T") return true
  if (en === "F") return false
  return dflt
}

export class Brep {
  p: Part21
  g: Geometry
  warnings: string[]
  readonly stats: BrepStats = { solids: 0, shells: 0, faces: 0, loops: 0, edgeUses: 0, brokenLoops: 0, nonManifoldEdges: 0, skippedFaces: 0, maxLoopGap: 0, reversedBounds: 0, inferredOuter: 0, closedEdgeUses: 0 }

  constructor(p: Part21, g: Geometry, warnings: string[]) {
    this.p = p
    this.g = g
    this.warnings = warnings
  }

  private warn(msg: string) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg)
  }

  /** every solid in the file, in entity order */
  read(): Solid[] {
    const out: Solid[] = []
    for (const e of [...this.p.entities.values()].sort((a, b) => a.id - b.id)) {
      if (e.type === "MANIFOLD_SOLID_BREP") {
        out.push(this.solid(e))
      } else if (e.type === "BREP_WITH_VOIDS") {
        // outer shell first, then the void shells (cavities are surfaces facing inward)
        // argsOf has already dropped the leading name, so the arguments are [outer_shell, void_shells].
        // Reading a[1]/a[2] here (the pre-strip indices) returned no shells at all for every hollow body.
        const a = argsOf(e, "BREP_WITH_VOIDS") ?? []
        const shells: Shell[] = []
        const outer = a[0]
        if (isRef(outer)) shells.push(this.shell(this.shellEntity(outer.ref)))
        else this.warn(`#${e.id} BREP_WITH_VOIDS has no outer shell reference; skipped`)
        const voids = a[1]
        for (const v of Array.isArray(voids) ? voids : []) if (isRef(v)) shells.push(this.shell(this.shellEntity(v.ref)))
        if (shells.length === 0) this.stats.skippedFaces += 0
        out.push({ id: e.id, shells })
      }
    }
    this.stats.solids = out.length
    return out
  }

  private shellEntity(id: number): Entity {
    return ent(this.p, { ref: id }, "shell")
  }

  private solid(e: Entity): Solid {
    const a = argsOf(e, "MANIFOLD_SOLID_BREP") ?? []
    const shellRef = a[0]
    if (!isRef(shellRef)) throw new Error(`#${e.id} MANIFOLD_SOLID_BREP has no shell reference`)
    return { id: e.id, shells: [this.shell(this.shellEntity(shellRef.ref))] }
  }

  private shell(e: Entity): Shell {
    this.stats.shells++
    const closed = e.type === "CLOSED_SHELL"
    const args = e.parts ? member(e, e.type)! : argsOf(e, e.type)!
    const list = args[0]
    const faces: Face[] = []
    if (Array.isArray(list)) {
      for (const f of list) {
        if (!isRef(f)) continue
        const face = this.face(ent(this.p, f, "face"))
        if (face) faces.push(face)
      }
    }
    return { id: e.id, closed, faces }
  }

  private face(e: Entity): Face | null {
    const args = e.parts ? member(e, "ADVANCED_FACE") : argsOf(e, "ADVANCED_FACE")
    if (!args) {
      this.stats.skippedFaces++
      this.warn(`face #${e.id} is a ${e.type}, which is not an ADVANCED_FACE; skipped`)
      return null
    }
    const boundList = args[0]
    const surfRef = args[1]
    const sameSense = flag(args[2], true)
    let surface: Surface
    try {
      surface = this.g.surface(surfRef)
    } catch (err) {
      this.stats.skippedFaces++
      this.warn(`face #${e.id} skipped: ${(err as Error).message}`)
      return null
    }
    this.stats.faces++
    const bounds: FaceBound[] = []
    for (const b of Array.isArray(boundList) ? boundList : []) {
      if (!isRef(b)) continue
      const bound = this.bound(ent(this.p, b, "face bound"))
      if (bound) bounds.push(bound)
    }
    if (bounds.length === 0) {
      this.stats.skippedFaces++
      this.warn(`face #${e.id} skipped: it has no boundary loops`)
      return null
    }
    // FACE_BOUND.orientation = F means the loop is traversed the other way round. Ignoring this reads
    // holes with the outer loop's winding and inside-out loops, which the tessellator turns into
    // flipped or self-intersecting triangles. Most hole bounds in the reference models are reversed.
    for (const b of bounds) {
      if (!b.oriented) {
        this.stats.reversedBounds++
        b.loop = this.reverseLoop(b.loop)
      }
    }
    // A face has exactly one outer bound. Some writers (four of the reference models) use plain
    // FACE_BOUND everywhere and never say which one is outer, so deduce it: the outer loop encloses
    // the most area in the surface's own (u, v) space. Holes lie inside it and are smaller.
    if (!bounds.some((b) => b.outer)) {
      let best = 0
      let bestArea = -1
      for (let i = 0; i < bounds.length; i++) {
        const a = Math.abs(this.loopArea(bounds[i]!.loop, surface))
        if (a > bestArea) {
          bestArea = a
          best = i
        }
      }
      bounds[best]!.outer = true
      this.stats.inferredOuter++
      if (bounds.length > 1) this.warn(`face #${e.id} has no FACE_OUTER_BOUND; took the largest of ${bounds.length} loops as the outer one (area ${bestArea.toFixed(6)})`)
    }
    return { id: e.id, surface, sameSense, bounds }
  }

  private bound(e: Entity): FaceBound | null {
    const type = e.parts ? (member(e, "FACE_OUTER_BOUND") ? "FACE_OUTER_BOUND" : "FACE_BOUND") : e.type
    if (type !== "FACE_OUTER_BOUND" && type !== "FACE_BOUND") return null
    const args = e.parts ? member(e, type)! : argsOf(e, type)!
    const loopRef = args[0]
    const oriented = flag(args[1], true)
    if (!isRef(loopRef)) return null
    const loop = this.loop(ent(this.p, loopRef, "loop"))
    return { outer: type === "FACE_OUTER_BOUND", oriented, loop }
  }

  private loop(e: Entity): Loop {
    this.stats.loops++
    // POLY_LOOP: a plain point list, no edges at all (some exporters use it for flat faces)
    if (e.type === "POLY_LOOP") {
      const args = argsOf(e, "POLY_LOOP") ?? []
      const pts = Array.isArray(args[0]) ? args[0].map((v) => this.g.point(v)) : []
      const edges: EdgeUse[] = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!
        edges.push({ edgeId: -1, forward: true, from: a, to: b, curve: this.straight(a, b), tFrom: 0, tTo: 1 })
      }
      return { edges, closed: true }
    }
    if (e.type === "VERTEX_LOOP") {
      this.warn(`loop #${e.id} is a VERTEX_LOOP (a face degenerating to a point); ignored`)
      return { edges: [], closed: false, reason: "VERTEX_LOOP" }
    }
    if (e.type !== "EDGE_LOOP") {
      this.warn(`loop #${e.id} is a ${e.type}, which is not supported; face skipped`)
      return { edges: [], closed: false, reason: e.type }
    }
    const args = e.parts ? member(e, "EDGE_LOOP")! : argsOf(e, "EDGE_LOOP")!
    const list = args[0]
    const edges: EdgeUse[] = []
    for (const o of Array.isArray(list) ? list : []) {
      if (!isRef(o)) continue
      const use = this.orientedEdge(ent(this.p, o, "oriented edge"))
      if (use) edges.push(use)
    }
    const closed = edges.length > 0 && this.chains(edges)
    if (!closed && edges.length > 0) {
      this.stats.brokenLoops++
      this.warn(`loop #${e.id} does not chain head to tail (worst gap ${this.stats.maxLoopGap.toExponential(3)}); kept in file order`)
    }
    return { edges, closed }
  }

  /** do the uses meet end-to-start all the way round? record the worst gap */
  private chains(edges: EdgeUse[]): boolean {
    let ok = true
    for (let i = 0; i < edges.length; i++) {
      const a = edges[i]!, b = edges[(i + 1) % edges.length]!
      const d = Math.hypot(a.to[0] - b.from[0], a.to[1] - b.from[1], a.to[2] - b.from[2])
      if (d > this.stats.maxLoopGap) this.stats.maxLoopGap = d
      if (d > 1e-6) ok = false
    }
    return ok
  }

  private straight(a: V3, b: V3): Curve {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1
    const u: V3 = [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d]
    return {
      kind: "line",
      at: (t) => [a[0] + u[0] * d * t, a[1] + u[1] * d * t, a[2] + u[2] * d * t],
      closest: () => 0,
      range: [-Infinity, Infinity],
      periodic: false,
    }
  }

  private orientedEdge(e: Entity): EdgeUse | null {
    const args = e.parts ? member(e, "ORIENTED_EDGE") : argsOf(e, "ORIENTED_EDGE")
    if (!args) {
      this.warn(`#${e.id} is a ${e.type} inside a loop; only ORIENTED_EDGE is supported there, skipped`)
      return null
    }
    // ORIENTED_EDGE(name, *, *, edge_element, orientation) -> after the name: [*, *, edge, orientation]
    const edgeRef = args[2]
    const orientation = flag(args[3], true)
    if (!isRef(edgeRef)) return null
    const ec = ent(this.p, edgeRef, "edge curve")
    const ed = this.g.edge(ec)
    // the edge's own direction: start -> end, or reversed when the curve runs against the edge
    const from = orientation ? ed.start : ed.end
    const to = orientation ? ed.end : ed.start
    // The curve's parameter at each vertex, so downstream sampling knows which way to run.
    // `forward` means the parameter ADVANCES along the use: it is true exactly when the traversal
    // direction agrees with the edge's own direction AND the curve agrees with the edge.
    const forward = orientation === ed.sameSense
    const tFrom = ed.curve.closest(from)
    let tTo = ed.curve.closest(to)
    const sameVertex = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) < 1e-9
    if (ed.curve.periodic) {
      // A periodic curve has no unique parameter for a point: closest() returns a wrapped angle. Taking
      // the two wrapped values as they come can make the arc run the LONG way round. Measurement on a
      // real model showed a 90 degree corner arc sampled as 270 degrees, which left its two faces with
      // different boundary points and a hole in the mesh. So take the shortest step, then flip it to the
      // direction `forward` insists on; a closed edge (both vertices at one point) is a whole turn.
      const period = ed.curve.range[1] - ed.curve.range[0]
      if (sameVertex) {
        tTo = tFrom + (forward ? period : -period)
        this.stats.closedEdgeUses++
      } else {
        let d = tTo - tFrom
        while (d > period / 2) d -= period
        while (d < -period / 2) d += period
        if (forward && d < 0) d += period
        if (!forward && d > 0) d -= period
        tTo = tFrom + d
      }
    }
    this.stats.edgeUses++
    return { edgeId: ec.id, forward, from, to, curve: ed.curve, tFrom, tTo }
  }

  /** the same loop traversed backwards: order reversed, and every use's ends swapped */
  private reverseLoop(loop: Loop): Loop {
    const edges = loop.edges
      .slice()
      .reverse()
      .map((e) => ({ ...e, from: e.to, to: e.from, tFrom: e.tTo, tTo: e.tFrom, forward: !e.forward }))
    return { ...loop, edges }
  }

  /**
   * Sample a loop into the surface's (u, v) space. Periodic surfaces wrap, so u is unwrapped against the
   * previous point by taking the shortest step; without that a circle crossing the seam appears to jump
   * the whole way round and the area comes out wildly wrong.
   */
  private loopUv(loop: Loop, s: Surface): [number, number][] {
    const out: [number, number][] = []
    let prevU = Number.NaN
    const per = s.uPeriod
    for (const e of loop.edges) {
      const same = Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]) < 1e-9
      // a full circle has from == to, so sampling by parameter is the only way to see it at all
      const steps = e.curve.kind === "line" ? (same ? 0 : 1) : 16
      for (let i = 0; i < steps; i++) {
        const t = steps === 1 ? e.tFrom : e.tFrom + ((e.tTo - e.tFrom) * i) / steps
        const [u0, v] = s.project(e.curve.at(t))
        let u = u0
        if (per > 0 && !Number.isNaN(prevU)) {
          while (u - prevU > per / 2) u -= per
          while (prevU - u > per / 2) u += per
        }
        prevU = u
        out.push([u, v])
      }
    }
    return out
  }

  /** signed area of a loop in (u, v), by the shoelace formula; the sign says which way it winds */
  private loopArea(loop: Loop, s: Surface): number {
    const pts = this.loopUv(loop, s)
    if (pts.length < 3) return 0
    let a = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      const q = pts[(i + 1) % pts.length]!
      a += p[0] * q[1] - q[0] * p[1]
    }
    return a / 2
  }

  /**
   * Orientation check that needs no convention at all. In a closed 2-manifold every edge is shared by
   * exactly two faces, and those two faces must traverse it in OPPOSITE directions: each face sees the
   * edge from its own side. If two faces run the same edge the same way, one of them has its loop wound
   * backwards, which puts a hole and the material on the same side and turns that face inside out.
   *
   * This is deliberately not a signed-area test in (u, v): a cylinder's or cone's parameter frame can be
   * left-handed, so area sign there is a convention and not evidence. Signed area is still useful for
   * choosing an outer loop when the file names none, where only a comparison between loops matters.
   *
   * Edges used by anything other than two faces (the 4-fold edges in the Panasonic model, where two
   * features touch along one edge) are excluded: the rule does not apply to a non-manifold edge.
   */
  checkOrientation(solids: Solid[]): { pairs: number; sameDirection: number; nonManifold: number; worst: string[] } {
    const out = { pairs: 0, sameDirection: 0, nonManifold: 0, worst: [] as string[] }
    const lex = (a: V3, b: V3) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2])
    for (const s of solids) for (const sh of s.shells) {
      if (!sh.closed) continue
      const per = new Map<number, { fwd: number; back: number }>()
      for (const fa of sh.faces) for (const bd of fa.bounds) for (const e of bd.loop.edges) {
        if (e.edgeId < 0) continue
        const r = per.get(e.edgeId) ?? { fwd: 0, back: 0 }
        // Canonical direction needs no shared convention. For an open edge the order of its two endpoints
        // decides it. For a closed edge both endpoints are the same point, so the direction is the way the
        // parameter travels, which comes from the orientation flag.
        const closed = Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]) < 1e-9
        if (closed ? e.tTo > e.tFrom : lex(e.from, e.to)) r.fwd++
        else r.back++
        per.set(e.edgeId, r)
      }
      for (const [id, r] of per) {
        const n = r.fwd + r.back
        if (n !== 2) { out.nonManifold++; continue }
        out.pairs++
        if (r.fwd !== 1 || r.back !== 1) {
          out.sameDirection++
          if (out.worst.length < 5) out.worst.push(`edge #${id} is traversed ${r.fwd > 1 ? "forward" : "backward"} by both faces`)
        }
      }
    }
    return out
  }

  /** count how many faces use each edge, per closed shell: a watertight solid uses each edge exactly twice */
  checkManifold(solids: Solid[]): number {
    let bad = 0
    for (const s of solids) {
      for (const sh of s.shells) {
        if (!sh.closed) continue
        const use = new Map<number, number>()
        for (const f of sh.faces) for (const b of f.bounds) for (const e of b.loop.edges) {
          if (e.edgeId < 0) continue
          use.set(e.edgeId, (use.get(e.edgeId) ?? 0) + 1)
        }
        for (const [, n] of use) if (n !== 2) bad++
      }
    }
    this.stats.nonManifoldEdges = bad
    return bad
  }
}
