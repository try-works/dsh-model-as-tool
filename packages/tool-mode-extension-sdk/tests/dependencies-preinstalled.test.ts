/**
 * EXT-10 / task-84 — preinstalled-content provenance for dependency graphs.
 *
 * The operator-gated PREINSTALLED arm: a resolver may supply a materialized
 * directory instead of registry bytes, and ONLY when the graph's
 * `allowPreinstalled` gate is set does the installer copy it (never link the
 * host tree), boundary-check it against `preinstalledRoot`, bound the copy,
 * digest the COPIED bytes, and record provenance. The scripts field is left
 * untouched and NO lifecycle script runs — `provenance: 'preinstalled'` IS the
 * "scripts were not run by the installer" statement (EXT-10's never-silently-
 * skip rule is honored by provenance, not by editing bytes).
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'

import {
  createZipArchiveSource,
  digestInstalledContent,
  ExtensionStore,
  ManagementError,
  stagedInstall,
  type DependencyResolver,
  type InstallDependencyGraph,
  type InstallSource,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-preinstalled-'))
  dirs.push(dir)
  return dir
}

const sha512 = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex')

/** A fake registry dependency tarball (the registry arm). */
function makeDep(name: string, version: string, options: { scripts?: Record<string, string> } = {}): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name, version, type: 'module',
    exports: { '.': './index.js' },
    ...options.scripts === undefined ? {} : { scripts: options.scripts },
  })))
  zip.addFile('index.js', Buffer.from(`export const value = ${JSON.stringify(`${name}@${version}`)}\n`))
  return new Uint8Array(zip.toBuffer())
}

/** The extension fixture declaring one dependency. */
function buildExtension(deps: Record<string, string>): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name: '@acme/preinstalled-fixture', version: '1.0.0', type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
    dependencies: deps,
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify({
    protocolVersion: '1.1.0', id: '@acme/preinstalled-fixture', version: '1.0.0',
    displayName: 'Preinstalled Fixture', description: 'A fixture extension with one dependency.',
    activation: { policy: 'operator', deactivatable: true }, runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [], tools: [], implementations: [], skills: [],
  })))
  zip.addFile('index.js', Buffer.from('export const ok = true\n'))
  return new Uint8Array(zip.toBuffer())
}

/** The stagedInstall top-level archive serving the extension bytes. */
function extArchive(bytes: Uint8Array) {
  return createZipArchiveSource(async () => bytes)
}

/** An unused zip archive source for the dependency graph (the preinstalled arm never fetches it). */
function emptyArchive() {
  return createZipArchiveSource(async () => {
    throw new Error('the fixture registry archive must not be fetched on the preinstalled arm')
  })
}

/** A registry resolver from one tarball. */
function registryResolver(name: string, range: string, bytes: Uint8Array): DependencyResolver {
  return {
    resolve: async (requestedName, requestedRange) => {
      assert.equal(requestedName, name)
      assert.equal(requestedRange, range)
      return {
        name, version: '1.0.0',
        tarball: { kind: 'registry', requested: `${name}@${range}` } satisfies InstallSource,
        integrity: sha512(bytes),
      }
    },
  }
}

/** The dependency-graph archive serving one registry dep's bytes. */
function depArchive(bytes: Uint8Array) {
  return createZipArchiveSource(async () => bytes)
}

/** A registry-arm graph: the resolver plus an archive that serves the dep bytes. */
function registryGraph(name: string, range: string, bytes: Uint8Array): InstallDependencyGraph {
  return { resolver: registryResolver(name, range, bytes), archive: depArchive(bytes) }
}

/** A preinstalled resolver returning one operator-approved directory. */
function preinstalledResolver(name: string, dir: string): DependencyResolver {
  return {
    resolve: async (requestedName, requestedRange) => {
      assert.equal(requestedName, name)
      return { name, version: '1.0.0', dir, provenance: 'preinstalled' as const }
    },
  }
}

/** The base graph for the preinstalled arm. */
function preinstalledGraph(resolver: DependencyResolver, overrides: Partial<InstallDependencyGraph> = {}): InstallDependencyGraph {
  return { resolver, archive: emptyArchive(), ...overrides }
}

