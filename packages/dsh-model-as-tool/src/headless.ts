/**
 * The REAL headless `serve` composition entry (RUN-03, task-74).
 *
 * Composes the host services the plugin needs WITHOUT the DSH CLI context:
 * config load (file/env), the extension-store-less operator surface, the model
 * catalog with capability resolution, the standard-contract bindings with the
 * SAME selection rule the plugin applies (providers override, else the first
 * eligible implementation), the MCP host over those bindings plus `model_tools`
 * and the `tool_mode_run` contract, and a bounded graceful shutdown on
 * SIGINT/SIGTERM.
 *
 * Two boundaries are deliberate and named, not faked:
 * - `tool_mode_run` is REGISTERED (its contract appears on tools/list) but its
 *   execution refuses: a headless process composes no DSH hosted-code runtime
 *   (the plugin's ProgramRunner needs the DSH PtcHostContext), and pretending
 *   otherwise would claim a confinement the deployment does not have.
 * - Extension-routed models resolve through the same bridge as the plugin; a
 *   model the headless deployment cannot run simply has no tool, exactly like
 *   the plugin.
 *
 * @module @try-works/dsh-model-as-tool/headless
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STANDARD_CONTRACTS, type ToolContract } from '@try-works/tool-mode-contracts'
import {
  assertValidContract,
  assertValidInput,
  assertValidOutput,
  crossFieldRules,
  type ToolMeta,
} from '@try-works/tool-mode-contracts'
import { createGrant, authorizeTool, createInvocationAuthority } from './authority.ts'
import { buildMeta, buildReceipt, type ContractBinding, type HostIdentity } from './bindings.ts'
import { DEFAULT_CATALOG_FILE, loadCatalog } from './catalog.ts'
import type { ModelCatalogEntry } from './types.ts'
import { resolveCapability, type ResolvedModel } from './capability.ts'
import { toContractPayload, toNativeArgs } from './contract-payload.ts'
import { createAdapter } from './adapters/index.ts'
import { ProviderBridge } from './provider-bridge.ts'
import { assertConfigV3DisabledFlags, describeModels, repairCeilingOf } from './index.ts'
import { TOOL_MODE_RUN_CONTRACT } from './tool-mode-run.ts'
import { createMcpHost, type PublishedTool } from './mcp/host-binding.ts'
import { startHttpServer, type BoundEndpoint } from './mcp/http.ts'
import { commandExists } from './transport.ts'

/** The headless config document (the same Config surface, parsed loosely). */
interface HeadlessConfig {
  readonly catalogFile?: string
  readonly allowNpm?: boolean
  readonly providers?: Record<string, string>
  readonly grantId?: string
  readonly recordReceipts?: boolean
  readonly approvedRoots?: string[]
  readonly cli?: { enabled?: boolean; command?: string }
  readonly remote?: { endpoint?: string; token?: string }
  readonly registerControlTool?: boolean
  readonly mcpV3?: { host?: string; port?: number; path?: string }
  readonly repairAttempts?: number
  readonly harnessExecutorV3?: { defaultRepairAttempts?: number }
  readonly [key: string]: unknown
}

/** A named headless-configuration error. */
export class HeadlessConfigError extends Error {
  override readonly name = 'HeadlessConfigError'
}

