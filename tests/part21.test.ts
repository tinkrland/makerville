import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { parsePart21, decodeString, StepParseError, isRef, isEnum, isDerived, isTyped, type Part21 } from "../src/step/part21.ts"
import { REF } from "./fixtures.ts"

/** wrap DATA lines in a minimal valid file */
const file = (data: string, header = "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));") =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\n${header}\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`
const one = (data: string) => parsePart21(file(data))
const e = (p: Part21, id: number) => p.entities.get(id)!

test("a point: reference-free entity with a nested list", () => {
  const p = one("#1 = CARTESIAN_POINT('', (1.5, -2., .25));")
  assert.deepEqual(e(p, 1).args, ["", [1.5, -2, 0.25]])
  assert.equal(e(p, 1).type, "CARTESIAN_POINT")
})

test("every legal number form", () => {
  const p = one("#1 = X((1, 1., .5, -.5, +3, 1.E-3, 2.5E+2, 1e3, 0, -0.0, 123456789012));")
  assert.deepEqual(e(p, 1).args[0], [1, 1, 0.5, -0.5, 3, 0.001, 250, 1000, 0, -0, 123456789012])
})

test("references, forward references, and $ and *", () => {
  const p = one("#1 = A(#2, $, *);\n#2 = B();")
  const a = e(p, 1).args
  assert.ok(isRef(a[0]!) && (a[0] as any).ref === 2)
  assert.equal(a[1], null)
  assert.ok(isDerived(a[2]!))
  assert.equal(e(p, 2).args.length, 0)
})

test("enumerations and booleans", () => {
  const p = one("#1 = A(.T., .F., .MILLI., .unspecified., .NOT_A_NUMBER.);")
  assert.deepEqual(e(p, 1).args.map((x) => (x as any).enum), ["T", "F", "MILLI", "UNSPECIFIED", "NOT_A_NUMBER"])
})

test("a number that starts with a dot is not an enumeration", () => {
  assert.deepEqual(e(one("#1 = A((.5, .25, .75E1));"), 1).args[0], [0.5, 0.25, 7.5])
})

test("strings: doubled quotes, and every structural character inside a string is inert", () => {
  const p = one("#1 = A('it''s', 'a;b', 'c(d)e', 'f,g', 'h#12', '', '''');")
  assert.deepEqual(e(p, 1).args, ["it's", "a;b", "c(d)e", "f,g", "h#12", "", "'"])
})

test("a semicolon inside a string does not end the statement", () => {
  const p = one("#1 = A('x;y');\n#2 = B('z');")
  assert.equal(p.entities.size, 2)
  assert.equal(e(p, 1).args[0], "x;y")
})

test("string escapes: unicode, latin1, backslash", () => {
  assert.equal(decodeString("caf\\X2\\00E9\\X0\\"), "café")
  assert.equal(decodeString("\\X2\\00480069\\X0\\"), "Hi")
  assert.equal(decodeString("a\\X\\E9b"), "aéb")
  assert.equal(decodeString("a\\\\b"), "a\\b")
  assert.equal(decodeString("\\X4\\0001F600\\X0\\"), "😀")
  assert.equal(decodeString("plain"), "plain")
  assert.equal(decodeString("\\S\\i"), "é")
})

test("comments anywhere, including between tokens, in strings that look like comments, and in the header", () => {
  const p = parsePart21(`ISO-10303-21;\nHEADER;\n/* licence ; 'quote ( */\nFILE_SCHEMA(('X'));\nENDSEC;\nDATA;\n#1 = /* mid */ A(/* a */ 1 /* b */, 'not /* a comment */');\n/* between */\n#2 = B();\nENDSEC;\nEND-ISO-10303-21;`)
  assert.equal(p.entities.size, 2)
  assert.deepEqual(e(p, 1).args, [1, "not /* a comment */"])
})

test("a comment containing a quote or a semicolon does not break the string scanner", () => {
  const p = parsePart21(`ISO-10303-21;\nHEADER;\n/* it's; not (a string */\nFILE_SCHEMA(('X'));\nENDSEC;\nDATA;\n#1 = A('ok');\nENDSEC;\nEND-ISO-10303-21;`)
  assert.equal(e(p, 1).args[0], "ok")
})

