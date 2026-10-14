/**
 * Report the pinned schema's own words for the subscription definitions.
 *
 * Run: node scripts/read-pinned-subscriptions.mjs
 */
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

for (const [name, definition] of Object.entries(defs)) {
  if (!/Subscription/i.test(name)) continue
  console.log(`=== ${name} ===`)
  if (definition.description) console.log(' ', definition.description.replace(/\s+/g, ' ').slice(0, 300))
  if (definition.required) console.log('  required:', JSON.stringify(definition.required))
  if (definition.properties) {
    for (const [key, value] of Object.entries(definition.properties)) {
      const note = value?.description ? ` -- ${String(value.description).replace(/\s+/g, ' ').slice(0, 170)}` : ''
      console.log(`    ${key}: ${value?.type ?? JSON.stringify(value?.$ref ?? value?.const ?? '')}${note}`)
    }
  }
  console.log('')
}
