/**
 * Contract-driven registration: one tool per contract, not one per model.
 *
 * This is the host half of BASE-02. The contract decides the tool's name, schema
 * and description; the implementation behind it is host configuration. A second
 * model implementing `stt.transcribe` therefore joins the existing
 * `stt_transcribe` tool rather than appearing as a competing duplicate — which is
 * the behaviour the previous per-model registrar could not express.
 *
 * The host also owns provenance (DECL-03): `meta` is stamped here, from host
 * state, so an implementation cannot claim another package's identity.
 *
 * @module @try-works/dsh-model-as-tool/bindings
 */

import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  assertValidContract,
  assertValidInput,
  assertValidOutput,
  crossFieldRules,
  toDshParameters,
  type ExecutionLocation,
  type ToolContract,
  type ToolMeta,
} from '@try-works/tool-mode-contracts'
import type { ModelCatalogEntry, ModelRoute } from './types.ts'
import { toContractPayload, toNativeArgs } from './contract-payload.ts'
import {
  authorizeTool,
  createInvocationAuthority,
  type InvocationAuthority,
  type ToolGrant,
} from './authority.ts'
import type { ModelAdapter, JsonValue } from './adapters/index.ts'

/** Host identity stamped into every result. */
export interface HostIdentity {
  /** The host package name. */
  readonly extension: string
  /** The host package version. */
  readonly extensionVersion: string
  /** Activation generation, incremented when the tool surface changes. */
  readonly activationGeneration: number
  /** Receipt id factory; injectable so tests are deterministic. */
  readonly nextReceiptId: () => string
  /**
   * The grant this tool surface runs under (SEC-03).
   *
   * Built by the host from operator configuration. A caller's request cannot
   * reach it, which is what makes the authority trustworthy (BASE-05).
   */
  readonly grant: ToolGrant
  /** How the host classified this caller. */
  readonly callerKind: InvocationAuthority['callerKind']
}

/** One contract with the implementation chosen to serve it. */
export interface ContractBinding {
  /** The contract that defines the tool. */
  readonly contract: ToolContract
  /** The catalog entry selected to execute it. */
  readonly implementation: ModelCatalogEntry
  /** The adapter that invokes that model. */
  readonly adapter: ModelAdapter
  /** The route the capability resolver proved, used for `executionLocation`. */
  readonly route: ModelRoute
  /** Other runnable implementations of the same contract, for reporting. */
  readonly alternatives: readonly string[]
}

/**
 * Translate a resolver route into the caller-facing execution location (SPEC §6).
 *
 * "Local" is deliberately not one value: a bridge is another machine, and a
 * caller reasoning about data boundaries needs to know which.
 * @param route - the resolved route.
 * @returns the declared execution location.
 */
export function executionLocationOf(route: ModelRoute): ExecutionLocation {
  switch (route) {
    case 'npm-native':
    case 'npm-onnxruntime':
      return 'host'
    case 'cli':
      return 'host'
    case 'remote':
      return 'team-server'
    /* v8 ignore next -- closed union; a new route must fail compilation here. */
    default:
      return 'host'
  }
}

/**
 * Build the `meta` envelope for one execution.
 *
 * Every field comes from host state or the contract, never from the model's
 * output, which is what makes the provenance trustworthy (DECL-03).
 * @param binding - the contract and implementation that are executing.
 * @param host - the host identity to stamp.
 * @param warnings - non-fatal conditions observed during this call.
 * @returns the envelope.
 */
export function buildMeta(
  binding: Pick<ContractBinding, 'contract' | 'implementation' | 'route'>,
  host: HostIdentity,
  warnings: readonly string[] = [],
): ToolMeta {
  return {
    contract: binding.contract.contract,
    contractVersion: binding.contract.version,
    implementationId: binding.implementation.id,
    extension: host.extension,
    extensionVersion: host.extensionVersion,
    activationGeneration: host.activationGeneration,
    executionLocation: executionLocationOf(binding.route),
    receiptId: host.nextReceiptId(),
    warnings: [...warnings],
  }
}

/**
 * Register one contract as a single DSH tool.
 *
 * The tool body validates arguments against the contract, applies the cross-field
 * rules the DSH DSL cannot express, invokes the selected implementation, then
 * validates the RESULT before returning it. A violation surfaces as a tool
 * failure rather than as malformed data reaching a caller (AT-11).
 * @param ctx - the context whose tool registry receives the definition.
 * @param binding - the contract and the implementation chosen for it.
 * @param host - host identity to stamp into results.
 * @returns the registered tool name and the registry disposer.
 */
