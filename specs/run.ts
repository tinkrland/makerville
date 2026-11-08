// Golden-master suite for the case generator: geometry changes have to prove themselves.
//
// Two layers per reference board, the same contract keeberia's paracraft engine uses (see NOTICE.md):
//   1. scad bytes  the codegen contract. Deterministic text, reviewable as a diff.
//   2. stl hash    the geometry contract. Same scad but different geometry means the OpenSCAD kernel
//                  moved under us; the manifest records which version blessed each golden.
//
//   node --experimental-strip-types specs/run.ts            compare, exit 1 on any mismatch
//   node --experimental-strip-types specs/run.ts --update   bless: rewrite goldens + manifest
//
// A mismatch is not always a bug. An intentional geometry change is re-blessed with --update, and the
// commit message says why. What this catches is the unintentional kind.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { generateCase } from "../src/case/generate.ts"
import { BOARDS } from "./boards.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GOLDENS = path.join(HERE, "goldens")
const MANIFEST = path.join(GOLDENS, "manifest.json")

const sha = (d: string | Buffer) => crypto.createHash("sha256").update(d).digest("hex").slice(0, 16)

/**
 * Canonical STL hash. OpenSCAD's raw STL bytes depend on the path the file was compiled from, and on
 * facet order. So hash a normal form instead: every vertex rounded to 1 micron, every facet reduced to
 * its three rounded vertices in sorted order, the facet list sorted. Path- and machine-independent,
 * and any real change above a micron still moves it.
 */
export function canonicalStlHash(stlText: string): string {
  const v = [...stlText.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => [m[1], m[2], m[3]].map((n) => (Math.round(Number(n) * 1000) / 1000 + 0).toFixed(3)).join(" "))
  const facets: string[] = []
  for (let i = 0; i + 2 < v.length; i += 3) facets.push([v[i]!, v[i + 1]!, v[i + 2]!].sort().join(" | "))
  facets.sort()
  return sha(facets.join("\n") + `\n#facets=${facets.length}`)
}

export function openscadVersion(): string | null {
  const r = spawnSync("openscad", ["--version"], { encoding: "utf8" })
  const t = (r.stdout + r.stderr).trim().split("\n")[0]
  return /OpenSCAD/.test(t ?? "") ? t! : null
}

export function compileHash(scad: string): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-golden-"))
  fs.writeFileSync(path.join(dir, "g.scad"), scad)
  const r = spawnSync("openscad", ["-o", path.join(dir, "g.stl"), path.join(dir, "g.scad")], { encoding: "utf8", env: { ...process.env, QT_QPA_PLATFORM: "offscreen" }, timeout: 240000 })
  const stl = path.join(dir, "g.stl")
  if (!fs.existsSync(stl)) { console.error(r.stderr); return null }
  return canonicalStlHash(fs.readFileSync(stl, "utf8"))
}

type Entry = { name: string; scadSha: string; stlSha: string | null; openscad: string; blessedAt: string }

if (import.meta.url === `file://${process.argv[1]}`) {
  const UPDATE = process.argv.includes("--update")
  const version = openscadVersion()
  fs.mkdirSync(GOLDENS, { recursive: true })
  const old: Record<string, Entry> = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : {}
  const next: Record<string, Entry> = {}
  let failures = 0

  for (const [name, make, opts] of BOARDS) {
    const r = generateCase(make(), opts ?? {})
    const errs = r.warnings.filter((w) => w.level === "error")
    if (errs.length) { console.log(`FAIL ${name}: the generator reported errors: ${errs.map((e) => e.message).join("; ")}`); failures++; continue }
    const scadSha = sha(r.scad)
    const stlSha = version ? compileHash(r.scad) : null
    const goldenPath = path.join(GOLDENS, `case-${name}.scad`)

    if (UPDATE) {
      fs.writeFileSync(goldenPath, r.scad)
      next[name] = { name, scadSha, stlSha, openscad: version ?? "unavailable", blessedAt: new Date().toISOString().slice(0, 10) }
      console.log(`blessed ${name}  scad ${scadSha}  stl ${stlSha ?? "skipped"}`)
      continue
    }
    const m = old[name]
    if (!m || !fs.existsSync(goldenPath)) { console.log(`FAIL ${name}: no golden on record (run with --update to bless)`); failures++; continue }
    if (fs.readFileSync(goldenPath, "utf8") !== r.scad) { console.log(`FAIL ${name}: scad drifted from the golden (${scadSha} vs ${m.scadSha}). Diff it, or re-bless with --update if intended.`); failures++; continue }
    if (m.stlSha && stlSha && m.stlSha !== stlSha) { console.log(`FAIL ${name}: same scad, different geometry (${stlSha} vs ${m.stlSha}). The OpenSCAD kernel or flags changed (blessed with ${m.openscad}, now ${version}).`); failures++; continue }
    console.log(`ok   ${name}  scad ${scadSha}  stl ${stlSha ?? "skipped (no openscad)"}`)
  }
  if (UPDATE) {
    fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + "\n")
    console.log(`\nmanifest written: ${Object.keys(next).length} boards, ${version ?? "no openscad"}`)
  } else {
    console.log(failures ? `\n${failures} of ${BOARDS.length} FAILED` : `\nall ${BOARDS.length} golden cases match`)
    process.exit(failures ? 1 : 0)
  }
}
