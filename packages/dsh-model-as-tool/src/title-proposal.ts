/**
 * Title and description proposal (TOOL-06), with the language-evidence rule from
 * TOOL-03.
 *
 * TOOL-06 is mostly a list of things a title generator must NOT do, and the sharpest of
 * them is this: **a refusal or an incomplete generation must not become a valid empty
 * title.** That failure is easy to ship and hard to notice, because the shape of the
 * response is correct — `{ title: "" }` looks like a result — and a caller writing it
 * into a document produces an empty heading rather than an error.
 *
 * The other rules here are enforced rather than described:
 *
 * - **No invented facts.** A number in a proposed title that does not appear in the
 *   source is a claim the source does not support. This is checkable, so it is checked.
 * - **No changed source meaning.** Enforced through the same provenance check plus a
 *   refusal to accept a title with no overlap with the source.
 * - **No calling another tool.** Structural: the response shape carries no tool-call
 *   field, so there is nothing to dispatch.
 * - **Maximum lengths in the schema**, which the contract states and this enforces.
 *
 * @module @try-works/dsh-model-as-tool/title-proposal
 */

/** The lengths the contract states (TOOL-06). */
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
 * Stated in the contract rather than chosen per call, because "define maximum
 * title/description lengths in the schema and evaluated recipe" means a caller cannot
 * widen them by asking.
 */
export const SECTION_TITLE_LIMITS: TitleLimits = {
  // A heading is scanned, not read; beyond this it wraps and stops being a heading.
  maxTitleChars: 80,
  maxDescriptionChars: 240,
  maxRepairs: 1,
}

/**
 * The contract limits for one configuration's CODE-11 repair ceiling.
 *
 * The title/description lengths stay contract-stated; the repair ceiling is
 * the operator's configured number (an integer 0..8, default 1). An invalid
 * ceiling is a REFUSAL, never a silent clamp — the recorded lineage must show
 * the budget the operator actually approved.
 * @param repairCeiling - the configured ceiling; absent means the default 1.
 * @returns the limits the repair decision and lineage honor.
 */
export function titleLimitsFor(repairCeiling?: number): TitleLimits {
  const ceiling = repairCeiling ?? SECTION_TITLE_LIMITS.maxRepairs
  if (!Number.isInteger(ceiling) || ceiling < 0 || ceiling > 8) {
    throw new Error(
      `the repair ceiling must be an integer between 0 and 8 (CODE-11); received ${JSON.stringify(ceiling)}`,
    )
  }
  return {
    maxTitleChars: SECTION_TITLE_LIMITS.maxTitleChars,
    maxDescriptionChars: SECTION_TITLE_LIMITS.maxDescriptionChars,
    maxRepairs: ceiling,
  }
}

/** What a title is being proposed for. */
export type TitleKind = 'section' | 'page' | 'document'

/** The raw response a text model produced (TOOL-06). */
export interface RawTitleResponse {
  /** The title text, when the model produced one. */
  readonly title?: string
  /** The description text, when the model produced one. */
  readonly description?: string
  /**
   * Set when the model refused.
   *
   * Distinguishing a refusal from an empty generation is what stops the first becoming
   * a valid empty title.
   */
  readonly refused?: boolean
  /** Why it refused, when it did. */
  readonly refusalReason?: string
  /**
   * Set when generation was cut short.
   *
   * A truncated generation is not a short one; reporting it as a title claims a
   * complete answer from an incomplete one.
   */
  readonly incomplete?: boolean
}

