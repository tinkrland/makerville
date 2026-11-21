/**
 * Probe KiCad's own model transform, so place.ts matches it instead of guessing.
 *
 * Two boards are identical except for the footprint side (top vs bottom). The model carries a deliberately
 * asymmetric offset, so wherever the model lands in KiCad's export tells us which axis the back side mirrors
 * and which way. A third board rotates the footprint 90 degrees, to pin the rotation direction.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { parseStl, components } from "../tools/oracle.ts"

const CONTACT = path.resolve(import.meta.dirname, "../../refs/circuit-json-to-gltf/tests/assets/Contact.step")

const board = (side: "top" | "bottom", rot: number, offset: [number, number, number]) => `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (footprint "probe:m"
    (layer "${side === "top" ? "F.Cu" : "B.Cu"}")
    (uuid "11111111-2222-3333-4444-555555555555")
    (at 200 200 ${rot})
    (property "Reference" "U1" (at 0 -5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "m" (at 0 5 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (model "${CONTACT}" (offset (xyz ${offset[0]} ${offset[1]} ${offset[2]})) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
  )
  (gr_rect (start 100 100) (end 101 101) (stroke (width 0.05) (type solid)) (fill none)
    (layer "Edge.Cuts") (uuid "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
)
`

function modelBounds(side: "top" | "bottom", rot: number, offset: [number, number, number]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"))
  try {
    const b = path.join(dir, "b.kicad_pcb")
    const stl = path.join(dir, "b.stl")
    fs.writeFileSync(b, board(side, rot, offset))
    execFileSync("kicad-cli", ["pcb", "export", "stl", "-o", stl, b], { stdio: "pipe" })
    const comps = components(parseStl(fs.readFileSync(stl)))
    // the board slab is the tiny 1x1 outline at (100,100); the model is everything else
    // the board slab is the 1x1 outline at (100,100); pick the component with the most triangles instead of
    // guessing by position, so the numbers are the model alone
    const model = comps.slice().sort((a, b) => b.tris.length - a.tris.length)[0]!
    const min = model.min, max = model.max
    return { centre: [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2], min, max, parts: comps.length }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const fmt = (v: number[]) => v.map((x) => x.toFixed(3)).join(", ")
const cases: [string, "top" | "bottom", number, [number, number, number]][] = [
  ["top, no offset", "top", 0, [0, 0, 0]],
  ["top, offset x+5", "top", 0, [5, 0, 0]],
  ["top, offset y+5", "top", 0, [0, 5, 0]],
  ["top, offset z+5", "top", 0, [0, 0, 5]],
  ["bottom, no offset", "bottom", 0, [0, 0, 0]],
  ["bottom, offset x+5", "bottom", 0, [5, 0, 0]],
  ["bottom, offset y+5", "bottom", 0, [0, 5, 0]],
  ["bottom, offset z+5", "bottom", 0, [0, 0, 5]],
  ["top, rot 90, offset x+5", "top", 90, [5, 0, 0]],
  ["top, rot 90, offset y+5", "top", 90, [0, 5, 0]],
  ["bottom, rot 90, offset x+5", "bottom", 90, [5, 0, 0]],
  ["bottom, rot 90, offset y+5", "bottom", 90, [0, 5, 0]],
  ["bottom, rot 90, offset z+5", "bottom", 90, [0, 0, 5]],
  ["top, rot 45, offset x+5", "top", 45, [5, 0, 0]],
]
for (const [label, side, rot, off] of cases) {
  const r = modelBounds(side, rot, off)
  console.log(`${label.padEnd(24)} centre [${fmt(r.centre)}]  min [${fmt(r.min)}]  max [${fmt(r.max)}]  parts ${r.parts}`)
}
