// For every open edge in a welded mesh, how far is it from the nearest edge that is NOT its own partner?
// A tiny distance means a sliver gap (harmless, or closable); a large one means a real hole.
import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { tessellate, weld } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const file = process.argv[2]!
const p = parsePart21(fs.readFileSync(file, "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const m = weld(tessellate(solids), 1e-6)
const P = m.positions, I = m.indices
const v = (i: number) => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!] as [number, number, number]
const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!] as [number, number, number]
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const len = (a: number[]) => Math.sqrt(dot(a, a))

/** distance from point q to segment ab */
function ptSeg(q: number[], a: number[], b: number[]) {
  const ab = sub(b, a), aq = sub(q, a)
  const d = dot(ab, ab)
  const t = d === 0 ? 0 : Math.max(0, Math.min(1, dot(aq, ab) / d))
  return len(sub(q, [a[0]! + ab[0]! * t, a[1]! + ab[1]! * t, a[2]! + ab[2]! * t]))
}

// count undirected edge uses
const use = new Map<string, number>()
const edgeVerts = new Map<string, [number, number]>()
for (let t = 0; t < I.length; t += 3) {
  const tri = [I[t]!, I[t + 1]!, I[t + 2]!]
  for (const [a, b] of [[tri[0]!, tri[1]!], [tri[1]!, tri[2]!], [tri[2]!, tri[0]!]] as const) {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`
    use.set(k, (use.get(k) ?? 0) + 1)
    edgeVerts.set(k, [a, b])
  }
}
const open: [number, number][] = []
for (const [k, c] of use) if (c === 1) open.push(edgeVerts.get(k)!)
console.log(`${file.split("/").pop()}: open edges ${open.length}`)

// all edges as segments, for the nearest-other-edge search
const all: [number, number][] = [...edgeVerts.values()]
const rows: { d: number; a: number[]; b: number[] }[] = []
for (const [a, b] of open) {
  const A = v(a), B = v(b)
  let best = Infinity
  for (const [c, d] of all) {
    if (c === a || c === b || d === a || d === b) continue
    const C = v(c), D = v(d)
    const dist = Math.min(ptSeg(A, C, D), ptSeg(B, C, D), ptSeg(C, A, B), ptSeg(D, A, B))
    if (dist < best) best = dist
  }
  rows.push({ d: best, a: A, b: B })
}
rows.sort((x, y) => x.d - y.d)
const fmt = (x: number) => x.toExponential(2)
console.log("closest other edge, sorted:")
for (const r of rows.slice(0, 40)) {
  console.log(`  ${fmt(r.d).padStart(9)} mm   edge ${r.a.map((q) => q.toFixed(4)).join(",")} -> ${r.b.map((q) => q.toFixed(4)).join(",")}   length ${len(sub(r.b, r.a)).toFixed(4)}`)
}
const buckets = [1e-6, 1e-4, 1e-3, 1e-2, 1e-1, 1, Infinity]
const counts = buckets.map((b) => rows.filter((r) => r.d <= b).length)
console.log("cumulative counts by distance:", buckets.map((b, i) => `<=${b === Infinity ? "inf" : fmt(b)}: ${counts[i]}`).join("  "))
