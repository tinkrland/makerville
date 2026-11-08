import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { canonicalStlHash } from "../specs/run.ts"

const have = spawnSync("openscad", ["--version"], { encoding: "utf8" })
const haveOpenscad = /OpenSCAD/.test(have.stderr + have.stdout)

const stl = (facets: number[][][]) =>
  "solid x\n" + facets.map((f) => `  facet normal 0 0 1\n    outer loop\n${f.map((v) => `      vertex ${v.join(" ")}`).join("\n")}\n    endloop\n  endfacet`).join("\n") + "\nendsolid x\n"

const A = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
const B = [[1, 0, 0], [1, 1, 0], [0, 1, 0]]

test("canonical hash ignores facet order", () => {
  assert.equal(canonicalStlHash(stl([A, B])), canonicalStlHash(stl([B, A])))
})

test("canonical hash ignores which vertex a triangle starts at", () => {
  const rotated = [A[1]!, A[2]!, A[0]!]
  assert.equal(canonicalStlHash(stl([A, B])), canonicalStlHash(stl([rotated, B])))
})

test("canonical hash ignores noise below a micron but sees a 2 micron change", () => {
  const nudge = (d: number) => A.map(([x, y, z]) => [x! + d, y!, z!])
  assert.equal(canonicalStlHash(stl([A])), canonicalStlHash(stl([nudge(0.0002)])), "0.2 micron is noise")
  assert.notEqual(canonicalStlHash(stl([A])), canonicalStlHash(stl([nudge(0.002)])), "2 micron is a change")
})

test("canonical hash sees a missing facet and a moved vertex, but not winding order", () => {
  const base = canonicalStlHash(stl([A, B]))
  assert.notEqual(base, canonicalStlHash(stl([A])), "missing facet")
  assert.notEqual(base, canonicalStlHash(stl([A, [[1, 0, 0], [1, 1, 0], [0, 1, 0.5]]])), "moved vertex")
  assert.equal(canonicalStlHash(stl([A, B])), canonicalStlHash(stl([A, [B[2]!, B[1]!, B[0]!]])), "winding is not part of the hash (a mirrored file compares equal)")
})

test("-0 and 0 hash the same (OpenSCAD writes both)", () => {
  assert.equal(canonicalStlHash(stl([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]])), canonicalStlHash(stl([[[-0, -0, 0], [1, -0, 0], [-0, 1, 0]]])))
})

test("the SAME scad compiled from two different directories gives the same hash (the path-dependence keeberia found)", { skip: !haveOpenscad }, () => {
  const scad = "difference(){cube([10,10,5]);translate([5,5,-1])cylinder(h=7,d=3,$fn=48);}"
  const hash = (name: string) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gold-")), name, "deeper")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "x.scad"), scad)
    spawnSync("openscad", ["-o", path.join(dir, "x.stl"), path.join(dir, "x.scad")], { env: { ...process.env, QT_QPA_PLATFORM: "offscreen" } })
    const raw = fs.readFileSync(path.join(dir, "x.stl"), "utf8")
    return { raw, h: canonicalStlHash(raw) }
  }
  const a = hash("one"), b = hash("a-much-longer-directory-name")
  assert.equal(a.h, b.h)
})

test("a forged STL hash in the manifest is reported as a geometry mismatch, not a text mismatch", { skip: !haveOpenscad }, () => {
  const root = path.resolve(import.meta.dirname, "..")
  const manifest = path.join(root, "specs", "goldens", "manifest.json")
  const original = fs.readFileSync(manifest, "utf8")
  try {
    const m = JSON.parse(original)
    m["l-shape"].stlSha = "0000000000000000"
    fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n")
    const r = spawnSync("node", ["--experimental-strip-types", path.join(root, "specs", "run.ts")], { encoding: "utf8", cwd: root, timeout: 290000 })
    assert.equal(r.status, 1)
    const line = r.stdout.split("\n").find((l) => l.startsWith("FAIL l-shape"))!
    assert.match(line, /same scad, different geometry/)
    assert.match(r.stdout, /ok\s+usb-header /, "the other boards still pass")
  } finally {
    fs.writeFileSync(manifest, original)
  }
})
