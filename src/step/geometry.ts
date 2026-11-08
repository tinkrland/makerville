/**
 * Resolves STEP geometry entities into the evaluators in curves.ts and surfaces.ts.
 *
 * Two encodings exist in real files and both are handled wherever they occur:
 *   simple   #5 = B_SPLINE_CURVE_WITH_KNOTS ( 'NONE', 3, ( #1, #2, #3, #4 ), .UNSPECIFIED., .F., .F.,
 *                                     ( 4, 4 ), ( 0., 1. ), .UNSPECIFIED. ) ;
 *   complex  #24 = ( BOUNDED_CURVE() B_SPLINE_CURVE ( 2, ( #3683, #3684, #3685 ), ... )
 *                    B_SPLINE_CURVE_WITH_KNOTS ( ( 3, 3 ), ( 0.12, 0.13 ), .UNSPECIFIED. )
 *                    RATIONAL_B_SPLINE_CURVE ( ( 1.01, 1.01, 1.01 ) ) CURVE() ... ) ;
 * A complex entity's members each carry their own arguments with no name; `member()` reaches them.
 *
 * Everything here is unit-agnostic: lengths are in the file's own unit. Scale at the mesh boundary.
 * Original code written against ISO 10303-42 and the AP203/AP214 entity definitions.
 */
import { ent, isRef, nums, num, type Entity, type Part21, type Value, type Typed } from "./part21.ts"
import { frameFrom, sub, len, norm, cross, type Frame, type V3 } from "./vec.ts"
import { lineCurve, circleCurve, ellipseCurve, bsplineCurve, type Curve, type BSplineData } from "./curves.ts"
import { planeSurface, cylinderSurface, coneSurface, sphereSurface, torusSurface, bsplineSurface, type Surface, type BSplineSurfaceData } from "./surfaces.ts"

/** arguments of a member of a complex entity, or of a simple entity of that type */
export function member(e: Entity, type: string): Value[] | null {
  if (e.parts) {
    const m = e.parts.find((x) => x.type === type)
    return m ? m.args : null
  }
  return e.type === type ? e.args : null
}
export const hasMember = (e: Entity, type: string) => member(e, type) !== null

/** simple entities start with a name; complex members do not. Detect by the type of the first argument. */
function argsAfterName(e: Entity, args: Value[]): Value[] {
  const first = args[0]
  return e.parts ? args : typeof first === "string" || first === null ? args.slice(1) : args
}

export class Geometry {
  p: Part21
  warnings: string[]
  private pts = new Map<number, V3>()
  private frames = new Map<number, Frame>()
  private curves = new Map<number, Curve>()
  private surfs = new Map<number, Surface>()
  /** measured repairs, so a reader can report what it had to change instead of hiding it */
  readonly stats = { lineEdgesRebuilt: 0, maxLineGapMm: 0 }

  constructor(p: Part21, warnings: string[] = []) {
    this.p = p
    this.warnings = warnings
  }

  /** push the accumulated repair stats into the warning list; call once when the file is done */
  flushWarnings(): string[] {
    const s = this.stats
    if (s.lineEdgesRebuilt > 0) {
      const msg = `${s.lineEdgesRebuilt} line edge(s) had a curve that does not pass through their own vertices (worst ${s.maxLineGapMm.toExponential(3)} mm); rebuilt each from its two vertices, which are what bounds the edge`
      if (!this.warnings.includes(msg)) this.warnings.push(msg)
    }
    return this.warnings
  }

