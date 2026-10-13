/**
 * Validation: caller input, caller schemas, and the model's output.
 *
 * Three different validations happen here and they fail for different reasons, so they are
 * kept apart rather than merged into one "validate everything" pass:
 *
 * 1. **The shipped input schemas** decide whether a call is well-formed at all. They are
 *    the same documents the manifest names, compiled from disk, so a caller cannot reach a
 *    shape the published contract does not declare.
 * 2. **The extraction schema sanitiser** decides whether a caller's JSON Schema can be
 *    expressed as the engine's constraining grammar. This is the interesting one: the
 *    engine compiles a schema into a byte-level grammar, and a keyword it does not
 *    understand would be DROPPED — which produces an object that is well-formed, plausible,
 *    and violates the caller's contract in exactly the way nobody can see. So an
 *    unsupported keyword is refused by name.
 * 3. **The proposal validator** decides whether the model's answer is admissible. A
 *    proposal naming a tool the caller never offered is the model hallucinating, and the
 *    engine's own grammar does not prevent it: a name is a free string to the grammar
 *    unless the tool document constrains it. That check is this package's job.
 *
 * @module @try-works/extension-needle/validation
 */

import { readFileSync } from 'node:fs'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { CALL_LIMITS, EXTRACTION_FUNCTION_NAME, type OfferedTool } from './contracts.ts'

/**
 * The JSON Schema keywords the engine's grammar compiler is known to honour.
 *
 * Kept as a POSITIVE list for the same reason the environment allow-list is: a deny-list
 * would have to enumerate every keyword in the 2020-12 vocabulary and would be wrong the
 * moment a caller used one nobody thought of. `enum` and `const` are here because they are
 * the two that make an extraction useful; `format`, `pattern`, `minimum` and the rest are
 * absent because a grammar that ignores them would accept a value the caller excluded.
 */
const GRAMMAR_KEYWORDS: readonly string[] = [
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'additionalProperties',
]

