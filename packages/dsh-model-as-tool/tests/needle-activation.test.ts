/**
 * TASK-128: the needle planning-shape regression. Two halves:
 *
 * 1. (env-gated) the REAL needle package, activated with the REAL pinned
 *    artifacts through the env route, registers BOTH tools — the planning
 *    shape is seen by the NDL-02 validator and tools_plan is served by the
 *    planning pipeline, never refused.
 * 2. (always on) an unreadable package (a moved store / stale lock path) is
 *    reported with the REAL reason — "cannot be read" — never the misleading
 *    NDL-02 "must declare the planning input shape", which was the live
 *    failure's mask.
 */

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { digestInstalledContent, ExtensionStore } from '@try-works/tool-mode-extension-sdk'

import * as plugin from '../src/index.ts'
import { tempDir } from './helpers.ts'

const NEEDLE_ID = '@try-works/extension-needle'

/** The real pinned artifacts through the env route, when present on this host. */
function pinnedArtifacts(): { engine: string; weights: string } | undefined {
  const engine = process.env.NEEDLE_EXTENSION_ENGINE
  const weights = process.env.NEEDLE_EXTENSION_WEIGHTS
  if (engine === undefined || weights === undefined) return undefined
  try {
    if (statSync(engine).size === 0 || statSync(weights).size === 0) return undefined
  } catch {
    return undefined
  }
  return { engine, weights }
}

function installNeedle(storeDir: string, options: { removeSchemaDir?: boolean } = {}): string {
  const installPath = join(storeDir, 'extensions', '@try-works', 'extension-needle', '0.1.2')
  mkdirSync(installPath, { recursive: true })
  cpSync(join(process.cwd(), 'packages', 'extension-needle'), installPath, { recursive: true })
  if (options.removeSchemaDir === true) {
    rmSync(join(installPath, 'schema'), { recursive: true, force: true })
  }
  const store = new ExtensionStore(storeDir)
  store.recordInstall({
    extensionId: NEEDLE_ID,
    version: '0.1.2',
    installPath,
    archiveDigest: 'sha512-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    contentDigest: digestInstalledContent(installPath),
  } satisfies Parameters<ExtensionStore['recordInstall']>[0])
  store.writeProfileState('default', [{
    extensionId: NEEDLE_ID,
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: ['tools_plan', 'structured_extract'],
    readiness: {},
  }])
  return installPath
}

test('the REAL needle activates with the planning shape seen (env-gated on the pinned artifacts)', { skip: pinnedArtifacts() === undefined ? 'set NEEDLE_EXTENSION_ENGINE and NEEDLE_EXTENSION_WEIGHTS to the pinned artifacts to run' : false }, async () => {
  const storeDir = tempDir()
  installNeedle(storeDir)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
  })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && ctx.tools.schemas().every(schema => schema.name !== 'tools_plan')) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const names = ctx.tools.schemas().map(schema => schema.name)
  assert.ok(names.includes('tools_plan'), `tools_plan must register (the NDL-02 shape is seen); tools=${JSON.stringify(names)}`)
  assert.ok(names.includes('structured_extract'), 'structured_extract must register')
  const state = new ExtensionStore(storeDir).readProfileState('default').value[0]
  assert.equal(state?.observedActivation, 'active', 'the needle stays active')
  await ctx.fiber.dispose()
})

test('an unreadable package is reported honestly, never as the NDL-02 planning-shape refusal', async () => {
  const storeDir = tempDir()
  installNeedle(storeDir, { removeSchemaDir: true })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {
    stateFile: join(storeDir, 'state.json'),
    credentialsFile: join(storeDir, 'credentials.json'),
    extensionStore: storeDir,
  })
  // The boot restore refuses the tools with the REAL reason; the enable path
  // surfaces the same message. A moved store / stale lock path must never be
  // reported as "must declare the planning input shape".
  const service = ctx.get('modelTools') as unknown as { enable: (id: string) => Promise<unknown> }
  const failure = await service.enable(NEEDLE_ID).then(
    () => undefined,
    error => error as Error,
  )
  const message = failure === undefined ? '' : failure.message
  assert.match(message, /cannot be read|does not ship|not a usable extension/, `the honest reason must name the unreadable package; got: ${message}`)
  assert.doesNotMatch(message, /must declare the planning input shape/, 'the NDL-02 refusal must not mask a package read failure')
  await ctx.fiber.dispose()
})
