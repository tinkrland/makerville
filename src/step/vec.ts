/** Small 3D vector and 4x4 transform helpers. Plain arrays so meshes stay cheap. Original code. */
export type V3 = [number, number, number]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
export const dist = (a: V3, b: V3) => len(sub(a, b))
export function norm(a: V3): V3 {
  const l = len(a)
  if (l < 1e-300) throw new Error("cannot normalise a zero-length vector")
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** An orthonormal frame at a point: the meaning of AXIS2_PLACEMENT_3D(location, axis=Z, ref_direction=X). */
export interface Frame { o: V3; x: V3; y: V3; z: V3 }

/**
 * Build a frame from a location, a Z axis and an optional X reference. STEP allows the reference to be
 * missing or not perpendicular to the axis; the X axis is the reference with its Z component removed.
 * When there is no reference, pick the world axis least aligned with Z, which is what CAD kernels do.
 */
export function frameFrom(o: V3, axis: V3 | null, ref: V3 | null): Frame {
  const z = axis ? norm(axis) : ([0, 0, 1] as V3)
  let r = ref
  if (!r || len(sub(r, scale(z, dot(r, z)))) < 1e-9) {
    const ax = Math.abs(z[0]), ay = Math.abs(z[1]), az = Math.abs(z[2])
    r = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  }
  const x = norm(sub(r, scale(z, dot(r, z))))
  return { o, x, y: cross(z, x), z }
}
export const toWorld = (f: Frame, p: V3): V3 => add(f.o, add(add(scale(f.x, p[0]), scale(f.y, p[1])), scale(f.z, p[2])))
export const toLocal = (f: Frame, p: V3): V3 => {
  const d = sub(p, f.o)
  return [dot(d, f.x), dot(d, f.y), dot(d, f.z)]
}

/** 4x4 row-major affine transform */
export type M4 = number[]
export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
export function mul(a: M4, b: M4): M4 {
  const r = new Array<number>(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j]! += a[i * 4 + k]! * b[k * 4 + j]!
  return r
}
export const apply = (m: M4, p: V3): V3 => [m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!, m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!, m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!]
/** transform a direction (no translation) */
export const applyDir = (m: M4, p: V3): V3 => [m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2], m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2], m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2]]
export const fromFrame = (f: Frame): M4 => [f.x[0], f.y[0], f.z[0], f.o[0], f.x[1], f.y[1], f.z[1], f.o[1], f.x[2], f.y[2], f.z[2], f.o[2], 0, 0, 0, 1]
export const scaling = (k: number): M4 => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1]
export const det3 = (m: M4) => m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)
/** inverse of a rigid (rotation + translation, uniform scale allowed) transform */
export function invert(m: M4): M4 {
  const d = det3(m)
  if (Math.abs(d) < 1e-300) throw new Error("singular transform")
  const a = m[0]!, b = m[1]!, c = m[2]!, e = m[4]!, f = m[5]!, g = m[6]!, h = m[8]!, i = m[9]!, j = m[10]!
  const inv = [(f * j - g * i) / d, (c * i - b * j) / d, (b * g - c * f) / d, (g * h - e * j) / d, (a * j - c * h) / d, (c * e - a * g) / d, (e * i - f * h) / d, (b * h - a * i) / d, (a * f - b * e) / d]
  const t: V3 = [m[3]!, m[7]!, m[11]!]
  const tx = -(inv[0]! * t[0] + inv[1]! * t[1] + inv[2]! * t[2])
  const ty = -(inv[3]! * t[0] + inv[4]! * t[1] + inv[5]! * t[2])
  const tz = -(inv[6]! * t[0] + inv[7]! * t[1] + inv[8]! * t[2])
  return [inv[0]!, inv[1]!, inv[2]!, tx, inv[3]!, inv[4]!, inv[5]!, ty, inv[6]!, inv[7]!, inv[8]!, tz, 0, 0, 0, 1]
}
