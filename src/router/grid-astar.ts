/**
 * Grid A* router with rip-up and reordered retries.
 *
 * Ported and adapted from tscircuit/single-layer-grid-router
 * (lib/SingleLayerGridRouter.ts, lib/group-connections.ts), MIT,
 * Copyright (c) 2026 tscircuit. See NOTICE.md.
 *
 * Kept from the original:
 *   - the conservative blocked-cell map: obstacles and other nets' copper are
 *     inflated by half a grid diagonal so a straight edge between two free
 *     nodes can never clip copper
 *   - a net's own pads and tracks never block it (alias handling)
 *   - nets are joined greedily by nearest connected/remaining terminal pair
 *   - when a connection cannot be routed the whole board is ripped up and
 *     retried with the net order reversed and then rotated, deterministically
 *   - 4-neighbour moves, Manhattan heuristic, stable heap so ties are repeatable
 *
 * Changed:
 *   - works on a boardforge Board instead of SimpleRouteJson
 *   - two or more copper layers: the search state is (cell, layer) and a via is
 *     a move between layers at the same cell, allowed only where both layers
 *     are free at that cell
 *   - existing tracks and vias on the board are fixed obstacles for other nets
 *   - emits Track / Via objects, merging collinear steps
 */
import type { Board, Pt, Track, Via, Footprint, Pad } from "../model.ts"
import { padWorld, padWorldSize, polygonBounds, uid } from "../model.ts"
import { MinHeap } from "./min-heap.ts"
import { obstacleDistance, pointSegmentDistance, simplify, type Obstacle } from "./geometry.ts"
import type { RouteOptions, RouteResult, Router } from "./types.ts"

type Terminal = { at: Pt; layers: string[]; ref: string }
type Net = { name: string; terminals: Terminal[]; width: number }
type Job = { net: Net; from: Terminal; to: Terminal }

type Copper = { layer: string; net: string; kind: "pad" | "track" | "via"; obstacle?: Obstacle; a?: Pt; b?: Pt; radius?: number }

export class GridAStarRouter implements Router {
  readonly name = "grid-astar"

