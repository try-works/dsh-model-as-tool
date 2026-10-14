/**
 * Report the pinned schema's FULL structure for the -32021 error definition.
 *
 * Run: node scripts/read-capability-error-shape.mjs
 */
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

const def = defs.MissingRequiredClientCapabilityError
console.log('top-level keys:', Object.keys(def ?? {}))
console.log('')
console.log(JSON.stringify(def, null, 2)?.slice(0, 1400))
