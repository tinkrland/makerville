/**
 * Board -> parametric OpenSCAD enclosure.
 *
 * Pure and deterministic: the same Board and options always give the same text,
 * byte for byte. Nothing is modelled by hand and nothing is guessed. Every
 * dimension is either a named parameter at the top of the file (the sliders of
 * a configurator) or derived from the board and the parts' case projections.
 *
 * The design (derive the case from per-part records, hard errors versus
 * warnings, golden files for the geometry) follows keeberia's paracraft engine,
 * kqrla/keeberia. See NOTICE.md. The code here is written for general PCBs: the
 * cavity follows the board's own outline instead of assuming a keyboard.
 *
 * Coordinates: the SCAD file uses the board's own coordinates, y up, with z = 0
 * at the OUTSIDE of the case floor. The PCB top surface sits at
 * `floor + standoff_height + board_thickness`.
 *
 * Two printed parts, side by side in one file:
 *   case_bottom   tray: floor, outline-following wall, standoffs, edge openings
 *   case_lid      cover: sits on the wall tops, with top openings and screw holes
 */
import type { Board, Pt } from "../model.ts"
import { polygonBounds } from "../model.ts"
import { resolveOpenings, type Projection, type ResolvedOpening } from "./projection.ts"
import { resolveTolerances, screwHoleDiameter, type ProfileName, type Tolerances } from "./tolerance.ts"

export interface CaseOptions {
  wallThickness: number
  floorThickness: number
  /** design gap between the board edge and the inside of the wall. The print tolerance is added on top. */
  margin: number
  /** standoff height. The board floats this far above the floor. */
  standoffHeight: number
  /** air above the tallest top-side part, under the lid */
  headroom: number
  lidThickness: number
  /** screw drill diameter. M2 = 2.2, M2.5 = 2.7, M3 = 3.2 */
  screwSize: number
  /** gap between the two printed parts when laid out side by side */
  partGap: number
  /** how far the lid's locating lip drops into the tray. 0 gives a plain butt joint. */
  lipHeight: number
  /** wall thickness of that lip */
  lipThickness: number
  /**
   * Print tolerances: a named profile ("ideal" | "fdm" | "fdm-loose" | "resin") or a full object, with
   * optional per-field overrides. See tolerance.ts for why these exist and what each one does.
   */
  profile: ProfileName | Tolerances
  tolerances: Partial<Tolerances>
}

export const DEFAULT_CASE_OPTIONS: CaseOptions = {
  wallThickness: 2.4,
  floorThickness: 2,
  margin: 0.2,
  standoffHeight: 3,
  headroom: 1.5,
  lidThickness: 2,
  screwSize: 2.2,
  partGap: 10,
  lipHeight: 2,
  lipThickness: 1.2,
  profile: "fdm",
  tolerances: {},
}

export interface CaseWarning {
  level: "error" | "warning" | "info"
  message: string
}

export interface CaseResult {
  /** the whole .scad file */
  scad: string
  /** the named values at the top of the file, the configurator's sliders */
  params: Record<string, number>
  warnings: CaseWarning[]
  /** true when there is no error: only then is the scad safe to print */
  ok: boolean
  stats: {
    standoffs: number
    edgeOpenings: number
    topOpenings: number
    /** inside depth of the tray above the floor */
    trayHeight: number
    outerWidth: number
    outerHeight: number
  }
}

/** a connector further than this from the board edge it faces cannot be reached by a wall opening */
const MAX_REACH = 3

const f = (n: number) => {
  const r = Math.round(n * 1000) / 1000
  return (Object.is(r, -0) ? 0 : r).toString()
}

