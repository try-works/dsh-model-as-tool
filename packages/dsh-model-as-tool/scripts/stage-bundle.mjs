/**
 * Materialise the bundled dependency as a REAL directory before packing.
 *
 * `bundledDependencies` does not follow a workspace junction: packing the host produced
 * 99 entries and ZERO bundled ones, so the dependency would still be fetched from the
 * registry — where it does not exist — and a consumer install would still 404.
 *
 * npm only bundles a dependency it finds as an actual directory, so the built package is
 * copied into place here. It is removed again afterwards, because leaving it would make
 * the repository look like it vendors a package it resolves from the workspace.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostDir = dirname(dirname(fileURLToPath(import.meta.url)))
// The script lives in the host's `scripts/` directory, so the sibling package is two
// levels up from the script rather than one.
const bundledPackages = [
  { name: '@try-works/tool-mode-contracts', source: join(hostDir, '..', 'tool-mode-contracts') },
  { name: '@try-works/tool-mode-extension-sdk', source: join(hostDir, '..', 'tool-mode-extension-sdk') },
  { name: '@try-works/tool-mode-recipes', source: join(hostDir, '..', 'tool-mode-recipes') },
]

if (process.argv.includes('--clean')) {
  for (const bundled of bundledPackages) {
    rmSync(join(hostDir, 'node_modules', ...bundled.name.split('/')), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  // Leave parent scope folders alone when npm still has file handles open during
  // postpack; deleting the exact staged packages is enough to avoid vendoring.
  console.log('bundle: cleaned')
  process.exit(0)
}

for (const bundled of bundledPackages) {
  if (!existsSync(join(bundled.source, 'lib', 'index.js'))) {
    console.error(`bundle: ${bundled.name} has no built lib/; run its build first`)
    process.exit(1)
  }

  const staging = join(hostDir, 'node_modules', ...bundled.name.split('/'))
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  // Only what the package actually needs at runtime and for types. Copying the source
  // would ship the test fixtures and the tsconfig references with it.
  cpSync(join(bundled.source, 'package.json'), join(staging, 'package.json'))
  cpSync(join(bundled.source, 'lib'), join(staging, 'lib'), { recursive: true })
  for (const extra of ['recipes', 'schema', 'bin']) {
    if (existsSync(join(bundled.source, extra))) {
      cpSync(join(bundled.source, extra), join(staging, extra), { recursive: true })
    }
  }
  console.log(`bundle: staged ${bundled.name} for packing`)
}
