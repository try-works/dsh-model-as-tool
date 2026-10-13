/**
 * Print the gating summary: one verdict per catalogued model, proving every
 * model resolves to a route and every unavailable one explains itself.
 *
 * Usage: npx tsx scripts/gating-report.ts
 */

import { loadCatalog } from '../packages/dsh-model-as-tool/src/catalog.ts'
import { resolveCapability } from '../packages/dsh-model-as-tool/src/capability.ts'

const entries = loadCatalog()
const byRoute: Record<string, string[]> = {}
let noReason = 0

for (const entry of entries) {
  const verdict = resolveCapability(entry)
  const route = verdict.runnable ? verdict.route : 'unavailable'
  ;(byRoute[route] ??= []).push(entry.id)
  if (!verdict.runnable && (verdict.reason ?? '').length < 20) noReason += 1
}

console.log(`catalogued models: ${entries.length}`)
for (const [route, ids] of Object.entries(byRoute).sort()) {
  console.log(`  ${route.padEnd(18)} ${ids.length}  ${ids.join(', ')}`)
}
console.log(`unavailable models lacking a reason: ${noReason}`)
if (noReason > 0) process.exit(1)
