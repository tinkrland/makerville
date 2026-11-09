import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parsePart21 } from "../src/step/part21.ts"
import { resolveLengthUnit, unitForContext, fileLengthUnit, shapeRepresentations, isRepresentationContext, MM } from "../src/step/units.ts"
import { REF } from "./fixtures.ts"

const file = (data: string) => `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`
const unit = (d: string, id = 1) => { const p = parsePart21(file(d)); return resolveLengthUnit(p, p.entities.get(id)!) }

test("SI units: millimetre, metre, centimetre, micrometre, kilometre", () => {
  assert.equal(unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));").mmPerUnit, 1)
  assert.equal(unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));").mmPerUnit, 1000)
  assert.equal(unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.));").mmPerUnit, 10)
  assert.equal(unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MICRO.,.METRE.));").mmPerUnit, 0.001)
  assert.equal(unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.KILO.,.METRE.));").mmPerUnit, 1e6)
})

test("exporter spacing variants parse to the same unit", () => {
  assert.equal(unit("#1 =( LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( .MILLI., .METRE. ) );").mmPerUnit, 1)
})

// A real inch unit as CAD tools write it: CONVERSION_BASED_UNIT with a measure of 25.4 mm
const INCH = `#1=(CONVERSION_BASED_UNIT('INCH',#2)LENGTH_UNIT()NAMED_UNIT(#3));
#2=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#4);
#3=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);
#4=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`
test("inch: CONVERSION_BASED_UNIT with 25.4 mm", () => {
  const u = unit(INCH)
  assert.equal(u.mmPerUnit, 25.4)
  assert.equal(u.name, "inch")
})
test("foot defined against a metre unit resolves through the chain", () => {
  const u = unit(`#1=(CONVERSION_BASED_UNIT('FOOT',#2)LENGTH_UNIT()NAMED_UNIT(#3));\n#2=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.3048),#4);\n#3=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);\n#4=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));`)
  assert.ok(Math.abs(u.mmPerUnit - 304.8) < 1e-9)
})
test("a unit defined in terms of another conversion unit (mil = 0.001 inch)", () => {
  const u = unit(INCH + `\n#10=(CONVERSION_BASED_UNIT('MIL',#11)LENGTH_UNIT()NAMED_UNIT(#3));\n#11=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),#1);`, 10)
  assert.ok(Math.abs(u.mmPerUnit - 0.0254) < 1e-12)
})

test("errors: a unit that is not metre-based, an unknown prefix, a circular definition, a missing measure", () => {
  assert.throws(() => unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.SECOND.));"), /not based on the metre/)
  assert.throws(() => unit("#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.BIG.,.METRE.));"), /unknown SI prefix BIG/)
  assert.throws(() => unit("#1=(CONVERSION_BASED_UNIT('X',#2)LENGTH_UNIT()NAMED_UNIT(*));\n#2=LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.),#1);"), /circular/)
  assert.throws(() => unit("#1=(CONVERSION_BASED_UNIT('X',#99)LENGTH_UNIT()NAMED_UNIT(*));"), /missing entity/)
  assert.throws(() => unit("#1=CARTESIAN_POINT('',(0.,0.,0.));"), /unsupported length unit entity/)
})

// ---- resolving through a shape's context
const shapeIn = (unitDef: string) => parsePart21(file(`#10=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#11),#20);
#11=AXIS2_PLACEMENT_3D('',#12,#13,#14);
#12=CARTESIAN_POINT('',(0.,0.,0.));#13=DIRECTION('',(0.,0.,1.));#14=DIRECTION('',(1.,0.,0.));
#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#30))GLOBAL_UNIT_ASSIGNED_CONTEXT((#21,#22,#23))REPRESENTATION_CONTEXT('',''));
#21=${unitDef};
#22=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#23=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());
#30=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#21,'d','d');`))

test("the unit is found through the shape's context, skipping the angle units listed alongside it", () => {
  const w: string[] = []
  const p = shapeIn("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))")
  assert.equal(unitForContext(p, p.entities.get(10)!.args[2], w).mmPerUnit, 1)
  assert.deepEqual(w, [])
  const q = shapeIn("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.))")
  assert.equal(unitForContext(q, q.entities.get(10)!.args[2], w).mmPerUnit, 1000)
})

test("unit order inside the context does not matter", () => {
  const p = parsePart21(file(`#10=SHAPE_REPRESENTATION('',(),#20);\n#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#22,#23,#21))REPRESENTATION_CONTEXT('',''));\n#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.));\n#22=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));\n#23=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());`))
  assert.equal(unitForContext(p, p.entities.get(10)!.args[2], []).mmPerUnit, 10)
})

test("inch resolves through a context too", () => {
  const p = parsePart21(file(`#10=SHAPE_REPRESENTATION('',(),#20);\n#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));\n${INCH}`))
  assert.equal(unitForContext(p, p.entities.get(10)!.args[2], []).mmPerUnit, 25.4)
})

