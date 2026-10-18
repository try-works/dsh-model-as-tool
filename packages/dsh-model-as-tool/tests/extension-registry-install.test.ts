/**
 * Registry installs (task-104).
 *
 * The tests run a REAL local HTTP registry (node:http) and REAL `.tgz` bytes
 * produced in-test (gzip + hand-built tar, exactly what npm publishes), so the
 * SDK's tar-gzip ArchiveSource, the sha512 verification and the registry client
 * are all exercised end to end with no network access. The failure tests assert
 * BOTH the named refusal and that nothing was recorded/fetched beyond the
 * metadata request where the refusal must happen before the tarball.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ExtensionStore, createTarGzipArchiveSource, type ExtensionState as SdkExtensionState } from '@try-works/tool-mode-extension-sdk'

import {
  createRegistrySession,
  DEFAULT_REGISTRY_METADATA_TIMEOUT_MS,
  DEFAULT_REGISTRY_TARBALL_TIMEOUT_MS,
  highestSatisfyingVersion,
  RegistryError,
  satisfiesRegistryRange,
} from '../src/extension-dependencies.ts'
import {
  createExtensionsService,
  ExtensionsServiceError,
  packageDirFor,
  type ExtensionActivation,
} from '../src/extensions-service.ts'
import { cleanup, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const FIXTURE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'extensions-service-extension')
const EXTENSION_ID = '@try-works/fixture-ext-service'
const DEP_ID = '@fixture/tiny-dep'

/** Build a valid ustar entry name (npm tarballs root everything under `package/`). */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/** Build a gzipped npm-style tarball (`package/` root, regular files only). */
function tarGz(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const blocks: Buffer[] = []
  for (const [path, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    blocks.push(tarHeader(`package/${path}`, data.byteLength), data)
    const padding = (512 - (data.byteLength % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** Every regular file under a fixture directory, as tarball entries. */
function treeEntries(directory: string, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const key = prefix === '' ? name : `${prefix}/${name}`
    if (statSync(path).isDirectory()) {
      Object.assign(entries, treeEntries(path, key))
    } else {
      entries[key] = readFileSync(path, 'utf8')
    }
  }
  return entries
}

/** Distinct sha512 SRI string for bytes (what npm's dist.integrity carries). */
function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** One published version served by the fixture registry. */
interface ServedVersion {
  readonly bytes: Uint8Array
  /** Override the declared integrity (`null` omits it, for the missing-integrity test). */
  readonly integrity?: string | null
}

/** One package served by the fixture registry. */
interface ServedPackage {
  readonly versions: Readonly<Record<string, ServedVersion>>
  readonly distTags: Readonly<Record<string, string>>
}

/** The local registry server handle. */
interface FixtureRegistry {
  readonly url: string
  readonly requests: string[]
  close(): Promise<void>
}

/** Per-test transport behavior for the fixture registry (timeouts and caps). */
interface RegistryTransportOptions {
  /** Stream the tarball instead of writing it in one shot (slow/stalled transfers). */
  readonly streamTarball?: (served: ServedVersion, response: ServerResponse) => void | Promise<void>
  /** Delay the packument response (metadata-timeout tests). */
  readonly metadataDelayMs?: number
}

/** Promise-based sleep for streamed fixtures. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Start a local npm registry over the given packages; integrity is the bytes' own sha512 unless overridden. */
async function startRegistry(
  packages: Readonly<Record<string, ServedPackage>>,
  transport: RegistryTransportOptions = {},
): Promise<FixtureRegistry> {
  const requests: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    requests.push(path)
    if (path.startsWith('/tar/')) {
      // `/tar/<package name, slashes included>/<version>`
      const segments = path.split('/')
      const version = segments[segments.length - 1]
      const name = segments.slice(2, -1).join('/')
      const pkg = packages[name]
      const served = version === undefined ? undefined : pkg?.versions[version]
      if (served === undefined) {
        response.writeHead(404).end('missing tarball')
        return
      }
      if (transport.streamTarball !== undefined) {
        void transport.streamTarball(served, response)
        return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(served.bytes))
      return
    }
    const name = path.slice(1)
    const pkg = packages[name]
    if (pkg === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
      return
    }
    const versions: Record<string, unknown> = {}
    for (const [version, served] of Object.entries(pkg.versions)) {
      const declared = served.integrity === null ? undefined : (served.integrity ?? integrityOf(served.bytes))
      versions[version] = {
        version,
        dist: {
          tarball: `http://127.0.0.1:${port}/tar/${encodeURIComponent(name)}/${version}`,
          ...declared === undefined ? {} : { integrity: declared },
        },
      }
    }
    const write = (): void => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        name,
        'dist-tags': pkg.distTags,
        versions,
      }))
    }
    if (transport.metadataDelayMs === undefined) write()
    else setTimeout(write, transport.metadataDelayMs)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error))))
    },
  }
}

