/**
 * Patches: the one way a board changes.
 *
 * Why not just hand back a new Board? Two of the three hosts (a running KiCad,
 * an EasyEDA editor tab) own the document themselves. They cannot accept "here
 * is the whole board"; they can accept "add this track, delete that one, move
 * this part". A patch is exactly that list, and it is also the undo record:
 * every op carries what is needed to invert it.
 *
 * Ops are plain JSON so a patch can cross a process boundary, an HTTP call or
 * an agent tool result unchanged.
 */
import type { Board, Footprint, MountHole, Pt, Rules, Track, Via } from "../model.ts"

export type Op =
  | { op: "add_track"; track: Track }
  | { op: "remove_track"; id: string; was?: Track }
  | { op: "add_via"; via: Via }
  | { op: "remove_via"; id: string; was?: Via }
  | { op: "add_footprint"; footprint: Footprint }
  | { op: "remove_footprint"; ref: string; was?: Footprint }
  | { op: "move_footprint"; ref: string; at: Pt; rotation: number; side: "top" | "bottom"; was?: { at: Pt; rotation: number; side: "top" | "bottom" } }
  | { op: "set_pad_net"; ref: string; pad: string; net: string; was?: string }
  | { op: "add_hole"; hole: MountHole }
  | { op: "remove_hole"; id: string; was?: MountHole }
  | { op: "set_outline"; outline: Pt[]; was?: Pt[] }
  | { op: "set_rules"; rules: Partial<Rules>; was?: Partial<Rules> }
  | { op: "add_net"; net: string }
  | { op: "remove_net"; net: string }

export interface Patch {
  ops: Op[]
  /** short human text for an undo menu or an agent log */
  label: string
}

