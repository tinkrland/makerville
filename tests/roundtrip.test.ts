import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { newBoard, ensureNet, padWorld } from "../src/model.ts"
import { resistor, led, header } from "../src/library.ts"
import { writeKicadPcb } from "../src/kicad-write.ts"
import { readKicadPcb, arcThrough, chainLoops } from "../src/kicad-read.ts"

function sample() {
  const b = newBoard("rt", 34, 22)
  const J1 = header("J1", 2, 1, { at: { x: -11, y: 0 } })
  const R1 = resistor("R1", "0402", { at: { x: -3, y: 0 }, value: "330" })
  const D1 = led("D1", "0603", { at: { x: 6, y: 0 }, rotation: 90 })
  b.footprints.push(J1, R1, D1)
  const set = (f: any, n: string, net: string) => { f.pads.find((p: any) => p.name === n).net = net; ensureNet(b, net) }
  set(J1, "1", "VIN"); set(R1, "1", "VIN"); set(R1, "2", "LEDA"); set(D1, "1", "LEDA")
  b.tracks.push({ id: "t1", a: padWorld(R1, R1.pads[1]!), b: padWorld(D1, D1.pads[0]!), width: 0.25, layer: "F.Cu", net: "LEDA" })
  b.vias.push({ id: "v1", at: { x: 0, y: 5 }, diameter: 0.8, drill: 0.4, from: "F.Cu", to: "B.Cu", net: "VIN" })
  b.holes.push({ id: "H1", at: { x: 14, y: 8 }, drill: 2.2, pad: 4 })
  return b
}

test("write -> read keeps outline, footprints, pads, nets, tracks, vias, holes", () => {
  const a = sample()
  const { board: r, warnings } = readKicadPcb(writeKicadPcb(a))
  assert.deepEqual(warnings, [])
  assert.equal(r.outline.length, 4)
  const bb = (p: any[]) => [Math.min(...p.map((q) => q.x)), Math.max(...p.map((q) => q.x)), Math.min(...p.map((q) => q.y)), Math.max(...p.map((q) => q.y))]
  assert.deepEqual(bb(r.outline).map((v) => +v.toFixed(3)), [-17, 17, -11, 11])
  assert.equal(r.footprints.length, 3)
  for (const f of a.footprints) {
    const g = r.footprints.find((x) => x.ref === f.ref)!
    assert.ok(g, f.ref)
    assert.ok(Math.abs(g.at.x - f.at.x) < 1e-6 && Math.abs(g.at.y - f.at.y) < 1e-6, `${f.ref} position`)
    assert.equal(((g.rotation % 360) + 360) % 360, ((f.rotation % 360) + 360) % 360, `${f.ref} rotation`)
    assert.equal(g.pads.length, f.pads.length)
    for (const p of f.pads) {
      const q = g.pads.find((x) => x.name === p.name)!
      assert.equal(q.net, p.net, `${f.ref}.${p.name} net`)
      assert.ok(Math.abs(q.at.x - p.at.x) < 1e-6 && Math.abs(q.at.y - p.at.y) < 1e-6, `${f.ref}.${p.name} pad pos`)
    }
  }
  assert.equal(r.tracks.length, 1)
  assert.equal(r.tracks[0]!.net, "LEDA")
  assert.equal(r.vias.length, 1)
  assert.equal(r.holes.length, 1)
  assert.ok(Math.abs(r.holes[0]!.at.x - 14) < 1e-6 && Math.abs(r.holes[0]!.at.y - 8) < 1e-6)
})

test("second write is byte-identical (stable uuids, stable order)", () => {
  assert.equal(writeKicadPcb(sample()), writeKicadPcb(sample()))
})

test("write(read(write(x))) is a fixed point", () => {
  const w1 = writeKicadPcb(sample())
  const w2 = writeKicadPcb(readKicadPcb(w1).board)
  const w3 = writeKicadPcb(readKicadPcb(w2).board)
  assert.equal(w3, w2)
})

test("arcThrough: quarter circle ends exactly and stays on the radius", () => {
  const pts = arcThrough({ x: 1, y: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, { x: 0, y: 1 })
  assert.deepEqual(pts[0], { x: 1, y: 0 })
  assert.deepEqual(pts[pts.length - 1], { x: 0, y: 1 })
  for (const p of pts) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 1) < 1e-9)
})

test("arcThrough picks the long way round when the midpoint is on it", () => {
  const pts = arcThrough({ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }) // via the far side
  assert.ok(pts.some((p) => p.y < -0.5), "must pass through the bottom half")
})

test("chainLoops closes a shuffled square and drops an open chain", () => {
  const sq = (a: number, b: number, c: number, d: number) => [{ x: a, y: b }, { x: c, y: d }] as [any, any]
  const loops = chainLoops([sq(1, 0, 1, 1), sq(0, 0, 1, 0), sq(0, 1, 0, 0), sq(1, 1, 0, 1), sq(5, 5, 6, 6)])
  assert.equal(loops.length, 1)
  assert.equal(loops[0]!.length, 4)
})

test("rejects a file that is not a kicad_pcb", () => {
  assert.throws(() => readKicadPcb("(kicad_sch (version 1))"), /not a kicad_pcb/)
})

const real = "../refs/circuit-json-to-kicad/tests/assets/joule-thief.kicad_pcb"
test("reads a board saved by real KiCad (joule-thief)", { skip: !fs.existsSync(real) }, () => {
  const { board: b, skipped } = readKicadPcb(fs.readFileSync(real, "utf8"))
  assert.ok(b.footprints.length > 3, "footprints " + b.footprints.length)
  assert.ok(b.tracks.length > 0)
  assert.ok(b.outline.length >= 3, "outline " + b.outline.length)
  // artwork footprints (logos like G***) legitimately have no pads
  const padless = b.footprints.filter((f) => f.pads.length === 0).map((f) => f.ref)
  assert.ok(padless.every((r) => /^G/.test(r)), "unexpected pad-less parts: " + padless.join(","))
  assert.ok(b.footprints.filter((f) => f.pads.length > 0).length >= 50)
  // every named net on a pad must exist in the board net list
  for (const f of b.footprints) for (const p of f.pads) if (p.net) assert.ok(b.nets.includes(p.net), "net " + p.net)
  console.log("   joule-thief:", b.footprints.length, "fp,", b.tracks.length, "tracks,", b.vias.length, "vias, outline", b.outline.length, "pts, skipped", JSON.stringify(skipped))
})
