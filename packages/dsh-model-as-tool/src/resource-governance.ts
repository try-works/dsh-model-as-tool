/**
 * Resource governance (RES-01, RES-04, RES-06, RES-09).
 *
 * Three distinctions here are easy to collapse and expensive to get wrong.
 *
 * **Readiness is not residency** (RES-04). The state vocabulary has eight members,
 * and they answer two DIFFERENT questions: `unavailable` and `needs-preparation` say
 * a call is not possible at all, while `prepared-cold`, `loading`, `ready` and `busy`
 * say it is possible and merely describe how the call will be admitted. Treating
 * `prepared-cold` as uncallable withdraws a tool that works, and — worse — makes the
 * tool surface change on every warm/cold transition, which RES-04 explicitly forbids
 * because an agent's view of its tools must not flicker with a cache.
 *
 * **A budget is a rejection, not a truncation** (RES-01, RES-09). Over-budget input
 * is refused WITH THE ACTUAL LIMITS, because a caller that cannot see the limit
 * cannot choose a smaller input. Silently trimming source data is the failure both
 * requirements name.
 *
 * **Cancellation is a claim about behaviour** (RES-06). Where a backend cannot be
 * interrupted, saying "cancelled" while its work continues is worse than admitting
 * the work is still running, so the outcome says which of the two happened.
 *
 * @module @try-works/dsh-model-as-tool/resource-governance
 */

/**
 * The eight readiness/residency states (RES-04).
 *
 * Named `Readiness` rather than `Residency` because it holds both dimensions; the
 * two derived functions below are what separate them.
 */
export type Readiness =
  /** No compatible implementation exists on this host. */
  | 'unavailable'
  /** Compatible, but its assets have not been prepared. */
  | 'needs-preparation'
  /** Preparation is under way. */
  | 'preparing'
  /** Prepared and not loaded: a call will load first. */
  | 'prepared-cold'
  /** Currently loading. */
  | 'loading'
  /** Loaded and idle. */
  | 'ready'
  /** Loaded and serving; further calls queue. */
  | 'busy'
  /** Preparation or loading failed. */
  | 'failed'

/** The states in which a call is possible at all (RES-04). */
const CALLABLE: ReadonlySet<Readiness> = new Set<Readiness>([
  // A cold but PREPARED deployment is callable: preparation, not residency, is what
  // makes a call possible.
  'prepared-cold',
  'loading',
  'ready',
  'busy',
])

/** The states that imply assets are on disk (RES-04). */
const PREPARED: ReadonlySet<Readiness> = new Set<Readiness>([
  'prepared-cold',
  'loading',
  'ready',
  'busy',
])

/**
 * Whether a call is possible in this state (RES-04).
 *
 * Determined by compatibility, authorization and PREPARATION — never by residency.
 * @param state - the current state.
 * @returns whether the tool can be called.
 */
export function isCallable(state: Readiness): boolean {
  return CALLABLE.has(state)
}

/**
 * Whether assets are prepared (RES-04).
 * @param state - the current state.
 * @returns whether preparation has completed.
 */
export function isPrepared(state: Readiness): boolean {
  return PREPARED.has(state)
}

/** How a call is admitted in a given state (RES-04). */
export type Admission =
  /** Runs now. */
  | 'immediate'
  /** Will load first, so it takes longer. */
  | 'loads-first'
  /** Waits for the current call to finish. */
  | 'queued'

/**
 * How residency affects admission (RES-04).
 *
 * This is the half that residency legitimately controls: not WHETHER a tool exists,
 * but what a call to it costs.
 * @param state - the current state.
 * @returns the admission behaviour, or undefined when no call is possible.
 */
export function admissionOf(state: Readiness): Admission | undefined {
  switch (state) {
    case 'ready': return 'immediate'
    case 'prepared-cold': return 'loads-first'
    // `loading` and `busy` both mean work is in progress, so a new call waits for it
    // rather than starting a second load of the same deployment.
    case 'loading':
    case 'busy': return 'queued'
    default: return undefined
  }
}

/**
 * Whether a tool DESCRIPTION may vary with this state (RES-04).
 *
 * Always false. RES-04 forbids changing agent tool descriptions on every warm/cold
 * transition, so this exists to be asserted rather than to be consulted: a caller
 * that branches on residency when building a description has found a bug.
 * @returns always false.
 */
export function descriptionMayVaryWithResidency(): boolean {
  return false
}

/** A budgeted resource (RES-09). */
export type BudgetKind =
  | 'sourceBytes'
  | 'decodedPixels'
  | 'audioSamples'
  | 'videoSeconds'
  | 'videoFrames'
  | 'processorTokens'
  | 'batch'
  | 'outputVectors'

/** Limits for one input class. `null` means the constraint does not apply. */
export type Budget = Partial<Record<BudgetKind, number | null>>

/**
 * The product defaults the requirement names verbatim (RES-09).
 *
 * These are PRODUCT limits, not guarantees that every input within them fits: the
 * requirement says model context limits may force lower admission, so a successful
 * check here is necessary and not sufficient.
 */
export const DEFAULT_BUDGETS: Readonly<Record<'image' | 'video' | 'audio' | 'text', Budget>> = {
  image: {
    sourceBytes: 8 * 1024 * 1024,
    decodedPixels: 16_000_000,
  },
  video: {
    sourceBytes: 128 * 1024 * 1024,
    videoSeconds: 120,
    videoFrames: 32,
  },
  audio: {
    // 16 kHz mono for an hour, matching the transcription contract's admission.
    audioSamples: 16_000 * 3600,
  },
  text: {
    sourceBytes: 1024 * 1024,
    processorTokens: 8192,
  },
}

