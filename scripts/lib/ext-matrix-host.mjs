/**
 * In-process tool-invocation host for the extension matrix (task-110).
 *
 * WHY THIS EXISTS (the discovered host gap): the live web profile exposes the
 * modelTools LIFECYCLE over the gateway RPC, but it exposes NO browser-free way to
 * INVOKE the contributed tools:
 * - the web/base composition mounts no MCP server (deepseek-harness
 *   packages/bundle/base/cordis.patch.yml has only `mcp-resources`, a client);
 * - the plugin's own headless `serve` is explicitly extension-store-LESS
 *   (packages/dsh-model-as-tool/src/headless.ts:5) and serves the model CATALOG,
 *   not installed extension tools;
 * - the gateway has no generic tool-execute endpoint (only per-controller
 *   namespaces; `ctx.tools.execute` is Agent-runtime internal).
 *
 * This module therefore invokes the REAL registered tools through the REAL host
 * chain (plugin apply → tool runtime → extension dispatch) in a separate process,
 * against a SNAPSHOT of the profile's store: the lock (with its absolute install
 * paths, so the real installed bytes and their materialized runtimes are used) and
 * the profile state copied and rewritten to inactive. The live profile's state is
 * never written, and no extension code is faked.
 *
 * @module scripts/lib/ext-matrix-host
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from './ext-matrix-lib.mjs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ExtensionStore } from '@try-works/tool-mode-extension-sdk'

/**
 * Which plugin build the in-process host runs.
 *
 * DEFAULT: the repository source (hermetic; no developer-local profile, no
 * network, no published artifact). Two EXPLICIT opt-ins:
 *   EXT_MATRIX_PLUGIN  — an absolute module path/URL to import directly.
 *   EXT_MATRIX_PROFILE — a DSH profile name whose INSTALLED package
 *                        (`…/node_modules/@try-works/dsh-model-as-tool/lib/index.js`)
 *                        is the deployment under test.
 * A named error is thrown when the opt-in names a profile with no installed build,
 * rather than silently falling back to source and testing the wrong artifact.
 * @returns {string} the module URL/absolute path to import.
 */
export function pluginModuleHref() {
  if (process.env.EXT_MATRIX_PLUGIN !== undefined && process.env.EXT_MATRIX_PLUGIN !== '') return process.env.EXT_MATRIX_PLUGIN
  if (process.env.EXT_MATRIX_PROFILE !== undefined && process.env.EXT_MATRIX_PROFILE !== '') {
    const installed = join(
      homedir(), '.dsh', 'profiles', process.env.EXT_MATRIX_PROFILE,
      'node_modules', '@try-works', 'dsh-model-as-tool', 'lib', 'index.js',
    )
    if (!existsSync(installed)) {
      throw new Error(
        `EXT_MATRIX_PROFILE=${JSON.stringify(process.env.EXT_MATRIX_PROFILE)} names a profile with no installed plugin build at ${installed}; `
        + 'install the plugin in that profile or unset EXT_MATRIX_PROFILE to run the repository source',
      )
    }
    return pathToFileURL(installed).href
  }
  return new URL('../../packages/dsh-model-as-tool/src/index.ts', import.meta.url).href
}

let pluginPromise
/** Import (once) the plugin module selected by pluginModuleHref(). */
async function loadPlugin() {
  pluginPromise ??= import(pluginModuleHref())
  return pluginPromise
}

let callCounter = 0

/**
 * Build a host-only snapshot of the profile store.
 *
 * The snapshot holds the SDK lock (which points at the REAL install paths), every
 * installed record re-recorded through the SDK, and the profile state rewritten so
 * this process owns activation (`observed/desired: inactive`, readiness preserved).
 * Nothing in the snapshot references the live profile's mutable state.
 * @param {string} profileStoreDir - the live profile's extension store.
 * @param {string} profile - profile name, usually 'default'.
 * @returns {string} the snapshot directory (caller removes it).
 */
export function snapshotStore(profileStoreDir, profile = 'default') {
  const snapshot = mkdtempSync(join(tmpdir(), 'ext-matrix-host-store-'))
  const live = new ExtensionStore(profileStoreDir)
  const target = new ExtensionStore(snapshot)
  const installed = live.listInstalled()
  if (installed.corrupt) throw new Error(`the live store lock is unreadable: ${installed.diagnostic ?? 'unknown reason'}`)
  /**
   * Copy the store's AUXILIARY state read-only from the live profile: the private
   * extension directories (`extension-private/...`, where needle resolves its
   * pinned engine), the runtime sidecar and everything else the host reads. The
   * installed package trees are NOT copied — the lock's absolute install paths are
   * re-recorded below, so this process uses the live installed bytes without a
   * multi-hundred-MB copy and without writing to the live profile.
   */
  const lockName = 'extensions.lock.json'
  for (const entry of readdirSync(profileStoreDir)) {
    if (entry === 'extensions' || entry === '.staging' || entry === lockName) continue
    cpSync(join(profileStoreDir, entry), join(snapshot, entry), { recursive: true })
  }
  /**
   * A store can hold several versions of one extension after an upgrade. The live
   * host's describe and this harness must agree on the ACTIVE one; keep only the
   * highest version per id in the snapshot so dispatch never resolves a stale
   * version through first-match lookup.
   */
  const highest = new Map()
  for (const record of installed.value) {
    const current = highest.get(record.extensionId)
    if (current === undefined || compareVersions(record.version, current.version) > 0) highest.set(record.extensionId, record)
  }
  for (const record of highest.values()) target.recordInstall(record)
  const states = live.readProfileState(profile)
  if (!states.corrupt && states.value.length > 0) {
    target.writeProfileState(profile, states.value.map(state => ({
      extensionId: state.extensionId,
      installation: 'installed',
      desiredActivation: 'inactive',
      observedActivation: 'inactive',
      readiness: state.readiness ?? {},
      tools: state.tools ?? [],
      export: 'not-exported',
    })))
  }
  return snapshot
}

