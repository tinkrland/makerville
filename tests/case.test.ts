import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { newBoard, padWorld } from "../src/model.ts"
import { usbCReceptacle, header, resistor, soicIc } from "../src/library.ts"
import { generateCase, edgeGap, DEFAULT_CASE_OPTIONS } from "../src/case/generate.ts"
import { solidAt } from "./stl-probe.ts"

/** a 50x30 board with a USB-C on the +y edge, four corner holes, and some parts */
function demo(over: { usbY?: number; usbRot?: number; holes?: boolean } = {}) {
  const b = newBoard("demo", 50, 30)
  b.footprints.push(
    usbCReceptacle("J1", { at: { x: 0, y: over.usbY ?? 11 }, rotation: over.usbRot ?? 180 }),
    header("J2", 4, 1, { at: { x: 18, y: 0 } }),
    resistor("R1", "0603", { at: { x: -10, y: 0 } }),
    soicIc("U1", 8, { at: { x: 0, y: -2 } }),
  )
  if (over.holes !== false) b.holes.push({ id: "H1", at: { x: -22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H3", at: { x: -22, y: -12 }, drill: 2.2, pad: 4 }, { id: "H4", at: { x: 22, y: -12 }, drill: 2.2, pad: 4 })
  return b
}
const errors = (r: ReturnType<typeof generateCase>) => r.warnings.filter((w) => w.level === "error").map((w) => w.message)

test("a sound board gives ok:true and no errors", () => {
  const r = generateCase(demo())
  assert.equal(r.ok, true, errors(r).join("; "))
  assert.deepEqual(errors(r), [])
})

test("DETERMINISTIC: the same board always gives byte-identical scad", () => {
  const a = generateCase(demo()).scad
  for (let i = 0; i < 5; i++) assert.equal(generateCase(demo()).scad, a)
})

test("deterministic regardless of the order parts and holes were added", () => {
  const b1 = demo()
  const b2 = demo()
  b2.footprints.reverse(); b2.holes.reverse()
  assert.equal(generateCase(b1).scad, generateCase(b2).scad)
})

test("does not mutate the board", () => {
  const b = demo()
  const before = JSON.stringify(b)
  generateCase(b)
  assert.equal(JSON.stringify(b), before)
})

test("DERIVED, not hardcoded: tray height follows the tallest top-side part", () => {
  const withHeader = generateCase(demo()).stats.trayHeight
  const b = demo()
  b.footprints = b.footprints.filter((f) => f.ref !== "J2") // remove the 8.5 mm header
  const without = generateCase(b).stats.trayHeight
  assert.ok(Math.abs(withHeader - without - (8.5 - 3.26)) < 1e-6, `${withHeader} - ${without}`)
})

test("tray height formula: floor + standoff + board + tallest part + headroom", () => {
  const o = DEFAULT_CASE_OPTIONS
  const expect = o.floorThickness + o.standoffHeight + 1.6 + 8.5 + o.headroom
  assert.equal(generateCase(demo()).stats.trayHeight, expect)
})

test("outer size is the outline plus 2 x (margin + print slip + wall)", () => {
  // fdm profile slip is 0.3: 50 + 2 * (1 + 0.3 + 3) = 58.6
  const r = generateCase(demo(), { margin: 1, wallThickness: 3 })
  assert.equal(r.stats.outerWidth, 58.6)
  assert.equal(r.stats.outerHeight, 38.6)
  // with the ideal profile the print slip is zero and the old formula holds exactly
  const e = generateCase(demo(), { margin: 1, wallThickness: 3, profile: "ideal" })
  assert.equal(e.stats.outerWidth, 58)
  assert.equal(e.stats.outerHeight, 38)
})

test("every mounting hole gets a standoff and a lid screw hole", () => {
  const r = generateCase(demo())
  assert.equal(r.stats.standoffs, 4)
  for (const [x, y] of [[-22, 12], [22, 12], [-22, -12], [22, -12]]) {
    assert.match(r.scad, new RegExp(`standoff\\(${x}, ${y}\\)`))
    assert.match(r.scad, new RegExp(`translate\\(\\[${x}, ${y}, -1\\]\\) cylinder\\(h = lid_thickness`))
  }
})

test("ERROR: no mounting holes fails the job", () => {
  const r = generateCase(demo({ holes: false }))
  assert.equal(r.ok, false)
  assert.match(errors(r)[0]!, /no mounting holes/)
})

test("WARNING only: a single mounting hole still produces a case", () => {
  const b = demo(); b.holes = b.holes.slice(0, 1)
  const r = generateCase(b)
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.level === "warning" && /only one mounting hole/.test(w.message)))
})

test("ERROR: a bottom-side part taller than the standoffs would hit the floor", () => {
  const b = demo()
  b.footprints.push(header("J9", 4, 1, { at: { x: 0, y: 5 }, side: "bottom" }))
  const r = generateCase(b, { standoffHeight: 3 })
  assert.equal(r.ok, false)
  assert.match(errors(r).join(" "), /raise standoff height to at least 8\.8 mm/)
  assert.equal(generateCase(b, { standoffHeight: 9 }).ok, true)
})

test("ERROR: invalid options are named, not silently clamped", () => {
  const r = generateCase(demo(), { wallThickness: 0, screwSize: -1, margin: NaN })
  assert.equal(r.ok, false)
  const e = errors(r).join(" ")
  assert.match(e, /wallThickness/); assert.match(e, /screwSize/); assert.match(e, /margin/)
})

test("ERROR: an empty outline", () => {
  const b = demo(); b.outline = []
  assert.equal(generateCase(b).ok, false)
})

test("WARNING: a screw that is much thinner than the mounting hole rattles", () => {
  const r = generateCase(demo(), { screwSize: 1.5 })
  assert.ok(r.warnings.some((w) => /rattle/.test(w.message)))
})

test("the USB opening lands on the wall the connector faces, for every rotation (expected side read from real pad positions)", () => {
  // The expectation is NOT hand-written: it is where the signal pads actually land after the
  // footprint transform, which is the side the connector's mouth faces away from.
  const wallFromPads = (rot: number, at: { x: number; y: number }) => {
    const fp = usbCReceptacle("J1", { at, rotation: rot })
    const sig = fp.pads.filter((p) => p.kind === "smd")
    const dx = sig.reduce((s, p) => s + padWorld(fp, p).x, 0) / sig.length - at.x
    const dy = sig.reduce((s, p) => s + padWorld(fp, p).y, 0) / sig.length - at.y
    return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? "y+" : "y-") : dx > 0 ? "x+" : "x-"
  }
  const placed: [number, { x: number; y: number }][] = [[180, { x: 0, y: 11 }], [0, { x: 0, y: -11 }], [90, { x: 21, y: 0 }], [270, { x: -21, y: 0 }]]
  const seen = new Set<string>()
  for (const [rot, at] of placed) {
    const b = newBoard("t", 50, 30)
    b.footprints.push(usbCReceptacle("J1", { at, rotation: rot }))
    b.holes.push({ id: "H1", at: { x: -22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 22, y: -12 }, drill: 2.2, pad: 4 })
    const r = generateCase(b)
    const wall = wallFromPads(rot, at)
    seen.add(wall)
    assert.match(r.scad, new RegExp(`// J1: USB-C, ${wall.replace("+", "\\+")} wall`), `rot ${rot} should open the ${wall} wall`)
    assert.ok(!r.warnings.some((w) => /will not reach/.test(w.message)), `rot ${rot}: flush connector must not warn: ${r.warnings.map((w) => w.message)}`)
  }
  assert.equal(seen.size, 4, "all four walls were exercised")
})

