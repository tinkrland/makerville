// helper shared by router tests: build a board that needs a via, route it, hand to KiCad
import { newBoard, ensureNet } from "../src/model.ts"
import { resistor, header, soicIc, capacitor, led } from "../src/library.ts"
import type { Board } from "../src/model.ts"

export function crossingBoard(): Board {
  const b = newBoard("cross", 40, 28)
  const J1 = header("J1", 4, 1, { at: { x: -16, y: 0 } })           // vertical column on the left
  const J2 = header("J2", 4, 1, { at: { x: 16, y: 0 } })            // vertical column on the right
  const R1 = resistor("R1", "0603", { at: { x: -4, y: 6 } })
  const R2 = resistor("R2", "0603", { at: { x: 4, y: -6 } })
  const C1 = capacitor("C1", "0603", { at: { x: 0, y: 0 }, rotation: 90 })
  const U1 = soicIc("U1", 8, { at: { x: 0, y: 0 } })
  b.footprints.push(J1, J2, R1, R2, C1)
  const set = (f: any, n: string, net: string) => { const p = f.pads.find((q: any) => q.name === n); if (!p) throw new Error(`${f.ref}.${n}`); p.net = net; ensureNet(b, net) }
  // J1 -> J2 in reversed order forces the four nets to cross over each other
  set(J1, "1", "A"); set(J2, "4", "A")
  set(J1, "2", "B"); set(J2, "3", "B")
  set(J1, "3", "C"); set(J2, "2", "C")
  set(J1, "4", "D"); set(J2, "1", "D")
  // a decoupling-style pair in the middle
  set(R1, "1", "A"); set(R1, "2", "E"); set(R2, "1", "E"); set(R2, "2", "D")
  b.holes.push({ id: "H1", at: { x: -16.5, y: 11 }, drill: 2.2, pad: 3.4 }, { id: "H2", at: { x: 16.5, y: 11 }, drill: 2.2, pad: 3.4 }, { id: "H3", at: { x: -16.5, y: -11 }, drill: 2.2, pad: 3.4 }, { id: "H4", at: { x: 16.5, y: -11 }, drill: 2.2, pad: 3.4 })
  return b
}
