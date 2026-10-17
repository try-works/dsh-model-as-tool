/**
 * The declarative recipe package format (RCP-01, RCP-02, RCP-03, RCP-05, RCP-06).
 *
 * A recipe is TRUSTED, DATA-ONLY: a static instruction string plus typed input
 * bindings. It is deliberately neither a PTC program nor an autonomous subagent. It has
 * no statements, no expressions, no imports and no filesystem access, because the moment
 * a recipe can COMPUTE something it needs an interpreter with a threat model instead of
 * a validator with an allow-list — and the threat model is the expensive part.
 *
 * Every rule below exists to keep that true against a recipe that is trying not to be
 * data, and each one names what it prevents:
 *
 * - **Unknown keys are refused, not ignored.** A key this host does not implement is
 *   either a typo or a field that means something elsewhere; silently dropping it runs a
 *   recipe that is not the one the author wrote (RCP-02, RCP-06).
 * - **`tools`, `messages`, `history` and `conversation` are refused BY NAME**, with a
 *   reason that says a recipe is data and not a program. HLM-05 forbids inheriting the
 *   parent's conversation, system prompt, tools, skills, attachments or memory, so a
 *   recipe that asks for any of them is refused here rather than quietly starved of them
 *   at dispatch time.
 * - **Executable template syntax is refused.** `{{name}}` is a binding placeholder and
 *   nothing else; `${...}` and `<%...%>` are template CODE, and RCP-02 forbids it.
 * - **A placeholder that names no declared input is refused** (RCP-03: an unbound
 *   pointer), because a template referring to something the caller can never supply is a
 *   recipe that cannot be satisfied.
 * - **The limits are RES-10's initial per-leaf maxima**, asserted individually: 1024
 *   output tokens and two image inputs. A recipe may lower a limit, never raise it.
 * - **The parsed recipe is deep-frozen**, so a caller holding it cannot widen the limits
 *   or rewrite the instructions it was authorized with (RCP-05, RCP-06).
 *
 * Bindings are a NAME-KEYED map rather than the specification's JSON Pointers on
 * purpose. A pointer is a small language — `/a/b/0`, `~0` escapes, `-`, traversal past a
 * reserved member — and RCP-03 has to reject all of it. A closed map of identifier-named
 * inputs has no pointer to traverse, so the whole class of pointer abuse is absent by
 * construction rather than by check.
 *
 * @module @try-works/tool-mode-recipes/recipe-format
 */

/**
 * RES-10's initial maximum output tokens for one leaf invocation.
 *
 * Restated here rather than imported: this package must not depend on the host package,
 * because a declarative recipe package is loaded by the host and not the other way
 * around (EXT-02, ARCH-02). The number is asserted in the tests so a drift between the
 * two copies is a failing test rather than a silent budget change.
 */
export const INITIAL_MAX_OUTPUT_TOKENS = 1024

/** RES-10's initial maximum image inputs for one leaf invocation. */
export const INITIAL_MAX_IMAGE_INPUTS = 2

/** The only keys a recipe may carry at the top level. */
export const RECIPE_TOP_LEVEL_KEYS: readonly string[] = [
  'id',
  'version',
  'description',
  'tool',
  'inputs',
  'promptTemplate',
  'maxOutputTokens',
  'imageInputs',
  'policy',
]

/**
 * Key names that are refused wherever they appear, at any depth.
 *
 * These are the fields through which a recipe would stop being data and start being a
 * program with access to the parent agent's context. They are checked BEFORE the
 * allow-list so the failure names the real problem — "a recipe is data, not a program" —
 * instead of reporting a generic unknown key.
 */
export const FORBIDDEN_RECIPE_KEYS: readonly string[] = [
  'tools',
  'tool_calls',
  'toolCalls',
  'messages',
  'history',
  'conversation',
  'attachments',
  'memory',
  'skills',
  'systemPrompt',
  // RCP-02's own context flags. HLM-05 says a flag meaning "take the entire
  // conversation" is not supported in this release, so the flag is refused rather than
  // accepted and then ignored — an ignored flag is a promise the host does not keep.
  'inheritConversation',
  'includeTools',
]

/**
 * Property names that must never appear, because they reach past data into the object
 * model (RCP-03: reserved prototype/member abuse).
 */
export const RESERVED_RECIPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype']

/** A legal input name, a legal placeholder and a legal JSON Schema property. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A legal contract identity.
 *
 * Two spellings, because the specification uses two: a STANDARD contract is a dotted
 * lower-case identity (`text.title`), which is the form `tool-mode-contracts` publishes,
 * and a THIRD-PARTY contract is scoped to the package that owns it
 * (`@acme/tool-mode-image-review/review`), which is the form the TMX manifest example
 * uses. Refusing the second would reject a spec-conformant third-party recipe, so both
 * are admitted and the identity comparison below is what actually protects against a
 * recipe claiming another tool.
 */
