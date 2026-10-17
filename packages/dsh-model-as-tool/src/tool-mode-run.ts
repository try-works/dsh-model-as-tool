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
import { AsyncLocalStorage } from 'node:async_hooks'

/** The runtime surface this module needs, narrowed so it is testable. */
export interface ProgramRuntime {
  resolve(request: Record<string, unknown>): unknown
  run(spec: unknown): Promise<{
    readonly value?: unknown
    readonly logs?: readonly string[]
    readonly error?: { readonly kind?: string; readonly message?: string }
  }>
}

/** How to reach the tools a program may call. */
export interface RunnerEnvironment {
  /** The host's context, for the guarded mount. */
  readonly context: PtcHostContext
  /**
   * The backend plugin, or undefined when it could not be resolved. May be a
   * thunk: the host resolves the backend LAZILY so a deployment without the
   * package still loads the plugin, and `prepare()` materializes it at most once.
   */
  readonly backend: unknown | (() => Promise<unknown>)
  /**
   * The grant a program's sub-calls authorize against, READ PER RUN.
   *
   * A FUNCTION rather than a value because of SEC-04's composition rule: an
   * external client's `tool_mode_run` call must compose under the CLIENT's grant,
   * not the host's — otherwise a client granted only `tool_mode_run` could reach
   * every host-granted tool through a program. The host wires this to an
   * {@link ExternalGrantContext}, which returns the caller's grant when the run
   * happens inside an external call and the host's own grant otherwise.
   */
  readonly grant: () => readonly string[]
  /** The tool names currently registered, read at RUN time so late registrations are visible. */
  readonly visible: () => readonly string[]
  /** Resolves one authorized name to its implementation. */
  readonly resolve: (name: string) => ToolBinding | undefined
  /** The runtime, once mounted. */
  readonly runtime: () => ProgramRuntime | undefined
  /** Whether the OPERATOR granted hosted code execution (CODE-10), read at check time. */
  readonly operatorGranted: () => boolean
}

/**
 * The per-call external grant carrier (SEC-04, composition).
 *
 * `AsyncLocalStorage` rather than a module global: the context travels with the
 * async chain of ONE call, so two concurrent external clients cannot see each
 * other's grants, and the native/interactive path (no context) reads the host's
 * own grant — unchanged behavior.
 */
export interface ExternalGrantContext {
  /** Run work with an external client's grant in force. */
  run<T>(grant: readonly string[], work: () => Promise<T>): Promise<T>
  /** The grant in force, or undefined on the host/interactive path. */
  current(): readonly string[] | undefined
}

