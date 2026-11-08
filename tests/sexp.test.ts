import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parse, write, num, sym, str, head, all, first, field, textField, isList } from "../src/sexp.ts"

test("numbers print like KiCad: no trailing zeros, no exponent, no -0", () => {
  assert.equal(num(1).atom, "1")
  assert.equal(num(0.15).atom, "0.15")
  assert.equal(num(-0).atom, "0")
  assert.equal(num(1e-9).atom, "0")
  assert.equal(num(104.825).atom, "104.825")
  assert.equal(num(0.1 + 0.2).atom, "0.3")
  assert.throws(() => num(NaN))
})

test("quoted-ness survives a round trip", () => {
  const t = '(footprint "tscircuit:R_0402" (layer F.Cu) (property "Reference" "R1"))'
  const l = parse(t)
  assert.deepEqual(parse(write(l)), l)
  const lib = l[1] as any
  const layer = (l[2] as any)[1]
  assert.equal(lib.quoted, true)
  assert.equal(layer.quoted, false)
  // flat lists stay on one line, nested ones break
  assert.match(write(l), /\n  \(layer F\.Cu\)\n/)
})

test("escapes in strings", () => {
  const l = parse('(a "he said \\"hi\\"\\nline2")')
  assert.equal((l[1] as any).atom, 'he said "hi"\nline2')
  assert.equal(write(l).trim(), '(a "he said \\"hi\\"\\nline2")')
})

test("errors say where", () => {
  assert.throws(() => parse("(a (b"), /unterminated list/)
  assert.throws(() => parse('(a "b'), /unterminated string/)
  assert.throws(() => parse("a"), /expected '\('/)
  assert.throws(() => parse("(a) (b)"), /trailing/)
})

test("query helpers", () => {
  const l = parse('(seg (start 1 2) (width 0.15) (layer "F.Cu") (net 3))')
  assert.equal(head(l), "seg")
  assert.equal(field(l, "width"), 0.15)
  assert.equal(textField(l, "layer"), "F.Cu")
  assert.equal(all(l, "net").length, 1)
  assert.equal(field(l, "start", 2), 2)
  assert.equal(field(l, "missing"), undefined)
})

// the strongest check: real files saved by KiCad itself must parse, and
// write -> parse must give back an identical tree
const real = [
  "../refs/circuit-json-to-kicad/tests/assets/joule-thief.kicad_pcb",
  "../refs/circuit-json-to-kicad/tests/assets/basics17-copper-pour.kicad_pcb",
  "../refs/circuit-json-to-kicad/tests/assets/basics15-plated-hole-shapes.kicad_pcb",
  "../refs/circuit-json-to-kicad/tests/assets/repro13-schematic-sections-sch.kicad_sch",
]
for (const f of real) {
  test(`real KiCad file round-trips: ${f.split("/").pop()}`, () => {
    if (!fs.existsSync(f)) return
    const text = fs.readFileSync(f, "utf8")
    const a = parse(text)
    const b = parse(write(a))
    assert.deepEqual(b, a)
    assert.ok(isList(a) && a.length > 3)
  })
}
