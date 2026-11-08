/**
 * A small S-expression reader and writer, enough for KiCad 7/8/9 files.
 *
 * Reading:  parse(text) -> Node (a list), where a Node is an atom or a list.
 * Writing:  write(node) -> text, laid out the way KiCad lays it out so a diff
 *           against a file KiCad saved is readable.
 *
 * Atoms keep one bit of information the parser must not lose: whether the text
 * was quoted. `(property "Reference" "R1")` and `(layer F.Cu)` differ, and KiCad
 * cares ("F.Cu" quoted in some places, bare in others).
 */

export type Atom = { atom: string; quoted: boolean }
export type List = Node[]
export type Node = Atom | List

export const isAtom = (n: Node): n is Atom => !Array.isArray(n)
export const isList = (n: Node): n is List => Array.isArray(n)

export const sym = (s: string): Atom => ({ atom: s, quoted: false })
export const str = (s: string): Atom => ({ atom: s, quoted: true })

/** KiCad prints numbers without trailing zeros and never in exponent form */
export function num(n: number): Atom {
  if (!Number.isFinite(n)) throw new Error(`cannot write non-finite number ${n}`)
  let t = (Math.round(n * 1e6) / 1e6).toFixed(6)
  t = t.replace(/\.?0+$/, "")
  if (t === "-0" || t === "") t = "0"
  return { atom: t, quoted: false }
}

export class SexpError extends Error {
  at: number
  constructor(msg: string, at: number) {
    super(`${msg} (at offset ${at})`)
    this.at = at
  }
}

export function parse(text: string): List {
  let i = 0
  const n = text.length

  function skip() {
    while (i < n) {
      const c = text[i]!
      if (c === " " || c === "\n" || c === "\t" || c === "\r") i++
      else break
    }
  }

  function readQuoted(): Atom {
    const start = i
    i++ // opening quote
    let out = ""
    while (i < n) {
      const c = text[i]!
      if (c === "\\") {
        const d = text[i + 1]
        if (d === undefined) throw new SexpError("dangling backslash", i)
        if (d === "n") out += "\n"
        else if (d === "t") out += "\t"
        else out += d
        i += 2
        continue
      }
      if (c === '"') {
        i++
        return { atom: out, quoted: true }
      }
      out += c
      i++
    }
    throw new SexpError("unterminated string", start)
  }

  function readBare(): Atom {
    const start = i
    while (i < n) {
      const c = text[i]!
      if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === "(" || c === ")") break
      i++
    }
    if (i === start) throw new SexpError("empty atom", i)
    return { atom: text.slice(start, i), quoted: false }
  }

  function readList(): List {
    const start = i
    i++ // (
    const out: List = []
    for (;;) {
      skip()
      if (i >= n) throw new SexpError("unterminated list", start)
      const c = text[i]!
      if (c === ")") {
        i++
        return out
      }
      if (c === "(") out.push(readList())
      else if (c === '"') out.push(readQuoted())
      else out.push(readBare())
    }
  }

  skip()
  if (text[i] !== "(") throw new SexpError("expected '(' at start", i)
  const root = readList()
  skip()
  if (i < n) throw new SexpError("trailing content after the root list", i)
  return root
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")
}

function atomText(a: Atom): string {
  return a.quoted ? `"${esc(a.atom)}"` : a.atom
}

/** a list is "flat" if it has no sublists: those are written on one line */
const flat = (l: List) => l.every(isAtom)

export function write(root: List, indent = 2): string {
  const out: string[] = []
  const pad = (d: number) => " ".repeat(d * indent)

  function go(l: List, depth: number) {
    if (flat(l)) {
      out.push(pad(depth) + "(" + l.map((x) => atomText(x as Atom)).join(" ") + ")")
      return
    }
    // head atoms stay on the opening line, then each child on its own line
    let k = 0
    const head: string[] = []
    while (k < l.length && isAtom(l[k]!)) {
      head.push(atomText(l[k] as Atom))
      k++
    }
    out.push(pad(depth) + "(" + head.join(" "))
    for (; k < l.length; k++) {
      const c = l[k]!
      if (isAtom(c)) out.push(pad(depth + 1) + atomText(c))
      else go(c, depth + 1)
    }
    out.push(pad(depth) + ")")
  }
  go(root, 0)
  return out.join("\n") + "\n"
}

// ---- query helpers used by the importer ---------------------------------

/** the head symbol of a list, or "" */
export function head(l: List): string {
  const h = l[0]
  return h && isAtom(h) ? h.atom : ""
}

/** all direct child lists with the given head */
export function all(l: List, name: string): List[] {
  const r: List[] = []
  for (const c of l) if (isList(c) && head(c) === name) r.push(c)
  return r
}

/** the first direct child list with the given head */
export function first(l: List, name: string): List | undefined {
  for (const c of l) if (isList(c) && head(c) === name) return c
  return undefined
}

/** the atom text at a position inside a list, or undefined */
export function at(l: List | undefined, idx: number): string | undefined {
  const v = l?.[idx]
  return v && isAtom(v) ? v.atom : undefined
}

export function numAt(l: List | undefined, idx: number): number | undefined {
  const t = at(l, idx)
  if (t === undefined) return undefined
  const v = Number(t)
  return Number.isFinite(v) ? v : undefined
}

/** `(name x)` -> x as number */
export function field(l: List, name: string, idx = 1): number | undefined {
  return numAt(first(l, name), idx)
}

/** `(name "text")` or `(name text)` -> text */
export function textField(l: List, name: string): string | undefined {
  return at(first(l, name), 1)
}