export function generateCase(board: Board, partial: Partial<CaseOptions> = {}, projections?: Record<string, Projection>): CaseResult {
  const o: CaseOptions = { ...DEFAULT_CASE_OPTIONS, ...partial }
  const warnings: CaseWarning[] = []
  let tol: Tolerances
  try {
    tol = resolveTolerances(o.profile, o.tolerances)
  } catch (e) {
    // a bad tolerance is a hard error, not a silent fallback: a wrong fit is a wasted print
    warnings.push({ level: "error", message: e instanceof Error ? e.message : String(e) })
    tol = resolveTolerances("ideal")
  }
  const err = (message: string) => warnings.push({ level: "error", message })
  const warn = (message: string) => warnings.push({ level: "warning", message })

  for (const k of ["wallThickness", "floorThickness", "lidThickness", "screwSize"] as const)
    if (!(o[k] > 0) || !Number.isFinite(o[k])) err(`${k} must be a positive number (got ${o[k]})`)
  for (const k of ["margin", "standoffHeight", "headroom", "partGap", "lipHeight", "lipThickness"] as const)
    if (!(o[k] >= 0) || !Number.isFinite(o[k])) err(`${k} must be zero or more (got ${o[k]})`)
  if (board.outline.length < 3) err("the board has no outline, so there is nothing to enclose")

  // ---- what the parts demand of the cavity
  const top = board.footprints.filter((p) => p.side === "top")
  const bottom = board.footprints.filter((p) => p.side === "bottom")
  const tallestTop = top.reduce((m, p) => Math.max(m, p.height), 0)
  const tallestBottom = bottom.reduce((m, p) => Math.max(m, p.height), 0)

  // bottom-side parts hang below the board: the standoffs must lift the board clear of them
  const minStandoff = tallestBottom + 0.3
  if (tallestBottom > 0 && o.standoffHeight < minStandoff) {
    err(`a part on the bottom of the board is ${f(tallestBottom)} mm tall but the standoffs are only ${f(o.standoffHeight)} mm: raise standoff height to at least ${f(minStandoff)} mm so it does not touch the floor`)
  }

  const bounds = polygonBounds(board.outline)
  const pcbW = bounds.maxX - bounds.minX
  const pcbH = bounds.maxY - bounds.minY

  // top-side parts set how tall the tray must be: floor + standoff + board + tallest part + headroom
  const boardTop = o.floorThickness + o.standoffHeight + board.thickness
  const trayHeight = boardTop + tallestTop + o.headroom

  // ---- things the printer cannot make
  if (o.wallThickness < tol.minFeature) warn(`walls of ${f(o.wallThickness)} mm are thinner than the ${f(tol.minFeature)} mm this printer profile can make reliably: raise the wall thickness`)
  if (o.lidThickness < tol.minFeature) warn(`a lid of ${f(o.lidThickness)} mm is thinner than the ${f(tol.minFeature)} mm this printer profile can make reliably`)
  if (o.lipHeight > 0 && o.lipThickness < tol.minFeature) warn(`a lid lip ${f(o.lipThickness)} mm thick is thinner than the ${f(tol.minFeature)} mm this printer profile can make reliably: it will be fragile`)
  if (o.lipHeight > 0 && o.lipThickness + tol.mating >= o.wallThickness) err(`the lid lip (${f(o.lipThickness)} mm + ${f(tol.mating)} mm fit gap) is as thick as the wall (${f(o.wallThickness)} mm), so it would break through: thicken the wall or thin the lip`)

  // ---- mounting
  if (board.holes.length === 0) err("this board has no mounting holes, so the case cannot hold it in place: add at least two mounting holes")
  else if (board.holes.length === 1) warn("only one mounting hole: the board can rotate on its single screw, add a second one")
  for (const h of board.holes) if (h.drill > o.screwSize + 0.6) warn(`mounting hole ${h.id} is ${f(h.drill)} mm but the screw drill is ${f(o.screwSize)} mm: the screw will rattle`)

  // ---- openings
  const openings = resolveOpenings(board, projections)
  const edge = openings.filter((x) => x.kind === "edge")
  const topOps = openings.filter((x) => x.kind === "top")
  for (const e of edge) {
    const z0 = o.floorThickness + o.standoffHeight + board.thickness + e.z - tol.opening
    if (e.side === "bottom") continue
    if (z0 < o.floorThickness) err(`the ${e.label} opening on ${e.ref} would cut into the floor: raise the standoff height`)
    if (z0 + e.height + 2 * tol.opening > trayHeight) err(`the ${e.label} opening on ${e.ref} is taller than the walls: it would cut through the top of the tray`)
  }
  for (const e of edge) {
    if (e.side === "bottom") warn(`${e.ref} (${e.label}) is on the bottom of the board; its opening is cut at the board's height, check it lines up`)
    const wallLen = e.wall === "y+" || e.wall === "y-" ? pcbW : pcbH
    const lo = e.wall === "y+" || e.wall === "y-" ? bounds.minX : bounds.minY
    if (e.along! < lo - 0.01 || e.along! > lo + wallLen + 0.01) err(`${e.ref} (${e.label}) sits outside the board outline on the ${e.wall} wall`)
    else if (e.along! - e.width / 2 < lo - 0.01 || e.along! + e.width / 2 > lo + wallLen + 0.01) warn(`the ${e.label} opening on ${e.ref} runs past the end of the ${e.wall} wall`)
    const gap = edgeGap(board.outline, e.bodyEdge!, e.wall, e.along!)
    if (gap > MAX_REACH) warn(`${e.ref} (${e.label}) faces the ${e.wall} wall but is ${f(gap)} mm from the board edge: the opening will not reach the connector`)
  }
  edge.sort(cmpOpening)
  topOps.sort(cmpOpening)

  const outlineSorted = board.outline

  // ---- emit
  const L: string[] = []
  const P = (s = "") => L.push(s)
  P(`// ${board.name}: enclosure`)
  P(`// Generated by boardforge from the board file. Every number below is either a parameter you can`)
  P(`// edit and re-render, or derived from the board (regenerate the case to change those).`)
  P(`// Plain OpenSCAD, no libraries, so it opens in the Customizer and in web playgrounds.`)
  P(`// Coordinates are the board's own, y up. z = 0 is the outside of the case floor.`)
  P(``)
  P(`/* [Case] */`)
  P(`wall_thickness  = ${f(o.wallThickness)};   // [1.2:0.2:5] wall around the board`)
  P(`floor_thickness = ${f(o.floorThickness)};   // [1:0.2:5]`)
  P(`margin          = ${f(o.margin)};   // [0:0.1:3] design gap between the board edge and the inside of the wall`)
  P(`lid_thickness   = ${f(o.lidThickness)};   // [1:0.2:5]`)
  P(`/* [Board fit] */`)
  P(`standoff_height = ${f(o.standoffHeight)};   // [1:0.5:12] the board floats this far above the floor`)
  P(`headroom        = ${f(o.headroom)};   // [0.5:0.5:10] air above the tallest part`)
  P(`/* [Mounting] */`)
  P(`screw_size      = ${f(o.screwSize)};   // [2:0.1:3.4] drill diameter (M2 = 2.2, M2.5 = 2.7, M3 = 3.2)`)
  P(`lip_height      = ${f(o.lipHeight)};   // [0:0.5:6] how far the lid's locating lip drops into the tray (0 = flat joint)`)
  P(`lip_thickness   = ${f(o.lipThickness)};   // [0.8:0.2:3] wall of that lip`)
  P(`/* [Print tolerances: ${tol.name}] */`)
  P(`// A printer does not make exact sizes. These are added to the drawn dimensions so real parts fit.`)
  P(`// Calibrate with a test print, then change these. All zero = exact CAD dimensions.`)
  P(`tol_slip         = ${f(tol.slip)};   // [0:0.05:1] extra room around the PCB so it drops in`)
  P(`tol_opening      = ${f(tol.opening)};   // [0:0.05:1] extra room around every connector opening`)
  P(`tol_screw_hole   = ${f(tol.screwHole)};   // [0:0.05:0.6] extra diameter for a screw to pass`)
  P(`tol_vertical_hole = ${f(tol.verticalHoleExtra)};   // [0:0.05:0.5] holes printed upright close up, so they get more`)
  P(`tol_mating      = ${f(tol.mating)};   // [0:0.05:0.6] gap between the lid's lip and the tray`)
  P(`opening_clearance = tol_opening;`)
  P(`/* [Layout] */`)
  P(`part_gap        = ${f(o.partGap)};   // [0:1:40] space between the two printed parts`)
  P(``)
  P(`/* [Hidden] */`)
  P(`$fn = 48;`)
  P(`board_thickness = ${f(board.thickness)};   // from the board`)
  P(`tallest_top     = ${f(tallestTop)};   // tallest part on the top side`)
  P(`tray_height     = floor_thickness + standoff_height + board_thickness + tallest_top + headroom;`)
  P(`standoff_radius = screw_size / 2 + 2.2;`)
  P(`screw_hole      = screw_size + tol_screw_hole + tol_vertical_hole;   // = ${f(screwHoleDiameter(o.screwSize, tol))} at the current settings`)
  P(`gap             = margin + tol_slip;   // total board-to-wall gap: design gap + print gap`)
  P(`wall_offset     = gap + wall_thickness;`)
  P(``)
  P(`// the board outline, exactly as in the board file`)
  P(`module board_outline() {`)
  P(`  polygon([${outlineSorted.map((p) => `[${f(p.x)}, ${f(p.y)}]`).join(", ")}]);`)
  P(`}`)
  P(`module board_cutouts() {`)
  if (board.cutouts.length === 0) P(`  // none`)
  for (const c of board.cutouts) P(`  polygon([${c.map((p) => `[${f(p.x)}, ${f(p.y)}]`).join(", ")}]);`)
  P(`}`)
  P(``)
  P(`// the cavity is the outline grown by the gap; the outer shell is the cavity grown by the wall`)
  P(`module cavity_2d() { offset(delta = gap) board_outline(); }`)
  P(`module shell_2d()  { offset(delta = wall_offset) board_outline(); }`)
  P(``)
  P(`module standoff(x, y) {`)
  P(`  translate([x, y, floor_thickness - 0.01])`)
  P(`    difference() {`)
  P(`      cylinder(h = standoff_height + 0.01, r = standoff_radius);`)
  P(`      translate([0, 0, -1]) cylinder(h = standoff_height + 2, d = screw_hole);`)
  P(`    }`)
  P(`}`)
  P(`module standoffs() {`)
  for (const h of [...board.holes].sort((a, b) => a.id.localeCompare(b.id))) P(`  standoff(${f(h.at.x)}, ${f(h.at.y)});   // ${h.id}`)
  if (board.holes.length === 0) P(`  // none: this board has no mounting holes`)
  P(`}`)
  P(``)
  P(`module edge_openings() {`)
  if (edge.length === 0) P(`  // none`)
  for (const e of edge) L.push(...edgeCut(e, bounds, o))
  P(`}`)
  P(``)
  P(`module case_bottom() {`)
  P(`  difference() {`)
  P(`    union() {`)
  P(`      difference() {`)
  P(`        linear_extrude(tray_height) shell_2d();`)
  P(`        translate([0, 0, floor_thickness]) linear_extrude(tray_height) cavity_2d();`)
  P(`      }`)
  P(`      standoffs();`)
  P(`    }`)
  P(`    edge_openings();`)
  P(`  }`)
  P(`}`)
  P(``)
  P(`module top_openings() {`)
  if (topOps.length === 0) P(`  // none`)
  for (const t of topOps) {
    P(`  // ${t.ref}: ${t.label}`)
    if (t.round) P(`  translate([${f(t.at!.x)}, ${f(t.at!.y)}, -1]) cylinder(h = lid_thickness + 2, d = ${f(t.width)} + 2 * opening_clearance);`)
    else P(`  translate([${f(t.at!.x - t.width / 2)} - opening_clearance, ${f(t.at!.y - t.height / 2)} - opening_clearance, -1]) cube([${f(t.width)} + 2 * opening_clearance, ${f(t.height)} + 2 * opening_clearance, lid_thickness + 2]);`)
  }
  P(`}`)
  P(``)
  P(`// The lid locates on the tray with a lip that drops into the cavity. The lip is the cavity outline`)
  P(`// shrunk by the mating gap (so it slides in) and hollowed to lip_thickness (so it is a rim, not a plug).`)
  P(`module lid_lip() {`)
  P(`  if (lip_height > 0)`)
  P(`    difference() {`)
  P(`      linear_extrude(lid_thickness + lip_height) offset(delta = -tol_mating) cavity_2d();`)
  P(`      translate([0, 0, -1]) linear_extrude(lid_thickness + lip_height + 2) offset(delta = -(tol_mating + lip_thickness)) cavity_2d();`)
  P(`    }`)
  P(`}`)
  P(``)
  P(`// The lid is built upside down (flat face on the bed) with the lip pointing up, which is how it prints.`)
  P(`module case_lid() {`)
  P(`  difference() {`)
  P(`    union() {`)
  P(`      linear_extrude(lid_thickness) shell_2d();`)
  P(`      lid_lip();`)
  P(`    }`)
  for (const h of [...board.holes].sort((a, b) => a.id.localeCompare(b.id))) P(`    translate([${f(h.at.x)}, ${f(h.at.y)}, -1]) cylinder(h = lid_thickness + lip_height + 2, d = screw_hole);   // ${h.id}`)
  P(`    top_openings();`)
  P(`  }`)
  P(`}`)
  P(``)
  P(`// ---- print both: the lid is laid beside the tray`)
  P(`case_bottom();`)
  P(`translate([${f(pcbW)} + 2 * wall_offset + part_gap, 0, 0]) case_lid();`)
  P(``)

  const ok = !warnings.some((w) => w.level === "error")
  return {
    scad: L.join("\n"),
    params: {
      wall_thickness: o.wallThickness,
      floor_thickness: o.floorThickness,
      margin: o.margin,
      lid_thickness: o.lidThickness,
      standoff_height: o.standoffHeight,
      headroom: o.headroom,
      screw_size: o.screwSize,
      tol_slip: tol.slip,
      tol_opening: tol.opening,
      tol_screw_hole: tol.screwHole,
      tol_vertical_hole: tol.verticalHoleExtra,
      tol_mating: tol.mating,
      lip_height: o.lipHeight,
      lip_thickness: o.lipThickness,
      part_gap: o.partGap,
    },
    warnings,
    ok,
    stats: {
      standoffs: board.holes.length,
      edgeOpenings: edge.length,
      topOpenings: topOps.length,
      trayHeight: Math.round(trayHeight * 1000) / 1000,
      outerWidth: Math.round((pcbW + 2 * (o.margin + tol.slip + o.wallThickness)) * 1000) / 1000,
      outerHeight: Math.round((pcbH + 2 * (o.margin + tol.slip + o.wallThickness)) * 1000) / 1000,
    },
  }
}