  private warn(msg: string) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg)
  }

  point(v: Value | undefined): V3 {
    if (isRef(v)) {
      const hit = this.pts.get(v.ref)
      if (hit) return hit
    }
    const e = ent(this.p, v, "CARTESIAN_POINT")
    if (e.type !== "CARTESIAN_POINT") throw new Error(`#${e.id} is a ${e.type}, expected a CARTESIAN_POINT`)
    const a = argsAfterName(e, e.args)
    const c = nums(a[0], "point coordinates")
    const out: V3 = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
    this.pts.set(e.id, out)
    return out
  }

  dir(v: Value | undefined): V3 {
    const e = ent(this.p, v, "DIRECTION")
    const a = argsAfterName(e, e.args)
    if (e.type !== "DIRECTION") throw new Error(`#${e.id} is a ${e.type}, expected a DIRECTION`)
    const c = nums(a[0], "direction ratios")
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
  }

  /** AXIS2_PLACEMENT_3D: location, axis (the local Z), ref_direction (the local X) */
  frame(v: Value | undefined): Frame {
    if (isRef(v)) {
      const hit = this.frames.get(v.ref)
      if (hit) return hit
    }
    const e = ent(this.p, v, "AXIS2_PLACEMENT_3D")
    const a = argsAfterName(e, e.args)
    const loc = this.point(a[0])
    const axis = a[1] === null || a[1] === undefined ? null : this.dir(a[1])
    const ref = a[2] === null || a[2] === undefined ? null : this.dir(a[2])
    const f = frameFrom(loc, axis, ref)
    this.frames.set(e.id, f)
    return f
  }

  /** VERTEX_POINT -> its 3D point */
  vertexPoint(v: Value | undefined): V3 {
    const e = ent(this.p, v, "VERTEX_POINT")
    if (e.type !== "VERTEX_POINT") throw new Error(`#${e.id} is a ${e.type}, expected a VERTEX_POINT`)
    return this.point(argsAfterName(e, e.args)[0])
  }

  /**
   * EDGE_CURVE -> its two vertices and its curve. `same_sense` false means the curve runs the other way
   * along the edge, from the second vertex to the first.
   */
  edge(e: Entity): { start: V3; end: V3; curve: Curve; sameSense: boolean } {
    if (e.type !== "EDGE_CURVE") throw new Error(`#${e.id} is a ${e.type}, expected an EDGE_CURVE`)
    const a = argsAfterName(e, e.args)
    // argsAfterName has already removed the leading name, so the flags sit one place earlier than in the
    // raw entity: [start, end, curve, same_sense]. Reading index 4 silently made every edge "same sense".
    const sameSense = !(a[3] !== undefined && a[3] !== null && (a[3] as { enum?: string }).enum === "F")
    const start = this.vertexPoint(a[0]), end = this.vertexPoint(a[1])
    let curve = this.curve(a[2])
    // An edge is BOUNDED BY its two vertices, so for a straight edge the line through those vertices is
    // authoritative. Real exporters drift: in one reference model 104 LINE entities sit up to 25 um to the
    // side of the vertices they are supposed to join (the vertices agree with each other to 1e-15, so the
    // declared line origin is the outlier). Trusting the curve there would open a visible gap and break
    // watertightness, so the line is rebuilt from its vertices and the repair is counted.
    if (curve.kind === "line") {
      const d = sub(end, start)
      if (len(d) < 1e-12) {
        this.warn(`#${e.id} is a degenerate edge: both vertices are at the same point`)
      } else {
        const u = norm(d)
        const gap = Math.max(this.perpGap(start, curve, u), this.perpGap(end, curve, u))
        if (gap > 1e-7) {
          this.stats.lineEdgesRebuilt++
          this.stats.maxLineGapMm = Math.max(this.stats.maxLineGapMm, gap)
          curve = lineCurve(start, u, len(d))
        }
      }
    }
    return { start, end, curve, sameSense }
  }

  /** distance from p to the infinite line of a line curve */
  private perpGap(p: V3, c: Curve, dir: V3): number {
    const o = c.at(0)
    return len(cross(sub(p, o), dir))
  }

  /** an ordered list of numbers, accepting the "typed" wrapper some writers use */
  private typedNums(v: Value | undefined, what: string): number[] {
    if (Array.isArray(v)) return nums(v, what)
    if (v && typeof v === "object" && "type" in v) return nums((v as Typed).args[0], what)
    throw new Error(`expected ${what}`)
  }

  curve(v: Value | undefined): Curve {
    if (isRef(v)) {
      const hit = this.curves.get(v.ref)
      if (hit) return hit
    }
    const e = ent(this.p, v, "curve")
    const c = this.buildCurve(e)
    this.curves.set(e.id, c)
    return c
  }

  private buildCurve(e: Entity): Curve {
    // complex curve: a bounded / rational B-spline, its parts split across members
    const bs = member(e, "B_SPLINE_CURVE")
    if (bs) {
      const knots = member(e, "B_SPLINE_CURVE_WITH_KNOTS")
      if (!knots) throw new Error(`#${e.id} is a B-spline curve with no knot vector (only B_SPLINE_CURVE_WITH_KNOTS is supported)`)
      const degree = num(bs[0], "B-spline degree")
      const pointRefs = bs[1]
      if (!Array.isArray(pointRefs)) throw new Error(`#${e.id} B-spline control points are not a list`)
      const rational = member(e, "RATIONAL_B_SPLINE_CURVE")
      // complex encoding: the WITH_KNOTS member carries ( mults, knots, spec ), weights come separately
      const data = this.splineData(e.id, degree, pointRefs, [knots[0], knots[1]], rational?.[0] ?? undefined)
      return bsplineCurve(data)
    }
    switch (e.type) {
      case "LINE": {
        const a = argsAfterName(e, e.args)
        const origin = this.point(a[0])
        const vec = ent(this.p, a[1], "VECTOR")
        const va = argsAfterName(vec, vec.args)
        const dir = this.dir(va[0])
        const mag = num(va[1], "vector magnitude")
        return lineCurve(origin, dir, mag)
      }
      case "CIRCLE": {
        const a = argsAfterName(e, e.args)
        return circleCurve(this.frame(a[0]), num(a[1], "circle radius"))
      }
      case "ELLIPSE": {
        const a = argsAfterName(e, e.args)
        return ellipseCurve(this.frame(a[0]), num(a[1], "ellipse semi-axis 1"), num(a[2], "ellipse semi-axis 2"))
      }
      case "B_SPLINE_CURVE_WITH_KNOTS": {
        // simple encoding, after the name: degree, points, form, closed, self_intersect, mults, knots, spec
        const a = argsAfterName(e, e.args)
        const data = this.splineData(e.id, num(a[0], "B-spline degree"), a[1], [a[5], a[6]])
        return bsplineCurve(data)
      }
      case "B_SPLINE_CURVE":
        throw new Error(`#${e.id} is a B-spline curve with no knot vector (only B_SPLINE_CURVE_WITH_KNOTS is supported)`)
      case "TRIMMED_CURVE":
        this.warn("TRIMMED_CURVE is not supported; its basis curve is used untrimmed where an edge still bounds it")
        return this.curve(argsAfterName(e, e.args)[0])
      default:
        throw new Error(`unsupported curve type ${e.type}`)
    }
  }

  /**
   * Shared B-spline curve arguments. `knotArgs` is [multiplicities, knot values] in whichever encoding the
   * entity uses; a simple entity also carries the control points inline, a complex one passes them apart.
   */
  private splineData(id: number, degree: number, pointRefs: Value, knotArgs: [Value, Value], weightsArg?: Value): BSplineData {
    if (!Array.isArray(pointRefs)) throw new Error(`#${id} B-spline control points are not a list`)
    const points = pointRefs.map((r) => this.point(r))
    const mults = this.typedNums(knotArgs[0], `#${id} knot multiplicities`)
    const knots = this.typedNums(knotArgs[1], `#${id} knot values`)
    const weights = weightsArg === undefined || weightsArg === null ? undefined : this.typedNums(weightsArg, `#${id} weights`)
    return { degree, points, ...(weights ? { weights } : {}), knots, mults }
  }

  surface(v: Value | undefined): Surface {
    if (isRef(v)) {
      const hit = this.surfs.get(v.ref)
      if (hit) return hit
    }
    const e = ent(this.p, v, "surface")
    const s = this.buildSurface(e)
    this.surfs.set(e.id, s)
    return s
  }

  private buildSurface(e: Entity): Surface {
    const bs = member(e, "B_SPLINE_SURFACE")
    if (bs) {
      const knots = member(e, "B_SPLINE_SURFACE_WITH_KNOTS")
      if (!knots) throw new Error(`#${e.id} is a B-spline surface with no knot vectors (only B_SPLINE_SURFACE_WITH_KNOTS is supported)`)
      const uDegree = num(bs[0], "u degree")
      const vDegree = num(bs[1], "v degree")
      const net = bs[2]
      if (!Array.isArray(net)) throw new Error(`#${e.id} B-spline surface control points are not a list of rows`)
      const points = net.map((row) => (Array.isArray(row) ? row.map((r) => this.point(r)) : []))
      const rational = member(e, "RATIONAL_B_SPLINE_SURFACE")
      const w = rational?.[0]
      const weights = Array.isArray(w) ? w.map((row) => this.typedNums(row as Value, `#${e.id} weights`)) : undefined
      const [uMults, vMults, uKnots, vKnots] = knots as [Value, Value, Value, Value]
      const d: BSplineSurfaceData = {
        uDegree, vDegree, points,
        ...(weights ? { weights } : {}),
        uKnots: this.typedNums(uKnots, `#${e.id} u knots`), uMults: this.typedNums(uMults, `#${e.id} u multiplicities`),
        vKnots: this.typedNums(vKnots, `#${e.id} v knots`), vMults: this.typedNums(vMults, `#${e.id} v multiplicities`),
      }
      return bsplineSurface(d)
    }
    switch (e.type) {
      case "PLANE": return planeSurface(this.frame(argsAfterName(e, e.args)[0]))
      case "CYLINDRICAL_SURFACE": {
        const a = argsAfterName(e, e.args)
        return cylinderSurface(this.frame(a[0]), num(a[1], "cylinder radius"))
      }
      case "CONICAL_SURFACE": {
        const a = argsAfterName(e, e.args)
        return coneSurface(this.frame(a[0]), num(a[1], "cone radius"), num(a[2], "cone semi-angle"))
      }
      case "SPHERICAL_SURFACE": {
        const a = argsAfterName(e, e.args)
        return sphereSurface(this.frame(a[0]), num(a[1], "sphere radius"))
      }
      case "TOROIDAL_SURFACE": {
        const a = argsAfterName(e, e.args)
        return torusSurface(this.frame(a[0]), num(a[1], "torus major radius"), num(a[2], "torus minor radius"))
      }
      case "B_SPLINE_SURFACE_WITH_KNOTS": {
        // simple encoding, after the name: u_degree, v_degree, net, form, u_closed, v_closed,
        // self_intersect, u_mults, v_mults, u_knots, v_knots, knot_spec
        const a = argsAfterName(e, e.args)
        const net = a[2]
        if (!Array.isArray(net)) throw new Error(`#${e.id} B-spline surface control points are not a list of rows`)
        return bsplineSurface({
          uDegree: num(a[0], "u degree"), vDegree: num(a[1], "v degree"),
          points: net.map((row) => (Array.isArray(row) ? row.map((r) => this.point(r)) : [])),
          uMults: this.typedNums(a[7], `#${e.id} u multiplicities`), uKnots: this.typedNums(a[9], `#${e.id} u knots`),
          vMults: this.typedNums(a[8], `#${e.id} v multiplicities`), vKnots: this.typedNums(a[10], `#${e.id} v knots`),
        })
      }
      case "B_SPLINE_SURFACE":
        throw new Error(`#${e.id} is a B-spline surface with no knot vectors (only B_SPLINE_SURFACE_WITH_KNOTS is supported)`)
      default:
        throw new Error(`unsupported surface type ${e.type}`)
    }
  }
}
