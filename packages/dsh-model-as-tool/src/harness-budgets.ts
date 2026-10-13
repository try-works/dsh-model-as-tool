/**
 * Harness budgets and foreground invocation semantics (RES-08, RES-10).
 *
 * Two rules here exist to stop a system reporting something it does not know.
 *
 * - **Unknown cost stays unknown** (RES-10). A budget report has three states for
 *   money: a known amount, "no monetary budget applies", and UNKNOWN. Collapsing
 *   unknown into zero reports a paid call as free, which is the failure the
 *   requirement names.
 * - **A foreground invocation is not a job** (RES-08). It is cancelled or it finishes;
 *   it is never replayed on reconnect, because a call that may already have run is not
 *   safely repeatable — the result could be billed or delivered twice.
 *
 * The initial per-leaf maxima are the numbers the requirement states, asserted
 * individually, because a budget that drifts silently is a limit nobody agreed to.
 *
 * @module @try-works/dsh-model-as-tool/harness-budgets
 */

/** A spending figure that may genuinely be unknown (RES-10). */
export type MonetaryAmount =
  /** A known amount in a named currency. */
  | { readonly known: true; readonly currency: string; readonly amount: number }
  /**
   * The cost is not known.
   *
   * Distinct from a zero amount: a zero would report a call that may be billed as
   * free.
   */
  | { readonly known: false; readonly reason: string }

/** Limits for one tool invocation (RES-10). */
export interface HarnessBudget {
  /** Provider attempts permitted. The initial maximum is ONE. */
  readonly providerAttempts: number
  /** Whether an automatic repair pass is permitted. The initial maximum is NONE. */
  readonly automaticRepairs: number
  /** Wall-clock deadline in seconds. The initial maximum is 60. */
  readonly deadlineSeconds: number
  /** Output tokens permitted. The initial maximum is 1024. */
  readonly outputTokens: number
  /** Image inputs permitted. The initial maximum is 2. */
  readonly imageInputs: number
  /** Model calls permitted, when a server grant sets one. */
  readonly modelCalls: number | null
  /** Whether remote model destinations are permitted at all. */
  readonly remoteDestinations: boolean
  /** The monetary budget, when one applies. */
  readonly monetary: MonetaryAmount
}

/**
 * The initial per-leaf maxima (RES-10).
 *
 * A reviewed recipe or profile may LOWER these, or explicitly permit one repair under
 * the same root deadline and accounting. It may not raise them silently.
 */
export const INITIAL_BUDGET: HarnessBudget = {
  providerAttempts: 1,
  automaticRepairs: 0,
  deadlineSeconds: 60,
  outputTokens: 1024,
  imageInputs: 2,
  modelCalls: null,
  remoteDestinations: true,
  monetary: { known: false, reason: 'no monetary budget was configured for this invocation' },
}

/** A local-only profile, which forbids remote destinations however the tool was built. */
export const LOCAL_ONLY_BUDGET: HarnessBudget = {
  ...INITIAL_BUDGET,
  remoteDestinations: false,
}

/**
 * Narrow a budget by a requested reduction (RES-10).
 *
 * Every figure takes the MINIMUM, so a request can only ever lower a limit. That
 * direction is the point: a caller asking for more than the profile permits gets the
 * profile's figure, not its own.
 * @param base - the budget in force.
 * @param requested - what the caller asked for.
 * @returns the effective budget.
 */
export function narrowBudget(base: HarnessBudget, requested: Partial<HarnessBudget>): HarnessBudget {
  const lower = (a: number, b: number | undefined): number => (b === undefined ? a : Math.min(a, b))
  /**
   * A nullable limit narrows the same way, with `null` meaning "no limit set".
   *
   * A request can INTRODUCE one where the base had none, and can only lower it where
   * the base already had one — so a caller can never widen a grant by asking.
   */
  const lowerNullable = (a: number | null, b: number | null | undefined): number | null => {
    if (b === undefined) return a
    if (a === null) return b
    if (b === null) return a
    return Math.min(a, b)
  }
  return {
    providerAttempts: lower(base.providerAttempts, requested.providerAttempts),
    automaticRepairs: lower(base.automaticRepairs, requested.automaticRepairs),
    deadlineSeconds: lower(base.deadlineSeconds, requested.deadlineSeconds),
    outputTokens: lower(base.outputTokens, requested.outputTokens),
    imageInputs: lower(base.imageInputs, requested.imageInputs),
    modelCalls: lowerNullable(base.modelCalls, requested.modelCalls),
    // A reduction can never ENABLE remote destinations, so this is an AND.
    remoteDestinations: base.remoteDestinations && (requested.remoteDestinations ?? true),
    monetary: base.monetary,
  }
}