/** Create the per-call external grant carrier. */
export function createExternalGrantContext(): ExternalGrantContext {
  const store = new AsyncLocalStorage<readonly string[]>()
  return {
    run(grant, work) {
      return store.run(grant, work)
    },
    current() {
      return store.getStore()
    },
  }
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
  | { readonly ok: true; readonly value: unknown; readonly logs: readonly string[]; readonly toolCalls: number }
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
  /** Materialized backend, resolved lazily at most once. */
  let backend: Promise<unknown | undefined> | undefined

  const materializeBackend = (): Promise<unknown | undefined> => {
    backend ??= (async () => {
      // A FUNCTION backend is a lazy resolver; a CLASS is a plugin constructor and
      // must not be invoked here (the mount does the construction). The source
      // prefix distinguishes the two, which is exact for native classes. Wrapped
      // constructors (bound/proxied/transpiled) can slip through as resolvers; the
      // try/catch converts their invocation error into the SAME undefined the
      // designed 'backend-unavailable' refusal reports, so no caller sees an
      // opaque TypeError instead of the documented deployment fact.
      const value = environment.backend
      const isClass = typeof value === 'function' && /^class\s/.test(Function.prototype.toString.call(value))
      if (typeof value !== 'function' || isClass) return value
      try {
        return await (value as () => Promise<unknown>)()
      } catch {
        // The failure is reported through prepare()'s 'backend-unavailable'
        // reason, which is the designed channel; the detail does not need a
        // second logger the runner does not own.
        return undefined
      }
    })()
    return backend
  }

  return {
    async prepare() {
      // Idempotent: the guard is inside, and re-running it must not double-mount.
      if (prepared !== undefined) return prepared
      prepared = await mountPtcRuntimeIfAbsent(environment.context, await materializeBackend(), {
        timeoutMs: 120_000,
        maxTimeoutMs: 600_000,
      })
      return prepared
    },

    externalExposurePermitted() {
      return mayExposeToClients(environment.operatorGranted())
    },

    externalExposureReason() {
      return exposureWithheldReason(environment.operatorGranted())
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
      let toolCalls = 0
      const countedResolve = (name: string): ToolBinding | undefined => {
        const binding = environment.resolve(name)
        if (binding === undefined) return undefined
        // A counter wrapper, not a permission change: the program's binding call is
        // counted so the CODE-02 meta reports real usage rather than a fabricated 0.
        return async args => {
          toolCalls += 1
          return binding(args)
        }
      }
      const bindings = buildToolBindings({
        requested: request.requested,
        // THE GRANT IS READ PER RUN: an external client's call composes under the
        // CLIENT's grant (SEC-04), the host path under the host's own.
        authority: { granted: environment.grant(), visible: environment.visible() },
        resolve: countedResolve,
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
        return { ok: true, value: result.value, logs: result.logs ?? [], toolCalls }
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

/** What the CODE-02 tool returns for one run. */
export interface RunReport {
  readonly result: unknown
  readonly logs: readonly string[]
  readonly meta: {
    readonly receiptId: string
    readonly elapsedMs: number
    readonly toolCalls: number
    readonly catalogRevision: string
    readonly warnings: readonly string[]
  }
}

/**
 * The `tool_mode_run` MCP contract, in the ToolContract shape (CODE-02).
 *
 * ONE definition serves the MCP export surface and the conformance test, so the
 * two cannot drift the way an inline object at the export site would: the test
 * validates this shape's MCP projection against the pinned schema before it ever
 * ships on a live tools/list.
 */
export const TOOL_MODE_RUN_CONTRACT = {
  contract: 'hosted.tool_mode_run',
  version: '1.0.0',
  toolName: 'tool_mode_run',
  description: 'Run a program that calls Tool Mode tools (CODE-02).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'code', 'tools'],
    properties: {
      description: { type: 'string' },
      code: { type: 'string' },
      input: {},
      tools: { type: 'array', items: { type: 'string' } },
      timeout_ms: { type: 'integer' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      result: {},
      logs: { type: 'array', items: { type: 'string' } },
      meta: { type: 'object' },
    },
  },
  semantics: { deterministic: false, readsInputs: true },
  limits: {},
  unsupported: ['no access to management or installer bindings'],
} as const

/**
 * Serve one CODE-02 request through the authorized pipeline (CODE-02/04).
 *
 * This is the `tool_mode_run` served path: the caller's arguments are validated
 * into the CODE-02 shape, the program runs through the SAME runner native PTC
 * uses, and the report carries the receipt, elapsed time, call count, catalog
 * revision and warnings the interface promises.
 *
 * `input` is refused when the pinned runtime cannot bind it structurally: CODE-04
 * forbids string interpolation into source, and the current PTC runtime has no
 * data-global path, so an input-bearing program gets a precise refusal naming
 * that limitation rather than a silently interpolated program.
 * @param args - the caller's arguments.
 * @param runner - the prepared runner.
 * @param report - the report-shaped facts the host owns (receipt id, revision).
 * @returns the report.
 */
export async function serveProgram(
  args: Record<string, unknown>,
  runner: ProgramRunner,
  report: { readonly receiptId: string; readonly catalogRevision: string },
): Promise<RunReport> {
  const description = typeof args.description === 'string' ? args.description : ''
  const code = typeof args.code === 'string' ? args.code : ''
  if (code.trim().length === 0) {
    throw new Error('`code` must be a non-empty program body')
  }
  void description

  const requested = Array.isArray(args.tools)
    ? args.tools.filter((name): name is string => typeof name === 'string')
    : []
  if (requested.length === 0) {
    throw new Error('`tools` must name at least one tool the program will call')
  }
  if (args.input !== undefined && args.input !== null) {
    /**
     * CODE-04: `input` is bound through a supported structured-data path, never
     * interpolated into source. The pinned PTC runtime materialises FUNCTION
     * namespaces only, so there is no data path to bind it through today. Refusing
     * with that fact is the honest outcome; interpolating JSON into the program
     * would be the silent violation the requirement names.
     */
    throw new Error(
      '`input` cannot be bound: the pinned PTC runtime has no structured-data path, '
      + 'and CODE-04 forbids interpolating it into source. Use a program that takes '
      + 'no input data, or run against a runtime that supports data binding.',
    )
  }

  const prepared = await runner.prepare()
  if (!prepared.mounted && prepared.reason === 'backend-unavailable') {
    throw new Error('the Node PTC backend is unavailable on this deployment, so no program can run')
  }

  const started = Date.now()
  const outcome = await runner.run({
    program: code,
    requested,
    ...typeof args.timeout_ms === 'number' ? { timeoutMs: args.timeout_ms } : {},
  })
  if (!outcome.ok) {
    throw new Error(`${outcome.code}: ${outcome.message}`)
  }
  return {
    result: outcome.value ?? null,
    logs: outcome.logs,
    meta: {
      receiptId: report.receiptId,
      elapsedMs: Date.now() - started,
      toolCalls: outcome.toolCalls,
      catalogRevision: report.catalogRevision,
      warnings: [],
    },
  }
}
