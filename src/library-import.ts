/**
 * Importing a whole footprint library: many `.kicad_mod` files into one list of Footprints.
 *
 * Two shapes, on purpose. `readFootprintLibrary` takes the file contents and is pure, so the interesting logic
 * (one bad file must not sink the rest, duplicate names must be visible, mounting holes go to their own list)
 * is testable without touching disk. `readFootprintLibraryDir` is the thin Node wrapper that walks a directory
 * and reads the files. A browser shell can call the pure one with contents it fetched however it likes.
 *
 * Nothing here throws on a bad file. A library of a thousand footprints that stops at the first malformed one is
 * useless, so problems are collected and reported by file name.
 */
import fs from "node:fs"
import path from "node:path"
import type { Board, Footprint } from "./model.ts"
import { readKicadMod } from "./kicad-read.ts"

export interface LibraryEntry {
  /** file name or path, used only for reporting */
  name: string
  text: string
}

export interface LibraryProblem {
  name: string
  message: string
}

export interface LibraryResult {
  footprints: Footprint[]
  /** mounting holes and similar, which are not placeable footprints */
  holes: Board["holes"]
  problems: LibraryProblem[]
  /** footprint names that appeared more than once, in first-seen order */
  duplicates: string[]
}

export function readFootprintLibrary(entries: LibraryEntry[]): LibraryResult {
  const footprints: Footprint[] = []
  const holes: Board["holes"] = []
  const problems: LibraryProblem[] = []
  const seen = new Map<string, number>()
  const duplicates: string[] = []

  for (const e of entries) {
    let r
    try {
      r = readKicadMod(e.text)
    } catch (err) {
      problems.push({ name: e.name, message: (err as Error).message })
      continue
    }
    if (r.hole) {
      holes.push(r.hole)
      continue
    }
    if (!r.footprint) {
      problems.push({ name: e.name, message: "file produced neither a footprint nor a hole" })
      continue
    }
    const n = (seen.get(r.footprint.lib) ?? 0) + 1
    seen.set(r.footprint.lib, n)
    if (n === 2) duplicates.push(r.footprint.lib)
    footprints.push(r.footprint)
  }
  return { footprints, holes, problems, duplicates }
}

/**
 * Read every `.kicad_mod` under a directory. Sorted by path so an import is reproducible: the same tree gives
 * the same order, and therefore the same ids, on every machine.
 */
export function readFootprintLibraryDir(dir: string): LibraryResult {
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".kicad_mod")) files.push(p)
    }
  }
  walk(dir)
  const entries: LibraryEntry[] = []
  const problems: LibraryProblem[] = []
  for (const f of files) {
    try {
      entries.push({ name: path.relative(dir, f), text: fs.readFileSync(f, "latin1") })
    } catch (err) {
      problems.push({ name: path.relative(dir, f), message: `could not read: ${(err as Error).message}` })
    }
  }
  const r = readFootprintLibrary(entries)
  return { ...r, problems: [...problems, ...r.problems] }
}