/** A URL nothing listens on (a deterministic transport failure). */
async function deadRegistryUrl(): Promise<string> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  await new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error))))
  return `http://127.0.0.1:${address.port}/`
}

/** A call-counting lifecycle double for the "activate after registry install" test. */
function fakeLifecycle(): ExtensionActivation & { readonly calls: number } {
  let calls = 0
  let state: SdkExtensionState | undefined
  return {
    get calls() { return calls },
    stateOf() { return state },
    async activate(extensionId: string) {
      calls += 1
      state = {
        extensionId,
        installation: 'installed',
        desiredActivation: 'active',
        observedActivation: 'active',
        readiness: {},
        tools: [],
        export: 'not-exported',
        ownerPid: process.pid,
      }
      return {} as never
    },
    async deactivate(extensionId: string) {
      state = state === undefined ? undefined : { ...state, extensionId, desiredActivation: 'inactive', observedActivation: 'inactive' }
      return {} as never
    },
  }
}

/** Assert a named refusal and return it. */
async function refuses(promise: Promise<unknown>, code: string): Promise<ExtensionsServiceError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ExtensionsServiceError, `expected ExtensionsServiceError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected a refusal with code ${code}`)
}

/** The fixture extension's own files, optionally with patched package.json. */
function extensionEntries(patch?: Record<string, unknown>): Record<string, string> {
  const entries = treeEntries(FIXTURE_DIR)
  if (patch !== undefined) {
    const pkg = JSON.parse(entries['package.json'] ?? '{}') as Record<string, unknown>
    entries['package.json'] = `${JSON.stringify({ ...pkg, ...patch }, null, 2)}\n`
  }
  return entries
}

describe('registry resolution rules (semver subset, documented honestly)', () => {
  it('selects the highest satisfying version for carets, tildes, x-ranges, hyphen and ||', () => {
    const published = ['1.0.0', '1.0.5', '1.2.0', '1.9.9', '2.0.0', '2.1.0']
    assert.equal(highestSatisfyingVersion(published, '^1.0.0'), '1.9.9')
    assert.equal(highestSatisfyingVersion(published, '~1.0.0'), '1.0.5')
    assert.equal(highestSatisfyingVersion(published, '1.x'), '1.9.9')
    assert.equal(highestSatisfyingVersion(published, '1.2'), '1.2.0')
    assert.equal(highestSatisfyingVersion(published, '1.2.0 - 2.0.0'), '2.0.0')
    assert.equal(highestSatisfyingVersion(published, '1.0.0 || 2.1.0'), '2.1.0')
    assert.equal(highestSatisfyingVersion(published, '>=2.0.0 <2.1.0'), '2.0.0')
  })

  it('never selects a prerelease unless the range names one (and refuses unsupported prerelease ranges)', () => {
    assert.equal(satisfiesRegistryRange('2.0.0-rc.1', '^2.0.0'), false)
    // Prerelease ranges are a DOCUMENTED limitation of this slice: they are refused
    // by returning no match rather than guessed.
    assert.equal(satisfiesRegistryRange('2.0.0-rc.1', '^2.0.0-rc.0'), false)
    assert.equal(highestSatisfyingVersion(['1.0.0'], '^2.0.0'), undefined)
  })

  it('refuses a special/non-semver spec rather than guessing', () => {
    assert.equal(highestSatisfyingVersion(['1.0.0'], 'workspace:*'), undefined)
    assert.equal(highestSatisfyingVersion(['1.0.0'], 'git+https://example.invalid/x.git'), undefined)
  })
})