const CONTRACT_IDENTITY = /^(?:[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)$/

/** The keys a recipe's `tool` object may carry. */
const TOOL_KEYS: readonly string[] = ['name', 'contractId']

/** The keys a recipe's `imageInputs` object may carry. */
const IMAGE_INPUTS_KEYS: readonly string[] = ['max']

/** The keys a recipe's `policy` object may carry. */
const POLICY_KEYS: readonly string[] = ['record', 'allowRemote']

/** The keys one input declaration may carry. */
const INPUT_KEYS: readonly string[] = [
  'type',
  'required',
  'description',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'enum',
  'default',
  'mediaTypes',
  'maxBytes',
  'jsonSerialized',
]

/** The input kinds a recipe may declare. */
export type RecipeInputKind = 'string' | 'integer' | 'number' | 'boolean' | 'image'

/** The kinds this format understands, for validation and error messages. */
const INPUT_KINDS: readonly RecipeInputKind[] = ['string', 'integer', 'number', 'boolean', 'image']

/**
 * One declarative input binding.
 *
 * The vocabulary is JSON-Schema-ish so the same declaration can be projected into a real
 * JSON Schema for DSH registration ({@link inputSchemaFor}) and into a tool contract,
 * with no second description of the input to drift from this one.
 */
export interface RecipeInputDeclaration {
  /** The binding kind. `image` is this format's typed media binding, not a JSON Schema type. */
  readonly type: RecipeInputKind
  /** Whether a caller must supply it. Defaults to false. */
  readonly required: boolean
  /** What the input is for. Bound into nothing; documentation for the author and the caller. */
  readonly description?: string
  /** Minimum characters, for `string`. */
  readonly minLength?: number
  /** Maximum characters, for `string`. */
  readonly maxLength?: number
  /** Minimum value, for `integer` and `number`. */
  readonly minimum?: number
  /** Maximum value, for `integer` and `number`. */
  readonly maximum?: number
  /** Admitted values, for the scalar kinds. */
  readonly enum?: readonly (string | number | boolean)[]
  /** The value used when a caller omits the field. */
  readonly default?: string | number | boolean
  /** Admitted media types, for `image`. */
  readonly mediaTypes?: readonly string[]
  /** Maximum bytes of one image, for `image`. */
  readonly maxBytes?: number
  /**
   * Set only by a CANONICAL RCP-02 `inputBindings` entry of kind `"json"`: the
   * caller supplies a data-only object or array, which is JSON-serialized into
   * the bound string (RCP-03's "JSON serialization" binding).
   */
  readonly jsonSerialized?: true
}

/** The recipe's declared input map, keyed by input name. */
export type RecipeInputMap = Readonly<Record<string, RecipeInputDeclaration>>

/** The tool identity a recipe implements (RCP-06). */
export interface RecipeToolIdentity {
  /** The tool name, e.g. `text_title`. */
  readonly name: string
  /** The contract identity, e.g. `text.title`. */
  readonly contractId: string
}

/**
 * What a recipe declares about recording and destinations.
 *
 * Both are DECLARATIONS, not grants: the host's policy decides whether the invocation
 * actually runs, and `record: false` under a host that requires recording is refused
 * rather than silently dropped (HLM-09).
 */
export interface RecipePolicy {
  /** Whether the invocation's prepared request must be journaled. */
  readonly record: boolean
  /** Whether a remote destination is acceptable to the author. */
  readonly allowRemote: boolean
}

/** A validated, frozen recipe. */
export interface RecipeManifest {
  /** Recipe identity, e.g. `text-title`. */
  readonly id: string
  /** Semantic version (RCP-06: a prompt change is a version change). */
  readonly version: string
  /** A real sentence describing what the recipe does. */
  readonly description: string
  /** The tool this recipe implements. */
  readonly tool: RecipeToolIdentity
  /** The declared inputs, in declaration order. */
  readonly inputs: RecipeInputMap
  /** The static instruction text, with `{{name}}` binding placeholders. */
  readonly promptTemplate: string
  /** The recipe's own output-token ceiling. Never above RES-10's initial maximum. */
  readonly maxOutputTokens: number
  /** The image inputs this recipe permits. `max` is never above RES-10's initial maximum. */
  readonly imageInputs: { readonly max: number }
  /** Recording and destination declarations. */
  readonly policy: RecipePolicy
  /**
   * Present only when a CANONICAL recipe selects `approved-profile` (RCP-05):
   * the logical profile name the operator binds; unresolved bindings keep the
   * tool unavailable with `EXECUTOR_NOT_CONFIGURED`.
   */
  readonly modelSelection?: { readonly strategy: 'approved-profile'; readonly profile: string }
  /**
   * Present only when a CANONICAL recipe declares `response` (RCP-04). `json`
   * mode is prompt-enforced and locally validated in this build — no provider
   * structured-output negotiation — which the describe metadata discloses.
   */
  readonly response?: { readonly mode: 'text' | 'json'; readonly field: string }
}

/** Errors this format reports, using RCP-11's vocabulary where it has a code. */
export type RecipeErrorCode =
  /** The recipe is not a valid recipe. */
  | 'INVALID_RECIPE'
  /** The supplied arguments do not satisfy the recipe's declared inputs. */
  | 'RECIPE_BINDING_ERROR'
  /** The supplied bindings exceed a budget RES-10 states. */
  | 'MODEL_BUDGET_EXCEEDED'
  /** A binding carries a media type the recipe does not admit. */
  | 'UNSUPPORTED_MODALITY'

/**
 * Render one named error.
 *
 * The code prefix is what a caller switches on; the sentence after it is what a human
 * reads. Both are needed: a code alone does not say which key was wrong, and a sentence
 * alone cannot be matched on without matching prose.
 * @param code - the error code.
 * @param message - the specific problem, naming the offending key or field.
 * @returns the rendered error.
 */
export function formatRecipeError(code: RecipeErrorCode, message: string): string {
  return `${code}: ${message}`
}

/**
 * The code of a rendered error.
 * @param error - a rendered error.
 * @returns the code, or the whole string when it carries no prefix.
 */
export function errorCodeOf(error: string): string {
  const separator = error.indexOf(':')
  return separator === -1 ? error : error.slice(0, separator)
}

/** What a bound argument may be: a scalar, or a typed image reference. */
export type RecipeValue = string | number | boolean | RecipeImageValue

/**
 * A bound image: the media type plus the ACTUAL bytes.
 *
 * Bytes, not a path and not a URL. A path would make the provider call depend on a
 * filesystem read that happens outside the validated request, and a URL would make it
 * depend on the network; both break the property that the request is fully described by
 * the recipe and the bound inputs (HLM-05, RCP-03).
 */
export interface RecipeImageValue {
  /** The image's media type, e.g. `image/png`. */
  readonly mediaType: string
  /** The image bytes. */
  readonly bytes: Uint8Array
}

/** The result of parsing a recipe. */
export type RecipeParseResult =
  | { readonly ok: true; readonly recipe: RecipeManifest }
  | { readonly ok: false; readonly errors: readonly string[] }

/** The result of binding caller arguments to a recipe's declared inputs. */
export type RecipeBindingResult =
  | { readonly ok: true; readonly values: Readonly<Record<string, RecipeValue>> }
  | { readonly ok: false; readonly errors: readonly string[] }

/** Options that tie a recipe to the tool whose implementation it claims to be. */
export interface ParseRecipeOptions {
  /** The tool name the recipe is being loaded as. A mismatch is refused (RCP-06). */
  readonly expectedToolName?: string
  /** The contract identity the recipe is being loaded as. A mismatch is refused. */
  readonly expectedContractId?: string
}

/** Whether a value is a plain JSON-style object, as opposed to an array or a class. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  // A class instance, a Date, a Map or a RegExp is not data; a null-prototype object is.
  return prototype === Object.prototype || prototype === null
}

/** Name a value's kind for an error message. */
function describeKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const kind = typeof value
  if (kind !== 'object') return `a ${kind}`
  return isPlainObject(value) ? 'an object' : 'a non-plain object (a class instance is not data)'
}

/** Freeze a recipe in place, at every depth. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Walk the raw recipe, refusing anything that is not data.
 *
 * Two rules run together here because both are about a value's POSITION, not its shape:
 * a key that names context the request must not carry, and a key that reaches into the
 * object model. Doing this as a walk rather than as a top-level check is what catches
 * `{ tool: { history: [] } }`, which a top-level allow-list would report as a mere
 * unknown nested key.
 * @param node - the value being walked.
 * @param path - the dotted path, for the error message.
 * @param errors - collected errors.
 */
function checkDataOnly(node: unknown, path: string, errors: string[]): void {
  if (node === null || typeof node === 'string' || typeof node === 'boolean') return
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) {
      errors.push(formatRecipeError('INVALID_RECIPE', `${path} is not a finite number; NaN and Infinity are not JSON data`))
    }
    return
  }
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) checkDataOnly(item, `${path}[${index}]`, errors)
    return
  }
  if (!isPlainObject(node)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `${path} is ${describeKind(node)}, which is not data. A recipe may contain only JSON values — no functions, `
      + 'no classes, no executable template code (RCP-02)',
    ))
    return
  }
  for (const [key, value] of Object.entries(node)) {
    const child = path === '' ? key : `${path}.${key}`
    if (FORBIDDEN_RECIPE_KEYS.includes(key)) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `${child} is refused by name. A recipe is DATA, not a program: it cannot supply tools, messages, `
        + 'conversation history, attachments, memory or skills, because the broker builds the provider request from '
        + 'the recipe and the bound inputs alone (HLM-05, HLM-06). Remove the key; something that needs tools is a '
        + 'PTC program, which is a different artifact',
      ))
      continue
    }
    if (RESERVED_RECIPE_KEYS.includes(key)) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `${child} uses a reserved property name; RCP-03 rejects reserved prototype/member abuse`,
      ))
      continue
    }
    checkDataOnly(value, child, errors)
  }
}

/** The unknown keys in an object, against an allow-list. */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter(key => !allowed.includes(key))
}

/** Render an unknown-key refusal. */
function unknownKeyError(path: string, key: string, allowed: readonly string[]): string {
  return formatRecipeError(
    'INVALID_RECIPE',
    `${path}${path === '' ? '' : '.'}${key} is not a key this format has. Allowed here: ${allowed.join(', ')}. `
    + 'A recipe\'s shape is closed: an unknown key is a typo or a field this host does not implement, and ignoring it '
    + 'would run a recipe other than the one the author wrote (RCP-02, RCP-06)',
  )
}

/** Read a finite integer, or report why not. */
function readInteger(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push(formatRecipeError('INVALID_RECIPE', `${path} must be an integer; received ${describeKind(value)}`))
    return undefined
  }
  return value
}

/** Read a non-empty string, or report why not. */
function readNonEmptyString(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(formatRecipeError('INVALID_RECIPE', `${path} must be a string; received ${describeKind(value)}`))
    return undefined
  }
  if (value.trim().length === 0) {
    errors.push(formatRecipeError('INVALID_RECIPE', `${path} must not be empty`))
    return undefined
  }
  return value
}

/**
 * Validate one input declaration.
 * @param name - the input name.
 * @param raw - the raw declaration.
 * @param errors - collected errors.
 * @returns the declaration, when it is valid enough to keep.
 */
