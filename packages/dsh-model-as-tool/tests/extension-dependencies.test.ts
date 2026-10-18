/**
 * First-party dependency graphs for extension installs (task-83).
 *
 * The tests run against the REAL SDK dependency graph and the REAL staged
 * installer. The only fabricated part is the HOST TREE: a temp directory laid out
 * like an npm install (`<root>/node_modules/<dep>`), because the point of this
 * module is that it resolves what is already installed — a fixture that existed
 * only in the test would prove nothing about the host-tree walk.
 *
 * The two arms are covered separately:
 * - registry bytes: the archive the host builds is the exact artifact the SDK
 *   verifies (sha512) and extracts, with the lock recorded in the install record;
 * - preinstalled content (task-84): operator-gated, copied by the SDK, recorded
 *   with provenance — including the real onnxruntime-node case that declared
 *   lifecycle scripts keep the EXT-10 refusal when the gate is OFF.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { ExtensionStore, ManagementError } from '@try-works/tool-mode-extension-sdk'

import { createExtensionsService, ExtensionsServiceError, packageDirFor } from '../src/extensions-service.ts'
import { createFirstPartyDependencyGraph, resolveFirstPartyDependency } from '../src/extension-dependencies.ts'
import { cleanup, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const FIXTURE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'tests', 'fixtures', 'extensions-service-extension')
const EXTENSION_ID = '@try-works/fixture-ext-service'
const LAYA_DIR = join(process.cwd(), 'packages', 'extension-laya')

/** A fake host tree: `<root>/node_modules/<dep>` plus a patched extension checkout. */
interface HostTree {
  readonly root: string
  readonly sourceDir: string
  readonly extensionDir: string
  readonly dependencyDir: string
}

/**
 * Build a host tree whose extension checkout declares `@fixture/dep`.
 * @param options - dependency name/version, whether the dependency declares a
 *   lifecycle script, and whether a broken symlink should be planted inside it.
 */
function hostTree(options: { name?: string; version?: string; postinstall?: boolean; link?: boolean } = {}): HostTree {
  const root = tempDir()
  const name = options.name ?? '@fixture/dep'
  const version = options.version ?? '1.0.0'
  const segments = name.split('/')
  const dependencyDir = join(root, 'node_modules', ...segments)
  mkdirSync(dependencyDir, { recursive: true })
  writeFileSync(join(dependencyDir, 'package.json'), `${JSON.stringify({
    name,
    version,
    ...options.postinstall === true ? { scripts: { postinstall: 'node ./install.js' } } : {},
  }, null, 2)}\n`)
  writeFileSync(join(dependencyDir, 'index.js'), 'export const answer = 42\n')

  const sourceDir = join(root, 'source-root')
  const extensionDir = join(sourceDir, packageDirFor(EXTENSION_ID))
  cpSync(FIXTURE_DIR, extensionDir, { recursive: true })
  const packageJsonPath = join(extensionDir, 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
  pkg['dependencies'] = { [name]: '^1.0.0' }
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)

  if (options.link === true) {
    mkdirSync(join(dependencyDir, 'extra'), { recursive: true })
    writeFileSync(join(dependencyDir, 'extra', 'inside.txt'), 'linked content\n')
    symlinkSync(join(dependencyDir, 'extra'), join(dependencyDir, 'linked'), 'junction')
  }
  return { root, sourceDir, extensionDir, dependencyDir }
}

/** Assert a promise rejects with a ManagementError carrying one code and message pattern. */
async function rejectsManagement(promise: Promise<unknown>, pattern: RegExp): Promise<ManagementError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ManagementError, `expected ManagementError, got ${String(error)}`)
    assert.equal(error.code, 'DEPENDENCY_UNSATISFIED')
    assert.match(error.message, pattern)
    return error
  }
  assert.fail(`expected a DEPENDENCY_UNSATISFIED refusal matching ${pattern}`)
}