describe('install from the npm registry', () => {
  it('resolves latest, verifies the sha512, records registry provenance and lands inactive', async () => {
    const bytes = tarGz(extensionEntries())
    const integrity = integrityOf(bytes)
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const storeDir = tempDir()
      const service = createExtensionsService({
        storeDir,
        installSource: 'registry',
        registryUrl: registry.url,
      })
      const installed = await service.install(EXTENSION_ID)
      assert.deepEqual(installed, {
        id: EXTENSION_ID,
        version: '1.0.0',
        active: false,
        source: 'registry',
        resolvedVersion: '1.0.0',
      })

      const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
      assert.ok(record !== undefined)
      assert.equal(record.version, '1.0.0')
      assert.equal(record.source.kind, 'registry')
      assert.equal(record.source.requested, `${EXTENSION_ID}@1.0.0`)
      assert.equal(record.archiveDigest, createHash('sha512').update(bytes).digest('hex'))
      assert.equal(record.provenance?.registryIntegrity, integrity)

      // The bytes were fetched exactly once from the registry.
      const tarballRequests = registry.requests.filter(path => path.startsWith('/tar/'))
      assert.equal(tarballRequests.length, 1)

      // Installation did not activate; enable does, through the mounted lifecycle.
      const lifecycle = fakeLifecycle()
      const enabled = await createExtensionsService({
        storeDir,
        installSource: 'registry',
        registryUrl: registry.url,
        lifecycle: () => lifecycle,
      }).enable(EXTENSION_ID)
      assert.equal(enabled.active, true)
      assert.equal(lifecycle.calls, 1)
    } finally {
      await registry.close()
    }
  })

  it('installs with NO source directory configured (no local package is needed)', async () => {
    const bytes = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const installed = await createExtensionsService({
        storeDir: tempDir(),
        installSource: 'registry',
        registryUrl: registry.url,
      }).install(EXTENSION_ID)
      assert.equal(installed.source, 'registry')
    } finally {
      await registry.close()
    }
  })

  it('refuses a version with no dist.integrity BEFORE fetching the tarball', async () => {
    const bytes = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes, integrity: null } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const storeDir = tempDir()
      const error = await refuses(
        createExtensionsService({ storeDir, installSource: 'registry', registryUrl: registry.url }).install(EXTENSION_ID),
        'extension-registry-integrity-missing',
      )
      assert.match(error.message, /sha512/)
      assert.deepEqual(registry.requests.filter(path => path.startsWith('/tar/')), [], 'never fetch unverifiable bytes')
      assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [])
    } finally {
      await registry.close()
    }
  })

  it('refuses a tarball whose sha512 does not match the registry metadata', async () => {
    const served = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: {
        versions: { '1.0.0': { bytes: served, integrity: integrityOf(tarGz({ 'package.json': '{"name":"other"}' })) } },
        distTags: { latest: '1.0.0' },
      },
    })
    try {
      const storeDir = tempDir()
      const error = await refuses(
        createExtensionsService({ storeDir, installSource: 'registry', registryUrl: registry.url }).install(EXTENSION_ID),
        'extension-registry-integrity-mismatch',
      )
      assert.match(error.message, /SHA-512/i)
      assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [], 'mismatched bytes are never recorded')
    } finally {
      await registry.close()
    }
  })

  it('refuses a package the registry does not know (404) with a named error', async () => {
    const registry = await startRegistry({})
    try {
      const error = await refuses(
        createExtensionsService({ storeDir: tempDir(), installSource: 'registry', registryUrl: registry.url }).install(EXTENSION_ID),
        'extension-registry-not-found',
      )
      assert.match(error.message, /404|not found/i)
    } finally {
      await registry.close()
    }
  })

  it('materializes a registry dependency inside the extension, selecting the highest satisfying version', async () => {
    const extensionBytes = tarGz(extensionEntries({ dependencies: { [DEP_ID]: '^1.0.0' } }))
    const dep100 = tarGz({
      'package.json': JSON.stringify({ name: DEP_ID, version: '1.0.0' }),
      'index.js': 'export const answer = 42\n',
    })
    const dep110 = tarGz({
      'package.json': JSON.stringify({ name: DEP_ID, version: '1.1.0' }),
      'index.js': 'export const answer = 43\n',
    })
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } },
      // latest points at 1.0.0, but ^1.0.0 must resolve the HIGHEST published match.
      [DEP_ID]: {
        versions: { '1.0.0': { bytes: dep100 }, '1.1.0': { bytes: dep110 } },
        distTags: { latest: '1.0.0' },
      },
    })
    try {
      const storeDir = tempDir()
      const installed = await createExtensionsService({
        storeDir,
        installSource: 'registry',
        registryUrl: registry.url,
      }).install(EXTENSION_ID)
      assert.equal(installed.source, 'registry')

      const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
      assert.ok(record !== undefined)
      const locked = record.dependencies?.[0]
      assert.equal(locked?.name, DEP_ID)
      assert.equal(locked?.version, '1.1.0')
      assert.equal(locked?.resolvedFrom, '^1.0.0')
      assert.match(locked?.integrity ?? '', /^[0-9a-f]{128}$/)
      const materialized = readFileSync(join(record.installPath, 'node_modules', '@fixture', 'tiny-dep', 'index.js'), 'utf8')
      assert.equal(materialized, 'export const answer = 43\n')
      // The dependency came from the registry, not from any host tree.
      assert.ok(registry.requests.some(path => path.startsWith('/tar/@fixture/tiny-dep/1.1.0')))
    } finally {
      await registry.close()
    }
  })
})

