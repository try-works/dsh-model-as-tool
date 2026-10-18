/**
 * The host extension-management service (task-79).
 *
 * These tests exercise the service as the browser half will call it — through the
 * ModelToolsRemote methods only — against a REAL SDK store, a REAL lifecycle with
 * an in-memory registrar, and a REAL fixture package installed by the SDK's
 * developer-mode directory installer. Nothing is mocked except the two documented
 * seams (`installDirectory`, `digestContent`) and the disabled-list writer, and
 * every one of those is used to prove a refusal path that cannot be provoked
 * through the filesystem alone.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  ExtensionLifecycle,
  ExtensionStore,
  ManagementError,
  stagedInstallFromDirectory,
  type ContributionRegistrar,
} from '@try-works/tool-mode-extension-sdk'

import { Config } from '../src/index.ts'
import { createExtensionsService, ExtensionsServiceError, packageDirFor } from '../src/extensions-service.ts'
import { cleanup, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const FIXTURE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'extensions-service-extension')
const EXTENSION_ID = '@try-works/fixture-ext-service'
const TOOL_NAME = 'fixture_ext_tool'

/** An in-memory registrar: activation publishes, deactivation withdraws. */
function recordingRegistrar(): ContributionRegistrar {
  const handles = new Map<string, string>()
  let next = 0
  return {
    publish(contribution) {
      const handle = `handle-${++next}`
      handles.set(handle, `${contribution.kind}:${contribution.name}`)
      return handle
    },
    withdraw(handle) {
      handles.delete(handle)
    },
  }
}

/** The real SDK lifecycle over a real store, with no host registry attached. */
function lifecycleFor(storeDir: string): ExtensionLifecycle {
  return new ExtensionLifecycle({ store: new ExtensionStore(storeDir), profile: 'default', registrar: recordingRegistrar() })
}

/**
 * A source root laid out the way the install path expects: one directory per
 * package, named by the package's final identity segment.
 */
function sourceRoot(): string {
  const root = tempDir()
  cpSync(FIXTURE_DIR, join(root, packageDirFor(EXTENSION_ID)), { recursive: true })
  return root
}

