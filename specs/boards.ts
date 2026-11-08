// The reference boards the case generator is pinned against. Each one exercises a different
// derivation, so a change to any rule shows up as a golden diff on the board it affects.
import { newBoard, roundedRectOutline, type Board } from "../src/model.ts"
import type { CaseOptions } from "../src/case/generate.ts"
import { usbCReceptacle, header, resistor, soicIc, capacitor } from "../src/library.ts"

const holes = (b: Board, x: number, y: number) => {
  b.holes.push({ id: "H1", at: { x: -x, y }, drill: 2.2, pad: 4 }, { id: "H2", at: { x, y }, drill: 2.2, pad: 4 }, { id: "H3", at: { x: -x, y: -y }, drill: 2.2, pad: 4 }, { id: "H4", at: { x, y: -y }, drill: 2.2, pad: 4 })
}

export const BOARDS: [string, () => Board, Partial<CaseOptions>?][] = [
  // the plain case: a USB-C on the +y wall, a header, four corner holes
  ["usb-header", () => {
    const b = newBoard("usb-header", 50, 30)
    b.footprints.push(usbCReceptacle("J1", { at: { x: 0, y: 11 }, rotation: 180 }), header("J2", 4, 1, { at: { x: 18, y: 0 } }), resistor("R1", "0603", { at: { x: -10, y: 0 } }), soicIc("U1", 8, { at: { x: 0, y: -2 } }))
    holes(b, 22, 12)
    return b
  }],
  // a connector on every wall, so each wall derivation is pinned
  ["four-walls", () => {
    const b = newBoard("four-walls", 60, 40)
    b.footprints.push(
      usbCReceptacle("J1", { at: { x: 0, y: 16 }, rotation: 180 }),
      usbCReceptacle("J2", { at: { x: 0, y: -16 }, rotation: 0 }),
      usbCReceptacle("J3", { at: { x: 26, y: 0 }, rotation: 90 }),
      usbCReceptacle("J4", { at: { x: -26, y: 0 }, rotation: 270 }),
    )
    holes(b, 27, 17)
    return b
  }],
  // a part on the underside: the standoffs must lift the board clear of it
  ["bottom-parts", () => {
    const b = newBoard("bottom-parts", 44, 28)
    b.footprints.push(header("J1", 6, 1, { at: { x: 0, y: 0 }, side: "bottom" }), resistor("R1", "0603", { at: { x: -12, y: 6 } }), capacitor("C1", "0603", { at: { x: 12, y: 6 } }))
    holes(b, 19, 11)
    return b
  }, { standoffHeight: 9 }],
  // a rounded outline, not a rectangle: the cavity must follow it
  ["rounded", () => {
    const b = newBoard("rounded", 56, 34)
    b.outline = roundedRectOutline(56, 34, 6)
    b.footprints.push(usbCReceptacle("J1", { at: { x: 0, y: 12 }, rotation: 180 }), soicIc("U1", 8, { at: { x: 0, y: -3 } }))
    holes(b, 23, 12)
    return b
  }],
  // an L-shaped board, to prove the case follows any outline
  ["l-shape", () => {
    const b = newBoard("l-shape", 40, 40)
    b.outline = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: -4 }, { x: -4, y: -4 }, { x: -4, y: 20 }, { x: -20, y: 20 }]
    b.footprints.push(usbCReceptacle("J1", { at: { x: -12, y: 16 }, rotation: 180 }), resistor("R1", "0603", { at: { x: 8, y: -12 } }))
    b.holes.push({ id: "H1", at: { x: -16, y: 16 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 16, y: -16 }, drill: 2.2, pad: 4 }, { id: "H3", at: { x: -16, y: -16 }, drill: 2.2, pad: 4 })
    return b
  }],
  // the same board as usb-header under the ideal profile: the golden diff between these two IS the tolerance model
  ["usb-header-ideal", () => {
    const b = newBoard("usb-header", 50, 30)
    b.footprints.push(usbCReceptacle("J1", { at: { x: 0, y: 11 }, rotation: 180 }), header("J2", 4, 1, { at: { x: 18, y: 0 } }), resistor("R1", "0603", { at: { x: -10, y: 0 } }), soicIc("U1", 8, { at: { x: 0, y: -2 } }))
    holes(b, 22, 12)
    return b
  }, { profile: "ideal" }],
  // a resin printer with M3 screws and a thicker lid
  ["usb-header-resin-m3", () => {
    const b = newBoard("usb-header", 50, 30)
    b.footprints.push(usbCReceptacle("J1", { at: { x: 0, y: 11 }, rotation: 180 }), header("J2", 4, 1, { at: { x: 18, y: 0 } }))
    holes(b, 22, 12)
    for (const h of b.holes) h.drill = 3.2
    return b
  }, { profile: "resin", screwSize: 3, lidThickness: 2.5 }],
]