describe('large tarballs: a separate idle timeout, not the packument budget', () => {
  it('pins the defaults: metadata 30 s, tarball idle 10 min', () => {
    assert.equal(DEFAULT_REGISTRY_METADATA_TIMEOUT_MS, 30_000)
    assert.equal(DEFAULT_REGISTRY_TARBALL_TIMEOUT_MS, 10 * 60_000)
  })

  it('SUCCEEDS on a tarball streamed over several idle windows', async () => {
    const bytes = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes } }, distTags: { latest: '1.0.0' } },
    }, {
      streamTarball: async (served, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': served.bytes.byteLength })
        const chunkSize = Math.max(1, Math.ceil(served.bytes.byteLength / 8))
        for (let offset = 0; offset < served.bytes.byteLength; offset += chunkSize) {
          response.write(Buffer.from(served.bytes.subarray(offset, offset + chunkSize)))
          await delay(200)
        }
        response.end()
      },
    })
    try {
      const started = Date.now()
      const installed = await createExtensionsService({
        storeDir: tempDir(),
        installSource: 'registry',
        registryUrl: registry.url,
        // Idle window comfortably longer than the 200 ms between chunks; the OLD
        // shared 30s budget is irrelevant because this transfer takes seconds.
        registryTarballTimeoutMs: 1_000,
      }).install(EXTENSION_ID)
      assert.equal(installed.source, 'registry')
      assert.equal(installed.version, '1.0.0')
      assert.ok(Date.now() - started >= 1_000, 'the transfer really spanned multiple idle windows')
    } finally {
      await registry.close()
    }
  })

  it('aborts a STALLED stream with a message naming the dependency, host and timeout', async () => {
    const bytes = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes } }, distTags: { latest: '1.0.0' } },
    }, {
      streamTarball: async (served, response) => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.write(Buffer.from(served.bytes.subarray(0, 32)))
        // Stall: no more bytes, no end. The client's idle timeout must abort.
        await new Promise<void>(resolve => response.once('close', resolve))
      },
    })
    try {
      const started = Date.now()
      const stalledStore = tempDir()
      const error = await refuses(
        createExtensionsService({
          storeDir: stalledStore,
          installSource: 'registry',
          registryUrl: registry.url,
          registryTarballTimeoutMs: 250,
        }).install(EXTENSION_ID),
        'extension-registry-fetch-failed',
      )
      assert.match(error.message, /timed out/)
      assert.match(error.message, /no bytes arrived for 250 ms/)
      assert.match(error.message, new RegExp(EXTENSION_ID.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')))
      assert.match(error.message, /127\.0\.0\.1:\d+/)
      assert.ok(Date.now() - started < 10_000, 'the stalled transfer is aborted promptly, not at a 30s wall clock')
      assert.deepEqual([...new ExtensionStore(stalledStore).listInstalled().value], [])
    } finally {
      await registry.close()
    }
  })

  it('still refuses an over-cap tarball and names the cap and host (not a timeout)', async () => {
    const bytes = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const error = await refuses(
        createExtensionsService({
          storeDir: tempDir(),
          installSource: 'registry',
          registryUrl: registry.url,
          registryTarballMaxBytes: 100,
        }).install(EXTENSION_ID),
        'extension-registry-fetch-failed',
      )
      assert.match(error.message, /over the 100-byte cap/)
      assert.match(error.message, /127\.0\.0\.1:\d+/)
      assert.match(error.message, new RegExp(EXTENSION_ID.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')))
      assert.doesNotMatch(error.message, /no bytes arrived/)
    } finally {
      await registry.close()
    }
  })

  it('keeps the packument timeout SHORT and independent of the tarball budget', async () => {
    const bytes = tarGz(extensionEntries())
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes } }, distTags: { latest: '1.0.0' } },
    }, { metadataDelayMs: 1_500 })
    try {
      const session = createRegistrySession({
        registryUrl: registry.url,
        archiveFactory: createTarGzipArchiveSource,
        metadataTimeoutMs: 200,
        // A 10-minute tarball budget must NOT stretch the metadata request.
        tarballTimeoutMs: 600_000,
      })
      const started = Date.now()
      await assert.rejects(
        session.resolve(EXTENSION_ID, 'latest'),
        (error: unknown) => {
          assert.ok(error instanceof RegistryError)
          assert.equal(error.code, 'registry-unavailable')
          assert.match(error.message, /metadata timeout/)
          assert.match(error.message, /200 ms/)
          return true
        },
      )
      assert.ok(Date.now() - started < 5_000)
    } finally {
      await registry.close()
    }
  })
})

