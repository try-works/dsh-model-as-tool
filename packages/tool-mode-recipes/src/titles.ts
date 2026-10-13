/**
 * The built-in `text_title` tool (TOOL-06, RCP-12), built on the broker.
 *
 * RCP-12 requires `text_title` to run through the SAME declarative mechanism as every
 * other recipe and forbids a hardcoded `if (tool === 'text_title')` path in the broker.
 * It does: the instructions below are a recipe, the broker does not know this tool
 * exists, and the only thing special about this file is that it interprets the model's
 * response as a title.
 *
 * THE TOOL-06 RULES ARE MIRRORED HERE, NOT IMPORTED.
 *
 * The host's `packages/dsh-model-as-tool/src/title-proposal.ts` is the original, and this
 * package may not import it (a recipe package must not depend on the host package:
 * EXT-02, ARCH-02). The rules are therefore restated with the same limits, the same five
 * outcomes and the same order of checks, so that a caller receiving a `TitleOutcome` from
 * either implementation can treat them alike. The consequence to keep in mind is real:
 * two copies can drift, and a divergence between them is a defect in whichever one the
 * reviewer decides is wrong. A future refactor that publishes the rules as their own
 * package would remove the copy; that is out of scope here because it would modify a
 * package this one is not allowed to touch.
 *
 * The rule the requirement states most sharply is enforced first and is the reason this
 * tool returns a result union with an `error` member rather than a title:
 * **a refusal or an incomplete generation must never become a valid empty title.**
 * `{ title: "" }` has the correct SHAPE, so a caller writing it into a document produces
 * a blank heading and nothing in the pipeline looks wrong.
 *
 * @module @try-works/tool-mode-recipes/titles
 */

import { HarnessBroker, type BrokerErrorCode, type ProviderIdentity, type RunOptions } from './broker.ts'
import { inputSchemaFor, parseRecipe, type RecipeManifest } from './recipe-format.ts'

/** The lengths the contract states (TOOL-06). Mirrors the host's `SECTION_TITLE_LIMITS`. */
export interface TitleLimits {
  /** Maximum characters in a title. */
  readonly maxTitleChars: number
  /** Maximum characters in a description. */
  readonly maxDescriptionChars: number
  /** Maximum repair attempts permitted. Zero when repairs are disabled. */
  readonly maxRepairs: number
}

/**
 * The evaluated defaults for a section title (TOOL-06).
 *
 * Stated here rather than chosen per call: "define maximum title/description lengths in
 * the schema and evaluated recipe" means a caller cannot widen them by asking, and the
 * recipe's prompt is built from the same numbers so the instruction and the check cannot
 * disagree.
 */
export const SECTION_TITLE_LIMITS: TitleLimits = {
  maxTitleChars: 80,
  maxDescriptionChars: 240,
  // RES-10's initial maximum for automatic repairs is NONE. A reviewed profile may
  // permit one; the count is reported either way.
  maxRepairs: 0,
}

/** What a title is being proposed for. */
export type TitleKind = 'section' | 'page' | 'document'

/** The raw response a text model produced (TOOL-06). */
export interface RawTitleResponse {
  /** The title text, when the model produced one. */
  readonly title?: string
  /** The description text, when the model produced one. */
  readonly description?: string
  /** Set when the model refused. */
  readonly refused?: boolean
  /** Why it refused, when it did. */
  readonly refusalReason?: string
  /** Set when generation was cut short. */
  readonly incomplete?: boolean
}

/** How a proposal ended. Mirrors the host's `TitleOutcome`. */
export type TitleOutcome =
  | {
    readonly kind: 'proposed'
    readonly title: string
    readonly description: string
    /** How many repair attempts were consumed, for the accounting TOOL-06 asks for. */
    readonly repairs: number
  }
  /** The model refused. An ERROR for the caller, never an empty title. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The generation was cut short. An error, never a short title. */
  | { readonly kind: 'incomplete'; readonly reason: string }
  /** The response could not be used as a title. */
  | { readonly kind: 'invalid'; readonly reason: string }
  /** The response failed validation against a rule below. */
  | { readonly kind: 'rejected'; readonly reason: string }

