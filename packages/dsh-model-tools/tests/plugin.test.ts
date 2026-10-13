/**
 * Boots the plugin on a REAL Cordis context with the shipping tool and skill
 * registries, then drives the registered tools through `ctx.tools.execute` —
 * only the plugin under test is ours; the registry, the prompt service and the
 * skill registry are the shipping code.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'

const signal = new AbortController().signal
let callCounter = 0

/** Mount the plugin on a real context carrying the shipping service stack. */
async function setup(config: plugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, config)
  return ctx
}

/** Invoke a registered tool through the real registry pipeline. */
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

/** Concatenate the text blocks of a tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('dsh-model-tools', () => {
  const contexts: Context[] = []
  after(async () => {
    for (const ctx of contexts.splice(0)) {
      // A context disposed by its own test is already unloaded; dispose is
      // idempotent, so the shared cleanup can call it unconditionally.
      await ctx.fiber.dispose()
    }
  })
  const mount = async (config: plugin.Config = {}): Promise<Context> => {
    const ctx = await setup(config)
    contexts.push(ctx)
    return ctx
  }

  it('registers lang_detect for Tongue, which can run on this machine', async () => {
    const ctx = await mount()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'lang_detect')
    assert.ok(schema, 'lang_detect should be registered')
    const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    assert.deepEqual(Object.keys(properties), ['text', 'top'])
  })

  it('registers the model_tools control tool', async () => {
    const ctx = await mount()
    assert.ok(ctx.tools.schemas().some(entry => entry.name === 'model_tools'))
  })

  it('detects language through the real tool pipeline', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'lang_detect', { text: 'kann ich das haben' })
    assert.equal(result.isError, false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as { language: string; candidates: unknown[] }
    assert.equal(value.language, 'de')
    assert.ok(Array.isArray(value.candidates) && value.candidates.length > 0)
    assert.match(text(result), /de/)
  })

  it('detects a non-latin script correctly', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'lang_detect', { text: '这是一个中文句子' })
    if (result.isError) throw new Error('expected success')
    assert.equal((result.value as { language: string }).language, 'zh')
  })

  it('reports every catalogued model and why the unavailable ones cannot run', async () => {
    const ctx = await mount()
    const result = await call(ctx, 'model_tools', { action: 'list' })
    if (result.isError) throw new Error('expected success')
    const value = result.value as {
      models: { id: string; runnable: boolean; reason: string; tool: string }[]
      runnable: number
    }
    assert.ok(value.models.length >= 18, `expected the full catalog, got ${value.models.length}`)
    const tongue = value.models.find(model => model.id === 'tongue')
    assert.equal(tongue?.runnable, true)
    // A model with no Windows runtime must explain itself rather than vanish.
    const redact = value.models.find(model => model.id === 'redact')
    assert.equal(redact?.runnable, false)
    assert.match(redact?.reason ?? '', /win32|not installed|no prebuilt/i)
  })

  it('describe returns one model by id and rejects an unknown one', async () => {
    const ctx = await mount()
    const ok = await call(ctx, 'model_tools', { action: 'describe', model: 'tongue' })
    if (ok.isError) throw new Error('expected success')
    assert.equal((ok.value as { models: unknown[] }).models.length, 1)

    const bad = await call(ctx, 'model_tools', { action: 'describe', model: 'nope' })
    assert.equal(bad.isError, true)
  })

  it('publishes a skill per registered tool, with routing metadata', async () => {
    const ctx = await mount()
    const skills = await ctx.skills.list({ cwd: process.cwd() })
    const tongue = skills.find(entry => entry.name === 'desert-ant-tongue')
    assert.ok(tongue, 'desert-ant-tongue should be published')
    assert.ok(tongue.description.length > 0)

    const definition = await ctx.skills.get('desert-ant-tongue', { cwd: process.cwd() })
    assert.ok(definition)
    // The body must actually teach usage, not just restate the summary.
    assert.match(definition.content, /## When to use/)
    assert.match(definition.content, /## When not to use/)
    assert.match(definition.content, /## Workflow/)
    assert.match(definition.content, /lang_detect/)
    assert.match(definition.content, /Source-Available License/)
  })

  it('honours an explicit model allowlist', async () => {
    const only = await mount({ models: ['tongue'] })
    assert.ok(only.tools.schemas().some(entry => entry.name === 'lang_detect'))

    // An allowlist naming only a model that cannot run registers no model tool.
    const none = await mount({ models: ['title'] })
    assert.equal(none.tools.schemas().some(entry => entry.name === 'lang_detect'), false)
    assert.equal(none.tools.schemas().some(entry => entry.name === 'suggest_title'), false)
    // The control tool is independent of the model selection.
    assert.ok(none.tools.schemas().some(entry => entry.name === 'model_tools'))
  })

  it('honours the exclude list', async () => {
    const ctx = await mount({ exclude: ['tongue'] })
    assert.equal(ctx.tools.schemas().some(entry => entry.name === 'lang_detect'), false)
  })

  it('can omit the control tool and skills', async () => {
    const ctx = await mount({ registerControlTool: false, registerSkills: false })
    assert.equal(ctx.tools.schemas().some(entry => entry.name === 'model_tools'), false)
    assert.ok(ctx.tools.schemas().some(entry => entry.name === 'lang_detect'))
    const skills = await ctx.skills.list({ cwd: process.cwd() })
    assert.equal(skills.some(entry => entry.name === 'desert-ant-tongue'), false)
  })

  it('drops its registrations when the plugin fiber is disposed', async () => {
    const root = new Context()
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)
    await root.plugin(SkillRegistry)
    // `ctx.plugin()` resolves to the plugin's own Fiber; disposing it must lift
    // only what the plugin registered, leaving the service stack readable.
    const fiber = await root.plugin(plugin, {})
    assert.ok(root.tools.schemas().some(entry => entry.name === 'lang_detect'))
    assert.ok(root.tools.schemas().some(entry => entry.name === 'model_tools'))

    await fiber.dispose()

    assert.equal(root.tools.schemas().some(entry => entry.name === 'lang_detect'), false)
    assert.equal(root.tools.schemas().some(entry => entry.name === 'model_tools'), false)

    await root.fiber.dispose()
  })
})
