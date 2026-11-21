/**
 * Step 12: 3D models survive the KiCad round trip.
 *
 * Two things are being checked, and the second is the one that matters:
 *
 * 1. write -> read gives back the path, offset, scale and rotate exactly. A footprint whose model is rotated
 *    90 degrees renders wrong if any of those is dropped.
 * 2. KiCad itself accepts what we write. The test writes a board referencing a real STEP fixture and asks
 *    `kicad-cli` to export its 3D view; if our `(model ...)` block were malformed or the file unresolvable,
 *    KiCad would emit a board slab and nothing else. So the assertion is that the model's geometry actually
 *    appears in KiCad's own output, with the volume we independently measured for that model.
 *
 * Skipped when kicad-cli is not installed.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { newBoard } from "../src/model.ts"
import { header } from "../src/library.ts"
import { writeKicadPcb } from "../src/kicad-write.ts"
import { readKicadPcb } from "../src/kicad-read.ts"
import { parseStl, components } from "../tools/oracle.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const CONTACT = path.join(REFS, "circuit-json-to-gltf/tests/assets/Contact.step")
const hasKicad = (() => {
  try { execFileSync("kicad-cli", ["version"], { stdio: "pipe" }); return true } catch { return false }
})()

function boardWithModel(modelPath: string, transform: { offset?: [number, number, number]; scale?: [number, number, number]; rotate?: [number, number, number] } = {}) {
  const b = newBoard("models", 20, 20)
  const J1 = header("J1", 2, 1, { at: { x: 0, y: 0 } })
  J1.model = { path: modelPath, ...transform }
  b.footprints.push(J1)
  return b
}

test("write -> read keeps the model path, offset, scale and rotate", () => {
  const b = boardWithModel("models/part.step", { offset: [1.5, -2, 0.25], scale: [1, 1, 2], rotate: [0, 0, 90] })
  const text = writeKicadPcb(b)
  assert.match(text, /\(model "models\/part\.step"/, "the model block is written")
  const { board: r, warnings } = readKicadPcb(text)
  assert.deepEqual(warnings, [])
  const m = r.footprints[0]!.model!
  assert.ok(m, "the model came back")
  assert.equal(m.path, "models/part.step")
  assert.deepEqual(m.offset, [1.5, -2, 0.25])
  assert.deepEqual(m.scale, [1, 1, 2])
  assert.deepEqual(m.rotate, [0, 0, 90])
})

test("a footprint with no model writes no model block, and reading gives none", () => {
  const b = boardWithModel("x", {})
  delete b.footprints[0]!.model
  const text = writeKicadPcb(b)
  assert.ok(!text.includes("(model "), "no stray model block")
  assert.equal(readKicadPcb(text).board.footprints[0]!.model, undefined)
})

test("an identity model still writes all three blocks, because KiCad's parser expects them", () => {
  const text = writeKicadPcb(boardWithModel("models/part.step"))
  assert.match(text, /\(offset\s*\(xyz 0 0 0\)\s*\)/)
  assert.match(text, /\(scale\s*\(xyz 1 1 1\)\s*\)/)
  assert.match(text, /\(rotate\s*\(xyz 0 0 0\)\s*\)/)
})

test("KiCad renders the model we wrote: its geometry appears in kicad-cli's own export", { skip: !hasKicad || !fs.existsSync(CONTACT) }, () => {
  const b = boardWithModel(CONTACT)
  const text = writeKicadPcb(b)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-write-"))
  try {
    const board = path.join(dir, "b.kicad_pcb")
    const stl = path.join(dir, "b.stl")
    fs.writeFileSync(board, text)
    execFileSync("kicad-cli", ["pcb", "export", "stl", "-o", stl, board], { stdio: "pipe" })
    const comps = components(parseStl(fs.readFileSync(stl)))
    assert.ok(comps.length >= 2, `expected a board and a model, got ${comps.length} component(s)`)
    // the model is the biggest non-board component; the board slab is 20x20x1.6 but the contact is 4 mm^3
    // of solid copper, so compare the largest component's volume against the independently measured 4.005
    const vols = comps.map((c) => c.volume).sort((x, y) => y - x)
    const contact = vols.find((v) => Math.abs(v - 4.005) / 4.005 < 0.05)
    assert.ok(contact !== undefined, `no component matched the contact's 4.005 mm^3; volumes were ${vols.map((v) => v.toFixed(2)).join(", ")}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
