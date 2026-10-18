/**
 * The PREFLIGHT requirements model (task-92).
 *
 * The defect these tests pin: the live host let the operator click Enable on
 * `@try-works/extension-declarative-recipes`, ran activation, and only THEN threw
 * an EXTENSION_FAULT ("this deployment composes no harness LlmProvider ... Set
 * config.harnessModel"). The requirements model must make every deployment gap
 * visible in `describe()` and refuse `enable()` BEFORE the lifecycle is touched.
 *
 * The tests use the REAL staged installer and real manifests/locks; only the
 * lifecycle (an in-memory double that COUNTS calls) and the deployment-facts thunk
 * are injected, so "no activation was attempted" is an observation, not an
 * assertion about a mock's default behavior.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  digestInstalledContent,
  discoverExtension,
  ExtensionStore,
  type ExtensionState as SdkExtensionState,
  stagedInstallFromDirectory,
} from '@try-works/tool-mode-extension-sdk'

import type { ExtensionRequirement, ExtensionRequirementAction, ExtensionRequirementKind, ExtensionState } from '../src/extensions-api.ts'
import { planPreparation } from '../src/deployment-coordinator.ts'
import {
  createExtensionsService,
  ExtensionsServiceError,
  packageDirFor,
  type ExtensionActivation,
  type HarnessProviderStatus,
} from '../src/extensions-service.ts'
import { identityFor, parseAssetLock, plannedAssets, type PrepareAssetsSurface } from '../src/prepared-assets.ts'
import { cleanup, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const PREPARABLE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'preparable-extension')
const EXECUTABLE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'executable-extension')
const DECLARATIVE_DIR = join(process.cwd(), 'packages', 'extension-declarative-recipes')
const PREPARABLE_ID = '@try-works/fixture-preparable'
const EXECUTABLE_ID = '@try-works/fixture-executable'
const DECLARATIVE_ID = '@try-works/extension-declarative-recipes'
const PREPARABLE_MODEL = 'fixture-preparable-model'
const EXECUTABLE_MODEL = 'fixture-executable-model'

const REQUIREMENT_KINDS: readonly ExtensionRequirementKind[] = [
  'store', 'source', 'dependencies', 'assets', 'executable', 'harness-model', 'platform', 'integrity', 'activation',
]
const REQUIREMENT_ACTIONS: readonly ExtensionRequirementAction[] = ['install', 'prepare', 'enable', 'config', 'none']

/** An in-memory lifecycle that COUNTS activation attempts. */
function fakeLifecycle(seed: SdkExtensionState[] = []): ExtensionActivation & { readonly calls: { activate: number; deactivate: number } } {
  const states = new Map<string, SdkExtensionState>()
  for (const state of seed) states.set(state.extensionId, state)
  const calls = { activate: 0, deactivate: 0 }
  return {
    calls,
    stateOf(extensionId) {
      return states.get(extensionId)
    },
    async activate(extensionId: string, _version: string) {
      calls.activate += 1
      const previous = states.get(extensionId)
      states.set(extensionId, {
        extensionId,
        installation: 'installed',
        desiredActivation: 'active',
        observedActivation: 'active',
        readiness: previous?.readiness ?? {},
        tools: previous?.tools ?? [],
        export: 'not-exported',
        ownerPid: process.pid,
      })
      return {} as never
    },
    async deactivate(extensionId: string) {
      calls.deactivate += 1
      const previous = states.get(extensionId)
      if (previous !== undefined) {
        states.set(extensionId, { ...previous, desiredActivation: 'inactive', observedActivation: 'inactive' })
      }
      return {} as never
    },
  }
}

/** Install one fixture directory into a fresh store and return the store path. */
async function installInto(fixtureDir: string, storeDir = tempDir()): Promise<string> {
  await stagedInstallFromDirectory({ sourceDir: fixtureDir, storeDir, allowSourceDirectories: true })
  return storeDir
}

/** A copy of a fixture whose manifest/package.json a test may patch before installing. */
function patchedFixture(fixtureDir: string, patch: (directory: string) => void): string {
  const root = tempDir()
  const target = join(root, packageDirFor('@try-works/fixture-patched'))
  cpSync(fixtureDir, target, { recursive: true })
  patch(target)
  return target
}