/** Assert a promise rejects with the service's dependency refusal code. */
async function rejectsService(promise: Promise<unknown>, pattern: RegExp): Promise<ExtensionsServiceError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ExtensionsServiceError, `expected ExtensionsServiceError, got ${String(error)}`)
    assert.equal(error.code, 'extension-dependency-unsatisfied')
    assert.match(error.message, pattern)
    return error
  }
  assert.fail(`expected an extension-dependency-unsatisfied refusal matching ${pattern}`)
}

/** All file names under a directory, relative and sorted. */
function filesUnder(root: string, current = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(root, absolute))
    else out.push(absolute.slice(root.length + 1).split('\\').join('/'))
  }
  return out.sort()
}

describe('the installed-tree resolver is truthful about what exists', () => {
  it('resolves a declared dependency to the exact installed version and directory', () => {
    const tree = hostTree()
    const found = resolveFirstPartyDependency({ sourcePackageDir: tree.extensionDir }, '@fixture/dep', '^1.0.0')
    assert.equal(found.name, '@fixture/dep')
    assert.equal(found.version, '1.0.0')
    assert.equal(found.directory, tree.dependencyDir)
  })

  it('refuses a declared dependency that is not installed, naming the dependency and spec', async () => {
    const tree = hostTree()
    const error = await rejectsManagement(
      createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir }).resolver.resolve('@fixture/missing', '^2.0.0'),
      /@fixture\/missing/,
    )
    assert.match(error.message, /\^2\.0\.0/)
  })

  it('refuses a dependency name that is not a package identity', async () => {
    const tree = hostTree()
    await rejectsManagement(
      createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir }).resolver.resolve('../escape', '1.0.0'),
      /not a package name/,
    )
  })
})

describe('the registry-bytes arm serves exactly the archive it declares', () => {
  it('builds a zip whose SHA-512 is the integrity and which excludes nested node_modules', async () => {
    const tree = hostTree()
    mkdirSync(join(tree.dependencyDir, 'node_modules', '@fixture', 'inner'), { recursive: true })
    writeFileSync(join(tree.dependencyDir, 'node_modules', '@fixture', 'inner', 'package.json'), '{"name":"@fixture/inner","version":"1.0.0"}')
    const graph = createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir })
    const content = await graph.resolver.resolve('@fixture/dep', '^1.0.0')
    assert.ok('tarball' in content, 'the ungated arm must be verified bytes')
    assert.equal(content.name, '@fixture/dep')
    assert.equal(content.version, '1.0.0')
    assert.match(content.integrity, /^[0-9a-f]{128}$/)
    const bytes = await graph.archive.fetch(content.tarball, { maxBytes: 256 * 1024 * 1024, timeoutMs: 10_000 })
    assert.equal(createHash('sha512').update(bytes).digest('hex'), content.integrity, 'the served bytes must hash to the declared integrity')
    const entries = new AdmZip(Buffer.from(bytes)).getEntries().map(entry => entry.entryName).sort()
    assert.deepEqual(entries, ['index.js', 'package.json'], 'the dependency tree must ship without nested node_modules')
  })

  it('refuses a script-declaring dependency before building any archive (EXT-10)', async () => {
    const tree = hostTree({ postinstall: true })
    await rejectsManagement(
      createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir }).resolver.resolve('@fixture/dep', '^1.0.0'),
      /postinstall.*EXT-10/,
    )
  })

  it('refuses an unresolved link inside the installed dependency', async () => {
    const tree = hostTree({ link: true })
    await rejectsManagement(
      createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir }).resolver.resolve('@fixture/dep', '^1.0.0'),
      /symbolic link/,
    )
  })

  it('refuses an archive over the configured byte bound', async () => {
    const tree = hostTree()
    await rejectsManagement(
      createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir, maxArchiveBytes: 8 })
        .resolver.resolve('@fixture/dep', '^1.0.0'),
      /over the 8-byte dependency bound/,
    )
  })
})

