/**
 * Extension store tests (EXT-33, EXT-25, AT-18).
 *
 * The two properties worth testing hardest are the ones whose failure is silent:
 * a corrupted state file must NOT be read as "everything is active", and a
 * package edited on disk after installation must NOT be activatable. Both pass
 * trivially when things go well, so they are exercised by corrupting real files
 * and editing a real installed package.
 *
 * Requirement links: EXT-33, EXT-25, EXT-08, AT-18.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import {
  createZipArchiveSource,
  digestInstalledContent,
  ExtensionStore,
  installedInactive,
  LOCK_FILE,
  ManagementError,
  stagedInstall,
  type ExtensionState,
  type InstallSource,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'tmx-store-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Build a valid extension zip. */
function buildZip(name = '@acme/tool-mode-topics', version = '1.2.3'): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name,
    version,
    type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify({
    protocolVersion: '1.1.0',
    id: name,
    version,
    displayName: 'Acme Topic Tools',
    description: 'Local topic classification using a packaged model recipe.',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false },
    models: [], tools: [], implementations: [], skills: [],
  })))
  zip.addFile('index.js', Buffer.from('export const ok = true'))
  zip.addFile('schemas/input.json', Buffer.from('{"type":"object"}'))
  return new Uint8Array(zip.toBuffer())
}

const digestOf = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')
const SOURCE: InstallSource = { kind: 'registry', requested: '@acme/tool-mode-topics@1.2.3' }

/** Install a package into a store and return the store plus the result. */
async function installInto(storeDir: string, name = '@acme/tool-mode-topics', version = '1.2.3') {
  const bytes = buildZip(name, version)
  const result = await stagedInstall({
    source: { ...SOURCE, requested: `${name}@${version}` },
    storeDir,
    expectedSha512: digestOf(bytes),
    archive: createZipArchiveSource(async () => bytes),
  })
  return { result, bytes }
}

describe('EXT-33 — the store records installations durably', () => {
  it('an install is visible in the lock and survives a restart', async () => {
    const store = scratch()
    const { result } = await installInto(store)
    // A NEW store object, as a later process would build: nothing is cached.
    const reopened = new ExtensionStore(store)
    const installed = reopened.listInstalled()
    assert.equal(installed.corrupt, false)
    assert.equal(installed.value.length, 1)
    assert.equal(installed.value[0]?.extensionId, '@acme/tool-mode-topics')
    assert.equal(installed.value[0]?.installPath, result.installPath)
    assert.equal(installed.value[0]?.archiveDigest, result.archiveDigest)
  })

  it('records the complete resolved source identity', async () => {
    const store = scratch()
    await installInto(store)
    const record = new ExtensionStore(store).listInstalled().value[0]
    assert.equal(record?.source.kind, 'registry')
    assert.equal(record?.source.requested, '@acme/tool-mode-topics@1.2.3')
    assert.match(String(record?.installedAt), /^\d{4}-\d{2}-\d{2}T/)
  })

  it('records two versions side by side rather than overwriting', async () => {
    const store = scratch()
    await installInto(store, '@acme/tool-mode-topics', '1.2.3')
    await installInto(store, '@acme/tool-mode-topics', '1.2.4')
    const versions = new ExtensionStore(store).listInstalled().value.map(record => record.version).sort()
    assert.deepEqual(versions, ['1.2.3', '1.2.4'])
  })

  it('refuses to record the same identity and version twice', async () => {
    const store = scratch()
    await installInto(store)
    await assert.rejects(installInto(store), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'UPGRADE_FAILED')
      return true
    })
  })

  it('treats an absent store as empty, not as corrupt', () => {
    const store = new ExtensionStore(scratch())
    const installed = store.listInstalled()
    assert.equal(installed.corrupt, false)
    assert.deepEqual([...installed.value], [])
  })

  it('refuses a profile name that would address another profile', () => {
    const store = new ExtensionStore(scratch())
    for (const bad of ['../other', 'a/b', '', 'has space', 'x'.repeat(65)]) {
      assert.throws(() => store.profileStatePath(bad), ManagementError, `${JSON.stringify(bad)} must be refused`)
    }
    assert.match(store.profileStatePath('default'), /profiles/)
  })
})