/** A plan-only prepared-assets surface: enough for the executable requirement, no acquisition. */
function planSurface(storeDir: string): PrepareAssetsSurface {
  const store = new ExtensionStore(storeDir)
  return {
    plan(extensionId) {
      const record = store.listInstalled().value.find(candidate => candidate.extensionId === extensionId)
      assert.ok(record !== undefined, `${extensionId} must be installed to plan`)
      const discovery = discoverExtension(record.installPath)
      const model = discovery.manifest.models[0]
      assert.ok(model !== undefined, `${extensionId} must declare a model to plan`)
      const lock = parseAssetLock(readFileSync(join(dirname(discovery.manifestPath), model.assetLock.replace(/^\.\//, '')), 'utf8'))
      return planPreparation(identityFor(extensionId, model.id, lock), plannedAssets(lock, model.assetSet), lock.license)
    },
    groupsForPlan() {
      throw new Error('plan-only surface: groups are not used by the requirements model')
    },
    modelIdFor() {
      throw new Error('plan-only surface: model id is not used by the requirements model')
    },
    async prepare() {
      throw new Error('plan-only surface: preparation is not used by the requirements model')
    },
    assetMapFor() {
      return undefined
    },
    registry: undefined as never,
  }
}

/** Find one requirement kind on a row. */
function kindOf(row: ExtensionState, kind: ExtensionRequirementKind): ExtensionRequirement {
  const found = row.requirements.find(candidate => candidate.kind === kind)
  assert.ok(found !== undefined, `${row.id} must report a ${kind} requirement; got ${row.requirements.map(candidate => candidate.kind).join(', ')}`)
  return found
}

/** Assert an enable refusal with a code and return it. */
async function rejects(promise: Promise<unknown>, code: string): Promise<ExtensionsServiceError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ExtensionsServiceError, `expected ExtensionsServiceError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected a refusal with code ${code}`)
}

describe('a declarative extension reports the missing harness model BEFORE Enable', () => {
  it('names the provider status as unknown when the host supplied no thunk, and refuses before activation', async () => {
    const storeDir = await installInto(DECLARATIVE_DIR)
    const lifecycle = fakeLifecycle()
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === DECLARATIVE_ID)
    assert.ok(row !== undefined)
    const harness = kindOf(row, 'harness-model')
    assert.equal(harness.satisfied, false)
    assert.equal(harness.action, 'config')
    assert.match(harness.reason, /provider status unknown/)
    assert.equal(row.blocked, true)
    assert.equal(row.reason, harness.reason)

    const error = await rejects(service.enable(DECLARATIVE_ID), 'extension-requirement-unmet')
    assert.equal(error.message, harness.reason)
    assert.equal(lifecycle.calls.activate, 0, 'no activation may be attempted for a deployment gap')
  })

  it('uses the host-supplied remediation verbatim and passes enable when the provider is available', async () => {
    const storeDir = await installInto(DECLARATIVE_DIR)
    const remediation =
      'this deployment composes no harness LlmProvider, so declarative extensions cannot be served; set config.harnessModel to a runnable model'
    const unavailable = createExtensionsService({
      storeDir,
      lifecycle: () => fakeLifecycle(),
      harnessProviderStatus: (): HarnessProviderStatus => ({ available: false, reason: remediation, action: 'config' }),
    })
    const unavailableRow = (await unavailable.describe()).extensions.find(candidate => candidate.id === DECLARATIVE_ID)
    assert.ok(unavailableRow !== undefined)
    assert.equal(kindOf(unavailableRow, 'harness-model').reason, remediation)
    assert.equal(unavailableRow.reason, remediation)
    const refused = await rejects(unavailable.enable(DECLARATIVE_ID), 'extension-requirement-unmet')
    assert.equal(refused.message, remediation)

    const lifecycle = fakeLifecycle()
    const available = createExtensionsService({
      storeDir,
      lifecycle: () => lifecycle,
      harnessProviderStatus: (): HarnessProviderStatus => ({ available: true, provider: 'deepseek', model: 'deepseek-chat' }),
    })
    const availableRow = (await available.describe()).extensions.find(candidate => candidate.id === DECLARATIVE_ID)
    assert.ok(availableRow !== undefined)
    const satisfied = kindOf(availableRow, 'harness-model')
    assert.equal(satisfied.satisfied, true)
    assert.match(satisfied.reason, /deepseek \/ deepseek-chat/)
    assert.equal(availableRow.blocked, false)
    const enabled = await available.enable(DECLARATIVE_ID)
    assert.equal(enabled.active, true)
    assert.equal(lifecycle.calls.activate, 1)
  })
})

describe('per-kind requirements are truthful and block the right action', () => {
  it('reports assets unmet with the prepare action and refuses enable before activation', async () => {
    const storeDir = await installInto(PREPARABLE_DIR)
    const lifecycle = fakeLifecycle()
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === PREPARABLE_ID)
    assert.ok(row !== undefined)
    const assets = kindOf(row, 'assets')
    assert.equal(assets.satisfied, false)
    assert.equal(assets.action, 'prepare')
    assert.equal(assets.reason, `activation blocked: ${PREPARABLE_MODEL} needs its model assets prepared — run prepare for this extension`)
    assert.equal(row.blocked, true)
    const error = await rejects(service.enable(PREPARABLE_ID), 'extension-preparation-required')
    assert.equal(error.message, assets.reason)
    assert.equal(lifecycle.calls.activate, 0)
  })

  it('reports an unsupported platform with no page action and refuses enable', async () => {
    const targets = [
      { os: 'darwin', arch: 'arm64' },
      { os: 'linux', arch: 'arm64' },
      { os: 'linux', arch: 'x64' },
      { os: 'win32', arch: 'x64' },
    ]
    const foreign = targets.find(target => target.os !== process.platform || target.arch !== process.arch)
    assert.ok(foreign !== undefined)
    const PATCHED_ID = '@try-works/fixture-patched'
    const fixture = patchedFixture(PREPARABLE_DIR, directory => {
      const packageJsonPath = join(directory, 'package.json')
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
      pkg['name'] = PATCHED_ID
      writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
      const manifestPath = join(directory, 'tool-mode.extension.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        id: string
        models: { platforms: { os: string; arch: string; accelerator?: string }[] }[]
      }
      manifest.id = PATCHED_ID
      manifest.models[0]!.platforms = [{ os: foreign.os, arch: foreign.arch, accelerator: 'cpu' }]
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    })
    const storeDir = await installInto(fixture)
    const lifecycle = fakeLifecycle()
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === PATCHED_ID)
    assert.ok(row !== undefined)
    const platform = kindOf(row, 'platform')
    assert.equal(platform.satisfied, false)
    assert.equal(platform.action, 'none')
    assert.match(platform.reason, new RegExp(`${foreign.os}-${foreign.arch}`))
    assert.equal(row.blocked, true)
    const error = await rejects(service.enable(PATCHED_ID), 'extension-requirement-unmet')
    assert.equal(error.message, platform.reason)
    assert.equal(lifecycle.calls.activate, 0)
  })

  it('names missing installed dependencies and refuses enable', async () => {
    const storeDir = tempDir()
    const installPath = join(storeDir, 'extensions', PREPARABLE_ID, '1.0.0')
    cpSync(PREPARABLE_DIR, installPath, { recursive: true })
    const packageJsonPath = join(installPath, 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
    pkg['dependencies'] = { '@fixture/missing-dep': '^1.0.0' }
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
    const contentDigest = digestInstalledContent(installPath)
    new ExtensionStore(storeDir).recordInstall({
      extensionId: PREPARABLE_ID,
      version: '1.0.0',
      installPath,
      archiveDigest: contentDigest,
      contentDigest,
      source: { kind: 'local', requested: PREPARABLE_DIR },
      installedAt: new Date().toISOString(),
    })
    const lifecycle = fakeLifecycle()
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === PREPARABLE_ID)
    assert.ok(row !== undefined)
    const dependencies = kindOf(row, 'dependencies')
    assert.equal(dependencies.satisfied, false)
    assert.equal(dependencies.action, 'install')
    assert.match(dependencies.reason, /@fixture\/missing-dep/)
    assert.equal(row.blocked, true)
    const error = await rejects(service.enable(PREPARABLE_ID), 'extension-requirement-unmet')
    assert.equal(error.message, dependencies.reason)
    assert.equal(lifecycle.calls.activate, 0)
  })

  it('reports changed integrity with the install action and keeps the INTEGRITY_MISMATCH refusal code', async () => {
    const storeDir = await installInto(PREPARABLE_DIR)
    const record = new ExtensionStore(storeDir).listInstalled().value[0]!
    writeFileSync(join(record.installPath, 'lib', 'index.js'), '// tampered\n')
    const lifecycle = fakeLifecycle()
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === PREPARABLE_ID)
    assert.ok(row !== undefined)
    const integrity = kindOf(row, 'integrity')
    assert.equal(integrity.satisfied, false)
    assert.equal(integrity.action, 'install')
    assert.equal(row.blocked, true)
    const error = await rejects(service.enable(PREPARABLE_ID), 'extension-activation-failed')
    assert.match(error.message, /INTEGRITY_MISMATCH/)
    assert.equal(lifecycle.calls.activate, 0)
  })

  it('reports the executable gate as unmet when the plan needs approval, and satisfied once the operator approves', async () => {
    const storeDir = await installInto(EXECUTABLE_DIR)
    const off = createExtensionsService({
      storeDir,
      lifecycle: () => fakeLifecycle(),
      prepareSurface: () => planSurface(storeDir),
      allowExecutablePreparation: () => false,
    })
    const offRow = (await off.describe()).extensions.find(candidate => candidate.id === EXECUTABLE_ID)
    assert.ok(offRow !== undefined)
    const executable = kindOf(offRow, 'executable')
    assert.equal(executable.satisfied, false)
    assert.equal(executable.action, 'config')
    assert.match(executable.reason, /allowExecutablePreparation is off/)
    assert.equal(offRow.blocked, true)
    const lifecycle = fakeLifecycle()
    const offWithSpy = createExtensionsService({
      storeDir,
      lifecycle: () => lifecycle,
      prepareSurface: () => planSurface(storeDir),
      allowExecutablePreparation: () => false,
    })
    const error = await rejects(offWithSpy.enable(EXECUTABLE_ID), 'extension-requirement-unmet')
    assert.equal(error.message, executable.reason)
    assert.equal(lifecycle.calls.activate, 0)

    const on = createExtensionsService({
      storeDir,
      lifecycle: () => fakeLifecycle(),
      prepareSurface: () => planSurface(storeDir),
      allowExecutablePreparation: () => true,
    })
    const onRow = (await on.describe()).extensions.find(candidate => candidate.id === EXECUTABLE_ID)
    assert.ok(onRow !== undefined)
    assert.equal(kindOf(onRow, 'executable').satisfied, true)
    // The assets requirement is still the blocker: approval is not preparation.
    assert.equal(kindOf(onRow, 'assets').satisfied, false)
    await rejects(on.enable(EXECUTABLE_ID), 'extension-preparation-required')
  })

  it('reports an unreadable/quarantined activation state as unmet with the diagnostic', async () => {
    const storeDir = await installInto(PREPARABLE_DIR)
    const quarantined: SdkExtensionState = {
      extensionId: PREPARABLE_ID,
      installation: 'installed',
      desiredActivation: 'active',
      observedActivation: 'quarantined',
      readiness: { [PREPARABLE_MODEL]: 'prepared-cold' },
      tools: [],
      export: 'not-exported',
    }
    // describe() reads the DURABLE profile state, enable() reads the lifecycle; a
    // real host persists both, so the test seeds both with the same state.
    new ExtensionStore(storeDir).writeProfileState('default', [quarantined])
    const lifecycle = fakeLifecycle([quarantined])
    const service = createExtensionsService({ storeDir, lifecycle: () => lifecycle })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === PREPARABLE_ID)
    assert.ok(row !== undefined)
    const activation = kindOf(row, 'activation')
    assert.equal(activation.satisfied, false)
    assert.equal(activation.action, 'none')
    assert.match(activation.reason, /quarantined/)
    assert.equal(row.blocked, true)
    const error = await rejects(service.enable(PREPARABLE_ID), 'extension-requirement-unmet')
    assert.equal(error.message, activation.reason)
    assert.equal(lifecycle.calls.activate, 0)
  })

  it('models installers: an unconfigured store blocks a source-only row with the config action', async () => {
    const sourceDir = tempDir()
    cpSync(PREPARABLE_DIR, join(sourceDir, packageDirFor(PREPARABLE_ID)), { recursive: true })
    const service = createExtensionsService({ sourceDir, allowSourceDirectories: true })
    const described = await service.describe()
    assert.equal(described.store, null)
    const row = described.extensions.find(candidate => candidate.id === PREPARABLE_ID)
    assert.ok(row !== undefined)
    const storeRequirement = kindOf(row, 'store')
    assert.equal(storeRequirement.satisfied, false)
    assert.equal(storeRequirement.action, 'config')
    assert.equal(kindOf(row, 'source').satisfied, true)
    assert.equal(row.blocked, true)
    await rejects(service.enable(PREPARABLE_ID), 'extension-store-unconfigured')
  })

  it('reports every satisfied requirement too, so "nothing to do" is distinguishable from "not checked"', async () => {
    const storeDir = await installInto(DECLARATIVE_DIR)
    const activeState: SdkExtensionState = {
      extensionId: DECLARATIVE_ID,
      installation: 'installed',
      desiredActivation: 'active',
      observedActivation: 'active',
      readiness: {},
      tools: [],
      export: 'not-exported',
      ownerPid: process.pid,
    }
    new ExtensionStore(storeDir).writeProfileState('default', [activeState])
    const lifecycle = fakeLifecycle([activeState])
    const service = createExtensionsService({
      storeDir,
      lifecycle: () => lifecycle,
      harnessProviderStatus: (): HarnessProviderStatus => ({ available: true, provider: 'harness', model: 'test-model' }),
    })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === DECLARATIVE_ID)
    assert.ok(row !== undefined)
    assert.equal(row.active, true)
    assert.equal(row.blocked, false)
    for (const kind of ['store', 'source', 'dependencies', 'assets', 'platform', 'integrity', 'activation', 'harness-model'] as const) {
      const found = kindOf(row, kind)
      assert.equal(found.satisfied, true, `${kind} must be satisfied for an active, provider-backed declarative row: ${found.reason}`)
      assert.ok(found.reason.length > 0, `${kind} must explain itself even when satisfied`)
    }
  })
})

