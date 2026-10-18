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

test('the client half is a generated ModuleLoader bundle with the model list embedded', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok((manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings'),
    'the client half needs the settings UI slot provider injected')
  const clientExport = manifest.exports?.['./client']
  const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof target, 'string', 'exports["./client"] must resolve to a file')
  const source = readFileSync(join(PACKAGE_DIR, String(target).replace(/^\.\//, '')), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(source.includes(`id: '${manifest.name}'`), 'the loader id must be the package name')
  assert.match(source, /settings\.section/)
  assert.match(source, /label: 'Model as Tool'/)
  // One row per catalog model with a toggle, not a free-text field.
  assert.ok(!source.includes('/*__CATALOG_JSON__*/ []'), 'the catalog placeholder must be replaced by the build')
  assert.match(source, /"id": "tongue"/)
  assert.match(source, /mtt-toggle/)
  assert.ok((manifest.files ?? []).includes('client/index.js'), 'files[] must ship the generated bundle')
  assert.ok(!(manifest.files ?? []).some(f => String(f).includes('template')),
    'files[] must not ship the template')

  // Drift guard: the committed bundle must equal what the generator produces now.
  const generated = spawnSync(process.execPath, [join(PACKAGE_DIR, 'scripts', 'gen-client-catalog.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`)
})

test('the Settings-editable fields are marked volatile so the host exposes them', async (t) => {
  if (!existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
    return t.skip('the package lib/ is not built; run the host build first')
  }
  // schemastery exposes a Config field to the settings mirror ONLY when it carries
  // the volatile marker; without it the page renders "namespace not exposed".
  const { pathToFileURL } = await import('node:url')
  const { Config } = await import(pathToFileURL(join(PACKAGE_DIR, 'lib', 'index.js')).href) as {
    Config: { dict?: Record<string, { meta?: { volatile?: boolean } }> }
  }
  for (const key of ['models', 'exclude', 'exposeUnavailable', 'registerSkills',
    'registerControlTool', 'allowNpm', 'managedWorkers', 'repairAttempts', 'approvedRoots']) {
    const field = Config.dict?.[key]
    assert.ok(field !== undefined, `${key} must exist on Config`)
    assert.equal(field.meta?.volatile, true, `${key} must be marked .volatile() for the Settings page`)
  }
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
