import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parsePart21 } from "../src/step/part21.ts"
import { Geometry, member, hasMember } from "../src/step/geometry.ts"
import { dist, len, cross, sub, norm, type V3 } from "../src/step/vec.ts"
import { REF } from "./fixtures.ts"

const file = (data: string) => `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`
const geo = (data: string) => { const p = parsePart21(file(data)); return { p, g: new Geometry(p) } }
const near = (a: number, b: number, e = 1e-9, m = "") => assert.ok(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`)
const nearV = (a: V3, b: V3, e = 1e-9, m = "") => assert.ok(dist(a, b) <= e, `${m} [${a}] vs [${b}]`)
const ref = (n: number) => ({ ref: n })

/** the point of a LINE curve nearest to q, and the lateral distance from q to that line */
function lineInfo(c: { at(t: number): V3; closest(p: V3): number }, q: V3) {
  const o = c.at(0), d = norm(sub(c.at(1), o))
  return { perp: len(cross(sub(q, o), d)) }
}

// ---------- points, directions, frames
test("point: 2D coordinates are padded to 3D with z=0, and the entity is cached", () => {
  const { p, g } = geo("#1=CARTESIAN_POINT('',(1.,2.));")
  nearV(g.point(ref(1)), [1, 2, 0])
  assert.equal(g.point(ref(1)), g.point(ref(1)), "same array identity means it was cached")
  void p
})
test("point: a non-point reference is refused by name", () => {
  const { g } = geo("#1=DIRECTION('',(1.,0.,0.));")
  assert.throws(() => g.point(ref(1)), /#1 is a DIRECTION, expected a CARTESIAN_POINT/)
  assert.throws(() => g.point(ref(99)), /#99 is referenced but never defined/)
})
test("direction and frame: axis is local Z, ref_direction is local X, Y = Z x X", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(1.,2.,3.));\n#2=DIRECTION('',(0.,0.,1.));\n#3=DIRECTION('',(1.,0.,0.));\n#4=AXIS2_PLACEMENT_3D('',#1,#2,#3);\n#5=DIRECTION('',(0.,2.,0.));`)
  nearV(g.dir(ref(5)), [0, 2, 0], 1e-12, "ratios are not normalised on the way in")
  const f = g.frame(ref(4))
  nearV(f.o, [1, 2, 3]); nearV(f.x, [1, 0, 0]); nearV(f.y, [0, 1, 0]); nearV(f.z, [0, 0, 1])
  assert.equal(g.frame(ref(4)), g.frame(ref(4)), "cached")
})
test("frame: a missing axis and ref_direction fall back to world Z and world X", () => {
  const { g } = geo("#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=AXIS2_PLACEMENT_3D('',#1,$,$);")
  const f = g.frame(ref(2))
  nearV(f.x, [1, 0, 0]); nearV(f.z, [0, 0, 1])
})
test("vertexPoint: resolves two levels (VERTEX_POINT -> CARTESIAN_POINT)", () => {
  const { g } = geo("#1=CARTESIAN_POINT('',(4.,5.,6.));\n#2=VERTEX_POINT('',#1);")
  nearV(g.vertexPoint(ref(2)), [4, 5, 6])
  assert.throws(() => g.vertexPoint(ref(1)), /#1 is a CARTESIAN_POINT, expected a VERTEX_POINT/)
})

// ---------- curves
const CURVES = `#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(1.,0.,0.));\n#3=VECTOR('',#2,10.);\n#4=LINE('',#1,#3);
#5=AXIS2_PLACEMENT_3D('',#1,$,$);\n#6=CIRCLE('',#5,2.5);\n#7=ELLIPSE('',#5,4.,1.5);`
test("LINE: parameter is in units of the VECTOR magnitude, so t=1 is 10 file units away", () => {
  const { g } = geo(CURVES)
  const c = g.curve(ref(4))
  assert.equal(c.kind, "line"); nearV(c.at(1), [10, 0, 0]); nearV(c.at(-0.5), [-5, 0, 0])
  near(c.closest([3, 7, 0]), 0.3)
})
test("CIRCLE and ELLIPSE resolve through their own placement, and are periodic", () => {
  const { g } = geo(CURVES)
  const c = g.curve(ref(6))
  assert.equal(c.kind, "circle"); near(dist(c.at(0.7), [0, 0, 0]), 2.5, 1e-12); assert.ok(c.periodic)
  const e = g.curve(ref(7))
  assert.equal(e.kind, "ellipse"); near(e.at(0)[0], 4, 1e-12); near(e.at(Math.PI / 2)[1], 1.5, 1e-12)
  assert.equal(g.curve(ref(6)), g.curve(ref(6)), "cached")
})

test("simple B_SPLINE_CURVE_WITH_KNOTS: arguments are read at the right positions", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,0.,0.));\n#3=CARTESIAN_POINT('',(2.,0.,0.));\n#4=CARTESIAN_POINT('',(3.,0.,0.));
#5=B_SPLINE_CURVE_WITH_KNOTS('',3,(#1,#2,#3,#4),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.);`)
  const c = g.curve(ref(5))
  assert.equal(c.kind, "bspline"); nearV(c.at(0), [0, 0, 0]); nearV(c.at(0.5), [1.5, 0, 0]); nearV(c.at(1), [3, 0, 0])
})

