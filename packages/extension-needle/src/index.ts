/**
 * The Needle extension: an HONEST provider over the pinned native engine.
 *
 * ## What this build really does
 *
 * The native route is implemented and was RUN on this host. `windows-x86_64/needle.exe`
 * from `Cactus-Compute/needle3@93e88ede…` executes, `--help` prints its usage, and a
 * one-shot inference over `needle3.cact` returned a real tool call with the engine's own
 * `reasoning`, `confidence` and grounding report. Nothing in this package pretends.
 *
 * ## What it refuses to pretend
 *
 * The artifacts are NOT shipped inside this package and NOT distributed with it. They are
 * 37 MB of upstream bytes that a host prepares, verifies and hands over — or that an
 * operator points at explicitly. So:
 *
 * - `inspect()` reports `unprepared` and NAMES every artifact it could not verify, unless
 *   the pinned bytes are genuinely resolvable and their size and SHA-256 match the pin.
 * - `invoke()` REFUSES, naming what is missing, rather than returning an empty plan or a
 *   null extraction that looks like a model answer.
 *
 * Between those two states there is no third one. There is no code path here that fabricates
 * a proposal, and none that reports `ready` because a file merely exists.
 *
 * ## One-shot, and why the state question is answered structurally
 *
 * `needle.exe` accumulates turns in process memory; the CLI has no reset flag, and the only
 * reset in the product is `POST /reset` on the HTTP server this package never starts. The
 * answer is therefore process-per-call: every invocation starts a fresh `needle.exe` and
 * waits for it to exit. That is the strongest available form of "verify request-state reset",
 * and it is verified as a property of the design rather than asserted: the provider holds no
 * child handle, no session id and no conversation buffer.
 *
 * ## The listener
 *
 * The pinned binary links `WS2_32.dll` and carries `--serve` / `--port` and
 * `http://127.0.0.1:%d`. This package never passes either flag, and the bridge REFUSES them
 * (`assertNoListenerArgument`), so the surface is closed by construction and not by habit.
 *
 * @module @try-works/extension-needle
 */

import {
  defineExtension,
  type ExtensionContextV1,
  type ExtensionInstanceV1,
  type InvocationContextV1,
  type JsonObject,
  type ModelProviderV1,
  type PreparedAssetMapV1,
  type ProviderInspectionV1,
} from '@try-works/tool-mode-extension-sdk'

import {
  CALL_LIMITS,
  STRUCTURED_EXTRACT_CONTRACT,
  TOOLS_PLAN_CONTRACT,
  contractByImplementation,
  type OfferedTool,
  type ProposedCall,
} from './contracts.ts'
import { DEFAULT_MAX_OUTPUT_BYTES } from './process-bridge.ts'
import { EngineCallError, invokeEngine, type EngineResult } from './engine.ts'
import {
  resolveArtifacts,
  resolvedEngine,
  resolvedWeights,
  type Resolution,
} from './resolve.ts'
import {
  assertInput,
  assertToolName,
  checkArguments,
  extractionTool,
  prepareExtractionSchema,
} from './validation.ts'

/** The one model this extension implements. */
const MODEL_ID = 'needle3'

/** The features this build provides when it is prepared. Empty until it is. */
const FEATURES: readonly string[] = ['tool-calling', 'structured-extraction', 'local-inference']

/** The provider configuration keys an operator may set. Read as data; nothing here is a grant. */
interface NeedleConfiguration {
  readonly enginePath?: string
  readonly weightsPath?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly maxNewTokens?: number
  readonly threads?: number
  readonly system?: string
  /**
   * The environment the artifact RESOLVER may read, when an operator wants to fix it.
   *
   * Absent means the process environment, which is the normal case and is how a developer
   * points this package at bytes outside a host profile. Supplying it makes resolution
   * DETERMINISTIC: nothing ambient can change which artifacts are found, which is what a test
   * needs and what a reproducible deployment wants. It is read as data and grants nothing —
   * every path it names still goes through the size-and-digest verification.
   */
  readonly resolutionEnv?: Readonly<Record<string, string>>
}

/** Read a positive integer out of the configuration, or undefined. */
function readInteger(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`configuration ${name} must be a positive integer`)
  }
  if (value > max) throw new Error(`configuration ${name} must be at most ${max}`)
  return value
}

/** Read a non-empty string out of the configuration, or undefined. */
function readString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`configuration ${name} must be a non-empty string`)
  }
  return value
}