describe('the preinstalled arm is operator-gated and states its provenance', () => {
  it('returns the resolved directory for the preinstalled arm only with the gate on', async () => {
    const tree = hostTree({ postinstall: true })
    const gated = createFirstPartyDependencyGraph({
      sourcePackageDir: tree.extensionDir,
      allowPreinstalled: true,
      preinstalledRoot: tree.root,
    })
    const content = await gated.resolver.resolve('@fixture/dep', '^1.0.0')
    assert.equal(content.provenance, 'preinstalled')
    assert.ok('dir' in content)
    assert.equal(content.dir, tree.dependencyDir)
    // EXT-10 does NOT pre-refuse on the gated arm: provenance records that the
    // content arrived from a completed install and no script was run.
    assert.equal(gated.graph.allowPreinstalled, true)
    assert.equal(gated.graph.preinstalledRoot, tree.root)
  })

  it('refuses the gate without an operator-configured root', () => {
    const tree = hostTree()
    assert.throws(
      () => createFirstPartyDependencyGraph({ sourcePackageDir: tree.extensionDir, allowPreinstalled: true }),
      (error: unknown) => error instanceof ManagementError && /preinstalled root/.test(error.message),
    )
  })

  it('refuses a preinstalled directory outside the configured root', async () => {
    const tree = hostTree()
    const elsewhere = tempDir()
    const gated = createFirstPartyDependencyGraph({
      sourcePackageDir: tree.extensionDir,
      allowPreinstalled: true,
      preinstalledRoot: elsewhere,
    })
    await rejectsManagement(gated.resolver.resolve('@fixture/dep', '^1.0.0'), /outside the operator-configured preinstalled root/)
  })
})

