/**
 * The extension-level inspection route (EXT-18, RUN-05, MODEL-05).
 *
 * `ProviderBridge.inspect` requires a CATALOG entry, so an extension that ships a
 * manifest but has no catalog row (EmbeddingGemma, Needle) could never have its
 * readiness recorded — its tools stayed withheld forever even when the extension's own
 * inspection could answer honestly.
 *
 * `inspectExtension` closes that: it activates the extension through its public entry
 * and inspects the provider the MANIFEST declares. This proves the route against the
 * REAL EmbeddingGemma package, whose inspection honestly reports `prepared-cold` when its
 * runtime packages resolve (its text path is wired) or `needs-preparation` naming the
 * missing packages when they do not — either way the readiness is never a fabrication —
 * and proves activation caching with a create()-call counter rather than a Map-key tautology.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ProviderBridge } from '../src/provider-bridge.ts'
import { createGrant } from '../src/authority.ts'

const scratch: string[] = []
after(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A minimal counting extension that reports `ready` and counts its activations. */
function writeCountingExtension(): { dir: string; path: string } {
  const dir = join(tmpdir(), `inspect-ext-${process.pid}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(dir, { recursive: true })
  scratch.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@fixture/counting-inspect', version: '1.0.0', type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
  }))
  writeFileSync(join(dir, 'tool-mode.extension.json'), JSON.stringify({
    protocolVersion: '1.1.0', id: '@fixture/counting-inspect', version: '1.0.0',
    displayName: 'Counting inspect fixture', description: 'Counts create() calls for caching proof.',
    activation: { policy: 'operator' }, runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [{ id: 'counted', assetSet: 'counted-set', assetLock: './models.lock.json',
      platforms: [{ os: 'win32', arch: 'x64' }] }],
    tools: [], implementations: [], skills: [],
  }))
  writeFileSync(join(dir, 'models.lock.json'), '{"assets":[]}')
  writeFileSync(join(dir, 'index.js'), `
export function create() {
  globalThis.__countingInspectActivations = (globalThis.__countingInspectActivations ?? 0) + 1
  return {
    async createProvider() {
      return { async inspect() { return { readiness: 'ready', modelId: 'counted', summary: 'counting' } } }
    },
    dispose() {},
  }
}
export default { apiVersion: 1, create }
`)
  return { dir, path: dir }
}

describe('the extension-level inspection route', () => {
  it('reaches a REAL installed extension that has no catalog row', async () => {
    const bridge = new ProviderBridge({
      grant: createGrant({ grantId: 'inspect-test', allowedTools: ['*'], approvedRoots: [] }),
      activationGeneration: 1,
    })
    // EmbeddingGemma declares model `embeddinggemma-2` in its manifest, ships an
    // honest EXT-18 inspection, and is NOT a catalogued provider.
    const inspection = await bridge.inspectExtension(
      '@try-works/extension-embeddinggemma',
      'embeddinggemma-2',
      new AbortController().signal,
    )
    assert.ok(inspection !== undefined, 'a declared model must produce an inspection')
    // The honest states: prepared-cold where the runtime packages resolve (the text path
    // is wired), needs-preparation naming them where they do not. `ready` before a load
    // would be the fabrication EXT-18 exists to forbid.
    if (typeof import.meta.resolve?.('onnxruntime-node') === 'string') {
      assert.equal(inspection?.readiness, 'prepared-cold')
    } else {
      assert.equal(inspection?.readiness, 'needs-preparation')
    }
  })

  it('activates an extension ONCE no matter how many models are inspected', async () => {
    const { path } = writeCountingExtension()
    const bridge = new ProviderBridge({
      grant: createGrant({ grantId: 'inspect-cache', allowedTools: ['*'], approvedRoots: [] }),
      activationGeneration: 1,
    })
    globalThis.__countingInspectActivations = 0
    const first = await bridge.inspectExtension(path, 'counted', new AbortController().signal)
    const second = await bridge.inspectExtension(path, 'counted', new AbortController().signal)
    assert.equal(first?.readiness, 'ready')
    assert.equal(second?.readiness, 'ready')
    // A COUNTER, not a Map-key tautology: this fails if create() runs per inspection.
    assert.equal(globalThis.__countingInspectActivations, 1)
  })
})