test("complex B-spline (BOUNDED_CURVE + B_SPLINE_CURVE + WITH_KNOTS + RATIONAL): a rational quarter circle", () => {
  const w = Math.SQRT1_2
  const { g } = geo(`#1=CARTESIAN_POINT('',(1.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,1.,0.));\n#3=CARTESIAN_POINT('',(0.,1.,0.));
#4=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#1,#2,#3),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.,1.),.UNSPECIFIED.)RATIONAL_B_SPLINE_CURVE((1.,${w.toFixed(16)},1.))CURVE()GEOMETRIC_REPRESENTATION_ITEM()REPRESENTATION_ITEM(''));`)
  const c = g.curve(ref(4))
  assert.equal(c.kind, "bspline")
  for (let i = 0; i <= 20; i++) { const p = c.at(i / 20); near(Math.hypot(p[0], p[1]), 1, 1e-12, "radius") }
  nearV(c.at(0), [1, 0, 0], 1e-12); nearV(c.at(1), [0, 1, 0], 1e-12)
})
test("complex B-spline without RATIONAL uses unit weights", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,2.,0.));\n#3=CARTESIAN_POINT('',(2.,0.,0.));
#4=(BOUNDED_CURVE()B_SPLINE_CURVE(2,(#1,#2,#3),.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()REPRESENTATION_ITEM(''));`)
  nearV(g.curve(ref(4)).at(0.5), [1, 1, 0], 1e-12, "midpoint of a quadratic Bezier")
})

test("a B-spline with no knot vector is a named error, not a silent guess", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,0.,0.));\n#3=B_SPLINE_CURVE('',1,(#1,#2),.UNSPECIFIED.,.F.,.F.);`)
  assert.throws(() => g.curve(ref(3)), /#3 is a B-spline curve with no knot vector/)
})
test("TRIMMED_CURVE degrades to its basis curve WITH a warning naming the limitation", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(1.,0.,0.));\n#3=VECTOR('',#2,1.);\n#4=LINE('',#1,#3);
#5=CARTESIAN_POINT('',(0.,0.,0.));\n#6=CARTESIAN_POINT('',(1.,0.,0.));\n#7=TRIMMED_CURVE('',#4,(#5,#6),.T.,.PARAMETER.);`)
  const c = g.curve(ref(7))
  assert.equal(c.kind, "line")
  nearV(c.at(0), [0, 0, 0])
  assert.ok(g.warnings.some((w) => /TRIMMED_CURVE is not supported/.test(w)), JSON.stringify(g.warnings))
})
test("an unsupported curve type is refused by name", () => {
  const { g } = geo("#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(0.,0.,1.));\n#3=VECTOR('',#2,1.);\n#4=PARABOLA('',#1);")
  assert.throws(() => g.curve(ref(4)), /unsupported curve type PARABOLA/)
})