describe('ExtensionsService.install materializes dependencies inside the extension', () => {
  it('installs a fixture extension whose dependency resolves, recording the lock', async () => {
    const tree = hostTree()
    const storeDir = tempDir()
    const hostNodeModulesBefore = filesUnder(join(tree.root, 'node_modules'))
    const service = createExtensionsService({
      storeDir,
      sourceDir: tree.sourceDir,
      allowSourceDirectories: true,
      installSource: 'directory',
    })
    const installed = await service.install(EXTENSION_ID)
    assert.deepEqual(installed, {
      id: EXTENSION_ID,
      version: '1.0.0',
      active: false,
      source: 'directory',
      resolvedVersion: '1.0.0',
    })

    const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
    assert.ok(record !== undefined)
    assert.equal(record.dependencies?.length, 1)
    const locked = record.dependencies?.[0]
    assert.equal(locked?.name, '@fixture/dep')
    assert.equal(locked?.version, '1.0.0')
    assert.equal(locked?.resolvedFrom, '^1.0.0')
    assert.match(locked?.integrity ?? '', /^[0-9a-f]{128}$/, 'the lock records the sha512 of the served archive')
    assert.equal(locked?.provenance, undefined, 'the ungated arm records no provenance')

    // The dependency landed INSIDE this extension's own installation…
    const installedDependency = join(record.installPath, 'node_modules', '@fixture', 'dep')
    assert.equal(readFileSync(join(installedDependency, 'index.js'), 'utf8'), 'export const answer = 42\n')
    // …and the host tree it was copied from is untouched.
    assert.deepEqual(filesUnder(join(tree.root, 'node_modules')), hostNodeModulesBefore)
    assert.deepEqual([...new Set(readdirSync(join(tree.root, 'node_modules')).filter(name => name.startsWith('.dep-')))], [])
  })

  it('refuses with a named error when a declared dependency is missing, and installs nothing', async () => {
    const tree = hostTree()
    const storeDir = tempDir()
    const service = createExtensionsService({ storeDir, sourceDir: tree.sourceDir, allowSourceDirectories: true, installSource: 'directory' })
    // Point the extension at a dependency that is not in the host tree.
    const packageJsonPath = join(tree.extensionDir, 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
    pkg['dependencies'] = { '@fixture/missing': '^2.0.0' }
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)

    await rejectsService(service.install(EXTENSION_ID), /@fixture\/missing/)
    assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [], 'a refused dependency must leave no install record')
  })

  it('refuses a script-declaring dependency with the EXT-10 reason and installs nothing', async () => {
    const tree = hostTree({ postinstall: true })
    const storeDir = tempDir()
    const packageJsonPath = join(tree.extensionDir, 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
    pkg['dependencies'] = { '@fixture/dep': '^1.0.0' }
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
    const service = createExtensionsService({ storeDir, sourceDir: tree.sourceDir, allowSourceDirectories: true, installSource: 'directory' })
    await rejectsService(service.install(EXTENSION_ID), /postinstall.*EXT-10/)
    assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [])
  })

  it('copies a preinstalled dependency with provenance when the operator gate is on', async () => {
    const tree = hostTree({ postinstall: true })
    const storeDir = tempDir()
    const packageJsonPath = join(tree.extensionDir, 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
    pkg['dependencies'] = { '@fixture/dep': '^1.0.0' }
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
    const service = createExtensionsService({
      storeDir,
      sourceDir: tree.sourceDir,
      allowSourceDirectories: true,
      allowPreinstalledDependencies: true,
      preinstalledDependenciesRoot: tree.root,
      installSource: 'directory',
    })
    const installed = await service.install(EXTENSION_ID)
    assert.deepEqual(installed, {
      id: EXTENSION_ID,
      version: '1.0.0',
      active: false,
      source: 'directory',
      resolvedVersion: '1.0.0',
    })

    const record = new ExtensionStore(storeDir).listInstalled().value.find(candidate => candidate.extensionId === EXTENSION_ID)
    const locked = record?.dependencies?.[0]
    assert.equal(locked?.name, '@fixture/dep')
    assert.equal(locked?.provenance, 'preinstalled')
    assert.equal(locked?.preinstalledFrom, tree.dependencyDir)
    assert.match(locked?.integrity ?? '', /^[0-9a-f]{64}$/, 'the preinstalled lock is the sha256 content digest the SDK computed')
    // The content was COPIED (never linked) and its package.json scripts are untouched.
    const copied = join(record?.installPath ?? '', 'node_modules', '@fixture', 'dep')
    assert.equal(readFileSync(join(copied, 'package.json'), 'utf8').includes('"postinstall"'), true)
    assert.equal(existsSync(join(copied, 'index.js')), true)
  })
})

describe('the real extension-laya dependency is resolved and refused by policy, not by a missing graph', () => {
  it('resolves onnxruntime-node from the host tree', () => {
    const found = resolveFirstPartyDependency({ sourcePackageDir: LAYA_DIR }, 'onnxruntime-node', '^1.20.0')
    assert.equal(found.name, 'onnxruntime-node')
    assert.match(found.version, /^\d+\.\d+\.\d+$/)
    assert.equal(existsSync(join(found.directory, 'package.json')), true)
    const installedVersion = (JSON.parse(readFileSync(join(found.directory, 'package.json'), 'utf8')) as { version: string }).version
    assert.equal(found.version, installedVersion)
  })

  it('refuses the real Laya install with the precise EXT-10 lifecycle-script reason', async () => {
    const storeDir = tempDir()
    const service = createExtensionsService({ storeDir, allowSourceDirectories: true })
    // The dependency declares prepare/postinstall in the installed tree; the
    // resolver refuses BEFORE building the 100+ MB archive, so this stays fast.
    const error = await rejectsService(service.install('@try-works/extension-laya', LAYA_DIR), /onnxruntime-node@\d+\.\d+\.\d+/)
    assert.match(error.message, /prepare|postinstall/)
    assert.match(error.message, /EXT-10/)
    assert.deepEqual([...new ExtensionStore(storeDir).listInstalled().value], [], 'the refused install must leave no record')
  })
})