describe('optional tool runtimes: materialized when resolvable, a named blocker when not', () => {
  const RUNTIME_DEP = '@fixture/tiny-dep'

  it('materializes a resolvable optional runtime into the extension and stays integrity-clean', async () => {
    const depBytes = tarGz({
      'package.json': JSON.stringify({ name: RUNTIME_DEP, version: '1.0.0' }),
      'index.js': 'export const answer = 42\n',
    })
    const extensionBytes = tarGz(extensionEntries({ optionalDependencies: { [RUNTIME_DEP]: '^1.0.0' } }))
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } },
      [RUNTIME_DEP]: { versions: { '1.0.0': { bytes: depBytes } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const storeDir = tempDir()
      const service = createExtensionsService({ storeDir, installSource: 'registry', registryUrl: registry.url })
      const installed = await service.install(EXTENSION_ID)
      assert.equal(installed.source, 'registry')

      const store = new ExtensionStore(storeDir)
      const record = store.listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
      assert.ok(record !== undefined)
      assert.equal(existsSync(join(record.installPath, 'node_modules', '@fixture', 'tiny-dep', 'index.js')), true)
      assert.ok(record.dependencies?.some(entry => entry.name === RUNTIME_DEP && entry.version === '1.0.0'))
      // The installed bytes legitimately changed; the record digest must match them.
      assert.equal(store.verifyUnchanged(record).unchanged, true)

      const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
      assert.ok(row !== undefined)
      const runtime = row.requirements.find(candidate => candidate.kind === 'runtime')
      assert.ok(runtime !== undefined)
      assert.equal(runtime.satisfied, true)
      assert.match(runtime.reason, /tiny-dep@1\.0\.0/)
      assert.equal(row.integrity, 'unchanged')
      assert.equal(row.blocked, false)

      const lifecycle = fakeLifecycle()
      const enabled = await createExtensionsService({ storeDir, lifecycle: () => lifecycle }).enable(EXTENSION_ID)
      assert.equal(enabled.active, true)
      assert.equal(lifecycle.calls, 1)
    } finally {
      await registry.close()
    }
  })

  it('does NOT fail the install on an unsatisfiable optional range, and blocks activation', async () => {
    const depBytes = tarGz({ 'package.json': JSON.stringify({ name: RUNTIME_DEP, version: '1.0.0' }) })
    const extensionBytes = tarGz(extensionEntries({ optionalDependencies: { [RUNTIME_DEP]: '^9.0.0' } }))
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } },
      [RUNTIME_DEP]: { versions: { '1.0.0': { bytes: depBytes } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const storeDir = tempDir()
      const service = createExtensionsService({ storeDir, installSource: 'registry', registryUrl: registry.url })
      const installed = await service.install(EXTENSION_ID)
      assert.equal(installed.version, '1.0.0')

      const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
      assert.ok(row !== undefined)
      const runtime = row.requirements.find(candidate => candidate.kind === 'runtime')
      assert.ok(runtime !== undefined)
      assert.equal(runtime.satisfied, false)
      assert.equal(runtime.action, 'install')
      assert.match(runtime.reason, /tiny-dep \^9\.0\.0/)
      assert.match(runtime.reason, /no published version|no matching|satisf/i)
      assert.equal(row.blocked, true)

      // The failure is RECORDED in the store sidecar, not lost.
      const sidecar = JSON.parse(readFileSync(join(storeDir, 'runtime-dependencies.json'), 'utf8')) as {
        extensions: Record<string, { optional: { name: string; satisfied: boolean; error?: string }[] }>
      }
      const attempt = sidecar.extensions[EXTENSION_ID]?.optional.find(entry => entry.name === RUNTIME_DEP)
      assert.equal(attempt?.satisfied, false)
      assert.match(attempt?.error ?? '', /no published version|satisf/i)

      const lifecycle = fakeLifecycle()
      const error = await refuses(
        createExtensionsService({ storeDir, lifecycle: () => lifecycle }).enable(EXTENSION_ID),
        'extension-runtime-unavailable',
      )
      assert.equal(error.message, runtime.reason)
      assert.equal(lifecycle.calls, 0, 'no lifecycle call is attempted for a runtime that cannot load')
    } finally {
      await registry.close()
    }
  })

  it('does NOT fail the install when the optional runtime package is missing (404)', async () => {
    const extensionBytes = tarGz(extensionEntries({ optionalDependencies: { '@fixture/ghost': '^1.0.0' } }))
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } },
    })
    try {
      const storeDir = tempDir()
      const service = createExtensionsService({ storeDir, installSource: 'registry', registryUrl: registry.url })
      const installed = await service.install(EXTENSION_ID)
      assert.equal(installed.version, '1.0.0')
      const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
      assert.ok(row !== undefined)
      const runtime = row.requirements.find(candidate => candidate.kind === 'runtime')
      assert.ok(runtime !== undefined)
      assert.equal(runtime.satisfied, false)
      assert.match(runtime.reason, /@fixture\/ghost \^1\.0\.0/)
      assert.match(runtime.reason, /not found|404/i)
      assert.equal(row.blocked, true)
      await refuses(
        createExtensionsService({ storeDir, lifecycle: () => fakeLifecycle() }).enable(EXTENSION_ID),
        'extension-runtime-unavailable',
      )
    } finally {
      await registry.close()
    }
  })
})

