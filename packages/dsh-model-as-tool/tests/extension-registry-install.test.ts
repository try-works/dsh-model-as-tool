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
import { cpSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ExtensionStore, type ExtensionState as SdkExtensionState } from '@try-works/tool-mode-extension-sdk'

import {
  highestSatisfyingVersion,
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

/** Start a local npm registry over the given packages; integrity is the bytes' own sha512 unless overridden. */
async function startRegistry(packages: Readonly<Record<string, ServedPackage>>): Promise<FixtureRegistry> {
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
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name,
      'dist-tags': pkg.distTags,
      versions,
    }))
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
