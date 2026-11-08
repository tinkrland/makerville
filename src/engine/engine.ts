/**
 * The Engine: the single command surface every variant talks to.
 *
 *   KiCad plugin   -> reads the open board over IPC into a Board, runs a command,
 *                     writes the returned patch back through IPC
 *   web app        -> holds a Board in the page or on a server, runs commands
 *   EasyEDA agent  -> reads the open document through the in-page `eda` API into
 *                     a Board, runs a command, replays the patch via `eda.*`
 *
 * The engine itself does no I/O and holds no global state. A command goes in as
 * JSON, a result comes out as JSON, and any change to the board is a Patch.
 * That is what lets the same code run in a browser tab, a cloud worker and a
 * KiCad plugin process.
 */
import type { Board, Footprint } from "../model.ts"
import { padWorld } from "../model.ts"
import { runDrc, type DrcResult } from "../drc/drc.ts"
import { GridAStarRouter } from "../router/grid-astar.ts"
import type { RouteOptions, Router } from "../router/types.ts"
import { writeKicadPcb, writeKicadDru } from "../kicad-write.ts"
import { readKicadPcb } from "../kicad-read.ts"
import { applyPatch, invert, type Op, type Patch } from "./patch.ts"

export type Command =
  | { cmd: "get_board" }
  | { cmd: "drc"; rules?: Partial<Board["rules"]> }
  | { cmd: "route"; router?: string; options?: Omit<RouteOptions, "onProgress">; apply?: boolean }
  | { cmd: "apply"; patch: Patch }
  | { cmd: "undo" }
  | { cmd: "redo" }
  | { cmd: "export_kicad" }
  | { cmd: "import_kicad"; text: string }
  | { cmd: "measure" }
  | { cmd: "list_routers" }
  | { cmd: "schema" }

export interface Result {
  ok: boolean
  error?: string
  /** command specific payload */
  data?: unknown
  /** present whenever the board changed, so a host can mirror it */
  patch?: Patch
  /** monotonically increasing; a host uses it to detect that it is out of sync */
  revision: number
}

export interface EngineOptions {
  routers?: Router[]
}

export class Engine {
  board: Board
  revision = 0
  private undoStack: Patch[] = []
  private redoStack: Patch[] = []
  private routers = new Map<string, Router>()

  constructor(board: Board, opts: EngineOptions = {}) {
    this.board = board
    for (const r of [new GridAStarRouter(), ...(opts.routers ?? [])]) this.routers.set(r.name, r)
  }

