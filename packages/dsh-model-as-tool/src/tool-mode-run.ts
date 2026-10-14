/**
 * The ONE authorized program-execution pipeline (CODE-02, CODE-03, CODE-08, ARCH-05).
 *
 * THE DEFECT THIS FIXES, found by adversarial review rather than by a test:
 * `ptc-authority.ts` and `ptc-runtime.ts` had **zero callers outside tests**. Everything in
 * them was correct and thoroughly covered — `buildToolBindings`, the guarded mount,
 * `mayExposeToClients()` — and none of it ran in production. `tool_mode_run` did not exist,
 * the mount guard never executed, and the exposure gate guarded nothing because there was
 * no caller to refuse.
 *
 * A security control with no callers is not a control; it is a symbol. This module is the
 * caller.
 *
 * The wiring enforces three things the directive requires and nothing else did:
 *
 * 1. **ONE pipeline.** Native PTC and any external `tool_mode_run` reach tools through the
 *    SAME `buildToolBindings` call, so authorization cannot differ between the two doors.
 * 2. **The grant is the grant.** The requested names are intersected with the host's own
 *    `allowedTools` and the live registry, and the whole request is refused if anything is
 *    unattainable.
 * 3. **The exposure gate has a caller.** `mayExposeToClients()` returning false now
 *    actually refuses something, with the reason attached.
 *
 * @module @try-works/dsh-model-as-tool/tool-mode-run
 */

import {
  admitTimeout,
  buildToolBindings,
  exposureWithheldReason,
  mayExposeToClients,
  mountPtcRuntimeIfAbsent,
  PTC_SERVICE,
  type PtcHostContext,
} from './ptc-runtime.ts'
import type { ToolBinding } from './ptc-authority.ts'

/** The runtime surface this module needs, narrowed so it is testable. */
export interface ProgramRuntime {
  resolve(request: Record<string, unknown>): unknown
  run(spec: unknown): Promise<{ readonly value?: unknown; readonly error?: { readonly kind?: string; readonly message?: string } }>
}

/** How to reach the tools a program may call. */
export interface RunnerEnvironment {
  /** The host's context, for the guarded mount. */
  readonly context: PtcHostContext
  /** The backend plugin, or undefined when it could not be resolved. */
  readonly backend: unknown
  /** The host's OWN grant — never a caller's claim about what it may use. */
  readonly grant: readonly string[]
  /** The tool names currently registered. */
  readonly visible: readonly string[]
  /** Resolves one authorized name to its implementation. */
  readonly resolve: (name: string) => ToolBinding | undefined
  /** The runtime, once mounted. */
  readonly runtime: () => ProgramRuntime | undefined
}

/** A request to run a program. */
export interface ProgramRequest {
  /** The program source. */
  readonly program: string
  /** The tool names the program declares it will call. */
  readonly requested: readonly string[]
  /** Cancellation, propagated to the runtime. */
  readonly signal?: AbortSignal
  /** A requested budget, CLAMPED rather than honoured. */
  readonly timeoutMs?: number | null
  readonly cwd?: string
}

/** The outcome of a run. */
export type ProgramOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: 'unavailable' | 'unauthorized' | 'cancelled' | 'failed'; readonly message: string }

/** The runner the host uses. */
export interface ProgramRunner {
  /** Mount the backend at most once, through the guard. */
  prepare(): Promise<{ readonly mounted: boolean; readonly reason?: string }>
  /** Run one program through the authorized pipeline. */
  run(request: ProgramRequest): Promise<ProgramOutcome>
  /** Whether an EXTERNAL caller may be served generated-code execution (CODE-08). */
  externalExposurePermitted(): boolean
  /** Why not, when it is not. */
  externalExposureReason(): string
}

/**
 * Create the runner.
 *
 * @param environment - how to reach tools and the runtime.
 * @returns the runner.
 */
export function createProgramRunner(environment: RunnerEnvironment): ProgramRunner {
  let prepared: { mounted: boolean; reason?: string } | undefined

  return {
    async prepare() {
      // Idempotent: the guard is inside, and re-running it must not double-mount.
      if (prepared !== undefined) return prepared
      prepared = await mountPtcRuntimeIfAbsent(environment.context, environment.backend, {
        timeoutMs: 120_000,
        maxTimeoutMs: 600_000,
      })
      return prepared
    },

    externalExposurePermitted() {
      return mayExposeToClients()
    },

    externalExposureReason() {
      return exposureWithheldReason()
    },

    async run(request: ProgramRequest): Promise<ProgramOutcome> {
      const runtime = environment.runtime()
      if (runtime === undefined) {
        return {
          ok: false,
          code: 'unavailable',
          message: 'no PTC runtime is mounted, so no program can run',
        }
      }

      /**
       * THE AUTHORIZED PIPELINE, and the only place bindings are built.
       *
       * `buildToolBindings` intersects the request with the GRANT and the live registry and
       * refuses the whole thing if any name is unattainable. Both doors — native PTC and any
       * external surface — come through here, which is what makes them the same pipeline
       * rather than two implementations that happen to agree today.
       */
      const bindings = buildToolBindings({
        requested: request.requested,
        authority: { granted: environment.grant, visible: environment.visible },
        resolve: environment.resolve,
      })
      if (!bindings.ok) {
        return { ok: false, code: 'unauthorized', message: bindings.message }
      }

      try {
        const result = await runtime.run(runtime.resolve({
          program: request.program,
          bindings: [bindings.namespace],
          // The budget is CLAMPED here, not passed through: `null` means "no deadline" in
          // the runtime's vocabulary, which is a request to opt out of budgeting entirely.
          timeoutMs: admitTimeout(request.timeoutMs),
          ...request.cwd === undefined ? {} : { cwd: request.cwd },
          ...request.signal === undefined ? {} : { signal: request.signal },
        }))

        if (result.error !== undefined && result.error !== null) {
          // A cancelled run is NOT a failure, and the distinction reaches the caller rather
          // than being flattened.
          const kind = result.error.kind
          return {
            ok: false,
            code: kind === 'abort' ? 'cancelled' : 'failed',
            message: result.error.message ?? `the program ended with ${String(kind)}`,
          }
        }
        return { ok: true, value: result.value }
      } catch (error) {
        return {
          ok: false,
          code: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/**
 * The refusal an EXTERNAL caller receives (CODE-08).
 *
 * A separate function so the gate has a single enforcement point rather than a condition
 * repeated at each call site — the shape that let the original gate go unused.
 * @param runner - the runner.
 * @returns the refusal, or undefined when exposure is permitted.
 */
export function externalRefusal(runner: ProgramRunner): { readonly message: string } | undefined {
  if (runner.externalExposurePermitted()) return undefined
  return { message: runner.externalExposureReason() }
}

/** The service key the runner depends on, re-exported so a caller need not import both. */
export { PTC_SERVICE }
