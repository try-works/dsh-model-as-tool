/**
 * End-to-end demonstration against a REAL Cordis context: mounts the plugin,
 * prints what it registered and why, then runs both working models through the
 * shipping tool pipeline.
 *
 * Usage: node --import tsx scripts/demo.ts
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../packages/dsh-model-tools/src/index.ts'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(SkillRegistry)
await ctx.plugin(plugin, {})

const signal = new AbortController().signal
let counter = 0
const call = (name: string, args: unknown) => ctx.tools.execute({
  signal,
  callId: ToolCallId(`demo-${++counter}`),
  name,
  arguments: args,
})
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.filter(b => b.type === 'text').map(b => b.text).join('')

console.log('=== registered tools ===')
console.log(ctx.tools.schemas().map(schema => schema.name).join(', '))

console.log('\n=== model_tools list ===')
const list = await call('model_tools', { action: 'list' })
console.log(text(list))

console.log('\n=== lang_detect (real inference) ===')
for (const input of ['kann ich das haben', 'Bonjour, comment allez-vous?', '这是一个中文句子', 'Hello there']) {
  const result = await call('lang_detect', { text: input, top: 2 })
  console.log(`${JSON.stringify(input).padEnd(30)} -> ${text(result).split('\n')[0]}`)
}

console.log('\n=== transcribe_audio (Voz, through the plugin) ===')
const started = Date.now()
const transcribed = await call('transcribe_audio', { audio_path: 'spike/tone.wav' })
console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s  isError=${transcribed.isError}`)
console.log(text(transcribed).slice(0, 300))

console.log('\n=== skills published ===')
const skills = await ctx.skills.list({ cwd: process.cwd() })
for (const skill of skills) console.log(`- ${skill.name}: ${skill.description}`)

console.log('\n=== skill body sample (desert-ant-tongue) ===')
const tongue = await ctx.skills.get('desert-ant-tongue', { cwd: process.cwd() })
console.log((tongue?.content ?? '(missing)').split('\n').slice(0, 26).join('\n'))

await ctx.fiber.dispose()