/**
 * Mount the shipping host stack on a store snapshot.
 * @param {object} options - {storeDir, profile?}.
 * @returns {Promise<{ctx: Context, service: any, invoke: Function, dispose: Function}>}
 */
export async function mountHost(options) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const plugin = await loadPlugin()
  await ctx.plugin(plugin, {
    extensionStore: options.storeDir,
    installSource: 'directory',
    allowSourceDirectories: true,
    allowExecutablePreparation: true,
    // The path broker approves only configured roots; the fixture dir carries the
    // typed-media files this harness invokes with.
    approvedRoots: options.approvedRoots ?? [],
    /**
     * The matrix exercises EXTENSION tools. The catalogue would register the same
     * standard-contract names (lang_detect, stt_transcribe) before activation: the
     * task-117 ownership deferral requires the extension to be ACTIVE in the store
     * state, and this snapshot rewrites activation to inactive so the host owns it.
     * An unreachable allowlist entry keeps the catalogue surface empty. NOTE the
     * consequence: implementation-only extensions (minilm text.embed/text.rerank)
     * are not registered by this host at all — a host gap the harness reports by
     * name, never as a fabricated pass.
     */
    models: ['__ext_matrix_no_catalog__'],
    stateFile: join(options.storeDir, 'matrix-host-state.json'),
  })
  const service = ctx.get('modelTools')
  if (service === undefined) throw new Error('the plugin mounted no modelTools service')
  const signal = new AbortController().signal
  return {
    ctx,
    service,
    /** The host-composed services this harness relies on (precondition reporting). */
    services: {
      modelTools: typeof service === 'object',
      // Planning composition cannot be introspected before activation; report the
      // registered tool after activation instead (runToolBatch.services).
      agentTurnContext: false,
    },
    /**
     * Invoke one registered tool through the real tool runtime + extension dispatch.
     * @param {string} name - tool name (e.g. lang_detect).
     * @param {unknown} args - tool arguments.
     * @returns {Promise<unknown>} the tool result object.
     */
    async invoke(name, args) {
      return ctx.tools.execute({
        signal,
        callId: ToolCallId(`matrix-${++callCounter}`),
        name,
        arguments: args,
      })
    },
    /** Whether the live registry currently holds a tool by this name. */
    hasTool(name) {
      return ctx.tools.get(name) !== undefined
    },
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Invoke a list of tools on the shipping host over a store snapshot.
 *
 * The selected extensions are ENABLED in this process (their prepared readiness is
 * carried by the copied profile state) before any call; a disabled/failed
 * activation is reported for the caller's matrix, never hidden.
 * @param {object} options - {storeDir, profile?, extensions: string[], calls: {extension, toolName, args}[]}.
 * @returns {Promise<{activation: object[], calls: object[]}>} raw results.
 */
export async function runToolBatch(options) {
  const snapshot = snapshotStore(options.storeDir, options.profile ?? 'default')
  const results = { activation: [], calls: [], missingTools: [], services: {} }
  let host
  try {
    host = await mountHost({ storeDir: snapshot, approvedRoots: options.approvedRoots ?? [] })
    for (const id of options.extensions) {
      try {
        /**
         * Activation only. The caller's LIVE lifecycle phase prepared the assets,
         * and the snapshot carries that readiness; preparing inside this process is
         * deliberately avoided because the host's preparation probe performs an
         * activation attempt whose published contributions cannot be safely retried
         * in the same runtime (a second enable would double-register its tools).
         */
        const enabled = await host.service.enable(id)
        results.activation.push({ extension: id, ok: enabled?.active === true, detail: enabled?.active === true ? 'active' : 'enable returned inactive' })
      } catch (error) {
        results.activation.push({ extension: id, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
    }
    /**
     * The composed-services precondition report: what the snapshot host actually
     * has. An absent service must become a NAMED skip/precondition in the report,
     * never a silent empty tool result.
     */
    results.services = {
      modelTools: typeof host.service === 'object',
      agentTurnContext: false,
      registeredTools: [...new Set(options.calls.map(call => call.toolName))].filter(name => host.hasTool(name)),
      planningTool: host.hasTool('tools_plan'),
    }
    for (const call of options.calls) {
      const activation = results.activation.find(entry => entry.extension === call.extension)
      if (activation?.ok !== true) {
        results.calls.push({ ...call, ok: false, error: `extension did not activate: ${activation?.detail ?? 'not attempted'}` })
        continue
      }
      // Harness preflight: never mistake an unmapped invocation id for a product
      // failure. The host must actually register the name before we call it.
      if (!host.hasTool(call.toolName)) {
        results.missingTools.push({ extension: call.extension, id: call.id, toolName: call.toolName })
        results.calls.push({ ...call, ok: false, error: `the host registered no tool named ${JSON.stringify(call.toolName)} (harness invocation mapping)` })
        continue
      }
      try {
        results.calls.push({ ...call, ok: true, result: await host.invoke(call.toolName, call.args) })
      } catch (error) {
        results.calls.push({ ...call, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    if (host !== undefined) await host.dispose()
    rmSync(snapshot, { recursive: true, force: true })
  }
  return results
}