function parseInputDeclaration(
  name: string,
  raw: unknown,
  errors: string[],
): RecipeInputDeclaration | undefined {
  const path = `inputs.${name}`
  if (!IDENTIFIER.test(name)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `${path} is not a legal input name. A name is an identifier because it is also the placeholder the template `
      + 'binds, and a name that cannot be written as `{{name}}` cannot be bound at all',
    ))
    return undefined
  }
  if (!isPlainObject(raw)) {
    errors.push(formatRecipeError('INVALID_RECIPE', `${path} must be an object; received ${describeKind(raw)}`))
    return undefined
  }
  for (const key of unknownKeys(raw, INPUT_KEYS)) errors.push(unknownKeyError(path, key, INPUT_KEYS))

  const declaredType = raw['type']
  if (typeof declaredType !== 'string' || !INPUT_KINDS.includes(declaredType as RecipeInputKind)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `${path}.type must be one of ${INPUT_KINDS.join(', ')}; received ${JSON.stringify(declaredType)}`,
    ))
    return undefined
  }
  const type = declaredType as RecipeInputKind

  const requiredRaw = raw['required']
  if (requiredRaw !== undefined && typeof requiredRaw !== 'boolean') {
    errors.push(formatRecipeError('INVALID_RECIPE', `${path}.required must be a boolean`))
  }
  const required = requiredRaw === true

  const declaration: {
    type: RecipeInputKind
    required: boolean
    description?: string
    minLength?: number
    maxLength?: number
    minimum?: number
    maximum?: number
    enum?: readonly (string | number | boolean)[]
    default?: string | number | boolean
    mediaTypes?: readonly string[]
    maxBytes?: number
    jsonSerialized?: true
  } = { type, required }

  // A canonical `inputBindings` kind "json" binding arrives as a string
  // declaration carrying this marker; it is read through so the canonical
  // round trip stays lossless.
  if (raw['jsonSerialized'] !== undefined) {
    if (raw['jsonSerialized'] !== true || type !== 'string') {
      errors.push(formatRecipeError('INVALID_RECIPE', `${path}.jsonSerialized must be true and only applies to a string binding`))
    } else {
      declaration.jsonSerialized = true
    }
  }

  if (raw['description'] !== undefined) {
    const description = readNonEmptyString(raw['description'], `${path}.description`, errors)
    if (description !== undefined) declaration.description = description
  }

  /**
   * Keywords are only accepted on the kind they constrain.
   *
   * A `maxLength` on an image, or a `minimum` on a string, is a constraint its author
   * believes is enforced. Silently ignoring it would ship a bound the recipe never had,
   * which is the failure BASE-04 names for schema projection.
   */
  const keyword = (key: string, kinds: readonly RecipeInputKind[]): unknown => {
    const value = raw[key]
    if (value === undefined) return undefined
    if (!kinds.includes(type)) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `${path}.${key} does not apply to an input of type "${type}"; it constrains ${kinds.join(' or ')}. A constraint `
        + 'that is ignored is a bound the author believes is enforced',
      ))
      return undefined
    }
    return value
  }

  const minLength = keyword('minLength', ['string'])
  if (minLength !== undefined) {
    const value = readInteger(minLength, `${path}.minLength`, errors)
    if (value !== undefined) declaration.minLength = value
  }
  const maxLength = keyword('maxLength', ['string'])
  if (maxLength !== undefined) {
    const value = readInteger(maxLength, `${path}.maxLength`, errors)
    if (value !== undefined) declaration.maxLength = value
  }
  const minimum = keyword('minimum', ['integer', 'number'])
  if (minimum !== undefined) {
    const value = typeof minimum === 'number' && Number.isFinite(minimum) ? minimum : undefined
    if (value === undefined) errors.push(formatRecipeError('INVALID_RECIPE', `${path}.minimum must be a finite number`))
    else declaration.minimum = value
  }
  const maximum = keyword('maximum', ['integer', 'number'])
  if (maximum !== undefined) {
    const value = typeof maximum === 'number' && Number.isFinite(maximum) ? maximum : undefined
    if (value === undefined) errors.push(formatRecipeError('INVALID_RECIPE', `${path}.maximum must be a finite number`))
    else declaration.maximum = value
  }
  const enumerated = keyword('enum', ['string', 'integer', 'number', 'boolean'])
  if (enumerated !== undefined) {
    if (!Array.isArray(enumerated) || enumerated.length === 0
      || !enumerated.every(member => typeof member === 'string' || typeof member === 'number' || typeof member === 'boolean')) {
      errors.push(formatRecipeError('INVALID_RECIPE', `${path}.enum must be a non-empty array of scalar values`))
    } else {
      declaration.enum = enumerated as readonly (string | number | boolean)[]
    }
  }
  const mediaTypes = keyword('mediaTypes', ['image'])
  if (mediaTypes !== undefined) {
    if (!Array.isArray(mediaTypes) || mediaTypes.length === 0
      || !mediaTypes.every(member => typeof member === 'string' && member.startsWith('image/'))) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `${path}.mediaTypes must be a non-empty array of image media types (for example "image/png")`,
      ))
    } else {
      declaration.mediaTypes = mediaTypes as readonly string[]
    }
  }
  const maxBytes = keyword('maxBytes', ['image'])
  if (maxBytes !== undefined) {
    const value = readInteger(maxBytes, `${path}.maxBytes`, errors)
    if (value !== undefined) {
      if (value < 1) errors.push(formatRecipeError('INVALID_RECIPE', `${path}.maxBytes must be at least 1`))
      else declaration.maxBytes = value
    }
  }

  if (raw['default'] !== undefined) {
    const fallback = raw['default']
    const scalar = typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean'
    if (!scalar || type === 'image') {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `${path}.default must be a scalar matching the declared type; an image binding has no default, because a `
        + 'default image would be a media reference the caller never supplied',
      ))
    } else if (!matchesScalarType(type, fallback)) {
      errors.push(formatRecipeError('INVALID_RECIPE', `${path}.default does not match the declared type ${type}`))
    } else if (declaration.enum !== undefined && !declaration.enum.includes(fallback)) {
      errors.push(formatRecipeError('INVALID_RECIPE', `${path}.default is not one of the declared enum values`))
    } else {
      declaration.default = fallback
    }
  }

  return declaration
}

/** Whether a scalar satisfies a declared scalar kind. */
function matchesScalarType(type: RecipeInputKind, value: string | number | boolean): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'image': return false
  }
}

/** Every `{{name}}` placeholder in a template, in order of appearance. */
function placeholdersIn(template: string): string[] {
  const found: string[] = []
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    found.push((match[1] ?? '').trim())
  }
  return found
}

/**
 * Normalize a CANONICAL RCP-02 document into the legacy raw shape the parser
 * below reads, collecting every canonical-key violation as a named error.
 *
 * The mapping is: `instructions`→`promptTemplate`; `inputBindings`→`inputs`
 * (pointer→name, kind text|image|json, required, label→description);
 * `limits.maxOutputTokens`→`maxOutputTokens`; `limits.maxImages`→
 * `imageInputs.max`; `policy` defaults to `{record:true, allowRemote:true}`
 * (recording defaults ON per HLM-09). `modelSelection.strategy:"caller-model"`
 * is the default and is validated then dropped; `"approved-profile"` is kept.
 * `context` must be `{inheritConversation:false, includeTools:false}` — the
 * "take the entire conversation" flag is not supported in this release
 * (HLM-05) and is refused. `response` is validated and kept. `schemaVersion`
 * and `kind:"harness-model"` are constants. `limits.timeoutMs`,
 * `maxInputTextBytes`, `maxAttempts`, `repairAttempts` are validated and
 * dropped: the broker enforces the RES-10 ceilings and the caller owns the
 * wall-clock deadline (RES-10's 60 s figure is the caller's to pass).
 *
 * @param raw - the decoded recipe document.
 * @param errors - the error sink.
 * @returns the legacy-shaped document plus the canonical-only extras, or
 * @param raw - the decoded recipe document.
 * @param errors - the error sink.
 * @returns the legacy-shaped document plus the canonical-only extras.
 */