/** Materialize a preinstalled fixture directory with a script-declaring package.json. */
function makePreinstalledDir(root: string, options: { name?: string; version?: string; files?: number; nested?: boolean } = {}): string {
  const dir = join(root, 'installed', 'onnxruntime-node')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: options.name ?? 'onnxruntime-node',
    version: options.version ?? '1.0.0',
    type: 'module',
    scripts: { postinstall: 'echo already-ran-under-the-operators-npm' },
  })}\n`)
  const count = options.files ?? 2
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `payload-${i}.bin`), Buffer.alloc(64, i))
  }
  if (options.nested === true) {
    mkdirSync(join(dir, 'dist', 'nested', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'nested', 'deep', 'file.js'), Buffer.from('export const nested = true\n'))
    // An EMPTY subdirectory too: the walk's directory branch mkdirs every
    // directory (empty or not), so it is recreated rather than dropped.
    mkdirSync(join(dir, 'dist', 'empty'), { recursive: true })
  }
  return dir
}

/** The snapshot of a directory tree's bytes, for the untouched-tree assertion. */
function treeSnapshot(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) snapshot[absolute] = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    }
  }
  walk(dir)
  return snapshot
}

describe('task-84 — preinstalled-content provenance', () => {
  it('EXT-10 regression: a script-declaring REGISTRY dependency still refuses by name', async () => {
    const store = scratch()
    const depBytes = makeDep('onnxruntime-node', '1.0.0', { scripts: { postinstall: 'echo pwned' } })
    const graph = registryGraph('onnxruntime-node', '^1.0.0', depBytes)
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('a script-declaring registry dependency must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /postinstall/)
      assert.match(error.message, /never runs or silently skips install-time scripts/)
    }
  })

  it('the gate is OFF by default: a preinstalled-armed result refuses by name', async () => {
    const store = scratch()
    const dir = makePreinstalledDir(scratch())
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir))
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('preinstalled content without the operator gate must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /allowPreinstalled/)
    }
  })

  it('with the gate the copy succeeds INSIDE the extension dir with provenance recorded and scripts untouched', async () => {
    const store = scratch()
    const hostRoot = scratch()
    const dir = makePreinstalledDir(hostRoot)
    const before = treeSnapshot(dir)
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir), {
      allowPreinstalled: true,
      preinstalledRoot: hostRoot,
    })
    const result = await stagedInstall({
      archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) },
      storeDir: store,
      dependencies: graph,
      record: true,
    })
    // The copy lands INSIDE the extension's own install dir, never a link.
    const copiedDir = join(result.installPath, 'node_modules', 'onnxruntime-node')
    assert.equal(existsSync(copiedDir), true)
    assert.equal(existsSync(join(copiedDir, 'payload-0.bin')), true)
    // The scripts field is untouched: the copied package.json still declares it.
    const copiedPkg = JSON.parse(readFileSync(join(copiedDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    assert.equal(copiedPkg.scripts?.postinstall, 'echo already-ran-under-the-operators-npm')
    // The host tree is untouched (bytes before/after).
    assert.deepEqual(treeSnapshot(dir), before)
    // The record carries the provenance, the source, and a digest of the COPIED bytes.
    const installed = new ExtensionStore(store).listInstalled().value[0]
    assert.ok(installed !== undefined)
    assert.equal(installed.dependencies?.[0]?.provenance, 'preinstalled')
    assert.equal(installed.dependencies?.[0]?.preinstalledFrom, dir)
    assert.equal(installed.dependencies?.[0]?.integrity, digestInstalledContent(copiedDir))
  })

  it('a REGISTRY-armed lock carries NO provenance field (existing locks stay valid)', async () => {
    const store = scratch()
    const depBytes = makeDep('plain-dep', '1.0.0')
    const graph = registryGraph('plain-dep', '^1.0.0', depBytes)
    await stagedInstall({
      archive: extArchive(buildExtension({ 'plain-dep': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'plain-dep': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'plain-dep': '^1.0.0' }) },
      storeDir: store,
      dependencies: graph,
      record: true,
    })
    const installed = new ExtensionStore(store).listInstalled().value[0]
    assert.equal(installed?.dependencies?.[0]?.provenance, undefined)
  })

  it('a directory outside the configured root refuses (path escape)', async () => {
    const store = scratch()
    const hostRoot = scratch()
    const outside = makePreinstalledDir(scratch())
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', outside), {
      allowPreinstalled: true,
      preinstalledRoot: hostRoot,
    })
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('a preinstalled dir outside the root must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /outside the operator-configured root/)
    }
  })

  it('the gate requires a configured root', async () => {
    const store = scratch()
    const dir = makePreinstalledDir(scratch())
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir), { allowPreinstalled: true })
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('the gate without a root must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /preinstalledRoot/)
    }
  })

  it('the copy bounds refuse by name', async () => {
    const store = scratch()
    const hostRoot = scratch()
    const dir = makePreinstalledDir(hostRoot, { files: 4 })
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir), {
      allowPreinstalled: true,
      preinstalledRoot: hostRoot,
      maxPreinstalledFiles: 2,
    })
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('an over-bounded copy must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /exceeds the copy bounds/)
    }
  })

  it('a name/version mismatch between the content and the resolver refuses', async () => {
    const store = scratch()
    const hostRoot = scratch()
    const dir = makePreinstalledDir(hostRoot, { name: 'some-other-package' })
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir), {
      allowPreinstalled: true,
      preinstalledRoot: hostRoot,
    })
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('a mismatched preinstalled package must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
      assert.match(error.message, /not the resolved onnxruntime-node@1\.0\.0/)
    }
  })

  it('a junction inside the preinstalled dir refuses', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows junctions are the reparse-point vector')
      return
    }
    const store = scratch()
    const hostRoot = scratch()
    const dir = makePreinstalledDir(hostRoot)
    const outside = join(hostRoot, 'elsewhere')
    mkdirSync(outside)
    const made = spawnSync('cmd', ['/c', 'mklink', '/J', join(dir, 'linked'), outside], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir), {
      allowPreinstalled: true,
      preinstalledRoot: hostRoot,
    })
    try {
      await stagedInstall({ archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) }, storeDir: store, dependencies: graph })
      assert.fail('a reparse point inside preinstalled content must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /reparse point/)
    }
  })

  it('the recorded preinstalledFrom is the resolved dir and the digest matches the copied bytes', async () => {
    const store = scratch()
    const hostRoot = scratch()
    const dir = makePreinstalledDir(hostRoot)
    const graph = preinstalledGraph(preinstalledResolver('onnxruntime-node', dir), {
      allowPreinstalled: true,
      preinstalledRoot: hostRoot,
    })
    const result = await stagedInstall({
      archive: extArchive(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      expectedSha512: sha512(buildExtension({ 'onnxruntime-node': '^1.0.0' })),
      source: { kind: 'bytes', bytes: buildExtension({ 'onnxruntime-node': '^1.0.0' }) },
      storeDir: store,
      dependencies: graph,
      record: true,
    })
    const installed = new ExtensionStore(store).listInstalled().value[0]
    const dep = installed?.dependencies?.[0]
    assert.equal(dep?.preinstalledFrom, dir)
    assert.equal(dep?.integrity, digestInstalledContent(join(result.installPath, 'node_modules', 'onnxruntime-node')))
  })
})
