import fs from "node:fs"
import { parsePart21 } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/part21.ts"
import { itemColours } from "/app/conversations/6af0495dcaf878e1398c29c6/boardforge/src/step/colour.ts"

const R = "/app/conversations/6af0495dcaf878e1398c29c6/refs/"
for (const f of [
  "circuit-json-to-gltf/tests/assets/ExampleModelPin.step",
  "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step",
  "circuit-json-to-gltf/tests/assets/Contact.step",
]) {
  const p = parsePart21(fs.readFileSync(R + f, "latin1"))
  const w: string[] = []
  const m = itemColours(p, w)
  const solids = [...p.entities.values()].filter((e) => e.type === "MANIFOLD_SOLID_BREP")
  const coloured = solids.filter((s) => m.has(s.id)).length
  const uniq = new Set([...m.values()].map((c) => `${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)}`))
  console.log(`\n${f.split("/").pop()}: ${m.size} styled items, ${coloured}/${solids.length} solids coloured, ${uniq.size} distinct colours, ${w.length} warnings`)
  for (const wm of w.slice(0, 3)) console.log("   warn:", wm)
  let shown = 0
  for (const [id, c] of m) {
    if (shown++ >= 4) break
    const e = p.entities.get(id)!
    console.log(`   #${id} ${e.type}: rgb(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`)
  }
  console.log(`   colours: ${[...uniq].slice(0, 5).join("  ")}`)
}