test("WARNING when a connector is nowhere near the wall it faces, on every wall", () => {
  for (const [rot, x, y] of [[180, 0, 0], [0, 0, 0], [90, 0, 0], [270, 0, 0]] as const) {
    const b = newBoard("t", 50, 30)
    b.footprints.push(usbCReceptacle("J1", { at: { x, y }, rotation: rot }))
    b.holes.push({ id: "H1", at: { x: -22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 22, y: -12 }, drill: 2.2, pad: 4 })
    const r = generateCase(b)
    assert.ok(r.warnings.some((w) => /will not reach the connector/.test(w.message)), `rot ${rot}: ${r.warnings.map((w) => w.message).join("|")}`)
  }
})

test("no 'will not reach' warning for a connector flush with its wall", () => {
  const r = generateCase(demo())
  assert.ok(!r.warnings.some((w) => /will not reach/.test(w.message)))
})

test("edgeGap on a rectangle: distance from a point to the wall it faces", () => {
  const sq = [{ x: -25, y: -15 }, { x: 25, y: -15 }, { x: 25, y: 15 }, { x: -25, y: 15 }]
  assert.equal(edgeGap(sq, 11, "y+", 0), 4)
  assert.equal(edgeGap(sq, -11, "y-", 0), 4)
  assert.equal(edgeGap(sq, 20, "x+", 0), 5)
  assert.equal(edgeGap(sq, -20, "x-", 0), 5)
  assert.equal(edgeGap(sq, 15, "y+", 0), 0)
})

