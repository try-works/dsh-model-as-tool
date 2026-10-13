/**
 * The tool contracts this package OWNS (DECL-01, EXT-21).
 *
 * Both tools are new, so EXT-21 requires their public identity to be namespaced with the
 * extension id. The contract identity lives in two places that cannot import each other:
 * this module, which the extension dispatches on, and `tool-mode.extension.json`, which
 * the host reads as DATA before any of this code runs (EXT-13). The package's test asserts
 * the two agree field for field, so a change to one without the other fails rather than
 * drifting.
 *
 * ## Why `tools_plan` is a contract about DATA and not about execution
 *
 * `tools_plan` asks the model which tool calls a request implies. The result is a
 * PROPOSAL: names and argument objects. This package has no dispatcher, no registry and no
 * callable handle anywhere in its object graph, and the proposal type below is closed over
 * `name` and `arguments` so there is no field an executor could be threaded through. That
 * is the property DECL-01's "never invoke a convenience function that executes proposed
 * tools automatically" is about, and it is enforced in three places: the output schema
 * (`additionalProperties: false`), the provider's projection of the engine envelope, and
 * the package tests.
 *
 * @module @try-works/extension-needle/contracts
 */

/** The declared limits on one call. Published in the code AND in the shipped schemas,
 * because a limit that exists in only one of the two places is a limit a caller can walk
 * around. */
export const CALL_LIMITS = {
  /** Most characters of the user request one call accepts. */
  maxRequestCharacters: 32_768,
  /** Most tools `tools_plan` may offer in one call. */
  maxTools: 64,
  /** Most characters of a tool name. */
  maxToolNameCharacters: 64,
  /** Most characters of a tool description. */
  maxToolDescriptionCharacters: 2_048,
  /** Most characters of the system text (session facts). */
  maxSystemCharacters: 4_096,
  /** Most proposed calls returned. Bounded because a proposal list is caller context. */
  maxProposedCalls: 16,
  /** Largest response-token budget a caller may request. Above the engine's 512 default,
   * below anything that would let one call monopolise the engine. */
  maxNewTokens: 4_096,
  /** Default response-token budget, which is the engine's own documented default. */
  defaultNewTokens: 512,
  /** Most characters of the extraction instruction. */
  maxInstructionCharacters: 8_192,
  /** Most characters of any single extracted string, so one field cannot flood a result. */
  maxExtractedStringCharacters: 16_384,
  /** Deepest nesting accepted in a caller-supplied extraction schema. */
  maxSchemaDepth: 8,
  /** Most properties accepted in one extraction schema, at any depth. */
  maxSchemaProperties: 128,
} as const

/** One tool the model may propose a call to. */
export interface OfferedTool {
  /** The name a proposal may use. Validated against this list before any result leaves. */
  readonly name: string
  /** What the tool does, for the model. */
  readonly description: string
  /** The tool's JSON Schema `parameters` object. */
  readonly parameters: Record<string, unknown>
}

/** One call the model PROPOSES. It is data; nothing in this package can execute it. */
export interface ProposedCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** The identity of an owned tool contract. */
export interface OwnedContract {
  readonly toolId: string
  readonly toolName: string
  readonly contractId: string
  readonly contractVersion: string
  readonly description: string
  readonly inputSchema: string
  readonly outputSchema: string
  readonly implementationId: string
}

/** The contract `tools_plan` is served under. */
export const TOOLS_PLAN_CONTRACT: OwnedContract = {
  toolId: 'tools-plan',
  toolName: 'tools_plan',
  contractId: '@try-works/extension-needle/tools_plan',
  contractVersion: '1.0.0',
  description:
    'Propose the tool calls a request implies, as DATA, over the pinned Cactus Needle 3 '
    + 'native engine. Returns each proposal as a name plus an arguments object, with the '
    + 'engine\'s own reasoning, confidence and grounding report. It EXECUTES NOTHING: the '
    + 'proposals are inert values, this package exposes no dispatcher for them, and a '
    + 'proposal whose name is not in the offered tool list is marked rejected rather than '
    + 'silently dropped. It is not a planner that runs a loop, does not call tools, and '
    + 'does not verify that a proposed argument is semantically right, only that it '
    + 'satisfies the tool\'s declared JSON Schema.',
  inputSchema: './schema/tools-plan.input.json',
  outputSchema: './schema/tools-plan.output.json',
  implementationId: 'needle3-native-tools-plan',
}

/** The contract `structured_extract` is served under. */
export const STRUCTURED_EXTRACT_CONTRACT: OwnedContract = {
  toolId: 'structured-extract',
  toolName: 'structured_extract',
  contractId: '@try-works/extension-needle/structured_extract',
  contractVersion: '1.0.0',
  description:
    'Extract structured data from text into a caller-supplied JSON Schema, over the '
    + 'pinned Cactus Needle 3 native engine. The schema is compiled to a byte-level '
    + 'grammar by the engine, so a returned object is well-formed by construction; this '
    + 'package then RE-VALIDATES it and reports every violation instead of discarding the '
    + 'attempt, because a well-formed object is not automatically a correct one. Fields '
    + 'the engine could not ground are reported in the engine\'s own grounding report. It '
    + 'does not answer questions, does not summarise, and does not call tools.',
  inputSchema: './schema/structured-extract.input.json',
  outputSchema: './schema/structured-extract.output.json',
  implementationId: 'needle3-native-structured-extract',
}

/** Every contract this package owns, in declaration order. */
export const OWNED_TOOL_CONTRACTS: readonly OwnedContract[] = [
  TOOLS_PLAN_CONTRACT,
  STRUCTURED_EXTRACT_CONTRACT,
]

/** Look an owned contract up by the implementation id a host dispatches on. */
export function contractByImplementation(implementationId: string): OwnedContract | undefined {
  return OWNED_TOOL_CONTRACTS.find(contract => contract.implementationId === implementationId)
}

/**
 * The extraction function name handed to the engine.
 *
 * `structured_extract` has no dedicated CLI flag — `needle.exe` offers exactly `--model`,
 * `--tools`, `--tool-index`, `--system`, `--prompt`, `--audio*`, `--serve`, `--port`,
 * `--max`, `--depth`, `--threads`, `--forced` and `--fail-input-overflow`. Extraction is
 * therefore expressed the way the engine actually supports it: one synthetic function
 * whose `parameters` ARE the caller's schema, which the engine compiles into the
 * constraining grammar. The name is fixed rather than caller-supplied so a caller cannot
 * name a real tool here and receive its invocation.
 */
export const EXTRACTION_FUNCTION_NAME = 'record_extraction'
