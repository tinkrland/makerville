# Attribution

Boardforge ports and adapts code from the open-source projects below. Each is
credited here with its licence. Files that contain ported code carry a header
naming the source.

| Boardforge file | Ported from | Author | Licence |
| --- | --- | --- | --- |
| `src/router/min-heap.ts` | `tscircuit/single-layer-grid-router` `lib/min-heap.ts` | tscircuit contributors | MIT |
| `src/router/geometry.ts` | `tscircuit/single-layer-grid-router` `lib/geometry.ts` | tscircuit contributors | MIT |
| `src/router/grid-astar.ts` | `tscircuit/single-layer-grid-router` `lib/SingleLayerGridRouter.ts`, `lib/group-connections.ts` | tscircuit contributors | MIT |

Reference reading (design, file formats and pitfalls; no code copied unless listed above):

- `tscircuit/circuit-json-to-kicad` (MIT), `tscircuit/kicad-to-circuit-json` (MIT)
- `tscircuit/capacity-autorouter` (MIT), `tscircuit/solver-utils` (MIT)
- `mixelpixx/KiCAD-MCP-Server` (MIT)
- `Kevoyuan/AgentSCAD` (MIT)

Copyright (c) 2026 tscircuit, used under the MIT licence. The MIT licence text
must accompany copies of the ported files; see `licenses/MIT-tscircuit.txt`.

## Original work

`src/drc/*` (shape distance library and design rule check) is original to
boardforge. Rule names follow KiCad's so results can be compared; the checker
was validated against KiCad 9.0.8's own DRC but contains none of its code.
