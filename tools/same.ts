import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { sampleEdge, DEFAULT_TESS } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const p = parsePart21(fs.readFileSync("/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step", "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const faces = solids.flatMap((s) => s.shells.flatMap((sh) => sh.faces))

const uses: any[] = []
for (const f of faces) for (const b of f.bounds) for (const e of b.loop.edges as any[]) if (e.edgeId === 18059) uses.push({ f, e })
console.log(`edge 18059 is used ${uses.length} times`)

for (const u of uses) {
  const e = u.e
  console.log(`\nface #${u.f.id} (${u.f.surface.kind}) forward=${e.forward}  tFrom=${e.tFrom?.toFixed(12)} tTo=${e.tTo?.toFixed(12)}`)
  console.log(`  from ${e.from.map((x: number) => x.toFixed(6))}  to ${e.to.map((x: number) => x.toFixed(6))}`)
  const pts = sampleEdge(e, DEFAULT_TESS)
  console.log(`  ${pts.length} samples:`)
  for (const q of pts) console.log(`    ${q.map((x: number) => x.toFixed(6)).join(", ")}`)
}