/** Every number appearing in a string, as written. */
function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)*/g) ?? []
}

/** Content words, lowercased, for the overlap check. */
function contentWords(text: string): Set<string> {
  const stop = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'your', 'you',
    'this', 'that', 'is', 'are', 'be', 'it', 'at', 'by', 'as', 'how', 'what', 'why',
  ])
  return new Set(
    text.toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter(word => !stop.has(word)) ?? [],
  )
}

/**
 * Accept or refuse a title proposal (TOOL-06).
 * @param response - the model's raw response.
 * @param source - the text the title was proposed for, used for provenance.
 * @param limits - the lengths the contract states.
 * @returns the outcome, which is an error rather than an empty title whenever the
 *   response was not a usable one.
 */
export function acceptTitle(
  response: RawTitleResponse,
  source: string,
  limits: TitleLimits = SECTION_TITLE_LIMITS,
): TitleOutcome {
  // A REFUSAL IS AN ERROR, checked first so it can never fall through to the empty-title
  // path below.
  if (response.refused === true) {
    return {
      kind: 'refused',
      reason: response.refusalReason ?? 'the model declined to propose a title',
    }
  }
  if (response.incomplete === true) {
    return { kind: 'incomplete', reason: 'the generation was cut short, so no title was completed' }
  }

  const title = response.title
  if (typeof title !== 'string') {
    return { kind: 'invalid', reason: 'the response carried no title field' }
  }
  // AN EMPTY TITLE IS NOT A VALID EMPTY TITLE: a caller writing one into a document
  // produces a blank heading rather than an error.
  if (title.trim().length === 0) {
    return {
      kind: 'rejected',
      reason: 'the title is empty; an empty title is an error, not a valid empty result',
    }
  }
  if (title.length > limits.maxTitleChars) {
    return {
      kind: 'rejected',
      reason: `the title is ${title.length} characters, over the ${limits.maxTitleChars} the contract states`,
    }
  }

  const description = response.description ?? ''
  if (description.length > limits.maxDescriptionChars) {
    return {
      kind: 'rejected',
      reason: `the description is ${description.length} characters, over the ${limits.maxDescriptionChars} the contract states`,
    }
  }

  /**
   * NO INVENTED FACTS: a number in the title or description must appear in the source.
   *
   * "10 Ways to Improve Performance" over a source that never says ten is a claim the
   * source does not support, and it is exactly the embellishment a summariser adds. It is
   * checkable, so it is checked rather than requested in the prompt.
   */
  const sourceNumbers = new Set(numbersIn(source))
  for (const number of numbersIn(title)) {
    if (!sourceNumbers.has(number)) {
      return { kind: 'rejected', reason: `the title states "${number}", which does not appear in the source` }
    }
  }
  for (const number of numbersIn(description)) {
    if (!sourceNumbers.has(number)) {
      return { kind: 'rejected', reason: `the description states "${number}", which does not appear in the source` }
    }
  }

  /**
   * NO CHANGED SOURCE MEANING, approximated as a real overlap requirement: a title
   * sharing no content word with its source is not a title FOR that source.
   */
  const sourceWords = contentWords(source)
  const titleWords = contentWords(title)
  if (sourceWords.size > 0 && titleWords.size > 0) {
    const overlap = [...titleWords].some(word => sourceWords.has(word))
    if (!overlap) {
      return {
        kind: 'rejected',
        reason: 'the title shares no content word with the source, so it is not a title for it',
      }
    }
  }

  return { kind: 'proposed', title: title.trim(), description: description.trim(), repairs: 0 }
}

/**
 * Whether a repair attempt may run (TOOL-06, HLM-07).
 *
 * The requirement says to COUNT repair attempts when they are enabled, so the count is
 * returned rather than kept internally — an uncounted retry is how a budget silently
 * becomes unbounded.
 * @param limits - the contract's limits.
 * @param repairsSoFar - repairs already consumed.
 * @param previous - what the previous attempt produced.
 * @returns whether to repair, and how many repairs would then be consumed.
 */
