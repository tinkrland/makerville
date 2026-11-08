/**
 * Hand-built STEP files for solids of revolution, so tessellation can be checked against closed-form
 * area and volume instead of "it produced some triangles".
 *
 * Written to the same rules as brep-box.ts: each face loop winds counter-clockwise seen from OUTSIDE, and
 * every shared edge is used exactly twice in opposite directions. A full circular rim is ONE periodic edge
 * whose two ends are the same vertex, which is how real exporters write it.
 */

/** one edge use inside a loop */
export type Use = { ec: number; fwd: boolean }
/** loop(...uses) keeps the nesting flat at the call site */
const loop = (...u: Use[]): Use[] => u

/** a STEP real: always a decimal point and at least one digit after it */
const num = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`)

class StepFile {
  L: string[] = [
    "ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('s.step','2026-11-08T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", "ENDSEC;", "DATA;",
  ]
  n = 0
  id(): number { return ++this.n }
  out(i: number, s: string): void { this.L.push(`#${i}=${s};`) }
  pt(x: number, y: number, z: number): number { const i = this.id(); this.out(i, `CARTESIAN_POINT('',(${num(x)},${num(y)},${num(z)}))`); return i }
  dir(x: number, y: number, z: number): number { const i = this.id(); this.out(i, `DIRECTION('',(${num(x)},${num(y)},${num(z)}))`); return i }
  vtx(x: number, y: number, z: number): number { const i = this.id(); this.out(i, `VERTEX_POINT('',#${this.pt(x, y, z)})`); return i }
  frame(p: [number, number, number], z: [number, number, number], x: [number, number, number]): number {
    const i = this.id(); this.out(i, `AXIS2_PLACEMENT_3D('',#${this.pt(...p)},#${this.dir(...z)},#${this.dir(...x)})`); return i
  }
  line(a: [number, number, number], b: [number, number, number]): number {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const m = Math.hypot(d[0]!, d[1]!, d[2]!)
    const v = this.id(); this.out(v, `VECTOR('',#${this.dir(d[0]! / m, d[1]! / m, d[2]! / m)},${m})`)
    const i = this.id(); this.out(i, `LINE('',#${this.pt(...a)},#${v})`); return i
  }
  circle(z: number, r: number, axis: [number, number, number]): number {
    const i = this.id(); this.out(i, `CIRCLE('',#${this.frame([0, 0, z], axis, [1, 0, 0])},${num(r)})`); return i
  }
  edge(v1: number, v2: number, curve: number, same: boolean): number {
    const i = this.id(); this.out(i, `EDGE_CURVE('',#${v1},#${v2},#${curve},.${same ? "T" : "F"}.)`); return i
  }
  surface(kind: string, args: string): number { const i = this.id(); this.out(i, `${kind}('',${args})`); return i }
  face(loops: Use[][], surface: number, sameSense: boolean): number {
    const bounds = loops.map((lp, k) => {
      const oes = lp.map((u) => { const oe = this.id(); this.out(oe, `ORIENTED_EDGE('',*,*,#${u.ec},.${u.fwd ? "T" : "F"}.)`); return oe })
      const el = this.id(); this.out(el, `EDGE_LOOP('',(${oes.map((x) => `#${x}`).join(",")}))`)
      const bd = this.id()
      this.out(bd, `${k === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',#${el},.T.)`)
      return bd
    })
    const i = this.id()
    this.out(i, `ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(",")}),#${surface},.${sameSense ? "T" : "F"}.)`)
    return i
  }
  solid(name: string, faces: number[]): string {
    const sh = this.id(); this.out(sh, `CLOSED_SHELL('',(${faces.map((x) => `#${x}`).join(",")}))`)
    const s = this.id(); this.out(s, `MANIFOLD_SOLID_BREP('${name}',#${sh})`)
    return this.L.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n"
  }
}

const ZP: [number, number, number] = [0, 0, 1]
const ZN: [number, number, number] = [0, 0, -1]
const XP: [number, number, number] = [1, 0, 0]

/** closed cylinder: radius r, height h, base at z = 0 */
export function cylinderStep(r: number, h: number): string {
  const f = new StepFile()
  const V0 = f.vtx(r, 0, 0), V1 = f.vtx(r, 0, h)
  const eBot = f.edge(V0, V0, f.circle(0, r, ZP), true)
  const eTop = f.edge(V1, V1, f.circle(h, r, ZP), true)
  const eSeam = f.edge(V0, V1, f.line([r, 0, 0], [r, 0, h]), true)
  const side = f.surface("CYLINDRICAL_SURFACE", `#${f.frame([0, 0, 0], ZP, XP)},${r}.`)
  const capB = f.surface("PLANE", `#${f.frame([0, 0, 0], ZN, XP)}`)
  const capT = f.surface("PLANE", `#${f.frame([0, 0, h], ZP, XP)}`)
  return f.solid("cylinder", [
    f.face([loop({ ec: eBot, fwd: true }, { ec: eSeam, fwd: true }, { ec: eTop, fwd: false }, { ec: eSeam, fwd: false })], side, true),
    f.face([loop({ ec: eBot, fwd: false })], capB, true),
    f.face([loop({ ec: eTop, fwd: true })], capT, true),
  ])
}

/** closed cone frustum: radius r0 at z = 0, r1 at z = h */
export function frustumStep(r0: number, r1: number, h: number): string {
  const f = new StepFile()
  const V0 = f.vtx(r0, 0, 0), V1 = f.vtx(r1, 0, h)
  const eBot = f.edge(V0, V0, f.circle(0, r0, ZP), true)
  const eTop = f.edge(V1, V1, f.circle(h, r1, ZP), true)
  const eSeam = f.edge(V0, V1, f.line([r0, 0, 0], [r1, 0, h]), true)
  const semi = Math.atan2(r1 - r0, h)
  const cone = f.surface("CONICAL_SURFACE", `#${f.frame([0, 0, 0], ZP, XP)},${num(r0)},${semi}`)
  const capB = f.surface("PLANE", `#${f.frame([0, 0, 0], ZN, XP)}`)
  const capT = f.surface("PLANE", `#${f.frame([0, 0, h], ZP, XP)}`)
  return f.solid("frustum", [
    f.face([loop({ ec: eBot, fwd: true }, { ec: eSeam, fwd: true }, { ec: eTop, fwd: false }, { ec: eSeam, fwd: false })], cone, true),
    f.face([loop({ ec: eBot, fwd: false })], capB, true),
    f.face([loop({ ec: eTop, fwd: true })], capT, true),
  ])
}

/** a tube: outer radius R, inner radius r, height h. Its annular caps exercise hole bridging. */
export function tubeStep(R: number, r: number, h: number): string {
  const f = new StepFile()
  const A0 = f.vtx(R, 0, 0), A1 = f.vtx(R, 0, h), B0 = f.vtx(r, 0, 0), B1 = f.vtx(r, 0, h)
  const eOB = f.edge(A0, A0, f.circle(0, R, ZP), true)
  const eOT = f.edge(A1, A1, f.circle(h, R, ZP), true)
  const eIB = f.edge(B0, B0, f.circle(0, r, ZP), true)
  const eIT = f.edge(B1, B1, f.circle(h, r, ZP), true)
  const eSO = f.edge(A0, A1, f.line([R, 0, 0], [R, 0, h]), true)
  const eSI = f.edge(B0, B1, f.line([r, 0, 0], [r, 0, h]), true)
  const outer = f.surface("CYLINDRICAL_SURFACE", `#${f.frame([0, 0, 0], ZP, XP)},${R}.`)
  const inner = f.surface("CYLINDRICAL_SURFACE", `#${f.frame([0, 0, 0], ZP, XP)},${r}.`)
  const capB = f.surface("PLANE", `#${f.frame([0, 0, 0], ZN, XP)}`)
  const capT = f.surface("PLANE", `#${f.frame([0, 0, h], ZP, XP)}`)
  return f.solid("tube", [
    // outer wall: normal away from the axis
    f.face([loop({ ec: eOB, fwd: true }, { ec: eSO, fwd: true }, { ec: eOT, fwd: false }, { ec: eSO, fwd: false })], outer, true),
    // inner wall: same_sense false, so its normal ends up pointing INTO the hole (toward the axis).
    // The uses must CHAIN: B0 ->(seam up) B1 ->(inner top rim) B1 ->(seam down) B0 ->(inner bottom rim) B0
    f.face([loop({ ec: eSI, fwd: true }, { ec: eIT, fwd: true }, { ec: eSI, fwd: false }, { ec: eIB, fwd: false })], inner, false),
    // bottom annulus: outer rim reversed, inner rim forward (they wind opposite ways in its plane)
    f.face([loop({ ec: eOB, fwd: false }), loop({ ec: eIB, fwd: true })], capB, true),
    f.face([loop({ ec: eOT, fwd: true }), loop({ ec: eIT, fwd: false })], capT, true),
  ])
}