/** The value types the grammar accepts. `integer` and `number` are both numbers to it. */
const GRAMMAR_TYPES: readonly string[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** A schema prepared for the engine, with the function name it is offered under. */
export interface PreparedExtraction {
  readonly tool: OfferedTool
  /** Every property path the caller declared, so a result can be checked against them. */
  readonly propertyPaths: readonly string[]
}

/** Refuse a caller schema the engine's grammar cannot express. */
export class SchemaRefusal extends Error {
  constructor(message: string, readonly path: string) {
    super(message)
    this.name = 'SchemaRefusal'
  }
}

let cachedInputValidators: Map<string, ValidateFunction> | undefined

/**
 * Compile a shipped input schema from the package's own `schema/` directory.
 *
 * Read from disk rather than restated in code, so the document the manifest publishes and
 * the document that actually validates a call cannot disagree. A code copy would drift the
 * first time one of them was edited.
 * @param fileName - the schema file name, e.g. `tools-plan.input.json`.
 * @returns the compiled validator.
 */
export function inputValidator(fileName: string): ValidateFunction {
  cachedInputValidators ??= new Map()
  const cached = cachedInputValidators.get(fileName)
  if (cached !== undefined) return cached
  const url = new URL(`../schema/${fileName}`, import.meta.url)
  const schema = JSON.parse(readFileSync(url, 'utf8')) as object
  // The 2020-12 dialect, because the schemas declare it; a draft-07 validator would reject
  // the `$schema` keyword itself and report every schema as uncompilable.
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const compiled = ajv.compile(schema)
  cachedInputValidators.set(fileName, compiled)
  return compiled
}

/**
 * Render Ajv errors as stable, path-qualified strings.
 *
 * The offending property NAME is included where Ajv puts it in `params` rather than in the
 * message: `additionalProperties: false` reports "must NOT have additional properties" at the
 * PARENT path, so a report built from `instancePath` alone would say a payload was wrong
 * without saying which field made it wrong.
 * @param errors - the validator's errors.
 * @returns deduplicated, human-readable lines.
 */
export function renderErrors(errors: ValidateFunction['errors']): string[] {
  const out: string[] = []
  for (const error of errors ?? []) {
    const path = error.instancePath === '' ? '(root)' : error.instancePath
    const params = error.params as Record<string, unknown>
    const named = typeof params.additionalProperty === 'string'
      ? ` (${params.additionalProperty})`
      : typeof params.missingProperty === 'string'
        ? ` (${params.missingProperty})`
        : ''
    const line = `${path} ${error.message ?? 'is invalid'}${named}`
    if (!out.includes(line)) out.push(line)
  }
  return out
}

/**
 * Validate a caller's input against a shipped schema.
 * @param fileName - the schema file to validate against.
 * @param value - the caller's input.
 * @throws Error listing every violation, so a caller fixes all of them at once.
 */
export function assertInput(fileName: string, value: unknown): void {
  const validate = inputValidator(fileName)
  if (validate(value)) return
  throw new Error(`the input does not satisfy ${fileName}: ${renderErrors(validate.errors).join('; ')}`)
}

/**
 * Reject a tool name that is not a plain identifier.
 *
 * Exported because the name is checked in two places with different consequences: here,
 * before it becomes a line in the engine's tool DOCUMENT, and again in the provider, before
 * a returned proposal's name is compared against the offered set.
 * @param name - the proposed name.
 * @param path - where it came from, for the message.
 * @throws SchemaRefusal naming the rule.
 */
export function assertToolName(name: string, path: string): void {
  if (name.length === 0 || name.length > CALL_LIMITS.maxToolNameCharacters) {
    throw new SchemaRefusal(
      `the tool name ${JSON.stringify(name)} must be 1..${CALL_LIMITS.maxToolNameCharacters} characters`,
      path,
    )
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
    throw new SchemaRefusal(`the tool name ${JSON.stringify(name)} is not a plain identifier`, path)
  }
}

/**
 * Strip and check a caller's extraction schema for the engine's grammar.
 *
 * The returned schema is a COPY restricted to the accepted vocabulary. `additionalProperties`
 * is forced to `false` on every object, because the engine's grammar constrains the tokens
 * it emits and an open object invites a field the caller never asked for; a closed object
 * makes an unexpected field a grammar violation instead of a surprise in the result.
 * @param schema - the caller's schema object.
 * @returns the schema to offer the engine, plus the property paths it declares.
 * @throws SchemaRefusal naming the first unsupported keyword or structure.
 */
export function prepareExtractionSchema(schema: unknown): {
  readonly schema: Record<string, unknown>
  readonly propertyPaths: readonly string[]
} {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaRefusal('the extraction schema must be a JSON object', '(root)')
  }
  if ((schema as Record<string, unknown>).type !== 'object') {
    throw new SchemaRefusal(
      'the extraction schema must have "type": "object" at its root: the engine returns one record per call',
      '(root).type',
    )
  }
  const propertyPaths: string[] = []
  let propertyCount = 0

  const walk = (node: unknown, depth: number, path: string): unknown => {
    if (depth > CALL_LIMITS.maxSchemaDepth) {
      throw new SchemaRefusal(
        `the schema nests deeper than the ${CALL_LIMITS.maxSchemaDepth}-level limit`,
        path,
      )
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new SchemaRefusal('a schema node must be an object', path)
    }
    const source = node as Record<string, unknown>
    for (const keyword of Object.keys(source)) {
      if (!GRAMMAR_KEYWORDS.includes(keyword)) {
        // Refused, not dropped. A dropped `minimum: 0` would let the engine return a
        // negative quantity that the caller's own validator then rejects — or worse, does
        // not, because the caller assumed the schema was honoured.
        throw new SchemaRefusal(
          `the schema keyword ${JSON.stringify(keyword)} is not part of the engine's grammar vocabulary `
          + `(${GRAMMAR_KEYWORDS.join(', ')}); it would be dropped rather than enforced, so it is refused`,
          `${path}.${keyword}`,
        )
      }
    }
    const out: Record<string, unknown> = {}
    const type = source.type
    if (type !== undefined) {
      if (Array.isArray(type)) {
        // A union type is expressible only as `["x","null"]`, which is the nullable form the
        // engine's grammar handles; anything else is refused rather than approximated.
        const members = type.filter((member): member is string => typeof member === 'string')
        const nullable = members.length === 2 && members.includes('null')
        if (!nullable) {
          throw new SchemaRefusal(
            `the type union ${JSON.stringify(type)} is not expressible; only ["<type>","null"] is admitted`,
            `${path}.type`,
          )
        }
        out.type = members
      } else if (typeof type === 'string' && GRAMMAR_TYPES.includes(type)) {
        out.type = type
      } else {
        throw new SchemaRefusal(`the type ${JSON.stringify(type)} is not admitted`, `${path}.type`)
      }
    }
    if (typeof source.description === 'string') out.description = source.description
    if (typeof source.title === 'string') out.title = source.title
    if (source.const !== undefined) out.const = source.const
    if (Array.isArray(source.enum)) out.enum = source.enum
    if (source.items !== undefined) {
      if (out.type !== 'array') {
        throw new SchemaRefusal('"items" is only admitted where "type" is "array"', `${path}.items`)
      }
      out.items = walk(source.items, depth + 1, `${path}[]`)
    }
    if (source.properties !== undefined) {
      if (out.type !== 'object') {
        throw new SchemaRefusal('"properties" is only admitted where "type" is "object"', `${path}.properties`)
      }
      const properties = source.properties
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        throw new SchemaRefusal('"properties" must be an object', `${path}.properties`)
      }
      const converted: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
        propertyCount += 1
        if (propertyCount > CALL_LIMITS.maxSchemaProperties) {
          throw new SchemaRefusal(
            `the schema declares more than the ${CALL_LIMITS.maxSchemaProperties}-property limit`,
            `${path}.properties.${name}`,
          )
        }
        propertyPaths.push(`${path}.${name}`)
        converted[name] = walk(child, depth + 1, `${path}.${name}`)
      }
      out.properties = converted
      // Forced closed. See the note above: an open object is how an unrequested field
      // arrives, and the engine's grammar is the only place that can prevent it cheaply.
      out.additionalProperties = false
      out.required = Array.isArray(source.required)
        ? (source.required as unknown[]).filter((name): name is string => typeof name === 'string')
        : Object.keys(converted)
      for (const name of out.required as string[]) {
        if (!(name in converted)) {
          throw new SchemaRefusal(
            `"required" names ${JSON.stringify(name)}, which is not a declared property`,
            `${path}.required`,
          )
        }
      }
    }
    return out
  }

  const prepared = walk(schema, 1, '(root)') as Record<string, unknown>
  return { schema: prepared, propertyPaths }
}

