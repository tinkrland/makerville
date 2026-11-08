import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { newBoard, ensureNet } from "../src/model.ts"
import { resistor, header } from "../src/library.ts"
import { writeKicadPcb, writeKicadDru } from "../src/kicad-write.ts"
import { runDrc } from "../src/drc/drc.ts"
import { GridAStarRouter } from "../src/router/grid-astar.ts"
import { crossingBoard } from "./router-kicad.ts"
import { dirtyBoard } from "./drc-kicad.ts"

const count = (b: ReturnType<typeof dirtyBoard>) => {
  const c: Record<string, number> = {}
  for (const v of runDrc(b).violations) c[v.type] = (c[v.type] ?? 0) + 1
  return c
}

test("each deliberate fault is found exactly once, naming the right items", () => {
  const d = runDrc(dirtyBoard())
  const by = (t: string) => d.violations.filter((v) => v.type === t)
  assert.deepEqual(by("clearance").map((v) => v.items.sort()), [["clr1", "clr2"]])
  assert.deepEqual(by("shorting_items").map((v) => v.items.sort()), [["sh1", "sh2"]])
  assert.deepEqual(by("track_width").map((v) => v.items), [["thin"]])
  assert.deepEqual(by("via_diameter").map((v) => v.items), [["vsmall"]])
  assert.deepEqual(by("annular_width").map((v) => v.items), [["vsmall"]])
  assert.deepEqual(by("copper_edge_clearance").map((v) => v.items), [["edge"]])
  assert.deepEqual(by("hole_to_hole").map((v) => v.items.sort()), [["HH1", "HH2"]])
  assert.equal(by("unconnected_items").length, 3)
})

test("measured values are right, not just flagged", () => {
  const d = runDrc(dirtyBoard())
  const clr = d.violations.find((v) => v.type === "clearance")!
  assert.ok(Math.abs(clr.actual! - 0.1) < 1e-9, "clr1/clr2 are 0.35 apart centre to centre, 0.25 wide => 0.10 gap: " + clr.actual)
  const h2h = d.violations.find((v) => v.type === "hole_to_hole")!
  assert.ok(Math.abs(h2h.actual! - 0.3) < 1e-9, "2.3 apart, two 2.0 drills => 0.3: " + h2h.actual)
  const ring = d.violations.find((v) => v.type === "annular_width")!
  assert.ok(Math.abs(ring.actual! - 0.05) < 1e-9)
})

test("a routed board is clean: 0 errors, 0 warnings, and fast", () => {
  const b = crossingBoard()
  const r = new GridAStarRouter().route(b, { gridSize: 0.2 })
  b.tracks.push(...r.tracks); b.vias.push(...r.vias)
  const d = runDrc(b)
  assert.deepEqual(d.violations.map((v) => v.type + ": " + v.message), [])
  assert.ok(d.ms < 250, `took ${d.ms} ms`)
})

test("an unrouted board reports exactly the connections the router would make", () => {
  const b = crossingBoard()
  const d = runDrc(b)
  const r = new GridAStarRouter().route(b, { gridSize: 0.2 })
  assert.equal(d.unconnected.length, r.stats.connections)
})

test("same-net copper may touch, different-net may not", () => {
  const mk = (n2: string) => {
    const b = newBoard("t", 30, 20)
    ensureNet(b, "X"); ensureNet(b, n2)
    b.tracks.push({ id: "a", a: { x: -5, y: 0 }, b: { x: 5, y: 0 }, width: 0.25, layer: "F.Cu", net: "X" })
    b.tracks.push({ id: "b", a: { x: 0, y: -5 }, b: { x: 0, y: 5 }, width: 0.25, layer: "F.Cu", net: n2 })
    return runDrc(b).violations.map((v) => v.type)
  }
  assert.ok(!mk("X").includes("shorting_items"))
  assert.ok(mk("Y").includes("shorting_items"))
})

test("copper on different layers does not interact, and a via joins them", () => {
  const b = newBoard("t", 30, 20)
  ensureNet(b, "X"); ensureNet(b, "Y")
  b.tracks.push({ id: "top", a: { x: -5, y: 0 }, b: { x: 5, y: 0 }, width: 0.25, layer: "F.Cu", net: "X" })
  b.tracks.push({ id: "bot", a: { x: 0, y: -5 }, b: { x: 0, y: 5 }, width: 0.25, layer: "B.Cu", net: "Y" })
  assert.ok(!runDrc(b).violations.some((v) => v.type === "shorting_items" || v.type === "clearance"))
  // a Y-net via right under the X track now violates on the top layer
  b.vias.push({ id: "v", at: { x: 0, y: 0 }, diameter: 0.8, drill: 0.4, from: "F.Cu", to: "B.Cu", net: "Y" })
  assert.ok(runDrc(b).violations.some((v) => v.type === "shorting_items"))
})