function edgeCut(e: ResolvedOpening, b: { minX: number; minY: number; maxX: number; maxY: number }, o: CaseOptions): string[] {
  const out: string[] = []
  out.push(`  // ${e.ref}: ${e.label}, ${e.wall} wall`)
  // z of the opening's bottom, above the case floor
  const zb = `floor_thickness + standoff_height + board_thickness + ${f(e.z)} - opening_clearance`
  const w = `${f(e.width)} + 2 * opening_clearance`
  const h = `${f(e.height)} + 2 * opening_clearance`
  const depth = `wall_offset + 2`
  // The cut spans from just inside the cavity to just outside the shell, on that wall.
  if (e.wall === "y+") out.push(`  translate([${f(e.along!)} - (${w}) / 2, ${f(b.maxY)} + gap - 1, ${zb}]) cube([${w}, ${depth}, ${h}]);`)
  else if (e.wall === "y-") out.push(`  translate([${f(e.along!)} - (${w}) / 2, ${f(b.minY)} - gap - wall_thickness - 1, ${zb}]) cube([${w}, ${depth}, ${h}]);`)
  else if (e.wall === "x+") out.push(`  translate([${f(b.maxX)} + gap - 1, ${f(e.along!)} - (${w}) / 2, ${zb}]) cube([${depth}, ${w}, ${h}]);`)
  else out.push(`  translate([${f(b.minX)} - gap - wall_thickness - 1, ${f(e.along!)} - (${w}) / 2, ${zb}]) cube([${depth}, ${w}, ${h}]);`)
  return out
}

