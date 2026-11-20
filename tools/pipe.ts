import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { tessellate, weld, stitchTJunctions, meshStats, type Mesh } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/tessellate.ts"

const files = {
  typec: "/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step",
  contact: "/app/conversations/6af0495dcaf878e1398c29c6/refs/circuit-json-to-gltf/tests/assets/Contact.step",
  plcc: "/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue191-processor.Z80/plcc44.stp",
}
const which = process.argv[2] as keyof typeof files
const p = parsePart21(fs.readFileSync(files[which], "latin1"))
const w: string[] = []
const raw = tessellate(new Brep(p, new Geometry(p, w), w).read())

const pipelines: { name: string; run: (m: Mesh) => Mesh }[] = [
  { name: "weld 1e-6, stitch 1e-4 (current)", run: (m) => stitchTJunctions(weld(m, 1e-6), 1e-4).mesh },
  { name: "weld 1e-6, stitch, weld 5e-3, stitch", run: (m) => stitchTJunctions(weld(stitchTJunctions(weld(m, 1e-6), 1e-4).mesh, 5e-3), 1e-4).mesh },
  { name: "weld 1e-6, stitch, weld 2e-2, stitch", run: (m) => stitchTJunctions(weld(stitchTJunctions(weld(m, 1e-6), 1e-4).mesh, 2e-2), 1e-4).mesh },
  { name: "weld 1e-6, stitch, weld 5e-2, stitch", run: (m) => stitchTJunctions(weld(stitchTJunctions(weld(m, 1e-6), 1e-4).mesh, 5e-2), 1e-4).mesh },
  { name: "weld 5e-3 from raw, stitch", run: (m) => stitchTJunctions(weld(m, 5e-3), 1e-4).mesh },
  { name: "weld 2e-2 from raw, stitch", run: (m) => stitchTJunctions(weld(m, 2e-2), 1e-4).mesh },
]
for (const pl of pipelines) {
  const s = meshStats(pl.run(raw))
  console.log(`${pl.name.padEnd(44)} open ${String(s.boundaryEdges).padStart(4)}  nonmanifold ${String(s.nonManifoldEdges).padStart(3)}  tris ${String(s.triangles).padStart(5)}  vol ${s.volume.toFixed(4)}`)
}
