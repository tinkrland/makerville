import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { tessellate, weld, stitchTJunctions } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const p = parsePart21(fs.readFileSync("/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step", "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const raw = tessellate(solids)
const wm = weld(raw, 1e-6)

/** use count per undirected edge, and which triangles use it */
function uses(m: { positions: number[]; indices: number[] }) {
  const map = new Map<string, number[]>()
  const k = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
  for (let t = 0; t < m.indices.length / 3; t++) {
    const a = m.indices[t * 3]!, b = m.indices[t * 3 + 1]!, c = m.indices[t * 3 + 2]!
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const key = k(x, y)
      const arr = map.get(key)
      if (arr) arr.push(t)
      else map.set(key, [t])
    }
  }
  return map
}

const before = uses(wm)
const openBefore = [...before.entries()].filter(([, v]) => v.length === 1)
console.log(`before stitching: ${openBefore.length} open edges`)

// the long edge from the earlier probe
const P = (i: number) => [wm.positions[i * 3]!, wm.positions[i * 3 + 1]!, wm.positions[i * 3 + 2]!]
const target = openBefore
  .map(([key, v]) => ({ key, tris: v, a: P(Number(key.split(",")[0])), b: P(Number(key.split(",")[1])) }))
  .filter((e) => Math.abs(e.a[1]! - 0.15) < 1e-9 && Math.abs(e.b[1]! - 0.15) < 1e-9 && Math.abs(e.a[2]! + 2.9325) < 1e-9 && Math.abs(e.b[2]! + 2.9325) < 1e-9)
console.log(`open edges on that line: ${target.length}`)
for (const e of target) console.log(`  ${e.key}  ${e.a.map((x) => x.toFixed(3))} -> ${e.b.map((x) => x.toFixed(3))}  len ${Math.hypot(e.a[0]! - e.b[0]!, e.a[1]! - e.b[1]!, e.a[2]! - e.b[2]!).toFixed(4)}`)

const st = stitchTJunctions(wm, 1e-4)
const after = uses(st.mesh)
const P2 = (i: number) => [st.mesh.positions[i * 3]!, st.mesh.positions[i * 3 + 1]!, st.mesh.positions[i * 3 + 2]!]
console.log(`\nafter stitching: splits ${st.splits}`)
const stillOpen = [...after.entries()].filter(([, v]) => v.length === 1)
console.log(`open edges: ${stillOpen.length}`)
const onLine = stillOpen
  .map(([key]) => ({ key, a: P2(Number(key.split(",")[0])), b: P2(Number(key.split(",")[1])) }))
  .filter((e) => Math.abs(e.a[1]! - 0.15) < 1e-9 && Math.abs(e.b[1]! - 0.15) < 1e-9 && Math.abs(e.a[2]! + 2.9325) < 1e-9 && Math.abs(e.b[2]! + 2.9325) < 1e-9)
console.log(`open edges still on that line: ${onLine.length}`)
for (const e of onLine) console.log(`  ${e.key}  ${e.a.map((x) => x.toFixed(3))} -> ${e.b.map((x) => x.toFixed(3))}  len ${Math.hypot(e.a[0]! - e.b[0]!, e.a[1]! - e.b[1]!, e.a[2]! - e.b[2]!).toFixed(4)}`)

// for each still-open edge on the line, what other edges share its endpoints?
console.log("\nneighbour edges at each still-open edge's endpoints (are the partners there at all?):")
for (const e of onLine.slice(0, 4)) {
  for (const end of ["0", "1"]) {
    const v = Number(e.key.split(",")[Number(end)]!)
    const touching = [...after.entries()].filter(([key]) => key.split(",").includes(String(v)))
    const counts = touching.map(([key, t]) => `${key.split(",").find((x) => x !== String(v))}x${t.length}`).join(" ")
    console.log(`  vertex ${v} (${P2(v).map((x) => x.toFixed(3))}): ${counts}`)
  }
}
