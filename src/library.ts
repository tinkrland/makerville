/**
 * Built-in parametric footprints. Everything is generated from numbers, so no
 * library files are fetched and nothing needs the network.
 *
 * Dimensions follow the common IPC / manufacturer land patterns for hand and
 * reflow assembly. Body size and height feed the enclosure generator.
 */
import type { Footprint, Pad, FootprintGraphic, CopperLayer } from "./model.ts"

type Spec = { lib: string; pads: Pad[]; body: { w: number; h: number }; height: number; courtyard?: number }

const smd = (name: string, x: number, y: number, w: number, h: number, shape: Pad["shape"] = "rect", layer: CopperLayer = "F.Cu"): Pad => ({ name, kind: "smd", shape, at: { x, y }, size: { w, h }, layers: [layer], net: "" })
const thru = (name: string, x: number, y: number, d: number, drill: number, shape: Pad["shape"] = "circle", cu: CopperLayer[] = ["F.Cu", "B.Cu"]): Pad => ({ name, kind: "thru", shape, at: { x, y }, size: { w: d, h: d }, drill, layers: cu, net: "" })

const box = (hw: number, hh: number, layer: string, width: number): FootprintGraphic => ({ kind: "rect", layer, a: { x: -hw, y: -hh }, b: { x: hw, y: hh }, width })

/** chip passives: 0201 0402 0603 0805 1206 */
const CHIP: Record<string, { l: number; w: number; pad: [number, number]; pitch: number; h: number }> = {
  "0201": { l: 0.6, w: 0.3, pad: [0.3, 0.3], pitch: 0.66, h: 0.3 },
  "0402": { l: 1.0, w: 0.5, pad: [0.54, 0.64], pitch: 1.02, h: 0.5 },
  "0603": { l: 1.6, w: 0.8, pad: [0.8, 0.95], pitch: 1.6, h: 0.8 },
  "0805": { l: 2.0, w: 1.25, pad: [1.0, 1.45], pitch: 1.9, h: 1.1 },
  "1206": { l: 3.2, w: 1.6, pad: [1.15, 1.8], pitch: 3.0, h: 1.1 },
}

function chip(prefix: string, size: string): Spec {
  const c = CHIP[size]
  if (!c) throw new Error(`unknown chip size ${size}`)
  const x = c.pitch / 2
  return {
    lib: `boardforge:${prefix}_${size}`,
    pads: [smd("1", -x, 0, c.pad[0], c.pad[1]), smd("2", x, 0, c.pad[0], c.pad[1])],
    body: { w: c.l, h: c.w },
    height: c.h,
    courtyard: 0.25,
  }
}

function soic(pins: number, pitch = 1.27, span = 5.4, padW = 0.6, padH = 1.55, bodyW = 3.9, bodyL = 4.9, height = 1.75): Spec {
  const half = pins / 2
  const pads: Pad[] = []
  for (let i = 0; i < half; i++) {
    const y = ((half - 1) / 2 - i) * pitch
    pads.push(smd(String(i + 1), -span / 2, -y, padH, padW))
    pads.push(smd(String(pins - i), span / 2, -y, padH, padW))
  }
  return { lib: `boardforge:SOIC-${pins}_${pitch}mm`, pads, body: { w: bodyW, h: Math.max(bodyL, half * pitch) }, height, courtyard: 0.25 }
}

function sot23(pins: 3 | 5 | 6): Spec {
  const pads: Pad[] = []
  if (pins === 3) {
    pads.push(smd("1", -1.0, -0.95, 1.0, 0.6), smd("2", -1.0, 0.95, 1.0, 0.6), smd("3", 1.0, 0, 1.0, 0.6))
  } else {
    const rows = pins === 5 ? [-0.95, 0.95] : [-0.95, 0, 0.95]
    rows.forEach((y, i) => pads.push(smd(String(i + 1), -1.1, y, 1.0, 0.6)))
    const top = pins === 5 ? [0.95] : [0.95, 0, -0.95]
    top.forEach((y, i) => pads.push(smd(String(rows.length + i + 1), 1.1, y, 1.0, 0.6)))
  }
  return { lib: `boardforge:SOT-23-${pins}`, pads, body: { w: 1.6, h: 2.9 }, height: 1.15, courtyard: 0.25 }
}