export function mayRepairTitle(
  limits: TitleLimits,
  repairsSoFar: number,
  previous: TitleOutcome,
): { readonly repair: boolean; readonly repairs: number; readonly reason?: string } {
  if (previous.kind === 'proposed') return { repair: false, repairs: repairsSoFar }
  if (repairsSoFar >= limits.maxRepairs) {
    // Reported as an exhausted budget rather than as a failure to produce a title, so a
    // caller can tell the two apart.
    return {
      repair: false,
      repairs: repairsSoFar,
      reason: `the repair budget of ${limits.maxRepairs} is exhausted; the last outcome was ${previous.kind}`,
    }
  }
  return { repair: true, repairs: repairsSoFar + 1 }
}

/**
 * Whether this tool may call another tool to fulfil its contract (TOOL-06).
 *
 * It may not: "do not call another tool". Returns false so the prohibition is asserted,
 * and no tool catalog is supplied to the provider at all (HLM-06).
 * @returns always false.
 */
export function mayCallAnotherTool(): boolean {
  return false
}

/** The tool name this module implements. */
export const TEXT_TITLE_TOOL = 'text_title'

/** The contract identity this module implements. */
export const TEXT_TITLE_CONTRACT = 'text.title'

/**
 * The recipe instructions for `text_title`, derived from the limits above.
 *
 * Derived rather than written out, because a prompt that states a bound the checker does
 * not enforce (or the reverse) is a recipe whose instruction and contract disagree — the
 * exact drift RCP-06 says to treat as a version change.
 */
const TEXT_TITLE_PROMPT_TEMPLATE = [
  'Propose a title and a one-sentence description for the {{kind}} text supplied below.',
  '',
  'Rules:',
  `- The title must be at most ${SECTION_TITLE_LIMITS.maxTitleChars} characters and the description at most ${SECTION_TITLE_LIMITS.maxDescriptionChars}.`,
  '- State only what the text supports. Never mention a number, name, version or count that does not appear in the text.',
  '- Keep the meaning of the source: title its actual subject and do not broaden, narrow or reinterpret the claim.',
  '- Do not call another tool. Do not ask for more input.',
  '',
  'Text to title:',
  '{{text}}',
  '',
  'Reply with ONE JSON object and nothing else, in exactly this shape:',
  '{"title": "...", "description": "..."}',
  'If the text cannot be titled, reply with {"refused": true, "refusalReason": "..."} instead.',
  'Never reply with an empty title, and never wrap the JSON in prose or a code fence.',
  '',
  'Validation feedback from a previous attempt: {{repairFeedback}}',
].join('\n')

/**
 * The `text_title` recipe as plain JSON.
 *
 * Exported as data so it can be written to `recipes/text-title.json` and pointed at by a
 * TMX manifest (RCP-01: a declarative package's implementation is a static recipe file),
 * with a test asserting the file and this object are the same recipe.
 */
export const TEXT_TITLE_RECIPE_JSON: Record<string, unknown> = {
  id: 'text-title',
  version: '1.0.0',
  description:
    'Proposes a bounded title and description for supplied text through an authorized harness model, using the '
    + 'TOOL-06 rules to refuse invented facts and empty titles.',
  tool: { name: TEXT_TITLE_TOOL, contractId: TEXT_TITLE_CONTRACT },
  inputs: {
    text: {
      type: 'string',
      required: true,
      minLength: 1,
      maxLength: 32768,
      description: 'The text to propose a title for.',
    },
    kind: {
      type: 'string',
      required: false,
      enum: ['section', 'page', 'document'],
      default: 'section',
      description: 'What is being titled.',
    },
    repairFeedback: {
      type: 'string',
      required: false,
      minLength: 1,
      maxLength: 512,
      description: 'Validation feedback for a permitted single repair (HLM-07).',
    },
  },
  promptTemplate: TEXT_TITLE_PROMPT_TEMPLATE,
  // Half of RES-10's initial ceiling: a title and a description do not need 1024 tokens,
  // and a recipe may lower a limit.
  maxOutputTokens: 512,
  imageInputs: { max: 0 },
  policy: { record: true, allowRemote: true },
}