test("rule overrides take effect without mutating the board", () => {
  const b = dirtyBoard()
  const before = JSON.stringify(b.rules)
  const strict = runDrc(b, { clearance: 0.5 })
  assert.ok(strict.violations.filter((v) => v.type === "clearance").length >= 1)
  const loose = runDrc(b, { clearance: 0.01 })
  assert.equal(loose.violations.filter((v) => v.type === "clearance").length, 0)
  assert.equal(JSON.stringify(b.rules), before)
})

test("duplicate references and overlapping courtyards", () => {
  const b = newBoard("t", 40, 20)
  b.footprints.push(resistor("R1", "0603", { at: { x: 0, y: 0 } }), resistor("R1", "0603", { at: { x: 0.5, y: 0 } }))
  const types = runDrc(b).violations.map((v) => v.type)
  assert.ok(types.includes("duplicate_ref"))
  assert.ok(types.includes("courtyards_overlap"))
})

test("scales: 400 tracks check in well under a second", () => {
  const b = newBoard("big", 200, 200)
  for (let i = 0; i < 400; i++) {
    const n = "N" + i
    ensureNet(b, n)
    b.tracks.push({ id: "t" + i, a: { x: -90 + (i % 20) * 9, y: -90 + Math.floor(i / 20) * 9 }, b: { x: -84 + (i % 20) * 9, y: -90 + Math.floor(i / 20) * 9 }, width: 0.25, layer: "F.Cu", net: n })
  }
  const d = runDrc(b)
  assert.ok(d.ms < 1000, `took ${d.ms} ms`)
  assert.equal(d.violations.filter((v) => v.type === "clearance" || v.type === "shorting_items").length, 0)
})

// ---- the independent check: the same board through KiCad with the same rules
const kicad = spawnSync("kicad-cli", ["version"], { encoding: "utf8" })
test("agrees with KiCad rule by rule on the faulty board", { skip: kicad.status !== 0 }, () => {
  const b = dirtyBoard()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-drc-"))
  fs.writeFileSync(path.join(dir, "b.kicad_pcb"), writeKicadPcb(b))
  fs.writeFileSync(path.join(dir, "b.kicad_dru"), writeKicadDru(b))
  const out = path.join(dir, "o.json")
  spawnSync("kicad-cli", ["pcb", "drc", path.join(dir, "b.kicad_pcb"), "-o", out, "--format", "json", "--severity-all"], { env: { ...process.env, HOME: dir } })
  const k = JSON.parse(fs.readFileSync(out, "utf8"))
  const kc: Record<string, number> = {}
  for (const v of k.violations) kc[v.type] = (kc[v.type] ?? 0) + 1
  const ours = count(b)
  // rules where the two must agree exactly
  for (const r of ["annular_width", "copper_edge_clearance", "track_width", "via_diameter", "hole_to_hole"]) assert.equal(ours[r] ?? 0, kc[r] ?? 0, `rule ${r}: ours ${ours[r] ?? 0}, KiCad ${kc[r] ?? 0}`)
  const kUnconnected = k.unconnected_items.filter((u: any) => !/Track|Via/.test(u.items[0].description)).length
  assert.equal(ours.unconnected_items ?? 0, kUnconnected, "unconnected pad links")
  assert.equal(ours.dangling_copper ?? 0, (kc.track_dangling ?? 0) + (kc.via_dangling ?? 0), "dangling copper")
  // documented divergence: KiCad reports no short for two bare crossing tracks and calls the
  // hole pair a clearance error. We call them shorting_items and hole_to_hole.
  assert.equal(kc.shorting_items ?? 0, 0)
  assert.equal(ours.shorting_items, 1)
})

