/**
 * The host-side harness-provider injection seam (HLM-01/02/03), proved at both layers.
 *
 * The recipes package ships the DSH-backed `DshLlmProvider`; this file proves the HOST
 * composition that makes a declarative package actually runnable:
 *
 * - unit: `buildHarnessLlmProvider` reads the deployment's DSH surface structurally,
 *   builds the provider from the model's OWN descriptor, mints the image transport ONLY
 *   when the attachment service is reachable (otherwise capabilities honestly report
 *   `unknown`, which the broker refuses with EXECUTOR_CAPABILITY_UNKNOWN), and fails
 *   CLOSED to `undefined` when the surface cannot serve the named model;
 * - end to end: the REAL declarative package (extension-declarative-recipes) installed
 *   and activated through the real lifecycle, with a SCRIPTED DSH surface provided on
 *   the context and the opt-in `harnessModel` config — `text_title` registers and
 *   completes a REAL broker run through the host pipeline, `describe_image` refuses
 *   with the capability-unknown code (no attachment service), and the absent-config
 *   case refuses activation rather than registering nothing.
 *
 * Every test names which surface it ran against: the scripted stub or the host pipeline.
 *
 * Requirement links: HLM-01, HLM-02, HLM-03, HLM-11, RCP-01.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import AdmZip from 'adm-zip'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createZipArchiveSource, ExtensionStore, stagedInstall } from '@try-works/tool-mode-extension-sdk'

import * as plugin from '../src/index.ts'
import { buildHarnessLlmProvider, discoverDefaultHarnessModel, resolveRunnableHarnessModel } from '../src/harness-llm.ts'
import { cleanup, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const SCRIPTED_TITLE = JSON.stringify({
  title: 'Deployment pipeline configuration',
  description: 'Automates the configuration of a deployment pipeline.',
})

/** A scripted DSH surface: deterministic model, descriptor-driven capabilities. */
function scriptedSurface(options: {
  readonly inputModalities?: readonly string[]
  readonly chunks?: readonly Record<string, unknown>[]
} = {}) {
  return {
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
      ...options.inputModalities === undefined ? {} : { inputModalities: options.inputModalities },
      defaultMaxTokens: 2048,
    }),
    stream: async function* (request: Record<string, unknown>) {
      void request
      for (const chunk of options.chunks ?? [
        { type: 'text-delta', index: 0, text: SCRIPTED_TITLE },
        { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]) yield chunk
    },
  }
}

/** JSON-safe image bytes: the harness requires losslessly serializable arguments. */
const IMAGE_BYTES = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]

describe('HLM-01/02/03 — the injection seam reads the DSH surface structurally (scripted stub)', () => {
  it('builds a provider over the model descriptor, images unsupported for a text model', async () => {
    const provider = await buildHarnessLlmProvider(
      { llm: scriptedSurface({ inputModalities: ['text'] }) },
      { provider: 'deepseek', model: 'deepseek-chat' },
    )
    assert.ok(provider !== undefined, 'a reachable surface must build a provider')
    assert.deepEqual(provider.capabilities(), { images: 'unsupported', maxOutputTokens: 2048 })
  })

  it('mints the image transport ONLY when the attachment service is reachable (HLM-11)', async () => {
    const imageModel = { inputModalities: ['text', 'image'] }
    const without = await buildHarnessLlmProvider(
      { llm: scriptedSurface(imageModel) },
      { provider: 'deepseek', model: 'vision' },
    )
    assert.ok(without !== undefined)
    assert.deepEqual(without.capabilities(), { images: 'unknown', maxOutputTokens: 2048 }, 'no attachment service means honest unknown, never a silent drop')

    const saved: unknown[] = []
    const withHook = await buildHarnessLlmProvider({
      llm: scriptedSurface(imageModel),
      attachments: {
        saveImage: async (input) => {
          saved.push(input)
          return { attachmentId: 'sha256:fake', mediaType: input.mediaType }
        },
      },
    }, { provider: 'deepseek', model: 'vision' })
    assert.ok(withHook !== undefined)
    assert.deepEqual(withHook.capabilities(), { images: 'supported', maxOutputTokens: 2048 }, 'a reachable attachment service makes images supported')
  })

  it('fails closed: an unreachable surface or an unresolvable descriptor yields undefined', async () => {
    const logs: string[] = []
    const absent = await buildHarnessLlmProvider({}, { provider: 'deepseek', model: 'deepseek-chat' }, message => logs.push(message))
    assert.equal(absent, undefined, 'no DSH LLM surface means no provider')
    assert.match(logs.join('\n'), /not mounted/)

    const broken = await buildHarnessLlmProvider({ llm: {
      resolveModelInfo: async () => { throw new Error('no route') },
      stream: async function* () {},
    } }, { provider: 'deepseek', model: 'deepseek-chat' }, message => logs.push(message))
    assert.equal(broken, undefined, 'an unresolvable descriptor fails closed')
    assert.match(logs.join('\n'), /could not build the harness provider/)
  })
})