/** Assert a promise rejects with one of this service's named refusals. */
async function refuses(promise: Promise<unknown>, code: string): Promise<ExtensionsServiceError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ExtensionsServiceError, `expected ExtensionsServiceError, got ${String(error)}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  assert.fail(`expected a refusal with code ${code}; the call succeeded`)
}

/** Read the recorded install so a test can tamper with the installed bytes. */
function installedRecord(storeDir: string) {
  const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
  assert.ok(record !== undefined, 'the fixture must be installed')
  return record
}

/** Wait until a tool's presence in the real registry stops changing, bounded. */
async function waitForToolPresence(ctx: Awaited<ReturnType<typeof mountPlugin>>, present: boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ctx.tools.schemas().some(schema => schema.name === TOOL_NAME) === present) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

describe('describe() is truthful about what it does not know', () => {
  it('reports store null, writable false and no rows when nothing is configured', async () => {
    const described = await createExtensionsService().describe()
    assert.deepEqual(described, { store: null, writable: false, sourceDir: null, extensions: [] })
  })

  it('lists a first-party source package as not installed, with the reason the store is missing', async () => {
    const source = sourceRoot()
    const described = await createExtensionsService({ sourceDir: source }).describe()
    assert.equal(described.store, null)
    assert.equal(described.writable, false)
    assert.equal(described.sourceDir, resolve(source))
    const rows = described.extensions.filter(row => row.id === EXTENSION_ID)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.installed, false)
    assert.equal(row.active, false)
    assert.equal(row.disabled, false)
    assert.equal(row.integrity, 'unknown')
    assert.equal(row.version, '1.0.0')
    assert.deepEqual([...row.tools], [TOOL_NAME])
    assert.match(row.reason ?? '', /extension store is not configured/)
  })

  it('reports a broken first-party checkout by name instead of hiding it', async () => {
    const source = tempDir()
    const broken = join(source, packageDirFor(EXTENSION_ID))
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'package.json'), JSON.stringify({ name: EXTENSION_ID, version: '1.0.0' }))
    const described = await createExtensionsService({ storeDir: tempDir(), sourceDir: source, allowSourceDirectories: true }).describe()
    const row = described.extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.ok(row !== undefined, 'the broken checkout must be listed by the name its package.json declares')
    assert.equal(row.installed, false)
    assert.match(row.reason ?? '', /is not a usable extension/)
  })

  it('pins the Config default for config.extensionSourceDir', async () => {
    const validate = Config['~standard'].validate
    const withDefault = await validate({ stateFile: 'state.json' })
    assert.equal(withDefault.value.extensionSourceDir, '')
    const explicit = await validate({ stateFile: 'state.json', extensionSourceDir: 'D:/first-party' })
    assert.equal(explicit.value.extensionSourceDir, 'D:/first-party')
  })

  it('is provided on the plugin context with config threaded through apply', async () => {
    const storeDir = tempDir()
    const source = sourceRoot()
    const ctx = await mountPlugin({ extensionStore: storeDir, extensionSourceDir: source })
    const service = ctx.get('modelTools') as
      | { describe(): Promise<{ store: string | null; sourceDir: string | null }>; typertRemote?: { serviceKey?: string } }
      | undefined
    assert.ok(service !== undefined, 'apply must provide the modelTools service')
    // The gateway refuses a service without this visible binding; apply attaches it.
    assert.equal(service.typertRemote?.serviceKey, 'modelTools')
    const described = await service.describe()
    assert.equal(described.store, resolve(storeDir))
    assert.equal(described.sourceDir, resolve(source))
  })
})

describe('install() refuses with named errors before copying anything', () => {
  it('refuses without a configured extension store', async () => {
    const error = await refuses(createExtensionsService().install(EXTENSION_ID, FIXTURE_DIR), 'extension-store-unconfigured')
    assert.match(error.message, /config\.extensionStore/)
  })

  it('refuses without a source argument or a configured source directory', async () => {
    const error = await refuses(
      createExtensionsService({ storeDir: tempDir(), installSource: 'directory' }).install(EXTENSION_ID),
      'extension-source-unconfigured',
    )
    assert.match(error.message, /config\.extensionSourceDir/)
  })

  it('refuses when the resolved source package directory is missing', async () => {
    const service = createExtensionsService({ storeDir: tempDir(), sourceDir: tempDir(), allowSourceDirectories: true, installSource: 'directory' })
    const error = await refuses(service.install(EXTENSION_ID), 'extension-source-missing')
    assert.match(error.message, /does not exist/)
  })

  it('refuses an explicit source path that does not exist', async () => {
    const service = createExtensionsService({ storeDir: tempDir() })
    const error = await refuses(service.install(EXTENSION_ID, join(tempDir(), 'absent')), 'extension-source-missing')
    assert.match(error.message, /does not exist/)
  })

  it('refuses source-directory installs unless the operator allowed them', async () => {
    const service = createExtensionsService({ storeDir: tempDir(), sourceDir: sourceRoot(), installSource: 'directory' })
    const error = await refuses(service.install(EXTENSION_ID), 'extension-source-directories-not-allowed')
    assert.match(error.message, /extensions\.allowSourceDirectories/)
  })

  it('refuses when the source content cannot be digested, before copying', async () => {
    const storeDir = tempDir()
    const service = createExtensionsService({
      storeDir,
      sourceDir: sourceRoot(),
      allowSourceDirectories: true,
      installSource: 'directory',
      digestContent: () => {
        throw new Error('the file is locked by another process')
      },
    })
    const error = await refuses(service.install(EXTENSION_ID), 'extension-digest-unavailable')
    assert.match(error.message, /locked by another process/)
    assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [], 'nothing may be recorded after a refused digest')
  })

  it('refuses a source whose package identity is not the requested id', async () => {
    const service = createExtensionsService({ storeDir: tempDir(), sourceDir: sourceRoot(), allowSourceDirectories: true, installSource: 'directory' })
    const error = await refuses(service.install('@try-works/some-other-extension', FIXTURE_DIR), 'extension-source-mismatch')
    assert.match(error.message, /fixture-ext-service/)
  })

  it('refuses an identity that could escape the source root', async () => {
    const service = createExtensionsService({ storeDir: tempDir(), sourceDir: sourceRoot(), allowSourceDirectories: true, installSource: 'directory' })
    await refuses(service.install('..', FIXTURE_DIR), 'extension-id-invalid')
  })

  it('surfaces the SDK installer refusal with its named code', async () => {
    const service = createExtensionsService({
      storeDir: tempDir(),
      sourceDir: sourceRoot(),
      allowSourceDirectories: true,
      installSource: 'directory',
      installDirectory: async () => {
        throw new ManagementError('UPGRADE_FAILED', 'install', 'the package is already installed', 'Uninstall it first.')
      },
    })
    const error = await refuses(service.install(EXTENSION_ID), 'extension-install-failed')
    assert.match(error.message, /\[UPGRADE_FAILED\]/)
  })

  it('refuses an install whose result carries no content digest', async () => {
    const service = createExtensionsService({
      storeDir: tempDir(),
      sourceDir: sourceRoot(),
      allowSourceDirectories: true,
      installSource: 'directory',
      installDirectory: async () => ({
        extensionId: EXTENSION_ID,
        version: '1.0.0',
        installPath: tempDir(),
        activation: 'inactive',
        discovery: undefined as never,
        archiveDigest: '',
      }),
    })
    await refuses(service.install(EXTENSION_ID), 'extension-digest-unavailable')
  })
})

describe('install then enable/disable is a truthful round-trip', () => {
  it('installs inactive, then reports installed/active/integrity truthfully, then toggles', async () => {
    const storeDir = tempDir()
    const source = sourceRoot()
    const lifecycle = lifecycleFor(storeDir)
    let persisted: readonly string[] = []
    const configuredDisabled: string[] = []
    const service = createExtensionsService({
      storeDir,
      sourceDir: source,
      allowSourceDirectories: true,
      installSource: 'directory',
      lifecycle: () => lifecycle,
      disabledExtensions: () => configuredDisabled,
      persistDisabledExtensions: ids => {
        persisted = ids
        configuredDisabled.splice(0, configuredDisabled.length, ...ids)
      },
    })

    // INSTALLATION IS NOT ACTIVATION.
    const installed = await service.install(EXTENSION_ID)
    assert.deepEqual(installed, {
      id: EXTENSION_ID,
      version: '1.0.0',
      active: false,
      source: 'directory',
      resolvedVersion: '1.0.0',
    })
    assert.equal(lifecycle.stateOf(EXTENSION_ID), undefined, 'install must not write activation state')

    const afterInstall = await service.describe()
    assert.equal(afterInstall.store, resolve(storeDir))
    assert.equal(afterInstall.sourceDir, resolve(source))
    assert.equal(afterInstall.writable, true)
    const installedRow = afterInstall.extensions.find(row => row.id === EXTENSION_ID)
    assert.ok(installedRow !== undefined)
    assert.equal(installedRow.installed, true)
    assert.equal(installedRow.active, false)
    assert.equal(installedRow.disabled, false)
    assert.equal(installedRow.integrity, 'unchanged')
    assert.equal(installedRow.version, '1.0.0')
    assert.deepEqual([...installedRow.tools], [TOOL_NAME])
    assert.match(installedRow.reason ?? '', /installed but never activated/)

    // ENABLE: activation through the real lifecycle, durable intent written.
    const enabled = await service.enable(EXTENSION_ID)
    assert.deepEqual(enabled, { id: EXTENSION_ID, active: true, disabled: false })
    const activeState = lifecycle.stateOf(EXTENSION_ID)
    assert.equal(activeState?.desiredActivation, 'active')
    assert.equal(activeState?.observedActivation, 'active')
    const activeRow = (await service.describe()).extensions.find(row => row.id === EXTENSION_ID)
    assert.equal(activeRow?.active, true)
    assert.equal(activeRow?.reason, null)

    // DISABLE: deactivation persists the inactive intent and records the override.
    const disabled = await service.disable(EXTENSION_ID)
    assert.deepEqual(disabled, { id: EXTENSION_ID, active: false, disabled: true })
    const inactiveState = lifecycle.stateOf(EXTENSION_ID)
    assert.equal(inactiveState?.desiredActivation, 'inactive')
    assert.equal(inactiveState?.observedActivation, 'inactive')
    assert.deepEqual([...persisted], [EXTENSION_ID])
    const disabledRow = (await service.describe()).extensions.find(row => row.id === EXTENSION_ID)
    assert.equal(disabledRow?.active, false)
    assert.equal(disabledRow?.disabled, true)
    assert.match(disabledRow?.reason ?? '', /disabled by the operator/)

    // A FRESH service reads the persisted disabled list and the durable state: the
    // disable survives a restart of the surface, and enable removes it again.
    const restarted = createExtensionsService({
      storeDir,
      sourceDir: source,
      allowSourceDirectories: true,
      lifecycle: () => lifecycleFor(storeDir),
      disabledExtensions: () => configuredDisabled,
      persistDisabledExtensions: ids => {
        persisted = ids
        configuredDisabled.splice(0, configuredDisabled.length, ...ids)
      },
    })
    const restartedRow = (await restarted.describe()).extensions.find(row => row.id === EXTENSION_ID)
    assert.equal(restartedRow?.disabled, true)
    assert.equal(restartedRow?.active, false)
    const reEnabled = await restarted.enable(EXTENSION_ID)
    assert.deepEqual(reEnabled, { id: EXTENSION_ID, active: true, disabled: false })
    assert.deepEqual([...persisted], [])
  })

  it('disables an installed extension that was never activated without inventing a deactivation', async () => {
    const storeDir = tempDir()
    await stagedInstallFromDirectory({ sourceDir: FIXTURE_DIR, storeDir, allowSourceDirectories: true })
    const lifecycle = lifecycleFor(storeDir)
    const configuredDisabled: string[] = []
    const service = createExtensionsService({
      storeDir,
      allowSourceDirectories: true,
      lifecycle: () => lifecycle,
      disabledExtensions: () => configuredDisabled,
      persistDisabledExtensions: ids => configuredDisabled.splice(0, configuredDisabled.length, ...ids),
    })
    assert.equal(lifecycle.stateOf(EXTENSION_ID), undefined)
    const disabled = await service.disable(EXTENSION_ID)
    assert.deepEqual(disabled, { id: EXTENSION_ID, active: false, disabled: true })
    assert.deepEqual([...configuredDisabled], [EXTENSION_ID])
  })

  it('reports changed integrity and refuses activation of tampered bytes', async () => {
    const storeDir = tempDir()
    await stagedInstallFromDirectory({ sourceDir: FIXTURE_DIR, storeDir, allowSourceDirectories: true })
    const record = installedRecord(storeDir)
    const entry = join(record.installPath, 'lib', 'index.js')
    writeFileSync(entry, `${readFileSync(entry, 'utf8')}\n// tampered after installation\n`)
    const lifecycle = lifecycleFor(storeDir)
    const service = createExtensionsService({ storeDir, allowSourceDirectories: true, lifecycle: () => lifecycle })

    const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.equal(row?.integrity, 'changed')
    assert.match(row?.reason ?? '', /not the content that was recorded/)
    const error = await refuses(service.enable(EXTENSION_ID), 'extension-activation-failed')
    assert.match(error.message, /INTEGRITY_MISMATCH/)
  })

  it('refuses enable/disable with a named error when nothing is installed and no lifecycle is mounted', async () => {
    const storeDir = tempDir()
    await refuses(createExtensionsService({ storeDir }).enable(EXTENSION_ID), 'extension-not-installed')
    await refuses(createExtensionsService({ storeDir }).disable(EXTENSION_ID), 'extension-not-installed')
    await stagedInstallFromDirectory({ sourceDir: FIXTURE_DIR, storeDir, allowSourceDirectories: true })
    await refuses(createExtensionsService({ storeDir }).enable(EXTENSION_ID), 'extension-activation-unavailable')
  })
})