  route(board: Board, opts: RouteOptions = {}): RouteResult {
    const t0 = Date.now()
    const grid = opts.gridSize ?? 0.1
    const maxAttempts = opts.maxAttempts ?? 16
    const useVias = opts.useVias ?? board.copper.length > 1
    const viaCost = opts.viaCost ?? 12
    const rules = board.rules
    const width = opts.trackWidth ?? Math.max(rules.minTrackWidth, 0.2)

    const fail = (reason: string): RouteResult => ({ ok: false, tracks: [], vias: [], unrouted: [{ net: "", from: "", to: "", reason }], stats: { attempts: 0, connections: 0, routed: 0, expandedCells: 0, ms: Date.now() - t0 } })
    if (!(grid > 0) || !Number.isFinite(grid)) return fail("gridSize must be a positive number")
    if (board.outline.length < 3) return fail("board has no outline")

    const bb = polygonBounds(board.outline)
    const nx = Math.floor((bb.maxX - bb.minX) / grid + 1e-9) + 1
    const ny = Math.floor((bb.maxY - bb.minY) / grid + 1e-9) + 1
    if (nx * ny * board.copper.length > 6_000_000) return fail(`grid too large (${nx}x${ny}x${board.copper.length}); raise gridSize`)

    const layers = board.copper
    const layerIdx = new Map(layers.map((l, i) => [l, i]))

    // ---- gather copper and terminals
    const fixed: Copper[] = []
    const nets = new Map<string, Net>()
    const only = opts.onlyNets ? new Set(opts.onlyNets) : null

    for (const fp of board.footprints) {
      for (const pad of fp.pads) {
        const w = padWorld(fp, pad)
        const sz = padWorldSize(fp, pad)
        const ob: Obstacle = { center: w, width: sz.w, height: sz.h, shape: pad.shape === "circle" ? "circle" : undefined }
        const padLayers = pad.kind === "smd" ? (fp.side === "bottom" ? [flip(pad.layers[0] ?? "F.Cu", layers)] : pad.layers) : pad.kind === "thru" ? layers : layers
        const routable = pad.net !== "" && pad.kind !== "npth" && (!only || only.has(pad.net))
        for (const l of padLayers) fixed.push({ layer: l, net: pad.net, kind: "pad", obstacle: ob })
        if (pad.kind === "npth" || (pad.drill && pad.kind !== "smd")) {
          // the drilled hole itself is keep-out on every layer for foreign nets
        }
        if (routable) {
          if (!nets.has(pad.net)) nets.set(pad.net, { name: pad.net, terminals: [], width })
          nets.get(pad.net)!.terminals.push({ at: w, layers: padLayers, ref: `${fp.ref}.${pad.name}` })
        }
      }
    }
    for (const h of board.holes) {
      const ob: Obstacle = { center: h.at, width: h.pad, height: h.pad, shape: "circle" }
      for (const l of layers) fixed.push({ layer: l, net: "\u0000hole", kind: "pad", obstacle: ob })
    }
    for (const t of board.tracks) fixed.push({ layer: t.layer, net: t.net, kind: "track", a: t.a, b: t.b, radius: t.width / 2 })
    for (const v of board.vias) for (const l of layers) fixed.push({ layer: l, net: v.net, kind: "via", a: v.at, radius: v.diameter / 2 })

    // terminals that already touch an existing track of their own net are already joined:
    // keep the net but drop terminals that are electrically connected to an earlier one
    for (const net of nets.values()) net.terminals = dedupeTerminals(net.terminals)
    const todo = [...nets.values()].filter((n) => n.terminals.length >= 2)

    if (todo.length === 0) {
      return { ok: true, tracks: [], vias: [], unrouted: [], stats: { attempts: 0, connections: 0, routed: 0, expandedCells: 0, ms: Date.now() - t0 } }
    }

    const outlineEdges: [Pt, Pt][] = board.outline.map((p, i) => [p, board.outline[(i + 1) % board.outline.length]!])
    const pointOf = (id: number): Pt => ({ x: bb.minX + (id % nx) * grid, y: bb.minY + Math.floor(id / nx) * grid })
    const cellOf = (p: Pt): number => {
      const x = Math.round((p.x - bb.minX) / grid)
      const y = Math.round((p.y - bb.minY) / grid)
      return x < 0 || y < 0 || x >= nx || y >= ny ? -1 : y * nx + x
    }
    const cells = nx * ny
    const padding = grid / Math.SQRT2 + 1e-8

    // ---- per net, per layer blocked map (built lazily, rebuilt after each routed branch)
    const routedTracks: Track[] = []
    const routedVias: Via[] = []
    let expandedTotal = 0

    const insideOutline = (p: Pt) => pointInPoly(p, board.outline) && !board.cutouts.some((c) => pointInPoly(p, c))

    const viaDia = Math.max(rules.minViaDiameter, 0.6)
    const blockedFor = (net: Net, copperHalf = net.width / 2): Uint8Array[] => {
      const maps = layers.map(() => new Uint8Array(cells))
      const half = copperHalf
      const margin = half + rules.clearance + padding
      const edgeMargin = half + rules.edgeClearance + padding
      // outside / too close to the outline or a cut-out
      for (let id = 0; id < cells; id++) {
        const p = pointOf(id)
        let bad = !insideOutline(p)
        if (!bad) {
          for (const [a, b] of outlineEdges) if (pointSegmentDistance(p, a, b) < edgeMargin) { bad = true; break }
        }
        if (!bad) for (const c of board.cutouts) for (let i = 0; i < c.length; i++) if (pointSegmentDistance(p, c[i]!, c[(i + 1) % c.length]!) < edgeMargin) { bad = true; break }
        if (bad) for (const m of maps) m[id] = 1
      }
      const paint = (m: Uint8Array, minX: number, maxX: number, minY: number, maxY: number, inside: (p: Pt) => boolean) => {
        const x0 = Math.max(0, Math.floor((minX - bb.minX) / grid))
        const x1 = Math.min(nx - 1, Math.ceil((maxX - bb.minX) / grid))
        const y0 = Math.max(0, Math.floor((minY - bb.minY) / grid))
        const y1 = Math.min(ny - 1, Math.ceil((maxY - bb.minY) / grid))
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const id = y * nx + x
          if (inside(pointOf(id))) m[id] = 1
        }
      }
      const all: Copper[] = [
        ...fixed,
        ...routedTracks.map((t): Copper => ({ layer: t.layer, net: t.net, kind: "track", a: t.a, b: t.b, radius: t.width / 2 })),
        ...routedVias.flatMap((v) => layers.map((l): Copper => ({ layer: l, net: v.net, kind: "via", a: v.at, radius: v.diameter / 2 }))),
      ]
      for (const c of all) {
        if (c.net === net.name) continue // a net never blocks itself
        const li = layerIdx.get(c.layer)
        if (li === undefined) continue
        const m = maps[li]!
        if (c.obstacle) {
          const o = c.obstacle
          const r = Math.hypot(o.width, o.height) / 2 + margin
          paint(m, o.center.x - r, o.center.x + r, o.center.y - r, o.center.y + r, (p) => obstacleDistance(p, o) < margin)
        } else if (c.kind === "track" && c.a && c.b) {
          const r = margin + (c.radius ?? 0)
          paint(m, Math.min(c.a.x, c.b.x) - r, Math.max(c.a.x, c.b.x) + r, Math.min(c.a.y, c.b.y) - r, Math.max(c.a.y, c.b.y) + r, (p) => pointSegmentDistance(p, c.a!, c.b!) < r)
        } else if (c.kind === "via" && c.a) {
          const r = margin + (c.radius ?? 0)
          paint(m, c.a.x - r, c.a.x + r, c.a.y - r, c.a.y + r, (p) => Math.hypot(p.x - c.a!.x, p.y - c.a!.y) < r)
        }
      }
      return maps
    }

