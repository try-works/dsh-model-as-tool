#!/usr/bin/env node
/**
 * Report a required verification suite whose prerequisites are intentionally absent.
 *
 * The Tool Mode checklist requires stable script names for live/platform suites even when
 * this checkout does not have the credentials, clean DSH profile, or model assets needed
 * to execute them. This command creates a bounded evidence record and exits non-zero so
 * the suite cannot be mistaken for a pass.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SUITES = {
  'harness-live': {
    script: 'test:harness:live',
    status: 'BLOCKED',
    reason: 'No operator-provided live DSH model/provider credentials or approved live-test profile are configured for this checkout.',
    requirements: ['AT-09', 'AT-24', 'AT-63', 'AT-64', 'AT-65', 'AT-66', 'AT-67', 'AT-68', 'AT-69', 'AT-70', 'AT-71', 'AT-72'],
    next: 'Configure an isolated live-test DSH profile with explicit provider credentials and rerun the harness live suite; do not use ambient production credentials.',
  },
}

const suiteId = process.argv[2]
const suite = SUITES[suiteId]

if (suite === undefined) {
  console.error(`unknown suite ${JSON.stringify(suiteId)}; expected one of: ${Object.keys(SUITES).join(', ')}`)
  process.exit(2)
}

const generatedAt = new Date().toISOString()
const result = { suiteId, generatedAt, ...suite }
mkdirSync(join('verification', 'results'), { recursive: true })
const outPath = join('verification', 'results', `${suiteId}.json`)
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)

console.error(`${suite.script}: ${suite.status}`)
console.error(suite.reason)
console.error(`Evidence written to ${outPath}`)
process.exit(1)
