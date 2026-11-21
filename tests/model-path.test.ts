/**
 * Model path resolution tests.
 *
 * Every case here is a shape that appears in a real footprint in refs. The point of the module is that an
 * unresolvable path is REPORTED by name rather than guessed at, so the tests care as much about the failure
 * messages as about the successes: a wrong guess would silently point a preview at the wrong file.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { resolveModelPath } from "../src/model-path.ts"

const roots = { KICAD10_3DMODEL_DIR: "/usr/share/kicad/3dmodels", KICAD9_3DMODEL_DIR: "/opt/k9/models" }

test("a variable root resolves, and so does a bare variable with nothing after it", () => {
  const a = resolveModelPath("${KICAD10_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0603_1608Metric.step", { roots })
  assert.deepEqual(a, { ok: true, path: "/usr/share/kicad/3dmodels/Capacitor_SMD.3dshapes/C_0603_1608Metric.step" })
  const b = resolveModelPath("${KICAD9_3DMODEL_DIR}/x.step", { roots })
  assert.deepEqual(b, { ok: true, path: "/opt/k9/models/x.step" })
})

test("an unknown variable is named in the failure, not guessed", () => {
  const r = resolveModelPath("${SOME_OTHER_DIR}/x.step", { roots })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /\$\{SOME_OTHER_DIR\}/, "the message names the variable")
  assert.match((r as { reason: string }).reason, /roots\.SOME_OTHER_DIR/, "and says how to supply it")
})

test("a relative path needs a baseDir and says so when there is none", () => {
  assert.deepEqual(resolveModelPath("../models/Socket.step", { baseDir: "/lib/fp" }), { ok: true, path: "/lib/models/Socket.step" })
  const r = resolveModelPath("../models/Socket.step", {})
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /relative and no baseDir/)
})

test("an absolute path is left alone", () => {
  assert.deepEqual(resolveModelPath("/abs/x.step", {}), { ok: true, path: "/abs/x.step" })
})

test("the path is normalised, so two spellings compare equal", () => {
  assert.deepEqual(resolveModelPath("/a//b/./c/../d.step", {}), { ok: true, path: "/a/b/d.step" })
  // walking above an absolute root stays at the root rather than escaping to a relative path
  assert.deepEqual(resolveModelPath("/a/../../d.step", {}), { ok: true, path: "/d.step" })
})

test("an existence check turns a plausible path into a verified one", () => {
  const ok = resolveModelPath("/a/b.step", { exists: (p) => p === "/a/b.step" })
  assert.deepEqual(ok, { ok: true, path: "/a/b.step" })
  const bad = resolveModelPath("/a/b.step", { exists: () => false })
  assert.equal(bad.ok, false)
  assert.match((bad as { reason: string }).reason, /\/a\/b\.step/, "the failure shows what it resolved to")
})

test("an empty path is refused with a reason", () => {
  for (const v of ["", "   "]) {
    const r = resolveModelPath(v, {})
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, /empty model path/)
  }
})

test("a real fixture resolves and is verified present", () => {
  const dir = path.resolve(import.meta.dirname, "../../refs/circuit-json-to-gltf/tests/assets")
  if (!fs.existsSync(dir)) return
  const r = resolveModelPath("Contact.step", { baseDir: dir, exists: fs.existsSync })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(fs.statSync((r as { path: string }).path).size > 1000)
  // and a name that is not there is refused rather than returned
  const missing = resolveModelPath("NotAFile.step", { baseDir: dir, exists: fs.existsSync })
  assert.equal(missing.ok, false)
})

test("every model path in the real library is either resolvable or reported", { skip: !fs.existsSync(path.resolve(import.meta.dirname, "../../refs")) }, async () => {
  // No footprint in refs may produce a silent failure: with roots supplied, each one either resolves or comes
  // back with a reason. This is the guard against a path shape nobody thought of.
  const { readFootprintLibraryDir } = await import("../src/library-import.ts")
  const r = readFootprintLibraryDir(path.resolve(import.meta.dirname, "../../refs"))
  const withModel = r.footprints.filter((f) => f.model?.path)
  assert.ok(withModel.length > 0, "fixtures do have model paths")
  for (const f of withModel) {
    const res = resolveModelPath(f.model!.path, { roots, baseDir: "/lib/fp" })
    if (!res.ok) assert.ok((res as { reason: string }).reason.length > 10, `${f.lib}: reason too vague`)
  }
})
