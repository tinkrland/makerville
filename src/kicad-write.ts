/**
 * Board -> .kicad_pcb (KiCad 9 format, version 20241229).
 *
 * Own implementation. The reference converters were read for the file layout
 * and for the pitfalls they handle; nothing is imported from them.
 *
 * Coordinates: the model is y-up; KiCad is y-down. flipY happens here and only
 * here. The whole board is also shifted so it sits in the middle of an A4
 * sheet (KiCad's page), otherwise it opens off-screen in the corner.
 */
import type { Board, Footprint, Pad, Pt } from "./model.ts"
import { padWorld } from "./model.ts"
import { type List, type Node, num, sym, str, write } from "./sexp.ts"

export const KICAD_PCB_VERSION = "20241229"
const PAGE_CENTER: Pt = { x: 148.5, y: 105 } // A4 landscape, mm

/** deterministic uuid from a string, so saving the same board twice is a no-diff */
export function uuidFrom(s: string): string {
  // two independent 32 bit FNV-1a style hashes, spread to 128 bits
  const words: number[] = []
  for (let k = 0; k < 4; k++) {
    let h = (0x811c9dc5 ^ (k * 0x9e3779b1)) >>> 0
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    h ^= h >>> 15
    h = Math.imul(h, 0x2c1b3c6d) >>> 0
    h ^= h >>> 12
    words.push(h >>> 0)
  }
  const hex = words.map((w) => w.toString(16).padStart(8, "0")).join("")
  // set version 4 and variant bits so every KiCad version accepts it
  const v = hex.slice(0, 12) + "4" + hex.slice(13, 16) + ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 32)
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}

const A = (...xs: (string | number | Node)[]): List =>
  xs.map((x) => (typeof x === "number" ? num(x) : typeof x === "string" ? sym(x) : x))
const S = (...xs: (string | number | Node)[]): List => A(...xs)
const q = (s: string) => str(s)

export interface WriteOptions {
  /** stroke width of Edge.Cuts lines */
  edgeWidth?: number
  /** keep the board where it is in model coordinates instead of centring on the page */
  noRecentre?: boolean
}

