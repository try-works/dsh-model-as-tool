/**
 * Extension contract tests (BASE-09, EXT-02, EXT-17, EXT-19).
 *
 * These exercise the extension the way a HOST does — through its public entry, by
 * import — rather than by reaching into its source. That is the property BASE-09
 * is about: if the host and this test use the same public route, a third-party
 * package has no less access than a first-party one.
 *
 * Requirement links: BASE-09, EXT-02, EXT-17, EXT-19.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateExtension,
  assertNoReservedMeta,
  defineExtension,
  EXTENSION_API_VERSION,
  resolveExtensionEntry,
  discoverExtension,
  loadExtensionModule,
  ManagementError,
  type ExtensionContextV1,
} from '@try-works/tool-mode-extension-sdk'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The installed location of this extension, resolved as a host would resolve it. */
function extensionDir(): string {
  const url = import.meta.resolve('@try-works/extension-desert-ant-tongue/package.json')
  return new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

/** A host-issued context, with nothing but what EXT-18 allows. */
function context(): ExtensionContextV1 {
  return {
    extensionId: '@try-works/extension-desert-ant-tongue',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

describe('BASE-09 — the extension is reached through the public entry', () => {
  it('discovers and validates its own manifest', () => {
    const discovery = discoverExtension(extensionDir())
    assert.equal(discovery.packageName, '@try-works/extension-desert-ant-tongue')
    assert.equal(discovery.manifest.id, discovery.packageName)
    // It implements a STANDARD contract (EXT-21): the tool is DECLARED in
    // tools[] AND bound by the implementation, with the schema refs shipped.
    const tool = discovery.manifest.tools[0]
    assert.ok(tool !== undefined, 'the tool must be declared in tools[]')
    assert.equal(tool.name, 'lang_detect')
    assert.equal(tool.contractId, 'tool-mode/lang_detect')
    assert.equal(discovery.manifest.implementations[0]?.contractId, 'tool-mode/lang_detect')
    assert.equal(existsSync(join(extensionDir(), 'schemas', 'lang-detect.input.json')), true)
    assert.equal(existsSync(join(extensionDir(), 'schemas', 'lang-detect.output.json')), true)
  })

  it('resolves its entry from its own exports map, not a host convention', () => {
    const discovery = discoverExtension(extensionDir())
    assert.equal(resolveExtensionEntry(discovery), discovery.entryPath)
    assert.ok(discovery.entryPath?.endsWith('index.js'))
  })

  it('loads and activates through the public API', async () => {
    const discovery = discoverExtension(extensionDir())
    const loaded = await loadExtensionModule(resolveExtensionEntry(discovery))
    assert.equal(loaded.apiVersion, EXTENSION_API_VERSION)
    const instance = await activateExtension(loaded, context())
    assert.equal(typeof instance.createProvider, 'function')
    assert.equal(typeof instance.dispose, 'function')
    await instance.dispose('deactivate')
  })

  it('declares no assets, because its weights ship inside the npm package', () => {
    const discovery = discoverExtension(extensionDir())
    // An empty asset list is an ASSERTION that preparation fetches nothing, not an
    // omission. Tongue bundles its 2 MB model, so there is no download to approve.
    assert.equal(discovery.manifest.models[0]?.assetSet, 'tongue-bundled')
    assert.deepEqual(discovery.manifest.permissions.networkOrigins, [])
    assert.equal(discovery.manifest.permissions.nativeCode, false)
  })
})

describe('EXT-19 — import and create stay lightweight', () => {
  it('creating a provider loads no model', async () => {
    const discovery = discoverExtension(extensionDir())
    const loaded = await loadExtensionModule(resolveExtensionEntry(discovery))
    const instance = await activateExtension(loaded, context())

    const started = Date.now()
    const provider = await instance.createProvider({ modelId: 'tongue', configuration: {} })
    const elapsed = Date.now() - started
    // A model load parses a 2 MB weight file; a handle creation must not.
    assert.ok(elapsed < 1500, `createProvider took ${elapsed}ms, suggesting it loaded the model`)

    const inspection = await provider.inspect(new AbortController().signal)
    assert.equal(inspection.readiness, inspection.missing.length === 0 ? 'prepared-cold' : 'needs-preparation')
    assert.ok(inspection.features.includes('language-detection'))
    await instance.dispose('deactivate')
  })

  it('inspection never reports ready before a load', async () => {
    const discovery = discoverExtension(extensionDir())
    const loaded = await loadExtensionModule(resolveExtensionEntry(discovery))
    const instance = await activateExtension(loaded, context())
    const provider = await instance.createProvider({ modelId: 'tongue', configuration: {} })
    // EXT-18: inspection reads approved local state only. It may report a cold
    // deployment as ready only after proving all local prerequisites resolve; it
    // must not load the model merely to answer readiness.
    const inspection = await provider.inspect(new AbortController().signal)
    assert.equal(inspection.readiness, inspection.missing.length === 0 ? 'prepared-cold' : 'needs-preparation')
  })

  it('refuses a model id it does not implement', async () => {
    const discovery = discoverExtension(extensionDir())
    const loaded = await loadExtensionModule(resolveExtensionEntry(discovery))
    const instance = await activateExtension(loaded, context())
    await assert.rejects(
      instance.createProvider({ modelId: 'some-other-model', configuration: {} }),
      /implements the "tongue" model/,
    )
  })
})

describe('EXT-17 — the reserved meta field', () => {
  it('rejects an extension that supplies host-authored metadata', () => {
    // The host stamps provenance; an extension asserting its own would be forging
    // who ran it and under what receipt.
    assert.throws(() => assertNoReservedMeta({ text: 'hi', meta: { extension: 'forged' } }, 'impl-1'), /reserved root/)
    assert.doesNotThrow(() => assertNoReservedMeta({ text: 'hi' }, 'impl-1'))
  })
})

describe('EXT-17 — declaration checking', () => {
  it('accepts a well-formed extension', () => {
    const declared = defineExtension({ apiVersion: 1, async create() { throw new Error('unused') } })
    assert.equal(declared.apiVersion, 1)
  })

  it('rejects a wrong apiVersion at the declaration site', () => {
    // Caught where the author is, rather than in an operator's log after publish.
    assert.throws(
      () => defineExtension({ apiVersion: 2, async create() { throw new Error('unused') } } as never),
      /apiVersion 2 is not supported/,
    )
  })

  it('rejects an extension with no create()', () => {
    assert.throws(() => defineExtension({ apiVersion: 1 } as never), /must implement create/)
  })
})

describe('EXT-17 — loader rejects malformed packages', () => {
  it('refuses a package with no importable entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmx-noentry-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@acme/no-entry', version: '1.0.0', type: 'module',
      exports: { '.': './index.js' },
      toolMode: { manifest: './tool-mode.extension.json' },
    }))
    writeFileSync(join(dir, 'tool-mode.extension.json'), JSON.stringify({
      protocolVersion: '1.1.0', id: '@acme/no-entry', version: '1.0.0',
      displayName: 'No entry', description: 'A declarative package with no module entry.',
      activation: { policy: 'operator' }, runtimeApi: 1,
      compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
      execution: { kind: 'declarative' },
      permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
      models: [], tools: [], implementations: [], skills: [],
    }))
    // A declarative package legitimately has no ./tool-mode module entry, so the
    // host must be able to tell "no module entry" from "malformed package".
    const discovery = discoverExtension(dir)
    assert.equal(discovery.entryPath, undefined)
    assert.throws(() => resolveExtensionEntry(discovery), (error: unknown) => {
      assert.ok(error instanceof ManagementError)
      assert.match(error.message, /no importable/)
      return true
    })
  })
})
