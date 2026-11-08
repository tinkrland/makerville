import test from "node:test"
import assert from "node:assert/strict"
import { Engine, SCHEMA, measure, type Command } from "../src/engine/engine.ts"
import { applyPatch, type Patch } from "../src/engine/patch.ts"
import { newBoard, type Board } from "../src/model.ts"
import { crossingBoard } from "./router-kicad.ts"
import { dirtyBoard } from "./drc-kicad.ts"
import type { Router, RouteResult } from "../src/router/types.ts"

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) // everything must survive a transport

test("every command is JSON in and JSON out", () => {
  const e = new Engine(crossingBoard())
  const cmds: Command[] = [{ cmd: "get_board" }, { cmd: "drc" }, { cmd: "measure" }, { cmd: "list_routers" }, { cmd: "schema" }, { cmd: "export_kicad" }]
  for (const c of cmds) {
    const r = e.run(wire(c))
    assert.equal(r.ok, true, c.cmd + ": " + r.error)
    assert.deepEqual(wire(r), r, c.cmd + " result must be plain JSON")
  }
})

test("route applies copper, returns a patch, bumps the revision, and DRC is then clean", () => {
  const e = new Engine(crossingBoard())
  assert.equal(e.revision, 0)
  const before = (e.run({ cmd: "drc" }).data as any).unconnected.length
  assert.equal(before, 7)
  const r = e.run({ cmd: "route", options: { gridSize: 0.2 } })
  assert.equal(r.ok, true, r.error)
  assert.equal(e.revision, 1)
  assert.ok(r.patch && r.patch.ops.length > 10)
  const d = e.run({ cmd: "drc" }).data as any
  assert.equal(d.errors, 0)
  assert.equal(d.unconnected.length, 0)
})

test("route with apply:false only reports", () => {
  const e = new Engine(crossingBoard())
  const r = e.run({ cmd: "route", apply: false, options: { gridSize: 0.25 } })
  assert.equal(r.ok, true)
  assert.equal(r.patch, undefined)
  assert.equal(e.revision, 0)
  assert.equal(e.board.tracks.length, 0)
})

test("HOST SYNC: a host that only ever receives patches ends identical to the engine", () => {
  const e = new Engine(crossingBoard())
  const host: Board = clone(e.board) // the host starts from a snapshot
  const feed = (r: { patch?: Patch }) => { if (r.patch) applyPatch(host, wire(r.patch)) }
  feed(e.run({ cmd: "route", options: { gridSize: 0.25 } }))
  assert.deepEqual(host, e.board)
  feed(e.run({ cmd: "apply", patch: { label: "move", ops: [{ op: "move_footprint", ref: "R1", at: { x: -7, y: 8 }, rotation: 90, side: "top" }] } }))
  assert.deepEqual(host, e.board)
  feed(e.run({ cmd: "undo" }))
  assert.deepEqual(host, e.board)
  feed(e.run({ cmd: "undo" }))
  assert.deepEqual(host, e.board)
  feed(e.run({ cmd: "redo" }))
  assert.deepEqual(host, e.board)
  assert.equal(host.tracks.length, 0 + e.board.tracks.length)
})

test("undo/redo walk the history and run out cleanly", () => {
  const e = new Engine(newBoard("t", 20, 20))
  assert.equal(e.run({ cmd: "undo" }).ok, false)
  assert.equal(e.run({ cmd: "redo" }).ok, false)
  const add = (id: string): Command => ({ cmd: "apply", patch: { label: id, ops: [{ op: "add_track", track: { id, a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0.2, layer: "F.Cu", net: "" } }] } })
  e.run(add("a")); e.run(add("b"))
  assert.equal(e.board.tracks.length, 2)
  e.run({ cmd: "undo" })
  assert.deepEqual(e.board.tracks.map((t) => t.id), ["a"])
  e.run({ cmd: "redo" })
  assert.deepEqual(e.board.tracks.map((t) => t.id), ["a", "b"])
  e.run({ cmd: "undo" }); e.run({ cmd: "undo" })
  assert.equal(e.board.tracks.length, 0)
  assert.equal(e.run({ cmd: "undo" }).ok, false)
  // a new change after undo discards the redo branch
  e.run(add("c")); assert.equal(e.run({ cmd: "redo" }).ok, false)
})

test("a failing apply leaves the board and history untouched", () => {
  const e = new Engine(crossingBoard())
  const before = clone(e.board)
  const r = e.run({ cmd: "apply", patch: { label: "bad", ops: [{ op: "remove_track", id: "ghost" }] } })
  assert.equal(r.ok, false)
  assert.match(r.error!, /no track ghost/)
  assert.deepEqual(e.board, before)
  assert.equal(e.revision, 0)
  assert.equal(e.run({ cmd: "undo" }).ok, false, "a failed change must not enter history")
})

test("run() never throws, even on garbage", () => {
  const e = new Engine(crossingBoard())
  for (const bad of [{ cmd: "nope" }, {}, { cmd: "route", router: "missing" }, { cmd: "import_kicad", text: "not sexp" }, { cmd: "apply" }, null as any]) {
    const r = e.run(bad as any)
    assert.equal(r.ok, false)
    assert.equal(typeof r.error, "string")
  }
  assert.match(e.run({ cmd: "route", router: "missing" }).error!, /Available: grid-astar/)
})

