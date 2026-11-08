/**
 * ISO 10303-21 ("Part 21") reader: the text container STEP files use.
 *
 * This layer knows nothing about geometry. It turns the file into entities:
 *
 *   #12 = CARTESIAN_POINT('', (1.0, 2.0, 3.0));
 *
 * becomes { id: 12, type: "CARTESIAN_POINT", args: ["", [1, 2, 3]] }.
 *
 * What makes real files awkward, and what is handled here:
 *   - comments  /* ... *​/  can appear anywhere, including inside the licence header
 *   - strings   'it''s' uses a doubled quote, and may contain  ;  ( ) , # that must not be parsed
 *   - lists     nest arbitrarily: ((1,2),(3,4))
 *   - typed     values: LENGTH_MEASURE(1.5) or COLOUR_RGB(...) inside an argument list
 *   - complex   entities: #5=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.)); several types, one id
 *   - markers   $ (not given), * (derived), .T. .F. .UNSPECIFIED. enumerations
 *   - references  #123 point at other entities and may point forward
 *   - numbers   1., .5, 1.E-3, -2, all legal
 *   - encoding  \X2\00E9\X0\ unicode escapes in strings
 *   - CRLF line endings and entities that span many lines
 *
 * Original code, written against the public ISO 10303-21 grammar. No parser was ported.
 */

export type Value = number | string | null | Ref | Enum | Derived | Typed | Value[]

/** a reference to another entity: #123 */
export interface Ref { ref: number }
/** an enumeration or boolean: .T. .F. .MILLI. */
export interface Enum { enum: string }
/** the derived marker: * */
export interface Derived { derived: true }
/** a typed value: LENGTH_MEASURE(1.5) */
export interface Typed { type: string; args: Value[] }

export interface Entity {
  id: number
  /** the entity type, upper case. For a complex entity this is the first member. */
  type: string
  args: Value[]
  /** present for complex entities: every member type with its own arguments, in file order */
  parts?: { type: string; args: Value[] }[]
}

export interface Part21 {
  /** HEADER section entities, e.g. FILE_NAME, keyed by type */
  header: Record<string, Value[]>
  entities: Map<number, Entity>
  /** the declared schema, e.g. "AUTOMOTIVE_DESIGN" or "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF" */
  schema: string | null
}

