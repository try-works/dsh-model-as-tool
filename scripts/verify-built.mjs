/**
 * Verify the BUILT artifact — `lib/index.js`, resolved through the package's own
 * `main`, under plain Node with no TypeScript loader.
 *
 * This is the thing DSH actually loads when the bundle is installed, so it is
 * the only artifact whose behaviour proves the plugin is installable. The TS
 * sources passing under tsx proves nothing about it.
 *
 * Usage: node scripts/verify-built.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

// Resolve the entry point the way the DSH loader does: read the package's own
// `main`, exactly as Node's resolver would for an installed dependency. The
// package is located by path rather than through node_modules, because linking
// it there would make npm prune the model packages it depends on.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/dsh-model-tools')
const packageJsonPath = join(packageDir, 'package.json')
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const entryPoint = join(packageDir, manifest.main)
console.log(`package:    ${packageJsonPath}`)
console.log(`main:       ${entryPoint}`)
// Prove the declared entry point is also what the `exports` map advertises.
const advertised = manifest.exports?.['.']?.default
if (advertised !== `./${manifest.main}`) {
  throw new Error(`exports["."].default (${advertised}) disagrees with main (${manifest.main})`)
}

const plugin = await import(pathToFileURL(entryPoint).href)
console.log(`exports:    ${Object.keys(plugin).sort().join(', ')}`)
if (typeof plugin.apply !== 'function') throw new Error('the built package does not export apply()')
// A schemastery schema is callable, so it is a function or an object — never absent.
if (plugin.Config === undefined) throw new Error('the built package does not export Config')

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(SkillRegistry)
await ctx.plugin(plugin, {})

const names = ctx.tools.schemas().map(schema => schema.name)
console.log(`tools:      ${names.join(', ')}`)

const signal = new AbortController().signal
let counter = 0
const call = (name, args) => ctx.tools.execute({
  signal,
  callId: ToolCallId(`built-${++counter}`),
  name,
  arguments: args,
})
const text = result => result.content.filter(b => b.type === 'text').map(b => b.text).join('')

// A real inference through the built artifact.
const detected = await call('lang_detect', { text: 'kann ich das haben' })
if (detected.isError) throw new Error(`lang_detect failed: ${detected.error.message}`)
const language = detected.value.language
console.log(`inference:  "kann ich das haben" -> ${language}`)
if (language !== 'de') throw new Error(`expected de, got ${language}`)

// The control surface, including the install flow.
const list = await call('model_tools', { action: 'list' })
if (list.isError) throw new Error(`model_tools failed: ${list.error.message}`)
console.log(`catalog:    ${list.value.models.length} models, ${list.value.runnable} runnable, ${list.value.installed} installed`)

const describe = await call('model_tools', { action: 'describe', model: 'title' })
if (describe.isError) throw new Error('describe failed')
console.log(`title:      runnable=${describe.value.models[0].runnable} route=${describe.value.models[0].route}`)

// Skills published from the built artifact.
const skills = await ctx.skills.list({ cwd: process.cwd() })
console.log(`skills:     ${skills.map(skill => skill.name).join(', ')}`)
if (!skills.some(skill => skill.name === 'desert-ant-tongue')) throw new Error('skill missing')

await ctx.fiber.dispose()
console.log('\nOK — the built artifact loads through package main and works under plain Node.')
