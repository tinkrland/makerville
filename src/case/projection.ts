/**
 * Case projections: what each part asks of its enclosure.
 *
 * The idea, taken from how keeberia's paracraft engine works (see NOTICE.md):
 * the case is never modelled by hand. Every part carries a small record of
 * what it needs from an enclosure, and the generator reads only those records
 * plus the placements. Change a part or move it and the case follows, because
 * both come from the same data.
 *
 * keeberia keys these facts to keyboard categories (switch, encoder, mcu). A
 * general PCB has no such categories, so here the vocabulary is about what the
 * part DOES to the enclosure:
 *
 *   opening   the part must be reachable from outside. A cut through a wall or
 *             the lid, sized from the part's own shape plus a clearance.
 *   clearance the part needs free air above it (everything has this, from its
 *             height), which sets how tall the cavity must be.
 *
 * `edge` openings (USB, jacks, SD slots) face a direction, and the wall they
 * cut is DERIVED from where the part sits and how it is rotated. `top`
 * openings (buttons, LEDs, displays) cut the lid above the part.
 */
import type { Board, Footprint, Pt } from "../model.ts"
import { padWorld } from "../model.ts"

export type Wall = "x+" | "x-" | "y+" | "y-"

/** the outward direction a part's opening faces, in the part's own frame (before rotation) */
export type LocalFace = "x+" | "x-" | "y+" | "y-"

export interface EdgeOpening {
  kind: "edge"
  /** which side of the part the connector faces, in its own frame */
  faces: LocalFace
  /** opening size across the wall: width along the wall, height up from the board surface */
  width: number
  height: number
  /** distance from the board surface to the opening's bottom edge */
  z: number
  /** why this opening exists, shown in warnings and as a comment in the scad */
  label: string
}

export interface TopOpening {
  kind: "top"
  width: number
  height: number
  /** circle if set, otherwise a rectangle width x height */
  round?: boolean
  label: string
}

export type Opening = EdgeOpening | TopOpening

export interface Projection {
  openings: Opening[]
}

/** library id -> projection. A part with no entry has no openings; its height still counts. */
export const PROJECTIONS: Record<string, Projection> = {
  "boardforge:USB-C_Receptacle_16P": {
    openings: [{ kind: "edge", faces: "y-", width: 8.94, height: 3.26, z: 0, label: "USB-C" }],
  },
}

export function projectionOf(fp: Footprint, extra?: Record<string, Projection>): Projection | undefined {
  return extra?.[fp.lib] ?? PROJECTIONS[fp.lib]
}

/** rotate a local direction by the footprint rotation (ccw degrees, y up) and name the wall it points at */
export function wallFor(face: LocalFace, rotationDeg: number, side: "top" | "bottom"): Wall {
  // a part on the bottom side is mirrored in x when viewed from the top
  let nx = face === "x+" ? 1 : face === "x-" ? -1 : 0
  const ny = face === "y+" ? 1 : face === "y-" ? -1 : 0
  if (side === "bottom") nx = -nx
  const r = (rotationDeg * Math.PI) / 180
  const rx = nx * Math.cos(r) - ny * Math.sin(r)
  const ry = nx * Math.sin(r) + ny * Math.cos(r)
  // A diagonal (45, 135, ...) is a true geometric tie, but cos and sin differ in the last bit,
  // so a bare comparison would pick a wall by rounding noise (and a different one at 45 than at 135).
  // Compare with a tolerance and break ties toward the y walls, always.
  const ax = Math.abs(rx), ay = Math.abs(ry)
  const yWins = ay >= ax - TIE
  return yWins ? (ry > 0 ? "y+" : "y-") : rx > 0 ? "x+" : "x-"
}

/** angles closer than this many units of the unit circle are treated as a tie */
const TIE = 1e-9

/** a resolved opening: where it lands in board coordinates */
export interface ResolvedOpening {
  ref: string
  label: string
  kind: "edge" | "top"
  side: "top" | "bottom"
  /** edge openings */
  wall?: Wall
  /** position along the wall (x for y walls, y for x walls) */
  along?: number
  /** size of the cut */
  width: number
  height: number
  /** edge openings: world coordinate (x for x walls, y for y walls) of the part's outermost body edge toward the wall */
  bodyEdge?: number
  /** bottom of the cut above the board surface (edge) */
  z: number
  /** top openings: centre in board coordinates */
  at?: Pt
  round?: boolean
}

export function resolveOpenings(board: Board, extra?: Record<string, Projection>): ResolvedOpening[] {
  const out: ResolvedOpening[] = []
  for (const fp of board.footprints) {
    const pr = projectionOf(fp, extra)
    if (!pr) continue
    for (const o of pr.openings) {
      if (o.kind === "edge") {
        const wall = wallFor(o.faces, fp.rotation, fp.side)
        // where the part's pads centre sits is a better anchor than the origin for connectors whose origin is off-centre
        const c = centroid(fp)
        out.push({ ref: fp.ref, label: o.label, kind: "edge", side: fp.side, wall, along: wall === "y+" || wall === "y-" ? c.x : c.y, bodyEdge: bodyEdgeToward(fp, wall), width: o.width, height: o.height, z: o.z })
      } else {
        out.push({ ref: fp.ref, label: o.label, kind: "top", side: fp.side, at: centroid(fp), width: o.width, height: o.height, z: 0, round: o.round })
      }
    }
  }
  return out
}

function centroid(fp: Footprint): Pt {
  if (!fp.pads.length) return fp.at
  let x = 0, y = 0
  for (const p of fp.pads) { const w = padWorld(fp, p); x += w.x; y += w.y }
  return { x: x / fp.pads.length, y: y / fp.pads.length }
}

/** the outermost extent of the part's body toward a wall, in world coordinates. Uses pads and the body box. */
function bodyEdgeToward(fp: Footprint, wall: Wall): number {
  const r = (fp.rotation * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  const hw = fp.body.w / 2, hh = fp.body.h / 2
  const mir = fp.side === "bottom" ? -1 : 1
  const pts: Pt[] = []
  for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
    const lx = x * mir
    pts.push({ x: fp.at.x + lx * c - y * s, y: fp.at.y + lx * s + y * c })
  }
  for (const p of fp.pads) {
    const w = padWorld(fp, p)
    const hx = Math.max(p.size.w, p.size.h) / 2
    pts.push({ x: w.x - hx, y: w.y - hx }, { x: w.x + hx, y: w.y + hx })
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  return wall === "x+" ? Math.max(...xs) : wall === "x-" ? Math.min(...xs) : wall === "y+" ? Math.max(...ys) : Math.min(...ys)
}
