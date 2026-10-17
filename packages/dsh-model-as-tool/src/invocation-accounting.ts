/**
 * Invocation accounting: timings, outcome class and sizes (OBS-01, OBS-05).
 *
 * The receipt already carries identity — contract, implementation, extension version,
 * content digest, activation generation, caller scope. OBS-01 asks for four things it did
 * not have:
 *
 *   - **queue / load / inference / total time**, separated, because a slow call has three
 *     very different causes and a single duration cannot tell them apart;
 *   - **a cancellation/failure CLASS**, so an operations reader can group failures rather
 *     than reading prose;
 *   - **sizes**, measured rather than estimated;
 *   - and all of it **without credentials or bodies**, which is why the sizes are NUMBERS
 *     and there is deliberately nowhere to put a payload.
 *
 * The last point is the design constraint rather than a disclaimer: this module has no
 * field that can hold request or response content, so a future change cannot start logging
 * bodies by accident. A `Record<string, unknown>` "details" bag would have undone that in
 * one commit.
 *
 * OBS-05 is the other half: what is recorded is MEASURED, with the runtime that measured
 * it, so a vendor's published figure can never be mistaken for this machine's.
 *
 * @module @try-works/dsh-model-as-tool/invocation-accounting
 */

/**
 * Why an invocation ended.
 *
 * Deliberately coarse and closed: a reader groups by these, and an open string would make
 * every dashboard a list of one-off messages.
 */
export type FailureClass =
  /** The call completed. */
  | 'none'
  /** The caller cancelled, or an imported signal aborted. */
  | 'cancelled'
  /** Policy or the contract refused before work began. */
  | 'refused'
  /** A deadline expired. */
  | 'timeout'
  /** An extension or provider failed. */
  | 'failed'
  /** Authorization denied. */
  | 'policy-denied'

/** Where the time went, in milliseconds. */
export interface InvocationTimings {
  /**
   * Time waiting for admission — a queue, a pool, or a load already in flight.
   *
   * Separated from load time because "the model is already loading for someone else" and
   * "the model is slow to load" are different problems with different fixes.
   */
  readonly queuedMs: number
  /** Time spent preparing or loading, when the invocation had to. */
  readonly loadMs: number
  /** Time the implementation spent on the work itself. */
  readonly inferenceMs: number
  /**
   * Wall time from admission attempt to result.
   *
   * NOT asserted equal to the sum: phases can overlap, and forcing equality would make the
   * record wrong whenever they do.
   */
  readonly totalMs: number
}

/** Byte sizes, measured rather than estimated. */
export interface InvocationSizes {
  /** Serialized request size in bytes. */
  readonly inputBytes: number
  /** Serialized result size in bytes. */
  readonly outputBytes: number
  /** Bytes read from assets during this invocation, when any were. */
  readonly assetBytes: number
}

/** The runtime that produced the measurements (OBS-05). */
export interface MeasurementContext {
  /** Platform, e.g. `win32`. */
  readonly platform: string
  /** Architecture, e.g. `x64`. */
  readonly architecture: string
  /** Node version. */
  readonly nodeVersion: string
  /** The engine or runtime version actually used. */
  readonly engineVersion: string
}

/** One invocation's accounting record. */
export interface InvocationAccounting {
  /** Correlation id, matching the receipt. */
  readonly receiptId: string
  readonly timings: InvocationTimings
  readonly sizes: InvocationSizes
  readonly failureClass: FailureClass
  /** A short class-level reason, never a payload. */
  readonly reason: string | null
  /**
   * How the timings were obtained.
   *
   * `measured` for this process's own clock; the alternative exists so an imported figure
   * can never be presented as one taken here.
   */
  readonly timingSource: 'measured' | 'reported-by-implementation'
  /** The runtime the measurement belongs to. */
  readonly measuredOn: MeasurementContext
  /**
   * The CALLER'S grant identity, present only for external MCP calls (SEC-04).
   *
   * Identity, never payload: the operator can tell WHICH client called, while the
   * record still has no field that can hold request or response content.
   */
  readonly grantId?: string
  /** The authenticated client identity, present with {@link grantId}. */
  readonly clientId?: string
}

/**
 * A phase timer.
 *
 * Records the phases as they HAPPEN rather than inferring them afterwards, because a
 * duration measured by subtraction cannot distinguish a slow load from a slow queue.
 */