export function writeKicadPcb(b: Board, opts: WriteOptions = {}): string {
  const edgeWidth = opts.edgeWidth ?? 0.1
  const origin: Pt = opts.noRecentre ? { x: 0, y: 0 } : PAGE_CENTER
  // model (x, y-up) -> kicad (x, y-down)
  const P = (p: Pt): Pt => ({ x: origin.x + p.x, y: origin.y - p.y })

  const netId = new Map<string, number>([["", 0]])
  for (const n of b.nets) if (!netId.has(n)) netId.set(n, netId.size)
  // a net used by an object but missing from b.nets must still get an id
  const useNet = (n: string) => {
    if (!netId.has(n)) netId.set(n, netId.size)
    return netId.get(n)!
  }
  for (const t of b.tracks) useNet(t.net)
  for (const v of b.vias) useNet(v.net)
  for (const f of b.footprints) for (const p of f.pads) useNet(p.net)

  const root: List = [sym("kicad_pcb")]
  root.push(S("version", KICAD_PCB_VERSION))
  root.push(S("generator", q("boardforge")))
  root.push(S("generator_version", q("0.1")))
  root.push(S("general", S("thickness", b.thickness), S("legacy_teardrops", "no")))
  root.push(S("paper", q("A4")))

  // ---- layers: copper first with KiCad's fixed indices, then the technical ones
  const layers: List = [sym("layers")]
  b.copper.forEach((name, i) => {
    const idx = name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : 2 * (i + 2) // In1.Cu = 4, In2.Cu = 6 ...
    layers.push(S(idx, q(name), "signal"))
  })
  const tech: [number, string, string, string?][] = [
    [9, "F.Adhes", "user", "F.Adhesive"],
    [11, "B.Adhes", "user", "B.Adhesive"],
    [13, "F.Paste", "user"],
    [15, "B.Paste", "user"],
    [5, "F.SilkS", "user", "F.Silkscreen"],
    [7, "B.SilkS", "user", "B.Silkscreen"],
    [1, "F.Mask", "user"],
    [3, "B.Mask", "user"],
    [17, "Dwgs.User", "user", "User.Drawings"],
    [19, "Cmts.User", "user", "User.Comments"],
    [21, "Eco1.User", "user", "User.Eco1"],
    [23, "Eco2.User", "user", "User.Eco2"],
    [25, "Edge.Cuts", "user"],
    [27, "Margin", "user"],
    [31, "F.CrtYd", "user", "F.Courtyard"],
    [29, "B.CrtYd", "user", "B.Courtyard"],
    [35, "F.Fab", "user"],
    [33, "B.Fab", "user"],
  ]
  for (const [idx, name, type, user] of tech) layers.push(user ? S(idx, q(name), type, q(user)) : S(idx, q(name), type))
  root.push(layers)

  root.push(
    S(
      "setup",
      S("pad_to_mask_clearance", 0),
      S("allow_soldermask_bridges_in_footprints", "no"),
      S("pcbplotparams", S("layerselection", "0x00000000_00000000_55555555_5755f5ff"), S("plot_on_all_layers_selection", "0x00000000_00000000_00000000_00000000"), S("outputformat", 1), S("usegerberextensions", "no")),
    ),
  )

  // ---- nets
  for (const [name, id] of [...netId.entries()].sort((a, c) => a[1] - c[1])) root.push(S("net", id, q(name)))

  // ---- footprints
  for (const f of b.footprints) root.push(footprintNode(f, P, useNet))

  // ---- tracks and vias
  for (const t of b.tracks) {
    const a = P(t.a)
    const c = P(t.b)
    root.push(S("segment", S("start", a.x, a.y), S("end", c.x, c.y), S("width", t.width), S("layer", q(t.layer)), S("net", useNet(t.net)), S("uuid", q(uuidFrom("seg:" + t.id)))))
  }
  for (const v of b.vias) {
    const p = P(v.at)
    root.push(S("via", S("at", p.x, p.y), S("size", v.diameter), S("drill", v.drill), S("layers", q(v.from), q(v.to)), S("net", useNet(v.net)), S("uuid", q(uuidFrom("via:" + v.id)))))
  }

  // ---- mounting holes as real footprints, so KiCad's 3D viewer and DRC see them
  for (const h of b.holes) {
    const p = P(h.at)
    root.push(
      S(
        "footprint",
        q("MountingHole:MountingHole"),
        S("layer", q("F.Cu")),
        S("uuid", q(uuidFrom("hole:" + h.id))),
        S("at", p.x, p.y),
        S("attr", "exclude_from_pos_files", "exclude_from_bom"),
        S("property", q("Reference"), q(h.id), S("at", 0, -(h.pad / 2 + 1)), S("layer", q("F.SilkS")), S("hide", "yes"), S("uuid", q(uuidFrom("holeref:" + h.id))), S("effects", S("font", S("size", 1, 1), S("thickness", 0.15)))),
        S("pad", q(""), "thru_hole", "circle", S("at", 0, 0), S("size", h.pad, h.pad), S("drill", h.drill), S("layers", q("*.Cu"), q("*.Mask")), S("uuid", q(uuidFrom("holepad:" + h.id)))),
      ),
    )
  }

  // ---- board outline and cut-outs on Edge.Cuts
  const ring = (poly: Pt[], tag: string) => {
    for (let i = 0; i < poly.length; i++) {
      const a = P(poly[i]!)
      const c = P(poly[(i + 1) % poly.length]!)
      if (a.x === c.x && a.y === c.y) continue
      root.push(S("gr_line", S("start", a.x, a.y), S("end", c.x, c.y), S("stroke", S("width", edgeWidth), S("type", "default")), S("layer", q("Edge.Cuts")), S("uuid", q(uuidFrom(`${tag}:${i}`)))))
    }
  }
  ring(b.outline, "outline")
  b.cutouts.forEach((c, i) => ring(c, "cutout" + i))

  root.push(S("embedded_fonts", "no"))
  return write(root)
}

