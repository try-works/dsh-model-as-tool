/**
 * Find the MCP-01 claim that contradicts MCP-02 and MCP-03.
 *
 * Run: node scripts/find-mcp-contradiction.mjs
 */
import { readFileSync } from 'node:fs'

const status = JSON.parse(readFileSync('docs/tool-mode/status.json', 'utf8'))
const requirements = status.requirements ?? status

const evidence = String(requirements['MCP-01']?.evidence ?? '')
for (const needle of ['do not exist', 'does not exist', 'neither the HTTP', 'no HTTP transport']) {
  const index = evidence.indexOf(needle)
  if (index < 0) continue
  console.log(`FOUND ${JSON.stringify(needle)} at ${index}:`)
  console.log('  ...' + evidence.slice(Math.max(0, index - 300), index + 160).replace(/\s+/g, ' ') + '...')
}
console.log('')
console.log('MCP-01 evidence length:', evidence.length)
console.log('MCP-01 status:', requirements['MCP-01']?.status)