describe('EXT-33 — corrupted state fails CLOSED', () => {
  it('a corrupt lock yields no records and a diagnostic, not a crash or a guess', async () => {
    const store = scratch()
    await installInto(store)
    writeFileSync(join(store, LOCK_FILE), '{ this is not json')
    const read = new ExtensionStore(store).listInstalled()
    assert.equal(read.corrupt, true)
    assert.deepEqual([...read.value], [])
    assert.match(String(read.diagnostic), /not valid JSON/)
  })

  it('a structurally wrong lock yields no records', () => {
    const store = scratch()
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, LOCK_FILE), JSON.stringify({ lockVersion: 1, extensions: 'nope' }))
    const read = new ExtensionStore(store).listInstalled()
    assert.equal(read.corrupt, true)
    assert.deepEqual([...read.value], [])
  })

  it('refuses to append to a lock it could not read, rather than discarding it', async () => {
    const store = scratch()
    await installInto(store)
    writeFileSync(join(store, LOCK_FILE), 'garbage')
    assert.throws(() => {
      new ExtensionStore(store).recordInstall({
        extensionId: '@acme/other', version: '1.0.0', installPath: store,
        archiveDigest: 'x', contentDigest: 'y', source: { kind: 'registry', requested: 'z' },
        installedAt: new Date().toISOString(),
      })
    }, (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'EXTENSION_FAULT')
      assert.match(error.recovery, /do not append/i)
      return true
    })
  })

  it('a corrupt profile state yields NO active extensions', () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    // A file claiming everything is active, then corrupted.
    extensions.writeProfileState('default', [{
      ...installedInactive('@acme/tool-mode-topics'),
      desiredActivation: 'active',
      observedActivation: 'active',
    }])
    writeFileSync(extensions.profileStatePath('default'), '[1,2,3')

    const read = extensions.readProfileState('default')
    // The failure EXT-33 names is falling back to "everything installed is
    // active". An empty set with a diagnostic is the only safe answer.
    assert.equal(read.corrupt, true)
    assert.deepEqual([...read.value], [])
    assert.match(String(read.diagnostic), /not valid JSON/)
  })

  it('a profile state with one malformed entry invalidates the whole file', () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    mkdirSync(join(store, 'profiles', 'default'), { recursive: true })
    writeFileSync(extensions.profileStatePath('default'), JSON.stringify({
      stateVersion: 1,
      profile: 'default',
      extensions: [
        { ...installedInactive('@acme/ok'), desiredActivation: 'active', observedActivation: 'active' },
        { extensionId: 'broken' },
      ],
    }))
    const read = extensions.readProfileState('default')
    assert.equal(read.corrupt, true)
    // Dropping just the bad entry would activate the other one from a file that
    // is demonstrably not trustworthy.
    assert.deepEqual([...read.value], [])
  })

  it('an oversized state file is refused rather than parsed', () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    mkdirSync(join(store, 'profiles', 'default'), { recursive: true })
    writeFileSync(extensions.profileStatePath('default'), `{"padding":"${'x'.repeat(5 * 1024 * 1024)}"}`)
    const read = extensions.readProfileState('default')
    assert.equal(read.corrupt, true)
    assert.match(String(read.diagnostic), /over the .* limit/)
  })
})