/** Narrow the host's configuration object, rejecting a value that would be silently ignored. */
function readConfiguration(raw: Readonly<JsonObject>): NeedleConfiguration {
  const resolutionEnv = readEnvironment(raw.resolutionEnv)
  return {
    ...readString(raw.enginePath, 'enginePath') === undefined ? {} : { enginePath: raw.enginePath as string },
    ...readString(raw.weightsPath, 'weightsPath') === undefined ? {} : { weightsPath: raw.weightsPath as string },
    ...readInteger(raw.timeoutMs, 'timeoutMs', 600_000) === undefined ? {} : { timeoutMs: raw.timeoutMs as number },
    ...readInteger(raw.maxOutputBytes, 'maxOutputBytes', 64 * 1024 * 1024) === undefined
      ? {} : { maxOutputBytes: raw.maxOutputBytes as number },
    ...readInteger(raw.maxNewTokens, 'maxNewTokens', CALL_LIMITS.maxNewTokens) === undefined
      ? {} : { maxNewTokens: raw.maxNewTokens as number },
    ...readInteger(raw.threads, 'threads', 64) === undefined ? {} : { threads: raw.threads as number },
    ...readString(raw.system, 'system') === undefined ? {} : { system: raw.system as string },
    ...resolutionEnv === undefined ? {} : { resolutionEnv },
  }
}

/** Read an explicit resolution environment, rejecting a value that is not a string map. */
function readEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('configuration resolutionEnv must be an object of string values')
  }
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      throw new Error(`configuration resolutionEnv.${name} must be a string`)
    }
    out[name] = entry
  }
  return out
}

/** Throw a refusal naming every missing prerequisite. */
function unpreparedError(problems: Resolution['problems']): never {
  const lines = problems.map(problem => `  - ${problem.assetId}: ${problem.reason}`)
  throw new Error(
    'the pinned Needle engine and weights are not prepared on this machine, so no inference was run.\n'
    + `${lines.join('\n')}\n`
    + 'Prepare the artifacts (see models.lock.json and PINNING.md) or set NEEDLE_EXTENSION_ENGINE '
    + 'and NEEDLE_EXTENSION_WEIGHTS to local copies whose size and SHA-256 match the pin. '
    + 'This extension does not download them and will not run a substitute.',
  )
}

/**
 * Build the provider for the Needle 3 native deployment.
 * @param context - the host-issued extension context.
 */
