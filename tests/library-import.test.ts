/**
 * Library import tests.
 *
 * The behaviour that matters is not "does it parse the happy file" but what happens to a real library: one
 * malformed file must not sink the other thousand, duplicate names must be visible rather than silently
 * overwriting, and mounting holes must not turn into placeable footprints.
 *
 * Checked against the 22 real fixtures in refs: 18 footprints, 4 mounting holes, 0 problems.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { readFootprintLibrary, readFootprintLibraryDir } from "../src/library-import.ts"
import { readKicadMod } from "../src/kicad-read.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const has = fs.existsSync(REFS)

test("the refs tree imports whole: 18 footprints, 4 holes, nothing unreadable", { skip: !has }, () => {
  const r = readFootprintLibraryDir(REFS)
  assert.equal(r.footprints.length, 18)
  assert.equal(r.holes.length, 4)
  assert.deepEqual(r.problems, [], `unexpected problems: ${JSON.stringify(r.problems.slice(0, 3))}`)
  assert.deepEqual(r.duplicates, [], "no two fixtures share a footprint name")
  // 18 + 4 covers every .kicad_mod in the tree, so nothing was dropped without a problem being recorded
  const count = (d: string): number =>
    fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) =>
      e.isDirectory() ? n + count(path.join(d, e.name)) : n + (e.name.endsWith(".kicad_mod") ? 1 : 0), 0)
  assert.equal(r.footprints.length + r.holes.length, count(REFS))
})

test("one bad file is reported and the rest still import", () => {
  const good = fs.readFileSync(path.join(REFS, "Konnect/crates/konnect-core/tests/fixtures/c_0603_1608metric_kicad10.kicad_mod"), "latin1")
  const r = readFootprintLibrary([
    { name: "a.kicad_mod", text: good },
    { name: "broken.kicad_mod", text: "(footprint \"x\" (pad" },
    { name: "wrong.kicad_mod", text: "(kicad_pcb (version 1))" },
    { name: "b.kicad_mod", text: good },
  ])
  assert.equal(r.footprints.length, 2, "both good files imported")
  assert.equal(r.problems.length, 2, "both bad files reported")
  assert.deepEqual(r.problems.map((p) => p.name).sort(), ["broken.kicad_mod", "wrong.kicad_mod"])
})

test("duplicate footprint names are reported, and both are kept", () => {
  const good = fs.readFileSync(path.join(REFS, "Konnect/crates/konnect-core/tests/fixtures/c_0603_1608metric_kicad10.kicad_mod"), "latin1")
  const r = readFootprintLibrary([
    { name: "one.kicad_mod", text: good },
    { name: "two.kicad_mod", text: good },
    { name: "three.kicad_mod", text: good },
  ])
  assert.equal(r.footprints.length, 3)
  assert.deepEqual(r.duplicates, ["C_0603_1608Metric"], "named once even though it appears three times")
})

test("import order is reproducible: sorted, so ids are stable across machines", { skip: !has }, () => {
  const a = readFootprintLibraryDir(REFS).footprints.map((f) => f.lib)
  const b = readFootprintLibraryDir(REFS).footprints.map((f) => f.lib)
  assert.deepEqual(a, b, "two imports agree")
  // the order is the one you get by walking the tree in sorted PATH order, not by sorting footprint names:
  // sorting names would reorder parts that live in different directories
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const q = path.join(d, e.name)
      if (e.isDirectory()) walk(q)
      else if (e.name.endsWith(".kicad_mod")) files.push(q)
    }
  }
  walk(REFS)
  const expected = files
    .map((f) => readKicadMod(fs.readFileSync(f, "latin1")))
    .filter((r) => r.footprint)
    .map((r) => r.footprint!.lib)
  assert.deepEqual(a, expected, "order follows sorted paths")
})

test("the pure reader and the directory reader agree on the same files", { skip: !has }, () => {
  const dir = path.join(REFS, "Konnect/crates/konnect-core/tests/fixtures")
  const fromDir = readFootprintLibraryDir(dir)
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".kicad_mod")).map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), "latin1") }))
  const fromPure = readFootprintLibrary(entries)
  assert.equal(fromDir.footprints.length, fromPure.footprints.length)
  assert.deepEqual(fromDir.footprints.map((f) => f.lib).sort(), fromPure.footprints.map((f) => f.lib).sort())
})

test("an empty library is empty, not an error", () => {
  const r = readFootprintLibrary([])
  assert.deepEqual(r.footprints, [])
  assert.deepEqual(r.holes, [])
  assert.deepEqual(r.problems, [])
})

test("imported footprints still carry what the single-file reader gives", { skip: !has }, () => {
  const dir = path.join(REFS, "Konnect/crates/konnect-core/tests/fixtures")
  const r = readFootprintLibraryDir(dir)
  const fp = r.footprints.find((f) => f.lib === "C_0603_1608Metric")!
  const single = readKicadMod(fs.readFileSync(path.join(dir, "c_0603_1608metric_kicad10.kicad_mod"), "latin1")).footprint!
  assert.equal(fp.pads.length, single.pads.length)
  assert.equal(fp.body.w, single.body.w)
  assert.equal(fp.model?.path, single.model?.path)
})
