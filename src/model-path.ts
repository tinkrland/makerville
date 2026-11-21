/**
 * Resolving a footprint's 3D model path to a file that exists.
 *
 * Model paths in real footprints come in three shapes, and only the first is usable as-is:
 *
 *   ${KICAD10_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0603_1608Metric.step   a variable root
 *   ../models/Socket.step                                                  relative to the footprint file
 *   /usr/share/kicad/3dmodels/...                                          already absolute
 *
 * The variable form is the common one, and the variable is a KiCad configuration value rather than anything we
 * can discover: there is no runtime network access and no KiCad install to interrogate. So the caller supplies
 * the roots, and an unresolved variable is reported by name instead of being guessed at.
 *
 * This is deliberately pure: the filesystem check is injected, so the logic is testable without files on disk
 * and the same code works in a browser shell where `fs` does not exist.
 */
import { posix } from "node:path"

export interface ModelPathOptions {
  /** variable name to directory, for example { KICAD10_3DMODEL_DIR: "/usr/share/kicad/3dmodels" } */
  roots?: Record<string, string>
  /** directory to resolve relative paths against, usually the footprint file's own directory */
  baseDir?: string
  /** existence check; when omitted, resolution succeeds without verifying the file is there */
  exists?: (abs: string) => boolean
}

export type ModelPathResult = { ok: true; path: string } | { ok: false; reason: string }

const VAR = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?:\/|$)/

/** collapse `//`, `.` and `..` so two spellings of the same path compare equal */
function clean(p: string): string {
  const abs = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!abs) out.push("..")
      continue
    }
    out.push(seg)
  }
  return (abs ? "/" : "") + out.join("/")
}

export function resolveModelPath(modelPath: string, opts: ModelPathOptions = {}): ModelPathResult {
  const raw = (modelPath ?? "").trim()
  if (!raw) return { ok: false, reason: "the footprint has an empty model path" }

  let p = raw
  const m = VAR.exec(raw)
  if (m) {
    const name = m[1]!
    const root = opts.roots?.[name]
    if (!root) {
      return { ok: false, reason: `no directory known for \${${name}}; supply roots.${name} to resolve it` }
    }
    p = posix.join(root, raw.slice(m[0].length))
  } else if (!raw.startsWith("/")) {
    if (!opts.baseDir) return { ok: false, reason: `"${raw}" is relative and no baseDir was given` }
    p = posix.join(opts.baseDir, raw)
  }

  const path = clean(p)
  if (opts.exists && !opts.exists(path)) return { ok: false, reason: `resolved to ${path}, which does not exist` }
  return { ok: true, path }
}
