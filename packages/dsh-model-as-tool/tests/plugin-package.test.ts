import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The DSH plugin package invariants.
 *
 * A plugin installed into a profile by name must satisfy these or it fails at
 * MOUNT time in someone else's profile. The authoritative check is
 * scripts/check-package.mjs (shared with `npm run plugin:check`); this test runs
 * it and then pins the pieces a loader/consumer reads directly.
 *
 * The reference implementation of these invariants is the dsh-memory plugin
 * (D:\DEV\dsh-memory): entry exports name/inject/apply/Config and NO default,
 * dsh.bundle.patch mounts the package by its published name, and schemastery is
 * a pinned dependency rather than a peer (a profile-supplied 3.18.1 throws).
 */
const PACKAGE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool')
const CHECK = join(PACKAGE_DIR, 'scripts', 'check-package.mjs')

test('the package check script passes (the shape a loader requires)', (t) => {
  if (!existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
    return t.skip('the package lib/ is not built; run the host build first')
  }
  const result = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /plugin package check OK/)
})

test('the manifest declares the bundle patch and the plugin row mounts by published name', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@try-works/dsh-model-as-tool')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*model-tools\b/)
  assert.match(patch, /name:\s*'@try-works\/dsh-model-as-tool'/)
  // The loader addresses CONFIG by top-level row id, so the row id must be stable.
  assert.ok((manifest.files ?? []).includes('cordis.patch.yml'))
})

test('schemastery is a pinned dependency, never a peer (the profile cannot supply it)', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest.peerDependencies ?? {}, '@deepseek-ai/schemastery'), false)
  assert.match(manifest.dependencies['@deepseek-ai/schemastery'], /^\^3\.18\.[4-9]/)
})

test('every bare runtime import of a bundled package is installed by the host', () => {
  // Bundling copies the package directory but not its dependencies, so an
  // undeclared import (the adm-zip incident) fails only in a real profile.
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const hostDeps = manifest.dependencies ?? {}
  const bundled = [
    ['packages/tool-mode-contracts', '@try-works/tool-mode-contracts'],
    ['packages/tool-mode-extension-sdk', '@try-works/tool-mode-extension-sdk'],
    ['packages/tool-mode-recipes', '@try-works/tool-mode-recipes'],
  ]
  for (const [dir, name] of bundled) {
    const pkgDir = join(process.cwd(), dir)
    const own = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).dependencies ?? {}
    const imports = new Set()
    const stack = [join(pkgDir, 'src')]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.name.endsWith('.ts')) {
          for (const match of readFileSync(full, 'utf8').matchAll(/from\s+'([^.'\n][^'\n]{0,120})'/g)) {
            imports.add(match[1])
          }
        }
      }
    }
    for (const specifier of imports) {
      if (specifier.startsWith('node:') || specifier.startsWith('@try-works/')) continue
      const bare = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      assert.ok(own[bare] !== undefined || hostDeps[bare] !== undefined,
        `${name} imports "${bare}" but it is declared nowhere`)
    }
  }
})
