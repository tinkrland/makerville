/**
 * Builds a STEP file for a rectangular box, by hand, so tests have a case whose orientation is known
 * exactly. Every face loop is wound counter-clockwise seen from OUTSIDE, each face's PLANE axis is its
 * outward normal, and the 12 edges are shared between the two faces that meet there with opposite
 * traversal directions. That is what a correct B-rep looks like, so any orientation bug shows up as a
 * mismatch against this file.
 *
 * `breakFace` (1-based index) emits one face with its loop wound the other way, via the bound's
 * orientation flag, which is exactly the mistake a real exporter can make.
 */
export interface BoxOptions {
  a?: number; b?: number; c?: number
  /** reverse this face's loop by flipping FACE_OUTER_BOUND.orientation on it */
  breakFace?: number
  /** reverse this face's loop by writing its ORIENTED_EDGE flags backwards (an inside-out loop) */
  insideOutFace?: number
  /** use FACE_BOUND instead of FACE_OUTER_BOUND everywhere, to exercise outer-loop deduction */
  noOuterFlag?: boolean
  /** report this face's same_sense as false, and give it the opposite plane axis */
  flipSameSenseFace?: number
  /** replace the given face's plane with an unsupported surface type */
  badSurfaceFace?: number
  /** wrap the shell in BREP_WITH_VOIDS with an extra void shell of one plane */
  withVoid?: boolean
}