function normalizeRecipeDocument(
  raw: Record<string, unknown>,
  errors: string[],
): { normalized: Record<string, unknown>; extras: {
  readonly modelSelection?: { readonly strategy: 'approved-profile'; readonly profile: string }
  readonly response?: { readonly mode: 'text' | 'json'; readonly field: string }
} } {
  const normalized: Record<string, unknown> = {}
  const extras: {
    modelSelection?: { readonly strategy: 'approved-profile'; readonly profile: string }
    response?: { readonly mode: 'text' | 'json'; readonly field: string }
  } = {}

  // Every canonical sub-object is CLOSED: unknown keys are refused, and the
  // forbidden/reserved names are refused by name — nothing is silently dropped.
  const refuseUnsafeKeys = (container: Record<string, unknown>, path: string, allowed: readonly string[]): void => {
    for (const key of Object.keys(container)) {
      if (allowed.includes(key)) continue
      if (FORBIDDEN_RECIPE_KEYS.includes(key)) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          `${path}.${key} is refused by name. A recipe is DATA, not a program: it cannot supply tools, messages, `
          + 'conversation history, attachments, memory or skills (HLM-05, HLM-06)',
        ))
      } else if (RESERVED_RECIPE_KEYS.includes(key)) {
        errors.push(formatRecipeError('INVALID_RECIPE', `${path}.${key} is a reserved prototype member and is refused by name (RCP-03)`))
      } else {
        errors.push(unknownKeyError(path, key, allowed))
      }
    }
  }

  // Constants: schemaVersion is accepted and pinned; kind must be harness-model.
  if (raw['schemaVersion'] !== undefined) {
    if (typeof raw['schemaVersion'] !== 'string' || raw['schemaVersion'].length === 0) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'schemaVersion must be a version string (for example "1.0.0")'))
    }
  }
  if (raw['kind'] !== undefined && raw['kind'] !== 'harness-model') {
    errors.push(formatRecipeError('INVALID_RECIPE', `kind must be "harness-model" when declared; received ${describeKind(raw['kind'])}`))
  }

  for (const key of ['id', 'version', 'description', 'tool']) {
    if (raw[key] !== undefined) normalized[key] = raw[key]
  }

  // --- instructions -----------------------------------------------------------
  const instructions = raw['instructions']
  if (typeof instructions !== 'string' || instructions.length === 0) {
    errors.push(formatRecipeError('INVALID_RECIPE', `instructions must be a non-empty string; received ${describeKind(instructions)}`))
  }

  // --- modelSelection (RCP-05) ------------------------------------------------
  const modelSelection = raw['modelSelection']
  const requires: { inputModalities: string[]; outputModalities: string[] } = { inputModalities: [], outputModalities: [] }
  let strategy: string | undefined
  if (!isPlainObject(modelSelection)) {
    errors.push(formatRecipeError('INVALID_RECIPE', `modelSelection must be an object carrying "strategy" and "requires"; received ${describeKind(modelSelection)}`))
  } else {
    refuseUnsafeKeys(modelSelection, 'modelSelection', ['strategy', 'requires', 'profile'])
    strategy = typeof modelSelection['strategy'] === 'string' ? modelSelection['strategy'] : undefined
    if (strategy !== 'caller-model' && strategy !== 'approved-profile') {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `modelSelection.strategy must be "caller-model" or "approved-profile"; received ${describeKind(modelSelection['strategy'])}`,
      ))
    }
    const rawRequires = modelSelection['requires']
    if (!isPlainObject(rawRequires)) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'modelSelection.requires must carry inputModalities and outputModalities'))
    } else {
      refuseUnsafeKeys(rawRequires, 'modelSelection.requires', ['inputModalities', 'outputModalities'])
      for (const [modalityKey, destination] of [['inputModalities', requires.inputModalities], ['outputModalities', requires.outputModalities]] as const) {
        const value = rawRequires[modalityKey]
        if (!Array.isArray(value) || value.length === 0 || !value.every(entry =>
          entry === 'text' || entry === 'image' || entry === 'audio' || entry === 'video')) {
          errors.push(formatRecipeError(
            'INVALID_RECIPE',
            `modelSelection.requires.${modalityKey} must be a non-empty array of the known modalities (text, image, audio, video); received ${describeKind(value)}`,
          ))
        } else {
          for (const entry of value) destination.push(entry as string)
        }
      }
    }
    const profile = modelSelection['profile']
    if (strategy === 'approved-profile') {
      if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          'modelSelection.strategy "approved-profile" requires a profile name of letters, digits, dot, underscore or dash',
        ))
      } else {
        extras.modelSelection = { strategy: 'approved-profile', profile }
      }
    } else if (profile !== undefined) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'modelSelection.profile is only valid with strategy "approved-profile"'))
    }
  }

  // --- context (HLM-05's frozen invariants) ------------------------------------
  const context = raw['context']
  if (context !== undefined) {
    if (!isPlainObject(context)) {
      errors.push(formatRecipeError('INVALID_RECIPE', `context must be the object {inheritConversation:false, includeTools:false}; received ${describeKind(context)}`))
    } else {
      refuseUnsafeKeys(context, 'context', ['inheritConversation', 'includeTools'])
      if (context['inheritConversation'] !== false
        || context['includeTools'] !== false) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          'context must be exactly {inheritConversation:false, includeTools:false}: a flag meaning "take the entire '
          + 'conversation" is not supported in this release (HLM-05)',
        ))
      }
    }
  }

  // --- response (RCP-04) -------------------------------------------------------
  const response = raw['response']
  if (response !== undefined) {
    if (!isPlainObject(response)) {
      errors.push(formatRecipeError('INVALID_RECIPE', `response must be an object carrying "mode" and "field"; received ${describeKind(response)}`))
    } else {
      refuseUnsafeKeys(response, 'response', ['mode', 'field'])
      const mode = response['mode']
      const field = response['field']
      if (mode !== 'text' && mode !== 'json') {
        errors.push(formatRecipeError('INVALID_RECIPE', `response.mode must be "text" or "json"; received ${describeKind(mode)}`))
      }
      if (typeof field !== 'string' || field.length === 0) {
        errors.push(formatRecipeError('INVALID_RECIPE', 'response.field must be a non-empty payload field name'))
      }
      if (mode === 'text' || mode === 'json') {
        if (typeof field === 'string' && field.length > 0) {
          extras.response = { mode, field }
        }
      }
    }
  }

  // --- limits ------------------------------------------------------------------
  const limits = raw['limits']
  let maxOutputTokens: number | undefined
  let maxImages = 0
  if (!isPlainObject(limits)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      'limits must be an object carrying at least maxOutputTokens and maxImages; received '
      + `${describeKind(limits)}`,
    ))
  } else {
    refuseUnsafeKeys(limits, 'limits', ['timeoutMs', 'maxInputTextBytes', 'maxImages', 'maxOutputTokens', 'maxAttempts', 'repairAttempts'])
    maxOutputTokens = readInteger(limits['maxOutputTokens'], 'limits.maxOutputTokens', errors) ?? undefined
    if (maxOutputTokens !== undefined && (maxOutputTokens < 1 || maxOutputTokens > INITIAL_MAX_OUTPUT_TOKENS)) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `limits.maxOutputTokens must be between 1 and ${INITIAL_MAX_OUTPUT_TOKENS} (RES-10)`,
      ))
    }
    const rawMaxImages = readInteger(limits['maxImages'], 'limits.maxImages', errors)
    if (rawMaxImages !== undefined && (rawMaxImages < 0 || rawMaxImages > INITIAL_MAX_IMAGE_INPUTS)) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `limits.maxImages must be between 0 and ${INITIAL_MAX_IMAGE_INPUTS} (RES-10)`,
      ))
    } else if (rawMaxImages !== undefined) {
      maxImages = rawMaxImages
    }
    // Accepted, validated, dropped (see the docstring above): the caller owns
    // the deadline and the broker enforces the RES-10 ceilings.
    for (const key of ['timeoutMs', 'maxInputTextBytes', 'maxAttempts', 'repairAttempts']) {
      if (limits[key] !== undefined) readInteger(limits[key], `limits.${key}`, errors)
    }
  }
  normalized.maxOutputTokens = maxOutputTokens
  normalized.imageInputs = { max: maxImages }
  // Recording defaults ON; destinations default to the author's acceptance.
  normalized.policy = { record: true, allowRemote: true }

  // --- inputBindings ------------------------------------------------------------
  const rawBindings = raw['inputBindings']
  const inputs: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>
  const bindingNames = new Set<string>()
  if (!Array.isArray(rawBindings) || rawBindings.length === 0) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `inputBindings must be a non-empty array of {kind, pointer, required, label}; received ${describeKind(rawBindings)}`,
    ))
  } else {
    for (const entry of rawBindings) {
      if (!isPlainObject(entry)) {
        errors.push(formatRecipeError('INVALID_RECIPE', `inputBindings entries must be objects; received ${describeKind(entry)}`))
        continue
      }
      refuseUnsafeKeys(entry, 'inputBindings[]', ['kind', 'pointer', 'required', 'label', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'default', 'mediaTypes', 'maxBytes'])
      const kind = entry['kind']
      const pointer = entry['pointer']
      if (kind !== 'text' && kind !== 'image' && kind !== 'json') {
        errors.push(formatRecipeError('INVALID_RECIPE', `inputBindings[].kind must be "text", "image" or "json"; received ${describeKind(kind)}`))
        continue
      }
      if (typeof pointer !== 'string' || !/^(\/[A-Za-z0-9_-]+)+$/.test(pointer)) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          `inputBindings[].pointer must be a validated JSON Pointer of simple name segments (for example "/focus"); `
          + `received ${JSON.stringify(pointer)}. Reserved characters, prototype keys and escapes are refused (RCP-03)`,
        ))
        continue
      }
      const name = pointer.slice(1)
      if (bindingNames.has(name)) {
        errors.push(formatRecipeError('INVALID_RECIPE', `inputBindings declare the pointer ${pointer} twice`))
        continue
      }
      bindingNames.add(name)
      const required = entry['required'] === true
      const label = typeof entry['label'] === 'string' && entry['label'].length > 0 ? entry['label'] : undefined
      // The canonical serializer re-emits the richer constraint fields so the
      // canonical round trip is LOSSLESS; the legacy parser below validates
      // them with its own named refusals.
      const constraints: Record<string, unknown> = {}
      for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'default', 'mediaTypes', 'maxBytes']) {
        if (entry[key] !== undefined) constraints[key] = entry[key]
      }
      if (kind === 'image') {
        inputs[name] = {
          type: 'image', required,
          ...label === undefined ? {} : { description: label },
          ...constraints,
        }
      } else {
        // NOTE: no implicit minLength default — the canonical round trip must
        // be LOSSLESS, and a legacy declaration without minLength parses to a
        // frozen recipe without minLength, so the normalization must not invent
        // one.
        inputs[name] = {
          type: 'string', required,
          ...label === undefined ? {} : { description: label },
          ...constraints,
          ...kind === 'json' ? { jsonSerialized: true } : {},
        }
      }
    }
    if (Object.keys(inputs).length === 0 && errors.length === 0) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'inputBindings must declare at least one binding'))
    }
  }
  normalized.inputs = inputs

  // --- promptTemplate rendering (RCP-03) --------------------------------------
  // The canonical `instructions` are static prose; bindings are rendered BY
  // POINTER. When the instructions do NOT already bind an input with the
  // legacy `{{name}}` placeholder (the spec's §19.3 example has none), the
  // normalized template appends one rendered line per unbound input — label or
  // name, in declaration order — so the legacy "never binds" rule never fires
  // on the canonical path and the bound VALUES reach the provider request.
  if (typeof instructions === 'string') {
    const bound = new Set<string>()
    for (const match of instructions.matchAll(/\{\{([^{}]*)\}\}/g)) {
      bound.add((match[1] ?? '').trim())
    }
    const unboundLines: string[] = []
    for (const [name, declaration] of Object.entries(inputs)) {
      if (bound.has(name)) continue
      const label = typeof declaration['description'] === 'string' && declaration['description'].length > 0
        ? declaration['description'] : name
      unboundLines.push(`- ${label}: {{${name}}}`)
    }
    normalized.promptTemplate = unboundLines.length === 0
      ? instructions
      : `${instructions}\n\nSupplied context: the recipe instructions and the validated bound inputs only — no parent `
        + `conversation, system prompt, tools or memory (HLM-05)\n${unboundLines.join('\n')}`
  }

  // The declared requires must be consistent with the declared bindings:
  // an image binding needs "image" in inputModalities, and nothing else is
  // permitted to appear (HLM-04: unknown is not supported).
  const declaredImage = Object.values(inputs).some(declaration => declaration['type'] === 'image')
  if (requires.inputModalities.length > 0) {
    if (declaredImage && !requires.inputModalities.includes('image')) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'the recipe declares an image binding but modelSelection.requires.inputModalities omits "image"'))
    }
    if (!declaredImage && requires.inputModalities.includes('image')) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'modelSelection.requires.inputModalities claims "image" but no image binding is declared'))
    }
  }
  if (requires.outputModalities.length > 0 && !requires.outputModalities.includes('text')) {
    errors.push(formatRecipeError('INVALID_RECIPE', 'this build only produces text output; modelSelection.requires.outputModalities must include "text"'))
  }

  return { normalized, extras }
}

