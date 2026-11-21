import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { assemblyInstances } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/assembly.ts"
import { apply, IDENTITY } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/vec.ts"

const R = "/app/conversations/6af0495dcaf878e1398c29c6/refs/"
for (const f of ["circuit-json-to-gltf/tests/assets/ExampleModelPin.step", "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"]) {
  const p = parsePart21(fs.readFileSync(R + f, "latin1"))
  const w: string[] = []
  const g = new Geometry(p, w)
  const inst = assemblyInstances(p, g, w)
  console.log(`\n${f.split("/").pop()}: ${inst.length} instance(s), ${w.length} warning(s)`)
  for (const wm of w) console.log("   warn:", wm)
  for (const i of inst) {
    const m = i.matrix
    // rigidity: the 3x3 block must be orthonormal with determinant +1
    const cols = [[m[0]!, m[4]!, m[8]!], [m[1]!, m[5]!, m[9]!], [m[2]!, m[6]!, m[10]!]]
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
    const det = dot(cols[0]!, [cols[1]![1]! * cols[2]![2]! - cols[1]![2]! * cols[2]![1]!, cols[1]![2]! * cols[2]![0]! - cols[1]![0]! * cols[2]![2]!, cols[1]![0]! * cols[2]![1]! - cols[1]![1]! * cols[2]![0]!])
    console.log(`  ${i.name}: child #${i.child} -> parent #${i.parent}`)
    console.log(`     det ${det.toFixed(9)}  |c| ${cols.map((c) => dot(c, c).toFixed(9)).join(",")}  off-diag ${[dot(cols[0]!, cols[1]!), dot(cols[1]!, cols[2]!), dot(cols[2]!, cols[0]!)].map((x) => x.toFixed(9)).join(",")}`)
    console.log(`     origin moves to ${apply(m, [0, 0, 0]).map((x) => x.toFixed(4)).join(",")}  identity? ${JSON.stringify(m) === JSON.stringify(IDENTITY)}`)
  }
}