/** The parsed, frozen `text_title` recipe. Parsed at module load, so a broken built-in
 * fails at import rather than at the first invocation. */
export const TEXT_TITLE_RECIPE: RecipeManifest = parseOrThrow(TEXT_TITLE_RECIPE_JSON, TEXT_TITLE_TOOL, TEXT_TITLE_CONTRACT)

/** Parse a built-in recipe, or fail loudly: a built-in that does not validate is a defect. */
function parseOrThrow(
  raw: Record<string, unknown>,
  toolName: string,
  contractId: string,
): RecipeManifest {
  const parsed = parseRecipe(raw, { expectedToolName: toolName, expectedContractId: contractId })
  if (!parsed.ok) {
    throw new Error(`the built-in ${toolName} recipe does not validate: ${parsed.errors.join('; ')}`)
  }
  return parsed.recipe
}

/** The keys a title response may carry. */
const RESPONSE_KEYS: readonly string[] = ['title', 'description', 'refused', 'refusalReason', 'incomplete']

/** The result of reading a title response out of the model's text (RCP-04). */
export type TitleResponseParse =
  | { readonly ok: true; readonly response: RawTitleResponse }
  | { readonly ok: false; readonly reason: string }

/**
 * Read a title response from the model's text (RCP-04).
 *
 * STRICT: the whole text must be one JSON object. No prose extraction and no code-fence
 * unwrapping, because both are guesses about which part of a reply the model meant, and a
 * guess that picks the wrong part silently titles a document with something the model
 * wrote as an aside.
 * @param text - the model's text.
 * @returns the response, or why it could not be read.
 */
export function parseTitleResponse(text: string): TitleResponseParse {
  const trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    return {
      ok: false,
      reason: 'the response is wrapped in a code fence; RCP-04 requires one JSON document with no prose extraction',
    }
  }
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return {
      ok: false,
      reason: 'the response is not a single JSON object; RCP-04 requires a strict JSON document rather than prose to '
        + 'be searched for one',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, reason: `the response is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'the response is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !RESPONSE_KEYS.includes(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `the response carries fields the recipe did not ask for (${unknown.join(', ')}); silently dropping them `
        + 'would accept a response whose schema is not the one that was requested (RCP-04)',
    }
  }
  for (const key of ['title', 'description', 'refusalReason'] as const) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, reason: `the response's "${key}" is not a string` }
    }
  }
  for (const key of ['refused', 'incomplete'] as const) {
    const value = record[key]
    if (value !== undefined && typeof value !== 'boolean') {
      return { ok: false, reason: `the response's "${key}" is not a boolean` }
    }
  }
  return { ok: true, response: record as RawTitleResponse }
}

/** A usable proposal from {@link TextTitleTool.invoke}. */
export interface TextTitleProposal {
  /** The outcome kind. */
  readonly kind: 'proposed'
  /** The accepted title. */
  readonly title: string
  /** The accepted description, possibly empty. */
  readonly description: string
  /** Repair attempts consumed, counted rather than assumed. */
  readonly repairs: number
  /** Which provider generation produced it. */
  readonly provider: ProviderIdentity
  /** Whether the prepared request was journaled. */
  readonly recorded: boolean
}

/**
 * A refused or unusable proposal.
 *
 * There is no `title` member, which is the structural half of the empty-title rule: a
 * caller cannot write a blank heading from this value because there is no field to write.
 */
export interface TextTitleFailure {
  /** The outcome kind. */
  readonly kind: 'error'
  /** Why it failed, from the broker's or this tool's vocabulary. */
  readonly code: BrokerErrorCode
  /** The specific reason. */
  readonly reason: string
  /** Repair attempts consumed before giving up. */
  readonly repairs: number
}

/** What `text_title` produced. */
export type TextTitleResult = TextTitleProposal | TextTitleFailure

/** The registerable tool surface. */
export interface TextTitleTool {
  /** The tool name callers see. */
  readonly name: string
  /** The contract identity (RCP-06). */
  readonly contractId: string
  /** The description for registration, projected from the recipe. */
  readonly description: string
  /** The argument schema, projected from the recipe's declarations (DECL-01). */
  readonly inputSchema: Record<string, unknown>
  /** The recipe the tool runs. */
  readonly recipe: RecipeManifest
  /** The handler to register. */
  invoke(args: unknown, options?: RunOptions): Promise<TextTitleResult>
}

