/**
 * Colour tests.
 *
 * The real files carry named colours ("Copper - Polished", "Brass - Polished"), so the extracted RGB can be
 * checked against the name the exporter wrote rather than against itself. The synthetic cases cover the two
 * things a real file cannot show on demand: a style chain that dead-ends must produce a warning naming the
 * item, and a face-level style must be usable separately from its solid.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { parsePart21 } from "../src/step/part21.ts"
import { itemColours } from "../src/step/colour.ts"

const REFS = path.resolve(import.meta.dirname, "../../refs")
const has = (rel: string) => fs.existsSync(path.join(REFS, rel))
const load = (rel: string) => parsePart21(fs.readFileSync(path.join(REFS, rel), "latin1"))
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol

const wrap = (data: string) => `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`

test("ExampleModelPin: the two solids get the copper and brass the file names", { skip: !has("circuit-json-to-gltf/tests/assets/ExampleModelPin.step") }, () => {
  const p = load("circuit-json-to-gltf/tests/assets/ExampleModelPin.step")
  const warnings: string[] = []
  const m = itemColours(p, warnings)
  assert.deepEqual(warnings, [], "no colour warnings")
  assert.equal(m.size, 2, "both solids are styled")
  // #22 is "Body2" (copper), #23 is "Body1" (brass) per the file's FILL_AREA_STYLE names
  const copper = m.get(22)!
  const brass = m.get(23)!
  assert.ok(near(copper.r, 0.929411764705882) && near(copper.g, 0.807843137254902) && near(copper.b, 0.764705882352941), `copper was ${JSON.stringify(copper)}`)
  assert.ok(near(brass.r, 0.952941176470588) && near(brass.g, 0.796078431372549) && near(brass.b, 0.486274509803922), `brass was ${JSON.stringify(brass)}`)
  // less yellow means MORE blue, not less: copper sits at b=0.765, brass at b=0.486
  assert.ok(copper.b > brass.b, "copper must be less yellow than brass, which is a check the names imply")
})

test("TYPE-C: every one of the 42 solids is coloured, in three distinct colours", { skip: !has("freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step") }, () => {
  const p = load("freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step")
  const warnings: string[] = []
  const m = itemColours(p, warnings)
  assert.deepEqual(warnings, [], "no colour warnings")
  const solids = [...p.entities.values()].filter((e) => e.type === "MANIFOLD_SOLID_BREP")
  assert.equal(solids.length, 42)
  assert.equal(solids.filter((s) => m.has(s.id)).length, 42, "a connector with grey contacts means the chain was lost")
  const distinct = new Set([...m.values()].map((c) => `${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}`))
  assert.equal(distinct.size, 3, `expected gold, shell and plastic; got ${[...distinct].join(" ")}`)
})

test("Contact: a single solid gets the polished copper the file names", { skip: !has("circuit-json-to-gltf/tests/assets/Contact.step") }, () => {
  const p = load("circuit-json-to-gltf/tests/assets/Contact.step")
  const warnings: string[] = []
  const m = itemColours(p, warnings)
  assert.deepEqual(warnings, [])
  assert.equal(m.size, 1)
  const c = [...m.values()][0]!
  assert.ok(near(c.r, 0.929411764705882) && near(c.b, 0.764705882352941), `was ${JSON.stringify(c)}`)
})

test("a style chain that reaches no COLOUR_RGB is reported by name, not silently skipped", () => {
  const p = parsePart21(wrap([
    "#1=STYLED_ITEM('',(#2),#9);",
    "#2=PRESENTATION_STYLE_ASSIGNMENT((#3));",
    "#3=SURFACE_STYLE_USAGE(.BOTH.,#4);",
    "#4=SURFACE_SIDE_STYLE('',(#5));",
    "#5=SURFACE_STYLE_FILL_AREA(#6);",
    "#6=FILL_AREA_STYLE('no colour here',());",
    "#9=MANIFOLD_SOLID_BREP('body',#10);",
    "#10=CLOSED_SHELL('',());",
  ].join("\n")))
  const warnings: string[] = []
  const m = itemColours(p, warnings)
  assert.equal(m.size, 0, "nothing to colour")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /STYLED_ITEM #1/)
  assert.match(warnings[0]!, /#9/, "the warning must name the item that will fall back to the default colour")
})

test("a complete chain yields the exact colour, and components are clamped to 0..1", () => {
  const p = parsePart21(wrap([
    "#1=STYLED_ITEM('',(#2),#9);",
    "#2=PRESENTATION_STYLE_ASSIGNMENT((#3));",
    "#3=SURFACE_STYLE_USAGE(.BOTH.,#4);",
    "#4=SURFACE_SIDE_STYLE('',(#5));",
    "#5=SURFACE_STYLE_FILL_AREA(#6);",
    "#6=FILL_AREA_STYLE('',(#7));",
    "#7=FILL_AREA_STYLE_COLOUR('',#8);",
    "#8=COLOUR_RGB('',1.0000001,-0.2,0.25);",
    "#9=MANIFOLD_SOLID_BREP('body',#10);",
    "#10=CLOSED_SHELL('',());",
  ].join("\n")))
  const warnings: string[] = []
  const m = itemColours(p, warnings)
  assert.deepEqual(warnings, [])
  const c = m.get(9)!
  assert.equal(c.r, 1, "1.0000001 clamps to 1")
  assert.equal(c.g, 0, "-0.2 clamps to 0")
  assert.equal(c.b, 0.25)
})
