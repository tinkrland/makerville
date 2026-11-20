import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"

const p = parsePart21(fs.readFileSync("/app/conversations/6af0495dcaf878e1398c29c6/refs/freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step", "latin1"))
const w: string[] = []
const solids = new Brep(p, new Geometry(p, w), w).read()
const faces = solids.flatMap((s) => s.shells.flatMap((sh) => sh.faces))

const near = (a: number[], b: number[], tol = 1e-3) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < tol
const A = [4.0863, 1.1290, -0.8525], B = [4.1489, 1.3354, -0.8525]

for (const fid of [12298, 14655]) {
  const f = faces.find((x) => x.id === fid)!
  for (const b of f.bounds) {
    for (const e of b.loop.edges as any[]) {
      if (e.curve.kind !== "circle") continue
      const s = e.curve
      const c = s.centre ?? s.center
      console.log(`face #${fid}: circle edge entity ${e.edgeId ?? "?"} radius ${s.radius?.toFixed(9)} centre ${c?.map?.((x: number) => x.toFixed(6))}  spans ${s.at?.(s.range?.[0])?.map?.((x: number) => x.toFixed(4))} .. ${s.at?.(s.range?.[1])?.map?.((x: number) => x.toFixed(4))}`)
    }
  }
}
console.log("\nEdge entity ids referenced by each face (looking for a shared one):")
for (const fid of [12298, 14655]) {
  const f = faces.find((x) => x.id === fid)!
  const ids = f.bounds.flatMap((b) => (b.loop.edges as any[]).map((e) => e.edgeId ?? e.curve.id ?? "?"))
  console.log(`  face #${fid}: ${ids.join(" ")}`)
}
void near
void A
void B
