/**
 * Ported from tscircuit/single-layer-grid-router (lib/geometry.ts), MIT,
 * Copyright (c) 2026 tscircuit. See NOTICE.md. Adapted to take boardforge
 * obstacle shapes.
 */
import type { Pt } from "../model.ts"

/** an axis-aligned (optionally rotated) rectangle or circle obstacle */
export type Obstacle = {
  center: Pt
  width: number
  height: number
  ccwRotationDegrees?: number
  shape?: "circle"
}

export function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}

/** shortest distance from a point to the obstacle's edge (0 when inside) */
export function obstacleDistance(p: Pt, o: Obstacle): number {
  if (o.shape === "circle") return Math.max(0, Math.hypot(p.x - o.center.x, p.y - o.center.y) - Math.max(o.width, o.height) / 2)
  const angle = (-(o.ccwRotationDegrees ?? 0) * Math.PI) / 180
  const dx = p.x - o.center.x
  const dy = p.y - o.center.y
  const x = dx * Math.cos(angle) - dy * Math.sin(angle)
  const y = dx * Math.sin(angle) + dy * Math.cos(angle)
  return Math.hypot(Math.max(0, Math.abs(x) - o.width / 2), Math.max(0, Math.abs(y) - o.height / 2))
}

/** drop points that sit on a straight line between their neighbours */
export function simplify(points: Pt[]): Pt[] {
  return points.filter((p, i) => {
    if (i === 0 || i === points.length - 1) return true
    const a = points[i - 1]!
    const b = points[i + 1]!
    return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-9
  })
}
