/**
 * Lifecycle tests (EXT-04, EXT-26, EXT-27, EXT-28).
 *
 * The properties under test are the ones whose failure is invisible in normal
 * operation: rollback that reaches too far, a generation that advances on a
 * failed activation, a deactivation whose intent was not durable, and a "stopped"
 * claim made while a worker is still running.
 *
 * Requirement links: EXT-04, EXT-26, EXT-27, EXT-28.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import {
  assessReadiness,
  createZipArchiveSource,
  ExtensionLifecycle,
  ExtensionStore,
  ManagementError,
  stagedInstall,
  type Contribution,
  type ContributionRegistrar,
  type InstallSource,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-life-'))
  dirs.push(dir)
  return dir
}

/** A registrar that records what it published and can be told to fail. */
function makeRegistrar(options: { failOn?: string; failWithdrawFor?: string } = {}) {
  const published: Contribution[] = []
  const withdrawn: string[] = []
  const live = new Set<string>()
  const registrar: ContributionRegistrar = {
    publish(contribution) {
      if (options.failOn !== undefined && contribution.name === options.failOn) {
        throw new Error(`registration refused for ${contribution.name}`)
      }
      published.push(contribution)
      const handle = `h:${contribution.extensionId}:${contribution.name}`
      live.add(handle)
      return handle
    },
    withdraw(handle) {
      if (options.failWithdrawFor !== undefined && handle.endsWith(options.failWithdrawFor)) {
        throw new Error(`worker for ${handle} did not stop`)
      }
      withdrawn.push(handle)
      live.delete(handle)
    },
  }
  return { registrar, published, withdrawn, live }
}

/** Install a package contributing the given tools, and return its identity. */
async function installPackage(
  storeDir: string,
  name: string,
  tools: { id: string; name: string }[],
  skills: { id: string; name: string }[] = [],
) {
  const version = '1.0.0'
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name, version, type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify({
    protocolVersion: '1.1.0',
    id: name,
    version,
    displayName: 'Test',
    description: 'A test extension used to exercise the lifecycle.',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false },
    models: [],
    tools: tools.map(tool => ({
      id: tool.id,
      name: tool.name,
      contractId: `@test/${tool.id}`,
      contractVersion: '1.0.0',
      description: `The ${tool.name} tool used for lifecycle testing.`,
      inputSchema: './schemas/in.json',
      outputSchema: './schemas/out.json',
    })),
    implementations: [],
    skills: skills.map(skill => ({
      id: skill.id, name: skill.name, description: `The ${skill.name} skill.`, path: './skills/SKILL.md',
    })),
  })))
  zip.addFile('index.js', Buffer.from('export const ok = true'))
  zip.addFile('schemas/in.json', Buffer.from('{"type":"object"}'))
  zip.addFile('schemas/out.json', Buffer.from('{"type":"object"}'))
  if (skills.length > 0) zip.addFile('skills/SKILL.md', Buffer.from('# Skill'))
  const bytes = new Uint8Array(zip.toBuffer())
  const source: InstallSource = { kind: 'registry', requested: `${name}@${version}` }
  await stagedInstall({
    source,
    storeDir,
    expectedSha512: createHash('sha512').update(bytes).digest('hex'),
    archive: createZipArchiveSource(async () => bytes),
  })
  return { name, version }
}

