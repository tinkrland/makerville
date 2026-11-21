/**
 * Face and solid colours from the STEP presentation structure.
 *
 * The chain is long but unambiguous, and every link is required:
 *
 *   STYLED_ITEM(name, [styles], item)          item is the solid or face being coloured
 *     PRESENTATION_STYLE_ASSIGNMENT([style])
 *       SURFACE_STYLE_USAGE(.BOTH., side_style)
 *         SURFACE_SIDE_STYLE(name, [surface_style])
 *           SURFACE_STYLE_FILL_AREA(fill_area)
 *             FILL_AREA_STYLE(name, [fill_area_style])
 *               FILL_AREA_STYLE_COLOUR(name, colour)
 *                 COLOUR_RGB(name, r, g, b)
 *
 * Colour is per styled ITEM, which is usually a whole MANIFOLD_SOLID_BREP, not per face; a face can be
 * styled too, and then it overrides its solid. Callers should look up the face first and fall back to the
 * solid. Components are usually styled per solid, so a connector body is one colour and its contacts another.
 *
 * Nothing here guesses. A style that cannot be followed produces a named warning and is skipped, so a model
 * that renders grey says why rather than looking like it had no colour to begin with.
 */
import { type Part21, type Entity, type Value, isRef } from "./part21.ts"

export interface Rgb {
  r: number
  g: number
  b: number
}

/** simple entities start with a name; complex members do not */
function argsAfterName(e: Entity, args: Value[]): Value[] {
  const first = args[0]
  return e.parts ? args : typeof first === "string" || first === null ? args.slice(1) : args
}

function deref(p: Part21, v: Value | undefined): Entity | null {
  if (!isRef(v)) return null
  return p.entities.get(v.ref) ?? null
}

/** COLOUR_RGB(name, red, green, blue) -> 0..1 components, clamped because exporters emit 1.0000001 */
function rgbOf(e: Entity): Rgb | null {
  if (e.type !== "COLOUR_RGB") return null
  const a = argsAfterName(e, e.args)
  const nums = a.filter((v): v is number => typeof v === "number")
  if (nums.length < 3) return null
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  return { r: clamp(nums[0]!), g: clamp(nums[1]!), b: clamp(nums[2]!) }
}

/**
 * Walk from a style entity down to a colour, following whichever of the documented links this exporter used.
 * Returns null when the chain dead-ends, and the caller reports that.
 */
function colourThrough(p: Part21, style: Entity, depth = 0): Rgb | null {
  if (depth > 8) return null
  const direct = rgbOf(style)
  if (direct) return direct
  const a = argsAfterName(style, style.args)
  // every link in the chain carries its children as refs or as a list of refs
  const children: Value[] = []
  for (const v of a) {
    if (isRef(v)) children.push(v)
    else if (Array.isArray(v)) for (const w of v) if (isRef(w)) children.push(w)
  }
  for (const c of children) {
    const child = deref(p, c)
    if (!child) continue
    const hit = colourThrough(p, child, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * Map every styled entity id (solid or face) to its colour. When an item is styled more than once the first
 * colour wins, which matches how these files are written: one style per item.
 */
export function itemColours(p: Part21, warnings: string[] = []): Map<number, Rgb> {
  const out = new Map<number, Rgb>()
  for (const e of [...p.entities.values()].sort((x, y) => x.id - y.id)) {
    if (e.type !== "STYLED_ITEM") continue
    const a = argsAfterName(e, e.args)
    const item = a[1]
    const styles = a[0]
    if (!isRef(item)) {
      warnings.push(`STYLED_ITEM #${e.id} does not name the item it colours; skipped`)
      continue
    }
    if (out.has(item.ref)) continue
    const styleRefs: Value[] = Array.isArray(styles) ? styles : isRef(styles) ? [styles] : []
    let found: Rgb | null = null
    for (const s of styleRefs) {
      const ent = deref(p, s)
      if (!ent) continue
      found = colourThrough(p, ent)
      if (found) break
    }
    if (found) out.set(item.ref, found)
    else warnings.push(`STYLED_ITEM #${e.id} colours #${item.ref}, but its style chain reaches no COLOUR_RGB; that item will use the default colour`)
  }
  return out
}
