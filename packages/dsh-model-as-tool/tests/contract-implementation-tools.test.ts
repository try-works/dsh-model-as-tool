/**
 * TASK-121: an ACTIVE extension whose manifest declares ONLY implementations
 * (no `tools[]` — the MiniLM pair's shape) must register the STANDARD contract
 * tools the host knows the names for: text.embed -> text_embed. The tool is
 * callable through ctx.tools.execute with the contract-shaped input, is
 * withdrawn on disable, restored on re-enable, and never duplicates a manifest
 * tool of the same contract.
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { digestInstalledContent, ExtensionStore } from '@try-works/tool-mode-extension-sdk'

import * as plugin from '../src/index.ts'
import { tempDir } from './helpers.ts'

const EXTENSION_ID = '@try-works/fixture-impl-only'

/** A 384-d L2-normalized vector the handler returns (the contract's shape). */
function fixtureEmbedding(seed: number): number[] {
  const vector = Array.from({ length: 384 }, (_, i) => Math.sin(seed + i) * 0.001)
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

/** Install an implementations-only extension serving text.embed. */
function installImplOnlyExtension(storeDir: string, options: { declareTool?: boolean } = {}): string {
  const installPath = join(storeDir, 'packages', '@try-works', 'fixture-impl-only', '1.0.0')
  mkdirSync(installPath, { recursive: true })
  writeFileSync(join(installPath, 'package.json'), JSON.stringify({
    name: EXTENSION_ID,
    version: '1.0.0',
    type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
  }))
  writeFileSync(join(installPath, 'index.js'), `export default {
  apiVersion: 1,
  async create(context) {
    return {
      async createProvider({ modelId }) {
        void modelId
        return {
          async inspect(signal) { void signal; return { readiness: 'prepared-cold', features: ['text-embedding'], missing: [] } },
          async load() {},
          async invoke({ input }) {
            const texts = input.texts ?? []
            const embeddings = texts.map((text, index) => {
              const norm = Math.sqrt(384) || 1
              return Array.from({ length: 384 }, (_, i) => Math.sin(text.length + index + i) / norm)
            })
            return { embeddings, dimensions: 384, normalized: true }
          },
          async unload() {},
          async dispose() {},
        }
      },
      async dispose() {},
    }
  },
}
`)
  mkdirSync(join(installPath, 'schemas'), { recursive: true })
  writeFileSync(join(installPath, 'tool-mode.extension.json'), JSON.stringify({
    protocolVersion: '1.1.0',
    id: EXTENSION_ID,
    version: '1.0.0',
    displayName: 'implementation-only fixture',
    description: 'a fixture with implementations only, serving text.embed (task-121)',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js', isolation: 'host-inline' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false },
    network: { requiredTelemetry: false, otherNetworkUse: false },
    licenses: [
      { layer: 'code', name: 'MIT', url: 'https://opensource.org/license/mit', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'engine', name: 'none: fixture', url: 'https://example.invalid/fixture', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'weights', name: 'none: fixture', url: 'https://example.invalid/fixture', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'sdk', name: 'MIT', url: 'https://opensource.org/license/mit', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'conversion-artifacts', name: 'none: fixture', url: 'https://example.invalid/fixture', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
    ],
    models: [],
    tools: options.declareTool === true ? [{
      id: 'embed-tool',
      name: 'text_embed',
      contractId: 'text.embed',
      contractVersion: '1.0.0',
      description: 'the manifest tool for text.embed',
      inputSchema: './schemas/input.json',
      outputSchema: './schemas/output.json',
    }] : [],
    implementations: [{
      id: 'embed-impl',
      contractId: 'text.embed',
      contractVersion: '1.0.0',
      recipeVersion: '1.0.0',
    }],
    skills: [],
  }))
  if (options.declareTool === true) {
    writeFileSync(join(installPath, 'schemas', 'input.json'), JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
      required: ['texts'], properties: { texts: { type: 'array', items: { type: 'string' } } },
    }))
    writeFileSync(join(installPath, 'schemas', 'output.json'), JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
      required: ['embeddings', 'dimensions', 'normalized'],
      properties: { embeddings: { type: 'array' }, dimensions: { const: 384 }, normalized: { const: true } },
    }))
  }
  const store = new ExtensionStore(storeDir)
  store.recordInstall({
    extensionId: EXTENSION_ID,
    version: '1.0.0',
    installPath,
    archiveDigest: 'sha512-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    contentDigest: digestInstalledContent(installPath),
  } satisfies Parameters<ExtensionStore['recordInstall']>[0])
  store.writeProfileState('default', [{
    extensionId: EXTENSION_ID,
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: options.declareTool === true ? ['text_embed'] : [],
    readiness: {},
  }])
  return storeDir
}

async function mount(storeDir: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
  })
  return ctx
}

function registrations(ctx: Context, name: string): number {
  return ctx.tools.schemas().filter(schema => schema.name === name).length
}

test('an implementations-only extension registers the STANDARD contract tool, callable through the registry', async () => {
  const storeDir = installImplOnlyExtension(tempDir())
  const ctx = await mount(storeDir)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && registrations(ctx, 'text_embed') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'text_embed'), 1, 'text.embed must register as text_embed exactly once')
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `embed-${Date.now()}` as never,
    name: 'text_embed',
    arguments: { texts: ['hello', 'world'] },
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  const raw = result.value as string | { embeddings: number[][]; dimensions: number; normalized: boolean }
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  assert.equal(value.dimensions, 384)
  assert.equal(value.normalized, true)
  assert.equal(value.embeddings.length, 2, 'input order preserved')
  await ctx.fiber.dispose()
})

test('disable unregisters the standard contract tool; re-enable restores it', async () => {
  const storeDir = installImplOnlyExtension(tempDir())
  const ctx = await mount(storeDir)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && registrations(ctx, 'text_embed') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'text_embed'), 1)
  const service = ctx.get('modelTools') as unknown as {
    disable: (id: string) => Promise<unknown>
    enable: (id: string) => Promise<unknown>
  }
  await service.disable(EXTENSION_ID)
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(registrations(ctx, 'text_embed'), 0, 'the disable must withdraw the implementation-registered tool')
  await service.enable(EXTENSION_ID)
  const deadline2 = Date.now() + 15_000
  while (Date.now() < deadline2 && registrations(ctx, 'text_embed') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'text_embed'), 1, 'the re-enable must restore the standard tool')
  await ctx.fiber.dispose()
})

test('a manifest tool and an implementation of the same contract do NOT duplicate', async () => {
  const storeDir = installImplOnlyExtension(tempDir(), { declareTool: true })
  const ctx = await mount(storeDir)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && registrations(ctx, 'text_embed') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'text_embed'), 1, 'exactly one text_embed — the manifest tool and the implementation must not both register')
  await ctx.fiber.dispose()
})
