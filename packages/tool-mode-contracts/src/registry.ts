/**
 * Contract definitions and their runtime validation.
 *
 * A contract is the tool's public identity: stable name, version, input and
 * output schema, semantics, limits and policy metadata (DECL-01). It is
 * deliberately model-free — implementations bind to it, it does not know about
 * them — which is what lets two models serve one `stt_transcribe` instead of
 * producing a duplicate tool each (BASE-02).
 *
 * Milestone A is explicit that "a copied schema with no runtime validation is not
 * completion", so this module validates both directions: the contract DEFINITION
 * is checked when registered, and every RESULT is checked against the declared
 * output schema before it reaches a caller.
 *
 * @module @try-works/tool-mode-contracts/registry
 */

import { Ajv, type ValidateFunction } from 'ajv'
import { TOOL_META_SCHEMA } from './meta.ts'

/** One tool contract: the authored-once public identity (DECL-01). */
export interface ToolContract {
  /** Contract identity, e.g. `stt.transcribe`. Never a model name. */
  readonly contract: string
  /** Semantic version, independent of any host release number. */
  readonly version: string
  /** The tool name callers see, e.g. `stt_transcribe`. */
  readonly toolName: string
  /** Concise description, used verbatim for DSH registration. */
  readonly description: string
  /** Input schema as JSON Schema. The object root is closed. */
  readonly inputSchema: Record<string, unknown>
  /** Output schema as JSON Schema, including the `meta` envelope. */
  readonly outputSchema: Record<string, unknown>
  /** Declared semantics a caller must be able to rely on. */
  readonly semantics: Readonly<Record<string, string | number | boolean>>
  /** Admitted resource limits, in the units the schema declares. */
  readonly limits: Readonly<Record<string, number>>
  /** Unsupported cases the caller should be told about. */
  readonly unsupported: readonly string[]
}

/** A contract that failed validation, with every reason. */
export class ContractError extends Error {
  override readonly name = 'ContractError'
  /** The individual violations, in declaration order. */
  readonly violations: readonly string[]
  constructor(subject: string, violations: readonly string[]) {
    super(`${subject} is not a valid contract: ${violations.join('; ')}`)
    this.violations = violations
  }
}

/** A result that did not satisfy its contract's output schema. */
export class ContractViolationError extends Error {
  override readonly name = 'ContractViolationError'
  readonly violations: readonly string[]
  constructor(contract: string, violations: readonly string[]) {
    super(`result violates the ${contract} contract: ${violations.join('; ')}`)
    this.violations = violations
  }
}

/**
 * The validator. `strict: false` because contract schemas use JSON Schema
 * keywords that Ajv's strict mode rejects when they are merely annotated, and
 * `allErrors` so a violation report lists every problem rather than the first.
 */
function createAjv(): Ajv {
  return new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
}

const ajv = createAjv()
const outputValidators = new Map<string, ValidateFunction>()
const inputValidators = new Map<string, ValidateFunction>()

/** Render Ajv errors as stable, deduplicated strings. */
function renderErrors(errors: ValidateFunction['errors']): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const error of errors ?? []) {
    const path = error.instancePath === '' ? '(root)' : error.instancePath
    const line = `${path} ${error.message ?? 'is invalid'}`
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

/**
 * Validate a contract definition.
 *
 * This is deliberately strict about the identity fields: a contract whose
 * `toolName` is not a legal tool name, or whose version is not semver, would
 * register a tool that callers cannot address consistently.
 * @param contract - the definition to check.
 * @throws ContractError listing every violation.
 */
export function assertValidContract(contract: ToolContract): void {
  const violations: string[] = []
  if (!/^[a-z][a-z0-9_]*$/.test(contract.toolName)) {
    violations.push(`toolName ${JSON.stringify(contract.toolName)} must be lower snake_case`)
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(contract.contract)) {
    violations.push(
      `contract ${JSON.stringify(contract.contract)} must be a dotted lower-case identity `
      + '(for example "stt.transcribe" or "text.language_detect")',
    )
  }
  if (!/^\d+\.\d+\.\d+$/.test(contract.version)) {
    violations.push(`version ${JSON.stringify(contract.version)} must be semantic (x.y.z)`)
  }
  if (contract.description.trim().length < 10) {
    violations.push('description must be a real sentence, not a placeholder')
  }
  const input = contract.inputSchema as { type?: unknown }
  if (input.type !== 'object') {
    violations.push('inputSchema root must be an object (clients require an object argument)')
  }
  const output = contract.outputSchema as {
    type?: unknown
    properties?: Record<string, unknown>
    additionalProperties?: unknown
  }
  if (output.type !== 'object') {
    violations.push('outputSchema root must be an object for broad client compatibility (DECL-02)')
  } else if (output.properties?.meta === undefined) {
    violations.push('outputSchema must include the shared `meta` envelope (DECL-03)')
  }
  // DECL-02: an unconstrained open object is not an adequate leaf-tool contract.
  if (output.additionalProperties !== false) {
    violations.push('outputSchema must be closed (additionalProperties: false), not a generic open object (DECL-02)')
  }
  if (contract.unsupported.length === 0) {
    violations.push('unsupported must name at least one case; an empty list claims universal support')
  }
  if (violations.length > 0) throw new ContractError(contract.contract, violations)

  // Schemas must be compilable, or the contract is unenforceable.
  try {
    inputValidators.set(contract.contract, ajv.compile(contract.inputSchema))
  } catch (error) {
    throw new ContractError(contract.contract, [`inputSchema does not compile: ${message(error)}`])
  }
  try {
    outputValidators.set(contract.contract, ajv.compile(contract.outputSchema))
  } catch (error) {
    throw new ContractError(contract.contract, [`outputSchema does not compile: ${message(error)}`])
  }
}

/**
 * Validate caller arguments against the contract's input schema.
 * @param contract - the contract to check against.
 * @param args - the candidate arguments.
 * @throws ContractViolationError listing every violation.
 */
export function assertValidInput(contract: ToolContract, args: unknown): void {
  const validate = inputValidators.get(contract.contract)
  if (validate === undefined) {
    throw new ContractError(contract.contract, ['input was validated before the contract was registered'])
  }
  if (!validate(args)) throw new ContractViolationError(contract.contract, renderErrors(validate.errors))
}

/**
 * Validate a result against the contract's output schema.
 *
 * This runs before the value reaches a caller, so a violation surfaces as a
 * tool failure rather than as malformed data downstream (AT-11).
 * @param contract - the contract to check against.
 * @param value - the candidate result.
 * @throws ContractViolationError listing every violation.
 */
export function assertValidOutput(contract: ToolContract, value: unknown): void {
  const validate = outputValidators.get(contract.contract)
  if (validate === undefined) {
    throw new ContractError(contract.contract, ['result was validated before the contract was registered'])
  }
  if (!validate(value)) throw new ContractViolationError(contract.contract, renderErrors(validate.errors))
}

/** The meta envelope's own schema, exported for contract authors. */
export { TOOL_META_SCHEMA }

/** Best-effort message from an arbitrary thrown value. */
function message(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<unrenderable>'
  }
}
