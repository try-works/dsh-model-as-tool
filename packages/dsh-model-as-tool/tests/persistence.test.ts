/**
 * Persistence tests: an enable/disable must outlive the session that made it.
 *
 * The durable case is tested by mounting the plugin TWICE against the same
 * state file — a second mount is what a restart looks like from the plugin's
 * point of view, so a passing test here is the difference between a remembered
 * choice and a session-scoped one.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'
import {
  createFileStateStore,
  createMemoryStateStore,
  defaultStateFile,
  parseState,
  resolveSelection,
  withChoice,
  StateError,
  EMPTY_STATE,
} from '../src/state.ts'

const signal = new AbortController().signal
let counter = 0

const tempDirs: string[] = []
function tempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-tools-test-'))
  tempDirs.push(dir)
  return join(dir, 'state.json')
}

const contexts: Context[] = []
after(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Mount the plugin the way a fresh process would. */
async function mount(config: plugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, config)
  contexts.push(ctx)
  return ctx
}

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`state-${++counter}`),
    name,
    arguments: args,
  })
}

const hasTool = (ctx: Context, tool: string) => ctx.tools.schemas().some(entry => entry.name === tool)

describe('state — pure merge rules', () => {
  it('keeps the two lists mutually exclusive', () => {
    let state = withChoice(EMPTY_STATE, 'voz', true)
    assert.deepEqual(state, { enabled: ['voz'], disabled: [] })
    // Disabling the same model must not leave it in both lists.
    state = withChoice(state, 'voz', false)
    assert.deepEqual(state, { enabled: [], disabled: ['voz'] })
    state = withChoice(state, 'voz', true)
    assert.deepEqual(state, { enabled: ['voz'], disabled: [] })
  })

  it('lets a disabled model win over the configured selection', () => {
    const { install, disabled } = resolveSelection(['tongue', 'voz'], { enabled: [], disabled: ['voz'] })
    assert.deepEqual([...install], ['tongue'])
    assert.deepEqual([...disabled], ['voz'])
  })

  it('adds a user-enabled model to the configured selection', () => {
    const { install } = resolveSelection(['tongue'], { enabled: ['voz'], disabled: [] })
    assert.deepEqual([...install].sort(), ['tongue', 'voz'])
  })

  it('rejects a malformed state document', () => {
    assert.throws(() => parseState([], 'test'), StateError)
    assert.throws(() => parseState({ enabled: 'tongue' }, 'test'), /must be an array of model ids/)
    assert.throws(() => parseState({ enabled: [1] }, 'test'), /must be an array of model ids/)
    assert.deepEqual(parseState({}, 'test'), { enabled: [], disabled: [] })
  })

  it('derives the default state file from DSH_HOME, falling back to ~/.dsh', () => {
    assert.equal(defaultStateFile({ DSH_HOME: 'C:/dsh' }), join('C:/dsh', 'model-as-tool', 'state.json'))
    assert.match(defaultStateFile({}), /model-as-tool[\\/]state\.json$/)
  })
})

describe('state — file store', () => {
  it('round-trips through disk, deduplicating and sorting', () => {
    const file = tempStateFile()
    const store = createFileStateStore(file)
    assert.deepEqual(store.read(), EMPTY_STATE, 'an absent file reads as empty')

    store.write({ enabled: ['voz', 'tongue', 'voz'], disabled: ['emo'] })
    assert.deepEqual(store.read(), { enabled: ['tongue', 'voz'], disabled: ['emo'] })
  })

  it('leaves no temporary file behind', () => {
    const file = tempStateFile()
    createFileStateStore(file).write({ enabled: ['tongue'], disabled: [] })
    assert.equal(existsSync(`${file}.tmp`), false)
  })

  it('surfaces a corrupt file instead of silently forgetting the user choices', () => {
    const file = tempStateFile()
    writeFileSync(file, '{ not json', 'utf8')
    assert.throws(() => createFileStateStore(file).read(), StateError)
  })

  it('an in-memory store never touches disk', () => {
    const store = createMemoryStateStore()
    store.write({ enabled: ['tongue'], disabled: [] })
    assert.deepEqual(store.read(), { enabled: ['tongue'], disabled: [] })
  })
})