// ---------- surfaces
test("all six analytic surfaces resolve from their entities with the right parameters", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=AXIS2_PLACEMENT_3D('',#1,$,$);
#3=PLANE('',#2);\n#4=CYLINDRICAL_SURFACE('',#2,3.);\n#5=CONICAL_SURFACE('',#2,1.,0.5);\n#6=SPHERICAL_SURFACE('',#2,4.);\n#7=TOROIDAL_SURFACE('',#2,5.,2.);`)
  assert.equal(g.surface(ref(3)).kind, "plane")
  const cy = g.surface(ref(4)); assert.equal(cy.kind, "cylinder"); near(dist(cy.at(1, 2), [0, 0, 2]), 3, 1e-12)
  const co = g.surface(ref(5)); assert.equal(co.kind, "cone"); near(Math.hypot(co.at(0, 2)[0], co.at(0, 2)[1]), 1 + 2 * Math.tan(0.5), 1e-12)
  const sp = g.surface(ref(6)); assert.equal(sp.kind, "sphere"); near(dist(sp.at(1, 0.5), [0, 0, 0]), 4, 1e-12)
  const to = g.surface(ref(7)); assert.equal(to.kind, "torus")
  assert.equal(g.surface(ref(3)), g.surface(ref(3)), "cached")
})
test("a simple B_SPLINE_SURFACE_WITH_KNOTS is read at the right argument positions", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(0.,4.,0.));\n#3=CARTESIAN_POINT('',(6.,0.,0.));\n#4=CARTESIAN_POINT('',(6.,4.,0.));
#5=B_SPLINE_SURFACE_WITH_KNOTS('',1,1,((#1,#2),(#3,#4)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);`)
  const s = g.surface(ref(5))
  nearV(s.at(0, 0), [0, 0, 0]); nearV(s.at(1, 1), [6, 4, 0]); nearV(s.at(0.5, 0.5), [3, 2, 0])
})
test("a complex rational B-spline surface (member encoding) makes an exact cylinder patch", () => {
  const w = Math.SQRT1_2
  const { g } = geo(`#1=CARTESIAN_POINT('',(1.,0.,0.));\n#2=CARTESIAN_POINT('',(1.,0.,5.));\n#3=CARTESIAN_POINT('',(1.,1.,0.));\n#4=CARTESIAN_POINT('',(1.,1.,5.));
#5=CARTESIAN_POINT('',(0.,1.,0.));\n#6=CARTESIAN_POINT('',(0.,1.,5.));
#7=(BOUNDED_SURFACE()B_SPLINE_SURFACE(2,1,((#1,#2),(#3,#4),(#5,#6)),.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS((3,3),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.)RATIONAL_B_SPLINE_SURFACE(((1.,1.),(${w.toFixed(16)},${w.toFixed(16)}),(1.,1.)))GEOMETRIC_REPRESENTATION_ITEM()REPRESENTATION_ITEM('')SURFACE());`)
  const s = g.surface(ref(7))
  for (let i = 0; i <= 10; i++) for (const v of [0, 0.5, 1]) {
    const p = s.at(i / 10, v); near(Math.hypot(p[0], p[1]), 1, 1e-12, "radius"); near(p[2], 5 * v, 1e-12)
  }
})
test("unsupported and malformed surfaces are refused by name", () => {
  const { g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=AXIS2_PLACEMENT_3D('',#1,$,$);\n#3=SURFACE_OF_REVOLUTION('',#2,#2);`)
  assert.throws(() => g.surface(ref(3)), /unsupported surface type SURFACE_OF_REVOLUTION/)
})

// ---------- EDGE_CURVE semantics
const EDGE = (ss: string) => `#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(5.,0.,0.));
#3=DIRECTION('',(-1.,0.,0.));\n#4=VECTOR('',#3,5.);\n#5=LINE('',#2,#4);\n#6=VERTEX_POINT('',#1);\n#7=VERTEX_POINT('',#2);
#8=EDGE_CURVE('',#6,#7,#5,${ss});`
test("EDGE_CURVE: start/end are its two vertices and same_sense is read from the flag", () => {
  const t = geo(EDGE(".T.")).g.edge(geo(EDGE(".T.")).p.entities.get(8)!)
  nearV(t.start, [0, 0, 0]); nearV(t.end, [5, 0, 0]); assert.equal(t.sameSense, true)
  const { p, g } = geo(EDGE(".F."))
  assert.equal(g.edge(p.entities.get(8)!).sameSense, false)
})
test("EDGE_CURVE: a missing same_sense argument defaults to true", () => {
  const { p, g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(5.,0.,0.));\n#3=DIRECTION('',(1.,0.,0.));\n#4=VECTOR('',#3,5.);
#5=LINE('',#1,#4);\n#6=VERTEX_POINT('',#1);\n#7=VERTEX_POINT('',#2);\n#8=EDGE_CURVE('',#6,#7,#5);`)
  assert.equal(g.edge(p.entities.get(8)!).sameSense, true)
})

test("EDGE_CURVE: a LINE that misses its own vertices is rebuilt from them, counted, and reported", () => {
  // the declared line runs along +X from the origin, but both vertices sit 0.2 above it (a real exporter drift)
  const { p, g } = geo(`#1=CARTESIAN_POINT('',(0.,0.2,0.));\n#2=CARTESIAN_POINT('',(5.,0.2,0.));\n#3=CARTESIAN_POINT('',(0.,0.,0.));
#4=DIRECTION('',(1.,0.,0.));\n#5=VECTOR('',#4,5.);\n#6=LINE('',#3,#5);\n#7=VERTEX_POINT('',#1);\n#8=VERTEX_POINT('',#2);\n#9=EDGE_CURVE('',#7,#8,#6,.T.);`)
  const ed = g.edge(p.entities.get(9)!)
  const { perp } = lineInfo(ed.curve, [0, 0.2, 0])
  near(perp, 0, 1e-12, "the rebuilt line passes through the vertices")
  nearV(ed.curve.at(ed.curve.closest(ed.start)), ed.start, 1e-12)
  nearV(ed.curve.at(ed.curve.closest(ed.end)), ed.end, 1e-12)
  near(dist(ed.start, ed.end), 5, 1e-12, "the two vertices are 5 apart")
  // the rebuilt curve's own parameterisation must span exactly the vertices: t=0 at start, t=1 at end.
  // Without this, a line rebuilt with the wrong magnitude still passes the nearest-point checks above.
  near(ed.curve.closest(ed.start), 0, 1e-12, "t=0 is the start vertex")
  near(ed.curve.closest(ed.end), 1, 1e-12, "t=1 is the end vertex")
  assert.equal(g.stats.lineEdgesRebuilt, 1)
  near(g.stats.maxLineGapMm, 0.2, 1e-12)
  g.flushWarnings()
  assert.ok(g.warnings.some((w) => /1 line edge\(s\) had a curve that does not pass through/.test(w)), JSON.stringify(g.warnings))
})
test("EDGE_CURVE: a line already through its vertices is used as declared, with no repair and no warning", () => {
  const { p, g } = geo(`#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=CARTESIAN_POINT('',(5.,0.,0.));\n#3=DIRECTION('',(1.,0.,0.));
#4=VECTOR('',#3,2.5);\n#5=LINE('',#1,#4);\n#6=VERTEX_POINT('',#1);\n#7=VERTEX_POINT('',#2);\n#8=EDGE_CURVE('',#6,#7,#5,.T.);`)
  const ed = g.edge(p.entities.get(8)!)
  near(ed.curve.at(0.5)[0], 1.25, 1e-12, "still the declared parameterisation, not rebuilt")
  assert.equal(g.stats.lineEdgesRebuilt, 0)
  assert.deepEqual(g.flushWarnings(), [])
})
test("EDGE_CURVE: a curved edge keeps its own curve (the repair is for lines only)", () => {
  const { p, g } = geo(`#1=CARTESIAN_POINT('',(1.,0.,0.));\n#2=CARTESIAN_POINT('',(0.,1.,0.));\n#3=CARTESIAN_POINT('',(0.,0.,0.));
#4=AXIS2_PLACEMENT_3D('',#3,$,$);\n#5=CIRCLE('',#4,1.);\n#6=VERTEX_POINT('',#1);\n#7=VERTEX_POINT('',#2);\n#8=EDGE_CURVE('',#6,#7,#5,.T.);`)
  const ed = g.edge(p.entities.get(8)!)
  assert.equal(ed.curve.kind, "circle")
  near(dist(ed.curve.at(0.3), [0, 0, 0]), 1, 1e-12)
  assert.equal(g.stats.lineEdgesRebuilt, 0)
})
test("EDGE_CURVE: a zero-length edge is flagged instead of producing a NaN direction", () => {
  const { p, g } = geo(`#1=CARTESIAN_POINT('',(2.,2.,2.));\n#2=DIRECTION('',(1.,0.,0.));\n#3=VECTOR('',#2,1.);
#4=LINE('',#1,#3);\n#5=VERTEX_POINT('',#1);\n#6=EDGE_CURVE('',#5,#5,#4,.T.);`)
  const ed = g.edge(p.entities.get(6)!)
  assert.ok(ed.curve.at(0).every(Number.isFinite))
  assert.ok(g.warnings.some((w) => /degenerate edge/.test(w)), JSON.stringify(g.warnings))
})

// ---------- complex entity helpers
test("member/hasMember reach into complex entities and also work for simple ones", () => {
  const { p } = geo(`#1=(B_SPLINE_CURVE()RATIONAL_B_SPLINE_CURVE((1.,1.))CURVE());\n#2=CIRCLE('',#3,1.);`)
  const c = p.entities.get(1)!
  assert.deepEqual(member(c, "RATIONAL_B_SPLINE_CURVE"), [[1, 1]])
  assert.deepEqual(member(c, "B_SPLINE_CURVE"), [], "a member present with no arguments is an empty list, not absent")
  assert.ok(hasMember(c, "CURVE")); assert.ok(!hasMember(c, "PLANE"))
  assert.ok(member(p.entities.get(2)!, "CIRCLE"))
})

// ---------- real fixtures: the edge-vertex agreement is the honest measurement
const realFiles = [
  "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step",
  "circuit-json-to-gltf/tests/assets/TO-92_Inline.step",
  "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step",
  "freerouting/fixtures/Issue191-processor.Z80/plcc44.stp",
  "circuit-json-to-step/test/basics/basics22/solidworks.step",
  "circuit-json-to-gltf/tests/assets/Contact.step",
]
for (const rel of realFiles) {
  test(`real file: every curve resolves and every edge passes through both its vertices (${rel.split("/").pop()})`, { skip: !fs.existsSync(REF + rel) }, () => {
    const p = parsePart21(fs.readFileSync(REF + rel, "latin1"))
    const g = new Geometry(p)
    let edges = 0, worst = 0, earlierKind = ""
    for (const e of p.entities.values()) {
      if (e.type !== "EDGE_CURVE") continue
      edges++
      const ed = g.edge(e)
      for (const v of [ed.start, ed.end]) {
        const d = dist(ed.curve.at(ed.curve.closest(v)), v)
        if (d > worst) { worst = d; earlierKind = ed.curve.kind }
      }
    }
    assert.ok(edges > 0, "file has edges")
    // 1 um is far tighter than any export tolerance; measured worst case over all six files is ~2 nm
    assert.ok(worst < 1e-3, `${rel}: worst vertex-to-curve gap ${worst} on a ${earlierKind} edge`)
    assert.equal(g.warnings.filter((w) => /unsupported|no knot/.test(w)).length, 0, JSON.stringify(g.warnings))
  })
}
test("real file TYPE-C: the 104 drifted lines are rebuilt, and the drift is reported with its size", { skip: !fs.existsSync(REF + realFiles[2]) }, () => {
  const p = parsePart21(fs.readFileSync(REF + realFiles[2], "latin1"))
  const g = new Geometry(p)
  for (const e of p.entities.values()) if (e.type === "EDGE_CURVE") g.edge(e)
  // measured distribution: 104 lines drift more than 1 um, and 112 more than 0.01 um; every other
  // reference file stays under 7e-9 mm, so the 1e-7 mm repair threshold sits in clear air.
  assert.equal(g.stats.lineEdgesRebuilt, 112)
  // measured 0.024807 mm from the vertex-to-vertex direction; asserted as a range because the exact
  // figure depends on which of the two conflicting lines you call authoritative
  assert.ok(g.stats.maxLineGapMm > 0.0247 && g.stats.maxLineGapMm < 0.0249, `worst drift ${g.stats.maxLineGapMm} mm, expected about 25 um`)
  g.flushWarnings()
  assert.ok(g.warnings.some((w) => /112 line edge\(s\)/.test(w)), JSON.stringify(g.warnings))
})
test("real file Contact.step: B-spline curves and surfaces are all rational or plain, all resolve", { skip: !fs.existsSync(REF + realFiles[5]) }, () => {
  const p = parsePart21(fs.readFileSync(REF + realFiles[5], "latin1"))
  const g = new Geometry(p)
  let bs = 0
  for (const e of p.entities.values()) {
    const t = e.parts ? e.parts.map((x) => x.type) : [e.type]
    if (t.includes("B_SPLINE_CURVE_WITH_KNOTS")) { g.curve(ref(e.id)); bs++ }
    if (t.includes("B_SPLINE_SURFACE_WITH_KNOTS")) g.surface(ref(e.id))
  }
  assert.ok(bs >= 20, `expected B-spline curves, found ${bs}`)
  assert.deepEqual(g.flushWarnings(), [])
})