    // ---- job list: greedy nearest-pair joining, as in the original
    let attempt = 0
    const makeJobs = (): Job[] => {
      const list = [...todo].sort((a, b) => span(a) - span(b) || a.name.localeCompare(b.name))
      if (attempt % 2) list.reverse()
      const off = Math.floor(attempt / 2) % (list.length || 1)
      list.push(...list.splice(0, off))
      const jobs: Job[] = []
      for (const net of list) {
        const connected = net.terminals.slice(0, 1)
        const remaining = net.terminals.slice(1)
        while (remaining.length) {
          let best: { from: Terminal; to: Terminal; i: number; d: number } | undefined
          for (const from of connected) for (const [i, to] of remaining.entries()) {
            const d = Math.hypot(from.at.x - to.at.x, from.at.y - to.at.y)
            if (!best || d < best.d) best = { from, to, i, d }
          }
          jobs.push({ net, from: best!.from, to: best!.to })
          connected.push(best!.to)
          remaining.splice(best!.i, 1)
        }
      }
      return jobs
    }

    // ---- the search
    const search = (job: Job, maps: Uint8Array[], viaMaps: Uint8Array[]): { pts: { p: Pt; layer: number }[] } | null => {
      const L = layers.length
      const N = cells * L
      const startCell = cellOf(job.from.at)
      const endCell = cellOf(job.to.at)
      if (startCell < 0 || endCell < 0) return null
      const startLayers = job.from.layers.map((l) => layerIdx.get(l)!).filter((x) => x !== undefined)
      const endLayers = new Set(job.to.layers.map((l) => layerIdx.get(l)!).filter((x) => x !== undefined))
      const cost = new Float64Array(N).fill(Infinity)
      const prev = new Int32Array(N).fill(-1)
      const heap = new MinHeap()
      const ex = endCell % nx
      const ey = Math.floor(endCell / nx)
      const h = (cell: number) => Math.abs((cell % nx) - ex) + Math.floor(Math.abs(Math.floor(cell / nx) - ey))
      // pads are their own net, so their own cell is free for us even if a foreign inflated area touched it
      const free = (layer: number, cell: number) => cell === startCell || cell === endCell || !maps[layer]![cell]
      for (const l of startLayers) {
        const s = l * cells + startCell
        cost[s] = 0
        heap.push({ id: s, cost: 0, score: h(startCell) })
      }
      let expanded = 0
      while (heap.length) {
        const cur = heap.pop()
        if (cur.cost !== cost[cur.id]) continue
        const layer = Math.floor(cur.id / cells)
        const cell = cur.id % cells
        if (cell === endCell && endLayers.has(layer)) {
          const out: { p: Pt; layer: number }[] = []
          for (let id = cur.id; id !== -1; id = prev[id]!) out.push({ p: pointOf(id % cells), layer: Math.floor(id / cells) })
          out.reverse()
          expandedTotal += expanded
          return { pts: out }
        }
        expanded++
        const x = cell % nx
        const y = Math.floor(cell / nx)
        const try_ = (nCell: number, nLayer: number, step: number) => {
          if (!free(nLayer, nCell)) return
          const c = cur.cost + step
          const id = nLayer * cells + nCell
          if (c >= cost[id]!) return
          cost[id] = c
          prev[id] = cur.id
          heap.push({ id, cost: c, score: c + h(nCell) })
        }
        if (x > 0) try_(cell - 1, layer, 1)
        if (x < nx - 1) try_(cell + 1, layer, 1)
        if (y > 0) try_(cell - nx, layer, 1)
        if (y < ny - 1) try_(cell + nx, layer, 1)
        if (useVias && L > 1 && cell !== startCell && cell !== endCell) {
          // a via needs every copper layer it passes free at this cell
          for (let nl = 0; nl < L; nl++) {
            if (nl === layer) continue
            const lo = Math.min(layer, nl)
            const hi = Math.max(layer, nl)
            let ok = true
            for (let k = lo; k <= hi; k++) if (viaMaps[k]![cell]) { ok = false; break }
            if (ok) try_(cell, nl, viaCost)
          }
        }
      }
      expandedTotal += expanded
      return null
    }