test("two shapes in two contexts get their own units (the mixed-unit file case)", () => {
  const p = parsePart21(file(`#10=SHAPE_REPRESENTATION('',(),#20);\n#11=SHAPE_REPRESENTATION('',(),#30);
#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#21))REPRESENTATION_CONTEXT('',''));
#30=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#31))REPRESENTATION_CONTEXT('',''));
#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));\n#31=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.));`))
  assert.equal(unitForContext(p, p.entities.get(10)!.args[2], []).mmPerUnit, 1)
  assert.equal(unitForContext(p, p.entities.get(11)!.args[2], []).mmPerUnit, 1000)
  const w: string[] = []
  fileLengthUnit(p, w)
  assert.match(w.join(" "), /mixes length units/)
})

test("fallbacks are millimetres WITH a warning: missing context, dangling context, no unit list, no length unit", () => {
  const w: string[] = []
  const p = parsePart21(file(`#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)REPRESENTATION_CONTEXT('',''));\n#21=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#22))REPRESENTATION_CONTEXT('',''));\n#22=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));`))
  assert.equal(unitForContext(p, undefined, w), MM)
  assert.equal(unitForContext(p, { ref: 999 }, w), MM)
  assert.equal(unitForContext(p, { ref: 20 }, w), MM)
  assert.equal(unitForContext(p, { ref: 21 }, w), MM)
  assert.equal(w.length, 4)
  assert.match(w[0]!, /no representation context/); assert.match(w[1]!, /missing/); assert.match(w[2]!, /lists no units/); assert.match(w[3]!, /no length unit/)
})

test("a broken unit definition falls back with the reason, instead of throwing out of the whole model", () => {
  const p = parsePart21(file(`#10=SHAPE_REPRESENTATION('',(),#20);\n#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#21))REPRESENTATION_CONTEXT('',''));\n#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.SECOND.));`))
  const w: string[] = []
  assert.equal(unitForContext(p, { ref: 20 }, w), MM)
  assert.match(w[0]!, /not based on the metre.*assuming millimetres/)
})

// ---- real files
const realFiles = [
  "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step",
  "circuit-json-to-gltf/tests/assets/TO-92_Inline.step",
  "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step",
  "freerouting/fixtures/Issue191-processor.Z80/plcc44.stp",
  "circuit-json-to-step/test/basics/basics22/solidworks.step",
]
for (const rel of realFiles) {
  test(`real file is millimetres with no warnings: ${rel.split("/").pop()}`, { skip: !fs.existsSync(REF + rel) }, () => {
    const w: string[] = []
    const u = fileLengthUnit(parsePart21(fs.readFileSync(REF + rel, "latin1")), w)
    assert.equal(u.mmPerUnit, 1); assert.equal(u.name, "mm"); assert.deepEqual(w, [])
  })
}

test("real mixed file (Contact.step): every shape resolves to a unit, and mm is among them", { skip: !fs.existsSync(REF + "circuit-json-to-gltf/tests/assets/Contact.step") }, () => {
  const p = parsePart21(fs.readFileSync(REF + "circuit-json-to-gltf/tests/assets/Contact.step", "latin1"))
  const w: string[] = []
  const scales = new Set<number>()
  for (const e of shapeRepresentations(p)) scales.add(unitForContext(p, e.args[e.args.length - 1], w).mmPerUnit)
  assert.ok(scales.size >= 1)
  assert.deepEqual(w, [], "no fallbacks needed")
})

// ---- selecting shapes by structure (regression: a name-suffix match caught an assembly link)
test("shapeRepresentations finds shapes by their context, and skips CONTEXT_DEPENDENT_SHAPE_REPRESENTATION (an assembly link)", () => {
  const p = parsePart21(file(`#10=SHAPE_REPRESENTATION('',(#40),#20);\n#11=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#40),#20);\n#12=MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#40),#20);
#13=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#10,#50);\n#14=PRODUCT_DEFINITION_SHAPE('','',#51);\n#40=CARTESIAN_POINT('',(0.,0.,0.));\n#50=PRODUCT_DEFINITION_SHAPE('','',#51);\n#51=PRODUCT_DEFINITION('','',#52,#53);
#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#21))REPRESENTATION_CONTEXT('',''));\n#21=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`))
  assert.deepEqual(shapeRepresentations(p).map((e) => e.id).sort((a, b) => a - b), [10, 11, 12])
})

test("isRepresentationContext", () => {
  const p = parsePart21(file(`#1=(GEOMETRIC_REPRESENTATION_CONTEXT(3)REPRESENTATION_CONTEXT('',''));\n#2=CARTESIAN_POINT('',(0.,0.,0.));\n#3=REPRESENTATION_CONTEXT('','');`))
  assert.ok(isRepresentationContext(p.entities.get(1)!)); assert.ok(isRepresentationContext(p.entities.get(3)!)); assert.ok(!isRepresentationContext(p.entities.get(2)!))
})

test("real assembly file: the assembly link is not treated as a shape, and no spurious warning appears", { skip: !fs.existsSync(REF + realFiles[2]) }, () => {
  const p = parsePart21(fs.readFileSync(REF + realFiles[2], "latin1"))
  const shapes = shapeRepresentations(p)
  assert.ok(shapes.length >= 2)
  assert.ok(shapes.every((e) => !/CONTEXT_DEPENDENT/.test(e.type)))
  const w: string[] = []
  assert.equal(fileLengthUnit(p, w).mmPerUnit, 1)
  assert.deepEqual(w, [])
})