/** Read and validate the headless config document. */
export function readHeadlessConfig(configPath: string | undefined, env: NodeJS.ProcessEnv): {
  config: HeadlessConfig
  path: string
} {
  const target = configPath ?? env.DSH_TOOL_MODE_CONFIG ?? './tool-mode.json'
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    throw new HeadlessConfigError(
      `the config file ${target} could not be read: ${error instanceof Error ? error.message : String(error)}. `
      + 'serve requires a config (--config <path> or DSH_TOOL_MODE_CONFIG).',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new HeadlessConfigError(`the config file ${target} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HeadlessConfigError(`the config file ${target} is not a JSON object`)
  }
  const config = parsed as HeadlessConfig
  // The same fixed-false gate the plugin applies: unsupported values REFUSE.
  try {
    assertConfigV3DisabledFlags(config as never)
  } catch (error) {
    throw new HeadlessConfigError(error instanceof Error ? error.message : String(error))
  }
  // The CODE-11 repair ceiling validates here too: the flat `repairAttempts`
  // key drives, the v3 nested spelling is its equivalent, and an out-of-range
  // value refuses at config load rather than silently clamping.
  try {
    repairCeilingOf(config as never)
  } catch (error) {
    throw new HeadlessConfigError(error instanceof Error ? error.message : String(error))
  }
  return { config, path: resolve(target) }
}

/** Resolve the contract bindings exactly like the plugin's selection rule. */
function resolveBindings(config: HeadlessConfig): Map<string, ContractBinding> {
  const entries: ModelCatalogEntry[] = loadCatalog(config.catalogFile ?? DEFAULT_CATALOG_FILE)
  const cliCommand = config.cli?.command ?? 'desertant'
  const cliAvailable = (config.cli?.enabled ?? true) && commandExists(cliCommand)
  const remoteEndpoint = config.remote?.endpoint
  const transportOptions = {
    cliCommand,
    ...remoteEndpoint !== undefined ? { endpoint: remoteEndpoint } : {},
    ...config.remote?.token !== undefined ? { token: config.remote.token } : {},
  }
  const resolved: ResolvedModel[] = entries.map(entry => ({
    entry,
    verdict: resolveCapability(entry, {
      cliAvailable,
      remoteEndpoint,
      ...config.allowNpm !== undefined ? { allowNpm: config.allowNpm } : {},
    }),
  }))
  const grant = createGrant({
    grantId: config.grantId ?? 'local-interactive',
    allowedTools: [...STANDARD_CONTRACTS.map(contract => contract.toolName), 'model_tools', 'tool_mode_run'],
    approvedRoots: config.approvedRoots ?? [],
    hostedCode: false,
    recordingPolicy: config.recordReceipts === false ? 'none' : 'receipts',
  })
  const bridge = new ProviderBridge({
    grant,
    activationGeneration: 1,
    log: () => { /* headless: no logger surface */ },
  })
  const bindings = new Map<string, ContractBinding>()
  for (const contract of STANDARD_CONTRACTS) {
    const eligible = resolved.filter(item => item.entry.contract === contract.contract && item.verdict.runnable)
    if (eligible.length === 0) continue
    const override = config.providers?.[contract.contract]
    const chosen = eligible.find(item => item.entry.id === override) ?? eligible[0]
    if (chosen === undefined) continue
    const adapter = createAdapter(chosen.entry, { route: chosen.verdict.route, ...transportOptions }, undefined, bridge)
    if (adapter === undefined) continue
    bindings.set(contract.contract, {
      contract,
      implementation: chosen.entry,
      adapter,
      route: chosen.verdict.route,
      alternatives: eligible.filter(item => item.entry.id !== chosen.entry.id).map(item => item.entry.id),
    })
  }
  return bindings
}

/** One started headless serve, with its shutdown. */
export interface HeadlessServe {
  /** The URL clients should use. */
  readonly url: string
  /** The host/port actually bound. */
  readonly host: string
  readonly port: number
  /** Close the server and settle owned resources (bounded). */
  close(): Promise<void>
}

/**
 * Start the headless serve composition (RUN-03).
 *
 * @param configPath - the config file path; falls back to DSH_TOOL_MODE_CONFIG
 *   then ./tool-mode.json.
 * @returns the bound endpoint and a shutdown handle.
 * @throws HeadlessConfigError for a missing/invalid configuration.
 */
export async function startHeadlessServe(configPath?: string): Promise<HeadlessServe> {
  const { config } = readHeadlessConfig(configPath, process.env)
  const bindings = resolveBindings(config)

  // The MCP surface is NEVER unauthenticated (SEC-01): the headless serve
  // requires a credential exactly like the stdio relay does.
  const token = process.env.DSH_TOOL_MODE_MCP_TOKEN
  if (token === undefined || token.length === 0) {
    throw new HeadlessConfigError(
      'serve requires a credential (DSH_TOOL_MODE_MCP_TOKEN); the MCP surface is never unauthenticated (SEC-01)',
    )
  }

  const models = (() => {
    const entries = loadCatalog(config.catalogFile ?? DEFAULT_CATALOG_FILE)
    const cliCommand = config.cli?.command ?? 'desertant'
    const cliAvailable = (config.cli?.enabled ?? true) && commandExists(cliCommand)
    const remoteEndpoint = config.remote?.endpoint
    return entries.map(entry => ({
      entry,
      verdict: resolveCapability(entry, {
        cliAvailable,
        remoteEndpoint,
        ...config.allowNpm !== undefined ? { allowNpm: config.allowNpm } : {},
      }),
    }))
  })()

  let receiptCounter = 0
  const host: HostIdentity = {
    extension: '@try-works/dsh-model-as-tool',
    extensionVersion: '0.1.1',
    activationGeneration: 1,
    nextReceiptId: () => `rcpt_${(++receiptCounter).toString(36).padStart(6, '0')}`,
    grant: createGrant({
      grantId: config.grantId ?? 'local-interactive',
      allowedTools: [...STANDARD_CONTRACTS.map(contract => contract.toolName), 'model_tools', 'tool_mode_run'],
      approvedRoots: config.approvedRoots ?? [],
      hostedCode: false,
      recordingPolicy: config.recordReceipts === false ? 'none' : 'receipts',
    }),
    callerKind: 'interactive',
  }

  const published: PublishedTool[] = []
  for (const binding of bindings.values()) {
    /**
     * Registration is what compiles a contract's validators. The plugin path gets
     * this from registerContractTool; the headless surface builds the published
     * list directly, so it must register each contract here or every real call
     * fails with "input was validated before the contract was registered".
     */
    assertValidContract(binding.contract)
    published.push({ toolName: binding.contract.toolName, contract: binding.contract })
  }
  if (config.registerControlTool !== false) {
    published.push({ toolName: 'model_tools', contract: modelToolsContract() })
  }
  published.push({ toolName: 'tool_mode_run', contract: TOOL_MODE_RUN_CONTRACT as never })

  const mcpHost = createMcpHost({
    serverInfo: { name: '@try-works/dsh-model-as-tool', version: '0.1.1' },
    surface: {
      get published() {
        return published
      },
      async execute(request) {
        if (request.caller !== undefined) {
          try {
            authorizeTool({
              grantId: request.caller.grantId,
              allowedTools: request.caller.allowedTools,
              approvedRoots: [],
              remoteDestinations: [],
              hostedCode: false,
              recordingPolicy: request.caller.recordingPolicy,
              limits: request.caller.limits,
            }, request.name)
          } catch (error) {
            return { isError: true, message: error instanceof Error ? error.message : String(error) }
          }
        }
        if (request.name === 'model_tools') {
          return { isError: false, value: { models: describeModels(models) } }
        }
        if (request.name === 'tool_mode_run') {
          return {
            isError: true,
            message:
              'tool_mode_run is registered but refused in the headless serve: this process composes no DSH hosted-code '
              + 'runtime (the ProgramRunner needs the DSH PtcHostContext), and the refusal is reported rather than a '
              + 'confinement the deployment does not have being claimed (CODE-10)',
          }
        }
        const binding = [...bindings.values()].find(candidate => candidate.contract.toolName === request.name)
        if (binding === undefined) {
          return { isError: true, message: `unknown tool ${JSON.stringify(request.name)}` }
        }
        const { contract, adapter } = binding
        assertValidInput(contract, request.arguments as Record<string, unknown>)
        for (const rule of crossFieldRules(contract)) {
          const violation = rule(request.arguments as Record<string, unknown>)
          if (violation !== undefined) {
            return { isError: true, message: `${contract.toolName}: ${violation}` }
          }
        }
        authorizeTool(host.grant, contract.toolName)
        const nativeArgs = toNativeArgs(contract.contract, request.arguments as Record<string, unknown>)
        const native = await adapter.invoke({
          args: nativeArgs,
          signal: request.signal,
          authority: createInvocationAuthority(host.grant, host.callerKind),
        })
        const payload = toContractPayload(contract.contract, native, request.arguments as Record<string, unknown>)
        const meta: ToolMeta = buildMeta(binding, host)
        const value = { ...payload, meta } as Record<string, unknown>
        assertValidOutput(contract, value)
        host.recordReceipt?.(buildReceipt(binding, host, meta))
        return { isError: false, value }
      },
    },
  })

  const endpoint: BoundEndpoint = await startHttpServer({
    path: config.mcpV3?.path ?? '/mcp',
    host: config.mcpV3?.host ?? '127.0.0.1',
    port: config.mcpV3?.port ?? 3765,
    maxBodyBytes: 16 * 1024 * 1024,
    allowedOrigins: [],
    auth: { scheme: 'static-token', token, clientId: 'headless-serve' },
  } satisfies Parameters<typeof startHttpServer>[0], mcpHost)

  let closing = false
  return {
    url: endpoint.url,
    host: endpoint.host,
    port: endpoint.port,
    async close() {
      if (closing) return
      closing = true
      await Promise.race([
        endpoint.close(),
        new Promise<void>(resolve => setTimeout(resolve, 3000)),
      ])
    },
  }
}

/** The `model_tools` control contract, rendered for the headless MCP surface. */
function modelToolsContract(): ToolContract {
  return {
    contract: 'model.tools',
    version: '1.0.0',
    toolName: 'model_tools',
    description: 'Inspect the models this headless deployment can run.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['models'],
      properties: {
        models: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    semantics: { scoreKind: 'none' },
    limits: {},
    unsupported: ['Changing the catalog: this is an inspection surface.'],
  }
}

/**
 * Run the headless serve as a PROCESS (the launcher entry): prints the bound
 * endpoint and waits for SIGINT/SIGTERM, then exits 0 after a bounded shutdown.
 *
 * @param options - the config path and the JSON-mode flag.
 * @param io - output sinks (injected for tests).
 * @returns the process exit code.
 */
export async function runHeadlessServe(
  options: { readonly configPath?: string; readonly json?: boolean },
  io: { readonly out: (line: string) => void; readonly err: (line: string) => void },
  signals: { once(name: 'SIGINT' | 'SIGTERM', handler: () => void): void } = process,
): Promise<number> {
  try {
    const serve = await startHeadlessServe(options.configPath)
    if (options.json === true) {
      io.out(JSON.stringify({ ok: true, listening: true, url: serve.url }))
    } else {
      io.out(`dsh-tool-mode serve: listening on ${serve.url}`)
    }
    return await new Promise<number>(resolve => {
      let shuttingDown = false
      const shutdown = (): void => {
        if (shuttingDown) return
        shuttingDown = true
        void serve.close().finally(() => resolve(0))
      }
      signals.once('SIGINT', shutdown)
      signals.once('SIGTERM', shutdown)
    })
  } catch (error) {
    if (error instanceof HeadlessConfigError) {
      if (options.json === true) io.out(JSON.stringify({ ok: false, error: error.message }))
      else io.err(`dsh-tool-mode serve: ${error.message}`)
      return 2
    }
    const message = error instanceof Error ? error.message : String(error)
    if (options.json === true) io.out(JSON.stringify({ ok: false, error: message }))
    else io.err(`dsh-tool-mode serve: ${message}`)
    return 1
  }
}
