/**
 * Shared test harness.
 *
 * Every test mounts the plugin through {@link mountPlugin}, which always points
 * the durable state at a throwaway directory. That is not a convenience: the
 * plugin writes the user's enable/disable choices into `DSH_HOME` by default, so
 * a test that forgets to isolate would edit the developer's real configuration —
 * and a later test would then read those edits as if the user had made them.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'

/** Process-wide cancellation signal for tool calls made by tests. */
export const testSignal = new AbortController().signal

const tempDirs: string[] = []
const contexts: Context[] = []
let callCounter = 0

/** A fresh directory that is removed when the process exits. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-as-tool-test-'))
  tempDirs.push(dir)
  return dir
}

/** A fresh state file inside its own throwaway directory. */
export function isolatedStateFile(): string {
  return join(tempDir(), 'state.json')
}

/**
 * Mount the plugin on a real context with the shipping service stack.
 *
 * `stateFile` is always set: an explicit value in `config` wins, otherwise each
 * mount gets its own throwaway file.
 * @param config - plugin configuration; `stateFile` defaults to an isolated path.
 * @returns the mounted context.
 */
export async function mountPlugin(config: plugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, { stateFile: isolatedStateFile(), ...config })
  contexts.push(ctx)
  return ctx
}

/** Invoke a registered tool through the real registry pipeline. */
export function callTool(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`test-${++callCounter}`),
    name,
    arguments: args,
  })
}

/** Concatenate the text blocks of a tool result. */
export function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Dispose every mounted context and delete every throwaway directory. */
export async function cleanup(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