describe('EXT-26 — activation', () => {
  it('publishes every contribution and advances the generation', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/one', [{ id: 'a', name: 'one_a' }, { id: 'b', name: 'one_b' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(result.state.observedActivation, 'active')
    assert.deepEqual(harness.published.map(entry => entry.name).sort(), ['one_a', 'one_b'])
    assert.equal(result.generation, 2)
  })

  it('creates no provider handle for an uninstalled extension', async () => {
    const store = scratch()
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await assert.rejects(lifecycle.activate('@acme/absent', '1.0.0'), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'EXTENSION_INACTIVE')
      return true
    })
    assert.equal(harness.published.length, 0)
  })

  it('refuses to activate content that changed after installation', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/tampered', [{ id: 'a', name: 't_a' }])
    const handle = makeRegistrar()
    const extensions = new ExtensionStore(store)
    const record = extensions.listInstalled().value[0]!
    // The attack: install a reviewed package, edit it, then activate.
    const { appendFileSync } = await import('node:fs')
    appendFileSync(join(record.installPath, 'index.js'), '\nexport const backdoor = true')

    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: handle.registrar })
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INTEGRITY_MISMATCH')
      return true
    })
    // Nothing was published: verification happens before publication.
    assert.equal(handle.published.length, 0)
    assert.equal(lifecycle.generation, 1)
  })

  it('rolls back ONLY its own contributions when one cannot be registered', async () => {
    const store = scratch()
    await installPackage(store, '@acme/good', [{ id: 'g', name: 'good_tool' }])
    const bad = await installPackage(store, '@acme/bad', [{ id: 'a', name: 'bad_a' }, { id: 'b', name: 'bad_b' }])

    const harness = makeRegistrar({ failOn: 'bad_b' })
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    // A healthy extension is already active; it must survive the other's failure.
    await lifecycle.activate('@acme/good', '1.0.0')
    const generationBefore = lifecycle.generation

    await assert.rejects(lifecycle.activate(bad.name, bad.version), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /bad_b/)
      assert.match(error.recovery, /other extensions were not disturbed/)
      return true
    })

    // The partial publication was withdrawn...
    assert.deepEqual(harness.withdrawn, ['h:@acme/bad:bad_a'])
    assert.deepEqual([...harness.live], ['h:@acme/good:good_tool'])
    // ...the generation did not advance...
    assert.equal(lifecycle.generation, generationBefore)
    // ...and the healthy extension is still active AND still callable, which is
    // what "without disturbing other packages" has to mean in practice.
    assert.equal(lifecycle.stateOf('@acme/good')?.observedActivation, 'active')
    assert.equal(lifecycle.admits('@acme/good', 'good_tool'), true)
  })

  it('records a failed activation rather than leaving it mid-flight', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/fails', [{ id: 'a', name: 'f_a' }])
    const harness = makeRegistrar({ failOn: 'f_a' })
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version))
    assert.equal(lifecycle.stateOf('@acme/fails')?.observedActivation, 'failed')
  })
})

describe('EXT-26 — readiness', () => {
  it('allows activation with merely unprepared assets, as needs-preparation', () => {
    const assessment = assessReadiness({ 'model-cpu': 'unprepared' })
    // EXT-26: a valid package with unprepared model assets MAY be active.
    assert.equal(assessment.proceed, true)
    assert.equal(assessment.diagnostics[0]?.code, 'needs-preparation')
  })

  it('refuses activation when a model deployment has FAILED', () => {
    const assessment = assessReadiness({ 'model-cpu': 'failed' })
    // A failed deployment will not become ready by waiting, so the distinction
    // from unprepared is the difference between a caveat and a fault.
    assert.equal(assessment.proceed, false)
    assert.equal(assessment.diagnostics[0]?.code, 'not-registerable')
  })

  it('reports no diagnostics when everything is ready', () => {
    const assessment = assessReadiness({ 'model-cpu': 'ready' })
    assert.equal(assessment.proceed, true)
    assert.deepEqual([...assessment.diagnostics], [])
  })
})