/**
 * How far the connector's outer edge is from the board edge it faces, measured along the wall's
 * normal and across the outline at the connector's position. A connector flush with the edge
 * gives ~0. A connector sitting well inside the board gives a large gap: the opening in the wall
 * would not reach it. Returns 0 when the geometry cannot be measured.
 */
export function edgeGap(outline: Pt[], fpEdgeCoord: number, wall: ResolvedOpening["wall"], along: number): number {
  // cast a ray from the connector's edge toward the wall and find where it leaves the outline
  const horizontal = wall === "x+" || wall === "x-"
  const dir = wall === "y+" || wall === "x+" ? 1 : -1
  let best = Infinity
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, c = outline[(i + 1) % outline.length]!
    // a and c in "ray space": u = across (along the wall), v = outward along the normal
    const au = horizontal ? a.y : a.x, av = (horizontal ? a.x : a.y) * dir
    const cu = horizontal ? c.y : c.x, cv = (horizontal ? c.x : c.y) * dir
    if ((au - along) * (cu - along) > 0) continue // segment does not straddle the ray
    if (au === cu) { if (au === along) best = Math.min(best, Math.max(av, cv) - fpEdgeCoord * dir); continue }
    const t = (along - au) / (cu - au)
    const v = av + t * (cv - av)
    const gap = v - fpEdgeCoord * dir
    if (gap >= -1e-9) best = Math.min(best, gap)
  }
  return Number.isFinite(best) ? Math.max(0, best) : 0
}

function cmpOpening(a: ResolvedOpening, b: ResolvedOpening): number {
  return a.ref.localeCompare(b.ref) || a.label.localeCompare(b.label)
}
