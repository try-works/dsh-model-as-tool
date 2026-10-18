#!/usr/bin/env node
/**
 * Generate the browser half's model list (client/index.js) from the catalog.
 *
 * The Settings page renders one row per model with an enable/disable toggle, so
 * it needs the catalog AND each model's capability verdict — and the verdict is a
 * HOST fact (which packages are installed here), not something the browser can
 * compute. This script resolves the catalog exactly as the plugin does, embeds
 * the result into client/index.template.js, and writes client/index.js.
 *
 * Run from the package root; `prepack` and `npm run plugin:install` call it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const template = join(root, 'client', 'index.template.js')
const output = join(root, 'client', 'index.js')
const PLACEHOLDER = '/*__CATALOG_JSON__*/ []'

if (!existsSync(join(root, 'lib', 'catalog.js'))) {
  process.stderr.write('gen-client-catalog: lib/ is not built; run the package build first\n')
  process.exit(1)
}

const { loadCatalog } = await import(new URL('../lib/catalog.js', import.meta.url).href)
const { resolveCatalog } = await import(new URL('../lib/capability.js', import.meta.url).href)
const { commandExists } = await import(new URL('../lib/transport.js', import.meta.url).href)

const entries = loadCatalog(join(root, 'catalog', 'desert-ant-models.json'))
const resolved = resolveCatalog(entries, { cliAvailable: commandExists('desertant'), remoteEndpoint: undefined })

const catalog = resolved.map(({ entry, verdict }) => ({
  id: entry.id,
  name: entry.name,
  summary: entry.summary,
  package: entry.npmPackage,
  capability: entry.capability,
  sizeMB: entry.modelSizeMB,
  license: entry.license,
  runnable: verdict.runnable,
  reason: verdict.runnable ? undefined : verdict.reason,
}))

const source = readFileSync(template, 'utf8')
if (!source.includes(PLACEHOLDER)) {
  process.stderr.write(`gen-client-catalog: template is missing the ${PLACEHOLDER} placeholder\n`)
  process.exit(1)
}
const json = JSON.stringify(catalog, null, 2).replace(/\n/g, '\n    ')
const generated = source.replace(PLACEHOLDER, `/*__CATALOG_JSON__*/\n    ${json}`)

// --check: fail when the committed bundle is stale (the same contract the
// verification/traceability generators use), so a catalog edit cannot ship a
// Settings page listing a model that no longer exists.
if (process.argv.includes('--check')) {
  if (!existsSync(output)) {
    process.stderr.write('gen-client-catalog --check: client/index.js is missing; run the build\n')
    process.exit(1)
  }
  if (readFileSync(output, 'utf8') !== generated) {
    process.stderr.write('gen-client-catalog --check: client/index.js is stale; run npm run build:client\n')
    process.exit(1)
  }
  process.stdout.write(`client/index.js current: ${catalog.length} models, ${catalog.filter(entry => entry.runnable).length} runnable here\n`)
  process.exit(0)
}

writeFileSync(output, generated)
process.stdout.write(`client/index.js generated: ${catalog.length} models, ${catalog.filter(entry => entry.runnable).length} runnable here\n`)
