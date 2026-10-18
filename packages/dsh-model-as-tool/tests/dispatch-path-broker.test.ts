/**
 * TASK-123: the extension invocation context carries the host's path
 * authority broker. A handler that reads a caller-supplied file path asks
 * resolvePath and gets the canonical authorized path for an in-root file, and
 * the broker's named refusal for anything outside the approved roots — the
 * SAME authority the catalogue/contract path builds.
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

const EXTENSION_ID = '@try-works/fixture-path-broker'

/** Install an implementations-only extension whose handler resolves a path. */
function installPathFixture(storeDir: string): void {
  const installPath = join(storeDir, 'packages', '@try-works', 'fixture-path-broker', '1.0.0')
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
          async inspect(signal) { void signal; return { readiness: 'prepared-cold', features: [], missing: [] } },
          async load() {},
          async invoke({ input, context: invocation }) {
            const audio = input.audio ?? {}
            const resolved = invocation.resolvePath(audio.path)
            return { text: resolved, coverage: { complete: true, transcribedSeconds: 0, totalSeconds: null, reason: null } }
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
    id: EXTENSION_ID,
    version: '1.0.0',
    displayName: 'path broker fixture',
    description: 'a fixture whose handler resolves a caller path through the host broker (task-123)',
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
    tools: [],
    implementations: [{
      id: 'stt-impl',
      contractId: 'stt.transcribe',
      contractVersion: '1.0.0',
      recipeVersion: '1.0.0',
    }],
    skills: [],
  }))
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
    tools: [],
    readiness: {},
  }])
}

test('the handler\'s resolvePath returns the canonical authorized path for an in-root file', async () => {
  const storeDir = tempDir()
  installPathFixture(storeDir)
  // DIAGNOSTIC: the ownership probe's exact inputs.
  const diagStore = new ExtensionStore(storeDir)
  const diagState = diagStore.readProfileState('default').value.map(entry => `${entry.extensionId}:${entry.desiredActivation}/${entry.observedActivation}`)
  const diagInstalled = diagStore.listInstalled().value.map(record => record.extensionId)
  const diagDiscovery = diagStore.listInstalled().value[0] !== undefined
    ? (await import('@try-works/tool-mode-extension-sdk')).discoverExtension(diagStore.listInstalled().value[0]!.installPath)
    : undefined
  console.log(`DIAG state=${JSON.stringify(diagState)} installed=${JSON.stringify(diagInstalled)} implementations=${JSON.stringify(diagDiscovery?.manifest.implementations)}`)
  const root = tempDir()
  const recording = join(root, 'clip.wav')
  const wav = Buffer.alloc(44 + 320)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + 320, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24)
  wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(320, 40)
  for (let i = 0; i < 320; i += 1) wav.writeUInt8(0, 44 + i)
  writeFileSync(recording, wav)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
    approvedRoots: [root],
  })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && ctx.tools.schemas().every(schema => schema.name !== 'stt_transcribe')) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const diagAfter = new ExtensionStore(storeDir).readProfileState('default').value[0]
  console.log(`DIAG-after state=${JSON.stringify(diagAfter)}`)
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `path-${Date.now()}` as never,
    name: 'stt_transcribe',
    arguments: { audio: { path: recording } },
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  const value = (typeof result.value === 'string' ? JSON.parse(result.value) : result.value) as { text: string }
  assert.equal(value.text, recording, `the broker returned the canonical in-root path; result=${JSON.stringify(result)}`)
  await ctx.fiber.dispose()
})

test('an out-of-root path is refused by the broker with the named authority error', async () => {
  const storeDir = tempDir()
  installPathFixture(storeDir)
  const root = tempDir()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
    approvedRoots: [root],
  })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && ctx.tools.schemas().every(schema => schema.name !== 'stt_transcribe')) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `path-out-${Date.now()}` as never,
    name: 'stt_transcribe',
    arguments: { audio: { path: 'C:/Windows/system32/kernel32.dll' } },
  })
  assert.equal(result.isError, true, 'an out-of-root path must be refused by the broker')
  assert.match(JSON.stringify(result), /outside every root|not admitted|absolute|does not exist/i, 'the refusal names the authority')
  await ctx.fiber.dispose()
})