export function boxStep(o: BoxOptions = {}): string {
  const a = o.a ?? 10, b = o.b ?? 6, c = o.c ?? 4
  const L: string[] = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('box.step','2026-11-08T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
  ]
  let n = 0
  const id = () => ++n
  const out = (i: number, s: string) => L.push(`#${i}=${s};`)
  const pt = (x: number, y: number, z: number) => { const i = id(); out(i, `CARTESIAN_POINT('',(${x}.,${y}.,${z}.))`); return i }
  const vtx = (x: number, y: number, z: number) => { const i = id(); out(i, `VERTEX_POINT('',#${pt(x, y, z)})`); return i }
  const dir = (x: number, y: number, z: number) => { const i = id(); out(i, `DIRECTION('',(${x}.,${y}.,${z}.))`); return i }
  const frame = (p: [number, number, number], z: [number, number, number], x: [number, number, number]) => {
    const i = id(); out(i, `AXIS2_PLACEMENT_3D('',#${pt(...p)},#${dir(...z)},#${dir(...x)})`); return i
  }

  const A = vtx(0, 0, 0), B = vtx(a, 0, 0), C = vtx(a, b, 0), D = vtx(0, b, 0)
  const E = vtx(0, 0, c), F = vtx(a, 0, c), G = vtx(a, b, c), H = vtx(0, b, c)
  const P: Record<string, [number, number, number]> = { A: [0, 0, 0], B: [a, 0, 0], C: [a, b, 0], D: [0, b, 0], E: [0, 0, c], F: [a, 0, c], G: [a, b, c], H: [0, b, c] }
  const V: Record<string, number> = { A, B, C, D, E, F, G, H }

  // 12 shared edges, each defined once from its first corner to its second
  const edgePairs: [string, string][] = [
    ["A", "B"], ["B", "C"], ["C", "D"], ["D", "A"],
    ["E", "F"], ["F", "G"], ["G", "H"], ["H", "E"],
    ["A", "E"], ["B", "F"], ["C", "G"], ["D", "H"],
  ]
  const edgeId = new Map<string, number>()
  for (const [s, e] of edgePairs) {
    const p1 = P[s]!, p2 = P[e]!
    const d: [number, number, number] = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
    const mag = Math.hypot(...d)
    const u: [number, number, number] = [d[0] / mag, d[1] / mag, d[2] / mag]
    const vec = id(); out(vec, `VECTOR('',#${dir(...u)},${mag}.)`)
    const line = id(); out(line, `LINE('',#${pt(...p1)},#${vec})`)
    const ec = id(); out(ec, `EDGE_CURVE('',#${V[s]!},#${V[e]!},#${line},.T.)`)
    edgeId.set(`${s}${e}`, ec)
  }

  // faces: loop (CCW seen from outside), outward normal, and a reference direction for the plane frame
  const faces: { loop: string[]; normal: [number, number, number]; ref: [number, number, number] }[] = [
    { loop: ["A", "E", "H", "D"], normal: [-1, 0, 0], ref: [0, 0, 1] },      // x = 0
    { loop: ["B", "C", "G", "F"], normal: [1, 0, 0], ref: [0, 1, 0] },       // x = a
    { loop: ["A", "B", "F", "E"], normal: [0, -1, 0], ref: [1, 0, 0] },      // y = 0
    { loop: ["D", "H", "G", "C"], normal: [0, 1, 0], ref: [1, 0, 0] },       // y = b
    { loop: ["A", "D", "C", "B"], normal: [0, 0, -1], ref: [1, 0, 0] },      // z = 0
    { loop: ["E", "F", "G", "H"], normal: [0, 0, 1], ref: [1, 0, 0] },       // z = c
  ]
  const faceIds: number[] = []
  faces.forEach((f, idx) => {
    const oneBased = idx + 1
    // each loop step names the shared edge (in either stored direction) plus the orientation to use
    const uses: { ec: number; orient: boolean }[] = []
    for (let i = 0; i < f.loop.length; i++) {
      const s = f.loop[i]!, e = f.loop[(i + 1) % f.loop.length]!
      const fwdKey = `${s}${e}`, backKey = `${e}${s}`
      const ec = edgeId.get(fwdKey) ?? edgeId.get(backKey)
      if (ec === undefined) throw new Error(`no edge ${s}-${e}`)
      const stored = edgeId.has(fwdKey)
      uses.push({ ec, orient: stored })
    }
    if (o.insideOutFace === oneBased) for (const u of uses) u.orient = !u.orient
    // A reversed bound is EQUIVALENT to the original only if the loop itself is also written backwards
    // (order reversed and every edge flipped). Emitting just the .F. flag describes a different, broken
    // face, which is not what this option is for; that case is `insideOutFace`.
    if (o.breakFace === oneBased) {
      uses.reverse()
      for (const u of uses) u.orient = !u.orient
    }
    const oriented = uses.map(({ ec, orient }) => { const oe = id(); out(oe, `ORIENTED_EDGE('',*,*,#${ec},.${orient ? "T" : "F"}.)`); return oe })
    const loop = id(); out(loop, `EDGE_LOOP('',(${oriented.map((x) => `#${x}`).join(",")}))`)
    const boundOrient = o.breakFace === oneBased ? ".F." : ".T."
    const bound = id()
    out(bound, o.noOuterFlag ? `FACE_BOUND('',#${loop},${boundOrient})` : `FACE_OUTER_BOUND('',#${loop},${boundOrient})`)
    let surfId: number
    if (o.badSurfaceFace === oneBased) {
      surfId = id(); out(surfId, `SURFACE_OF_REVOLUTION('',#${frame(P[f.loop[0]!]!, f.normal, f.ref)},#${dir(1.,0.,0.)})`)
    } else {
      const ax = o.flipSameSenseFace === oneBased ? (f.normal.map((v) => -v) as [number, number, number]) : f.normal
      surfId = id(); out(surfId, `PLANE('',#${frame(P[f.loop[0]!]!, ax, f.ref)})`)
    }
    const sameSense = o.flipSameSenseFace === oneBased ? ".F." : ".T."
    const fid = id(); out(fid, `ADVANCED_FACE('',(#${bound}),#${surfId},${sameSense})`)
    faceIds.push(fid)
  })

  const shell = id(); out(shell, `CLOSED_SHELL('',(${faceIds.map((x) => `#${x}`).join(",")}))`)
  if (o.withVoid) {
    // a second, independent closed shell standing in for a cavity wall: a unit square prism, correctly
    // wound, so the void contributes faces without breaking edge-use counts
    const cor = [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]
    const zs = [100, 101]
    const quad = (k: number, z: number, flip: boolean): number => {
      const vs = cor.map(([x, y]) => vtx(100 + x, 100 + y, z))
      const oes: number[] = []
      const order = flip ? [3, 2, 1, 0] : [0, 1, 2, 3]
      for (let i = 0; i < 4; i++) {
        const i0 = order[i]!, i1 = order[(i + 1) % 4]!
        const p0 = [100 + cor[i0]![0], 100 + cor[i0]![1], z]
        const p1 = [100 + cor[i1]![0], 100 + cor[i1]![1], z]
        const dx = p1[0]! - p0[0]!, dy = p1[1]! - p0[1]!, m = Math.hypot(dx, dy)
        const vec = id(); out(vec, `VECTOR('',#${dir(dx / m, dy / m, 0.)},${m}.)`)
        const ln = id(); out(ln, `LINE('',#${pt(p0[0]!, p0[1]!, p0[2]!)},#${vec})`)
        const ec = id(); out(ec, `EDGE_CURVE('',#${vs[i0]!},#${vs[i1]!},#${ln},.T.)`)
        const oe = id(); out(oe, `ORIENTED_EDGE('',*,*,#${ec},.T.)`); oes.push(oe)
      }
      const lp = id(); out(lp, `EDGE_LOOP('',(${oes.map((x) => `#${x}`).join(",")}))`)
      const bd = id(); out(bd, `FACE_OUTER_BOUND('',#${lp},.T.)`)
      const axis: [number, number, number] = [0, 0, flip ? -1 : 1]
      const pl = id(); out(pl, `PLANE('',#${frame([100 + cor[0]![0], 100 + cor[0]![1], z], axis, [1, 0, 0])})`)
      const fc = id(); out(fc, `ADVANCED_FACE('',(#${bd}),#${pl},.T.)`)
      void k
      return fc
    }
    // Two independent quads stand in for cavity walls. They share no edges, so this shell is NOT
    // watertight; it is here to exercise shell/void parsing, not manifoldness.
    const bottom = quad(0, zs[0]!, true), top = quad(1, zs[1]!, false)
    void bottom; void top
    const voidShell = id(); out(voidShell, `CLOSED_SHELL('',(#${bottom},#${top}))`)
    const body = id(); out(body, `BREP_WITH_VOIDS('box',#${shell},(#${voidShell}))`)
    return L.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n"
  }
  const msb = id(); out(msb, `MANIFOLD_SOLID_BREP('box',#${shell})`)
  return L.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n"
}