describe('the disabled override gates the host restore path', () => {
  it('does not restore a disabled extension while the same package restores when enabled', async () => {
    /** Install the fixture into a fresh store and record a PREVIOUS approval (dead owner). */
    const prepare = async (): Promise<string> => {
      const storeDir = tempDir()
      await stagedInstallFromDirectory({ sourceDir: FIXTURE_DIR, storeDir, allowSourceDirectories: true })
      new ExtensionStore(storeDir).writeProfileState('default', [{
        extensionId: EXTENSION_ID,
        installation: 'installed',
        desiredActivation: 'active',
        observedActivation: 'active',
        ownerPid: 2147483647,
        export: 'not-exported',
        tools: [{ toolName: TOOL_NAME, enabled: true }],
        readiness: {},
      }])
      return storeDir
    }

    // CONTROL: without the disabled entry the restore chain publishes the tool.
    const control = await mountPlugin({ extensionStore: await prepare() })
    assert.equal(await waitForToolPresence(control, true), true, 'the fixture must restore when it is not disabled')

    // DISABLED: the restore gate skips it, so the tool never reaches the registry.
    const disabledStore = await prepare()
    const disabledCtx = await mountPlugin({ extensionStore: disabledStore, disabledExtensions: [EXTENSION_ID] })
    assert.equal(await waitForToolPresence(disabledCtx, false, 1000), true, 'a disabled extension must not be restored')
    // The skip is deliberate, not an activation failure: the durable record is untouched.
    const state = new ExtensionStore(disabledStore).readProfileState('default').value[0]
    assert.equal(state?.observedActivation, 'active')
  })
})

describe('the host service is wire- and browser-agnostic', () => {
  it('imports only node:* and the published SDK', () => {
    const source = readFileSync(join(process.cwd(), 'packages', 'dsh-model-as-tool', 'src', 'extensions-service.ts'), 'utf8')
    const imports = [...source.matchAll(/^import .*$/gm)].map(match => match[0]).join('\n')
    assert.doesNotMatch(imports, /from ['"]react['"]/, 'the host service must not import React')
    assert.doesNotMatch(imports, /@deepseek-ai\//, 'the host service must not import DSH')
    assert.doesNotMatch(imports, /client\//, 'the host service must not import the browser half')
    assert.doesNotMatch(imports, /\.jsx?['"]/, 'the host service must not import browser modules')
  })
})