/**
 * Build the single function the engine's grammar is compiled from.
 * @param prepared - the prepared schema.
 * @param instruction - what the caller asked for, used as the function description.
 * @returns the offered tool.
 */
export function extractionTool(
  prepared: { readonly schema: Record<string, unknown> },
  instruction: string,
): OfferedTool {
  return {
    name: EXTRACTION_FUNCTION_NAME,
    description: instruction,
    parameters: prepared.schema,
  }
}

/** What one argument check found. */
export interface ArgumentReport {
  readonly valid: boolean
  readonly issues: readonly string[]
}

/**
 * Check one proposed argument object against an offered tool's schema.
 *
 * A tool whose `parameters` is not a compilable schema is reported as an issue rather than
 * throwing: the tool list is caller-supplied, so a malformed entry is the caller's bug and
 * must not take down the call.
 * @param tool - the offered tool.
 * @param args - the proposed arguments.
 * @returns the verdict and every violation.
 */
export function checkArguments(
  tool: OfferedTool,
  args: Record<string, unknown>,
): ArgumentReport {
  let validate: ValidateFunction
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    validate = ajv.compile(tool.parameters)
  } catch (error) {
    return {
      valid: false,
      issues: [
        `the offered schema for ${tool.name} does not compile: `
        + `${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  if (validate(args)) return { valid: true, issues: [] }
  return { valid: false, issues: renderErrors(validate.errors) }
}
