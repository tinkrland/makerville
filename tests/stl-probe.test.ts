import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { loadStl, solidAt, transitionsAlongX, transitionsAlongY } from "./stl-probe.ts"

const have = spawnSync("openscad", ["--version"], { encoding: "utf8" })
const haveOpenscad = /OpenSCAD/.test(have.stderr + have.stdout)

function mesh(scad: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"))
  fs.writeFileSync(path.join(dir, "c.scad"), scad)
  spawnSync("openscad", ["-o", path.join(dir, "c.stl"), path.join(dir, "c.scad")], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen" } })
  return loadStl(fs.readFileSync(path.join(dir, "c.stl"), "utf8"))
}

// The probe is the instrument every geometry test relies on, so it is tested against shapes whose
// answers are known by construction, including the awkward spots that broke the first version.
test("probe: cube with a round hole, on and off every kind of edge", { skip: !haveOpenscad }, () => {
  const t = mesh("difference(){cube([10,10,10]);translate([5,5,-1])cylinder(h=12,d=4,$fn=64);}")
  const S = (x: number, y: number, z: number) => solidAt(t, x, y, z)
  assert.equal(S(1, 1, 5), true, "(1,1) lies exactly on the diagonal of the top and bottom faces: the case that broke the first probe")
  assert.equal(S(2, 2, 5), true, "another point on that diagonal")
  assert.equal(S(8, 5, 5), true)
  assert.equal(S(5, 5, 5), false, "hole centre")
  assert.equal(S(5, 5, 0.1), false, "hole centre near the floor")
  assert.equal(S(5, 5, 9.9), false, "hole centre near the top")
  assert.equal(S(20, 20, 5), false, "outside the cube")
  assert.equal(S(1, 1, 11), false, "above the cube")
  assert.equal(S(1, 1, -1), false, "below the cube")
  assert.equal(S(0, 0, 5), true, "on a corner edge: nudged inside")
  assert.equal(S(5, 0, 5), true, "on a side face")
})

test("probe: a grid of points all agree with a closed-form answer", { skip: !haveOpenscad }, () => {
  const t = mesh("difference(){cube([20,20,6]);translate([10,10,-1])cylinder(h=8,r=4,$fn=96);}")
  let wrong = 0, n = 0
  for (let x = 0.5; x < 20; x += 1.0) for (let y = 0.5; y < 20; y += 1.0) for (const z of [1, 3, 5]) {
    const inCube = true
    const r = Math.hypot(x - 10, y - 10)
    if (Math.abs(r - 4) < 0.2) continue // skip the facet-sensitive rim
    const expected = inCube && r > 4
    n++
    if (solidAt(t, x, y, z) !== expected) wrong++
  }
  assert.ok(n > 1000)
  assert.equal(wrong, 0, `${wrong} of ${n} points disagree with the closed form`)
})

test("probe: hand-built tetra-free mesh, no OpenSCAD needed", () => {
  // a unit cube from 12 triangles, written out by hand
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  const t = f.map((tri) => tri.map((i) => v[i]!))
  assert.equal(solidAt(t, 0.5, 0.5, 0.5), true)
  assert.equal(solidAt(t, 0.25, 0.25, 0.5), true, "on the face diagonal")
  assert.equal(solidAt(t, 0.5, 0.5, 2), false)
  assert.equal(solidAt(t, 1.5, 0.5, 0.5), false)
})

test("probe: transitionsAlongX measures a wall's position and thickness to within a thousandth", { skip: !haveOpenscad }, () => {
  // a 30 mm box with a 25.4 mm cavity: walls are exactly 2.3 mm
  const t = mesh("difference(){translate([-15,-15,0])cube([30,30,10]);translate([-12.7,-12.7,2])cube([25.4,25.4,10]);}")
  const xs = transitionsAlongX(t, 0, 5, -20, 20)
  assert.deepEqual(xs.length, 4)
  assert.ok(Math.abs(xs[0]! - -15) < 0.002, `outer left ${xs[0]}`)
  assert.ok(Math.abs(xs[1]! - -12.7) < 0.002, `inner left ${xs[1]}`)
  assert.ok(Math.abs(xs[2]! - 12.7) < 0.002, `inner right ${xs[2]}`)
  assert.ok(Math.abs(xs[3]! - 15) < 0.002, `outer right ${xs[3]}`)
  assert.ok(Math.abs(xs[1]! - xs[0]! - 2.3) < 0.003, "wall thickness measured as 2.3")
})

test("probe: transitionsAlongY agrees with transitionsAlongX on a square", { skip: !haveOpenscad }, () => {
  const t = mesh("difference(){translate([-15,-15,0])cube([30,30,10]);translate([-12.7,-12.7,2])cube([25.4,25.4,10]);}")
  assert.deepEqual(transitionsAlongY(t, 0, 5, -20, 20), transitionsAlongX(t, 0, 5, -20, 20))
})