function footprintNode(f: Footprint, P: (p: Pt) => Pt, useNet: (n: string) => number): List {
  const at = P(f.at)
  const layer = f.side === "top" ? "F.Cu" : "B.Cu"
  const silk = f.side === "top" ? "F.SilkS" : "B.SilkS"
  const fab = f.side === "top" ? "F.Fab" : "B.Fab"
  const hasThru = f.pads.some((p) => p.kind === "thru")
  const hasSmd = f.pads.some((p) => p.kind === "smd")
  const attr = hasThru ? "through_hole" : hasSmd ? "smd" : "through_hole"
  // KiCad stores footprint rotation measured on the y-down screen, so it is the negation
  const rot = -f.rotation
  const fx = (size = 1) => S("effects", S("font", S("size", size, size), S("thickness", 0.15)))

  const out: List = [sym("footprint"), q(f.lib), S("layer", q(layer)), S("uuid", q(uuidFrom("fp:" + f.ref))), S("at", at.x, at.y, rot === 0 ? 0 : rot), S("attr", attr)]
  out.push(S("property", q("Reference"), q(f.ref), S("at", 0, -(f.body.h / 2 + 1)), S("layer", q(silk)), S("uuid", q(uuidFrom("ref:" + f.ref))), fx()))
  out.push(S("property", q("Value"), q(f.value), S("at", 0, f.body.h / 2 + 1), S("layer", q(fab)), S("hide", "yes"), S("uuid", q(uuidFrom("val:" + f.ref))), fx()))

  for (const [gi, g] of f.graphics.entries()) {
    // footprint-local coordinates are y-down in KiCad as well
    const a = { x: g.a.x, y: -g.a.y }
    const c = { x: g.b.x, y: -g.b.y }
    const stroke = S("stroke", S("width", g.width), S("type", "default"))
    const id = q(uuidFrom(`g:${f.ref}:${gi}`))
    if (g.kind === "line") out.push(S("fp_line", S("start", a.x, a.y), S("end", c.x, c.y), stroke, S("layer", q(g.layer)), S("uuid", id)))
    else if (g.kind === "rect") out.push(S("fp_rect", S("start", a.x, a.y), S("end", c.x, c.y), stroke, S("fill", "no"), S("layer", q(g.layer)), S("uuid", id)))
    else out.push(S("fp_circle", S("center", a.x, a.y), S("end", c.x, c.y), stroke, S("fill", "no"), S("layer", q(g.layer)), S("uuid", id)))
  }

  for (const [pi, p] of f.pads.entries()) out.push(padNode(f, p, pi, useNet))
  return out
}

function padNode(f: Footprint, p: Pad, idx: number, useNet: (n: string) => number): List {
  const type = p.kind === "smd" ? "smd" : p.kind === "thru" ? "thru_hole" : "np_thru_hole"
  const shape = p.shape
  const lay: Node[] =
    p.kind === "smd"
      ? [q(p.layers[0] ?? "F.Cu"), q((p.layers[0] ?? "F.Cu") === "F.Cu" ? "F.Mask" : "B.Mask"), ...((p.layers[0] ?? "F.Cu") === "F.Cu" ? [q("F.Paste")] : [q("B.Paste")])]
      : [q("*.Cu"), q("*.Mask")]
  // local pad coordinates are y-down in KiCad
  const node: List = [sym("pad"), q(p.name), sym(type), sym(shape), S("at", p.at.x, -p.at.y), S("size", p.size.w, p.size.h)]
  if (p.drill !== undefined) node.push(S("drill", p.drill))
  node.push([sym("layers"), ...lay])
  if (shape === "roundrect") node.push(S("roundrect_rratio", 0.25))
  if (p.kind !== "npth") node.push(S("net", useNet(p.net), q(p.net)))
  node.push(S("uuid", q(uuidFrom(`pad:${f.ref}:${idx}`))))
  return node
}

/** world position of a pad in KiCad (page) coordinates, for tests and tooling */
export function padKicadXY(fp: Footprint, pad: Pad): Pt {
  const w = padWorld(fp, pad)
  return { x: PAGE_CENTER.x + w.x, y: PAGE_CENTER.y - w.y }
}

/**
 * The board's rules as a KiCad custom-rules file (.kicad_dru), so KiCad's DRC
 * and ours enforce the same numbers. Save it next to the board with the same
 * base name, e.g. board.kicad_pcb + board.kicad_dru.
 */
export function writeKicadDru(b: Board): string {
  const r = b.rules
  const rule = (name: string, constraint: string) => `(rule "${name}"\n  (constraint ${constraint}))\n`
  return (
    `(version 1)\n` +
    rule("boardforge min track width", `track_width (min ${r.minTrackWidth}mm)`) +
    rule("boardforge clearance", `clearance (min ${r.clearance}mm)`) +
    rule("boardforge min via diameter", `via_diameter (min ${r.minViaDiameter}mm)`) +
    rule("boardforge min hole size", `hole_size (min ${r.minViaDrill}mm)`) +
    rule("boardforge annular ring", `annular_width (min ${r.minAnnularRing}mm)`) +
    rule("boardforge edge clearance", `edge_clearance (min ${r.edgeClearance}mm)`) +
    rule("boardforge hole to hole", `hole_to_hole (min ${r.minHoleToHole}mm)`)
  )
}
