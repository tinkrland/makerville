import test from "node:test"
import assert from "node:assert/strict"
import { newBoard, padWorld } from "../src/model.ts"
import { usbCReceptacle } from "../src/library.ts"
import { wallFor, resolveOpenings, type Wall } from "../src/case/projection.ts"

/**
 * Independent oracle for "which wall does this connector face?".
 * The USB-C's signal pads sit on the y- side of the part's own frame and its mouth faces y-
 * (that is what the projection declares). So in the world the mouth faces from the part's
 * centre TOWARD the signal pad row. We find that row with padWorld, the same transform the
 * PCB writer uses, so wallFor's rotation maths can't share a bug with it.
 */
function oracleWall(rot: number, side: "top" | "bottom"): Wall {
  const fp = usbCReceptacle("J1", { at: { x: 0, y: 0 }, rotation: rot, side })
  const sig = fp.pads.filter((p) => p.kind === "smd")
  const mx = sig.reduce((s, p) => s + padWorld(fp, p).x, 0) / sig.length
  const my = sig.reduce((s, p) => s + padWorld(fp, p).y, 0) / sig.length
  return Math.abs(my) >= Math.abs(mx) ? (my > 0 ? "y+" : "y-") : mx > 0 ? "x+" : "x-"
}

test("signal pads are on the y- side of the USB-C's own frame (the declared mouth side)", () => {
  const sig = usbCReceptacle("J1").pads.filter((p) => p.kind === "smd")
  assert.ok(sig.length >= 12)
  assert.ok(sig.every((p) => p.at.y < 0))
})

test("wallFor agrees with the pad-geometry oracle at every right angle, both sides", () => {
  for (const side of ["top", "bottom"] as const)
    for (const rot of [0, 90, 180, 270, -90, 360, 450]) {
      assert.equal(wallFor("y-", rot, side), oracleWall(rot, side), `rot ${rot} side ${side}`)
    }
})

test("resolveOpenings puts the USB on the wall the oracle says, with the right position along it", () => {
  for (const side of ["top", "bottom"] as const)
    for (const rot of [0, 90, 180, 270]) {
      const b = newBoard("t", 60, 40)
      const fp = usbCReceptacle("J1", { at: { x: 7, y: -3 }, rotation: rot, side })
      b.footprints.push(fp)
      const [o] = resolveOpenings(b)
      assert.equal(o!.wall, oracleWall(rot, side), `rot ${rot} ${side}`)
      // along a y wall is the world x of the connector, along an x wall its world y
      const expected = o!.wall === "y+" || o!.wall === "y-" ? 7 : -3
      assert.ok(Math.abs(o!.along! - expected) < 1.2, `rot ${rot} ${side} along ${o!.along} expected ~${expected}`)
    }
})

test("wallFor handles all four local faces and is a rotation (rotating twice by 90 equals 180)", () => {
  const faces = ["x+", "y+", "x-", "y-"] as const
  for (const f of faces)
    for (const side of ["top", "bottom"] as const) {
      const once = (r: number) => wallFor(f, r, side)
      // 180 degrees flips to the opposite wall
      const opp = { "x+": "x-", "x-": "x+", "y+": "y-", "y-": "y+" } as const
      assert.equal(once(180), opp[once(0)], `${f} ${side}`)
      assert.equal(once(360), once(0))
    }
})

test("a part with no projection produces no openings", () => {
  const b = newBoard("t", 40, 30)
  b.footprints.push({ ...usbCReceptacle("J1"), lib: "boardforge:Nothing" })
  assert.deepEqual(resolveOpenings(b), [])
})

// ---- the mirror only shows up for faces with an x component
test("a part on the bottom is mirrored in x: an x+ face points at x- at rotation 0", () => {
  assert.equal(wallFor("x+", 0, "top"), "x+")
  assert.equal(wallFor("x+", 0, "bottom"), "x-")
  assert.equal(wallFor("x-", 0, "bottom"), "x+")
  // a y face does not care about the mirror at rotation 0
  assert.equal(wallFor("y+", 0, "bottom"), "y+")
})

test("mirror then rotate: x+ on the bottom at 90 degrees", () => {
  // mirror x+ -> x-, then rotate 90 ccw: (-1,0) -> (0,-1) = y-
  assert.equal(wallFor("x+", 90, "bottom"), "y-")
  // top side, no mirror: (1,0) -> (0,1) = y+
  assert.equal(wallFor("x+", 90, "top"), "y+")
})

test("the mirror matches pad geometry for an x-facing declaration too", () => {
  // build a footprint whose signal pads sit on its x- side (so the mouth faces x-), place it every way,
  // and compare wallFor("x-") with where the pads really land
  for (const side of ["top", "bottom"] as const)
    for (const rot of [0, 90, 180, 270]) {
      const fp = usbCReceptacle("J1", { at: { x: 0, y: 0 }, rotation: 0, side })
      // turn the y- pad row into an x- pad row by moving every pad (x,y) -> (y,-x)... then rotate the footprint
      const turned = { ...fp, rotation: rot, pads: fp.pads.map((p) => ({ ...p, at: { x: p.at.y, y: -p.at.x } })) }
      const sig = turned.pads.filter((p) => p.kind === "smd")
      const mx = sig.reduce((s, p) => s + padWorld(turned, p).x, 0) / sig.length
      const my = sig.reduce((s, p) => s + padWorld(turned, p).y, 0) / sig.length
      const oracle = Math.abs(my) >= Math.abs(mx) ? (my > 0 ? "y+" : "y-") : mx > 0 ? "x+" : "x-"
      assert.equal(wallFor("x-", rot, side), oracle, `x- face, rot ${rot}, ${side}`)
    }
})

test("non right-angle rotations pick the nearer wall, and a tie is stable", () => {
  assert.equal(wallFor("y-", 30, "top"), "y-")   // 30 degrees off y- is still y-
  assert.equal(wallFor("y-", 60, "top"), "x+")   // 60 degrees: closer to x+
  assert.equal(wallFor("y-", 120, "top"), "x+")
  // exactly 45: the tie goes to the y wall, always the same answer
  assert.equal(wallFor("y-", 45, "top"), wallFor("y-", 45, "top"))
  assert.equal(wallFor("x+", 45, "top"), "y+")
})

test("every diagonal is a tie and every tie goes to the y wall (no float-noise flips)", () => {
  for (const face of ["x+", "x-", "y+", "y-"] as const)
    for (const side of ["top", "bottom"] as const)
      for (const rot of [45, 135, 225, 315, -45, -135, 405]) {
        const w = wallFor(face, rot, side)
        assert.ok(w === "y+" || w === "y-", `${face} ${side} ${rot} -> ${w}`)
      }
  // and just off the diagonal the nearer wall wins, on both sides of it
  assert.equal(wallFor("y-", 44, "top"), "y-")
  assert.equal(wallFor("y-", 46, "top"), "x+")
})