describe('the audit matrix over every first-party extension', () => {
  it('gives every real package a requirements list covering its prerequisites and explains every blocker', async () => {
    const packagesRoot = join(process.cwd(), 'packages')
    const packages = readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('extension-'))
      .map(entry => entry.name)
      .filter(name => existsSync(join(packagesRoot, name, 'tool-mode.extension.json')))
      .sort()
    assert.ok(packages.length >= 8, `expected the first-party extension set, found ${packages.join(', ')}`)

    const storeDir = tempDir()
    const service = createExtensionsService({
      storeDir,
      sourceDir: packagesRoot,
      allowSourceDirectories: true,
      lifecycle: () => fakeLifecycle(),
      harnessProviderStatus: (): HarnessProviderStatus => ({ available: true, provider: 'harness', model: 'matrix-model' }),
    })
    const described = await service.describe()
    const rows = new Map(described.extensions.map(row => [row.id, row]))

    const missingRows: string[] = []
    for (const packageName of packages) {
      const manifestPath = join(packagesRoot, packageName, 'tool-mode.extension.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        id: string
        execution?: { kind?: string }
        models?: unknown[]
      }
      const row = rows.get(manifest.id)
      if (row === undefined) {
        missingRows.push(`${packageName} (${manifest.id})`)
        continue
      }
      // Every row covers the deployment-wide prerequisites.
      for (const kind of ['store', 'source', 'dependencies', 'platform', 'integrity', 'activation', 'assets', 'executable'] as const) {
        kindOf(row, kind)
      }
      // Platform-specific model packages declare assets; declarative ones do not.
      if ((manifest.models ?? []).length > 0) {
        assert.equal(kindOf(row, 'assets').satisfied, false, `${manifest.id}: a source-only model package cannot report its assets as prepared`)
      } else {
        assert.equal(kindOf(row, 'assets').satisfied, true, `${manifest.id}: no model deployment means the assets requirement is satisfied`)
      }
      // The harness model is a real prerequisite exactly for declarative packages.
      const isDeclarative = manifest.execution?.kind === 'declarative'
      const harness = row.requirements.find(candidate => candidate.kind === 'harness-model')
      assert.equal(harness !== undefined, isDeclarative, `${manifest.id}: harness-model presence must match execution.kind`)
      // Every requirement is well formed and explained.
      for (const requirement of row.requirements) {
        assert.ok(REQUIREMENT_KINDS.includes(requirement.kind), `${manifest.id}: unknown requirement kind ${requirement.kind}`)
        assert.ok(REQUIREMENT_ACTIONS.includes(requirement.action), `${manifest.id}: unknown action ${requirement.action}`)
        assert.ok(requirement.reason.length > 0, `${manifest.id}: ${requirement.kind} needs a reason even when satisfied`)
      }
      // Every blocked row names at least one unmet requirement with a reason/action.
      if (row.blocked) {
        const unmet = row.requirements.filter(candidate => !candidate.satisfied)
        assert.ok(unmet.length > 0, `${manifest.id}: blocked with no unmet requirement`)
        for (const requirement of unmet) {
          assert.ok(requirement.reason.length > 0, `${manifest.id}: unmet ${requirement.kind} needs a reason`)
          assert.ok(REQUIREMENT_ACTIONS.includes(requirement.action), `${manifest.id}: unmet ${requirement.kind} needs an action`)
        }
        assert.ok(row.reason !== null && unmet.some(requirement => requirement.reason === row.reason),
          `${manifest.id}: a blocked row's summary must be one of its unmet requirement reasons`)
      }
    }
    assert.deepEqual(missingRows, [], 'every first-party extension must appear in describe()')
    assert.equal(rows.size >= packages.length, true)
  })
})
