/**
 * The board model. This is the single source of truth the editor mutates,
 * the KiCad writer serialises, the DRC reads and the case generator measures.
 *
 * Conventions:
 *  - millimetres everywhere
 *  - y grows UP (maths convention). The KiCad writer flips it, nothing else does.
 *  - nets are first class: every pad, track and via points at a net by NAME
 *    ("" means unconnected). There is no connectivity-key indirection.
 *  - layers are KiCad names ("F.Cu", "B.Cu", "In1.Cu"...), so nothing is mapped
 */

export type Pt = { x: number; y: number }

export type CopperLayer = string // "F.Cu" | "B.Cu" | "In1.Cu" ...

export type PadShape = "rect" | "circle" | "oval" | "roundrect"

export interface Pad {
  /** pad number/name inside its footprint, e.g. "1" or "A3" */
  name: string
  kind: "smd" | "thru" | "npth"
  shape: PadShape
  /** centre relative to the footprint origin, BEFORE footprint rotation */
  at: Pt
  size: { w: number; h: number }
  /** drill diameter, thru and npth only */
  drill?: number
  /** which copper layers carry it. smd: one. thru: all copper. */
  layers: CopperLayer[]
  net: string
}

export interface FootprintGraphic {
  kind: "line" | "rect" | "circle"
  layer: string // "F.SilkS" | "F.CrtYd" | "F.Fab" ...
  /** line: a->b. rect: a, b are opposite corners. circle: a is centre, b is a point on it */
  a: Pt
  b: Pt
  width: number
}

export interface Footprint {
  ref: string
  value: string
  /** library id such as "boardforge:R_0402" */
  lib: string
  at: Pt
  /** degrees, counter-clockwise, as seen with y up */
  rotation: number
  side: "top" | "bottom"
  pads: Pad[]
  graphics: FootprintGraphic[]
  /** body height above the board surface, mm. This is what the case reads. */
  height: number
  /** body footprint size before rotation, mm. This is what the case reads. */
  body: { w: number; h: number }
  /** optional 3D model, a path relative to the project. Never a URL. */
  model?: { path: string; offset?: [number, number, number]; rotate?: [number, number, number]; scale?: [number, number, number] }
}

export interface Track {
  id: string
  a: Pt
  b: Pt
  width: number
  layer: CopperLayer
  net: string
}

export interface Via {
  id: string
  at: Pt
  diameter: number
  drill: number
  from: CopperLayer
  to: CopperLayer
  net: string
}

export interface MountHole {
  id: string
  at: Pt
  drill: number
  /** keep-out ring around it, for screws and standoffs */
  pad: number
}

export interface Rules {
  clearance: number
  minTrackWidth: number
  minViaDiameter: number
  minViaDrill: number
  minAnnularRing: number
  /** copper to board edge */
  edgeClearance: number
  minHoleToHole: number
}

export interface Board {
  name: string
  thickness: number
  /** copper layer names in stack order, top first. 2 or 4 or more */
  copper: CopperLayer[]
  /** closed polygon, counter-clockwise, y up. Rounded corners are pre-flattened. */
  outline: Pt[]
  /** internal cut-outs */
  cutouts: Pt[][]
  nets: string[]
  footprints: Footprint[]
  tracks: Track[]
  vias: Via[]
  holes: MountHole[]
  rules: Rules
}

export const DEFAULT_RULES: Rules = {
  clearance: 0.2,
  minTrackWidth: 0.15,
  minViaDiameter: 0.5,
  minViaDrill: 0.3,
  minAnnularRing: 0.13,
  edgeClearance: 0.3,
  minHoleToHole: 0.5,
}

export function newBoard(name: string, w: number, h: number, layers = 2): Board {
  const copper = layers === 2 ? ["F.Cu", "B.Cu"] : ["F.Cu", ...Array.from({ length: layers - 2 }, (_, i) => `In${i + 1}.Cu`), "B.Cu"]
  return {
    name,
    thickness: 1.6,
    copper,
    outline: rectOutline(w, h),
    cutouts: [],
    nets: [],
    footprints: [],
    tracks: [],
    vias: [],
    holes: [],
    rules: { ...DEFAULT_RULES },
  }
}

/** centred on the origin, counter-clockwise, y up */
export function rectOutline(w: number, h: number): Pt[] {
  const x = w / 2
  const y = h / 2
  return [
    { x: -x, y: -y },
    { x: x, y: -y },
    { x: x, y: y },
    { x: -x, y: y },
  ]
}

/** rectangle with rounded corners flattened to segments */
export function roundedRectOutline(w: number, h: number, r: number, segs = 8): Pt[] {
  const rr = Math.min(r, w / 2, h / 2)
  if (rr <= 0) return rectOutline(w, h)
  const hx = w / 2
  const hy = h / 2
  const corners: [number, number, number][] = [
    [hx - rr, -hy + rr, -90],
    [hx - rr, hy - rr, 0],
    [-hx + rr, hy - rr, 90],
    [-hx + rr, -hy + rr, 180],
  ]
  const out: Pt[] = []
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segs; i++) {
      const a = ((start + (90 * i) / segs) * Math.PI) / 180
      out.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) })
    }
  }
  return out
}

export function ensureNet(b: Board, net: string): void {
  if (net && !b.nets.includes(net)) b.nets.push(net)
}

let counter = 0
export function uid(prefix: string): string {
  counter += 1
  return `${prefix}${counter.toString(36)}`
}

/** world position of a pad, applying footprint rotation, side and translation */
export function padWorld(fp: Footprint, pad: Pad): Pt {
  const mx = fp.side === "bottom" ? -pad.at.x : pad.at.x
  const r = (fp.rotation * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: fp.at.x + mx * c - pad.at.y * s, y: fp.at.y + mx * s + pad.at.y * c }
}

/** pad size in world space (swaps w/h on 90 degree rotations) */
export function padWorldSize(fp: Footprint, pad: Pad): { w: number; h: number } {
  const q = Math.round(((fp.rotation % 180) + 180) % 180)
  return q === 90 ? { w: pad.size.h, h: pad.size.w } : { ...pad.size }
}

export function polygonBounds(p: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of p) {
    minX = Math.min(minX, q.x)
    minY = Math.min(minY, q.y)
    maxX = Math.max(maxX, q.x)
    maxY = Math.max(maxY, q.y)
  }
  return { minX, minY, maxX, maxY }
}

export function polygonArea(p: Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length]!
    a += p[i]!.x * q.y - q.x * p[i]!.y
  }
  return a / 2
}
