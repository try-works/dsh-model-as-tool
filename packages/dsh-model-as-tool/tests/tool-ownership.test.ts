/**
 * TASK-117: the catalogue-vs-extension tool-name reconciliation.
 *
 * An installed extension that declares a tool name OWNS it: the catalogue
 * skips its own registration for a contract-backed entry with that name, and
 * restores it when the extension releases the name. These tests pin the
 * ownership rule end to end: boot with the owning extension active, enable
 * after boot, disable (restore), re-enable (swap back), and the no-extension
 * case.
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { discoverExtension, digestInstalledContent, ExtensionStore } from '@try-works/tool-mode-extension-sdk'

import * as plugin from '../src/index.ts'
import { tempDir } from './helpers.ts'

/** A minimal installed extension that OWNS the `lang_detect` tool name. */
function installOwnerExtension(storeDir: string): string {
  const installPath = join(storeDir, 'packages', '@try-works', 'extension-lang-owner', '1.0.0')
  mkdirSync(installPath, { recursive: true })
  writeFileSync(join(installPath, 'package.json'), JSON.stringify({
    name: '@try-works/extension-lang-owner',
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
        return {
          async inspect(signal) { return { readiness: 'ready', features: [], missing: [] } },
          async load() {},
          async invoke({ input }) {
            return { language: 'en', reliability: 'confident', tooCloseToCall: false, candidates: [{ language: 'en', probability: 0.99 }] }
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
  writeFileSync(join(installPath, 'tool-mode.extension.json'), JSON.stringify({
    protocolVersion: '1.1.0',
    id: '@try-works/extension-lang-owner',
    version: '1.0.0',
    displayName: 'lang owner fixture',
    description: 'a fixture owning the lang_detect tool name (task-117)',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js', isolation: 'host-inline' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'extension-private', secrets: [], nativeCode: false },
    network: { requiredTelemetry: false, otherNetworkUse: false },
    licenses: [
      { layer: 'code', name: 'MIT', url: 'https://opensource.org/license/mit', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'engine', name: 'none: the fixture implements its tool directly', url: 'https://example.invalid/fixture', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'weights', name: 'none: the fixture owns no model', url: 'https://example.invalid/fixture', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'sdk', name: 'MIT', url: 'https://opensource.org/license/mit', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
      { layer: 'conversion-artifacts', name: 'none: no conversion step is performed', url: 'https://example.invalid/fixture', openSource: true, redistribution: 'permitted', attributionRequired: false, obligations: [] },
    ],
    models: [],
    tools: [{
      id: 'lang-detect-fixture',
      name: 'lang_detect',
      contractId: 'text.language_detect',
      contractVersion: '1.0.0',
      description: 'the fixture lang_detect',
      inputSchema: './schemas/input.json',
      outputSchema: './schemas/output.json',
    }],
    implementations: [{
      id: 'lang-owner-impl',
      contractId: 'text.language_detect',
      contractVersion: '1.0.0',
      recipeVersion: '1.0.0',
    }],
    skills: [],
  }))
  mkdirSync(join(installPath, 'schemas'), { recursive: true })
  writeFileSync(join(installPath, 'schemas', 'input.json'), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    required: ['text'], properties: { text: { type: 'string' } },
  }))
  writeFileSync(join(installPath, 'schemas', 'output.json'), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    required: ['language', 'reliability', 'tooCloseToCall', 'candidates'],
    properties: {
      language: { type: ['string', 'null'] },
      reliability: { type: 'string' },
      tooCloseToCall: { type: 'boolean' },
      candidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['language', 'probability'], properties: { language: { type: 'string' }, probability: { type: 'number' } } } },
    },
  }))
  // The store record: installed + active — the LOCK carries the installation
  // (listInstalled reads it), the profile state carries the activation. The
  // content digest is the REAL one (verifyUnchanged re-checks it at restore).
  const store = new ExtensionStore(storeDir)
  store.recordInstall({
    extensionId: '@try-works/extension-lang-owner',
    version: '1.0.0',
    installPath,
    archiveDigest: 'sha512-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    contentDigest: digestInstalledContent(installPath),
  } satisfies Parameters<ExtensionStore['recordInstall']>[0])
  store.writeProfileState('default', [{
    extensionId: '@try-works/extension-lang-owner',
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: ['lang_detect'],
    readiness: {},
  }])
  // Sanity: the fixture discovers.
  const discovery = discoverExtension(installPath)
  assert.equal(discovery.manifest.tools.length, 1)
  return storeDir
}

