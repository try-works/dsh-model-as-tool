/**
 * EXT-09 — installer-owned dependency graphs (task-55, fix H1).
 *
 * A fixture extension declares runtime dependencies; the injected fake
 * resolver/archive stand in for the operator-configured registry. Every flow
 * is driven through the real stagedInstall: materialization into the
 * extension's own directory, runtime import of the dependency, one-time range
 * resolution, integrity refusal, lifecycle-script refusal, graph bounds,
 * version-conflict refusal, and the undeclared-import failure at load time.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import AdmZip from 'adm-zip'

import {
  createZipArchiveSource,
  ExtensionStore,
  ManagementError,
  stagedInstall,
  type DependencyResolver,
  type InstallSource,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-dep-'))
  dirs.push(dir)
  return dir
}

const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex')

/** Build a fake dependency tarball. */
function makeDep(
  name: string,
  version: string,
  options: { deps?: Record<string, string>; scripts?: Record<string, string>; exportsName?: string } = {},
): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name, version, type: 'module',
    exports: { '.': './index.js' },
    ...options.deps === undefined ? {} : { dependencies: options.deps },
    ...options.scripts === undefined ? {} : { scripts: options.scripts },
  })))
  zip.addFile('index.js', Buffer.from(`export const value = ${JSON.stringify(options.exportsName ?? `${name}@${version}`)}\n`))
  return new Uint8Array(zip.toBuffer())
}

/** A deterministic fake registry: each declared spec maps to an exact version + tarball. */
interface RegistryEntry {
  readonly version: string
  readonly bytes: Uint8Array
}
function fakeRegistry(
  entries: Map<string, RegistryEntry>,
  calls: { name: string; range: string }[] = [],
): { resolver: DependencyResolver; archive: ReturnType<typeof createZipArchiveSource> } {
  const resolve: DependencyResolver['resolve'] = async (name, range) => {
    calls.push({ name, range })
    const entry = entries.get(`${name}@${range}`)
    if (entry === undefined) {
      throw new ManagementError('DEPENDENCY_UNSATISFIED', 'install', `${name}@${range} is unknown to the fixture registry`, 'Use a registered fixture dependency.')
    }
    return {
      name,
      version: entry.version,
      tarball: { kind: 'registry', requested: `${name}@${range}` } satisfies InstallSource,
      integrity: sha512(entry.bytes),
    }
  }
  const archive = createZipArchiveSource(async (source) => {
    const entry = entries.get(source.requested)
    if (entry === undefined) throw new Error(`fixture archive has no bytes for ${source.requested}`)
    return entry.bytes
  })
  return { resolver: { resolve }, archive }
}

/** Build the extension fixture with declared dependencies and an entry that imports them. */
function buildExtension(deps: Record<string, string>, entry: string): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: '@acme/with-deps', version: '1.0.0', type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
    dependencies: deps,
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify({
    protocolVersion: '1.1.0', id: '@acme/with-deps', version: '1.0.0',
    displayName: 'With Deps', description: 'An extension with runtime dependencies.',
    activation: { policy: 'operator', deactivatable: true }, runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [], tools: [], implementations: [], skills: [],
  })))
  zip.addFile('index.js', Buffer.from(entry))
  return new Uint8Array(zip.toBuffer())
}

/** Install the extension fixture with the given deps and registry. */
async function installFixture(
  store: string,
  deps: Record<string, string>,
  entry: string,
  registry: Map<string, RegistryEntry>,
  calls: { name: string; range: string }[] = [],
) {
  const bytes = buildExtension(deps, entry)
  const { resolver, archive } = fakeRegistry(registry, calls)
  return await stagedInstall({
    source: { kind: 'local', requested: '@acme/with-deps@1.0.0' },
    storeDir: store,
    expectedSha512: sha512(bytes),
    archive: createZipArchiveSource(async () => bytes),
    dependencies: { resolver, archive },
  })
}

