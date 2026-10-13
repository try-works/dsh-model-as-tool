/**
 * Projection of a contract into DSH's parameter DSL (DECL-01).
 *
 * DECL-01 requires that DSH registration, MCP projection and Code Mode types all
 * come from one source. The contract's JSON Schema is that source; this module is
 * the DSH-specific projection of it.
 *
 * It replaces the old registrar behaviour that inferred the required input from
 * parameter ORDER (BASE-04). Requiredness now comes from the schema's `required`
 * array, so a contract cannot silently change meaning when a property is
 * reordered.
 *
 * @module @try-works/tool-mode-contracts/dsh
 */

import type { ToolContract } from './registry.ts'

/** One DSH parameter property: a JSON-Schema subset plus `required`. */
type DshProperty = Record<string, unknown> & { required?: true }

/** The implicit-open-object parameter map DSH expects. */
export type DshParameters = Record<string, DshProperty>

/** The result of projecting a contract into DSH's narrower DSL. */
export interface DshProjection {
  /** What the model-facing parameter schema advertises. */
  readonly parameters: DshParameters
  /**
   * Contract keywords the parameter schema cannot advertise, in `path.keyword`
   * form. They remain enforced at runtime against the full contract schema.
   */
  readonly runtimeEnforced: readonly string[]
}

/** Raised when a contract uses a schema shape the DSH DSL cannot express. */
export class ProjectionError extends Error {
  override readonly name = 'ProjectionError'
  readonly unsupported: readonly string[]
  constructor(contract: string, unsupported: readonly string[]) {
    super(
      `${contract} cannot be projected into the DSH parameter DSL: ${unsupported.join('; ')}. `
      + 'Weakening the schema silently is not permitted (BASE-04), so the contract must be reshaped.',
    )
    this.unsupported = unsupported
  }
}

/**
 * JSON-Schema keywords the DSH value-schema DSL can carry.
 *
 * Anything outside this set is not DISCARDED: it stays in the contract and is
 * enforced at runtime by {@link assertValidInput}, which validates arguments
 * against the full contract schema before the implementation runs. This module
 * only decides what the model-facing parameter schema advertises.
 */
const DSH_SUPPORTED = new Set([
  'type', 'enum', 'const', 'description', 'default', 'examples',
  'items', 'properties', 'additionalProperties', 'required',
])

/**
 * Project one JSON-Schema node into the subset DSH can carry.
 *
 * Recursive because DSH validates nested object properties too, so a constraint
 * on `audio.path` reaches the same DSL limit as one on a top-level property.
 * @param node - the schema node to project.
 * @param path - dotted path for reporting what was left out.
 * @param runtimeEnforced - accumulates `path.keyword` entries.
 * @returns the projected node.
 */
function projectNode(
  node: Record<string, unknown>,
  path: string,
  runtimeEnforced: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [keyword, value] of Object.entries(node)) {
    if (!DSH_SUPPORTED.has(keyword)) {
      runtimeEnforced.push(`${path}.${keyword}`)
      continue
    }
    if (keyword === 'properties' && typeof value === 'object' && value !== null) {
      const nested: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        nested[name] = typeof child === 'object' && child !== null
          ? projectNode(child as Record<string, unknown>, `${path}.${name}`, runtimeEnforced)
          : child
      }
      out[keyword] = nested
    } else if (keyword === 'items' && typeof value === 'object' && value !== null) {
      out[keyword] = projectNode(value as Record<string, unknown>, `${path}[]`, runtimeEnforced)
    } else {
      out[keyword] = value
    }
  }
  return out
}

/**
 * Project a contract's input schema into DSH parameters.
 *
 * DSH's DSL is narrower than JSON Schema — it has no `minLength`, `minimum` or
 * `pattern` at any nesting level — so the projection is deliberately lossy in what
 * it ADVERTISES while remaining complete in what it ENFORCES. BASE-04 forbids
 * silently discarding a constraint, so every keyword left out is returned in
 * {@link DshProjection.runtimeEnforced} and is checked by `assertValidInput`
 * against the untouched contract.
 * @param contract - the contract to project.
 * @returns the parameter map plus the keywords enforced only at runtime.
 */
export function projectToDsh(contract: ToolContract): DshProjection {
  const schema = contract.inputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const runtimeEnforced: string[] = []

  const out: DshParameters = {}
  for (const [name, property] of Object.entries(properties)) {
    const projected = projectNode(property, name, runtimeEnforced) as DshProperty
    if (required.has(name)) projected.required = true
    out[name] = projected
  }

  // A required property that is not declared cannot be satisfied by any caller.
  const undeclared = [...required].filter(name => !(name in properties))
  if (undeclared.length > 0) {
    throw new ProjectionError(contract.contract, undeclared.map(name => `required property "${name}" is not declared`))
  }

  return { parameters: out, runtimeEnforced }
}

/**
 * Project a contract's input schema into DSH parameters.
 * @param contract - the contract to project.
 * @returns the parameter map.
 * @throws ProjectionError when the schema is internally inconsistent.
 */
export function toDshParameters(contract: ToolContract): DshParameters {
  return projectToDsh(contract).parameters
}

/**
 * Cross-field constraints the DSH parameter DSL cannot express (BASE-04).
 *
 * Each returns a violation message, or undefined when the arguments are
 * acceptable. They run after schema validation, so each may assume its fields
 * are present and correctly typed.
 */
export type CrossFieldRule = (args: Record<string, unknown>) => string | undefined

/** The cross-field rules that apply to a given contract. */
export function crossFieldRules(contract: ToolContract): CrossFieldRule[] {
  switch (contract.contract) {
    case 'stt.transcribe':
      return [
        (args) => {
          const timestamps = args.timestamps
          if (timestamps === 'word' && args.language === undefined) {
            // Not a hard error, but a caller asking for word timing without
            // declaring a language gets worse results on code-switched audio.
            return undefined
          }
          return undefined
        },
        (args) => {
          const audio = args.audio as { sampleRateHz?: number; channels?: number } | undefined
          if (audio?.channels !== undefined && audio.channels !== 1) {
            return 'audio.channels must be 1: the admitted input is 16 kHz mono'
          }
          if (audio?.sampleRateHz !== undefined && audio.sampleRateHz !== 16000) {
            return 'audio.sampleRateHz must be 16000: resampling is not part of this contract'
          }
          return undefined
        },
      ]
    case 'text.language_detect':
      return [
        (args) => {
          const text = args.text
          if (typeof text === 'string' && text.trim().length === 0) {
            return 'text must contain at least one non-whitespace character'
          }
          return undefined
        },
      ]
    default:
      return []
  }
}