  /** run one command. Never throws: a failure is `{ ok:false, error }` so a transport can return it as is. */
  run(c: Command): Result {
    try {
      if (!c || typeof c !== "object") return { ok: false, error: "a command must be an object like { cmd: \"drc\" }", revision: this.revision }
      return this.dispatch(c)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), revision: this.revision }
    }
  }

  /**
   * Build a success result. Keys that have no value are left OUT rather than set to
   * undefined: JSON drops undefined keys, so a result must not differ before and
   * after it crosses a wire. `data` is copied so a caller can never mutate engine state.
   */
  private done(data?: unknown, patch?: Patch): Result {
    const r: Result = { ok: true, revision: this.revision }
    if (data !== undefined) r.data = JSON.parse(JSON.stringify(data))
    if (patch !== undefined) r.patch = patch
    return r
  }

  private change(patch: Patch): Patch {
    const applied = applyPatch(this.board, patch)
    this.undoStack.push(applied)
    this.redoStack = []
    this.revision++
    return applied
  }

  private dispatch(c: Command): Result {
    switch (c.cmd) {
      case "get_board":
        return this.done(this.board)

      case "drc": {
        const d: DrcResult = runDrc(this.board, c.rules)
        return this.done(d)
      }

      case "route": {
        const name = c.router ?? "grid-astar"
        const router = this.routers.get(name)
        if (!router) return { ok: false, error: `no router named "${name}". Available: ${[...this.routers.keys()].join(", ")}`, revision: this.revision }
        const res = router.route(this.board, c.options)
        if (!(c.apply ?? true) || (!res.ok && res.tracks.length === 0)) return this.done(res)
        const ops: Op[] = [...res.tracks.map((t): Op => ({ op: "add_track", track: t })), ...res.vias.map((v): Op => ({ op: "add_via", via: v }))]
        const patch = this.change({ label: `autoroute (${name})`, ops })
        const { tracks, vias, ...rest } = res
        return this.done({ ...rest, added: { tracks: tracks.length, vias: vias.length } }, patch)
      }

      case "apply": {
        const patch = this.change(c.patch)
        return this.done(undefined, patch)
      }

      case "undo": {
        const last = this.undoStack.pop()
        if (!last) return { ok: false, error: "nothing to undo", revision: this.revision }
        const inv = applyPatch(this.board, invert(last))
        this.redoStack.push(last)
        this.revision++
        return this.done(undefined, inv)
      }

      case "redo": {
        const next = this.redoStack.pop()
        if (!next) return { ok: false, error: "nothing to redo", revision: this.revision }
        const re = applyPatch(this.board, { label: next.label, ops: next.ops.map(stripWas) })
        this.undoStack.push(re)
        this.revision++
        return this.done(undefined, re)
      }

      case "export_kicad":
        return this.done({ pcb: writeKicadPcb(this.board), dru: writeKicadDru(this.board) })

      case "import_kicad": {
        const r = readKicadPcb(c.text)
        const patch = this.replaceBoard(r.board)
        return this.done({ skipped: r.skipped, warnings: r.warnings }, patch)
      }

      case "measure":
        return this.done(measure(this.board))

      case "list_routers":
        return this.done([...this.routers.keys()])

      case "schema":
        return this.done(SCHEMA)
    }
    return { ok: false, error: `unknown command "${(c as any)?.cmd}"`, revision: this.revision }
  }

  /** swap in a whole new board as one undoable change */
  private replaceBoard(next: Board): Patch {
    const ops: Op[] = []
    for (const t of this.board.tracks) ops.push({ op: "remove_track", id: t.id })
    for (const v of this.board.vias) ops.push({ op: "remove_via", id: v.id })
    for (const f of this.board.footprints) ops.push({ op: "remove_footprint", ref: f.ref })
    for (const h of this.board.holes) ops.push({ op: "remove_hole", id: h.id })
    ops.push({ op: "set_outline", outline: next.outline })
    ops.push({ op: "set_rules", rules: next.rules })
    for (const f of next.footprints) ops.push({ op: "add_footprint", footprint: f })
    for (const h of next.holes) ops.push({ op: "add_hole", hole: h })
    for (const t of next.tracks) ops.push({ op: "add_track", track: t })
    for (const v of next.vias) ops.push({ op: "add_via", via: v })
    return this.change({ label: "import KiCad board", ops })
  }
}

const stripWas = (op: Op): Op => {
  const { was: _w, ...rest } = op as any
  return rest as Op
}

/** What the case generator needs, and what a human wants to see: size, parts, height. */
export function measure(b: Board) {
  const xs = b.outline.map((p) => p.x)
  const ys = b.outline.map((p) => p.y)
  const top = b.footprints.filter((f) => f.side === "top")
  const bottom = b.footprints.filter((f) => f.side === "bottom")
  const tallest = (l: Footprint[]) => l.reduce((m, f) => Math.max(m, f.height), 0)
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    thickness: b.thickness,
    layers: b.copper.length,
    parts: { top: top.length, bottom: bottom.length },
    tallestTop: tallest(top),
    tallestBottom: tallest(bottom),
    holes: b.holes.map((h) => ({ id: h.id, x: h.at.x, y: h.at.y, drill: h.drill })),
    connectors: b.footprints.filter((f) => f.pads.some((p) => p.kind === "thru") && f.height >= 3).map((f) => ({ ref: f.ref, at: padWorld(f, f.pads[0]!), side: f.side })),
  }
}

/** A description of every command, so a host or an agent can discover the surface without reading code. */
export const SCHEMA = {
  version: 1,
  commands: {
    get_board: "return the whole board as JSON",
    drc: "run design rule check; optional rules override. data: { violations, errors, warnings, unconnected, ms }",
    route: "autoroute; { router?, options?, apply? }. apply defaults to true and returns the patch",
    apply: "apply a patch { label, ops[] } atomically; returns the applied patch",
    undo: "undo the last change; returns the inverse patch",
    redo: "redo the last undone change",
    export_kicad: "data: { pcb, dru } as text, KiCad 9 format",
    import_kicad: "replace the board from .kicad_pcb text, as one undoable change",
    measure: "board size, layer count, tallest parts, holes, connectors: the case generator's input",
    list_routers: "names of the available routers",
    schema: "this document",
  },
  ops: ["add_track", "remove_track", "add_via", "remove_via", "add_footprint", "remove_footprint", "move_footprint", "set_pad_net", "add_hole", "remove_hole", "set_outline", "set_rules", "add_net", "remove_net"],
} as const