export class StepParseError extends Error {
  offset: number
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`)
    this.name = "StepParseError"
    this.offset = offset
  }
}

export const isRef = (v: Value): v is Ref => typeof v === "object" && v !== null && !Array.isArray(v) && "ref" in v
export const isEnum = (v: Value): v is Enum => typeof v === "object" && v !== null && !Array.isArray(v) && "enum" in v
export const isDerived = (v: Value): v is Derived => typeof v === "object" && v !== null && !Array.isArray(v) && "derived" in v
export const isTyped = (v: Value): v is Typed => typeof v === "object" && v !== null && !Array.isArray(v) && "type" in v && "args" in v

/** decode STEP string escapes: '' -> ', \\ -> \, \X2\hhhh\X0\ -> unicode, \X\hh -> latin1, \S\c -> shifted latin1 */
export function decodeString(raw: string): string {
  if (!raw.includes("\\")) return raw
  let s = raw.replace(/\\X2\\([0-9A-Fa-f]*)\\X0\\/g, (_, hex: string) => {
    let out = ""
    for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    return out
  })
  s = s.replace(/\\X4\\([0-9A-Fa-f]*)\\X0\\/g, (_, hex: string) => {
    let out = ""
    for (let i = 0; i + 7 < hex.length + 1; i += 8) out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16))
    return out
  })
  s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
  s = s.replace(/\\\\/g, "\\")
  return s
}

/** Blank out comments, keeping string contents and byte offsets, so error offsets still mean something. */
function stripComments(src: string): string {
  const out: string[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    if (c === "'") {
      // A string: copy it through, so comment markers inside it are left alone. An escaped quote ('')
      // needs no special case here: it reads as the end of one string and the start of the next, which
      // copies exactly the same characters. (Verified by mutation: removing the case changes nothing.)
      const j = src.indexOf("'", i + 1)
      if (j < 0) throw new StepParseError("unterminated string", i)
      out.push(src.slice(i, j + 1))
      i = j + 1
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      if (end < 0) throw new StepParseError("unterminated comment", i)
      // keep newlines so line-based error reporting still works; replace the rest with spaces
      out.push(src.slice(i, end + 2).replace(/[^\n]/g, " "))
      i = end + 2
    } else {
      out.push(c)
      i++
    }
  }
  return out.join("")
}

/** a tiny recursive-descent reader over one entity's text */
class Reader {
  i = 0
  s: string
  base: number
  constructor(s: string, base: number) {
    this.s = s
    this.base = base
  }
  err(m: string): never { throw new StepParseError(m, this.base + this.i) }
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++ }
  peek() { this.ws(); return this.s[this.i] }
  eof() { this.ws(); return this.i >= this.s.length }

  /** one value: number, string, ref, enum, $, *, list, or TYPE(args) */
  value(): Value {
    this.ws()
    const c = this.s[this.i]
    if (c === undefined) this.err("expected a value, found end of entity")
    if (c === "'") return this.string()
    if (c === "#") return this.ref()
    if (c === "$") { this.i++; return null }
    if (c === "*") { this.i++; return { derived: true } }
    if (c === ".") return this.enumOrNumber()
    if (c === "(") return this.list()
    if (c === "-" || c === "+" || (c >= "0" && c <= "9")) return this.number()
    if (/[A-Za-z_]/.test(c!)) return this.typed()
    return this.err(`unexpected character "${c}"`)
  }

  string(): string {
    const start = this.i
    this.i++ // opening quote
    for (;;) {
      if (this.i >= this.s.length) this.err("unterminated string")
      if (this.s[this.i] === "'") {
        if (this.s[this.i + 1] === "'") { this.i += 2; continue }
        break
      }
      this.i++
    }
    const raw = this.s.slice(start + 1, this.i).replace(/''/g, "'")
    this.i++
    return decodeString(raw)
  }

  ref(): Ref {
    const m = /^#(\d+)/.exec(this.s.slice(this.i, this.i + 24))
    if (!m) this.err("malformed reference")
    this.i += m![0].length
    return { ref: Number(m![1]) }
  }

  number(): number {
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i, this.i + 40))
    if (!m) this.err("malformed number")
    this.i += m![0].length
    return Number(m![0])
  }

  /** .T.  .F.  .MILLI.  but also a number that starts with a dot like .5 */
  enumOrNumber(): Enum | number {
    const m = /^\.([A-Za-z_][A-Za-z_0-9]*)\./.exec(this.s.slice(this.i, this.i + 80))
    if (m) { this.i += m[0].length; return { enum: m[1]!.toUpperCase() } }
    return this.number()
  }

  list(): Value[] {
    this.i++ // (
    const out: Value[] = []
    if (this.peek() === ")") { this.i++; return out }
    for (;;) {
      out.push(this.value())
      const c = this.peek()
      if (c === ",") { this.i++; continue }
      if (c === ")") { this.i++; return out }
      this.err(`expected "," or ")" in a list, found ${c === undefined ? "end of entity" : `"${c}"`}`)
    }
  }

  typed(): Typed {
    const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(this.s.slice(this.i, this.i + 120))
    this.i += m![0].length
    this.ws()
    if (this.s[this.i] !== "(") this.err(`expected "(" after ${m![0]}`)
    return { type: m![0].toUpperCase(), args: this.list() }
  }

  /** the body of an entity: either TYPE(args) or a complex (TYPE1(args)TYPE2(args)...) */
  body(): { type: string; args: Value[]; parts?: { type: string; args: Value[] }[] } {
    this.ws()
    if (this.s[this.i] === "(") {
      // complex entity: members are written back to back
      this.i++
      const parts: { type: string; args: Value[] }[] = []
      for (;;) {
        this.ws()
        if (this.s[this.i] === ")") { this.i++; break }
        const t = this.typed()
        parts.push({ type: t.type, args: t.args })
      }
      if (parts.length === 0) this.err("empty complex entity")
      return { type: parts[0]!.type, args: parts[0]!.args, parts }
    }
    const t = this.typed()
    return { type: t.type, args: t.args }
  }
}

/** split a section into statements at top-level semicolons, ignoring ; inside strings */
function* statements(src: string, from: number, to: number): Generator<{ text: string; offset: number }> {
  let start = from
  let i = from
  while (i < to) {
    const c = src[i]!
    if (c === "'") {
      i++
      for (;;) {
        if (i >= to) throw new StepParseError("unterminated string", start)
        if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue } break }
        i++
      }
      i++
    } else if (c === ";") {
      const st = trimmed(src, start, i)
      if (st) yield st
      i++
      start = i
    } else i++
  }
  const tail = trimmed(src, start, to)
  if (tail) yield tail
}

/** the text between two offsets with surrounding whitespace removed, and the offset where it REALLY starts */
function trimmed(src: string, from: number, to: number): { text: string; offset: number } | null {
  let a = from
  let b = to
  while (a < b && /\s/.test(src[a]!)) a++
  while (b > a && /\s/.test(src[b - 1]!)) b--
  return a < b ? { text: src.slice(a, b), offset: a } : null
}

export function parsePart21(input: string | Uint8Array): Part21 {
  let text = typeof input === "string" ? input : new TextDecoder("latin1").decode(input)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const src = stripComments(text)

  if (!/^\s*ISO-10303-21\s*;/.test(src)) throw new StepParseError("not a STEP file: missing the ISO-10303-21; header", 0)
  const end = /END-ISO-10303-21\s*;/.exec(src)
  if (!end) throw new StepParseError("truncated STEP file: missing END-ISO-10303-21;", src.length)

  const hdr = /\bHEADER\s*;/.exec(src)
  const hdrEnd = /\bENDSEC\s*;/.exec(src.slice(hdr ? hdr.index : 0))
  const dat = /\bDATA\s*;/.exec(src)
  if (!hdr || !hdrEnd || !dat) throw new StepParseError("missing HEADER or DATA section", 0)

  const header: Record<string, Value[]> = {}
  const hFrom = hdr.index + hdr[0].length
  const hTo = hdr.index + hdrEnd.index
  for (const st of statements(src, hFrom, hTo)) {
    const r = new Reader(st.text, st.offset)
    try {
      const t = r.typed()
      header[t.type] = t.args
    } catch (e) {
      if (!(e instanceof StepParseError)) throw e
      // a malformed header record must not stop the geometry from loading
    }
  }

  const dFrom = dat.index + dat[0].length
  const dEndRel = /\bENDSEC\s*;/.exec(src.slice(dFrom))
  if (!dEndRel) throw new StepParseError("DATA section is not closed with ENDSEC;", dFrom)
  const dTo = dFrom + dEndRel.index

  const entities = new Map<number, Entity>()
  for (const st of statements(src, dFrom, dTo)) {
    const m = /^#(\d+)\s*=/.exec(st.text)
    if (!m) throw new StepParseError(`expected an entity like "#12 = TYPE(...)", found "${st.text.slice(0, 40)}"`, st.offset)
    const id = Number(m[1])
    if (entities.has(id)) throw new StepParseError(`entity #${id} is defined twice`, st.offset)
    const r = new Reader(st.text.slice(m[0].length), st.offset + m[0].length)
    const b = r.body()
    if (!r.eof()) r.err("unexpected text after the end of the entity")
    entities.set(id, { id, type: b.type, args: b.args, ...(b.parts ? { parts: b.parts } : {}) })
  }

  const schemaArg = header["FILE_SCHEMA"]?.[0]
  const schema = Array.isArray(schemaArg) && typeof schemaArg[0] === "string" ? schemaArg[0].split(/[ {]/)[0]!.toUpperCase() : null
  return { header, entities, schema }
}

