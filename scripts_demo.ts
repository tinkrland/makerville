import fs from "node:fs"
import { newBoard, ensureNet, uid } from "./src/model.ts"
import { resistor, led, header, capacitor } from "./src/library.ts"
import { writeKicadPcb } from "./src/kicad-write.ts"
import { padWorld } from "./src/model.ts"

const b = newBoard("led-demo", 34, 22)
const J1 = header("J1", 2, 1, { at: { x: -11, y: 0 } })
const R1 = resistor("R1", "0402", { at: { x: -3, y: 0 }, value: "330" })
const D1 = led("D1", "0603", { at: { x: 6, y: 0 }, value: "LED" })
b.footprints.push(J1, R1, D1)
const set = (f: any, pad: string, net: string) => { f.pads.find((p: any) => p.name === pad).net = net; ensureNet(b, net) }
set(J1, "1", "VIN"); set(R1, "1", "VIN"); set(R1, "2", "LEDA"); set(D1, "1", "LEDA"); set(D1, "2", "GND"); set(J1, "2", "GND")
// a track from J1.1 to R1.1 (L-shaped), straight R1.2 -> D1.1
const w = (f: any, n: string) => padWorld(f, f.pads.find((p: any) => p.name === n))
const seg = (a: any, c: any, net: string) => b.tracks.push({ id: uid("t"), a, b: c, width: 0.25, layer: "F.Cu", net })
const j1 = w(J1, "1"), j2 = w(J1, "2"), r1 = w(R1, "1"), d2 = w(D1, "2")
// header pins are stacked vertically at x=-11: pin1 on top (y=+1.27), pin2 below (y=-1.27)
seg(j1, { x: r1.x, y: j1.y }, "VIN"); seg({ x: r1.x, y: j1.y }, r1, "VIN")
seg(w(R1, "2"), w(D1, "1"), "LEDA")
// GND returns underneath everything on the back layer through two vias
const vi = (p: any) => b.vias.push({ id: uid("v"), at: p, diameter: 0.8, drill: 0.4, from: "F.Cu", to: "B.Cu", net: "GND" })
const gv = { x: j2.x + 3, y: j2.y - 3 }, dv = { x: d2.x + 2, y: d2.y }
seg(j2, gv, "GND"); vi(gv)
b.tracks.push({ id: uid("t"), a: gv, b: { x: dv.x, y: gv.y }, width: 0.4, layer: "B.Cu", net: "GND" })
b.tracks.push({ id: uid("t"), a: { x: dv.x, y: gv.y }, b: dv, width: 0.4, layer: "B.Cu", net: "GND" })
vi(dv); seg(dv, d2, "GND")
b.holes.push({ id: "H1", at: { x: -14, y: 8 }, drill: 2.2, pad: 4 }, { id: "H2", at: { x: 14, y: 8 }, drill: 2.2, pad: 4 }, { id: "H3", at: { x: -14, y: -8 }, drill: 2.2, pad: 4 }, { id: "H4", at: { x: 14, y: -8 }, drill: 2.2, pad: 4 })
fs.writeFileSync("/tmp/bf_demo.kicad_pcb", writeKicadPcb(b))
console.log("wrote", fs.statSync("/tmp/bf_demo.kicad_pcb").size, "bytes")
