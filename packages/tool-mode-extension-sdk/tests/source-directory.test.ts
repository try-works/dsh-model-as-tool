/**
 * EXT-06 — local source-directory developer mode (task-69).
 *
 * A source DIRECTORY installs with the same discipline as archives: the
 * operator config must allow it, the manifest is validated, install-time
 * scripts are refused, reparse points (ancestor junctions and in-tree links)
 * are refused, and the installation lands INACTIVE with the source recorded.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  ExtensionLifecycle,
  ExtensionStore,
  ManagementError,
  stagedInstallFromDirectory,
  type ContributionRegistrar,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-src-'))
  dirs.push(dir)
  return dir
}

/** Materialize a valid module-extension source checkout. */
function makeSourceDir(root: string, scripts?: Record<string, string>): string {
  const dir = join(root, 'checkout')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: '@acme/dev-ext', version: '1.0.0', type: 'module',
    exports: { './tool-mode': './index.js', './tool-mode.extension.json': './tool-mode.extension.json', './package.json': './package.json' },
    toolMode: { manifest: './tool-mode.extension.json' },
    ...scripts === undefined ? {} : { scripts },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'tool-mode.extension.json'), `${JSON.stringify({
    protocolVersion: '1.1.0', id: '@acme/dev-ext', version: '1.0.0',
    displayName: 'Dev Ext', description: 'A developer-mode source-directory extension.',
    activation: { policy: 'operator', deactivatable: true }, runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [], tools: [], implementations: [], skills: [],
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'index.js'), 'export const ok = true\n')
  return dir
}

const stubRegistrar = (): ContributionRegistrar => ({
  publish: contribution => `h:${contribution.extensionId}:${contribution.name}`,
  withdraw: () => { /* nothing to release */ },
})

describe('EXT-06 — source-directory developer mode', () => {
  it('an allowed source directory installs INACTIVE with the source recorded, then activates', async () => {
    const store = scratch()
    const source = makeSourceDir(scratch())
    const result = await stagedInstallFromDirectory({
      sourceDir: source,
      storeDir: store,
      allowSourceDirectories: true,
    })
    assert.equal(result.activation, 'inactive')
    assert.equal(result.extensionId, '@acme/dev-ext')
    const record = new ExtensionStore(store).listInstalled().value[0]
    assert.ok(record !== undefined)
    assert.equal(record.source.kind, 'local-directory')
    assert.equal(record.source.requested, resolve(source))
    // Activation through the ordinary lifecycle.
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: stubRegistrar(),
    })
    const activation = await lifecycle.activate('@acme/dev-ext', '1.0.0')
    assert.equal(activation.state.observedActivation, 'active')
  })

  it('a disallowed source directory refuses by name', async () => {
    const store = scratch()
    const source = makeSourceDir(scratch())
    try {
      await stagedInstallFromDirectory({ sourceDir: source, storeDir: store, allowSourceDirectories: false })
      assert.fail('the operator gate must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INVALID_EXTENSION')
      assert.match(error.message, /not allowed by the operator configuration/)
    }
  })

  it('a source checkout declaring an install-time script refuses, never runs', async () => {
    const store = scratch()
    const source = makeSourceDir(scratch(), { postinstall: 'echo pwned' })
    try {
      await stagedInstallFromDirectory({ sourceDir: source, storeDir: store, allowSourceDirectories: true })
      assert.fail('an install-time script must refuse the install')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /postinstall/)
    }
    assert.equal(existsSync(join(store, 'extensions')), false, 'nothing was materialized')
  })

  it('a junction on the source path or inside the checkout refuses', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows junctions are the reparse-point vector')
      return
    }
    // Ancestor junction: the source path passes through a link.
    const store = scratch()
    const root = scratch()
    const real = join(root, 'real')
    const link = join(root, 'link')
    makeSourceDir(real)
    const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, real], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    try {
      await stagedInstallFromDirectory({ sourceDir: link, storeDir: store, allowSourceDirectories: true })
      assert.fail('an ancestor junction must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /junction|symbolic link/)
    }

    // In-tree junction: a link inside the checkout.
    const store2 = scratch()
    const source2 = makeSourceDir(scratch())
    const target = join(source2, '..', 'outside')
    mkdirSync(target)
    const inner = spawnSync('cmd', ['/c', 'mklink', '/J', join(source2, 'linked'), target], { encoding: 'utf8' })
    assert.equal(inner.status, 0, inner.stderr)
    try {
      await stagedInstallFromDirectory({ sourceDir: source2, storeDir: store2, allowSourceDirectories: true })
      assert.fail('an in-tree reparse point must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /reparse point/)
    }
  })
})