test("edgeGap follows a non-rectangular outline (an L shape)", () => {
  // an L: wide at the bottom, narrow tower on the left
  const L = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 }]
  assert.equal(edgeGap(L, 5, "y+", 5), 25)     // inside the tower, the top wall is at y=30
  assert.equal(edgeGap(L, 5, "y+", 30), 5)     // under the foot of the L, the top wall is at y=10
  assert.equal(edgeGap(L, 20, "x+", 5), 20)    // along y=5 the right wall is x=40
})

test("scad is plain OpenSCAD: no use/include, no network, parameters at the top", () => {
  const s = generateCase(demo()).scad
  assert.ok(!/\b(use|include)\s*</.test(s), "no library imports")
  assert.ok(!/https?:\/\//.test(s), "no URLs")
  assert.ok(s.indexOf("wall_thickness") < s.indexOf("module case_bottom"))
  for (const p of ["wall_thickness", "floor_thickness", "margin", "lid_thickness", "standoff_height", "headroom", "screw_size", "opening_clearance", "part_gap"]) assert.match(s, new RegExp(`^${p}\\s*=`, "m"))
})

test("params returned match the numbers written into the file", () => {
  const r = generateCase(demo(), { wallThickness: 3.2, standoffHeight: 4.5 })
  assert.equal(r.params.wall_thickness, 3.2)
  assert.match(r.scad, /^wall_thickness\s*=\s*3\.2;/m)
  assert.match(r.scad, /^standoff_height\s*=\s*4\.5;/m)
})

test("no -0 or exponent numbers leak into the scad", () => {
  const s = generateCase(demo()).scad
  assert.ok(!/-0[^.\d]/.test(s.replace(/-0\./g, "")), "no negative zero")
  assert.ok(!/\de[+-]?\d/.test(s.replace(/\/\/.*$/gm, "")), "no exponent notation")
})

// ---- the honest check: compile it and measure the result
const oscad = spawnSync("openscad", ["--version"], { encoding: "utf8" })
const haveOpenscad = oscad.status === 0 || /OpenSCAD/.test(oscad.stderr + oscad.stdout)

function compile(scad: string): { stl: string; ok: boolean; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-scad-"))
  fs.writeFileSync(path.join(dir, "c.scad"), scad)
  const run = spawnSync("openscad", ["-o", path.join(dir, "c.stl"), path.join(dir, "c.scad")], { encoding: "utf8", env: { ...process.env, QT_QPA_PLATFORM: "offscreen" }, timeout: 180000 })
  const stl = path.join(dir, "c.stl")
  return { stl, ok: fs.existsSync(stl), log: run.stderr + run.stdout }
}
function tris(stl: string): number[][][] {
  const t = fs.readFileSync(stl, "utf8")
  const v = [...t.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
  const out: number[][][] = []
  for (let i = 0; i < v.length; i += 3) out.push([v[i]!, v[i + 1]!, v[i + 2]!])
  return out
}

test("OPENSCAD compiles it to a manifold STL with no errors", { skip: !haveOpenscad }, () => {
  const c = compile(generateCase(demo()).scad)
  assert.ok(c.ok, c.log)
  assert.ok(!/ERROR/.test(c.log), c.log)
  assert.match(c.log, /Simple:\s+yes/)
})

test("OPENSCAD geometry matches the numbers: bounding box is tray + gap + lid, height is the tray height", { skip: !haveOpenscad }, () => {
  const r = generateCase(demo())
  const t = tris(compile(r.scad).stl)
  const all = t.flat()
  const minX = Math.min(...all.map((p) => p[0]!)), maxX = Math.max(...all.map((p) => p[0]!))
  const minY = Math.min(...all.map((p) => p[1]!)), maxY = Math.max(...all.map((p) => p[1]!))
  const maxZ = Math.max(...all.map((p) => p[2]!)), minZ = Math.min(...all.map((p) => p[2]!))
  assert.equal(minZ, 0)
  assert.ok(Math.abs(maxZ - r.stats.trayHeight) < 1e-3, `maxZ ${maxZ} vs ${r.stats.trayHeight}`)
  assert.ok(Math.abs(maxY - minY - r.stats.outerHeight) < 1e-3, `depth ${maxY - minY}`)
  const expectedW = r.stats.outerWidth * 2 + DEFAULT_CASE_OPTIONS.partGap
  assert.ok(Math.abs(maxX - minX - expectedW) < 1e-3, `width ${maxX - minX} vs ${expectedW}`)
})

test("OPENSCAD: the USB wall is open at the connector and solid on the other three", { skip: !haveOpenscad }, () => {
  const r = generateCase(demo())
  const t = tris(compile(r.scad).stl).filter((tri) => Math.max(...tri.map((p) => p[0]!)) < 30) // the tray only
  const half = { x: r.stats.outerWidth / 2, y: r.stats.outerHeight / 2 }
  const solidAt = (axis: 0 | 1, sign: 1 | -1, along: number, z: number): boolean => {
    const plane = sign * (axis === 0 ? half.x : half.y)
    const u = axis === 0 ? 1 : 0
    for (const tri of t) {
      if (!tri.every((p) => Math.abs(p[axis]! - plane) < 1e-6)) continue
      const P = tri.map((p) => [p[u]!, p[2]!])
      const [a, b, c] = P as [number[], number[], number[]]
      const d = (b![1]! - c![1]!) * (a![0]! - c![0]!) + (c![0]! - b![0]!) * (a![1]! - c![1]!)
      if (Math.abs(d) < 1e-12) continue
      const l1 = ((b![1]! - c![1]!) * (along - c![0]!) + (c![0]! - b![0]!) * (z - c![1]!)) / d
      const l2 = ((c![1]! - a![1]!) * (along - c![0]!) + (a![0]! - c![0]!) * (z - c![1]!)) / d
      if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) return true
    }
    return false
  }
  const z = 2 + 3 + 1.6 + 1.63
  assert.equal(solidAt(1, 1, 0, z), false, "y+ wall must be open at the USB")
  assert.equal(solidAt(1, -1, 0, z), true)
  assert.equal(solidAt(0, 1, 0, z), true)
  assert.equal(solidAt(0, -1, 0, z), true)
  // the wall is solid just outside the opening and at the same height
  assert.equal(solidAt(1, 1, 8, z), true, "wall must be solid beside the opening")
  // and solid above and below the opening
  assert.equal(solidAt(1, 1, 0, z + 6), true)
  assert.equal(solidAt(1, 1, 0, 1), true)
})

// ---- geometry probes: ask the compiled STL, not the text
const solidAtPoint = solidAt

test("OPENSCAD: a connector opens ITS wall and no other, on all four walls", { skip: !haveOpenscad }, () => {
  const placed: [string, number, { x: number; y: number }, { x: number; y: number }][] = [
    ["y+", 180, { x: 0, y: 11 }, { x: 0, y: 17.5 }],
    ["y-", 0, { x: 0, y: -11 }, { x: 0, y: -17.5 }],
    ["x+", 90, { x: 21, y: 0 }, { x: 27.5, y: 0 }],
    ["x-", 270, { x: -21, y: 0 }, { x: -27.5, y: 0 }],
  ]
  const z = 2 + 3 + 1.6 + 1.63
  for (const [wall, rot, at, probe] of placed) {
    const b = newBoard("t", 50, 30)
    b.footprints.push(usbCReceptacle("J1", { at, rotation: rot }))
    b.holes.push({ id: "H1", at: { x: -22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 22, y: -12 }, drill: 2.2, pad: 4 })
    const r = generateCase(b)
    assert.match(r.scad, new RegExp(`USB-C, ${wall.replace("+", "\\+")} wall`))
    const t = tris(compile(r.scad).stl).filter((tri) => Math.max(...tri.map((p) => p[0]!)) < 40)
    // the wall's material sits between the cavity edge and the outer edge, so probe mid-wall
    const mid = (wall.endsWith("+") ? 1 : -1)
    const wallCentre = wall[0] === "y" ? { x: probe.x, y: mid * (15 + 0.2 + 0.3 + 2.4 / 2) } : { x: mid * (25 + 0.2 + 0.3 + 2.4 / 2), y: probe.y }
    assert.equal(solidAtPoint(t, wallCentre.x, wallCentre.y, z), false, `${wall} wall must be open at the connector`)
    // the same wall just beside the opening is solid, so we cut a slot rather than removing the wall
    const beside = wall[0] === "y" ? { x: wallCentre.x + 8, y: wallCentre.y } : { x: wallCentre.x, y: wallCentre.y + 8 }
    assert.equal(solidAtPoint(t, beside.x, beside.y, z), true, `${wall} wall must be solid beside the slot`)
    // and every OTHER wall is solid at the same height and position
    for (const other of ["y+", "y-", "x+", "x-"]) {
      if (other === wall) continue
      const m = other.endsWith("+") ? 1 : -1
      const pt = other[0] === "y" ? { x: 0, y: m * (15 + 0.2 + 0.3 + 1.2) } : { x: m * (25 + 0.2 + 0.3 + 1.2), y: 0 }
      assert.equal(solidAtPoint(t, pt.x, pt.y, z), true, `${other} wall must stay solid when the connector is on ${wall}`)
    }
  }
})

test("OPENSCAD: standoffs reach the underside of the board and have a screw hole", { skip: !haveOpenscad }, () => {
  const r = generateCase(demo(), { standoffHeight: 3 })
  const t = tris(compile(r.scad).stl).filter((tri) => Math.max(...tri.map((p) => p[0]!)) < 30)
  const ring = 2.2 / 2 + 0.1 + 0.5 // just outside the screw hole, inside the post (post radius 3.3)
  for (const [hx, hy] of [[-22, 12], [22, 12], [-22, -12], [22, -12]]) {
    // solid in the post just above the floor, and right up under the board, but not above it
    assert.equal(solidAtPoint(t, hx + ring + 0.3, hy, 2.5), true, `post at ${hx},${hy} low`)
    assert.equal(solidAtPoint(t, hx + ring + 0.3, hy, 4.9), true, `post at ${hx},${hy} reaches the board underside (floor 2 + standoff 3 = 5)`)
    assert.equal(solidAtPoint(t, hx + ring + 0.3, hy, 5.3), false, `post at ${hx},${hy} stops at the board`)
    // the screw hole down the middle is empty
    assert.equal(solidAtPoint(t, hx, hy, 3.5), false, `screw hole at ${hx},${hy}`)
  }
})

test("OPENSCAD: the lid has its screw holes, and the opening for a top-side cut-out", { skip: !haveOpenscad }, () => {
  const r = generateCase(demo())
  const t = tris(compile(r.scad).stl).filter((tri) => Math.min(...tri.map((p) => p[0]!)) > 30) // the lid only
  const lidX = r.stats.outerWidth + DEFAULT_CASE_OPTIONS.partGap // lid origin shift
  for (const [hx, hy] of [[-22, 12], [22, 12]]) {
    assert.equal(solidAtPoint(t, lidX + hx, hy, 0.5), false, "screw hole is open through the lid")
    assert.equal(solidAtPoint(t, lidX + hx + 3, hy, 0.5), true, "lid is solid beside the hole")
  }
  // the flat plate is lid_thickness; the locating lip stands lip_height above it
  const zs = t.flat().map((p) => p[2]!)
  assert.equal(Math.max(...zs), DEFAULT_CASE_OPTIONS.lidThickness + DEFAULT_CASE_OPTIONS.lipHeight)
  assert.equal(Math.min(...zs), 0)
})
