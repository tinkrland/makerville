// Is there solid material at a point inside a closed triangle mesh?
//
// Casts a ray straight up +z from the point and counts how many triangles it crosses; an odd count
// means inside. Two things make a naive version wrong, and both bit us:
//   1. A point whose (x,y) lies exactly on an edge shared by two triangles (very common: a cube's top
//      face is split along a diagonal, and coordinates like 1,1 sit right on it) gets counted twice or
//      not at all. The fix is a consistent tie-break so a shared edge belongs to exactly one triangle.
//   2. Float noise. We nudge the ray by a tiny irrational offset so it almost never lands on an edge.
export type Tri = number[][]

const NUDGE_X = 1.0e-7 * Math.SQRT2
const NUDGE_Y = 1.0e-7 * Math.PI

export function loadStl(text: string): Tri[] {
  const v = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
  const out: Tri[] = []
  for (let i = 0; i + 2 < v.length; i += 3) out.push([v[i]!, v[i + 1]!, v[i + 2]!])
  return out
}

/** ray-cast; the (x,y) is nudged off any shared edge */
export function solidAt(tris: Tri[], x: number, y: number, z: number): boolean {
  const px = x + NUDGE_X
  const py = y + NUDGE_Y
  let crossings = 0
  for (const t of tris) {
    const [a, b, c] = t as [number[], number[], number[]]
    const d = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!)
    if (Math.abs(d) < 1e-15) continue // vertical (edge-on) triangle: it cannot be crossed by a vertical ray
    const l1 = ((b[1]! - c[1]!) * (px - c[0]!) + (c[0]! - b[0]!) * (py - c[1]!)) / d
    const l2 = ((c[1]! - a[1]!) * (px - c[0]!) + (a[0]! - c[0]!) * (py - c[1]!)) / d
    const l3 = 1 - l1 - l2
    if (l1 < 0 || l2 < 0 || l3 < 0) continue
    const zz = l1 * a[2]! + l2 * b[2]! + l3 * c[2]!
    if (zz > z) crossings++
  }
  return crossings % 2 === 1
}

/**
 * Walk along a straight line (at fixed y and z) from x0 to x1 and return every x where the material
 * flips between solid and empty. Used to MEASURE a wall: the gap between two flips is its thickness,
 * and the first flip is where it starts. Step is the resolution; the flips are then refined by bisection.
 */
export function transitionsAlongX(tris: Tri[], y: number, z: number, x0: number, x1: number, step = 0.05): number[] {
  const out: number[] = []
  let prev = solidAt(tris, x0, y, z)
  let px = x0
  for (let x = x0 + step; x <= x1 + 1e-9; x += step) {
    const cur = solidAt(tris, x, y, z)
    if (cur !== prev) {
      let lo = px, hi = x
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (solidAt(tris, mid, y, z) === prev) lo = mid
        else hi = mid
      }
      out.push(Math.round(((lo + hi) / 2) * 1000) / 1000)
    }
    prev = cur
    px = x
  }
  return out
}

export function transitionsAlongY(tris: Tri[], x: number, z: number, y0: number, y1: number, step = 0.05): number[] {
  const out: number[] = []
  let prev = solidAt(tris, x, y0, z)
  let py = y0
  for (let y = y0 + step; y <= y1 + 1e-9; y += step) {
    const cur = solidAt(tris, x, y, z)
    if (cur !== prev) {
      let lo = py, hi = y
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2
        if (solidAt(tris, x, mid, z) === prev) lo = mid
        else hi = mid
      }
      out.push(Math.round(((lo + hi) / 2) * 1000) / 1000)
    }
    prev = cur
    py = y
  }
  return out
}