describe('dependency graphs: depth bound and preinstalled regular dependencies (task-116)', () => {
  /** Build one link of a dependency chain served by the fixture registry. */
  function chainEntry(name: string, next: string | undefined): ServedPackage {
    const pkg = {
      name,
      version: '1.0.0',
      ...next === undefined ? {} : { dependencies: { [next]: '^1.0.0' } },
    }
    return {
      versions: { '1.0.0': { bytes: tarGz({ 'package.json': JSON.stringify(pkg), 'index.js': `module.exports = ${JSON.stringify(name)}\n` }) } },
      distTags: { latest: '1.0.0' },
    }
  }

  function chainPackages(length: number): Record<string, ServedPackage> {
    const packages: Record<string, ServedPackage> = {}
    for (let index = 0; index < length; index += 1) {
      packages[`@fixture/chain-${index}`] = chainEntry(
        `@fixture/chain-${index}`,
        index + 1 < length ? `@fixture/chain-${index + 1}` : undefined,
      )
    }
    return packages
  }

  it('resolves a >=6-level registry tree with the raised default depth (12)', async () => {
    const packages = chainPackages(7)
    const extensionBytes = tarGz(extensionEntries({ dependencies: { '@fixture/chain-0': '^1.0.0' } }))
    packages[EXTENSION_ID] = { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } }
    const registry = await startRegistry(packages)
    try {
      const storeDir = tempDir()
      const installed = await createExtensionsService({
        storeDir,
        installSource: 'registry',
        registryUrl: registry.url,
      }).install(EXTENSION_ID)
      assert.equal(installed.version, '1.0.0')
      const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
      assert.ok(record !== undefined)
      const names = new Set((record.dependencies ?? []).map(entry => entry.name))
      for (let index = 0; index < 7; index += 1) assert.equal(names.has(`@fixture/chain-${index}`), true, `chain-${index} missing`)
    } finally {
      await registry.close()
    }
  })

  it('still refuses a runaway graph, names the depth bound, and installs nothing', async () => {
    const packages = chainPackages(7)
    const extensionBytes = tarGz(extensionEntries({ dependencies: { '@fixture/chain-0': '^1.0.0' } }))
    packages[EXTENSION_ID] = { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } }
    const registry = await startRegistry(packages)
    try {
      const storeDir = tempDir()
      const error = await refuses(
        createExtensionsService({
          storeDir,
          installSource: 'registry',
          registryUrl: registry.url,
          // Deliberately too shallow for a 7-package chain.
          registryDependencyDepth: 2,
        }).install(EXTENSION_ID),
        'extension-dependency-unsatisfied',
      )
      assert.match(error.message, /depth bound/)
      assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [])
    } finally {
      await registry.close()
    }
  })

  it('resolves a transitive leaf from the PREINSTALLED PACKAGE\'S OWN node_modules (npm nesting)', async () => {
    // Mirrors the live failure: @huggingface/transformers hoists onnxruntime-web
    // into ITS OWN node_modules; root-level lookup alone fell through to the
    // registry and refused the script-declaring leaf under EXT-10.
    const extensionBytes = tarGz(extensionEntries({ dependencies: { '@fixture/wrapper': '^1.0.0' } }))
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } },
    })
    const preinstalledRoot = tempDir()
    const wrapperDir = join(preinstalledRoot, 'node_modules', '@fixture', 'wrapper')
    const leafDir = join(wrapperDir, 'node_modules', '@fixture', 'scripted-leaf')
    mkdirSync(leafDir, { recursive: true })
    writeFileSync(join(wrapperDir, 'package.json'), `${JSON.stringify({
      name: '@fixture/wrapper',
      version: '1.0.0',
      dependencies: { '@fixture/scripted-leaf': '^1.0.0' },
    })}\n`)
    writeFileSync(join(wrapperDir, 'index.js'), 'module.exports = require("@fixture/scripted-leaf")\n')
    writeFileSync(join(leafDir, 'package.json'), `${JSON.stringify({
      name: '@fixture/scripted-leaf',
      version: '1.0.0',
      scripts: { prepare: 'node -e "process.exit(0)"' },
    })}\n`)
    writeFileSync(join(leafDir, 'index.js'), 'module.exports = 7\n')
    try {
      const storeDir = tempDir()
      const service = createExtensionsService({
        storeDir,
        installSource: 'registry',
        registryUrl: registry.url,
        allowPreinstalledDependencies: true,
        preinstalledDependenciesRoot: preinstalledRoot,
      })
      await service.install(EXTENSION_ID)
      const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
      assert.ok(record !== undefined)
      const byName = new Map((record.dependencies ?? []).map(entry => [entry.name, entry]))
      assert.equal(byName.get('@fixture/wrapper')?.provenance, 'preinstalled')
      assert.equal(byName.get('@fixture/scripted-leaf')?.provenance, 'preinstalled')
      assert.equal(existsSync(join(record.installPath, 'node_modules', '@fixture', 'scripted-leaf', 'index.js')), true)
    } finally {
      await registry.close()
    }
  })

  it('materializes a SCRIPT-DECLARING regular dependency from the operator-preinstalled root', async () => {
    // The registry does not serve this dependency at all; only the operator's
    // own installed tree has it, and its install scripts already ran as them.
    const extensionBytes = tarGz(extensionEntries({ dependencies: { '@fixture/scripted-dep': '^1.0.0' } }))
    const registry = await startRegistry({
      [EXTENSION_ID]: { versions: { '1.0.0': { bytes: extensionBytes } }, distTags: { latest: '1.0.0' } },
    })
    const preinstalledRoot = tempDir()
    const preinstalledDir = join(preinstalledRoot, 'node_modules', '@fixture', 'scripted-dep')
    mkdirSync(preinstalledDir, { recursive: true })
    writeFileSync(join(preinstalledDir, 'package.json'), `${JSON.stringify({
      name: '@fixture/scripted-dep',
      version: '1.0.0',
      scripts: { prepare: 'node -e "process.exit(0)"' },
    })}\n`)
    writeFileSync(join(preinstalledDir, 'index.js'), 'module.exports = 42\n')
    try {
      const storeDir = tempDir()
      const service = createExtensionsService({
        storeDir,
        installSource: 'registry',
        registryUrl: registry.url,
        allowPreinstalledDependencies: true,
        preinstalledDependenciesRoot: preinstalledRoot,
      })
      const installed = await service.install(EXTENSION_ID)
      assert.equal(installed.version, '1.0.0')
      const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
      assert.ok(record !== undefined)
      const locked = record.dependencies?.find(entry => entry.name === '@fixture/scripted-dep')
      assert.ok(locked !== undefined)
      assert.equal(locked.version, '1.0.0')
      assert.equal(locked.provenance, 'preinstalled')
      assert.equal(existsSync(join(record.installPath, 'node_modules', '@fixture', 'scripted-dep', 'index.js')), true)
      // The regular-dependency requirement is satisfied: the tools can `require` it.
      const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
      assert.ok(row !== undefined)
      const dependencies = row.requirements.find(candidate => candidate.kind === 'dependencies')
      assert.equal(dependencies?.satisfied, true)
    } finally {
      await registry.close()
    }
  })
})

