import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { tessellateFace, sampleEdge, DEFAULT_TESS } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const p = parsePart21(fs.readFileSync("/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step", "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const faces = solids.flatMap((s) => s.shells.flatMap((sh) => sh.faces))

const key = (v: number[]) => v.map((x) => Math.round(x * 1e5)).join(",")
const near = (a: number[], b: number[], tol = 1e-4) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < tol

for (const fid of [12298, 14655]) {
  const f = faces.find((x) => x.id === fid)!
  const fm = tessellateFace(f)
  // boundary edges this face is supposed to produce
  const want: { name: string; a: number[]; b: number[] }[] = []
  for (const b of f.bounds) for (const e of b.loop.edges as any[]) {
    const pts = sampleEdge(e, DEFAULT_TESS)
    for (let i = 0; i + 1 < pts.length; i++) want.push({ name: `${e.edgeId}`, a: pts[i]!, b: pts[i + 1]! })
  }
  // edges the triangles actually contain
  const have: [number[], number[]][] = []
  for (let t = 0; t < fm.tris.length; t++) {
    const [i, j, k] = fm.tris[t]!
    const P = (n: number) => fm.positions[n]! as unknown as number[]
    for (const [x, y] of [[i, j], [j, k], [k, i]] as const) have.push([P(x), P(y)])
  }
  const missing = want.filter((e) => !have.some(([a, b]) => (near(a, e.a) && near(b, e.b)) || (near(a, e.b) && near(b, e.a))))
  console.log(`face #${fid} (${f.surface.kind}): ${want.length} boundary segments expected, ${missing.length} missing from its own triangles`)
  for (const m of missing.slice(0, 6)) console.log(`   missing edge of entity ${m.name}: ${m.a.map((x) => x.toFixed(4))} -> ${m.b.map((x) => x.toFixed(4))}`)
}
void key