describe('EXT-09 — installer-owned dependency graphs', () => {  it('an exact-version dependency installs into the extension\'s own dir and imports AT RUNTIME', async () => {
    const store = scratch()
    const dep = makeDep('@fake/dep', '1.0.0')
    const calls: { name: string; range: string }[] = []
    const result = await installFixture(
      store, { '@fake/dep': '1.0.0' },
      `import { value } from '@fake/dep'\nexport { value }\n`,
      new Map([['@fake/dep@1.0.0', { version: '1.0.0', bytes: dep }]]), calls,
    )
    assert.equal(existsSync(join(result.installPath, 'node_modules', '@fake', 'dep')), true, 'the dep is materialized INSIDE the extension')
    // The entry resolves the dependency from the extension's own tree.
    const module = await import(pathToFileURL(join(result.installPath, 'index.js')).href) as { value: string }
    assert.equal(module.value, '@fake/dep@1.0.0')
    // The locked graph is recorded in the install record (EXT-12).
    const record = new ExtensionStore(store).listInstalled().value[0]
    assert.deepEqual(record?.dependencies, [{
      name: '@fake/dep', version: '1.0.0', integrity: sha512(dep), resolvedFrom: '1.0.0',
    }])
    assert.equal(calls.length, 1, 'an exact version is resolved exactly once')
  })

  it('a version range resolves ONCE and stays locked across restart', async () => {
    const store = scratch()
    const dep = makeDep('@fake/dep', '1.0.0')
    const calls: { name: string; range: string }[] = []
    await installFixture(
      store, { '@fake/dep': '^1.0.0' },
      `import { value } from '@fake/dep'\nexport { value }\n`,
      new Map([['@fake/dep@^1.0.0', { version: '1.0.0', bytes: dep }]]), calls,
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.range, '^1.0.0')
    // A fresh store instance re-reads the lock: no resolver runs again.
    const record = new ExtensionStore(store).listInstalled().value[0]
    assert.equal(record?.dependencies?.[0]?.version, '1.0.0')
    assert.equal(calls.length, 1, 'restart does not re-resolve: the lock is the authority')
  })

  it('a tarball that fails integrity refuses with INTEGRITY_MISMATCH and the previous install stays usable', async () => {
    const store = scratch()
    // First, a clean install of a dependency-free extension.
    const plain = buildExtension({}, 'export const ok = true\n')
    await stagedInstall({
      source: { kind: 'local', requested: '@acme/with-deps@1.0.0' },
      storeDir: store,
      expectedSha512: sha512(plain),
      archive: createZipArchiveSource(async () => plain),
    })
    const prior = new ExtensionStore(store).listInstalled().value[0]
    assert.ok(prior !== undefined)

    // Now an install whose dependency tarball does NOT match the recorded integrity.
    const dep = makeDep('@fake/dep', '1.0.0')
    const wrongBytes = makeDep('@fake/dep', '1.0.0', { exportsName: 'tampered' })
    const resolver: DependencyResolver = {
      async resolve() {
        return {
          name: '@fake/dep', version: '1.0.0',
          tarball: { kind: 'registry', requested: '@fake/dep@1.0.0' },
          integrity: sha512(dep), // the RECORDED integrity; the tarball bytes differ
        }
      },
    }
    const archive = createZipArchiveSource(async () => wrongBytes)
    const bytes = buildExtension({ '@fake/dep': '1.0.0' }, 'export const ok = true\n')
    try {
      await stagedInstall({
        source: { kind: 'local', requested: '@acme/with-deps@1.0.0' },
        storeDir: store, expectedSha512: sha512(bytes),
        archive: createZipArchiveSource(async () => bytes),
        dependencies: { resolver, archive },
      })
      assert.fail('the mismatched dependency tarball must refuse the install')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INTEGRITY_MISMATCH')
    }
    assert.equal(new ExtensionStore(store).verifyUnchanged(prior).unchanged, true, 'the previous install stays usable')
  })

  it('a dependency declaring a lifecycle script refuses DEPENDENCY_UNSATISFIED, never silently skipped', async () => {
    const store = scratch()
    const dep = makeDep('@fake/dep', '1.0.0', { scripts: { postinstall: 'echo pwned' } })
    try {
      await installFixture(
        store, { '@fake/dep': '1.0.0' }, 'export const ok = true\n',
        new Map([['@fake/dep@1.0.0', { version: '1.0.0', bytes: dep }]]),
      )
      assert.fail('an install-time script must refuse the install')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /postinstall/)
    }
    assert.equal(existsSync(join(store, 'extensions')), false, 'nothing was materialized')
  })

  it('a package declaring dependencies WITHOUT a provider refuses DEPENDENCY_UNSATISFIED', async () => {
    const store = scratch()
    const bytes = buildExtension({ '@fake/dep': '1.0.0' }, 'export const ok = true\n')
    try {
      await stagedInstall({
        source: { kind: 'local', requested: '@acme/with-deps@1.0.0' },
        storeDir: store, expectedSha512: sha512(bytes),
        archive: createZipArchiveSource(async () => bytes),
      })
      assert.fail('an unresolvable dependency graph must refuse the install')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
    }
  })

  it('the depth bound refuses a deep chain by name', async () => {
    const store = scratch()
    // A 6-deep chain: the 3-level depth bound must refuse with the named error.
    const registry = new Map<string, RegistryEntry>()
    for (let i = 0; i < 6; i += 1) {
      const deps = i < 5 ? { [`@fake/chain-${i + 1}`]: '1.0.0' } : {}
      registry.set(`@fake/chain-${i}@1.0.0`, { version: '1.0.0', bytes: makeDep(`@fake/chain-${i}`, '1.0.0', { deps }) })
    }
    try {
      await installFixture(
        store, { '@fake/chain-0': '1.0.0' }, 'export const ok = true\n',
        registry,
      )
      assert.fail('a deep graph must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /3-level depth bound/)
    }
  })

  it('the package-count bound refuses a wide graph by name', async () => {
    const store = scratch()
    // 65 direct dependencies: the 64-package bound must refuse.
    const registry = new Map<string, RegistryEntry>()
    for (let i = 0; i < 65; i += 1) {
      registry.set(`@fake/wide-${i}@1.0.0`, { version: '1.0.0', bytes: makeDep(`@fake/wide-${i}`, '1.0.0') })
    }
    const deps: Record<string, string> = {}
    for (let i = 0; i < 65; i += 1) deps[`@fake/wide-${i}`] = '1.0.0'
    try {
      await installFixture(store, deps, 'export const ok = true\n', registry)
      assert.fail('a wide graph must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /64-package bound/)
    }
  })

  it('conflicting versions of one dependency inside one graph refuse by name', async () => {
    const store = scratch()
    const registry = new Map<string, RegistryEntry>([
      ['@fake/dep@1.0.0', { version: '1.0.0', bytes: makeDep('@fake/dep', '1.0.0') }],
      ['@fake/dep@2.0.0', { version: '2.0.0', bytes: makeDep('@fake/dep', '2.0.0') }],
      ['@fake/left@1.0.0', { version: '1.0.0', bytes: makeDep('@fake/left', '1.0.0', { deps: { '@fake/dep': '1.0.0' } }) }],
      ['@fake/right@1.0.0', { version: '1.0.0', bytes: makeDep('@fake/right', '1.0.0', { deps: { '@fake/dep': '2.0.0' } }) }],
    ])
    try {
      await installFixture(
        store, { '@fake/left': '1.0.0', '@fake/right': '1.0.0' }, 'export const ok = true\n',
        registry,
      )
      assert.fail('a version conflict must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /conflicting versions/)
    }
  })

  it('an undeclared runtime import fails at load: the installer tree is the only resolution root', async () => {
    const store = scratch()
    const result = await installFixture(
      store, {}, `import { value } from '@fake/not-installed'\nexport { value }\n`,
      new Map(),
    )
    await assert.rejects(
      import(pathToFileURL(join(result.installPath, 'index.js')).href),
      /Cannot find package|not-installed|ERR_MODULE_NOT_FOUND/,
    )
  })
})