describe('EXT-27 — deactivation', () => {
  it('persists inactive intent BEFORE withdrawing', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/ordered', [{ id: 'a', name: 'o_a' }])

    // The intent is read from a FRESH store inside `withdraw`, so what is observed
    // is the durable file rather than the lifecycle's in-memory view.
    let intentAtWithdrawal: string | undefined
    const inner = makeRegistrar()
    const observing: ContributionRegistrar = {
      publish: contribution => inner.registrar.publish(contribution),
      withdraw(handle) {
        const persisted = new ExtensionStore(store).readProfileState('default').value
        intentAtWithdrawal = persisted.find(state => state.extensionId === '@acme/ordered')?.desiredActivation
        return inner.registrar.withdraw(handle)
      },
    }
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: observing,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    await lifecycle.deactivate(pkg.name)

    // By the time withdrawal runs, the file on disk already says inactive. That
    // ordering is what survives a crash mid-deactivation: a restart re-reads the
    // file and sees "off" rather than resurrecting the package.
    assert.equal(intentAtWithdrawal, 'inactive')
  })

  it('withdraws every contribution and reports fully stopped', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/full', [{ id: 'a', name: 'x_a' }], [{ id: 's', name: 'x-skill' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    const result = await lifecycle.deactivate(pkg.name)
    assert.equal(result.fullyStopped, true)
    assert.equal(result.cleanupFailure, undefined)
    assert.equal(result.state.observedActivation, 'inactive')
    assert.equal(harness.live.size, 0)
  })

  it('never reports fully stopped while a worker continues, and quarantines instead', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/stuck', [{ id: 'a', name: 's_a' }])
    const harness = makeRegistrar({ failWithdrawFor: 's_a' })
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)

    const result = await lifecycle.deactivate(pkg.name)
    // EXT-27 forbids claiming a full stop while an uncontrolled worker continues.
    assert.equal(result.fullyStopped, false)
    assert.match(String(result.cleanupFailure), /did not stop/)
    assert.equal(result.state.observedActivation, 'quarantined')
    // Intent is STILL inactive even though the stop failed: the operator asked for
    // off, and a stuck worker does not undo that.
    assert.equal(result.state.desiredActivation, 'inactive')
    assert.equal(lifecycle.admits(pkg.name, 's_a'), false)
  })

  it('a deactivated extension is not admitted even if its tool is enabled', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/off', [{ id: 'a', name: 'off_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(lifecycle.stateOf(pkg.name)?.tools[0]?.enabled, true)
    await lifecycle.deactivate(pkg.name)
    // Enabled but inactive is exactly the orthogonal-state case a single boolean
    // would collapse into "on".
    assert.equal(lifecycle.stateOf(pkg.name)?.tools[0]?.enabled, true)
    assert.equal(lifecycle.admits(pkg.name, 'off_a'), false)
  })
})

describe('EXT-04 — per-tool toggles and uninstall', () => {
  it('toggles one tool without deactivating the extension', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/toggle', [{ id: 'a', name: 't_a' }, { id: 'b', name: 't_b' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    lifecycle.setToolEnabled(pkg.name, 't_a', false)

    const state = lifecycle.stateOf(pkg.name)
    assert.equal(state?.observedActivation, 'active')
    assert.equal(state?.tools.find(tool => tool.toolName === 't_a')?.enabled, false)
    assert.equal(state?.tools.find(tool => tool.toolName === 't_b')?.enabled, true)
  })

  it('refuses to toggle a tool the extension does not contribute', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/notool', [{ id: 'a', name: 'n_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.throws(() => lifecycle.setToolEnabled(pkg.name, 'absent', false), /contributes no tool/)
  })

  it('refuses to uninstall an active extension without explicit deactivation', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/inuse', [{ id: 'a', name: 'i_a' }])
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    await assert.rejects(lifecycle.uninstall(pkg.name), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'EXTENSION_IN_USE')
      return true
    })
  })

  it('uninstalls when deactivation is explicitly requested, keeping a tombstone', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/remove', [{ id: 'a', name: 'r_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    await lifecycle.uninstall(pkg.name, { deactivate: true })

    // The record is gone...
    assert.equal(new ExtensionStore(store).listInstalled().value.length, 0)
    // ...but the tombstone remains, so nothing silently resurrects the package.
    const state = lifecycle.stateOf(pkg.name)
    assert.equal(state?.installation, 'absent')
    assert.equal(state?.desiredActivation, 'inactive')
    assert.equal(lifecycle.admits(pkg.name, 'r_a'), false)
  })
})