describe('EXT-33 — installed content is checked before activation', () => {
  it('reports an unmodified installation as unchanged', async () => {
    const store = scratch()
    await installInto(store)
    const extensions = new ExtensionStore(store)
    const record = extensions.listInstalled().value[0]!
    const check = extensions.verifyUnchanged(record)
    assert.equal(check.unchanged, true)
    assert.equal(check.contentDigest, record.contentDigest)
  })

  it('detects a file EDITED after installation', async () => {
    const store = scratch()
    const { result } = await installInto(store)
    const extensions = new ExtensionStore(store)
    const record = extensions.listInstalled().value[0]!
    // The attack this defends against: install a reviewed package, then replace
    // its code before it is ever activated.
    appendFileSync(join(result.installPath, 'index.js'), '\nexport const backdoor = true')
    const check = extensions.verifyUnchanged(record)
    assert.equal(check.unchanged, false)
    assert.match(String(check.diagnostic), /changed on disk/)
  })

  it('detects an ADDED file', async () => {
    const store = scratch()
    const { result } = await installInto(store)
    const extensions = new ExtensionStore(store)
    const record = extensions.listInstalled().value[0]!
    writeFileSync(join(result.installPath, 'extra.js'), 'export const extra = 1')
    assert.equal(extensions.verifyUnchanged(record).unchanged, false)
  })

  it('detects a REMOVED file', async () => {
    const store = scratch()
    const { result } = await installInto(store)
    const extensions = new ExtensionStore(store)
    const record = extensions.listInstalled().value[0]!
    rmSync(join(result.installPath, 'schemas', 'input.json'))
    assert.equal(extensions.verifyUnchanged(record).unchanged, false)
  })

  it('detects a missing installation directory', async () => {
    const store = scratch()
    const { result } = await installInto(store)
    const extensions = new ExtensionStore(store)
    const record = extensions.listInstalled().value[0]!
    rmSync(result.installPath, { recursive: true, force: true })
    const check = extensions.verifyUnchanged(record)
    assert.equal(check.unchanged, false)
    assert.match(String(check.diagnostic), /missing/)
  })

  it('the digest ignores the install receipt, which is store metadata', async () => {
    const store = scratch()
    const { result } = await installInto(store)
    const before = digestInstalledContent(result.installPath)
    // Rewriting the receipt must not look like a package change, or every
    // installation would fail its own integrity check.
    writeFileSync(join(result.installPath, '.tool-mode-install.json'), '{"rewritten":true}')
    assert.equal(digestInstalledContent(result.installPath), before)
  })
})

describe('EXT-25 — profile state round-trips', () => {
  it('persists and reloads the orthogonal dimensions separately', () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    const state: ExtensionState = {
      ...installedInactive('@acme/tool-mode-topics'),
      desiredActivation: 'active',
      observedActivation: 'active',
      readiness: { 'topic-model-cpu': 'preparing' },
      tools: [{ toolName: 'acme_topic_classify', enabled: true, selectedImplementation: 'topic-cpu' }],
      export: 'denied',
    }
    extensions.writeProfileState('default', [state])

    const reloaded = new ExtensionStore(store).readProfileState('default')
    assert.equal(reloaded.corrupt, false)
    const [restored] = reloaded.value
    // Each dimension survives independently; a single boolean could not carry this.
    assert.equal(restored?.desiredActivation, 'active')
    assert.equal(restored?.readiness['topic-model-cpu'], 'preparing')
    assert.equal(restored?.tools[0]?.selectedImplementation, 'topic-cpu')
    assert.equal(restored?.export, 'denied')
  })

  it('an unwritten profile reads as empty and not corrupt', () => {
    const read = new ExtensionStore(scratch()).readProfileState('default')
    assert.equal(read.corrupt, false)
    assert.deepEqual([...read.value], [])
  })

  it('keeps profiles independent', () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    extensions.writeProfileState('default', [installedInactive('@acme/a')])
    extensions.writeProfileState('strict', [installedInactive('@acme/b')])
    assert.equal(extensions.readProfileState('default').value[0]?.extensionId, '@acme/a')
    assert.equal(extensions.readProfileState('strict').value[0]?.extensionId, '@acme/b')
  })
})

describe('EXT-33 — the lock is machine-readable', () => {
  it('writes a documented lock document', async () => {
    const store = scratch()
    await installInto(store)
    const document = JSON.parse(readFileSync(join(store, LOCK_FILE), 'utf8'))
    assert.equal(document.lockVersion, 1)
    assert.ok(Array.isArray(document.extensions))
    // Complete resolved source/identity records, per EXT-33.
    const [record] = document.extensions
    for (const field of ['extensionId', 'version', 'installPath', 'archiveDigest', 'contentDigest', 'source', 'installedAt']) {
      assert.ok(record[field] !== undefined, `${field} must be recorded`)
    }
  })

  it('leaves no temporary file behind after a write', async () => {
    const store = scratch()
    await installInto(store)
    const files = readFileSync(join(store, LOCK_FILE), 'utf8')
    assert.ok(files.length > 0)
    // The atomic-write temporary must not survive.
    assert.throws(() => readFileSync(join(store, `${LOCK_FILE}.tmp`), 'utf8'))
  })
})