/** Dependencies for {@link createTextTitleTool}. */
export interface TextTitleDeps {
  /** The broker that will run the invocation. */
  readonly broker: HarnessBroker
  /** The recipe to run. Defaults to {@link TEXT_TITLE_RECIPE}. */
  readonly recipe?: RecipeManifest
  /** The limits to enforce. A reviewed profile may NARROW them or permit one repair. */
  readonly limits?: TitleLimits
}

/** Read the source text out of the arguments, for the provenance checks. */
function readSource(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const text = (args as Record<string, unknown>)['text']
  return typeof text === 'string' ? text : undefined
}

/**
 * Build the `text_title` tool.
 *
 * The returned `invoke` is the plain function a registration step can call: it takes the
 * caller's arguments and returns either a proposal or a failure, and it never returns a
 * title it did not accept.
 * @param deps - the broker, and optionally a narrowed recipe or limits.
 * @returns the tool surface.
 */
export function createTextTitleTool(deps: TextTitleDeps): TextTitleTool {
  const recipe = deps.recipe ?? TEXT_TITLE_RECIPE
  const limits = deps.limits ?? SECTION_TITLE_LIMITS

  return {
    name: recipe.tool.name,
    contractId: recipe.tool.contractId,
    description: recipe.description,
    inputSchema: inputSchemaFor(recipe),
    recipe,
    async invoke(args: unknown, options: RunOptions = {}): Promise<TextTitleResult> {
      let repairs = 0
      let feedback: string | undefined
      // The loop runs at most 1 + maxRepairs times, and the count of the extra runs is
      // REPORTED rather than assumed: an uncounted retry is a budget nobody can audit.
      for (;;) {
        const bound = feedback === undefined ? args : { ...(args as Record<string, unknown>), repairFeedback: feedback }
        const outcome = await deps.broker.run(recipe, bound, options)
        if (outcome.kind === 'cancelled') {
          return { kind: 'error', code: 'CANCELLED', reason: outcome.reason, repairs }
        }
        if (outcome.kind === 'failed') {
          return { kind: 'error', code: outcome.code, reason: outcome.reason, repairs }
        }

        const source = readSource(args)
        if (source === undefined) {
          // Unreachable when the broker validated the binding, and kept so this function
          // is total rather than relying on that.
          return {
            kind: 'error',
            code: 'RECIPE_BINDING_ERROR',
            reason: 'the required input "text" was not supplied as a string',
            repairs,
          }
        }

        const read = parseTitleResponse(outcome.text)
        const evaluated: TitleOutcome = read.ok
          ? acceptTitle(read.response, source, limits)
          : { kind: 'invalid', reason: read.reason }

        if (evaluated.kind === 'proposed') {
          return {
            kind: 'proposed',
            title: evaluated.title,
            description: evaluated.description,
            repairs,
            provider: outcome.provider,
            recorded: outcome.recorded,
          }
        }

        const decision = mayRepairTitle(limits, repairs, evaluated)
        if (!decision.repair) {
          return {
            kind: 'error',
            code: codeFor(evaluated),
            reason: decision.reason === undefined
              ? evaluated.reason
              : `${evaluated.reason}; ${decision.reason}`,
            repairs,
          }
        }
        repairs = decision.repairs
        feedback = `The previous attempt was rejected: ${evaluated.reason}. Return a corrected single JSON object.`
      }
    },
  }
}

/** Map a failed title outcome onto the host/management error vocabulary (RCP-11). */
function codeFor(outcome: Exclude<TitleOutcome, { kind: 'proposed' }>): BrokerErrorCode {
  switch (outcome.kind) {
    case 'refused': return 'MODEL_REFUSED'
    case 'incomplete': return 'MODEL_OUTPUT_TRUNCATED'
    case 'invalid': return 'INVALID_MODEL_OUTPUT'
    case 'rejected': return 'INVALID_MODEL_OUTPUT'
  }
}
