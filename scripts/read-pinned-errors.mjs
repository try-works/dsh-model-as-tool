/**
 * Report the pinned schema's own words for the three transport error definitions.
 *
 * Run: node scripts/read-pinned-errors.mjs
 */
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

for (const [name, definition] of Object.entries(defs)) {
  if (!/MissingRequiredClientCapability|UnsupportedProtocolVersion|HeaderMismatch/i.test(name)) continue
  console.log(`=== ${name} ===`)
  console.log((definition.description ?? '').replace(/\s+/g, ' ').slice(0, 460))
  const data = definition.properties?.data
  if (data) {
    console.log('  data.required:', JSON.stringify(data.required ?? null))
    console.log('  data.properties:', JSON.stringify(Object.keys(data.properties ?? {})))
  }
  console.log('  error.code:', JSON.stringify(definition.properties?.error?.properties?.code ?? null))
  console.log('')
}
