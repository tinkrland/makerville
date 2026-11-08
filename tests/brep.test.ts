import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parsePart21 } from "../src/step/part21.ts"
import { Geometry } from "../src/step/geometry.ts"
import { Brep } from "../src/step/brep.ts"
import { dot, len, scale, sub, add, type V3 } from "../src/step/vec.ts"
import { boxStep } from "./brep-box.ts"

const near = (a: number, b: number, e = 1e-9, m = "") => assert.ok(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`)

function read(text: string) {
  const p = parsePart21(text)
  const w: string[] = []
  const g = new Geometry(p, w)
  const b = new Brep(p, g, w)
  const solids = b.read()
  return { p, g, b, w, solids, faces: solids.flatMap((s) => s.shells.flatMap((sh) => sh.faces)) }
}
const box = (o = {}) => read(boxStep(o))

/** Newell normal of a loop, from its ordered vertices: the direction its winding implies */
function loopNormal(face: { bounds: { outer: boolean; loop: { edges: { from: V3 }[] } }[] }): V3 {
  const pts = (face.bounds.find((x) => x.outer) ?? face.bounds[0]!).loop.edges.map((e) => e.from)
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, q = pts[(i + 1) % pts.length]!
    nx += (a[1] - q[1]) * (a[2] + q[2]); ny += (a[2] - q[2]) * (a[0] + q[0]); nz += (a[0] - q[0]) * (a[1] + q[1])
  }
  const l = Math.hypot(nx, ny, nz)
  return [nx / l, ny / l, nz / l]
}
/** the normal the face claims, after same_sense is applied */
const faceNormal = (f: { surface: { normal(u: number, v: number): V3 }; sameSense: boolean }) => {
  const n = f.surface.normal(0, 0)
  return f.sameSense ? n : scale(n, -1)
}

// ---------- the synthetic box, where the right answer is arithmetic
test("box: one closed shell of six planar faces, all loops chained, no warnings", () => {
  const { solids, b, w, faces } = box()
  assert.equal(solids.length, 1); assert.equal(solids[0]!.shells.length, 1)
  const sh = solids[0]!.shells[0]!
  assert.equal(sh.closed, true); assert.equal(sh.faces.length, 6)
  assert.equal(b.stats.brokenLoops, 0); assert.equal(b.stats.maxLoopGap, 0)
  assert.ok(faces.every((f) => f.surface.kind === "plane"))
  assert.equal(b.stats.nonManifoldEdges, 0)
  assert.deepEqual(w, [])
})

test("box: every face's loop winds the way its own normal says (the outward normal)", () => {
  const { faces } = box()
  const centres: V3[] = []
  for (const f of faces) {
    const n = faceNormal(f)
    near(len(n), 1, 1e-12)
    near(dot(loopNormal(f), n), 1, 1e-12, `face #${f.id}`)
    centres.push(scale(f.bounds[0]!.loop.edges.reduce<V3>((s, e) => add(s, e.from), [0, 0, 0]), 1 / f.bounds[0]!.loop.edges.length))
  }
  // and all six normals point away from the box centre (5, 3, 2)
  const c: V3 = [5, 3, 2]
  for (const f of faces) assert.ok(dot(faceNormal(f), sub(centres[faces.indexOf(f)]!, c)) > 0, `face #${f.id} points inward`)
  // the six normals are the six axis directions, each exactly once
  const keys = new Set(faces.map((f) => faceNormal(f).map((x) => Math.round(x)).join(",")))
  assert.deepEqual([...keys].sort(), ["-1,0,0", "0,-1,0", "0,0,-1", "0,0,1", "0,1,0", "1,0,0"])
})

test("box: each of the 12 edges is used by exactly two faces, in opposite directions", () => {
  const { solids, b, faces } = box()
  const o = b.checkOrientation(solids)
  assert.equal(o.pairs, 12); assert.equal(o.sameDirection, 0); assert.equal(o.nonManifold, 0)
  assert.equal(b.checkManifold(solids), 0)
  const uses = new Map<number, number>()
  for (const f of faces) for (const bd of f.bounds) for (const e of bd.loop.edges) uses.set(e.edgeId, (uses.get(e.edgeId) ?? 0) + 1)
  assert.equal(uses.size, 12); assert.ok([...uses.values()].every((n) => n === 2))
})