export class PhaseTimer {
  readonly #start: number
  readonly #phases = new Map<string, number>()
  #current: { name: string; startedAt: number } | null = null

  constructor(now: () => number = Date.now) {
    this.#now = now
    this.#start = now()
  }

  readonly #now: () => number

  /** Begin a phase, closing any phase already open. */
  begin(name: 'queued' | 'load' | 'inference'): void {
    this.end()
    this.#current = { name, startedAt: this.#now() }
  }

  /** Close the open phase, if any. Idempotent. */
  end(): void {
    if (this.#current === null) return
    const elapsed = this.#now() - this.#current.startedAt
    // Phases ACCUMULATE: a call may load, infer, and resume the same phase after a retry.
    this.#phases.set(this.#current.name, (this.#phases.get(this.#current.name) ?? 0) + elapsed)
    this.#current = null
  }

  /** The timings recorded so far. */
  finish(): InvocationTimings {
    this.end()
    return {
      queuedMs: this.#phases.get('queued') ?? 0,
      loadMs: this.#phases.get('load') ?? 0,
      inferenceMs: this.#phases.get('inference') ?? 0,
      totalMs: this.#now() - this.#start,
    }
  }
}

/** Classify an outcome from what was observed (OBS-01). */
export function classifyOutcome(input: {
  readonly ok: boolean
  readonly aborted?: boolean
  readonly timedOut?: boolean
  readonly denied?: boolean
  readonly refused?: boolean
}): FailureClass {
  /**
   * ORDER MATTERS, and it is the caller's intent that wins.
   *
   * A deadline that fires will usually also surface as an abort, so checking `aborted`
   * first would report every timeout as a cancellation and hide the deadline. Likewise a
   * denial is a policy decision rather than a failure of the work.
   */
  if (input.ok) return 'none'
  if (input.denied === true) return 'policy-denied'
  if (input.refused === true) return 'refused'
  if (input.timedOut === true) return 'timeout'
  if (input.aborted === true) return 'cancelled'
  return 'failed'
}

/**
 * The runtime this process is measuring on (OBS-05).
 *
 * Read from the process rather than configured, so a record cannot claim a platform it was
 * not produced on. That is the specific defect OBS-05 names: Apple Neural Engine figures
 * presented as Windows performance.
 * @param engineVersion - the engine actually used for this invocation.
 * @returns the measurement context.
 */
export function measurementContext(engineVersion: string): MeasurementContext {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    engineVersion,
  }
}

/**
 * Build an accounting record (OBS-01).
 *
 * Sizes are computed from the SERIALIZED forms because that is what crossed the boundary;
 * an object's in-memory size is not what a caller paid for.
 * @param request - what to record.
 * @returns the accounting record.
 */
export function accountInvocation(request: {
  readonly receiptId: string
  readonly timings: InvocationTimings
  readonly failureClass: FailureClass
  readonly reason?: string
  readonly input: unknown
  readonly output?: unknown
  readonly assetBytes?: number
  readonly engineVersion: string
  /** The external caller's grant identity, when the call was external (SEC-04). */
  readonly grantId?: string
  readonly clientId?: string
}): InvocationAccounting {
  return {
    receiptId: request.receiptId,
    timings: request.timings,
    sizes: {
      inputBytes: byteLengthOf(request.input),
      // An absent output is ZERO bytes rather than unknown: nothing crossed the boundary,
      // and reporting `null` would invite a reader to treat it as unmeasured.
      outputBytes: request.output === undefined ? 0 : byteLengthOf(request.output),
      assetBytes: request.assetBytes ?? 0,
    },
    failureClass: request.failureClass,
    reason: request.reason ?? null,
    timingSource: 'measured',
    measuredOn: measurementContext(request.engineVersion),
    ...request.grantId === undefined
      ? {}
      : { grantId: request.grantId, ...request.clientId === undefined ? {} : { clientId: request.clientId } },
  }
}

/** Serialized byte length, with a defined answer for values that cannot serialize. */
function byteLengthOf(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    // `undefined` and functions serialize to `undefined`, which is zero bytes on the wire.
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    /**
     * A cyclic or otherwise unserializable value did cross the boundary, but its size is
     * unknown — and reporting `0` would understate it. Recorded as `-1`, which no real
     * payload can produce, so a reader sees "unmeasured" rather than "empty".
     */
    return -1
  }
}
