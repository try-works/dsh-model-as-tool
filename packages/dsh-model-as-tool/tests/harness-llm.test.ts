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
import { buildHarnessLlmProvider } from '../src/harness-llm.ts'
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
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
    ...options.harnessModel === undefined ? {} : { harnessModel: options.harnessModel },
  })
  return { ctx, storeDir }
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
})
