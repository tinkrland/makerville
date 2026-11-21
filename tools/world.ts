import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { Geometry } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/geometry.ts"
import { Brep } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/brep.ts"
import { assemblyInstances } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/assembly.ts"
import { apply } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/vec.ts"

const p = parsePart21(fs.readFileSync("/app/conversations/6af0495dcaf878e1398c29c6/refs/circuit-json-to-gltf/tests/assets/ExampleModelPin.step", "latin1"))
const w: string[] = []
const g = new Geometry(p, w)
const solids = new Brep(p, g, w).read()
const inst = assemblyInstances(p, g, w)

const bounds = (pts: number[][]) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const q of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, q[k]!); hi[k] = Math.max(hi[k]!, q[k]!) }
  return { lo, hi }
}
// sample every vertex-ish point of the B-rep through the face loops
const pts: number[][] = []
for (const s of solids) for (const sh of s.shells) for (const f of sh.faces) for (const b of f.bounds) for (const e of b.loop.edges as any[]) {
  for (const q of [e.from, e.to]) if (Array.isArray(q)) pts.push(q as number[])
}
const asIs = bounds(pts)
const moved = bounds(pts.map((q) => apply(inst[0]!.matrix, q as [number, number, number])))
console.log(`solids ${solids.length}, instances ${inst.length}`)
console.log(`as-is bounds   x ${asIs.lo[0]!.toFixed(4)}..${asIs.hi[0]!.toFixed(4)}  z ${asIs.lo[2]!.toFixed(4)}..${asIs.hi[2]!.toFixed(4)}`)
console.log(`moved bounds   x ${moved.lo[0]!.toFixed(4)}..${moved.hi[0]!.toFixed(4)}  z ${moved.lo[2]!.toFixed(4)}..${moved.hi[2]!.toFixed(4)}`)
console.log(`the tests assert z -3.9525..3.9525 (the file's declared extents): as-is ${asIs.lo[2]!.toFixed(4)}..${asIs.hi[2]!.toFixed(4)}, moved ${moved.lo[2]!.toFixed(4)}..${moved.hi[2]!.toFixed(4)}`)
