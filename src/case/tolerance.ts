/**
 * Print tolerances: the gap between a computer's exact dimensions and what a printer produces.
 *
 * A CAD model is exact. A printed part is not: extruded plastic spreads, vertical holes close up,
 * and corners round off. If the generator emitted the board's nominal sizes, the PCB would be a
 * force fit or would not go in at all. So every dimension that has to MATE with something real
 * (the board, a connector, a screw, the lid) is adjusted by a tolerance from a profile.
 *
 * The numbers are not universal. They depend on the printer, nozzle, material and slicer, so the
 * defaults here are a typical well-tuned 0.4 mm FDM profile and everything is overridable. Treat them
 * as a starting point to calibrate with a test print, not as truth. The `ideal` profile is all zeros:
 * exact CAD dimensions, for resin printers, CNC, or comparing against the tuned numbers.
 *
 * Directions, because getting the sign wrong is the classic mistake:
 *   a CAVITY the board sits in must be BIGGER than the board         -> add clearance
 *   a HOLE a screw passes through must be BIGGER than the screw      -> add clearance
 *   a SLOT a connector pokes through must be BIGGER than the connector -> add clearance
 *   a vertical hole prints SMALLER than drawn                        -> add extra on top
 *   a lid that must slip into the tray must be SMALLER than the tray -> subtract clearance
 */

export interface Tolerances {
  /** human name, shown in the generated file */
  name: string
  /**
   * Clearance for a part that has to drop in freely (the PCB in its cavity). Added to each side.
   * This replaces the flat "margin" idea: it is the print-process part of the gap.
   */
  slip: number
  /** Clearance for a connector or button poking through a wall or lid. Added to each side. */
  opening: number
  /** Extra diameter for a hole a screw passes through, on top of the screw size. */
  screwHole: number
  /** Extra diameter for a screw hole printed upright (z axis): these close up the most. */
  verticalHoleExtra: number
  /** Clearance between mating printed parts (lid lip into the tray). Subtracted from the inner part. */
  mating: number
  /** Hole diameter bonus for a heat-set insert, over the insert's outer diameter. */
  insertHole: number
  /** Smallest wall or feature the printer reliably makes. Below this the generator warns. */
  minFeature: number
}

export const PROFILES = {
  /** exact CAD numbers: no compensation. For resin/CNC, or to see what compensation changes. */
  ideal: { name: "ideal", slip: 0, opening: 0, screwHole: 0, verticalHoleExtra: 0, mating: 0, insertHole: 0, minFeature: 0.4 },
  /** a typical well-tuned 0.4 mm nozzle FDM printer. Calibrate with a test print. */
  fdm: { name: "fdm", slip: 0.3, opening: 0.3, screwHole: 0.2, verticalHoleExtra: 0.15, mating: 0.2, insertHole: 0.1, minFeature: 0.8 },
  /** a loose, forgiving profile for a printer you have not calibrated */
  fdmLoose: { name: "fdm-loose", slip: 0.5, opening: 0.5, screwHole: 0.3, verticalHoleExtra: 0.25, mating: 0.35, insertHole: 0.15, minFeature: 1.2 },
  /** resin (SLA/MSLA): tight and accurate, but parts shrink slightly */
  resin: { name: "resin", slip: 0.15, opening: 0.15, screwHole: 0.1, verticalHoleExtra: 0.05, mating: 0.1, insertHole: 0.05, minFeature: 0.4 },
} as const satisfies Record<string, Tolerances>

export type ProfileName = keyof typeof PROFILES

export function resolveTolerances(profile: ProfileName | Tolerances = "fdm", overrides: Partial<Tolerances> = {}): Tolerances {
  const base = typeof profile === "string" ? PROFILES[profile] : profile
  if (!base) throw new Error(`unknown tolerance profile "${String(profile)}". Known: ${Object.keys(PROFILES).join(", ")}`)
  const t: Tolerances = { ...base, ...overrides }
  for (const k of Object.keys(t) as (keyof Tolerances)[]) {
    if (k === "name") continue
    const v = t[k] as number
    if (!Number.isFinite(v) || v < 0) throw new Error(`tolerance "${k}" must be zero or more (got ${v}). Holes and cavities get ADDED size, so a negative value would make parts that do not fit`)
  }
  if (t.slip > 2 || t.opening > 2 || t.screwHole > 2 || t.mating > 2) throw new Error("a tolerance above 2 mm is almost certainly a mistake (millimetres, not percent)")
  return t
}

/** the diameter to draw for a screw hole: nominal screw + clearance, with the vertical closing-up allowance */
export function screwHoleDiameter(screw: number, t: Tolerances, vertical = true): number {
  return round(screw + t.screwHole + (vertical ? t.verticalHoleExtra : 0))
}

/** the diameter to draw for a heat-set insert hole */
export function insertHoleDiameter(insertOuter: number, t: Tolerances, vertical = true): number {
  return round(insertOuter + t.insertHole + (vertical ? t.verticalHoleExtra : 0))
}

const round = (n: number) => Math.round(n * 1000) / 1000