describe('plugin — persistence across restarts', () => {
  it('remembers an enable in a second mount', async () => {
    const stateFile = tempStateFile()

    // Session one: nothing selected by config, user enables Tongue.
    const first = await mount({ models: ['title'], stateFile })
    assert.equal(hasTool(first, 'lang_detect'), false)
    const enabled = await call(first, 'model_tools', { action: 'enable', model: 'tongue' })
    assert.equal(enabled.isError, false)
    if (enabled.isError) throw new Error('expected success')
    assert.equal((enabled.value as { persisted: boolean }).persisted, true)
    assert.ok(hasTool(first, 'lang_detect'))

    // Session two: same config, same state file — the choice must survive.
    const second = await mount({ models: ['title'], stateFile })
    assert.ok(hasTool(second, 'lang_detect'), 'the remembered enable must survive a restart')

    // And the stored document says so.
    const stored = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.deepEqual(stored, { enabled: ['tongue'], disabled: [] })
  })

  it('remembers a disable in a second mount', async () => {
    const stateFile = tempStateFile()

    // Session one: config selects Tongue, user turns it off.
    const first = await mount({ stateFile })
    assert.ok(hasTool(first, 'lang_detect'))
    await call(first, 'model_tools', { action: 'disable', model: 'tongue' })
    assert.equal(hasTool(first, 'lang_detect'), false)

    // Session two: the config still selects it, the user's choice still wins.
    const second = await mount({ stateFile })
    assert.equal(hasTool(second, 'lang_detect'), false, 'the remembered disable must survive a restart')
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).disabled[0], 'tongue')
  })

  it('reports the remembered choice per model', async () => {
    const stateFile = tempStateFile()
    const ctx = await mount({ models: ['title'], stateFile })
    await call(ctx, 'model_tools', { action: 'enable', model: 'tongue' })
    await call(ctx, 'model_tools', { action: 'disable', model: 'voz' })

    const listed = await call(ctx, 'model_tools', { action: 'list' })
    if (listed.isError) throw new Error('expected success')
    const models = (listed.value as { models: { id: string; choice: string }[] }).models
    assert.equal(models.find(model => model.id === 'tongue')?.choice, 'enabled')
    assert.equal(models.find(model => model.id === 'voz')?.choice, 'disabled')
    assert.equal(models.find(model => model.id === 'title')?.choice, 'none')
  })

  it('reset forgets the choice and re-applies the configuration', async () => {
    const stateFile = tempStateFile()
    const first = await mount({ stateFile })
    await call(first, 'model_tools', { action: 'disable', model: 'tongue' })
    assert.equal(hasTool(first, 'lang_detect'), false)

    const reset = await call(first, 'model_tools', { action: 'reset', model: 'tongue' })
    assert.equal(reset.isError, false)
    // Reset takes effect immediately, not only after a restart.
    assert.ok(hasTool(first, 'lang_detect'))

    // And it is durable: a second mount still has the config's selection.
    const second = await mount({ stateFile })
    assert.ok(hasTool(second, 'lang_detect'))
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { enabled: [], disabled: [] })
  })

  it('does not persist a choice that failed to take effect', async () => {
    const stateFile = tempStateFile()
    const ctx = await mount({ stateFile })
    // Title cannot run on this host, so the enable fails...
    const failed = await call(ctx, 'model_tools', { action: 'enable', model: 'title' })
    assert.equal(failed.isError, true)
    // ...and nothing may be written, or the next start would install it silently.
    if (existsSync(stateFile)) {
      assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { enabled: [], disabled: [] })
    }
  })

  it('keeps choices session-scoped when persistence is off', async () => {
    const stateFile = tempStateFile()
    const first = await mount({ models: ['title'], stateFile, persist: false })
    const enabled = await call(first, 'model_tools', { action: 'enable', model: 'tongue' })
    assert.equal(enabled.isError, false)
    if (enabled.isError) throw new Error('expected success')
    assert.equal((enabled.value as { persisted: boolean }).persisted, false)
    assert.ok(hasTool(first, 'lang_detect'))
    assert.equal(existsSync(stateFile), false, 'nothing should be written when persistence is off')

    const second = await mount({ models: ['title'], stateFile, persist: false })
    assert.equal(hasTool(second, 'lang_detect'), false)
  })

  it('applies a persisted enable even when it cannot run yet, without registering it', async () => {
    const stateFile = tempStateFile()
    // A hand-written state naming a model this host cannot run.
    writeFileSync(stateFile, JSON.stringify({ enabled: ['title'], disabled: [] }), 'utf8')
    const ctx = await mount({ stateFile })
    assert.equal(hasTool(ctx, 'suggest_title'), false, 'an unrunnable model must not register a tool')

    const listed = await call(ctx, 'model_tools', { action: 'describe', model: 'title' })
    if (listed.isError) throw new Error('expected success')
    const model = (listed.value as { models: { installed: boolean; choice: string }[] }).models[0]
    assert.equal(model?.installed, false)
    assert.equal(model?.choice, 'enabled', 'the choice is kept for when a route appears')
  })
})
