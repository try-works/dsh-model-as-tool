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
const contractSource = join(hostDir, '..', 'tool-mode-contracts')
const staging = join(hostDir, 'node_modules', '@try-works', 'tool-mode-contracts')

if (process.argv.includes('--clean')) {
  rmSync(join(hostDir, 'node_modules'), { recursive: true, force: true })
  console.log('bundle: cleaned')
  process.exit(0)
}

if (!existsSync(join(contractSource, 'lib', 'index.js'))) {
  console.error('bundle: @try-works/tool-mode-contracts has no built lib/; run its build first')
  process.exit(1)
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
// Only what the package actually needs at runtime and for types. Copying the source
// would ship the test fixtures and the tsconfig references with it.
cpSync(join(contractSource, 'package.json'), join(staging, 'package.json'))
cpSync(join(contractSource, 'lib'), join(staging, 'lib'), { recursive: true })
console.log('bundle: staged @try-works/tool-mode-contracts for packing')