// ---------- typed accessors the geometry layers use

export function ent(p: Part21, v: Value | undefined, what = "entity"): Entity {
  if (!v || !isRef(v)) throw new StepParseError(`expected a reference to a ${what}`, 0)
  const e = p.entities.get(v.ref)
  if (!e) throw new StepParseError(`#${v.ref} is referenced but never defined (${what})`, 0)
  return e
}
export function num(v: Value | undefined, what = "number"): number {
  if (typeof v === "number") return v
  if (isTyped(v as Value) && typeof (v as Typed).args[0] === "number") return (v as Typed).args[0] as number
  throw new StepParseError(`expected a ${what}, got ${JSON.stringify(v)}`, 0)
}
export function nums(v: Value | undefined, what = "number list"): number[] {
  if (!Array.isArray(v)) throw new StepParseError(`expected a ${what}`, 0)
  return v.map((x) => num(x, what))
}
export function refs(v: Value | undefined, what = "reference list"): number[] {
  if (!Array.isArray(v)) throw new StepParseError(`expected a ${what}`, 0)
  return v.map((x) => {
    if (!isRef(x)) throw new StepParseError(`expected a reference in ${what}`, 0)
    return x.ref
  })
}
export const bool = (v: Value | undefined): boolean => isEnum(v as Value) && (v as Enum).enum === "T"
