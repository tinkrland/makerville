// Where the real-world STEP models live. They are NOT in this repository: the KiCad library models are
// CC-BY-SA 4.0 with an exception that does not cover redistribution as a collection, and the connector
// models belong to their authors. Tests that need them look in $BOARDFORGE_REFS (default: ../refs/ next to
// the repo) and are SKIPPED when they are absent, so a fresh clone is green but tests less. See the README.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const REF = (process.env.BOARDFORGE_REFS ?? path.resolve(here, "..", "..", "refs")).replace(/\/?$/, "/")
export const haveRefs = fs.existsSync(REF)
