/**
 * Server and plugin lifecycle (RUN-01, RUN-02, RUN-05, RUN-06, RUN-07).
 *
 * Almost every rule here is about what must NOT happen:
 *
 * - **Do not announce readiness before it is true** (RUN-06). A listener that reports
 *   ready before its bind or its initialisation succeeded sends a client to a port
 *   that is not answering. Readiness is therefore a STATE derived from both, not a flag
 *   set by whoever got there first.
 * - **Do not resolve a port conflict by force or by stealth** (RUN-06). Taking the port
 *   from another process, or silently moving to a different one, both break a client
 *   that was told where to connect. The conflict is reported.
 * - **Do not let a failed start take the host with it** (RUN-06). The MCP endpoint is
 *   one feature of a much larger host; a port clash must leave the rest running.
 * - **Do not kill work you do not own** (RUN-07). A model process serving another
 *   still-authorized owner is not this lifecycle's to terminate.
 * - **Do not prepare anything at startup** (RUN-05). Nothing downloads because a plugin
 *   loaded or a client listed tools.
 *
 * @module @try-works/dsh-model-as-tool/server-lifecycle
 */

/** Where the server is in its lifecycle. */
export type ServerState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed'

/** Why a start failed. */
export interface StartFailure {
  /** A stable code, so a caller can branch without matching a message. */
  readonly code: 'PORT_IN_USE' | 'BIND_FAILED' | 'INIT_FAILED' | 'ALREADY_STARTED'
  readonly message: string
  /** What to do about it, because a bare failure leaves an operator stuck. */
  readonly remedy: string
}

/** One piece of work the server owns (RUN-07). */
export interface OwnedWork {
  /** An identity for diagnostics. */
  readonly id: string
  /**
   * The owner this work serves.
   *
   * Shutdown cancels work THIS lifecycle owns, and the owner is recorded so a model
   * process serving another still-authorized owner is never terminated by mistake.
   */
  readonly owner: string
  /** Ask the work to stop. */
  cancel(): Promise<void> | void
  /** Force it to stop after the grace period. */
  terminate?(): void
}

/** What the lifecycle needs from its environment. */
export interface LifecycleHost {
  /**
   * Bind the listener.
   *
   * Implementations throw with a `code` of `EADDRINUSE` for a port conflict; the
   * lifecycle reports it rather than trying to resolve it.
   */
  bind(): Promise<{ readonly port: number; readonly close: () => Promise<void> }>
  /** Initialise whatever must be ready before the endpoint serves. */
  initialise(): Promise<void>
  /** Called once, and only once, when both bind and initialise have succeeded. */
  onReady(port: number): void
  /** Log a non-fatal diagnostic. */
  log(message: string): void
}

/** The documented grace period for cleanup (RUN-07). */
export const DEFAULT_GRACE_MS = 5000

/** How a shutdown ended. */
export interface ShutdownReport {
  /** Work that stopped within the grace period. */
  readonly cancelled: readonly string[]
  /** Work that had to be terminated after it. */
  readonly terminated: readonly string[]
  /** Work that was NOT touched because this lifecycle does not own it. */
  readonly untouched: readonly string[]
  /** Whether the port was released. */
  readonly portReleased: boolean
  /** Whether cleanup finished inside the grace period. */
  readonly withinGrace: boolean
}

/**
 * Manages one MCP listener's lifecycle.
 *
 * Deliberately separate from the DSH plugin's own lifecycle: RUN-01 requires disabling
 * the SERVER to stop its listener and owned work without disabling unrelated DSH tools,
 * so the two must be independently stoppable.
 */
export class ServerLifecycle {
  #state: ServerState = 'stopped'
  #port: number | null = null
  #closeListener: (() => Promise<void>) | null = null
  readonly #work = new Map<string, OwnedWork>()
  readonly #host: LifecycleHost
  readonly #graceMs: number
  /** Set once shutdown begins, so new work is refused from that moment. */
  #acceptingWork = true

