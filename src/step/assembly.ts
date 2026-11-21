/**
 * Assembly placements: where each part sits inside the assembly that uses it.
 *
 * A STEP assembly is a graph, not geometry: NEXT_ASSEMBLY_USAGE_OCCURRENCE (NAUO) says "assembly A uses
 * part B", and the placement comes from an ITEM_DEFINED_TRANSFORMATION (IDT) reachable through a
 * CONTEXT_DEPENDENT_SHAPE_REPRESENTATION (CDSR). Nothing about a part's position is stored on the part.
 *
 * The IDT holds two AXIS2_PLACEMENT_3D frames, one belonging to the child's shape representation and one to
 * the parent's. Per ISO 10303-43 the transformation maps transform_item_1 onto transform_item_2, so a point
 * p given in the child's coordinates lands in the parent's at  M2 * inv(M1) * p. Both real fixtures in refs
 * confirm the pairing (ExampleModelPin: child axis #2076 in rep #4399, parent axis #2239 in rep #4398).
 *
 * The relationship is a COMPLEX instance, e.g.
 *   #12=( REPRESENTATION_RELATIONSHIP($,$,#4399,#4398)
 *         REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#11)
 *         SHAPE_REPRESENTATION_RELATIONSHIP() );
 * so the transform reference is not in `args`; it is in the REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION
 * part. Reading only `args` finds the reps and silently loses the transform.
 */
import { type Part21, type Entity, type Value, isRef } from "./part21.ts"
import type { Geometry } from "./geometry.ts"
import { type M4, mul, fromFrame } from "./vec.ts"

export interface AssemblyInstance {
  /** product definition id of the part being placed */
  child: number
  /** product definition id of the assembly that contains it */
  parent: number
  /** the NAUO's name, which exporters usually set to the part name */
  name: string
  /** maps child coordinates into parent coordinates */
  matrix: M4
}

/** Inverse of a rigid transform: R^T and -R^T t. Throws rather than returning nonsense for a non-rigid input. */
export function invertRigid(m: M4): M4 {
  const r = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!] // transpose of the 3x3
  const t = [m[3]!, m[7]!, m[11]!]
  const tx = -(r[0]! * t[0]! + r[1]! * t[1]! + r[2]! * t[2]!)
  const ty = -(r[3]! * t[0]! + r[4]! * t[1]! + r[5]! * t[2]!)
  const tz = -(r[6]! * t[0]! + r[7]! * t[1]! + r[8]! * t[2]!)
  return [r[0]!, r[1]!, r[2]!, tx, r[3]!, r[4]!, r[5]!, ty, r[6]!, r[7]!, r[8]!, tz, 0, 0, 0, 1]
}

/** simple entities start with a name; complex members do not. Detect by the type of the first argument. */
function argsAfterName(e: Entity, args: Value[]): Value[] {
  const first = args[0]
  return e.parts ? args : typeof first === "string" || first === null ? args.slice(1) : args
}

/** the transform an IDT references, from the complex-instance part rather than from `args` */
function idtRefOf(rel: Entity): number | null {
  const parts = (rel as { parts?: { type: string; args: Value[] }[] }).parts
  if (!parts) return null
  for (const part of parts) {
    if (part.type === "REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION") {
      const v = part.args[0]
      if (isRef(v)) return v.ref
    }
  }
  return null
}

/** PRODUCT_DEFINITION_SHAPE -> the PRODUCT_DEFINITION or NAUO it defines */
function definitionOf(p: Part21, ref: Value | undefined): Entity | null {
  if (!isRef(ref)) return null
  const pds = p.entities.get(ref.ref)
  if (!pds || pds.type !== "PRODUCT_DEFINITION_SHAPE") return null
  const a = argsAfterName(pds, pds.args)
  const def = a[2] ?? a[1]
  return isRef(def) ? (p.entities.get(def.ref) ?? null) : null
}

export function assemblyInstances(p: Part21, g: Geometry, warnings: string[] = []): AssemblyInstance[] {
  // Every representation relationship that carries a transform, keyed by its own entity id, so a CDSR can
  // find its matrix.
  const byRel = new Map<number, M4>()
  for (const e of p.entities.values()) {
    if (!e.parts) continue
    const relPart = e.parts.find((x) => x.type === "REPRESENTATION_RELATIONSHIP")
    if (!relPart) continue
    const idt = idtRefOf(e)
    if (idt === null) continue
    const idtEnt = p.entities.get(idt)
    if (!idtEnt || idtEnt.type !== "ITEM_DEFINED_TRANSFORMATION") {
      warnings.push(`representation relationship #${e.id} names #${idt} as its transform, but that is not an ITEM_DEFINED_TRANSFORMATION; placement ignored`)
      continue
    }
    // ITEM_DEFINED_TRANSFORMATION(name, description, transform_item_1, transform_item_2). Both leading
    // fields are usually `$`, so stripping a single name still leaves a null in front: take the first two
    // REF arguments instead of indexing, which is what the signature actually promises.
    const refs = (idtEnt.args ?? []).filter(isRef)
    const item1 = refs[0]
    const item2 = refs[1]
    if (!item1 || !item2) {
      warnings.push(`ITEM_DEFINED_TRANSFORMATION #${idt} does not name two placements; placement ignored`)
      continue
    }
    const m1 = fromFrame(g.frame(item1))
    const m2 = fromFrame(g.frame(item2))
    byRel.set(e.id, mul(m2, invertRigid(m1)))
  }

  const out: AssemblyInstance[] = []
  for (const e of [...p.entities.values()].sort((a, b) => a.id - b.id)) {
    if (e.type !== "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION") continue
    const a = argsAfterName(e, e.args)
    const rel = a[0]
    const pds = a[1]
    if (!isRef(rel)) continue
    const matrix = byRel.get(rel.ref)
    if (!matrix) {
      warnings.push(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION #${e.id} points at #${rel.ref}, which carries no transform; placement ignored`)
      continue
    }
    const nauo = definitionOf(p, pds)
    if (!nauo || nauo.type !== "NEXT_ASSEMBLY_USAGE_OCCURRENCE") {
      warnings.push(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION #${e.id} does not lead to a NEXT_ASSEMBLY_USAGE_OCCURRENCE; placement ignored`)
      continue
    }
    const n = argsAfterName(nauo, nauo.args)
    // NEXT_ASSEMBLY_USAGE_OCCURRENCE(id, name, description, relating, related, reference_designator):
    // relating is the assembly, related is the part it uses.
    const parent = n[2]
    const child = n[3]
    if (!isRef(parent) || !isRef(child)) {
      warnings.push(`NEXT_ASSEMBLY_USAGE_OCCURRENCE #${nauo.id} does not name both product definitions; placement ignored`)
      continue
    }
    out.push({ child: child.ref, parent: parent.ref, name: typeof n[0] === "string" ? n[0] : `#${nauo.id}`, matrix })
  }
  return out
}