test("entities spanning many lines, CRLF line endings, and odd spacing", () => {
  const p = parsePart21(file("#1=\r\n  CARTESIAN_POINT\r\n(\r\n''\r\n,\r\n(\r\n1.\r\n,\r\n2.\r\n,\r\n3.\r\n)\r\n)\r\n;\r\n#2=A  (  #1  )  ;").replace(/\n/g, "\r\n"))
  assert.deepEqual(e(p, 1).args, ["", [1, 2, 3]])
  assert.equal((e(p, 2).args[0] as any).ref, 1)
})

test("deeply nested lists", () => {
  assert.deepEqual(e(one("#1 = A(((1,2),(3,4)),((5),()));"), 1).args, [[[1, 2], [3, 4]], [[5], []]])
})

test("typed values inside an argument list", () => {
  const a = e(one("#1 = A(LENGTH_MEASURE(1.5), PLANE_ANGLE_MEASURE(0.5));"), 1).args
  assert.ok(isTyped(a[0]!)); assert.equal((a[0] as any).type, "LENGTH_MEASURE"); assert.deepEqual((a[0] as any).args, [1.5])
})

test("a complex entity keeps every member, in order, and presents the first as its type", () => {
  const p = one("#5 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );")
  const u = e(p, 5)
  assert.equal(u.type, "LENGTH_UNIT")
  assert.deepEqual(u.parts!.map((x) => x.type), ["LENGTH_UNIT", "NAMED_UNIT", "SI_UNIT"])
  assert.deepEqual((u.parts![2]!.args as any[]).map((x) => x.enum), ["MILLI", "METRE"])
  assert.ok(isDerived(u.parts![1]!.args[0]!))
})

test("a complex entity with no spacing and a trailing member that has arguments", () => {
  const u = e(one("#1=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#2))REPRESENTATION_CONTEXT('a','b'));"), 1)
  assert.deepEqual(u.parts!.map((x) => x.type), ["GEOMETRIC_REPRESENTATION_CONTEXT", "GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT", "REPRESENTATION_CONTEXT"])
  assert.deepEqual(u.parts![0]!.args, [3])
})

test("entity types are upper-cased, ids can be large, and ids need not be contiguous", () => {
  const p = one("#7 = cartesian_point('',(0.,0.,0.));\n#99999999 = A();")
  assert.equal(e(p, 7).type, "CARTESIAN_POINT")
  assert.ok(p.entities.has(99999999))
  assert.equal(p.entities.size, 2)
})

test("header: schema is extracted and the file name is available", () => {
  const p = parsePart21(`ISO-10303-21;\nHEADER;\nFILE_NAME('a b.step','2020',('me'),('org'),'pp','sys','');\nFILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;`)
  assert.equal(p.schema, "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF")
  assert.equal(p.header["FILE_NAME"]![0], "a b.step")
})

test("a malformed header record does not stop the geometry loading", () => {
  const p = parsePart21(`ISO-10303-21;\nHEADER;\nFILE_NAME('x', ,,, );\nFILE_SCHEMA(('X'));\nENDSEC;\nDATA;\n#1 = A();\nENDSEC;\nEND-ISO-10303-21;`)
  assert.equal(p.entities.size, 1)
})

test("a byte-order mark and a leading blank line are tolerated", () => {
  assert.equal(parsePart21("\ufeff" + file("#1 = A();")).entities.size, 1)
  assert.equal(parsePart21("\n\n  " + file("#1 = A();")).entities.size, 1)
})

test("a Uint8Array is decoded as latin1", () => {
  const bytes = new TextEncoder().encode(file("#1 = A('plain');"))
  assert.equal(e(parsePart21(bytes), 1).args[0], "plain")
})

test("an empty DATA section is a valid, empty model", () => {
  assert.equal(parsePart21(file("")).entities.size, 0)
})

// ---- failures must be loud and located, never a silent half-model
const bad = (data: string, re: RegExp, header?: string) => assert.throws(() => parsePart21(file(data, header)), (err: any) => err instanceof StepParseError && re.test(err.message), data)

