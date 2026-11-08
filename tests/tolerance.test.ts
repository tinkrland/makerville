import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { newBoard } from "../src/model.ts"
import { usbCReceptacle, header } from "../src/library.ts"
import { generateCase } from "../src/case/generate.ts"
import { PROFILES, resolveTolerances, screwHoleDiameter, insertHoleDiameter } from "../src/case/tolerance.ts"
import { loadStl, solidAt, transitionsAlongX, transitionsAlongY, type Tri } from "./stl-probe.ts"

function board() {
  const b = newBoard("tol", 50, 30)
  b.footprints.push(usbCReceptacle("J1", { at: { x: 0, y: 11 }, rotation: 180 }), header("J2", 4, 1, { at: { x: 18, y: 0 } }))
  b.holes.push({ id: "H1", at: { x: -22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 22, y: 12 }, drill: 2.2, pad: 4 }, { id: "H3", at: { x: -22, y: -12 }, drill: 2.2, pad: 4 }, { id: "H4", at: { x: 22, y: -12 }, drill: 2.2, pad: 4 })
  return b
}
const errors = (r: ReturnType<typeof generateCase>) => r.warnings.filter((w) => w.level === "error").map((w) => w.message)
const near = (a: number, b: number, e = 0.005, m = "") => assert.ok(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`)

// ---------- the profile maths, no OpenSCAD needed
test("ideal is all zeros: exact CAD dimensions", () => {
  const t = resolveTolerances("ideal")
  for (const k of ["slip", "opening", "screwHole", "verticalHoleExtra", "mating", "insertHole"] as const) assert.equal(t[k], 0, k)
})

test("every real profile only ever ADDS clearance (a hole or cavity is never made smaller)", () => {
  for (const [name, p] of Object.entries(PROFILES))
    for (const k of ["slip", "opening", "screwHole", "verticalHoleExtra", "mating", "insertHole"] as const) assert.ok(p[k] >= 0, `${name}.${k}`)
})

test("looser profiles are looser: ideal < resin < fdm < fdm-loose on every clearance", () => {
  const order = ["ideal", "resin", "fdm", "fdmLoose"] as const
  for (const k of ["slip", "opening", "screwHole", "mating"] as const)
    for (let i = 1; i < order.length; i++) assert.ok(PROFILES[order[i]!][k] >= PROFILES[order[i - 1]!][k], `${k}: ${order[i]} should be >= ${order[i - 1]}`)
})

test("screw hole diameter = screw + clearance + vertical closing-up allowance", () => {
  const t = PROFILES.fdm
  assert.equal(screwHoleDiameter(2, t), 2 + 0.2 + 0.15)
  assert.equal(screwHoleDiameter(2, t, false), 2 + 0.2, "a horizontal hole does not close up as much")
  assert.equal(screwHoleDiameter(3, PROFILES.ideal), 3)
  assert.equal(insertHoleDiameter(3.2, t), 3.2 + 0.1 + 0.15)
})

test("overrides win over the profile, and unknown profiles are refused", () => {
  assert.equal(resolveTolerances("fdm", { slip: 0.45 }).slip, 0.45)
  assert.equal(resolveTolerances("fdm", { slip: 0.45 }).opening, PROFILES.fdm.opening)
  assert.throws(() => resolveTolerances("nope" as any), /unknown tolerance profile "nope"/)
})

test("a negative or absurd tolerance is refused, naming the field", () => {
  assert.throws(() => resolveTolerances("fdm", { slip: -0.1 }), /"slip" must be zero or more/)
  assert.throws(() => resolveTolerances("fdm", { screwHole: NaN }), /screwHole/)
  assert.throws(() => resolveTolerances("fdm", { slip: 5 }), /millimetres, not percent/)
})

test("a bad tolerance in the generator is a hard error, not a silent fallback", () => {
  const r = generateCase(board(), { tolerances: { slip: -1 } })
  assert.equal(r.ok, false)
  assert.match(errors(r)[0]!, /"slip" must be zero or more/)
})

test("the numbers appear in the scad as named, editable parameters", () => {
  const s = generateCase(board()).scad
  for (const p of ["tol_slip", "tol_opening", "tol_screw_hole", "tol_vertical_hole", "tol_mating", "lip_height", "lip_thickness"]) assert.match(s, new RegExp(`^${p}\\s*=`, "m"), p)
  assert.match(s, /\/\* \[Print tolerances: fdm\] \*\//)
  assert.match(s, /^tol_slip\s*=\s*0\.3;/m)
  assert.match(generateCase(board(), { profile: "ideal" }).scad, /^tol_slip\s*=\s*0;/m)
})

test("the fdm profile changes the file, ideal differs from it, and each is stable", () => {
  const a = generateCase(board()).scad, b = generateCase(board(), { profile: "ideal" }).scad
  assert.notEqual(a, b)
  assert.equal(generateCase(board(), { profile: "ideal" }).scad, b)
})

test("a custom tolerance object works as a profile", () => {
  const r = generateCase(board(), { profile: { ...PROFILES.fdm, name: "my-printer", slip: 0.12 } })
  assert.match(r.scad, /\[Print tolerances: my-printer\]/)
  assert.match(r.scad, /^tol_slip\s*=\s*0\.12;/m)
})

test("WARNING when a wall is thinner than the printer can make; ideal never warns", () => {
  assert.ok(generateCase(board(), { wallThickness: 0.5 }).warnings.some((w) => /thinner than the 0\.8 mm/.test(w.message)))
  // the ideal profile's minimum feature is 0.4, so a 0.5 mm wall is fine there but 0.3 is not
  assert.ok(!generateCase(board(), { wallThickness: 0.5, profile: "ideal" }).warnings.some((w) => /walls of/.test(w.message)))
  assert.ok(generateCase(board(), { wallThickness: 0.3, profile: "ideal" }).warnings.some((w) => /walls of 0\.3 mm are thinner than the 0\.4 mm/.test(w.message)))
  assert.ok(generateCase(board(), { wallThickness: 1.0 }).warnings.every((w) => !/walls of/.test(w.message)))
})

test("ERROR when the lid lip would break through the wall", () => {
  const r = generateCase(board(), { wallThickness: 1.5, lipThickness: 1.4 })
  assert.equal(r.ok, false)
  assert.match(errors(r).join(" "), /lid lip .* is as thick as the wall/)
  assert.equal(generateCase(board(), { wallThickness: 1.5, lipThickness: 1.4, lipHeight: 0 }).ok, true, "no lip, no problem")
})

// ---------- the compiled geometry
const have = spawnSync("openscad", ["--version"], { encoding: "utf8" })
const haveOpenscad = /OpenSCAD/.test(have.stderr + have.stdout)
function mesh(scad: string): Tri[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tol-"))
  fs.writeFileSync(path.join(dir, "c.scad"), scad)
  spawnSync("openscad", ["-o", path.join(dir, "c.stl"), path.join(dir, "c.scad")], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen" }, timeout: 240000 })
  return loadStl(fs.readFileSync(path.join(dir, "c.stl"), "utf8"))
}
const trayOnly = (t: Tri[]) => t.filter((tri) => Math.max(...tri.map((p) => p[0]!)) < 40)
const lidOnly = (t: Tri[]) => t.filter((tri) => Math.min(...tri.map((p) => p[0]!)) > 30)

test("MEASURED: the cavity is exactly the board plus margin + slip on every side", { skip: !haveOpenscad }, () => {
  for (const [profile, slip] of [["ideal", 0], ["fdm", 0.3], ["fdmLoose", 0.5]] as const) {
    const r = generateCase(board(), { profile, margin: 0.2, wallThickness: 2.4 })
    const t = trayOnly(mesh(r.scad))
    const z = 8 // well above the floor, below the top, between standoffs
    const gap = 0.2 + slip
    const xs = transitionsAlongX(t, 0, z, -40, 40)
    // outer left, inner left, inner right, outer right
    near(xs[1]!, -25 - gap, 0.005, `${profile} inner left`)
    near(xs[2]!, 25 + gap, 0.005, `${profile} inner right`)
    near(xs[1]! - xs[0]!, 2.4, 0.005, `${profile} wall thickness`)
    const ys = transitionsAlongY(t, 10, z, -30, 30) // x=10 avoids the USB slot at x=0
    near(ys[2]! - ys[1]!, 30 + 2 * gap, 0.006, `${profile} cavity height`)
  }
})

test("MEASURED: the board fits in the cavity with a positive gap, ideal fits with zero extra", { skip: !haveOpenscad }, () => {
  const fit = (profile: "ideal" | "fdm") => {
    const t = trayOnly(mesh(generateCase(board(), { profile, margin: 0 }).scad))
    const xs = transitionsAlongX(t, 0, 8, -40, 40)
    return xs[2]! - xs[1]! - 50 // cavity width minus board width
  }
  near(fit("ideal"), 0, 0.006, "ideal with margin 0 is an exact-size cavity")
  near(fit("fdm"), 0.6, 0.006, "fdm leaves 0.3 each side")
})

test("MEASURED: the lid's lip is smaller than the cavity by exactly the mating gap each side", { skip: !haveOpenscad }, () => {
  for (const [profile, mating] of [["ideal", 0], ["fdm", 0.2], ["fdmLoose", 0.35]] as const) {
    const r = generateCase(board(), { profile, margin: 0.2, lipHeight: 2, lipThickness: 1.2 })
    const all = mesh(r.scad)
    const tray = trayOnly(all), lid = lidOnly(all)
    const slip = PROFILES[profile].slip
    const cavityHalf = 25 + 0.2 + slip
    const trayXs = transitionsAlongX(tray, 0, 8, -40, 40)
    near(trayXs[2]!, cavityHalf, 0.006, `${profile} cavity edge`)
    // in the lid (shifted right), sample the lip's height band (above the plate, z = lid_thickness + 1)
    const shift = r.stats.outerWidth + 10
    const lipZ = 2 + 1
    const lx = transitionsAlongX(lid, 5, lipZ, shift - 40, shift + 40).map((x) => x - shift)
    // the lip is a rim: outer-left, inner-left, inner-right, outer-right
    assert.equal(lx.length, 4, `${profile} lip crossings: ${lx}`)
    near(lx[3]!, cavityHalf - mating, 0.006, `${profile} lip outer face`)
    near(lx[0]!, -(cavityHalf - mating), 0.006, `${profile} lip outer face (left)`)
    near(lx[3]! - lx[2]!, 1.2, 0.006, `${profile} lip thickness`)
    // the lip fits: its outer face is inside the cavity wall by the mating gap
    near(trayXs[2]! - lx[3]!, mating, 0.008, `${profile} fit gap`)
  }
})

test("MEASURED: a screw hole through the lid has the diameter the profile promises", { skip: !haveOpenscad }, () => {
  for (const profile of ["ideal", "fdm", "fdmLoose"] as const) {
    const r = generateCase(board(), { profile })
    const lid = lidOnly(mesh(r.scad))
    const shift = r.stats.outerWidth + 10
    const want = screwHoleDiameter(2.2, PROFILES[profile])
    const xs = transitionsAlongX(lid, 12, 1, shift - 22 - 4, shift - 22 + 4, 0.02) // across H1 at x=-22, y=12
    assert.equal(xs.length, 2, `${profile}: ${xs}`)
    near(xs[1]! - xs[0]!, want, 0.02, `${profile} hole diameter`)
  }
})

test("MEASURED: the standoff's screw hole is the diameter the profile promises", { skip: !haveOpenscad }, () => {
  for (const profile of ["ideal", "fdm"] as const) {
    const t = trayOnly(mesh(generateCase(board(), { profile }).scad))
    const want = screwHoleDiameter(2.2, PROFILES[profile])
    const xs = transitionsAlongX(t, 12, 4, -22 - 3, -22 + 3, 0.02)
    near(xs[1]! - xs[0]!, want, 0.02, `${profile} standoff hole`)
  }
})

test("MEASURED: the USB opening is bigger than the connector by the opening tolerance on each side", { skip: !haveOpenscad }, () => {
  for (const profile of ["ideal", "fdm", "fdmLoose"] as const) {
    const r = generateCase(board(), { profile })
    const t = trayOnly(mesh(r.scad))
    const open = PROFILES[profile].opening
    const wallY = 15 + 0.2 + PROFILES[profile].slip + 1.2 // middle of the y+ wall
    const z = 2 + 3 + 1.6 + 1.63
    const xs = transitionsAlongX(t, wallY, z, -12, 12, 0.02)
    assert.equal(xs.length, 2, `${profile}: ${xs}`)
    near(xs[1]! - xs[0]!, 8.94 + 2 * open, 0.02, `${profile} opening width`)
  }
})

test("MEASURED: the same board, three profiles, strictly growing outer size", { skip: !haveOpenscad }, () => {
  const w = (p: "ideal" | "fdm" | "fdmLoose") => generateCase(board(), { profile: p }).stats.outerWidth
  assert.ok(w("ideal") < w("fdm") && w("fdm") < w("fdmLoose"), `${w("ideal")} ${w("fdm")} ${w("fdmLoose")}`)
})