describe('source selection: auto fallback, directory mode, and named refusals', () => {
  it('auto falls back to the directory ONLY for a transport failure when directory installs are allowed', async () => {
    const sourceDir = tempDir()
    const { cpSync } = await import('node:fs')
    cpSync(FIXTURE_DIR, join(sourceDir, packageDirFor(EXTENSION_ID)), { recursive: true })
    const service = createExtensionsService({
      storeDir: tempDir(),
      sourceDir,
      allowSourceDirectories: true,
      registryUrl: await deadRegistryUrl(),
    })
    const installed = await service.install(EXTENSION_ID)
    assert.deepEqual(installed, {
      id: EXTENSION_ID,
      version: '1.0.0',
      active: false,
      source: 'directory',
      resolvedVersion: '1.0.0',
    })
  })

  it('auto does NOT fall back for a 404 even when the directory would exist', async () => {
    const sourceDir = tempDir()
    const { cpSync } = await import('node:fs')
    cpSync(FIXTURE_DIR, join(sourceDir, packageDirFor(EXTENSION_ID)), { recursive: true })
    const registry = await startRegistry({})
    try {
      const storeDir = tempDir()
      const error = await refuses(
        createExtensionsService({ storeDir, sourceDir, allowSourceDirectories: true, registryUrl: registry.url }).install(EXTENSION_ID),
        'extension-registry-not-found',
      )
      assert.match(error.message, /404|not found/i)
      assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [], 'a package refusal is never retried locally')
    } finally {
      await registry.close()
    }
  })

  it('describes the registry as the source route for a not-yet-installed row', async () => {
    const sourceDir = tempDir()
    cpSync(FIXTURE_DIR, join(sourceDir, packageDirFor(EXTENSION_ID)), { recursive: true })
    const service = createExtensionsService({
      storeDir: tempDir(),
      sourceDir,
      allowSourceDirectories: true,
      installSource: 'registry',
      registryUrl: 'https://registry.example.test/',
    })
    const row = (await service.describe()).extensions.find(candidate => candidate.id === EXTENSION_ID)
    assert.ok(row !== undefined)
    const source = row.requirements.find(candidate => candidate.kind === 'source')
    assert.ok(source !== undefined)
    assert.equal(source.satisfied, true)
    assert.equal(source.action, 'install')
    assert.match(source.reason, /registry\.example\.test/)
    assert.equal(row.blocked, false)
  })

  it('auto falls back to the directory when no registry is configured and directory installs are allowed', async () => {
    const sourceDir = tempDir()
    cpSync(FIXTURE_DIR, join(sourceDir, packageDirFor(EXTENSION_ID)), { recursive: true })
    const installed = await createExtensionsService({
      storeDir: tempDir(),
      sourceDir,
      allowSourceDirectories: true,
      registryUrl: '',
    }).install(EXTENSION_ID)
    assert.equal(installed.source, 'directory')
  })

  it('directory mode still installs from the configured source directory and says so', async () => {
    const sourceDir = tempDir()
    const { cpSync } = await import('node:fs')
    cpSync(FIXTURE_DIR, join(sourceDir, packageDirFor(EXTENSION_ID)), { recursive: true })
    const installed = await createExtensionsService({
      storeDir: tempDir(),
      sourceDir,
      allowSourceDirectories: true,
      installSource: 'directory',
    }).install(EXTENSION_ID)
    assert.equal(installed.source, 'directory')
    assert.equal(installed.resolvedVersion, installed.version)
  })

  it('registry mode refuses with a named error when the registry is unreachable and directory is not allowed', async () => {
    const error = await refuses(
      createExtensionsService({
        storeDir: tempDir(),
        installSource: 'registry',
        registryUrl: await deadRegistryUrl(),
      }).install(EXTENSION_ID),
      'extension-registry-unavailable',
    )
    assert.match(error.message, /could not be reached/)
  })

  it('registry mode refuses when no registry is configured', async () => {
    const error = await refuses(
      createExtensionsService({ storeDir: tempDir(), installSource: 'registry', registryUrl: '' }).install(EXTENSION_ID),
      'extension-registry-unconfigured',
    )
    assert.match(error.message, /config\.extensionRegistry/)
  })
})
