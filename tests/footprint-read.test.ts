/**
 * Standalone footprint (.kicad_mod) tests.
 *
 * These use real library footprints from refs, so the numbers are checked against what the files actually say
 * rather than against our own output. The 0603 case is the sharpest: its courtyard rect in the file is
 * (-1.48,-0.73) to (1.48,0.73), so the body must come out as 2.96 x 1.46, which is NOT the pad span (2.45) and
 * not the fab body (1.6 x 0.8). Getting that wrong would quietly feed the case generator the wrong size.
 *
 * Two real bugs were caught by running all 22 fixtures rather than the two I had open:
 *   - an extracted pad loop turned "skip this pad" into "abort the whole footprint", so four files came back
 *     empty;
 *   - KiCad 5/6 files start with `(module ...)` rather than `(footprint ...)` and were refused outright.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { readKicadMod } from "../src/kicad-read.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const find = (name: string): string | null => {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name === name ? [path.join(d, e.name)] : [])
  const hits = fs.existsSync(REFS) ? walk(REFS) : []
  return hits[0] ?? null
}
const read = (name: string) => {
  const f = find(name)
  assert.ok(f, `fixture ${name} not found`)
  return readKicadMod(fs.readFileSync(f!, "latin1"))
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol

test("0603: pads, body from the courtyard, and the model path all match the file", () => {
  const r = read("c_0603_1608metric_kicad10.kicad_mod")
  const fp = r.footprint
  assert.ok(fp, "parsed a footprint")
  assert.equal(fp!.pads.length, 2)
  assert.equal(fp!.lib, "C_0603_1608Metric")
  const p0 = fp!.pads.find((p) => p.name === "1")!
  assert.equal(p0.kind, "smd")
  assert.ok(near(p0.at.x, -0.775) && near(p0.at.y, 0), `pad 1 at ${JSON.stringify(p0.at)}`)
  assert.ok(near(p0.size.w, 0.9) && near(p0.size.h, 0.95), `pad 1 size ${JSON.stringify(p0.size)}`)
  // the courtyard rect in the file is (-1.48,-0.73)..(1.48,0.73)
  assert.ok(near(fp!.body.w, 2.96) && near(fp!.body.h, 1.46), `body ${fp!.body.w} x ${fp!.body.h}`)
  assert.ok(fp!.model?.path.includes("C_0603_1608Metric.step"), `model ${fp!.model?.path}`)
  assert.deepEqual(r.skipped, {}, "nothing in this file is unmodelled")
})

test("0603: the body is the courtyard, not the pad span and not the fab body", () => {
  const fp = read("c_0603_1608metric_kicad10.kicad_mod").footprint!
  const span = Math.max(...fp.pads.map((p) => Math.abs(p.at.x) + p.size.w / 2)) * 2
  assert.ok(near(span, 2.45, 1e-6), `pad span ${span}`)
  assert.ok(fp.body.w > span + 0.4, "the courtyard is wider than the pads, and the body must be the courtyard")
  assert.ok(!near(fp.body.w, 1.6, 1e-3), "the fab body is 1.6 wide; the body must not be that either")
})

test("DIP-10: ten through-hole pads, each with a drill", () => {
  const fp = read("DIP-10_W10.16mm.kicad_mod").footprint!
  assert.equal(fp.pads.length, 10)
  assert.equal(fp.pads.filter((p) => p.kind === "thru").length, 10)
  for (const p of fp.pads) assert.ok(p.drill && p.drill > 0, `${p.name} has no drill`)
})

test("QFN-60 with an exposed pad: every pad is SMD and there are more than 60 of them", () => {
  const fp = read("QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm.kicad_mod").footprint!
  assert.ok(fp.pads.length >= 61, `pads ${fp.pads.length}`)
  assert.equal(fp.pads.filter((p) => p.kind === "smd").length, fp.pads.length)
  assert.ok(fp.body.w > 7 && fp.body.h > 7, `body ${fp.body.w} x ${fp.body.h}`)
})

test("a KiCad 5/6 file starting with (module ...) is read, not refused", () => {
  const r = read("PCB_Fork_10mils_5mmx5mm.kicad_mod")
  assert.ok(r.footprint, "legacy module root parsed")
  assert.equal(r.footprint!.pads.length, 2)
})

test("a mounting-hole style file comes back as a hole, not a placeable footprint", () => {
  const r = read("pad_zone_connect_kicad10.kicad_mod")
  assert.equal(r.footprint, null)
  assert.ok(r.hole, "hole returned")
  assert.ok(near(r.hole!.drill, 3.2, 1e-6), `drill ${r.hole!.drill}`)
})

test("what the reader does not model is reported, never silently dropped", () => {
  const r = read("QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm.kicad_mod")
  assert.ok((r.skipped["fp_poly"] ?? 0) > 0, `expected fp_poly in skipped, got ${JSON.stringify(r.skipped)}`)
})

test("text that is not a footprint is refused with a message naming what it found", () => {
  assert.throws(() => readKicadMod("(kicad_pcb (version 1))"), /not a kicad_mod file/)
  // a bare `(module)` IS accepted as a legacy root, which is why it is not asserted here to throw
})

test("every footprint fixture either yields pads or a hole, and none crashes", () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".kicad_mod") ? [path.join(d, e.name)] : [])
  const files = fs.existsSync(REFS) ? walk(REFS) : []
  assert.ok(files.length >= 20, `expected the refs fixtures, found ${files.length}`)
  for (const f of files) {
    const r = readKicadMod(fs.readFileSync(f, "latin1"))
    // the invariant that matters: something usable comes back, and nothing throws
    assert.ok(r.hole !== null || r.footprint !== null, `${path.basename(f)} produced neither a hole nor a footprint`)
  }
})
