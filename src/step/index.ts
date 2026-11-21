/**
 * readStep: the one way into the STEP reader.
 *
 * Everything a renderer needs comes out of here in millimetres, already welded and stitched, with colours and
 * a bounding box, and every problem named in `warnings`. Callers should never have to know the order the
 * stages go in, and in particular should not have to remember to weld before measuring: a raw tessellation is
 * never watertight because faces are triangulated independently.
 *
 * Two decisions worth knowing about:
 *
 * 1. UNITS ARE APPLIED HERE. The rest of the reader works in file units. `fileLengthUnit` resolves the
 *    representation context's unit (mm, cm, inch, mil ...) and every position is multiplied by its mmPerUnit
 *    on the way out. A file that mixes units gets a warning rather than a silently mis-scaled model.
 *
 * 2. ASSEMBLY PLACEMENTS ARE NOT APPLIED. Both real fixtures that have assembly data already store their
 *    B-reps in world coordinates, so applying the placement would move them off the position the file
 *    declares (measured: the connector would shift 1.3525 mm off its own extents). The placements are
 *    returned so a caller that wants the hierarchy can use them. See assembly.ts.
 */
import { parsePart21, type Part21 } from "./part21.ts"
import { Geometry } from "./geometry.ts"
import { Brep, type Face, type Solid } from "./brep.ts"
import { tessellate, weld, stitchTJunctions, DEFAULT_TESS, type TessOptions, type Mesh } from "./tessellate.ts"
import { itemColours, type Rgb } from "./colour.ts"
import { assemblyInstances, type AssemblyInstance } from "./assembly.ts"
import { fileLengthUnit } from "./units.ts"
import type { V3 } from "./vec.ts"

export interface ReadMesh {
  /** x,y,z per vertex, in millimetres */
  positions: number[]
  /** triangles, counter-clockwise seen from outside */
  indices: number[]
  /** unit normal per vertex, for smooth shading */
  normals: number[]
  /** the colour the file gives this group, or null to let the viewer choose */
  colour: Rgb | null
  /** the solid this came from, for picking and for reporting */
  solidId: number
}

export interface ReadStepResult {
  meshes: ReadMesh[]
  /** bounding box of every mesh, in millimetres */
  boundsMm: [V3, V3]
  /** sum of the closed solids' volumes, in mm^3 */
  volumeMm3: number
  triangles: number
  /** assembly placements found in the file; NOT applied to the meshes (see the header note) */
  placements: AssemblyInstance[]
  warnings: string[]
}

const colourKey = (c: Rgb | null) => (c ? `${c.r.toFixed(9)},${c.g.toFixed(9)},${c.b.toFixed(9)}` : "none")

/** Tessellate one solid, grouped by the colour each face ends up with, so a face style overrides its solid. */
function solidMeshes(solid: Solid, colourOf: (face: Face) => Rgb | null, opts: TessOptions): { colour: Rgb | null; mesh: Mesh }[] {
  const groups = new Map<string, { colour: Rgb | null; faces: Face[] }>()
  for (const shell of solid.shells) for (const face of shell.faces) {
    const c = colourOf(face)
    const k = colourKey(c)
    const g = groups.get(k)
    if (g) g.faces.push(face)
    else groups.set(k, { colour: c, faces: [face] })
  }
  const out: { colour: Rgb | null; mesh: Mesh }[] = []
  for (const g of groups.values()) {
    const synthetic: Solid = { id: solid.id, shells: [{ id: 0, closed: false, faces: g.faces }] }
    const mesh = tessellate([synthetic], opts)
    if (mesh.indices.length === 0) continue
    out.push({ colour: g.colour, mesh })
  }
  return out
}

export function readStep(input: string | Uint8Array, opts: TessOptions = DEFAULT_TESS): ReadStepResult {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: false }).decode(input)
  const warnings: string[] = []
  const p: Part21 = parsePart21(text)

  const unit = fileLengthUnit(p, warnings)
  const k = unit.mmPerUnit

  const g = new Geometry(p, warnings)
  const solids = new Brep(p, g, warnings).read()
  if (solids.length === 0) warnings.push("no closed solids found; the file may hold only surfaces, which are not read yet")

  const colours = itemColours(p, warnings)
  const placements = assemblyInstances(p, g, warnings)

  const meshes: ReadMesh[] = []
  let volumeMm3 = 0
  let triangles = 0
  for (const solid of solids) {
    const solidColour = colours.get(solid.id) ?? null
    for (const { colour, mesh } of solidMeshes(solid, (face) => colours.get(face.id) ?? solidColour, opts)) {
      // a face the tessellator could not do must be reported here, not lost with the intermediate mesh
      for (const w of mesh.warnings) if (!warnings.includes(w)) warnings.push(w)
      const stitched = stitchTJunctions(weld(mesh, 1e-6), opts.tolerance)
      const m = stitched.mesh
      if (m.indices.length === 0) continue
      const positions = k === 1 ? m.positions.slice() : m.positions.map((x) => x * k)
      meshes.push({ positions, indices: m.indices.slice(), normals: m.normals.slice(), colour, solidId: solid.id })
      triangles += m.indices.length / 3
      volumeMm3 += signedVolume(positions, m.indices) // positions are already in mm, so this is mm^3
    }
  }

  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const x = m.positions[i + a]!
        if (x < lo[a]!) lo[a] = x
        if (x > hi[a]!) hi[a] = x
      }
    }
  }
  if (!meshes.length) { lo[0] = lo[1] = lo[2] = 0; hi[0] = hi[1] = hi[2] = 0 }
  return { meshes, boundsMm: [lo, hi], volumeMm3, triangles, placements, warnings }
}

/** signed volume by the divergence theorem; positions are already in mm, so no extra scale is applied here */
function signedVolume(positions: number[], indices: number[]): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
    const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!
    const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!
    const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return v
}

export type { Rgb, AssemblyInstance, TessOptions }
