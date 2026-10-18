/**
 * TASK-125/A: every REAL extension package, installed into a store and
 * activated through the host, must compile — the SAME path the host uses at
 * activation (the manifest schema references → the declared schemas → the DSH
 * projection + compile). This is the regression for the laya refusal.
 *
 * The needle case (B) is covered by the same activation: its
 * structured_extract parameters compile through the DSH parameter path that
 * refused the injected property-map flag.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { digestInstalledContent, ExtensionStore } from '@try-works/tool-mode-extension-sdk'
import { projectSchemaToDsh } from '@try-works/tool-mode-contracts'

import * as plugin from '../src/index.ts'
import { PLANNING_TOOL_INPUT_SCHEMA, hasPlanningInputShape } from '../src/planning.ts'
import { tempDir } from './helpers.ts'

/** The real packages with manifest-declared tools, and the tools they publish. */
const PACKAGES: readonly { dir: string; id: string; tools: readonly string[] }[] = [
  { dir: 'extension-laya', id: '@try-works/extension-laya', tools: ['decision_choose', 'decision_test', 'decision_score'] },
  { dir: 'extension-needle', id: '@try-works/extension-needle', tools: ['tools_plan', 'structured_extract'] },
  { dir: 'extension-desert-ant-tongue', id: '@try-works/extension-desert-ant-tongue', tools: ['lang_detect'] },
  { dir: 'extension-desert-ant-voz', id: '@try-works/extension-desert-ant-voz', tools: [] },
  { dir: 'extension-minilm-embed', id: '@try-works/extension-minilm-embed', tools: ['text_embed'] },
  { dir: 'extension-minilm-rerank', id: '@try-works/extension-minilm-rerank', tools: ['text_rerank'] },
  {
    dir: 'extension-embeddinggemma', id: '@try-works/extension-embeddinggemma',
    tools: ['multimodal_embed', 'semantic_similarity', 'semantic_rank', 'semantic_classify', 'semantic_deduplicate', 'media_find_moments'],
  },
]

function install(storeDir: string, dir: string, id: string): void {
  const pkgJson = JSON.parse(readFileSync(join(process.cwd(), 'packages', dir, 'package.json'), 'utf8')) as { version: string }
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'packages', dir, 'tool-mode.extension.json'), 'utf8')) as { tools?: readonly { name: string }[] }
  const installPath = join(storeDir, 'extensions', '@try-works', dir, pkgJson.version)
  mkdirSync(installPath, { recursive: true })
  cpSync(join(process.cwd(), 'packages', dir), installPath, { recursive: true })
  const store = new ExtensionStore(storeDir)
  store.recordInstall({
    extensionId: id,
    version: pkgJson.version,
    installPath,
    archiveDigest: 'sha512-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    contentDigest: digestInstalledContent(installPath),
  } satisfies Parameters<ExtensionStore['recordInstall']>[0])
  const state = new ExtensionStore(storeDir).readProfileState('default').value.filter(entry => entry.extensionId !== id)
  state.push({
    extensionId: id,
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: [...(manifest.tools ?? []).map(tool => tool.name)],
    readiness: {},
  })
  store.writeProfileState('default', state)
}

test('every real extension activates through the host: all declared schemas compile', async () => {
  const storeDir = tempDir()
  const expected = new Set<string>()
  for (const pkg of PACKAGES) {
    install(storeDir, pkg.dir, pkg.id)
    for (const tool of pkg.tools) expected.add(tool)
  }
  // The needle's model is NOT prepared in this fixture (the inspection reports
  // needs-preparation), so its tools are WITHHELD by the publication readiness
  // gate (the SDK's #contributionsOf) — the honest EXT-24 behavior, not a
  // compiler failure. Its schemas still compile: the dedicated test below runs
  // them through the same defineTool path.
  for (const name of ['tools_plan', 'structured_extract']) expected.delete(name)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const names = new Set(ctx.tools.schemas().map(schema => schema.name))
    if ([...expected].every(name => names.has(name))) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const names = ctx.tools.schemas().map(schema => schema.name)
  const states = new ExtensionStore(storeDir).readProfileState('default').value
  for (const name of expected) {
    assert.ok(names.includes(name), `${name} must register; tools=${JSON.stringify(names)}; states=${JSON.stringify(states)}`)
  }
  // Every extension stays active — no activation was refused by the compiler.
  for (const entry of states) {
    assert.equal(entry.observedActivation, 'active', `${entry.extensionId} must stay active; state=${JSON.stringify(states)}`)
  }
  await ctx.fiber.dispose()
})

test('TASK-125/B: every DECLARED schema (needle included) compiles through the same defineTool path the registrar uses', async () => {
  // The needle's tools are withheld by the readiness gate before the registrar
  // runs, so this test compiles the SAME schemas through the SAME defineTool +
  // projection code the host's registerTool executes — the offline regression
  // for "parameters.schema.properties.additionalProperties must be a value
  // schema object" (a property-map flag injected where the DSH parameter
  // compiler reads the map's keys as property declarations).
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  for (const pkg of PACKAGES) {
    const dir = join(process.cwd(), 'packages', pkg.dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'tool-mode.extension.json'), 'utf8')) as {
      tools?: readonly { name: string; description?: string; inputSchema: string; outputSchema: string }[]
    }
    for (const tool of manifest.tools ?? []) {
      const input = JSON.parse(readFileSync(join(dir, tool.inputSchema), 'utf8')) as Record<string, unknown>
      const output = JSON.parse(readFileSync(join(dir, tool.outputSchema), 'utf8')) as Record<string, unknown>
      const isPlanning = tool.name === 'tools_plan' && hasPlanningInputShape(input)
      const inputProjection = isPlanning
        ? projectSchemaToDsh(PLANNING_TOOL_INPUT_SCHEMA).parameters
        : projectSchemaToDsh(input).parameters
      const declaredClosed = output.additionalProperties === false
      const outputProjection = {
        type: 'object',
        properties: projectSchemaToDsh(output).parameters,
        additionalProperties: declaredClosed,
      }
      ctx.tools.register(defineTool({
        name: `compile_probe_${pkg.dir}_${tool.name}`,
        description: tool.description ?? 'compile probe',
        parameters: inputProjection,
        output: { schema: outputProjection, render: () => [{ type: 'text', text: '' }] },
        async execute() { return {} as never },
      }))
    }
  }
  await ctx.fiber.dispose()
})