export class PatchError extends Error {
  op: Op
  constructor(msg: string, op: Op) {
    super(msg)
    this.op = op
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/**
 * Apply a patch to a board IN PLACE and return the patch with every `was`
 * filled in, which is what makes it invertible. Applies atomically: if any op
 * fails, nothing is changed.
 */
export function applyPatch(board: Board, patch: Patch): Patch {
  const snapshot = clone(board)
  const done: Op[] = []
  try {
    for (const op of patch.ops) done.push(applyOp(board, op))
  } catch (e) {
    // restore: copy the snapshot back into the same object so callers' references stay valid
    for (const k of Object.keys(board)) delete (board as any)[k]
    Object.assign(board, snapshot)
    throw e
  }
  return { label: patch.label, ops: done }
}

function applyOp(b: Board, op: Op): Op {
  switch (op.op) {
    case "add_track": {
      if (b.tracks.some((t) => t.id === op.track.id)) throw new PatchError(`track ${op.track.id} already exists`, op)
      if (!b.copper.includes(op.track.layer)) throw new PatchError(`layer ${op.track.layer} is not on this board`, op)
      if (!(op.track.width > 0)) throw new PatchError("track width must be positive", op)
      if (op.track.net && !b.nets.includes(op.track.net)) b.nets.push(op.track.net)
      b.tracks.push(clone(op.track))
      return op
    }
    case "remove_track": {
      const i = b.tracks.findIndex((t) => t.id === op.id)
      if (i < 0) throw new PatchError(`no track ${op.id}`, op)
      const was = b.tracks[i]!
      b.tracks.splice(i, 1)
      return { op: "remove_track", id: op.id, was: clone(was) }
    }
    case "add_via": {
      if (b.vias.some((v) => v.id === op.via.id)) throw new PatchError(`via ${op.via.id} already exists`, op)
      if (op.via.net && !b.nets.includes(op.via.net)) b.nets.push(op.via.net)
      b.vias.push(clone(op.via))
      return op
    }
    case "remove_via": {
      const i = b.vias.findIndex((v) => v.id === op.id)
      if (i < 0) throw new PatchError(`no via ${op.id}`, op)
      const was = b.vias[i]!
      b.vias.splice(i, 1)
      return { op: "remove_via", id: op.id, was: clone(was) }
    }
    case "add_footprint": {
      if (b.footprints.some((f) => f.ref === op.footprint.ref)) throw new PatchError(`reference ${op.footprint.ref} already exists`, op)
      for (const p of op.footprint.pads) if (p.net && !b.nets.includes(p.net)) b.nets.push(p.net)
      b.footprints.push(clone(op.footprint))
      return op
    }
    case "remove_footprint": {
      const i = b.footprints.findIndex((f) => f.ref === op.ref)
      if (i < 0) throw new PatchError(`no footprint ${op.ref}`, op)
      const was = b.footprints[i]!
      b.footprints.splice(i, 1)
      return { op: "remove_footprint", ref: op.ref, was: clone(was) }
    }
    case "move_footprint": {
      const f = b.footprints.find((x) => x.ref === op.ref)
      if (!f) throw new PatchError(`no footprint ${op.ref}`, op)
      const was = { at: { ...f.at }, rotation: f.rotation, side: f.side }
      f.at = { ...op.at }
      f.rotation = op.rotation
      f.side = op.side
      return { ...op, was }
    }
    case "set_pad_net": {
      const f = b.footprints.find((x) => x.ref === op.ref)
      if (!f) throw new PatchError(`no footprint ${op.ref}`, op)
      const p = f.pads.find((x) => x.name === op.pad)
      if (!p) throw new PatchError(`no pad ${op.ref}.${op.pad}`, op)
      const was = p.net
      p.net = op.net
      if (op.net && !b.nets.includes(op.net)) b.nets.push(op.net)
      return { ...op, was }
    }
    case "add_hole": {
      if (b.holes.some((h) => h.id === op.hole.id)) throw new PatchError(`hole ${op.hole.id} already exists`, op)
      b.holes.push(clone(op.hole))
      return op
    }
    case "remove_hole": {
      const i = b.holes.findIndex((h) => h.id === op.id)
      if (i < 0) throw new PatchError(`no hole ${op.id}`, op)
      const was = b.holes[i]!
      b.holes.splice(i, 1)
      return { op: "remove_hole", id: op.id, was: clone(was) }
    }
    case "set_outline": {
      if (op.outline.length < 3) throw new PatchError("an outline needs at least 3 points", op)
      const was = clone(b.outline)
      b.outline = clone(op.outline)
      return { op: "set_outline", outline: op.outline, was }
    }
    case "set_rules": {
      const was: Partial<Rules> = {}
      for (const k of Object.keys(op.rules) as (keyof Rules)[]) {
        was[k] = b.rules[k]
        b.rules[k] = op.rules[k]!
      }
      return { op: "set_rules", rules: op.rules, was }
    }
    case "add_net": {
      if (!b.nets.includes(op.net)) b.nets.push(op.net)
      return op
    }
    case "remove_net": {
      const used = b.tracks.some((t) => t.net === op.net) || b.vias.some((v) => v.net === op.net) || b.footprints.some((f) => f.pads.some((p) => p.net === op.net))
      if (used) throw new PatchError(`net ${op.net} is still in use`, op)
      b.nets = b.nets.filter((n) => n !== op.net)
      return op
    }
  }
}

/** the patch that undoes `applied` (which must come from applyPatch so `was` is filled in) */
export function invert(applied: Patch): Patch {
  const ops: Op[] = []
  for (const op of [...applied.ops].reverse()) {
    switch (op.op) {
      case "add_track": ops.push({ op: "remove_track", id: op.track.id }); break
      case "remove_track": ops.push({ op: "add_track", track: need(op.was, op) }); break
      case "add_via": ops.push({ op: "remove_via", id: op.via.id }); break
      case "remove_via": ops.push({ op: "add_via", via: need(op.was, op) }); break
      case "add_footprint": ops.push({ op: "remove_footprint", ref: op.footprint.ref }); break
      case "remove_footprint": ops.push({ op: "add_footprint", footprint: need(op.was, op) }); break
      case "move_footprint": { const w = need(op.was, op); ops.push({ op: "move_footprint", ref: op.ref, at: w.at, rotation: w.rotation, side: w.side }); break }
      case "set_pad_net": ops.push({ op: "set_pad_net", ref: op.ref, pad: op.pad, net: need(op.was, op, true) }); break
      case "add_hole": ops.push({ op: "remove_hole", id: op.hole.id }); break
      case "remove_hole": ops.push({ op: "add_hole", hole: need(op.was, op) }); break
      case "set_outline": ops.push({ op: "set_outline", outline: need(op.was, op) }); break
      case "set_rules": ops.push({ op: "set_rules", rules: need(op.was, op) }); break
      case "add_net": ops.push({ op: "remove_net", net: op.net }); break
      case "remove_net": ops.push({ op: "add_net", net: op.net }); break
    }
  }
  return { ops, label: "undo " + applied.label }
}

function need<T>(v: T | undefined, op: Op, allowEmptyString = false): T {
  if (v === undefined || (!allowEmptyString && (v as any) === "")) throw new PatchError("cannot invert: this patch was not produced by applyPatch", op)
  return v
}