/**
 * Parse and validate a raw recipe.
 *
 * Every violation is collected and reported — one error per problem — because fixing a
 * recipe one error per run is how an author gives up.
 * @param raw - the parsed JSON of a recipe file, or any candidate value.
 * @param options - the tool identity the recipe is being loaded as.
 * @returns the frozen recipe, or every reason it is not one.
 */
export function parseRecipe(raw: unknown, options: ParseRecipeOptions = {}): RecipeParseResult {
  const errors: string[] = []
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [formatRecipeError(
        'INVALID_RECIPE',
        `a recipe must be a JSON object; received ${describeKind(raw)}`,
      )],
    }
  }

  // A CANONICAL RCP-02 document is normalized into the legacy shape BEFORE the
  // data-only gate below, because the canonical vocabulary's own `context`
  // object carries the HLM-05 flag names (`inheritConversation`/`includeTools`)
  // that the legacy gate refuses by name at any depth — the normalizer
  // VALIDATES those flags are exactly false and then DROPS them, so the
  // normalized document carries no forbidden keys and the legacy checks apply
  // unchanged. The raw document is still name-gated: every top-level key that
  // is not part of the canonical vocabulary is refused (unknown/forbidden/
  // reserved) BEFORE any value is read.
  const canonicalKeys = new Set([
    'schemaVersion', 'kind', 'id', 'version', 'description', 'tool',
    'modelSelection', 'instructions', 'inputBindings', 'response', 'limits', 'context',
  ])
  const isCanonical = canonicalKeys.has('instructions')
    && (Object.prototype.hasOwnProperty.call(raw, 'instructions')
      || Object.prototype.hasOwnProperty.call(raw, 'inputBindings')
      || Object.prototype.hasOwnProperty.call(raw, 'modelSelection')
      || Object.prototype.hasOwnProperty.call(raw, 'kind')
      || Object.prototype.hasOwnProperty.call(raw, 'schemaVersion'))
  if (isCanonical) {
    for (const key of Object.keys(raw)) {
      if (!canonicalKeys.has(key)) {
        if (FORBIDDEN_RECIPE_KEYS.includes(key)) {
          errors.push(formatRecipeError(
            'INVALID_RECIPE',
            `${key} is refused by name. A recipe is DATA, not a program: it cannot supply tools, messages, conversation `
            + 'history, attachments, memory or skills, because the broker builds the provider request from the recipe '
            + 'and the bound inputs alone (HLM-05, HLM-06). Remove the key; something that needs tools is a PTC '
            + 'program, which is a different artifact',
          ))
        } else if (RESERVED_RECIPE_KEYS.includes(key)) {
          errors.push(formatRecipeError(
            'INVALID_RECIPE',
            `${key} is a reserved prototype member and is refused by name (RCP-03)`,
          ))
        } else {
          errors.push(unknownKeyError('', key, [...canonicalKeys]))
        }
      }
    }
    if (errors.length > 0) return { ok: false, errors }
    const canonical = normalizeRecipeDocument(raw, errors)
    if (errors.length > 0) return { ok: false, errors }
    const parsed = parseRecipe(canonical.normalized, options)
    if (!parsed.ok) return parsed
    const recipe = parsed.recipe
    const frozen = deepFreeze({
      ...recipe,
      ...canonical.extras.modelSelection === undefined ? {} : { modelSelection: canonical.extras.modelSelection },
      ...canonical.extras.response === undefined ? {} : { response: canonical.extras.response },
    } satisfies RecipeManifest)
    return { ok: true, recipe: frozen }
  }

  // Data-only first: this is where a function, a class instance or a context key is
  // caught, and it must happen before any field is read, because a getter could
  // otherwise run arbitrary code during validation.
  checkDataOnly(raw, '', errors)

  for (const key of unknownKeys(raw, RECIPE_TOP_LEVEL_KEYS)) {
    errors.push(unknownKeyError('', key, RECIPE_TOP_LEVEL_KEYS))
  }

  const id = readNonEmptyString(raw['id'], 'id', errors)
  if (id !== undefined && !/^[A-Za-z0-9@][A-Za-z0-9._@/-]*$/.test(id)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `id ${JSON.stringify(id)} must be a stable identity of letters, digits, dot, dash, underscore, slash or a `
      + 'leading scope, with no whitespace',
    ))
  }

  const version = readNonEmptyString(raw['version'], 'version', errors)
  if (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `version ${JSON.stringify(version)} must be semantic (x.y.z). A prompt change is a version change, because `
      + 'identical JSON shape does not mean identical semantics (RCP-06)',
    ))
  }

  const description = readNonEmptyString(raw['description'], 'description', errors)
  if (description !== undefined && description.trim().length < 10) {
    errors.push(formatRecipeError('INVALID_RECIPE', 'description must be a real sentence, not a placeholder'))
  }

  const tool = parseToolIdentity(raw['tool'], errors, options)

  // --- inputs -----------------------------------------------------------------
  const rawInputs = raw['inputs']
  const inputs: Record<string, RecipeInputDeclaration> = {}
  if (!isPlainObject(rawInputs)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `inputs must be an object keyed by input name; received ${describeKind(rawInputs)}`,
    ))
  } else if (Object.keys(rawInputs).length === 0) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      'inputs must declare at least one input. A tool that binds nothing is a constant, and a constant does not need '
      + 'a provider call to produce it',
    ))
  } else {
    for (const [name, declaration] of Object.entries(rawInputs)) {
      const parsed = parseInputDeclaration(name, declaration, errors)
      if (parsed !== undefined) inputs[name] = parsed
    }
  }

  // --- imageInputs ------------------------------------------------------------
  let imageInputMax = 0
  const rawImageInputs = raw['imageInputs']
  if (!isPlainObject(rawImageInputs)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `imageInputs must be an object carrying "max"; received ${describeKind(rawImageInputs)}`,
    ))
  } else {
    for (const key of unknownKeys(rawImageInputs, IMAGE_INPUTS_KEYS)) {
      errors.push(unknownKeyError('imageInputs', key, IMAGE_INPUTS_KEYS))
    }
    const max = readInteger(rawImageInputs['max'], 'imageInputs.max', errors)
    if (max !== undefined) {
      if (max < 0) {
        errors.push(formatRecipeError('INVALID_RECIPE', 'imageInputs.max must not be negative'))
      } else if (max > INITIAL_MAX_IMAGE_INPUTS) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          `imageInputs.max is ${max}, over the ${INITIAL_MAX_IMAGE_INPUTS} that RES-10's initial per-leaf maximum `
          + 'permits for one invocation. A reviewed profile may lower this; a recipe may not raise it',
        ))
      } else {
        imageInputMax = max
      }
    }
  }

  const declaredImages = Object.entries(inputs).filter(([, declaration]) => declaration.type === 'image')
  if (declaredImages.length > 0 && imageInputMax === 0) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `the recipe declares ${declaredImages.length} image input(s) (${declaredImages.map(([name]) => name).join(', ')}) `
      + 'but imageInputs.max is 0, so no image could ever be bound',
    ))
  }
  if (declaredImages.length > imageInputMax) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `the recipe declares ${declaredImages.length} image inputs but permits imageInputs.max ${imageInputMax}`,
    ))
  }

  // --- promptTemplate ---------------------------------------------------------
  const promptTemplate = readNonEmptyString(raw['promptTemplate'], 'promptTemplate', errors)
  if (promptTemplate !== undefined) {
    /**
     * The template is static instructions with bindings and nothing else.
     *
     * The check is deliberately two-sided: a placeholder must name a declared input
     * (an unbound pointer cannot be satisfied, RCP-03), and template CODE must not
     * appear at all, because RCP-02 admits no expressions, `eval`, shell, dynamic
     * imports or remote prompt downloads.
     */
    const names = new Set(Object.keys(inputs))
    const bound = new Set<string>()
    for (const match of promptTemplate.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const name = (match[1] ?? '').trim()
      bound.add(name)
      if (!names.has(name)) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          `promptTemplate binds {{${name}}}, which is not a declared input. The declared inputs are: `
          + `${names.size === 0 ? '(none)' : [...names].join(', ')}. A binding that names nothing is an unbound `
          + 'pointer and can never be satisfied (RCP-03)',
        ))
      }
    }
    if (![...names].every(name => bound.has(name))) {
      const unused = [...names].filter(name => !bound.has(name))
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `promptTemplate never binds ${unused.join(', ')}, so those inputs would be validated and then silently `
        + 'dropped. Either bind them or remove them from the recipe',
      ))
    }
    const leftover = promptTemplate.replace(/\{\{[^{}]*\}\}/g, '')
    if (leftover.includes('{{') || leftover.includes('}}')) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        'promptTemplate contains an unbalanced or nested brace; bindings are written exactly `{{name}}`',
      ))
    }
    for (const syntax of ['${', '<%', '%>']) {
      if (promptTemplate.includes(syntax)) {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          `promptTemplate contains the template expression ${JSON.stringify(syntax)}. A recipe is static data: `
          + 'RCP-02 admits no expressions, eval, shell, dynamic imports or remote prompt downloads',
        ))
      }
    }
  }

  // --- maxOutputTokens --------------------------------------------------------
  let maxOutputTokens = 0
  const rawMaxOutputTokens = readInteger(raw['maxOutputTokens'], 'maxOutputTokens', errors)
  if (rawMaxOutputTokens !== undefined) {
    if (rawMaxOutputTokens < 1) {
      errors.push(formatRecipeError('INVALID_RECIPE', 'maxOutputTokens must be at least 1'))
    } else if (rawMaxOutputTokens > INITIAL_MAX_OUTPUT_TOKENS) {
      errors.push(formatRecipeError(
        'INVALID_RECIPE',
        `maxOutputTokens is ${rawMaxOutputTokens}, over the ${INITIAL_MAX_OUTPUT_TOKENS} that RES-10's initial `
        + 'per-leaf maximum permits. A reviewed profile may lower this; a recipe may not raise it',
      ))
    } else {
      maxOutputTokens = rawMaxOutputTokens
    }
  }

  // --- policy -----------------------------------------------------------------
  let record = true
  let allowRemote = true
  const rawPolicy = raw['policy']
  if (!isPlainObject(rawPolicy)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `policy must be an object carrying "record" and "allowRemote"; received ${describeKind(rawPolicy)}`,
    ))
  } else {
    for (const key of unknownKeys(rawPolicy, POLICY_KEYS)) errors.push(unknownKeyError('policy', key, POLICY_KEYS))
    for (const key of POLICY_KEYS) {
      const value = rawPolicy[key]
      if (typeof value !== 'boolean') {
        errors.push(formatRecipeError(
          'INVALID_RECIPE',
          `policy.${key} must be a boolean; a policy that is absent or ambiguous is one the host must guess at, and `
          + 'guessing at recording is how a request goes unrecorded (HLM-09)',
        ))
      }
    }
    if (typeof rawPolicy['record'] === 'boolean') record = rawPolicy['record']
    if (typeof rawPolicy['allowRemote'] === 'boolean') allowRemote = rawPolicy['allowRemote']
  }

  if (errors.length > 0 || tool === undefined || promptTemplate === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : [formatRecipeError('INVALID_RECIPE', 'the recipe is incomplete')] }
  }

  return {
    ok: true,
    recipe: deepFreeze({
      id: id ?? '',
      version: version ?? '',
      description: description ?? '',
      tool,
      inputs,
      promptTemplate,
      maxOutputTokens,
      imageInputs: { max: imageInputMax },
      policy: { record, allowRemote },
    } satisfies RecipeManifest),
  }
}