/**
 * Whether a repair pass may run (RES-10).
 *
 * The initial maximum is none, and a repair is only permitted when a reviewed profile
 * explicitly allowed one AND the same root deadline still has time in it — a repair
 * that consumes a fresh deadline would evade the budget rather than fit inside it.
 * @param budget - the effective budget.
 * @param repairsSoFar - repairs already performed.
 * @param remainingSeconds - time left on the ROOT deadline.
 * @returns whether to repair.
 */
export function mayRepair(budget: HarnessBudget, repairsSoFar: number, remainingSeconds: number): boolean {
  if (budget.automaticRepairs <= repairsSoFar) return false
  return remainingSeconds > 0
}

/**
 * Whether another provider attempt may run (RES-10).
 * @param budget - the effective budget.
 * @param attemptsSoFar - attempts already made.
 * @returns whether to attempt.
 */
export function mayAttempt(budget: HarnessBudget, attemptsSoFar: number): boolean {
  return attemptsSoFar < budget.providerAttempts
}

/**
 * Render a monetary figure for a report (RES-10).
 *
 * An unknown cost is reported as unknown. Reporting it as zero would present a call
 * that may be billed as free, which is the specific failure the requirement names.
 * @param amount - the figure.
 * @returns the reportable string.
 */
export function describeCost(amount: MonetaryAmount): string {
  return amount.known
    ? `${amount.amount} ${amount.currency}`
    : `unknown (${amount.reason})`
}

/**
 * Whether a budget permits reaching a remote destination (RES-10).
 *
 * A local-only profile prohibits remote destinations INDEPENDENTLY of how the tool was
 * implemented, so this asks the budget rather than the implementation.
 * @param budget - the effective budget.
 * @param destination - the destination being considered.
 * @returns whether it is permitted.
 */
export function permitsDestination(budget: HarnessBudget, destination: 'local' | 'remote'): boolean {
  return destination === 'local' ? true : budget.remoteDestinations
}

/** How a foreground invocation ended (RES-08). */
export type InvocationEnd =
  /** The tool completed normally. */
  | { readonly kind: 'completed' }
  /** The tool failed; the failure is the result. */
  | { readonly kind: 'failed'; readonly reason: string }
  /** Cancellation was requested and honoured on the originating stream. */
  | { readonly kind: 'cancelled' }
  /**
   * The connection dropped without an answer.
   *
   * Distinct from `failed`, because there is no result to report — and distinct from
   * `completed`, because the call may have run.
   */
  | { readonly kind: 'disconnected'; readonly mayHaveRun: boolean }

/**
 * Whether an interrupted foreground invocation may be REPLAYED on reconnect (RES-08).
 *
 * Never. A foreground invocation is not a persistent job, and the requirement forbids
 * automatically replaying completed or uncertain calls: a call that may already have
 * run is not safely repeatable, because its effects could be billed or delivered
 * twice. A retry is a NEW request with fresh authorization and budget.
 * @returns always false.
 */
export function mayReplayAfterReconnect(): boolean {
  return false
}

/**
 * Whether a dropped connection should be reported as ambiguous (RES-08, P26-07).
 *
 * It should, whenever the work may have run: the client cannot otherwise tell a call
 * that never started from one that completed and whose response was lost.
 * @param mayHaveRun - whether work had started.
 * @returns whether the completion is ambiguous.
 */
export function isAmbiguousCompletion(mayHaveRun: boolean): boolean {
  return mayHaveRun
}
