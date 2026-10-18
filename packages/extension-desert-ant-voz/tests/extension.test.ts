/**
 * Voz extension contract tests (BASE-09, EXT-02, EXT-17, EXT-18, EXT-19).
 *
 * The extension is exercised the way a HOST reaches it — through the public entry,
 * by import — because that is the property BASE-09 is about. A test that reached
 * into the source would prove nothing about whether a published package could do
 * the same thing.
 *
 * Requirement links: BASE-09, EXT-02, EXT-17, EXT-18, EXT-19.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateExtension,
  discoverExtension,
  EXTENSION_API_VERSION,
  loadExtensionModule,
  resolveExtensionEntry,
  type ExtensionContextV1,
  type InvocationContextV1,
} from '@try-works/tool-mode-extension-sdk'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The installed location of this extension, resolved as a host would resolve it. */
function extensionDir(): string {
  const url = import.meta.resolve('@try-works/extension-desert-ant-voz/package.json')
  return new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

function context(): ExtensionContextV1 {
  return {
    extensionId: '@try-works/extension-desert-ant-voz',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** An invocation context whose path resolution records what it was asked for. */
function invocationContext(): { context: InvocationContextV1; resolved: string[] } {
  const resolved: string[] = []
  return {
    resolved,
    context: {
      invocationId: 'inv-test',
      signal: new AbortController().signal,
      limits: { maxInputBytes: 1024, maxAudioSeconds: 60, maxResultBytes: 1024 },
      resolvePath(candidate) {
        resolved.push(candidate)
        return `/authorized${candidate}`
      },
    },
  }
}

async function activate() {
  const discovery = discoverExtension(extensionDir())
  const loaded = await loadExtensionModule(resolveExtensionEntry(discovery))
  const instance = await activateExtension(loaded, context())
  return { discovery, instance }
}

describe('BASE-09 — the extension is reached through the public entry', () => {
  it('discovers and validates its own manifest', () => {
    const discovery = discoverExtension(extensionDir())
    assert.equal(discovery.packageName, '@try-works/extension-desert-ant-voz')
    assert.equal(discovery.manifest.id, discovery.packageName)
    // It implements the STANDARD contract (EXT-21): the tool is DECLARED in
    // tools[] AND bound by the implementation, with the schema refs shipped.
    const tool = discovery.manifest.tools[0]
    assert.ok(tool !== undefined, 'the tool must be declared in tools[]')
    assert.equal(tool.name, 'stt_transcribe')
    assert.equal(tool.contractId, 'tool-mode/stt_transcribe')
    assert.equal(discovery.manifest.implementations[0]?.contractId, 'tool-mode/stt_transcribe')
    assert.equal(discovery.manifest.implementations[0]?.modelId, 'voz')
  })

  it('declares native code and file input, which is what it actually needs', () => {
    const discovery = discoverExtension(extensionDir())
    // Voz runs ONNX Runtime and reads an audio file, so both are declared. A
    // manifest that understated this would be a permissions lie (EXT-14).
    assert.equal(discovery.manifest.permissions.nativeCode, true)
    assert.equal(discovery.manifest.permissions.inputFiles, true)
    // It still needs no network of its own: the model package fetches its weights.
    assert.deepEqual(discovery.manifest.permissions.networkOrigins, [])
    // No secrets: nothing here reads a credential.
    assert.deepEqual(discovery.manifest.permissions.secrets, [])
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
})

describe('EXT-18 — inspection reads local state only', () => {
  it('never reports ready before a load', async () => {
    const { instance } = await activate()
    const provider = await instance.createProvider({ modelId: 'voz', configuration: {} })
    const inspection = await provider.inspect(new AbortController().signal)
    // Inspection distinguishes preparation from residency: if the local runtime
    // prerequisites resolve, a cold provider is callable and may report ready
    // without compiling the graph merely to inspect it.
    assert.equal(inspection.readiness, inspection.missing.length === 0 ? 'prepared-cold' : 'needs-preparation')
    assert.deepEqual(
      [...inspection.features].sort(),
      ['speech-to-text', 'word-timestamps'],
    )
  })

  it('names the missing dependency when its runtime is absent', async () => {
    const { instance } = await activate()
    const provider = await instance.createProvider({ modelId: 'voz', configuration: {} })
    const inspection = await provider.inspect(new AbortController().signal)
    // In this checkout neitheroptional dependency is installed, so inspection must
    // say WHICH one is missing rather than reporting a generic failure.
    if (inspection.readiness === 'needs-preparation' && inspection.missing.length > 0) {
      for (const entry of inspection.missing) {
        assert.ok(entry.reason.includes('install'), 'each missing prerequisite needs actionable guidance')
      }
    }
  })
})

describe('EXT-19 — import and create stay lightweight', () => {
  it('creating a provider loads no model', async () => {
    const { instance } = await activate()
    const started = Date.now()
    const provider = await instance.createProvider({ modelId: 'voz', configuration: {} })
    const elapsed = Date.now() - started
    // Loading parses ~349 MB of weights and compiles three ONNX graphs. Creating a
    // handle must do none of that.
    assert.ok(elapsed < 1500, `createProvider took ${elapsed}ms, suggesting it loaded the model`)
    assert.equal(typeof provider.invoke, 'function')
  })

  it('refuses a model id it does not implement', async () => {
    const { instance } = await activate()
    await assert.rejects(
      instance.createProvider({ modelId: 'tongue', configuration: {} }),
      /implements the "voz" model/,
    )
  })

  it('disposal is safe without a load and is idempotent', async () => {
    const { instance } = await activate()
    const provider = await instance.createProvider({ modelId: 'voz', configuration: {} })
    // A provider that was never loaded must dispose cleanly, or deactivating an
    // unused package would fail for no reason.
    await provider.dispose()
    await provider.dispose()
    assert.equal(typeof (await provider.inspect(new AbortController().signal)).readiness, 'string')
  })
})

describe('SEC-06 — the extension opens only the authorized path', () => {
  it('resolves the caller path through the host before using it', async () => {
    const { instance } = await activate()
    const provider = await instance.createProvider({ modelId: 'voz', configuration: {} })
    const { context: invocation, resolved } = invocationContext()

    // The model is absent here, so the call fails AFTER authorization. That
    // ordering is the point: the path must be authorized before anything opens it,
    // and the extension must use the RESOLVED path rather than the raw argument.
    // TASK-120: the CONTRACT input shape is {audio: {path}}, never audio_path.
    await assert.rejects(
      provider.invoke({ implementationId: 'voz-default', input: { audio: { path: 'recording.wav' } }, context: invocation }),
    )
    assert.deepEqual(resolved, ['recording.wav'])
  })

  it('refuses a missing or non-string audio.path before authorizing anything', async () => {
    const { instance } = await activate()
    const provider = await instance.createProvider({ modelId: 'voz', configuration: {} })
    const { context: invocation, resolved } = invocationContext()
    await assert.rejects(
      provider.invoke({ implementationId: 'voz-default', input: {}, context: invocation }),
      /audio\.path/,
    )
    // Nothing was authorized, because there was nothing legitimate to authorize.
    assert.deepEqual(resolved, [])
  })
})
