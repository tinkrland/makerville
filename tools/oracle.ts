/**
 * Oracle check: compare our tessellation of a STEP model against KiCad's own 3D export.
 *
 * KiCad 9 can export a board's 3D view as STL, and it meshes STEP models with its own importer. That makes it
 * an independent implementation to check us against, rather than checking our mesh against itself.
 *
 * The board deliberately carries a 1x1 mm outline at (100,100) and the model far away at (200,200), so the
 * STL contains two disjoint groups: the board slab and the model. Connected components separate them, and the
 * model is everything that is not the slab. Only COMPARISONS THAT SURVIVE AN AXIS SWAP are used - the sorted
 * bounding-box extents and the volume - because KiCad's board frame flips and rotates Y relative to the STEP
 * frame, and pinning an axis convention would be testing the frame, not the geometry.
 *
 * Usage: node --experimental-strip-types tools/oracle.ts <model.step> [more.step ...]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { readStep } from "../src/step/index.ts"

const BOARD = `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (footprint "oracle:model_under_test"
    (layer "F.Cu")
    (uuid "11111111-2222-3333-4444-555555555555")
    (at 200 200)
    (property "Reference" "U1" (at 0 -5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "model" (at 0 5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (model "@MODEL@" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
  )
  (gr_rect (start 100 100) (end 101 101) (stroke (width 0.05) (type solid)) (fill none)
    (layer "Edge.Cuts") (uuid "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
)
`

type Tri = [number, number, number, number, number, number, number, number, number]

export function parseStl(buf: Buffer): Tri[] {
  const tris: Tri[] = []
  // binary STL is exactly 84 + 50n bytes; anything else is text. The "solid" header is not a reliable tell,
  // because binary writers use it too.
  const isBinary = buf.length >= 84 && 84 + 50 * buf.readUInt32LE(80) === buf.length
  if (!isBinary) {
    const text = buf.toString("latin1")
    // the exponent may carry a sign ("1.234000e-05"); a character class without '-' truncates it to NaN
    const num = "(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)"
    const nums = [...text.matchAll(new RegExp(`vertex\\s+${num}\\s+${num}\\s+${num}`, "g"))]
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const v = nums.slice(i, i + 3).map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
      tris.push([...v[0]!, ...v[1]!, ...v[2]!] as Tri)
    }
    return tris
  }
  const n = buf.readUInt32LE(80)
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12
    tris.push([
      buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8),
      buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20),
      buf.readFloatLE(o + 24), buf.readFloatLE(o + 28), buf.readFloatLE(o + 32),
    ])
  }
  return tris
}

const keyOf = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`

/** connected components over shared vertices, so the board slab can be dropped without guessing */
export function components(tris: Tri[]): { tris: Tri[]; min: number[]; max: number[]; volume: number }[] {
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let r = a
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = a
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const t of tris) {
    const ks = [0, 3, 6].map((i) => keyOf(t[i]!, t[i + 1]!, t[i + 2]!))
    for (const k of ks) if (!parent.has(k)) parent.set(k, k)
    union(ks[0]!, ks[1]!)
    union(ks[1]!, ks[2]!)
  }
  const groups = new Map<string, Tri[]>()
  for (const t of tris) {
    const r = find(keyOf(t[0]!, t[1]!, t[2]!))
    const g = groups.get(r)
    if (g) g.push(t)
    else groups.set(r, [t])
  }
  const out: { tris: Tri[]; min: number[]; max: number[]; volume: number }[] = []
  for (const g of groups.values()) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    let vol = 0
    for (const t of g) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, t[k]!, t[k + 3]!, t[k + 6]!)
        max[k] = Math.max(max[k]!, t[k]!, t[k + 3]!, t[k + 6]!)
      }
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = t
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    }
    out.push({ tris: g, min, max, volume: Math.abs(vol) })
  }
  return out
}

export function kicadOracle(stepPath: string): { dims: number[]; volume: number; components: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"))
  const board = path.join(dir, "b.kicad_pcb")
  const stl = path.join(dir, "b.stl")
  fs.writeFileSync(board, BOARD.replace("@MODEL@", stepPath))
  execFileSync("kicad-cli", ["pcb", "export", "stl", "-o", stl, board], { stdio: "pipe" })
  const comps = components(parseStl(fs.readFileSync(stl)))
  // the board slab sits at (100..101, 100..101); everything else is the model
  const model = comps.filter((c) => (c.min[0]! + c.max[0]!) / 2 > 150 || (c.min[1]! + c.max[1]!) / 2 > 150)
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  let volume = 0
  for (const c of model) {
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, c.min[k]!); max[k] = Math.max(max[k]!, c.max[k]!) }
    volume += c.volume
  }
  const dims = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!].sort((a, b) => a - b)
  fs.rmSync(dir, { recursive: true, force: true })
  return { dims, volume, components: model.length }
}

function main() {
let failures = 0
for (const file of process.argv.slice(2)) {
  const ours = readStep(fs.readFileSync(file, "latin1"))
  const [lo, hi] = ours.boundsMm
  const ourDims = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].sort((a, b) => a - b)
  let oracle: { dims: number[]; volume: number; components: number }
  try {
    oracle = kicadOracle(path.resolve(file))
  } catch (e) {
    console.log(`${path.basename(file)}: kicad-cli failed (${(e as Error).message.split("\n")[0]})`)
    failures++
    continue
  }
  const dimErr = Math.max(...ourDims.map((d, i) => Math.abs(d - oracle.dims[i]!)))
  const volErrPct = oracle.volume > 0 ? Math.abs(ours.volumeMm3 - oracle.volume) / oracle.volume * 100 : 0
  const dimOk = dimErr <= 0.05
  const volOk = volErrPct <= 2
  if (!dimOk || !volOk) failures++
  console.log(
    `${path.basename(file).padEnd(26)} dims ours [${ourDims.map((d) => d.toFixed(3)).join(", ")}] ` +
    `kicad [${oracle.dims.map((d) => d.toFixed(3)).join(", ")}] worst ${dimErr.toFixed(4)} mm ` +
    `| vol ours ${ours.volumeMm3.toFixed(3)} kicad ${oracle.volume.toFixed(3)} (${volErrPct.toFixed(2)}%) ` +
    `| ${oracle.components} parts ${dimOk && volOk ? "OK" : "FAIL"}`)
}
process.exit(failures ? 1 : 0)
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main()