export function registerContractTool(
  ctx: { tools: { register(definition: unknown): () => void } },
  binding: ContractBinding,
  host: HostIdentity,
): { toolName: string; dispose: () => void } {
  const { contract, adapter, implementation } = binding
  // Registration and argument validation must agree, so the contract is checked
  // here rather than trusted: a definition that cannot compile would otherwise
  // fail only when a caller happened to hit the broken branch.
  assertValidContract(contract)
  const rules = crossFieldRules(contract)

  const definition = defineTool({
    name: contract.toolName,
    description: contract.description,
    // `toDshParameters` returns the projected JSON-Schema subset; the registry's
    // DSL type is structurally narrower, and `ProjectionError` has already
    // refused any keyword the DSL cannot express.
    parameters: toDshParameters(contract) as unknown as ParameterSchemaSpec,
    output: {
      // The contract's output schema is the canonical value contract; the
      // registry enforces it as well as this module does.
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const record = value as Record<string, unknown>
        return [{ type: 'text', text: renderForModel(contract, record) }]
      },
    },
    async execute(args, exec) {
      const record = args as Record<string, unknown>
      assertValidInput(contract, record)
      for (const rule of rules) {
        const violation = rule(record)
        if (violation !== undefined) {
          throw new Error(`${contract.toolName}: ${violation}`)
        }
      }

      // SEC-03: the grant is consulted before any work happens, so an ungranted
      // tool is refused before inference rather than after it.
      authorizeTool(host.grant, contract.toolName)
      const authority = createInvocationAuthority(host.grant, host.callerKind)

      // The contract's caller-facing arguments are translated into the adapter's
      // native vocabulary before invocation; the reverse translation runs on the
      // result. Both are explicit, so a name change on either side is a compile-
      // or test-time failure rather than a runtime mystery.
      const nativeArgs = toNativeArgs(contract.contract, record)
      const native = await adapter.invoke({ args: nativeArgs, signal: exec.signal, authority })
      // The implementation's native result is translated into the contract's
      // payload before validation: the contract is the authority, so a mismatch is
      // resolved here rather than by loosening the schema.
      const payload = toContractPayload(contract.contract, native, record)
      // `ToolMeta` is a plain interface without an index signature, so it is not
      // structurally a `JsonValue`; the value is losslessly JSON either way, and
      // `assertValidOutput` is the real check.
      const value = { ...payload, meta: buildMeta(binding, host) } as Record<string, unknown>
      assertValidOutput(contract, value)
      return value as Record<string, never> | Record<string, JsonValue>
    },
    presentCall(callArgs) {
      const primary = Object.values(callArgs as Record<string, unknown>)[0]
      return {
        card: 'generic',
        title: contract.toolName,
        kind: 'read',
        ...typeof primary === 'string' ? { rawInput: primary } : {},
      }
    },
  })

  void implementation
  return { toolName: contract.toolName, dispose: ctx.tools.register(definition) }
}

/**
 * Render a contract result for the model.
 *
 * The canonical value is the source of truth; this only chooses the presentation.
 * It never invents a field the contract did not declare.
 * @param contract - the contract that produced the value.
 * @param value - the validated canonical value.
 * @returns a short text projection.
 */
function renderForModel(contract: ToolContract, value: Record<string, unknown>): string {
  if (contract.contract === 'text.language_detect') {
    const language = value.language
    const candidates = Array.isArray(value.candidates) ? value.candidates : []
    const detail = candidates
      .filter((candidate): candidate is { language: string; probability: number } =>
        typeof candidate === 'object' && candidate !== null
        && typeof (candidate as { language?: unknown }).language === 'string')
      .map(candidate => `${candidate.language} ${(candidate.probability * 100).toFixed(1)}%`)
      .join(', ')
    const tooClose = value.tooCloseToCall === true ? ' (too close to call)' : ''
    return `Detected language: ${String(language)}${tooClose}`
      + (detail.length > 0 ? `\nCandidates: ${detail}` : '')
  }
  if (contract.contract === 'stt.transcribe') {
    const text = typeof value.text === 'string' ? value.text : ''
    const coverage = value.coverage as { complete?: boolean; transcribedSeconds?: number } | undefined
    const partial = coverage?.complete === false
      ? `\n[warnings] partial transcript: ${String(coverage.transcribedSeconds ?? 0)}s covered\n`
      : ''
    return text.length > 0 ? `${text}${partial}` : `(no speech recognized)${partial}`
  }
  return JSON.stringify(value, null, 2)
}
