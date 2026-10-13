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
 * Keywords that carry real constraints and have no DSH equivalent.
 *
 * BASE-04 ends with "Never silently discard unsupported schema constraints", so
 * these are collected and reported rather than dropped. Purely descriptive
 * keywords (`description`, `default`, `examples`) are not constraints and are
 * safe to omit.
 */
const UNREPRESENTABLE = [
  'oneOf', 'anyOf', 'allOf', 'not', 'patternProperties', 'dependencies',
  'dependentRequired', 'dependentSchemas', 'if', 'then', 'else',
  'minProperties', 'maxProperties', 'contains', 'uniqueItems',
] as const

/**
 * Project a contract's input schema into DSH parameters.
 * @param contract - the contract to project.
 * @returns the parameter map, with `required: true` on the schema's required properties.
 * @throws ProjectionError when the schema needs a constraint DSH cannot express.
 */
export function toDshParameters(contract: ToolContract): DshParameters {
  const schema = contract.inputSchema as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const unsupported: string[] = []

  const out: DshParameters = {}
  for (const [name, property] of Object.entries(properties)) {
    for (const keyword of UNREPRESENTABLE) {
      if (keyword in property) unsupported.push(`${name}.${keyword}`)
    }
    const { description, default: fallback, ...rest } = property
    const projected: DshProperty = { ...rest }
    if (typeof description === 'string') projected.description = description
    if (fallback !== undefined) projected.default = fallback
    if (required.has(name)) projected.required = true
    out[name] = projected
  }

  // A required property that is not declared would be unsatisfiable.
  for (const name of required) {
    if (!(name in properties)) unsupported.push(`required property "${name}" is not declared`)
  }

  if (unsupported.length > 0) throw new ProjectionError(contract.contract, unsupported)
  return out
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