/** A measured input. */
export type Measurement = Partial<Record<BudgetKind, number>>

/** The outcome of admitting an input. */
export type AdmissionDecision =
  | { readonly admitted: true }
  | {
    readonly admitted: false
    /** Every exceeded budget, with the actual limit. */
    readonly exceeded: readonly {
      readonly kind: BudgetKind
      readonly measured: number
      readonly limit: number
    }[]
  }

/**
 * Decide whether an input fits its budget (RES-01, RES-09).
 *
 * Over-budget input is REJECTED with the actual limits. It is never truncated and
 * never sampled down, because the caller cannot otherwise tell that what it supplied
 * is not what was processed.
 * @param measurement - what the input actually is.
 * @param budget - the limits in force.
 * @returns the decision, naming every exceeded budget.
 */
export function admit(measurement: Measurement, budget: Budget): AdmissionDecision {
  const exceeded: { kind: BudgetKind; measured: number; limit: number }[] = []
  for (const [kind, limit] of Object.entries(budget) as [BudgetKind, number | null][]) {
    if (limit === null || limit === undefined) continue
    const measured = measurement[kind]
    // An unmeasured budget cannot be enforced, and pretending it passed would be a
    // silent acceptance. It is reported as exceeded by zero only if actually over, so
    // an absent measurement is treated as "not applicable" rather than as "fits".
    if (measured === undefined) continue
    if (measured > limit) exceeded.push({ kind, measured, limit })
  }
  return exceeded.length === 0 ? { admitted: true } : { admitted: false, exceeded }
}

/**
 * Render a rejection the caller can act on (RES-01).
 *
 * The requirement says to reject with ACTUAL LIMITS: a caller told only "too large"
 * cannot choose a smaller input.
 * @param decision - a rejection.
 * @returns the message.
 */
export function describeRejection(decision: Extract<AdmissionDecision, { admitted: false }>): string {
  return decision.exceeded
    .map(entry => `${entry.kind} is ${entry.measured}, over the limit of ${entry.limit}`)
    .join('; ')
}

/** An explicit sampling instruction (RES-09). */
export interface SamplingPlan {
  /** What was sampled, in the caller's terms. */
  readonly instruction: string
  /** The budget that forced sampling, when one did. */
  readonly forcedBy: BudgetKind | null
}

/** What was actually processed, returned so coverage is never implied. */
export interface Coverage {
  /** Whether every unit of the source was processed. */
  readonly complete: boolean
  /** Units processed. */
  readonly processed: number
  /** Units in the source. */
  readonly total: number
  /** The sampling that was applied, when any was. */
  readonly sampling: SamplingPlan | null
  /** Why coverage is incomplete. */
  readonly reason: string | null
}

/**
 * Build the coverage report for an input that had to be sampled (RES-09).
 *
 * Sampling is only legitimate when it is EXPLICIT and its coverage is REPORTED. An
 * implementation that quietly processed 32 of 900 frames and reported success has
 * told the caller something false about the input it supplied.
 * @param processed - units processed.
 * @param total - units in the source.
 * @param sampling - the instruction applied, when one was.
 * @returns the coverage report.
 */
export function coverageOf(processed: number, total: number, sampling: SamplingPlan | null): Coverage {
  const complete = processed >= total
  return {
    complete,
    processed,
    total,
    sampling,
    reason: complete
      ? null
      : sampling === null
        // Incomplete WITHOUT a sampling instruction is a defect, not a policy: the
        // requirement forbids silent sampling, so this case is named rather than
        // dressed up as intentional.
        ? 'the source was not fully processed and no sampling instruction was recorded'
        : `sampled by instruction: ${sampling.instruction}`,
  }
}

/** How a cancellation actually ended (RES-06). */
export type CancellationOutcome =
  /** The work stopped and released its resources. */
  | { readonly stopped: true }
  /**
   * The work could not be interrupted. It continues to completion, and its result
   * is discarded rather than delivered.
   */
  | { readonly stopped: false; readonly reason: string }

/**
 * Describe a cancellation honestly (RES-06).
 *
 * RES-06 forbids claiming cancellation while uncontrolled work continues
 * indefinitely. Where a backend cannot be interrupted safely, the honest report is
 * that it is still running and its result will be discarded — which is also why the
 * requirement prefers isolating such a backend in an owned worker.
 * @param interruptible - whether the backend can be interrupted safely.
 * @param subject - what is being cancelled, for the message.
 * @returns the outcome to report.
 */
export function cancellationOutcome(interruptible: boolean, subject: string): CancellationOutcome {
  return interruptible
    ? { stopped: true }
    : {
        stopped: false,
        reason: `${subject} cannot be interrupted safely; it will run to completion and its result discarded`,
      }
}

/**
 * Whether a decompression bomb must be rejected before allocation (RES-09).
 *
 * The check is on the DECLARED expanded size, before any allocation: a check that
 * runs after decompression has already lost.
 * @param declaredBytes - the expansion the container declares.
 * @param limit - the budget for this input class.
 * @returns whether to reject.
 */
export function isExpansionBomb(declaredBytes: number, limit: number): boolean {
  return declaredBytes > limit
}
