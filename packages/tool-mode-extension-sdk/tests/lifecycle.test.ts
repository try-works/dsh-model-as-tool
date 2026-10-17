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
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
      // Auto-bound fixture implementations are metadata, not the registry leaves
      // these lifecycle assertions track. Explicit implementation fixtures remain recorded.
      if (contribution.kind === 'implementation' && contribution.name.startsWith('fixture-binding-')) return `metadata:${contribution.name}`
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
  skills: { id: string; name: string; requiresTools?: string[] }[] = [],
  options: {
    models?: { id: string }[]
    implementations?: { id: string; contractId: string; contractVersion?: string; modelId?: string }[]
  } = {},
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
    models: (options.models ?? []).map(model => ({
      id: model.id,
      assetSet: `${model.id}-assets`,
      assetLock: './models.lock.json',
      platforms: [{ os: 'win32', arch: 'x64' }],
    })),
    tools: tools.map(tool => ({
      id: tool.id,
      name: tool.name,
      contractId: `@test/${tool.id}`,
      contractVersion: '1.0.0',
      description: `The ${tool.name} tool used for lifecycle testing.`,
      inputSchema: './schemas/in.json',
      outputSchema: './schemas/out.json',
    })),
    implementations: (options.implementations ?? tools.map(tool => ({ id: `fixture-binding-${tool.id}`, contractId: `@test/${tool.id}`, contractVersion: '1.0.0', modelId: undefined }))).map(implementation => ({
      id: implementation.id,
      contractId: implementation.contractId,
      contractVersion: implementation.contractVersion ?? '1.0.0',
      modelId: implementation.modelId,
      recipeVersion: '1.0.0',
    })),
    skills: skills.map(skill => ({
      id: skill.id, name: skill.name, description: `The ${skill.name} skill.`, path: './skills/SKILL.md',
      ...(skill.requiresTools === undefined ? {} : { requiresTools: skill.requiresTools }),
    })),
  })))
  zip.addFile('index.js', Buffer.from('export const ok = true'))
  zip.addFile('schemas/in.json', Buffer.from('{"type":"object"}'))
  zip.addFile('schemas/out.json', Buffer.from('{"type":"object"}'))
  if ((options.models ?? []).length > 0) zip.addFile('models.lock.json', Buffer.from('{"assets":[]}'))
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

  it('withholds model-backed tools whose deployments are not prepared', async () => {
    const store = scratch()
    const pkg = await installPackage(
      store,
      '@acme/unprepared',
      [{ id: 'model-tool', name: 'model_tool' }],
      [
        { id: 'usage', name: 'model-usage', requiresTools: ['model-tool'] },
        { id: 'setup', name: 'model-setup' },
      ],
      {
        models: [{ id: 'model-cpu' }],
        implementations: [{ id: 'impl-cpu', contractId: '@test/model-tool', modelId: 'model-cpu' }],
      },
    )
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(result.state.observedActivation, 'active')
    assert.deepEqual(harness.published.map(entry => `${entry.kind}:${entry.name}`).sort(), ['implementation:impl-cpu', 'skill:model-setup'])
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), false)
    assert.ok(result.diagnostics.some(entry => entry.subject === 'model_tool'))
  })

  it('publishes usage guidance when its required local tool is visible', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/guidance',
      [{ id: 'available-tool', name: 'available_tool' }],
      [{ id: 'usage', name: 'available-usage', requiresTools: ['available-tool'] }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.deepEqual(harness.published.map(entry => entry.name).sort(), ['available-usage', 'available_tool'])
  })

  it('withholds a tool and usage skill when only another contract version is implemented', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/wrong-version',
      [{ id: 'versioned', name: 'versioned_tool' }],
      [{ id: 'usage', name: 'versioned-usage', requiresTools: ['versioned'] }],
      { implementations: [{ id: 'wrong', contractId: '@test/versioned', contractVersion: '2.0.0' }] })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.deepEqual(harness.published.map(entry => entry.name), ['wrong'])
    assert.ok(result.diagnostics.some(entry => entry.code === 'not-registerable' && entry.subject === 'versioned_tool'))
    assert.equal(lifecycle.admits(pkg.name, 'versioned_tool'), false)
  })

  it('admits a model-free tool even when an unrelated declared deployment is unprepared', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/unrelated-model',
      [{ id: 'plain', name: 'plain_tool' }], [],
      { models: [{ id: 'unrelated' }], implementations: [
        { id: 'plain-impl', contractId: '@test/plain' },
        { id: 'other-impl', contractId: '@test/other', modelId: 'unrelated' },
      ] })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.ok(harness.published.some(entry => entry.name === 'plain_tool'))
    assert.equal(result.state.readiness.unrelated, 'needs-preparation')
    // The tool's own binding has no deployment, so an unrelated unprepared model
    // must not make it inadmissible.
    assert.equal(lifecycle.admits(pkg.name, 'plain_tool'), true)
  })

  it('withholds when the first exact binding is cold even if a later binding is ready', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/mixed-readiness',
      [{ id: 'mixed', name: 'mixed_tool' }],
      [{ id: 'usage', name: 'mixed-usage', requiresTools: ['mixed'] }],
      { models: [{ id: 'cold' }, { id: 'warm' }], implementations: [
        { id: 'cold-first', contractId: '@test/mixed', modelId: 'cold' },
        { id: 'warm-second', contractId: '@test/mixed', modelId: 'warm' },
      ] })
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [{ extensionId: pkg.name, installation: 'installed',
      desiredActivation: 'inactive', observedActivation: 'inactive', export: 'not-exported',
      tools: [], readiness: { cold: 'needs-preparation', warm: 'ready' } }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: harness.registrar })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.deepEqual(harness.published.map(entry => entry.name), ['cold-first', 'warm-second'])
    assert.ok(result.diagnostics.some(entry => entry.subject === 'mixed_tool' && entry.code === 'needs-preparation'))
  })

  it('ignores persisted failures for deployments no longer declared by the package', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/removed-deployment', [], [], { models: [{ id: 'current' }] })
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [{ extensionId: pkg.name, installation: 'installed',
      desiredActivation: 'inactive', observedActivation: 'inactive', export: 'not-exported',
      tools: [], readiness: { removed: 'failed', current: 'prepared-cold' } }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: harness.registrar })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(result.state.observedActivation, 'active')
    assert.deepEqual(result.state.readiness, { current: 'prepared-cold' })
  })

  it('still refuses persisted failure for a currently declared deployment', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/current-failure', [], [], { models: [{ id: 'current' }] })
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [{ extensionId: pkg.name, installation: 'installed',
      desiredActivation: 'inactive', observedActivation: 'inactive', export: 'not-exported',
      tools: [], readiness: { current: 'failed', removed: 'ready' } }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: harness.registrar })
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version), /deployment current is in a failed state/)
    assert.equal(harness.published.length, 0)
    assert.deepEqual(lifecycle.stateOf(pkg.name)?.readiness, { current: 'failed' })
  })

  it('retains failed rollback handles and refuses reactivation until cleanup succeeds', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/rollback-cleanup', [{ id: 'a', name: 'rb_a' }, { id: 'b', name: 'rb_b' }])
    const harness = makeRegistrar({ failOn: 'rb_b' })
    let stuck = true
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: {
      publish: contribution => harness.registrar.publish(contribution),
      withdraw(handle) { if (stuck) throw new Error('rollback stuck'); return harness.registrar.withdraw(handle) },
    } })
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version), /rb_b/)
    assert.equal(lifecycle.stateOf(pkg.name)?.observedActivation, 'quarantined')
    assert.equal(lifecycle.generation, 1)
    const count = harness.published.length
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version), /cleanup|in use/i)
    assert.equal(harness.published.length, count)
    stuck = false
    assert.equal((await lifecycle.deactivate(pkg.name)).fullyStopped, true)
    assert.equal(harness.live.size, 0)
  })

  it('refuses to overwrite interrupted activation with no local handles', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/interrupted-activation', [])
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [{ extensionId: pkg.name, installation: 'installed',
      desiredActivation: 'active', observedActivation: 'activating', export: 'not-exported', tools: [], readiness: {} }])
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: makeRegistrar().registrar })
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version), /cleanup/i)
    assert.equal((await lifecycle.deactivate(pkg.name)).fullyStopped, false)
    assert.equal(lifecycle.stateOf(pkg.name)?.observedActivation, 'quarantined')
  })

  it('retains all rollback handles when cross-kind contributions share a name', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/collision-cleanup', [{ id: 'a', name: 'shared' }],
      [{ id: 'bad', name: 'fail-skill' }], { implementations: [{ id: 'shared', contractId: '@test/a' }] })
    let next = 0
    let stuck = true
    const live = new Set<string>()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: {
      publish(entry) { if (entry.kind === 'skill') throw new Error('skill refused'); const handle = String(++next); live.add(handle); return handle },
      withdraw(handle) { if (stuck) throw new Error('stuck'); live.delete(handle) },
    } })
    await assert.rejects(lifecycle.activate(pkg.name, pkg.version), /skill refused/)
    assert.equal(live.size, 2)
    stuck = false
    assert.equal((await lifecycle.deactivate(pkg.name)).fullyStopped, true)
    assert.equal(live.size, 0)
  })

  it('rejects overlapping lifecycle changes while publication awaits', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/overlap', [{ id: 'a', name: 'overlap_a' }])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: {
      async publish(entry) { await gate; return harness.registrar.publish(entry) },
      withdraw: handle => harness.registrar.withdraw(handle),
    } })
    const activation = lifecycle.activate(pkg.name, pkg.version)
    try {
      await assert.rejects(lifecycle.deactivate(pkg.name), /operation.*progress|in progress/i)
      await assert.rejects(lifecycle.uninstall(pkg.name, { deactivate: true }), /operation.*progress|in progress/i)
      await assert.rejects(lifecycle.setToolEnabled(pkg.name, 'overlap_a', false), /operation.*progress|in progress/i)
    } finally { release() }
    await activation
    assert.equal(lifecycle.stateOf(pkg.name)?.observedActivation, 'active')
    assert.equal((await lifecycle.deactivate(pkg.name)).fullyStopped, true)
    assert.equal(harness.live.size, 0)
  })

  it('keeps other extensions independent and releases exclusion after rejection', async () => {
    const store = scratch()
    const slow = await installPackage(store, '@acme/slow-guard', [{ id: 'a', name: 'slow_a' }])
    const fast = await installPackage(store, '@acme/fast-guard', [{ id: 'b', name: 'fast_b' }])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const harness = makeRegistrar()
    let refuseSlow = true
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: {
      async publish(entry) {
        if (entry.extensionId === slow.name) { await gate; if (refuseSlow) throw new Error('publication rejected') }
        return harness.registrar.publish(entry)
      },
      withdraw: handle => harness.registrar.withdraw(handle),
    } })
    const pending = lifecycle.activate(slow.name, slow.version)
    const rejected = assert.rejects(pending, /publication rejected/)
    try {
      await assert.rejects(lifecycle.activate(slow.name, slow.version), /operation in progress/)
      assert.equal((await lifecycle.activate(fast.name, fast.version)).state.observedActivation, 'active')
    } finally { release() }
    await rejected
    refuseSlow = false
    assert.equal((await lifecycle.activate(slow.name, slow.version)).state.observedActivation, 'active')
    await lifecycle.deactivate(slow.name)
    await lifecycle.deactivate(fast.name)
    assert.equal(harness.live.size, 0)
  })

  it('withholds unimplemented tools and usage skills but retains setup guidance', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/unimplemented', [{ id: 'a', name: 'unserved_a' }],
      [{ id: 'usage', name: 'unserved-usage', requiresTools: ['a'] }, { id: 'setup', name: 'unserved-setup' }],
      { implementations: [] })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.deepEqual(harness.published.map(entry => entry.name), ['unserved-setup'])
    assert.ok(result.diagnostics.some(entry => entry.subject === 'unserved_a' && entry.code === 'not-registerable'))
    // Publication and admission must agree: a withheld tool is not callable.
    assert.equal(lifecycle.admits(pkg.name, 'unserved_a'), false)
  })

  it('recovers a model-backed package once readiness is recorded, without a deadlock', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/model-recovery',
      [{ id: 'mt', name: 'model_tool' }], [],
      { models: [{ id: 'dep' }], implementations: [{ id: 'impl', contractId: '@test/mt', modelId: 'dep' }] })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })

    // No recorded readiness yet: the model-backed tool is withheld, but implementations
    // are still published as metadata, and the package reports needs-preparation.
    const first = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(first.state.observedActivation, 'active')
    assert.equal(harness.live.has('h:@acme/model-recovery:model_tool'), false)
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), false)

    // The operator prepares the model: record it, then cycle the package.
    const extensions = new ExtensionStore(store)
    const state = extensions.readProfileState('default').value[0]!
    extensions.writeProfileState('default', [{ ...state, readiness: { dep: 'prepared-cold' } }])
    assert.equal((await lifecycle.deactivate(pkg.name)).fullyStopped, true)

    const second = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(second.state.observedActivation, 'active')
    assert.equal(harness.live.has('h:@acme/model-recovery:model_tool'), true)
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), true)
  })

  it('can re-activate to pick up newly recorded readiness without a deadlock', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/model-reactivate',
      [{ id: 'mt', name: 'model_tool' }], [],
      { models: [{ id: 'dep' }], implementations: [{ id: 'impl', contractId: '@test/mt', modelId: 'dep' }] })
    const harness = makeRegistrar()
    const extensions = new ExtensionStore(store)
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: harness.registrar })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), false)

    // Record preparation WITHOUT cycling the package, then activate again. The
    // implementation-metadata handles this package published must not be mistaken
    // for a competing owner and block picking up the new readiness.
    const state = extensions.readProfileState('default').value[0]!
    extensions.writeProfileState('default', [{ ...state, readiness: { dep: 'prepared-cold' } }])
    const second = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(second.state.observedActivation, 'active')
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), true)
    assert.equal(harness.live.has('h:@acme/model-reactivate:model_tool'), true)
  })

  it('refuses to adopt an extension another instance already has active', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/two-owners', [{ id: 'a', name: 'owner_a' }])
    const extensions = new ExtensionStore(store)
    const first = makeRegistrar()
    const owner = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: first.registrar })
    await owner.activate(pkg.name, pkg.version)
    assert.equal(first.live.size > 0, true)

    // A SECOND instance must not adopt-and-republish: it holds no handles for the
    // surface the first one published, so duplicating it would leave two owners.
    const second = makeRegistrar()
    const stranger = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: second.registrar })
    await assert.rejects(stranger.activate(pkg.name, pkg.version), /EXTENSION_IN_USE|already|in progress|cleanup/i)
    assert.equal(second.live.size, 0)

    // And the stranger must not claim a full stop for a surface it never owned.
    assert.equal((await stranger.deactivate(pkg.name)).fullyStopped, false)
    assert.equal(first.live.size > 0, true)
  })

  it('restores an extension recorded active by a previous process (restart)', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/restart', [{ id: 'a', name: 'restart_a' }])
    const extensions = new ExtensionStore(store)
    const before = makeRegistrar()
    const first = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: before.registrar })
    await first.activate(pkg.name, pkg.version)
    // The process exits WITHOUT deactivating: state keeps saying active, and the
    // handles it published died with the process. Simulate that by recording a
    // DEAD owner pid — the restart case the guard must allow.
    const prior = extensions.readProfileState('default').value[0]!
    extensions.writeProfileState('default', [{ ...prior, ownerPid: 2147483647 }])

    // A NEW process must be able to restore what the operator approved. If the
    // adoption guard treated every 'active' record as a live foreign owner, restart
    // would permanently refuse to restore a healthy extension.
    const after = makeRegistrar()
    const second = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: after.registrar })
    const restored = await second.activate(pkg.name, pkg.version)
    assert.equal(restored.state.observedActivation, 'active')
    assert.equal(after.live.size > 0, true)
    assert.equal(second.admits(pkg.name, 'restart_a'), true)
  })

  it('recordReadiness makes a model-backed tool publishable without a manual state edit', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/record-readiness',
      [{ id: 'mt', name: 'model_tool' }], [],
      { models: [{ id: 'dep' }], implementations: [{ id: 'impl', contractId: '@test/mt', modelId: 'dep' }] })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), false)

    // The PRODUCTION writer: the host records inspected readiness, then re-activates.
    await lifecycle.recordReadiness(pkg.name, { dep: 'prepared-cold', stale: 'failed' })
    const state = lifecycle.stateOf(pkg.name)
    assert.equal(state?.readiness.dep, 'prepared-cold')
    // Deployments the manifest does not declare are dropped, so a stale failure
    // cannot poison activation.
    assert.equal('stale' in (state?.readiness ?? {}), false)

    const second = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(second.state.observedActivation, 'active')
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), true)
    assert.equal(harness.live.has('h:@acme/record-readiness:model_tool'), true)
  })

  it('withdraws a published tool when its deployment is recorded as failed', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/readiness-downgrade',
      [{ id: 'mt', name: 'model_tool' }], [],
      { models: [{ id: 'dep' }], implementations: [{ id: 'impl', contractId: '@test/mt', modelId: 'dep' }] })
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    // A deployment failing AFTER publication must move the surface too: the tool is
    // withdrawn, not left registered while admission merely says false.
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [{ extensionId: pkg.name, installation: 'installed',
      desiredActivation: 'inactive', observedActivation: 'inactive', export: 'not-exported',
      tools: [], readiness: { dep: 'prepared-cold' } }])
    await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), true)
    assert.equal(harness.live.has('h:@acme/readiness-downgrade:model_tool'), true)

    await lifecycle.recordReadiness(pkg.name, { dep: 'failed' })
    assert.equal(harness.live.has('h:@acme/readiness-downgrade:model_tool'), false)
    assert.equal(lifecycle.admits(pkg.name, 'model_tool'), false)
  })

  it('recordReadiness throws for unknown extensions and unreadable manifests', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/record-guard', [{ id: 'a', name: 'rg_a' }], [], { models: [{ id: 'dep' }] })
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar })
    await assert.rejects(lifecycle.recordReadiness('@acme/nobody', { dep: 'ready' }), /not known|not installed/)
    await assert.rejects(lifecycle.recordReadiness(pkg.name, { dep: 'ready' }), /not known|not installed/)
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
    const assessment = assessReadiness({ 'model-cpu': 'needs-preparation' })
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

  it('retries failed withdrawals instead of forgetting their handles', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/retry-stop', [{ id: 'a', name: 'retry_a' }])
    const harness = makeRegistrar()
    let attempts = 0
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: {
      publish: contribution => harness.registrar.publish(contribution),
      withdraw(handle) {
        if (!handle.startsWith('metadata:') && ++attempts === 1) throw new Error('temporarily stuck')
        return harness.registrar.withdraw(handle)
      },
    } })
    await lifecycle.activate(pkg.name, pkg.version)
    const failed = await lifecycle.deactivate(pkg.name)
    assert.equal(failed.fullyStopped, false)
    assert.equal(harness.live.size, 1)
    const retried = await lifecycle.deactivate(pkg.name)
    assert.equal(retried.fullyStopped, true)
    assert.equal(attempts, 2)
    assert.equal(harness.live.size, 0)
  })

  it('re-admits a published tool after it is re-enabled', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/re-admit', [{ id: 'a', name: 'readmit_a' }])
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(lifecycle.admits(pkg.name, 'readmit_a'), true)
    await lifecycle.setToolEnabled(pkg.name, 'readmit_a', false)
    assert.equal(lifecycle.admits(pkg.name, 'readmit_a'), false)
    await lifecycle.setToolEnabled(pkg.name, 'readmit_a', true)
    // The toggle changes INTENT only; the committed published surface is unchanged,
    // so re-enabling must restore admission rather than require a reactivation.
    assert.equal(lifecycle.admits(pkg.name, 'readmit_a'), true)
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

describe('EXT-27 — the onWithdrawal teardown hook (task-29)', () => {
  it('fires exactly once AFTER every handle withdrawal settled and BEFORE the final state write', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/hook-order', [{ id: 'a', name: 'ho_a' }])
    const harness = makeRegistrar()
    const calls: string[] = []
    let stateAtHook: string | undefined
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
      onWithdrawal(extensionId) {
        calls.push(extensionId)
        // By the time the hook runs, every registrar handle must already be gone…
        assert.equal(harness.live.size, 0, 'the hook must observe a withdrawn surface')
        // …and the FINAL state write must not have happened yet (the durable file
        // still carries the mid-flight `deactivating` record).
        const persisted = new ExtensionStore(store).readProfileState('default').value
        stateAtHook = persisted.find(state => state.extensionId === extensionId)?.observedActivation
      },
    })
    await lifecycle.activate(pkg.name, pkg.version)
    const result = await lifecycle.deactivate(pkg.name)

    assert.deepEqual(calls, [pkg.name], 'the hook runs exactly once per withdrawn extension')
    assert.equal(stateAtHook, 'deactivating', 'the hook runs BEFORE the final state write settles')
    assert.equal(result.state.observedActivation, 'inactive', 'the final write lands after the hook')
    assert.equal(result.hookFailure, undefined)
  })

  it('a REJECTING hook never loses the withdrawal state write, and the error surfaces as hookFailure', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/hook-fail', [{ id: 'a', name: 'hf_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
      onWithdrawal() {
        throw new Error('worker disposal exploded')
      },
    })
    await lifecycle.activate(pkg.name, pkg.version)
    const result = await lifecycle.deactivate(pkg.name)

    // The durable answer is still "off": the hook error must not resurrect the
    // package or leave it half-withdrawn.
    assert.equal(result.fullyStopped, true)
    assert.equal(result.state.observedActivation, 'inactive')
    assert.equal(harness.live.size, 0)
    assert.equal(result.hookFailure, 'worker disposal exploded', 'the hook error is surfaced, never thrown')
    const persisted = new ExtensionStore(store).readProfileState('default').value
    assert.equal(persisted.find(state => state.extensionId === pkg.name)?.observedActivation, 'inactive')
  })

  it('awaits an ASYNC hook before the final state write settles', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/hook-async', [{ id: 'a', name: 'ha_a' }])
    let settled = false
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar,
      onWithdrawal: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        settled = true
      },
    })
    await lifecycle.activate(pkg.name, pkg.version)
    const result = await lifecycle.deactivate(pkg.name)
    assert.equal(settled, true, 'the hook promise must settle before deactivate returns')
    assert.equal(result.hookFailure, undefined)
    assert.equal(result.state.observedActivation, 'inactive')
  })

  it('an async hook that REJECTS still commits the state and reports the error', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/hook-async-fail', [{ id: 'a', name: 'haf_a' }])
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar,
      onWithdrawal: async () => {
        throw new Error('async disposal failure')
      },
    })
    await lifecycle.activate(pkg.name, pkg.version)
    const result = await lifecycle.deactivate(pkg.name)
    assert.equal(result.hookFailure, 'async disposal failure')
    assert.equal(result.state.observedActivation, 'inactive')
  })

  it('an omitted hook is byte-identical: the result carries no hookFailure key', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/no-hook', [{ id: 'a', name: 'nh_a' }])
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    const result = await lifecycle.deactivate(pkg.name)
    assert.equal('hookFailure' in result, false, 'an absent hook must not add keys to the result')
    assert.equal(result.fullyStopped, true)
  })

  it('fires on the deactivate-inside-uninstall path too', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/hook-uninstall', [{ id: 'a', name: 'hu_a' }])
    const calls: string[] = []
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar,
      onWithdrawal(extensionId) {
        calls.push(extensionId)
      },
    })
    await lifecycle.activate(pkg.name, pkg.version)
    await lifecycle.uninstall(pkg.name, { deactivate: true })
    assert.deepEqual(calls, [pkg.name], 'uninstall-with-deactivate must invoke the teardown hook once')
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
    await lifecycle.setToolEnabled(pkg.name, 't_a', false)

    const state = lifecycle.stateOf(pkg.name)
    assert.equal(state?.observedActivation, 'active')
    assert.equal(state?.tools.find(tool => tool.toolName === 't_a')?.enabled, false)
    assert.equal(state?.tools.find(tool => tool.toolName === 't_b')?.enabled, true)
  })

  it('preserves disabled choices and withholds dependent guidance on reactivation', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/remember-choice',
      [{ id: 'a', name: 'choice_a' }, { id: 'b', name: 'choice_b' }],
      [{ id: 'usage', name: 'choice-usage', requiresTools: ['a'] }, { id: 'setup', name: 'choice-setup' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    await lifecycle.activate(pkg.name, pkg.version)
    await lifecycle.setToolEnabled(pkg.name, 'choice_a', false)
    await lifecycle.deactivate(pkg.name)
    harness.published.length = 0
    const result = await lifecycle.activate(pkg.name, pkg.version)
    assert.equal(result.state.tools.find(tool => tool.toolName === 'choice_a')?.enabled, false)
    assert.deepEqual(harness.published.map(entry => entry.name).sort(), ['choice-setup', 'choice_b'])
    assert.equal(lifecycle.admits(pkg.name, 'choice_a'), false)
  })

  it('retains installed bytes and quarantine when uninstall cleanup fails', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/unsafe-remove', [{ id: 'a', name: 'remove_a' }])
    const extensions = new ExtensionStore(store)
    const harness = makeRegistrar({ failWithdrawFor: 'remove_a' })
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: harness.registrar })
    await lifecycle.activate(pkg.name, pkg.version)
    await assert.rejects(lifecycle.uninstall(pkg.name, { deactivate: true }), /cleanup/i)
    assert.equal(extensions.listInstalled().value.length, 1)
    assert.equal(lifecycle.stateOf(pkg.name)?.observedActivation, 'quarantined')
    await assert.rejects(lifecycle.uninstall(pkg.name), /cleanup|in use|active/i)
    assert.equal(extensions.listInstalled().value.length, 1)
    assert.equal(harness.live.size, 1)
  })

  it('never treats repeated orphan deactivation as evidence of a clean stop', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/orphan-retry', [{ id: 'a', name: 'orphan_a' }])
    const extensions = new ExtensionStore(store)
    const owner = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: makeRegistrar().registrar })
    await owner.activate(pkg.name, pkg.version)
    const stranger = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: makeRegistrar().registrar })
    assert.equal((await stranger.deactivate(pkg.name)).fullyStopped, false)
    assert.equal((await stranger.deactivate(pkg.name)).fullyStopped, false)
    await assert.rejects(stranger.uninstall(pkg.name, { deactivate: true }), /cleanup/i)
    assert.equal(extensions.listInstalled().value.length, 1)
  })

  it('refuses uninstall after a crash leaves deactivating intent without local handles', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/interrupted-stop', [])
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [{ extensionId: pkg.name, installation: 'installed',
      desiredActivation: 'inactive', observedActivation: 'deactivating', export: 'not-exported', tools: [], readiness: {} }])
    const lifecycle = new ExtensionLifecycle({ store: extensions, profile: 'default', registrar: makeRegistrar().registrar })
    await assert.rejects(lifecycle.uninstall(pkg.name, { deactivate: true }), /cleanup/i)
    assert.equal(extensions.listInstalled().value.length, 1)
    assert.equal(lifecycle.stateOf(pkg.name)?.observedActivation, 'quarantined')
  })

  it('withdraws a disabled tool from the published surface and republishes it on enable', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/reconcile',
      [{ id: 'a', name: 'rec_a' }, { id: 'b', name: 'rec_b' }],
      [{ id: 'usage', name: 'rec-usage', requiresTools: ['a'] }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar })
    await lifecycle.activate(pkg.name, pkg.version)
    assert.deepEqual([...harness.live].sort(), [
      'h:@acme/reconcile:rec-usage', 'h:@acme/reconcile:rec_a', 'h:@acme/reconcile:rec_b',
    ])

    await lifecycle.setToolEnabled(pkg.name, 'rec_a', false)
    // A disabled tool must LEAVE the registry, and its dependent usage skill with it.
    assert.deepEqual([...harness.live].sort(), ['h:@acme/reconcile:rec_b'])
    assert.equal(lifecycle.admits(pkg.name, 'rec_a'), false)
    assert.equal(lifecycle.admits(pkg.name, 'rec_b'), true)

    await lifecycle.setToolEnabled(pkg.name, 'rec_a', true)
    assert.deepEqual([...harness.live].sort(), [
      'h:@acme/reconcile:rec-usage', 'h:@acme/reconcile:rec_a', 'h:@acme/reconcile:rec_b',
    ])
    assert.equal(lifecycle.admits(pkg.name, 'rec_a'), true)
  })

  it('keeps a surface entry visible and tracked when its withdrawal fails during a toggle', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/partial-reconcile',
      [{ id: 'a', name: 'pr_a' }, { id: 'b', name: 'pr_b' }])
    const harness = makeRegistrar()
    let stuck = false
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: {
      publish: contribution => harness.registrar.publish(contribution),
      withdraw(handle) {
        if (stuck && handle.endsWith('pr_a')) throw new Error('worker will not stop')
        return harness.registrar.withdraw(handle)
      },
    } })
    await lifecycle.activate(pkg.name, pkg.version)
    const generationBefore = lifecycle.generation

    stuck = true
    await assert.rejects(lifecycle.setToolEnabled(pkg.name, 'pr_a', false), /partly reconciled/)
    // A failed withdrawal leaves the contribution REGISTERED, so it must stay
    // tracked; the retry below only succeeds if the handle was retained.
    assert.equal(harness.live.has('h:@acme/partial-reconcile:pr_a'), true)
    // The operator asked for it OFF, so the host stops admitting it either way —
    // disabling is an intent the host enforces, not a statement about the registry.
    assert.equal(lifecycle.admits(pkg.name, 'pr_a'), false)
    assert.equal(lifecycle.admits(pkg.name, 'pr_b'), true)
    // The surface moved, so the generation advanced even though the toggle reported failure.
    assert.equal(lifecycle.generation, generationBefore + 1)

    stuck = false
    await lifecycle.setToolEnabled(pkg.name, 'pr_a', false)
    // Retrying actually releases it, which proves the handle survived the failure.
    assert.equal(harness.live.has('h:@acme/partial-reconcile:pr_a'), false)
    assert.equal(lifecycle.admits(pkg.name, 'pr_a'), false)
  })

  it('a redundant toggle is a no-op and does not advance the generation', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/noop-toggle', [{ id: 'a', name: 'noop_a' }])
    const lifecycle = new ExtensionLifecycle({ store: new ExtensionStore(store), profile: 'default', registrar: makeRegistrar().registrar })
    await lifecycle.activate(pkg.name, pkg.version)
    const generation = lifecycle.generation
    await lifecycle.setToolEnabled(pkg.name, 'noop_a', true)
    await lifecycle.setToolEnabled(pkg.name, 'noop_a', true)
    assert.equal(lifecycle.generation, generation)
  })

  it('refuses to toggle a tool the extension does not contribute', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/notool', [{ id: 'a', name: 'n_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)
    await assert.rejects(lifecycle.setToolEnabled(pkg.name, 'absent', false), /contributes no tool/)
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

  it('state-mutating operations hold the STORE lock, so an offline editor is refused (EXT-31)', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/locked-edit', [{ id: 'a', name: 'le_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)

    // A LIVE FOREIGN process holds the store lock. A made-up pid would read as a
    // stale lock (isProcessAlive is false), so a real child is spawned and its
    // pid written into the lock document — exactly what another host process
    // would leave behind.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
    try {
      writeFileSync(join(store, 'store.lock'), JSON.stringify({ pid: holder.pid, since: new Date().toISOString() }))
      await assert.rejects(
        lifecycle.setToolEnabled(pkg.name, 'le_a', false),
        (error: unknown) => {
          assert.ok(error instanceof ManagementError)
          assert.equal(error.code, 'EXTENSION_IN_USE')
          return true
        },
      )
      // The failed operation left the tool's state untouched: it is still enabled.
      assert.equal(lifecycle.stateOf(pkg.name)?.tools.find(tool => tool.toolName === 'le_a')?.enabled, true)
    } finally {
      holder.kill()
    }
  })

  it('the store lock is REENTRANT: nested lifecycle operations in one process do not self-refuse', async () => {
    const store = scratch()
    const pkg = await installPackage(store, '@acme/reentrant', [{ id: 'a', name: 're_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    // Two nested exclusive sections over the same store: the outer holds the lock,
    // the inner must not refuse its own process's reacquisition.
    const outer = new ExtensionStore(store)
    await outer.exclusive(async () => {
      await lifecycle.activate(pkg.name, pkg.version)
    })
    assert.equal(lifecycle.stateOf(pkg.name)?.observedActivation, 'active')
    assert.equal(harness.published.length, 1)
  })

  it('RE-ENTRANCY ACROSS INSTANCES on one root: the inner does not overwrite or remove the outer lock', async () => {
    // The round-49 review's hole 3: two ExtensionStore instances on one rootDir
    // must share the reentrancy depth, or the inner acquisition overwrites the
    // outer's lock record and removes it early.
    const store = scratch()
    const pkg = await installPackage(store, '@acme/cross-instance', [{ id: 'a', name: 'ci_a' }])
    const harness = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: harness.registrar,
    })
    const outer = new ExtensionStore(store)
    let lockFileSeenDuringInner: string | undefined
    let lockFileSeenAfterOuter: string | undefined
    await outer.exclusive(async () => {
      await lifecycle.activate(pkg.name, pkg.version)
      lockFileSeenDuringInner = readFileSync(join(store, 'store.lock'), 'utf8')
    })
    const afterOuter = join(store, 'store.lock')
    lockFileSeenAfterOuter = existsSync(afterOuter) ? readFileSync(afterOuter, 'utf8') : undefined
    // During the inner call the outer's record must still name THIS process, and
    // after the outer returns the record must be GONE (removed exactly once).
    assert.match(String(lockFileSeenDuringInner), new RegExp(String(process.pid)))
    assert.equal(lockFileSeenAfterOuter, undefined, 'the outer release must remove the lock')
  })

  it('the reentrancy key is the CANONICAL path: a junction spelling of one store does not split the depth', { skip: process.platform !== 'win32' }, async () => {
    // The round-50 review's key-canonicalization finding: the depth map must key
    // on the real path, or two spellings (case, junctions) of ONE directory
    // behave as two stores and the inner acquisition overwrites the outer's lock
    // record. A junction is the realistic Windows vector (unlike symlinks, it
    // needs no elevation), so the regression is pinned against it.
    const store = scratch()
    const junction = join(scratch(), 'j')
    symlinkSync(store, junction, 'junction')
    try {
      const pkg = await installPackage(store, '@acme/junction-spelling', [{ id: 'a', name: 'js_a' }])
      const harness = makeRegistrar()
      const viaReal = new ExtensionStore(store)
      const viaJunction = new ExtensionStore(junction)
      const lifecycle = new ExtensionLifecycle({
        store: viaReal, profile: 'default', registrar: harness.registrar,
      })
      let junctionLockSeen: string | undefined
      let lockFileAfter: string | undefined
      await viaJunction.exclusive(async () => {
        await lifecycle.activate(pkg.name, pkg.version)
        junctionLockSeen = readFileSync(join(junction, 'store.lock'), 'utf8')
      })
      const afterOuter = join(store, 'store.lock')
      lockFileAfter = existsSync(afterOuter) ? readFileSync(afterOuter, 'utf8') : undefined
      // The inner (real-spelling store) must NOT have overwritten or removed the
      // outer (junction-spelling) record: one directory, one lock, one depth.
      assert.match(String(junctionLockSeen), new RegExp(String(process.pid)))
      assert.equal(lockFileAfter, undefined, 'the junction-spelled outer release must remove the lock exactly once')
    } finally {
      rmSync(junction, { recursive: true, force: true })
    }
  })

  it('a REFUSED acquisition does not poison the depth: the next exclusive() takes the lock again', async () => {
    // The round-49 review's hole 1: a refusal before the try left the depth map
    // stuck, permanently unlocking the instance. The discriminator is the SECOND
    // refusal: a healthy store refuses while a NEW holder is alive; a poisoned one
    // skips acquisition and mutates silently, so only this assertion separates
    // the two worlds.
    const store = scratch()
    const pkg = await installPackage(store, '@acme/refusal-then-retry', [{ id: 'a', name: 'rr_a' }])
    const harness = makeRegistrar()
    const store0 = new ExtensionStore(store)
    const lifecycle = new ExtensionLifecycle({
      store: store0, profile: 'default', registrar: harness.registrar,
    })
    await lifecycle.activate(pkg.name, pkg.version)

    // A live foreign holder refuses the first mutation...
    const first = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      writeFileSync(join(store, 'store.lock'), JSON.stringify({ pid: first.pid, since: new Date().toISOString() }))
      await assert.rejects(
        lifecycle.setToolEnabled(pkg.name, 'rr_a', false),
        (error: unknown) => {
          assert.ok(error instanceof ManagementError)
          assert.equal(error.code, 'EXTENSION_IN_USE')
          return true
        },
      )
    } finally {
      first.kill()
      await new Promise<void>(resolve => first.once('exit', () => resolve()))
    }
    // ...and a SECOND live holder must refuse the SAME instance again. This is
    // the assertion that fails under poisoned depth: if the refusal had left the
    // count nonzero, this call would skip the lock and toggle silently.
    const second = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      writeFileSync(join(store, 'store.lock'), JSON.stringify({ pid: second.pid, since: new Date().toISOString() }))
      await assert.rejects(
        lifecycle.setToolEnabled(pkg.name, 'rr_a', false),
        (error: unknown) => {
          assert.ok(error instanceof ManagementError)
          assert.equal(error.code, 'EXTENSION_IN_USE')
          return true
        },
      )
      assert.equal(lifecycle.stateOf(pkg.name)?.tools.find(tool => tool.toolName === 'rr_a')?.enabled, true, 'nothing may have been toggled')
    } finally {
      second.kill()
      await new Promise<void>(resolve => second.once('exit', () => resolve()))
    }
    // Once no holder remains, the same instance acquires and mutates normally.
    await lifecycle.setToolEnabled(pkg.name, 'rr_a', false)
    assert.equal(lifecycle.stateOf(pkg.name)?.tools.find(tool => tool.toolName === 'rr_a')?.enabled, false)
  })
})