/**
 * Serialize a frozen recipe as the CANONICAL RCP-02 document.
 *
 * The output is what pack/create emit and what the schema's canonical branch
 * validates: `schemaVersion`/`kind`/`modelSelection`/`instructions`/
 * `inputBindings`/`response`/`limits`/`context` plus the identity keys
 * (id/version/description/tool). The richer legacy constraint fields are
 * re-emitted on the bindings, so canonical → parse → canonical is LOSSLESS.
 * `modelSelection.strategy` defaults to `caller-model` with the derived
 * requires; an `approved-profile` selection is preserved verbatim.
 *
 * @param recipe - the frozen recipe.
 * @returns the canonical document.
 */
export function toCanonicalRecipe(recipe: RecipeManifest): Record<string, unknown> {
  const declaredImage = Object.values(recipe.inputs).some(declaration => declaration.type === 'image')
  return {
    schemaVersion: '1.0.0',
    kind: 'harness-model',
    id: recipe.id,
    version: recipe.version,
    description: recipe.description,
    tool: { name: recipe.tool.name, contractId: recipe.tool.contractId },
    modelSelection: recipe.modelSelection ?? {
      strategy: 'caller-model',
      requires: {
        inputModalities: declaredImage ? ['text', 'image'] : ['text'],
        outputModalities: ['text'],
      },
    },
    instructions: recipe.promptTemplate,
    inputBindings: Object.entries(recipe.inputs).map(([name, declaration]) => ({
      kind: declaration.type === 'image' ? 'image' : declaration.jsonSerialized === true ? 'json' : 'text',
      pointer: `/${name}`,
      required: declaration.required,
      ...declaration.description === undefined ? {} : { label: declaration.description },
      ...declaration.minLength === undefined ? {} : { minLength: declaration.minLength },
      ...declaration.maxLength === undefined ? {} : { maxLength: declaration.maxLength },
      ...declaration.minimum === undefined ? {} : { minimum: declaration.minimum },
      ...declaration.maximum === undefined ? {} : { maximum: declaration.maximum },
      ...declaration.enum === undefined ? {} : { enum: declaration.enum },
      ...declaration.default === undefined ? {} : { default: declaration.default },
      ...declaration.mediaTypes === undefined ? {} : { mediaTypes: declaration.mediaTypes },
      ...declaration.maxBytes === undefined ? {} : { maxBytes: declaration.maxBytes },
    })),
    ...recipe.response === undefined ? {} : { response: recipe.response },
    limits: { maxOutputTokens: recipe.maxOutputTokens, maxImages: recipe.imageInputs.max },
    context: { inheritConversation: false, includeTools: false },
  }
}

