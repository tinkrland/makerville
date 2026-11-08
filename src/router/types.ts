/**
 * The router contract. Every router in boardforge is a separate piece behind
 * this one interface, so a grid A* router, a hypergraph router or a bridge to
 * an external one can be swapped without touching the editor.
 *
 * A router reads a Board (footprints, existing tracks, holes, rules) and
 * returns new copper. It must not mutate the board it was given.
 */
import type { Board, Track, Via } from "../model.ts"

export interface RouteOptions {
  /** grid pitch in mm for grid based routers. Smaller is finer and slower. */
  gridSize?: number
  /** how many reorder-and-retry passes before giving up */
  maxAttempts?: number
  /** track width for nets that have no preference, defaults to a bit above the board minimum */
  trackWidth?: number
  /** only route these nets (everything else is treated as fixed copper) */
  onlyNets?: string[]
  /** allow layer changes through vias */
  useVias?: boolean
  /** cost of a via relative to one grid step, higher means fewer vias */
  viaCost?: number
  /** called after each connection with progress 0..1 so a UI can draw it live */
  onProgress?: (p: Progress) => void
}

export interface Progress {
  done: number
  total: number
  net: string
  attempt: number
}

export interface RouteResult {
  ok: boolean
  tracks: Track[]
  vias: Via[]
  /** nets or connections that could not be routed, with the reason */
  unrouted: { net: string; from: string; to: string; reason: string }[]
  stats: { attempts: number; connections: number; routed: number; expandedCells: number; ms: number }
}

export interface Router {
  readonly name: string
  route(board: Board, opts?: RouteOptions): RouteResult
}
