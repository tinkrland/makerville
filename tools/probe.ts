// Probe one open edge: its use count, and every mesh vertex lying near the segment.
import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { tessellate, weld } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const file = "/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"
const p = parsePart21(fs.readFileSync(file, "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const m = weld(tessellate(solids), 1e-6)
const P = m.positions, I = m.indices
const v = (i: number) => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!] as [number, number, number]
const k = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`)

const uses = new Map<string, number>()
for (let t = 0; t < I.length; t += 3) for (const [i, j] of [[I[t]!, I[t + 1]!], [I[t + 1]!, I[t + 2]!], [I[t + 2]!, I[t]!]] as const) uses.set(k(i, j), (uses.get(k(i, j)) ?? 0) + 1)

// find the long open edge near y=0.15, z=-2.9325
let target: [number, number] | null = null
for (const [key, c] of uses) {
  if (c !== 1) continue
  const [i, j] = key.split(",").map(Number) as [number, number]
  const A = v(i), B = v(j)
  if (Math.abs(A[1] - 0.15) < 1e-6 && Math.abs(B[1] - 0.15) < 1e-6 && Math.abs(A[2] + 2.9325) < 1e-6) {
    const L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2])
    if (L > 2) target = [i, j]
  }
}
if (!target) { console.log("long edge not found"); process.exit(0) }
const [a, b] = target
const A = v(a), B = v(b)
console.log(`open edge ${a} -> ${b}   ${A.map((q) => q.toFixed(6))} -> ${B.map((q) => q.toFixed(6))}`)
const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
const l2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2
console.log("nearby vertices (distance from the line, and t along it):")
const nv = P.length / 3
for (let q = 0; q < nv; q++) {
  if (q === a || q === b) continue
  const Q = v(q)
  const t = ((Q[0] - A[0]) * ab[0]! + (Q[1] - A[1]) * ab[1]! + (Q[2] - A[2]) * ab[2]!) / l2
  if (t < -0.01 || t > 1.01) continue
  const proj = [A[0] + ab[0]! * t, A[1] + ab[1]! * t, A[2] + ab[2]! * t]
  const d = Math.hypot(Q[0] - proj[0]!, Q[1] - proj[1]!, Q[2] - proj[2]!)
  if (d < 1e-2) console.log(`  v${q} t=${t.toFixed(4)} offLine=${d.toExponential(2)}  at ${Q.map((x) => x.toFixed(6))}`)
}
