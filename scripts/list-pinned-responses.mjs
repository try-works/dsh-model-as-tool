/**
 * List the pinned schema's response/error definitions available for live validation.
 *
 * Run: node scripts/list-pinned-responses.mjs
 */
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

const names = Object.keys(defs)
console.log('total definitions:', names.length)
console.log('')
for (const pattern of [/Response$/, /Error$/, /^JSONRPC/, /Notification$/]) {
  const matched = names.filter(name => pattern.test(name)).sort()
  console.log(`${pattern}: ${matched.length}`)
  for (const name of matched) console.log('   ', name)
  console.log('')
}