function pinHeader(n: number, rows: 1 | 2, pitch = 2.54): Spec {
  const pads: Pad[] = []
  const d = Math.min(1.7, pitch - 0.7)
  const drill = pitch >= 2.5 ? 1.0 : 0.7
  const per = n / rows
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < per; i++) {
      const y = i * pitch - ((per - 1) * pitch) / 2
      const x = rows === 1 ? 0 : (r - 0.5) * pitch
      pads.push(thru(String(r * per + i + 1), x, -y, d, drill, i === 0 && r === 0 ? "rect" : "circle"))
    }
  }
  return { lib: `boardforge:PinHeader_${rows}x${per}_P${pitch}mm`, pads, body: { w: rows * pitch, h: per * pitch }, height: 8.5, courtyard: 0.25 }
}

/** USB-C 16 pin receptacle, mid-mount. Shell tabs are the mechanical anchors. */
function usbc(): Spec {
  const pads: Pad[] = []
  const xs = [-3.2, -2.4, -1.75, -1.25, -0.75, -0.25, 0.25, 0.75, 1.25, 1.75, 2.4, 3.2]
  xs.forEach((x, i) => pads.push(smd(String(i + 1), x, -3.8, 0.3 + (i === 0 || i === 11 || i === 1 || i === 10 ? 0.3 : 0), 1.1)))
  pads.push(thru("S1", -4.32, -1.0, 1.1, 0.6, "oval"), thru("S1", 4.32, -1.0, 1.1, 0.6, "oval"), thru("S1", -4.32, 2.6, 1.1, 0.6, "oval"), thru("S1", 4.32, 2.6, 1.1, 0.6, "oval"))
  return { lib: "boardforge:USB-C_Receptacle_16P", pads, body: { w: 8.94, h: 7.3 }, height: 3.26, courtyard: 0.3 }
}

export type Kind = "R" | "C" | "L" | "LED" | "D"

export interface PlaceOpts {
  at?: { x: number; y: number }
  rotation?: number
  side?: "top" | "bottom"
  value?: string
}

function finish(ref: string, s: Spec, o: PlaceOpts, value: string): Footprint {
  const cy = s.courtyard ?? 0.25
  const hw = s.body.w / 2 + cy
  const hh = s.body.h / 2 + cy
  const xs = s.pads.map((p) => Math.abs(p.at.x) + p.size.w / 2)
  const ys = s.pads.map((p) => Math.abs(p.at.y) + p.size.h / 2)
  const cw = Math.max(hw, ...xs) + 0.1
  const ch = Math.max(hh, ...ys) + 0.1
  const graphics: FootprintGraphic[] = [box(s.body.w / 2, s.body.h / 2, "F.Fab", 0.1), box(cw, ch, "F.CrtYd", 0.05)]
  return {
    ref,
    value,
    lib: s.lib,
    at: o.at ?? { x: 0, y: 0 },
    rotation: o.rotation ?? 0,
    side: o.side ?? "top",
    pads: s.pads.map((p) => ({ ...p, at: { ...p.at }, size: { ...p.size }, layers: [...p.layers] })),
    graphics,
    height: s.height,
    body: { ...s.body },
  }
}

export function resistor(ref: string, size = "0402", o: PlaceOpts = {}): Footprint {
  return finish(ref, chip("R", size), o, o.value ?? "10k")
}
export function capacitor(ref: string, size = "0402", o: PlaceOpts = {}): Footprint {
  return finish(ref, chip("C", size), o, o.value ?? "100nF")
}
export function led(ref: string, size = "0603", o: PlaceOpts = {}): Footprint {
  const s = chip("LED", size)
  s.pads[0]!.name = "1"
  s.pads[1]!.name = "2"
  return finish(ref, s, o, o.value ?? "LED")
}
export function soicIc(ref: string, pins: number, o: PlaceOpts = {}): Footprint {
  return finish(ref, soic(pins), o, o.value ?? "IC")
}
export function sot(ref: string, pins: 3 | 5 | 6, o: PlaceOpts = {}): Footprint {
  return finish(ref, sot23(pins), o, o.value ?? "Q")
}
export function header(ref: string, pins: number, rows: 1 | 2 = 1, o: PlaceOpts & { pitch?: number } = {}): Footprint {
  return finish(ref, pinHeader(pins, rows, o.pitch ?? 2.54), o, o.value ?? `Conn_${rows}x${pins / rows}`)
}
export function usbCReceptacle(ref: string, o: PlaceOpts = {}): Footprint {
  return finish(ref, usbc(), o, o.value ?? "USB-C")
}

export const CHIP_SIZES = Object.keys(CHIP)
