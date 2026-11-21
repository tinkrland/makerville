/**
 * Placing a footprint's 3D model in board space.
 *
 * A renderer needs world-space triangles, not a STEP file's local ones. This module is that bridge: it takes
 * what readStep returns and the footprint that references it, and produces meshes in the BOARD MODEL's frame
 * (millimetres, x right, y up, z up, z = 0 at the board's top surface), which is the frame `src/model.ts`
 * already uses everywhere else.
 *
 * The transform chain was MEASURED against KiCad 9, not guessed. `tools/probe-transform.ts` renders the same
 * model on a front and a back footprint with an asymmetric offset and with rotations of 0, 45 and 90 degrees,
 * and reads where the geometry actually lands in KiCad's own STL export. What that established:
 *
 *   - The model's own `offset` is applied after its `scale` and `rotate`.
 *   - The model's `rotate` is XYZ order, degrees (KiCad's documented order).
 *   - A BACK-side footprint negates the model's y and z, and leaves x alone, whatever the rotation is. That is
 *     a 180-degree turn about X applied after the footprint rotation: measured with a 90-degree footprint, a
 *     +x offset still moved the model to +y on both sides, while +y and +z flipped sign on the back.
 *   - Footprint rotation turns the model a quarter turn in the board plane for 90 degrees, and keeps the
 *     distance from the footprint. That much is measured. The DIRECTION is NOT: KiCad's 3D frame cannot be
 *     pinned from outside (its y sign is a convention, and it shifts z by the board thickness on export), so
 *     an absolute direction would be testing that convention rather than the geometry. The direction here
 *     follows the convention `model.ts` documents for Footprint.rotation - counter-clockwise as seen with y up
 *     - and the tests assert the frame-free facts (length preserved, quarter turn square to the original,
 *     flip commuting with the turn) plus the kicad-cli extents check. If a preview ever looks mirrored, this
 *     sign is the first thing to check, and it is one line.
 *
 * z needs a word. STEP models are authored with z = 0 at the board surface, so a front part sits at z >= 0 and
 * a back part hangs below at z <= 0 after the flip above. KiCad's STL export shifts everything by the board
 * thickness; that shift is an artefact of its export frame and is deliberately NOT reproduced here, because a
 * preview wants the model where the model says it is.
 */
import type { Footprint } from "../model.ts"
import type { ReadMesh, ReadStepResult } from "./index.ts"
import type { Rgb } from "./colour.ts"
import { type M4, mul, apply, applyDir, norm } from "./vec.ts"

const rad = (deg: number) => (deg * Math.PI) / 180

const translate = (t: [number, number, number]): M4 => [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1]

const scaleM = (s: [number, number, number]): M4 => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]

function rotX(deg: number): M4 {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg))
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]
}

function rotY(deg: number): M4 {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg))
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]
}

function rotZ(deg: number): M4 {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg))
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/**
 * The matrix that takes a model's local coordinates to board-model coordinates for one footprint.
 * Order, innermost first: scale -> rotate (X then Y then Z) -> model offset -> back-side flip -> footprint
 * rotation -> footprint position.
 */
export function footprintModelMatrix(
  fp: Pick<Footprint, "at" | "rotation" | "side">,
  spec: { offset?: [number, number, number]; scale?: [number, number, number]; rotate?: [number, number, number] },
): M4 {
  const scale = spec.scale ?? [1, 1, 1]
  const rot = spec.rotate ?? [0, 0, 0]
  const off = spec.offset ?? [0, 0, 0]

  let m = scaleM(scale)
  m = mul(rotX(rot[0]), m)
  m = mul(rotY(rot[1]), m)
  m = mul(rotZ(rot[2]), m)
  m = mul(translate(off), m)
  if (fp.side === "bottom") m = mul(rotX(180), m)
  m = mul(rotZ(fp.rotation), m)
  m = mul(translate([fp.at.x, fp.at.y, 0]), m)
  return m
}

/** One placed mesh, in board-model millimetres. */
export interface PlacedMesh {
  positions: number[]
  indices: number[]
  normals: number[]
  colour: Rgb | null
  /** the footprint this belongs to */
  ref: string
}

/** Transform one mesh by a matrix, keeping winding and renormalising normals. */
export function placeMesh(mesh: Pick<ReadMesh, "positions" | "indices" | "normals" | "colour">, m: M4, ref: string): PlacedMesh {
  const positions: number[] = new Array(mesh.positions.length)
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const q = apply(m, [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!])
    positions[i] = q[0]
    positions[i + 1] = q[1]
    positions[i + 2] = q[2]
  }
  const normals: number[] = new Array(mesh.normals.length)
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const n = norm(applyDir(m, [mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!]))
    normals[i] = n[0]
    normals[i + 1] = n[1]
    normals[i + 2] = n[2]
  }
  return { positions, indices: mesh.indices.slice(), normals, colour: mesh.colour, ref }
}

/**
 * Every mesh of a loaded model, placed for one footprint. Returns an empty array when the footprint has no
 * model, so a caller can simply render the body box instead.
 */
export function placeFootprintModel(model: ReadStepResult, fp: Footprint): PlacedMesh[] {
  if (!fp.model) return []
  const m = footprintModelMatrix(fp, fp.model)
  return model.meshes.map((mesh) => placeMesh(mesh, m, fp.ref))
}

/** bounds of a set of placed meshes, or null when there are none */
export function placedBounds(meshes: PlacedMesh[]): [[number, number, number], [number, number, number]] | null {
  if (!meshes.length) return null
  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k]!
        if (v < lo[k]!) lo[k] = v
        if (v > hi[k]!) hi[k] = v
      }
    }
  }
  return [lo, hi]
}
