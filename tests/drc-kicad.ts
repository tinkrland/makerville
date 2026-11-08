// A board with exactly one deliberate fault of each kind, for comparing against KiCad.
import { newBoard, ensureNet, padWorld } from "../src/model.ts"
import { resistor, header } from "../src/library.ts"
import type { Board } from "../src/model.ts"

export function dirtyBoard(): Board {
  const b = newBoard("dirty", 60, 40)
  const R1 = resistor("R1", "0603", { at: { x: -20, y: 10 } })
  const R2 = resistor("R2", "0603", { at: { x: -10, y: 10 } })
  const R3 = resistor("R3", "0603", { at: { x: 0, y: 10 } })
  const J1 = header("J1", 2, 1, { at: { x: 10, y: 10 } })
  b.footprints.push(R1, R2, R3, J1)
  const net = (f: any, n: string, name: string) => { f.pads.find((p: any) => p.name === n).net = name; ensureNet(b, name) }
  net(R1, "2", "A"); net(R2, "1", "B"); net(R3, "1", "C"); net(R3, "2", "A"); net(J1, "1", "A"); net(J1, "2", "B")
  const T = (id: string, a: any, c: any, w: number, layer: string, n: string) => b.tracks.push({ id, a, b: c, width: w, layer, net: n })

  // 1. clearance: two parallel tracks on different nets, 0.1 mm apart (rule 0.2)
  ensureNet(b, "P"); ensureNet(b, "Q")
  T("clr1", { x: -25, y: 0 }, { x: -15, y: 0 }, 0.25, "F.Cu", "P")
  T("clr2", { x: -25, y: 0.35 }, { x: -15, y: 0.35 }, 0.25, "F.Cu", "Q")
  // 2. short: two different-net tracks that cross on the same layer
  ensureNet(b, "S1"); ensureNet(b, "S2")
  T("sh1", { x: -5, y: -3 }, { x: 5, y: 3 }, 0.25, "F.Cu", "S1")
  T("sh2", { x: -5, y: 3 }, { x: 5, y: -3 }, 0.25, "F.Cu", "S2")
  // 3. track too narrow (min 0.15)
  ensureNet(b, "N")
  T("thin", { x: 12, y: -10 }, { x: 22, y: -10 }, 0.1, "F.Cu", "N")
  // 4. via too small + ring too thin
  b.vias.push({ id: "vsmall", at: { x: -20, y: -15 }, diameter: 0.4, drill: 0.3, from: "F.Cu", to: "B.Cu", net: "N" })
  // 5. track too near the board edge (outline half width 30): centre at x=29.8
  ensureNet(b, "E")
  T("edge", { x: 29.8, y: -10 }, { x: 29.8, y: 10 }, 0.25, "F.Cu", "E")
  // 6. two mounting holes almost touching
  b.holes.push({ id: "HH1", at: { x: 0, y: -15 }, drill: 2, pad: 2.6 }, { id: "HH2", at: { x: 2.3, y: -15 }, drill: 2, pad: 2.6 })
  return b
}