function createNeedleProvider(context: ExtensionContextV1): ModelProviderV1 {
  const configuration = readConfiguration(context.configuration)
  const timeoutMs = configuration.timeoutMs ?? 120_000
  const maxOutputBytes = configuration.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxNewTokens = configuration.maxNewTokens ?? CALL_LIMITS.defaultNewTokens
  /**
   * Paths an operator configured directly, keyed by asset id.
   *
   * Built once. They are HINTS into the same verification every other route goes through,
   * so a configured path is not a way to run bytes the pin does not describe.
   */
  const configuredPaths: Record<string, string> | undefined =
    configuration.enginePath === undefined && configuration.weightsPath === undefined
      ? undefined
      : {
        ...configuration.enginePath === undefined ? {} : { 'needle-engine-win-x64': configuration.enginePath },
        ...configuration.weightsPath === undefined ? {} : { 'needle3-weights': configuration.weightsPath },
      }
  let disposed = false
  /** The host's verified asset map, kept only for the life of a load. */
  let prepared: PreparedAssetMapV1 | undefined

  /**
   * The verified resolution, memoized for the life of this provider.
   *
   * A call would otherwise re-walk every route and re-hash 37 MB before it could start the
   * engine, which is slower than the inference. The memo is dropped whenever the authority
   * changes — on `load()`, which is the host handing over a verified asset map, and on
   * `unload()` — so a prepared map is never shadowed by a stale answer.
   */
  let resolutionMemo: Promise<Resolution> | undefined

  /** Resolve the artifacts through every route the host and the operator allow. */
  const resolve = async (): Promise<Resolution> => {
    resolutionMemo ??= resolveArtifacts({
      ...prepared === undefined ? {} : { assets: prepared },
      ...configuredPaths === undefined ? {} : { hints: { paths: configuredPaths } },
      ...context.storage.directory.length === 0 ? {} : { storageDirectory: context.storage.directory },
      ...configuration.resolutionEnv === undefined ? {} : { env: configuration.resolutionEnv },
    })
    return resolutionMemo
  }

  /**
   * Read the extraction source: the inline text, or a file the HOST authorized.
   *
   * A caller-supplied path never reaches the filesystem directly: it goes through
   * `resolvePath`, and the RESOLVED path is what is opened. Validating the string and then
   * opening it would leave the check-then-open window a symlink wins.
   */
  const readSource = async (
    input: Readonly<JsonObject>,
    invocation: InvocationContextV1,
  ): Promise<string> => {
    const inline = input.text
    if (typeof inline === 'string' && inline.length > 0) return inline
    const candidate = input.path
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error('exactly one of "text" and "path" must be supplied')
    }
    const authorized = invocation.resolvePath(candidate)
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(authorized)
    if (bytes.byteLength > CALL_LIMITS.maxRequestCharacters * 4) {
      throw new Error(
        `the authorized source is ${bytes.byteLength} bytes, over the `
        + `${CALL_LIMITS.maxRequestCharacters * 4}-byte read limit`,
      )
    }
    return bytes.toString('utf8')
  }

  /**
   * Run one engine call.
   *
   * A plain closure rather than a method: the provider object is an interface the host
   * holds, and hanging an extra method off it would make the call surface part of the
   * provider's public shape.
   */
  const runEngine = async (
    enginePath: string,
    weightsPath: string,
    request: {
      readonly prompt: string
      readonly tools: readonly OfferedTool[]
      readonly system?: string
      readonly maxNewTokens: number
    },
    signal: AbortSignal,
  ): Promise<EngineResult> => {
    try {
      return await invokeEngine(
        {
          enginePath,
          weightsPath,
          prompt: request.prompt,
          tools: request.tools,
          maxNewTokens: request.maxNewTokens,
          timeoutMs,
          maxOutputBytes,
          ...request.system === undefined ? {} : { system: request.system },
          ...configuration.threads === undefined ? {} : { threads: configuration.threads },
        },
        signal,
      )
    } catch (error) {
      if (error instanceof EngineCallError) {
        context.logger.log('warn', 'the needle engine call failed', {
          outcome: error.outcome?.kind ?? 'not-started',
          stderr: (error.outcome?.stderr ?? '').slice(0, 512),
        })
      }
      throw error
    }
  }

  /** Read the caller's response-token budget, bounded by the shipped schemas. */
  const newTokensInput = (input: Readonly<JsonObject>, fallback: number): number => {
    const value = input.max_new_tokens
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error('argument "max_new_tokens" must be a positive integer')
    }
    if (value > CALL_LIMITS.maxNewTokens) {
      throw new Error(`argument "max_new_tokens" must be at most ${CALL_LIMITS.maxNewTokens}`)
    }
    return value
  }

  /** Narrow the offered tools out of the caller's input. */
  const offeredTools = (input: Readonly<JsonObject>): OfferedTool[] => {
    const raw = input.tools
    if (!Array.isArray(raw)) throw new Error('argument "tools" must be an array')
    if (raw.length > CALL_LIMITS.maxTools) {
      throw new Error(`argument "tools" is over the ${CALL_LIMITS.maxTools}-tool limit`)
    }
    return raw.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`argument "tools[${index}]" must be an object`)
      }
      const record = entry as Record<string, unknown>
      const name = record.name
      const description = record.description
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`argument "tools[${index}].name" must be a non-empty string`)
      }
      if (typeof description !== 'string' || description.length === 0) {
        throw new Error(`argument "tools[${index}].description" must be a non-empty string`)
      }
      // The name reaches the engine's tool DOCUMENT, which is a file this package writes,
      // and comes back as a proposal whose name is compared against this list. A name that
      // is not a plain identifier is refused here rather than becoming a file's contents.
      assertToolName(name, `tools[${index}].name`)
      const parameters = record.parameters
      if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
        throw new Error(`argument "tools[${index}].parameters" must be a JSON Schema object`)
      }
      return { name, description, parameters: parameters as Record<string, unknown> }
    })
  }

  /** Project one engine call into the inert proposal shape. */
  const project = (tool: OfferedTool | undefined, call: { name: string; arguments: Record<string, unknown> }): {
    proposal: ProposedCall
    offered: boolean
    report: { readonly valid: boolean; readonly issues: readonly string[] }
  } => {
    const report = tool === undefined
      ? { valid: false, issues: [`no tool named ${JSON.stringify(call.name)} was offered for this turn`] }
      : checkArguments(tool, call.arguments)
    return {
      proposal: { name: call.name, arguments: call.arguments },
      offered: tool !== undefined,
      report,
    }
  }

  return {
    /**
     * EXT-18: inspection reads approved local state only. It resolves and VERIFIES the
     * pinned bytes and reports exactly what it found. It never downloads, never runs the
     * engine and never infers.
     */
    async inspect(signal): Promise<ProviderInspectionV1> {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      const resolution = await resolve()
      const engine = resolvedEngine(resolution)
      const weights = resolvedWeights(resolution)
      if (engine === undefined || weights === undefined) {
        return {
          readiness: 'unprepared',
          // An EMPTY feature list while unprepared is the honest answer: `features` is what
          // this deployment can actually run, not what the model is documented to do.
          features: [],
          missing: resolution.problems.map(problem => ({
            name: problem.assetId,
            reason: `${problem.reason} (routes searched: ${problem.searched.join('; ') || 'none'})`,
          })),
          reason:
            'needs preparation: the pinned Needle engine and weights were not found, or what was found '
            + 'did not match the pinned size and SHA-256',
        }
      }
      return {
        readiness: 'ready',
        features: [...FEATURES],
        missing: [],
        runtimeVersion: `needle engine ${engine.path} (sha256 ${engine.observedSha256.slice(0, 16)}…), `
          + `weights ${weights.observedBytes} bytes`,
      }
    },

    /**
     * Record the host's verified map and prove the artifacts resolve and verify. This is
     * the one place a host-prepared asset is consulted, so `inspect()` and `invoke()` agree
     * about what the machine has.
     */
    async load(request: { readonly assets: Readonly<PreparedAssetMapV1>; readonly signal: AbortSignal }) {
      if (request.signal.aborted) {
        throw request.signal.reason instanceof Error ? request.signal.reason : new Error('aborted')
      }
      prepared = request.assets
      // The authority just changed, so a memoized resolution computed without it must not
      // survive: the host's verified map is the route with the most authority.
      resolutionMemo = undefined
      const resolution = await resolve()
      if (resolution.problems.length > 0) unpreparedError(resolution.problems)
      // Nothing is loaded into this process: the engine is a child process, started per
      // call. Saying so is more useful than an empty successful return that implies a
      // resident model.
      context.logger.log('debug', 'needle deployment verified; the engine is started per invocation')
    },

    async invoke({ implementationId, input, context: invocation }): Promise<JsonObject> {
      if (invocation.signal.aborted) {
        throw invocation.signal.reason instanceof Error ? invocation.signal.reason : new Error('aborted')
      }
      if (disposed) throw new Error('the provider has been disposed')
      const contract = contractByImplementation(implementationId)
      if (contract === undefined) {
        throw new Error(
          `this extension implements ${JSON.stringify(TOOLS_PLAN_CONTRACT.implementationId)} and `
          + `${JSON.stringify(STRUCTURED_EXTRACT_CONTRACT.implementationId)}, `
          + `not ${JSON.stringify(implementationId)}`,
        )
      }

      // Arguments are checked BEFORE artifacts are resolved, so a malformed call fails for
      // its own reason on a machine where nothing is prepared — which is the difference
      // between "you called this wrong" and "this deployment cannot run".
      const maxTokens = newTokensInput(input, configuration.maxNewTokens ?? maxNewTokens)
      const system = typeof input.system === 'string' && input.system.length > 0
        ? input.system
        : configuration.system

      if (implementationId === TOOLS_PLAN_CONTRACT.implementationId) {
        assertInput('tools-plan.input.json', input)
        const tools = offeredTools(input)
        const request = typeof input.request === 'string' ? input.request : ''
        const resolution = await resolve()
        const engine = resolvedEngine(resolution)
        const weights = resolvedWeights(resolution)
        // REFUSE, naming what is missing. Returning an empty plan here would be
        // indistinguishable from a model that found nothing to do.
        if (engine === undefined || weights === undefined) unpreparedError(resolution.problems)
        const result = await runEngine(engine.path, weights.path, {
          prompt: request,
          tools,
          ...system === undefined ? {} : { system },
          maxNewTokens: maxTokens,
        }, invocation.signal)

        const byName = new Map(tools.map(tool => [tool.name, tool]))
        const proposals: JsonObject[] = []
        const rejected: JsonObject[] = []
        for (const call of result.envelope.functionCalls.slice(0, CALL_LIMITS.maxProposedCalls)) {
          const { proposal, offered, report } = project(byName.get(call.name), call)
          const entry: JsonObject = {
            name: proposal.name,
            arguments: proposal.arguments as JsonObject,
            offered,
            valid: report.valid,
            issues: [...report.issues],
          }
          // A proposal the caller never offered, or one whose arguments violate the schema
          // the caller supplied, is REPORTED as rejected rather than passed through. The
          // engine cannot be relied on for this: its grammar constrains shapes, not intent.
          if (offered && report.valid) proposals.push(entry)
          else rejected.push(entry)
        }
        const suppressed = result.envelope.suppressedCalls.map(call => ({
          name: call.name,
          arguments: call.arguments as JsonObject,
          offered: byName.has(call.name),
          valid: byName.has(call.name),
          issues: [],
        }))
        const payload: JsonObject = {
          proposals,
          rejected,
          ...suppressed.length === 0 ? {} : { suppressed },
          reasoning: result.envelope.reasoning,
          confidence: result.envelope.confidence,
          ...result.envelope.validation === null ? {} : {
            grounding: {
              ungrounded: result.envelope.validation.ungrounded as JsonObject[],
              negation: result.envelope.validation.negation,
            },
          },
        }
        return payload
      }

      if (implementationId === STRUCTURED_EXTRACT_CONTRACT.implementationId) {
        assertInput('structured-extract.input.json', input)
        const prepared = prepareExtractionSchema(input.schema)
        const instruction = typeof input.instruction === 'string' ? input.instruction : ''
        const text = await readSource(input, invocation)
        const tool = extractionTool(prepared, instruction)
        const resolution = await resolve()
        const engine = resolvedEngine(resolution)
        const weights = resolvedWeights(resolution)
        if (engine === undefined || weights === undefined) unpreparedError(resolution.problems)
        const result = await runEngine(engine.path, weights.path, {
          prompt: text,
          tools: [tool],
          ...system === undefined ? {} : { system },
          maxNewTokens: maxTokens,
        }, invocation.signal)

        const call = result.envelope.functionCalls[0]
        if (call === undefined) {
          // "Nothing matched" is a REPORTED outcome, not an error: a document with none of
          // the requested fields is a legitimate answer.
          return {
            extraction: null,
            proposed: false,
            valid: false,
            issues: [],
            reasoning: result.envelope.reasoning,
            confidence: result.envelope.confidence,
            ...result.envelope.validation === null ? {} : {
              grounding: {
                ungrounded: result.envelope.validation.ungrounded as JsonObject[],
                negation: result.envelope.validation.negation,
              },
            },
          }
        }
        // Re-validate even though the grammar constrained the tokens. A constrained grammar
        // makes the object WELL-FORMED; it does not make it correct, and it does not make it
        // satisfy a keyword the engine dropped.
        const report = checkArguments(tool, call.arguments)
        return {
          extraction: call.arguments as JsonObject,
          proposed: true,
          valid: report.valid,
          issues: [...report.issues],
          reasoning: result.envelope.reasoning,
          confidence: result.envelope.confidence,
          ...result.envelope.validation === null ? {} : {
            grounding: {
              ungrounded: result.envelope.validation.ungrounded as JsonObject[],
              negation: result.envelope.validation.negation,
            },
          },
        }
      }

      throw new Error(`no implementation is wired for ${JSON.stringify(implementationId)}`)
    },

    /** Release the host's asset map. Nothing resident is dropped, because nothing resident
     * exists: each call owns its process. */
    async unload(signal) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      prepared = undefined
      resolutionMemo = undefined
    },

    async dispose() {
      disposed = true
      prepared = undefined
      resolutionMemo = undefined
      context.logger.log('debug', 'needle provider disposed')
    },
  }
}

export default defineExtension({
  apiVersion: 1,
  async create(context): Promise<ExtensionInstanceV1> {
    return {
      async createProvider({ modelId }) {
        if (modelId !== MODEL_ID) {
          throw new Error(`this extension implements the "${MODEL_ID}" model, not "${modelId}"`)
        }
        // A handle only: no artifact is fetched, no process is started, no model is loaded.
        return createNeedleProvider(context)
      },
      async dispose(reason) {
        context.logger.log('debug', `needle extension disposed: ${reason}`)
      },
    }
  },
})

export {
  CALL_LIMITS,
  STRUCTURED_EXTRACT_CONTRACT,
  TOOLS_PLAN_CONTRACT,
}
export type { EngineEnvelope, EngineResult } from './engine.ts'
export type { ProcessOutcome } from './process-bridge.ts'
export type { ProposedCall } from './contracts.ts'
export type { Resolution } from './resolve.ts'