/** How a proposal ended. */
export type TitleOutcome =
  /** A usable title. */
  | {
    readonly kind: 'proposed'
    readonly title: string
    readonly description: string
    /** How many repair attempts were consumed, for the accounting TOOL-06 asks for. */
    readonly repairs: number
  }
  /**
   * The model refused.
   *
   * An ERROR for the caller, never an empty title.
   */
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
 *
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
  // A REFUSAL IS AN ERROR. This is the rule the requirement states most sharply, and it
  // is checked first so a refusal can never fall through to the empty-title path.
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
  // AN EMPTY TITLE IS NOT A VALID EMPTY TITLE. A caller writing one into a document
  // produces a blank heading rather than an error, which is why this is refused.
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
   * NO INVENTED FACTS: a number in the title must appear in the source.
   *
   * "10 Ways to Improve Performance" over a source that never says ten is a claim the
   * source does not support, and it is exactly the kind of plausible embellishment a
   * summariser adds. This is checkable, so it is checked rather than requested.
   */
  const sourceNumbers = new Set(numbersIn(source))
  for (const number of numbersIn(title)) {
    if (!sourceNumbers.has(number)) {
      return {
        kind: 'rejected',
        reason: `the title states "${number}", which does not appear in the source`,
      }
    }
  }
  for (const number of numbersIn(description)) {
    if (!sourceNumbers.has(number)) {
      return {
        kind: 'rejected',
        reason: `the description states "${number}", which does not appear in the source`,
      }
    }
  }

  /**
   * NO CHANGED SOURCE MEANING, approximated as a real overlap requirement.
   *
   * A title sharing no content word with its source is not a title FOR that source; it
   * is a different claim wearing the shape of one.
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
 * Whether a repair attempt may run (TOOL-06).
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
  if (previous.kind === 'proposed') {
    return { repair: false, repairs: repairsSoFar }
  }
  if (repairsSoFar >= limits.maxRepairs) {
    // Reported as an exhausted budget rather than as a failure to produce a title, so
    // the caller can tell the two apart.
    return {
      repair: false,
      repairs: repairsSoFar,
      reason: `the repair budget of ${limits.maxRepairs} is exhausted; the last outcome was ${previous.kind}`,
    }
  }
  return { repair: true, repairs: repairsSoFar + 1 }
}

/**
 * One repair-lineage entry (CODE-11): the traceable per-attempt record the
 * budget lineage owes — which repair, the budget before and after the
 * decision, and the outcome the decision produced. A COUNT alone cannot show
 * WHERE a budget was spent; the lineage does.
 */
export interface RepairLineageEntry {
  /** One-based repair attempt index. */
  readonly repairIndex: number
  /** The repair budget before the decision. */
  readonly budgetBefore: number
  /** The repair budget after the decision (one lower when a repair ran). */
  readonly budgetAfter: number
  /** What the previous attempt produced, so the lineage names WHY. */
  readonly previousKind: string
  /** The decision outcome for this attempt. */
  readonly outcome: 'repaired' | 'exhausted' | 'not-needed'
}

/**
 * Record one repair decision into the lineage (CODE-11, pure and testable).
 * @param lineage - the lineage so far (mutated in place, then returned).
 * @param decision - the `mayRepairTitle` decision for this attempt.
 * @param previousKind - the previous outcome kind.
 * @param budgetBefore - the budget the decision was made against.
 * @returns the updated lineage.
 */
export function recordRepairLineage(
  lineage: RepairLineageEntry[],
  decision: { readonly repair: boolean; readonly repairs: number },
  previousKind: string,
  budgetBefore: number,
): RepairLineageEntry[] {
  const outcome = decision.repair
    ? 'repaired'
    : decision.repairs >= budgetBefore && previousKind !== 'proposed'
      ? 'exhausted'
      : 'not-needed'
  lineage.push({
    repairIndex: lineage.length + 1,
    budgetBefore,
    // The budget AFTER the decision is the budget before minus the one
    // attempt a repair consumed — the lineage's own contract ("one lower
    // when a repair ran"), never the consumed count relabelled.
    budgetAfter: budgetBefore - (decision.repair ? 1 : 0),
    previousKind,
    outcome,
  })
  return lineage
}

/**
 * Whether a tool may call another tool to fulfil this contract (TOOL-06).
 *
 * It may not: "do not call another tool". Returns false so the prohibition is asserted,
 * and the response shape carries no tool-call field for one to be dispatched from.
 * @returns always false.
 */
export function mayCallAnotherTool(): boolean {
  return false
}

/** What a language result actually examined (TOOL-03). */
export type LanguageEvidence = 'text' | 'audio'

/**
 * Whether a language result may be cited as evidence for a medium (TOOL-03).
 *
 * A text detector's result is evidence about the TEXT it processed and nothing else.
 * The requirement forbids using it as evidence of the language SPOKEN in audio it has
 * not processed, and the refusal is per-medium rather than per-result because the result
 * itself is sound — only its use as audio evidence is not.
 * @param examined - what the result examined.
 * @param claimed - the medium being claimed.
 * @returns whether the claim is supported.
 */
export function supportsLanguageClaim(examined: LanguageEvidence, claimed: LanguageEvidence): boolean {
  return examined === claimed
}

/**
 * Describe what a language result is evidence for (TOOL-03).
 * @param examined - what the result examined.
 * @returns a description that does not overstate the result.
 */
export function describeLanguageEvidence(examined: LanguageEvidence): string {
  return examined === 'text'
    ? 'the language of the supplied text; this is not evidence of the language spoken in audio'
    : 'the language of the supplied audio'
}