/** Validate and read the tool identity, including the identity-claim refusal. */
function parseToolIdentity(
  raw: unknown,
  errors: string[],
  options: ParseRecipeOptions,
): RecipeToolIdentity | undefined {
  if (!isPlainObject(raw)) {
    errors.push(formatRecipeError('INVALID_RECIPE', `tool must be an object; received ${describeKind(raw)}`))
    return undefined
  }
  for (const key of unknownKeys(raw, TOOL_KEYS)) errors.push(unknownKeyError('tool', key, TOOL_KEYS))

  const name = readNonEmptyString(raw['name'], 'tool.name', errors)
  if (name !== undefined && !/^[a-z][a-z0-9_]*$/.test(name)) {
    errors.push(formatRecipeError('INVALID_RECIPE', `tool.name ${JSON.stringify(name)} must be lower snake_case`))
  }
  const contractId = readNonEmptyString(raw['contractId'], 'tool.contractId', errors)
  if (contractId !== undefined && !CONTRACT_IDENTITY.test(contractId)) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `tool.contractId ${JSON.stringify(contractId)} must be a dotted lower-case identity (for example "text.title") or `
      + 'a scoped third-party identity (for example "@acme/tool-mode-image-review/review")',
    ))
  }

  /**
   * A recipe implements the tool it is loaded as, and no other.
   *
   * Without this check a recipe file could be swapped for another tool's recipe and
   * inherit that tool's authorization while running different instructions — the recipe
   * generation and the contract identity would silently disagree (RCP-06).
   */
  if (name !== undefined && options.expectedToolName !== undefined && name !== options.expectedToolName) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `the recipe names the tool "${name}" but it is being loaded as the implementation of "${options.expectedToolName}". `
      + 'A recipe cannot claim another tool\'s identity: the authorization, the contract and the limits all belong to '
      + 'the tool it declares (RCP-06)',
    ))
  }
  if (contractId !== undefined && options.expectedContractId !== undefined && contractId !== options.expectedContractId) {
    errors.push(formatRecipeError(
      'INVALID_RECIPE',
      `the recipe names the contract "${contractId}" but it is being loaded as the implementation of `
      + `"${options.expectedContractId}"`,
    ))
  }

  if (name === undefined || contractId === undefined) return undefined
  return { name, contractId }
}

/**
 * Bind caller arguments to a recipe's declared inputs.
 *
 * Every problem is reported, not the first: an author fixing a binding one field per run
 * is an author who ships the field they gave up on. Nothing is coerced — a string "3" is
 * not the integer 3, because a silently coerced binding is a binding the caller did not
 * supply.
 * @param recipe - the recipe whose inputs are being bound.
 * @param args - the caller's arguments.
 * @returns the bound values, or every reason they do not satisfy the recipe.
 */
export function validateRecipeInputs(recipe: RecipeManifest, args: unknown): RecipeBindingResult {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      errors: [formatRecipeError(
        'RECIPE_BINDING_ERROR',
        `the arguments for ${recipe.tool.name} must be an object; received ${describeKind(args)}`,
      )],
    }
  }

  const errors: string[] = []
  const declaredNames = Object.keys(recipe.inputs)

  for (const supplied of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(recipe.inputs, supplied)) {
      errors.push(formatRecipeError(
        'RECIPE_BINDING_ERROR',
        `"${supplied}" is not an input of ${recipe.tool.name}. The declared inputs are: ${declaredNames.join(', ')}. `
        + 'A recipe\'s inputs are closed, so a caller cannot add one — and cannot widen a limit through the argument '
        + 'object (RCP-05)',
      ))
    }
  }

  const values: Record<string, RecipeValue> = {}

  for (const [name, declaration] of Object.entries(recipe.inputs)) {
    const supplied = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : undefined
    if (supplied === undefined) {
      if (declaration.default !== undefined) {
        values[name] = declaration.default
      } else if (declaration.required) {
        errors.push(formatRecipeError('RECIPE_BINDING_ERROR', `the required input "${name}" was not supplied`))
      }
      // An omitted optional input is OMITTED, never stringified: RCP-03 requires that a
      // missing optional binding drop that user content rather than contribute the text
      // "undefined" to the prompt.
      continue
    }
    const bound = bindValue(name, declaration, supplied, errors)
    if (bound !== undefined) values[name] = bound
  }

  /**
   * There is no image-count check here, and that is deliberate rather than missing.
   *
   * The inputs are a CLOSED name-keyed map, so the most images a caller can bind is the
   * number of image inputs the recipe declares — and parseRecipe already refuses a recipe
   * declaring more image inputs than its own `imageInputs.max` permits. A check here would
   * be unreachable, and an unreachable budget check is worse than none: it reads as
   * enforcement. The RUNTIME ceiling, which a narrowed host policy can lower below the
   * recipe's figure, is enforced in the broker where it can actually differ.
   */

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}

/** Bind one supplied value against its declaration. */
function bindValue(
  name: string,
  declaration: RecipeInputDeclaration,
  supplied: unknown,
  errors: string[],
): RecipeValue | undefined {
  const path = `"${name}"`
  if (declaration.type === 'image') return bindImage(name, declaration, supplied, errors)

  // A canonical `inputBindings` kind "json" binding (RCP-03): the caller
  // supplies a data-only object or array, which is JSON-serialized into the
  // bound string. Serialization is data-only — never evaluated as instructions
  // or code.
  if (declaration.jsonSerialized === true) {
    if (!isPlainObject(supplied) && !Array.isArray(supplied)) {
      errors.push(formatRecipeError(
        'RECIPE_BINDING_ERROR',
        `${path} must be a JSON-serializable object or array (the binding kind is "json"); received ${describeKind(supplied)}`,
      ))
      return undefined
    }
    const serializationErrors: string[] = []
    checkDataOnly(supplied, path, serializationErrors)
    for (const error of serializationErrors) errors.push(error)
    return JSON.stringify(supplied)
  }

  const scalar = typeof supplied === 'string' || typeof supplied === 'number' || typeof supplied === 'boolean'
  if (!scalar) {
    errors.push(formatRecipeError(
      'RECIPE_BINDING_ERROR',
      `${path} must be a ${declaration.type}; received ${describeKind(supplied)}`,
    ))
    return undefined
  }
  if (!matchesScalarType(declaration.type, supplied)) {
    errors.push(formatRecipeError(
      'RECIPE_BINDING_ERROR',
      `${path} must be a ${declaration.type}; received ${describeKind(supplied)}. Values are not coerced, because a `
      + 'coerced binding is a binding the caller did not supply',
    ))
    return undefined
  }
  if (declaration.enum !== undefined && !declaration.enum.includes(supplied)) {
    errors.push(formatRecipeError(
      'RECIPE_BINDING_ERROR',
      `${path} must be one of ${declaration.enum.map(member => JSON.stringify(member)).join(', ')}; received `
      + `${JSON.stringify(supplied)}`,
    ))
    return undefined
  }
  if (typeof supplied === 'string') {
    if (declaration.minLength !== undefined && supplied.length < declaration.minLength) {
      errors.push(formatRecipeError(
        'RECIPE_BINDING_ERROR',
        `${path} is ${supplied.length} characters, under the declared minLength ${declaration.minLength}`,
      ))
      return undefined
    }
    if (declaration.maxLength !== undefined && supplied.length > declaration.maxLength) {
      errors.push(formatRecipeError(
        'RECIPE_BINDING_ERROR',
        `${path} is ${supplied.length} characters, over the declared maxLength ${declaration.maxLength}. The binding is `
        + 'refused rather than truncated, because a truncated input is not the input the caller supplied',
      ))
      return undefined
    }
  }
  if (typeof supplied === 'number') {
    if (declaration.minimum !== undefined && supplied < declaration.minimum) {
      errors.push(formatRecipeError('RECIPE_BINDING_ERROR', `${path} is under the declared minimum ${declaration.minimum}`))
      return undefined
    }
    if (declaration.maximum !== undefined && supplied > declaration.maximum) {
      errors.push(formatRecipeError('RECIPE_BINDING_ERROR', `${path} is over the declared maximum ${declaration.maximum}`))
      return undefined
    }
  }
  return supplied
}