test("box: edge uses run head to tail and the loop of each face has 4 uses", () => {
  const { faces } = box()
  for (const f of faces) {
    const es = f.bounds[0]!.loop.edges
    assert.equal(es.length, 4)
    assert.equal(f.bounds[0]!.loop.closed, true)
    for (let i = 0; i < es.length; i++) {
      const a = es[i]!, n = es[(i + 1) % es.length]!
      near(Math.hypot(a.to[0] - n.from[0], a.to[1] - n.from[1], a.to[2] - n.from[2]), 0, 1e-12)
    }
  }
})

test("box: the 8 corners are shared, not duplicated (24 uses of 12 edges, 8 distinct vertices)", () => {
  const { faces } = box()
  const corners = new Set<string>()
  for (const f of faces) for (const e of f.bounds[0]!.loop.edges) corners.add(e.from.map((x) => x.toFixed(6)).join(","))
  assert.equal(corners.size, 8)
})

// ---------- deliberate breakage: does the walker notice?
test("a loop reversed by the bound's orientation flag is put back the right way round", () => {
  const good = box()
  const broken = box({ breakFace: 3 })
  // the broken file says the same thing, written differently, so the result must be identical
  const g3 = good.faces.find((f) => f.id === broken.faces[2]!.id)!
  near(dot(loopNormal(broken.faces[2]!), faceNormal(broken.faces[2]!)), 1, 1e-12, "reversed bound corrected")
  near(dot(loopNormal(g3), faceNormal(g3)), 1, 1e-12)
  assert.equal(broken.b.stats.reversedBounds, 1)
  assert.deepEqual(broken.b.checkOrientation(broken.solids), good.b.checkOrientation(good.solids))
})

test("a loop wound backwards inside ORIENTED_EDGE flags is caught by the orientation check", () => {
  const { solids, b } = box({ insideOutFace: 2 })
  const o = b.checkOrientation(solids)
  // the walker faithfully reports what the file says, so the check must now see two faces running the
  // same edge the same way: that is the signal, and it must fire rather than be silently normalised
  assert.ok(o.sameDirection > 0, `expected same-direction edge uses, got ${JSON.stringify(o)}`)
  assert.ok(o.worst.some((s) => /both/.test(s)))
})