test("errors: not a STEP file", () => {
  assert.throws(() => parsePart21("hello"), /not a STEP file/)
  assert.throws(() => parsePart21(""), /not a STEP file/)
  assert.throws(() => parsePart21("solid x\nendsolid"), /not a STEP file/)
})
test("errors: truncated file (no END-ISO-10303-21)", () => assert.throws(() => parsePart21("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1 = A();\n"), /truncated STEP file/))
test("errors: unterminated string, comment and list", () => {
  assert.throws(() => parsePart21("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1 = A('abc);\nENDSEC;\nEND-ISO-10303-21;"), /unterminated string/)
  assert.throws(() => parsePart21("ISO-10303-21;\nHEADER;\n/* never closed\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;"), /unterminated comment/)
  bad("#1 = A((1,2);", /expected "," or "\)"|end of entity/)
})
test("errors: duplicate entity id", () => bad("#1 = A();\n#1 = B();", /entity #1 is defined twice/))
test("errors: statement that is not an entity", () => bad("CARTESIAN_POINT('',(0,0,0));", /expected an entity like/))
test("errors: junk after an entity, missing parenthesis, bad number, bad reference", () => {
  bad("#1 = A() B();", /unexpected text|expected/)
  bad("#1 = A;", /expected "\("/)
  bad("#1 = A(#);", /malformed reference/)
  bad("#1 = A(1.2.3);", /expected "," or "\)"|unexpected/)
  bad("#1 = A(@);", /unexpected character "@"/)
})
test("errors: missing DATA section", () => assert.throws(() => parsePart21("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;"), /missing HEADER or DATA/))
test("errors: DATA never closed", () => assert.throws(() => parsePart21("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1 = A();\nEND-ISO-10303-21;"), /DATA section is not closed/))
test("error offsets point at the bad character, whatever whitespace precedes the entity", () => {
  // regression: statements were trimmed but their offset was not, so every leading newline shifted it early
  for (const lead of ["", "\n", "\n\n   ", "\r\n  \t", " ".repeat(40)]) {
    const text = file(`#1 = A();${lead}#2 = B(@);`)
    try { parsePart21(text); assert.fail("should throw") } catch (err: any) {
      assert.ok(err instanceof StepParseError)
      assert.equal(text[err.offset], "@", `lead ${JSON.stringify(lead)}: offset ${err.offset} -> ${JSON.stringify(text[err.offset])}`)
    }
  }
})

test("error offset inside a multi-line entity points at the right line", () => {
  const text = file("#1 = A(\n  1,\n  2,\n  @\n);")
  try { parsePart21(text); assert.fail("should throw") } catch (err: any) { assert.equal(text[err.offset], "@") }
})

// ---- real files
const real: [string, string][] = [
  ["R_0603 (KiCad library)", "circuit-json-to-step/test/fixtures/kicad-models/R_0603_1608Metric.step"],
  ["TO-92", "circuit-json-to-gltf/tests/assets/TO-92_Inline.step"],
  ["USB-C connector (EasyEDA/LCSC style)", "freerouting/fixtures/Issue558-dev-board-autoroute-demo/3d-models/TYPE-C-31-M-12.step"],
  ["PLCC44 socket (1.7 MB)", "freerouting/fixtures/Issue191-processor.Z80/plcc44.stp"],
]
for (const [name, rel] of real) {
  test(`real file parses and every entity id matches an independent regex count: ${name}`, { skip: !fs.existsSync(REF + rel) }, () => {
    const text = fs.readFileSync(REF + rel, "latin1")
    const p = parsePart21(text)
    const ids = new Set([...text.matchAll(/^#(\d+)\s*=/gm)].map((m) => Number(m[1])))
    assert.equal(p.entities.size, ids.size)
    for (const id of ids) assert.ok(p.entities.has(id), `#${id}`)
  })
}

test("real file: every reference points at an entity that exists (a complete, closed model)", { skip: !fs.existsSync(REF + real[2]![1]) }, () => {
  const p = parsePart21(fs.readFileSync(REF + real[2]![1], "latin1"))
  let refsSeen = 0
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (isRef(v as any)) { refsSeen++; assert.ok(p.entities.has((v as any).ref), `dangling #${(v as any).ref}`) }
    else if (isTyped(v as any)) walk((v as any).args)
  }
  for (const en of p.entities.values()) { walk(en.args); en.parts?.forEach((x) => walk(x.args)) }
  assert.ok(refsSeen > 20000, `only ${refsSeen} references`)
})

test("real file: the declared unit is millimetres and the schema is read", { skip: !fs.existsSync(REF + real[0]![1]) }, () => {
  const p = parsePart21(fs.readFileSync(REF + real[0]![1], "latin1"))
  assert.equal(p.schema, "AUTOMOTIVE_DESIGN")
  const units = [...p.entities.values()].filter((x) => x.parts?.some((q) => q.type === "SI_UNIT"))
  const length = units.find((u) => u.parts!.some((q) => q.type === "LENGTH_UNIT"))!
  const si = length.parts!.find((q) => q.type === "SI_UNIT")!
  assert.deepEqual((si.args as any[]).map((x) => x?.enum), ["MILLI", "METRE"])
})

test("performance: a 1.7 MB, 22k-entity file parses in under 2 seconds", { skip: !fs.existsSync(REF + real[3]![1]) }, () => {
  const text = fs.readFileSync(REF + real[3]![1], "latin1")
  const t0 = performance.now()
  parsePart21(text)
  assert.ok(performance.now() - t0 < 2000)
})

// ---- comment handling: each case below pins one way a naive stripper goes wrong
test("a string ending in an escaped quote followed by comment-like text stays a string", () => {
  // 'a''/* x */' is the string  a'/* x */  : the comment markers are inside the quotes
  const p = one("#1 = A('a''/* x */', 2);")
  assert.deepEqual(e(p, 1).args, ["a'/* x */", 2])
})

test("a quote inside a comment does not start a string, and the string after it still parses", () => {
  const p = one("#1 = A(/* don't */ 'real', /* it''s */ 3);")
  assert.deepEqual(e(p, 1).args, ["real", 3])
})

test("minimal and adjacent comments: /**/, comment right before a semicolon, comment right after one", () => {
  const p = one("#1 = A(1)/**/;/**/#2 = B(2)/* x */;/* y */")
  assert.equal(p.entities.size, 2)
  assert.deepEqual(e(p, 2).args, [2])
  assert.equal(one("#1 = A(/**/1/**/,/**/2/**/);").entities.get(1)!.args.length, 2)
})

test("a comment that ends exactly at the character after it: nothing is swallowed", () => {
  // "/*x*/1" must leave the 1 alone; an off-by-one in the comment end eats it
  assert.deepEqual(e(one("#1 = A(/*x*/1,/*y*/2);"), 1).args, [1, 2])
  assert.deepEqual(e(one("#1 = A(1/*x*/);"), 1).args, [1])
})

test("a comment does not move the offset of an error that comes after it", () => {
  const text = file("#1 = A(/* a fairly long comment that must keep its width */ @);")
  try { parsePart21(text); assert.fail("should throw") } catch (err: any) { assert.equal(text[err.offset], "@") }
  const multi = file("#1 = A(/* line one\n line two\n line three */ @);")
  try { parsePart21(multi); assert.fail("should throw") } catch (err: any) { assert.equal(multi[err.offset], "@") }
})

test("comment markers inside a header string are not comments", () => {
  const p = parsePart21(`ISO-10303-21;\nHEADER;\nFILE_NAME('a/*b*/c.step');\nFILE_SCHEMA(('X'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;`)
  assert.equal(p.header["FILE_NAME"]![0], "a/*b*/c.step")
})

test("an empty complex entity is rejected", () => {
  bad("#1 = ();", /empty complex entity|expected/)
  bad("#1 = (   );", /empty complex entity|expected/)
})

test("a complex entity member is a type with parentheses, not a bare word", () => {
  bad("#1 = (A B());", /expected "\("/)
})