/** Bind one image, which is the media type plus the bytes. */
function bindImage(
  name: string,
  declaration: RecipeInputDeclaration,
  supplied: unknown,
  errors: string[],
): RecipeImageValue | undefined {
  const path = `"${name}"`
  if (!isPlainObject(supplied)) {
    errors.push(formatRecipeError(
      'RECIPE_BINDING_ERROR',
      `${path} must be a typed image ({ mediaType, bytes }); received ${describeKind(supplied)}. A path or a URL is not `
      + 'an image binding: the request must be fully described by the recipe and the bound inputs (HLM-05)',
    ))
    return undefined
  }
  for (const key of unknownKeys(supplied, ['mediaType', 'bytes'])) {
    errors.push(formatRecipeError('RECIPE_BINDING_ERROR', `${path}.${key} is not part of a typed image binding`))
  }
  const mediaType = supplied['mediaType']
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) {
    errors.push(formatRecipeError(
      'UNSUPPORTED_MODALITY',
      `${path}.mediaType must be an image media type (for example "image/png"); received ${JSON.stringify(mediaType)}. `
      + 'A non-image media type bound to an image input would be sent as an image the provider cannot read',
    ))
    return undefined
  }
  if (declaration.mediaTypes !== undefined && !declaration.mediaTypes.includes(mediaType)) {
    errors.push(formatRecipeError(
      'UNSUPPORTED_MODALITY',
      `${path}.mediaType ${JSON.stringify(mediaType)} is not among the admitted types ${declaration.mediaTypes.join(', ')}`,
    ))
    return undefined
  }
  const bytes = supplied['bytes']
  if (!(bytes instanceof Uint8Array)) {
    errors.push(formatRecipeError(
      'RECIPE_BINDING_ERROR',
      `${path}.bytes must be a Uint8Array of the image's actual bytes; received ${describeKind(bytes)}`,
    ))
    return undefined
  }
  if (bytes.length === 0) {
    errors.push(formatRecipeError('RECIPE_BINDING_ERROR', `${path}.bytes is empty; an empty buffer is not an image`))
    return undefined
  }
  if (declaration.maxBytes !== undefined && bytes.length > declaration.maxBytes) {
    errors.push(formatRecipeError(
      'MODEL_BUDGET_EXCEEDED',
      `${path}.bytes is ${bytes.length} bytes, over the declared maxBytes ${declaration.maxBytes}`,
    ))
    return undefined
  }
  /**
   * The bytes are COPIED, not aliased.
   *
   * HLM-09 requires model requests to use immutable captured inputs. Handing the
   * provider a buffer the caller still holds would let a mutation between dispatch and
   * dispatch change what the model received, which is exactly the kind of evidence gap
   * an auxiliary-call journal cannot describe after the fact.
   */
  return { mediaType, bytes: Uint8Array.from(bytes) }
}

/**
 * Render the prompt from validated bindings (RCP-02, RCP-03).
 *
 * A line that binds an absent optional input is DROPPED, whole. RCP-03 says a missing
 * optional focus omits that user content rather than stringifying `undefined`, and in a
 * flat string the only way to omit a labelled section is to omit its line.
 *
 * A bound image contributes a bounded REFERENCE — its media type and byte count — never
 * its bytes: MOD-06 forbids concatenating raw byte data into text.
 * @param recipe - the recipe to render.
 * @param values - bindings from {@link validateRecipeInputs}.
 * @returns the prompt text.
 * @throws Error when a required binding has no value, which means the caller skipped
 *   validation; the broker always validates first.
 */
export function renderPrompt(recipe: RecipeManifest, values: Readonly<Record<string, RecipeValue>>): string {
  const rendered: string[] = []
  for (const line of recipe.promptTemplate.split('\n')) {
    const names = placeholdersIn(line)
    if (names.length === 0) {
      rendered.push(line)
      continue
    }
    let omit = false
    let text = line
    for (const name of names) {
      const declaration = recipe.inputs[name]
      if (declaration === undefined) {
        // Unreachable for a parsed recipe; parseRecipe refuses an unbound placeholder.
        throw new Error(`the prompt binds {{${name}}}, which is not a declared input of ${recipe.tool.name}`)
      }
      const value = values[name]
      if (value === undefined) {
        if (declaration.required) {
          throw new Error(
            `renderPrompt requires validated bindings: the required input "${name}" has no value. Call `
            + 'validateRecipeInputs first; the broker always does',
          )
        }
        omit = true
        continue
      }
      const substitute = declaration.type === 'image' ? imageReference(value as RecipeImageValue) : String(value)
      text = text.split(`{{${name}}}`).join(substitute)
    }
    if (!omit) rendered.push(text)
  }
  return rendered.join('\n')
}

/**
 * The textual reference a bound image contributes to a prompt (HLM-09, MOD-06).
 * @param image - the bound image.
 * @returns a bounded reference naming the media type and size.
 */
export function imageReference(image: RecipeImageValue): string {
  return `[image ${image.mediaType}, ${image.bytes.length} bytes]`
}

/**
 * Project a recipe's input declarations into a JSON Schema (DECL-01).
 *
 * This is what makes one declaration serve three surfaces: the tool contract, the DSH
 * parameter projection and the MCP schema all read this object, so there is no second
 * description of the inputs to drift from the recipe. The schema is closed, because an
 * open object would advertise that a caller may add inputs the recipe does not have.
 * @param recipe - the recipe to project.
 * @returns a JSON Schema object for the tool's arguments.
 */
export function inputSchemaFor(recipe: RecipeManifest): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, declaration] of Object.entries(recipe.inputs)) {
    const property: Record<string, unknown> = declaration.type === 'image'
      // An image binding is an object carrying its media type and bytes; the schema says
      // which media types are admitted, so a caller learns the bound from the contract.
      ? {
        type: 'object',
        additionalProperties: false,
        required: ['mediaType', 'bytes'],
        properties: {
          mediaType: { type: 'string', ...(declaration.mediaTypes === undefined ? {} : { enum: declaration.mediaTypes }) },
          bytes: { type: 'string', contentEncoding: 'base64', description: 'The image bytes.' },
        },
      }
      : { type: declaration.type }
    if (declaration.description !== undefined) property['description'] = declaration.description
    if (declaration.minLength !== undefined) property['minLength'] = declaration.minLength
    if (declaration.maxLength !== undefined) property['maxLength'] = declaration.maxLength
    if (declaration.minimum !== undefined) property['minimum'] = declaration.minimum
    if (declaration.maximum !== undefined) property['maximum'] = declaration.maximum
    if (declaration.enum !== undefined) property['enum'] = [...declaration.enum]
    if (declaration.default !== undefined) property['default'] = declaration.default
    properties[name] = property
    if (declaration.required) required.push(name)
  }
  return { type: 'object', additionalProperties: false, required, properties }
}

/** The parts of the host's invocation policy a description must state (RCP-10). */
export interface DescribedPolicy {
  /** Whether a remote destination is permitted for this invocation. */
  readonly remoteDestinations: boolean
  /** The host's output-token ceiling. */
  readonly outputTokens: number
  /** The host's image-input ceiling. */
  readonly imageInputs: number
}

/**
 * Describe a recipe and its actual executor possibilities (RCP-10).
 *
 * The description states what the invocation will really do — the effective token
 * ceiling after narrowing, whether a remote destination is possible at all, and that no
 * parent context is supplied — because discovery that describes the recipe's wishes
 * rather than the host's limits tells a caller it can do something it cannot.
 * @param recipe - the recipe to describe.
 * @param policy - the host policy in force.
 * @returns a bounded, honest description.
 */
export function describeRecipe(recipe: RecipeManifest, policy: DescribedPolicy): string {
  const images = Object.entries(recipe.inputs).filter(([, declaration]) => declaration.type === 'image').length
  const ceiling = Math.min(recipe.maxOutputTokens, policy.outputTokens)
  const imageCeiling = Math.min(recipe.imageInputs.max, policy.imageInputs, INITIAL_MAX_IMAGE_INPUTS)
  return [
    `${recipe.tool.name} (contract ${recipe.tool.contractId}) — ${recipe.description}`,
    `Recipe ${recipe.id}@${recipe.version}; ${Object.keys(recipe.inputs).length} declared input(s), ${images} image input(s).`,
    `Limits in force: at most ${ceiling} output tokens (recipe ${recipe.maxOutputTokens}, host ${policy.outputTokens}), `
    + `at most ${imageCeiling} image input(s) (recipe ${recipe.imageInputs.max}, host ${policy.imageInputs}).`,
    `Destinations: ${policy.remoteDestinations ? (recipe.policy.allowRemote ? 'local or remote' : 'local only, by the recipe') : 'local only, by the host policy'}.`,
    `Supplied context: the recipe instructions and the validated bound inputs only — no parent conversation, system `
    + `prompt, tools, skills, attachments or memory (HLM-05). Recording: ${recipe.policy.record ? 'on' : 'off by the recipe'}.`,
  ].join(' ')
}