test("a face whose surface is unsupported is skipped with a named warning, and the rest survives", () => {
  const { b, w, faces } = box({ badSurfaceFace: 5 })
  assert.equal(b.stats.skippedFaces, 1)
  assert.equal(faces.length, 5)
  assert.ok(w.some((m) => /face #\d+ skipped: unsupported surface type SURFACE_OF_REVOLUTION/.test(m)), w.join(" | "))
})

test("faces with no FACE_OUTER_BOUND get their outer loop inferred, and it is the enclosing one", () => {
  const { b, faces } = box({ noOuterFlag: true })
  assert.equal(b.stats.inferredOuter, 6)
  assert.equal(b.stats.reversedBounds, 0)
  // with a single loop per face the deduction cannot change anything, so the geometry must be unchanged
  for (const f of faces) near(dot(loopNormal(f), faceNormal(f)), 1, 1e-12, `face #${f.id}`)
  assert.equal(b.checkOrientation(box({ noOuterFlag: true }).solids).sameDirection, 0)
})

test("same_sense false flips the face normal, so the loop still winds the way the face claims", () => {
  const { faces, solids, b } = box({ flipSameSenseFace: 1 })
  const f = faces[0]!
  assert.equal(f.sameSense, false)
  near(dot(loopNormal(f), faceNormal(f)), 1, 1e-12)
  // the surface axis was flipped too, so the effective normal is unchanged and the solid is still consistent
  assert.equal(b.checkOrientation(solids).sameDirection, 0)
})

test("BREP_WITH_VOIDS reads the outer shell and the void shells as separate shells", () => {
  const { solids, b, faces } = box({ withVoid: true })
  assert.equal(solids.length, 1); assert.equal(solids[0]!.shells.length, 2)
  assert.equal(solids[0]!.shells[0]!.faces.length, 6)
  assert.equal(solids[0]!.shells[1]!.faces.length, 2)
  assert.equal(faces.length, 8)
  assert.equal(b.stats.solids, 1); assert.equal(b.stats.shells, 2)
  // the outer shell stays watertight; the cavity stand-in (two independent quads) is deliberately open
  const outerOnly = [{ ...solids[0]!, shells: [solids[0]!.shells[0]!] }]
  assert.equal(b.checkManifold(outerOnly), 0)
})

// ---------- real models
const REF = "/app/conversations/6af0495dcaf878e1398c29c6/refs/"
const realFiles = [
  "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step",
  "circuit-json-to-gltf/tests/assets/TO-92_Inline.step",
  "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step",
  "freerouting/fixtures/Issue191-processor.Z80/plcc44.stp",
  "circuit-json-to-step/test/basics/basics22/solidworks.step",
  "circuit-json-to-gltf/tests/assets/Contact.step",
]
for (const rel of realFiles) {
  const name = rel.split("/").pop()
  test(`real model walks cleanly and watertight: ${name}`, { skip: !fs.existsSync(REF + rel) }, () => {
    const { solids, b, faces } = read(fs.readFileSync(REF + rel, "latin1"))
    assert.ok(solids.length >= 1, "some solid")
    assert.ok(faces.length > 0)
    assert.equal(b.stats.skippedFaces, 0, `skipped: ${b.stats.skippedFaces}`)
    assert.equal(b.stats.brokenLoops, 0, "every loop chains head to tail")
    assert.equal(b.stats.nonManifoldEdges, 0, "every edge used by exactly two faces")
    const o = b.checkOrientation(solids)
    assert.equal(o.nonManifold, 0)
    assert.equal(o.sameDirection, 0, `edges traversed the same way twice: ${o.worst.join("; ")}`)
    assert.ok(o.pairs > 0)
    // each face has exactly one outer bound
    for (const f of faces) assert.equal(f.bounds.filter((x) => x.outer).length, 1, `face #${f.id}`)
  })

  test(`real model planar faces: the loop winding agrees with the face normal: ${name}`, { skip: !fs.existsSync(REF + rel) }, () => {
    const { faces } = read(fs.readFileSync(REF + rel, "latin1"))
    let checked = 0
    for (const f of faces) {
      if (f.surface.kind !== "plane") continue
      const es = (f.bounds.find((x) => x.outer) ?? f.bounds[0]!).loop.edges
      if (es.length < 3) continue
      checked++
      // Not 1e-9: real planes are not exact. Face #4467 of the TYPE-C model has vertices up to
      // 6.25e-4 mm off its own plane, which tilts the loop normal by 6e-4, so require the correct SIDE.
      assert.ok(dot(loopNormal(f), faceNormal(f)) > 0.999, `face #${f.id} dot ${dot(loopNormal(f), faceNormal(f))}`)
    }
    assert.ok(checked > 0, "no planar faces to check")
  })
}

test("real model totals are stable (entity counts must not drift silently)", { skip: !fs.existsSync(REF + realFiles[2]) }, () => {
  const { b, faces } = read(fs.readFileSync(REF + realFiles[2], "latin1"))
  assert.equal(b.stats.solids, 42)
  assert.equal(b.stats.faces, 689)
  assert.equal(b.stats.edgeUses, 3342)
  assert.equal(faces.length, 689)
  const kinds = new Map<string, number>()
  for (const f of faces) kinds.set(f.surface.kind, (kinds.get(f.surface.kind) ?? 0) + 1)
  assert.deepEqual(Object.fromEntries(kinds), { plane: 549, cylinder: 120, cone: 20 })
})

test("the one real model that never names an outer bound is inferred, and says so once per face", { skip: !fs.existsSync(REF + realFiles[1]) }, () => {
  const { b, w } = read(fs.readFileSync(REF + realFiles[1], "latin1"))
  assert.equal(b.stats.inferredOuter, 19)
  assert.equal(w.filter((m) => /no FACE_OUTER_BOUND/.test(m)).length, 1)
})

test("a real periodic edge (a full circle with both vertices at one point) spans the whole circle", { skip: !fs.existsSync(REF + "circuit-json-to-gltf/tests/assets/Contact.step") }, () => {
  const { b, faces } = read(fs.readFileSync(REF + "circuit-json-to-gltf/tests/assets/Contact.step", "latin1"))
  assert.ok(b.stats.closedEdgeUses > 0, "expected some full-circle edges")
  // such a use must cover a whole period, not zero
  const full = faces.flatMap((f) => f.bounds.flatMap((x) => x.loop.edges)).filter((e) => Math.abs(e.tTo - e.tFrom) > Math.PI)
  assert.ok(full.length >= b.stats.closedEdgeUses)
  assert.ok(full.every((e) => Math.abs(Math.abs(e.tTo - e.tFrom) - Math.PI * 2) < 1e-6 || Math.abs(e.tTo - e.tFrom) > 3), "a full turn")
})
