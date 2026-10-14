/**
 * Report the SHAPE of each pinned error definition: envelope or bare error object?
 *
 * Run: node scripts/read-error-definition-shapes.mjs
 */
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

for (const name of ['MethodNotFoundError', 'InvalidParamsError', 'ParseError', 'InvalidRequestError',
  'HeaderMismatchError', 'MissingRequiredClientCapabilityError', 'UnsupportedProtocolVersionError']) {
  const def = defs[name]
  if (def === undefined) { console.log(`${name}: ABSENT`); continue }
  const props = Object.keys(def.properties ?? {})
  const required = def.required ?? []
  const kind = props.includes('jsonrpc') ? 'ENVELOPE' : props.includes('code') ? 'ERROR OBJECT' : 'OTHER'
  console.log(`${name.padEnd(36)} ${kind.padEnd(13)} properties=[${props.join(', ')}] required=[${required.join(', ')}]`)
}