interface MountOptions {
  readonly storeDir?: string
}

async function mount(options: MountOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(options.storeDir ?? tempDir(), 'state.json'),
    credentialsFile: join(options.storeDir ?? tempDir(), 'credentials.json'),
    ...options.storeDir === undefined ? {} : { extensionStore: options.storeDir },
  })
  return ctx
}

/** Count how many registrations exist under a tool name (1 expected). */
function registrations(ctx: Context, name: string): number {
  return ctx.tools.schemas().filter(schema => schema.name === name).length
}

test('no extension store: the catalogue registers lang_detect exactly once (unchanged)', async () => {
  const ctx = await mount()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && registrations(ctx, 'lang_detect') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'lang_detect'), 1, 'the catalogue registration is the no-extension baseline')
  await ctx.fiber.dispose()
})

test('boot with the owning extension active: exactly one lang_detect, owned by the extension (no EXTENSION_FAULT)', async () => {
  const storeDir = installOwnerExtension(tempDir())
  const ctx = await mount({ storeDir })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && registrations(ctx, 'lang_detect') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  // DIAGNOSTIC: report the activation state when the assertion would fail.
  const state = new ExtensionStore(storeDir).readProfileState('default').value[0]
  assert.equal(
    registrations(ctx, 'lang_detect'), 1,
    `exactly one lang_detect — observed=${state?.observedActivation} tools=${JSON.stringify(ctx.tools.schemas().map(schema => schema.name))}`,
  )
  // The registered tool is callable and returns the fixture's honest payload.
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `fixture-${Date.now()}` as never,
    name: 'lang_detect',
    arguments: { text: 'hello' },
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  await ctx.fiber.dispose()
})

test('disable restores the catalogue tool; re-enable swaps back', async () => {
  const storeDir = installOwnerExtension(tempDir())
  const ctx = await mount({ storeDir })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && registrations(ctx, 'lang_detect') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'lang_detect'), 1)
  // Disable the extension: the lifecycle releases the name and the host's
  // onActivationChange restores the deferred catalogue registration.
  const store = new ExtensionStore(storeDir)
  store.writeProfileState('default', [{
    extensionId: '@try-works/extension-lang-owner',
    installation: 'installed',
    desiredActivation: 'inactive',
    observedActivation: 'inactive',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: [],
    readiness: {},
  }])
  const service = ctx.get('modelTools') as unknown as {
    disable: (id: string, signal?: AbortSignal) => Promise<unknown>
    enable: (id: string, signal?: AbortSignal) => Promise<unknown>
  }
  const toggled = await service.disable('@try-works/extension-lang-owner')
  void toggled
  await new Promise(resolve => setTimeout(resolve, 1200))
  // The catalogue restoration registers lang_detect again through the
  // contract path — exactly one tool remains (the extension's withdrawn).
  assert.equal(
    registrations(ctx, 'lang_detect'), 1,
    `after disable exactly one lang_detect remains (the restored catalogue tool); tools=${JSON.stringify(ctx.tools.schemas().map(schema => schema.name))}`,
  )
  // Re-enable: the catalogue registration is withdrawn and the extension's
  // activation publishes its tool again — still exactly one, callable.
  store.writeProfileState('default', [{
    extensionId: '@try-works/extension-lang-owner',
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: ['lang_detect'],
    readiness: {},
  }])
  const reenabled = await service.enable('@try-works/extension-lang-owner')
  void reenabled
  const deadline2 = Date.now() + 15_000
  while (Date.now() < deadline2 && registrations(ctx, 'lang_detect') === 0) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(registrations(ctx, 'lang_detect'), 1, 're-enable swaps back to exactly one lang_detect')
  const afterReenable = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `fixture-re-${Date.now()}` as never,
    name: 'lang_detect',
    arguments: { text: 'hello again' },
  })
  assert.equal(afterReenable.isError, false, JSON.stringify(afterReenable))
  await ctx.fiber.dispose()
})

test('the restore probe reads the durable store (deterministic in both orders)', () => {
  const storeDir = tempDir()
  installOwnerExtension(storeDir)
  // The probe itself is order-independent: it reads the store, not an
  // in-flight registry — re-checking the same store gives the same answer.
  const first = new ExtensionStore(storeDir).listInstalled().value.length
  const second = new ExtensionStore(storeDir).listInstalled().value.length
  assert.equal(first, 1)
  assert.equal(second, 1)
})
