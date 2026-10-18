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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(dirname(root))
const template = join(root, 'client', 'index.template.js')
const output = join(root, 'client', 'index.js')
const CATALOG_PLACEHOLDER = '/*__CATALOG_JSON__*/ []'
const EXTENSION_PLACEHOLDER = '/*__EXTENSIONS_JSON__*/ []'

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
  // An extension-backed model is provided by another package. Whether that
  // package is installed is a HOST fact the browser cannot observe, so the page
  // labels it "extension" rather than claiming it is runnable here.
  extension: entry.provider?.extension ?? null,
  capability: entry.capability,
  sizeMB: entry.modelSizeMB,
  license: entry.license,
  runnable: verdict.runnable,
  reason: verdict.runnable ? undefined : verdict.reason,
}))

const source = readFileSync(template, 'utf8')
if (!source.includes(CATALOG_PLACEHOLDER) || !source.includes(EXTENSION_PLACEHOLDER)) {
  process.stderr.write('gen-client-catalog: template is missing its catalog/extensions placeholders\n')
  process.exit(1)
}

/**
 * The Tool Mode extensions this repository ships.
 *
 * They are NOT Desert Ant catalog entries: an extension is installed and
 * activated through the extension store, and the browser cannot see that state.
 * Listing them beside the catalog models answers "where are laya/needle/minilm"
 * without claiming they run here.
 */
const packagesDir = join(repoRoot, 'packages')
const represented = new Set(resolved
  .map(({ entry }) => entry.provider?.extension)
  .filter(name => typeof name === 'string'))
const KNOWN_NAMES = {
  laya: 'Laya',
  needle3: 'Needle 3',
  'minilm-l6': 'MiniLM-L6',
  'minilm-rerank': 'MiniLM Rerank',
  'embeddinggemma-2': 'EmbeddingGemma 2',
}

/** A short product name for an extension row. */
function displayNameOf(manifest, packageName) {
  const firstModel = Array.isArray(manifest.models) ? manifest.models[0] : undefined
  const modelId = typeof firstModel === 'string' ? firstModel : firstModel?.id
  if (typeof modelId === 'string' && KNOWN_NAMES[modelId] !== undefined) return KNOWN_NAMES[modelId]
  return packageName.replace(/^@try-works\/extension-/, '').replace(/-/g, ' ')
}

/** The first sentence of the manifest description, bounded for a row. */
function summaryOf(manifest) {
  const text = String(manifest.description ?? '').trim()
  const first = text.split(/(?<=\.)\s/)[0] ?? text
  return first.length > 160 ? first.slice(0, 157) + '…' : first
}

const extensions = []
if (existsSync(packagesDir)) {
  for (const dir of readdirSync(packagesDir)) {
    if (!dir.startsWith('extension-')) continue
    const manifestPath = join(packagesDir, dir, 'tool-mode.extension.json')
    const packagePath = join(packagesDir, dir, 'package.json')
    if (!existsSync(manifestPath) || !existsSync(packagePath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const manifestPackage = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (represented.has(manifest.id)) continue
    const tools = Array.isArray(manifest.tools) ? manifest.tools.map(tool => tool.name ?? tool.id) : []
    const models = Array.isArray(manifest.models)
      ? manifest.models.map(model => typeof model === 'string' ? model : model.id).filter(Boolean)
      : []
    const contracts = Array.isArray(manifest.implementations)
      ? manifest.implementations.map(impl => impl.contractId ?? impl.contract).filter(Boolean)
      : []
    extensions.push({
      id: manifest.id,
      name: displayNameOf(manifest, manifestPackage.name),
      package: manifestPackage.name,
      version: manifest.version,
      license: manifest.license ?? manifestPackage.license ?? null,
      summary: summaryOf(manifest),
      models,
      tools,
      contracts,
    })
  }
}
extensions.sort((left, right) => left.name.localeCompare(right.name))

const json = JSON.stringify(catalog, null, 2).replace(/\n/g, '\n    ')
const extensionJson = JSON.stringify(extensions, null, 2).replace(/\n/g, '\n    ')
const generated = source
  .replace(CATALOG_PLACEHOLDER, `/*__CATALOG_JSON__*/\n    ${json}`)
  .replace(EXTENSION_PLACEHOLDER, `/*__EXTENSIONS_JSON__*/\n    ${extensionJson}`)

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
