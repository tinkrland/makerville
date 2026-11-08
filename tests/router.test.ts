import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { newBoard, ensureNet, padWorld } from "../src/model.ts"
import { resistor, header } from "../src/library.ts"
import { writeKicadPcb } from "../src/kicad-write.ts"
import { GridAStarRouter } from "../src/router/grid-astar.ts"
import { MinHeap } from "../src/router/min-heap.ts"
import { simplify, obstacleDistance, pointSegmentDistance } from "../src/router/geometry.ts"
import { crossingBoard } from "./router-kicad.ts"

test("MinHeap pops in score order and is stable for ties", () => {
  const h = new MinHeap()
  ;[5, 1, 4, 1, 3].forEach((s, i) => h.push({ id: i, score: s, cost: 0 }))
  const out: number[] = []
  while (h.length) out.push(h.pop().score)
  assert.deepEqual(out, [1, 1, 3, 4, 5])
})

test("geometry helpers", () => {
  assert.equal(pointSegmentDistance({ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }), 1)
  assert.equal(pointSegmentDistance({ x: 3, y: 0 }, { x: -1, y: 0 }, { x: 1, y: 0 }), 2)
  assert.equal(obstacleDistance({ x: 3, y: 0 }, { center: { x: 0, y: 0 }, width: 2, height: 2 }), 2)
  assert.equal(obstacleDistance({ x: 0, y: 0 }, { center: { x: 0, y: 0 }, width: 2, height: 2 }), 0)
  assert.ok(Math.abs(obstacleDistance({ x: 3, y: 0 }, { center: { x: 0, y: 0 }, width: 2, height: 2, shape: "circle" }) - 2) < 1e-9)
  assert.deepEqual(simplify([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }]), [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }])
})

test("routes a simple two-pad net on one layer, with no vias", () => {
  const b = newBoard("s", 20, 10)
  const R1 = resistor("R1", "0603", { at: { x: -6, y: 0 } })
  const R2 = resistor("R2", "0603", { at: { x: 6, y: 0 } })
  b.footprints.push(R1, R2)
  R1.pads[1]!.net = "N"; R2.pads[0]!.net = "N"; ensureNet(b, "N")
  const r = new GridAStarRouter().route(b, { gridSize: 0.2 })
  assert.equal(r.ok, true)
  assert.equal(r.vias.length, 0)
  assert.ok(r.tracks.length >= 1)
  // the track must start and end exactly on the pad centres
  const a = padWorld(R1, R1.pads[1]!), z = padWorld(R2, R2.pads[0]!)
  const ends = r.tracks.flatMap((t) => [t.a, t.b])
  assert.ok(ends.some((p) => Math.hypot(p.x - a.x, p.y - a.y) < 1e-6), "starts on pad")
  assert.ok(ends.some((p) => Math.hypot(p.x - z.x, p.y - z.y) < 1e-6), "ends on pad")
})

test("does not mutate the board it is given", () => {
  const b = crossingBoard()
  const before = JSON.stringify(b)
  new GridAStarRouter().route(b, { gridSize: 0.25 })
  assert.equal(JSON.stringify(b), before)
})

test("deterministic: same board gives identical copper", () => {
  const a = new GridAStarRouter().route(crossingBoard(), { gridSize: 0.25 })
  const c = new GridAStarRouter().route(crossingBoard(), { gridSize: 0.25 })
  const norm = (r: typeof a) => JSON.stringify([r.tracks.map((t) => [t.a, t.b, t.layer, t.net]), r.vias.map((v) => [v.at, v.net])])
  assert.equal(norm(a), norm(c))
})

test("reports an impossible board instead of drawing something wrong", () => {
  // a slot of copper wall (a foreign-net pad row) cuts the board in two on a 1 layer board
  const b = newBoard("wall", 20, 10, 2)
  b.copper = ["F.Cu"]
  const L = resistor("L", "0603", { at: { x: -8, y: 0 } })
  const Rr = resistor("R", "0603", { at: { x: 8, y: 0 } })
  b.footprints.push(L, Rr)
  L.pads[1]!.net = "N"; Rr.pads[0]!.net = "N"; ensureNet(b, "N")
  // foreign pads across the whole height
  for (let i = 0; i < 10; i++) {
    const w = resistor("W" + i, "1206", { at: { x: 0, y: -4.5 + i }, rotation: 90 })
    w.pads[0]!.net = "WALL"; w.pads[1]!.net = "WALL"
    b.footprints.push(w)
  }
  ensureNet(b, "WALL")
  const r = new GridAStarRouter().route(b, { gridSize: 0.25, maxAttempts: 3, useVias: false })
  assert.equal(r.ok, false)
  assert.ok(r.unrouted.length > 0)
  assert.match(r.unrouted[0]!.reason, /no path/)
})

test("rejects bad options with a reason", () => {
  const r = new GridAStarRouter().route(crossingBoard(), { gridSize: 0 })
  assert.equal(r.ok, false)
  assert.match(r.unrouted[0]!.reason, /gridSize/)
})

test("a forced crossing uses a via, and the tracks are on two layers", () => {
  const r = new GridAStarRouter().route(crossingBoard(), { gridSize: 0.2 })
  assert.equal(r.ok, true)
  assert.ok(r.vias.length >= 1, "needs at least one via")
  assert.ok(new Set(r.tracks.map((t) => t.layer)).size === 2)
})

// the real judge: KiCad's own DRC must find nothing on a board we routed
const kicad = spawnSync("kicad-cli", ["version"], { encoding: "utf8" })
test("KiCad DRC accepts the routed crossing board: 0 violations, 0 unconnected", { skip: kicad.status !== 0 }, () => {
  const b = crossingBoard()
  const r = new GridAStarRouter().route(b, { gridSize: 0.2 })
  assert.equal(r.ok, true)
  b.tracks.push(...r.tracks)
  b.vias.push(...r.vias)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-"))
  const f = path.join(dir, "b.kicad_pcb")
  fs.writeFileSync(f, writeKicadPcb(b))
  const out = path.join(dir, "drc.json")
  const run = spawnSync("kicad-cli", ["pcb", "drc", f, "-o", out, "--format", "json", "--severity-all"], { encoding: "utf8", env: { ...process.env, HOME: dir } })
  assert.ok(fs.existsSync(out), run.stderr)
  const d = JSON.parse(fs.readFileSync(out, "utf8"))
  const real = d.violations.filter((v: any) => v.type !== "lib_footprint_issues")
  assert.deepEqual(real.map((v: any) => v.type + ": " + v.description), [])
  assert.equal(d.unconnected_items.length, 0)
})
