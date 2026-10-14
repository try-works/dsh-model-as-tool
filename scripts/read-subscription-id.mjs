/**
 * Report every occurrence of `subscriptionId` in the pinned schema, with full descriptions.
 *
 * The question: is the subscription id the listen REQUEST's id, or an independent id?
 * Run: node scripts/read-subscription-id.mjs
 */
import { readFileSync } from 'node:fs'

const text = readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8')
const schema = JSON.parse(text)
const defs = schema.$defs ?? schema.definitions ?? {}

console.log('=== defs whose DESCRIPTION mentions subscriptionId ===')
for (const [name, definition] of Object.entries(defs)) {
  const description = definition.description ?? ''
  if (!description.includes('subscriptionId') && !description.includes('subscription')) continue
  if (!/Notification|Result|MetaObject/i.test(name)) continue
  console.log(`--- ${name} ---`)
  console.log(' ', description.replace(/\s+/g, ' ').slice(0, 400))
  const required = definition.required ?? []
  console.log('  required:', JSON.stringify(required))
  const sub = definition.properties?.['io.modelcontextprotocol/subscriptionId']
  if (sub) {
    console.log('  subscriptionId type:', JSON.stringify(sub.type ?? sub.$ref ?? null))
    console.log('  subscriptionId description:', String(sub.description ?? '').replace(/\s+/g, ' ').slice(0, 420))
  }
  console.log('')
}

console.log('=== the RequestId definition ===')
console.log(JSON.stringify(defs.RequestId ?? null).slice(0, 400))