test("agrees with KiCad that the routed board is clean", { skip: kicad.status !== 0 }, () => {
  const b = crossingBoard()
  const r = new GridAStarRouter().route(b, { gridSize: 0.2 })
  b.tracks.push(...r.tracks); b.vias.push(...r.vias)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-drc2-"))
  fs.writeFileSync(path.join(dir, "b.kicad_pcb"), writeKicadPcb(b))
  fs.writeFileSync(path.join(dir, "b.kicad_dru"), writeKicadDru(b))
  const out = path.join(dir, "o.json")
  spawnSync("kicad-cli", ["pcb", "drc", path.join(dir, "b.kicad_pcb"), "-o", out, "--format", "json", "--severity-all"], { env: { ...process.env, HOME: dir } })
  const k = JSON.parse(fs.readFileSync(out, "utf8"))
  assert.deepEqual(k.violations.filter((v: any) => v.type !== "lib_footprint_issues").map((v: any) => v.type), [])
  assert.equal(k.unconnected_items.length, 0)
  assert.equal(runDrc(b).violations.length, 0)
})

// ---- boundaries: a rule must flip exactly at its limit, not nearby
function gapBoard(gap: number, rules: Partial<import("../src/model.ts").Rules> = {}) {
  const b = newBoard("gap", 40, 20)
  Object.assign(b.rules, rules)
  ensureNet(b, "A"); ensureNet(b, "B")
  // two parallel 0.2 mm tracks whose copper edges are exactly `gap` apart
  b.tracks.push({ id: "a", a: { x: -5, y: 0 }, b: { x: 5, y: 0 }, width: 0.2, layer: "F.Cu", net: "A" })
  b.tracks.push({ id: "b", a: { x: -5, y: 0.2 + gap }, b: { x: 5, y: 0.2 + gap }, width: 0.2, layer: "F.Cu", net: "B" })
  return b
}
const has = (b: ReturnType<typeof gapBoard>, t: string) => runDrc(b).violations.some((v) => v.type === t)

test("clearance flips exactly at the limit (0.2 mm)", () => {
  assert.equal(has(gapBoard(0.19), "clearance"), true, "0.19 < 0.20 must fail")
  assert.equal(has(gapBoard(0.2), "clearance"), false, "exactly 0.20 must pass")
  assert.equal(has(gapBoard(0.21), "clearance"), false)
  assert.equal(has(gapBoard(0.151), "clearance"), true, "0.151 must fail (a 0.05 slack would hide it)")
})

test("the limit follows the rule value", () => {
  assert.equal(has(gapBoard(0.29, { clearance: 0.3 }), "clearance"), true)
  assert.equal(has(gapBoard(0.3, { clearance: 0.3 }), "clearance"), false)
})

test("track width flips exactly at the minimum", () => {
  const mk = (w: number) => {
    const b = newBoard("w", 30, 20); ensureNet(b, "A")
    b.tracks.push({ id: "t", a: { x: -5, y: 0 }, b: { x: 5, y: 0 }, width: w, layer: "F.Cu", net: "A" })
    return runDrc(b).violations.some((v) => v.type === "track_width")
  }
  assert.equal(mk(0.149), true)
  assert.equal(mk(0.15), false)
})

test("annular ring flips exactly at the minimum (0.13)", () => {
  const mk = (diameter: number) => {
    const b = newBoard("v", 30, 20); ensureNet(b, "A")
    b.vias.push({ id: "v", at: { x: 0, y: 0 }, diameter, drill: 0.3, from: "F.Cu", to: "B.Cu", net: "A" })
    return runDrc(b).violations.some((v) => v.type === "annular_width")
  }
  assert.equal(mk(0.55), true, "ring 0.125 < 0.13")
  assert.equal(mk(0.56), false, "ring 0.13 passes")
})

test("edge clearance flips exactly at the limit (0.3 mm to the copper edge)", () => {
  // board edge at x=15, track half-width 0.1  =>  gap = 15 - x - 0.1
  const mk = (x: number) => {
    const b = newBoard("e", 30, 20); ensureNet(b, "A")
    b.tracks.push({ id: "t", a: { x, y: -3 }, b: { x, y: 3 }, width: 0.2, layer: "F.Cu", net: "A" })
    return runDrc(b).violations.some((v) => v.type === "copper_edge_clearance")
  }
  assert.equal(mk(14.61), true, "gap 0.29 < 0.30 must fail")
  assert.equal(mk(14.6), false, "gap exactly 0.30 must pass")
  assert.equal(mk(14.5), false, "gap 0.40 passes")
  assert.equal(mk(14.95), true, "gap -0.05 .. copper hanging past the edge")
})
