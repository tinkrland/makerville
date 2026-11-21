import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { tessellate, weld, stitchTJunctions, meshStats } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const file = process.argv[2] ?? "/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"
const p = parsePart21(fs.readFileSync(file, "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const wm = weld(tessellate(solids), 1e-6)
const st = stitchTJunctions(wm)
const m = st.mesh
const s = meshStats(m)
console.log(`${file.split("/").pop()}: after weld+stitch open ${s.boundaryEdges} nonmanifold ${s.nonManifoldEdges} splits ${st.splits}`)

const V = (i: number): number[] => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]
const k = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
const uses = new Map<string, number>()
for (let t = 0; t < m.indices.length / 3; t++) {
  const a = m.indices[t * 3]!, b = m.indices[t * 3 + 1]!, c = m.indices[t * 3 + 2]!
  for (const [x, y] of [[a, b], [b, c], [c, a]] as const) uses.set(k(x, y), (uses.get(k(x, y)) ?? 0) + 1)
}
const open = [...uses.entries()].filter(([, n]) => n === 1).map(([key]) => key.split(",").map(Number) as [number, number])
console.log(`open edges: ${open.length}`)

// every other edge, as segments, to find the nearest one that does not share a vertex
const allEdges = [...uses.keys()].map((key) => key.split(",").map(Number) as [number, number])
function segDist(p0: number[], p1: number[], q0: number[], q1: number[]): number {
  const d = (a: number[], b: number[], c: number[]) => {
    const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const ac = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
    const l = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2
    const t = l < 1e-30 ? 0 : Math.max(0, Math.min(1, (ac[0]! * ab[0]! + ac[1]! * ab[1]! + ac[2]! * ab[2]!) / l))
    return Math.hypot(ac[0]! - ab[0]! * t, ac[1]! - ab[1]! * t, ac[2]! - ab[2]! * t)
  }
  return Math.min(d(p0, p1, q0), d(p0, p1, q1), d(q0, q1, p0), d(q0, q1, p1))
}
const rows: { key: string; gap: number; len: number; a: number[]; b: number[] }[] = []
for (const [x, y] of open) {
  const A = V(x), B = V(y)
  let best = Infinity
  for (const [u, v] of allEdges) {
    if (u === x || u === y || v === x || v === y) continue
    const d = segDist(A, B, V(u), V(v))
    if (d < best) best = d
  }
  rows.push({ key: `${x},${y}`, gap: best, len: Math.hypot(A[0]! - B[0]!, A[1]! - B[1]!, A[2]! - B[2]!), a: A, b: B })
}
rows.sort((p, q) => p.gap - q.gap)
console.log("open edges by nearest non-partner edge:")
for (const r of rows) console.log(`  gap ${r.gap.toExponential(2)}  len ${r.len.toFixed(4)}  ${r.a.map((x) => x.toFixed(4))} -> ${r.b.map((x) => x.toFixed(4))}`)
