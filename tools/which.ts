import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { sampleEdge, DEFAULT_TESS } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const p = parsePart21(fs.readFileSync("/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step", "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const faces = solids.flatMap((s) => s.shells.flatMap((sh) => sh.faces))

const targets: [number[], number[]][] = [
  [[4.0863, 1.1290, -0.8525], [4.1489, 1.3354, -0.8525]],
  [[-2.9950, 2.0300, 0.2925], [-3.1950, 1.9300, 0.2925]],
]
const near = (a: number[], b: number[], tol = 1e-3) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < tol

for (const [A, B] of targets) {
  console.log(`\n=== open edge ${A.map((x) => x.toFixed(4))} -> ${B.map((x) => x.toFixed(4))}`)
  for (const f of faces) {
    for (const b of f.bounds) {
      for (const e of b.loop.edges as any[]) {
        const pts = sampleEdge(e, DEFAULT_TESS)
        const hasA = pts.some((q: number[]) => near(q, A)), hasB = pts.some((q: number[]) => near(q, B))
        if (!hasA && !hasB) continue
        const endA = near(pts[0]!, A) || near(pts[pts.length - 1]!, A)
        const endB = near(pts[0]!, B) || near(pts[pts.length - 1]!, B)
        console.log(`  face #${String(f.id).padEnd(6)} ${f.surface.kind.padEnd(8)} edge ${String(e.curve.kind).padEnd(9)} samples ${String(pts.length).padStart(3)}  ${endA && endB ? "SPANS the whole open edge" : "touches one end"}  ${pts[0]!.map((x: number) => x.toFixed(4))} .. ${pts[pts.length - 1]!.map((x: number) => x.toFixed(4))}`)
      }
    }
  }
}