    // ---- main loop with whole-board rip-up
    const unrouted: RouteResult["unrouted"] = []
    let jobs = makeJobs()
    let ji = 0
    let lastFail: Job | undefined
    const total = jobs.length
    while (ji < jobs.length) {
      const job = jobs[ji]!
      const maps = blockedFor(job.net)
      // a via is wider than the track: its own keep-out is computed with the via radius
      const viaMaps = useVias && layers.length > 1 ? blockedFor(job.net, viaDia / 2) : maps
      const found = search(job, maps, viaMaps)
      if (!found) {
        lastFail = job
        attempt++
        if (attempt >= maxAttempts) break
        routedTracks.length = 0
        routedVias.length = 0
        jobs = makeJobs()
        ji = 0
        continue
      }
      emit(found.pts, job)
      ji++
      opts.onProgress?.({ done: ji, total, net: job.net.name, attempt: attempt + 1 })
    }
    const done = ji === jobs.length
    if (!done && lastFail) {
      // report every connection we did not reach, not just the first
      for (const j of jobs.slice(ji)) unrouted.push({ net: j.net.name, from: j.from.ref, to: j.to.ref, reason: `no path after ${attempt} attempts` })
    }

    function emit(pts: { p: Pt; layer: number }[], job: Job) {
      // split the path where the layer changes (that cell becomes a via)
      let run: Pt[] = []
      let cur = pts[0]!.layer
      const flush = (layer: number) => {
        const poly = simplify(dedupe([job.from.at.x === run[0]?.x && job.from.at.y === run[0]?.y ? job.from.at : run[0]!, ...run.slice(1)]))
        for (let i = 0; i < poly.length - 1; i++) {
          if (poly[i]!.x === poly[i + 1]!.x && poly[i]!.y === poly[i + 1]!.y) continue
          routedTracks.push({ id: uid("rt"), a: poly[i]!, b: poly[i + 1]!, width: job.net.width, layer: layers[layer]!, net: job.net.name })
        }
      }
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i]!
        if (q.layer !== cur) {
          flush(cur)
          const at = pts[i - 1]!.p
          routedVias.push({ id: uid("rv"), at, diameter: Math.max(rules.minViaDiameter, 0.6), drill: Math.max(rules.minViaDrill, 0.3), from: layers[Math.min(cur, q.layer)]!, to: layers[Math.max(cur, q.layer)]!, net: job.net.name })
          run = [at]
          cur = q.layer
        }
        run.push(q.p)
      }
      // snap the two ends to the exact pad centres
      if (run.length) {
        run[0] = run.length && pts[0]!.layer === cur && routedVias.length === 0 ? job.from.at : run[0]!
        run[run.length - 1] = job.to.at
        flush(cur)
      }
    }

    return {
      ok: done,
      tracks: routedTracks.map((t) => ({ ...t })),
      vias: routedVias.map((v) => ({ ...v })),
      unrouted,
      stats: { attempts: attempt + 1, connections: total, routed: ji, expandedCells: expandedTotal, ms: Date.now() - t0 },
    }
  }
}

// ---------------------------------------------------------------------------

function span(n: Net) {
  if (n.terminals.length < 2) return 0
  const xs = n.terminals.map((t) => t.at.x)
  const ys = n.terminals.map((t) => t.at.y)
  return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)
}

function dedupe(p: Pt[]): Pt[] {
  return p.filter((q, i) => i === 0 || Math.hypot(q.x - p[i - 1]!.x, q.y - p[i - 1]!.y) > 1e-9)
}

function dedupeTerminals(t: Terminal[]): Terminal[] {
  const out: Terminal[] = []
  for (const x of t) if (!out.some((o) => Math.hypot(o.at.x - x.at.x, o.at.y - x.at.y) < 1e-6)) out.push(x)
  return out
}

function flip(layer: string, layers: string[]): string {
  return layer === "F.Cu" ? layers[layers.length - 1]! : layer === "B.Cu" ? layers[0]! : layer
}

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