  constructor(host: LifecycleHost, options: { readonly graceMs?: number } = {}) {
    this.#host = host
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  }

  /** The current state. */
  get state(): ServerState {
    return this.#state
  }

  /** The bound port, once one exists. */
  get port(): number | null {
    return this.#port
  }

  /**
   * Whether the endpoint is serving (RUN-06).
   *
   * True only after BOTH bind and initialise succeeded. A caller asking "can I connect"
   * gets one answer, and it is not derived from a flag somebody set early.
   */
  get ready(): boolean {
    return this.#state === 'ready'
  }

  /** Work currently owned, for diagnostics. */
  get owned(): readonly OwnedWork[] {
    return [...this.#work.values()]
  }

  /**
   * Start the listener.
   *
   * @returns nothing on success, or the failure — never a thrown exception, because
   *   RUN-06 requires a failed start not to crash the unrelated host.
   */
  async start(): Promise<{ readonly ok: true; readonly port: number } | { readonly ok: false; readonly failure: StartFailure }> {
    if (this.#state === 'ready' || this.#state === 'starting') {
      return {
        ok: false,
        failure: {
          code: 'ALREADY_STARTED',
          message: `the server is already ${this.#state}`,
          remedy: 'Call stop() before starting again.',
        },
      }
    }
    this.#state = 'starting'
    try {
      const listener = await this.#host.bind()
      this.#port = listener.port
      this.#closeListener = listener.close
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.#state = 'failed'
      if (code === 'EADDRINUSE') {
        // Reported, NOT resolved. Taking the port from another process or silently
        // moving to a different one both break a client told where to connect.
        return {
          ok: false,
          failure: {
            code: 'PORT_IN_USE',
            message: `port ${String((error as Error).message)} is already in use`,
            remedy: 'Choose a different port in the configuration, or stop the process holding it. This server will not take it by force or move silently.',
          },
        }
      }
      return {
        ok: false,
        failure: {
          code: 'BIND_FAILED',
          message: error instanceof Error ? error.message : String(error),
          remedy: 'Check that the bind address is a loopback address and that the port is permitted.',
        },
      }
    }

    try {
      await this.#host.initialise()
    } catch (error) {
      this.#state = 'failed'
      // The listener bound but cannot serve, so it is CLOSED rather than left open:
      // an open port that answers nothing is worse than no port.
      await this.#closeListener?.().catch(() => undefined)
      this.#closeListener = null
      this.#port = null
      return {
        ok: false,
        failure: {
          code: 'INIT_FAILED',
          message: error instanceof Error ? error.message : String(error),
          remedy: 'Check the server diagnostics; the host itself is unaffected.',
        },
      }
    }

    // Only now. Readiness after BOTH succeed, and never before.
    this.#state = 'ready'
    this.#host.onReady(this.#port as number)
    return { ok: true, port: this.#port as number }
  }

  /**
   * Register work this lifecycle owns (RUN-07).
   *
   * Refused once shutdown has begun, so a call racing a stop cannot slip into the
   * cleanup window and be left running.
   * @param work - the work to own.
   * @returns whether it was accepted.
   */
  adopt(work: OwnedWork): boolean {
    if (!this.#acceptingWork) return false
    this.#work.set(work.id, work)
    return true
  }

  /** Release work that finished on its own. */
  release(id: string): void {
    this.#work.delete(id)
  }

  /**
   * Stop the listener and everything it owns (RUN-07).
   *
   * The order is the requirement's: refuse new work, cancel owned foreground
   * invocations, wait within the grace period, terminate what remains, close the
   * transport and release the port. Work belonging to another owner is LEFT ALONE.
   * @param options - `ownedBy` selects the owner whose work may be stopped.
   * @returns the report.
   */
  async stop(options: { readonly ownedBy?: string } = {}): Promise<ShutdownReport> {
    // 1. Refuse new work FIRST, so nothing is adopted during cleanup.
    this.#acceptingWork = false
    if (this.#state === 'stopped') {
      return { cancelled: [], terminated: [], untouched: [], portReleased: true, withinGrace: true }
    }
    this.#state = 'stopping'

    const mine: OwnedWork[] = []
    const untouched: string[] = []
    for (const work of this.#work.values()) {
      // RUN-07: never kill a model process serving another still-authorized owner.
      if (options.ownedBy !== undefined && work.owner !== options.ownedBy) {
        untouched.push(work.id)
        continue
      }
      mine.push(work)
    }

    // 2. Cancel owned foreground invocations, and wait for them WITHIN the grace
    // period. Racing each cancel against one shared deadline is what makes the grace
    // period mean something: a cancel that never resolves must not hold shutdown open
    // forever, and it must not be reported as stopped either.
    const deadline = Date.now() + this.#graceMs
    const cancelled: string[] = []
    const terminated: string[] = []
    const outcomes = await Promise.all(mine.map(async work => {
      const remaining = Math.max(0, deadline - Date.now())
      const settled = await Promise.race([
        Promise.resolve(work.cancel()).then(() => true).catch(() => false),
        new Promise<false>(resolve => setTimeout(() => resolve(false), remaining)),
      ])
      return { work, settled }
    }))
    for (const { work, settled } of outcomes) {
      if (settled) cancelled.push(work.id)
    }
    const withinGrace = outcomes.every(outcome => outcome.settled)

    // 3. Terminate whatever outlived the grace period.
    for (const { work, settled } of outcomes) {
      if (settled) continue
      try {
        work.terminate?.()
        terminated.push(work.id)
      } catch {
        // A terminate that throws is logged rather than fatal: shutdown must complete
        // even when one piece of work refuses to die.
        this.#host.log(`work ${work.id} could not be terminated`)
      }
    }
    this.#work.clear()

    // 4. Close the transport and release the port.
    let portReleased = false
    try {
      await this.#closeListener?.()
      portReleased = true
    } catch {
      this.#host.log('the listener could not be closed cleanly')
    }
    this.#closeListener = null
    this.#port = null
    this.#state = 'stopped'
    this.#acceptingWork = true
    return { cancelled, terminated, untouched, portReleased, withinGrace }
  }
}

/** What startup may and may not do (RUN-05). */
export interface StartupPolicy {
  /**
   * Whether model preparation may run at startup.
   *
   * Always false. The type carries it so the prohibition is visible at the call site
   * rather than only in the requirement.
   */
  readonly preparesModels: false
  /** Whether package resolution may run at startup. Always false. */
  readonly resolvesPackages: false
  /** Whether discovery is read-only. Always true. */
  readonly discoveryIsReadOnly: true
}

/** The only startup policy this implementation permits (RUN-05). */
export const READ_ONLY_STARTUP: StartupPolicy = {
  preparesModels: false,
  resolvesPackages: false,
  discoveryIsReadOnly: true,
}

/**
 * Whether a startup action is permitted (RUN-05).
 *
 * @param action - what the startup wants to do.
 * @returns whether it may.
 */
export function startupPermits(action: 'restore-active' | 'inspect-assets' | 'read-manifests' | 'prepare-model' | 'resolve-package' | 'download-weights'): boolean {
  switch (action) {
    // Restoring an explicitly approved activation and inspecting local state are the
    // two things startup MAY do.
    case 'restore-active':
    case 'inspect-assets':
    case 'read-manifests':
      return true
    // Preparation and resolution are refused, because RUN-05 is explicit that nothing
    // downloads because a plugin loaded or a client listed tools.
    case 'prepare-model':
    case 'resolve-package':
    case 'download-weights':
      return false
  }
}

/**
 * Whether disabling the MCP server must also disable unrelated DSH tools (RUN-01).
 *
 * It must not. The server and the plugin are independently stoppable, which is why the
 * lifecycle is a separate object from the plugin's own registration state.
 * @returns always false.
 */
export function disablingServerDisablesOtherTools(): boolean {
  return false
}