describe('task-93 — the AUTO default-model discovery is default-safe', () => {
  it('reads the agent-default-model settings entry', () => {
    const found = discoverDefaultHarnessModel({
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
    })
    assert.deepEqual(found, { provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('falls back to config.model.default as the provider/model string', () => {
    const found = discoverDefaultHarnessModel({
      config: { model: { default: 'deepseek-official/deepseek-flash' } },
    })
    assert.deepEqual(found, { provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('refuses ambiguity: malformed entries and missing surfaces yield undefined, never a guess', () => {
    assert.equal(discoverDefaultHarnessModel({}), undefined)
    // The actual SettingsForms surface has NO get(ns); describe() is the API.
    assert.equal(discoverDefaultHarnessModel({ settings: { describe: () => [] } }), undefined, 'no descriptor means no model')
    assert.equal(
      discoverDefaultHarnessModel({ settings: { describe: () => [{ ns: 'other', value: { provider: 'p', model: 'm' } }] } }),
      undefined,
      'a different namespace is not the default model',
    )
    assert.equal(
      discoverDefaultHarnessModel({ settings: { describe: () => [{ ns: 'agent-default-model', value: { provider: 'p' } }] } }),
      undefined,
      'a missing model half is ambiguous',
    )
    assert.equal(
      discoverDefaultHarnessModel({ settings: { describe: () => [{ ns: 'agent-default-model', value: { model: 'm' } }] } }),
      undefined,
      'a missing provider half is ambiguous',
    )
    assert.equal(discoverDefaultHarnessModel({ config: { model: { default: 'no-slash' } } }), undefined)
    assert.equal(discoverDefaultHarnessModel({ config: { model: { default: '/m' } } }), undefined, 'an empty provider half is ambiguous')
  })
})

const PACKAGE_DIR = join(process.cwd(), 'packages', 'extension-declarative-recipes')
const EXTENSION_ID = '@try-works/extension-declarative-recipes'

/** Archive the REAL declarative package, exactly as the installer verifies it. */
function packPackage(): { bytes: Uint8Array; sha512: string } {
  const zip = new AdmZip()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'src' || entry === 'tests') continue
      const full = join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else zip.addFile(relative(PACKAGE_DIR, full).replace(/\\/g, '/'), readFileSync(full))
    }
  }
  walk(PACKAGE_DIR)
  const bytes = new Uint8Array(zip.toBuffer())
  return { bytes, sha512: createHash('sha512').update(bytes).digest('hex') }
}

/** Install + approve the declarative package, mounting a fresh host around it. */
async function mountDeclarative(options: {
  readonly harnessModel?: { provider: string; model: string }
  readonly llm?: unknown
  readonly settings?: unknown
  readonly harnessRetry?: { intervalMs: number; capMs: number }
}): Promise<{ ctx: Context; storeDir: string }> {
  const storeDir = tempDir()
  const { bytes, sha512 } = packPackage()
  await stagedInstall({
    source: { kind: 'local', requested: PACKAGE_DIR },
    storeDir,
    expectedSha512: sha512,
    archive: createZipArchiveSource(() => bytes),
  })
  const store = new ExtensionStore(storeDir)
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

  const ctx = new Context()
  if (options.llm !== undefined) ctx.provide('llm', options.llm)
  if (options.settings !== undefined) ctx.provide('settings', options.settings)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const pluginFiber = await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
    ...options.harnessModel === undefined ? {} : { harnessModel: options.harnessModel },
    ...options.harnessRetry === undefined ? {} : {
      harnessRetryIntervalMs: options.harnessRetry.intervalMs,
      harnessRetryCapMs: options.harnessRetry.capMs,
    },
  })
  return { ctx, storeDir, disposePlugin: () => pluginFiber.dispose() }
}

describe('HLM-01 — the host pipeline serves declarative recipes through a scripted DSH surface', () => {
  it('registers text_title/describe_image and COMPLETES a real broker run (opt-in harnessModel)', async () => {
    const { ctx } = await mountDeclarative({
      harnessModel: { provider: 'deepseek', model: 'deepseek-chat' },
      // The scripted surface stands in for the DSH LLM service: the model is
      // deterministic, the machinery (descriptor read, stream assembly, broker) is real.
      llm: scriptedSurface(),
    })

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const names = ctx.tools.schemas().map(schema => schema.name)
      if (names.includes('text_title') && names.includes('describe_image')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const names = ctx.tools.schemas().map(schema => schema.name)
    assert.ok(names.includes('text_title'), `text_title must be registered, saw: ${names.join(', ')}`)
    assert.ok(names.includes('describe_image'), 'describe_image must be registered')

    // A REAL broker run through the host pipeline: the recipe renders the prompt,
    // the scripted model answers, and the completion reaches the caller.
    const signal = new AbortController().signal
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('harness-title-1'),
      name: 'text_title',
      arguments: { text: 'A guide to automating the configuration of a deployment pipeline.' },
    })
    assert.equal(result.isError, false, `the title run must complete: ${JSON.stringify(result)}`)
    const parsed = JSON.parse(result.value as string) as { title?: string }
    assert.equal(parsed.title, 'Deployment pipeline configuration', 'the completion must carry the scripted title')

    // HLM-11: no attachment service was provided, so the image-capable descriptor is
    // honestly 'unknown' and the broker refuses — never a silent drop.
    const image = await ctx.tools.execute({
      signal,
      callId: ToolCallId('harness-image-1'),
      name: 'describe_image',
      arguments: { image: { mediaType: 'image/png', bytes: IMAGE_BYTES } },
    })
    assert.equal(image.isError, true, 'an image recipe on an unknown capability must refuse')
    assert.match(JSON.stringify(image), /EXECUTOR_CAPABILITY_UNKNOWN/, 'the refusal names the capability')
  })

  it('DEFAULT OFF: without harnessModel (and no harnessProvider), declarative activation refuses rather than registering nothing', async () => {
    const { ctx, storeDir } = await mountDeclarative({})
    // Give the restore chain time to attempt publication and record the refusal.
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(
      ctx.tools.schemas().some(schema => schema.name === 'text_title'),
      false,
      'no provider means no declarative tools',
    )
    const state = new ExtensionStore(storeDir).readProfileState('default').value[0]
    assert.ok(
      state?.observedActivation === 'failed' || state?.observedActivation === 'quarantined',
      `the extension must be failed or quarantined, not ${state?.observedActivation}`,
    )
  })

  it('fails closed through the host: harnessModel without a mounted DSH surface refuses the same way', async () => {
    const { ctx } = await mountDeclarative({ harnessModel: { provider: 'deepseek', model: 'deepseek-chat' } })
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(ctx.tools.schemas().some(schema => schema.name === 'text_title'), false, 'an unreachable surface must not half-wire the provider')
  })

  it('AUTO (task-93): no harnessModel, but the LLM surface + the default-model setting compose the provider end to end', async () => {
    const { ctx } = await mountDeclarative({
      llm: scriptedSurface(),
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (ctx.tools.schemas().some(schema => schema.name === 'text_title')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(
      ctx.tools.schemas().some(schema => schema.name === 'text_title'),
      'the AUTO composition must register text_title from the deployment default model',
    )
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('harness-auto-1'),
      name: 'text_title',
      arguments: { text: 'A guide to automating the configuration of a deployment pipeline.' },
    })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(JSON.parse(result.value as string).title, 'Deployment pipeline configuration', 'the AUTO provider serves a real recipe call')
  })

  it('explicit config wins over the AUTO discovery', async () => {
    const resolved: string[] = []
    const recording = scriptedSurface()
    const original = recording.resolveModelInfo
    recording.resolveModelInfo = async (provider: string, model: string) => {
      resolved.push(`${provider}/${model}`)
      return original(provider, model)
    }
    const { ctx } = await mountDeclarative({
      harnessModel: { provider: 'explicit-provider', model: 'explicit-model' },
      llm: recording,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (ctx.tools.schemas().some(schema => schema.name === 'text_title')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(resolved.length > 0, 'the provider must have resolved a model')
    assert.ok(resolved.every(pair => pair === 'explicit-provider/explicit-model'), `only the explicit config may resolve, saw: ${resolved.join(', ')}`)
  })

  it('task-96 regression: a materialized but EMPTY harnessModel falls through to AUTO and serves', async () => {
    // The parsed Config materializes harnessModel as {} when the operator set
    // nothing; the explicit branch must not run (the live undefined/undefined
    // reason) — AUTO discovers the settings default instead.
    const { ctx } = await mountDeclarative({
      harnessModel: {} as never,
      llm: scriptedSurface(),
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (ctx.tools.schemas().some(schema => schema.name === 'text_title')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(
      ctx.tools.schemas().some(schema => schema.name === 'text_title'),
      'an empty harnessModel must fall through to AUTO and register the tool',
    )
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('harness-empty-config-1'),
      name: 'text_title',
      arguments: { text: 'A guide to automating the configuration of a deployment pipeline.' },
    })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(JSON.parse(result.value as string).title, 'Deployment pipeline configuration')
  })

  it('task-96 regression: a PARTIAL harnessModel (only provider) also falls through to AUTO', async () => {
    const { ctx } = await mountDeclarative({
      harnessModel: { provider: 'only-provider' } as never,
      llm: scriptedSurface(),
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (ctx.tools.schemas().some(schema => schema.name === 'text_title')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(
      ctx.tools.schemas().some(schema => schema.name === 'text_title'),
      'a partial harnessModel must fall through to AUTO and register the tool',
    )
  })

  it('task-96 regression: an explicit UNSERVABLE pair still names the real pair, never undefined/undefined', async () => {
    const logs: string[] = []
    const built = await buildHarnessLlmProvider(
      { llm: { resolveModelInfo: async () => { throw new Error('no route') }, stream: async function* () {} } },
      { provider: 'broken-route', model: 'broken-model' },
      message => logs.push(message),
    )
    assert.equal(built, undefined)
    // The composition's explicit-unsatisfiable reason is built from the SAME
    // explicit pair; the build-side diagnostic must carry the real pair.
    assert.match(logs.join('\n'), /broken-route\/broken-model/)
  })
})

/**
 * A LlmRuntime-shaped double: resolveModelInfo succeeds only for the
 * REGISTERED route, while listProviders/listConfigurableProviders/listModels
 * mirror the real registry (types.d.ts: LlmProviderInfo {id, name};
 * LlmConfigurableProvider {provider, displayName, settingsNs}; LlmModelInfo
 * {provider, id, name}).
 */
function runtimeSurface(options: {
  readonly route: string
  readonly models: readonly string[]
  readonly settingsNs?: string
  readonly displayName?: string
}) {
  return {
    resolveModelInfo: async (provider: string, model: string) => {
      if (provider !== options.route) throw new Error(`unknown provider route ${provider}`)
      if (!options.models.includes(model)) throw new Error(`unknown model ${model}`)
      return { provider, id: model, name: model, inputModalities: ['text'], defaultMaxTokens: 2048 }
    },
    listProviders: () => [{ id: options.route, name: options.displayName ?? options.route }],
    listConfigurableProviders: () => [{
      provider: options.route,
      displayName: options.displayName ?? options.route,
      settingsNs: options.settingsNs ?? options.route,
      settingsPath: [],
    }],
    listModels: async (provider: string) => (
      provider === options.route ? options.models.map(id => ({ provider, id, name: id })) : []
    ),
    stream: async function* (request: Record<string, unknown>) {
      void request
      yield { type: 'text-delta', index: 0, text: SCRIPTED_TITLE }
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

describe('task-98 — the runtime-aware resolution maps the configured provider to a RUNNABLE route', () => {

  it('maps a SETTINGS-NAMESPACE provider to its registered route and confirms the model (the live deepseek-official case)', async () => {
    const llm = runtimeSurface({ route: 'deepseek', models: ['deepseek-flash', 'deepseek-chat'], settingsNs: 'deepseek-official', displayName: 'DeepSeek Official' })
    const resolution = await resolveRunnableHarnessModel(llm, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.deepEqual(resolution, { ok: true, route: 'deepseek', model: 'deepseek-flash' })
  })

  it('keeps the direct pair when the configured provider IS the route', async () => {
    const llm = runtimeSurface({ route: 'deepseek', models: ['deepseek-flash'] })
    const resolution = await resolveRunnableHarnessModel(llm, { provider: 'deepseek', model: 'deepseek-flash' })
    assert.deepEqual(resolution, { ok: true, route: 'deepseek', model: 'deepseek-flash' })
  })

  it('an EMPTY route registry is not-ready-yet, never not-configured', async () => {
    const llm = {
      resolveModelInfo: async () => { throw new Error('nothing registered') },
      listProviders: () => [] as { id: string; name: string }[],
    }
    const resolution = await resolveRunnableHarnessModel(llm, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.equal(resolution.kind, 'not-ready-yet')
      assert.match(resolution.reason, /has not registered its provider routes yet/)
    }
  })

  it('an unknown provider and an unserved model are not-configured with the exact reasons', async () => {
    const llm = runtimeSurface({ route: 'deepseek', models: ['deepseek-flash'] })
    const unknownProvider = await resolveRunnableHarnessModel(llm, { provider: 'nobody', model: 'deepseek-flash' })
    assert.equal(unknownProvider.ok, false)
    if (!unknownProvider.ok) {
      assert.equal(unknownProvider.kind, 'not-configured')
      assert.match(unknownProvider.reason, /not a registered LLM route/)
    }
    const unservedModel = await resolveRunnableHarnessModel(llm, { provider: 'deepseek', model: 'deepseek-hologram' })
    assert.equal(unservedModel.ok, false)
    if (!unservedModel.ok) {
      assert.equal(unservedModel.kind, 'not-configured')
      assert.match(unservedModel.reason, /not served by the deepseek route/)
    }
  })

  it('task-100: routes present but an EMPTY directory is not-ready-yet, never terminal', async () => {
    // The live boot-to-ready sequence: the adapter routes register FIRST and
    // the configurable-provider directory lands after. A provider the empty
    // directory cannot map yet is INCOMPLETE, not misconfigured.
    const llm = {
      resolveModelInfo: async () => { throw new Error('not a route') },
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listConfigurableProviders: () => [] as { provider: string; displayName: string }[],
    }
    const resolution = await resolveRunnableHarnessModel(llm, { provider: 'deepseek-official', model: 'deepseek-flash' })
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.equal(resolution.kind, 'not-ready-yet')
      assert.match(resolution.reason, /has not registered its provider routes yet/)
    }
  })

  it('task-100: a genuinely unknown provider WITH a non-empty directory is terminal not-configured', async () => {
    const llm = {
      resolveModelInfo: async () => { throw new Error('not a route') },
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listConfigurableProviders: () => [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'deepseek-official' }],
    }
    const resolution = await resolveRunnableHarnessModel(llm, { provider: 'completely-unknown', model: 'deepseek-flash' })
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.equal(resolution.kind, 'not-configured')
      assert.match(resolution.reason, /not a registered LLM route/)
    }
  })

  it('AUTO composes through the mapped route and serves a declarative recipe call end to end', async () => {
    const { ctx } = await mountDeclarative({
      llm: runtimeSurface({ route: 'deepseek', models: ['deepseek-flash'], settingsNs: 'deepseek-official', displayName: 'DeepSeek Official' }),
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
    })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (ctx.tools.schemas().some(schema => schema.name === 'text_title')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(
      ctx.tools.schemas().some(schema => schema.name === 'text_title'),
      'the mapped route must compose the provider and register the declarative tool',
    )
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('harness-mapped-1'),
      name: 'text_title',
      arguments: { text: 'A guide to automating the configuration of a deployment pipeline.' },
    })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(JSON.parse(result.value as string).title, 'Deployment pipeline configuration')
  })
})

describe('task-99 — the bounded background retry flips the status without a second read', () => {
  interface ServiceDescribe {
    describe(signal?: AbortSignal): Promise<{
      rows: readonly { id: string; blocked: boolean; requirements: readonly { kind: string; satisfied: boolean; reason: string }[] }[]
    }>
  }
  const harnessRequirement = (result: Awaited<ReturnType<ServiceDescribe['describe']>>) => (
    result.extensions.find(row => row.id === EXTENSION_ID)!.requirements.find(req => req.kind === 'harness-model')!
  )

  /**
   * TASK-108: the deterministic promotion helper. The retry tests await an
   * OBSERVABLE condition with a generous 10 s timeout instead of racing a
   * tight wall-clock budget; under parallel load the polls lag but the helper
   * absorbs it. Never assert an exact poll count — `>= N` only.
   */
  async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await condition()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`)
  }

  /** listProviders() stays empty for `emptyPolls` calls, then the route appears. */
  function deferredSurface(emptyPolls: number, route = 'deepseek') {
    let polls = 0
    const calls = { resolveModelInfo: 0, listProviders: 0 }
    const base = runtimeSurface({ route, models: ['deepseek-flash'], settingsNs: 'deepseek-official', displayName: 'DeepSeek Official' })
    return {
      calls,
      surface: {
        resolveModelInfo: async (provider: string, model: string) => {
          calls.resolveModelInfo += 1
          if (polls < emptyPolls) throw new Error('no routes yet')
          return base.resolveModelInfo(provider, model)
        },
        listProviders: () => {
          calls.listProviders += 1
          polls += 1
          if (polls <= emptyPolls) return []
          return [{ id: route, name: 'DeepSeek Official' }]
        },
        listConfigurableProviders: base.listConfigurableProviders,
        listModels: base.listModels,
        stream: base.stream,
      },
    }
  }

  it('flips to available within the bounded retry WITHOUT another describe', async () => {
    const deferred = deferredSurface(3)
    const { ctx } = await mountDeclarative({
      llm: deferred.surface,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
      harnessRetry: { intervalMs: 100, capMs: 5_000 },
    })
    const service = ctx.get('modelTools') as unknown as ServiceDescribe
    const first = await service.describe()
    const initial = harnessRequirement(first)
    assert.equal(initial.satisfied, false, 'the first read sees the honest not-ready-yet')
    // TASK-108: await the OBSERVABLE flip — the requirement becoming satisfied
    // — with a generous 10 s timeout. The retry does the work on its own
    // interval; the poll helper only observes the status it publishes.
    let flipAttempts = 0
    await waitFor(async () => {
      flipAttempts += 1
      return harnessRequirement(await service.describe()).satisfied
    }, 'the retry to flip the requirement to satisfied')
    assert.ok(flipAttempts >= 1)
    assert.ok(deferred.calls.listProviders > 3, 'the flip came from the retry\'s own polls, not the first read')
  })

  it('a registry that stays empty is still not-ready-yet after the cap, with the same reason', async () => {
    const deferred = deferredSurface(1_000_000)
    const { ctx } = await mountDeclarative({
      llm: deferred.surface,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
      harnessRetry: { intervalMs: 60, capMs: 400 },
    })
    const service = ctx.get('modelTools') as unknown as ServiceDescribe
    const first = await service.describe()
    const initial = harnessRequirement(first)
    assert.match(initial.reason, /has not registered its provider routes yet/)
    // The cap (400 ms) elapses; the polls stop; the parked verdict — which for
    // an empty registry IS the not-ready-yet — is published unchanged.
    await waitFor(() => deferred.calls.resolveModelInfo >= 3, 'a few retry polls to have run')
    const final = await service.describe()
    const after = harnessRequirement(final)
    assert.equal(after.satisfied, false)
    assert.match(after.reason, /has not registered its provider routes yet/, 'the reason stays the honest not-ready-yet')
  })

  it('dispose stops the retry (no leaked timers)', async () => {
    const deferred = deferredSurface(1_000_000)
    const { disposePlugin } = await mountDeclarative({
      llm: deferred.surface,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
      harnessRetry: { intervalMs: 50, capMs: 30_000 },
    })
    await waitFor(() => deferred.calls.listProviders >= 1, 'the retry to start polling')
    await disposePlugin()
    // After dispose the polls plateau: give any single in-flight refresh a
    // chance to land, then require the count to stay put across a quiet window.
    await new Promise(resolve => setTimeout(resolve, 120))
    const settled = deferred.calls.listProviders
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.ok(deferred.calls.listProviders - settled <= 1, `the retry must stop on dispose (settled=${settled}, after=${deferred.calls.listProviders})`)
  })

  it('task-100 retry e2e: routes first + deferred directory → not-ready-yet, retry continues, then available', async () => {
    // The live boot sequence: routes registered, directory still empty for a
    // few polls. The retry must NOT finalize the empty-directory verdict.
    let directoryPolls = 0
    const surface = runtimeSurface({ route: 'deepseek', models: ['deepseek-flash'], settingsNs: 'deepseek-official', displayName: 'DeepSeek Official' })
    const directoryCount = { polls: 0 }
    const deferred = {
      resolveModelInfo: async (provider: string, model: string) => {
        if (directoryCount.polls < 6) throw new Error('not a route yet')
        return surface.resolveModelInfo(provider, model)
      },
      listProviders: surface.listProviders,
      listConfigurableProviders: () => {
        directoryPolls += 1
        directoryCount.polls = directoryPolls
        if (directoryPolls < 6) return [] as { provider: string; displayName: string }[]
        return surface.listConfigurableProviders()
      },
      listModels: surface.listModels,
      stream: surface.stream,
    }
    const { ctx } = await mountDeclarative({
      llm: deferred,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
      harnessRetry: { intervalMs: 80, capMs: 5_000 },
    })
    const service = ctx.get('modelTools') as unknown as ServiceDescribe
    const first = await service.describe()
    const initial = harnessRequirement(first)
    assert.equal(initial.satisfied, false, 'the first read sees the honest not-ready-yet')
    assert.match(initial.reason, /has not registered its provider routes yet/, 'an incomplete directory is not-ready-yet, not the terminal string')
    // TASK-108: await the OBSERVABLE flip (the requirement becoming satisfied)
    // — the retry keeps polling and does the work on its own interval.
    await waitFor(async () => harnessRequirement(await service.describe()).satisfied, 'the retry to reach available once the directory lands')
    assert.ok(directoryPolls >= 6, 'the flip came from the retry\'s own polling')
    void ctx
  })

  it('task-101: a NON-EMPTY directory missing the provider is transient while retrying, then available when it lands', async () => {
    // The live 0.3.5 shape: the directory has OTHER entries but not
    // deepseek-official yet. The safe rule presents the transient startup
    // blocker (not the terminal string) and keeps polling.
    let directoryPolls = 0
    const surface = runtimeSurface({ route: 'deepseek', models: ['deepseek-flash'], settingsNs: 'deepseek-official', displayName: 'DeepSeek Official' })
    const deferred = {
      resolveModelInfo: async (provider: string, model: string) => {
        if (directoryPolls < 5) throw new Error('not a route yet')
        return surface.resolveModelInfo(provider, model)
      },
      listProviders: surface.listProviders,
      listConfigurableProviders: () => {
        directoryPolls += 1
        // Non-empty from the first poll: ANOTHER provider is already listed.
        const other = { provider: 'pi-ai', displayName: 'Pi AI', settingsNs: 'pi-ai' }
        return directoryPolls < 5 ? [other] : [...surface.listConfigurableProviders(), other]
      },
      listModels: surface.listModels,
      stream: surface.stream,
    }
    const { ctx } = await mountDeclarative({
      llm: deferred,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
      harnessRetry: { intervalMs: 80, capMs: 5_000 },
    })
    const service = ctx.get('modelTools') as unknown as ServiceDescribe
    const first = await service.describe()
    const initial = harnessRequirement(first)
    assert.equal(initial.satisfied, false, 'the first read sees an unsatisfied requirement')
    assert.match(initial.reason, /has not registered its provider routes yet/, 'the transient string, never the terminal unknown-provider one')
    // TASK-108: await the OBSERVABLE flip.
    await waitFor(async () => harnessRequirement(await service.describe()).satisfied, 'the retry to reach available once the entry lands')
    assert.ok(directoryPolls >= 5, 'the flip came from the retry\'s own polling')
    void ctx
  })

  it('task-101: after the cap the REAL not-configured reason is published and polling ends', async () => {
    // The directory is non-empty but never contains the configured provider —
    // the transient presentation must give way to the real verdict at the cap.
    const surface = runtimeSurface({ route: 'deepseek', models: ['deepseek-flash'], settingsNs: 'deepseek-official', displayName: 'DeepSeek Official' })
    const calls = { resolveModelInfo: 0 }
    const never = {
      resolveModelInfo: async (provider: string, model: string) => {
        calls.resolveModelInfo += 1
        throw new Error('unknown provider route')
      },
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listConfigurableProviders: () => [{ provider: 'pi-ai', displayName: 'Pi AI', settingsNs: 'pi-ai' }],
      listModels: surface.listModels,
      stream: surface.stream,
    }
    const { ctx } = await mountDeclarative({
      llm: never,
      settings: { describe: () => [{ ns: 'agent-default-model', autoGenerate: false, schema: null, value: { provider: 'deepseek-official', model: 'deepseek-flash' }, revision: 0, applies: 'live' }] },
      harnessRetry: { intervalMs: 60, capMs: 400 },
    })
    const service = ctx.get('modelTools') as unknown as ServiceDescribe
    const first = await service.describe()
    assert.match(harnessRequirement(first).reason, /has not registered its provider routes yet/, 'transient while retrying')
    // TASK-108: await the OBSERVABLE publication — the REAL verdict appearing
    // once the cap ends the retry.
    await waitFor(async () => /cannot be served: the configured provider "deepseek-official" is not a registered LLM route/.test(harnessRequirement(await service.describe()).reason), 'the cap to publish the real verdict')
    const paused = calls.resolveModelInfo
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(calls.resolveModelInfo - paused <= 1, 'no polling after the cap')
    void ctx
  })

  it('explicit config is never retried or overwritten', async () => {
    const deferred = deferredSurface(0)
    const { ctx } = await mountDeclarative({
      harnessModel: { provider: 'broken-route', model: 'broken-model' },
      llm: deferred.surface,
      harnessRetry: { intervalMs: 50, capMs: 5_000 },
    })
    await new Promise(resolve => setTimeout(resolve, 300))
    // The initial composition probes once (the direct pair fails, then the
    // resolver consults listProviders once); the bounded retry must NOT add
    // any further polls for explicit config.
    assert.ok(deferred.calls.listProviders <= 1, `explicit config must never be retried (listProviders=${deferred.calls.listProviders})`)
    await cleanup()
  })
})
