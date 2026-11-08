/**
 * Length units in a STEP file, resolved to a scale into millimetres.
 *
 * A STEP file stores numbers in whatever unit the exporting CAD tool used. Most are millimetres, but
 * GrabCAD downloads from US vendors are often inches, and a few tools write metres. Read the number
 * without its unit and a USB-C connector comes out 25 times too large (or too small).
 *
 * Where the unit lives, and why "the first LENGTH_UNIT in the file" is wrong:
 *
 *   #12 = ADVANCED_BREP_SHAPE_REPRESENTATION('', (#14), #1442);      <- the LAST argument is its context
 *   #1442 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3)
 *             GLOBAL_UNIT_ASSIGNED_CONTEXT((#1444, #1446, #1447))     <- the units this context uses
 *             REPRESENTATION_CONTEXT('', '') );
 *   #1444 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI., .METRE.) );
 *
 * One file can carry several contexts with different units (Contact.step has both a millimetre and a
 * plain-metre unit), so the scale is resolved per shape, through its own context.
 *
 * Original code written against the ISO 10303-41/-42 definitions of the unit entities.
 */
import { isEnum, isRef, num, type Entity, type Part21, type Value } from "./part21.ts"

/** SI prefixes as powers of ten */
const PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
}

export interface LengthUnit {
  /** how many millimetres one file unit is */
  mmPerUnit: number
  /** a short human name for diagnostics */
  name: string
}

export const MM: LengthUnit = { mmPerUnit: 1, name: "mm" }

const members = (e: Entity) => e.parts ?? [{ type: e.type, args: e.args }]
const member = (e: Entity, type: string) => members(e).find((m) => m.type === type)

/** is this entity a length unit (LENGTH_UNIT among its members)? */
const isLengthUnit = (e: Entity) => members(e).some((m) => m.type === "LENGTH_UNIT")

/**
 * Resolve one unit entity to millimetres.
 *   SI_UNIT(.MILLI., .METRE.)              -> 1
 *   SI_UNIT($, .METRE.)                    -> 1000
 *   CONVERSION_BASED_UNIT('INCH', #m)      -> factor in #m (a LENGTH_MEASURE_WITH_UNIT whose own unit is mm or m)
 */
export function resolveLengthUnit(p: Part21, e: Entity, depth = 0): LengthUnit {
  if (depth > 8) throw new Error("unit definition is circular")
  const si = member(e, "SI_UNIT")
  if (si) {
    const prefix = si.args[0]
    const base = si.args[1]
    if (!isEnum(base as Value) || (base as { enum: string }).enum !== "METRE") throw new Error(`length unit is not based on the metre (${JSON.stringify(base)})`)
    let scale = 1000 // a metre in millimetres
    let name = "m"
    if (isEnum(prefix as Value)) {
      const k = (prefix as { enum: string }).enum
      const f = PREFIX[k]
      if (f === undefined) throw new Error(`unknown SI prefix ${k}`)
      scale *= f
      name = `${k.toLowerCase()}metre`
      if (k === "MILLI") name = "mm"
    }
    return { mmPerUnit: scale, name }
  }
  const cb = member(e, "CONVERSION_BASED_UNIT")
  if (cb) {
    const label = typeof cb.args[0] === "string" ? cb.args[0] : "converted"
    const mw = cb.args[1]
    if (!isRef(mw as Value)) throw new Error(`conversion unit ${label} has no measure`)
    const meas = p.entities.get((mw as { ref: number }).ref)
    if (!meas) throw new Error(`conversion unit ${label} points at a missing entity`)
    // LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4), #unit): "one <label> is 25.4 of #unit"
    const value = num(meas.args[0], "conversion factor")
    const baseRef = meas.args[1]
    if (!isRef(baseRef as Value)) throw new Error(`conversion unit ${label} has no base unit`)
    const baseEnt = p.entities.get((baseRef as { ref: number }).ref)
    if (!baseEnt) throw new Error(`conversion unit ${label} base unit is missing`)
    const base = resolveLengthUnit(p, baseEnt, depth + 1)
    return { mmPerUnit: value * base.mmPerUnit, name: label.toLowerCase() }
  }
  throw new Error(`unsupported length unit entity ${e.type}`)
}

/**
 * The length unit for a shape representation, found through its context (the last argument).
 * Falls back to millimetres, with a warning, if the file does not say. Every real CAD export declares
 * it, so a fallback means a hand-written or damaged file.
 */
export function unitForContext(p: Part21, contextRef: Value | undefined, warnings: string[]): LengthUnit {
  if (!contextRef || !isRef(contextRef)) {
    warnings.push("shape has no representation context; assuming millimetres")
    return MM
  }
  const ctx = p.entities.get(contextRef.ref)
  if (!ctx) {
    warnings.push(`representation context #${contextRef.ref} is missing; assuming millimetres`)
    return MM
  }
  const assigned = member(ctx, "GLOBAL_UNIT_ASSIGNED_CONTEXT")
  const list = assigned?.args[0]
  if (!Array.isArray(list)) {
    warnings.push(`representation context #${ctx.id} lists no units; assuming millimetres`)
    return MM
  }
  for (const u of list) {
    if (!isRef(u)) continue
    const ue = p.entities.get(u.ref)
    if (!ue || !isLengthUnit(ue)) continue
    try {
      return resolveLengthUnit(p, ue)
    } catch (err) {
      warnings.push(`${(err as Error).message}; assuming millimetres`)
      return MM
    }
  }
  warnings.push(`representation context #${ctx.id} has no length unit; assuming millimetres`)
  return MM
}

/** is this entity a representation context? (it has a GEOMETRIC_REPRESENTATION_CONTEXT or REPRESENTATION_CONTEXT member) */
export function isRepresentationContext(e: Entity): boolean {
  return members(e).some((m) => m.type === "GEOMETRIC_REPRESENTATION_CONTEXT" || m.type === "REPRESENTATION_CONTEXT")
}

/**
 * Every shape that carries geometry, found by STRUCTURE and not by name: an entity whose last argument
 * points at a representation context. Matching on the name suffix "SHAPE_REPRESENTATION" is wrong because
 * CONTEXT_DEPENDENT_SHAPE_REPRESENTATION (an assembly link) ends the same way but has no context.
 */
export function shapeRepresentations(p: Part21): Entity[] {
  const out: Entity[] = []
  for (const e of p.entities.values()) {
    if (e.parts) continue
    const last = e.args[e.args.length - 1]
    if (!last || !isRef(last)) continue
    const target = p.entities.get(last.ref)
    if (target && isRepresentationContext(target) && Array.isArray(e.args[1])) out.push(e)
  }
  return out
}

/**
 * The unit of the whole file, for single-part models. Looks at every shape representation: if they
 * agree, that is the answer; if they disagree, the first is returned and a warning says so (per-shape
 * resolution is what the tessellator uses; this is for diagnostics and the simple case).
 */
export function fileLengthUnit(p: Part21, warnings: string[] = []): LengthUnit {
  const seen = new Map<number, LengthUnit>()
  for (const e of shapeRepresentations(p)) {
    const ctxRef = e.args[e.args.length - 1] as { ref: number }
    seen.set(ctxRef.ref, unitForContext(p, ctxRef, warnings))
  }
  const all = [...seen.values()]
  if (all.length === 0) return MM
  const first = all[0]!
  if (all.some((u) => u.mmPerUnit !== first.mmPerUnit)) warnings.push(`file mixes length units (${[...new Set(all.map((u) => u.name))].join(", ")}); resolve per shape`)
  return first
}