test("routers are pluggable by name", () => {
  const fake: Router = { name: "fake", route: (): RouteResult => ({ ok: true, tracks: [{ id: "ft", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0.2, layer: "F.Cu", net: "Z" }], vias: [], unrouted: [], stats: { attempts: 1, connections: 1, routed: 1, expandedCells: 0, ms: 0 } }) }
  const e = new Engine(crossingBoard(), { routers: [fake] })
  assert.deepEqual(e.run({ cmd: "list_routers" }).data, ["grid-astar", "fake"])
  e.run({ cmd: "route", router: "fake" })
  assert.ok(e.board.tracks.some((t) => t.id === "ft"))
})

test("KiCad export -> import into a fresh engine reproduces the design", () => {
  const a = new Engine(crossingBoard())
  a.run({ cmd: "route", options: { gridSize: 0.25 } })
  const pcb = (a.run({ cmd: "export_kicad" }).data as any).pcb as string
  const b = new Engine(newBoard("empty", 10, 10))
  const imp = b.run({ cmd: "import_kicad", text: pcb })
  assert.equal(imp.ok, true, imp.error)
  assert.equal(b.board.footprints.length, a.board.footprints.length)
  assert.equal(b.board.tracks.length, a.board.tracks.length)
  assert.equal(b.board.vias.length, a.board.vias.length)
  assert.equal((b.run({ cmd: "drc" }).data as any).errors, 0)
  // import is itself undoable
  b.run({ cmd: "undo" })
  assert.equal(b.board.footprints.length, 0)
  assert.equal(b.board.outline.length, 4)
})

test("measure reports what a case needs", () => {
  const m = measure(crossingBoard())
  assert.equal(m.width, 40)
  assert.equal(m.height, 28)
  assert.equal(m.thickness, 1.6)
  assert.equal(m.holes.length, 4)
  assert.ok(m.tallestTop >= 8, "pin headers are the tallest part: " + m.tallestTop)
  assert.deepEqual(m.connectors.map((c) => c.ref).sort(), ["J1", "J2"])
})

test("schema documents every command the engine accepts", () => {
  const src = JSON.stringify(Object.keys(SCHEMA.commands).sort())
  const accepted = ["apply", "drc", "export_kicad", "get_board", "import_kicad", "list_routers", "measure", "redo", "route", "schema", "undo"]
  assert.equal(src, JSON.stringify(accepted))
})

test("two engines are independent (no hidden global state, safe to host many)", () => {
  const a = new Engine(crossingBoard()), b = new Engine(crossingBoard())
  a.run({ cmd: "route", options: { gridSize: 0.25 } })
  assert.equal(b.board.tracks.length, 0)
  assert.equal(b.revision, 0)
})

test("drc rule overrides do not stick", () => {
  const e = new Engine(dirtyBoard())
  const strict = (e.run({ cmd: "drc", rules: { clearance: 0.6 } }).data as any).violations.filter((v: any) => v.type === "clearance").length
  const normal = (e.run({ cmd: "drc" }).data as any).violations.filter((v: any) => v.type === "clearance").length
  assert.ok(strict >= normal)
  assert.equal(e.board.rules.clearance, 0.2)
})

test("results are detached: mutating a returned board cannot change the engine", () => {
  const e = new Engine(crossingBoard())
  const count = e.board.footprints.length
  assert.ok(count > 0)
  const got = e.run({ cmd: "get_board" }).data as Board
  got.footprints.length = 0
  got.rules.clearance = 99
  assert.equal(e.board.footprints.length, count)
  assert.equal(e.board.rules.clearance, 0.2)
})

test("no result ever carries an undefined key", () => {
  const e = new Engine(crossingBoard())
  const walk = (o: any, path: string): void => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { assert.notEqual(v, undefined, `${path}.${k} is undefined`); walk(v, path + "." + k) }
  }
  for (const c of [{ cmd: "get_board" }, { cmd: "drc" }, { cmd: "route", options: { gridSize: 0.25 } }, { cmd: "undo" }, { cmd: "redo" }, { cmd: "measure" }] as Command[]) walk(e.run(c), c.cmd)
})

test("EVERY change moves the revision, including undo and redo (hosts poll it to detect drift)", () => {
  const e = new Engine(crossingBoard())
  const seen = [e.revision]
  const step = (c: Command) => { const r = e.run(c); assert.equal(r.ok, true, c.cmd + ": " + r.error); assert.equal(r.revision, e.revision); seen.push(e.revision) }
  step({ cmd: "route", options: { gridSize: 0.25 } })
  step({ cmd: "apply", patch: { label: "m", ops: [{ op: "move_footprint", ref: "R1", at: { x: 1, y: 1 }, rotation: 0, side: "top" }] } })
  step({ cmd: "undo" })
  step({ cmd: "redo" })
  step({ cmd: "undo" })
  step({ cmd: "undo" })
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6], "strictly +1 per change")
  // reads and failures never move it
  const before = e.revision
  e.run({ cmd: "drc" }); e.run({ cmd: "measure" }); e.run({ cmd: "get_board" }); e.run({ cmd: "undo" })
  assert.equal(e.run({ cmd: "undo" }).ok, false)
  assert.equal(e.revision, before)
})
